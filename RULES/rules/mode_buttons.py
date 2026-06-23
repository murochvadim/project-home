"""Mode Buttons — sole owner of state.shared['home_mode'].

Sentence-driven mode-button controller. All behavior comes from sentences
in the r_modebuttons_init container (`dashboard_settings.apartment.rule_sentences`).
Edits in the dashboard re-resolve on the next heartbeat (≤ 60 s via the
30 s bindings TTL + the engine's reload path).

Sentences read:

  s_mb1 (or any chip-bearing sentence)
      `@<Device> <Channel> represents <mode> mode`
      Declares one button → one mode mapping. Repeat for each mode.
      Mode names are free-form lowercase ([a-z_]+).

  s_mb_default
      `Mode Buttons: default mode is <name>`
      Names which mode to assert when all buttons stay off for the
      cooldown window. The named mode must also appear as a binding.
      If the sentence is missing OR names an unknown mode, the
      default-to-X path is a safe no-op (mode detection still works
      on real button presses).

  s_mb_cooldown
      `Mode Buttons: default-to-<mode> cooldown is N seconds`
      Engine-parsed via KNOB_PATTERNS into
      `state.shared['mode_buttons.default_home_cooldown_sec']`.

Safety guards (any failure → safe no-op, returns [] without writing
home_mode or emitting commands):

- Container missing.
- Fewer than 2 chip→mode bindings declared (a single-mode rule has no
  mutual-exclusivity meaning).
- Cooldown sentence missing OR not numeric.

Sole writer guarantee: NO other rule writes state.shared['home_mode'].
Anyone else (evening_lights, morning_lights, move_in_corridor,
start_away_mode, dashboard widgets) reads home_mode but never writes it.

Note: downstream rules still hard-compare `home_mode` against literals
'home' / 'away' / 'abroad'. Until those rules are migrated to be
sentence-driven too, choosing mode names beyond those three works for
the Mode Buttons rule itself but won't be recognised by downstream
consumers.
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

_REPRESENTS_RE = re.compile(r'represents\s+([a-z_]+)\s+mode', re.IGNORECASE)
_DEFAULT_MODE_RE = re.compile(r'default\s+mode\s+is\s+([a-z_]+)', re.IGNORECASE)
_TRUTHY_BUTTON_VALUES = (True, 1, 'true', 'True', 'on', 'ON', '1')


RULE = {
    "name":        "Mode Buttons",
    "description": "Watches your Home / Away / Abroad buttons and decides which mode the house is in. Press one and that mode takes over while the others switch off. If no button is pressed for a while, the house returns to its default mode on its own.",
    "triggers":    ["*"],
    "controls":    [],
    "category":    "info",
    "group":       "info",
    "priority":    1,
    "depends_on":  [],
}


# ─────────────────────────── Helpers ───────────────────────────

def _sentence_text(s):
    """Flatten a sentence into plain text — prefers segments, falls back to text."""
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
    """Cached wrapper around _load_mode_bindings — TTL 30s."""
    now = time.time()
    if _BINDINGS_CACHE["data"] is not None and (now - _BINDINGS_CACHE["ts"]) < _BINDINGS_CACHE_TTL_SEC:
        return _BINDINGS_CACHE["data"]
    data = _load_mode_bindings(state)
    _BINDINGS_CACHE["data"] = data
    _BINDINGS_CACHE["ts"] = now
    return data


def _load_mode_bindings(state):
    """Returns {'modes': {<name>: (dev_id, dps_key), ...}, 'default': <name|None>}.

    Reads `dashboard_settings.apartment.rule_sentences`, finds the rule
    container by id `r_modebuttons_init` OR (case-insensitive) name
    'home/away/abroad buttons'. For each sentence:

    - Scans chip+text for `represents <mode> mode` → adds chip resolution
      to the modes dict.
    - Scans flat text for `default mode is <name>` → records the default
      mode name.

    Empty modes dict means the container is missing OR no chip bindings
    were declared. `default=None` means no default-mode sentence exists.
    """
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ('apartment.rule_sentences',),
    )
    empty = {'modes': {}, 'default': None}
    if not rows:
        return empty
    raw = rows[0][0]
    if isinstance(raw, str):
        try:
            rules = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            log.warning("mode_buttons: apartment.rule_sentences not valid JSON")
            return empty
    elif isinstance(raw, list):
        rules = raw
    else:
        return empty

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
        return empty

    devices_by_name_desc = _build_devices_by_name_desc(state.devices)

    modes = {}
    default_mode = None
    for s in (container.get('sentences') or []):
        if not s.get('active'):
            continue
        # 1) Chip+represents-mode parse
        segs = s.get('segments') or []
        for i, seg in enumerate(segs):
            if (seg.get('t') or '').lower() != 'dev':
                continue
            chip = seg.get('v') or ''
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
                modes[mode] = parsed
        # 2) Flat-text default-mode parse
        flat = _sentence_text(s)
        dm = _DEFAULT_MODE_RE.search(flat)
        if dm:
            default_mode = dm.group(1).lower()
    return {'modes': modes, 'default': default_mode}


def _is_button_on(state, dev_id, dps_key):
    """True if the device's current dps[dps_key] is a truthy button value."""
    dev = state.devices.get(dev_id) or {}
    dps = dev.get('dps') or {}
    if dps_key is None:
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
    from datetime import datetime, timezone
    now_dt = datetime.now(timezone.utc)
    try:
        transition = state.get_last_transition_before(dev_id, dps_key, now_dt)
    except Exception:
        return float('inf')
    if transition is None:
        return float('inf')
    try:
        ts = transition[0]
    except (TypeError, IndexError):
        return float('inf')
    if ts is None:
        return float('inf')
    try:
        if hasattr(ts, 'timestamp'):
            ts_dt = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        else:
            ts_dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
    except (TypeError, ValueError):
        return float('inf')
    return max(0.0, (now_dt - ts_dt).total_seconds())


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    bindings = _get_mode_bindings(state)
    modes = bindings.get('modes') or {}
    if len(modes) < 2:
        # No usable bindings — safe no-op.
        return []

    # Wildcard early-filter — only fire on heartbeat OR events from the
    # device(s) that hold our mode buttons.
    button_devs = {dev for (dev, _) in modes.values()}
    dev_id = event.get('device_id', '')
    if dev_id != 'heartbeat' and dev_id not in button_devs:
        return []

    # Which buttons are currently ON
    on_modes = [m for m, (bd, bp) in modes.items() if _is_button_on(state, bd, bp)]

    # ── Track continuous all-off time ──
    if on_modes:
        state.shared['_mode_buttons_all_off_armed'] = False
    else:
        if not state.shared.get('_mode_buttons_all_off_armed'):
            state.set_timer('mode_buttons_all_off_since')
            state.shared['_mode_buttons_all_off_armed'] = True

    # ── All OFF for ≥ cooldown_sec → emit default-to-<mode> turn_on ──
    if not on_modes:
        default_mode = bindings.get('default')
        if not default_mode or default_mode not in modes:
            log.debug("mode_buttons: default-mode sentence missing or names unknown mode %r — skipping default-to-X",
                      default_mode)
            return []
        cooldown_raw = state.shared.get('mode_buttons.default_home_cooldown_sec')
        if cooldown_raw is None:
            log.debug("mode_buttons: cooldown sentence missing — skipping default-to-X")
            return []
        try:
            cooldown_sec = int(cooldown_raw)
        except (TypeError, ValueError):
            log.warning("mode_buttons: invalid cooldown value %r — skipping default-to-X", cooldown_raw)
            return []
        all_off_age = state.get_timer('mode_buttons_all_off_since')
        if all_off_age < cooldown_sec:
            return []
        # Disarm so we re-arm cleanly next time + don't refire on every event
        # while still in all-off (the device's response will flip this anyway).
        state.shared['_mode_buttons_all_off_armed'] = False
        d_dev, d_dps = modes[default_mode]
        cmd = {
            'device_id':        d_dev,
            'action':           'turn_on',
            'rule':             'Mode Buttons',
            # Rule reacts to human button input — opt out of the engine's
            # loop-detection so rapid intentional presses can't disable us.
            '_skip_loop_guard': True,
        }
        if d_dps is not None:
            cmd['channel'] = d_dps
        log.info(
            "mode_buttons: all buttons off for %ds (>= %ds) → asserting %s (turn_on dev=%s dps=%s)",
            int(all_off_age), cooldown_sec, default_mode, d_dev, d_dps,
        )
        return [cmd]

    # ── Rising-edge fast path (race-safe) ──
    # A mode SWITCH always starts with the PREVIOUS mode's button still ON —
    # mode buttons don't self-clear (this rule clears them via mutual-exclusivity
    # afterwards), and AWAY/ch8 especially lingers ~14 s because it's the
    # cloud-authoritative datapoint that only clears when HA reports it. So
    # "exactly one button true" almost never holds at switch time, and the
    # most-recent-transition tiebreaker below reads device_events — which does
    # NOT yet contain the just-pressed transition when evaluate() runs. The net
    # effect was that every switch deferred to the next heartbeat (0-60 s lag).
    #
    # Fix: detect which button went FALSE->TRUE in THIS event (a rising edge).
    # That press wins immediately, regardless of other buttons still latched on.
    # Per-button truthiness prefers this event's payload (authoritative for what
    # changed) and falls back to live state for buttons not in the payload.
    fresh_mode = None
    event_dps = event.get('dps') or {}
    if dev_id != 'heartbeat' and dev_id in button_devs:
        cur_truthy = {}
        for mode, (bd, bp) in modes.items():
            key = bp if bp is not None else '1'
            if key in event_dps:
                cur_truthy[mode] = event_dps.get(key) in _TRUTHY_BUTTON_VALUES
            else:
                cur_truthy[mode] = _is_button_on(state, bd, bp)
        last_vals = state.shared.get('_mode_buttons_last_vals') or {}
        if last_vals:  # need a prior snapshot to compute edges
            rising = [m for m, v in cur_truthy.items() if v and not last_vals.get(m, False)]
            if len(rising) == 1:
                fresh_mode = rising[0]
        # Record this event's button truthiness for the next edge computation.
        # Private (_-prefixed) key → doesn't pollute the Runs counter.
        state.shared['_mode_buttons_last_vals'] = cur_truthy

    if fresh_mode:
        active_mode = fresh_mode
    elif len(on_modes) == 1:
        active_mode = on_modes[0]
    else:
        # Multiple ON — pick deterministically + fall through to mutual-exclusivity.
        # Priority: most-recent transition wins. Fallback: previously-stored
        # home_mode if still ON, else first declared mode (insertion order).
        latest_age = float('inf')
        active_mode = None
        for m in on_modes:
            age = _last_change_age(state, *modes[m])
            if age < latest_age:
                latest_age = age
                active_mode = m
        if active_mode is None:
            prev = state.shared.get('home_mode')
            active_mode = prev if prev in on_modes else on_modes[0]
            log.warning(
                "mode_buttons: multi-on with no transition history — falling back to "
                "deterministic winner=%s (on_modes=%s, prev=%s)",
                active_mode, ', '.join(on_modes), prev,
            )

    # ── Write only on transition ──
    prev = state.shared.get('home_mode')
    if prev != active_mode:
        state.shared['home_mode'] = active_mode
        log.info("mode_buttons: home_mode %s -> %s", prev or '(unset)', active_mode)

    # ── Mutual exclusivity ──
    # Whenever a button is currently ON that is NOT the active mode, turn it
    # off. Runs on every event so any drift between panel state and the rule's
    # decision converges within a tick or two. Idempotent — if the OFF command
    # is already reflected in state.devices, _is_button_on returns False and
    # we skip emitting.
    commands = []
    for mode, (bd, bp) in modes.items():
        if mode == active_mode:
            continue
        if _is_button_on(state, bd, bp):
            cmd = {
                'device_id':        bd,
                'action':           'turn_off',
                'rule':             'Mode Buttons',
                # Cleanup commands aren't a runaway — they're intentional
                # mutual-exclusivity enforcement. Skip loop-guard counter
                # so rapid user button presses don't trigger auto-disable.
                '_skip_loop_guard': True,
            }
            if bp is not None:
                cmd['channel'] = bp
            commands.append(cmd)
    if commands:
        log.info(
            "mode_buttons: enforcing mutual-exclusivity — turning off %d non-active buttons (active=%s)",
            len(commands), active_mode,
        )
    return commands
