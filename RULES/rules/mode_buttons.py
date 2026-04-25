"""Mode Buttons — sole owner of state.shared['home_mode'].

Interprets base rule 2 ("Home/Away/Abroad Buttons", id `r_modebuttons_init`)
sentences from `dashboard_settings.apartment.rule_sentences`. Watches the
declared mode-button DPS state on the resolved device(s). Writes home_mode
on every transition: 'home' / 'away' / 'abroad'.

Default-to-HOME: if all three buttons are OFF, emits a `turn_on` command
to the HOME button. The cooldown is read from the sentence
`Mode Buttons: default-to-HOME cooldown is N seconds` (no hardcoded
fallback — if the sentence is missing the default-to-HOME path is a
safe no-op). The button's state-report flows back through the engine
and on the next event the rule resolves to home_mode='home'.

Sentence-driven — no hardcoded device IDs or DPS keys. Edit the sentence
in the dashboard, the rule re-resolves on the next heartbeat (≤ 60 s).

If the sentence container is missing OR any of HOME/AWAY/ABROAD bindings
fail to resolve, the rule is a safe no-op (returns [] without writing
home_mode or emitting commands).

Sole writer guarantee: NO other rule writes state.shared['home_mode']
(verified 2026-04-25 — people_home stripped; no other producer exists).
Anyone else (evening_lights, future Coming-Home rule, dashboard widgets)
reads home_mode but never writes it.
"""

import json
import logging
import re
import time

log = logging.getLogger('rule.mode_buttons')

# TTL cache for the bindings — avoids a `state.db_query` per wildcard event
# (~1 query/sec at home scale → ~86k/day uncached). Same pattern as
# wallmote_handler.py:70-93. Dashboard edits propagate within ≤ TTL seconds.
_BINDINGS_CACHE = {"data": None, "ts": 0.0}
_BINDINGS_CACHE_TTL_SEC = 30

_REPRESENTS_RE = re.compile(r'represents\s+(home|away|abroad)\s+mode', re.IGNORECASE)
_TRUTHY_BUTTON_VALUES = (True, 1, 'true', 'True', 'on', 'ON', '1')


RULE = {
    "name":        "Mode Buttons",
    "description": "Interpret base rule 2 sentences. Sole owner of state.shared['home_mode'] — 8 Gang Switch button state → home/away/abroad. All-off triggers default-to-HOME via turn_on command.",
    "triggers":    ["*"],
    "controls":    [],
    "category":    "info",
    "group":       "info",
    "priority":    1,
    "depends_on":  [],
}


# ─────────────────────────── Helpers ───────────────────────────

def _sentence_text(s):
    """Flatten a sentence into plain text (mirrors home_state.py)."""
    segs = s.get('segments')
    if isinstance(segs, list) and segs:
        return ''.join((seg or {}).get('v', '') for seg in segs)
    return s.get('text') or ''


def _build_devices_by_name_desc(state_devices):
    """Sort devices by name length desc → enables longest-prefix match."""
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
    """Parse '@<DeviceName> <ChannelLabel>' into (device_id, dps_key).

    Longest-prefix match against devices.name; remainder is matched against
    that device's `dps_labels` to find the dps_key.
    Returns (device_id, dps_key) or None on failure.
    """
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


def _get_mode_bindings(state):
    """Cached wrapper around _load_mode_bindings — TTL 30s.

    Refreshes the parsed bindings at most once per `_BINDINGS_CACHE_TTL_SEC`
    even if the rule fires per-event. Dashboard sentence edits propagate
    within ≤ TTL seconds.
    """
    now = time.time()
    if _BINDINGS_CACHE["data"] is not None and (now - _BINDINGS_CACHE["ts"]) < _BINDINGS_CACHE_TTL_SEC:
        return _BINDINGS_CACHE["data"]
    data = _load_mode_bindings(state)
    _BINDINGS_CACHE["data"] = data
    _BINDINGS_CACHE["ts"] = now
    return data


def _load_mode_bindings(state):
    """Returns {'home': (dev_id, dps_key), 'away': (...), 'abroad': (...)} or {}.

    Reads `dashboard_settings.apartment.rule_sentences`, finds the rule
    container by id `r_modebuttons_init` OR (case-insensitive) name
    'home/away/abroad buttons'. For each sentence, scans for the pattern
    `<dev chip> represents <mode> mode` to extract mode → device+dps.
    """
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ('apartment.rule_sentences',),
    )
    if not rows:
        return {}
    raw = rows[0][0]
    if isinstance(raw, str):
        try:
            rules = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            log.warning("mode_buttons: apartment.rule_sentences not valid JSON")
            return {}
    elif isinstance(raw, list):
        rules = raw
    else:
        return {}

    container = None
    for r in rules or []:
        if not r.get('active'):
            continue
        rid = (r.get('id') or '').strip()
        rname = (r.get('name') or '').strip().lower()
        if rid == 'r_modebuttons_init' or rname == 'home/away/abroad buttons':
            container = r
            break
    if not container:
        return {}

    devices_by_name_desc = _build_devices_by_name_desc(state.devices)

    bindings = {}
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        segs = s.get('segments') or []
        for i, seg in enumerate(segs):
            if (seg.get('t') or '').lower() != 'dev':
                continue
            chip = seg.get('v') or ''
            # Concatenate following text segments (until the next dev chip)
            # and scan for "represents <mode> mode".
            following = ''
            for next_seg in segs[i + 1:]:
                if (next_seg.get('t') or '').lower() == 'text':
                    following += next_seg.get('v') or ''
                else:
                    break
            m = _REPRESENTS_RE.search(following)
            if not m:
                continue
            mode = m.group(1).lower()
            parsed = _parse_dev_chip(chip, devices_by_name_desc)
            if parsed:
                bindings[mode] = parsed
    return bindings


def _is_button_on(state, dev_id, dps_key):
    """True if the device's current dps[dps_key] is a truthy button value.

    Reads from state.devices (live snapshot). dps_key=None means whole-device
    on (not common for these scene buttons but supported defensively).
    """
    dev = state.devices.get(dev_id) or {}
    dps = dev.get('dps') or {}
    if dps_key is None:
        # Whole-device — accept truthy DPS '1' as a default heuristic.
        val = dps.get('1')
    else:
        val = dps.get(dps_key)
    return val in _TRUTHY_BUTTON_VALUES


def _last_change_age(state, dev_id, dps_key):
    """Seconds since the most recent transition on (dev_id, dps_key).
    Returns float('inf') if no historical transition recorded.
    Used to disambiguate when multiple buttons are simultaneously ON
    (most-recent change wins).
    """
    if not dps_key:
        return float('inf')
    import time
    now = time.time()
    try:
        ts = state.get_last_transition_before(dev_id, dps_key, now)
    except Exception:
        return float('inf')
    if ts is None:
        return float('inf')
    # ts may be a unix float or a datetime — handle both defensively.
    try:
        if hasattr(ts, 'timestamp'):
            ts_unix = ts.timestamp()
        else:
            ts_unix = float(ts)
    except (TypeError, ValueError):
        return float('inf')
    return max(0.0, now - ts_unix)


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    bindings = _get_mode_bindings(state)
    if not bindings or not all(k in bindings for k in ('home', 'away', 'abroad')):
        # Sentence missing or incomplete → safe no-op. Don't touch home_mode.
        return []

    # Wildcard early-filter — only fire on heartbeat OR events from the
    # device(s) that hold our mode buttons. Saves ~99% of wildcard cost.
    button_devs = {bindings[m][0] for m in ('home', 'away', 'abroad')}
    dev_id = event.get('device_id', '')
    if dev_id != 'heartbeat' and dev_id not in button_devs:
        return []

    # Determine which buttons are currently ON.
    on_modes = []
    for mode in ('home', 'away', 'abroad'):
        b_dev, b_dps = bindings[mode]
        if _is_button_on(state, b_dev, b_dps):
            on_modes.append(mode)

    # ── Track continuous all-off time ──
    # We only assert HOME when ALL three buttons have been continuously off
    # for the cooldown window (sentence-driven, e.g. 30 s). If a button goes
    # on at any point during the wait, the window resets. This gives the user
    # a grace period to re-press a button after the firmware auto-off, without
    # the rule overriding their intent.
    if on_modes:
        # Any button on → cancel the all-off wait.
        state.shared['_mode_buttons_all_off_armed'] = False
    else:
        # All off → start the wait if not already started.
        if not state.shared.get('_mode_buttons_all_off_armed'):
            state.set_timer('mode_buttons_all_off_since')
            state.shared['_mode_buttons_all_off_armed'] = True

    # ── All OFF for ≥ cooldown_sec → emit default-to-HOME turn_on ──
    # Cooldown comes from the sentence
    #   "Mode Buttons: default-to-HOME cooldown is N seconds"
    # parsed by the engine's KNOB_PATTERNS into
    # state.shared['mode_buttons.default_home_cooldown_sec'].
    # No Python fallback: if the sentence is missing, the default-to-HOME
    # path is a safe no-op (mode detection still works on real button state).
    if not on_modes:
        cooldown_raw = state.shared.get('mode_buttons.default_home_cooldown_sec')
        if cooldown_raw is None:
            log.debug("mode_buttons: cooldown sentence missing — skipping default-to-HOME")
            return []
        try:
            cooldown_sec = int(cooldown_raw)
        except (TypeError, ValueError):
            log.warning("mode_buttons: invalid cooldown value %r — skipping default-to-HOME", cooldown_raw)
            return []
        all_off_age = state.get_timer('mode_buttons_all_off_since')
        if all_off_age < cooldown_sec:
            # Not enough continuous all-off time yet — keep waiting.
            return []
        # Disarm so we re-arm cleanly next time + don't refire on every event
        # while still in all-off (the device's response will flip this anyway).
        state.shared['_mode_buttons_all_off_armed'] = False
        h_dev, h_dps = bindings['home']
        cmd = {
            'device_id': h_dev,
            'action':    'turn_on',
            'rule':      'Mode Buttons',
        }
        if h_dps is not None:
            cmd['channel'] = h_dps
        log.info(
            "mode_buttons: all buttons off for %ds (>= %ds) → asserting HOME (turn_on dev=%s dps=%s)",
            int(all_off_age), cooldown_sec, h_dev, h_dps,
        )
        return [cmd]

    # ── Exactly one ON → that mode wins ──
    if len(on_modes) == 1:
        active_mode = on_modes[0]
    else:
        # ── Multiple ON → most-recent transition wins ──
        # Pick the mode whose button's last transition was most recent.
        latest_age = float('inf')
        active_mode = None
        for m in on_modes:
            age = _last_change_age(state, *bindings[m])
            if age < latest_age:
                latest_age = age
                active_mode = m
        if active_mode is None:
            # Couldn't disambiguate; don't write — leave previous value.
            log.debug("mode_buttons: ambiguous (multiple buttons on, no transition history)")
            return []

    # ── Write only on transition ──
    prev = state.shared.get('home_mode')
    if prev != active_mode:
        state.shared['home_mode'] = active_mode
        log.info("mode_buttons: home_mode %s -> %s", prev or '(unset)', active_mode)

    return []
