"""Evening Lights — turn ON a sentence-declared list of lights.

Two firing scenarios:

  A) Sun-anchor kick-in: wall-clock minute equals any sun-event anchor
     declared in s_el2 (e.g. `sunset+10`).
     Decoupled from time_mode — fires at the perceptual "low light"
     moment regardless of which time_mode window we're in.

  B) Late arrival: home_mode just transitioned to the value declared by
     the `s_el3` home_mode gate (e.g. `home_mode is home` → fires on
     `<any_other_mode> → home`) AND current time_mode is in the names
     declared in s_el2. Lights come on when you arrive home during
     those windows.

BOTH scenarios are gated by sentence-driven gate(s) — see s_el3 below.
The home_mode gate ALSO drives Scenario B's transition target and the
"home period" latch reset, so mode names are fully sentence-driven —
no `'home'` / `'away'` / `'abroad'` literals in the code.

Latched per "home period" — once fired, the rule won't refire until
home_mode leaves the gated value (i.e. you press AWAY / ABROAD / any
non-gated mode) and comes back. Prevents re-asserting on every
heartbeat once the lights are on.

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
from _scenes import load_scene, expand_scene  # noqa: E402

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
# Scene sentence (s_el1 alt) — "Evening Lights: scene is @scene <Name>". When a
# scene chip is present the rule RUNS that scene (via _scenes.expand_scene)
# instead of the legacy device list — mirrors Start Away Mode's s_sa1.
_SCENE_RE = re.compile(r'evening\s+lights:\s*scene\s+is\s+(.+)', re.IGNORECASE)


# Mode-button device (8 Gang Switch). Added to triggers so Scenario B (home
# arrival) fires in the SAME event cycle as the button press (~1 s) instead of
# waiting up to 60 s for the heartbeat. Mode Buttons (depends_on) runs first and
# sets home_mode. Scenario A (sunset anchor) stays HEARTBEAT-ONLY — see evaluate().
_MODE_BUTTON_DEVICE_ID = 'bf85e819855d686918q6hz'


RULE = {
    "name":        "Evening Lights",
    "description": "Turn on declared lights on evening kick-in OR home arrival during active time modes (latched per home period).",
    "triggers":    ["heartbeat", _MODE_BUTTON_DEVICE_ID],
    "controls":    [],
    "category":    "control",
    "group":       "lighting",
    "priority":    30,
    "depends_on":  ["Home Time Periods", "Mode Buttons"],
    # Manual "Run" button (dashboard, Force path): builds a heartbeat event with
    # source='force_run'. evaluate() treats that as a simulated Scenario-A
    # trigger (sun-anchor hit) and runs the rule EXACTLY as declared — gates +
    # latch + device list all apply. Nothing is bypassed except the wall-clock
    # anchor moment itself (otherwise Run could only fire at the exact minute).
    "test_event":  {"device_id": "heartbeat", "source": "force_run"},
    # The dashboard button is a real "Run" (not a debug Force), so a forced run
    # that dispatches commands bumps the Runs counter + last_fired like a real
    # fire. Honored in _test_rule_impl's force branch.
    "count_force_fires": True,
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
    """Extract targets from the device-list sentence.

    Returns a list whose items are either:
      - (device_id, dps_key)            for switch/light style chips → turn_on
      - {device_id, protocol, action…}  for display chips (Pixoo / Awtrix
                                         on/off/push) → dispatched verbatim
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
            # Display chips first (Awtrix/Pixoo on/off/push)
            disp = parse_display_chip(chip, devices_by_name)
            if disp:
                key = ('disp', disp.get('device_id'), disp.get('action'), disp.get('preset_name'))
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
    """If s_el1 declares a scene ('Evening Lights: scene is @scene <Name>'),
    return the scene name; else None → fall back to the legacy device list."""
    if not container:
        return None
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        for chip in _iter_dev_chips(s):
            if chip.lower().startswith('@scene '):
                return chip[len('@scene '):].strip()
        m = _SCENE_RE.search(_sentence_text(s))
        if m:  # plain-text "scene is <Name>" with no chip
            name = m.group(1).strip()
            return name[len('@scene '):].strip() if name.lower().startswith('@scene ') else name
    return None


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
    # Heartbeat drives Scenario A (sunset anchor) + acts as fallback; a
    # mode-button event drives instant Scenario B (arrival). Mode Buttons
    # (depends_on) ran first this cycle, so home_mode is fresh. Other devices ignored.
    if event.get('device_id') not in ('heartbeat', _MODE_BUTTON_DEVICE_ID):
        return []
    is_heartbeat = event.get('device_id') == 'heartbeat'

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

    # Load gates once — used by gates_pass below AND to derive Scenario B's
    # transition target. The gate `home_mode is <value>` makes <value> the
    # "active mode" for this rule: arrival is `prev != active && now == active`,
    # leaving is the inverse. No hardcoded mode literals.
    gates = _load_gates(container)
    home_gate_value = next((v for k, v in gates if k == 'home_mode'), None)

    # Reset latch when leaving the active mode. Next time we come back,
    # the rule is free to fire again.
    home_just_left = (home_gate_value is not None
                      and prev_home == home_gate_value
                      and home_mode != home_gate_value)
    if home_just_left:
        fired = False

    # Now-minute-of-day in local tz — used for sun-anchor matching.
    now = datetime.now(_TZ)
    now_min = now.hour * 60 + now.minute

    # Daily latch reset — without this, a user who's continuously in the
    # gated mode (vacation week, WFH) would never re-fire after the first night.
    # Empty fired_date (legacy state from before this fix) is treated as
    # "not today" so the latch clears on the first run after upgrade.
    today_iso = now.date().isoformat()
    fired_date = state.shared.get('_evening_lights_fired_date', '')
    if fired and fired_date != today_iso:
        fired = False

    # Scenario A — anchor kick-in. We detect when we CROSSED any anchor
    # minute since the previous tick rather than equality on the current
    # minute. The 60 s heartbeat drifts (state-load takes ~1 s, pushing
    # datetime.now() past the minute boundary), so an exact-equality check
    # silently misses the anchor about half of all evenings depending on
    # how the tick aligns with the wall clock. Crossing-edge detection
    # tolerates drift while the daily + period latches still prevent
    # double-firing.
    # HEARTBEAT-ONLY: a mode-button event must NOT advance _last_eval_min or run
    # the anchor check (it would shift the crossing window and could make sunset
    # miss). So sun_anchor_hit stays False on mode events; sunset still fires on
    # the tick. Scenario B (arrival) below is what the mode event is for.
    # anchor_minutes computed unconditionally — it's also read by the fire log
    # below, which runs on a Scenario-B (mode-event) fire too. Only the
    # _last_eval_min mutation + crossing check are heartbeat-gated.
    anchor_minutes = _anchor_minutes(sun_anchors, state)
    sun_anchor_hit = False
    if is_heartbeat:
        prev_now_min = state.shared.get('_evening_lights_last_eval_min')
        state.shared['_evening_lights_last_eval_min'] = now_min
        if isinstance(prev_now_min, int) and anchor_minutes:
            delta = (now_min - prev_now_min) % 1440
            for a in anchor_minutes:
                if 0 < ((a - prev_now_min) % 1440) <= delta:
                    sun_anchor_hit = True
                    break

    # Manual Run (dashboard red "Run" button → engine Force path). Simulate the
    # trigger MOMENT so the rule fires on demand:
    #   - sun_anchor_hit=True  → ignore the sunset / time_mode timing
    #   - fired=False          → clear the per-period latch (at a real trigger
    #                            moment the latch is always clear — it's SET by
    #                            the fire, not a precondition)
    # The home_mode gate (gates_pass) + the resolved device list STILL apply, so
    # Run dispatches exactly the same commands a real trigger would. The Force
    # harness deep-copies + restores state.shared, so the latch write during a
    # Run is reverted and the real sunset fire is never suppressed.
    if event.get('source') == 'force_run':
        sun_anchor_hit = True
        fired = False

    # Scenario B — late arrival: home_mode just transitioned to the gated
    # value (the home_gate_value derived above) AND current time_mode is one
    # of the declared time_mode names. If no home_mode gate is authored,
    # Scenario B silently doesn't fire (no transition target known).
    # `prev_home` non-empty guard prevents a false "arrival" right after
    # rule-engine restart, where the persisted state hasn't been re-seeded
    # yet and `prev_home` defaults to '' (≠ the gate value → would fire).
    home_just_arrived = (home_gate_value is not None
                         and prev_home
                         and prev_home != home_gate_value
                         and home_mode == home_gate_value)
    late_arrival_hit  = home_just_arrived and time_mode in active_modes

    # Sentence-driven gates (s_el3). All gates AND-combined. If no gate
    # sentence is authored, gates_pass is True (no constraint).
    gates_pass = all(state.shared.get(k) == v for k, v in gates)

    fire = (not fired) and gates_pass and (sun_anchor_hit or late_arrival_hit)

    # Persist transitions for next tick (always — even if we're not firing).
    state.shared['_evening_lights_prev_home_mode']      = home_mode
    state.shared['_evening_lights_fired_this_period']   = fired or fire
    if fire:
        state.shared['_evening_lights_fired_date'] = today_iso

    if not fire:
        return []

    # Resolve what to fire — fresh each fire. Prefer a Scene (s_el1 = "scene is
    # @scene <Name>") run via _scenes.expand_scene, exactly like Start Away Mode;
    # fall back to the legacy device-list path when no scene chip is present.
    scene_name = _load_scene_name(container)
    if scene_name:
        scene = load_scene(state, scene_name)
        commands = expand_scene(state, scene, 'Evening Lights')
        if not commands:
            log.warning("evening_lights: scene %r missing/empty — no-op", scene_name)
            return []
        src = f'scene:{scene_name}'
    else:
        targets = _load_evening_light_targets(state, container)
        if not targets:
            log.info("evening_lights: trigger met but no targets parsed — skipping")
            return []
        commands = []
        for t in targets:
            if isinstance(t, dict):
                # Display chip (already a complete command dict)
                commands.append({**t, 'rule': 'Evening Lights'})
            else:
                dev_id, dps_key = t
                cmd = {'device_id': dev_id, 'action': 'turn_on', 'rule': 'Evening Lights'}
                if dps_key is not None:
                    cmd['channel'] = dps_key
                commands.append(cmd)
        src = 'devlist'

    scenario = 'A:sun_anchor' if sun_anchor_hit else 'B:home_arrival'
    log.info(
        "evening_lights: fired %d commands via %s (scenario=%s time_mode=%s home_mode=%s now_min=%d anchors=%s gates=%s)",
        len(commands), src, scenario, time_mode, home_mode, now_min, sorted(anchor_minutes), gates,
    )
    return commands
