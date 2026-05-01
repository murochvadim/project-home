"""Start Away Mode — staged actions when home_mode transitions to 'away'.

Sentence-driven via the dashboard "Start Away Mode" container. Five sentences:

  s_sa1: Start Away: turn off all lights and tvs
         (which device-type families to switch OFF on entry)

  s_sa2: Start Away: device set ON is @<DeviceChip>
         (the single fake-presence device — chip appended via +Dev)

  s_sa3: Start Away: keep on for 90 seconds
         (duration X — accepts seconds | minutes | hours, integer or decimal)

  s_sa4: Start Away: initial preset is <PresetName>
         (Pixoo preset pushed at entry — uses live `{{countdown}}` token)

  s_sa5: Start Away: final preset is <PresetName>
         (Pixoo preset pushed when X elapses)

State machine (per home period):

  idle  ──home_mode just entered 'away'──→  phase1
                                              · turn_off all matching device_types
                                              · turn_on s_sa2 device
                                              · push s_sa3 preset (countdown=now+X)
                                              · start timer start_away_t0

  phase1 ──elapsed ≥ X min, still away──→   phase2
                                              · turn_off s_sa2 device
                                              · push s_sa4 preset

  any   ──home_mode leaves 'away'────────→  idle (latch reset; eligible to refire)

  phase1 ──AWAY pressed again─────────────→  phase1 (latched, no refire)

If the configuration is incomplete (any of the 5 fields unparsed), the rule
is a safe no-op. Trigger is heartbeat (60 s) so transitions and the
phase-2 timeout are caught within ≤ 60 s.

Companion rules:
- mode_buttons.py — sole writer of state.shared['home_mode'], rule depends_on it.
"""

import json
import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo

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


RULE = {
    "name":        "Start Away Mode",
    "description": "On home_mode→away: off all lights+tvs, keep one device on for X min with pixoo countdown, push final preset after.",
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
    """Parse the 4 (or fewer) sentences. Returns dict; missing fields → None."""
    cfg = {
        'off_types':       set(),
        'keep_on_target':  None,
        'keep_on_sec':     None,
        'initial_preset':  None,
        'final_preset':    None,
    }
    if not container:
        return cfg
    devices_by_name_desc = _build_devices_by_name_desc(state.devices)
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

        m = _INIT_RE.search(text)
        if m:
            cfg['initial_preset'] = _extract_preset_name(s, m.group(1))
            continue

        m = _FINAL_RE.search(text)
        if m:
            cfg['final_preset'] = _extract_preset_name(s, m.group(1))
            continue
    return cfg


_PRESET_CHIP_RE = re.compile(r'^@(?P<dev>Pixoo|Awtrix)\s+(?:push\s+)?(?P<preset>.+)$', re.IGNORECASE)


def _extract_preset_name(sentence, fallback_text):
    """Pixoo presets are typically authored via @Pixoo or @Awtrix chip syntax.
    Recognized formats:
      @Pixoo <PresetName>        (legacy)
      @Pixoo push <PresetName>   (display-picker action format)
      @Awtrix push <SavedApp>    (Awtrix saved app — same shape)
    """
    chips = _iter_dev_chips(sentence)
    if chips:
        chip = chips[0]
        m = _PRESET_CHIP_RE.match(chip.strip())
        if m:
            return m.group('preset').strip()
        if chip.startswith('@'):
            return chip[1:].strip()
    return (fallback_text or '').strip()


def _config_ok(cfg):
    return (
        bool(cfg['off_types']) and
        cfg['keep_on_target'] is not None and
        cfg['keep_on_sec'] is not None and
        bool(cfg['initial_preset']) and
        bool(cfg['final_preset'])
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

    # Reset latch when home_mode leaves 'away'.
    if prev_home == 'away' and home_mode != 'away':
        phase = 'idle'
        state.shared['_start_away_phase'] = 'idle'

    # Persist prev for next tick (always).
    state.shared['_start_away_prev_home_mode'] = home_mode

    # Need full config to act. Update phase tracking; emit nothing.
    if not _config_ok(cfg):
        return []

    home_just_entered_away = (prev_home != 'away' and home_mode == 'away')

    commands = []

    # ── Phase 1 — entry into away ──
    if phase == 'idle' and home_just_entered_away:
        keep_dev_id, keep_dps = cfg['keep_on_target']

        # Turn OFF every device whose device_type matches the s_sa1 set,
        # except the kept-on device itself.
        for dev_id, dev in state.devices.items():
            if dev_id == keep_dev_id:
                continue
            if (dev.get('device_type') or '') in cfg['off_types']:
                commands.append({
                    'device_id': dev_id,
                    'action':    'turn_off',
                    'rule':      'Start Away Mode',
                })

        # Turn ON the keep-on target.
        cmd = {
            'device_id': keep_dev_id,
            'action':    'turn_on',
            'rule':      'Start Away Mode',
        }
        if keep_dps is not None:
            cmd['channel'] = keep_dps
        commands.append(cmd)

        # Push initial Pixoo preset; live `{{countdown}}` in the preset
        # ticks down from end_ts to 0.
        end_ts = datetime.now(_TZ).timestamp() + cfg['keep_on_sec']
        commands.append({
            'device_id':   'pixoo',
            'protocol':    'pixoo',
            'action':      'push_preset',
            'preset_name': cfg['initial_preset'],
            'vars':        {'countdown': end_ts},
            'rule':        'Start Away Mode',
        })

        state.set_timer('start_away_t0')
        state.shared['_start_away_phase'] = 'phase1'

        log.info(
            "start_away_mode: phase1 fired (off_types=%s keep_on=%s for %.0f sec initial=%s final=%s)",
            sorted(cfg['off_types']), cfg['keep_on_target'], cfg['keep_on_sec'],
            cfg['initial_preset'], cfg['final_preset'],
        )
        return commands

    # ── Phase 2 — countdown elapsed, still away ──
    if phase == 'phase1' and home_mode == 'away':
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

            commands.append({
                'device_id':   'pixoo',
                'protocol':    'pixoo',
                'action':      'push_preset',
                'preset_name': cfg['final_preset'],
                'rule':        'Start Away Mode',
            })

            state.shared['_start_away_phase'] = 'phase2'
            log.info(
                "start_away_mode: phase2 fired (elapsed=%.0f sec final=%s)",
                elapsed_sec, cfg['final_preset'],
            )
            return commands

    return []
