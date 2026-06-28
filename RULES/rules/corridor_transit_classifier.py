"""Corridor Transit Classifier — 4-state info rule for apartment ↔ corridor traffic.

Classifies movement direction by comparing the time-ordering of three signals:
  • Corridor Presence sensor       (id bfbdca138cb1c78c3dlbmc, dps['1'])
  • Main Door open/close           (id 8d853479-..., dps['door'])
  • Entrance Presence sensor       (id bf4d5e650d32117f49ifvb, dps['1'])

State machine — 4 modes, default Corridor_Clear_Home:

  Corridor_Clear_Home          ◀─── default / fallback after timeouts
       │
       ├─ Corridor rising edge with NO recent inside-trigger ──▶ Corridor_Visit_Home
       │                                                            │
       │                                                            ├─ inside-trigger within window ─▶ Corridor_To_Home
       │                                                            └─ window expires (no follow-up) ─▶ Corridor_Clear_Home
       │
       └─ Inside-trigger (door open / Entrance pres) THEN
          Corridor presence within window           ────────────▶ Corridor_From_Home

Mode lock + cooldown semantics (revised 2026-05-27):
  • Corridor_Visit_Home — auto-reverts to Corridor_Clear_Home after
    `window_sec` if no follow-up inside-trigger arrives. CAN still be
    upgraded to Corridor_To_Home if a door-open / Entrance-presence
    inside-trigger arrives within window_sec.
  • Corridor_To_Home and Corridor_From_Home — LOCKED once entered.
    No further mode changes from any event until the Main Door has a
    falling edge (open → closed). When the door closes, the cooldown
    timer starts; mode reverts to Corridor_Clear_Home after
    `cooldown_sec` of continuously-closed door time. If the door
    re-opens during cooldown, the cooldown is paused (and the next
    door close restarts it from that new close timestamp).
  • Safety net (added 2026-06-21): a max-lock timeout force-reverts
    To_Home/From_Home to Clear_Home after `max_lock_sec` regardless of
    door state, so a lock can never jam forever when the door event is
    missed or the mode was falsely entered.
  • From_Home entry guard (added 2026-06-21): From_Home is entered ONLY
    when a real Main Door OPEN happened within `window_sec` before the
    corridor presence — Entrance presence alone classifies as Visit, not
    a leave. Stops a neighbor passing the corridor from suppressing the
    apartment's corridor monitoring (Move in Corridor's when-home bucket).
  • Rationale: avoids mode flip-flopping during a transit moment.
    Once we decide "user is coming home" or "user is leaving", commit
    to that decision until the physical transit is complete (door shut).

Outputs (info-only — no device commands):
  • state.shared['corridor_transit.mode']  — current mode string, polled
    by the dashboard for display
  • virtual:corridor_transit  — emits on every mode change with
    dps = {mode, mode_set_ts, prior_mode}, so other rules can react to
    transitions historically (e.g. "if mode flipped to Corridor_To_Home in
    the last 30 s, push a Pixoo welcome preset").

Coexists with Move in Corridor (which fires actions on corridor presence).
This rule is the classifier — separate concerns, no overlap.

Sentence-driven knobs (container `r_corridor_transit_init`):
  • s_ct1_window    — "Corridor Transit: window is N seconds"
                      (the N for rising-edge correlation + Visit_Home timeout)
  • s_ct2_cooldown  — "Corridor Transit: cooldown is N seconds"
                      (after From_Home / To_Home before returning to Clear_Home)
  • s_ct6_dwell     — "Corridor Transit: ignore coming home for N seconds after
                      going away" — the "just-left" guard: suppresses the set-home
                      HOME-press when home_mode went away/abroad < N s ago (you
                      pressed Away and walked out → leaving, not arriving).

state.shared keys owned by this rule:
  • corridor_transit.away_since_ts                 — epoch float when home_mode last
                                                     ENTERED away/abroad (just-left guard)
  • corridor_transit._prev_home_mode               — internal: previous home_mode value
  • corridor_transit.mode                          — current mode string
  • corridor_transit.mode_set_ts                   — epoch float when mode was entered
  • corridor_transit.last_inside_trigger_ts        — last door-open / Entrance-pres rising edge
  • corridor_transit.last_door_open_ts             — last Main Door rising edge (closed → open);
                                                     From_Home entry requires this within window_sec
  • corridor_transit.last_corridor_rising_ts       — last Corridor rising edge
  • corridor_transit.door_closed_after_mode_set_ts — epoch float of the most recent Main Door
                                                     falling edge (open → closed) while in
                                                     TO_HOME or FROM_HOME mode. Reset to 0
                                                     on every mode change. Used by
                                                     _check_timeouts as the cooldown anchor
                                                     for TO_HOME/FROM_HOME revert.
  • corridor_transit._prev_corridor                — internal: previous Corridor pres value
  • corridor_transit._prev_door                    — internal: previous Main Door open value
  • corridor_transit._prev_entrance                — internal: previous Entrance pres value
"""

import json
import logging
import re
import time

log = logging.getLogger("rule.corridor_transit_classifier")

# Trigger device IDs — hardcoded because RULE['triggers'] is fixed at module load.
CORRIDOR_PRESENCE_ID = 'bfbdca138cb1c78c3dlbmc'
MAIN_DOOR_ID         = '8d853479-bb87-4d2e-9350-fb8fc5c486d5'
ENTRANCE_PRESENCE_ID = 'bf4d5e650d32117f49ifvb'

# Mode constants
MODE_CLEAR     = 'Corridor_Clear_Home'
MODE_VISIT     = 'Corridor_Visit_Home'
MODE_TO_HOME   = 'Corridor_To_Home'
MODE_FROM_HOME = 'Corridor_From_Home'

VIRTUAL_ID = 'virtual:corridor_transit'

# Defaults — overridden by container `r_corridor_transit_init`.
DEFAULTS_WINDOW_SEC   = 15
DEFAULTS_COOLDOWN_SEC = 30
# Safety net: force-revert a locked To_Home/From_Home back to Clear_Home after
# this many seconds regardless of door state. Without it, a lock entered without
# a real door event (presence coincidence) or whose door-close was missed never
# releases — the 2026-06-21 stuck-From_Home incident (jammed ~2 h, suppressing
# corridor monitoring the whole time).
DEFAULTS_MAX_LOCK_SEC = 180
# "Just-left" guard: a real arrival means you were actually gone a while. If
# home_mode entered away/abroad LESS than this many seconds ago, a corridor+door
# pattern is you LEAVING (you pressed Away then walked out), NOT coming home — so
# the set-home HOME-press is suppressed. Fixes Away being cancelled ~3 s after you
# press it (2026-06-28 "Evening Lights fired while away" incident). 0 = disabled.
DEFAULTS_MIN_AWAY_DWELL_SEC = 90

# 30 s TTL on sentence-parse to avoid hitting DB on every event.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Corridor Transit Classifier",
    "description": "Figures out whether someone is just passing your door, coming home, or leaving — by watching the order of the building corridor sensor, your front door, and the entrance sensor.",
    # Three real device triggers + heartbeat so timeouts fire even in quiet
    # apartments (heartbeat is a synthetic 60 s tick — see CLAUDE.md).
    "triggers": [
        CORRIDOR_PRESENCE_ID,
        MAIN_DOOR_ID,
        ENTRANCE_PRESENCE_ID,
        'heartbeat',
    ],
    "controls": [],
    "category": "info",
    "group": "corridor",
    "priority": 10,
    # Reads state.shared['home_mode'] (sole-written by Mode Buttons) for the
    # coming-home gate + set-home action — depend on it so on shared ticks
    # (heartbeat) Mode Buttons resolves home_mode first.
    "depends_on": ["Mode Buttons"],
}


def _read_config(state):
    """Parse r_corridor_transit_init container. Returns {window_sec, cooldown_sec}."""
    now = time.time()
    if _config_cache['data'] is not None and (now - _config_cache['ts']) < _CONFIG_TTL_SEC:
        return _config_cache['data']

    cfg = {
        'window_sec':   DEFAULTS_WINDOW_SEC,
        'cooldown_sec': DEFAULTS_COOLDOWN_SEC,
        'max_lock_sec': DEFAULTS_MAX_LOCK_SEC,
        # Change 1 — gate: classify To_Home (coming home) only when home_mode is
        # in this set (e.g. {'away','abroad'}). None = no gate (legacy behavior).
        'coming_home_modes': None,
        # Change 2 — set-home action: press this device/channel (the HOME button)
        # on a door-confirmed arrival. None = no action authored.
        'set_home_device':   None,
        'set_home_channel':  None,
        # "Just-left" dwell guard (see DEFAULTS_MIN_AWAY_DWELL_SEC).
        'min_away_dwell_sec': DEFAULTS_MIN_AWAY_DWELL_SEC,
    }
    try:
        rows = state.db_query(
            "SELECT value FROM dashboard_settings WHERE key='apartment.rule_sentences'"
        )
        if not rows:
            raise RuntimeError("no sentence config row")
        containers = rows[0][0]
        if isinstance(containers, str):
            containers = json.loads(containers)
        container = next((c for c in containers if c.get('id') == 'r_corridor_transit_init'), None)
        if not container:
            raise RuntimeError("container r_corridor_transit_init not found")

        for sentence in container.get('sentences', []):
            if not sentence.get('active', True):
                continue
            full_text = ''.join(seg.get('v', '') for seg in sentence.get('segments', []))
            t = full_text.lower()
            if 'window is' in t:
                m = re.search(r'window is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['window_sec'] = int(m.group(1))
                    continue
            if 'cooldown is' in t:
                m = re.search(r'cooldown is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['cooldown_sec'] = int(m.group(1))
                    continue
            if 'max lock is' in t:
                m = re.search(r'max lock is\s+(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['max_lock_sec'] = int(m.group(1))
                    continue
            # "Just-left" guard — "ignore coming home for N seconds after going away".
            if 'after going away' in t:
                m = re.search(r'(\d+)\s*seconds?', full_text, re.I)
                if m:
                    cfg['min_away_dwell_sec'] = int(m.group(1))
                    continue
            # Change 1 — coming-home home-mode gate. Modes are taken from the
            # words after "home mode" so the leading "coming home" isn't counted.
            if 'coming home' in t and 'home mode' in t:
                after = t.split('home mode', 1)[1]
                modes = set(re.findall(r'\b(home|away|abroad)\b', after))
                if modes:
                    cfg['coming_home_modes'] = modes
                continue
            # Change 2 — set-home action: a device chip ("turn on @<Device> <Channel>").
            if 'coming home' in t and 'turn on' in t:
                for seg in sentence.get('segments', []):
                    if (seg.get('t') or '').lower() == 'dev':
                        resolved = _resolve_chip(state, seg.get('v', ''))
                        if resolved:
                            cfg['set_home_device'], cfg['set_home_channel'] = resolved
                        break
                continue

    except Exception as e:
        log.warning("Corridor Transit Classifier: config parse failed (%s) — using defaults", e)

    _config_cache['data'] = cfg
    _config_cache['ts'] = now
    return cfg


def _resolve_chip(state, chip_value):
    """Resolve '@<Device Name> <Channel Label>' → (device_id, dps_key) or None.
    Longest-name-prefix match against devices.name; the remainder is matched
    against that device's dps_labels VALUES to find the channel's dps key.
    Same chip shape Mode Buttons / the +Dev picker use (e.g. '@8 Gang Switch HOME')."""
    if not chip_value or not chip_value.startswith('@'):
        return None
    text = chip_value[1:].strip()
    if not text:
        return None
    items = [((dev.get('name') or '').strip(), dev_id, dev)
             for dev_id, dev in (state.devices or {}).items()
             if (dev.get('name') or '').strip()]
    items.sort(key=lambda x: len(x[0]), reverse=True)   # longest name wins
    for name, dev_id, dev in items:
        if text == name:
            return (dev_id, None)
        if text.startswith(name + ' '):
            label = text[len(name) + 1:].strip()
            for k, v in (dev.get('dps_labels') or {}).items():
                if v == label:
                    return (dev_id, k)
            return (dev_id, None)
    return None


def _set_mode(state, new_mode, now):
    """Update mode + emit virtual event on change. Idempotent: no-op if mode unchanged."""
    prior = state.shared.get('corridor_transit.mode', MODE_CLEAR)
    if prior == new_mode:
        return
    state.shared['corridor_transit.mode']        = new_mode
    state.shared['corridor_transit.mode_set_ts'] = now
    # Reset the door-closed-anchor on every mode change. The new mode owns
    # its own cooldown window starting from the NEXT door close (if any).
    state.shared['corridor_transit.door_closed_after_mode_set_ts'] = 0
    log.info("Corridor Transit: mode %s → %s", prior, new_mode)
    state.emit_virtual_event(
        virtual_id=VIRTUAL_ID,
        dps={
            'mode':        new_mode,
            'prior_mode':  prior,
            'mode_set_ts': round(now, 1),
        },
        source='rule:Corridor Transit Classifier',
        name='Corridor Transit',
        dps_labels={
            'mode':        'Mode',
            'prior_mode':  'Prior Mode',
            'mode_set_ts': 'Mode Set TS',
        },
    )


def _check_timeouts(state, cfg, now):
    """Auto-revert non-CLEAR modes back to Clear_Home when their timeout
    condition is satisfied. Called on every event entry (including heartbeat).

    Revised 2026-05-27:
      • VISIT — unchanged: reverts after `window_sec` from mode_set_ts.
      • TO_HOME / FROM_HOME — LOCKED until Main Door closes. Cooldown
        timer (`cooldown_sec`) starts from the most recent door
        falling edge (open → closed) that happened AFTER mode entry.
        Cooldown only counts while the door is currently closed —
        if it re-opens, cooldown pauses (the next close timestamp
        replaces the anchor when this function is called again).
    """
    mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
    if mode == MODE_CLEAR:
        return
    if mode == MODE_VISIT:
        mode_age = now - float(state.shared.get('corridor_transit.mode_set_ts', 0) or 0)
        if mode_age >= cfg['window_sec']:
            _set_mode(state, MODE_CLEAR, now)
        return
    # TO_HOME / FROM_HOME — locked until the Main Door closes.
    # Safety net FIRST: if we've been locked longer than max_lock_sec, force-
    # revert regardless of door state. A lock entered without a real door event
    # (presence coincidence) or whose door-close was missed otherwise never
    # releases (no falling edge → no anchor → permanently stuck). See the
    # 2026-06-21 incident where From_Home jammed for ~2 h and suppressed all
    # corridor monitoring.
    mode_age = now - float(state.shared.get('corridor_transit.mode_set_ts', 0) or 0)
    if mode_age >= cfg['max_lock_sec']:
        log.info("Corridor Transit: %s locked %ds >= max_lock %ds — force-revert to Clear_Home",
                 mode, int(mode_age), cfg['max_lock_sec'])
        _set_mode(state, MODE_CLEAR, now)
        return
    # Cooldown only counts when door has closed since mode entered AND is
    # currently closed.
    door_closed_ts = float(state.shared.get('corridor_transit.door_closed_after_mode_set_ts', 0) or 0)
    door_is_open   = bool(state.shared.get('corridor_transit._prev_door', False))
    if door_closed_ts <= 0:
        return                                  # door hasn't closed yet → locked
    if door_is_open:
        return                                  # door re-opened during cooldown → paused
    if (now - door_closed_ts) >= cfg['cooldown_sec']:
        _set_mode(state, MODE_CLEAR, now)


def evaluate(event, state):
    commands = []
    now = time.time()
    cfg = _read_config(state)

    # Track when home_mode ENTERED away/abroad (rising edge only — must stay stable
    # while away so a 20-min-later arrival still measures the full dwell). The
    # "just-left" guard in _handle_inside_trigger reads corridor_transit.away_since_ts.
    _hm = (state.shared.get('home_mode') or '').lower()
    _prev_hm = state.shared.get('corridor_transit._prev_home_mode', '')
    if _hm in ('away', 'abroad') and _prev_hm not in ('away', 'abroad'):
        state.shared['corridor_transit.away_since_ts'] = now
    state.shared['corridor_transit._prev_home_mode'] = _hm

    # Always check timeouts first — fixes mode transitions even on unrelated
    # events arriving at this rule (and on heartbeat).
    _check_timeouts(state, cfg, now)

    dev_id = event.get('device_id', '')
    dps    = event.get('dps', {}) or {}

    # ── Heartbeat tick — timeout check above is the only work needed. ────
    if dev_id == 'heartbeat':
        return commands

    # ── Corridor Presence ────────────────────────────────────────────────
    if dev_id == CORRIDOR_PRESENCE_ID and '1' in dps:
        is_presence = dps.get('1') in ('presence', True, 'true', 1)
        prev = state.shared.get('corridor_transit._prev_corridor', 'none')
        state.shared['corridor_transit._prev_corridor'] = 'presence' if is_presence else 'none'

        if is_presence and prev != 'presence':
            # Rising edge — record the timestamp regardless of lock state
            # (useful for diagnostics) before deciding whether to update mode.
            state.shared['corridor_transit.last_corridor_rising_ts'] = now
            current_mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
            # Lock: TO_HOME / FROM_HOME stay until door close + cooldown.
            # New corridor rising edges during the lock are ignored.
            if current_mode in (MODE_TO_HOME, MODE_FROM_HOME):
                log.debug("Corridor Transit: locked in %s — Corridor rising edge ignored",
                          current_mode)
                return commands
            # Classify. A real LEAVE requires a recent Main Door OPEN just
            # before the corridor presence — you physically opened the door to
            # step out. Entrance presence ALONE is NOT enough: it fires when you
            # merely walk near the entrance while a neighbor passes the building
            # corridor, which used to be misread as From_Home and then jammed
            # the lock forever (no door close → no release; 2026-06-21 incident).
            last_door_open = float(state.shared.get('corridor_transit.last_door_open_ts', 0) or 0)
            if last_door_open > 0 and (now - last_door_open) <= cfg['window_sec']:
                _set_mode(state, MODE_FROM_HOME, now)
            else:
                # No recent door open → corridor presence without a real exit
                # → treat as a Visit (when-home monitoring still fires).
                _set_mode(state, MODE_VISIT, now)
        return commands

    # ── Main Door (door open boolean) ─────────────────────────────────────
    if dev_id == MAIN_DOOR_ID and 'door' in dps:
        is_open = bool(dps.get('door'))
        prev = state.shared.get('corridor_transit._prev_door', False)
        state.shared['corridor_transit._prev_door'] = is_open

        if is_open and not prev:
            # Door rising edge (closed → open) counts as an inside trigger.
            # Record the door-open time SEPARATELY so From_Home entry can
            # require a REAL door open (not just Entrance presence) — a neighbor
            # passing the building corridor must not be misread as us leaving
            # (2026-06-21 fix).
            state.shared['corridor_transit.last_door_open_ts'] = now
            commands += _handle_inside_trigger(state, cfg, now, 'door')
        elif not is_open and prev:
            # Door falling edge (open → closed). If we're currently locked
            # in TO_HOME or FROM_HOME, this is the cooldown anchor —
            # _check_timeouts will revert to CLEAR cooldown_sec after this
            # timestamp (as long as the door stays closed).
            mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
            if mode in (MODE_TO_HOME, MODE_FROM_HOME):
                state.shared['corridor_transit.door_closed_after_mode_set_ts'] = now
                log.info("Corridor Transit: Main Door closed in %s — cooldown anchor set, "
                         "%ds until revert to Clear_Home",
                         mode, cfg['cooldown_sec'])
        return commands

    # ── Entrance Presence ─────────────────────────────────────────────────
    if dev_id == ENTRANCE_PRESENCE_ID and '1' in dps:
        is_presence = dps.get('1') in ('presence', True, 'true', 1)
        prev = state.shared.get('corridor_transit._prev_entrance', 'none')
        state.shared['corridor_transit._prev_entrance'] = 'presence' if is_presence else 'none'

        if is_presence and prev != 'presence':
            commands += _handle_inside_trigger(state, cfg, now, 'entrance')
        return commands

    return commands


def _handle_inside_trigger(state, cfg, now, trigger):
    """Door rising-edge OR Entrance Presence rising-edge. `trigger` is 'door' or
    'entrance'. Returns a list of commands (the set-home button press, if any).

    Upgrades Visit_Home → To_Home when the visit started within window_sec, with:

    • Change 1 (coming-home gate): the upgrade only happens when home_mode is in
      cfg['coming_home_modes'] (e.g. away/abroad). Opening the front door while
      already HOME is therefore NOT misread as an arrival (it stays Visit).
      No gate sentence → legacy behavior (upgrade in any mode).

    • Change 2 (set home on arrival): when the upgrade is completed by a REAL
      Main Door open (trigger=='door') that followed the corridor presence, and a
      set-home device is configured, emit a turn_on on the HOME button so Mode
      Buttons switches the house to home. Entrance-presence-only completions do
      NOT set home (the door must have opened after the presence).

    Lock: in TO_HOME / FROM_HOME the mode is held until the door closes
    (cooldown in _check_timeouts) — timestamp logged, no mode change.
    """
    state.shared['corridor_transit.last_inside_trigger_ts'] = now
    mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
    if mode in (MODE_TO_HOME, MODE_FROM_HOME):
        log.debug("Corridor Transit: locked in %s — inside trigger logged but no mode change", mode)
        return []
    if mode != MODE_VISIT:
        return []
    mode_age = now - float(state.shared.get('corridor_transit.mode_set_ts', 0) or 0)
    if mode_age > cfg['window_sec']:
        return []

    # ── Change 1 — coming-home home-mode gate ──
    home_mode = (state.shared.get('home_mode') or '').lower()
    gate = cfg.get('coming_home_modes')
    if gate is not None and home_mode not in gate:
        log.info("Corridor Transit: corridor→inside trigger but home_mode=%s not in %s "
                 "— staying Visit (not coming-home)", home_mode or '?', sorted(gate))
        return []

    _set_mode(state, MODE_TO_HOME, now)

    # ── Change 2 — set home on a door-confirmed arrival ──
    if trigger != 'door':
        return []                               # entrance presence completed it → no set-home
    dev = cfg.get('set_home_device')
    if not dev:
        return []                               # no set-home sentence authored
    if home_mode not in (gate or {'away', 'abroad'}):
        return []
    last_door = float(state.shared.get('corridor_transit.last_door_open_ts', 0) or 0)
    last_corr = float(state.shared.get('corridor_transit.last_corridor_rising_ts', 0) or 0)
    if last_door < last_corr:
        return []                               # door must have opened AFTER the corridor presence

    # ── "Just-left" guard ──
    # Pressing AWAY then walking out produces the SAME corridor-presence + door-open
    # pattern as coming home. A real arrival means you were actually gone a while,
    # so if home_mode entered away/abroad only moments ago, this is you LEAVING —
    # do NOT press HOME (which would cancel the Away you just set).
    dwell = cfg.get('min_away_dwell_sec') or 0
    if dwell > 0:
        away_since = float(state.shared.get('corridor_transit.away_since_ts', 0) or 0)
        if away_since > 0 and (now - away_since) < dwell:
            log.info("Corridor Transit: 'arrival' only %.0fs after going away (< %ds dwell) "
                     "— treating as LEAVING, NOT pressing HOME", now - away_since, dwell)
            return []

    cmd = {
        'device_id': dev,
        'action': 'turn_on',
        'rule': 'Corridor Transit Classifier',
        '_skip_loop_guard': True,               # intentional button press, not a runaway loop
    }
    if cfg.get('set_home_channel') is not None:
        cmd['channel'] = cfg['set_home_channel']
    log.info("Corridor Transit: door-confirmed arrival (home_mode=%s) → pressing HOME (dev=%s ch=%s)",
             home_mode, dev, cfg.get('set_home_channel'))
    return [cmd]
