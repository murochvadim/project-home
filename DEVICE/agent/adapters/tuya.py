"""
Tuya adapter — persistent TCP connections to all local Tuya devices.

Each local device gets its own thread:
  - connect with persistent socket
  - get initial status
  - wait for push updates (device sends immediately on state change)
  - send heartbeat every 12s to keep connection alive
  - reconnect on error with exponential backoff

Gateway: connect to wg2 gateway, which proxies all Zigbee sub-device states.
  - On startup: Cloud API bootstrap builds node_id→device_id map and fetches
    initial state for each sub-device (one-time, then all updates are local TCP)
  - Ongoing: gateway TCP push messages are routed to the correct sub-device
    using the node_id map (cid field in push = Zigbee node_id, not device_id)
"""

import threading
import time
import logging

import tinytuya

from .base import DeviceAdapter

log = logging.getLogger('tuya_adapter')

HEARTBEAT_INTERVAL = 12    # seconds — Tuya drops connection after ~20s without heartbeat
RECONNECT_DELAY    = 5     # seconds — initial reconnect wait
RECONNECT_MAX      = 60    # seconds — maximum reconnect wait
SOCKET_TIMEOUT     = 5     # seconds — receive timeout (must be < heartbeat interval)

from .tuya_config import API_REGION, API_KEY, API_SECRET


class TuyaAdapter(DeviceAdapter):
    vendor = 'tuya'

    def __init__(self, devices, on_state_change):
        super().__init__(devices, on_state_change)
        self._threads    = []
        self._stop_event = threading.Event()

        # Split devices by how we reach them
        self._local   = [d for d in devices if d['protocol'] == 'local' and d.get('local_ip') and d.get('local_key')]
        self._gateway = [d for d in devices if d['protocol'] == 'gateway']

        # Find gateway hub device (device_type='gateway', has local_ip)
        gw = next((d for d in devices if d['device_type'] == 'gateway' and d.get('local_ip')), None)
        self._gateway_dev = gw

        # node_id (short Zigbee ID from gateway push cid field) → full Tuya device_id
        # Populated once at startup by _bootstrap_gateway()
        self._node_map: dict[str, str] = {}

        # device_id → {code_name: dp_id} for converting cloud initial state to numeric keys
        self._dps_map: dict[str, dict[str, int]] = {}

        log.info(f'Tuya adapter: {len(self._local)} local, {len(self._gateway)} gateway sub-devices')

    # ─── Gateway bootstrap (one-time Cloud API call) ───────────────────────

    def _bootstrap_gateway(self):
        """
        Runs once in a daemon thread at startup.
        1. Fetches sub-device list from Cloud → builds node_id → device_id map
        2. Fetches dp_id maps so initial states can use numeric keys
        3. Fetches and stores initial state for every sub-device
        After this, all updates arrive via local TCP gateway push.
        """
        gw = self._gateway_dev
        if not gw or not self._gateway:
            return

        log.info('Gateway: bootstrapping via Cloud API')
        try:
            cloud = tinytuya.Cloud(apiRegion=API_REGION, apiKey=API_KEY, apiSecret=API_SECRET)
        except Exception as e:
            log.error(f'Gateway bootstrap: Cloud connect failed: {e}')
            return

        # ── Step 1: Build node_id → device_id map ──────────────────────────
        try:
            r = cloud.cloudrequest(f'/v1.0/iot-03/devices/{gw["id"]}/sub-devices')
            result = r.get('result') or []
            # result may be a list directly or a dict with 'list' key
            sub_list = result if isinstance(result, list) else result.get('list', [])
            for sub in sub_list:
                node_id = sub.get('node_id') or sub.get('nodeId')
                dev_id  = sub.get('id') or sub.get('devId')
                if node_id and dev_id:
                    self._node_map[node_id] = dev_id
            log.info(f'Gateway: node map built — {len(self._node_map)} sub-devices')
        except Exception as e:
            log.warning(f'Gateway: node map fetch failed: {e}')

        # ── Step 2: Fetch dp_id maps (code_name → dp_id) per sub-device ────
        for dev in self._gateway:
            try:
                r = cloud.getdps(dev['id'])
                mapping = {}
                for entry in (r.get('result') or {}).get('status', []):
                    mapping[entry['code']] = entry['dp_id']
                self._dps_map[dev['id']] = mapping
                time.sleep(0.3)
            except Exception as e:
                log.warning(f'Gateway: dp_id map failed for {dev["name"]}: {e}')

        # ── Step 3: Fetch and store initial state for each sub-device ───────
        for dev in self._gateway:
            try:
                r = cloud.cloudrequest(f'/v1.0/iot-03/devices/{dev["id"]}/status')
                if r.get('success'):
                    code_map = self._dps_map.get(dev['id'], {})
                    dps = {}
                    for item in r.get('result', []):
                        code  = item['code']
                        value = item['value']
                        dp_id = code_map.get(code)
                        # Use numeric dp_id if known, else fall back to code name
                        key = str(dp_id) if dp_id else code
                        dps[key] = value
                    if dps:
                        self.on_state_change(dev['id'], dps, 'gateway_init')
                time.sleep(0.3)
            except Exception as e:
                log.warning(f'Gateway: initial state failed for {dev["name"]}: {e}')

        log.info('Gateway: bootstrap complete')

        # ── Step 4: Cloud poll all gateway devices every 60s as safety net ────
        # TCP push covers some, Pulsar push (when enabled) covers the rest.
        if self._gateway:
            log.info(f'Gateway: starting cloud poll for all {len(self._gateway)} gateway devices')
            t = threading.Thread(target=self._poll_gateway, args=(cloud,),
                                 daemon=True, name='tuya-gw-poll')
            t.start()

    def _poll_gateway(self, cloud):
        """Poll all gateway devices via cloud every 60s as safety net."""
        INTERVAL = 60
        consecutive_failures = 0
        while not self._stop_event.is_set():
            self._stop_event.wait(INTERVAL)
            if self._stop_event.is_set():
                break
            for dev in self._gateway:
                if self._stop_event.is_set():
                    break
                try:
                    r = cloud.cloudrequest(f'/v1.0/iot-03/devices/{dev["id"]}/status')
                    if r.get('success'):
                        code_map = self._dps_map.get(dev['id'], {})
                        dps = {}
                        for item in r.get('result', []):
                            dp_id = code_map.get(item['code'])
                            key   = str(dp_id) if dp_id else item['code']
                            dps[key] = item['value']
                        if dps:
                            self.on_state_change(dev['id'], dps, 'cloud_poll')
                        consecutive_failures = 0
                    time.sleep(0.5)
                except Exception as e:
                    consecutive_failures += 1
                    log.warning(f'Gateway poll failed for {dev["name"]}: {e}')
                    if consecutive_failures >= 10:
                        log.warning('Gateway poll: 10 consecutive failures — recreating Cloud session')
                        try:
                            cloud = tinytuya.Cloud(apiRegion=API_REGION, apiKey=API_KEY, apiSecret=API_SECRET)
                            consecutive_failures = 0
                        except Exception as ce:
                            log.error(f'Gateway poll: Cloud reconnect failed: {ce}')

    # ─── Adapter lifecycle ─────────────────────────────────────────────────

    def start(self):
        # Bootstrap gateway sub-devices in background (non-blocking)
        if self._gateway_dev and self._gateway:
            t = threading.Thread(target=self._bootstrap_gateway, daemon=True, name='tuya-gw-bootstrap')
            t.start()

        # One thread per local device
        for dev in self._local:
            t = threading.Thread(target=self._device_thread, args=(dev,), daemon=True,
                                 name=f"tuya-{dev.get('name','?')[:20]}")
            t.start()
            self._threads.append(t)

        # One thread for gateway TCP connection (covers all Zigbee sub-device pushes)
        if self._gateway_dev:
            t = threading.Thread(target=self._gateway_thread, daemon=True, name='tuya-gateway')
            t.start()
            self._threads.append(t)

        log.info(f'Started {len(self._threads)} device threads')

    def stop(self):
        self._stop_event.set()

    # ─── Local device persistent connection ────────────────────────────────

    def _device_thread(self, dev):
        """Hybrid mode: persistent TCP for push + periodic poll as fallback.
        If push arrives → instant update (tcp_push).
        If no push → poll every 15s catches state changes (local_poll).
        Keepalive every 5 min so connected devices never appear stale.
        """
        dev_id = dev['id']
        ip     = dev['local_ip']
        key    = dev['local_key']
        ver    = float(dev.get('version') or 3.3)
        name   = dev.get('name', dev_id)[:30]
        delay  = RECONNECT_DELAY
        POLL_INTERVAL = 15  # seconds between status polls

        while not self._stop_event.is_set():
            d = None
            try:
                d = tinytuya.Device(dev_id, ip, key, version=ver)
                d.set_socketPersistent(True)
                d.set_socketTimeout(SOCKET_TIMEOUT)

                delay = RECONNECT_DELAY  # reset backoff on successful connect

                # Get initial state
                status = d.status()
                if status and 'dps' in status:
                    self.on_state_change(dev_id, status['dps'], 'initial')

                last_heartbeat  = time.time()
                last_poll       = time.time()
                last_push       = 0  # timestamp of last tcp_push received

                while not self._stop_event.is_set():
                    now = time.time()

                    if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                        d.heartbeat(nowait=True)
                        last_heartbeat = now

                    # Poll every 15s ONLY if no push received recently (last 30s)
                    # Devices that push don't need polling — it just creates noise
                    if now - last_poll >= POLL_INTERVAL and now - last_push > 30:
                        try:
                            ps = d.status()
                            if ps and 'dps' in ps:
                                self.on_state_change(dev_id, ps['dps'], 'local_poll')
                        except Exception:
                            break  # connection likely dead
                        last_poll = time.time()

                    data = d.receive()
                    if data is None:
                        continue

                    if isinstance(data, dict):
                        if 'dps' in data and data['dps']:
                            self.on_state_change(dev_id, data['dps'], 'tcp_push')
                            last_push = time.time()
                        elif data.get('Error'):
                            log.warning(f'{name}: device error: {data}')
                            break

            except Exception as e:
                log.warning(f'{name} ({ip}): {e} — reconnecting in {delay}s')
            finally:
                try:
                    if d:
                        d.close()
                except Exception:
                    pass

            if not self._stop_event.is_set():
                time.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX)

    # ─── Gateway thread (Zigbee sub-devices via TCP push) ──────────────────

    def _gateway_thread(self):
        gw      = self._gateway_dev
        dev_id  = gw['id']
        ip      = gw['local_ip']
        key     = gw['local_key']
        ver     = float(gw.get('version') or 3.4)
        delay   = RECONNECT_DELAY

        while not self._stop_event.is_set():
            d = None
            try:
                d = tinytuya.Device(dev_id, ip, key, version=ver)
                d.set_socketPersistent(True)
                d.set_socketTimeout(SOCKET_TIMEOUT)

                # Gateway hub's own status
                status = d.status()
                if status and 'dps' in status:
                    self.on_state_change(dev_id, status['dps'], 'initial')
                    delay = RECONNECT_DELAY

                last_heartbeat = time.time()

                while not self._stop_event.is_set():
                    if time.time() - last_heartbeat >= HEARTBEAT_INTERVAL:
                        d.heartbeat(nowait=True)
                        last_heartbeat = time.time()

                    data = d.receive()
                    if data is None:
                        continue

                    if not isinstance(data, dict) or not data.get('dps'):
                        continue

                    cid = data.get('cid')
                    if cid:
                        # cid = Zigbee node_id (short ID) — look up full device_id
                        target_id = self._node_map.get(cid)
                        if target_id:
                            self.on_state_change(target_id, data['dps'], 'gateway_push')
                        else:
                            log.debug(f'Gateway push: unknown cid {cid!r} DPS={data["dps"]}')
                    else:
                        # No cid — push belongs to the gateway hub itself
                        self.on_state_change(dev_id, data['dps'], 'gateway_push')

            except Exception as e:
                log.warning(f'Gateway ({ip}): {e} — reconnecting in {delay}s')
            finally:
                try:
                    if d:
                        d.close()
                except Exception:
                    pass

            if not self._stop_event.is_set():
                time.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX)

    # ─── Direct state control ───────────────────────────────────────────────

    def get_state(self, device_id: str) -> dict:
        dev = next((d for d in self.devices if d['id'] == device_id), None)
        if not dev or not dev.get('local_ip'):
            return {}
        try:
            d = tinytuya.Device(device_id, dev['local_ip'], dev['local_key'],
                                version=float(dev.get('version') or 3.3))
            d.set_socketTimeout(5)
            status = d.status()
            d.close()
            return status.get('dps', {}) if status else {}
        except Exception as e:
            log.error(f'get_state {device_id}: {e}')
            return {}

    def set_state(self, device_id: str, dps: dict) -> bool:
        dev = next((d for d in self.devices if d['id'] == device_id), None)
        if not dev or not dev.get('local_ip'):
            return False
        try:
            d = tinytuya.Device(device_id, dev['local_ip'], dev['local_key'],
                                version=float(dev.get('version') or 3.3))
            d.set_socketTimeout(5)
            result = d.set_multiple_values(dps)
            d.close()
            return result is not None
        except Exception as e:
            log.error(f'set_state {device_id}: {e}')
            return False
