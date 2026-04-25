"""Estimate people count + home mode using zone-based occupancy.

Rewritten 2026-04-25 — replaces room-based folding with zone-based counting.

Key changes from prior version:
- Counts distinct sustained ZONES (from `state.shared['active_zones']`)
  instead of rooms. Open-plan multi-occupancy is now visible: 5 people across
  Living Room + Kitchen + Dining Room sub-zones count separately, not folded
  to 1.
- Transit zones (doorways, walkways) are excluded — even if sustained, they
  are movement zones, not lived-in.
- Each zone must be continuously active ≥ `zone_sustained_sec` (default 30 s)
  before it counts. Filters out brief sensor flicker.
- Both Constant (`people_home`) and Dynamic (`people_home_dynamic`) use the
  SAME zone-based algorithm — the only difference is *when* the value
  snapshots: Constant at end of stabilize window after Main Door close;
  Dynamic on every event.
- Constant snapshot uses the ROLLING MAX of sustained-zone count during the
  stabilize window. Fixes the bug where the value at the END of the window
  had decayed to a misleadingly low number (e.g. 5 → 2 in the 18:04 entry on
  2026-04-25). See `RULES/INVESTIGATION_people_home_undercount.md`.
- Discovery layer: a new zone is eligible to bump the dynamic count once it's
  been sustained ≥ `zone_sustained_sec` AND it's not in the lock snapshot AND
  no corridor-transit involving it has fired in the last 5 minutes. Replaces
  the prior "accounted forever until next door event" logic that killed
  discovery in practice.

Reads `state.spatial` for zone→room mapping. Falls back to the room-based
counter when `active_zones` is empty (startup race / Home Activity hadn't
populated yet).

Tuning knobs (state.shared — populated by the heartbeat sentence parser):
- people_home.corridor_sec                 — default 15
- people_home.adjacency_dedupe_sec         — default 30
- people_home.door_transit_window_sec      — default 10
- people_home.exit_quiet_window_sec        — default 30
- people_home.transit_sequence_window_sec  — default 15
- people_home.door_close_stabilize_sec     — default 60
- people_home.zone_sustained_sec           — default 30  (NEW — sustained gate)
- people_home.zone_accounted_decay_sec     — default 300 (NEW — discovery gate)
"""

from datetime import datetime, timezone


RULE = {
    "name": "People Home",
    "description": "People count + home mode (zone-based, sustained-gated, V9 door-sensor entry/exit)",
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
DEFAULT_EXTERIOR_ROOMS  = ('Corridor',)    # Tier-1 (exterior approach)
DEFAULT_THRESHOLD_ROOMS = ('Entrance',)    # Tier-3 (interior side of the door)
DEFAULT_TRANSIT_ROOMS   = ('Hallway',)
EXTERIOR_MOTION_NAME_HINTS = ('doorbell', 'ring bell', 'ring doorbell')

# Transit zones — pure movement zones (doorways, walkways). Even when sustained,
# these don't count as separate occupants. Lived-in zones (Bed Area, Sofa
# Entertainment, Dining Table, Kitchen Bar, etc.) DO count when sustained.
DEFAULT_TRANSIT_ZONES = (
    'Hallway Walkway',
    'Living Room Doorway',
    'Entrance Walkway',
    'My BathRoom Doorway',
    'Bedroom Doorway',
)

# Manual sub-room merging — kept for the legacy room-based fallback path
# only (when active_zones is empty). The primary zone-based path doesn't fold.
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
    for slug, data in (spatial.get('rooms_by_slug') or {}).items():
        if data.get('name') == room_name:
            return slug
    return None


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _is_exterior_motion(device, name_hints):
    if (device.get('device_type') or '').lower() != 'motion':
        return False
    nm = (device.get('name') or '').lower()
    return any(h in nm for h in name_hints)


def _main_door_state(state):
    """Return current Main Door state ('open' / 'closed') or None.

    Reads the snapshot Home Activity already maintains in state.shared —
    avoids a state.devices scan on every wildcard event. Earlier versions
    also returned the device id but no caller used it.
    """
    val = state.shared.get('door:Main Door')
    return val if val in ('open', 'closed') else None


def _build_zone_to_room(spatial):
    """Map zone name → room display name from state.spatial.

    `spatial['rooms_by_slug'][slug]['zones']` is a dict keyed by zone name
    (per `state_manager._load_spatial`). Each value is {cells, sensor_device_ids}.
    Returns {} if spatial is empty (startup race).
    """
    zone_to_room = {}
    rooms_by_slug = (spatial or {}).get('rooms_by_slug') or {}
    for slug, layout in rooms_by_slug.items():
        if not isinstance(layout, dict):
            continue
        room_name = layout.get('name') or ''
        if not room_name:
            continue
        zones = layout.get('zones') or {}
        if isinstance(zones, dict):
            for zname in zones.keys():
                if zname:
                    zone_to_room[zname] = room_name
        else:
            # Legacy list shape — defensive only
            for zone in zones:
                if isinstance(zone, dict):
                    zname = zone.get('name')
                    if zname:
                        zone_to_room[zname] = room_name
    return zone_to_room


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Knobs
    try:
        corridor_sec             = int(state.shared.get('people_home.corridor_sec',                15))
        adjacency_dedupe_sec     = int(state.shared.get('people_home.adjacency_dedupe_sec',        30))
        door_transit_window      = int(state.shared.get('people_home.door_transit_window_sec',     10))
        exit_quiet_window        = int(state.shared.get('people_home.exit_quiet_window_sec',       30))
        transit_seq_window       = int(state.shared.get('people_home.transit_sequence_window_sec', 15))
        door_close_stabilize_sec = int(state.shared.get('people_home.door_close_stabilize_sec',    60))
        zone_sustained_sec       = int(state.shared.get('people_home.zone_sustained_sec',          30))
        zone_accounted_decay_sec = int(state.shared.get('people_home.zone_accounted_decay_sec',    300))
    except (TypeError, ValueError):
        corridor_sec, adjacency_dedupe_sec = 15, 30
        door_transit_window, exit_quiet_window = 10, 30
        transit_seq_window, door_close_stabilize_sec = 15, 60
        zone_sustained_sec, zone_accounted_decay_sec = 30, 300

    exterior_rooms  = set(DEFAULT_EXTERIOR_ROOMS)
    threshold_rooms = set(DEFAULT_THRESHOLD_ROOMS)
    transit_rooms   = set(DEFAULT_TRANSIT_ROOMS)
    transit_zones   = set(DEFAULT_TRANSIT_ZONES)

    spatial      = state.spatial or {}
    door_map     = spatial.get('door_sensor_to_adjacency') or {}
    zone_to_room = _build_zone_to_room(spatial)

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
            # Zone-level accounting is handled in §7b via zone_accounted:<zone>
            # timers stamped from device_to_zones. The previously-maintained
            # `_people_accounted_rooms` list was only consumed by the old
            # room-based discovery path and is no longer referenced.

    # ── 2. Door open → record for entry/exit decision ──
    if dtype in DOOR_TYPES:
        open_state = _door_is_open(dps)
        if open_state is True:
            door_info = door_map.get(dev_id) or {}
            door_name = door_info.get('name') or device.get('name') or dev_id
            state.set_timer(f'door_just_opened:{door_name}')
            state.shared['_last_door_opened'] = door_name

    # ── 2a. Main Door transitions ──
    main_door_now = _main_door_state(state)
    prev_main_door = state.shared.get('_prev_main_door_state')
    main_door_opened_now = (main_door_now == 'open'   and prev_main_door == 'closed')
    main_door_closed_now = (main_door_now == 'closed' and prev_main_door == 'open')
    if main_door_now is not None:
        state.shared['_prev_main_door_state'] = main_door_now

    # ── 2b. Tier-1 / Tier-3 transit signals ──
    if dtype in PRESENCE_TYPES and _presence_active(dps):
        if room in exterior_rooms:
            state.set_timer('transit_tier1')
            state.shared['_transit_tier1_via'] = device.get('name') or room
        elif room in threshold_rooms:
            state.set_timer('transit_tier3')
            state.shared['_transit_tier3_via'] = device.get('name') or room
    if _is_exterior_motion(device, EXTERIOR_MOTION_NAME_HINTS) and 'motion' in dps:
        state.set_timer('transit_tier1')
        state.shared['_transit_tier1_via'] = device.get('name') or 'Ring Doorbell'

    # ── 3. Entry detection: presence fires within the transit window ──
    if dtype in PRESENCE_TYPES and _presence_active(dps):
        recent_door = state.shared.get('_last_door_opened', '')
        if recent_door and state.get_timer(f'door_just_opened:{recent_door}') < door_transit_window:
            state.shared['last_entered_via']   = recent_door
            state.shared['last_transition_ts'] = _now_iso()
            state.shared['_last_door_opened']  = ''

    # ── 4. ZONE-BASED COUNT (primary path) ──
    # Reads Home Activity's `active_zones` (a held set with sensor-decay-aware
    # holds already applied). For each non-transit zone, gate by sustained
    # activity (≥ zone_sustained_sec) before counting.
    raw_zones = list(state.shared.get('active_zones') or [])

    # Filter transit zones up front — they never contribute to count.
    candidate_zones = [z for z in raw_zones if z not in transit_zones]

    # Filter to zones whose owning room is NOT exterior / pure-transit.
    counted_candidate_zones = []
    for z in candidate_zones:
        owner_room = zone_to_room.get(z, '')
        if owner_room in exterior_rooms:
            continue
        if owner_room in transit_rooms:
            continue
        counted_candidate_zones.append(z)

    # Rising-edge tracking with gap tolerance. Sensors flicker: a zone can drop
    # out of active_zones for a few seconds and reappear, even though the same
    # person is still there. To survive that, we only RESET zone_first_active
    # when the zone has been absent for `ZONE_GAP_TOLERANCE_SEC` or more.
    # zone_last_seen is updated every tick the zone is active; comparing its
    # AGE before re-stamping tells us whether this is a true rising edge or a
    # flicker bounce.
    ZONE_GAP_TOLERANCE_SEC = 15
    current_zone_set = set(counted_candidate_zones)
    for z in current_zone_set:
        last_seen_age = state.get_timer(f'zone_last_seen:{z}')
        if last_seen_age >= ZONE_GAP_TOLERANCE_SEC:
            # First appearance OR returning after a real gap → restart sustained timer
            state.set_timer(f'zone_first_active:{z}')
        state.set_timer(f'zone_last_seen:{z}')
    state.shared['_people_last_active_zones'] = sorted(current_zone_set)

    # Sustained-activity gate — only count zones active ≥ zone_sustained_sec.
    sustained_zones = [
        z for z in counted_candidate_zones
        if state.get_timer(f'zone_first_active:{z}') >= zone_sustained_sec
    ]

    # Same-room dedupe — if multiple sustained zones belong to the same room
    # AND a corridor-style fire happened between them recently, treat as one
    # person walking. Kept conservative: only merge if both are in the same
    # owning room AND `corridor:<room>>self` evidence is recent — which
    # almost never matches today, so this is a no-op safety net for now.
    # The transit-zone exclusion + sustained gate handle the common cases.
    sustained_zones_deduped = sustained_zones[:]

    live_count_zones = len(sustained_zones_deduped)

    # ── 4z. Legacy room-based fallback — used only if active_zones is empty.
    # Preserves prior behavior so the rule stays useful during the brief
    # window between rule-engine boot and Home Activity's first emission.
    # Legacy room-based fallback — only computed when active_zones is empty
    # (startup race / Home Activity hadn't populated yet). Skipped on every
    # normal event to avoid an extra state.devices.items() scan.
    presence_rooms_folded = []
    if not raw_zones:
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
            if r in exterior_rooms or r in transit_rooms:
                continue
            if _is_exterior_motion(dev, EXTERIOR_MOTION_NAME_HINTS):
                continue
            if _presence_active(dev.get('dps') or {}):
                presence_rooms.append(r)
                seen_rooms.add(r)

        rooms_by_slug = spatial.get('rooms_by_slug') or {}
        parent_of = {}
        for sname, sinfo in (spatial.get('subrooms') or {}).items():
            p_slug = sinfo.get('parent_slug')
            p_name = (rooms_by_slug.get(p_slug) or {}).get('name')
            if p_name:
                parent_of[sname] = p_name
        for child, parent in DEFAULT_MANUAL_SUBROOM_MERGE.items():
            parent_of[child] = parent
        folded_seen = set()
        for r in presence_rooms:
            eff = parent_of.get(r, r)
            if eff and eff not in folded_seen:
                presence_rooms_folded.append(eff)
                folded_seen.add(eff)

    # Pick whichever path produced a number. Zone-based wins when zones exist;
    # otherwise fall back to rooms.
    if raw_zones:
        live_count = live_count_zones
        live_basis = 'zones'
    else:
        live_count = len(presence_rooms_folded)
        live_basis = 'rooms_fallback'

    # ── 5. Inferred transit detection ──
    t1_age = state.get_timer('transit_tier1')
    t3_age = state.get_timer('transit_tier3')
    inferred_transit = None
    if t1_age < transit_seq_window and t3_age < transit_seq_window:
        last_inferred_age = state.get_timer('_inferred_transit_fired')
        if last_inferred_age > transit_seq_window:
            state.set_timer('_inferred_transit_fired')
            if t1_age > t3_age:
                inferred_transit = 'entry'
                inferred_via = state.shared.get('_transit_tier1_via', 'exterior')
            else:
                inferred_transit = 'exit'
                inferred_via = state.shared.get('_transit_tier3_via', 'threshold')
            state.shared['last_transition_ts'] = _now_iso()
            if inferred_transit == 'entry':
                state.shared['last_entered_via'] = f'{inferred_via} (inferred)'
            else:
                state.shared['last_exited_via'] = f'{inferred_via} (inferred)'

    # ── 6. Confidence ──
    if sustained_zones_deduped or presence_rooms_folded:
        confidence = 'high'
    else:
        recent_door = state.shared.get('_last_door_opened', '')
        door_recent = bool(recent_door and state.get_timer(f'door_just_opened:{recent_door}') < 120)
        active_rooms_now = state.shared.get('active_rooms', []) or []
        confidence = 'medium' if (door_recent or active_rooms_now) else 'low'

    # ── 7. Floor count ──
    active_rooms = state.shared.get('active_rooms', []) or []
    if live_count == 0 and active_rooms:
        live_count = 1

    # ── 7a. Door-event-driven Constant lock with ROLLING MAX during stabilize ──
    # On Main Door close (or inferred Tier-1↔Tier-3 transit), open a stabilize
    # window. During the window, track the rolling max of `live_count` —
    # captures the entry peak even when sensors decay before window-end.
    if main_door_closed_now or inferred_transit:
        state.set_timer('_post_door_stabilize')
        state.shared['_recalc_pending']    = True
        state.shared['_recount_max_zones'] = 0  # reset rolling max for new window

    # Only update the rolling max while the timer is still INSIDE the
    # configured stabilize window. After the window closes, the value is
    # frozen until the snapshot fires below — otherwise gaps between events
    # (e.g. quiet period until next heartbeat) let stale post-window peaks
    # leak into the locked count.
    if state.shared.get('_recalc_pending') and \
       state.get_timer('_post_door_stabilize') < door_close_stabilize_sec:
        prev_max = int(state.shared.get('_recount_max_zones') or 0)
        if live_count > prev_max:
            state.shared['_recount_max_zones'] = live_count

    recalc_pending = bool(state.shared.get('_recalc_pending'))
    if recalc_pending and state.get_timer('_post_door_stabilize') >= door_close_stabilize_sec:
        # Snapshot — lock = rolling max during the window.
        snapshot_max = int(state.shared.get('_recount_max_zones') or live_count)
        state.shared['_people_locked_count'] = snapshot_max
        state.shared['_people_last_lock_ts'] = _now_iso()
        state.shared['_recalc_pending']      = False
        # Capture which zones were sustained at lock time — so discovery can
        # tell new occupants from already-locked ones.
        state.shared['_people_lock_zones']   = sorted(set(sustained_zones_deduped))
        locked_count   = snapshot_max
        recalc_pending = False
    elif state.shared.get('_people_locked_count') is not None:
        locked_count = int(state.shared['_people_locked_count'])
    else:
        # First evaluation after boot — seed from current live count.
        locked_count = live_count
        state.shared['_people_locked_count']    = locked_count
        state.shared['_people_last_lock_ts']    = _now_iso()
        state.shared['_people_lock_zones']      = sorted(set(sustained_zones_deduped))

    # ── 7b. Zone-based discovery with 5-min decay ──
    # A sustained zone can bump the dynamic count if:
    #   1. It's not in the lock-time snapshot (`_people_lock_zones`)
    #   2. No corridor-transit involvement in the last `zone_accounted_decay_sec`
    # When a presence sensor fires, stamp accounted ONLY for zones the
    # sensor's cone actually covers (from state.spatial['device_to_zones']).
    # The prior approach — stamping every zone in the device's room — was
    # too broad: a single sensor firing in Living Room marked Sofa, Dining
    # Table, Kitchen Bar, and Kitchen Cooking all as "accounted," blocking
    # discovery of a second occupant who later sustained any of those zones.
    if dtype in PRESENCE_TYPES and _presence_active(dps):
        d2z = (state.spatial or {}).get('device_to_zones') or {}
        sensor_info = d2z.get(dev_id) or {}
        for z in (sensor_info.get('zones') or []):
            state.set_timer(f'zone_accounted:{z}')

    lock_zones = set(state.shared.get('_people_lock_zones') or [])
    discovered_count = 0
    discovered_zones = []
    for z in sustained_zones_deduped:
        if z in lock_zones:
            continue
        if state.get_timer(f'zone_accounted:{z}') < zone_accounted_decay_sec:
            continue
        discovered_count += 1
        discovered_zones.append(z)

    state.shared['_people_discovered_count']    = discovered_count
    state.shared['_people_discovered_zones']    = sorted(discovered_zones)

    dynamic_count = max(live_count, locked_count + discovered_count)

    # ── 8. Occupied rooms = union of presence_rooms + zone owners + active_rooms ──
    zone_owner_rooms = {zone_to_room.get(z, '') for z in sustained_zones_deduped}
    zone_owner_rooms.discard('')
    occupied_rooms = sorted(
        set(presence_rooms_folded) | zone_owner_rooms | set(active_rooms)
    )

    # ── 9. Exit detection ──
    # NOTE: home_mode (home/away/abroad) is owned by mode_buttons.py — that
    # rule reads base rule 2 sentences + 8 Gang Switch button state and
    # writes state.shared['home_mode']. People Home no longer touches it
    # (single-responsibility: this rule only counts people).
    last_motion_sec = state.get_timer('last_motion')
    recent_door = state.shared.get('_last_door_opened', '')
    if recent_door:
        opened_ago = state.get_timer(f'door_just_opened:{recent_door}')
        if exit_quiet_window <= opened_ago < exit_quiet_window * 2 and last_motion_sec > exit_quiet_window:
            state.shared['last_exited_via']    = recent_door
            state.shared['last_transition_ts'] = _now_iso()
            state.shared['_last_door_opened']  = ''

    # ── 11. Derive count_state for dashboard display ──
    floored = (live_count != locked_count)
    if main_door_now == 'open':
        people_count_state = 'transit'
        confidence         = 'transit'
    elif recalc_pending:
        people_count_state = 'recounting'
        confidence         = 'recalculating'
    else:
        people_count_state = 'stable'

    # Authoritative transition source for this tick
    if main_door_opened_now:
        transition_source = 'door_sensor'
    elif inferred_transit:
        transition_source = f'inferred_{inferred_transit}'
    else:
        transition_source = state.shared.get('_last_transition_source', '')
    if transition_source:
        state.shared['_last_transition_source'] = transition_source

    # ── 12. Publish + emit ──
    # Constant: people_home = locked snapshot. Updates only on door-event
    # recount (rolling max during stabilize window).
    # Dynamic: people_home_dynamic = locked + discovered, never below live_count.
    state.shared['people_home']         = locked_count
    state.shared['people_home_dynamic'] = dynamic_count
    state.shared['occupied_rooms']      = occupied_rooms
    state.shared['people_count_state']  = people_count_state

    state.emit_virtual_event(
        virtual_id='virtual:people_home',
        dps={
            # Legacy (dashboard reads these — preserved byte-identical, except
            # `home_mode` was removed 2026-04-25; ownership moved to mode_buttons.py).
            'people_home':        locked_count,
            'someone_home':       dynamic_count > 0,
            'occupied_rooms':     occupied_rooms,
            'people_confidence':  confidence,
            'last_entered_via':   state.shared.get('last_entered_via', ''),
            'last_exited_via':    state.shared.get('last_exited_via', ''),
            'last_transition_ts': state.shared.get('last_transition_ts', ''),
            # Lock diagnostics
            'people_count_state':      people_count_state,
            'people_count_floored':    floored,
            'people_count_high_water': locked_count,
            'people_count_live':       live_count,
            'last_transition_source':  transition_source,
            # Dynamic — Constant + discovered_count (never below live)
            'people_home_dynamic':     dynamic_count,
            'people_discovered_count': discovered_count,
            # NEW — zone diagnostics
            'live_basis':           live_basis,           # 'zones' | 'rooms_fallback'
            'sustained_zones':      sorted(sustained_zones_deduped),
            'discovered_zones':     sorted(discovered_zones),
        },
        source='rule:People Home',
        name='People Home State',
        dps_labels={
            'people_home':             'People Count (Constant, door-locked)',
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
            'people_home_dynamic':     'People Count (Dynamic, +discoveries)',
            'people_discovered_count': 'Discoveries Since Last Door Event',
            'live_basis':              'Live Count Basis (zones | rooms_fallback)',
            'sustained_zones':         'Sustained Zones (≥ gate)',
            'discovered_zones':        'Newly Discovered Zones',
        },
    )

    return []
