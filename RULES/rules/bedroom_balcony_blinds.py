"""Bedroom Balcony Blinds — daily timed close/open, sentence-driven, home-only.

Two daily clock-anchored actions, both gated on home_mode:
  • CLOSE to <pct>% at <HH:MM>             (sentence s_bbb1)
  • OPEN  to <pct>% at <HH:MM>             (sentence s_bbb2)
  • gate: only fires when home_mode is <v> (sentence s_bbb3)

The blind (Bedroom Balcony Blinds, id 20775604840d8ebd346d) is an SCS curtain
with NO position capability — its HA cover entity supports only open/close/stop
(supported_features 11, current_position None) and over 90 days it has emitted
only DPS '1' (open/close/settled). So a partial position is reached by TIMED
MOTION: move in the right direction for |Δ%|/100 × full_run_sec, then stop. The
rule tracks its own last-commanded position in state.shared; OPEN-to-100 runs
the motor to the physical limit (no timed stop) which re-syncs the tracker to
100 every morning. Commands flow through the engine's protocol='curtain'
dispatch (HA cover.* services; reversed wiring is encoded in
dps_config.direction.action_open/close/stop).

Device id is HARDCODED — this is a single-device rule, the blind IS the rule's
identity. TIMES, percentages, and the home_mode gate are all sentence-driven
(container r_bedroom_balcony_blinds_init), editable in the dashboard.

Crossing-edge time detection (NOT now>=anchor): with TWO daily events a
ready-to-fire check would wrongly fire the morning OPEN if the engine first
evaluates in the evening. We fire only when the clock crosses an anchor minute
in (prev_eval_min, now_min] (mod 1440), plus a per-action daily latch. State
(last_eval_min, close_date, open_date, position_pct) persists in state.shared
so crossing + latch survive an engine restart.
"""

import json
import logging
import re
import time
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo("Asia/Jerusalem")
except Exception:
    _TZ = None

log = logging.getLogger("rule.bedroom_balcony_blinds")

DEVICE_ID            = "20775604840d8ebd346d"   # Bedroom Balcony Blinds (SCS, HA-mediated)
DEFAULT_FULL_RUN_SEC = 22                        # fallback if dps_config.direction.full_run_sec missing
CONTAINER_ID         = "r_bedroom_balcony_blinds_init"
_SK                  = "bedroom_balcony_blinds"  # state.shared key prefix

# Sentence regexes — case-insensitive, tolerant of surrounding text.
_CLOSE_RE = re.compile(r"close\s+to\s+(\d{1,3})\s*%?\s+at\s+(\d{1,2}):(\d{2})", re.I)
_OPEN_RE  = re.compile(r"open\s+to\s+(\d{1,3})\s*%?\s+at\s+(\d{1,2}):(\d{2})", re.I)
_GATE_RE  = re.compile(r"only\s+fires\s+when\s+([a-z_][a-z0-9_]*)\s+is\s+([a-z0-9_]+)", re.I)

RULE = {
    "name": "Bedroom Balcony Blinds",
    "description": "Daily timed close-to-X% / open-to-Y% of the Bedroom Balcony blind (sentence-driven times + gate; home_mode only).",
    "triggers": ["heartbeat"],
    "controls": [],
    "category": "control",
    "group": "bedroom",
    "priority": 10,
    "depends_on": ["Mode Buttons"],   # gate reads home_mode (owned by Mode Buttons)
}

_cfg_cache = {"data": None, "ts": 0.0}
_CFG_TTL = 30.0


def _load_config(state):
    """Parse container r_bedroom_balcony_blinds_init (30 s TTL cache).
    Returns {close:(pct,min)|None, open:(pct,min)|None, gates:[(key,val), …]}."""
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CFG_TTL:
        return _cfg_cache["data"]
    cfg = {"close": None, "open": None, "gates": []}
    try:
        rows = state.db_query(
            "SELECT value FROM dashboard_settings WHERE key='apartment.rule_sentences'")
        containers = rows[0][0] if rows else []
        if isinstance(containers, str):
            containers = json.loads(containers)
        container = next((c for c in containers if c.get("id") == CONTAINER_ID), None)
        if container:
            for s in container.get("sentences", []):
                if not s.get("active", True):
                    continue
                text = "".join(seg.get("v", "") for seg in s.get("segments", []))
                m = _CLOSE_RE.search(text)
                if m:
                    cfg["close"] = (min(100, int(m.group(1))), int(m.group(2)) * 60 + int(m.group(3)))
                    continue
                m = _OPEN_RE.search(text)
                if m:
                    cfg["open"] = (min(100, int(m.group(1))), int(m.group(2)) * 60 + int(m.group(3)))
                    continue
                m = _GATE_RE.search(text)
                if m:
                    cfg["gates"].append((m.group(1).lower(), m.group(2).lower()))
    except Exception as e:
        log.warning("bedroom_balcony_blinds: config parse failed: %s", e)
    _cfg_cache["data"] = cfg
    _cfg_cache["ts"] = now
    return cfg


def _gates_pass(gates, state):
    for key, val in gates:
        if str(state.shared.get(key, "")).lower() != val:
            return False
    return True


def _crossed(target_min, prev_min, now_min):
    """True if target_min falls in (prev_min, now_min] mod 1440. First run
    (prev_min None) primes without firing."""
    if prev_min is None or prev_min == now_min:
        return False
    if prev_min < now_min:
        return prev_min < target_min <= now_min
    return target_min > prev_min or target_min <= now_min   # wrapped past midnight


def _full_run_sec(state):
    dev = state.devices.get(DEVICE_ID, {}) or {}
    frs = ((dev.get("dps_config") or {}).get("direction") or {}).get("full_run_sec")
    try:
        return float(frs) if frs else DEFAULT_FULL_RUN_SEC
    except (TypeError, ValueError):
        return DEFAULT_FULL_RUN_SEC


def _move_to(target_pct, state, commands):
    """Emit curtain commands to move from the tracked position to target_pct,
    and update the tracked position. 100% = full open (motor runs to the limit,
    no timed stop). Other targets = timed motion (move + delayed stop)."""
    cur = state.shared.get(f"{_SK}.position_pct")
    try:
        cur = float(cur)
    except (TypeError, ValueError):
        cur = 100.0   # unknown → assume fully open (re-synced each morning by OPEN)
    target = float(max(0, min(100, target_pct)))

    if target >= 100:
        commands.append({"device_id": DEVICE_ID, "protocol": "curtain",
                         "action": "open", "rule": RULE["name"]})
        state.shared[f"{_SK}.position_pct"] = 100.0
        return "open -> 100% (full)"

    if abs(target - cur) < 1:
        return None   # already there

    frs = _full_run_sec(state)
    dur = round(abs(target - cur) / 100.0 * frs, 1)
    direction = "close" if target < cur else "open"
    commands.append({"device_id": DEVICE_ID, "protocol": "curtain",
                     "action": direction, "rule": RULE["name"]})
    commands.append({"device_id": DEVICE_ID, "protocol": "curtain",
                     "action": "stop", "_delay_sec": dur, "rule": RULE["name"]})
    state.shared[f"{_SK}.position_pct"] = target
    return f"{direction} {cur:.0f}% -> {target:.0f}% ({dur}s motion)"


def evaluate(event, state):
    commands = []
    cfg = _load_config(state)

    now = datetime.now(_TZ) if _TZ else datetime.now()
    now_min = now.hour * 60 + now.minute
    today = now.strftime("%Y-%m-%d")
    prev_min = state.shared.get(f"{_SK}.last_eval_min")
    state.shared[f"{_SK}.last_eval_min"] = now_min   # advance the eval cursor every tick

    gate_ok = _gates_pass(cfg["gates"], state)

    for kind, re_key, date_key in (("CLOSE", "close", "close_date"), ("OPEN", "open", "open_date")):
        spec = cfg[re_key]
        if not spec:
            continue
        pct, minute = spec
        if not (_crossed(minute, prev_min, now_min) and state.shared.get(f"{_SK}.{date_key}") != today):
            continue
        if not gate_ok:
            log.info("Bedroom Balcony Blinds: %s crossed but gate not satisfied — skip", kind)
            continue
        desc = _move_to(pct, state, commands)
        state.shared[f"{_SK}.{date_key}"] = today
        log.info("Bedroom Balcony Blinds: %s fire -> %s", kind, desc)

    return commands
