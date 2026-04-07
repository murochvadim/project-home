#!/usr/bin/env python3
"""
Device Agent — persistent TCP connections to all local Tuya devices.
Writes state changes to devices.last_state and device_events table.
Logs each run cycle to device_agent_log for orchestrator monitoring.

Usage:
  python3 device_agent.py

Env:
  None required — DB accessed without password (LXC 103 IP trusted in pg_hba.conf)
"""

import json
import logging
import signal
import sys
import threading
import time
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import RealDictCursor

from adapters import ADAPTERS, CLOUD_ADAPTERS, PUSH_ADAPTERS, HAApiAdapter

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger('device_agent')

DB_CONFIG = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}

LOG_INTERVAL = 300   # write device_agent_log every 5 min

# Higher number = better/faster source — only upgrade, never downgrade
SOURCE_PRI = {
    'initial': 0, 'gateway_init': 0,
    'cloud_poll': 1, 'local_poll': 2,
    'gateway_push': 3, 'cloud_push': 3,
    'ha_api': 4, 'home_connect': 4, 'tcp_push': 5, 'mqtt': 5,
}


class DeviceAgent:
    def __init__(self):
        self.conn = None
        self.adapters = {}
        self._event_count = 0
        self._error_count = 0
        self._db_lock = threading.Lock()
        self._stop = threading.Event()
        self._device_best_source = {}   # device_id → best source seen
        self._device_last_event = {}    # (device_id, source) → dps_json
        self._connect_db()

    def _connect_db(self):
        """Open a new DB connection. Caller must hold _db_lock if threads are running."""
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = psycopg2.connect(**DB_CONFIG)
        self.conn.autocommit = True

    def _ensure_conn(self):
        """Check connection health, reconnect if needed. Must be called under _db_lock."""
        try:
            if self.conn.closed:
                self._connect_db()
        except Exception:
            self._connect_db()

    def _load_devices(self):
        with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Auto-populate MAC for devices that have local_ip but no mac
            cur.execute("""
                UPDATE devices d SET mac = n.mac
                FROM net_devices n
                WHERE n.ip = d.local_ip AND d.mac IS NULL AND d.local_ip IS NOT NULL
            """)
            # Load devices with fresh IP from net_devices (via MAC lookup)
            cur.execute("""
                SELECT d.id, d.name, d.vendor, d.device_type, d.protocol,
                       COALESCE(n.ip, d.local_ip) AS local_ip,
                       d.local_key, d.gateway_id, d.version,
                       d.poll_enabled, d.poll_interval_sec, d.enabled, d.mac
                FROM devices d
                LEFT JOIN net_devices n ON n.mac = d.mac
                WHERE d.enabled = true
                ORDER BY d.vendor, d.protocol, d.name
            """)
            return cur.fetchall()

    def _db_write(self, device_id: str, dps: dict, source: str):
        """Execute the DB writes for a state change event. Must be called under _db_lock."""
        with self.conn.cursor() as cur:
            if source == 'keepalive':
                cur.execute("UPDATE devices SET last_seen = NOW() WHERE id = %s", (device_id,))
                return

            # Track best source per device — only upgrade
            cur_best = self._device_best_source.get(device_id)
            new_pri = SOURCE_PRI.get(source, 0)
            cur_pri = SOURCE_PRI.get(cur_best, -1)
            if new_pri >= cur_pri:
                self._device_best_source[device_id] = source
                best = source
            else:
                best = cur_best

            dps_json = json.dumps(dps, sort_keys=True)
            now = time.time()

            # Dedup per device+source: skip event if DPS unchanged since last write from same source
            # Cross-source dedup: skip if same DPS within 2 seconds (e.g. tcp_push + ha_api)
            dedup_key = (device_id, source)
            last_same_src = self._device_last_event.get(dedup_key)
            last_any = self._device_last_event.get(device_id)
            is_dup = (last_same_src == dps_json) or (last_any and (now - last_any[0]) < 2 and last_any[1] == dps_json)

            cur.execute("""
                UPDATE devices
                SET last_state = COALESCE(last_state, '{}'::jsonb) || %s::jsonb,
                    last_seen = NOW(), updated_at = NOW(), last_source = %s
                WHERE id = %s
            """, (dps_json, best, device_id))

            if not is_dup:
                cur.execute("""
                    INSERT INTO device_events (device_id, ts, dps, source)
                    VALUES (%s, NOW(), %s, %s)
                """, (device_id, dps_json, source))
                self._device_last_event[dedup_key] = dps_json
                self._device_last_event[device_id] = (now, dps_json)

    def on_state_change(self, device_id: str, dps: dict, source: str):
        """Called by any adapter when a device state changes. Thread-safe."""
        with self._db_lock:
            try:
                self._db_write(device_id, dps, source)
                self._event_count += 1
                if self._event_count % 50 == 0:
                    log.info(f'Events processed: {self._event_count}')
            except (psycopg2.InterfaceError, psycopg2.OperationalError):
                log.warning('DB connection lost — reconnecting and retrying')
                try:
                    self._connect_db()
                    self._db_write(device_id, dps, source)
                    self._event_count += 1
                except Exception as e:
                    log.error(f'DB retry failed for {device_id}: {e}')
                    self._error_count += 1
            except Exception as e:
                log.error(f'DB write error for {device_id}: {e}')
                self._error_count += 1

    def _write_log(self, decision: str, error: str):
        """Write heartbeat to device_agent_log. Thread-safe."""
        with self._db_lock:
            try:
                self._ensure_conn()
                with self.conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO device_agent_log (ts, decision, error, next_ts)
                        VALUES (NOW(), %s, %s, NOW() + INTERVAL '5 minutes')
                    """, (decision, error))
            except Exception as e:
                log.error(f'Failed to write agent log: {e}')

    def run(self):
        log.info('Device Agent starting')

        # Load devices from DB
        devices = self._load_devices()
        log.info(f'Loaded {len(devices)} enabled devices')

        # Group by vendor+protocol key
        by_key = {}
        for dev in devices:
            proto = dev['protocol']
            vendor = dev['vendor']
            key = f'{vendor}:cloud' if proto == 'cloud' else vendor
            by_key.setdefault(key, []).append(dev)

        # Start adapter per group
        for key, group_devices in by_key.items():
            vendor = key.split(':')[0]
            is_cloud = key.endswith(':cloud')
            registry = CLOUD_ADAPTERS if is_cloud else ADAPTERS
            if vendor not in registry:
                log.warning(f'No adapter for {key} — skipping {len(group_devices)} devices')
                continue
            adapter = registry[vendor](group_devices, self.on_state_change)
            adapter.start()
            self.adapters[key] = adapter
            log.info(f'Started {key} adapter for {len(group_devices)} devices')

        # Start real-time cloud push adapters (gateway + cloud devices)
        push_devices = [d for d in devices if d['protocol'] in ('gateway', 'cloud')]
        if push_devices:
            vendors = {d['vendor'] for d in push_devices}
            for vendor in vendors:
                if vendor in PUSH_ADAPTERS:
                    vdevs = [d for d in push_devices if d['vendor'] == vendor]
                    adapter = PUSH_ADAPTERS[vendor](vdevs, self.on_state_change)
                    adapter.start()
                    self.adapters[f'{vendor}:push'] = adapter
                    log.info(f'Started {vendor}:push adapter for {len(vdevs)} devices')

        # Start HA API adapter for all enabled devices (real-time via WebSocket)
        ha_adapter = HAApiAdapter(devices, self.on_state_change)
        ha_adapter.start()
        self.adapters['ha_api'] = ha_adapter
        log.info(f'Started ha_api adapter for {len(devices)} devices')

        # Write initial log entry
        self._write_log(
            f'Started — {len(devices)} devices across {len(self.adapters)} adapters',
            'NO ERROR'
        )

        # Main loop — write heartbeat log periodically
        last_log = time.time()
        try:
            while not self._stop.is_set():
                self._stop.wait(10)
                if time.time() - last_log >= LOG_INTERVAL:
                    adapters_summary = ', '.join(
                        f'{k}:{len(a.devices)}' for k, a in self.adapters.items()
                    )
                    err = 'NO ERROR' if self._error_count == 0 else f'WARN: {self._error_count} DB errors'
                    self._write_log(
                        f'Running — {self._event_count} events [{adapters_summary}]',
                        err
                    )
                    last_log = time.time()
        finally:
            log.info('Shutting down adapters')
            for adapter in self.adapters.values():
                adapter.stop()
            self._write_log('Stopped', 'NO ERROR')
            try:
                self.conn.close()
            except Exception:
                pass

    def shutdown(self):
        self._stop.set()


def main():
    agent = DeviceAgent()

    def _shutdown(sig, frame):
        log.info(f'Signal {sig} received, shutting down')
        agent.shutdown()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    agent.run()


if __name__ == '__main__':
    main()
