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


class HAApiAdapter(DeviceAdapter):
    vendor = 'tuya'

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
                        val = self._ha_state_to_dps_value(ent['domain'], state_val)
                        if tuya_id not in device_dps:
                            device_dps[tuya_id] = {}
                        device_dps[tuya_id][ent['dp_key']] = val
                        break

            for dev_id, dps in device_dps.items():
                # Only seed SmartThings devices on startup. Tuya devices already
                # have faster sources (tcp_push, local_poll) that would be
                # overridden by ha_api's higher priority on every restart.
                if dps and dev_id in self._smartthings_ids:
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

            # Auth required
            if msg.get('type') == 'auth_required':
                ws.send(json.dumps({'type': 'auth', 'access_token': HA_TOKEN}))
                return

            # Auth OK → subscribe to state changes
            if msg.get('type') == 'auth_ok':
                log.info('HA WebSocket authenticated')
                ws.send(json.dumps({
                    'id': 1,
                    'type': 'subscribe_events',
                    'event_type': 'state_changed',
                }))
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

        # Initial bulk fetch — set ha_api as source for all mapped devices
        self._fetch_all_states()

        delay = RECONNECT_DELAY
        while not self._stop_event.is_set():
            try:
                log.info(f'Connecting to HA WebSocket at {HA_WS}')
                ws = websocket.WebSocketApp(
                    HA_WS,
                    on_message=self._on_ws_message,
                    on_error=self._on_ws_error,
                    on_close=self._on_ws_close,
                )
                # run_forever blocks until connection closes
                ws.run_forever(ping_interval=30, ping_timeout=10)
                delay = RECONNECT_DELAY
            except Exception as e:
                log.error(f'HA WebSocket connection failed: {e}')

            if not self._stop_event.is_set():
                log.info(f'HA WebSocket reconnecting in {delay}s')
                self._stop_event.wait(delay)
                delay = min(delay * 2, RECONNECT_MAX)

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True, name='ha-api')
        self._thread.start()

    def stop(self):
        self._stop_event.set()

    def get_state(self, device_id: str) -> dict:
        return {}

    def set_state(self, device_id: str, dps: dict) -> bool:
        return False
