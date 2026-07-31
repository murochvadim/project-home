"""
Home Assistant API adapter — subscribes to HA WebSocket for real-time state changes.

HA receives instant Tuya cloud push for ALL devices. This adapter taps into that
by subscribing to HA's state_changed events via WebSocket. When a Tuya device
changes state in HA, we convert the HA entity state back to Tuya DPS format
and call on_state_change().

This replaces local_poll and cloud_poll for devices that don't support TCP push.
"""

import json
import logging
import os
import re
import threading
import time

import requests
import websocket

from .base import DeviceAdapter

log = logging.getLogger('ha_api')

HA_URL   = os.environ.get('HA_URL', 'http://192.168.1.110:8123')
HA_TOKEN = os.environ.get('HA_TOKEN', '')
HA_WS    = HA_URL.replace('http://', 'ws://').replace('https://', 'wss://') + '/api/websocket'

RECONNECT_DELAY = 5
RECONNECT_MAX   = 60

# Keepalive interval (seconds) — how often to touch `last_seen` for every
# reachable HA-mapped device. HA sends `state_changed` only on actual state
# changes, so wired switches with no secondary sensors (battery/illuminance/
# temp) look stale for hours when nobody uses them even though they are fine.
# 15 min stays comfortably under the group_health_watchdog's 30-min zwave
# threshold. `unavailable`/`unknown` entities are skipped so genuinely broken
# devices still stand out.
KEEPALIVE_INTERVAL_SEC = 900


class HAApiAdapter(DeviceAdapter):
    vendor = 'tuya'

    # ── HA-direct devices (id = entity_id, no identifier mapping) ──
    # Class-level so both _build_entity_map (registration) and
    # _fetch_all_states (initial seed allowlist) consume the same source
    # of truth. Adding a new HA-integrated device = one edit here.
    #
    # Each entry maps a devices.id to a list of (entity_id, dp_key)
    # tuples → ONE devices row pulled from N HA entities. dp_key=None
    # means "domain-specific multi-attr projection" (handled in
    # _on_ws_message). Other dp_keys are single-value sensor entities.
    #
    # Roomba: state from vacuum.roomba (multi-attr) + battery from
    # sensor.roomba_battery (Roomba's vacuum entity doesn't expose
    # battery_level in attributes).
    # Viomi: state + battery_level both come from the single vacuum
    # entity's attributes — no auxiliary sensor needed.
    HA_DIRECT_DEVICES = {
        'vacuum.roomba': [
            ('vacuum.roomba',                      None),              # main entity, multi-attr
            ('sensor.roomba_battery',              'battery'),         # aux sensor → 'battery'
            ('binary_sensor.roomba_charging',      'charging'),        # on/off → bool
            ('sensor.roomba_total_missions',       'total_missions'),  # lifetime mission count
            ('sensor.roomba_average_mission_time', 'avg_mission_time'),# minutes
        ],
        'vacuum.viomi_v6_2b2a_robot_cleaner': [
            ('vacuum.viomi_v6_2b2a_robot_cleaner', None),  # main entity (battery in attrs)
        ],
        # Roborock S6 (Xiaomi Miot Auto entity — Mi Home account, local control).
        # Same shape as Viomi: battery_level is in the vacuum entity's attributes.
        'vacuum.roborock_s6_f881_robot_cleaner': [
            ('vacuum.roborock_s6_f881_robot_cleaner', None),  # main entity (battery in attrs)
        ],
        # Aqara FP2 (paired via HomeKit Controller, NOT Tuya). Each zone in
        # Aqara's app surfaces as its own binary_sensor in HA. The 6 zones
        # below are the named zones currently set in the Living Room FP2;
        # if more are added in Aqara, append matching tuples here + extend
        # devices.dps_labels for fp2_presence_335e.
        'fp2_presence_335e': [
            ('binary_sensor.presence_sensor_fp2',                        'presence'),
            ('sensor.presence_sensor_fp2_335e_light_sensor_light_level', 'illuminance'),
            ('binary_sensor.presence_sensor_balcony_doorway',            'z_balcony_doorway'),
            ('binary_sensor.presence_sensor_dining_table',               'z_dining_table'),
            ('binary_sensor.presence_sensor_kitchen_bar',                'z_kitchen_bar'),
            ('binary_sensor.presence_sensor_kitchen_cooking',            'z_kitchen_cooking'),
            ('binary_sensor.presence_sensor_kitchen_walkway',            'z_kitchen_walkway'),
            ('binary_sensor.presence_sensor_sofa_entertaiment',          'z_sofa_entertaiment'),
        ],
        # Shelly 3EM Gen 1 — 3-phase apartment energy meter. 15 sensors
        # (R/S/T × {voltage, current, active power, power factor,
        # cumulative energy}). Naming matches HA's electrician convention
        # (R/S/T = L1/L2/L3) and is preserved end-to-end through DPS keys,
        # power_consumption columns, virtual:phase_<r|s|t>_background ids,
        # and dashboard labels. See POWER/CLAUDE.md.
        'shelly_3em_main': [
            ('sensor.r_voltage',      'r_v'),
            ('sensor.r_current',      'r_a'),
            ('sensor.r_power',        'r_w'),
            ('sensor.r_power_factor', 'r_pf'),
            ('sensor.r_energy',       'r_kwh'),
            ('sensor.s_voltage',      's_v'),
            ('sensor.s_current',      's_a'),
            ('sensor.s_power',        's_w'),
            ('sensor.s_power_factor', 's_pf'),
            ('sensor.s_energy',       's_kwh'),
            ('sensor.t_voltage',      't_v'),
            ('sensor.t_current',      't_a'),
            ('sensor.t_power',        't_w'),
            ('sensor.t_power_factor', 't_pf'),
            ('sensor.t_energy',       't_kwh'),
        ],
        # Samsung TVs (state only — POWER subsystem reads dps['state'] to
        # decide ON/OFF for state_known power_devices rows). Unmatched
        # domain in _ha_state_to_dps_value → state passes through as raw
        # string ('on' / 'off' / 'playing' / 'idle' / 'standby').
        #
        # TV 85 QLED has TWO sources both projecting to the same `state`
        # dps key. Reason: the Samsung TV HA integration goes 'unavailable'
        # for days at a time (broke 2026-05-26 for >4 days continuously),
        # but the smart-plug `switch.samsung_85_qled` reliably tracks
        # power. The adapter's _on_ws_message filters out 'unavailable'/
        # 'unknown', so the broken media_player can't overwrite the
        # switch's 'on'/'off' — whichever has a usable value wins. Media
        # Agents already trusts the switch entity (tv_control.py
        # TV_SWITCH). Q60BA 50 / Q49 BA have no smart plug, so they keep
        # the media_player-only entry below.
        'media_player.samsung_85_qled':       [
            ('media_player.samsung_85_qled',  'state'),
            ('switch.samsung_85_qled',        'state'),
        ],
        'media_player.samsung_q60ba_50_tv_2': [('media_player.samsung_q60ba_50_tv_2', 'state')],
        'media_player.samsung_q49_ba_tv':     [('media_player.samsung_q49_ba_tv',     'state')],
        'media_player.balcony_55_neo_qled':   [('media_player.balcony_55_neo_qled',   'state')],
        # Alexa Echo devices + Samsung soundbar (built-in Alexa). devices
        # rows already exist (protocol='alexa', identity-only); adding here
        # so their HA media_player state flows into last_state for power
        # attribution.
        'media_player.10inch_echo_show':   [('media_player.10inch_echo_show',   'state')],
        'media_player.alexa_guy_room':     [('media_player.alexa_guy_room',     'state')],
        'media_player.samsung_soundbar_2': [('media_player.samsung_soundbar_2', 'state')],
        'media_player.alexa_maya_bedroom': [('media_player.alexa_maya_bedroom', 'state')],
        'media_player.alexa_my_bathroom':  [('media_player.alexa_my_bathroom',  'state')],
    }

    def __init__(self, devices, on_state_change):
        super().__init__(devices, on_state_change)
        self._stop_event = threading.Event()
        self._thread = None
        # tuya_device_id → list of {entity_id, domain, dp_key}
        self._entity_map: dict[str, list[dict]] = {}
        # entity_id → tuya_device_id (reverse lookup)
        self._reverse_map: dict[str, str] = {}
        # Known device IDs we care about
        self._known_ids = {d['id'] for d in devices}
        self._smartthings_ids = set()  # IDs sourced from SmartThings (for seed restriction)
        # Watchdog state — auto-heal stuck WebSocket (websocket-client 1.9.0
        # occasionally logs "ping/pong timed out - goodbye" without invoking
        # on_close, so run_forever() never returns and our reconnect loop hangs).
        self._ws = None                   # current WebSocketApp; set before run_forever()
        self._last_event_ts = 0.0         # updated on every WS message
        self._last_auth_ok_ts = 0.0       # updated on auth_ok; reset per connect
        self._ws_connect_ts = 0.0         # when current run_forever() started
        self._pending_pings: dict[int, float] = {}  # {msg_id: send_ts}
        self._next_msg_id = 1000          # ping ids — disjoint from subscribe_events id=1
        self._watchdog_thread = None
        self._watchdog_stop = threading.Event()
        # Entity-build health tracking.
        # `_entity_build_healthy` flips False when a build call returns 0
        # entities for a category that previously had >0 (regression =
        # HA was up enough for the WS handshake but not for the template
        # API; the build "succeeded" with empty results). Both the post-
        # auth rebuild and the watchdog's condition-2 use this flag
        # instead of `len(_entity_map)`, because ha_direct devices are
        # ALWAYS added to the map (hardcoded), so checking emptiness
        # alone never detects the regression.
        self._last_good_tuya_count = 0
        self._last_good_st_count = 0
        self._entity_build_healthy = False
        self._keepalive_thread = None
        self._keepalive_stop = threading.Event()

    def _build_entity_map(self):
        """Query HA template API to build tuya_id → entity mapping."""
        log.info('Building HA entity → Tuya device map')
        try:
            tpl = (
                '{% set ns = namespace(items=[]) %}'
                '{% for state in states %}'
                '{% set ids = device_attr(state.entity_id,"identifiers") %}'
                '{% if ids %}{% for id in ids %}'
                '{% if id[0] == "tuya" %}'
                '{% set ns.items = ns.items + [id[1] ~ "|" ~ state.entity_id] %}'
                '{% endif %}{% endfor %}{% endif %}{% endfor %}'
                '{{ ns.items | join("\\n") }}'
            )
            r = requests.post(
                f'{HA_URL}/api/template',
                headers={'Authorization': f'Bearer {HA_TOKEN}', 'Content-Type': 'application/json'},
                json={'template': tpl},
                timeout=30,
            )
            r.raise_for_status()

            self._entity_map.clear()
            self._reverse_map.clear()

            for line in r.text.strip().split('\n'):
                if '|' not in line:
                    continue
                tuya_id, entity_id = line.split('|', 1)
                tuya_id = tuya_id.strip()
                entity_id = entity_id.strip()

                if tuya_id not in self._known_ids:
                    continue

                # Extract DPS key from entity_id suffix (e.g. switch_1 → "1", switch_2 → "2")
                dp_key = '1'
                m = re.search(r'_(\d+)$', entity_id)
                if m:
                    dp_key = m.group(1)

                domain = entity_id.split('.')[0]

                if tuya_id not in self._entity_map:
                    self._entity_map[tuya_id] = []
                self._entity_map[tuya_id].append({
                    'entity_id': entity_id,
                    'domain': domain,
                    'dp_key': dp_key,
                })
                self._reverse_map[entity_id] = tuya_id

            log.info(f'HA map (tuya): {len(self._reverse_map)} entities → {len(self._entity_map)} devices')

        except Exception as e:
            log.error(f'Failed to build Tuya entity map: {e}')

        # ── External HA integrations (SmartThings + Ring) ──
        self._smartthings_ids.clear()
        try:
            st_tpl = (
                '{% set ns = namespace(items=[]) %}'
                '{% for state in states %}'
                '{% set ids = device_attr(state.entity_id,"identifiers") %}'
                '{% if ids %}{% for id in ids %}'
                '{% if id[0] in ["smartthings", "ring"] %}'
                '{% set ns.items = ns.items + [id[1] ~ "|" ~ state.entity_id ~ "|" ~ device_attr(state.entity_id, "name")] %}'
                '{% endif %}{% endfor %}{% endif %}{% endfor %}'
                '{{ ns.items | join("\\n") }}'
            )
            st_r = requests.post(
                f'{HA_URL}/api/template',
                headers={'Authorization': f'Bearer {HA_TOKEN}', 'Content-Type': 'application/json'},
                json={'template': st_tpl},
                timeout=30,
            )
            st_r.raise_for_status()

            for line in st_r.text.strip().split('\n'):
                if '|' not in line:
                    continue
                parts = line.split('|')
                if len(parts) < 2:
                    continue
                st_id = parts[0].strip()
                entity_id = parts[1].strip()

                if st_id not in self._known_ids:
                    continue

                domain = entity_id.split('.')[0]

                # Skip camera entities — can't handle streams as DPS
                if domain == 'camera':
                    continue

                # Derive dp_key from entity purpose
                if domain == 'binary_sensor':
                    dp_key = 'motion' if 'motion' in entity_id else 'door' if 'door' in entity_id else 'presence'
                elif domain == 'event':
                    # Use device_class hint: ding/doorbell → 'ding', motion → 'motion'
                    dp_key = 'ding' if 'ding' in entity_id else 'motion' if ('motion' in entity_id or 'ring_ring' in entity_id) else entity_id.split('.')[-1].rsplit('_', 1)[-1]
                elif 'temperature' in entity_id:
                    dp_key = 'temperature'
                elif 'humidity' in entity_id:
                    dp_key = 'humidity'
                elif 'illuminance' in entity_id:
                    dp_key = 'illuminance'
                elif 'uv' in entity_id:
                    dp_key = 'uv'
                elif 'battery' in entity_id:
                    dp_key = 'battery'
                elif 'volume' in entity_id:
                    dp_key = 'volume'
                elif 'motion_enab' in entity_id or 'motion_detection' in entity_id:
                    dp_key = 'motion_detection'
                elif 'chime' in entity_id:
                    dp_key = 'chime'
                elif 'siren' in entity_id:
                    dp_key = 'siren'
                else:
                    dp_key = entity_id.split('.')[-1].rsplit('_', 1)[-1]

                if st_id not in self._entity_map:
                    self._entity_map[st_id] = []
                self._entity_map[st_id].append({
                    'entity_id': entity_id,
                    'domain': domain,
                    'dp_key': dp_key,
                })
                self._reverse_map[entity_id] = st_id
                self._smartthings_ids.add(st_id)

            log.info(f'HA map (smartthings): {len(self._smartthings_ids)} devices added')
        except Exception as e:
            log.error(f'Failed to build SmartThings entity map: {e}')

        # ── HA-direct devices — see class-level HA_DIRECT_DEVICES dict ──
        added = 0
        for tuya_id, ent_specs in self.HA_DIRECT_DEVICES.items():
            if tuya_id not in self._known_ids:
                continue
            for entity_id, dp_key in ent_specs:
                domain = entity_id.split('.')[0]
                self._entity_map.setdefault(tuya_id, []).append({
                    'entity_id': entity_id,
                    'domain':    domain,
                    'dp_key':    dp_key,   # None = vacuum-style multi-attr
                })
                self._reverse_map[entity_id] = tuya_id
            added += 1
        log.info(f'HA map (ha_direct): {added} devices added')

        # ── Build-health evaluation ─────────────────────────────────
        # Compute Tuya device count specifically (the cumulative
        # _entity_map at this point also contains SmartThings + ha_direct
        # entries, so subtract them).
        tuya_count = len(self._entity_map) - len(self._smartthings_ids) - added
        st_count   = len(self._smartthings_ids)
        # `both_empty` catches the first-build-after-fresh-restart-while-HA-still-loading
        # case, where _last_good_* are both 0 (initial state) and tuya_count + st_count
        # are both 0 → the regression check below would incorrectly mark the build healthy
        # because there's no high-water mark to compare against. Without this guard, a
        # device-agent restart that lands during HA's boot results in a permanently
        # bricked bridge (zero entities mapped, watchdog never triggers) — the exact
        # failure mode that caused the 2026-05-18 to 2026-05-26 silent zwave/Ring/Tuya
        # outage. Marking 0+0 as unhealthy makes the watchdog force a reconnect after 60s,
        # at which point HA is reliably up and the rebuild succeeds.
        both_empty = (tuya_count == 0 and st_count == 0)
        regression = both_empty or (
            (self._last_good_tuya_count > 0 and tuya_count == 0) or
            (self._last_good_st_count   > 0 and st_count   == 0)
        )
        if regression:
            self._entity_build_healthy = False
            reason = 'both empty (HA likely still loading)' if both_empty else (
                'tuya %d→%d, smartthings %d→%d' % (
                    self._last_good_tuya_count, tuya_count,
                    self._last_good_st_count,   st_count,
                )
            )
            log.warning('HA map: build unhealthy — %s (watchdog will retry)', reason)
        else:
            self._entity_build_healthy = True
            # Update high-water marks only on healthy builds.
            if tuya_count > 0:
                self._last_good_tuya_count = tuya_count
            if st_count > 0:
                self._last_good_st_count = st_count

    def _fetch_all_states(self):
        """One-time bulk fetch of all HA states to seed ha_api as source."""
        log.info('Fetching all HA states for initial seed')
        try:
            r = requests.get(
                f'{HA_URL}/api/states',
                headers={'Authorization': f'Bearer {HA_TOKEN}'},
                timeout=15,
            )
            r.raise_for_status()
            states = r.json()

            count = 0
            # Group by tuya_id to build combined DPS per device
            device_dps: dict[str, dict] = {}
            for s in states:
                eid = s.get('entity_id', '')
                if eid not in self._reverse_map:
                    continue
                state_val = s.get('state')
                if state_val in ('unavailable', 'unknown', None):
                    continue

                tuya_id = self._reverse_map[eid]
                for ent in self._entity_map.get(tuya_id, []):
                    if ent['entity_id'] == eid:
                        # Vacuum: project state + optional battery_level
                        # (Viomi exposes it in attributes; Roomba doesn't,
                        # so battery comes via a sibling sensor entity in
                        # HA_DIRECT_DEVICES).
                        if ent['domain'] == 'vacuum':
                            _attrs = s.get('attributes') or {}
                            device_dps.setdefault(tuya_id, {})['state'] = state_val
                            batt = _attrs.get('battery_level')
                            if isinstance(batt, (int, float)):
                                device_dps[tuya_id]['battery'] = batt
                            for _src in ('clean_area', 'clean_time'):
                                _v = _attrs.get(_src)
                                if isinstance(_v, (int, float)):
                                    device_dps[tuya_id][_src] = _v
                            _fs = _attrs.get('fan_speed')
                            if isinstance(_fs, str) and _fs:
                                device_dps[tuya_id]['fan_speed'] = _fs
                            _bf = _attrs.get('bin_full')
                            if isinstance(_bf, bool):
                                device_dps[tuya_id]['bin_full'] = _bf
                        else:
                            val = self._ha_state_to_dps_value(ent['domain'], state_val)
                            device_dps.setdefault(tuya_id, {})[ent['dp_key']] = val
                        break

            for dev_id, dps in device_dps.items():
                # Seed SmartThings/Ring + ha_direct (vacuum etc.) devices on
                # startup. Tuya devices already have faster sources
                # (tcp_push, local_poll) that would be overridden by ha_api's
                # higher priority on every restart.
                if dps and (dev_id in self._smartthings_ids
                            or dev_id in self.HA_DIRECT_DEVICES):
                    self.on_state_change(dev_id, dps, 'ha_api')
                    count += 1

            log.info(f'HA initial seed: {count} devices updated')
        except Exception as e:
            log.error(f'HA initial fetch failed: {e}')

    def _ha_state_to_dps_value(self, domain, state):
        """Convert HA entity state to Tuya DPS value."""
        if domain in ('switch', 'light', 'fan'):
            return state == 'on'
        if domain == 'cover':
            return state  # 'open', 'closed', 'opening', 'closing'
        if domain == 'binary_sensor':
            return state == 'on'
        if domain == 'sensor':
            try:
                return float(state)
            except (ValueError, TypeError):
                return state
        return state

    def _on_ws_message(self, ws, message):
        """Handle WebSocket message from HA."""
        try:
            msg = json.loads(message)

            # Watchdog: update last-event timestamp on every incoming message
            self._last_event_ts = time.time()

            # Watchdog: correlate pong replies for active health check
            if msg.get('type') == 'pong':
                mid = msg.get('id')
                if mid in self._pending_pings:
                    del self._pending_pings[mid]
                return

            # Auth required
            if msg.get('type') == 'auth_required':
                ws.send(json.dumps({'type': 'auth', 'access_token': HA_TOKEN}))
                return

            # Auth OK → subscribe to state changes
            if msg.get('type') == 'auth_ok':
                log.info('HA WebSocket authenticated')
                self._last_auth_ok_ts = time.time()
                ws.send(json.dumps({
                    'id': 1,
                    'type': 'subscribe_events',
                    'event_type': 'state_changed',
                }))
                # Rebuild entity map now that HA is confirmed responsive.
                # The initial build in _run() may have run against a briefly-down
                # HA (connection refused → empty map → silent event drops after
                # HA comes back). Rebuilding post-auth catches that case.
                # Use the build-health flag instead of `not self._entity_map`
                # because ha_direct devices are always present and would mask
                # a failed Tuya/SmartThings build.
                if not self._entity_build_healthy:
                    try:
                        log.info('HA: entity build unhealthy after auth — rebuilding')
                        self._build_entity_map()
                        self._fetch_all_states()
                    except Exception as e:
                        log.warning(f'HA: post-auth map rebuild failed: {e} (watchdog will retry)')
                return

            # Auth rejected — close and reconnect
            if msg.get('type') == 'auth_invalid':
                log.error(f'HA WebSocket auth rejected: {msg.get("message", "invalid token")}')
                ws.close()
                return

            # State change event
            if msg.get('type') == 'event' and msg.get('event', {}).get('event_type') == 'state_changed':
                data = msg['event']['data']
                entity_id = data.get('entity_id', '')
                new_state = data.get('new_state')

                if not new_state or entity_id not in self._reverse_map:
                    return

                tuya_id = self._reverse_map[entity_id]
                ent_info = None
                for e in self._entity_map.get(tuya_id, []):
                    if e['entity_id'] == entity_id:
                        ent_info = e
                        break
                if not ent_info:
                    return

                state_val = new_state.get('state')
                if state_val in ('unavailable', 'unknown'):
                    return

                # Vacuum entities project state + (optional) battery into dps.
                # Roomba's vacuum entity doesn't expose battery_level in
                # attributes — battery comes from a separate sensor entity
                # also registered in HA_DIRECT_DEVICES. Viomi's vacuum
                # entity DOES carry battery_level in attributes; we read it
                # here so a single subscription suffices. When absent (e.g.
                # Roomba), the key is omitted so on_state_change merges
                # without disturbing the existing battery from the sensor.
                if ent_info['domain'] == 'vacuum':
                    attrs = new_state.get('attributes') or {}
                    dps = {'state': state_val}
                    batt = attrs.get('battery_level')
                    if isinstance(batt, (int, float)):
                        dps['battery'] = batt
                    # Extra telemetry (Roborock exposes these; Roomba/Viomi may not).
                    for _src in ('clean_area', 'clean_time'):
                        _v = attrs.get(_src)
                        if isinstance(_v, (int, float)):
                            dps[_src] = _v
                    _fs = attrs.get('fan_speed')
                    if isinstance(_fs, str) and _fs:
                        dps['fan_speed'] = _fs
                    # bin_full is a bool — explicit isinstance(bool) so it's not
                    # swept up by the numeric guard above (bool subclasses int).
                    _bf = attrs.get('bin_full')
                    if isinstance(_bf, bool):
                        dps['bin_full'] = _bf
                    self.on_state_change(tuya_id, dps, 'ha_api')
                    return

                # Event entities (buttons): value = "action:timestamp" so rules
                # can distinguish pushed/held AND dedup passes (unique timestamps)
                if ent_info['domain'] == 'event':
                    event_type = new_state.get('attributes', {}).get('event_type', 'unknown')
                    dps_val = f'{event_type}:{state_val}'
                else:
                    dps_val = self._ha_state_to_dps_value(ent_info['domain'], state_val)
                dps = {ent_info['dp_key']: dps_val}

                self.on_state_change(tuya_id, dps, 'ha_api')

        except Exception as e:
            log.error(f'HA WS message error: {e}')

    def _on_ws_error(self, ws, error):
        log.warning(f'HA WebSocket error: {error}')

    def _on_ws_close(self, ws, close_code, close_msg):
        log.info(f'HA WebSocket closed: {close_code} {close_msg}')

    def _run(self):
        """Connect to HA WebSocket with reconnect loop."""
        if not HA_TOKEN:
            log.error('HA_TOKEN not set — HA API adapter disabled')
            return

        delay = RECONNECT_DELAY
        while not self._stop_event.is_set():
            self._build_entity_map()
            if self._entity_map:
                break
            log.warning(f'No HA entities mapped — retrying in {delay}s')
            self._stop_event.wait(delay)
            delay = min(delay * 2, RECONNECT_MAX)
        if self._stop_event.is_set():
            return

        delay = RECONNECT_DELAY
        while not self._stop_event.is_set():
            try:
                # Rebuild entity map on each reconnect (picks up new devices)
                self._build_entity_map()
                self._fetch_all_states()
                log.info(f'Connecting to HA WebSocket at {HA_WS}')
                ws = websocket.WebSocketApp(
                    HA_WS,
                    on_message=self._on_ws_message,
                    on_error=self._on_ws_error,
                    on_close=self._on_ws_close,
                )
                # Watchdog handshake: reset per-connection state, stash handle
                self._ws = ws
                self._ws_connect_ts = time.time()
                self._last_event_ts = time.time()
                self._last_auth_ok_ts = 0.0
                self._pending_pings.clear()
                # run_forever blocks until connection closes
                ws.run_forever(ping_interval=30, ping_timeout=10)
                self._ws = None
                delay = RECONNECT_DELAY
            except Exception as e:
                log.error(f'HA WebSocket connection failed: {e}')
                self._ws = None

            if not self._stop_event.is_set():
                log.info(f'HA WebSocket reconnecting in {delay}s')
                self._stop_event.wait(delay)
                delay = min(delay * 2, RECONNECT_MAX)

    def _watchdog_loop(self):
        """Auto-heal stuck WebSocket connections.

        Runs every 60s in a separate daemon thread. Four overlapping checks:
        1. Post-auth deadline — force close if auth_ok doesn't arrive within 60s
        2. Empty-map detection — force close if entity_map stays empty >60s after auth
           (handles: HA briefly down during initial _build_entity_map → map=0 → silent drops)
        3. Event-idle backup — force close if no WS message for 15 min
        4. Active ping — send HA ping; if 2 consecutive pings unanswered, force close

        ws.close() is thread-safe in websocket-client 1.9.0; it makes
        run_forever() return so the main reconnect loop can rebuild cleanly.
        """
        while not self._watchdog_stop.wait(60):
            ws = self._ws
            if ws is None:
                continue  # not currently connected — nothing to monitor
            # Skip if the underlying socket is already gone
            sock = getattr(ws, 'sock', None)
            if sock is None or not getattr(sock, 'connected', False):
                continue

            now = time.time()

            # 1) Post-auth deadline
            if self._last_auth_ok_ts == 0.0 and self._ws_connect_ts > 0 \
                    and (now - self._ws_connect_ts) > 60:
                log.warning('HA watchdog: no auth_ok within 60s of connect — forcing close')
                try:
                    ws.close()
                except Exception:
                    pass
                continue

            # 2) Unhealthy-build detection (only after auth_ok — grace 60s for initial build)
            #    Catches the case where _build_entity_map ran against a partially-up HA
            #    (WS handshake worked but template API returned 0 entities) and silently
            #    discarded the SmartThings/Tuya entity maps. ha_direct devices are still
            #    in self._entity_map, so the legacy `not self._entity_map` check missed
            #    this and the WS stayed connected with a useless empty map.
            if self._last_auth_ok_ts > 0 and (now - self._last_auth_ok_ts) > 60 \
                    and not self._entity_build_healthy:
                log.warning('HA watchdog: entity build unhealthy >60s after auth — forcing close (rebuild on next connect)')
                try:
                    ws.close()
                except Exception:
                    pass
                continue

            # 2) Event-idle backup (only after auth_ok — pre-auth silence is normal)
            if self._last_auth_ok_ts > 0 and (now - self._last_event_ts) > 900:
                idle_min = (now - self._last_event_ts) / 60
                log.warning('HA watchdog: no events for %.0f min — forcing close', idle_min)
                try:
                    ws.close()
                except Exception:
                    pass
                continue

            # 3) Active ping (only after auth_ok)
            if self._last_auth_ok_ts > 0:
                # Drop stale pings older than 65s (overlap with next check window)
                stale = [mid for mid, ts in self._pending_pings.items() if (now - ts) > 65]
                for mid in stale:
                    self._pending_pings.pop(mid, None)
                if len(self._pending_pings) >= 2:
                    log.warning('HA watchdog: %d pings unanswered — forcing close',
                                len(self._pending_pings))
                    try:
                        ws.close()
                    except Exception:
                        pass
                    continue
                # Send new ping
                mid = self._next_msg_id
                self._next_msg_id += 1
                self._pending_pings[mid] = now
                try:
                    ws.send(json.dumps({'id': mid, 'type': 'ping'}))
                except Exception as e:
                    log.warning('HA watchdog: ping send failed: %s — forcing close', e)
                    try:
                        ws.close()
                    except Exception:
                        pass

    def _keepalive_loop(self):
        """Touch `last_seen` for every reachable HA-mapped device every
        KEEPALIVE_INTERVAL_SEC. Wired switches with no secondary sensors would
        otherwise look stale for hours when idle, even though they are fine.

        Empty dps + source='keepalive' triggers the device-agent's
        last-seen-only path (see device_agent.py — does not overwrite
        last_source, does not emit state_changed, does not touch MQTT).

        `unavailable` / `unknown` entities are skipped so genuinely broken
        devices still show stale and alert correctly.
        """
        while not self._keepalive_stop.wait(KEEPALIVE_INTERVAL_SEC):
            if not self._entity_map or not self._reverse_map:
                continue  # not ready yet — initial map build still in progress
            try:
                r = requests.get(
                    f'{HA_URL}/api/states',
                    headers={'Authorization': f'Bearer {HA_TOKEN}'},
                    timeout=15,
                )
                r.raise_for_status()
                touched = set()
                for s in r.json():
                    eid = s.get('entity_id', '')
                    if eid not in self._reverse_map:
                        continue
                    state_val = s.get('state')
                    if state_val in ('unavailable', 'unknown', None):
                        continue
                    dev_id = self._reverse_map[eid]
                    if dev_id in touched:
                        continue
                    self.on_state_change(dev_id, {}, 'keepalive')
                    touched.add(dev_id)
                log.info(f'HA keepalive: touched {len(touched)} devices')
            except Exception as e:
                log.warning(f'HA keepalive failed: {e}')

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True, name='ha-api')
        self._thread.start()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop, daemon=True, name='ha-api-watchdog')
        self._watchdog_thread.start()
        self._keepalive_thread = threading.Thread(
            target=self._keepalive_loop, daemon=True, name='ha-api-keepalive')
        self._keepalive_thread.start()

    def stop(self):
        self._stop_event.set()
        self._watchdog_stop.set()
        self._keepalive_stop.set()

    def get_state(self, device_id: str) -> dict:
        return {}

    def set_state(self, device_id: str, dps: dict) -> bool:
        return False
