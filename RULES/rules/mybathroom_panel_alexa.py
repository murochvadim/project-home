"""My Bathroom Alexa Panel — control Alexa My Bathroom (sound mode) from the
mybathroom-panel plate's page 3: 3 assignable Media buttons (play a saved
station) + transport + volume slider. Sound-only (no announce/say).

Control is via the engine's existing `_dispatch_alexa` (routed by the device's
`protocol='alexa'`) — NO engine change. Target = `media_player.alexa_my_bathroom`.

Page-3 objects (MY_BATHROOM_PANEL/pages.jsonl):
  p3b10..p3b15  6 Media buttons (Media 1-6) → play the station assigned to each in
                `dashboard_settings.my-bathroom.alexa_media_buttons`
                ({"p3b10": "<station name>", …}; set via the Lights Panel →
                Media Buttons card). Station resolved against
                `media-agents.alexa_quick_music` at fire-time by name.
  p3b20 Play / p3b21 Stop / p3b22 Pause → media_play / media_stop / media_pause
  p3b30 volume slider 0-100 → volume_set (0..1)

Validated 2026-06-23: play_media / media_stop / media_pause / volume_set work on
this Echo; turn_on/off are no-ops (no on/off buttons); next/prev dropped (no-op on
TuneIn radio, which is most saved stations).
"""

import json
import logging
import os
import sys
import time

_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)

log = logging.getLogger("rule.mybathroom_panel_alexa")

_PANEL = "mybathroom-panel"
_ECHO  = "media_player.alexa_my_bathroom"
_RULE_NAME = "My Bathroom Alexa Panel"

_MEDIA_BTNS = ("p3b10", "p3b11", "p3b12", "p3b13", "p3b14", "p3b15")
_TRANSPORT = {
    "p3b20": "media_play",
    "p3b21": "media_stop",
    "p3b22": "media_pause",
}
_VOL = "p3b30"

_CFG_KEY = "my-bathroom.alexa_media_buttons"   # {p3b<id>: "<station name>"}

RULE = {
    "name": _RULE_NAME,
    "description": "Controls the Alexa speaker in My BathRoom from page 3 of the My BathRoom Lights Panel — play a saved station, play/stop/pause, and change the volume.",
    "triggers": [f"hasp:{_PANEL}:{o}" for o in (*_MEDIA_BTNS, *_TRANSPORT, _VOL)],
    "controls": [],
    "category": "control",
    "group": "my-bathroom",
    "priority": 12,
    "depends_on": [],
}

_COMMIT_EVENTS = {"up"}
_DEBOUNCE_SEC = 0.4
_last_fired = {}

_cfg_cache = {"data": None, "ts": 0.0}
_CFG_TTL_SEC = 30


def _media_cfg(state):
    """Read the per-button → station-name map (30 s TTL)."""
    now = time.time()
    if _cfg_cache["data"] is not None and (now - _cfg_cache["ts"]) < _CFG_TTL_SEC:
        return _cfg_cache["data"]
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s", (_CFG_KEY,)
    )
    data = {}
    if rows:
        raw = rows[0][0]
        if isinstance(raw, str):
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                data = {}
        elif isinstance(raw, dict):
            data = raw
    if not isinstance(data, dict):
        data = {}
    _cfg_cache["data"] = data
    _cfg_cache["ts"] = now
    return data


def _alexa(action, extra=None):
    cmd = {
        "device_id": _ECHO,
        "protocol": "alexa",
        "action": action,
        "rule": _RULE_NAME,
        "_skip_loop_guard": True,
    }
    if extra:
        cmd.update(extra)
    return cmd


def evaluate(event, state):
    dev_id = event.get("device_id", "")
    if not dev_id.startswith(f"hasp:{_PANEL}:"):
        return []
    obj = dev_id.rsplit(":", 1)[-1]
    dps = event.get("dps", {}) or {}
    evt = dps.get("event")
    if evt is not None and evt not in _COMMIT_EVENTS:
        return []   # act on the 'up' commit only

    now = time.time()
    if now - _last_fired.get(obj, 0.0) < _DEBOUNCE_SEC:
        return []
    _last_fired[obj] = now

    if obj in _MEDIA_BTNS:
        station = (_media_cfg(state).get(obj) or "").strip()
        if not station:
            log.info("%s: %s — no station assigned", _RULE_NAME, obj)
            return []
        log.info("%s: %s → play_station '%s'", _RULE_NAME, obj, station)
        return [_alexa("play_station", {"station_name": station})]

    if obj in _TRANSPORT:
        action = _TRANSPORT[obj]
        log.info("%s: %s → %s", _RULE_NAME, obj, action)
        return [_alexa(action)]

    if obj == _VOL:
        val = dps.get("val")
        if val is None:
            return []
        lvl = max(0.0, min(1.0, float(val) / 100.0))
        log.info("%s: %s → volume_set %.2f", _RULE_NAME, obj, lvl)
        return [_alexa("volume_set", {"volume_level": lvl})]

    return []
