"""Notifications — generic dispatcher for user-authored notifications.

The reusable core of the Notifications subsystem. Users author notifications on
the dashboard (Main Agent → Notifications tab); each is a row in
`notification_defs` with a TRIGGER, optional CONDITIONS (gates), a MESSAGE, and a
delivery mode. This ONE rule watches every event, decides which notifications
should fire, and inserts a `notification_events` row for each — the dashboard
popup (notify-toast.js) polls those. No per-notification rule files: add one from
the tab and this rule picks it up within ~30 s (TTL-cached defs).

Triggers (v1)
-------------
  main_door_closed      — the Main Door closed (uses People Home's finalized
                          `_people_last_reset_ts` + `_last_transition_source`)
  home_mode_changed     — home_mode changed (optionally → a specific mode via
                          trigger_param, e.g. "home" = "someone comes home")
  people_count_changed  — people_home changed
  scheduled_time        — once/day at trigger_param HH:MM (heartbeat)

Conditions (AND-ed gates) — list of {field, op, value}
  home_mode   is <mode>
  people_home >= / <= / == / > / <  <N>
  time_window between "HH:MM-HH:MM"   (wraps past midnight)
  day         is weekday | weekend    (Israel weekend = Fri/Sat)
  main_door   is open | closed        (current Main Door state)

Delivery
  immediate — fire the moment the trigger+gates pass (throttle_min optional)
  at_time   — hold the latest occurrence; deliver at delivery_time (HH:MM)
  daily     — count occurrences; deliver one summary at delivery_time ({count})

Message placeholders: {people_home} {home_mode} {time} {date} {count}

Architecture: this rule ONLY inserts DB rows (no engine commands) and tracks its
state in `_notify:*` shared keys (underscore-prefixed → the engine does NOT count
them as fires, so a wildcard rule can't inflate the Runs counter). Firing lives on
the LXC; the dashboard is UI-only. depends_on People Home + Mode Buttons so the
live `home_mode` / `people_home` / door-reset signals are fresh on the same event.

Wildcard (`*`) trigger: needed because users pick arbitrary triggers at runtime;
the per-event work is a tiny loop over the handful of defs, early-out when none.
"""

import json
import logging
import re
import time
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo("Asia/Jerusalem")
except Exception:                        # pragma: no cover
    _TZ = None

log = logging.getLogger("rule.notifications")

RULE = {
    "name":        "Notifications",
    "description": "Watches the notifications you set up on the Notifications tab. When a notification's trigger happens and its conditions are met, it fires — popping a message on screen now, or holding it for a set time / a daily summary.",
    "triggers":    ["*", "heartbeat"],
    "controls":    [],
    "category":    "info",
    "group":       "notify",        # own group — never skipped by same-group competition
    "priority":    20,
    "depends_on":  ["People Home", "Mode Buttons"],
}

_CFG_TTL_SEC   = 30
_EVENT_TTL_MIN = 15                # popup-freshness guard baked into each event
_cfg_cache     = {"data": None, "ts": 0.0}
_first_eval    = True              # prime signals once after (re)load → no startup pop


# ─────────────────────────── config load ───────────────────────────

def _load_defs(state):
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CFG_TTL_SEC:
        return _cfg_cache["data"]
    try:
        rows = state.db_query(
            "SELECT id, name, enabled, trigger, trigger_param, conditions, message, "
            "delivery, delivery_time, throttle_min, surfaces, level, action "
            "FROM notification_defs"
        ) or []
    except Exception as e:
        log.warning("notifications: load defs failed: %s", e)
        _cfg_cache["ts"] = now
        return _cfg_cache["data"] or []
    defs = []
    for r in rows:
        conds = r[5] if isinstance(r[5], (list, dict)) else (json.loads(r[5]) if r[5] else [])
        surf = r[10] if isinstance(r[10], dict) else (json.loads(r[10]) if r[10] else {})
        defs.append({
            "id": r[0], "name": r[1], "enabled": bool(r[2]), "trigger": r[3],
            "trigger_param": r[4], "conditions": conds, "message": r[6],
            "delivery": r[7], "delivery_time": r[8], "throttle_min": r[9] or 0,
            "surfaces": surf, "level": r[11] or "info",
            "action": r[12] if len(r) > 12 else None,
        })
    _cfg_cache["data"] = defs
    _cfg_cache["ts"] = now
    return defs


# ─────────────────────────── helpers ───────────────────────────

def _now_local():
    return datetime.now(_TZ) if _TZ else datetime.now()


def _subst(msg, ctx):
    return re.sub(r"\{(\w+)\}", lambda m: str(ctx.get(m.group(1), m.group(0))), msg or "")


def _hhmm_to_min(s):
    try:
        h, m = str(s).split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _in_window(now_local, val):
    try:
        a, b = str(val).split("-")
    except Exception:
        return True
    am, bm = _hhmm_to_min(a), _hhmm_to_min(b)
    if am is None or bm is None:
        return True
    cur = now_local.hour * 60 + now_local.minute
    return am <= cur <= bm if am <= bm else (cur >= am or cur <= bm)


def _passes_gates(conditions, ctx, now_local):
    for c in conditions or []:
        field = (c.get("field") or "").lower()
        op = (c.get("op") or "is").lower()
        val = c.get("value")
        if field == "home_mode":
            if str(ctx.get("home_mode")) != str(val):
                return False
        elif field == "people_home":
            try:
                ph, v = int(ctx.get("people_home") or 0), int(val)
            except Exception:
                return False
            if op in (">=", "ge") and not ph >= v: return False
            if op in ("<=", "le") and not ph <= v: return False
            if op in ("==", "=", "is", "eq") and not ph == v: return False
            if op in (">", "gt") and not ph > v: return False
            if op in ("<", "lt") and not ph < v: return False
        elif field == "time_window":
            if not _in_window(now_local, val):
                return False
        elif field == "day":
            is_weekend = now_local.weekday() in (4, 5)   # Fri, Sat
            v = str(val).lower()
            if v == "weekend" and not is_weekend: return False
            if v == "weekday" and is_weekend: return False
        elif field == "main_door":
            # ctx["main_door"] is 'open'/'closed'/None (from state.shared['door:Main Door']).
            # Unknown (None) never equals 'open'/'closed' -> condition not met -> suppressed.
            if str(ctx.get("main_door")) != str(val):
                return False
    return True


def _emit(state, d, ctx):
    """Insert one notification_events row (respecting throttle)."""
    did = d["id"]
    throttle = int(d.get("throttle_min") or 0)
    now_ts = time.time()
    if throttle > 0:
        last = state.shared.get(f"_notify:{did}:last_emit_ts")
        try:
            if last is not None and (now_ts - float(last)) < throttle * 60:
                return
        except Exception:
            pass
    body = _subst(d.get("message") or d.get("name"), ctx)
    surfaces = d.get("surfaces") or {"popup": True, "pages": "all", "phone": False}
    # Interactive popups (e.g. action='set_people') carry the live value so the
    # popup can pre-fill an input the user can correct.
    data = {}
    if d.get("action"):
        data["action"] = d["action"]
        if d["action"] == "set_people":
            data["people_home"] = ctx.get("people_home")
    interactive = bool(data.get("action"))
    try:
        if interactive:
            # STICKY: supersede any prior unresolved prompt for this def so only the
            # LATEST (current occupancy) stays pending — one prompt, never a stack.
            state.db_execute(
                "UPDATE notification_events SET resolved_at = now() "
                "WHERE def_id = %s AND resolved_at IS NULL AND (data->>'action') IS NOT NULL",
                (did,),
            )
            # No expiry — a sticky interactive prompt lives until the user resolves
            # it (Save), so a main-door-close can never be missed (laptop closed etc).
            state.db_execute(
                "INSERT INTO notification_events (def_id, title, body, level, surfaces, expires_at, data) "
                "VALUES (%s, %s, %s, %s, %s::jsonb, NULL, %s::jsonb)",
                (did, d.get("name"), body, d.get("level") or "info",
                 json.dumps(surfaces), json.dumps(data)),
            )
        else:
            state.db_execute(
                "INSERT INTO notification_events (def_id, title, body, level, surfaces, expires_at, data) "
                "VALUES (%s, %s, %s, %s, %s::jsonb, now() + make_interval(mins => %s), %s::jsonb)",
                (did, d.get("name"), body, d.get("level") or "info",
                 json.dumps(surfaces), _EVENT_TTL_MIN, json.dumps(data)),
            )
    except Exception as e:
        log.warning("notifications: emit failed for def %s: %s", did, e)
        return
    state.shared[f"_notify:{did}:last_emit_ts"] = now_ts
    log.info("notification fired: def=%s '%s'", did, body)


def _deliver(state, d, ctx, today):
    """Route a fired trigger by delivery mode."""
    delivery = (d.get("delivery") or "immediate").lower()
    did = d["id"]
    if delivery == "at_time":
        # remember the latest occurrence to render at delivery_time
        state.shared[f"_notify:{did}:pending"] = json.dumps(
            {"people_home": ctx.get("people_home"), "home_mode": ctx.get("home_mode")})
    elif delivery == "daily":
        # ONE rolling counter, reset at each delivery — so the summary covers the
        # whole window since the last delivery (not a partial same-day count), and
        # we don't leak a key per calendar day.
        ckey = f"_notify:{did}:daily_count"
        state.shared[ckey] = int(state.shared.get(ckey, 0) or 0) + 1
    else:  # immediate
        _emit(state, d, ctx)


def _tablet_cmd(state, d, ctx):
    """Build a panel_alert command for the Balcony tablet if this def has a
    Tablet-alert surface (`surfaces.tablet.enabled`). Honors `throttle_min` via its
    own key so a flapping trigger can't spam the tablet. Returns a command dict or
    None — the engine's `protocol='panel_alert'` branch publishes it to the panel."""
    tab = ((d.get("surfaces") or {}).get("tablet")) or {}
    if not tab.get("enabled"):
        return None
    did = d["id"]
    throttle = int(d.get("throttle_min") or 0)
    now_ts = time.time()
    if throttle > 0:
        last = state.shared.get(f"_notify:{did}:tablet_ts")
        try:
            if last is not None and (now_ts - float(last)) < throttle * 60:
                return None
        except Exception:
            pass
    state.shared[f"_notify:{did}:tablet_ts"] = now_ts
    return {
        "protocol": "panel_alert",
        "device_id": "panel",
        "icon": tab.get("icon") or "door",
        "color": tab.get("color") or "#e5352b",
        "blink": bool(tab.get("blink", True)),
        "sound": bool(tab.get("sound", True)),
        "duration_sec": int(tab.get("duration_sec") or 12),
        "message": _subst(d.get("message") or d.get("name"), ctx),
        "rule": "Notifications",
        "_skip_loop_guard": True,
    }


def _process_pending(state, d, ctx, now_local, today):
    """Heartbeat: deliver at_time / daily notifications once their time arrives."""
    delivery = (d.get("delivery") or "immediate").lower()
    if delivery not in ("at_time", "daily"):
        return
    tp_min = _hhmm_to_min(d.get("delivery_time"))
    if tp_min is None or (now_local.hour * 60 + now_local.minute) < tp_min:
        return
    did = d["id"]
    dkey = f"_notify:{did}:delivered_date"
    if state.shared.get(dkey) == today:
        return
    if delivery == "at_time":
        pend = state.shared.get(f"_notify:{did}:pending")
        if not pend:
            return
        try:
            p = json.loads(pend)
        except Exception:
            p = {}
        c = dict(ctx); c.update(p)
        _emit(state, d, c)
        state.shared[f"_notify:{did}:pending"] = ""
        state.shared[dkey] = today
    else:  # daily — deliver the rolling count once/day at delivery_time, then reset.
        # Mark the day done FIRST (even when the count is 0) so a later event can't
        # trigger an early partial delivery — the whole point of the fix.
        state.shared[dkey] = today
        ckey = f"_notify:{did}:daily_count"
        cnt = int(state.shared.get(ckey, 0) or 0)
        if cnt <= 0:
            return                       # nothing happened this window → no nag
        c = dict(ctx); c["count"] = cnt
        _emit(state, d, c)
        state.shared[ckey] = 0           # reset — next window starts fresh


# ─────────────────────────── trigger signals ───────────────────────────

def _signal_for(d, ctx, shared):
    """Return (signal_key, current_value) for change-detection triggers, or None."""
    trig = (d.get("trigger") or "").lower()
    did = d["id"]
    if trig == "main_door_closed":
        return f"_notify:{did}:door_ts", shared.get("_people_last_reset_ts")
    if trig == "home_mode_changed":
        return f"_notify:{did}:home", ctx.get("home_mode")
    if trig == "people_count_changed":
        return f"_notify:{did}:people", ctx.get("people_home")
    return None


# ── Deferred door re-check — fixes the fast-presence / slow-zwave-door race ───────
# A device_presence notification with a main_door condition is racy: the fast local
# presence sensor fires a fraction of a second BEFORE the slow z-wave Main Door reports
# 'open', so a point-in-time door check always sees 'closed'. We hold the decision a few
# seconds, then re-check whether the Main Door opened AROUND the presence (via People
# Home's _main_door_open_ts timer) and suppress if so.
_HOLD_SEC = 3   # wait this long for the Main Door to register 'open' before deciding.
                # The door 'open' event lands in the SAME second as the presence (sub-second
                # race) and People Home sets _main_door_open_ts within ~1-2s, so 3s is ample
                # margin while keeping the notification snappy. Below ~2s risks the race back.
_DOOR_PRE = 4   # also suppress if the door opened up to this many seconds BEFORE the presence


def _needs_door_hold(d):
    if (d.get("trigger") or "").lower() != "device_presence":
        return False
    return any((c.get("field") or "").lower() == "main_door" for c in (d.get("conditions") or []))


def _process_holds(state, defs, ctx, now_local, today):
    """Deliver or suppress held device_presence notifications once the Main Door state
    has had time to settle. Suppress when the door opened around the presence moment."""
    shared = state.shared
    now = time.time()
    by_id = {str(d.get("id")): d for d in defs}
    out = []
    for key in [k for k in list(shared.keys()) if k.startswith("_notify_hold:")]:
        deliver_at = shared.get(key)
        if not deliver_at or now < deliver_at:
            continue
        shared[key] = None            # consume (upsert-only store never DELETEs; None is skipped)
        d = by_id.get(key.split(":", 1)[1])
        if not d or not d.get("enabled"):
            continue
        # non-door conditions must still hold at delivery time
        conds_nondoor = [c for c in (d.get("conditions") or []) if (c.get("field") or "").lower() != "main_door"]
        if not _passes_gates(conds_nondoor, ctx, now_local):
            continue
        # race-proof door check: was the Main Door opened around the presence?
        door_cond = next((c for c in (d.get("conditions") or []) if (c.get("field") or "").lower() == "main_door"), {})
        want = str(door_cond.get("value") or "closed").lower()
        opened_recently = state.get_timer("_main_door_open_ts") <= (_HOLD_SEC + _DOOR_PRE)
        door_ok = (not opened_recently) if want == "closed" else (opened_recently or str(ctx.get("main_door")) == "open")
        if not door_ok:
            continue
        _deliver(state, d, ctx, today)
        cmd = _tablet_cmd(state, d, ctx)
        if cmd:
            out.append(cmd)
    return out


def evaluate(event, state):
    global _first_eval
    defs = _load_defs(state)
    if not defs:
        return []

    shared = state.shared
    ctx = {"people_home": shared.get("people_home"), "home_mode": shared.get("home_mode")}
    ctx["main_door"] = shared.get("door:Main Door")   # 'open' / 'closed' / None
    now_local = _now_local()
    ctx["time"] = now_local.strftime("%H:%M")
    ctx["date"] = now_local.strftime("%d/%m/%Y")
    today = now_local.strftime("%Y-%m-%d")

    # Prime every def's change-detection signal ONCE after (re)load so a restart or
    # a Reload can never pop a spurious notification for a change we didn't witness.
    if _first_eval:
        for d in defs:
            sig = _signal_for(d, ctx, shared)
            if sig:
                shared[sig[0]] = sig[1]
            # Prime device_presence shadows from current device state so a reload
            # never fires a spurious alert for a presence we didn't just witness.
            if (d.get("trigger") or "").lower() == "device_presence":
                dev = d.get("trigger_param")
                dv = (state.devices.get(dev, {}) or {}).get("dps", {}) if dev else {}
                shared[f"_notify:{d['id']}:presence"] = dv.get("1") in ("presence", True, "true", 1)
        _first_eval = False
        return []

    is_heartbeat = (event.get("device_id") == "heartbeat")
    door_src = shared.get("_last_transition_source")
    ev_dev = event.get("device_id")
    ev_dps = event.get("dps", {}) or {}

    commands = []
    commands += _process_holds(state, defs, ctx, now_local, today)
    for d in defs:
        if not d.get("enabled"):
            continue
        trig = (d.get("trigger") or "").lower()
        fired = False

        sig = _signal_for(d, ctx, shared)
        if sig:
            key, cur = sig
            prev = shared.get(key)
            if cur != prev:
                if prev is not None:
                    if trig == "main_door_closed":
                        fired = (door_src == "door_sensor")
                    elif trig == "home_mode_changed":
                        tp = d.get("trigger_param")
                        fired = (not tp) or (str(cur) == str(tp))
                    else:  # people_count_changed
                        fired = True
                shared[key] = cur
        elif trig == "device_presence":
            # Fires on a presence sensor's rising edge (none/false -> present).
            # The sensor may double-report (tcp_push 'presence' + ha_api true); the
            # multi-value check + rising-edge dedup collapse that to ONE fire.
            dev = d.get("trigger_param")
            if dev and ev_dev == dev and "1" in ev_dps:
                cur = ev_dps.get("1") in ("presence", True, "true", 1)
                key = f"_notify:{d['id']}:presence"
                prev = shared.get(key)
                if cur and prev is False:      # None = just primed → no fire yet
                    fired = True
                shared[key] = cur
        elif trig == "scheduled_time" and is_heartbeat:
            tp_min = _hhmm_to_min(d.get("trigger_param"))
            key = f"_notify:{d['id']}:sched_date"
            if tp_min is not None and (now_local.hour * 60 + now_local.minute) >= tp_min \
                    and shared.get(key) != today:
                fired = True
                shared[key] = today

        if fired and _needs_door_hold(d):
            # Racy: the fast presence sensor beats the slow z-wave Main Door. Hold the
            # decision _HOLD_SEC and re-check the door (in _process_holds) so opening the
            # door reliably suppresses this. Require the non-door conditions up front.
            conds_nondoor = [c for c in (d.get("conditions") or []) if (c.get("field") or "").lower() != "main_door"]
            if _passes_gates(conds_nondoor, ctx, now_local):
                shared[f"_notify_hold:{d['id']}"] = time.time() + _HOLD_SEC
        elif fired and _passes_gates(d.get("conditions"), ctx, now_local):
            _deliver(state, d, ctx, today)       # popup (DB insert, if popup surface)
            cmd = _tablet_cmd(state, d, ctx)      # tablet alert (if tablet surface)
            if cmd:
                commands.append(cmd)

        # time-based deliveries tick on the heartbeat
        if is_heartbeat:
            _process_pending(state, d, ctx, now_local, today)

    return commands
