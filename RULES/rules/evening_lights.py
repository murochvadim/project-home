"""Evening Lights — turn ON a sentence-declared list of lights when the
apartment is in home mode AND time mode is in the active set.

Two firing scenarios (both via sentence-driven knobs):

  A) Evening kick-in: time_mode just transitioned to 'evening' AND
     home_mode is 'home'. Lights come on automatically when evening starts.

  B) Late arrival: home_mode just transitioned from 'away' or 'abroad' to
     'home' AND current time_mode is in the active list (e.g. evening,
     night, late_night). Lights come on when you arrive home in those
     time windows.

Latched per "home period" — once fired, the rule won't refire until
home_mode leaves 'home' (i.e. you press AWAY or ABROAD), then comes back.
This prevents re-asserting on every heartbeat once the lights are on.

Sentences (authored in the dashboard "Evening Lights" container):

  s_el1: evening lights are @<Device 1> <Channel>, @<Device 2>, ...
         (the device list — chips resolved via longest-prefix match)

  s_el2: Evening Lights: active time modes are evening, night, late_night
         (the time modes during which the rule may fire)

If either sentence is missing, the rule is a safe no-op.

Companion rules / patches:
- home_state.py writes state.shared['time_mode']
- mode_buttons.py writes state.shared['home_mode']
- Both happen on the same heartbeat tick, so the rule sees a consistent
  pair of values.
"""

import json
import logging
import re

log = logging.getLogger('rule.evening_lights')

# Sentence regex anchors — case-insensitive, tolerant of surrounding text.
_DEVICES_TRIGGER_RE = re.compile(r'evening\s+lights\s+are', re.IGNORECASE)
_ACTIVE_MODES_RE    = re.compile(
    r'evening\s+lights:\s*active\s+time\s+modes?\s+are\s+(.+)',
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


def _load_active_time_modes(container):
    """Extract the list of active time modes from the s_el2 sentence.

    Sentence: "Evening Lights: active time modes are evening, night, late_night"
    Returns a set of mode names (lowercase) or empty set if no sentence.
    """
    if not container:
        return set()
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        m = _ACTIVE_MODES_RE.search(text)
        if not m:
            continue
        rest = m.group(1).strip()
        # Split on commas + "or" + "and", strip whitespace, lowercase.
        # Tolerant of "evening, night, or late_night" or "evening night late_night".
        parts = re.split(r'[,;]\s*|\s+(?:or|and)\s+|\s+', rest, flags=re.IGNORECASE)
        modes = {p.strip().lower() for p in parts if p.strip()}
        # Drop noise tokens that aren't real time_mode names.
        modes = {m for m in modes if re.match(r'^[a-z_]+$', m)}
        return modes
    return set()


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Belt-and-braces — engine already filters by trigger.
    if event.get('device_id') != 'heartbeat':
        return []

    container = _read_evening_lights_container(state)
    if container is None:
        # Container not authored yet — no-op.
        return []

    active_modes = _load_active_time_modes(container)
    if not active_modes:
        # s_el2 missing — no-op.
        log.debug("evening_lights: active time modes sentence missing — skipping")
        return []

    home_mode = state.shared.get('home_mode', '')
    time_mode = state.shared.get('time_mode', '')

    prev_home = state.shared.get('_evening_lights_prev_home_mode', '')
    prev_time = state.shared.get('_evening_lights_prev_time_mode', '')
    fired     = bool(state.shared.get('_evening_lights_fired_this_period', False))

    # Reset latch when leaving home (away/abroad). Next time we come back,
    # the rule is free to fire again.
    home_just_left = (prev_home == 'home' and home_mode != 'home')
    if home_just_left:
        fired = False

    # Detect the two trigger transitions.
    home_just_arrived  = (prev_home in ('away', 'abroad') and home_mode == 'home')
    time_entered_evening = (prev_time != 'evening' and time_mode == 'evening')

    fire = False
    if (not fired) and home_mode == 'home' and time_mode in active_modes:
        # Scenario A — evening kick-in
        if time_entered_evening:
            fire = True
        # Scenario B — late arrival
        elif home_just_arrived:
            fire = True

    # Persist transitions for next tick (always — even if we're not firing).
    state.shared['_evening_lights_prev_home_mode']      = home_mode
    state.shared['_evening_lights_prev_time_mode']      = time_mode
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

    scenario = 'A:evening_kickin' if time_entered_evening else 'B:home_arrival'
    log.info(
        "evening_lights: fired %d turn_on commands (scenario=%s time_mode=%s home_mode=%s)",
        len(commands), scenario, time_mode, home_mode,
    )
    return commands
