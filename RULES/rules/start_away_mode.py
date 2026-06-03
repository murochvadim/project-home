"""Start Away Mode — staged actions when home_mode transitions to the
trigger mode declared in s_sa7 (typically `away`).

Sentence-driven via the dashboard "Start Away Mode" container. Seven sentences:

  s_sa1: Start Away: turn off all lights and tvs
         (which device-type families to switch OFF on entry)

  s_sa2: Start Away: device set ON is @<DeviceChip>
         (the single fake-presence device — chip appended via +Dev)

  s_sa3: Start Away: keep on for 90 seconds
         (duration X — accepts seconds | minutes | hours, integer or decimal)

  s_sa4: Start Away: initial preset is @<DisplayChip>
         (Pixoo/Awtrix preset pushed at entry — vars include live
          {{countdown}} token if action is push_preset. Chip drives WHICH
          device gets the command — Pixoo, Awtrix, HASP, Alexa, anything
          parse_display_chip recognizes.)

  s_sa5: Start Away: final preset is @<DisplayChip>
         (Pushed when X elapses — same chip flexibility as s_sa4)

  s_sa6_exclude: Start Away: do not turn off @<Chip1>, @<Chip2>, …
         (device IDs to PROTECT from Phase 1's bulk-OFF, e.g. fridge,
          security camera, router. Per-device granularity — a chip on
          one channel of a multi-gang switch excludes the whole device.
          Empty/missing sentence = no exclusions.)

  s_sa7: Start Away: fires when home_mode is away
         (the trigger mode — replaces hardcoded literal. If absent or
          names an unknown mode, rule is a safe no-op.)

State machine (per home period):

  idle  ──home_mode just entered <trigger>──→  phase1
                                                · turn_off all matching device_types
                                                · turn_on s_sa2 device
                                                · dispatch s_sa4 cmd (with countdown var if push_preset)
                                                · start timer start_away_t0

  phase1 ──elapsed ≥ X sec, still in trigger──→ phase2
                                                · turn_off s_sa2 device
                                                · dispatch s_sa5 cmd

  any   ──home_mode leaves <trigger>────────→  idle (latch reset; eligible to refire)

  phase1 ──trigger pressed again────────────→  phase1 (latched, no refire)

`prev_home` non-empty guard on the entry trigger prevents a false-fire
right after a rule-engine restart, where the persisted state defaults
to empty and would otherwise look like a transition.

If the configuration is incomplete (any of the 6 fields unparsed), the rule
is a safe no-op. Trigger is heartbeat (60 s) so transitions and the
phase-2 timeout are caught within ≤ 60 s.

Companion rules:
- mode_buttons.py — sole writer of state.shared['home_mode'], rule depends_on it.

Companion modules:
- _display_chips.parse_display_chip — resolves @<Display>/@<Panel>/@<Alexa>
  chips in s_sa4 / s_sa5 to complete command dicts.
"""

import json
import logging
import os
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

# RULES/ is the parent of rules/ — needed for `import _display_chips` since
# rule files are loaded via importlib.util but share sys.path with the engine.
_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import parse_display_chip, build_devices_by_name  # noqa: E402

log = logging.getLogger('rule.start_away_mode')

_TZ = ZoneInfo('Asia/Jerusalem')

# Map common English words in s_sa1 to actual device_type values seen in
# state.devices. Add aliases here as new device categories arrive.
DEVICE_TYPE_ALIASES = {
    'lights': ('light', 'switch', 'circuit_breaker'),
    'light':  ('light', 'switch', 'circuit_breaker'),
    'tvs':    ('tv', 'media_player', 'samsung_tv'),
    'tv':     ('tv', 'media_player', 'samsung_tv'),
    'media':  ('media_player', 'tv'),
}

# Sentence anchors — case-insensitive, tolerant of surrounding text.
_OFF_SCOPE_RE = re.compile(r'start\s+away:\s*turn\s+off\s+all\s+(.+)', re.IGNORECASE)
# Two separate sentences for device and duration — cleaner UX (chip lands at
# end of the device sentence; duration is a plain number with unit anywhere).
_DEVICE_RE    = re.compile(r'start\s+away:\s*device\s+set\s+on\s+is\b', re.IGNORECASE)
_DURATION_RE  = re.compile(
    r'start\s+away:\s*keep\s+on.*?for\s+(\d+(?:\.\d+)?)\s*(sec|second|seconds|min|minute|minutes|hr|hour|hours)',
    re.IGNORECASE,
)
_INIT_RE      = re.compile(r'start\s+away:\s*initial\s+preset\s+is\s+(.+)', re.IGNORECASE)
_FINAL_RE     = re.compile(r'start\s+away:\s*final\s+preset\s+is\s+(.+)', re.IGNORECASE)
# Exclude sentence — chips listed after the phrase get protected from the
# Phase 1 bulk-OFF. Match phrasing flexibly: "do not turn off" / "don't
# turn off" / "do not touch" / "do not switch off". One device chip is
# enough to activate; multiple chips comma-separated all get excluded.
_EXCLUDE_RE   = re.compile(r"start\s+away:\s*do(?:n['']t|\s+not)\s+(?:turn\s+off|switch\s+off|touch)", re.IGNORECASE)
# Trigger-mode sentence (s_sa7) — names which home_mode value the rule
# reacts to. No hardcoded `'away'` literal in code.
_TRIGGER_MODE_RE = re.compile(
    r'start\s+away:\s*fires\s+when\s+home_mode\s+is\s+([a-z_]+)',
    re.IGNORECASE,
)


RULE = {
    "name":        "Start Away Mode",
    "description": "On entering the s_sa7 trigger mode: off s_sa1 device types (s_sa6 exclusions kept on), turn on s_sa2 device for s_sa3 duration, dispatch s_sa4 cmd with countdown, dispatch s_sa5 cmd after countdown.",
    "triggers":    ["heartbeat"],
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


def _build_devices_by_name_desc(state_devices):
    by_name = {}
    for dev_id, dev in state_devices.items():
        name = (dev.get('name') or '').strip()
        if not name:
            continue
        merged = dict(dev)
        merged['id'] = dev_id
        by_name[name] = merged
    return sorted(by_name.items(), key=lambda kv: len(kv[0]), reverse=True)


def _parse_dev_chip(chip_value, devices_by_name_desc):
    if not chip_value or not chip_value.startswith('@'):
        return None
    text = chip_value[1:].strip()
    if not text:
        return None
    for name, dev in devices_by_name_desc:
        if text == name:
            return (dev['id'], None)
        if text.startswith(name + ' '):
            label = text[len(name) + 1:].strip()
            dps_labels = dev.get('dps_labels') or {}
            for dps_key, dps_label in dps_labels.items():
                if dps_label == label:
                    return (dev['id'], dps_key)
            return (dev['id'], None)
    return None


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
    """Parse the 7 (or fewer) sentences. Returns dict; missing fields → None.

    `initial_cmd` and `final_cmd` are full command dicts produced by
    parse_display_chip — they carry their own device_id + protocol +
    action + (optional) preset_name + (optional) channel/page_num/etc.
    No hardcoded display device in this rule's dispatch.
    """
    cfg = {
        'off_types':       set(),
        'exclude_ids':     set(),
        'keep_on_target':  None,
        'keep_on_sec':     None,
        'initial_cmd':     None,
        'final_cmd':       None,
        'trigger_mode':    None,
    }
    if not container:
        return cfg
    devices_by_name_desc = _build_devices_by_name_desc(state.devices)
    devices_by_name      = build_devices_by_name(state.devices)
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)

        m = _OFF_SCOPE_RE.search(text)
        if m:
            rest = m.group(1).lower()
            for w in re.findall(r'[a-z_]+', rest):
                if w in DEVICE_TYPE_ALIASES:
                    cfg['off_types'].update(DEVICE_TYPE_ALIASES[w])
            continue

        # Trigger-mode sentence (s_sa7). Plain-text only, no chips.
        m = _TRIGGER_MODE_RE.search(text)
        if m:
            cfg['trigger_mode'] = m.group(1).lower()
            continue

        # Exclude sentence: any chip(s) here are added to the per-device
        # protection set so Phase 1's bulk-OFF loop skips them. Checked
        # BEFORE _DEVICE_RE because both sentences carry @<chip> segments
        # — without the explicit early branch, an excluded-device chip
        # would be misread as the keep-on target.
        if _EXCLUDE_RE.search(text):
            for chip in _iter_dev_chips(s):
                parsed = _parse_dev_chip(chip, devices_by_name_desc)
                if parsed:
                    cfg['exclude_ids'].add(parsed[0])
            continue

        # Device-set-ON sentence: any chip in the sentence is the keep-on target.
        if _DEVICE_RE.search(text):
            chips = _iter_dev_chips(s)
            if chips:
                parsed = _parse_dev_chip(chips[0], devices_by_name_desc)
                if parsed:
                    cfg['keep_on_target'] = parsed
            continue

        # Duration sentence: extract the magnitude + unit anywhere in the sentence.
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

        # Initial preset / final preset sentences — chip parsed via the
        # shared display-chip parser. Cmd dict carries device + action info.
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
        bool(cfg['off_types']) and
        cfg['keep_on_target'] is not None and
        cfg['keep_on_sec'] is not None and
        cfg['initial_cmd'] is not None and
        cfg['final_cmd'] is not None and
        cfg['trigger_mode'] is not None
    )


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    if event.get('device_id') != 'heartbeat':
        return []

    container = _read_container(state)
    if container is None:
        return []
    cfg = _parse_config(state, container)

    home_mode = state.shared.get('home_mode', '')
    prev_home = state.shared.get('_start_away_prev_home_mode', '')
    phase     = state.shared.get('_start_away_phase', 'idle')
    trigger   = cfg.get('trigger_mode')

    # Reset latch when home_mode leaves the trigger mode (e.g. user
    # presses HOME after being AWAY). Only runs when trigger_mode is set.
    if trigger is not None and prev_home == trigger and home_mode != trigger:
        phase = 'idle'
        state.shared['_start_away_phase'] = 'idle'

    # Persist prev for next tick (always).
    state.shared['_start_away_prev_home_mode'] = home_mode

    # Need full config to act. Update phase tracking; emit nothing.
    if not _config_ok(cfg):
        return []

    # `prev_home` non-empty guard prevents a spurious Phase 1 right after
    # rule-engine restart, where the persisted state hasn't re-seeded yet
    # and prev_home defaults to '' (≠ trigger → would fire).
    home_just_entered = (prev_home
                        and prev_home != trigger
                        and home_mode == trigger)

    commands = []

    # ── Phase 1 — entry into trigger mode ──
    if phase == 'idle' and home_just_entered:
        keep_dev_id, keep_dps = cfg['keep_on_target']

        # Turn OFF every device whose device_type matches the s_sa1 set,
        # EXCEPT (1) the keep-on device itself and (2) any device id listed
        # in the s_sa6 exclude sentence (e.g. fridge, security cameras).
        skipped = []
        for dev_id, dev in state.devices.items():
            if dev_id == keep_dev_id:
                continue
            if dev_id in cfg['exclude_ids']:
                skipped.append(dev.get('name') or dev_id)
                continue
            if (dev.get('device_type') or '') in cfg['off_types']:
                commands.append({
                    'device_id': dev_id,
                    'action':    'turn_off',
                    'rule':      'Start Away Mode',
                })
        if skipped:
            log.info("start_away_mode: phase1 excluded %d device(s) from bulk-off: %s",
                     len(skipped), ', '.join(skipped))

        # Turn ON the keep-on target.
        cmd = {
            'device_id': keep_dev_id,
            'action':    'turn_on',
            'rule':      'Start Away Mode',
        }
        if keep_dps is not None:
            cmd['channel'] = keep_dps
        commands.append(cmd)

        # Dispatch the s_sa4 chip's command (Pixoo/Awtrix/HASP/Alexa —
        # whatever the chip resolved to). For push_preset actions, inject
        # the `{{countdown}}` substitution var so the display can render
        # a live countdown to phase 2. Non-preset actions (power_on,
        # announce_template, page-nav etc.) get no vars injection.
        end_ts = datetime.now(_TZ).timestamp() + cfg['keep_on_sec']
        initial = {**cfg['initial_cmd'], 'rule': 'Start Away Mode'}
        if initial.get('action') == 'push_preset':
            initial['vars'] = {**(initial.get('vars') or {}), 'countdown': end_ts}
        commands.append(initial)

        state.set_timer('start_away_t0')
        state.shared['_start_away_phase'] = 'phase1'

        log.info(
            "start_away_mode: phase1 fired (trigger=%s off_types=%s keep_on=%s for %.0f sec initial=%s final=%s)",
            trigger, sorted(cfg['off_types']), cfg['keep_on_target'], cfg['keep_on_sec'],
            cfg['initial_cmd'].get('preset_name') or cfg['initial_cmd'].get('action'),
            cfg['final_cmd'].get('preset_name') or cfg['final_cmd'].get('action'),
        )
        return commands

    # ── Phase 2 — countdown elapsed, still in trigger mode ──
    if phase == 'phase1' and home_mode == trigger:
        elapsed_sec = state.get_timer('start_away_t0')
        if elapsed_sec >= cfg['keep_on_sec']:
            keep_dev_id, keep_dps = cfg['keep_on_target']
            cmd = {
                'device_id': keep_dev_id,
                'action':    'turn_off',
                'rule':      'Start Away Mode',
            }
            if keep_dps is not None:
                cmd['channel'] = keep_dps
            commands.append(cmd)

            commands.append({**cfg['final_cmd'], 'rule': 'Start Away Mode'})

            state.shared['_start_away_phase'] = 'phase2'
            log.info(
                "start_away_mode: phase2 fired (elapsed=%.0f sec final=%s)",
                elapsed_sec,
                cfg['final_cmd'].get('preset_name') or cfg['final_cmd'].get('action'),
            )
            return commands

    return []
