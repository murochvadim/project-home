"""Track active rooms + zones from presence/motion + switches + door sensors.

Upgraded 2026-04-24 to consume the apartment spatial index
(state.spatial.rooms_by_slug / device_to_zones / subrooms). All legacy fields
on virtual:home_activity are preserved byte-identical for the dashboard Home
Activity card (no display regression). New zone-level fields + door snapshot
are additive.

Behaviour:
- Presence / motion event → light up every zone the sensor's cone covers
  (state.spatial.device_to_zones[dev_id]). Each zone lights up its parent room
  AND any sub-room (Kitchen / Dining Room / Entrance) whose zone-cluster it
  belongs to.
- Door sensor event → update the `door:<name>` snapshot in shared state.
  Doors by themselves don't mark activity; People Home consumes them for
  transit detection.
- Switch event → only counts if the device name contains the room name
  (legacy heuristic — placement ownership upgrade deferred).
- Spatial index unavailable (startup race) → falls back to today's flat-room
  behaviour. Rules work either way.

Tuning knobs (optional, from state.shared — populated by the sentence parser):
- home_activity.hold_off_sec        — default 10
- home_activity.interact_window_sec — default 120
- home_activity.level_low_max       — default 2 (count ≤ this → 'low', more → 'active')
"""

RULE = {
    "name": "Home Activity",
    "description": "Active rooms + zones from presence/motion + switches + door sensors (spatial-aware)",
    "triggers": ["*"],
    "controls": [],
    "category": "info",
    "group": "info",
    "priority": 1,
}

PRESENCE_TYPES = {'presence', 'motion'}
SWITCH_TYPES   = {'switch', 'circuit_breaker', 'light'}
DOOR_TYPES     = {'door_sensor'}


# ─────────────────────────── Helpers ───────────────────────────

def _name_matches_room(device_name, room):
    """Legacy heuristic: device name contains the room name (case-insensitive)."""
    if not device_name or not room:
        return False
    return room.lower() in device_name.lower()


def _presence_active(dps):
    """Protocol-aware: Tuya '1', Aeotec 'motion', Z2M 'occupancy'."""
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
    """Aeotec `door: true/false` (true=open), Z2M `contact: true/false` (false=open), Tuya `'1'`."""
    if not isinstance(dps, dict):
        return None
    if dps.get('door') is True:    return True
    if dps.get('door') is False:   return False
    if dps.get('contact') is False: return True
    if dps.get('contact') is True:  return False
    if dps.get('1') is True:       return True
    if dps.get('1') is False:      return False
    return None


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Tunable knobs (fall back to defaults if the sentence parser hasn't populated them yet)
    try:
        hold_off_sec    = int(state.shared.get('home_activity.hold_off_sec',       10))
        interact_window = int(state.shared.get('home_activity.interact_window_sec', 120))
        level_low_max   = int(state.shared.get('home_activity.level_low_max',        2))
    except (TypeError, ValueError):
        hold_off_sec, interact_window, level_low_max = 10, 120, 2

    spatial         = state.spatial or {}
    rooms_by_slug   = spatial.get('rooms_by_slug') or {}
    device_to_zones = spatial.get('device_to_zones') or {}
    subrooms        = spatial.get('subrooms') or {}

    dev_id = event.get('device_id', '')
    device = state.devices.get(dev_id, {})
    dtype  = (device.get('device_type') or '').lower()
    room   = device.get('room', '')
    name   = device.get('name', '')
    dps    = event.get('dps', {}) or {}

    # ── 1. Event dispatch ──

    if dtype in PRESENCE_TYPES:
        if _presence_active(dps):
            if room:
                state.set_timer(f'room_active:{room}')
                state.shared['last_motion_room'] = room
            state.set_timer('last_motion')

            # Zone activity — ONLY the sensor's *primary* zone (beam midpoint),
            # not every zone its cone edge touches. Full cone-coverage list
            # stays in `info['zones']` for coverage queries; activity uses
            # `primary_zone` to avoid false-activating adjacent sub-rooms
            # (e.g. Dining Room Presence's cone edge reaching into Kitchen
            # Walkway shouldn't mark the Kitchen sub-room active).
            info = device_to_zones.get(dev_id) or {}
            primary_zone = info.get('primary_zone')
            if primary_zone:
                state.set_timer(f'zone_active:{primary_zone}')
                state.shared['last_motion_zone'] = primary_zone
                # Sub-room activation: only if the primary zone belongs to a sub-room
                for subroom_name, subinfo in subrooms.items():
                    if primary_zone in (subinfo.get('zones') or []):
                        state.set_timer(f'room_active:{subroom_name}')

        # Multi-zone radar event dispatch (Aqara FP2 et al.) — independent of
        # the global `_presence_active` check above. Each z_* DPS field in the
        # event lights its own zone; FP2 can fire zone-only updates without
        # raising the global `presence` field.
        dps_labels = device.get('dps_labels') or {}
        for dpkey, zone_label in dps_labels.items():
            if not isinstance(dpkey, str) or not dpkey.startswith('z_'):
                continue
            val = dps.get(dpkey)
            if val is True or val == 1 or val == 'on' or val == '1' or val == 'true' or val == 'True':
                if zone_label:
                    state.set_timer(f'zone_active:{zone_label}')
                    state.shared['last_motion_zone'] = zone_label
                    state.set_timer('last_motion')
                    if room:
                        state.set_timer(f'room_active:{room}')
                        state.shared['last_motion_room'] = room
                    for subroom_name, subinfo in subrooms.items():
                        if zone_label in (subinfo.get('zones') or []):
                            state.set_timer(f'room_active:{subroom_name}')
        # Clear event: do NOT reset timer — let the hold-off expire naturally

    elif dtype in DOOR_TYPES:
        open_state = _door_is_open(dps)
        if open_state is not None:
            door_name = name or dev_id
            state.shared[f'door:{door_name}'] = 'open' if open_state else 'closed'

    elif dtype in SWITCH_TYPES and room and event.get('source') != 'startup':
        if _name_matches_room(name, room):
            # Zigbee switches send periodic retain messages with the full state
            # payload (e.g. state_l1=OFF even when nothing changed). Only treat
            # this as a real interaction when the state signature actually differs
            # from what we saw last time — otherwise every retain would falsely
            # mark the room active for the 120s interact window.
            META = ('last_seen', 'linkquality', 'battery', 'battery_low',
                    'tamper', 'voltage', 'current', 'power', 'energy')
            state_sig = tuple(sorted(
                (k, str(v)) for k, v in dps.items() if k not in META
            ))
            sig_key = f'_sw_sig:{dev_id}'
            prev_sig = state.shared.get(sig_key)
            state.shared[sig_key] = state_sig  # always remember
            if state_sig and prev_sig is not None and prev_sig != state_sig:
                state.set_timer(f'room_interact:{room}')
                state.set_timer(f'room_active:{room}')
                state.shared['last_motion_room'] = room
                state.set_timer('last_motion')

    # ── 2. Scan to build active_rooms + active_zones ──

    active_rooms = set()
    active_zones = set()

    # 2a. Currently-active presence sensors
    for did, dev in state.devices.items():
        if (dev.get('device_type') or '').lower() not in PRESENCE_TYPES:
            continue
        if not dev.get('online', True):
            continue
        r = dev.get('room', '')
        dps_now = dev.get('dps') or {}

        if _presence_active(dps_now):
            if r:
                active_rooms.add(r)
            # Use primary_zone only — cone edges can touch adjacent sub-room zones
            # (e.g. Dining Room Presence reaches into Kitchen Walkway) which would
            # falsely activate those sub-rooms in step 2c.
            info = device_to_zones.get(did) or {}
            pz = info.get('primary_zone')
            if pz:
                active_zones.add(pz)
        elif r and state.get_timer(f'room_active:{r}') < hold_off_sec:
            active_rooms.add(r)

        # Multi-zone radar branch (Aqara FP2 et al.) — any DPS key named `z_*`
        # is an independent per-zone boolean. Activate each zone whose key is
        # truthy in the current dps payload, mapped to its dps_label (which
        # must match the room's layout zone name). Independent of the
        # primary_zone / room-presence checks above — a multi-zone radar can
        # light up several zones simultaneously without the device showing
        # global presence.
        dps_labels = dev.get('dps_labels') or {}
        for dpkey, zone_label in dps_labels.items():
            if not isinstance(dpkey, str) or not dpkey.startswith('z_'):
                continue
            val = dps_now.get(dpkey)
            if val is True or val == 1 or val == 'on' or val == '1' or val == 'true' or val == 'True':
                if zone_label:
                    active_zones.add(zone_label)
                    state.set_timer(f'zone_active:{zone_label}')
                    if r:
                        active_rooms.add(r)

    # 2b. Zone hold-off (a zone stays active for `hold_off_sec` after its last fire)
    for rdata in rooms_by_slug.values():
        for zname in rdata.get('zones', {}):
            if state.get_timer(f'zone_active:{zname}') < hold_off_sec:
                active_zones.add(zname)

    # 2c. Sub-room activation from active zones
    for subroom_name, subinfo in subrooms.items():
        if any(z in active_zones for z in subinfo.get('zones', [])):
            active_rooms.add(subroom_name)

    # 2d. Named-switch interact window
    for did, dev in state.devices.items():
        if (dev.get('device_type') or '').lower() not in SWITCH_TYPES:
            continue
        r = dev.get('room', '')
        if r and _name_matches_room(dev.get('name', ''), r):
            if state.get_timer(f'room_interact:{r}') < interact_window:
                active_rooms.add(r)

    # ── 3. Activity level ──

    active_rooms_list = sorted(active_rooms)
    active_zones_list = sorted(active_zones)
    count = len(active_rooms_list)
    if count == 0:
        level = 'idle'
    elif count <= level_low_max:
        level = 'low'
    else:
        level = 'active'

    # ── 4. Door-state snapshot (mirror of state.shared['door:*']) ──

    door_state = {}
    for k, v in state.shared.items():
        if k.startswith('door:') and isinstance(v, str):
            door_state[k[len('door:'):]] = v

    # ── 5. Publish + emit virtual event ──

    state.shared['activity_level']    = level
    state.shared['active_rooms']      = active_rooms_list
    state.shared['active_room_count'] = count
    state.shared['active_zones']      = active_zones_list
    state.shared['active_zone_count'] = len(active_zones_list)

    state.emit_virtual_event(
        virtual_id='virtual:home_activity',
        dps={
            # Legacy fields (dashboard Home Activity card reads these)
            'activity_level':    level,
            'active_rooms':      active_rooms_list,
            'active_room_count': count,
            'last_motion_room':  state.shared.get('last_motion_room', ''),
            # New fields (additive)
            'active_zones':      active_zones_list,
            'active_zone_count': len(active_zones_list),
            'last_motion_zone':  state.shared.get('last_motion_zone', ''),
            'door_state':        door_state,
        },
        source='rule:Home Activity',
        name='Home Activity State',
        dps_labels={
            'activity_level':    'Activity Level',
            'active_rooms':      'Active Rooms',
            'active_room_count': 'Active Room Count',
            'last_motion_room':  'Last Motion Room',
            'active_zones':      'Active Zones',
            'active_zone_count': 'Active Zone Count',
            'last_motion_zone':  'Last Motion Zone',
            'door_state':        'Door State',
        },
    )

    return []
