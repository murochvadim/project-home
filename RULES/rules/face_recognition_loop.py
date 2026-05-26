"""Face Recognition Loop — retry recognition + door unlock on success.

Listens to events from the face_01 ESP board (HLK TX-510 + ESP8266
bridge) and drives the post-corridor-entry recognition loop:

  • On face_unknown   — increment retry count. If < max_retries, emit
                        TWO commands: `screen_on` immediately and
                        `start_recognition` deferred by retry_delay_sec
                        (engine's `_delay_sec` Timer). The screen_on is
                        required because the FR board's display auto-
                        turns-off after each recognition cycle; without
                        it, the next start_recognition reaches a board
                        with no display and silently returns face_unknown.
                        If ≥ max_retries, clear state and give up.

  • On face_identified — clear retry state, dispatch unlock chips from
                         the s_frl1_unlock sentence (typically a chip
                         targeting the RemoteXY door-lock board).

The FIRST `start_recognition` is NOT fired by this rule — Move in
Corridor's `s_mic5_pixoo` delayed bucket already includes a
`@Face Recognition recognition on` chip that kicks off the chain
N seconds after corridor presence (N from `s_mic4_delay`). From there,
the FR board publishes either face_identified (→ this rule unlocks)
or face_unknown (→ this rule retries up to N times).

On face_unknown the rule schedules the next start_recognition with
`_delay_sec=<retry_delay>` so the engine's deferred-dispatch Timer
fires the MQTT publish that many seconds later — gives the FR board
time to complete its current cycle (screen on → scan → result →
screen off → ready) before the next command arrives. Non-blocking;
does NOT wait for the 60 s heartbeat.

Total attempts = 1 (external trigger from Move in Corridor) + N
(retries from this rule on face_unknown). With N=2 and delay=3 s
the full chain spans ~15 s end-to-end, then gives up if no
face_identified.

Sentence-driven knobs in container `r_face_recognition_loop_init`:
  • s_frl1_unlock         — chip(s) to fire on face_identified. Empty by
                            default; user adds e.g. `@RemoteXY Gate Door on`.
  • s_frl2_retries        — "Face Loop: retry recognition N times"
  • s_frl3_delay          — "Face Loop: retry delay is N seconds"
  • (any id)              — "Face Loop: door unlock is enabled" (or
                            "disabled"). Gate that prevents unlock chips
                            from firing on face_identified WITHOUT having
                            to remove the chips. Default: enabled. Use
                            "disabled" during testing / away mode.

state.shared keys owned by this rule:
  • face_recognition_loop.retry_count        — int, 0..max_retries
  • face_recognition_loop.last_face_event_ts — float epoch (debug only)
"""

import json
import logging
import os
import re
import sys
import time

log = logging.getLogger("rule.face_recognition_loop")

# RULES/ is the parent of rules/ — needed for `import _display_chips`
_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import build_devices_by_name  # noqa: E402
from _chip_resolver import resolve_chip  # noqa: E402

# Trigger device — hardcoded because RULE['triggers'] is fixed at module load.
FACE_01_ID = 'face_01'

# Defaults — overridden by container `r_face_recognition_loop_init`.
DEFAULTS_MAX_RETRIES     = 2
DEFAULTS_RETRY_DELAY_SEC = 3

# Cache parsed config for 30 s. Same pattern as other sentence-driven rules.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Face Recognition Loop",
    "description": "Retry start_recognition immediately on face_unknown; unlock door on face_identified — chips drive the unlock target",
    "triggers": [FACE_01_ID],
    "controls": [],
    "category": "control",
    "group": "corridor",
    "priority": 10,
    "depends_on": [],
    # Custom test event — a face_unknown payload that exercises the retry path.
    "test_event": {
        "device_id": FACE_01_ID,
        "source":    "event",
        "dps":       {"kind": "face_unknown", "reason": "test"},
    },
}


def _classify_sentence(text):
    t = (text or '').lower()
    if 'retry recognition' in t and 'times' in t:
        return 'knob_retries'
    if 'retry delay is' in t:
        return 'knob_delay'
    # "door unlock is enabled" / "door unlock is disabled" — gate that
    # controls whether the unlock chips fire on face_identified. Default
    # ENABLED (matches pre-2026-05-26 behavior). Add the "disabled" sentence
    # to suppress unlock during testing / away mode without removing the
    # chips themselves.
    if 'door unlock is' in t:
        return 'knob_unlock_enabled'
    if 'on recognized' in t:
        return 'unlock'
    return None


def _read_config(state):
    """Parse r_face_recognition_loop_init.
    Returns dict with: max_retries, retry_delay_sec, unlock_cmds.
    """
    now = time.time()
    if _config_cache['data'] is not None and (now - _config_cache['ts']) < _CONFIG_TTL_SEC:
        return _config_cache['data']

    cfg = {
        'max_retries':     DEFAULTS_MAX_RETRIES,
        'retry_delay_sec': DEFAULTS_RETRY_DELAY_SEC,
        'unlock_cmds':     [],
        'unlock_enabled':  True,   # gate — see _classify_sentence 'knob_unlock_enabled'
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
        container = next((c for c in containers if c.get('id') == 'r_face_recognition_loop_init'), None)
        if not container:
            raise RuntimeError("container r_face_recognition_loop_init not found")

        devices_by_name = build_devices_by_name(state.devices)

        for sentence in container.get('sentences', []):
            if not sentence.get('active', True):
                continue
            full_text = ''.join(seg.get('v', '') for seg in sentence.get('segments', []))
            kind = _classify_sentence(full_text)
            if kind is None:
                log.debug("Face Recognition Loop: sentence %r unclassified — skipping",
                          sentence.get('id'))
                continue

            if kind == 'knob_retries':
                m = re.search(r'retry recognition\s+(\d+)\s*times?', full_text, re.I)
                if m:
                    cfg['max_retries'] = int(m.group(1))
                continue
            if kind == 'knob_delay':
                m = re.search(r'retry delay is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['retry_delay_sec'] = int(m.group(1))
                continue
            if kind == 'knob_unlock_enabled':
                # Match the token after "door unlock is" — enabled/on/true → True,
                # disabled/off/false → False. Anything else → keep default True.
                m = re.search(r'door unlock is\s+(\w+)', full_text, re.I)
                if m:
                    tok = m.group(1).lower()
                    if tok in ('enabled', 'on', 'true', 'yes'):
                        cfg['unlock_enabled'] = True
                    elif tok in ('disabled', 'off', 'false', 'no'):
                        cfg['unlock_enabled'] = False
                continue

            if kind == 'unlock':
                for seg in sentence.get('segments', []):
                    if seg.get('t') != 'dev':
                        continue
                    cmd = resolve_chip(seg.get('v', ''), devices_by_name, 'Face Recognition Loop')
                    if cmd:
                        cfg['unlock_cmds'].append(cmd)

    except Exception as e:
        log.warning("Face Recognition Loop: config parse failed (%s) — using defaults", e)

    _config_cache['data'] = cfg
    _config_cache['ts'] = now
    return cfg


def evaluate(event, state):
    commands = []
    dev_id = event.get('device_id', '')

    if dev_id != FACE_01_ID:
        return commands

    dps = event.get('dps', {}) or {}
    kind = dps.get('kind', '')

    if kind not in ('face_unknown', 'face_identified'):
        return commands

    cfg = _read_config(state)
    state.shared['face_recognition_loop.last_face_event_ts'] = time.time()

    if kind == 'face_identified':
        prev_count = state.shared.get('face_recognition_loop.retry_count', 0)
        state.shared['face_recognition_loop.retry_count'] = 0
        user = dps.get('user_name') or dps.get('payload') or '?'
        if not cfg['unlock_cmds']:
            log.info("Face Recognition Loop: face_identified (%s) after %d retries — but no unlock chips configured (empty s_frl1_unlock)",
                     user, prev_count)
            return commands
        if not cfg['unlock_enabled']:
            log.info("Face Recognition Loop: face_identified (%s) after %d retries — UNLOCK DISABLED via sentence ('door unlock is disabled') — dropping %d command(s)",
                     user, prev_count, len(cfg['unlock_cmds']))
            return commands
        log.info("Face Recognition Loop: face_identified (%s) after %d retries — dispatching %d unlock command(s)",
                 user, prev_count, len(cfg['unlock_cmds']))
        commands.extend(cfg['unlock_cmds'])
        return commands

    # kind == 'face_unknown' — schedule retry: screen_on now + start_recognition deferred.
    count = int(state.shared.get('face_recognition_loop.retry_count', 0))
    count += 1
    state.shared['face_recognition_loop.retry_count'] = count

    if count > cfg['max_retries']:
        log.info("Face Recognition Loop: face_unknown — gave up after %d attempts (max=%d)",
                 count - 1, cfg['max_retries'])
        state.shared['face_recognition_loop.retry_count'] = 0
        return commands

    log.info("Face Recognition Loop: face_unknown — scheduling retry %d/%d "
             "(screen_on now + start_recognition in %ds)",
             count, cfg['max_retries'], cfg['retry_delay_sec'])

    # Screen turns off after each recognition cycle on the FR board; without
    # an explicit screen_on the next start_recognition reaches a board with
    # no display and returns face_unknown immediately. Fire screen_on first
    # (immediate), then defer start_recognition so the screen has time to
    # wake up before scanning.
    commands.append({
        "device_id":         FACE_01_ID,
        "protocol":          "esp",
        "action":            "turn_on",
        "channel":           "screen",
        "rule":              "Face Recognition Loop",
        "_skip_loop_guard":  True,
    })
    commands.append({
        "device_id":         FACE_01_ID,
        "protocol":          "esp",
        "action":            "turn_on",
        "channel":           "recognition",
        "rule":              "Face Recognition Loop",
        "_skip_loop_guard":  True,
        "_delay_sec":        cfg['retry_delay_sec'],
    })
    return commands
