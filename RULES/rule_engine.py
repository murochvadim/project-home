#!/usr/bin/env python3
"""
Rule Engine — main event loop for the home automation rule system.

Subscribes to MQTT topics, maintains device state via StateManager,
evaluates matching rules on each event, and dispatches commands.

Runs on LXC 105 (Main Agent / Orchestrator).
"""

import copy
import importlib.util
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from datetime import datetime, timedelta

import psycopg2

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from backports.zoneinfo import ZoneInfo

from mqtt_client import MqttClient
from state_manager import DB_CONFIG, StateManager

TZ = ZoneInfo('Asia/Jerusalem')

# ======================================================================
# Rule-knob sentence parser
# ----------------------------------------------------------------------
# Rules keep their logic shape in Python but expose tunable constants as
# `state.shared.get('<key>', <default>)`. Every 60s the heartbeat calls
# _parse_rule_knobs() which rescans `dashboard_settings.apartment.rule_sentences`,
# matches each sentence against a pattern below, and pushes the parsed
# numeric value (normalised to the target unit) into state.shared.
#
# User-facing: they can write sentences like
#   "Home Activity: hold a room active for 15 seconds"
#   "Home Activity: hold a room active for 0.5 minutes"   (same knob, different unit)
# Both resolve to `home_activity.hold_off_sec = 15` (or 30).
#
# Each entry: (compiled regex, state.shared key, target_unit)
#   regex: group(1)=number, group(2)=unit word (optional; missing → 'count')
#   target_unit: 'sec' | 'min' | 'count' — what the rule reads as
#
# To add a new knob: append to KNOB_PATTERNS + read the same key in the
# rule's evaluate(). Nothing else to change.
# ======================================================================

_NUM_UNIT = r'(\d+(?:\.\d+)?)\s*(second|minute|hour|sec|min|hr|s|m|h)s?'

KNOB_PATTERNS = [
    # Home Activity knobs
    (re.compile(r'home activity:.*hold.*?' + _NUM_UNIT, re.I),
     'home_activity.hold_off_sec', 'sec'),
    (re.compile(r'home activity:.*active.*?' + _NUM_UNIT + r'.*switch', re.I),
     'home_activity.interact_window_sec', 'sec'),
    (re.compile(r"home activity:.*low.*?1\s*(?:to|-)?\s*(\d+)\s*room", re.I),
     'home_activity.level_low_max', 'count'),
    # People Home knobs
    (re.compile(r'people home:.*two rooms.*?' + _NUM_UNIT + r'.*same person', re.I),
     'people_home.corridor_sec', 'sec'),
    (re.compile(r'people home:.*adjacent rooms.*?' + _NUM_UNIT, re.I),
     'people_home.adjacency_dedupe_sec', 'sec'),
    (re.compile(r'people home:.*away.*?' + _NUM_UNIT + r'.*no motion', re.I),
     'people_home.away_after_no_motion_min', 'min'),
    (re.compile(r'people home:.*door.*?presence.*?' + _NUM_UNIT + r'.*entry', re.I),
     'people_home.door_transit_window_sec', 'sec'),
    (re.compile(r'people home:.*door.*?no motion.*?' + _NUM_UNIT + r'.*exit', re.I),
     'people_home.exit_quiet_window_sec', 'sec'),
    # People Home — inferred transit + Main Door recount knobs
    (re.compile(r'people home:.*transit.*?sequence.*?' + _NUM_UNIT, re.I),
     'people_home.transit_sequence_window_sec', 'sec'),
    (re.compile(r'people home:.*recount.*?' + _NUM_UNIT + r'.*main door', re.I),
     'people_home.door_close_stabilize_sec', 'sec'),
    # Mode Buttons knob
    (re.compile(r'mode buttons:.*default.*?cooldown.*?' + _NUM_UNIT, re.I),
     'mode_buttons.default_home_cooldown_sec', 'sec'),
]

_UNIT_TO_SEC = {
    'second': 1, 'sec': 1, 's': 1,
    'minute': 60, 'min': 60, 'm': 60,
    'hour': 3600, 'hr': 3600, 'h': 3600,
}


def _flatten_sentence(s):
    """Turn a sentence record into plain text — prefers `segments`, falls back to `text`."""
    segs = s.get('segments')
    if isinstance(segs, list) and segs:
        return ''.join((seg or {}).get('v', '') for seg in segs).strip()
    return (s.get('text') or '').strip()


def _parse_knob_sentences(containers):
    """Scan the apartment rule_sentences array. Returns dict of {state_key: int_value}."""
    knobs = {}
    for container in (containers or []):
        if container.get('active') is False:
            continue
        for s in (container.get('sentences') or []):
            if s.get('active') is False:
                continue
            text = _flatten_sentence(s)
            if not text:
                continue
            for regex, key, target_unit in KNOB_PATTERNS:
                m = regex.search(text)
                if not m:
                    continue
                try:
                    n = float(m.group(1))
                except (TypeError, ValueError):
                    break
                if target_unit == 'count':
                    knobs[key] = int(n)
                else:
                    unit_word = ''
                    try:
                        unit_word = (m.group(2) or '').lower()
                    except (IndexError, AttributeError):
                        pass
                    sec_per_unit = _UNIT_TO_SEC.get(unit_word, 1)
                    seconds = n * sec_per_unit
                    if target_unit == 'sec':
                        knobs[key] = int(round(seconds))
                    elif target_unit == 'min':
                        knobs[key] = int(round(seconds / 60))
                break  # first match wins; skip remaining patterns for this sentence
    return knobs

log = logging.getLogger('rule_engine')
logging.basicConfig(
    level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
    format='%(asctime)s  %(name)-22s  %(levelname)-7s  %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)


class RuleEngine:
    """Load rules, subscribe to MQTT, evaluate on events, dispatch commands."""

    def __init__(self):
        self.mqtt = MqttClient()
        self.state = StateManager(DB_CONFIG)

        self.rules = []                 # list of loaded rule modules
        self.trigger_index = {}         # device_id -> [rule_module, ...]
        self._disabled_rules = set()    # set of rule names
        self._command_log = {}          # device_id -> [(ts, action), ...]
        self._command_log_lock = threading.Lock()  # guards _command_log read + list-slice-assignment (paho thread races)
        # Serializes rule-firing, disable/enable commands, hot-reload, and test
        # runs across the paho callback thread and the heartbeat thread. RLock
        # (reentrant) so a nested acquire from the same thread is safe — cheap
        # insurance against future refactors.
        self._dispatch_lock = threading.RLock()
        self._rule_stats = {}           # rule_name -> {count, total_ms, max_ms, last_fired}
        self._group_active = {}         # group_name -> {rule, action, ts} (per event cycle)
        self._rule_originals = {}       # rule_name -> {priority, group, conditions} from file
        self._rule_errors = {}          # rule_name -> consecutive error count
        self._rule_load_errors = {}     # filename -> error message (for invalid rule files)
        self._sorted_rules = []         # global DAG-sorted order (computed at load time)
        self._save_failures = 0         # consecutive save_shared_state failures
        self._stop = threading.Event()
        self._last_computed_publish = 0

    # ------------------------------------------------------------------
    # Rule loading
    # ------------------------------------------------------------------

    def load_rules(self):
        """Scan RULES/rules/*.py, validate, and register rule modules."""
        rules_dir = os.path.join(os.path.dirname(__file__), 'rules')
        if not os.path.isdir(rules_dir):
            log.warning('Rules directory not found: %s', rules_dir)
            return

        required_keys = {'name', 'description', 'triggers', 'controls', 'category'}
        self._rule_load_errors = {}  # reset on every load

        for filename in sorted(os.listdir(rules_dir)):
            if not filename.endswith('.py') or filename.startswith('_'):
                continue

            filepath = os.path.join(rules_dir, filename)
            module_name = f'rules.{filename[:-3]}'

            try:
                spec = importlib.util.spec_from_file_location(module_name, filepath)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            except Exception as e:
                msg = f'import failed: {type(e).__name__}: {e}'
                log.error('Failed to import rule %s: %s', filename, msg, exc_info=True)
                self._rule_load_errors[filename] = msg
                self._raise_load_error_alert(filename, msg)
                continue

            # Validate RULE dict
            rule_dict = getattr(module, 'RULE', None)
            if not isinstance(rule_dict, dict):
                msg = 'missing RULE dict'
                log.warning('Rule %s %s — skipped', filename, msg)
                self._rule_load_errors[filename] = msg
                self._raise_load_error_alert(filename, msg)
                continue

            missing = required_keys - set(rule_dict.keys())
            if missing:
                msg = f'RULE dict missing keys {sorted(missing)}'
                log.warning('Rule %s %s — skipped', filename, msg)
                self._rule_load_errors[filename] = msg
                self._raise_load_error_alert(filename, msg)
                continue

            if not callable(getattr(module, 'evaluate', None)):
                msg = 'missing evaluate() callable'
                log.warning('Rule %s %s — skipped', filename, msg)
                self._rule_load_errors[filename] = msg
                self._raise_load_error_alert(filename, msg)
                continue

            # Assign rule ID and parse optional fields with defaults
            rule_dict.setdefault('id', len(self.rules) + 1)
            rule_dict.setdefault('group', None)
            rule_dict.setdefault('priority', 10)
            rule_dict.setdefault('depends_on', [])
            rule_dict.setdefault('conditions', {})

            # Store original values before any overrides
            self._rule_originals[rule_dict['name']] = {
                'priority': rule_dict.get('priority', 10),
                'group': rule_dict.get('group'),
                'conditions': copy.deepcopy(rule_dict.get('conditions', {})),
            }

            self.rules.append(module)

        # Load disabled list from shared state
        disabled_raw = self.state.shared.get('_disabled_rules', [])
        if isinstance(disabled_raw, str):
            try:
                disabled_raw = json.loads(disabled_raw)
            except (json.JSONDecodeError, TypeError):
                disabled_raw = []
        self._disabled_rules = set(disabled_raw)

        # Apply DB overrides (priority, conditions, group — set from dashboard)
        self._apply_overrides()

        # Build global dependency-sorted order once. Per-event dispatch filters
        # from this list so depends_on is honored even across rule subsets.
        self._sorted_rules = self._sort_rules(self.rules)

        # Expose load errors for dashboard
        self.state.shared['_rule_load_errors'] = self._rule_load_errors

        # Store rules metadata in shared state for dashboard
        self._update_rules_metadata()

        log.info('Loaded %d rules (%d disabled, %d load errors)',
                 len(self.rules), len(self._disabled_rules), len(self._rule_load_errors))

    def _raise_load_error_alert(self, filename, msg):
        """Write a system_alerts row for a rule file that failed to load."""
        try:
            self.state.db_execute(
                "INSERT INTO system_alerts (ts, severity, alert_type, affected_agent, message) "
                "VALUES (NOW(), 'error', 'rule_load_error', 'rule_engine', %s)",
                (f"Rule file {filename}: {msg[:200]}",),
            )
        except Exception:
            log.warning('Failed to write rule_load_error alert', exc_info=True)

    def _index_rules(self):
        """Build trigger_index mapping device_id -> [rule_module, ...]."""
        self.trigger_index = {}
        for module in self.rules:
            for device_id in module.RULE.get('triggers', []):
                self.trigger_index.setdefault(device_id, []).append(module)

    def _update_rules_metadata(self):
        """Store rules metadata + execution stats in shared state for dashboard."""
        self.state.shared['_rules'] = [
            {
                'id': m.RULE.get('id', i + 1),
                'name': m.RULE['name'],
                'description': m.RULE.get('description', ''),
                'category': m.RULE.get('category', ''),
                'group': m.RULE.get('group'),
                'priority': m.RULE.get('priority', 10),
                'depends_on': m.RULE.get('depends_on', []),
                'conditions': m.RULE.get('conditions', {}),
                'triggers': len(m.RULE.get('triggers', [])),
                'controls': len(m.RULE.get('controls', [])),
                'stats': self._rule_stats.get(m.RULE['name'], {}),
                'errors': self._rule_errors.get(m.RULE['name'], 0),
            }
            for i, m in enumerate(self.rules)
        ]

    def _apply_overrides(self):
        """Apply DB overrides (from dashboard) to rule RULE dicts.

        Overrides stored in shared state as _rule_overrides: {rule_name: {field: value}}
        Overridable fields: priority, group, conditions
        Always applies from file-original base to prevent accumulation.
        """
        overrides_raw = copy.deepcopy(self.state.shared.get('_rule_overrides', {}))
        if isinstance(overrides_raw, str):
            try:
                overrides_raw = json.loads(overrides_raw)
            except (json.JSONDecodeError, TypeError):
                overrides_raw = {}
        if not isinstance(overrides_raw, dict):
            return

        for module in self.rules:
            name = module.RULE['name']
            orig = self._rule_originals.get(name, {})

            # Restore file originals first (prevents accumulation)
            module.RULE['priority'] = orig.get('priority', 10)
            module.RULE['group'] = orig.get('group')
            module.RULE['conditions'] = copy.deepcopy(orig.get('conditions', {}))

            # Apply DB overrides on top
            ovr = overrides_raw.get(name, {})
            if not ovr:
                continue
            if 'priority' in ovr:
                try:
                    module.RULE['priority'] = int(ovr['priority'])
                except (ValueError, TypeError):
                    pass
            if 'group' in ovr:
                module.RULE['group'] = ovr['group'] or None
            if 'conditions' in ovr and isinstance(ovr['conditions'], dict):
                file_conds = module.RULE['conditions']
                for ck, cv in ovr['conditions'].items():
                    if cv is None:
                        file_conds.pop(ck, None)
                    else:
                        file_conds[ck] = cv

        if overrides_raw:
            log.info('Applied DB overrides for %d rules', len(overrides_raw))

    # ------------------------------------------------------------------
    # MQTT event callback (runs in paho network thread — must be fast)
    # ------------------------------------------------------------------

    def on_mqtt_event(self, client, userdata, msg):
        """Route incoming MQTT message: update state, evaluate rules, dispatch commands."""
        try:
            parts = msg.topic.split('/')
            payload = self._parse_payload(msg.payload)
        except Exception:
            log.debug('Failed to parse MQTT message on %s', msg.topic, exc_info=True)
            return

        # ---- State-only updates (no rule evaluation) ----

        # mur/home/device/+/state
        if (len(parts) == 5 and parts[:3] == ['mur', 'home', 'device']
                and parts[4] == 'state'):
            device_id = parts[3]
            dps = payload.get('dps', payload)
            self.state.update_device(device_id, dps, source='state')
            return

        # mur/home/device/+/availability
        if (len(parts) == 5 and parts[:3] == ['mur', 'home', 'device']
                and parts[4] == 'availability'):
            device_id = parts[3]
            online = payload.get('online', True)
            self.state.update_availability(device_id, online)
            return

        # mur/home/device/_bridge/devices
        if parts == ['mur', 'home', 'device', '_bridge', 'devices']:
            if isinstance(payload, list):
                self.state.update_inventory(payload)
                self._rebuild_name_index()
            return

        # mur/home/device/+/command/response — just log
        if (len(parts) == 6 and parts[:3] == ['mur', 'home', 'device']
                and parts[4] == 'command' and parts[5] == 'response'):
            log.debug('Command response for %s: %s', parts[3], payload)
            return

        # ---- Control topics ----

        # mur/home/rule-engine/disable/+
        if (len(parts) == 5 and parts[:3] == ['mur', 'home', 'rule-engine']
                and parts[3] == 'disable'):
            self._disable_rule(parts[4])
            return

        # mur/home/rule-engine/enable/+
        if (len(parts) == 5 and parts[:3] == ['mur', 'home', 'rule-engine']
                and parts[3] == 'enable'):
            self._enable_rule(parts[4])
            return

        # mur/home/rule-engine/reload
        if parts == ['mur', 'home', 'rule-engine', 'reload']:
            self._reload_rules()
            return

        # mur/home/rule-engine/test
        if parts == ['mur', 'home', 'rule-engine', 'test']:
            self._test_rule(payload)
            return

        # mur/home/esp/<id>/{availability,schema,status,event} — ESP boards subsystem
        # Phase 5 (2026-05-02): rule engine is sole writer of esp_boards.last_*
        # columns. Dashboard owns config CRUD; this is read-only ingest.
        if (len(parts) == 5 and parts[:3] == ['mur', 'home', 'esp']):
            self._handle_esp_message(parts[3], parts[4], msg.payload, payload)
            return

        # ---- Event topics (update state AND trigger rules) ----

        device_id = None
        dps = {}
        source = ''

        # mur/home/device/+/event
        if (len(parts) == 5 and parts[:3] == ['mur', 'home', 'device']
                and parts[4] == 'event'):
            device_id = parts[3]
            dps = payload.get('dps', payload)
            source = 'event'

        # hasp/+/state
        elif len(parts) == 3 and parts[0] == 'hasp' and parts[2] == 'state':
            node = parts[1]
            device_id = self._lookup_device_by_name(node)
            dps = payload
            source = 'hasp'

        # hasp/+/state/+
        elif len(parts) == 4 and parts[0] == 'hasp' and parts[2] == 'state':
            node = parts[1]
            obj = parts[3]
            # Button widgets (p<page>b<id>): synthesize device_id "hasp:<plate>:<obj>"
            # so rules can target panel widgets directly without registering the panel
            # as a "device". Payload is {event: 'short'|'long'|'down'|'up'|'double', ...}.
            if re.match(r'^p\d+b\d+$', obj):
                device_id = f'hasp:{node}:{obj}'
                dps = payload if isinstance(payload, dict) else {'val': payload}
                source = 'hasp_button'
            else:
                device_id = self._lookup_device_by_name(node)
                dps = {obj: payload} if not isinstance(payload, dict) else payload
                source = 'hasp'

        # zigbee2mqtt/+ (skip "bridge")
        elif len(parts) == 2 and parts[0] == 'zigbee2mqtt':
            name = parts[1]
            if name == 'bridge':
                return
            device_id = self._lookup_device_by_name(name)
            dps = payload
            source = 'zigbee'

        # awtrix/+/stats
        elif len(parts) == 3 and parts[0] == 'awtrix' and parts[2] == 'stats':
            name = parts[1]
            device_id = self._lookup_device_by_name(name)
            dps = payload
            source = 'awtrix'

        else:
            return  # unrecognized topic

        if not device_id:
            return

        # Update state
        if isinstance(dps, dict):
            self.state.update_device(device_id, dps, source=source)

        event = {
            'device_id': device_id,
            'dps': dps if isinstance(dps, dict) else {},
            'source': source,
            'ts': datetime.now(tz=TZ).isoformat(),
        }
        self._fire_rules_for_event(event)

    def _fire_rules_for_event(self, event):
        """Dispatch an event (real MQTT or synthetic tick) to all matching rules.

        Called from the paho callback thread via on_mqtt_event(), and from the
        heartbeat thread for synthetic ``heartbeat`` ticks. The dispatch_lock
        serializes the two so rule evaluation, group-active tracking, and
        shared-state mutations stay consistent."""
        with self._dispatch_lock:
            device_id = event['device_id']
            source = event.get('source', '')

            # Find matching rules (device-specific + wildcard)
            matching_set = set(self.trigger_index.get(device_id, []) + self.trigger_index.get('*', []))

            shared_before = self.state.shared.copy()

            # Clear group-active tracking for this event cycle
            self._group_active.clear()

            # Filter from pre-sorted global list so depends_on is respected even
            # across rule subsets (a rule may depend on a rule that isn't triggered
            # by this event — the dependency order from load time still applies).
            sorted_matching = [r for r in self._sorted_rules if r in matching_set]

            for rule in sorted_matching:
                rule_name = rule.RULE['name']
                if rule_name in self._disabled_rules:
                    continue

                # Check conditions (time, state)
                ok, reason = self._check_conditions(rule)
                if not ok:
                    log.debug("Rule '%s' skipped: %s", rule_name, reason)
                    continue

                # Check group conflict — skip if higher priority rule in same group already acted
                group = rule.RULE.get('group')
                if group and group in self._group_active:
                    active = self._group_active[group]
                    log.debug("Rule '%s' skipped: group '%s' already served by '%s'",
                              rule_name, group, active['rule'])
                    continue

                rule_shared_before = self.state.shared.copy()

                commands = self._evaluate_rule(rule, event)
                for cmd in commands:
                    self._dispatch_command(cmd, rule_name)

                # Detect what changed
                elapsed = self._rule_stats.get(rule_name, {}).get('_last_ms', 0)
                changed_keys = [k for k in self.state.shared
                               if self.state.shared.get(k) != rule_shared_before.get(k)
                               and not k.startswith('_')]

                if commands:
                    result = '; '.join(f'cmd:{c.get("action","?")}:{c.get("preset_name", c.get("device_id",""))}' for c in commands)
                    self._log_rule_event(rule_name, device_id, source, 'command', result, elapsed)
                    if group:
                        self._group_active[group] = {
                            'rule': rule_name,
                            'action': commands[0].get('action', ''),
                            'ts': time.time(),
                        }
                    stats = self._rule_stats.get(rule_name, {'count': 0, 'total_ms': 0, 'max_ms': 0})
                    stats['last_fired'] = datetime.now(tz=TZ).isoformat()
                    self._rule_stats[rule_name] = stats
                elif changed_keys:
                    result = '; '.join(f'{k}={self.state.shared[k]}' for k in changed_keys[:5])
                    self._log_rule_event(rule_name, device_id, source, 'state_changed', result, elapsed)
                    stats = self._rule_stats.get(rule_name, {'count': 0, 'total_ms': 0, 'max_ms': 0})
                    stats['last_fired'] = datetime.now(tz=TZ).isoformat()
                    self._rule_stats[rule_name] = stats

            self._maybe_publish_computed()

            # Immediate DB save if shared state changed (responsive presence updates)
            if self.state.shared != shared_before:
                self._save_state_tracked()

    def _save_state_tracked(self):
        """Wrap save_shared_state with consecutive-failure tracking + alerting."""
        try:
            self.state.save_shared_state()
            if self._save_failures:
                log.info('save_shared_state recovered after %d failures', self._save_failures)
            self._save_failures = 0
        except Exception as e:
            self._save_failures += 1
            log.warning('save_shared_state failed (%d consecutive): %s',
                        self._save_failures, e, exc_info=True)
            if self._save_failures == 5:
                try:
                    self.state.db_execute(
                        "INSERT INTO system_alerts (ts, severity, alert_type, affected_agent, message) "
                        "VALUES (NOW(), 'error', 'rule_engine_state_save_failed', 'rule_engine', %s)",
                        (f"save_shared_state failed 5 consecutive times — shared state may be stale. Last error: {str(e)[:200]}",),
                    )
                except Exception:
                    log.error('Failed to raise save-failure alert', exc_info=True)

    # ------------------------------------------------------------------
    # Rule event logging
    # ------------------------------------------------------------------

    def _log_rule_event(self, rule_name, device_id, source, event_type, result, duration_ms):
        """Log a meaningful rule event to DB (state change or command only)."""
        self.state.db_execute(
            "INSERT INTO rule_events (rule_name, device_id, source, event_type, result, duration_ms) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (rule_name, device_id, source, event_type, str(result)[:500], duration_ms),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_payload(raw):
        """Parse MQTT payload bytes to dict/list/str."""
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            return {}

    def _rebuild_name_index(self):
        """Build name→device_id lookup for fast name-based queries."""
        self._name_to_id = {dev.get('name', ''): did for did, dev in self.state.devices.items()}

    def _lookup_device_by_name(self, name):
        """Find device_id by device name. Returns None if not found."""
        if not hasattr(self, '_name_to_id'):
            self._rebuild_name_index()
        dev_id = self._name_to_id.get(name)
        if dev_id is None:
            log.debug('Device lookup failed for name=%s', name)
        return dev_id

    # ------------------------------------------------------------------
    # ESP boards ingest (mur/home/esp/<id>/{availability,schema,status,event})
    # ------------------------------------------------------------------

    _ESP_ID_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9_-]*$')

    def _esp_known_ids(self, refresh=False):
        """Cached set of esp_boards.id. Refreshes lazily — on first access AND
        when an UPDATE misses (so a freshly INSERTed row is picked up without
        an engine reload). Avoids db_execute warnings for unknown board ids
        (e.g. messages arriving before the operator has INSERTed the row)."""
        if refresh or not hasattr(self, '_esp_ids_cache'):
            try:
                rows = self.state.db_query('SELECT id FROM esp_boards')
                self._esp_ids_cache = {r[0] for r in (rows or [])}
            except Exception:
                log.warning('ESP boards id cache refresh failed', exc_info=True)
                if not hasattr(self, '_esp_ids_cache'):
                    self._esp_ids_cache = set()
        return self._esp_ids_cache

    @staticmethod
    def _parse_esp_build_ts(raw):
        """Parse C __DATE__ " " __TIME__ output (e.g. 'May  2 2026 14:30:00')
        into ISO. Returns None if input is missing or malformed."""
        if not raw or not isinstance(raw, str):
            return None
        try:
            return datetime.strptime(' '.join(raw.split()), '%b %d %Y %H:%M:%S').isoformat()
        except (ValueError, TypeError):
            return None

    def _handle_esp_message(self, board_id, suffix, raw_payload, parsed_payload):
        """Route an ESP topic message to the right esp_boards UPDATE."""
        if not self._ESP_ID_RE.match(board_id or ''):
            return
        if board_id not in self._esp_known_ids():
            self._esp_known_ids(refresh=True)
            if board_id not in self._esp_known_ids():
                log.debug('ESP message for unknown board %s/%s — ignoring', board_id, suffix)
                return

        if suffix == 'availability':
            try:
                text = (raw_payload or b'').decode('utf-8', errors='replace').strip()
            except Exception:
                text = ''
            if text == 'online':
                self.state.db_execute(
                    'UPDATE esp_boards SET last_seen = NOW() WHERE id = %s',
                    (board_id,)
                )
            elif text == 'offline':
                # LWT fired — broker detected board disconnect (~22 s after
                # power loss with default 15 s keepalive). Backdate last_seen
                # to push isOnline() in the dashboard past its 180 s threshold
                # immediately, instead of waiting 3 missed heartbeats. The
                # value still represents "last time we believed the board
                # was online" — semantically correct.
                self.state.db_execute(
                    "UPDATE esp_boards SET last_seen = NOW() - interval '1 hour' WHERE id = %s",
                    (board_id,)
                )
            return

        if suffix == 'status':
            if not isinstance(parsed_payload, dict):
                return
            self.state.db_execute(
                """UPDATE esp_boards SET
                       last_status    = %s::jsonb,
                       last_seen      = NOW(),
                       ip             = COALESCE(%s::inet, ip),
                       sketch_name    = COALESCE(%s, sketch_name),
                       sketch_version = COALESCE(%s, sketch_version),
                       build_ts       = COALESCE(%s::timestamptz, build_ts)
                   WHERE id = %s""",
                (
                    json.dumps(parsed_payload),
                    parsed_payload.get('ip'),
                    parsed_payload.get('sketch_name'),
                    parsed_payload.get('sketch_version'),
                    self._parse_esp_build_ts(parsed_payload.get('build_ts')),
                    board_id,
                )
            )
            # Also project a subset of status fields into devices.last_state.dps
            # so rules + the device picker treat ESP boards like any other
            # device (state.devices[id].dps['pump_state'] etc.). Only the
            # fields a board actually publishes get mapped — the dashboard's
            # dps_labels column controls which ones are user-visible.
            projected_dps = self._update_esp_device_dps(board_id, parsed_payload)
            # Fire a synthetic device event so downstream rules (e.g.
            # gates_button_progress mirroring barrier_progress onto a HASP
            # button) can react to ESP status updates the same way they
            # react to Tuya/Zigbee/HA events. Without this, rules with
            # `triggers=[<board_id>]` never fire because /status messages
            # only update DB + in-memory dps and don't reach the rule
            # firing pipeline. Skip when no fields were projected (no
            # rule could care about an empty payload anyway).
            if projected_dps:
                self._fire_rules_for_event({
                    'device_id': board_id,
                    'dps':       projected_dps,
                    'source':    'esp_status',
                    'ts':        datetime.now(tz=TZ).isoformat(),
                })
            return

        if suffix == 'schema':
            if not isinstance(parsed_payload, dict):
                return
            self.state.db_execute(
                'UPDATE esp_boards SET board_schema = %s::jsonb WHERE id = %s',
                (json.dumps(parsed_payload), board_id)
            )
            return

        if suffix == 'event':
            # Acks + ad-hoc events. Dashboard Test sub-tab (Phase 4) consumes
            # acks via direct browser-MQTT subscribe; rule engine doesn't
            # persist them (would need rate limiting and they'd dilute the
            # device_events table).
            log.debug('ESP event from %s: %s', board_id, parsed_payload)
            return

        log.debug('ESP message: unknown suffix %s for board %s', suffix, board_id)

    # Status fields lifted from any ESP board's `mur/home/esp/<id>/status`
    # payload into devices.last_state.dps. Each board only publishes the
    # subset relevant to its hardware — the field is projected only when
    # present, so the smell board contributes pump_state + auto_enabled
    # while RemoteXY contributes door_relay + charge_relay. New boards add
    # a new key here when they want a status field rule-addressable.
    _ESP_STATUS_DPS_FIELDS = (
        # smell board
        'pump_state', 'auto_enabled', 'auto_phase', 'manual_active',
        # remoteXY gate
        'door_relay', 'charge_relay',
        # jura coffee bridge
        'power_state', 'current_drink',
        'water_low', 'beans_low', 'grounds_full',
        'cleaning_required', 'descale_required',
        'total_dispensed', 'espressos_today',
        # home gates (gates_01) — live progress for HASP/Awtrix/Pixoo display
        'gates_state', 'barrier_progress', 'gates_progress',
    )

    def _update_esp_device_dps(self, board_id, status_payload):
        """Project ESP status fields into devices.last_state for rule/dashboard use.

        Convention across this project: devices.last_state holds the dps
        dict directly with flat keys (matches Tuya/Zigbee/HASP rows already
        written by device_agent). Same shape that state_manager loads into
        state.devices[id]['dps'] — so a rule reads `dev['dps']['pump_state']`
        and the Devices page reads `last_state.pump_state`.
        """
        dps = {k: status_payload[k] for k in self._ESP_STATUS_DPS_FIELDS if k in status_payload}
        if not dps:
            return {}
        # JSONB || JSONB merges right onto left (right wins on key collision)
        # so concurrent writes from other paths aren't clobbered.
        rowcount = self.state.db_execute(
            """UPDATE devices SET
                   last_state  = COALESCE(last_state, '{}'::jsonb) || %s::jsonb,
                   last_seen   = NOW(),
                   last_source = 'esp_status'
               WHERE id = %s""",
            (json.dumps(dps), board_id),
        )
        if rowcount:
            # Mirror into the in-memory state.devices map so currently-firing
            # rules see the new dps without waiting for the next load_from_db.
            dev = self.state.devices.get(board_id)
            if dev is not None:
                dev_dps = dev.setdefault('dps', {})
                dev_dps.update(dps)
        return dps

    # ------------------------------------------------------------------
    # Rule evaluation
    # ------------------------------------------------------------------

    def _check_conditions(self, rule):
        """Check if rule conditions are met. Returns (ok, reason)."""
        conditions = rule.RULE.get('conditions', {})
        if not conditions:
            return True, ''

        # Time condition
        time_cond = conditions.get('time')
        if time_cond:
            now = datetime.now(tz=TZ)
            now_str = now.strftime('%H:%M')
            after = time_cond.get('after', '00:00')
            before = time_cond.get('before', '23:59')
            if after <= before:
                if not (after <= now_str <= before):
                    return False, f'time {now_str} outside {after}-{before}'
            else:  # wraps midnight (e.g., 22:00-06:00)
                if not (now_str >= after or now_str <= before):
                    return False, f'time {now_str} outside {after}-{before}'

        # State condition
        state_cond = conditions.get('state')
        if state_cond:
            for key, expected in state_cond.items():
                actual = self.state.shared.get(key)
                if isinstance(expected, list):
                    if actual not in expected:
                        return False, f'state {key}={actual} not in {expected}'
                elif actual != expected:
                    return False, f'state {key}={actual} != {expected}'

        return True, ''

    def _sort_rules(self, rules):
        """Sort rules by depends_on (topological) then priority (lower first).
        Detects cycles and breaks them with a warning."""
        name_to_rule = {r.RULE['name']: r for r in rules}
        sorted_rules = []
        visited = set()
        visiting = set()  # gray set for cycle detection

        def visit(rule):
            name = rule.RULE['name']
            if name in visited:
                return
            if name in visiting:
                log.warning("Dependency cycle detected at rule '%s' — breaking cycle", name)
                return
            visiting.add(name)
            for dep_name in rule.RULE.get('depends_on', []):
                dep = name_to_rule.get(dep_name)
                if dep and dep in rules:
                    visit(dep)
            visiting.discard(name)
            visited.add(name)
            sorted_rules.append(rule)

        for r in sorted(rules, key=lambda r: r.RULE.get('priority', 10)):
            visit(r)

        return sorted_rules

    _MAX_CONSECUTIVE_ERRORS = 3

    def _evaluate_rule(self, rule, event):
        """Call rule.evaluate() safely, return list of command dicts.
        Auto-disables rule after _MAX_CONSECUTIVE_ERRORS consecutive failures."""
        name = rule.RULE['name']
        t0 = time.time()
        try:
            result = rule.evaluate(event, self.state)
        except Exception as e:
            log.error("Rule '%s' failed: %s", name, e, exc_info=True)
            # Track consecutive errors
            self._rule_errors[name] = self._rule_errors.get(name, 0) + 1
            # Log to rule_events so dashboard shows the failure
            self._log_rule_event(
                name, event.get('device_id', ''), event.get('source', ''),
                'error', f'{type(e).__name__}: {str(e)[:250]}',
                (time.time() - t0) * 1000,
            )
            if self._rule_errors[name] >= self._MAX_CONSECUTIVE_ERRORS:
                self._auto_disable_rule(name, str(e))
            return []
        finally:
            elapsed_ms = (time.time() - t0) * 1000
            stats = self._rule_stats.get(name, {'count': 0, 'total_ms': 0, 'max_ms': 0})
            stats['count'] += 1
            stats['total_ms'] += elapsed_ms
            stats['_last_ms'] = elapsed_ms
            if elapsed_ms > stats['max_ms']:
                stats['max_ms'] = elapsed_ms
            self._rule_stats[name] = stats

        # Success — reset error counter
        self._rule_errors[name] = 0

        if result is None:
            return []
        if not isinstance(result, list):
            log.warning("Rule '%s' returned non-list: %s", name, type(result).__name__)
            return []
        return result

    def _auto_disable_rule(self, rule_name, error_msg):
        """Auto-disable a rule after repeated errors. Write alert to system_alerts."""
        if rule_name in self._disabled_rules:
            return  # already disabled
        self._disabled_rules.add(rule_name)
        self.state.shared['_disabled_rules'] = list(self._disabled_rules)
        log.warning("Rule '%s' AUTO-DISABLED after %d consecutive errors: %s",
                     rule_name, self._MAX_CONSECUTIVE_ERRORS, error_msg)
        # Write to system_alerts for dashboard + orchestrator
        self.state.db_execute(
            "INSERT INTO system_alerts (ts, severity, alert_type, affected_agent, message) "
            "VALUES (NOW(), 'warn', 'rule_error', 'rule_engine', %s)",
            (f"Rule '{rule_name}' auto-disabled after {self._MAX_CONSECUTIVE_ERRORS} "
             f"consecutive errors: {error_msg[:200]}",),
        )
        # Log to rule_events
        self._log_rule_event(rule_name, '', '', 'auto_disabled', error_msg[:300], 0)

    # ------------------------------------------------------------------
    # Command dispatch
    # ------------------------------------------------------------------

    # ─── Awtrix dispatch helpers ────────────────────────────────────────
    # Awtrix firmware 0.98 uses a flat MQTT prefix that equals the device id
    # (e.g. 'awtrix_05ec2c'), so topics are '<id>/power', '<id>/notify' —
    # NOT nested under awtrix/<name>/. devices.id IS the prefix.

    _AWTRIX_TPL_RE = re.compile(r'\{\{(\w+)\}\}')

    def _dispatch_awtrix(self, cmd, device_id, rule_name):
        action = cmd.get('action', '')
        if action in ('power_on', 'power_off'):
            self.mqtt.publish_command(f'{device_id}/power', {'power': action == 'power_on'})
            log.info("Rule '%s' -> awtrix %s %s", rule_name, action, device_id)
            return
        if action == 'push_preset':
            self._awtrix_push_preset(cmd, device_id, rule_name)
            return
        log.warning("Rule '%s' awtrix: unsupported action '%s'", rule_name, action)

    def _awtrix_push_preset(self, cmd, device_id, rule_name):
        preset_name = cmd.get('preset_name', '')
        if not preset_name:
            log.warning("Rule '%s' awtrix push_preset: missing preset_name", rule_name)
            return
        rows = self.state.db_query(
            "SELECT value FROM dashboard_settings WHERE key = 'awtrix.messages'"
        )
        messages = (rows[0][0] if rows else None) or []
        if isinstance(messages, str):
            try:    messages = json.loads(messages)
            except: messages = []
        preset = next((m for m in messages if isinstance(m, dict) and m.get('name') == preset_name), None)
        if not preset:
            log.warning("Rule '%s' awtrix push_preset: preset '%s' not found in dashboard_settings.awtrix.messages",
                        rule_name, preset_name)
            return

        # Substitute {{var}} in template — first from cmd['vars'] (rule-supplied),
        # falling back to state.shared. Floats are rounded to 1 decimal so
        # micro sensor-noise (e.g. 21.039999961853) doesn't render as an ugly
        # long string scrolling across the LED matrix. Numeric strings get
        # the same treatment only if they were already in decimal form.
        explicit_vars = cmd.get('vars') or {}
        def _fmt_awtrix(v):
            if v is None:               return ''
            if isinstance(v, bool):     return str(v)
            if isinstance(v, int):      return str(v)
            if isinstance(v, float):    return f"{v:.1f}"
            if isinstance(v, str):
                try:
                    f = float(v)
                    return f"{f:.1f}" if '.' in v else v
                except ValueError:
                    pass
            return str(v)
        def sub(m):
            k = m.group(1)
            if k in explicit_vars:
                v = explicit_vars[k]
            else:
                v = self.state.shared.get(k)
            return _fmt_awtrix(v)
        text = self._AWTRIX_TPL_RE.sub(sub, preset.get('template') or '')

        # Translate stored preset fields → Awtrix wire format
        payload = {'text': text}
        if preset.get('color'):        payload['color']       = preset['color']
        if preset.get('scroll_speed') is not None: payload['scrollSpeed'] = preset['scroll_speed']
        if preset.get('text_case')   is not None: payload['textCase']    = preset['text_case']
        if preset.get('duration_s')  is not None: payload['duration']    = preset['duration_s']
        if preset.get('blink_ms'):     payload['blinkText']   = preset['blink_ms']
        if preset.get('sound'):
            s = preset['sound']
            payload['rtttl' if re.search(r':[dob]=', s) else 'sound'] = s
        if preset.get('priority') == 'high': payload['wakeup'] = True
        if preset.get('clear_after') and preset.get('persistent'):
            payload['lifetime'] = preset.get('duration_s', 6)
            payload['lifetimeMode'] = 0

        self.mqtt.publish_command(f'{device_id}/notify', payload)
        log.info("Rule '%s' -> awtrix preset '%s' (%s) -> %r",
                 rule_name, preset_name, device_id, text)

    def _dispatch_command(self, cmd, rule_name):
        """Route a command dict to the correct MQTT topic."""
        if not isinstance(cmd, dict):
            return

        device_id = cmd.get('device_id', '')
        action = cmd.get('action', '')

        if not device_id:
            log.warning("Rule '%s' returned command without device_id", rule_name)
            return

        # Pixoo is a virtual device — route directly to pixoo command topic
        protocol = cmd.get('protocol', '')
        if protocol == 'pixoo':
            pixoo_payload = {k: v for k, v in cmd.items() if k not in {'device_id', 'protocol', 'rule', '_skip_loop_guard'}}
            self.mqtt.publish_command('mur/home/pixoo/command', pixoo_payload)
            log.info("Rule '%s' -> pixoo %s", rule_name, action)
            return

        # Loop guard catches runaway automation feedback (rule → device →
        # rule → …). Rules that act on human input (panel button, wallmote)
        # can mark their commands with `_skip_loop_guard=True` so rapid
        # intentional presses don't auto-disable the rule.
        if not cmd.get('_skip_loop_guard') and self._check_loop(device_id, action, rule_name):
            return

        dev = self.state.devices.get(device_id, {})
        protocol = dev.get('protocol', '')
        device_name = dev.get('name', device_id)

        # Strip internal keys — only pass device-specific payload
        _internal = {'device_id', 'action', 'channel', 'rule', 'path', 'value', '_skip_loop_guard'}

        if protocol == 'hasp':
            # Plate name (used in MQTT topic) lives in the device id as
            # 'hasp:<plate>', not in `name` — so users can freely rename
            # the device's human display name without breaking dispatch.
            plate = device_id[5:].split(':', 1)[0] if device_id.startswith('hasp:') else device_name
            path = cmd.get('path', '')
            value = cmd.get('value', '')
            self.mqtt.publish_raw(f'hasp/{plate}/command/{path}', str(value))

        elif protocol == 'zigbee':
            # For multi-gang zigbee switches, `channel` (e.g. 'state_l1') is the
            # actual Z2M key for that gang. Single-gang devices: default to 'state'.
            z2m_payload = {k: v for k, v in cmd.items() if k not in _internal and k != 'channel'}
            state_key = cmd.get('channel') or 'state'
            if action == 'turn_on':  z2m_payload[state_key] = 'ON'
            elif action == 'turn_off': z2m_payload[state_key] = 'OFF'
            self.mqtt.publish_command(f'zigbee2mqtt/{device_name}/set', z2m_payload)

        elif protocol == 'awtrix':
            self._dispatch_awtrix(cmd, device_id, rule_name)
            return

        elif protocol == 'esp':
            # ESP boards expect a single action key on mur/home/esp/<id>/command
            # (plain-string payload). turn_on/turn_off map per board via
            # devices.dps_config[<channel>].action_on/action_off so different
            # boards can wire on/off to different sketch actions (smell board:
            # smell_auto_start; future boards: their own keys).
            esp_action = self._resolve_esp_action(dev, cmd)
            if not esp_action:
                log.warning("Rule '%s' -> esp %s/%s: no mapping for action '%s' (channel=%s)",
                            rule_name, device_id, device_name, action, cmd.get('channel'))
                return
            self.mqtt.publish_raw(f'mur/home/esp/{device_id}/command', esp_action)
            log.info("Rule '%s' -> esp %s '%s'", rule_name, device_name, esp_action)
            return

        else:
            # Default: Tuya / BSH / other
            self.mqtt.publish_command(f'mur/home/device/{device_id}/command', cmd)

        log.info("Rule '%s' -> %s %s", rule_name, action, device_name)

    # ESP turn_on/turn_off → sketch action key.
    #
    # Per-channel mapping lives in devices.dps_config[<channel>] as
    # `action_on` / `action_off`. The smell board's `auto` channel maps
    # turn_on→smell_auto_start, turn_off→smell_auto_stop; a future board
    # can map differently per channel without engine changes. If `action`
    # is already a literal sketch key (e.g. a rule emits action='restart'),
    # pass it through unchanged so existing patterns keep working.
    def _resolve_esp_action(self, dev, cmd):
        action = cmd.get('action', '')
        if not action:
            return None
        # Pass-through for actions that are already sketch keys
        # (restart, factory_reset, smell_auto_start, etc.).
        if action not in ('turn_on', 'turn_off'):
            return action
        channel = cmd.get('channel') or ''
        cfg = (dev.get('dps_config') or {}).get(channel, {}) if channel else {}
        if action == 'turn_on'  and cfg.get('action_on'):  return cfg['action_on']
        if action == 'turn_off' and cfg.get('action_off'): return cfg['action_off']
        # If the channel itself is missing or has no explicit mapping, pick
        # the first channel whose dps_config carries the matching key.
        for ch_cfg in (dev.get('dps_config') or {}).values():
            if not isinstance(ch_cfg, dict):
                continue
            if action == 'turn_on'  and ch_cfg.get('action_on'):  return ch_cfg['action_on']
            if action == 'turn_off' and ch_cfg.get('action_off'): return ch_cfg['action_off']
        return None

    def _check_loop(self, device_id, action, rule_name):
        """Detect command loops. Returns True if loop detected (rule auto-disabled)."""
        now = time.time()
        # Lock guards the setdefault + slice-assign + append sequence against
        # concurrent paho-thread callbacks that could corrupt the list.
        with self._command_log_lock:
            entries = self._command_log.setdefault(device_id, [])
            entries[:] = [(ts, a) for ts, a in entries if now - ts < 10]
            entries.append((now, action))
            same_action_count = sum(1 for _, a in entries if a == action)
        if same_action_count >= 4:
            log.error(
                "Loop detected: rule '%s' sent '%s' to %s %d times in 10s — auto-disabling",
                rule_name, action, device_id, same_action_count,
            )
            self._disable_rule(rule_name)
            return True
        return False

    # ------------------------------------------------------------------
    # Enable / disable rules
    # ------------------------------------------------------------------

    def _disable_rule(self, rule_name):
        """Disable a rule by name. Locked so it can't race with rule dispatch."""
        with self._dispatch_lock:
            self._disabled_rules.add(rule_name)
            self.state.shared['_disabled_rules'] = list(self._disabled_rules)
            log.info("Rule '%s' DISABLED", rule_name)

    def _enable_rule(self, rule_name):
        """Enable a previously disabled rule. Locked so it can't race with dispatch."""
        with self._dispatch_lock:
            self._disabled_rules.discard(rule_name)
            self.state.shared['_disabled_rules'] = list(self._disabled_rules)
            log.info("Rule '%s' ENABLED", rule_name)

    def _reload_rules(self):
        """Hot-reload rules from disk without restarting.
        Preserves stats for rules that still exist. Locked so the heartbeat
        thread can't iterate self._sorted_rules mid-rebuild."""
        with self._dispatch_lock:
            old_count = len(self.rules)
            old_stats = dict(self._rule_stats)
            existing_names = {m.RULE['name'] for m in self.rules}

            # Load into temporary list
            self.rules = []
            self.load_rules()
            new_names = {m.RULE['name'] for m in self.rules}

            # Restore stats for rules that still exist
            for name, stats in old_stats.items():
                if name in new_names and name not in self._rule_stats:
                    self._rule_stats[name] = stats

            # Atomic index rebuild
            self._index_rules()

            added = new_names - existing_names
            removed = existing_names - new_names
            log.info("Rules reloaded: %d -> %d (added: %s, removed: %s)",
                     old_count, len(self.rules),
                     list(added) if added else 'none',
                     list(removed) if removed else 'none')

    def _test_rule(self, payload):
        """Locked wrapper so Test/Force runs can't race with dispatch / reload."""
        with self._dispatch_lock:
            self._test_rule_impl(payload)

    def _test_rule_impl(self, payload):
        """Test a rule. Two modes:
        - force=false (default): dry-run, shows what state looks like, no side effects
        - force=true: resets cooldown timers, runs evaluate, dispatches commands for real
        """
        rule_name = payload.get('rule_name', '') if isinstance(payload, dict) else ''
        force = payload.get('force', False) if isinstance(payload, dict) else False
        if not rule_name:
            log.warning("Test request missing rule_name")
            return

        # Find the rule
        rule = None
        for m in self.rules:
            if m.RULE['name'] == rule_name:
                rule = m
                break
        if not rule:
            self._write_test_result({'rule': rule_name, 'status': 'error', 'reason': 'Rule not found'})
            return

        # Check conditions
        ok, reason = self._check_conditions(rule)
        if not ok:
            self._write_test_result({
                'rule': rule_name, 'status': 'skip',
                'reason': f'Condition failed: {reason}',
                'ts': datetime.now(tz=TZ).isoformat(),
            })
            return

        # Build synthetic event. Rules that react to custom payloads can
        # declare a RULE["test_event"] template; otherwise fall back to the
        # first presence device's current state (works for presence/switch rules).
        custom_test = rule.RULE.get('test_event')
        if isinstance(custom_test, dict):
            event = {
                'device_id': custom_test.get('device_id', ''),
                'dps':       custom_test.get('dps', {}),
                'source':    custom_test.get('source', 'test'),
                'ts':        datetime.now(tz=TZ).isoformat(),
            }
            test_device_id = event['device_id']
        else:
            test_device_id = ''
            for did, dev in self.state.devices.items():
                if dev.get('device_type') == 'presence':
                    test_device_id = did
                    break
            event = {
                'device_id': test_device_id,
                'dps':       self.state.devices.get(test_device_id, {}).get('dps', {}),
                'source':    'test',
                'ts':        datetime.now(tz=TZ).isoformat(),
            }

        if force:
            # Force mode: fake all conditions so rule fires, dispatch for real
            log.info("Force-running rule '%s'", rule_name)

            # Save state (hold state.lock across snapshot + timer reset + fake-conditions write
            # so the heartbeat thread can't observe a torn state mid-save).
            with self.state.lock:
                saved_shared = copy.deepcopy(self.state.shared)
                saved_timers = dict(self.state._timers)
                # Reset ALL timers to ancient time (all cooldowns expired)
                for k in list(self.state._timers):
                    self.state._timers[k] = 0
                # Fake favorable conditions for the main trigger path
                self.state.shared['activity_level'] = 'active'
                self.state.shared['_pixoo_resumed'] = 'yes'

            # Build event — honor RULE["test_event"] if rule declares one,
            # otherwise fall back to corridor/entrance presence with dps 1=true
            # (which matches typical presence/switch rules).
            custom_test = rule.RULE.get('test_event')
            if isinstance(custom_test, dict):
                force_device_id = custom_test.get('device_id', '')
                force_event = {
                    'device_id': force_device_id,
                    'dps':       custom_test.get('dps', {}),
                    'source':    custom_test.get('source', 'event'),
                    'ts':        datetime.now(tz=TZ).isoformat(),
                }
            else:
                force_device_id = ''
                # Hold _dev_lock across iteration — midnight refresh thread
                # swaps self.devices via load_from_db() which would invalidate
                # the iterator or return a stale list.
                with self.state._dev_lock:
                    for did, dev in self.state.devices.items():
                        if dev.get('device_type') == 'presence' and dev.get('room', '').lower() in ('corridor', 'entrance'):
                            force_device_id = did
                            break
                if not force_device_id:
                    force_device_id = test_device_id
                force_event = {
                    'device_id': force_device_id,
                    'dps': {'1': True},
                    'source': 'force_test',
                    'ts': datetime.now(tz=TZ).isoformat(),
                }

            commands = self._evaluate_rule(rule, force_event)

            # Detect state mutations (compare against the saved snapshot)
            changed_keys = [
                k for k in self.state.shared
                if not k.startswith('_')
                and self.state.shared.get(k) != saved_shared.get(k)
            ]
            state_diff = {
                k: self.state.shared.get(k) for k in changed_keys
            } if changed_keys else {}

            # Dispatch for real
            for cmd in commands:
                self._dispatch_command(cmd, rule_name)

            # Restore state + timers (hold the lock across both assignments so
            # the heartbeat thread can't snapshot a half-restored state).
            with self.state.lock:
                self.state.shared = saved_shared
                self.state._timers = saved_timers

            if commands:
                cmd_strs = [self._format_cmd(c) for c in commands]
                self._write_test_result({
                    'rule': rule_name, 'status': 'force_fired',
                    'commands': cmd_strs, 'device': force_device_id,
                    'state_changes': state_diff,
                    'ts': datetime.now(tz=TZ).isoformat(),
                })
            elif state_diff:
                self._write_test_result({
                    'rule': rule_name, 'status': 'state_updated',
                    'reason': f'Rule updated {len(state_diff)} state key(s) (no device commands)',
                    'state_changes': state_diff,
                    'device': force_device_id,
                    'ts': datetime.now(tz=TZ).isoformat(),
                })
            else:
                hints = self._collect_state_hints()
                self._write_test_result({
                    'rule': rule_name, 'status': 'no_action',
                    'reason': 'Rule did not fire even with all conditions faked',
                    'state': hints['state'], 'timers': hints['timers'],
                    'device': force_device_id,
                    'ts': datetime.now(tz=TZ).isoformat(),
                })
        else:
            # Dry-run mode: no side effects
            log.info("Testing rule '%s' (dry run)", rule_name)
            shared_backup = copy.deepcopy(self.state.shared)
            try:
                commands = self._evaluate_rule(rule, event)
                # Detect user-visible state mutations (ignore internal `_` prefixed)
                changed_keys = [
                    k for k in self.state.shared
                    if not k.startswith('_')
                    and self.state.shared.get(k) != shared_backup.get(k)
                ]
                state_diff = {
                    k: self.state.shared.get(k) for k in changed_keys
                } if changed_keys else {}
            finally:
                self.state.shared = shared_backup

            if commands:
                cmd_strs = [self._format_cmd(c) for c in commands]
                self._write_test_result({
                    'rule': rule_name, 'status': 'would_fire',
                    'commands': cmd_strs, 'device': test_device_id,
                    'state_changes': state_diff,
                    'ts': datetime.now(tz=TZ).isoformat(),
                })
            elif state_diff:
                # Info rule: no commands but state was updated — success
                self._write_test_result({
                    'rule': rule_name, 'status': 'state_updated',
                    'reason': f'Rule updated {len(state_diff)} state key(s)',
                    'state_changes': state_diff,
                    'device': test_device_id,
                    'ts': datetime.now(tz=TZ).isoformat(),
                })
            else:
                hints = self._collect_state_hints()
                self._write_test_result({
                    'rule': rule_name, 'status': 'no_action',
                    'reason': 'Rule evaluated but returned no commands and no state changes',
                    'state': hints['state'], 'timers': hints['timers'],
                    'device': test_device_id,
                    'ts': datetime.now(tz=TZ).isoformat(),
                })

        log.info("Test result for '%s': %s (force=%s)", rule_name,
                 'fired' if force and commands else 'no_action', force)

    def _write_test_result(self, result):
        """Write test result to DB for dashboard polling."""
        self.state.db_execute(
            "INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_test_result', %s::jsonb, NOW()) "
            "ON CONFLICT (key) DO UPDATE SET value = %s::jsonb, updated_at = NOW()",
            (json.dumps(result), json.dumps(result)),
        )

    def _format_cmd(self, cmd):
        """Format a command dict for test result display."""
        s = cmd.get('action', '?')
        if cmd.get('preset_name'):
            s += f': {cmd["preset_name"]}'
        if cmd.get('vars'):
            s += f' vars={cmd["vars"]}'
        return s

    def _collect_state_hints(self):
        """Collect current state + timer info for test result."""
        hints = []
        for timer_name in ['pixoo_last_push', 'last_motion', 'room_active:Corridor', 'room_active:Entrance']:
            val = self.state.get_timer(timer_name)
            if val != float('inf'):
                hints.append(f'{timer_name}: {val:.0f}s ago')
        return {
            'state': {
                'activity_level': self.state.shared.get('activity_level'),
                'people_home': self.state.shared.get('people_home'),
                'last_motion_room': self.state.shared.get('last_motion_room'),
            },
            'timers': hints,
        }

    # ------------------------------------------------------------------
    # Computed state publish (debounced)
    # ------------------------------------------------------------------

    def _maybe_publish_computed(self):
        """Publish computed shared state values if enough time has elapsed."""
        now = time.time()
        if now - self._last_computed_publish < 2:
            return

        computed_keys = [
            'activity_level', 'people_home', 'occupied_rooms',
            'home_mode', 'last_motion_room',
        ]
        for key in computed_keys:
            if key in self.state.shared:
                self.mqtt.publish_computed_state(key, self.state.shared[key])

        self._last_computed_publish = now

    # ------------------------------------------------------------------
    # Background threads
    # ------------------------------------------------------------------

    def _heartbeat_loop(self):
        """Write heartbeat to DB every 60s, save shared state every 60s."""
        last_heartbeat = 0
        last_save = 0

        while not self._stop.is_set():
            now = time.time()

            # Save shared state + sync disabled rules from DB every 60s
            if now - last_save >= 60:
                try:
                    # Reload disabled rules from DB (dashboard may have changed them)
                    self.state.load_shared_state()
                    disabled_raw = self.state.shared.get('_disabled_rules', [])
                    if isinstance(disabled_raw, str):
                        try:
                            disabled_raw = json.loads(disabled_raw)
                        except (json.JSONDecodeError, TypeError):
                            disabled_raw = []
                    self._disabled_rules = set(disabled_raw)
                    self._apply_overrides()
                    # Check for reload request from dashboard
                    if self.state.shared.get('_reload_request') == 'pending':
                        self._reload_rules()
                        self.state.shared['_reload_request'] = 'done'
                        # Explicit DELETE — _reload_request is in _DASHBOARD_KEYS
                        # so save_shared_state() skips it; without this, the flag
                        # stays 'pending' in DB and triggers reload every cycle.
                        try:
                            self.state.db_execute(
                                "DELETE FROM rule_engine_state WHERE key = '_reload_request'"
                            )
                        except Exception:
                            log.warning('Failed to clear _reload_request flag', exc_info=True)
                    # Parse rule-knob sentences from apartment.rule_sentences
                    # → push values into state.shared so rules pick them up at
                    # their next fire. Cheap (~10 ms regex scan); runs every 60 s.
                    try:
                        self._sync_rule_knobs()
                    except Exception:
                        log.warning('Knob parsing failed', exc_info=True)
                    # Spatial reload — flipped by dashboard on any room-layout /
                    # placement save. Rebuilds devices + rooms + spatial index
                    # atomically; same lock + atomic swap as startup.
                    if self.state.shared.get('_spatial_reload_request') == 'pending':
                        try:
                            self.state.load_from_db()
                            log.info('Spatial index reloaded (dashboard save)')
                        except Exception:
                            log.warning('Spatial reload failed', exc_info=True)
                        self.state.shared['_spatial_reload_request'] = 'done'
                        try:
                            self.state.db_execute(
                                "DELETE FROM rule_engine_state WHERE key = '_spatial_reload_request'"
                            )
                        except Exception:
                            log.warning('Failed to clear _spatial_reload_request flag', exc_info=True)
                    # Count rule files on disk for dashboard "new rule" badge
                    rules_dir = os.path.join(os.path.dirname(__file__), 'rules')
                    disk_count = len([f for f in os.listdir(rules_dir)
                                     if f.endswith('.py') and not f.startswith('_')]) if os.path.isdir(rules_dir) else 0
                    self.state.shared['_rules_on_disk'] = disk_count
                    self.state.shared['_rule_stats'] = self._rule_stats
                    self._update_rules_metadata()
                    self._save_state_tracked()
                except Exception:
                    log.warning('Failed to sync shared state', exc_info=True)
                last_save = now

            # Write heartbeat + dispatch synthetic tick event every 60s.
            # Tick gives time-based rules (e.g. home_state.py Layer 0) a
            # reliable re-evaluation pulse independent of real device events,
            # so boundaries like "22:30 turn off lights" still fire when nobody
            # is home to generate MQTT traffic.
            if now - last_heartbeat >= 60:
                try:
                    self._write_heartbeat()
                except Exception:
                    log.warning('Failed to write heartbeat', exc_info=True)
                try:
                    tick = {
                        'device_id': 'heartbeat',
                        'dps': {'ts': datetime.now(tz=TZ).isoformat()},
                        'source': 'tick',
                        'ts': datetime.now(tz=TZ).isoformat(),
                    }
                    self._fire_rules_for_event(tick)
                except Exception:
                    log.warning('Failed to dispatch heartbeat tick', exc_info=True)
                last_heartbeat = now

            self._stop.wait(30)

    def _sync_rule_knobs(self):
        """Parse `apartment.rule_sentences` + write matched knob values into
        state.shared. Called once per heartbeat tick (~60 s). Idempotent — if
        nothing changed, no state mutation happens, no log noise."""
        with self.state._hb_lock:
            self.state._ensure_hb_conn()
            with self.state._hb_conn.cursor() as cur:
                cur.execute(
                    "SELECT value FROM dashboard_settings WHERE key = 'apartment.rule_sentences'"
                )
                row = cur.fetchone()
        if not row or row[0] is None:
            return
        raw = row[0]
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return
        if not isinstance(raw, list):
            return
        parsed = _parse_knob_sentences(raw)
        if not parsed:
            return
        for key, val in parsed.items():
            if self.state.shared.get(key) != val:
                self.state.shared[key] = val
                log.info("Rule knob updated from sentence: %s = %s", key, val)

    def _write_heartbeat(self):
        """Insert a heartbeat row into rule_engine_log.
        Uses the heartbeat-dedicated connection (with its lock) — avoids contention
        with rule emissions on the main connection and the previous latent
        thread-safety smell where this method bypassed _db_lock."""
        decision = f"Running — {len(self.rules)} rules, {len(self._disabled_rules)} disabled"
        now = datetime.now(tz=TZ)
        next_ts = now + timedelta(minutes=5)
        try:
            with self.state._hb_lock:
                self.state._ensure_hb_conn()
                with self.state._hb_conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO rule_engine_log (decision, error, next_ts) "
                        "VALUES (%s, %s, %s)",
                        (decision, 'NO ERROR', next_ts),
                    )
        except Exception:
            log.warning('Heartbeat write failed', exc_info=True)

    def _midnight_refresh(self):
        """Reload device/room state from DB at midnight Asia/Jerusalem."""
        while not self._stop.is_set():
            now = datetime.now(tz=TZ)
            tomorrow = (now + timedelta(days=1)).replace(
                hour=0, minute=0, second=5, microsecond=0,
            )
            seconds_until = (tomorrow - now).total_seconds()
            log.info('Midnight refresh scheduled in %.0f seconds', seconds_until)

            if self._stop.wait(seconds_until):
                break  # stop requested

            try:
                self.state.load_from_db()
                log.info('Midnight refresh complete')
            except Exception:
                log.error('Midnight refresh failed', exc_info=True)

    # ------------------------------------------------------------------
    # Main run loop
    # ------------------------------------------------------------------

    def run(self):
        """Start the rule engine: load state, connect MQTT, evaluate forever."""
        log.info('Rule Engine starting...')

        # Load state from DB
        self.state.load_from_db()
        self.state.load_shared_state()

        # Restore rule stats from last run (count, total_ms, max_ms, last_fired)
        stored_stats = self.state.shared.get('_rule_stats')
        if isinstance(stored_stats, str):
            try:
                stored_stats = json.loads(stored_stats)
            except (json.JSONDecodeError, TypeError):
                stored_stats = {}
        if isinstance(stored_stats, dict):
            self._rule_stats = stored_stats
            log.info('Restored stats for %d rules', len(stored_stats))

        # Load and index rules
        self.load_rules()
        self._index_rules()

        # Connect MQTT and subscribe
        self.mqtt.connect()

        topics = [
            ('mur/home/device/+/state', 0),
            ('mur/home/device/+/event', 0),
            ('mur/home/device/+/availability', 1),
            ('mur/home/device/_bridge/devices', 0),
            ('mur/home/device/+/command/response', 0),
            ('mur/home/rule-engine/disable/+', 0),
            ('mur/home/rule-engine/enable/+', 0),
            ('mur/home/rule-engine/reload', 0),
            ('mur/home/rule-engine/test', 0),
            ('mur/home/esp/+/+', 0),  # ESP boards ingest (Phase 5, 2026-05-02)
            ('hasp/+/state', 0),
            ('hasp/+/state/+', 0),
            ('awtrix/+/stats', 0),
            ('zigbee2mqtt/+', 0),
        ]
        self.mqtt.subscribe(topics, self.on_mqtt_event)
        self.mqtt.publish_bridge_online(len(self.rules))

        # Start background threads
        heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, daemon=True, name='heartbeat',
        )
        heartbeat_thread.start()

        midnight_thread = threading.Thread(
            target=self._midnight_refresh, daemon=True, name='midnight',
        )
        midnight_thread.start()

        # Write initial heartbeat
        try:
            self._write_heartbeat()
        except Exception:
            log.warning('Initial heartbeat write failed', exc_info=True)

        log.info('Rule Engine running — %d rules loaded', len(self.rules))

        # Evaluate all rules once on startup using current device state
        # This ensures computed state (people_home, activity) is correct immediately
        self._stop.wait(5)  # wait for retained MQTT messages to arrive
        if not self._stop.is_set():
            count = 0
            for dev_id, dev in self.state.devices.items():
                dps = dev.get('dps', {})
                if not dps:
                    continue
                event = {'device_id': dev_id, 'dps': dps, 'source': 'startup', 'ts': datetime.now(tz=TZ).isoformat()}
                matching = self.trigger_index.get(dev_id, []) + self.trigger_index.get('*', [])
                for rule in matching:
                    if rule.RULE['name'] not in self._disabled_rules:
                        self._evaluate_rule(rule, event)
                count += 1
            self._maybe_publish_computed()
            log.info('Startup evaluation: processed %d devices', count)

        # Main loop — just wait
        while not self._stop.is_set():
            self._stop.wait(10)

        # Shutdown
        log.info('Rule Engine shutting down...')
        self.state.save_shared_state()
        self.mqtt.disconnect()
        if self.state.conn:
            try:
                self.state.conn.close()
            except Exception:
                pass
        log.info('Rule Engine stopped')

    def shutdown(self):
        """Signal the engine to stop."""
        self._stop.set()


# ----------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------

def main():
    engine = RuleEngine()

    def _shutdown(sig, frame):
        log.info('Signal %s, shutting down', sig)
        engine.shutdown()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    engine.run()


if __name__ == '__main__':
    main()
