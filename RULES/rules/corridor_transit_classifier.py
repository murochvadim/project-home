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

Corridor_To_Home and Corridor_From_Home automatically revert to
Corridor_Clear_Home after `cooldown_sec` has elapsed since the mode was
entered. Corridor_Visit_Home reverts after `window_sec` if no follow-up
inside-trigger arrives.

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
  • corridor_transit.mode                    — current mode string
  • corridor_transit.mode_set_ts             — epoch float when mode was entered
  • corridor_transit.last_inside_trigger_ts  — last door-open / Entrance-pres rising edge
  • corridor_transit.last_corridor_rising_ts — last Corridor rising edge
  • corridor_transit._prev_corridor          — internal: previous Corridor pres value
  • corridor_transit._prev_door              — internal: previous Main Door open value
  • corridor_transit._prev_entrance          — internal: previous Entrance pres value
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

# 30 s TTL on sentence-parse to avoid hitting DB on every event.
_config_cache = {'data': None, 'ts': 0.0}
_CONFIG_TTL_SEC = 30.0


RULE = {
    "name": "Corridor Transit Classifier",
    "description": "Classifies corridor ↔ apartment movement into 4 modes (Clear/Visit/To_Home/From_Home) by time-ordering of Corridor Presence, Main Door, and Entrance Presence events",
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
    "group": "info",
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
    """Auto-revert From_Home / To_Home / Visit_Home back to Clear_Home once
    their respective windows elapse. Called on every event entry."""
    mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
    if mode == MODE_CLEAR:
        return
    mode_age = now - float(state.shared.get('corridor_transit.mode_set_ts', 0) or 0)
    if mode == MODE_VISIT and mode_age >= cfg['window_sec']:
        _set_mode(state, MODE_CLEAR, now)
    elif mode in (MODE_TO_HOME, MODE_FROM_HOME) and mode_age >= cfg['cooldown_sec']:
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
            # Rising edge: classify based on whether an inside-trigger
            # arrived within window_sec.
            last_inside = float(state.shared.get('corridor_transit.last_inside_trigger_ts', 0) or 0)
            state.shared['corridor_transit.last_corridor_rising_ts'] = now
            if last_inside > 0 and (now - last_inside) <= cfg['window_sec']:
                _set_mode(state, MODE_FROM_HOME, now)
            else:
                _set_mode(state, MODE_VISIT, now)
        return commands

    # ── Main Door (door open boolean) ─────────────────────────────────────
    if dev_id == MAIN_DOOR_ID and 'door' in dps:
        is_open = bool(dps.get('door'))
        prev = state.shared.get('corridor_transit._prev_door', False)
        state.shared['corridor_transit._prev_door'] = is_open

        if is_open and not prev:
            # Door rising edge (closed → open) counts as an inside trigger.
            _handle_inside_trigger(state, cfg, now)
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
    1. Records the timestamp (so subsequent Corridor rise can classify as From_Home).
    2. If currently in Visit_Home AND the visit started within window_sec,
       upgrades the mode to To_Home (the "visitor" was actually us coming home).
    """
    state.shared['corridor_transit.last_inside_trigger_ts'] = now
    mode = state.shared.get('corridor_transit.mode', MODE_CLEAR)
    if mode == MODE_VISIT:
        mode_age = now - float(state.shared.get('corridor_transit.mode_set_ts', 0) or 0)
        if mode_age <= cfg['window_sec']:
            _set_mode(state, MODE_TO_HOME, now)
