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
  - "Power Discovery: delta window is N seconds"   → power_discovery.delta_window_sec

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
DEFAULT_DELTA_WINDOW_SEC    = 12   # compare power across this window, not event-to-event

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
        SELECT row_id, device_id, channel, phase, is_three_phase, config
        FROM power_devices
        WHERE source IN ('auto_pending', 'auto_custom', 'auto_discovered')
        """
    )
    # state.db_query returns positional tuples (psycopg default cursor),
    # matching the SELECT order:
    #   0=row_id, 1=device_id, 2=channel, 3=phase, 4=is_three_phase, 5=config
    out = []
    for r in (rows or []):
        cfg = r[5] or {}
        if isinstance(cfg, str):
            try: cfg = json.loads(cfg)
            except Exception: cfg = {}
        out.append({
            'row_id':         int(r[0]),
            'device_id':      r[1],
            'channel':        r[2],         # None for whole-device rows
            'phase':          r[3],
            'is_three_phase': bool(r[4]),
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
        "UPDATE power_devices SET live = %s::jsonb, last_observed_at = NOW(), updated_at = NOW() WHERE row_id = %s",
        (json.dumps(live), reg_row['row_id']),
    )

    state.emit_virtual_event(
        virtual_id='virtual:power_state',
        dps={
            'device_id': reg_row['device_id'],
            'channel':   reg_row['channel'] or '',
            'phase':     reg_row['phase'] or 'RST',
            'on':        bool(want_on),
            'w':         int(round(delta_total)) if want_on else 0,
        },
        source='rule:Power Phase Discovery',
        name='Power State',
        dps_labels={
            'device_id': 'Device',
            'channel':   'Channel',
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

    # Sliding-window delta (fix 2026-06-08). The Shelly pushes ~1 event/s, but a
    # real load (e.g. an inverter AC) ramps over ~10+ s — so an event-to-event
    # delta is far below any device's threshold and auto devices were NEVER
    # recognized. We instead measure each phase against the sample from
    # ~`delta_window_sec` ago (a TRAILING window over a small in-memory history),
    # so a gradual ramp accumulates into one big step REGARDLESS of when it
    # started — no window-boundary straddle (the earlier fixed-tick "plateau"
    # variant could re-anchor mid-ramp and miss the step). Mirrors the 13 s
    # ingest snapshots that empirically caught the AC's ~1145 W turn-on.
    now    = time.time()
    window = _knob_float(state, 'power_discovery.delta_window_sec', DEFAULT_DELTA_WINDOW_SEC)
    hist = state.shared.get('_power_discovery.history') or []
    hist.append([now, r_w, s_w, t_w])
    hist = [h for h in hist if h[0] >= now - (window * 2)]   # keep ~2 windows of samples
    state.shared['_power_discovery.history'] = hist
    # Baseline = the most-recent sample that is at least `window` seconds old.
    baseline = None
    for h in hist:
        if (now - h[0]) >= window:
            baseline = h
    if baseline is None:
        return []   # history doesn't span the window yet (warm-up after start/reload)

    delta_r = r_w - baseline[1]
    delta_s = s_w - baseline[2]
    delta_t = t_w - baseline[3]

    noise_floor = _knob_float(state, 'power_discovery.noise_floor_w', DEFAULT_NOISE_FLOOR_W)
    if max(abs(delta_r), abs(delta_s), abs(delta_t)) < noise_floor:
        return []   # no significant change across the window

    tol_low   = _knob_float(state, 'power_discovery.tol_low',  DEFAULT_TOL_LOW)
    tol_high  = _knob_float(state, 'power_discovery.tol_high', DEFAULT_TOL_HIGH)
    settling  = _knob_float(state, 'power_discovery.settling_sec', DEFAULT_SETTLING_SEC)
    post_lock = _knob_float(state, 'power_discovery.post_flip_lock_sec', DEFAULT_POST_FLIP_LOCK_SEC)

    registry = _load_auto_registry(state)
    if not registry:
        return []

    # All per-device state is keyed by row_id (synthetic PK on power_devices),
    # since one device_id can now have multiple registered rows (one per
    # channel of a multi-gang switch).
    locks  = state.shared.get('_power_discovery.lock_until') or {}
    cands  = state.shared.get('_power_discovery.candidates')  or {}
    flips  = []

    live_state = state.shared.get('_power_discovery.live_state') or {}
    for reg in registry:
        rid = str(reg['row_id'])   # state.shared serializes JSON; keys become strings
        if locks.get(rid, 0) > now:
            continue
        want_on = not bool(live_state.get(rid, False))
        total, score = _phase_match(reg, delta_r, delta_s, delta_t, tol_low, tol_high, want_on)
        if total is None:
            continue
        prior = cands.get(rid)
        if not prior or prior.get('want_on') != want_on:
            cands[rid] = {'want_on': want_on, 'start_ts': now, 'total': total, 'score': score}
        else:
            prior['total'] = total
            prior['score'] = score

    # Promote candidates that have settled.
    to_clear = []
    for rid, c in cands.items():
        if (now - c['start_ts']) >= settling:
            flips.append((rid, c['want_on'], c['total'], c['score']))
            to_clear.append(rid)

    # Multi-candidate tiebreaker: lowest score (closest to expected) wins.
    flips.sort(key=lambda x: x[3])
    fired_this_tick = set()
    for rid, want_on, total, _score in flips:
        if rid in fired_this_tick:
            continue
        reg = next((r for r in registry if str(r['row_id']) == rid), None)
        if not reg:
            to_clear.append(rid)
            continue
        try:
            _confirm_flip(state, reg, total, want_on, now)
            live_state[rid] = bool(want_on)
            locks[rid] = now + post_lock
            label = reg['device_id'] + (f":{reg['channel']}" if reg['channel'] else '')
            log.info("power_phase_discovery: %s -> %s (Δ=%s W)",
                     label, 'ON' if want_on else 'OFF', int(round(total)))
        except Exception as e:
            log.warning("power_phase_discovery: confirm failed for row %s: %s", rid, e)
        fired_this_tick.add(rid)

    for rid in to_clear:
        cands.pop(rid, None)

    state.shared['_power_discovery.candidates'] = cands
    state.shared['_power_discovery.lock_until'] = locks
    state.shared['_power_discovery.live_state'] = live_state

    return []
