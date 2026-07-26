"""Panel Commands — dispatch device commands from the Balcony Smart Tablet PWA.

The wall tablet (Galaxy Tab A7) publishes a TILE PRESS to
`mur/home/device/panel/event` as `{dps: {tile: '<tile_id>', event: 'short'}}`.
The engine turns that into a synthetic event with `device_id = 'panel'` (see
rule_engine.on_mqtt_event — the `mur/home/device/+/event` branch). This rule
fires on it, resolves the tile's BINDINGS **server-side** from
`dashboard_settings.panel`, and returns the engine commands to dispatch.

Why server-side resolution: the browser sends only a tile id, never raw device
commands — so a compromised/rogue tablet can't inject arbitrary actions, and all
the business logic stays on the LXC (the architecture rule). The tablet is a dumb
renderer + tile-id publisher.

Binding shape is IDENTICAL to the OpenHASP panel buttons + Living Room wallmote
bindings (built by the shared `device-picker.js`), so the tablet inherits every
capability the balcony panel has. Each tile carries an ARRAY of bindings → one
press can fire N commands. Supported binding variants:
  {device_id, channel, action}          — device toggle / turn_on / turn_off
                                           (mode buttons = an 8-Gang channel here)
  {type:'scene',  target:'<Name>'}       — run a named scene (async in engine)
  {type:'curtain', device_id, action}    — curtain open / close / stop
  {type:'hasp_command', target:'page 2'} — a HASP panel command
  {type:'media',  media_action, target}  — media agent (TV / playlist)
  {type:'pixoo_preset', target, vars}    — push a Pixoo preset
  Alexa / Vacuum bindings                — via _display_chips helpers

Config shape (`dashboard_settings.panel`):
  {"pages":[{"id":"p1","name":"Lights","tiles":[
      {"id":"t1","label":"Living Room","bindings":[ <binding>, ... ]}
  ]}]}
"""

import json
import logging
import os
import sys
import time

_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import (  # noqa: E402
    build_alexa_cmd  as _build_alexa_cmd,
    build_vacuum_cmd as _build_vacuum_cmd,
)

log = logging.getLogger("rule.panel_commands")

RULE = {
    "name": "Panel Commands",
    "description": "Carries out what a tile on the wall tablet is set to do — switching a light, running a scene, changing the Home/Away/Abroad mode, moving a curtain, or controlling media — when you tap it.",
    "triggers": ["panel"],
    "controls": [],
    "category": "control",
    "group": "panel",
    "priority": 10,
    "depends_on": [],
    "test_event": {
        "device_id": "panel",
        "source": "event",
        "dps": {"tile": "__test__", "event": "short"},
    },
}

_RULE_NAME = "Panel Commands"
_COOLDOWN_SEC = 1.0           # de-dupe a double-publish of the same tile
_last_fired = {}

_cfg_cache = {"data": None, "ts": 0.0}
_CACHE_TTL_SEC = 30


def _load_tiles(state):
    """Return {tile_id: bindings_array} from dashboard_settings.panel. 30 s TTL."""
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CACHE_TTL_SEC:
        return _cfg_cache["data"]

    tiles = {}
    try:
        rows = state.db_query("SELECT value FROM dashboard_settings WHERE key = 'panel'")
        if rows and rows[0] and rows[0][0]:
            cfg = rows[0][0]
            if not isinstance(cfg, dict):
                cfg = json.loads(cfg)
            for page in cfg.get("pages") or []:
                for t in page.get("tiles") or []:
                    tid = t.get("id")
                    if tid:
                        tiles[str(tid)] = t.get("bindings") or []
    except Exception as e:
        log.warning("panel: load config failed: %s", e)
        # keep whatever we had; don't wedge the cache empty on a transient error
        return _cfg_cache["data"] or {}

    _cfg_cache["data"] = tiles
    _cfg_cache["ts"] = now
    return tiles


def _resolve_toggle(state, device_id, channel):
    """Read current device state and return 'turn_on' or 'turn_off' to flip it."""
    # HASP on-board relay: on/off lives on the PLATE device's last_state->output<n>
    # (the button is stateless). Read the output mapping + state from the DB so it
    # never depends on in-memory dps_config being loaded.
    if str(device_id).startswith("hasp:"):
        _plate = "hasp:" + str(device_id)[5:].split(":", 1)[0]
        try:
            _rows = state.db_query(
                "SELECT b.dps_config->'relay'->>'output', "
                "p.last_state ->> (b.dps_config->'relay'->>'output') "
                "FROM devices b LEFT JOIN devices p ON p.id = %s WHERE b.id = %s",
                (_plate, device_id))
        except Exception:
            _rows = None
        if _rows and _rows[0] and _rows[0][0] is not None:
            return "turn_off" if _rows[0][1] in (True, 1, "on", "ON", "true", "True") else "turn_on"
    dev_state = state.devices.get(device_id, {}) or {}
    cur_dps = dev_state.get("dps", {}) or {}
    if channel:
        cur_val = cur_dps.get(channel)
    elif "1" in cur_dps:
        cur_val = cur_dps["1"]
    elif "state" in cur_dps:
        cur_val = cur_dps["state"]
    elif "power" in cur_dps:
        cur_val = cur_dps["power"]
    elif len(cur_dps) == 1:
        cur_val = next(iter(cur_dps.values()))
    else:
        cur_val = None
    if cur_val in (True, 1, "on", "ON", "true", "True"):
        return "turn_off"
    return "turn_on"


def _build_command(b, state):
    """Translate one binding element into an engine command dict (or None)."""
    btype = b.get("type")  # None implies device

    if btype is None or btype == "device":
        device_id = b.get("device_id")
        if not device_id:
            return None
        channel = b.get("channel")
        action = b.get("action", "toggle")
        dev = state.devices.get(device_id, {}) or {}
        special_cmd = (_build_alexa_cmd(b, action, device_id, _RULE_NAME, dev)
                       or _build_vacuum_cmd(b, action, device_id, _RULE_NAME, dev))
        if special_cmd:
            return special_cmd
        if action == "toggle":
            action = _resolve_toggle(state, device_id, channel)
        cmd = {
            "device_id": device_id,
            "action": action,
            "rule": _RULE_NAME,
            "_skip_loop_guard": True,
        }
        if channel:
            cmd["channel"] = channel
        if "page_num" in b:
            cmd["page_num"] = b["page_num"]
        return cmd

    if btype == "scene":
        name = b.get("target") or b.get("scene")
        if not name:
            return None
        # The engine runs scenes async on a daemon thread (group `scenes`).
        return {"action": "run_scene", "scene": name, "rule": _RULE_NAME, "_skip_loop_guard": True}

    if btype == "curtain":
        device_id = b.get("device_id")
        if not device_id:
            return None
        # Semantic open/close/stop → engine _dispatch_curtain (protocol='curtain'),
        # which maps to the device's HA cover.* service (reversed wiring handled there).
        return {
            "device_id": device_id,
            "protocol": "curtain",
            "action": b.get("action", "stop"),
            "rule": _RULE_NAME,
            "_skip_loop_guard": True,
        }

    if btype == "hasp_command":
        target = b.get("target") or ""
        parts = target.strip().split(" ", 1)
        return {
            "device_id": b.get("device_id") or "hasp:balcony",
            "protocol": "hasp",
            "path": parts[0],
            "value": parts[1] if len(parts) > 1 else "",
            "rule": _RULE_NAME,
            "_skip_loop_guard": True,
        }

    if btype == "media":
        cmd = {
            "device_id": "media",
            "protocol": "media",
            "media_action": b.get("media_action"),
            "target": b.get("target") or "tv55",
            "rule": _RULE_NAME,
            "_skip_loop_guard": True,
        }
        for k in ("playlist_id", "rel_path", "shuffle", "repeat"):
            if b.get(k) is not None:
                cmd[k] = b[k]
        return cmd

    if btype == "pixoo_preset":
        cmd = {
            "device_id": "pixoo",
            "protocol": "pixoo",
            "action": "push_preset",
            "preset_name": b.get("target"),
            "rule": _RULE_NAME,
            "_skip_loop_guard": True,
        }
        if b.get("vars"):
            cmd["vars"] = b["vars"]
        return cmd

    log.warning("panel: unsupported binding type '%s'", btype)
    return None


def evaluate(event, state):
    if event.get("device_id") != "panel":
        return []
    dps = event.get("dps", {}) or {}
    tile_id = dps.get("tile")
    if not tile_id:
        return []
    tile_id = str(tile_id)

    evt = dps.get("event") or "short"
    cooldown_key = f"{tile_id}:{evt}"
    now = time.time()
    if now - _last_fired.get(cooldown_key, 0.0) < _COOLDOWN_SEC:
        return []
    _last_fired[cooldown_key] = now

    bindings = _load_tiles(state).get(tile_id)
    if not bindings:
        log.info("panel: tile '%s' — no binding (or unknown tile)", tile_id)
        return []

    commands = []
    for b in bindings:
        cmd = _build_command(b, state)
        if cmd:
            commands.append(cmd)

    if commands:
        log.info("panel: tile '%s' → %d command(s)", tile_id, len(commands))
    return commands
