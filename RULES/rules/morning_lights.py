"""Morning Lights — turn ON a sentence-declared list of lights once per day.

Two firing scenarios (both gated by s_ml3, both share the daily latch):

  A) Sun-anchor moment: if today's earliest s_ml2 anchor has PASSED
     (now_min >= anchor_min) AND gates pass AND latch unset → fire.
     Covers: home at sunrise+90 → fires at 07:08; home all morning →
     fires once when the anchor crosses.

  B) Arrival (sentence-driven via s_ml4): if home_mode transitioned
     INTO the gated value AND current time is past the sun-anchor
     declared in s_ml4 → fire. Covers: away at 07:08, walked in at
     07:30 — fires immediately on the heartbeat after arrival.
     If s_ml4 is absent, Scenario B is disabled; only Scenario A fires.

Daily latch ensures the rule fires at MOST once per calendar day, no
matter which scenario triggers. No per-home-period latch reset (a brief
AWAY+return shouldn't re-fire morning lights mid-morning).

Sentences (authored in the dashboard "Morning Lights" container):

  s_ml1: morning lights are @<Device 1> <Channel>, @<Device 2>, ...
         (the device list — chips resolved via longest-prefix match;
         display chips like @Pixoo / @Awtrix routed through the shared
         _display_chips parser)

  s_ml2: Morning Lights: active time modes are sunrise+90
         List of sun-event anchors (`<event>[±N]` where event is
         dawn|sunrise|noon|sunset|dusk and ±N is minutes). Earliest
         anchor = "rule can fire from this minute onward today".
         Plain time-mode names are ignored.

  s_ml3: Morning Lights: only fires when home_mode is home
         A gate. Multiple gate sentences are AND-combined. The
         home_mode gate ALSO drives Scenario B's transition target
         (mode names are fully sentence-driven — no `'home'`/`'away'`/
         `'abroad'` literals in code).

  s_ml4: Morning Lights: also turn on when arriving home after sunrise+90
         (optional) Enables the arrival trigger. Threshold is an
         explicit sun-event anchor: <event>[±N] where event is
         dawn|sunrise|noon|sunset|dusk and ±N is minutes. Examples:
         `... after sunrise`, `... after sunrise+90`, `... after dawn-15`.
         If absent, the arrival trigger is disabled.

If s_ml1 is empty (no chips) or s_ml2 yields no anchors, the rule is a
safe no-op.

Companion rules:
- home_time_periods.py writes state.shared['time_mode'] + sun event ISO
  strings for each event in {dawn, sunrise, noon, sunset, dusk}; this rule
  reads those for the anchor resolver.
- mode_buttons.py writes state.shared['home_mode'].
- Both run before this rule in the same heartbeat tick (depends_on),
  so the rule sees consistent values.
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
# Arrival-trigger sentence (s_ml4, optional) —
#   "Morning Lights: also turn on when arriving home after <event>[±N]"
# `<event>[±N]` is e.g. `sunrise`, `sunrise+90`, `dawn-15`.
_LATE_ARRIVAL_RE = re.compile(
    r'morning\s+lights:\s*also\s+turn\s+on\s+when\s+arriving\s+home\s+after\s+(.+)',
    re.IGNORECASE,
)


RULE = {
    "name":        "Morning Lights",
    "description": "Turn on declared lights once per day: at the s_ml2 sun anchor, OR (if s_ml4 is authored) on home arrival once the s_ml4 anchor has passed.",
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


def _load_sun_anchors(container):
    """Parse s_ml2 → list[(base, offset_min)] of sun-event anchors.

    Sentence: "Morning Lights: active time modes are sunrise-15, dawn-5"
    Only sun-event tokens with optional ±N offset are honored. Any plain
    words (e.g. `morning`, `day`) are silently ignored — they were a
    pre-2026-05-27 Scenario-B concept that no longer drives anything.
    """
    sun_anchors = []
    if not container:
        return sun_anchors
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
        return sun_anchors
    return sun_anchors


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


def _load_late_arrival_threshold(container, state):
    """Parse s_ml4. Returns the minute-of-day threshold for Scenario B,
    or None if no s_ml4 sentence is authored (Scenario B disabled).

    Sentence: "Morning Lights: also turn on when arriving home after <event>[±N]"
    e.g. `... after sunrise`, `... after sunrise+90`, `... after dawn-15`.
    """
    if not container:
        return None
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        m = _LATE_ARRIVAL_RE.search(text)
        if not m:
            continue
        spec = m.group(1).strip().lower().rstrip('.,;')
        token = spec.split()[0] if spec else ''
        ma = _SUN_ANCHOR_RE.match(token)
        if ma:
            base = ma.group(1).lower()
            offset = int(ma.group(2)) if ma.group(2) else 0
            iso = state.shared.get(base)
            if not iso:
                return None
            try:
                dt = datetime.fromisoformat(iso).astimezone(_TZ)
            except (ValueError, TypeError):
                return None
            return (dt.hour * 60 + dt.minute + offset) % 1440
        log.warning("morning_lights: s_ml4 threshold %r not a sun anchor — Scenario B disabled", spec)
        return None
    return None


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Belt-and-braces — engine already filters by trigger.
    if event.get('device_id') != 'heartbeat':
        return []

    container = _read_morning_lights_container(state)
    if container is None:
        # Container not authored yet — no-op.
        return []

    sun_anchors = _load_sun_anchors(container)
    if not sun_anchors:
        # s_ml2 missing or no sun-event anchors — rule has no time threshold,
        # no-op. Plain time-mode words alone don't drive anything.
        log.debug("morning_lights: no sun anchors in s_ml2 — skipping")
        return []

    home_mode = state.shared.get('home_mode', '')
    time_mode = state.shared.get('time_mode', '')

    prev_home = state.shared.get('_morning_lights_prev_home_mode', '')
    fired     = bool(state.shared.get('_morning_lights_fired_this_period', False))

    # Now-minute-of-day in local tz — used for sun-anchor matching.
    now = datetime.now(_TZ)
    now_min = now.hour * 60 + now.minute

    # Daily latch reset: once fired today, can't re-fire until the calendar
    # day changes. Single latch path (no per-home-period reset) — a brief
    # AWAY blip mid-morning shouldn't re-arm Scenario A; Scenario B's
    # arrival check handles legitimate "left and came back" anyway.
    today_iso = now.date().isoformat()
    fired_date = state.shared.get('_morning_lights_fired_date', '')
    if fired and fired_date != today_iso:
        fired = False

    # Resolve anchors + earliest. Scenario A's threshold; also the default
    # threshold for Scenario B unless s_ml4 specifies a different anchor.
    anchor_minutes = _anchor_minutes(sun_anchors, state)
    state.shared['_morning_lights_last_eval_min'] = now_min        # diagnostic only
    earliest_anchor = min(anchor_minutes) if anchor_minutes else None
    anchor_passed   = earliest_anchor is not None and now_min >= earliest_anchor

    # Sentence-driven gates (s_ml3). All gates AND-combined. If no gate
    # sentence is authored, gates_pass is True (no constraint). The home_mode
    # gate doubles as Scenario B's transition target (no hardcoded literals).
    gates = _load_gates(container)
    gates_pass = all(state.shared.get(k) == v for k, v in gates)
    home_gate_value = next((v for k, v in gates if k == 'home_mode'), None)

    # Scenario B — late arrival. Enabled by the optional s_ml4 sentence.
    # `prev_home` non-empty guard prevents a false-arrival at first heartbeat
    # post-restart, where the persisted state hasn't re-seeded yet.
    late_arrival_threshold = _load_late_arrival_threshold(container, state)
    home_just_arrived = (home_gate_value is not None
                         and prev_home
                         and prev_home != home_gate_value
                         and home_mode == home_gate_value)
    late_arrival_hit = (late_arrival_threshold is not None
                        and home_just_arrived
                        and now_min >= late_arrival_threshold)

    # Fire when Scenario A OR Scenario B trigger AND gates pass AND latch unset.
    fire = (not fired) and gates_pass and (anchor_passed or late_arrival_hit)

    # Persist transitions + latch state (always — even when not firing).
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

    scenario = 'B:late_arrival' if late_arrival_hit else 'A:anchor_passed'
    log.info(
        "morning_lights: fired %d turn_on commands (scenario=%s time_mode=%s "
        "home_mode=%s now_min=%d earliest_anchor=%s late_threshold=%s gates=%s)",
        len(commands), scenario, time_mode, home_mode, now_min,
        earliest_anchor, late_arrival_threshold, gates,
    )
    return commands
