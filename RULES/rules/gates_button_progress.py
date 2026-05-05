"""Gates Button Progress — mirror gates_01 progress percent + active state
onto the BARRIER and GATES buttons on the balcony HASP panel.

When the board reports `barrier_progress` 0..100 (sequence running):
  - p1b120.text = "45%" (BARRIER button shows live percent)
  - p1b120.val = 1     (button @checked styling lit up)
When idle (-1 or absent):
  - p1b120.text = "BARRIER"
  - p1b120.val = 0

Same for p1b110 (GATES button) keyed off `gates_progress`.

Triggered on every gates_01 event — the board publishes /status on every
state-machine tick (~1 Hz during a sequence) so the percent updates
real-time. Module-level dedupe prevents republishing identical
(text, val) tuples across consecutive heartbeats while the sequence is
between transitions. depends_on Balcony Buttons so the press dispatch
fires first; this rule reacts to the resulting status updates.
"""

import logging

log = logging.getLogger("rule.gates_button_progress")

DEVICE_ID       = "gates_01"
PANEL_DEVICE_ID = "hasp:balcony"

# Button widget IDs on page 1 of the balcony panel.
#   <btn>      — toggle btn — only its `.val` is set (lights up @checked
#                while a sequence runs, dim when idle). Its main text
#                stays at its native icon/name layout.
#   <corner>   — small label widget overlaid on the button's upper-right
#                corner. Carries the live "45%" while running, blank
#                when idle so the button visually returns to its default
#                icon + name layout.
BARRIER_BTN    = "p1b120"
BARRIER_CORNER = "p1b123"
GATES_BTN      = "p1b110"
GATES_CORNER   = "p1b113"

# Per-widget dedupe — (path, prop) -> last value published. Lives in module
# globals; rule engine instantiates each rule once per process so this
# survives the lifetime of the rule loader.
_LAST = {}

RULE = {
    "name":        "Gates Button Progress",
    "description": "Mirror gates_01 progress + active state onto p1b110 (GATES) and p1b120 (BARRIER) buttons on the balcony panel",
    "triggers":    [DEVICE_ID],
    "controls":    [],
    "category":    "display",
    "group":       "balcony",
    "priority":    20,
    "depends_on":  ["Balcony Buttons"],
}


def _btn_cmds(btn_id, corner_id, progress):
    """Build commands for one button's corner label. Returns [] if state
    matches the last-published value (dedupe).

    Only the corner label gets updated — we deliberately do NOT flip the
    button's `.val` (which would activate @checked styling on a toggle
    button). User feedback 2026-05-05: the lit-up @checked color washes
    out the yellow corner text, defeating the point. The corner text
    itself is the active-state indicator (empty = idle, "N%" = running).
    """
    if progress is None or progress < 0:
        # OpenHASP ignores zero-length MQTT payloads as "no change", so
        # an empty-string clear leaves the previous percent stuck on the
        # panel. A single space renders invisibly but counts as an
        # actual value-change publish.
        text = " "                      # idle — clear corner overlay (space, not empty)
    else:
        p = max(0, min(100, int(progress)))
        text = f"{p}%"

    if _LAST.get((corner_id, "text")) == text:
        return []                       # dedupe — no change since last publish
    _LAST[(corner_id, "text")] = text
    return [{
        "device_id":        PANEL_DEVICE_ID,
        "protocol":         "hasp",
        "path":             f"{corner_id}.text",
        "value":            text,
        "rule":             RULE["name"],
        # Status-mirroring publishes — not user actions. Rule engine's
        # 4-same-action-in-10s loop guard would otherwise auto-disable
        # us mid-sequence (16+ ticks share empty action key).
        "_skip_loop_guard": True,
    }]


def evaluate(event, state):
    if event.get("device_id") != DEVICE_ID:
        return []
    dps = (state.devices.get(DEVICE_ID) or {}).get("dps") or {}
    barrier_p = dps.get("barrier_progress")
    gates_p   = dps.get("gates_progress")

    cmds = []
    cmds.extend(_btn_cmds(BARRIER_BTN, BARRIER_CORNER, barrier_p))
    cmds.extend(_btn_cmds(GATES_BTN,   GATES_CORNER,   gates_p))
    return cmds
