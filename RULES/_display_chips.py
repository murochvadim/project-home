"""Shared parser for chip-driven action tokens in rule_sentences.

Display chips (device_type='display' or protocol in {pixoo, awtrix}):

    @<DeviceName> on              → power_on
    @<DeviceName> off             → power_off
    @<DeviceName> push <preset>   → push_preset (Pixoo preset OR Awtrix saved app)

Legacy (still in use): `@Pixoo <PresetName>` ≡ `@Pixoo push <PresetName>`.

Panel chips (device_type='panel' or protocol='hasp', added 2026-05-05):

    @<PanelName> on               → backlight on
    @<PanelName> off              → backlight off
    @<PanelName> Page <N>         → goto_page N

Alexa media-player chips (protocol='alexa', added 2026-05-06):

    @<EchoName> say "<message>"            → notify.alexa_media announce
    @<EchoName> play "<phrase>"            → media_player.play_media (DEFAULT)
    @<EchoName> on                         → media_player.turn_on
    @<EchoName> off                        → media_player.turn_off

  Phase 2 (2026-05-07) — transport + saved-template chips:

    @<EchoName> stop                       → media_player.media_stop
    @<EchoName> pause                      → media_player.media_pause
    @<EchoName> resume                     → media_player.media_play
    @<EchoName> next                       → media_player.media_next_track
    @<EchoName> prev                       → media_player.media_previous_track
    @<EchoName> vol <N>                    → media_player.volume_set (N=0..100)
    @<EchoName> speak <TemplateName>       → look up name in
                                              dashboard_settings.media-agents.alexa_announcements
                                              → notify.alexa_media (with optional default_volume)
    @<EchoName> announce <TemplateName>    → alias for `speak` (kept for back-compat
                                              with rules authored before the rename)

The function still named `parse_display_chip` for back-compat with the
single existing caller (Evening Lights). Returns a command-dict ready
for rule_engine._dispatch_command, or None if the token isn't a chip
this parser knows about.
"""

import re

# `@<Panel> Page <N>` — case-insensitive; allow "page" / "Page" / "PAGE".
_PAGE_RE = re.compile(r"^page\s+(\d+)$")

# `@<Echo> say "<message>"` — message wrapped in single OR double quotes.
_SAY_RE  = re.compile(r"^say\s+(?:\"([^\"]*)\"|'([^']*)')$",  re.IGNORECASE)
# `@<Echo> play "<phrase>"` — same wrapping.
_PLAY_RE = re.compile(r"^play\s+(?:\"([^\"]*)\"|'([^']*)')$", re.IGNORECASE)
# `@<Echo> vol <N>` — integer 0..100 (UI scale, dispatch divides by 100).
_VOL_RE  = re.compile(r"^vol\s+(\d{1,3})$",                   re.IGNORECASE)
# `@<Echo> speak <TemplateName>` (or legacy `announce <TemplateName>`) —
# bare name, allow spaces. Template lookup happens at fire-time in
# rule_engine._dispatch_alexa, against
# dashboard_settings.media-agents.alexa_announcements. The dashboard
# device picker emits `speak` since 2026-05-07; `announce` stays
# recognized for back-compat with rules authored before the rename.
_ANN_RE  = re.compile(r"^(?:speak|announce)\s+(.+?)\s*$",     re.IGNORECASE)

def parse_display_chip(token, devices_by_name):
    """Return a command dict for a display / panel chip, or None.

    devices_by_name: map of {device_name: device_dict} where device_dict has
    at least 'id' and 'protocol' (typically built from state.devices).
    """
    if not token or not isinstance(token, str) or not token.startswith("@"):
        return None
    body = token[1:].strip()
    if not body:
        return None

    # Longest-prefix match: try the full body as device name, then shorten
    # by one trailing word until a known name matches. Handles both
    # single-word ('@Pixoo on') and multi-word ('@Multi Word Display on').
    parts = body.split()
    dev = None
    rest = ""
    for split_at in range(len(parts), 0, -1):
        candidate = " ".join(parts[:split_at])
        if candidate in devices_by_name:
            dev = devices_by_name[candidate]
            rest = " ".join(parts[split_at:]).strip()
            break

    if not dev:
        return None

    protocol  = dev.get("protocol")
    dtype     = dev.get("device_type")
    is_display = dtype == "display" or protocol in ("pixoo", "awtrix")
    is_panel   = dtype == "panel"   or protocol == "hasp"
    is_alexa   = protocol == "alexa"
    if not (is_display or is_panel or is_alexa):
        return None

    device_id  = dev.get("id")
    rest_lower = rest.lower()

    # ── Alexa media_player: TTS announce + play_media + turn_on/off ───
    if is_alexa:
        m = _SAY_RE.match(rest)  # use original rest (preserve quoted casing)
        if m:
            message = m.group(1) if m.group(1) is not None else (m.group(2) or "")
            return {
                "device_id": device_id,
                "protocol":  "alexa",
                "action":    "say",
                "message":   message,
            }
        m = _PLAY_RE.match(rest)
        if m:
            phrase = m.group(1) if m.group(1) is not None else (m.group(2) or "")
            return {
                "device_id":     device_id,
                "protocol":      "alexa",
                "action":        "play_media",
                "content_id":    phrase,
                "content_type":  "DEFAULT",
            }
        # Bare-word transport / power chips.
        _ALEXA_BARE = {
            "on":     "turn_on",
            "off":    "turn_off",
            "stop":   "media_stop",
            "pause":  "media_pause",
            "resume": "media_play",          # resume already-loaded media
            "next":   "media_next_track",
            "prev":   "media_previous_track",
        }
        if rest_lower in _ALEXA_BARE:
            return {"device_id": device_id, "protocol": "alexa",
                    "action": _ALEXA_BARE[rest_lower]}
        m = _VOL_RE.match(rest_lower)
        if m:
            n = int(m.group(1))
            if 0 <= n <= 100:
                return {
                    "device_id":     device_id,
                    "protocol":      "alexa",
                    "action":        "volume_set",
                    "volume_level":  n / 100.0,
                }
            return None
        m = _ANN_RE.match(rest)  # original case for template-name match
        if m:
            return {
                "device_id":     device_id,
                "protocol":      "alexa",
                "action":        "announce_template",
                "template_name": m.group(1).strip(),
            }
        return None

    # ── Panel: HASP-specific actions (page nav + backlight on/off) ────
    if is_panel:
        m = _PAGE_RE.match(rest_lower)
        if m:
            # `@<Panel> Page <N>` → rule engine HASP branch resolves
            # via dps_config.page.action_on='goto_page' and reads
            # cmd['page_num'] as the publish payload for command/page.
            return {
                "device_id": device_id,
                "protocol":  protocol,
                "action":    "turn_on",
                "channel":   "page",
                "page_num":  int(m.group(1)),
            }
        if rest_lower in ("on", "off"):
            # Backlight toggle — engine maps via dps_config.backlight
            # alias to publish `command/backlight on|off`.
            return {
                "device_id": device_id,
                "protocol":  protocol,
                "action":    "turn_on" if rest_lower == "on" else "turn_off",
                "channel":   "backlight",
            }
        return None

    # ── Display: power + push preset ──────────────────────────────────
    if rest_lower == "on":
        return {"device_id": device_id, "protocol": protocol, "action": "power_on"}
    if rest_lower == "off":
        return {"device_id": device_id, "protocol": protocol, "action": "power_off"}

    # `push <preset>` or legacy `<preset>` (Pixoo only)
    preset_name = None
    if rest_lower.startswith("push "):
        preset_name = rest[5:].strip()
    elif protocol == "pixoo" and rest:
        # Legacy format: @Pixoo <PresetName> (no 'push' prefix) — Start Away has used this.
        preset_name = rest

    if preset_name:
        cmd = {
            "device_id": device_id,
            "protocol": protocol,
            "action": "push_preset",
            "preset_name": preset_name,
            "vars": {},
        }
        return cmd

    # Bare @DisplayName with no action — caller decides whether to skip or default.
    return None


def build_devices_by_name(state_devices):
    """Build a name → device dict suitable for parse_display_chip.

    Includes both the device's `name` and lower-cased variant for tolerance.
    """
    out = {}
    for dev_id, dev in (state_devices or {}).items():
        n = (dev.get("name") or "").strip()
        if not n:
            continue
        merged = dict(dev)
        merged["id"] = dev_id
        out[n] = merged
    return out


# ── Alexa binding → command dict ──────────────────────────────────────────
# Shared by wallmote / balcony / my_bathroom button handlers. The bindings
# UI offers three Alexa actions per user request — saved announcements,
# saved music stations, and stop:
#
#   {action: 'speak', template_name: '<name>'}  → announce_template
#   {action: 'play',  station_name:  '<name>'}  → play_station (rule_engine
#                                                  looks up content_id at
#                                                  fire-time)
#   {action: 'stop'}                            → media_stop (counterpart
#                                                  to play — without it a
#                                                  binding can start music
#                                                  but not stop it)
#
# Returns a fully-formed cmd dict (caller pushes into commands[]) or None
# if the binding isn't a speak/play/stop row — caller falls through to the
# generic logic. Other transport verbs (pause/resume/next/prev) + power
# were considered + dropped 2026-05-07 — only play / announce / stop.
def build_alexa_cmd(binding, action, device_id, rule_name, dev=None):
    """Map an Alexa binding row → command dict.

    `dev` is the device record from `state.devices` (passed by callers
    since the vacuum integration in Phase 2 — same `stop` action is
    valid for both Alexa AND Vacuum but means different things, so we
    refuse to match if the device's actual protocol isn't alexa). Old
    callers that don't pass `dev` keep working — no protocol check
    runs in that case (preserves the old "trust the binding shape"
    contract).
    """
    if dev is not None and dev.get('protocol') != 'alexa':
        return None
    if action == "speak":
        tpl = (binding.get("template_name") or "").strip()
        if not tpl:
            return None
        return {
            "device_id":     device_id,
            "protocol":      "alexa",
            "action":        "announce_template",
            "template_name": tpl,
            "rule":          rule_name,
            "_skip_loop_guard": True,
        }
    if action == "play":
        sname = (binding.get("station_name") or "").strip()
        if not sname:
            return None
        return {
            "device_id":    device_id,
            "protocol":     "alexa",
            "action":       "play_station",
            "station_name": sname,
            "rule":         rule_name,
            "_skip_loop_guard": True,
        }
    if action == "stop":
        return {
            "device_id": device_id,
            "protocol":  "alexa",
            "action":    "media_stop",
            "rule":      rule_name,
            "_skip_loop_guard": True,
        }
    return None


# ── Vacuum binding → command dict ─────────────────────────────────────────
# Roomba (and future robot vacuums) bindings are simpler than Alexa —
# just a verb, no template/station name. Picker emits one of:
#
#   {action: 'start'}   → vacuum.start
#   {action: 'stop'}    → vacuum.stop
#   {action: 'dock'}    → vacuum.return_to_base (alias renamed for the picker)
#   {action: 'locate'}  → vacuum.locate
#
# Returns a cmd dict the rule engine's _dispatch_vacuum branch
# consumes. `dev` arg is the device record from state.devices — used
# to gate this helper to vacuum-protocol devices only (since `stop`
# is also a valid Alexa action).
_VACUUM_VERBS = {'start', 'stop', 'dock', 'locate'}


def build_vacuum_cmd(binding, action, device_id, rule_name, dev=None):
    if dev is not None and dev.get('protocol') != 'vacuum':
        return None
    if action not in _VACUUM_VERBS:
        return None
    return {
        'device_id': device_id,
        'protocol':  'vacuum',
        'action':    action,
        'rule':      rule_name,
        '_skip_loop_guard': True,
    }
