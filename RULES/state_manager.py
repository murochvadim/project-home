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
import math
import os
import threading
import time

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values

log = logging.getLogger('state_manager')

DB_CONFIG = {
    'host': os.environ.get('DB_HOST', '192.168.1.219'),
    'port': 5432,
    'database': os.environ.get('DB_NAME', 'home_data'),
    'user': os.environ.get('DB_USER', 'postgres'),
}

# Keys owned by the dashboard — loaded from DB but never overwritten by save
_DASHBOARD_KEYS = {'_disabled_rules', '_rule_overrides', '_reload_request', '_spatial_reload_request', '_rule_stats_reset'}


# ======================================================================
# Spatial geometry helpers — public module API for rules.
# Port of `zoneGridBoundsSrv` / `resolveCellSrv` from
# BOILER/dashboard/server.js. Both sides read the same DB rows
# (room_layouts.<slug> JSONB), so behaviour stays in sync by construction.
# Coordinates are in metres; 1 m grid per cell; cell numbering is row-major,
# 1-based (matches the V6 Zones convention on the Rooms page).
#
# Any rule can call these directly:
#   from state_manager import zone_grid_bounds, cell_id_for_point, resolve_zone, cone_zones
# Or via the instance helpers on `state` in evaluate(event, state).
# ======================================================================

def zone_grid_bounds(layout):
    """Compute the 1 m grid bbox from a room's walls. Returns dict or None."""
    walls = (layout or {}).get('walls') or []
    if not walls:
        return None
    xs, ys = [], []
    for w in walls:
        try:
            xs.extend([float(w['x1']), float(w['x2'])])
            ys.extend([float(w['y1']), float(w['y2'])])
        except (KeyError, TypeError, ValueError):
            continue
    if not xs or not ys:
        return None
    minX, minY = min(xs), min(ys)
    maxX, maxY = max(xs), max(ys)
    return {
        'minX': minX, 'minY': minY,
        'cols': max(1, int(math.ceil(maxX - minX))),
        'rows': max(1, int(math.ceil(maxY - minY))),
    }


def cell_id_for_point(layout, x, y):
    """Return the 1-based cell id for (x, y) in room-local metres, or None."""
    g = zone_grid_bounds(layout)
    if not g:
        return None
    col = int(math.floor(float(x) - g['minX']))
    row = int(math.floor(float(y) - g['minY']))
    if col < 0 or col >= g['cols'] or row < 0 or row >= g['rows']:
        return None
    return row * g['cols'] + col + 1


def resolve_zone(layout, x, y):
    """Return ('zone_name' or None) for the point. None if out of grid or unnamed cell."""
    cell_id = cell_id_for_point(layout, x, y)
    if cell_id is None:
        return None
    for z in (layout.get('zones') or []):
        if cell_id in (z.get('cells') or []):
            return z.get('name')
    return None  # inside grid but unnamed cell


def cone_zones(layout, placement):
    """Sample the sensor's cone and return the set of zone names it overlaps.

    Matches the visual cone drawn on the Rooms page (see renderPlacementsForRoom
    in rooms.js): symmetric halves from (rot - angL) to rot and rot to (rot + angR),
    with independent radii. Samples at 1° angular steps × 0.3 m radial steps,
    which at 45° half-angle and 4 m gives ~900 points per side — negligible CPU
    at load time, deterministic. Wall clipping NOT applied (can be added later
    via wall_barrier param); for rule activity tracking the raw cone is accurate
    enough because sensors fire on any motion in their actual sensing volume."""
    params = (placement.get('params') or {})
    if params.get('enabled') is False:
        return set()
    legacy_ang = params.get('beam_angle_deg')
    legacy_len = params.get('beam_length_m')
    try:
        legacy_ang = float(legacy_ang) if legacy_ang is not None else None
        legacy_len = float(legacy_len) if legacy_len is not None else None
    except (TypeError, ValueError):
        legacy_ang = legacy_len = None

    def _get(k, fallback):
        v = params.get(k)
        try:
            return float(v) if v is not None else fallback
        except (TypeError, ValueError):
            return fallback

    ang_l = _get('beam_angle_left_deg',  (legacy_ang / 2) if legacy_ang is not None else 45.0)
    ang_r = _get('beam_angle_right_deg', (legacy_ang / 2) if legacy_ang is not None else 45.0)
    len_l = _get('beam_length_left_m',   legacy_len if legacy_len is not None else 4.0)
    len_r = _get('beam_length_right_m',  legacy_len if legacy_len is not None else 4.0)
    try:
        rot = float(placement.get('rotation') or 0) * math.pi / 180.0
        px = float(placement['x'])
        py = float(placement['y'])
    except (KeyError, TypeError, ValueError):
        return set()

    step_m = 0.3
    zones = set()
    for ang_start_rad, ang_span_rad, length in (
        (rot - ang_l * math.pi / 180, ang_l * math.pi / 180, len_l),
        (rot,                         ang_r * math.pi / 180, len_r),
    ):
        n_angles = max(4, int(ang_span_rad * 180 / math.pi))
        n_steps = max(1, int(length / step_m))
        for ka in range(n_angles + 1):
            a = ang_start_rad + ang_span_rad * (ka / n_angles if n_angles else 0)
            cos_a, sin_a = math.cos(a), math.sin(a)
            for ks in range(n_steps + 1):
                r = ks * step_m
                zname = resolve_zone(layout, px + r * cos_a, py + r * sin_a)
                if zname:
                    zones.add(zname)
    return zones


class StateManager:
    """In-memory device/room state with shared persistent state for rule evaluation."""

    def __init__(self, db_config: dict):
        self.devices = {}      # device_id -> {dps, online, name, room, device_type, protocol}
        self.rooms = {}        # room_name -> {devices: [device_id, ...]}
        # Spatial index — rebuilt inside load_from_db() from room_layouts.* +
        # room_device_placements. Starts empty so rules can do `state.spatial or {}`
        # safely before the first load completes. See docstring on _build_spatial.
        self.spatial = {}
        self.shared = {}       # persistent shared state (home_mode, people_home, etc.)
        self._timers = {}      # timer_name -> timestamp (float)
        self._db_config = db_config
        # Two independent DB connections to avoid blocking:
        # * self.conn  — used by rule-driven ops (db_execute, db_query, get_device_state_at,
        #   emit_virtual_event, get_events_between, get_last_transition_before).
        #   Protected by _db_lock.
        # * self._hb_conn — used only by the heartbeat thread (load_from_db, load_shared_state,
        #   save_shared_state, _write_heartbeat). Protected by _hb_lock.
        # Separation prevents heartbeat's ~250ms lock-hold (167-row upsert in save_shared_state)
        # from blocking rule emissions (5-15ms each).
        self.conn = None
        self._hb_conn = None
        self._db_lock = threading.Lock()   # protects self.conn
        self._hb_lock = threading.Lock()   # protects self._hb_conn
        self.lock = threading.Lock()       # protects shared + _timers
        self._dev_lock = threading.Lock()  # protects devices + rooms

    # ------------------------------------------------------------------
    # DB connection helpers
    # ------------------------------------------------------------------

    def _open_connection(self):
        """Open a new psycopg2 connection with autocommit. Used by both _connect_db and _connect_hb_db."""
        c = psycopg2.connect(**self._db_config)
        c.autocommit = True
        return c

    def _connect_db(self):
        """(Re)open the rule-ops connection. Must hold _db_lock."""
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = self._open_connection()

    def _ensure_conn(self):
        """Reconnect rule-ops connection if dropped. Must hold _db_lock."""
        try:
            if self.conn is None or self.conn.closed:
                self._connect_db()
        except Exception:
            self._connect_db()

    def _connect_hb_db(self):
        """(Re)open the heartbeat connection. Must hold _hb_lock."""
        try:
            if self._hb_conn:
                self._hb_conn.close()
        except Exception:
            pass
        self._hb_conn = self._open_connection()

    def _ensure_hb_conn(self):
        """Reconnect heartbeat connection if dropped. Must hold _hb_lock."""
        try:
            if self._hb_conn is None or self._hb_conn.closed:
                self._connect_hb_db()
        except Exception:
            self._connect_hb_db()

    # ------------------------------------------------------------------
    # Startup loaders
    # ------------------------------------------------------------------

    def load_from_db(self):
        """Load devices + rooms + spatial index from PostgreSQL.
        Called at startup, at midnight, and on demand when the dashboard
        flips `_spatial_reload_request='pending'` (auto-reload hook).
        Uses the heartbeat-dedicated connection so it does not block rule emissions."""
        with self._hb_lock:
            self._ensure_hb_conn()
            devices = {}
            rooms = {}
            layouts = {}           # slug -> layout dict
            placements = []        # list of placement rows (dicts)

            with self._hb_conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, name, room, device_type, protocol, last_state, dps_labels, dps_config "
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

                    # dps_labels is a JSONB column — psycopg2 returns it as a
                    # dict already; default to {} when NULL or unparseable so
                    # callers can do `dev.get('dps_labels', {}).get(key)` safely.
                    raw_labels = row.get('dps_labels')
                    if isinstance(raw_labels, dict):
                        dps_labels = raw_labels
                    elif isinstance(raw_labels, str):
                        try:
                            dps_labels = json.loads(raw_labels) or {}
                        except (json.JSONDecodeError, TypeError):
                            dps_labels = {}
                    else:
                        dps_labels = {}

                    # dps_config — same JSONB shape; consumed by
                    # rule_engine._resolve_esp_action to map turn_on/turn_off
                    # to per-channel sketch actions (action_on / action_off).
                    # Without this loaded, ESP boards added via rules silently
                    # log "no mapping for action" and the dispatch is dropped.
                    raw_cfg = row.get('dps_config')
                    if isinstance(raw_cfg, dict):
                        dps_config = raw_cfg
                    elif isinstance(raw_cfg, str):
                        try:
                            dps_config = json.loads(raw_cfg) or {}
                        except (json.JSONDecodeError, TypeError):
                            dps_config = {}
                    else:
                        dps_config = {}

                    devices[dev_id] = {
                        'dps': dps,
                        'online': True,
                        'name': row['name'] or '',
                        'room': row['room'] or '',
                        'device_type': row['device_type'] or '',
                        'protocol': row['protocol'] or '',
                        'dps_labels': dps_labels,
                        'dps_config': dps_config,
                    }

                cur.execute("SELECT name FROM rooms")
                for row in cur.fetchall():
                    rooms[row['name']] = {'devices': []}

                # Room layouts — JSONB per slug. Skip the apartment-view marker.
                cur.execute(
                    "SELECT key, value FROM dashboard_settings "
                    "WHERE key LIKE 'room_layouts.%' AND key <> 'room_layouts._apartment'"
                )
                for row in cur.fetchall():
                    slug = row['key'][len('room_layouts.'):]
                    raw = row['value']
                    if isinstance(raw, str):
                        try:
                            raw = json.loads(raw)
                        except (json.JSONDecodeError, TypeError):
                            continue
                    if isinstance(raw, dict):
                        layouts[slug] = raw

                # Placements — used for sensor/light/door placement in rooms.
                cur.execute(
                    "SELECT p.id, p.slug, p.device_id, p.device_type, p.x, p.y, p.rotation, "
                    "       p.params, p.label, d.name AS device_name "
                    "FROM room_device_placements p "
                    "LEFT JOIN devices d ON d.id = p.device_id"
                )
                for row in cur.fetchall():
                    params = row['params']
                    if isinstance(params, str):
                        try:
                            params = json.loads(params)
                        except (json.JSONDecodeError, TypeError):
                            params = {}
                    placements.append({
                        'id': row['id'],
                        'slug': row['slug'],
                        'device_id': row['device_id'],
                        'device_type': row['device_type'],
                        'x': row['x'], 'y': row['y'],
                        'rotation': row['rotation'],
                        'params': params or {},
                        'label': row['label'],
                        'device_name': row['device_name'],
                    })

            # Group devices by room
            for dev_id, dev in devices.items():
                room = dev['room']
                if room:
                    if room not in rooms:
                        rooms[room] = {'devices': []}
                    rooms[room]['devices'].append(dev_id)

            # Build spatial index from layouts + placements (read-only pass).
            spatial = self._build_spatial(rooms, layouts, placements)

        # Atomic swap (GIL makes dict assignment atomic)
        with self._dev_lock:
            self.devices = devices
            self.rooms = rooms
            self.spatial = spatial
        n_zones = sum(len(r['zones']) for r in spatial['rooms_by_slug'].values())
        n_placements = len(spatial.get('device_to_zones', {}))
        n_doors = len(spatial.get('door_sensor_to_adjacency', {}))
        log.info(
            "Loaded %d devices, %d rooms, %d layouts, %d zones, %d presence/motion placements, %d door sensors",
            len(devices), len(rooms), len(layouts), n_zones, n_placements, n_doors,
        )

    def _build_spatial(self, rooms, layouts, placements):
        """Build the spatial index — pure function, no DB access, no locks.

        Shape:
            {
              'rooms_by_slug': {
                  'living-room': {
                      'name': 'Living Room',
                      'zones': {'Kitchen Cooking': {'cells': [...],
                                                     'sensor_device_ids': [...]},
                                ...},
                      'sensors':      [device_id, ...],  # presence + motion
                      'door_sensors': [device_id, ...],
                      'lights':       [{id, controller_device_id, dps_key}, ...],
                      'adjacent_rooms': ['balcony', 'hallway', ...],
                  },
                  ...
              },
              'subrooms': {
                  'Kitchen': {'parent_slug': 'living-room',
                              'zones': ['Kitchen Cooking', 'Kitchen Bar', ...]},
                  ...
              },
              'device_to_zones': {
                  device_id: {'room_slug': 'living-room',
                              'zones': ['Kitchen Cooking', ...]},
                  ...
              },
              'door_sensor_to_adjacency': {
                  device_id: {'room_slug': 'entrance',
                              'leads_to_slug': None,
                              'name': 'Main Door'},
                  ...
              },
            }
        """
        # Slug → room-name map (heuristic: 'living-room' -> 'Living Room'; rooms
        # table has the canonical name, so match by lower(replace(name, ' ', '-'))).
        name_by_slug = {}
        for rname in rooms.keys():
            slug = rname.lower().replace(' ', '-')
            name_by_slug[slug] = rname

        spatial = {
            'rooms_by_slug': {},
            'subrooms': {},
            'device_to_zones': {},
            'door_sensor_to_adjacency': {},
        }

        # Pass 1 — skeleton from layouts.
        for slug, layout in layouts.items():
            zones_info = {}
            for z in (layout.get('zones') or []):
                zname = z.get('name') or ''
                if not zname:
                    continue
                zones_info[zname] = {
                    'cells': list(z.get('cells') or []),
                    'sensor_device_ids': [],
                }
            adjacent = set()
            for d in (layout.get('doors') or []):
                if d.get('leads_to'):
                    adjacent.add(d['leads_to'])
            for d in (layout.get('dividers') or []):
                if d.get('leads_to'):
                    adjacent.add(d['leads_to'])
            spatial['rooms_by_slug'][slug] = {
                'name': name_by_slug.get(slug, slug.replace('-', ' ').title()),
                'zones': zones_info,
                'sensors': [],
                'door_sensors': [],
                'lights': [],
                'adjacent_rooms': sorted(adjacent),
            }

        # Pass 2 — placements: resolve each sensor's cone to covered zones.
        for p in placements:
            slug = p['slug']
            dev_id = p['device_id']
            dtype = (p.get('device_type') or '').lower()
            if slug not in spatial['rooms_by_slug']:
                continue
            room = spatial['rooms_by_slug'][slug]
            layout = layouts.get(slug, {})

            if dtype in ('presence', 'motion'):
                room['sensors'].append(dev_id)
                zones_covered = cone_zones(layout, p)
                for zname in zones_covered:
                    if zname in room['zones']:
                        room['zones'][zname]['sensor_device_ids'].append(dev_id)
                # Primary zone = zone at the beam midpoint along the aim axis.
                # Used by Home Activity for "where is this sensor aimed?" —
                # fixes the edge-overlap bug where a cone touching many zones
                # falsely activates all of them when the sensor fires.
                primary_zone = None
                try:
                    params = p.get('params') or {}
                    legacy_len = params.get('beam_length_m')
                    legacy_len = float(legacy_len) if legacy_len is not None else None
                    def _len(k, fb):
                        v = params.get(k)
                        try:
                            return float(v) if v is not None else fb
                        except (TypeError, ValueError):
                            return fb
                    len_l = _len('beam_length_left_m',  legacy_len if legacy_len is not None else 4.0)
                    len_r = _len('beam_length_right_m', legacy_len if legacy_len is not None else 4.0)
                    # Halfway along the shorter radius — guaranteed inside both halves.
                    mid_dist = min(len_l, len_r) / 2.0
                    rot_rad = float(p.get('rotation') or 0) * math.pi / 180.0
                    mid_x = float(p['x']) + mid_dist * math.cos(rot_rad)
                    mid_y = float(p['y']) + mid_dist * math.sin(rot_rad)
                    primary_zone = resolve_zone(layout, mid_x, mid_y)
                except (KeyError, TypeError, ValueError):
                    pass
                # hold_s = sensor's hardware hold time in seconds (how long the
                # device keeps reporting "presence" after true absence). Stored
                # per-placement in room_device_placements.params. Consumed by
                # People Home to auto-size the post-door-close stabilize window.
                hold_s = 15
                try:
                    hold_raw = (p.get('params') or {}).get('hold_s')
                    if hold_raw is not None:
                        hold_s = max(0, int(hold_raw))
                except (TypeError, ValueError):
                    pass
                spatial['device_to_zones'][dev_id] = {
                    'room_slug': slug,
                    'zones': sorted(zones_covered),
                    'primary_zone': primary_zone,  # None if midpoint falls outside any named zone
                    'hold_s': hold_s,              # sensor hardware hold (seconds)
                }
            elif dtype == 'door_sensor':
                room['door_sensors'].append(dev_id)
                # Best-effort leads_to: if the placement's (x,y) lies on a door
                # with a leads_to, inherit its target. Otherwise None (exterior
                # door like Main Door, or a door not yet linked in the layout).
                leads_to = None
                try:
                    px, py = float(p['x']), float(p['y'])
                    for door in (layout.get('doors') or []):
                        if not door.get('leads_to'):
                            continue
                        # Door mid-point comes from its wall + offset — but we
                        # don't have walls resolved here. Approximate: if a
                        # leads_to door exists in this room and the placement
                        # shares its wall, inherit. One leads_to door per room
                        # keeps this simple.
                        leads_to = door['leads_to']
                        break
                except (KeyError, TypeError, ValueError):
                    pass
                spatial['door_sensor_to_adjacency'][dev_id] = {
                    'room_slug': slug,
                    'leads_to_slug': leads_to,
                    'name': p.get('device_name') or p.get('label') or dev_id,
                }
            elif dtype == 'light':
                # Resolve the light's (x,y) to a zone so future light-control
                # rules can do dict lookup instead of re-running geometry.
                try:
                    light_zone = resolve_zone(layout, float(p['x']), float(p['y']))
                except (KeyError, TypeError, ValueError):
                    light_zone = None
                room['lights'].append({
                    'id': dev_id,
                    'controller_device_id': (p.get('params') or {}).get('controller_device_id'),
                    'dps_key': (p.get('params') or {}).get('controller_dps_key'),
                    'zone': light_zone,  # zone name or None if not inside a named zone
                })

        # Pass 3 — sub-rooms: rooms table entries with no layout whose name
        # appears as a prefix in some other room's zone names. Heuristic but
        # covers the Kitchen / Dining Room cases well. Sub-rooms that don't
        # match any zone (e.g. Entrance, Corridor) simply stay empty and are
        # handled by the fallback room.devices grouping in the rules.
        layout_slugs = set(layouts.keys())
        for rname in rooms.keys():
            slug = rname.lower().replace(' ', '-')
            if slug in layout_slugs:
                continue  # has own layout → not a sub-room
            matching_zones = []
            parent_slug = None
            for pslug, pdata in spatial['rooms_by_slug'].items():
                for zname in pdata['zones'].keys():
                    if zname.lower().startswith(rname.lower() + ' ') or zname.lower() == rname.lower():
                        matching_zones.append(zname)
                        parent_slug = pslug
            if matching_zones and parent_slug:
                spatial['subrooms'][rname] = {
                    'parent_slug': parent_slug,
                    'zones': sorted(set(matching_zones)),
                }

        return spatial

    def load_shared_state(self):
        """Load dashboard-owned keys from DB into shared state.

        Only loads keys that the dashboard controls (_disabled_rules,
        _rule_overrides, _reload_request). Rule-computed keys are kept
        as-is in memory to avoid overwriting fresh values.
        """
        # Heartbeat-owned: runs on its own connection so it never blocks rule emissions.
        with self._hb_lock:
            self._ensure_hb_conn()
            try:
                with self._hb_conn.cursor(cursor_factory=RealDictCursor) as cur:
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
                self._hb_conn.rollback()

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
        """Persist shared state + timers to rule_engine_state table.

        Runs on the heartbeat-dedicated connection. Uses ONE batched
        `execute_values` multi-row upsert instead of ~167 sequential executes —
        measured ~9.3 ms -> ~1.0 ms (9x). This save is also called per-event from
        the engine's dispatch path when shared state changes (rule_engine.py
        ~L638) while holding the dispatch lock, so the batch shaves that hold to
        ~1 ms. (The old docstring's "200-300 ms" was wrong for this deployment —
        LXC-to-LXC DB RTT is ~0.03 ms, so 167 round-trips were only ~9 ms.)"""
        with self.lock:
            snapshot = copy.deepcopy(self.shared)
            timers = dict(self._timers)
        rows = []
        for key, value in snapshot.items():
            # Skip keys owned by other services / dashboard
            if (key.startswith('_pixoo_') or key in _DASHBOARD_KEYS
                    or key.startswith('_rule_override')):
                continue
            rows.append((key, json.dumps(value)))
        for name, ts in timers.items():
            rows.append((f'_timer:{name}', str(ts)))
        if not rows:
            return
        with self._hb_lock:
            self._ensure_hb_conn()
            try:
                with self._hb_conn.cursor() as cur:
                    execute_values(
                        cur,
                        "INSERT INTO rule_engine_state (key, value, updated_at) "
                        "VALUES %s "
                        "ON CONFLICT (key) DO UPDATE "
                        "SET value = EXCLUDED.value, updated_at = NOW()",
                        rows,
                        template="(%s, %s, NOW())",
                    )
                log.debug("Saved %d shared keys + %d timers (batched)",
                          len(snapshot), len(timers))
            except psycopg2.errors.UndefinedTable:
                log.warning("rule_engine_state table does not exist — cannot persist state")
                self._hb_conn.rollback()

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

            # Preserve existing DPS + dps_labels if we already track this device.
            # dps_labels comes from `devices.dps_labels` (loaded by load_from_db);
            # the inventory broadcast doesn't carry it, so we'd lose it on refresh
            # without this preserve step. Rules that map @dev chips to DPS keys
            # (mode_buttons, evening_lights) depend on it.
            existing_dps = {}
            existing_online = True
            existing_dps_labels = {}
            existing_dps_config = {}
            if dev_id in old_devices:
                existing_dps = old_devices[dev_id].get('dps', {})
                existing_online = old_devices[dev_id].get('online', True)
                existing_dps_labels = old_devices[dev_id].get('dps_labels', {})
                existing_dps_config = old_devices[dev_id].get('dps_config', {})

            new_devices[dev_id] = {
                'dps': existing_dps,
                'online': existing_online,
                'name': item.get('name', ''),
                'room': item.get('room', ''),
                'device_type': item.get('device_type', ''),
                'protocol': item.get('protocol', ''),
                'dps_labels': existing_dps_labels,
                'dps_config': existing_dps_config,
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
        """Execute a DB statement with thread-safe connection. Single retry on failure.
        Returns rowcount on success, -1 on complete failure.
        Warns on 0-row UPDATE/DELETE to catch silent data loss."""
        rowcount = -1
        with self._db_lock:
            self._ensure_conn()
            try:
                with self.conn.cursor() as cur:
                    cur.execute(sql, params or ())
                    rowcount = cur.rowcount
            except Exception:
                log.warning("db_execute failed, retrying after reconnect", exc_info=True)
                try:
                    self._connect_db()
                    with self.conn.cursor() as cur:
                        cur.execute(sql, params or ())
                        rowcount = cur.rowcount
                except Exception:
                    log.warning("db_execute retry also failed", exc_info=True)
                    return -1

        if rowcount == 0 and sql.strip()[:6].upper() in ('UPDATE', 'DELETE'):
            log.warning("db_execute: 0 rows affected — sql=%s params=%s", sql[:120], params)
        return rowcount

    def db_query(self, sql, params=None):
        """Execute a read-only SELECT with thread-safe connection. Single retry on failure.
        Returns list of row tuples, or [] on failure."""
        with self._db_lock:
            self._ensure_conn()
            try:
                with self.conn.cursor() as cur:
                    cur.execute(sql, params or ())
                    return cur.fetchall()
            except Exception:
                log.warning("db_query failed, retrying after reconnect", exc_info=True)
                try:
                    self._connect_db()
                    with self.conn.cursor() as cur:
                        cur.execute(sql, params or ())
                        return cur.fetchall()
                except Exception:
                    log.warning("db_query retry also failed", exc_info=True)
                    return []

    # ------------------------------------------------------------------
    # Historical state queries — for rules that need time-travel on device_events
    # ------------------------------------------------------------------

    def get_device_state_at(self, device_id, at_ts):
        """Return latest dps dict for device at or before at_ts, or None.
        Used by rules to query state at any historical moment."""
        rows = self.db_query(
            "SELECT dps FROM device_events WHERE device_id = %s AND ts <= %s "
            "ORDER BY ts DESC LIMIT 1",
            (device_id, at_ts),
        )
        if not rows:
            return None
        dps = rows[0][0]
        if isinstance(dps, str):
            try:
                dps = json.loads(dps)
            except Exception:
                return None
        return dps if isinstance(dps, dict) else None

    def get_last_transition_before(self, device_id, dps_key, at_ts, lookback=500):
        """Return (ts, prev_value, new_value) of the most recent change of dps[dps_key]
        for device before at_ts. Returns None if no transition found in lookback rows."""
        rows = self.db_query(
            "SELECT ts, dps FROM device_events WHERE device_id = %s AND ts <= %s "
            "ORDER BY ts DESC LIMIT %s",
            (device_id, at_ts, lookback),
        )
        if not rows:
            return None

        # Walk rows newest→oldest; find the first pair where dps[dps_key] differs
        prev_value = None
        prev_ts = None
        key = str(dps_key)
        for ts, dps in rows:
            if isinstance(dps, str):
                try:
                    dps = json.loads(dps)
                except Exception:
                    continue
            if not isinstance(dps, dict):
                continue
            value = dps.get(key)
            if prev_value is None and value is not None:
                prev_value = value
                prev_ts = ts
                continue
            if value is not None and value != prev_value:
                # Transition: old row value -> newer row value (prev_value)
                return (prev_ts, value, prev_value)
        return None

    def get_events_between(self, device_ids, from_ts, to_ts):
        """Return raw events for any list of device_ids in a time range.
        Returns list of (ts, device_id, dps) tuples, ordered ascending by ts."""
        if not device_ids:
            return []
        rows = self.db_query(
            "SELECT ts, device_id, dps FROM device_events "
            "WHERE device_id = ANY(%s) AND ts >= %s AND ts <= %s "
            "ORDER BY ts ASC",
            (list(device_ids), from_ts, to_ts),
        )
        result = []
        for ts, dev_id, dps in rows:
            if isinstance(dps, str):
                try:
                    dps = json.loads(dps)
                except Exception:
                    dps = {}
            result.append((ts, dev_id, dps if isinstance(dps, dict) else {}))
        return result

    # ------------------------------------------------------------------
    # Virtual device emission — for rules that produce derived state
    # ------------------------------------------------------------------

    def emit_virtual_event(self, virtual_id, dps, source, name=None, dps_labels=None):
        """Emit a virtual device event to device_events (only when dps changed vs last emission).
        Also registers the virtual device in the devices table on first emission.

        virtual_id: must start with 'virtual:' prefix
        dps: dict of current derived state values
        source: e.g. 'rule:Home Activity'
        name: friendly name for devices table registration (first time only)
        dps_labels: optional dict {key: label} for dashboard rendering
        """
        if not virtual_id.startswith('virtual:'):
            log.warning("emit_virtual_event: device_id must start with 'virtual:' — got %s", virtual_id)
            return

        # Dedupe: fetch last emission for this virtual device
        last_rows = self.db_query(
            "SELECT dps FROM device_events WHERE device_id = %s ORDER BY ts DESC LIMIT 1",
            (virtual_id,),
        )
        last_dps = None
        if last_rows:
            last_dps = last_rows[0][0]
            if isinstance(last_dps, str):
                try:
                    last_dps = json.loads(last_dps)
                except Exception:
                    last_dps = None

        # Emit only if changed (or first time)
        if last_dps == dps:
            return

        # Ensure registered in devices table (idempotent)
        self.db_execute(
            "INSERT INTO devices (id, name, device_type, protocol, enabled, dps_labels, created_at, updated_at) "
            "VALUES (%s, %s, 'virtual', 'virtual', true, %s, NOW(), NOW()) "
            "ON CONFLICT (id) DO NOTHING",
            (virtual_id, name or virtual_id, json.dumps(dps_labels or {})),
        )

        # Insert event row
        self.db_execute(
            "INSERT INTO device_events (device_id, ts, dps, source) "
            "VALUES (%s, NOW(), %s, %s)",
            (virtual_id, json.dumps(dps), source),
        )
