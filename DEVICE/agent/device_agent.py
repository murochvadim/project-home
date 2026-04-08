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
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone, timedelta

import pytz

import psycopg2
from psycopg2.extras import RealDictCursor

import requests

from adapters import ADAPTERS, CLOUD_ADAPTERS, PUSH_ADAPTERS, HAApiAdapter
from adapters.ha_api import HA_URL, HA_TOKEN
from adapters.mqtt_publisher import MqttPublisher

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

MQTT_BROKER = os.environ.get('MQTT_BROKER', '192.168.1.189')
MQTT_PORT   = int(os.environ.get('MQTT_PORT', '1883'))
MQTT_USER   = os.environ.get('MQTT_USER', 'device_agent')
MQTT_PASS   = os.environ.get('MQTT_PASS', '')

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
        self._device_best_source = {}   # device_id → (source, timestamp)
        self._device_last_event = {}    # (device_id, source) → dps_json
        self._device_states = {}        # device_id → merged last_state dict (cache, filtered)
        self._allowed_dps = {}          # device_id → set of allowed DPS keys (None = all allowed)
        self._connect_db()

        self._mqtt = MqttPublisher(
            broker=MQTT_BROKER, port=MQTT_PORT,
            username=MQTT_USER, password=MQTT_PASS,
            client_id='device-agent-103',
            lwt_topic='mur/home/device/_bridge/state',
        )
        self._mqtt.connect()

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
            devices = cur.fetchall()

            # Build allowed DPS keys per device (for filtering events/MQTT)
            cur.execute("""
                SELECT id, dps_config, channel_config, dps_labels
                FROM devices WHERE enabled = true
            """)
            for row in cur.fetchall():
                allowed = {'1'}  # DPS "1" always allowed
                for k, cfg in (row.get('channel_config') or {}).items():
                    if cfg.get('enabled') is not False:
                        allowed.add(k)
                for k, cfg in (row.get('dps_config') or {}).items():
                    if cfg.get('enabled') is not False:
                        allowed.add(k)
                for k in (row.get('dps_labels') or {}).keys():
                    allowed.add(k)
                self._allowed_dps[row['id']] = allowed

            return devices

    def _filter_dps(self, device_id: str, dps: dict) -> dict:
        """Filter DPS to only allowed keys for this device."""
        allowed = self._allowed_dps.get(device_id)
        if not allowed:
            return dps  # no config loaded → allow all (safety fallback)
        return {k: v for k, v in dps.items() if k in allowed}

    def _db_write(self, device_id: str, dps: dict, source: str):
        """Execute the DB writes for a state change event. Must be called under _db_lock."""
        with self.conn.cursor() as cur:
            if source == 'keepalive':
                cur.execute("UPDATE devices SET last_seen = NOW() WHERE id = %s", (device_id,))
                return

            # Track best source per device — upgrade, or downgrade after 600s silence
            cur_entry = self._device_best_source.get(device_id)
            cur_best = cur_entry[0] if cur_entry else None
            cur_ts = cur_entry[1] if cur_entry else 0
            new_pri = SOURCE_PRI.get(source, 0)
            cur_pri = SOURCE_PRI.get(cur_best, -1)
            now_ts = time.time()
            if new_pri >= cur_pri or (now_ts - cur_ts) > 600:
                self._device_best_source[device_id] = (source, now_ts)
                best = source
            else:
                best = cur_best

            dps_json = json.dumps(dps, sort_keys=True)
            # Filter DPS for events/MQTT (DB last_state gets all, events/MQTT get filtered)
            filtered = self._filter_dps(device_id, dps)
            filtered_json = json.dumps(filtered, sort_keys=True) if filtered else None
            now = time.time()

            # Purge stale dedup entries older than 120s to prevent unbounded growth
            if len(self._device_last_event) > 500:
                stale_keys = [k for k, v in self._device_last_event.items()
                              if isinstance(v, tuple) and (now - v[0]) > 120]
                for k in stale_keys:
                    del self._device_last_event[k]
                    # Also remove the corresponding (device_id, source) entries
                    stale_src_keys = [sk for sk in self._device_last_event
                                      if isinstance(sk, tuple) and sk[0] == k]
                    for sk in stale_src_keys:
                        del self._device_last_event[sk]

            # Dedup uses filtered DPS — changes to disabled keys don't trigger events
            dedup_key = (device_id, source)
            last_same_src = self._device_last_event.get(dedup_key)
            last_any = self._device_last_event.get(device_id)
            is_dup = (not filtered_json) or (last_same_src == filtered_json) or (last_any and (now - last_any[0]) < 2 and last_any[1] == filtered_json)

            # DB last_state gets ALL DPS (for Settings view)
            cur.execute("""
                UPDATE devices
                SET last_state = COALESCE(last_state, '{}'::jsonb) || %s::jsonb,
                    last_seen = NOW(), updated_at = NOW(), last_source = %s
                WHERE id = %s
            """, (dps_json, best, device_id))

            # Events + MQTT get only filtered (allowed) DPS
            if not is_dup and filtered_json:
                cur.execute("""
                    INSERT INTO device_events (device_id, ts, dps, source)
                    VALUES (%s, NOW(), %s, %s)
                """, (device_id, filtered_json, source))
                self._device_last_event[dedup_key] = filtered_json
                self._device_last_event[device_id] = (now, filtered_json)

            # MQTT: cached state only has filtered keys
            cached = self._device_states.get(device_id, {})
            cached.update(filtered)
            self._device_states[device_id] = cached
            if filtered:
                self._mqtt.publish_device_state(device_id, cached, source)
            if not is_dup and filtered_json:
                self._mqtt.publish_device_event(device_id, filtered, source)

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

    def _seconds_until_midnight(self):
        """Calculate seconds from now until next midnight in Asia/Jerusalem."""
        now = datetime.now(pytz.timezone('Asia/Jerusalem'))
        midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return (midnight - now).total_seconds()

    def _daily_refresh(self):
        """Republish full device inventory to MQTT at midnight daily."""
        try:
            seconds = self._seconds_until_midnight()
            while not self._stop.is_set():
                self._stop.wait(seconds)
                if self._stop.is_set():
                    break
                try:
                    with self._db_lock:
                        self._ensure_conn()
                        with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                            cur.execute("""
                                SELECT id, name, room, device_type, protocol, vendor
                                FROM devices WHERE enabled = true
                            """)
                            rows = cur.fetchall()

                    inventory = [
                        {'id': r['id'], 'name': r['name'], 'room': r.get('room', ''),
                         'device_type': r.get('device_type', ''), 'protocol': r['protocol'],
                         'vendor': r['vendor']}
                        for r in rows
                    ]
                    self._mqtt.publish_inventory(inventory)
                    log.info(f'Daily refresh: published {len(inventory)} devices')
                except Exception:
                    log.exception('Daily refresh error')

                seconds = self._seconds_until_midnight()
        except Exception:
            log.exception('Daily refresh thread crashed')

    def _config_poll_loop(self):
        """Poll devices table for enable/disable changes and new devices every 30s."""
        last_check = datetime.now(pytz.utc)
        try:
            while not self._stop.is_set():
                self._stop.wait(30)
                if self._stop.is_set():
                    break
                try:
                    with self._db_lock:
                        self._ensure_conn()
                        with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                            cur.execute(
                                "SELECT id, enabled FROM devices WHERE updated_at > %s",
                                (last_check,)
                            )
                            changed = cur.fetchall()
                            cur.execute(
                                "SELECT id FROM devices WHERE created_at > %s AND enabled = true",
                                (last_check,)
                            )
                            new_devices = cur.fetchall()

                    if not changed and not new_devices:
                        last_check = datetime.now(pytz.utc)
                        continue

                    # Publish offline for disabled devices
                    disabled = [r for r in changed if not r['enabled']]
                    for r in disabled:
                        self._mqtt.publish_availability(r['id'], False, '')

                    # Republish inventory if new or re-enabled devices found
                    re_enabled = [r for r in changed if r['enabled']]
                    if new_devices or re_enabled:
                        with self._db_lock:
                            self._ensure_conn()
                            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                                cur.execute("""
                                    SELECT id, name, room, device_type, protocol, vendor
                                    FROM devices WHERE enabled = true
                                """)
                                rows = cur.fetchall()
                        inventory = [
                            {'id': r['id'], 'name': r['name'], 'room': r.get('room', ''),
                             'device_type': r.get('device_type', ''), 'protocol': r['protocol'],
                             'vendor': r['vendor']}
                            for r in rows
                        ]
                        self._mqtt.publish_inventory(inventory)
                        # Refresh MQTT ingest map so new HASP/Awtrix/Zigbee devices are picked up
                        self._build_mqtt_device_map()

                    log.info(f'Config poll: {len(changed)} changes, {len(new_devices)} new devices')
                    last_check = datetime.now(pytz.utc)
                except Exception:
                    log.exception('Config poll error')
        except Exception:
            log.exception('Config poll thread crashed')

    # ── MQTT command handler ──────────────────────────────────────

    # Entities to skip when resolving switchable target
    _SKIP_SUFFIXES = ('child_lock', 'countdown', 'indicator')
    # Preferred entity suffixes, in priority order
    _PREFER_SUFFIXES = ('_switch', '_switch_1', '_light', '_curtain')

    def _resolve_entity(self, device_id: str, channel: str | None) -> dict | None:
        """Pick the best HA entity for a command. Returns {entity_id, domain} or None."""
        ha_adapter = self.adapters.get('ha_api')
        if not ha_adapter:
            return None
        entities = ha_adapter._entity_map.get(device_id, [])
        if not entities:
            return None

        # Filter out non-actionable entities (sensors, child_lock, etc.)
        candidates = [
            e for e in entities
            if e['domain'] in ('switch', 'light', 'fan', 'cover')
            and not any(e['entity_id'].endswith(s) for s in self._SKIP_SUFFIXES)
        ]
        if not candidates:
            return None

        # If channel specified, find exact match
        if channel:
            suffix = f'_{channel}'
            for e in candidates:
                if e['entity_id'].endswith(suffix):
                    return e
            return None

        # Prefer known suffixes
        for pref in self._PREFER_SUFFIXES:
            for e in candidates:
                if e['entity_id'].endswith(pref):
                    return e

        # Fall back to first switch entity
        for e in candidates:
            if e['domain'] == 'switch':
                return e
        return candidates[0]

    def _handle_command(self, device_id: str, payload: dict):
        """Execute a device command via HA API. Runs in a daemon thread."""
        rule = payload.get('rule', '')
        resp_topic = f'mur/home/device/{device_id}/command/response'
        try:
            action = payload.get('action')
            if not action:
                self._mqtt.publish(resp_topic, {'ok': False, 'error': 'Missing action', 'rule': rule})
                return

            channel = payload.get('channel')
            entity = self._resolve_entity(device_id, channel)
            if not entity:
                self._mqtt.publish(resp_topic, {
                    'ok': False, 'error': 'No switchable entity found', 'rule': rule,
                })
                return

            entity_id = entity['entity_id']
            domain = entity['domain']
            headers = {'Authorization': f'Bearer {HA_TOKEN}', 'Content-Type': 'application/json'}
            svc_data: dict = {'entity_id': entity_id}

            if action in ('turn_on', 'turn_off'):
                service = f'{domain}/{action}'
            elif action == 'set_brightness':
                service = 'light/turn_on'
                svc_data['brightness'] = int(payload.get('brightness', 128))
            elif action == 'set_color_temp':
                service = 'light/turn_on'
                svc_data['color_temp'] = int(payload.get('color_temp', 370))
            elif action == 'set_position':
                service = 'cover/set_cover_position'
                svc_data['position'] = int(payload.get('position', 50))
            else:
                self._mqtt.publish(resp_topic, {
                    'ok': False, 'error': f'Unknown action: {action}', 'rule': rule,
                })
                return

            r = requests.post(
                f'{HA_URL}/api/services/{service}',
                headers=headers, json=svc_data, timeout=10,
            )
            r.raise_for_status()

            log.info(f'Command OK: {device_id} → {service} ({entity_id}) rule={rule}')
            self._mqtt.publish(resp_topic, {
                'ok': True, 'entity_id': entity_id, 'service': service, 'rule': rule,
            })

        except Exception as e:
            log.error(f'Command failed for {device_id}: {e}')
            self._mqtt.publish(resp_topic, {
                'ok': False, 'error': str(e), 'rule': rule,
            })

    # ── MQTT ingest ──────────────────────────────────────────────

    def _build_mqtt_device_map(self):
        """Build name→device_id lookup for MQTT-protocol devices."""
        with self._db_lock:
            self._ensure_conn()
            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, name, protocol FROM devices
                    WHERE protocol IN ('mqtt', 'hasp', 'awtrix', 'zigbee')
                      AND enabled = true
                """)
                rows = cur.fetchall()

        self._mqtt_id_map = {r['name'].lower(): r['id'] for r in rows}
        log.info(f'MQTT device map: {len(self._mqtt_id_map)} devices')

    def _on_mqtt_message(self, client, userdata, msg):
        """Callback for subscribed MQTT topics — routes to on_state_change."""
        try:
            topic = msg.topic
            parts = topic.split('/')

            # --- mur/home/device/+/command ---
            if topic.startswith('mur/home/device/') and topic.endswith('/command'):
                device_id = parts[3]
                try:
                    payload = json.loads(msg.payload)
                except (json.JSONDecodeError, ValueError):
                    log.warning(f'Invalid command JSON for {device_id}')
                    return
                # Run in thread to avoid blocking MQTT callback loop
                threading.Thread(
                    target=self._handle_command, args=(device_id, payload),
                    daemon=True, name=f'cmd-{device_id[:8]}',
                ).start()
                return

            # --- mur/home/device/+/ingest ---
            if topic.startswith('mur/home/device/') and topic.endswith('/ingest'):
                device_id = parts[3]
                source = 'mqtt'
                try:
                    dps = json.loads(msg.payload)
                except (json.JSONDecodeError, ValueError):
                    return

            # --- hasp/+/state/+ (object state — before hasp/+/state to avoid prefix clash) ---
            elif topic.startswith('hasp/') and len(parts) == 4 and parts[2] == 'state':
                node = parts[1]
                obj_key = parts[3]
                device_id = self._mqtt_id_map.get(node.lower())
                if not device_id:
                    log.debug(f'Unmapped HASP device: {node}')
                    return
                source = 'hasp'
                # Payload may be raw value or JSON
                raw = msg.payload.decode('utf-8', errors='replace')
                try:
                    val = json.loads(raw)
                except (json.JSONDecodeError, ValueError):
                    val = raw
                dps = {obj_key: val}

            # --- hasp/+/state (plate status JSON) ---
            elif topic.startswith('hasp/') and len(parts) == 3 and parts[2] == 'state':
                node = parts[1]
                device_id = self._mqtt_id_map.get(node.lower())
                if not device_id:
                    log.debug(f'Unmapped HASP device: {node}')
                    return
                source = 'hasp'
                try:
                    dps = json.loads(msg.payload)
                except (json.JSONDecodeError, ValueError):
                    return

            # --- awtrix/+/stats ---
            elif topic.startswith('awtrix/') and len(parts) == 3 and parts[2] == 'stats':
                uid = parts[1]
                device_id = self._mqtt_id_map.get(uid.lower())
                if not device_id:
                    log.debug(f'Unmapped Awtrix device: {uid}')
                    return
                source = 'awtrix'
                try:
                    dps = json.loads(msg.payload)
                except (json.JSONDecodeError, ValueError):
                    return

            # --- zigbee2mqtt/+ (skip bridge) ---
            elif topic.startswith('zigbee2mqtt/') and len(parts) == 2:
                friendly_name = parts[1]
                if friendly_name == 'bridge':
                    return
                device_id = self._mqtt_id_map.get(friendly_name.lower())
                if not device_id:
                    log.debug(f'Unmapped Zigbee device: {friendly_name}')
                    return
                source = 'zigbee'
                try:
                    dps = json.loads(msg.payload)
                except (json.JSONDecodeError, ValueError):
                    return

            else:
                return

            self.on_state_change(device_id, dps, source)
        except Exception:
            log.exception(f'MQTT ingest error on topic {msg.topic}')

    def _setup_mqtt_ingest(self):
        """Subscribe to external MQTT topics for DIY, HASP, Awtrix, Zigbee devices."""
        self._build_mqtt_device_map()
        if not self._mqtt_id_map:
            log.info('No MQTT-protocol devices configured — skipping MQTT ingest')
            return
        topics = [
            ('mur/home/device/+/ingest', 0),
            ('mur/home/device/+/command', 1),   # QoS 1 — commands must be delivered
            ('hasp/+/state', 0),
            ('hasp/+/state/+', 0),
            ('awtrix/+/stats', 0),
            ('zigbee2mqtt/+', 0),
        ]
        self._mqtt.subscribe(topics, self._on_mqtt_message)
        log.info(f'MQTT ingest: subscribed to {len(topics)} topic patterns')

    def _availability_loop(self):
        """Periodically check device last_seen and publish availability to MQTT."""
        tz_jerusalem = pytz.timezone('Asia/Jerusalem')
        while not self._stop.is_set():
            self._stop.wait(180)
            if self._stop.is_set():
                break
            try:
                with self._db_lock:
                    self._ensure_conn()
                    with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute("SELECT id, last_seen FROM devices WHERE enabled = true")
                        rows = cur.fetchall()

                now = datetime.now(timezone.utc)
                online_count = 0
                offline_count = 0
                for row in rows:
                    device_id = row['id']
                    last_seen = row['last_seen']
                    if last_seen is None:
                        online = False
                        last_seen_str = ''
                    else:
                        # Ensure last_seen is timezone-aware (DB may return naive as UTC)
                        if last_seen.tzinfo is None:
                            last_seen = last_seen.replace(tzinfo=timezone.utc)
                        age = (now - last_seen).total_seconds()
                        online = age <= 180
                        last_seen_str = last_seen.astimezone(tz_jerusalem).isoformat()

                    self._mqtt.publish_availability(device_id, online, last_seen_str)
                    if online:
                        online_count += 1
                    else:
                        offline_count += 1

                log.info(f'Availability check: {online_count} online, {offline_count} offline')
            except Exception:
                log.exception('Availability loop error')

    def run(self):
        log.info('Device Agent starting')

        # Load devices from DB
        devices = self._load_devices()
        log.info(f'Loaded {len(devices)} enabled devices')

        # Seed state cache from DB with filtered keys only
        with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, last_state FROM devices WHERE enabled = true AND last_state IS NOT NULL")
            for row in cur.fetchall():
                self._device_states[row['id']] = self._filter_dps(row['id'], dict(row['last_state']))

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

        # Publish device inventory and bridge status to MQTT
        inventory = [
            {'id': d['id'], 'name': d['name'], 'room': d.get('room', ''),
             'device_type': d.get('device_type', ''), 'protocol': d['protocol'],
             'vendor': d['vendor']}
            for d in devices
        ]
        self._mqtt.publish_inventory(inventory)
        self._mqtt.publish_bridge_online(len(devices), len(self.adapters))

        # Subscribe to external MQTT topics (DIY, HASP, Awtrix, Zigbee)
        self._setup_mqtt_ingest()

        # Start availability checker thread (first check after 180s)
        threading.Thread(target=self._availability_loop, daemon=True, name='avail-check').start()

        # Start daily inventory refresh thread (publishes at midnight Asia/Jerusalem)
        threading.Thread(target=self._daily_refresh, daemon=True, name='daily-refresh').start()

        # Start config change polling thread (checks for enable/disable/new devices every 30s)
        threading.Thread(target=self._config_poll_loop, daemon=True, name='config-poll').start()

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
            self._mqtt.disconnect()
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
