#!/usr/bin/env python3
"""
StateManager — in-memory device/room state for rule evaluation.

Loads devices and rooms from PostgreSQL at startup, merges MQTT updates
in real-time, and manages shared persistent state + timers.

Thread-safe: all state mutations are protected by locks.
Runs on LXC 105 (Main Agent / Orchestrator).
"""

import copy
import json
import logging
import os
import threading
import time

import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger('state_manager')

DB_CONFIG = {
    'host': os.environ.get('DB_HOST', '192.168.1.219'),
    'port': 5432,
    'database': os.environ.get('DB_NAME', 'home_data'),
    'user': os.environ.get('DB_USER', 'postgres'),
}

# Keys owned by the dashboard — loaded from DB but never overwritten by save
_DASHBOARD_KEYS = {'_disabled_rules', '_rule_overrides', '_reload_request'}


class StateManager:
    """In-memory device/room state with shared persistent state for rule evaluation."""

    def __init__(self, db_config: dict):
        self.devices = {}      # device_id -> {dps, online, name, room, device_type, protocol}
        self.rooms = {}        # room_name -> {devices: [device_id, ...]}
        self.shared = {}       # persistent shared state (home_mode, people_home, etc.)
        self._timers = {}      # timer_name -> timestamp (float)
        self._db_config = db_config
        self.conn = None
        self._db_lock = threading.Lock()   # protects DB connection
        self.lock = threading.Lock()       # protects shared + _timers
        self._dev_lock = threading.Lock()  # protects devices + rooms

    # ------------------------------------------------------------------
    # DB connection helpers
    # ------------------------------------------------------------------

    def _connect_db(self):
        """Open DB connection with autocommit. Must hold _db_lock."""
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = psycopg2.connect(**self._db_config)
        self.conn.autocommit = True

    def _ensure_conn(self):
        """Reconnect if connection dropped. Must hold _db_lock."""
        try:
            if self.conn is None or self.conn.closed:
                self._connect_db()
        except Exception:
            self._connect_db()

    # ------------------------------------------------------------------
    # Startup loaders
    # ------------------------------------------------------------------

    def load_from_db(self):
        """Load devices + rooms from PostgreSQL. Called at startup and midnight."""
        with self._db_lock:
            self._ensure_conn()
            devices = {}
            rooms = {}

            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, name, room, device_type, protocol, last_state "
                    "FROM devices WHERE enabled = true"
                )
                for row in cur.fetchall():
                    dev_id = str(row['id'])
                    last_state = row['last_state']
                    if last_state is None:
                        dps = {}
                    elif isinstance(last_state, str):
                        try:
                            dps = json.loads(last_state)
                        except (json.JSONDecodeError, TypeError):
                            dps = {}
                    else:
                        dps = dict(last_state)

                    devices[dev_id] = {
                        'dps': dps,
                        'online': True,
                        'name': row['name'] or '',
                        'room': row['room'] or '',
                        'device_type': row['device_type'] or '',
                        'protocol': row['protocol'] or '',
                    }

                cur.execute("SELECT name FROM rooms")
                for row in cur.fetchall():
                    rooms[row['name']] = {'devices': []}

            # Group devices by room
            for dev_id, dev in devices.items():
                room = dev['room']
                if room:
                    if room not in rooms:
                        rooms[room] = {'devices': []}
                    rooms[room]['devices'].append(dev_id)

        # Atomic swap (GIL makes dict assignment atomic)
        with self._dev_lock:
            self.devices = devices
            self.rooms = rooms
        log.info("Loaded %d devices across %d rooms", len(devices), len(rooms))

    def load_shared_state(self):
        """Load dashboard-owned keys from DB into shared state.

        Only loads keys that the dashboard controls (_disabled_rules,
        _rule_overrides, _reload_request). Rule-computed keys are kept
        as-is in memory to avoid overwriting fresh values.
        """
        with self._db_lock:
            self._ensure_conn()
            try:
                with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("SELECT key, value FROM rule_engine_state")
                    with self.lock:
                        for row in cur.fetchall():
                            key = row['key']
                            raw = row['value']
                            if key.startswith('_timer:'):
                                timer_name = key[len('_timer:'):]
                                try:
                                    self._timers[timer_name] = float(raw)
                                except (ValueError, TypeError):
                                    log.warning("Invalid timer value for %s: %s", key, raw)
                            elif key.startswith('_pixoo_'):
                                continue  # pixoo-owned, skip
                            elif key in _DASHBOARD_KEYS:
                                # Dashboard-owned: always take DB value (parsed)
                                self.shared[key] = self._parse_value(raw)
                            elif key not in self.shared:
                                # First load only: seed keys not yet in memory
                                self.shared[key] = self._parse_value(raw)
                    log.info("Loaded %d shared keys + %d timers",
                             len(self.shared), len(self._timers))
            except psycopg2.errors.UndefinedTable:
                log.warning("rule_engine_state table does not exist — starting with empty state")
                self.conn.rollback()

    @staticmethod
    def _parse_value(raw):
        """Parse a DB value — already deserialized by psycopg2 JSONB, but handle strings."""
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return raw
        return raw

    def save_shared_state(self):
        """Persist shared state + timers to rule_engine_state table."""
        with self.lock:
            snapshot = copy.deepcopy(self.shared)
            timers = dict(self._timers)
        with self._db_lock:
            self._ensure_conn()
            try:
                with self.conn.cursor() as cur:
                    for key, value in snapshot.items():
                        # Skip keys owned by other services / dashboard
                        if (key.startswith('_pixoo_') or key in _DASHBOARD_KEYS
                                or key.startswith('_rule_override')):
                            continue
                        val_str = json.dumps(value)
                        cur.execute(
                            "INSERT INTO rule_engine_state (key, value, updated_at) "
                            "VALUES (%s, %s, NOW()) "
                            "ON CONFLICT (key) DO UPDATE "
                            "SET value = EXCLUDED.value, updated_at = NOW()",
                            (key, val_str),
                        )
                    for name, ts in timers.items():
                        cur.execute(
                            "INSERT INTO rule_engine_state (key, value, updated_at) "
                            "VALUES (%s, %s, NOW()) "
                            "ON CONFLICT (key) DO UPDATE "
                            "SET value = EXCLUDED.value, updated_at = NOW()",
                            (f'_timer:{name}', str(ts)),
                        )
                log.debug("Saved %d shared keys + %d timers",
                          len(self.shared), len(self._timers))
            except psycopg2.errors.UndefinedTable:
                log.warning("rule_engine_state table does not exist — cannot persist state")
                self.conn.rollback()

    # ------------------------------------------------------------------
    # Real-time state updates (called from MQTT callbacks)
    # ------------------------------------------------------------------

    def update_device(self, device_id: str, dps: dict, source: str = ''):
        """Merge incoming DPS into device state."""
        with self._dev_lock:
            dev = self.devices.get(device_id)
            if dev is None:
                log.debug("update_device: unknown device_id %s (source=%s)", device_id, source)
                return
            dev['dps'].update(dps)

    def update_availability(self, device_id: str, online: bool):
        """Update device online status."""
        with self._dev_lock:
            dev = self.devices.get(device_id)
            if dev is not None:
                dev['online'] = online

    def update_inventory(self, inventory: list):
        """Refresh devices and rooms from _bridge/devices topic.

        Preserves existing DPS for known devices so we don't wipe
        state on inventory refresh.
        """
        new_devices = {}
        new_rooms = {}

        with self._dev_lock:
            old_devices = self.devices

        for item in inventory:
            dev_id = str(item.get('id', ''))
            if not dev_id:
                continue

            # Preserve existing DPS if we already track this device
            existing_dps = {}
            existing_online = True
            if dev_id in old_devices:
                existing_dps = old_devices[dev_id].get('dps', {})
                existing_online = old_devices[dev_id].get('online', True)

            new_devices[dev_id] = {
                'dps': existing_dps,
                'online': existing_online,
                'name': item.get('name', ''),
                'room': item.get('room', ''),
                'device_type': item.get('device_type', ''),
                'protocol': item.get('protocol', ''),
            }

            room = item.get('room', '')
            if room:
                if room not in new_rooms:
                    new_rooms[room] = {'devices': []}
                new_rooms[room]['devices'].append(dev_id)

        # Atomic swap
        with self._dev_lock:
            self.devices = new_devices
            self.rooms = new_rooms
        log.info("Inventory refresh: %d devices across %d rooms",
                 len(new_devices), len(new_rooms))

    # ------------------------------------------------------------------
    # Timers
    # ------------------------------------------------------------------

    def set_timer(self, name: str):
        """Record current time for a named timer."""
        with self.lock:
            self._timers[name] = time.time()

    def get_timer(self, name: str) -> float:
        """Seconds since timer was set. Returns float('inf') if never set."""
        with self.lock:
            if name in self._timers:
                return time.time() - self._timers[name]
            return float('inf')

    # ------------------------------------------------------------------
    # DB access for rule event logging (thread-safe)
    # ------------------------------------------------------------------

    def db_execute(self, sql, params=None):
        """Execute a DB statement with thread-safe connection. Fire-and-forget."""
        with self._db_lock:
            self._ensure_conn()
            try:
                with self.conn.cursor() as cur:
                    cur.execute(sql, params or ())
            except Exception:
                log.debug("db_execute failed", exc_info=True)
