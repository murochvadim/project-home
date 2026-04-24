"""Estimate people count + home mode with adjacency-aware dedupe + door transit.

Upgraded 2026-04-24:
- Dedupe uses state.spatial adjacency graph — merging counts only when rooms
  are physically adjacent AND a corridor timer fired recently.
- V9 door sensors feed Main-Door-style entry/exit detection.
- `people_confidence` scalar classifies how strong the evidence is.
- Legacy fields (`people_home`, `home_mode`, `someone_home`, `occupied_rooms`)
  preserved byte-identical for dashboard consumers — no display regression.

Reads state.spatial for adjacency + door roles. Falls back to today's
flat-room corridor dedupe if the spatial index is empty (startup race).

Tuning knobs (state.shared — populated by the heartbeat sentence parser):
- people_home.corridor_sec                  — default 15  (A→B within X = same person)
- people_home.adjacency_dedupe_sec          — default 30  (wider window for adjacent rooms)
- people_home.away_after_no_motion_min      — default 30  (idle → away after X min)
- people_home.door_transit_window_sec       — default 10  (door open then presence = entry)
- people_home.exit_quiet_window_sec         — default 30  (door open then no motion = exit)
- people_home.transit_sequence_window_sec   — default 15  (Tier-1↔Tier-3 inferred transit window)
- people_home.door_close_stabilize_sec      — default 15  (seconds after Main Door close before recount)
"""

from datetime import datetime, timezone


RULE = {
    "name": "People Home",
    "description": "People count + home mode (adjacency dedupe + V9 door-sensor entry/exit)",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
    "group": "info",
    "priority": 2,
    "depends_on": ["Home Activity"],
}

PRESENCE_TYPES = {'presence', 'motion'}
DOOR_TYPES     = {'door_sensor'}

# Classification of sensors near the apartment entry for inferred-transit detection.
# Corridor Presence lives in the building hallway *outside* the flat — it fires
# ~7 s before the Main Door opens when someone approaches, and ~9 s after it
# closes when they leave. So it's an *exterior* approach signal, not an interior
# one, and it MUST NOT count toward people_count (the person is still outside).
# These can be overridden via knobs if the house layout changes.
DEFAULT_EXTERIOR_ROOMS  = ('Corridor',)    # Tier-1 (exterior approach)
DEFAULT_THRESHOLD_ROOMS = ('Entrance',)     # Tier-3 (interior side of the door)
# Transit-only rooms — people walk through them but don't "live" there. Their
# presence fires shouldn't add to people_count (otherwise walking from room A
# to room B briefly inflates the count when the transit sensor overlaps).
DEFAULT_TRANSIT_ROOMS   = ('Hallway',)
# Ring Doorbell = camera at the front door, fires `motion:<iso-ts>` events —
# also Tier-1 (exterior), identified by name match since its device_type='motion'
# is shared with other indoor motion sensors.
EXTERIOR_MOTION_NAME_HINTS = ('doorbell', 'ring bell', 'ring doorbell')

# Manual sub-room merging for open-plan areas that the automatic spatial
# heuristic misses. The heuristic looks for zones named like "<Room> *" in a
# parent layout; it catches Kitchen (zones "Kitchen Walkway" etc.) but misses:
#   - Dining Room — zones in Living Room are named "Dining Table", "Dinner Zone"
#     (no "Dining Room" prefix)
#   - Entrance — has its own drawn floorplan, so it never enters sub-room logic
# Both are physically part of the Living Room open-plan space — one person
# moving through triggers sensors in multiple "rooms" simultaneously. Map
# child → parent. Override in state.shared if the layout changes.
DEFAULT_MANUAL_SUBROOM_MERGE = {
    'Dining Room': 'Living Room',
    'Entrance':    'Living Room',
}


# ─────────────────────────── Helpers ───────────────────────────

def _presence_active(dps):
    if not isinstance(dps, dict):
        return False
    v1 = dps.get('1')
    if v1 in (True, 1, 'true', 'True', 'presence', '1'):
        return True
    if isinstance(v1, str) and v1 and v1 not in ('none', 'None', '0', 'false', 'False'):
        return True
    return bool(
        dps.get('motion') is True or dps.get('presence') is True or
        dps.get('occupancy') is True or dps.get('occupied') is True or
        dps.get('motion_detected') is True
    )


def _door_is_open(dps):
    if not isinstance(dps, dict):
        return None
    if dps.get('door') is True:     return True
    if dps.get('door') is False:    return False
    if dps.get('contact') is False: return True
    if dps.get('contact') is True:  return False
    if dps.get('1') is True:        return True
    if dps.get('1') is False:       return False
    return None


def _slug_for_room(spatial, room_name):
    """Best-effort reverse lookup: room display name → layout slug."""
    for slug, data in (spatial.get('rooms_by_slug') or {}).items():
        if data.get('name') == room_name:
            return slug
    return None


def _are_adjacent(spatial, room_a, room_b):
    """True if A and B share a door/divider/archway with `leads_to`."""
    if room_a == room_b:
        return True
    rooms_by_slug = spatial.get('rooms_by_slug') or {}
    slug_a = _slug_for_room(spatial, room_a)
    slug_b = _slug_for_room(spatial, room_b)
    if not slug_a or not slug_b:
        return False
    if slug_b in (rooms_by_slug.get(slug_a, {}).get('adjacent_rooms') or []):
        return True
    if slug_a in (rooms_by_slug.get(slug_b, {}).get('adjacent_rooms') or []):
        return True
    return False


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _is_exterior_motion(device, name_hints):
    """Ring-Doorbell-style camera motion: device_type=motion + name hint match."""
    if (device.get('device_type') or '').lower() != 'motion':
        return False
    nm = (device.get('name') or '').lower()
    return any(h in nm for h in name_hints)


def _find_main_door(state):
    """Return (device_id, state_str) for the Main Door, or (None, None) if absent.
    Uses the state.shared['door:Main Door'] snapshot populated by Home Activity."""
    val = state.shared.get('door:Main Door')
    if val not in ('open', 'closed'):
        return None, None
    for did, dev in state.devices.items():
        if (dev.get('device_type') or '').lower() == 'door_sensor' \
                and (dev.get('name') or '') == 'Main Door':
            return did, val
    return None, val


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Knobs
    try:
        corridor_sec         = int(state.shared.get('people_home.corridor_sec',             15))
        adjacency_dedupe_sec = int(state.shared.get('people_home.adjacency_dedupe_sec',     30))
        away_after_min       = int(state.shared.get('people_home.away_after_no_motion_min', 30))
        door_transit_window  = int(state.shared.get('people_home.door_transit_window_sec',  10))
        exit_quiet_window    = int(state.shared.get('people_home.exit_quiet_window_sec',    30))
        # Main-Door-locked count knobs — the count only changes on Main Door events
        # (real or inferred). Stabilize window runs after door closes so sensors
        # settle before the recount is snapshotted.
        transit_seq_window       = int(state.shared.get('people_home.transit_sequence_window_sec', 15))
        door_close_stabilize_sec = int(state.shared.get('people_home.door_close_stabilize_sec',    15))
    except (TypeError, ValueError):
        corridor_sec, adjacency_dedupe_sec, away_after_min = 15, 30, 30
        door_transit_window, exit_quiet_window = 10, 30
        transit_seq_window, door_close_stabilize_sec = 15, 15

    exterior_rooms  = set(DEFAULT_EXTERIOR_ROOMS)
    threshold_rooms = set(DEFAULT_THRESHOLD_ROOMS)
    transit_rooms   = set(DEFAULT_TRANSIT_ROOMS)

    spatial  = state.spatial or {}
    door_map = spatial.get('door_sensor_to_adjacency') or {}

    dev_id = event.get('device_id', '')
    device = state.devices.get(dev_id, {})
    dtype  = (device.get('device_type') or '').lower()
    room   = device.get('room', '')
    dps    = event.get('dps', {}) or {}

    # ── 1. Corridor transition tracking ──
    if dtype in PRESENCE_TYPES and room and _presence_active(dps):
        prev_room  = state.shared.get('_prev_presence_room', '')
        prev_timer = state.get_timer('_prev_presence_time')
        state.shared['_prev_presence_room'] = room
        state.set_timer('_prev_presence_time')
        if prev_room and prev_room != room and prev_timer < corridor_sec:
            state.set_timer(f'corridor:{prev_room}>{room}')

    # ── 2. Door open → record for entry/exit decision ──
    if dtype in DOOR_TYPES:
        open_state = _door_is_open(dps)
        if open_state is True:
            door_info = door_map.get(dev_id) or {}
            door_name = door_info.get('name') or device.get('name') or dev_id
            state.set_timer(f'door_just_opened:{door_name}')
            state.shared['_last_door_opened'] = door_name

    # ── 2a. Main Door transitions (authoritative reset signal for the lock) ──
    # open = person is crossing threshold; count stays on the previous lock.
    # close = transit complete; start stabilize window, recompute count after it elapses.
    main_door_id, main_door_now = _find_main_door(state)
    prev_main_door = state.shared.get('_prev_main_door_state')
    main_door_opened_now = (main_door_now == 'open'   and prev_main_door == 'closed')
    main_door_closed_now = (main_door_now == 'closed' and prev_main_door == 'open')
    if main_door_now is not None:
        state.shared['_prev_main_door_state'] = main_door_now

    # Main Door CLOSE (§2a) and the inferred Tier-1↔Tier-3 sequence (§2b + §5a)
    # both trigger the recount in §7a. The OPEN edge is intentionally not a
    # reset — it only flags the `transit` visual state. If the door sensor dies,
    # inferred transit covers the recount signal.

    # ── 2b. Tier-1 / Tier-3 transit signals (inferred-transit fallback) ──
    # Tier-1 = exterior approach (Corridor Presence, Ring Doorbell camera).
    # Tier-3 = interior threshold (Entrance Presence).
    # A sequence of both within `transit_seq_window` seconds = door transit
    # even if the Main Door sensor itself is silent.
    if dtype in PRESENCE_TYPES and _presence_active(dps):
        if room in exterior_rooms:
            state.set_timer('transit_tier1')
            state.shared['_transit_tier1_via'] = device.get('name') or room
        elif room in threshold_rooms:
            state.set_timer('transit_tier3')
            state.shared['_transit_tier3_via'] = device.get('name') or room
    # Ring Doorbell (device_type='motion', name matches) — each event with a
    # 'motion' key is a fresh fire (Z2M/Ring encode timestamps in the value).
    if _is_exterior_motion(device, EXTERIOR_MOTION_NAME_HINTS) and 'motion' in dps:
        state.set_timer('transit_tier1')
        state.shared['_transit_tier1_via'] = device.get('name') or 'Ring Doorbell'

    # ── 3. Entry detection: presence fires within the transit window ──
    if dtype in PRESENCE_TYPES and _presence_active(dps):
        recent_door = state.shared.get('_last_door_opened', '')
        if recent_door and state.get_timer(f'door_just_opened:{recent_door}') < door_transit_window:
            state.shared['last_entered_via']   = recent_door
            state.shared['last_transition_ts'] = _now_iso()
            state.shared['_last_door_opened']  = ''  # consume so a later quiet window can't also fire exit

    # ── 4. Count active presence/motion rooms (dedupe by room name) ──
    # Exterior sensors (Corridor Presence in the building hallway, Ring Doorbell
    # camera) are *not* in the flat — they must not contribute to people_count.
    presence_rooms = []
    seen_rooms = set()
    for did, dev in state.devices.items():
        dt = (dev.get('device_type') or '').lower()
        if dt not in PRESENCE_TYPES:
            continue
        if not dev.get('online', True):
            continue
        r = dev.get('room', '')
        if not r or r in seen_rooms:
            continue
        if r in exterior_rooms:
            continue
        if r in transit_rooms:
            continue
        if _is_exterior_motion(dev, EXTERIOR_MOTION_NAME_HINTS):
            continue
        if _presence_active(dev.get('dps') or {}):
            presence_rooms.append(r)
            seen_rooms.add(r)

    # ── 4a. Sub-room folding: Kitchen / Dining Room / (manual) Entrance all
    # share the Living Room open-plan space; multiple mmWave sensors see the
    # same person and inflate the count. Fold sub-rooms into their parent
    # before counting. Automatic mapping comes from state.spatial.subrooms
    # (rooms without own layout whose name prefixes a parent's zone names).
    # Manual mapping (DEFAULT_MANUAL_SUBROOM_MERGE) covers open-plan rooms
    # that DO have their own floorplan but physically share space. ──
    rooms_by_slug = spatial.get('rooms_by_slug') or {}
    parent_of = {}
    for sname, sinfo in (spatial.get('subrooms') or {}).items():
        p_slug = sinfo.get('parent_slug')
        p_name = (rooms_by_slug.get(p_slug) or {}).get('name')
        if p_name:
            parent_of[sname] = p_name
    for child, parent in DEFAULT_MANUAL_SUBROOM_MERGE.items():
        parent_of[child] = parent
    folded = []
    folded_seen = set()
    for r in presence_rooms:
        eff = parent_of.get(r, r)
        if eff and eff not in folded_seen:
            folded.append(eff)
            folded_seen.add(eff)
    presence_rooms = folded

    # ── 5. Adjacency-aware dedupe: merge pairs that are adjacent AND had a recent corridor fire ──
    people_count = len(presence_rooms)
    if people_count > 1:
        merged = set()
        for i, r1 in enumerate(presence_rooms):
            if r1 in merged:
                continue
            for r2 in presence_rooms[i + 1:]:
                if r2 in merged:
                    continue
                has_corridor_evidence = (
                    state.get_timer(f'corridor:{r1}>{r2}') < adjacency_dedupe_sec or
                    state.get_timer(f'corridor:{r2}>{r1}') < adjacency_dedupe_sec
                )
                if has_corridor_evidence and _are_adjacent(spatial, r1, r2):
                    people_count -= 1
                    merged.add(r2)
        people_count = max(1, people_count)

    # ── 5a. Inferred transit: Tier-1 ↔ Tier-3 sequence within window ──
    # If the Main Door sensor is silent but Corridor→Entrance (or Entrance→
    # Corridor) fired within transit_seq_window seconds, that's a high-confidence
    # inferred transit. Direction is determined by which tier fired first
    # (older timer age = fired longer ago = first).
    t1_age = state.get_timer('transit_tier1')
    t3_age = state.get_timer('transit_tier3')
    inferred_transit = None  # 'entry' | 'exit' | None
    if t1_age < transit_seq_window and t3_age < transit_seq_window:
        # Debounce: only process once per sequence — re-trigger only if at least
        # transit_seq_window has elapsed since the last inferred fire.
        last_inferred_age = state.get_timer('_inferred_transit_fired')
        if last_inferred_age > transit_seq_window:
            state.set_timer('_inferred_transit_fired')
            if t1_age > t3_age:
                inferred_transit = 'entry'  # Tier-1 fired first (outside), then Tier-3 (threshold)
                inferred_via = state.shared.get('_transit_tier1_via', 'exterior')
            else:
                inferred_transit = 'exit'
                inferred_via = state.shared.get('_transit_tier3_via', 'threshold')
            state.shared['last_transition_ts'] = _now_iso()
            if inferred_transit == 'entry':
                state.shared['last_entered_via'] = f'{inferred_via} (inferred)'
            else:
                state.shared['last_exited_via'] = f'{inferred_via} (inferred)'

    # ── 6. Confidence score ──
    if presence_rooms:
        confidence = 'high'
    else:
        recent_door = state.shared.get('_last_door_opened', '')
        door_recent = bool(recent_door and state.get_timer(f'door_just_opened:{recent_door}') < 120)
        active_rooms_now = state.shared.get('active_rooms', []) or []
        if door_recent or active_rooms_now:
            confidence = 'medium'
        else:
            confidence = 'low'

    # ── 7. Fallback count: if no presence but Home Activity saw activity, at least 1 ──
    active_rooms = state.shared.get('active_rooms', []) or []
    if people_count == 0 and active_rooms:
        people_count = 1

    # ── 7a. Door-event-driven lock with explicit transit/recount states ──
    # Simple, unambiguous semantics:
    #   - Main Door is 'open'  → people_count_state = 'transit'    (dashboard: --)
    #   - Main Door just closed (or inferred transit) → 'recounting' (dashboard: **)
    #   - Stabilize window elapsed → snapshot live_count → 'stable'  (dashboard: N)
    #   - Between door events → count is frozen regardless of sensor noise
    # No asymmetric UP, no sustain counters — door events are the ONLY thing
    # that moves the lock. Period.
    live_count = people_count

    if main_door_closed_now or inferred_transit:
        state.set_timer('_post_door_stabilize')
        state.shared['_recalc_pending'] = True

    recalc_pending = bool(state.shared.get('_recalc_pending'))
    if recalc_pending and state.get_timer('_post_door_stabilize') >= door_close_stabilize_sec:
        state.shared['_people_locked_count'] = live_count
        state.shared['_people_last_lock_ts'] = _now_iso()
        state.shared['_recalc_pending']      = False
        locked_count   = live_count
        recalc_pending = False
    elif state.shared.get('_people_locked_count') is not None:
        locked_count = int(state.shared['_people_locked_count'])
    else:
        # First evaluation after boot — seed from the current live count.
        locked_count = live_count
        state.shared['_people_locked_count'] = locked_count
        state.shared['_people_last_lock_ts'] = _now_iso()

    people_count = locked_count
    floored = (live_count != locked_count)

    # Derive state from door + recount flags. Dashboard reads this to decide
    # whether to render "--" (transit) / "**" (recounting) / the integer.
    if main_door_now == 'open':
        people_count_state = 'transit'
        confidence         = 'transit'
    elif recalc_pending:
        people_count_state = 'recounting'
        confidence         = 'recalculating'
    else:
        people_count_state = 'stable'
        # confidence keeps 'high' / 'medium' / 'low' from §6

    # ── 8. Occupied rooms = union ──
    occupied_rooms = sorted(set(presence_rooms) | set(active_rooms))

    # ── 9. Home mode ──
    last_motion_sec = state.get_timer('last_motion')
    if people_count == 0:
        home_mode = 'away' if last_motion_sec > away_after_min * 60 else 'idle'
    else:
        home_mode = 'active'

    # ── 10. Exit detection: door was opened, then no motion for exit_quiet_window sec ──
    recent_door = state.shared.get('_last_door_opened', '')
    if recent_door:
        opened_ago = state.get_timer(f'door_just_opened:{recent_door}')
        # Fire once when the quiet window elapses while motion stays silent
        if exit_quiet_window <= opened_ago < exit_quiet_window * 2 and last_motion_sec > exit_quiet_window:
            state.shared['last_exited_via']    = recent_door
            state.shared['last_transition_ts'] = _now_iso()
            state.shared['_last_door_opened']  = ''  # consume

    # ── 11. Publish + emit ──
    state.shared['people_home']         = people_count
    state.shared['occupied_rooms']      = occupied_rooms
    state.shared['home_mode']           = home_mode
    state.shared['people_count_state']  = people_count_state

    # Pick the authoritative transition source for this tick
    if main_door_opened_now:
        transition_source = 'door_sensor'
    elif inferred_transit:
        transition_source = f'inferred_{inferred_transit}'
    else:
        transition_source = state.shared.get('_last_transition_source', '')
    if transition_source:
        state.shared['_last_transition_source'] = transition_source

    state.emit_virtual_event(
        virtual_id='virtual:people_home',
        dps={
            # Legacy (dashboard reads these)
            'people_home':        people_count,
            'home_mode':          home_mode,
            'someone_home':       people_count > 0,
            'occupied_rooms':     occupied_rooms,
            # New (additive)
            'people_confidence':  confidence,
            'last_entered_via':   state.shared.get('last_entered_via', ''),
            'last_exited_via':    state.shared.get('last_exited_via', ''),
            'last_transition_ts': state.shared.get('last_transition_ts', ''),
            # Main-Door-locked count diagnostics
            'people_count_state':      people_count_state,  # 'stable' | 'transit' | 'recounting'
            'people_count_floored':    floored,             # True when live != locked (lock is holding)
            'people_count_high_water': locked_count,        # emitted count (locked value)
            'people_count_live':       live_count,          # what sensors say right now, pre-lock
            'last_transition_source':  transition_source,
        },
        source='rule:People Home',
        name='People Home State',
        dps_labels={
            'people_home':             'People Count',
            'home_mode':               'Home Mode',
            'someone_home':            'Someone Home',
            'occupied_rooms':          'Occupied Rooms',
            'people_confidence':       'Confidence',
            'last_entered_via':        'Last Entered Via',
            'last_exited_via':         'Last Exited Via',
            'last_transition_ts':      'Last Transition',
            'people_count_state':      'Count State (transit / recounting / stable)',
            'people_count_floored':    'Lock Engaged (sensors disagree)',
            'people_count_high_water': 'Locked Count',
            'people_count_live':       'Live Sensor Count',
            'last_transition_source':  'Transition Source',
        },
    )

    return []
