"""Face Recognition Loop — retry recognition + door unlock on success.

Listens to events from the face_01 ESP board (HLK TX-510 + ESP8266
bridge) and drives the post-corridor-entry recognition loop:

  • On face_unknown   — increment retry count. If < max_retries, schedule
                        another `start_recognition` after retry_delay_sec.
                        If ≥ max_retries, clear state and give up.

  • On face_identified — clear retry state, dispatch unlock chips from
                         the s_frl1_unlock sentence (typically a chip
                         targeting the RemoteXY door-lock board).

  • On heartbeat       — check the pending-retry timestamp; if due, fire
                         the scheduled start_recognition.

The FIRST `start_recognition` is NOT fired by this rule — Move in
Corridor's `s_mic5_pixoo` delayed bucket already includes a
`@Face Recognition recognition on` chip that kicks off the chain 2 s
after corridor presence. From there, the FR board publishes either
face_identified (→ this rule unlocks) or face_unknown (→ this rule
retries up to N times).

Decoupling from Move in Corridor lets other entry points reuse the
same recognition retry + unlock chain in the future (e.g. doorbell-
triggered recognition, manual dashboard kick-off).

Sentence-driven knobs in container `r_face_recognition_loop_init`:
  • s_frl1_unlock   — chip(s) to fire on face_identified. Empty by
                      default; user adds e.g. `@RemoteXY Gate Door on`.
  • s_frl2_retries  — "Face Loop: retry recognition N times"
  • s_frl3_delay    — "Face Loop: retry delay is N seconds"

Trigger device (FACE_01_ID) is hardcoded because RULE['triggers'] is
fixed at module load. start_recognition target is the same device
(face_01) so it's also hardcoded. Output devices (door, future
auxiliary actions) are sentence-driven.

state.shared keys owned by this rule:
  • face_recognition_loop.retry_count        — int, 0..max_retries
  • face_recognition_loop.pending_retry_ts   — float epoch, 0 = no pending
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
DEFAULTS_MAX_RETRIES     = 3
DEFAULTS_RETRY_DELAY_SEC = 2

# Cache parsed config for 30 s. Same pattern as other sentence-driven rules.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Face Recognition Loop",
    "description": "Retry start_recognition on face_unknown; unlock door on face_identified — chips drive the unlock target",
    "triggers": [FACE_01_ID, "heartbeat"],
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


def _try_fire_pending_retry(state):
    """If a scheduled retry is due, return the start_recognition command.
    Uses falsy sentinels (not pop) — same pattern as move_in_corridor.
    """
    ts = state.shared.get('face_recognition_loop.pending_retry_ts')
    if not ts:
        return None
    if time.time() < float(ts):
        return None
    state.shared['face_recognition_loop.pending_retry_ts'] = 0
    log.info("Face Recognition Loop: firing scheduled retry start_recognition")
    return {
        "device_id": FACE_01_ID,
        "protocol":  "esp",
        "action":    "turn_on",
        "channel":   "recognition",
        "rule":      "Face Recognition Loop",
        "_skip_loop_guard": True,
    }


def evaluate(event, state):
    commands = []
    dev_id = event.get('device_id', '')

    # Fire scheduled retry on any wake-up (heartbeat or face_01 event).
    pending = _try_fire_pending_retry(state)
    if pending:
        commands.append(pending)

    # Only face_01's own events drive the state machine.
    if dev_id != FACE_01_ID:
        return commands

    dps = event.get('dps', {}) or {}
    kind = dps.get('kind', '')

    if kind not in ('face_unknown', 'face_identified'):
        # Other face_01 events (ack, fr_ack, status, etc.) — ignore.
        return commands

    cfg = _read_config(state)
    state.shared['face_recognition_loop.last_face_event_ts'] = time.time()

    if kind == 'face_identified':
        # Success — clear retry state and dispatch unlock chips.
        prev_count = state.shared.get('face_recognition_loop.retry_count', 0)
        state.shared['face_recognition_loop.retry_count']     = 0
        state.shared['face_recognition_loop.pending_retry_ts'] = 0
        user = dps.get('user_name') or dps.get('payload') or '?'
        if cfg['unlock_cmds']:
            log.info("Face Recognition Loop: face_identified (%s) after %d retries — dispatching %d unlock command(s)",
                     user, prev_count, len(cfg['unlock_cmds']))
            commands.extend(cfg['unlock_cmds'])
        else:
            log.info("Face Recognition Loop: face_identified (%s) after %d retries — but no unlock chips configured (empty s_frl1_unlock)",
                     user, prev_count)
        return commands

    # kind == 'face_unknown' — schedule a retry, up to max_retries.
    count = int(state.shared.get('face_recognition_loop.retry_count', 0))
    count += 1
    state.shared['face_recognition_loop.retry_count'] = count

    if count > cfg['max_retries']:
        log.info("Face Recognition Loop: face_unknown — gave up after %d attempts (max=%d)",
                 count - 1, cfg['max_retries'])
        state.shared['face_recognition_loop.retry_count']      = 0
        state.shared['face_recognition_loop.pending_retry_ts'] = 0
        return commands

    fire_at = time.time() + cfg['retry_delay_sec']
    state.shared['face_recognition_loop.pending_retry_ts'] = fire_at
    log.info("Face Recognition Loop: face_unknown — scheduling retry %d/%d in %ds",
             count, cfg['max_retries'], cfg['retry_delay_sec'])
    return commands
