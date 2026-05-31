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

DEFAULT_REGISTRY_TTL_SEC = 30
OFF_VALUES = {'off', 'unavailable', 'unknown', 'standby', 'none', ''}

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


def _is_on(state_val):
    # Bool False = OFF (otherwise str(False) = 'False' lowercased = 'false'
    # would slip past OFF_VALUES — which only contains the human strings
    # HA reports, not Python literals).
    if state_val is None or state_val is False:
        return False
    if state_val is True:
        return True
    return str(state_val).strip().lower() not in OFF_VALUES


def _read_device_on(dev, channel):
    """Determine ON-ness from a device's projected dps. Tries `state` first
    (media_player + most HA entities), then the channel key (for switches),
    then any boolean truthy key.
    """
    dps = dev.get('dps') or {}
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
    return []
