"""Move in Corridor — corridor presence chain entry rule.

On Corridor Presence rising edge (DPS '1' transitions 'none' → 'presence'):
  1. ALWAYS — fire chips from the "on presence" sentence.
  2. WHEN home_mode == <gate> — fire chips from the "when home" sentence(s).
     <gate> value comes from the s_mic_gate sentence — no hardcoded literal.
  3. AFTER `after_delay_sec` seconds — fire chips from the "after delay"
     sentence (Pixoo preset + Face Recognition start_recognition).
  4. AT cooldown end (T + cooldown_sec) — fire chips from the
     "on cooldown end" sentence(s) (screen_off + restore Pixoo).
     Pixoo `push_preset` is auto-substituted with `wipe` if the cleanup
     fire-time falls outside Daily_Welcome's operating window — so the
     LED matrix stays dark overnight instead of holding a stale preset.

Everything except the trigger device is sentence-driven via container
`r_move_in_corridor` on the Main Agent → Base Rule Settings tab. Add
or remove devices by editing chips in the dashboard — no code changes.

Sentence classification (by text content):
  - contains 'on presence'                  → always bucket (every rising edge)
  - contains 'when home'                    → home-mode bucket (gated by s_mic_gate)
  - contains 'after delay'                  → delayed bucket (fired after_delay_sec later)
  - contains 'on cooldown end'              → cleanup bucket (fired cooldown_sec later)
  - contains 'delay is N seconds'           → sets after_delay_sec
  - contains 'cooldown is N seconds'        → sets cooldown_sec
  - contains 'when-home bucket fires when'  → sets when-home gate value (s_mic_gate)

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
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("Asia/Jerusalem")

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
# Main Door — second trigger: Awtrix fires on the door OPENING.
MAIN_DOOR_ID = '8d853479-bb87-4d2e-9350-fb8fc5c486d5'
# Entrance Presence (inside) — third trigger, used ONLY to timestamp when the
# inside sensor last fired. If it fired within the leaving-window BEFORE a
# corridor-presence event, you came from inside → LEAVING → suppress monitor/FR.
ENTRANCE_PRESENCE_ID = 'bf4d5e650d32117f49ifvb'

# Fallback knob defaults — overridden by container `r_move_in_corridor`.
DEFAULTS_COOLDOWN_SEC       = 60
DEFAULTS_AFTER_DELAY_SEC    = 3
DEFAULTS_LEAVING_WINDOW_SEC = 5   # entrance-before-corridor window → "leaving"

# Cache parsed config for 30 s to avoid hitting the DB on every event.
# Sentence edits land via dashboard save → 30 s max before the rule
# picks them up. Same pattern as other sentence-driven rules.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Move in Corridor",
    "description": "When someone moves in the building corridor outside your door, this turns on the corridor light and — if you're home — wakes the entrance screen, shows a welcome on the Pixoo, and starts face recognition. It skips the welcome and recognition when you're on your way out.",
    "triggers": [CORRIDOR_PRESENCE_ID, MAIN_DOOR_ID, ENTRANCE_PRESENCE_ID],
    "controls": [],
    "category": "control",
    # OWN group (NOT 'corridor') on purpose: the Corridor Transit Classifier (also
    # 'corridor') now RETURNS a command (press HOME) on a door-confirmed To_Home,
    # which would claim the 'corridor' group and group-skip this rule on that door
    # event (Awtrix would miss on a coming-home-from-away). A distinct group avoids
    # the conflict; depends_on still orders the classifier first (global sort).
    "group": "corridor-move",
    "priority": 10,
    # depends_on Corridor Transit Classifier so it runs FIRST on every corridor
    # presence event and `state.shared['corridor_transit.mode']` is up-to-date
    # when this rule reads it below.
    "depends_on": ["Mode Buttons", "Corridor Transit Classifier"],
    "test_event": {
        "device_id": CORRIDOR_PRESENCE_ID,
        "source": "event",
        "dps": {"1": "presence"},
    },
}


_WHEN_HOME_GATE_RE = re.compile(
    r'when-home\s+bucket\s+fires\s+when\s+home_mode\s+is\s+([a-z_]+)',
    re.IGNORECASE,
)


def _classify_sentence(text):
    """Return one of: 'always', 'when_home', 'delayed', 'cleanup',
    'knob_delay', 'knob_cooldown', 'knob_gate', or None."""
    t = (text or '').lower()
    if 'cooldown is' in t:
        return 'knob_cooldown'
    if 'leaving window is' in t:
        return 'knob_leaving'
    if 'delay is' in t:
        return 'knob_delay'
    # 'when-home bucket fires when home_mode is X' must be checked BEFORE
    # 'when home' because it also matches that substring.
    if 'when-home bucket fires' in t:
        return 'knob_gate'
    # 'on cooldown end' must be checked before 'on presence' (substring match)
    if 'on cooldown end' in t:
        return 'cleanup'
    if 'after delay' in t:
        return 'delayed'
    if 'on door open' in t:
        return 'on_door_open'                 # Awtrix — fires on Main Door OPEN
    # 'when home and arriving' must be checked BEFORE plain 'when home'.
    if 'when home' in t and 'arriving' in t:
        return 'when_home_arriving'           # Entrance Monitor — home + NOT leaving
    if 'arriving' in t:
        return 'when_arriving'                # FR screen on — NOT leaving (home or away)
    if 'when home' in t:
        return 'when_home'                    # legacy bucket (back-compat)
    if 'on presence' in t:
        return 'always'
    return None


def _in_daily_welcome_window(at_time):
    """Returns True if `at_time` (datetime, local TZ) is inside the
    Daily_Welcome rule's operating window. Reads daily_welcome.RULE
    live from sys.modules so DB overrides take effect at evaluation
    time. Falls back to 08:00-23:59 if Daily_Welcome isn't loaded.

    Window may wrap midnight (e.g. after=22:00, before=06:00) — handled
    by the `after_min > before_min` branch.
    """
    after_hhmm = '08:00'
    before_hhmm = '23:59'
    for mod in sys.modules.values():
        if mod is None:
            continue
        try:
            r = getattr(mod, 'RULE', None)
            if isinstance(r, dict) and r.get('name') == 'Daily_Welcome':
                t = r.get('conditions', {}).get('time', {}) or {}
                after_hhmm = t.get('after', after_hhmm)
                before_hhmm = t.get('before', before_hhmm)
                break
        except Exception:
            continue

    try:
        ah, am = (int(x) for x in after_hhmm.split(':'))
        bh, bm = (int(x) for x in before_hhmm.split(':'))
    except (ValueError, AttributeError):
        return False

    at_min     = at_time.hour * 60 + at_time.minute
    after_min  = ah * 60 + am
    before_min = bh * 60 + bm

    if after_min <= before_min:
        return after_min <= at_min < before_min
    # Window wraps midnight
    return at_min >= after_min or at_min < before_min


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
        'leaving_window_sec': DEFAULTS_LEAVING_WINDOW_SEC,
        'when_home_gate':  None,         # set from s_mic_gate; None → bucket disabled
        'always_cmds':     [],
        'when_home_cmds':  [],           # legacy 'when home' bucket (back-compat)
        'when_home_arriving_cmds': [],   # Entrance Monitor — home + NOT leaving
        'when_arriving_cmds':      [],   # FR screen on — NOT leaving (home or away)
        'on_door_open_cmds':       [],   # Awtrix — on Main Door open
        'delayed_cmds':    [],
        'cleanup_cmds':    [],
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
            if kind == 'knob_leaving':
                m = re.search(r'leaving window is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['leaving_window_sec'] = int(m.group(1))
                continue
            if kind == 'knob_gate':
                m = _WHEN_HOME_GATE_RE.search(full_text)
                if m:
                    cfg['when_home_gate'] = m.group(1).lower()
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
            elif kind == 'when_home_arriving':
                cfg['when_home_arriving_cmds'].extend(sentence_cmds)
            elif kind == 'when_arriving':
                cfg['when_arriving_cmds'].extend(sentence_cmds)
            elif kind == 'on_door_open':
                cfg['on_door_open_cmds'].extend(sentence_cmds)
            elif kind == 'delayed':
                cfg['delayed_cmds'].extend(sentence_cmds)
            elif kind == 'cleanup':
                cfg['cleanup_cmds'].extend(sentence_cmds)

    except Exception as e:
        log.warning("Move in Corridor: config parse failed (%s) — using defaults", e)

    _config_cache['data'] = cfg
    _config_cache['ts'] = now
    return cfg


def evaluate(event, state):
    commands = []
    dev_id = event.get('device_id', '')
    dps = event.get('dps', {}) or {}

    # ── Main Door OPEN → Awtrix (move_on_main_door) ──
    # Fires on the door's rising edge (closed → open), separate from the corridor
    # chain (no cooldown gate). "Awtrix fires only on Main Door open."
    if dev_id == MAIN_DOOR_ID:
        if 'door' not in dps:
            return commands
        is_open = bool(dps.get('door'))
        # Private (_-prefixed) so a door open/close that emits no command doesn't
        # land in the engine's changed_keys diff and bump the Runs counter
        # (rule_engine.py excludes _-keys). Matches the Entrance branch's _mic_* keys.
        prev_door = state.shared.get('_mic_last_door', False)
        state.shared['_mic_last_door'] = is_open
        if is_open and not prev_door:
            cfg = _read_config(state)
            if cfg['on_door_open_cmds']:
                commands.extend(cfg['on_door_open_cmds'])
                log.info("Move in Corridor: Main Door opened → %d on-door-open command(s) (awtrix)",
                         len(cfg['on_door_open_cmds']))
        return commands

    # ── Entrance Presence (inside) → just timestamp its rising edge ──
    # Used to detect "leaving" (inside sensor fired just before the corridor
    # sensor). Private (_-prefixed) keys so this never claims the group or
    # bumps the Runs counter.
    if dev_id == ENTRANCE_PRESENCE_ID:
        if '1' in dps:
            is_ent = dps.get('1') in ('presence', True, 'true', 1)
            prev_ent = state.shared.get('_mic_prev_entrance', 'none')
            state.shared['_mic_prev_entrance'] = 'presence' if is_ent else 'none'
            if is_ent and prev_ent != 'presence':
                state.shared['_mic_last_entrance_ts'] = time.time()
        return commands

    # Only the Corridor Presence sensor triggers the chain entry below.
    if dev_id != CORRIDOR_PRESENCE_ID:
        return commands

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

    # Read the transit mode set by Corridor Transit Classifier on the SAME
    # event (depends_on guarantees the classifier ran first). When mode is
    # Corridor_From_Home the user is leaving the apartment — no welcome,
    # no recognition, no monitoring needed. Suppress the whole monitor /
    # awtrix / FR / pixoo chain; only the ALWAYS bucket (corridor light)
    # fires so the user has light to walk out by.
    transit_mode = state.shared.get('corridor_transit.mode', 'Corridor_Clear_Home')
    # Suppress the welcome / monitor / awtrix / FR / pixoo chain when the user
    # is LEAVING. Two signals OR'd together:
    #   (a) the transit classifier reports Corridor_From_Home, OR
    #   (b) an away countdown currently owns the Pixoo — Start Away set
    #       daily_welcome.suppress_until_ts = end_ts. This catches the common
    #       leaving case where, at rising-edge time, the classifier is still at
    #       Corridor_Visit_Home (it only upgrades to From_Home a few seconds
    #       later), so without (b) the delayed FR start_recognition would fire
    #       while walking out. The Pixoo push is already blocked by the central
    #       countdown lock; (b) also skips the wasted FR + deferred dispatch.
    _away_cd = state.shared.get('daily_welcome.suppress_until_ts', 0) or 0
    try:
        away_countdown_active = float(_away_cd) > time.time()
    except (TypeError, ValueError):
        away_countdown_active = False
    # LEAVING — the inside (Entrance) sensor fired within leaving_window before this
    # corridor event = you came from inside = on the way out. This is the RELIABLE
    # leaving signal (the door lags the corridor sensor by ~0.7 s, and From_Home only
    # catches the door-then-corridor order). OR'd with From_Home + away-countdown so
    # the WHOLE chain (FR screen, Entrance Monitor, delayed Pixoo+recognition, cleanup)
    # is suppressed when leaving — only the corridor light + Awtrix are exempt.
    last_ent   = float(state.shared.get('_mic_last_entrance_ts', 0) or 0)
    is_leaving = last_ent > 0 and (time.time() - last_ent) <= cfg['leaving_window_sec']
    suppress_monitoring = (transit_mode == 'Corridor_From_Home') or away_countdown_active or is_leaving

    home_mode = state.shared.get('home_mode', '')
    gate      = cfg.get('when_home_gate')

    log.info("Move in Corridor: rising edge — leaving=%s, suppress=%s, home_mode=%s, transit=%s "
             "(always=%d, fr=%d, entrance=%d, delayed=%d, leaving_window=%ds)",
             is_leaving, suppress_monitoring, home_mode, transit_mode,
             len(cfg['always_cmds']), len(cfg['when_arriving_cmds']),
             len(cfg['when_home_arriving_cmds']), len(cfg['delayed_cmds']), cfg['leaving_window_sec'])

    # 1. ALWAYS — corridor light (every rising edge, even when leaving)
    commands.extend(cfg['always_cmds'])

    # 2. Face-Recognition screen ON — unless on the way out (leaving / From_Home / away).
    if not suppress_monitoring and cfg['when_arriving_cmds']:
        commands.extend(cfg['when_arriving_cmds'])

    # 3. Entrance Monitor Ch.2 — when HOME and not on the way out.
    if not suppress_monitoring and gate is not None and home_mode == gate and cfg['when_home_arriving_cmds']:
        commands.extend(cfg['when_home_arriving_cmds'])

    # Legacy plain 'when home' bucket — back-compat only.
    if cfg['when_home_cmds'] and gate is not None and home_mode == gate and not suppress_monitoring:
        commands.extend(cfg['when_home_cmds'])

    # 3. Delayed bucket — emit each command with `_delay_sec` so the
    #    engine's deferred-dispatch Timer fires the MQTT publish at
    #    exact wall-clock time. No pending_ts, no heartbeat polling,
    #    not sensitive to mmWave silence after the rising edge.
    #    Gated by transit mode: From_Home suppresses Pixoo welcome + FR.
    if suppress_monitoring:
        log.info("Move in Corridor: transit_mode='%s' — skipping delayed bucket (pixoo/FR start_recognition)", transit_mode)
    elif cfg['delayed_cmds'] and cfg['after_delay_sec'] > 0:
        for cmd in cfg['delayed_cmds']:
            deferred = dict(cmd)
            deferred['_delay_sec'] = cfg['after_delay_sec']
            commands.append(deferred)
        log.info("Move in Corridor: scheduled %d delayed command(s) via engine deferred dispatch in %ds",
                 len(cfg['delayed_cmds']), cfg['after_delay_sec'])

    # 4. Cleanup bucket — fires `cooldown_sec` after rising edge to
    #    restore the corridor to its idle state (FR screen off + Pixoo
    #    back to Daily_Welcome). For pixoo `push_preset` chips: substitute
    #    a `wipe` if the projected fire-time falls OUTSIDE Daily_Welcome's
    #    operating window (its `conditions.time.after..before`). Without
    #    this substitution, the LED matrix would hold a stale Daily_Welcome
    #    preset overnight after the last corridor walk-in before bedtime.
    #    Also gated by transit mode: if we suppressed the welcome chain,
    #    no cleanup needed.
    if suppress_monitoring:
        log.info("Move in Corridor: transit_mode='%s' — skipping cleanup bucket (nothing to clean up)", transit_mode)
    elif cfg['cleanup_cmds'] and cfg['cooldown_sec'] > 0:
        fire_at = datetime.now(LOCAL_TZ) + timedelta(seconds=cfg['cooldown_sec'])
        in_window = _in_daily_welcome_window(fire_at)
        n_pushed_subst = 0
        for cmd in cfg['cleanup_cmds']:
            cleanup = dict(cmd)
            if (cleanup.get('protocol') == 'pixoo'
                and cleanup.get('action') == 'push_preset'
                and not in_window):
                cleanup = {
                    'device_id': 'pixoo',
                    'protocol':  'pixoo',
                    'action':    'wipe',
                    'rule':      'Move in Corridor',
                }
                n_pushed_subst += 1
            cleanup['_delay_sec'] = cfg['cooldown_sec']
            commands.append(cleanup)
        log.info("Move in Corridor: scheduled %d cleanup command(s) at T+%ds — Daily_Welcome window: %s%s",
                 len(cfg['cleanup_cmds']), cfg['cooldown_sec'],
                 'inside' if in_window else 'outside',
                 f' ({n_pushed_subst} push→wipe)' if n_pushed_subst else '')

    return commands
