"""My BathRoom Displays — render value templates onto HASP panel labels/gauges.

Reads `hasp_displays` rows for the my-bathroom panel. Each row maps a panel widget
(`p<page>b<label_id>`) to a `format_string` template that's rendered against
`state.shared`. The result is published to
`hasp/my-bathroom/command/p<page>b<label_id>.<target_property>`, mutating that
HASP property in real-time.

v1 supports source_type='shared_state' only. SQL / HA fetches are TODO.

Triggered on heartbeat (every 60s). Per-row refresh_sec is honored — a row
only re-publishes when the heartbeat tick is at-or-after its
`last_published_at + refresh_sec`. Dedupe against `last_value` in DB so the
panel only sees actual changes.
"""

import logging
import re
import time
from datetime import datetime, timezone

log = logging.getLogger("rule.my_bathroom_displays")

RULE = {
    "name": "My BathRoom Displays",
    "description": "Updates the text on the My BathRoom Toilet Panel (temperatures, status) so it stays current.",
    "triggers": ["heartbeat"],
    "controls": [],
    "category": "display",
    "group": "my-bathroom",
    "priority": 50,
    "depends_on": [],
}

_TEMPLATE_RE = re.compile(r"\{\{(\w+)\}\}")

# Force re-publish every N seconds even when the rendered value hasn't
# changed. Without this, a stable value (e.g. temperature that holds at
# 21.0 for hours) is published once on first change, then `last_value`
# dedupe skips it forever — and a panel that reboots after that misses
# the value entirely (label stays at its default text "0.0" forever).
_FORCE_REPUBLISH_S = 600   # 10 min


def _resolve_source(source_value, state):
    """Resolve source_value → live value.

    Two source_value formats:
      'foo'                    → state.shared['foo']
      'device:<id>:<dps_key>'  → state.devices[id].dps[dps_key]
    """
    if not source_value:
        return None
    if source_value.startswith("device:"):
        rest = source_value[len("device:"):]
        if ":" in rest:
            dev_id, dps_key = rest.split(":", 1)
            dev = (state.devices or {}).get(dev_id) or {}
            dps = dev.get("dps") or {}
            return dps.get(dps_key)
    return (state.shared or {}).get(source_value)


def _fmt(v):
    """String-format a value with 1-decimal precision for floats so micro
    sensor-noise (e.g. 21.039999961853 → 21.040001869202) doesn't blow
    past the dedupe and trigger spurious publishes. Ints / bools / strings
    that are not numeric pass through unchanged. Numeric strings (e.g.
    Tuya stores some readings as "21.0") get the same rounding only if
    they were already in decimal form."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return f"{v:.1f}"
    if isinstance(v, str):
        try:
            f = float(v)
            return f"{f:.1f}" if '.' in v else v
        except ValueError:
            pass
    return str(v)


def _render(format_string, shared, source_val):
    """Substitute {{key}} placeholders.

    {{val}}  → the resolved source value (works for both source_types)
    {{key}}  → state.shared[key]  (for legacy multi-key templates)
    """
    def sub(m):
        k = m.group(1)
        if k == "val":
            return _fmt(source_val)
        return _fmt(shared.get(k))
    return _TEMPLATE_RE.sub(sub, format_string or "")


def evaluate(event, state):
    # Filter out rows that have no source_value — those are placeholder
    # entries auto-created by the panel sync process and have nothing to
    # render. Without this filter every heartbeat does ~65 useless UPDATE
    # roundtrips bumping last_published_at on empty rows (rule was taking
    # ~100 ms; with the filter it drops to ~5-10 ms).
    rows = state.db_query(
        """
        SELECT d.id, d.page, d.label_id, d.target_property, d.format_string,
               d.source_type, d.source_value, d.refresh_sec, d.last_value, d.last_published_at
        FROM hasp_displays d
        JOIN hasp_panels p ON p.id = d.panel_id
        WHERE p.name = 'my-bathroom'
          AND d.source_value IS NOT NULL
          AND d.source_value != ''
        """
    )
    if not rows:
        return []

    shared = state.shared or {}
    now_ts = time.time()
    commands = []

    for row in rows:
        disp_id, page, label_id, target_prop, fmt, src_type, src_val, refresh_sec, last_val, last_pub = row

        # Per-row cadence — skip if not yet due. Also compute age so we can
        # force a re-publish on stable values that would otherwise dedupe
        # forever (panel-reboot recovery).
        last_pub_ts = 0
        if last_pub:
            try:
                last_pub_ts = last_pub.timestamp() if hasattr(last_pub, "timestamp") else 0
            except Exception:
                last_pub_ts = 0
            if now_ts - last_pub_ts < (refresh_sec or 30):
                continue
        force_republish = last_pub_ts and (now_ts - last_pub_ts) >= _FORCE_REPUBLISH_S

        # source_type is informational — actual resolution is keyed by source_value:
        #   'device:<id>:<dps_key>' → state.devices[...].dps[key]
        #   anything else            → state.shared[source_value]
        source_val_resolved = _resolve_source(src_val, state)

        rendered = _render(fmt, shared, source_val_resolved)
        if rendered == (last_val or "") and not force_republish:
            # No change AND we published recently — bump last_published_at so
            # we don't re-render every heartbeat. Will fall through to
            # publish once age exceeds _FORCE_REPUBLISH_S.
            state.db_execute(
                "UPDATE hasp_displays SET last_published_at = NOW() WHERE id = %s",
                (disp_id,),
            )
            continue

        commands.append({
            "device_id": "hasp:my-bathroom",
            "protocol": "hasp",
            "path": f"p{page}b{label_id}.{target_prop or 'text'}",
            "value": rendered,
            "rule": "My BathRoom Displays",
        })
        state.db_execute(
            "UPDATE hasp_displays SET last_value = %s, last_published_at = NOW() WHERE id = %s",
            (rendered, disp_id),
        )

    if commands:
        log.info("My BathRoom Displays: %d widgets updated", len(commands))
    return commands
