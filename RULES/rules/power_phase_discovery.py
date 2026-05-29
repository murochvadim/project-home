"""Power Phase Discovery — state recognition for auto-registered devices.

P3 of the POWER subsystem. On every Shelly 3EM event, computes per-phase
delta vs the previous in-memory sample. For each auto-registered device
(power_devices.source IN ('auto_pending','auto_custom','auto_discovered')),
checks whether the delta on its registered phase falls inside the device's
expected/max range. On confirmed match, flips power_devices.live and emits
a virtual:power_state event so history queries can reproduce the timeline.

Does NOT learn signatures — that's a deliberate scope flip (2026-05-29).
The user supplies expected_w + max_w per device via the Project Power page's
Device Registry (P2). This rule's job is purely state recognition + DB write.

Knobs are sentence-driven via the `r_power_discovery_init` container in
apartment.rule_sentences:
  - "Power Discovery: noise floor is N watts"      → power_discovery.noise_floor_w
  - "Power Discovery: settling delay is N seconds" → power_discovery.settling_sec
  - "Power Discovery: tolerance low is X.XX"       → power_discovery.tol_low
  - "Power Discovery: tolerance high is X.XX"      → power_discovery.tol_high
  - "Power Discovery: post-flip lock is N seconds" → power_discovery.post_flip_lock_sec

Cost: queries power_devices once per 30 s (TTL cache); no DB read per event.
Per-device cooldown after each flip filters Shelly's oscillation on sharp
on/off edges.
"""

import logging
import time
import json

log = logging.getLogger('rule.power_phase_discovery')

SHELLY_ID = 'shelly_3em_main'

# Defaults — used only when the corresponding sentence doesn't exist yet.
# Real values come from state.shared['power_discovery.*'] populated by the
# heartbeat's _parse_knob_sentences pass over r_power_discovery_init.
DEFAULT_NOISE_FLOOR_W       = 10
DEFAULT_SETTLING_SEC        = 2
DEFAULT_TOL_LOW             = 0.7
DEFAULT_TOL_HIGH            = 1.15
DEFAULT_POST_FLIP_LOCK_SEC  = 5

_REGISTRY_CACHE_TTL_SEC     = 30

RULE = {
    "name":        "Power Phase Discovery",
    "description": "Match Shelly per-phase deltas to auto-registered devices' expected/max ranges; flip power_devices.live",
    "triggers":    [SHELLY_ID],
    "controls":    [],
    "category":    "info",
    "group":       "power",
    "priority":    20,
    "depends_on":  ["Power Ingest"],
}


def _knob_float(state, key, default):
    v = state.shared.get(key)
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _load_auto_registry(state):
    """TTL-cached read of auto-registered power_devices rows. Returns list of
    dicts shaped: {device_id, phase, is_three_phase, config_dict}.
    """
    cache = state.shared.get('_power_discovery.registry_cache')
    cache_ts = float(state.shared.get('_power_discovery.registry_cache_ts', 0))
    if cache and (time.time() - cache_ts) < _REGISTRY_CACHE_TTL_SEC:
        return cache
    rows = state.db_query(
        """
        SELECT device_id, phase, is_three_phase, config
        FROM power_devices
        WHERE source IN ('auto_pending', 'auto_custom', 'auto_discovered')
        """
    )
    # state.db_query returns positional tuples (psycopg default cursor),
    # matching the SELECT order: 0=device_id, 1=phase, 2=is_three_phase, 3=config.
    out = []
    for r in (rows or []):
        cfg = r[3] or {}
        if isinstance(cfg, str):
            try: cfg = json.loads(cfg)
            except Exception: cfg = {}
        out.append({
            'device_id':      r[0],
            'phase':          r[1],
            'is_three_phase': bool(r[2]),
            'config':         cfg,
        })
    state.shared['_power_discovery.registry_cache']    = out
    state.shared['_power_discovery.registry_cache_ts'] = time.time()
    return out


def _in_range(delta_w, expected_w, max_w, tol_low, tol_high):
    if expected_w is None or expected_w <= 0:
        return False
    lo = expected_w * tol_low
    hi = (max_w if (max_w and max_w > expected_w) else expected_w) * tol_high
    return lo <= abs(delta_w) <= hi


def _candidate_score(delta_w, expected_w):
    """Lower = better match. Used to break ties when multiple devices' ranges
    overlap the same delta — picks the one whose expected_w is closest.
    """
    if not expected_w:
        return float('inf')
    return abs(abs(delta_w) - expected_w) / expected_w


def _phase_match(reg_row, delta_r, delta_s, delta_t, tol_low, tol_high, want_on):
    """For a single-phase device: returns delta on its phase if it's in range
    and sign matches want_on (positive Δ = turning on, negative = off).
    For a 3-phase device: returns total |Δ| across phases if ALL three per-
    phase deltas hit their per-phase range. Returns None on mismatch.
    """
    cfg = reg_row['config']
    if reg_row['is_three_phase']:
        signs = []
        score_sum = 0.0
        total_delta = 0.0
        for phase_char, phase_delta in (('r', delta_r), ('s', delta_s), ('t', delta_t)):
            exp = cfg.get(f'{phase_char}_expected_w')
            mx  = cfg.get(f'{phase_char}_max_w')
            if not exp:                    # phase not used by this device
                if abs(phase_delta) > 0:   # phase has activity but device doesn't draw on it
                    pass                   # tolerated — other devices on this phase
                continue
            if not _in_range(phase_delta, exp, mx, tol_low, tol_high):
                return None, None
            sign = 1 if phase_delta > 0 else -1
            if want_on and sign != 1:  return None, None
            if (not want_on) and sign != -1: return None, None
            signs.append(sign)
            score_sum += _candidate_score(phase_delta, exp)
            total_delta += abs(phase_delta)
        if not signs:
            return None, None
        return total_delta, score_sum / len(signs)
    # Single phase
    phase = (reg_row['phase'] or '').upper()
    if phase not in ('R', 'S', 'T'):
        return None, None
    delta = {'R': delta_r, 'S': delta_s, 'T': delta_t}[phase]
    if want_on and delta <= 0:    return None, None
    if (not want_on) and delta >= 0: return None, None
    if not _in_range(delta, cfg.get('expected_w'), cfg.get('max_w'),
                     tol_low, tol_high):
        return None, None
    return abs(delta), _candidate_score(delta, cfg.get('expected_w'))


def _confirm_flip(state, reg_row, delta_total, want_on, now):
    """Write the new state into power_devices.live + emit virtual:power_state."""
    cfg = reg_row['config']
    if reg_row['is_three_phase'] and want_on:
        live = {
            'on':   True,
            'r_w':  int(round(cfg.get('r_expected_w') or 0)),
            's_w':  int(round(cfg.get('s_expected_w') or 0)),
            't_w':  int(round(cfg.get('t_expected_w') or 0)),
            'ts':   time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
        }
    elif want_on:
        live = {
            'on': True,
            'w':  int(round(delta_total)),
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
        }
    else:
        live = {'on': False, 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))}

    state.db_execute(
        "UPDATE power_devices SET live = %s::jsonb, last_observed_at = NOW(), updated_at = NOW() WHERE device_id = %s",
        (json.dumps(live), reg_row['device_id']),
    )

    state.emit_virtual_event(
        virtual_id='virtual:power_state',
        dps={
            'device_id': reg_row['device_id'],
            'phase':     reg_row['phase'] or 'RST',
            'on':        bool(want_on),
            'w':         int(round(delta_total)) if want_on else 0,
        },
        source='rule:Power Phase Discovery',
        name='Power State',
        dps_labels={
            'device_id': 'Device',
            'phase':     'Phase',
            'on':        'On',
            'w':         'Watts',
        },
    )


def evaluate(event, state):
    if event.get('device_id') != SHELLY_ID:
        return []

    dev = state.devices.get(SHELLY_ID)
    if not dev:
        return []
    dps = dev.get('dps') or {}
    r_w, s_w, t_w = dps.get('r_w'), dps.get('s_w'), dps.get('t_w')
    if not all(isinstance(x, (int, float)) for x in (r_w, s_w, t_w)):
        return []

    prev = state.shared.get('_power_discovery.prev_w') or {}
    state.shared['_power_discovery.prev_w'] = {'r': r_w, 's': s_w, 't': t_w}
    if not prev:
        return []   # first sample — nothing to compare to

    delta_r = r_w - prev.get('r', r_w)
    delta_s = s_w - prev.get('s', s_w)
    delta_t = t_w - prev.get('t', t_w)

    noise_floor = _knob_float(state, 'power_discovery.noise_floor_w', DEFAULT_NOISE_FLOOR_W)
    if max(abs(delta_r), abs(delta_s), abs(delta_t)) < noise_floor:
        return []

    tol_low   = _knob_float(state, 'power_discovery.tol_low',  DEFAULT_TOL_LOW)
    tol_high  = _knob_float(state, 'power_discovery.tol_high', DEFAULT_TOL_HIGH)
    settling  = _knob_float(state, 'power_discovery.settling_sec', DEFAULT_SETTLING_SEC)
    post_lock = _knob_float(state, 'power_discovery.post_flip_lock_sec', DEFAULT_POST_FLIP_LOCK_SEC)

    registry = _load_auto_registry(state)
    if not registry:
        return []

    now    = time.time()
    locks  = state.shared.get('_power_discovery.lock_until') or {}
    cands  = state.shared.get('_power_discovery.candidates')  or {}
    flips  = []

    # For each device currently OFF look for a positive-Δ match; for each
    # device currently ON look for a negative-Δ match. live.on lives in the
    # registry cache's row (synced from DB).
    live_state = state.shared.get('_power_discovery.live_state') or {}
    for reg in registry:
        did = reg['device_id']
        if locks.get(did, 0) > now:
            continue
        want_on = not bool(live_state.get(did, False))
        total, score = _phase_match(reg, delta_r, delta_s, delta_t, tol_low, tol_high, want_on)
        if total is None:
            continue
        # Candidate found — start settling timer if not already counting.
        prior = cands.get(did)
        if not prior or prior.get('want_on') != want_on:
            cands[did] = {'want_on': want_on, 'start_ts': now, 'total': total, 'score': score}
        else:
            # Update most-recent reading; settling timer continues
            prior['total'] = total
            prior['score'] = score

    # Promote candidates that have settled.
    to_clear = []
    for did, c in cands.items():
        if (now - c['start_ts']) >= settling:
            # Multi-candidate: only one winner per Δ event. If multiple
            # candidates fire on the same tick, pick the lowest score (closest
            # to expected_w) and skip the rest until next event.
            flips.append((did, c['want_on'], c['total'], c['score']))
            to_clear.append(did)

    # Sort by score asc → take winner, clear others (they'll re-enter cands
    # on the next event if their Δ is still observable).
    flips.sort(key=lambda x: x[3])
    fired_this_tick = set()
    for did, want_on, total, _score in flips:
        if did in fired_this_tick:
            continue
        reg = next((r for r in registry if r['device_id'] == did), None)
        if not reg:
            to_clear.append(did)
            continue
        try:
            _confirm_flip(state, reg, total, want_on, now)
            live_state[did] = bool(want_on)
            locks[did] = now + post_lock
            log.info("power_phase_discovery: %s -> %s (Δ=%s W)",
                     did, 'ON' if want_on else 'OFF', int(round(total)))
        except Exception as e:
            log.warning("power_phase_discovery: confirm failed for %s: %s", did, e)
        fired_this_tick.add(did)

    for did in to_clear:
        cands.pop(did, None)

    state.shared['_power_discovery.candidates'] = cands
    state.shared['_power_discovery.lock_until'] = locks
    state.shared['_power_discovery.live_state'] = live_state

    return []
