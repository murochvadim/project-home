"""Balcony Displays — render value templates onto HASP panel labels/gauges.

Reads `hasp_displays` rows for the balcony panel. Each row maps a panel widget
(`p<page>b<label_id>`) to a `format_string` template that's rendered against
`state.shared`. The result is published to
`hasp/balcony/command/p<page>b<label_id>.<target_property>`, mutating that
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

log = logging.getLogger("rule.balcony_displays")

RULE = {
    "name": "Balcony Displays",
    "description": "Render value templates onto HASP balcony panel widgets",
    "triggers": ["heartbeat"],
    "controls": [],
    "category": "display",
    "group": "balcony",
    "priority": 50,
    "depends_on": [],
}

_TEMPLATE_RE = re.compile(r"\{\{(\w+)\}\}")


def _render(format_string, shared):
    """Substitute {{key}} placeholders in format_string from state.shared."""
    def sub(m):
        k = m.group(1)
        v = shared.get(k)
        return str(v) if v is not None else ""
    return _TEMPLATE_RE.sub(sub, format_string or "")


def evaluate(event, state):
    rows = state.db_query(
        """
        SELECT d.id, d.page, d.label_id, d.target_property, d.format_string,
               d.source_type, d.refresh_sec, d.last_value, d.last_published_at
        FROM hasp_displays d
        JOIN hasp_panels p ON p.id = d.panel_id
        WHERE p.name = 'balcony'
        """
    )
    if not rows:
        return []

    shared = state.shared or {}
    now_ts = time.time()
    commands = []

    for row in rows:
        disp_id, page, label_id, target_prop, fmt, src_type, refresh_sec, last_val, last_pub = row

        # Per-row cadence — skip if not yet due
        if last_pub:
            try:
                last_pub_ts = last_pub.timestamp() if hasattr(last_pub, "timestamp") else 0
            except Exception:
                last_pub_ts = 0
            if now_ts - last_pub_ts < (refresh_sec or 30):
                continue

        if src_type and src_type != "shared_state":
            log.debug("Balcony Displays: source_type '%s' not supported in v1 — skipping id=%d",
                      src_type, disp_id)
            continue

        rendered = _render(fmt, shared)
        if rendered == (last_val or ""):
            # No change — bump last_published_at so we don't re-render every heartbeat
            state.db_execute(
                "UPDATE hasp_displays SET last_published_at = NOW() WHERE id = %s",
                (disp_id,),
            )
            continue

        commands.append({
            "device_id": "hasp:balcony",
            "protocol": "hasp",
            "path": f"p{page}b{label_id}.{target_prop or 'text'}",
            "value": rendered,
            "rule": "Balcony Displays",
        })
        state.db_execute(
            "UPDATE hasp_displays SET last_value = %s, last_published_at = NOW() WHERE id = %s",
            (rendered, disp_id),
        )

    if commands:
        log.info("Balcony Displays: %d widgets updated", len(commands))
    return commands
