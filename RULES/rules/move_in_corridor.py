"""Move in Corridor — corridor presence chain entry rule.

On Corridor Presence rising edge (DPS '1' transitions 'none' → 'presence'):
  1. ALWAYS — fire chips from the "on presence" sentence.
  2. WHEN home_mode == 'home' — fire chips from the "when home" sentence(s).
  3. AFTER `pixoo_delay_sec` seconds — fire chips from the "after delay"
     sentence (typically a Pixoo preset push).

Everything except the trigger device is sentence-driven via container
`r_move_in_corridor` on the Main Agent → Base Rule Settings tab. Add
or remove devices by editing chips in the dashboard — no code changes.

Sentence classification (by text content):
  - contains 'on presence'  → always bucket (every rising edge)
  - contains 'when home'    → home-mode bucket (rising edge AND home_mode=home)
  - contains 'after delay'  → delayed bucket (fired pixoo_delay_sec later)
  - contains 'delay is N seconds'    → sets pixoo_delay_sec
  - contains 'cooldown is N seconds' → sets cooldown_sec

Cooldown `cooldown_sec` between fires prevents flicker spam when the mmWave
sensor flutters on the edge of the cone.

Triggers list includes the presence sensor's id (rising-edge entry path)
AND `heartbeat` so the delayed bucket fires within 60 s even if the
sensor goes silent after the presence event. In practice the mmWave
sensor emits DPS updates 1-3×/sec during continued presence, so a 2-second
delay typically fires within ~1 s of target time.

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
DEFAULTS_PIXOO_DELAY_SEC = 2

# Cache parsed config for 30 s to avoid hitting the DB on every event.
# Sentence edits land via dashboard save → 30 s max before the rule
# picks them up. Same pattern as other sentence-driven rules.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Move in Corridor",
    "description": "Corridor presence chain — chips in r_move_in_corridor drive all output devices",
    "triggers": [CORRIDOR_PRESENCE_ID, "heartbeat"],
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
        'pixoo_delay_sec': int,
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
        'pixoo_delay_sec': DEFAULTS_PIXOO_DELAY_SEC,
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
                    cfg['pixoo_delay_sec'] = int(m.group(1))
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


def _try_fire_pending(state):
    """If a scheduled delayed command set is due, return the list and
    clear the pending state.

    state.shared keys are NOT pop()'d — save_shared_state only UPSERTs
    (never DELETEs), and load_shared_state restores any DB key not in
    memory. Popping leads to infinite refire every heartbeat. Set
    falsy sentinels instead so the keys stay in memory as 0/'' and
    load_shared_state's `if key not in self.shared` branch is skipped.
    """
    ts = state.shared.get('move_in_corridor.pending_ts')
    if not ts:
        return []
    if time.time() < float(ts):
        return []
    payload = state.shared.get('move_in_corridor.pending_cmds', '')
    state.shared['move_in_corridor.pending_ts'] = 0
    state.shared['move_in_corridor.pending_cmds'] = ''
    if not payload:
        return []
    try:
        cmds = json.loads(payload) if isinstance(payload, str) else payload
        if not isinstance(cmds, list):
            return []
        log.info("Move in Corridor: firing %d scheduled command(s)", len(cmds))
        return cmds
    except Exception as e:
        log.warning("Move in Corridor: pending cmd decode failed (%s)", e)
        return []


def evaluate(event, state):
    commands = []
    dev_id = event.get('device_id', '')

    # On every wake-up (any of this rule's triggers), check whether the
    # delayed command set is due. Both heartbeat and presence-sensor events
    # fire frequently enough to give sub-second-to-60-s precision.
    commands.extend(_try_fire_pending(state))

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
             "(always=%d, when_home=%d, delayed=%d, cooldown=%ds, delay=%ds)",
             len(cfg['always_cmds']), len(cfg['when_home_cmds']),
             len(cfg['delayed_cmds']), cfg['cooldown_sec'], cfg['pixoo_delay_sec'])

    # 1. ALWAYS bucket
    commands.extend(cfg['always_cmds'])

    # 2. WHEN home_mode == 'home' bucket
    home_mode = state.shared.get('home_mode', 'away')
    if home_mode == 'home':
        commands.extend(cfg['when_home_cmds'])
    else:
        log.info("Move in Corridor: home_mode='%s' (not home) — skipping when-home bucket", home_mode)

    # 3. Schedule delayed bucket (no gate — fires regardless of home_mode).
    #    Stored as JSON-serialized command list so heartbeat AND subsequent
    #    presence-sensor events both poll for it.
    if cfg['delayed_cmds'] and cfg['pixoo_delay_sec'] > 0:
        fire_at = time.time() + cfg['pixoo_delay_sec']
        state.shared['move_in_corridor.pending_ts']   = fire_at
        state.shared['move_in_corridor.pending_cmds'] = json.dumps(cfg['delayed_cmds'])
        log.info("Move in Corridor: scheduled %d delayed command(s) in %ds",
                 len(cfg['delayed_cmds']), cfg['pixoo_delay_sec'])

    return commands
