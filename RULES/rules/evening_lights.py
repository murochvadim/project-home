"""Evening Lights — turn ON a sentence-declared list of lights.

Two firing scenarios:

  A) Sun-anchor kick-in: wall-clock minute equals any sun-event anchor
     declared in s_el2 (e.g. `sunset+10`).
     Decoupled from time_mode — fires at the perceptual "low light"
     moment regardless of which time_mode window we're in.

  B) Late arrival: home_mode just transitioned 'away'|'abroad' → 'home'
     AND current time_mode is in the time_mode names declared in s_el2
     (e.g. evening, twilight, late_night). Lights come on when you arrive
     home during those windows.

BOTH scenarios are gated by sentence-driven gate(s) — see s_el3 below.

Latched per "home period" — once fired, the rule won't refire until
home_mode leaves 'home' (i.e. you press AWAY or ABROAD), then comes back.
This prevents re-asserting on every heartbeat once the lights are on.

Sentences (authored in the dashboard "Evening Lights" container):

  s_el1: evening lights are @<Device 1> <Channel>, @<Device 2>, ...
         (the device list — chips resolved via longest-prefix match)

  s_el2: Evening Lights: active time modes are sunset+10, evening, late_night
         The list mixes sun-event anchors (`<event>[±N]` where event is
         dawn|sunrise|noon|sunset|dusk and ±N is minutes) with plain
         time_mode names. Anchors drive Scenario A; names drive Scenario B.

  s_el3: Evening Lights: only fires when home_mode is home
         A gate. Multiple gate sentences are AND-combined. Each gate names
         a state.shared key and the value it must equal for the rule to
         fire. Gates apply to BOTH scenarios A and B. If no gate sentence
         is authored, no gate is applied — Scenario A would fire at the
         sun anchor regardless of home_mode (Scenario B is still naturally
         gated by its home_just_arrived check).

If s_el1 or s_el2 is missing or yields no anchors and no modes, the rule
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
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger('rule.evening_lights')

_TZ = ZoneInfo('Asia/Jerusalem')

# Sentence regex anchors — case-insensitive, tolerant of surrounding text.
_DEVICES_TRIGGER_RE = re.compile(r'evening\s+lights\s+are', re.IGNORECASE)
_ACTIVE_MODES_RE    = re.compile(
    r'evening\s+lights:\s*active\s+time\s+modes?\s+are\s+(.+)',
    re.IGNORECASE,
)
# Items in s_el2 that match this regex are sun-event anchors with optional
# ±N minute offset (e.g. `sunset+10`, `dusk-5`). Anything else in the list
# is treated as a time_mode name (drives Scenario B late-arrival only).
_SUN_ANCHOR_RE = re.compile(
    r'^(dawn|sunrise|noon|sunset|dusk)([+-]\d+)?$',
    re.IGNORECASE,
)
# Gate sentence (s_el3) — "Evening Lights: only fires when <key> is <value>".
# Each match yields one (state.shared key, expected value) gate. Multiple gate
# sentences in the container are AND-combined.
_GATE_RE = re.compile(
    r'evening\s+lights:\s*only\s+fires\s+when\s+(\w+)\s+is\s+([\w-]+)',
    re.IGNORECASE,
)


RULE = {
    "name":        "Evening Lights",
    "description": "Turn on declared lights on evening kick-in OR home arrival during active time modes (latched per home period).",
    "triggers":    ["heartbeat"],
    "controls":    [],
    "category":    "control",
    "group":       "lighting",
    "priority":    30,
    "depends_on":  ["Home Time Periods", "Mode Buttons"],
}


# ─────────────────────────── Helpers ───────────────────────────

def _sentence_text(s):
    """Flatten a sentence into plain text. Mirrors home_state.py."""
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


def _read_evening_lights_container(state):
    """Read the Evening Lights rule container from dashboard_settings.

    Returns the container dict or None.
    """
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
            log.warning("evening_lights: apartment.rule_sentences not valid JSON")
            return None
    elif isinstance(raw, list):
        rules = raw
    else:
        return None

    for r in rules or []:
        if not r.get('active'):
            continue
        if (r.get('name') or '').strip().lower() == 'evening lights':
            return r
    return None


def _load_evening_light_targets(state, container):
    """Extract (device_id, dps_key) tuples from the device-list sentence."""
    if not container:
        return []
    devices_by_name_desc = _build_devices_by_name_desc(state.devices)
    targets = []
    seen = set()
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        if not _DEVICES_TRIGGER_RE.search(text):
            continue
        for chip in _iter_dev_chips(s):
            parsed = _parse_dev_chip(chip, devices_by_name_desc)
            if parsed and parsed not in seen:
                targets.append(parsed)
                seen.add(parsed)
    return targets


def _load_active_triggers(container):
    """Parse the s_el2 sentence into (active_modes, sun_anchors).

    Sentence: "Evening Lights: active time modes are sunset+10, night, late_night"
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
    """Parse s_el3 gate sentences. Returns list of (key, expected_value).

    Each gate sentence: "Evening Lights: only fires when <key> is <value>"
    Multiple gate sentences are AND-combined at fire time.
    """
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

    container = _read_evening_lights_container(state)
    if container is None:
        # Container not authored yet — no-op.
        return []

    active_modes, sun_anchors = _load_active_triggers(container)
    if not active_modes and not sun_anchors:
        # s_el2 missing or empty — no-op.
        log.debug("evening_lights: active time modes sentence missing — skipping")
        return []

    home_mode = state.shared.get('home_mode', '')
    time_mode = state.shared.get('time_mode', '')

    prev_home = state.shared.get('_evening_lights_prev_home_mode', '')
    fired     = bool(state.shared.get('_evening_lights_fired_this_period', False))

    # Reset latch when leaving home (away/abroad). Next time we come back,
    # the rule is free to fire again.
    home_just_left = (prev_home == 'home' and home_mode != 'home')
    if home_just_left:
        fired = False

    # Now-minute-of-day in local tz — used for sun-anchor matching.
    now = datetime.now(_TZ)
    now_min = now.hour * 60 + now.minute

    # Scenario A — kick-in: current minute matches any configured sun-event
    # anchor. Heartbeat is 60 s, so equality on minute-of-day catches it.
    anchor_minutes = _anchor_minutes(sun_anchors, state)
    sun_anchor_hit = (now_min in anchor_minutes)

    # Scenario B — late arrival: home_mode just transitioned to 'home' AND
    # current time_mode is one of the declared time_mode names.
    home_just_arrived = (prev_home in ('away', 'abroad') and home_mode == 'home')
    late_arrival_hit  = home_just_arrived and time_mode in active_modes

    # Sentence-driven gates (s_el3). All gates AND-combined. If no gate
    # sentence is authored, gates_pass is True (no constraint).
    gates = _load_gates(container)
    gates_pass = all(state.shared.get(k) == v for k, v in gates)

    fire = (not fired) and gates_pass and (sun_anchor_hit or late_arrival_hit)

    # Persist transitions for next tick (always — even if we're not firing).
    state.shared['_evening_lights_prev_home_mode']      = home_mode
    state.shared['_evening_lights_fired_this_period']   = fired or fire

    if not fire:
        return []

    # Resolve the device list — fresh each fire.
    targets = _load_evening_light_targets(state, container)
    if not targets:
        log.info("evening_lights: trigger met but no targets parsed — skipping")
        return []

    commands = []
    for dev_id, dps_key in targets:
        cmd = {
            'device_id': dev_id,
            'action':    'turn_on',
            'rule':      'Evening Lights',
        }
        if dps_key is not None:
            cmd['channel'] = dps_key
        commands.append(cmd)

    scenario = 'A:sun_anchor' if sun_anchor_hit else 'B:home_arrival'
    log.info(
        "evening_lights: fired %d turn_on commands (scenario=%s time_mode=%s home_mode=%s now_min=%d anchors=%s gates=%s)",
        len(commands), scenario, time_mode, home_mode, now_min, sorted(anchor_minutes), gates,
    )
    return commands
