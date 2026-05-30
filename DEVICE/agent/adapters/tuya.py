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
import psycopg2

from .base import DeviceAdapter

log = logging.getLogger('tuya_adapter')

HEARTBEAT_INTERVAL = 12    # seconds — Tuya drops connection after ~20s without heartbeat
RECONNECT_DELAY    = 5     # seconds — initial reconnect wait
RECONNECT_MAX      = 60    # seconds — maximum reconnect wait
SOCKET_TIMEOUT     = 15    # seconds — receive timeout (> heartbeat interval)
KEEPALIVE_INTERVAL = 3600  # seconds — update last_seen for devices with no DPS (IR remotes etc.)
# tinytuya.find_device(dev_id) — signature is (dev_id=None, address=None);
# no timeout kwarg. The function blocks until ANY broadcast arrives or its
# internal scan window expires (~10–15 s in practice on this LAN).

# DB connection params — mirror device_agent.DB_CONFIG (LAN trust auth per
# pg_hba.conf, no password needed). Used by _persist_local_ip to write back
# the rediscovered IP so the next service restart skips straight to the
# fresh address. Kept tiny — opens a short-lived connection per write.
_DB_CONFIG = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}

# ─── Per-device silent-freeze watchdog ──────────────────────────────────────
# A per-device TCP thread can sit silently for days if it's in a reconnect
# loop where status()/receive() keeps timing out without raising. The
# watchdog detects this by tracking last-active timestamps and forces a
# reconnect when a thread goes silent — the alternative is a manual
# device-agent restart, which froze Entrance Monitor Switch for 36 days
# (2026-04-08 → 2026-05-15) before being noticed.
WATCHDOG_INTERVAL_SEC = 300        # check every 5 min
SILENT_FREEZE_SEC     = 3600       # 1 h with zero data = thread considered stuck

# ─── Local-key rotation auto-recovery (since 2026-05-30) ────────────────────
# When a Tuya device is re-paired in the user's Tuya app, the cloud generates
# a NEW `local_key` and ships it to the device. The DB still has the OLD key,
# so every local TCP poll fails with Err 904 "Unexpected Payload". The
# silent-freeze watchdog only force-reconnects (no fix); the IP rediscovery
# watchdog only touches IP. Neither resolves a rotated key — so the device
# silently fell back to the cloud channel (ha_api) and stayed there until
# someone manually re-fetched the key. Guy Room window Light sat in this
# state for 14+ days before being caught on 2026-05-30.
#
# Auto-fix: each per-device thread increments _per_dev_904_count on every
# Err 904 response; resets to 0 on any successful read. The watchdog checks
# this counter every WATCHDOG_INTERVAL_SEC tick — if it exceeds the
# threshold AND the per-device key-refetch throttle has elapsed, the
# watchdog queries the Tuya cloud for the device's current local_key, and
# if it differs from the DB, UPDATEs the row + signals the per-device
# thread to reconnect using the fresh key (via the existing force_event
# mechanism). Throttle prevents bursting cloud API calls if the cloud's
# key also happens to be wrong (extremely unlikely but possible).
KEY_REFETCH_904_THRESHOLD    = 5     # consecutive Err 904 responses before refetch fires
KEY_REFETCH_THROTTLE_SEC     = 1800  # 30 min between refetches per device

from .tuya_config import API_REGION, API_KEY, API_SECRET


class TuyaAdapter(DeviceAdapter):
    vendor = 'tuya'

    def __init__(self, devices, on_state_change):
        super().__init__(devices, on_state_change)
        self._threads    = []
        self._stop_event = threading.Event()

        # ─── Per-device watchdog state ─────────────────────────────────────
        # Updated on every successful data read (push or poll) by the
        # per-device thread; consulted by _watchdog_loop to detect frozen
        # threads. Force-reconnect events let the watchdog poke a stuck
        # thread without having to kill+respawn it.
        self._per_dev_last_active:      dict[str, float]            = {}
        self._per_dev_force_reconnect:  dict[str, threading.Event]  = {}
        # Err 904 (local_key rotation) tracking — see KEY_REFETCH_*
        # constants above. Counter increments on every 904, resets to 0
        # on any successful read. Watchdog reads the counter + last-
        # refetch ts to decide whether to query the Tuya cloud for a
        # fresh key.
        self._per_dev_904_count:        dict[str, int]              = {}
        self._per_dev_last_key_refetch: dict[str, float]            = {}
        # Live reference each per-device thread reads at reconnect time
        # so the watchdog can hand it a fresh local_key without restart.
        # Initialised from each device's row.
        self._per_dev_key: dict[str, str] = {d['id']: d.get('local_key', '') for d in devices}
        self._watchdog_thread = None

        # Find gateway hub device (device_type='gateway', has local_ip) FIRST
        # so we can exclude it from the per-device-thread list below. Without
        # the exclusion, a Tuya gateway with protocol='local' (which all of
        # ours are) ends up in BOTH self._local AND self._gateway_dev — two
        # TCP threads competing for the same device session, producing
        # recurring Err 914 / 904 every ~90 s as one thread wins the
        # handshake and the other gets rejected. async pushes still flow
        # (so state stayed fresh and the bug was silent for months) but the
        # error spam masks real problems. See audit 2026-05-15.
        gw = next((d for d in devices if d['device_type'] == 'gateway' and d.get('local_ip')), None)
        self._gateway_dev = gw
        gw_id = gw['id'] if gw else None

        # Split devices by how we reach them. Exclude _gateway_dev from
        # _local — _gateway_thread will own its TCP connection exclusively.
        self._local   = [d for d in devices if d['protocol'] == 'local' and d.get('local_ip') and d.get('local_key')
                         and d['id'] != gw_id]
        self._gateway = [d for d in devices if d['protocol'] == 'gateway']

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
                    else:
                        consecutive_failures += 1
                        log.warning(f'Gateway poll API error for {dev["name"]}: {r.get("msg", r)}')
                        if consecutive_failures >= 10:
                            log.warning('Gateway poll: 10 consecutive API failures — recreating Cloud session')
                            try:
                                cloud = tinytuya.Cloud(apiRegion=API_REGION, apiKey=API_KEY, apiSecret=API_SECRET)
                                consecutive_failures = 0
                            except Exception as ce:
                                log.error(f'Gateway poll: Cloud reconnect failed: {ce}')
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

    # ─── Per-device freeze watchdog ─────────────────────────────────────────

    def _watchdog_loop(self):
        """Detect frozen per-device threads (no data > SILENT_FREEZE_SEC)
        and signal them to reopen their TCP connection.

        Prior incident: Entrance Monitor Switch silent for 36 days because
        a single per-device thread got stuck in a reconnect loop where
        status()/receive() kept timing out, but the inner-loop `except:
        break` was silent (no log). Service restart was the only recovery.

        This watchdog runs in its own thread, scans every WATCHDOG_INTERVAL_SEC,
        and force-reconnects any per-device thread that hasn't reported
        activity within SILENT_FREEZE_SEC. The force-reconnect path is
        cooperative — the per-device thread checks `force_event` each
        iteration and breaks out of the inner loop cleanly when set, then
        the outer loop opens a fresh TCP socket.

        If the underlying issue is a rotated local_key (re-pair) or a
        truly offline device, this won't fix it — but it WILL produce a
        stream of loud reconnect-failure logs every 60 s instead of going
        silent for weeks. That's the observability gain.
        """
        log.info(f'Tuya watchdog: scanning every {WATCHDOG_INTERVAL_SEC}s for threads silent > {SILENT_FREEZE_SEC}s')
        while not self._stop_event.is_set():
            if self._stop_event.wait(WATCHDOG_INTERVAL_SEC):
                break
            now = time.monotonic()
            # Iterate all watched threads: per-device locals AND the gateway
            # hub (which has its own silent-freeze pattern via half-dead TCP
            # — d.receive() returning None forever without raising).
            watched = list(self._local)
            if self._gateway_dev:
                watched.append(self._gateway_dev)
            for dev in watched:
                dev_id = dev['id']
                name = dev.get('name', dev_id)[:30]

                # ─── Mode B: local_key rotation auto-recovery ─────────
                # Sustained Err 904 = stale local_key. Refetch from cloud,
                # update DB if different, signal reconnect. Throttled per
                # device so a permanently-broken device can't burst the
                # Tuya cloud API.
                count_904 = self._per_dev_904_count.get(dev_id, 0)
                if count_904 >= KEY_REFETCH_904_THRESHOLD:
                    last_refetch = self._per_dev_last_key_refetch.get(dev_id, 0)
                    wall_now = time.time()
                    if wall_now - last_refetch >= KEY_REFETCH_THROTTLE_SEC:
                        self._per_dev_last_key_refetch[dev_id] = wall_now
                        log.warning(
                            f'Tuya watchdog: {name} sustained Err 904 ({count_904} consecutive) '
                            f'— querying cloud for fresh local_key'
                        )
                        cloud_key = self._refresh_local_key_from_cloud(dev_id, name)
                        stored_key = self._per_dev_key.get(dev_id) or dev.get('local_key', '')
                        if cloud_key and cloud_key != stored_key:
                            log.warning(
                                f'Tuya watchdog: {name} local_key rotated — updating DB + reconnecting'
                            )
                            self._persist_local_key(dev_id, cloud_key)
                            self._per_dev_key[dev_id] = cloud_key   # next reconnect reads this
                            self._per_dev_904_count[dev_id] = 0      # reset counter
                            ev = self._per_dev_force_reconnect.get(dev_id)
                            if ev and not ev.is_set():
                                ev.set()
                        elif cloud_key:
                            log.info(
                                f'Tuya watchdog: {name} cloud key matches DB — Err 904 cause is something '
                                f'else (firmware bug, peer mismatch). Resetting counter.'
                            )
                            self._per_dev_904_count[dev_id] = 0
                        # If cloud_key is None (cloud unreachable) leave the
                        # counter intact so we retry on the next tick after
                        # the throttle window closes.

                # ─── Mode A: silent-freeze watchdog (existing) ─────────
                last = self._per_dev_last_active.get(dev_id)
                if last is None:
                    # Thread hasn't registered itself yet — skip
                    continue
                silent_for = now - last
                if silent_for < SILENT_FREEZE_SEC:
                    continue
                event = self._per_dev_force_reconnect.get(dev_id)
                if event is None:
                    continue
                if event.is_set():
                    # Previous force-reconnect not consumed yet — don't pile up
                    continue
                log.warning(
                    f'Tuya watchdog: {name} silent for {silent_for/3600:.1f}h '
                    f'(> {SILENT_FREEZE_SEC/3600:.0f}h threshold) — forcing reconnect'
                )
                event.set()
                # Push last_active forward so we don't trigger again in 5 min
                # if the thread takes a moment to react. The thread itself
                # resets this on its next successful read.
                self._per_dev_last_active[dev_id] = now

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

        # Per-device silent-freeze watchdog (one thread, monitors all locals
        # AND the gateway hub if present).
        if self._local or self._gateway_dev:
            self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True, name='tuya-watchdog')
            self._watchdog_thread.start()
            self._threads.append(self._watchdog_thread)

        log.info(f'Started {len(self._threads)} device threads')

    def stop(self):
        self._stop_event.set()

    # ─── Tuya UDP-broadcast IP rediscovery (since 2026-05-27) ──────────────
    # Tuya devices announce themselves over UDP (encrypted, ports 6666/6667)
    # every ~30 sec — that broadcast carries the device's CURRENT LAN IP.
    # When a per-device TCP thread fails to connect on the cached IP (DHCP
    # rotated the address out from under us, common case), we listen for
    # the next broadcast and reconnect with the fresh IP. `tinytuya` ships
    # `find_device(devid)` which does exactly this. Side effect: the new IP
    # gets persisted to `devices.local_ip` so a future service restart
    # boots straight to the right address, no rediscovery wait.
    #
    # We deliberately DON'T run find_device on the first connect of a
    # device-thread (the cached IP is right ~99% of the time at process
    # start). Only when a connection attempt fails does the next iteration
    # rediscover, so healthy devices never pay the UDP-listen cost.

    def _rediscover_ip(self, dev_id, current_ip, name):
        """Listen for the device's UDP broadcast; return the discovered IP
        (str) or None on timeout. Logs a transition when the IP differs
        from the cached one."""
        try:
            r = tinytuya.find_device(dev_id)
        except Exception as e:
            log.warning(f'{name}: find_device exception ({type(e).__name__}): {e}')
            return None
        if not r or not r.get('ip'):
            log.info(f'{name}: rediscovery timed out (no broadcast seen) — keeping cached IP {current_ip}')
            return None
        new_ip = r['ip']
        if new_ip == current_ip:
            log.debug(f'{name}: rediscovery confirms cached IP {current_ip}')
        else:
            log.info(f'{name}: IP changed {current_ip} → {new_ip} (DHCP rotation), reconnecting + persisting')
        return new_ip

    def _persist_local_ip(self, dev_id, new_ip):
        """Write the rediscovered IP back to BOTH `devices.local_ip` AND
        `net_devices.ip` (looked up via the device's MAC). The double-
        write is load-bearing: device_agent's startup query reads
        `COALESCE(net_devices.ip, devices.local_ip)`, so if only
        devices.local_ip was updated, the next process restart would
        still pick the stale net_devices.ip and rediscovery would have
        to refire. The net_devices write also pre-empts device-agent's
        own 5-min keepalive writeback, which historically pushed the
        OLD startup-cached IP back into net_devices and undid this
        update — that hole was closed at the same time by switching
        device_agent._db_write to read mac+local_ip via RETURNING
        instead of trusting the startup-populated cache. Idempotent;
        opens a short-lived connection so we don't share state with
        the agent's main pool (rediscovery is rare, cost negligible)."""
        try:
            conn = psycopg2.connect(**_DB_CONFIG)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE devices SET local_ip = %s WHERE id = %s",
                        (new_ip, dev_id),
                    )
                    cur.execute(
                        """UPDATE net_devices
                           SET ip = %s, last_seen = NOW(), last_online = NOW()
                           WHERE lower(mac::text) = (
                             SELECT lower(mac::text) FROM devices WHERE id = %s
                           )""",
                        (new_ip, dev_id),
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            log.warning(f'persist local_ip failed for {dev_id}: {type(e).__name__}: {e}')

    def _refresh_local_key_from_cloud(self, dev_id, name):
        """Query the Tuya cloud for this device's current local_key. Returns
        the cloud-side key (str) or None on any error. Used by the 904
        watchdog when sustained 'Unexpected Payload' errors suggest the key
        was rotated by a re-pair. See KEY_REFETCH_* constants for the
        trigger threshold and throttle."""
        try:
            cloud = tinytuya.Cloud(apiRegion=API_REGION, apiKey=API_KEY, apiSecret=API_SECRET)
            r = cloud.cloudrequest(f'/v1.0/devices/{dev_id}')
            if not r or not r.get('success'):
                log.warning(f'{name}: cloud key fetch failed: {r}')
                return None
            return (r.get('result') or {}).get('local_key')
        except Exception as e:
            log.warning(f'{name}: cloud key fetch exception ({type(e).__name__}): {e}')
            return None

    def _persist_local_key(self, dev_id, new_key):
        """UPDATE devices.local_key. Parameterised via psycopg2 so keys
        containing '$' / single-quotes / etc. round-trip cleanly. Sets
        last_source='cloud_key_refresh' so the journal trail of the
        recovery is visible on the Devices page + System Alerts."""
        try:
            conn = psycopg2.connect(**_DB_CONFIG)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """UPDATE devices
                           SET local_key = %s,
                               last_source = 'cloud_key_refresh',
                               updated_at = NOW()
                           WHERE id = %s""",
                        (new_key, dev_id),
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            log.warning(f'persist local_key failed for {dev_id}: {type(e).__name__}: {e}')

    # ─── Local device persistent connection ────────────────────────────────

    def _device_thread(self, dev):
        """Hybrid mode: persistent TCP for push + periodic poll as fallback.
        If push arrives → instant update (tcp_push).
        If no push → poll every 15s catches state changes (local_poll).
        Keepalive every 5 min so connected devices never appear stale.

        Self-healing: per-device watchdog (_watchdog_loop) tracks each
        thread's last successful read via _per_dev_last_active. If a
        thread sits silent > SILENT_FREEZE_SEC, the watchdog sets the
        thread's force_reconnect event; this loop checks it each
        iteration and breaks out of the inner loop to reconnect.
        """
        dev_id = dev['id']
        ip     = dev['local_ip']
        # Live key reference — watchdog can rotate this in-place via
        # self._per_dev_key[dev_id] when it auto-refetches from the cloud
        # after sustained Err 904. Each outer loop iteration re-reads, so
        # the next reconnect uses whatever key the watchdog wrote.
        ver    = float(dev.get('version') or 3.3)
        name   = dev.get('name', dev_id)[:30]
        delay  = RECONNECT_DELAY
        POLL_INTERVAL = 15  # seconds between status polls

        # Register watchdog state for this device. Initial timestamp = now
        # so a brand-new thread isn't immediately flagged as stale before
        # it gets its first data.
        force_event = self._per_dev_force_reconnect.setdefault(dev_id, threading.Event())
        self._per_dev_last_active[dev_id] = time.monotonic()
        log.info(f'{name} ({ip}): per-device thread started')

        # IP-rediscovery iteration counter — first iteration uses cached IP
        # (fast path on process start; right ~99% of the time). Every
        # subsequent iteration (i.e. after ANY failure — exception, Err
        # 904, watchdog force-reconnect) starts by listening for the
        # device's Tuya UDP broadcast and updating the IP if it changed.
        # Self-heals from DHCP rotation within one reconnect cycle, no
        # manual SQL needed.
        attempt = 0

        while not self._stop_event.is_set():
            if force_event.is_set():
                force_event.clear()
                log.info(f'{name}: watchdog requested reconnect — opening fresh TCP')

            if attempt > 0:
                new_ip = self._rediscover_ip(dev_id, ip, name)
                if new_ip and new_ip != ip:
                    ip = new_ip
                    self._persist_local_ip(dev_id, new_ip)
            attempt += 1

            d = None
            try:
                # Read the latest key from the per-device key map so a
                # watchdog auto-refetch (after sustained Err 904) takes
                # effect on the very next reconnect, no service restart.
                key = self._per_dev_key.get(dev_id) or dev['local_key']
                d = tinytuya.Device(dev_id, ip, key, version=ver)
                d.set_socketPersistent(True)
                d.set_socketTimeout(SOCKET_TIMEOUT)

                # Get initial state
                status = d.status()
                if status and 'dps' in status:
                    self.on_state_change(dev_id, status['dps'], 'initial')
                    self._per_dev_last_active[dev_id] = time.monotonic()
                    self._per_dev_904_count[dev_id] = 0   # success — reset 904 counter
                    delay = RECONNECT_DELAY
                elif status and status.get('Error'):
                    # Loud: spell out the error so a recurring failure
                    # (e.g. Err 904 = stale local_key after re-pair) is
                    # immediately diagnosable in the journal.
                    log.warning(f'{name}: initial status error: {status}')
                    if str(status.get('Err')) == '904':
                        self._per_dev_904_count[dev_id] = self._per_dev_904_count.get(dev_id, 0) + 1

                last_heartbeat  = time.time()
                last_poll       = time.time()
                last_push       = 0  # timestamp of last tcp_push received
                last_keepalive  = time.time()
                has_dps         = bool(status and 'dps' in status)

                while not self._stop_event.is_set():
                    # Watchdog wants us to reopen the socket — break out
                    # cleanly so the outer loop reconnects fresh.
                    if force_event.is_set():
                        log.info(f'{name}: force-reconnect requested mid-loop')
                        break

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
                                self._per_dev_last_active[dev_id] = time.monotonic()
                                self._per_dev_904_count[dev_id] = 0   # success
                                has_dps = True
                            elif ps and ps.get('Error'):
                                # Loud — this was silently swallowed before
                                # (catch-all `except: break` with no log).
                                # Frozen-thread observability lives or dies
                                # here.
                                log.warning(f'{name}: poll returned error: {ps}')
                                if str(ps.get('Err')) == '904':
                                    self._per_dev_904_count[dev_id] = self._per_dev_904_count.get(dev_id, 0) + 1
                                break  # reopen socket
                        except Exception as poll_err:
                            log.warning(f'{name}: poll exception ({type(poll_err).__name__}): {poll_err}')
                            break  # connection likely dead
                        last_poll = time.time()

                    # Keepalive for devices that never report DPS (IR remotes etc.)
                    # Updates last_seen so they don't show stale on dashboard
                    if not has_dps and now - last_keepalive >= KEEPALIVE_INTERVAL:
                        self.on_state_change(dev_id, {}, 'keepalive')
                        self._per_dev_last_active[dev_id] = time.monotonic()
                        last_keepalive = now

                    data = d.receive()
                    if data is None:
                        continue

                    if isinstance(data, dict):
                        if 'dps' in data and data['dps']:
                            self.on_state_change(dev_id, data['dps'], 'tcp_push')
                            self._per_dev_last_active[dev_id] = time.monotonic()
                            self._per_dev_904_count[dev_id] = 0   # success
                            last_push = time.time()
                        elif data.get('Error'):
                            log.warning(f'{name}: device error: {data}')
                            if str(data.get('Err')) == '904':
                                self._per_dev_904_count[dev_id] = self._per_dev_904_count.get(dev_id, 0) + 1
                            break

            except Exception as e:
                # Include the exception type so 904/timeout/network-down
                # are easy to grep apart. (Rediscovery triggers
                # automatically on the next outer-loop iteration via the
                # `attempt > 0` check at the top.)
                log.warning(f'{name} ({ip}): {type(e).__name__}: {e} — reconnecting in {delay}s')
            finally:
                try:
                    if d:
                        d.close()
                except Exception:
                    pass

            if not self._stop_event.is_set():
                self._stop_event.wait(delay)
                delay = min(delay * 2, RECONNECT_MAX)

        log.warning(f'{name}: per-device thread exiting (stop_event set)')

    # ─── Gateway thread (Zigbee sub-devices via TCP push) ──────────────────

    def _gateway_thread(self):
        """Persistent TCP to the Tuya gateway hub — receives pushes for the
        hub's own DPS (e.g. Multi-Mode Gateway's built-in buttons) AND for
        Zigbee sub-devices behind it (routed by `cid` → node_id → device_id).

        Self-healing: same watchdog pattern as _device_thread. A common
        silent-freeze mode for this thread is a half-dead TCP socket
        where d.receive() keeps returning None for 15 s (its timeout)
        forever without raising — outer try/except never fires, no log
        line, thread looks alive but does nothing. The watchdog tracks
        per-thread activity (push received → last_active updated) and
        force-reconnects if silent > SILENT_FREEZE_SEC.

        Note: sub-device state still gets refreshed via `_poll_gateway`
        (60 s cloud poll) when this thread is frozen, so the visible
        impact is mostly the hub's own buttons + real-time push latency.
        """
        gw      = self._gateway_dev
        dev_id  = gw['id']
        ip      = gw['local_ip']
        key     = gw['local_key']
        ver     = float(gw.get('version') or 3.4)
        name    = gw.get('name', dev_id)[:30]
        delay   = RECONNECT_DELAY

        # Register watchdog state for the gateway hub. Initial timestamp
        # so the watchdog gives the freshly-started thread a full
        # SILENT_FREEZE_SEC grace period before flagging it.
        force_event = self._per_dev_force_reconnect.setdefault(dev_id, threading.Event())
        self._per_dev_last_active[dev_id] = time.monotonic()
        log.info(f'{name} ({ip}): gateway thread started')

        while not self._stop_event.is_set():
            if force_event.is_set():
                force_event.clear()
                log.info(f'{name}: watchdog requested reconnect — opening fresh TCP')

            d = None
            try:
                d = tinytuya.Device(dev_id, ip, key, version=ver)
                d.set_socketPersistent(True)
                d.set_socketTimeout(SOCKET_TIMEOUT)

                # Gateway hub's own status
                status = d.status()
                if status and 'dps' in status:
                    self.on_state_change(dev_id, status['dps'], 'initial')
                    self._per_dev_last_active[dev_id] = time.monotonic()
                    delay = RECONNECT_DELAY
                elif status and status.get('Error'):
                    log.warning(f'{name}: gateway initial status error: {status}')

                last_heartbeat = time.time()

                while not self._stop_event.is_set():
                    # Watchdog wants us to reopen the socket — cooperative
                    # break so the outer loop reconnects fresh.
                    if force_event.is_set():
                        log.info(f'{name}: force-reconnect requested mid-loop')
                        break

                    if time.time() - last_heartbeat >= HEARTBEAT_INTERVAL:
                        d.heartbeat(nowait=True)
                        last_heartbeat = time.time()

                    data = d.receive()
                    if data is None:
                        continue

                    if not isinstance(data, dict) or not data.get('dps'):
                        continue

                    # Any valid dps push from the gateway TCP socket counts
                    # as activity — even sub-device pushes prove the socket
                    # is alive end-to-end. This is what the watchdog reads.
                    self._per_dev_last_active[dev_id] = time.monotonic()

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
                # Include exception type so timeout/904/network-down are
                # easy to grep apart (matches _device_thread pattern).
                log.warning(f'{name} ({ip}): {type(e).__name__}: {e} — reconnecting in {delay}s')
            finally:
                try:
                    if d:
                        d.close()
                except Exception:
                    pass

            if not self._stop_event.is_set():
                self._stop_event.wait(delay)
                delay = min(delay * 2, RECONNECT_MAX)

        log.warning(f'{name}: gateway thread exiting (stop_event set)')

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
