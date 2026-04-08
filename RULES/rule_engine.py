#!/usr/bin/env python3
"""
Rule Engine — main event loop for the home automation rule system.

Subscribes to MQTT topics, maintains device state via StateManager,
evaluates matching rules on each event, and dispatches commands.

Runs on LXC 105 (Main Agent / Orchestrator).
"""

import importlib.util
import json
import logging
import os
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

        for filename in sorted(os.listdir(rules_dir)):
            if not filename.endswith('.py') or filename.startswith('_'):
                continue

            filepath = os.path.join(rules_dir, filename)
            module_name = f'rules.{filename[:-3]}'

            try:
                spec = importlib.util.spec_from_file_location(module_name, filepath)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            except Exception:
                log.error('Failed to import rule %s', filename, exc_info=True)
                continue

            # Validate RULE dict
            rule_dict = getattr(module, 'RULE', None)
            if not isinstance(rule_dict, dict):
                log.warning('Rule %s missing RULE dict — skipped', filename)
                continue

            missing = required_keys - set(rule_dict.keys())
            if missing:
                log.warning('Rule %s RULE dict missing keys %s — skipped', filename, missing)
                continue

            if not callable(getattr(module, 'evaluate', None)):
                log.warning('Rule %s missing evaluate() callable — skipped', filename)
                continue

            self.rules.append(module)

        # Load disabled list from shared state
        disabled_raw = self.state.shared.get('_disabled_rules', [])
        if isinstance(disabled_raw, str):
            try:
                disabled_raw = json.loads(disabled_raw)
            except (json.JSONDecodeError, TypeError):
                disabled_raw = []
        self._disabled_rules = set(disabled_raw)

        log.info('Loaded %d rules (%d disabled)', len(self.rules), len(self._disabled_rules))

    def _index_rules(self):
        """Build trigger_index mapping device_id -> [rule_module, ...]."""
        self.trigger_index = {}
        for module in self.rules:
            for device_id in module.RULE.get('triggers', []):
                self.trigger_index.setdefault(device_id, []).append(module)

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

        # Find matching rules
        matching = self.trigger_index.get(device_id, []) + self.trigger_index.get('*', [])

        event = {
            'device_id': device_id,
            'dps': dps if isinstance(dps, dict) else {},
            'source': source,
            'ts': datetime.now(tz=TZ).isoformat(),
        }

        for rule in matching:
            rule_name = rule.RULE['name']
            if rule_name in self._disabled_rules:
                continue
            commands = self._evaluate_rule(rule, event)
            for cmd in commands:
                self._dispatch_command(cmd, rule_name)

        self._maybe_publish_computed()

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

    def _lookup_device_by_name(self, name):
        """Find device_id by device name. Returns None if not found."""
        for dev_id, dev in self.state.devices.items():
            if dev.get('name', '') == name:
                return dev_id
        log.debug('Device lookup failed for name=%s', name)
        return None

    # ------------------------------------------------------------------
    # Rule evaluation
    # ------------------------------------------------------------------

    def _evaluate_rule(self, rule, event):
        """Call rule.evaluate() safely, return list of command dicts."""
        try:
            result = rule.evaluate(event, self.state)
        except Exception as e:
            log.error("Rule '%s' failed: %s", rule.RULE['name'], e, exc_info=True)
            return []

        if result is None:
            return []
        if not isinstance(result, list):
            log.warning("Rule '%s' returned non-list: %s", rule.RULE['name'], type(result).__name__)
            return []
        return result

    # ------------------------------------------------------------------
    # Command dispatch
    # ------------------------------------------------------------------

    def _dispatch_command(self, cmd, rule_name):
        """Route a command dict to the correct MQTT topic."""
        if not isinstance(cmd, dict):
            return

        device_id = cmd.get('device_id', '')
        action = cmd.get('action', '')

        if not device_id:
            log.warning("Rule '%s' returned command without device_id", rule_name)
            return

        if self._check_loop(device_id, action, rule_name):
            return

        dev = self.state.devices.get(device_id, {})
        protocol = dev.get('protocol', '')
        device_name = dev.get('name', device_id)

        if protocol == 'hasp':
            path = cmd.get('path', '')
            value = cmd.get('value', '')
            self.mqtt.publish_command(f'hasp/{device_name}/command/{path}', value)

        elif protocol == 'zigbee':
            self.mqtt.publish_command(f'zigbee2mqtt/{device_name}/set', cmd)

        elif protocol == 'awtrix':
            self.mqtt.publish_command(f'awtrix/{device_name}/custom', cmd)

        else:
            # Default: Tuya / BSH / other
            self.mqtt.publish_command(f'mur/home/device/{device_id}/command', cmd)

        log.info("Rule '%s' -> %s %s", rule_name, action, device_name)

    def _check_loop(self, device_id, action, rule_name):
        """Detect command loops. Returns True if loop detected (rule auto-disabled)."""
        now = time.time()
        entries = self._command_log.setdefault(device_id, [])

        # Purge entries older than 10 seconds
        self._command_log[device_id] = [(ts, a) for ts, a in entries if now - ts < 10]
        entries = self._command_log[device_id]

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
        """Disable a rule by name."""
        self._disabled_rules.add(rule_name)
        self.state.shared['_disabled_rules'] = list(self._disabled_rules)
        log.info("Rule '%s' DISABLED", rule_name)

    def _enable_rule(self, rule_name):
        """Enable a previously disabled rule."""
        self._disabled_rules.discard(rule_name)
        self.state.shared['_disabled_rules'] = list(self._disabled_rules)
        log.info("Rule '%s' ENABLED", rule_name)

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
        """Write heartbeat to DB every 300s, save shared state every 60s."""
        last_heartbeat = 0
        last_save = 0

        while not self._stop.is_set():
            now = time.time()

            # Save shared state every 60s
            if now - last_save >= 60:
                try:
                    self.state.save_shared_state()
                except Exception:
                    log.warning('Failed to save shared state', exc_info=True)
                last_save = now

            # Write heartbeat every 300s
            if now - last_heartbeat >= 300:
                try:
                    self._write_heartbeat()
                except Exception:
                    log.warning('Failed to write heartbeat', exc_info=True)
                last_heartbeat = now

            self._stop.wait(30)

    def _write_heartbeat(self):
        """Insert a heartbeat row into rule_engine_log."""
        self.state._ensure_conn()
        decision = f"Running — {len(self.rules)} rules, {len(self._disabled_rules)} disabled"
        now = datetime.now(tz=TZ)
        next_ts = now + timedelta(minutes=5)
        try:
            with self.state.conn.cursor() as cur:
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
