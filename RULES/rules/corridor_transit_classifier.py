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

state.shared keys owned by this rule:
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
    "depends_on": [],
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

    except Exception as e:
        log.warning("Corridor Transit Classifier: config parse failed (%s) — using defaults", e)

    _config_cache['data'] = cfg
    _config_cache['ts'] = now
    return cfg


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
            _handle_inside_trigger(state, cfg, now)
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
            _handle_inside_trigger(state, cfg, now)
        return commands

    return commands


def _handle_inside_trigger(state, cfg, now):
    """Door rising-edge OR Entrance Presence rising-edge.
    1. Records `last_inside_trigger_ts` (diagnostic only since 2026-06-21 —
       From_Home classification now requires a real door open via
       `last_door_open_ts`, NOT just any inside trigger).
    2. If currently in Visit_Home AND the visit started within window_sec,
       upgrades the mode to To_Home (the "visitor" was actually us coming home).
    3. Lock: if currently in TO_HOME or FROM_HOME, the mode is locked until
       the door closes (handled in _check_timeouts via cooldown). The
       timestamp is still recorded for diagnostics, but no mode change.
    """
    state.shared['corridor_transit.last_inside_trigger_ts'] = now
    mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
    if mode in (MODE_TO_HOME, MODE_FROM_HOME):
        log.debug("Corridor Transit: locked in %s — inside trigger logged but no mode change", mode)
        return
    if mode == MODE_VISIT:
        mode_age = now - float(state.shared.get('corridor_transit.mode_set_ts', 0) or 0)
        if mode_age <= cfg['window_sec']:
            _set_mode(state, MODE_TO_HOME, now)
