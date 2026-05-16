"""Estimate people count using a single high-water-since-last-door-close metric.

Rewritten 2026-05-13 — replaces the Constant/Dynamic split with one number.

Algorithm (one path, no recount window):
  1. Build `sustained_zones` from `state.shared['active_zones']`:
       - Exclude transit zones (doorways, walkways).
       - Exclude zones owned by exterior / transit-only rooms (Corridor, Hallway).
       - Require each surviving zone to have been continuously active for
         `zone_sustained_sec` (default 30 s) with `ZONE_GAP_TOLERANCE_SEC`
         flicker tolerance.
  2. Per-room cap of 1: group sustained zones by their owner room and count
     each room once. `live_count = len(distinct rooms)`. Defends against
     FP2 zone polygons that overlap at boundaries (a single person at a
     zone edge registers in 2-3 zones simultaneously). The full
     `sustained_zones` list is still emitted as a diagnostic, but it
     doesn't drive the count.
  3. Maintain a rolling high-water mark in `state.shared['people_home']`:
       - On every tick, `people_home = max(people_home, live_count)`.
       - On Main Door rising-edge close (open → closed), provided the door
         was open for at least `main_door_min_open_sec` (default 3 s),
         RESET: `people_home = live_count`. This is the only path that
         decreases the value. Justified by the invariant: the Main Door is
         the only way to leave, so when it closes whoever is actually
         inside IS who is inside.
  4. `people_count_state`:
       - 'transit'  while Main Door is open
       - 'stable'   otherwise

FP2 (Aqara) integration is automatic: Home Activity now lights up each
`z_*` DPS field as its own `active_zones` entry, so sustained-zone counting
picks them up natively.

Removed in this rewrite:
- `people_home_dynamic` (was Constant + discoveries)
- `_people_locked_count`, `_people_lock_zones`, `_recount_max_zones`,
  `_recalc_pending`, `_post_door_stabilize`, `_people_discovered_*`
- `zone_accounted:*` timers (no longer needed — discovery layer dissolved)
- `people_count_state = 'recounting'` (no stabilize window to be in)

Preserved (consumers still rely on these):
- `people_home`             — the single count (high-water)
- `someone_home`            — bool, dynamic_count > 0
- `occupied_rooms`          — union of zones / rooms / fallback
- `last_entered_via` / `last_exited_via` / `last_transition_ts`
- `people_count_state`      — 'transit' | 'stable'
- `people_confidence`       — high / medium / low / transit
- `active_zones`, `active_rooms` (read from Home Activity)
- `home_mode` — NOT touched here (owned by mode_buttons.py)

Tuning knobs (state.shared, all sentence-controlled via apartment.rule_sentences):
- people_home.corridor_sec                 — default 15
- people_home.door_transit_window_sec      — default 10
- people_home.exit_quiet_window_sec        — default 30
- people_home.transit_sequence_window_sec  — default 15
- people_home.zone_sustained_sec           — default 30
- people_home.main_door_min_open_sec       — default 3   (anti-bounce on door cycle)
- people_home.count_settle_sec             — default 60  (settle window before high-water rises)
"""

from datetime import datetime, timezone


RULE = {
    "name": "People Home",
    "description": "People count (high-water since last Main Door close, zone-based)",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
    "group": "info",
    "priority": 2,
    "depends_on": ["Home Activity"],
}

PRESENCE_TYPES = {'presence', 'motion'}
DOOR_TYPES     = {'door_sensor'}

# Tier classification for inferred-transit detection (entry/exit metadata).
DEFAULT_EXTERIOR_ROOMS  = ('Corridor',)
DEFAULT_THRESHOLD_ROOMS = ('Entrance',)
DEFAULT_TRANSIT_ROOMS   = ('Hallway',)
EXTERIOR_MOTION_NAME_HINTS = ('doorbell', 'ring bell', 'ring doorbell')

# Transit zones — doorways / walkways. Always excluded from people count.
DEFAULT_TRANSIT_ZONES = (
    'Hallway Walkway',
    'Living Room Doorway',
    'Entrance Walkway',
    'My BathRoom Doorway',
    'Bedroom Doorway',
    'Balcony Doorway',
    'Kitchen Walkway',
    'Corridor Doorway',
    'Guy Room Doorway',
    'My Room Doorway',
    'DressRoom Doorway',
    'Bathroom Walkway',
    'Living Room Walkway',
    'Bedroom Balcony Walkway',
    'Flower WalkWay',
)

# Sensor-flicker tolerance: a zone can drop out of active_zones for up to
# this many seconds without resetting its sustained-active timer.
ZONE_GAP_TOLERANCE_SEC = 15


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


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _is_exterior_motion(device, name_hints):
    if (device.get('device_type') or '').lower() != 'motion':
        return False
    nm = (device.get('name') or '').lower()
    return any(h in nm for h in name_hints)


def _main_door_state(state):
    val = state.shared.get('door:Main Door')
    return val if val in ('open', 'closed') else None


def _build_zone_to_room(spatial):
    """Map zone name → room display name from state.spatial."""
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
            for zone in zones:
                if isinstance(zone, dict):
                    zname = zone.get('name')
                    if zname:
                        zone_to_room[zname] = room_name
    return zone_to_room


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Knobs (all sentence-controlled via apartment.rule_sentences → KNOB_PATTERNS).
    try:
        corridor_sec         = int(state.shared.get('people_home.corridor_sec',                15))
        door_transit_window  = int(state.shared.get('people_home.door_transit_window_sec',     10))
        exit_quiet_window    = int(state.shared.get('people_home.exit_quiet_window_sec',       30))
        transit_seq_window   = int(state.shared.get('people_home.transit_sequence_window_sec', 15))
        zone_sustained_sec   = int(state.shared.get('people_home.zone_sustained_sec',          30))
        main_door_min_open   = int(state.shared.get('people_home.main_door_min_open_sec',       3))
        count_settle_sec     = int(state.shared.get('people_home.count_settle_sec',            60))
    except (TypeError, ValueError):
        corridor_sec, door_transit_window = 15, 10
        exit_quiet_window, transit_seq_window = 30, 15
        zone_sustained_sec, main_door_min_open = 30, 3
        count_settle_sec = 60

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

    # ── 1. Corridor transition tracking (for entry/exit metadata) ──
    if dtype in PRESENCE_TYPES and room and _presence_active(dps):
        prev_room  = state.shared.get('_prev_presence_room', '')
        prev_timer = state.get_timer('_prev_presence_time')
        state.shared['_prev_presence_room'] = room
        state.set_timer('_prev_presence_time')
        if prev_room and prev_room != room and prev_timer < corridor_sec:
            state.set_timer(f'corridor:{prev_room}>{room}')

    # ── 2. Door open event — stamp for entry/exit window ──
    if dtype in DOOR_TYPES:
        open_state = _door_is_open(dps)
        if open_state is True:
            door_info = door_map.get(dev_id) or {}
            door_name = door_info.get('name') or device.get('name') or dev_id
            state.set_timer(f'door_just_opened:{door_name}')
            state.shared['_last_door_opened'] = door_name

    # ── 2a. Main Door transitions ──
    main_door_now  = _main_door_state(state)
    prev_main_door = state.shared.get('_prev_main_door_state')
    main_door_opened_now = (main_door_now == 'open'   and prev_main_door == 'closed')
    main_door_closed_now = (main_door_now == 'closed' and prev_main_door == 'open')
    if main_door_now is not None:
        state.shared['_prev_main_door_state'] = main_door_now

    # Track how long the door has been open: stamp on rising-edge open,
    # check against min-open guard at rising-edge close. Filters accidental
    # brief opens (≤ main_door_min_open_sec) so they don't trigger reset.
    if main_door_opened_now:
        state.set_timer('_main_door_open_ts')
    main_door_was_open_long_enough = (
        main_door_closed_now and
        state.get_timer('_main_door_open_ts') >= main_door_min_open
    )

    # ── 2a-bis. Manual people count auto-clear ──
    # On EITHER Main Door transition (open or close), insert a NULL row in
    # manual_people_log so the dashboard's "Manual: N" chip reverts to
    # "Manual: —". Dedupe: skip if the last row is already NULL (e.g. user
    # already cleared manually) so we don't spam the table on every door
    # cycle. `calculated_count` captures people_home at clear time for
    # future AI calibration consumers.
    if main_door_opened_now or main_door_closed_now:
        door_event_label = 'open' if main_door_opened_now else 'close'
        try:
            last_manual = state.db_query(
                "SELECT value FROM manual_people_log ORDER BY ts DESC LIMIT 1"
            )
            if last_manual and last_manual[0][0] is not None:
                calc_now = int(state.shared.get('people_home', 0))
                state.db_execute(
                    "INSERT INTO manual_people_log (value, source, door_event, calculated_count) "
                    "VALUES (NULL, 'door_clear', %s, %s)",
                    (door_event_label, calc_now),
                )
        except Exception:
            pass  # best-effort; never breaks the rule

    # ── 2b. Tier-1 / Tier-3 transit signals (entry/exit inference) ──
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

    # ── 4. SUSTAINED-ZONE COUNT (single source of live count) ──
    raw_zones = list(state.shared.get('active_zones') or [])

    # Drop transit zones up front.
    candidate_zones = [z for z in raw_zones if z not in transit_zones]

    # Drop zones owned by exterior or transit rooms.
    counted_candidate_zones = []
    for z in candidate_zones:
        owner_room = zone_to_room.get(z, '')
        if owner_room in exterior_rooms or owner_room in transit_rooms:
            continue
        counted_candidate_zones.append(z)

    # Rising-edge sustained gate with flicker tolerance.
    current_zone_set = set(counted_candidate_zones)
    for z in current_zone_set:
        if state.get_timer(f'zone_last_seen:{z}') >= ZONE_GAP_TOLERANCE_SEC:
            state.set_timer(f'zone_first_active:{z}')
        state.set_timer(f'zone_last_seen:{z}')

    sustained_zones = sorted(
        z for z in counted_candidate_zones
        if state.get_timer(f'zone_first_active:{z}') >= zone_sustained_sec
    )

    # Per-room cap of 1: collapse same-room sustained zones to a single
    # occupant. Real-world FP2 zone polygons drawn in the Aqara app can
    # overlap (or touch) at boundaries — a single person sitting at a zone
    # edge then registers in multiple zones simultaneously. Without the cap,
    # one person counts as 2-3.
    # Future: opt-in `people_home.multi_target_rooms` knob to disable the
    # cap for rooms with physically-disjoint zones (e.g. once FP2 zones are
    # redrawn with gaps).
    counted_rooms = set()
    for z in sustained_zones:
        owner = zone_to_room.get(z, '')
        if owner:
            counted_rooms.add(owner)
    live_count = len(counted_rooms)

    # ── 5. Inferred transit detection (entry/exit metadata only) ──
    t1_age = state.get_timer('transit_tier1')
    t3_age = state.get_timer('transit_tier3')
    inferred_transit = None
    if t1_age < transit_seq_window and t3_age < transit_seq_window:
        if state.get_timer('_inferred_transit_fired') > transit_seq_window:
            state.set_timer('_inferred_transit_fired')
            if t1_age > t3_age:
                inferred_transit = 'entry'
                inferred_via = state.shared.get('_transit_tier1_via', 'exterior')
                state.shared['last_entered_via']   = f'{inferred_via} (inferred)'
            else:
                inferred_transit = 'exit'
                inferred_via = state.shared.get('_transit_tier3_via', 'threshold')
                state.shared['last_exited_via']    = f'{inferred_via} (inferred)'
            state.shared['last_transition_ts'] = _now_iso()

    # ── 6. HIGH-WATER + Main Door reset + settle gate ──
    #
    # Default behaviour: people_home rises to live_count only after live_count
    # has held *above* the current high-water for ≥ count_settle_sec. Filters
    # transient peaks (e.g. one person walking room-to-room with a tail of
    # sensor hold-off in the room they just left).
    #
    # The Main Door close (after a ≥ min_open window) is the ONLY event that
    # can DECREASE the count, and it bypasses the settle gate — whoever's
    # actually inside at the close moment IS who's inside.
    if main_door_was_open_long_enough or (inferred_transit == 'exit'):
        new_high_water = live_count
        state.shared['people_home'] = new_high_water
        state.shared['_people_last_reset_ts'] = _now_iso()
        state.shared['_was_above_high_water'] = False  # clear settle tracking
    else:
        prev_high_water = state.shared.get('people_home')
        if prev_high_water is None:
            # First evaluation after boot — seed from current live count.
            new_high_water = live_count
            state.shared['_was_above_high_water'] = False
        else:
            cur = int(prev_high_water)
            if live_count > cur:
                # Live exceeds current high-water. Apply settle gate.
                was_above = bool(state.shared.get('_was_above_high_water', False))
                if not was_above:
                    # Rising edge — start the settle timer, don't bump yet.
                    state.set_timer('_count_above_high_water_since')
                    state.shared['_was_above_high_water'] = True
                    new_high_water = cur
                elif state.get_timer('_count_above_high_water_since') >= count_settle_sec:
                    # Held above high-water long enough — promote.
                    new_high_water = live_count
                    state.shared['_was_above_high_water'] = False
                else:
                    # Still inside settle window — wait it out.
                    new_high_water = cur
            else:
                # Live not above high-water — no settle in progress.
                new_high_water = cur
                state.shared['_was_above_high_water'] = False
        state.shared['people_home'] = new_high_water

    # ── 7. Confidence ──
    if sustained_zones:
        confidence = 'high'
    elif new_high_water > 0:
        confidence = 'medium'
    else:
        recent_door = state.shared.get('_last_door_opened', '')
        door_recent = bool(recent_door and state.get_timer(f'door_just_opened:{recent_door}') < 120)
        active_rooms_now = state.shared.get('active_rooms', []) or []
        confidence = 'medium' if (door_recent or active_rooms_now) else 'low'

    # ── 8. Occupied rooms = union of zone owners + active_rooms ──
    active_rooms = state.shared.get('active_rooms', []) or []
    zone_owner_rooms = {zone_to_room.get(z, '') for z in sustained_zones}
    zone_owner_rooms.discard('')
    occupied_rooms = sorted(zone_owner_rooms | set(active_rooms))

    # ── 9. Exit detection (entry/exit metadata only) ──
    last_motion_sec = state.get_timer('last_motion')
    recent_door = state.shared.get('_last_door_opened', '')
    if recent_door:
        opened_ago = state.get_timer(f'door_just_opened:{recent_door}')
        if exit_quiet_window <= opened_ago < exit_quiet_window * 2 and last_motion_sec > exit_quiet_window:
            state.shared['last_exited_via']    = recent_door
            state.shared['last_transition_ts'] = _now_iso()
            state.shared['_last_door_opened']  = ''

    # ── 10. count_state for dashboard display ──
    if main_door_now == 'open':
        people_count_state = 'transit'
        confidence         = 'transit'
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

    # ── 11. Publish + emit ──
    state.shared['occupied_rooms']     = occupied_rooms
    state.shared['people_count_state'] = people_count_state

    state.emit_virtual_event(
        virtual_id='virtual:people_home',
        dps={
            'people_home':            new_high_water,
            'someone_home':           new_high_water > 0,
            'occupied_rooms':         occupied_rooms,
            'people_confidence':      confidence,
            'last_entered_via':       state.shared.get('last_entered_via', ''),
            'last_exited_via':        state.shared.get('last_exited_via', ''),
            'last_transition_ts':     state.shared.get('last_transition_ts', ''),
            'people_count_state':     people_count_state,
            'people_count_live':      live_count,
            'last_transition_source': transition_source,
            'sustained_zones':        sustained_zones,
            'counted_rooms':          sorted(counted_rooms),
        },
        source='rule:People Home',
        name='People Home State',
        dps_labels={
            'people_home':            'People Count (high-water since door close)',
            'someone_home':           'Someone Home',
            'occupied_rooms':         'Occupied Rooms',
            'people_confidence':      'Confidence',
            'last_entered_via':       'Last Entered Via',
            'last_exited_via':        'Last Exited Via',
            'last_transition_ts':     'Last Transition',
            'people_count_state':     'Count State (transit / stable)',
            'people_count_live':      'Live Sensor Count',
            'last_transition_source': 'Transition Source',
            'sustained_zones':        'Sustained Zones (currently active)',
            'counted_rooms':          'Counted Rooms (one occupant max per room)',
        },
    )

    return []
