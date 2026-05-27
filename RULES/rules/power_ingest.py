"""Power Ingest — write one row per N seconds to power_consumption.

P1 of the POWER subsystem. Subscribes to Shelly 3EM events (which arrive
at ~1-2 s cadence from HA, each event carrying ONE changed entity value)
and writes a downsampled snapshot to the power_consumption table.

Downsampling rationale: Shelly Gen 1 pushes via CoIoT to HA every ~1-2 s;
without a write rate cap we'd land ~50k rows/day per device. The rule
honours a sentence-tunable knob (`power.ingest_interval_sec`, default 10 s)
to keep volume at ~8.6k rows/day. Each row IS a 15-field snapshot at the
moment of the write — we read the latest merged DPS from
state.devices['shelly_3em_main']['dps'] (device-agent does the merging
across the 15 single-key HA events). All numeric values pass through
the schema's NUMERIC precision automatically.

No attribution math here — that's P4. This rule just captures the raw
time-series. Reading later joins it to power_devices (P2/P3 work) for
per-device contribution.
"""

import logging
import time

log = logging.getLogger('rule.power_ingest')

SHELLY_ID = 'shelly_3em_main'
DEFAULT_INTERVAL_SEC = 10

RULE = {
    "name": "Power Ingest",
    "description": "Snapshot Shelly 3EM into power_consumption every N seconds",
    "triggers": [SHELLY_ID],
    "controls": [],
    "category": "info",
    "group": "power",
    "priority": 10,
}


def evaluate(event, state):
    if event.get("device_id") != SHELLY_ID:
        return []

    now = time.time()
    interval = float(state.shared.get('power.ingest_interval_sec', DEFAULT_INTERVAL_SEC))
    last = float(state.shared.get('_power_ingest.last_write', 0.0))
    if now - last < interval:
        return []

    dev = state.devices.get(SHELLY_ID)
    if not dev:
        return []
    dps = dev.get('dps') or {}

    def _num(key):
        v = dps.get(key)
        if isinstance(v, (int, float)):
            return v
        return None

    r_w, s_w, t_w = _num('r_w'), _num('s_w'), _num('t_w')
    if r_w is None and s_w is None and t_w is None:
        return []

    total_w = (r_w or 0) + (s_w or 0) + (t_w or 0)

    rc = state.db_execute(
        """
        INSERT INTO power_consumption
          (ts, r_w, s_w, t_w, total_w,
           r_a, s_a, t_a,
           r_v, s_v, t_v,
           r_pf, s_pf, t_pf,
           r_kwh, s_kwh, t_kwh)
        VALUES
          (NOW(),
           %s, %s, %s, %s,
           %s, %s, %s,
           %s, %s, %s,
           %s, %s, %s,
           %s, %s, %s)
        ON CONFLICT (ts) DO NOTHING
        """,
        (
            r_w if r_w is None else int(round(r_w)),
            s_w if s_w is None else int(round(s_w)),
            t_w if t_w is None else int(round(t_w)),
            int(round(total_w)),
            _num('r_a'), _num('s_a'), _num('t_a'),
            _num('r_v'), _num('s_v'), _num('t_v'),
            _num('r_pf'), _num('s_pf'), _num('t_pf'),
            _num('r_kwh'), _num('s_kwh'), _num('t_kwh'),
        ),
    )

    if rc >= 0:
        state.shared['_power_ingest.last_write'] = now

    return []
