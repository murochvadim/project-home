"""Move in Corridor — corridor presence chain entry rule.

On Corridor Presence rising edge (DPS '1' transitions 'none' → 'presence'):
  1. ALWAYS — fire chips from the "on presence" sentence.
  2. WHEN home_mode == 'home' — fire chips from the "when home" sentence(s).
  3. AFTER `after_delay_sec` seconds — fire chips from the "after delay"
     sentence (Pixoo preset + Face Recognition start_recognition).

Everything except the trigger device is sentence-driven via container
`r_move_in_corridor` on the Main Agent → Base Rule Settings tab. Add
or remove devices by editing chips in the dashboard — no code changes.

Sentence classification (by text content):
  - contains 'on presence'  → always bucket (every rising edge)
  - contains 'when home'    → home-mode bucket (rising edge AND home_mode=home)
  - contains 'after delay'  → delayed bucket (fired after_delay_sec later)
  - contains 'delay is N seconds'    → sets after_delay_sec
  - contains 'cooldown is N seconds' → sets cooldown_sec

Cooldown `cooldown_sec` between fires prevents flicker spam when the mmWave
sensor flutters on the edge of the cone.

Delayed-bucket dispatch uses the engine's `_delay_sec` Timer mechanism
(see rule_engine._dispatch_command). The rule emits each delayed command
with `_delay_sec=<after_delay_sec>` and the engine schedules a
threading.Timer to publish the MQTT command after that wall-clock delay
— no heartbeat polling, no waiting for the next sensor event. Exact
2/3/N-second timing regardless of mmWave silence.

The `after-delay is N seconds` value is also the gap between
`@Face Recognition screen on` (immediate, when-home bucket) and
`@Face Recognition recognition on` (delayed bucket) — gives the FR
display + module time to wake up before recognition scans.

Trigger device (CORRIDOR_PRESENCE_ID) stays hardcoded: it's listed in
RULE['triggers'] which is fixed at module load time; the rule engine
subscribes to that ID at startup. The 5 output devices used previously
(Corridor Switch, Entrance Monitor, Awtrix, Pixoo, Face Recognition)
are now resolved from chips in the sentence container at fire time.
"""

import json
import logging
import os
import re
import sys
import time

log = logging.getLogger("rule.move_in_corridor")

# RULES/ is the parent of rules/ — needed for `import _display_chips` since
# rule files are loaded via importlib.util but share sys.path with the engine.
_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import build_devices_by_name  # noqa: E402
from _chip_resolver import resolve_chip  # noqa: E402

# Trigger device — must be hardcoded because RULE['triggers'] is fixed at
# module load and the engine builds its event-routing index from that list.
CORRIDOR_PRESENCE_ID = 'bfbdca138cb1c78c3dlbmc'

# Fallback knob defaults — overridden by container `r_move_in_corridor`.
DEFAULTS_COOLDOWN_SEC    = 60
DEFAULTS_AFTER_DELAY_SEC = 3

# Cache parsed config for 30 s to avoid hitting the DB on every event.
# Sentence edits land via dashboard save → 30 s max before the rule
# picks them up. Same pattern as other sentence-driven rules.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Move in Corridor",
    "description": "Corridor presence chain — chips in r_move_in_corridor drive all output devices; delayed bucket uses engine deferred dispatch",
    "triggers": [CORRIDOR_PRESENCE_ID],
    "controls": [],
    "category": "control",
    "group": "corridor",
    "priority": 10,
    "depends_on": ["Mode Buttons"],
    "test_event": {
        "device_id": CORRIDOR_PRESENCE_ID,
        "source": "event",
        "dps": {"1": "presence"},
    },
}


def _classify_sentence(text):
    """Return one of: 'always', 'when_home', 'delayed', 'knob_delay',
    'knob_cooldown', or None."""
    t = (text or '').lower()
    if 'cooldown is' in t:
        return 'knob_cooldown'
    if 'delay is' in t:
        return 'knob_delay'
    if 'after delay' in t:
        return 'delayed'
    if 'when home' in t:
        return 'when_home'
    if 'on presence' in t:
        return 'always'
    return None


def _read_config(state):
    """Parse `r_move_in_corridor` and return the live config:
      {
        'cooldown_sec':    int,
        'after_delay_sec': int,
        'always_cmds':     [cmd, ...],
        'when_home_cmds':  [cmd, ...],
        'delayed_cmds':    [cmd, ...],
      }
    Chips are resolved at parse time so we cache the resolved commands.
    """
    now = time.time()
    if _config_cache['data'] is not None and (now - _config_cache['ts']) < _CONFIG_TTL_SEC:
        return _config_cache['data']

    cfg = {
        'cooldown_sec':    DEFAULTS_COOLDOWN_SEC,
        'after_delay_sec': DEFAULTS_AFTER_DELAY_SEC,
        'always_cmds':     [],
        'when_home_cmds':  [],
        'delayed_cmds':    [],
    }
    try:
        rows = state.db_query(
            "SELECT value FROM dashboard_settings WHERE key='apartment.rule_sentences'"
        )
        if not rows:
            raise RuntimeError("no sentence config row")
        containers = rows[0][0]
        if isinstance(containers, str):
            containers = json.loads(containers)
        container = next((c for c in containers if c.get('id') == 'r_move_in_corridor'), None)
        if not container:
            raise RuntimeError("container r_move_in_corridor not found")

        devices_by_name = build_devices_by_name(state.devices)

        for sentence in container.get('sentences', []):
            if not sentence.get('active', True):
                continue
            full_text = ''.join(seg.get('v', '') for seg in sentence.get('segments', []))
            kind = _classify_sentence(full_text)
            if kind is None:
                log.debug("Move in Corridor: sentence %r unclassified — skipping",
                          sentence.get('id'))
                continue

            if kind == 'knob_cooldown':
                m = re.search(r'cooldown is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['cooldown_sec'] = int(m.group(1))
                continue
            if kind == 'knob_delay':
                m = re.search(r'delay is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['after_delay_sec'] = int(m.group(1))
                continue

            # Chip sentence — collect resolved commands
            sentence_cmds = []
            for seg in sentence.get('segments', []):
                if seg.get('t') != 'dev':
                    continue
                cmd = resolve_chip(seg.get('v', ''), devices_by_name, 'Move in Corridor')
                if cmd:
                    sentence_cmds.append(cmd)

            if kind == 'always':
                cfg['always_cmds'].extend(sentence_cmds)
            elif kind == 'when_home':
                cfg['when_home_cmds'].extend(sentence_cmds)
            elif kind == 'delayed':
                cfg['delayed_cmds'].extend(sentence_cmds)

    except Exception as e:
        log.warning("Move in Corridor: config parse failed (%s) — using defaults", e)

    _config_cache['data'] = cfg
    _config_cache['ts'] = now
    return cfg


def evaluate(event, state):
    commands = []
    dev_id = event.get('device_id', '')

    # Only the Corridor Presence sensor itself triggers the chain entry.
    if dev_id != CORRIDOR_PRESENCE_ID:
        return commands

    dps = event.get('dps', {}) or {}
    if '1' not in dps:
        # Event from this device but no presence-state field — ignore
        # (other DPS like motion_amplitude / target_distance updates).
        return commands

    is_presence = dps.get('1') in ('presence', True, 'true', 1)

    # Track last-known presence in state.shared so we only fire on the
    # rising edge (none → presence). Updates BOTH directions so the next
    # rising edge can fire after the sensor reports 'none' first.
    last_pres = state.shared.get('move_in_corridor.last_presence', 'none')
    state.shared['move_in_corridor.last_presence'] = 'presence' if is_presence else 'none'

    if not is_presence:
        return commands  # falling edge — just update tracker, no actions
    if last_pres == 'presence':
        return commands  # already in presence; no rising edge

    cfg = _read_config(state)
    cooldown = state.get_timer('move_in_corridor_cooldown')
    if cooldown < cfg['cooldown_sec']:
        log.info("Move in Corridor: rising edge but cooldown (%ds < %ds) — skipping",
                 cooldown, cfg['cooldown_sec'])
        return commands
    state.set_timer('move_in_corridor_cooldown')

    log.info("Move in Corridor: rising edge — firing chain "
             "(always=%d, when_home=%d, delayed=%d, cooldown=%ds, after_delay=%ds)",
             len(cfg['always_cmds']), len(cfg['when_home_cmds']),
             len(cfg['delayed_cmds']), cfg['cooldown_sec'], cfg['after_delay_sec'])

    # 1. ALWAYS bucket
    commands.extend(cfg['always_cmds'])

    # 2. WHEN home_mode == 'home' bucket
    home_mode = state.shared.get('home_mode', 'away')
    if home_mode == 'home':
        commands.extend(cfg['when_home_cmds'])
    else:
        log.info("Move in Corridor: home_mode='%s' (not home) — skipping when-home bucket", home_mode)

    # 3. Delayed bucket — emit each command with `_delay_sec` so the
    #    engine's deferred-dispatch Timer fires the MQTT publish at
    #    exact wall-clock time. No pending_ts, no heartbeat polling,
    #    not sensitive to mmWave silence after the rising edge.
    if cfg['delayed_cmds'] and cfg['after_delay_sec'] > 0:
        for cmd in cfg['delayed_cmds']:
            deferred = dict(cmd)
            deferred['_delay_sec'] = cfg['after_delay_sec']
            commands.append(deferred)
        log.info("Move in Corridor: scheduled %d delayed command(s) via engine deferred dispatch in %ds",
                 len(cfg['delayed_cmds']), cfg['after_delay_sec'])

    return commands
