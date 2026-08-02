"""Morning Lights — turn ON a sentence-declared list of lights once per day.

Two firing scenarios (both gated by s_ml3, both share the daily latch):

  A) Sun-anchor moment: if today's earliest s_ml2 anchor has PASSED
     (now_min >= anchor_min) AND gates pass AND latch unset → fire.
     Covers: home at sunrise+90 → fires at 07:08; home all morning →
     fires once when the anchor crosses.

  B) Come-home (sentence-driven via s_ml4): runs a SEPARATE "come home"
     scene on EVERY away/abroad→home arrival, at ANY hour, every time —
     no sunrise threshold, no once-a-day latch. Edge-triggered on the
     home_mode transition (fires once per arrival). Fires ~instantly via
     the 8-Gang-Switch trigger (or the next heartbeat). If s_ml4 is
     absent, Scenario B is disabled; only Scenario A fires.

Scenario A's daily latch ensures the DAWN morning scene fires at most once
per calendar day. Scenario B (come-home) is deliberately UNLATCHED — it
runs every time you arrive home. They use DIFFERENT scenes (s_ml1 dawn
scene vs s_ml4 come-home scene) and can both fire on the same morning
arrival (you missed the dawn fire while away → arrival runs both).

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

  s_ml4: Morning Lights: on arriving home run @scene <Come Home Lights>
         (optional) Enables the come-home path and names the scene to run
         on EVERY away/abroad→home arrival (any hour, every time). A
         DIFFERENT scene from s_ml1's dawn scene. If absent, the come-home
         path is disabled.

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
# Scene sentence (s_ml1 alt) — "Morning Lights: scene is @scene <Name>". When a
# scene chip is present the rule emits one {action:'run_scene'} command and the
# ENGINE runs it async (rule_engine._run_scene) instead of the legacy device
# list — mirrors Evening Lights' s_el1.
_SCENE_RE = re.compile(r'morning\s+lights:\s*scene\s+is\s+(.+)', re.IGNORECASE)
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
# Come-home scene sentence (s_ml4) —
#   "Morning Lights: on arriving home run @scene <Name>"
# Declares a SEPARATE scene that runs on EVERY away/abroad→home arrival, at ANY
# hour, every time (no sunrise threshold, no once-a-day latch). Distinct from the
# dawn Scenario-A "scene is" scene. Absent → the arrival path is disabled.
_COMEHOME_RE = re.compile(
    r'morning\s+lights:\s*on\s+arriving\s+home\s+run',
    re.IGNORECASE,
)


# Mode-button device (8 Gang Switch). Added to triggers so the come-home arrival
# path fires in the SAME event cycle as the HOME button press (~1 s) instead of
# waiting up to 60 s for the heartbeat — same pattern as Evening Lights. Mode
# Buttons (depends_on) runs first and sets home_mode.
_MODE_BUTTON_DEVICE_ID = 'bf85e819855d686918q6hz'

# Scenario A (dawn morning routine) upper time bound. The engine time-window
# override is now all-day so come-home fires any hour — so the rule must self-
# enforce that the DAWN routine only runs in the morning, else "away all morning,
# home at 14:00" would fire the morning routine in the afternoon. Run bypasses it.
# (Minutes-of-day; 600 = 10:00, matches the old 04:01–10:00 window top.)
_MORNING_END_MIN = 10 * 60
# Ignore a "come home" whose preceding away lasted less than this — a transient
# mode-flip blip (e.g. the nightly 04:00 Tuya reload flipping home->away->home in
# ~1 s), not a real arrival. A real trip is far longer. Read from Mode Buttons'
# `mode_buttons.prev_mode_sec`. Raise/lower to tune.
_MIN_ARRIVAL_DWELL_SEC = 60


RULE = {
    "name":        "Morning Lights",
    "description": "Runs your morning routine once a day around sunrise. Also runs your Come Home Lights scene every time you arrive home (any hour) after being away.",
    "triggers":    ["heartbeat", _MODE_BUTTON_DEVICE_ID],
    "controls":    [],
    "category":    "control",
    "group":       "lighting",
    "priority":    30,
    "depends_on":  ["Home Time Periods", "Mode Buttons"],
    # Manual "Run" button (dashboard, Force path): builds a heartbeat event with
    # source='force_run'. evaluate() treats that as a simulated trigger moment —
    # sets anchor_passed=True and clears the per-day latch — and runs the rule
    # otherwise EXACTLY as declared (s_ml3 home_mode gate + s_ml1 device list
    # still apply). Only the timing (sun anchor / time_mode / engine window /
    # latch) is bypassed. See the force_run block in evaluate().
    "test_event":  {"device_id": "heartbeat", "source": "force_run"},
    # The dashboard button is a real "Run" (not a debug Force), so a forced run
    # that dispatches commands bumps the Runs counter + last_fired like a real
    # fire. Honored in _test_rule_impl's force branch.
    "count_force_fires": True,
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


def _load_scene_name(container):
    """s_ml1: 'Morning Lights: scene is @scene <Name>' → the dawn Scenario-A scene.
    Scoped to the 'scene is' sentence so it never picks up the come-home scene
    (which also has an @scene chip)."""
    if not container:
        return None
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        text = _sentence_text(s)
        if not _SCENE_RE.search(text):           # only the "scene is" sentence
            continue
        for chip in _iter_dev_chips(s):
            if chip.lower().startswith('@scene '):
                return chip[len('@scene '):].strip()
        m = _SCENE_RE.search(text)
        if m:  # plain-text "scene is <Name>" with no chip
            name = m.group(1).strip()
            return name[len('@scene '):].strip() if name.lower().startswith('@scene ') else name
    return None


def _load_comehome_scene(container):
    """s_ml4: 'Morning Lights: on arriving home run @scene <Name>' → the scene to
    run on EVERY away/abroad→home arrival (any hour, every time). None if absent
    (arrival path disabled)."""
    if not container:
        return None
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        if not _COMEHOME_RE.search(_sentence_text(s)):
            continue
        for chip in _iter_dev_chips(s):
            if chip.lower().startswith('@scene '):
                return chip[len('@scene '):].strip()
    return None


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


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Heartbeat drives Scenario A (dawn anchor) + is the fallback; a mode-button
    # event drives the instant come-home arrival (Scenario B). Others ignored.
    if event.get('device_id') not in ('heartbeat', _MODE_BUTTON_DEVICE_ID):
        return []
    is_heartbeat = event.get('device_id') == 'heartbeat'

    container = _read_morning_lights_container(state)
    if container is None:
        # Container not authored yet — no-op.
        return []

    # Sun anchors gate Scenario A only; the come-home arrival path does NOT need
    # them, so an empty s_ml2 just disables Scenario A (no early return).
    sun_anchors = _load_sun_anchors(container)

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

    # ── Scenario B — come-home: run the Come Home Lights scene (s_ml4) on EVERY
    # away/abroad→home arrival, at ANY hour, every time. No sunrise threshold, no
    # daily latch — it's edge-triggered on the home_mode transition, so it fires
    # exactly once per arrival. `prev_home` non-empty guard avoids a false-arrival
    # at the first heartbeat post-restart (persisted state not re-seeded yet).
    comehome_scene = _load_comehome_scene(container)
    home_just_arrived = (home_gate_value is not None
                         and prev_home
                         and prev_home != home_gate_value
                         and home_mode == home_gate_value)
    # Dwell guard: skip a "come home" if the away we just returned from lasted less
    # than _MIN_ARRIVAL_DWELL_SEC — a transient mode flip (nightly Tuya reload), not
    # a real arrival. Mode Buttons ran first (depends_on) and set prev_mode_sec.
    if home_just_arrived:
        try:
            _away_sec = float(state.shared.get('mode_buttons.prev_mode_sec', 99999))
        except (TypeError, ValueError):
            _away_sec = 99999
        if _away_sec < _MIN_ARRIVAL_DWELL_SEC:
            log.info("morning_lights: come-home IGNORED — previous away only %.1fs (< %ds), transient mode flip",
                     _away_sec, _MIN_ARRIVAL_DWELL_SEC)
            home_just_arrived = False
    fire_comehome = comehome_scene is not None and home_just_arrived

    # Manual Run (dashboard red "Run" → engine Force path) simulates the dawn
    # trigger MOMENT (Scenario A): anchor_passed=True (ignore sun-anchor timing) +
    # fired=False (clear the latch). The s_ml3 gate + s_ml1 scene still apply.
    forced = event.get('source') == 'force_run'
    if forced:
        anchor_passed = True
        fired = False

    # Scenario A — dawn sun anchor, gated + latched once/day (the Morning scene).
    # HEARTBEAT-ONLY: a mode event must not fire the morning routine (the next
    # heartbeat does, within 60 s); the mode event is purely for the come-home path.
    # MORNING-ONLY: also require now_min < _MORNING_END_MIN so the dawn routine can't
    # leak into the afternoon now that the engine window is all-day. Run bypasses it.
    fire_anchor = (is_heartbeat and (not fired) and gates_pass and anchor_passed
                   and (forced or now_min < _MORNING_END_MIN))

    # Persist transitions + latch (always). ONLY Scenario A sets the daily latch —
    # come-home arrivals are intentionally unlatched (repeatable, any hour).
    state.shared['_morning_lights_prev_home_mode']    = home_mode
    state.shared['_morning_lights_fired_this_period'] = fired or fire_anchor
    if fire_anchor:
        state.shared['_morning_lights_fired_date'] = today_iso

    if not (fire_anchor or fire_comehome):
        return []

    commands = []
    srcs = []

    # Scenario A → the dawn "scene is" scene (s_ml1), or the legacy device list.
    if fire_anchor:
        scene_name = _load_scene_name(container)
        if scene_name:
            commands.append({'action': 'run_scene', 'scene': scene_name, 'rule': 'Morning Lights'})
            srcs.append(f'anchor:run_scene:{scene_name}')
        else:
            for t in _load_morning_light_targets(state, container):
                if isinstance(t, dict):
                    commands.append({**t, 'rule': 'Morning Lights'})
                else:
                    dev_id, dps_key = t
                    cmd = {'device_id': dev_id, 'action': 'turn_on', 'rule': 'Morning Lights'}
                    if dps_key is not None:
                        cmd['channel'] = dps_key
                    commands.append(cmd)
            srcs.append('anchor:devlist')

    # Scenario B → the come-home scene (s_ml4), any hour, every arrival.
    if fire_comehome:
        commands.append({'action': 'run_scene', 'scene': comehome_scene, 'rule': 'Morning Lights'})
        srcs.append(f'comehome:run_scene:{comehome_scene}')

    log.info(
        "morning_lights: fired %d commands via [%s] (time_mode=%s home_mode=%s "
        "prev_home=%s now_min=%d earliest_anchor=%s gates=%s)",
        len(commands), ', '.join(srcs), time_mode, home_mode, prev_home, now_min,
        earliest_anchor, gates,
    )
    return commands
