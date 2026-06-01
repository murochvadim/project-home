"""Power Known State — flip power_devices.live for state_known rows on
HA-reported device-state transitions.

For devices whose ON/OFF is reported directly (TVs / Alexas / any HA-mediated
media_player), the apartment-meter Δ inference is the wrong tool — the source
already publishes state. This rule consumes that state and updates
power_devices.live + emits virtual:power_state, mirroring the output path
of Power Phase Discovery so downstream consumers (LCD DEVICES ON counter,
history, dashboards) treat the two behaviours identically.

Trigger: wildcard `*`. The state_known device set is dynamic (user-edited
via the Power Registry dashboard) so a fixed trigger list can't track it;
wildcard with a fast early-return on a TTL-cached device_id set keeps the
cost-per-event below 20 us at home scale.

ON detection: anything except {'off','unavailable','unknown','standby',
'none', '', None} counts as ON. Covers media_player ('on'/'playing'/
'paused'/'idle' all = ON), switch/light ('on' = ON), generic HA entities.
"""

import json
import logging
import time

log = logging.getLogger('rule.power_known_state')

SHARED_REGISTRY_KEY    = '_power_known.registry_cache'
SHARED_REGISTRY_TS_KEY = '_power_known.registry_cache_ts'
SHARED_LAST_ON_KEY     = '_power_known.last_on'
SHARED_LAST_W_KEY      = '_power_known.last_w'         # tracks current refined wattage per row_id
SHARED_SHELLY_PREV_KEY = '_power_known.shelly_prev'    # r/s/t prev sample for Δ
SHARED_REFINE_LOCKS_KEY= '_power_known.refine_locks'   # per-row post-attribution lock

DEFAULT_REGISTRY_TTL_SEC = 30
OFF_VALUES = {'off', 'unavailable', 'unknown', 'standby', 'none', ''}

# Shelly 3EM device id — single source of meter Δ events. Same identifier
# Power Phase Discovery listens to.
SHELLY_ID = 'shelly_3em_main'

# Meter refinement tolerances — reuse the same sentence knobs that
# Power Phase Discovery reads, so the user tunes both rules from the
# `r_power_discovery_init` container.
DEFAULT_NOISE_FLOOR_W       = 10
DEFAULT_TOL_LOW             = 0.7
DEFAULT_TOL_HIGH            = 1.15
DEFAULT_POST_LOCK_SEC       = 5

RULE = {
    "name":        "Power Known State",
    "description": "Flip power_devices.live for state_known rows when HA-reported device state changes ON/OFF",
    "triggers":    ["*"],
    "controls":    [],
    "category":    "info",
    "group":       "power",
    "priority":    25,
    "depends_on":  [],
}


def _load_registry(state):
    """TTL-cached state_known registry. Returns list of
    {row_id, device_id, channel, phase, config}.
    """
    cache = state.shared.get(SHARED_REGISTRY_KEY)
    cache_ts = float(state.shared.get(SHARED_REGISTRY_TS_KEY, 0))
    if cache and (time.time() - cache_ts) < DEFAULT_REGISTRY_TTL_SEC:
        return cache
    rows = state.db_query(
        """
        SELECT row_id, device_id, channel, phase, config
        FROM power_devices
        WHERE source = 'state_known'
        """
    )
    # state.db_query → positional tuples
    out = []
    for r in (rows or []):
        cfg = r[4] or {}
        if isinstance(cfg, str):
            try: cfg = json.loads(cfg)
            except Exception: cfg = {}
        out.append({
            'row_id':    int(r[0]),
            'device_id': r[1],
            'channel':   r[2],
            'phase':     r[3],
            'config':    cfg,
        })
    state.shared[SHARED_REGISTRY_KEY]    = out
    state.shared[SHARED_REGISTRY_TS_KEY] = time.time()
    return out


def _knob_float(state, key, default):
    """Read a sentence-driven float knob; fall back to the default."""
    v = state.shared.get(key)
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _refine_wattage_from_shelly(state, registry):
    """Refine `live.w` for state_known rows currently ON using Shelly Δ.

    Doesn't touch `live.on` (HA owns the on/off path). Adds/subtracts the
    signed Δ on the row's phase from the row's current refined wattage.
    Initial wattage = expected_w (set by the on/off path on state transition).
    A positive Δ in [expected_w × tol_low, max_w × tol_high] = element kicking
    in. Negative Δ in the same range = element done.

    Per-row lock (`SHARED_REFINE_LOCKS_KEY`) suppresses oscillation:
    once a row gets attributed, it's locked for `post_lock_sec` from
    re-attribution.
    """
    dev = state.devices.get(SHELLY_ID)
    if not dev:
        return
    dps = dev.get('dps') or {}
    r_w = dps.get('r_w'); s_w = dps.get('s_w'); t_w = dps.get('t_w')
    if not all(isinstance(x, (int, float)) for x in (r_w, s_w, t_w)):
        return

    prev = state.shared.get(SHARED_SHELLY_PREV_KEY) or {}
    state.shared[SHARED_SHELLY_PREV_KEY] = {'r': r_w, 's': s_w, 't': t_w}
    if not prev:
        return  # first sample — nothing to compare to

    delta_r = r_w - prev.get('r', r_w)
    delta_s = s_w - prev.get('s', s_w)
    delta_t = t_w - prev.get('t', t_w)

    noise_floor = _knob_float(state, 'power_discovery.noise_floor_w', DEFAULT_NOISE_FLOOR_W)
    if max(abs(delta_r), abs(delta_s), abs(delta_t)) < noise_floor:
        return

    tol_low   = _knob_float(state, 'power_discovery.tol_low',  DEFAULT_TOL_LOW)
    tol_high  = _knob_float(state, 'power_discovery.tol_high', DEFAULT_TOL_HIGH)
    post_lock = _knob_float(state, 'power_discovery.post_flip_lock_sec', DEFAULT_POST_LOCK_SEC)

    now = time.time()
    locks       = state.shared.get(SHARED_REFINE_LOCKS_KEY) or {}
    last_on_map = state.shared.get(SHARED_LAST_ON_KEY) or {}
    last_w_map  = state.shared.get(SHARED_LAST_W_KEY) or {}

    candidates = []   # (rid, reg, phase_delta, score)
    for reg in registry:
        rid = str(reg['row_id'])
        if locks.get(rid, 0) > now:
            continue
        if not last_on_map.get(rid):
            continue  # device is OFF (per HA) — nothing to refine
        cfg = reg['config'] or {}
        phase = (reg['phase'] or '').upper()
        if phase not in ('R', 'S', 'T'):
            continue
        delta = {'R': delta_r, 'S': delta_s, 'T': delta_t}[phase]
        expected_w = float(cfg.get('expected_w') or 0)
        max_w      = float(cfg.get('max_w') or 0)
        if expected_w <= 0 or max_w <= expected_w:
            continue   # no meaningful range → can't refine
        # Only match Δ that looks like the heating element kicking in/out.
        # That's the SWING between standby and heating, NOT anything ≥ standby:
        #   lo = (max_w - expected_w) × tol_low  (heating-sized change)
        # Anything smaller is noise from other devices on the same phase.
        swing = max_w - expected_w
        lo = swing * tol_low
        hi = max_w * tol_high
        if not (lo <= abs(delta) <= hi):
            continue
        # Score: prefer matches closest to max_w (the heating-element draw
        # is closer to max_w than expected_w). Lower = better.
        score = abs(abs(delta) - max_w) / max_w
        candidates.append((rid, reg, delta, score))

    if not candidates:
        return

    candidates.sort(key=lambda x: x[3])   # closest-to-max wins ties
    fired = set()
    now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))
    for rid, reg, delta, _score in candidates:
        if rid in fired:
            continue
        cfg = reg['config'] or {}
        expected_w = float(cfg.get('expected_w') or 0)
        max_w      = float(cfg.get('max_w') or 0)
        prev_w     = float(last_w_map.get(rid, expected_w))
        # Negative Δ matching the swing range = heating element STOPPED.
        # The device is now back to standby — set w to expected_w directly
        # instead of subtracting Δ. Subtraction leaves residual phantom
        # wattage when the matching positive Δ was clamped upward earlier
        # (e.g. Tami 4 sat at 843W after cycle complete because the +1441
        # got clamped to 2300 but the -1456 only brought it back to 844).
        if delta < 0:
            new_w_f = expected_w
        else:
            new_w_f = prev_w + delta
            new_w_f = max(0.0, min(new_w_f, max_w * tol_high))
        new_w = int(round(new_w_f))
        live = {'on': True, 'w': new_w, 'ts': now_iso}
        try:
            state.db_execute(
                "UPDATE power_devices SET live=%s::jsonb, last_observed_at=NOW(), updated_at=NOW() "
                "WHERE row_id=%s",
                (json.dumps(live), reg['row_id']),
            )
            label = reg['device_id'] + (f":{reg['channel']}" if reg['channel'] else '')
            log.info("power_known_state refine: %s w=%d (Δ=%+d on %s)",
                     label, new_w, int(round(delta)), reg.get('phase') or '?')
            locks[rid] = now + post_lock
            last_w_map[rid] = new_w
            fired.add(rid)
        except Exception as e:
            log.warning("power_known_state refine: db update failed for %s: %s",
                        reg['device_id'], e)

    state.shared[SHARED_REFINE_LOCKS_KEY] = locks
    state.shared[SHARED_LAST_W_KEY] = last_w_map


def _is_on(state_val):
    # Bool False = OFF (otherwise str(False) = 'False' lowercased = 'false'
    # would slip past OFF_VALUES — which only contains the human strings
    # HA reports, not Python literals).
    if state_val is None or state_val is False:
        return False
    if state_val is True:
        return True
    s = str(state_val).strip()
    # BSH / Home Connect enum awareness — Siemens appliances (oven,
    # dishwasher, hob, hood, microwave, washer) publish state as long
    # enum strings. OperationState's only "actively drawing power" value
    # is ".Run"; every other value (Inactive/Ready/Pause/Finished/
    # ActionRequired/Error/Aborting) is near-zero draw. PowerState's
    # only "on" value is ".On" (".Standby" and ".Off" mean off).
    if s.startswith('BSH.Common.EnumType.OperationState.'):
        return s.endswith('.Run')
    if s.startswith('BSH.Common.EnumType.PowerState.'):
        return s.endswith('.On')
    return s.lower() not in OFF_VALUES


def _read_device_on(dev, channel):
    """Determine ON-ness from a device's projected dps. Tries the BSH
    OperationState field first (canonical for any Home Connect appliance —
    overrides per-row channel since OperationState is the only field that
    reliably says "drawing power" for this family), then `state` (HA
    media_player et al.), then the configured channel (Tuya gang switches,
    ESP boards), then any boolean truthy key as last resort.
    """
    dps = dev.get('dps') or {}
    # BSH/Home Connect — Siemens oven/dishwasher/hob/hood/microwave/washer.
    # OperationState=Run is the only state that draws power. Works without
    # per-row channel config — every BSH device with this field is handled.
    op = dps.get('BSH.Common.Status.OperationState')
    if isinstance(op, str) and op.startswith('BSH.Common.EnumType.OperationState.'):
        return op.endswith('.Run')
    if 'state' in dps:
        return _is_on(dps['state'])
    if channel and channel in dps:
        v = dps[channel]
        if isinstance(v, bool):    return v
        return _is_on(v)
    # Fallback — any truthy dps suggests ON (rare).
    for v in dps.values():
        if isinstance(v, bool) and v:
            return True
        if isinstance(v, str) and _is_on(v):
            return True
    return False


def evaluate(event, state):
    dev_id = event.get('device_id', '')
    if not dev_id:
        return []
    registry = _load_registry(state)
    if not registry:
        return []

    # Shelly meter event → refine `live.w` for state_known rows currently
    # ON. Doesn't touch `live.on` (that path is HA-event driven, below).
    # Returns early so the on/off block doesn't re-evaluate this event.
    if dev_id == SHELLY_ID:
        _refine_wattage_from_shelly(state, registry)
        return []

    # Heartbeat tick: sweep EVERY state_known row regardless of which device
    # the event names. Catches devices that were already in their current
    # state when added to the registry (no source-event fires for stable
    # devices, so without this sweep they stay frozen at the row's default
    # live={on:false}). Also self-heals after engine restart or any drift.
    # Real device events keep the fast per-device path below.
    if dev_id == 'heartbeat':
        matching = registry
    else:
        matching = [r for r in registry if r['device_id'] == dev_id]
        if not matching:
            return []

    last_on_map = state.shared.get(SHARED_LAST_ON_KEY) or {}
    last_w_map  = state.shared.get(SHARED_LAST_W_KEY) or {}
    now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    changed = False
    for reg in matching:
        rid = str(reg['row_id'])
        dev = state.devices.get(reg['device_id'])
        if not dev:
            continue
        is_on = _read_device_on(dev, reg['channel'])
        prior = last_on_map.get(rid)
        if prior == is_on:
            continue
        cfg = reg['config'] or {}
        w = int(round(float(cfg.get('expected_w') or 0))) if is_on else 0
        live = {'on': bool(is_on), 'ts': now_iso}
        if is_on and w > 0:
            live['w'] = w
        # Seed/clear the last_w cache so the Shelly Δ refine path knows the
        # starting wattage. On a fresh ON, baseline is expected_w; on OFF,
        # clear the entry so the next ON starts clean.
        if is_on:
            last_w_map[rid] = w
        else:
            last_w_map.pop(rid, None)
        try:
            state.db_execute(
                "UPDATE power_devices SET live=%s::jsonb, last_observed_at=NOW(), updated_at=NOW() WHERE row_id=%s",
                (json.dumps(live), reg['row_id']),
            )
            state.emit_virtual_event(
                virtual_id='virtual:power_state',
                dps={
                    'device_id': reg['device_id'],
                    'channel':   reg['channel'] or '',
                    'phase':     reg['phase'] or '',
                    'on':        bool(is_on),
                    'w':         w,
                },
                source='rule:Power Known State',
                name='Power State',
                dps_labels={
                    'device_id': 'Device',
                    'channel':   'Channel',
                    'phase':     'Phase',
                    'on':        'On',
                    'w':         'Watts',
                },
            )
            label = reg['device_id'] + (f":{reg['channel']}" if reg['channel'] else '')
            log.info("power_known_state: %s -> %s (w=%s)",
                     label, 'ON' if is_on else 'OFF', w)
        except Exception as e:
            log.warning("power_known_state: confirm failed for %s: %s", reg['device_id'], e)
        last_on_map[rid] = is_on
        changed = True

    if changed:
        state.shared[SHARED_LAST_ON_KEY] = last_on_map
        state.shared[SHARED_LAST_W_KEY]  = last_w_map
    return []
