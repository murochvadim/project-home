"""Morning Lights — turn ON a sentence-declared list of lights.

Symmetric counterpart of evening_lights.py. Same architecture, same
sentence shape — just the morning side.

Two firing scenarios:

  A) Sun-anchor kick-in: wall-clock minute equals any sun-event anchor
     declared in s_ml2 (e.g. `sunrise-15`, `sunrise+30`).
     Decoupled from time_mode — fires at the perceptual "first light"
     moment regardless of which time_mode window we're in.

  B) Late arrival: home_mode just transitioned 'away'|'abroad' → 'home'
     AND current time_mode is in the time_mode names declared in s_ml2
     (e.g. dawn, morning). Lights come on when you arrive home during
     those windows. Less commonly useful in morning than evening, but
     symmetric — only fires if the user actually puts time_mode names
     in s_ml2.

BOTH scenarios are gated by sentence-driven gate(s) — see s_ml3 below.

Latched per "home period" — once fired, the rule won't refire until
home_mode leaves 'home' (i.e. you press AWAY or ABROAD), then comes back.
Also latched per calendar day so a user who's continuously 'home'
(vacation week, WFH) doesn't see it re-fire after the first morning.

Sentences (authored in the dashboard "Morning Lights" container):

  s_ml1: morning lights are @<Device 1> <Channel>, @<Device 2>, ...
         (the device list — chips resolved via longest-prefix match;
         display chips like @Pixoo / @Awtrix routed through the shared
         _display_chips parser)

  s_ml2: Morning Lights: active time modes are sunrise-15, sunrise+30, morning
         The list mixes sun-event anchors (`<event>[±N]` where event is
         dawn|sunrise|noon|sunset|dusk and ±N is minutes) with plain
         time_mode names. Anchors drive Scenario A; names drive Scenario B.

  s_ml3: Morning Lights: only fires when home_mode is home
         A gate. Multiple gate sentences are AND-combined. Each gate names
         a state.shared key and the value it must equal for the rule to
         fire. Gates apply to BOTH scenarios A and B. If no gate sentence
         is authored, no gate is applied — Scenario A would fire at the
         sun anchor regardless of home_mode (Scenario B is still naturally
         gated by its home_just_arrived check).

If s_ml1 or s_ml2 is missing or yields no anchors and no modes, the rule
is a safe no-op.

Companion rules:
- home_time_periods.py writes state.shared['time_mode'] + sun event ISO
  strings for each event in {dawn, sunrise, noon, sunset, dusk}; this rule
  reads those for the anchor resolver.
- mode_buttons.py writes state.shared['home_mode'].
- Both happen on the same heartbeat tick, so the rule sees a consistent
  set of values.
"""

import json
import logging
import re
import sys
import os
from datetime import datetime
from zoneinfo import ZoneInfo

# RULES/ is the parent of rules/ — needed for `import _display_chips` since
# rule files are loaded via importlib.util but share sys.path with the engine.
_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import parse_display_chip, build_devices_by_name  # noqa: E402

log = logging.getLogger('rule.morning_lights')

_TZ = ZoneInfo('Asia/Jerusalem')

# Sentence regex anchors — case-insensitive, tolerant of surrounding text.
_DEVICES_TRIGGER_RE = re.compile(r'morning\s+lights\s+are', re.IGNORECASE)
_ACTIVE_MODES_RE    = re.compile(
    r'morning\s+lights:\s*active\s+time\s+modes?\s+are\s+(.+)',
    re.IGNORECASE,
)
# Items in s_ml2 that match this regex are sun-event anchors with optional
# ±N minute offset (e.g. `sunrise+10`, `dawn-5`). Anything else in the list
# is treated as a time_mode name (drives Scenario B late-arrival only).
_SUN_ANCHOR_RE = re.compile(
    r'^(dawn|sunrise|noon|sunset|dusk)([+-]\d+)?$',
    re.IGNORECASE,
)
# Gate sentence (s_ml3) — "Morning Lights: only fires when <key> is <value>".
# Each match yields one (state.shared key, expected value) gate. Multiple gate
# sentences in the container are AND-combined.
_GATE_RE = re.compile(
    r'morning\s+lights:\s*only\s+fires\s+when\s+(\w+)\s+is\s+([\w-]+)',
    re.IGNORECASE,
)


RULE = {
    "name":        "Morning Lights",
    "description": "Turn on declared lights at sunrise±offset OR home arrival during active morning time modes (latched per home period + per day).",
    "triggers":    ["heartbeat"],
    "controls":    [],
    "category":    "control",
    "group":       "lighting",
    "priority":    30,
    "depends_on":  ["Home Time Periods", "Mode Buttons"],
}


# ─────────────────────────── Helpers ───────────────────────────

def _sentence_text(s):
    """Flatten a sentence into plain text."""
    segs = s.get('segments')
    if isinstance(segs, list) and segs:
        return ''.join((seg or {}).get('v', '') for seg in segs)
    return s.get('text') or ''


def _iter_dev_chips(sentence):
    """Yield each `dev` segment's `v` value from a sentence's segments."""
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


def _parse_dev_chip(chip_value, devices_by_name_desc):
    """Parse '@<DeviceName> <ChannelLabel>' into (device_id, dps_key) via
    longest-prefix match against device names."""
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


def _read_morning_lights_container(state):
    """Read the Morning Lights rule container from dashboard_settings."""
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
            log.warning("morning_lights: apartment.rule_sentences not valid JSON")
            return None
    elif isinstance(raw, list):
        rules = raw
    else:
        return None

    for r in rules or []:
        if not r.get('active'):
            continue
        if (r.get('name') or '').strip().lower() == 'morning lights':
            return r
    return None


def _load_morning_light_targets(state, container):
    """Extract targets from the device-list sentence.

    Returns a list whose items are either:
      - (device_id, dps_key)            for switch/light style chips → turn_on
      - {device_id, protocol, action…}  for display chips (Pixoo / Awtrix
                                         on/off/push, HASP backlight/page)
                                         → dispatched verbatim
    """
    if not container:
        return []
    devices_by_name_desc = _build_devices_by_name_desc(state.devices)
    devices_by_name = build_devices_by_name(state.devices)
    targets = []
    seen = set()
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        if not _DEVICES_TRIGGER_RE.search(text):
            continue
        for chip in _iter_dev_chips(s):
            # Display / panel chips first (Awtrix/Pixoo on/off/push, HASP
            # backlight/page-select). _display_chips.py recognizes both.
            disp = parse_display_chip(chip, devices_by_name)
            if disp:
                key = ('disp', disp.get('device_id'), disp.get('action'),
                       disp.get('preset_name'), disp.get('channel'),
                       disp.get('page_num'))
                if key not in seen:
                    targets.append(disp)
                    seen.add(key)
                continue
            parsed = _parse_dev_chip(chip, devices_by_name_desc)
            if parsed and parsed not in seen:
                targets.append(parsed)
                seen.add(parsed)
    return targets


def _load_active_triggers(container):
    """Parse the s_ml2 sentence into (active_modes, sun_anchors).

    Sentence: "Morning Lights: active time modes are sunrise-15, dawn, morning"
    Each comma-separated item is classified:
      - sun-event token with optional ±N offset → sun_anchors list of (base, offset)
      - any plain word (a-z, _) → active_modes set
    Returns (active_modes:set, sun_anchors:list[tuple[str,int]]).
    """
    active_modes = set()
    sun_anchors = []
    if not container:
        return active_modes, sun_anchors
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        m = _ACTIVE_MODES_RE.search(text)
        if not m:
            continue
        rest = m.group(1).strip()
        # Split on commas/semicolons + "or"/"and" + whitespace.
        parts = re.split(r'[,;]\s*|\s+(?:or|and)\s+|\s+', rest, flags=re.IGNORECASE)
        for p in (p.strip().lower() for p in parts if p.strip()):
            ma = _SUN_ANCHOR_RE.match(p)
            if ma:
                base = ma.group(1).lower()
                offset = int(ma.group(2)) if ma.group(2) else 0
                sun_anchors.append((base, offset))
            elif re.match(r'^[a-z_]+$', p):
                active_modes.add(p)
        return active_modes, sun_anchors
    return active_modes, sun_anchors


def _load_gates(container):
    """Parse s_ml3 gate sentences. Returns list of (key, expected_value)."""
    gates = []
    if not container:
        return gates
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        m = _GATE_RE.search(text)
        if m:
            gates.append((m.group(1).lower(), m.group(2).lower()))
    return gates


def _anchor_minutes(sun_anchors, state):
    """Resolve [(base, offset_min)] to a set of minute-of-day ints.

    Uses state.shared['<base>'] (ISO datetime string published every heartbeat
    by the Home Time Periods rule). Skips anchors whose base sun event isn't
    in state.shared yet (e.g. before the first Home Time Periods tick).
    """
    out = set()
    for base, offset in sun_anchors:
        iso = state.shared.get(base)
        if not iso:
            continue
        try:
            dt = datetime.fromisoformat(iso).astimezone(_TZ)
        except (ValueError, TypeError):
            continue
        out.add((dt.hour * 60 + dt.minute + offset) % 1440)
    return out


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Belt-and-braces — engine already filters by trigger.
    if event.get('device_id') != 'heartbeat':
        return []

    container = _read_morning_lights_container(state)
    if container is None:
        # Container not authored yet — no-op.
        return []

    active_modes, sun_anchors = _load_active_triggers(container)
    if not active_modes and not sun_anchors:
        # s_ml2 missing or empty — no-op.
        log.debug("morning_lights: active time modes sentence missing — skipping")
        return []

    home_mode = state.shared.get('home_mode', '')
    time_mode = state.shared.get('time_mode', '')

    prev_home = state.shared.get('_morning_lights_prev_home_mode', '')
    fired     = bool(state.shared.get('_morning_lights_fired_this_period', False))

    # Reset latch when leaving home (away/abroad). Next time we come back,
    # the rule is free to fire again.
    home_just_left = (prev_home == 'home' and home_mode != 'home')
    if home_just_left:
        fired = False

    # Now-minute-of-day in local tz — used for sun-anchor matching.
    now = datetime.now(_TZ)
    now_min = now.hour * 60 + now.minute

    # Daily latch reset — without this, a user who's continuously 'home'
    # (vacation week, WFH) would never re-fire after the first morning.
    today_iso = now.date().isoformat()
    fired_date = state.shared.get('_morning_lights_fired_date', '')
    if fired and fired_date != today_iso:
        fired = False

    # Scenario A — kick-in: current minute matches any configured sun-event
    # anchor. Heartbeat is 60 s, so equality on minute-of-day catches it.
    anchor_minutes = _anchor_minutes(sun_anchors, state)
    sun_anchor_hit = (now_min in anchor_minutes)

    # Scenario B — late arrival: home_mode just transitioned to 'home' AND
    # current time_mode is one of the declared time_mode names.
    home_just_arrived = (prev_home in ('away', 'abroad') and home_mode == 'home')
    late_arrival_hit  = home_just_arrived and time_mode in active_modes

    # Sentence-driven gates (s_ml3). All gates AND-combined. If no gate
    # sentence is authored, gates_pass is True (no constraint).
    gates = _load_gates(container)
    gates_pass = all(state.shared.get(k) == v for k, v in gates)

    fire = (not fired) and gates_pass and (sun_anchor_hit or late_arrival_hit)

    # Persist transitions for next tick (always — even if we're not firing).
    state.shared['_morning_lights_prev_home_mode']    = home_mode
    state.shared['_morning_lights_fired_this_period'] = fired or fire
    if fire:
        state.shared['_morning_lights_fired_date'] = today_iso

    if not fire:
        return []

    # Resolve the device list — fresh each fire.
    targets = _load_morning_light_targets(state, container)
    if not targets:
        log.info("morning_lights: trigger met but no targets parsed — skipping")
        return []

    commands = []
    for t in targets:
        if isinstance(t, dict):
            # Display / panel chip (already a complete command dict)
            cmd = {**t, 'rule': 'Morning Lights'}
        else:
            dev_id, dps_key = t
            cmd = {'device_id': dev_id, 'action': 'turn_on', 'rule': 'Morning Lights'}
            if dps_key is not None:
                cmd['channel'] = dps_key
        commands.append(cmd)

    scenario = 'A:sun_anchor' if sun_anchor_hit else 'B:home_arrival'
    log.info(
        "morning_lights: fired %d turn_on commands (scenario=%s time_mode=%s home_mode=%s now_min=%d anchors=%s gates=%s)",
        len(commands), scenario, time_mode, home_mode, now_min, sorted(anchor_minutes), gates,
    )
    return commands
