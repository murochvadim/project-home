"""Start Away Mode — staged actions when home_mode transitions to the
trigger mode declared in s_sa7 (typically `away`).

Sentence-driven via the dashboard "Start Away Mode" container. Sentences:

  s_sa1: Start Away: away scene is <SceneName>
         (name of a Scene from Main Agent → Scenes; its device on/off list is
          RUN on entry — replaces the old "turn off all lights and tvs" bulk-off
          by device_type. Explicit, curated, no blast radius.)

  s_sa2: Start Away: device set ON is @<DeviceChip>
         (the single fake-presence device — chip appended via +Dev)

  s_sa3: Start Away: keep on for 90 seconds
         (duration X — accepts seconds | minutes | hours, integer or decimal)

  s_sa4: Start Away: initial preset is @<DisplayChip>
         (Pixoo/Awtrix preset pushed at entry — vars include live {{countdown}})

  s_sa5: Start Away: final preset is @<DisplayChip>
         (pushed when X elapses)

  s_sa7: Start Away: fires when home_mode is away
         (the trigger mode)

State machine (per home period):

  idle  ──home_mode just entered <trigger>──→  phase1
                                                · RUN the s_sa1 Scene (its device
                                                  on/off list), skipping the keep-on
                                                · turn_on s_sa2 device
                                                · dispatch s_sa4 cmd (+countdown)
                                                · start timer start_away_t0
  phase1 ──elapsed ≥ X, still in trigger────→  phase2
                                                · turn_off s_sa2 device
                                                · dispatch s_sa5 cmd
  any   ──home_mode leaves <trigger>────────→  idle (latch reset)

If the s_sa1 Scene is missing/empty, Phase 1 is a safe NO-OP (warning) — there is
NO fallback to the old device-type bulk-off, so the blast radius is gone by
construction (only the scene's explicit devices are ever touched).

`prev_home` non-empty guard prevents a false-fire right after a rule-engine
restart. Trigger is heartbeat (60 s).

Companion:
- mode_buttons.py — sole writer of state.shared['home_mode']; depends_on it.
- _scenes.py — load_scene (existence check) + device-chip resolution. The
  scene's per-device dispatch is handled by the engine's run_scene (Phase 1
  emits {action:'run_scene'}), not expand_scene here.
- _display_chips.parse_display_chip — resolves the s_sa4/s_sa5 display chips.
"""

import json
import logging
import os
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

# RULES/ is the parent of rules/ — on sys.path so `import _scenes` /
# `_display_chips` work under the engine's importlib loader.
_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import parse_display_chip, build_devices_by_name  # noqa: E402
from _scenes import load_scene, build_devices_by_name_desc, parse_dev_chip  # noqa: E402

log = logging.getLogger('rule.start_away_mode')

_TZ = ZoneInfo('Asia/Jerusalem')

# Sentence anchors — case-insensitive, tolerant of surrounding text.
_SCENE_RE     = re.compile(r'start\s+away:\s*(?:away\s+)?scene\s+is\s+(.+)', re.IGNORECASE)
_DEVICE_RE    = re.compile(r'start\s+away:\s*device\s+set\s+on\s+is\b', re.IGNORECASE)
_DURATION_RE  = re.compile(
    r'start\s+away:\s*keep\s+on.*?for\s+(\d+(?:\.\d+)?)\s*(sec|second|seconds|min|minute|minutes|hr|hour|hours)',
    re.IGNORECASE,
)
_INIT_RE      = re.compile(r'start\s+away:\s*initial\s+preset\s+is\s+(.+)', re.IGNORECASE)
_FINAL_RE     = re.compile(r'start\s+away:\s*final\s+preset\s+is\s+(.+)', re.IGNORECASE)
# Trigger-mode sentence (s_sa7) — names which home_mode value the rule reacts to.
_TRIGGER_MODE_RE = re.compile(
    r'start\s+away:\s*fires\s+when\s+home_mode\s+is\s+([a-z_]+)',
    re.IGNORECASE,
)


# Mode-button device (8 Gang Switch — HOME=DPS4 / AWAY=DPS8 / ABROAD=DPS3).
# Start Away triggers on it so Phase 1 fires in the SAME event cycle as the
# button press (~1 s) instead of waiting up to 60 s for the next heartbeat tick.
# Mode Buttons (depends_on) runs first in that cycle and sets home_mode, so this
# rule sees the fresh value. Heartbeat stays a trigger for Phase 2 (countdown →
# keep-on off) and as a fallback. If the mode buttons ever move to a different
# device, update this id; the heartbeat fallback still catches it within 60 s.
_MODE_BUTTON_DEVICE_ID = 'bf85e819855d686918q6hz'


RULE = {
    "name":        "Start Away Mode",
    "description": "When the house switches to Away mode, this runs your Away scene (turning off the lights, TVs and other devices you chose), then turns on one 'fake presence' device for a set time so the home still looks occupied, and shows a countdown on the display. When the time runs out it turns that device back off and shows the final display.",
    "triggers":    ["heartbeat", _MODE_BUTTON_DEVICE_ID],
    "controls":    [],
    "category":    "control",
    "group":       "away",
    "priority":    10,
    "depends_on":  ["Mode Buttons"],
}


# ─────────────────────────── Helpers ───────────────────────────

def _sentence_text(s):
    segs = s.get('segments')
    if isinstance(segs, list) and segs:
        return ''.join((seg or {}).get('v', '') for seg in segs)
    return s.get('text') or ''


def _iter_dev_chips(sentence):
    segs = sentence.get('segments')
    if not isinstance(segs, list):
        return []
    out = []
    for seg in segs:
        if isinstance(seg, dict) and (seg.get('t') or '').lower() == 'dev':
            v = seg.get('v') or ''
            if v.startswith('@'):
                out.append(v)
    return out


def _read_container(state):
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ('apartment.rule_sentences',),
    )
    if not rows:
        return None
    raw = rows[0][0]
    if isinstance(raw, str):
        try:
            rules = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            log.warning("start_away_mode: rule_sentences not valid JSON")
            return None
    elif isinstance(raw, list):
        rules = raw
    else:
        return None
    for r in rules or []:
        if not r.get('active'):
            continue
        if (r.get('name') or '').strip().lower() == 'start away mode':
            return r
    return None


def _parse_config(state, container):
    """Parse the sentences. Returns dict; missing fields → None.

    `scene_name` names the Scene to run on entry; `initial_cmd`/`final_cmd` are
    full command dicts produced by parse_display_chip (s_sa4/s_sa5).
    """
    cfg = {
        'scene_name':      None,
        'keep_on_target':  None,
        'keep_on_sec':     None,
        'initial_cmd':     None,
        'final_cmd':       None,
        'trigger_mode':    None,
    }
    if not container:
        return cfg
    devices_by_name_desc = build_devices_by_name_desc(state.devices)
    devices_by_name      = build_devices_by_name(state.devices)
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)

        # Scene sentence (s_sa1): a "@scene <Name>" chip (preferred — picked from
        # the device-picker so renaming/swapping is a click) OR plain text
        # "away scene is <Name>" (back-compat).
        m = _SCENE_RE.search(text)
        if m:
            scene_chip = None
            for chip in _iter_dev_chips(s):
                if chip.lower().startswith('@scene '):
                    scene_chip = chip[len('@scene '):].strip()
                    break
            cfg['scene_name'] = scene_chip or m.group(1).strip()
            continue

        # Trigger-mode sentence (s_sa7).
        m = _TRIGGER_MODE_RE.search(text)
        if m:
            cfg['trigger_mode'] = m.group(1).lower()
            continue

        # Device-set-ON (keep-on) sentence (s_sa2): the chip is the fake-presence target.
        if _DEVICE_RE.search(text):
            chips = _iter_dev_chips(s)
            if chips:
                parsed = parse_dev_chip(chips[0], devices_by_name_desc)
                if parsed:
                    cfg['keep_on_target'] = parsed
            continue

        # Duration sentence (s_sa3).
        m = _DURATION_RE.search(text)
        if m:
            duration = float(m.group(1))
            unit = m.group(2).lower()
            if unit.startswith('sec'):
                cfg['keep_on_sec'] = duration
            elif unit.startswith('min'):
                cfg['keep_on_sec'] = duration * 60
            else:
                cfg['keep_on_sec'] = duration * 3600
            continue

        # Initial / final preset sentences (s_sa4 / s_sa5).
        if _INIT_RE.search(text):
            chips = _iter_dev_chips(s)
            if chips:
                cfg['initial_cmd'] = parse_display_chip(chips[0], devices_by_name)
            continue
        if _FINAL_RE.search(text):
            chips = _iter_dev_chips(s)
            if chips:
                cfg['final_cmd'] = parse_display_chip(chips[0], devices_by_name)
            continue
    return cfg


def _config_ok(cfg):
    return (
        bool(cfg['scene_name']) and
        cfg['keep_on_target'] is not None and
        cfg['keep_on_sec'] is not None and
        cfg['initial_cmd'] is not None and
        cfg['final_cmd'] is not None and
        cfg['trigger_mode'] is not None
    )


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Fire on the heartbeat (Phase 2 timing + fallback) OR on a mode-button
    # event (instant Phase 1 — Mode Buttons ran first this cycle and set
    # home_mode). Any other device event is ignored.
    if event.get('device_id') not in ('heartbeat', _MODE_BUTTON_DEVICE_ID):
        return []

    container = _read_container(state)
    if container is None:
        return []
    cfg = _parse_config(state, container)

    home_mode = state.shared.get('home_mode', '')
    prev_home = state.shared.get('_start_away_prev_home_mode', '')
    phase     = state.shared.get('_start_away_phase', 'idle')
    trigger   = cfg.get('trigger_mode')

    # Reset latch when home_mode leaves the trigger mode.
    if trigger is not None and prev_home == trigger and home_mode != trigger:
        was_phase1 = (phase == 'phase1')
        state.shared['_start_away_phase'] = 'idle'
        state.shared['_start_away_prev_home_mode'] = home_mode
        if was_phase1:
            # Returned home before the countdown finished — release the Pixoo
            # reservation + clear the Daily_Welcome hold so the welcome/idle
            # screen can take over immediately instead of waiting out the lock.
            state.shared['daily_welcome.suppress_until_ts'] = 0
            log.info("start_away_mode: left trigger mid-countdown — releasing Pixoo lock")
            return [{'device_id': 'pixoo', 'action': 'unlock', 'rule': 'Start Away Mode'}]
        return []

    state.shared['_start_away_prev_home_mode'] = home_mode

    if not _config_ok(cfg):
        return []

    # `prev_home` non-empty guard — no spurious Phase 1 right after restart.
    home_just_entered = (prev_home
                        and prev_home != trigger
                        and home_mode == trigger)

    commands = []

    # ── Phase 1 — entry into trigger mode ──
    if phase == 'idle' and home_just_entered:
        if not load_scene(state, cfg['scene_name']):
            # SAFETY: no scene → do nothing. NO fallback to the old bulk-off.
            log.warning("start_away_mode: scene %r missing/empty — Phase 1 NO-OP "
                        "(no bulk-off fallback)", cfg['scene_name'])
            return []

        keep_dev_id, keep_dps = cfg['keep_on_target']

        # Run the whole Away scene off-thread via the engine's async run_scene
        # (ONE command — Start Away is freed instantly; the scene's per-device
        # dispatch happens on the engine's run_scene thread). The keep-on turn_on
        # is DEFERRED a few seconds so it lands AFTER the async scene — so even if
        # the scene turns the keep-on's channel off, the fake-presence device
        # ends ON (replaces the old in-line "skip the keep-on channel" logic).
        commands.append({'action': 'run_scene', 'scene': cfg['scene_name'], 'rule': 'Start Away Mode'})
        kc = {'device_id': keep_dev_id, 'action': 'turn_on', 'rule': 'Start Away Mode', '_delay_sec': 4}
        if keep_dps is not None:
            kc['channel'] = keep_dps
        commands.append(kc)

        # Initial preset + {{countdown}} (push_preset only) + Daily_Welcome hold.
        end_ts = datetime.now(_TZ).timestamp() + cfg['keep_on_sec']
        initial = {**cfg['initial_cmd'], 'rule': 'Start Away Mode'}
        if initial.get('action') == 'push_preset':
            initial['vars'] = {**(initial.get('vars') or {}), 'countdown': end_ts}
        commands.append(initial)
        # Hold Daily_Welcome's 30-min re-push so it can't clobber the countdown.
        if initial.get('action') == 'push_preset' and initial.get('device_id') == 'pixoo':
            state.shared['daily_welcome.suppress_until_ts'] = end_ts

        state.set_timer('start_away_t0')
        state.shared['_start_away_phase'] = 'phase1'
        log.info(
            "start_away_mode: phase1 fired (trigger=%s scene=%r via run_scene total=%d "
            "keep_on=%s for %.0f sec initial=%s final=%s)",
            trigger, cfg['scene_name'], len(commands),
            cfg['keep_on_target'], cfg['keep_on_sec'],
            cfg['initial_cmd'].get('preset_name') or cfg['initial_cmd'].get('action'),
            cfg['final_cmd'].get('preset_name') or cfg['final_cmd'].get('action'),
        )
        return commands

    # ── Phase 2 — countdown elapsed, still in trigger mode ──
    if phase == 'phase1' and home_mode == trigger:
        elapsed_sec = state.get_timer('start_away_t0')
        if elapsed_sec >= cfg['keep_on_sec']:
            keep_dev_id, keep_dps = cfg['keep_on_target']
            cmd = {'device_id': keep_dev_id, 'action': 'turn_off', 'rule': 'Start Away Mode'}
            if keep_dps is not None:
                cmd['channel'] = keep_dps
            commands.append(cmd)
            # force:true releases the countdown lock + guarantees the final
            # preset lands even if the lock hasn't auto-expired yet (race-safe).
            commands.append({**cfg['final_cmd'], 'rule': 'Start Away Mode', 'force': True})
            state.shared['_start_away_phase'] = 'phase2'
            log.info(
                "start_away_mode: phase2 fired (elapsed=%.0f sec final=%s)",
                elapsed_sec,
                cfg['final_cmd'].get('preset_name') or cfg['final_cmd'].get('action'),
            )
            return commands

    return []
