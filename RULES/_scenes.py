"""Shared Scene helpers — load a named scene + expand it into device commands.

A "scene" is a reusable, named device-action list authored on the Main Agent →
Scenes tab and stored in `dashboard_settings.apartment.scenes`:

    [{ "id": "...", "name": "Away Devices Off", "active": true,
       "devices": [ {"t":"dev", "v":"@Table Lamp off"},
                    {"t":"dev", "v":"@Bedroom Main Switch Main Left Light off"},
                    {"t":"dev", "v":"@Alexa Balcony on"}, ... ] }, ...]

Each device chip `v` uses the same grammar the device-picker + rule sentences use
("@Name", "@Name Channel", "@Name on/off", "@Pixoo push X", "@Alexa say …", …).

This module turns a scene into a list of command dicts the rule engine can
dispatch — reusable by any rule/binding that wants to "run a scene". It owns the
device-name → (device_id, channel) resolution so there is ONE copy of it
(`start_away_mode` imports `parse_dev_chip` from here for its keep-on chip too).
"""

import json
import logging
import os
import re
import sys

# RULES/ (this file's own dir) on sys.path so `import _display_chips` works
# whether loaded by the engine or a rule module.
_RULES_DIR = os.path.dirname(os.path.abspath(__file__))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _display_chips import parse_display_chip, build_devices_by_name  # noqa: E402

log = logging.getLogger('rule._scenes')

# trailing " on" / " off" on a chip token = the scene's on/off intent
_ONOFF_RE = re.compile(r'\s+(on|off)\s*$', re.IGNORECASE)


# ─────────────── device-name resolution (single canonical copy) ───────────────

def build_devices_by_name_desc(state_devices):
    """name → device dict, sorted by name length DESC for greedy longest-prefix
    matching (so '@Bedroom Main Switch Main Left Light' beats '@Bedroom')."""
    by_name = {}
    for dev_id, dev in state_devices.items():
        name = (dev.get('name') or '').strip()
        if not name:
            continue
        merged = dict(dev)
        merged['id'] = dev_id
        by_name[name] = merged
    return sorted(by_name.items(), key=lambda kv: len(kv[0]), reverse=True)


def parse_dev_chip(chip_value, devices_by_name_desc):
    """'@Name' or '@Name Channel' → (device_id, dps_key_or_None); None if no match.
    Channel is resolved against the device's dps_labels (the same source the
    device-picker used to author multi-gang channel chips)."""
    if not chip_value or not chip_value.startswith('@'):
        return None
    text = chip_value[1:].strip()
    if not text:
        return None
    for name, dev in devices_by_name_desc:
        if text == name:
            return (dev['id'], None)
        if text.startswith(name + ' '):
            label = text[len(name) + 1:].strip()
            dps_labels = dev.get('dps_labels') or {}
            for dps_key, dps_label in dps_labels.items():
                if dps_label == label:
                    return (dev['id'], dps_key)
            return (dev['id'], None)
    return None


# ─────────────────────────── scene load + expand ───────────────────────────

def load_scene(state, name):
    """Return the active scene dict named `name` (case-insensitive) from
    `dashboard_settings.apartment.scenes`, or None."""
    if not name:
        return None
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ('apartment.scenes',),
    )
    if not rows:
        return None
    raw = rows[0][0]
    if isinstance(raw, str):
        try:
            scenes = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            log.warning('_scenes: apartment.scenes is not valid JSON')
            return None
    elif isinstance(raw, list):
        scenes = raw
    else:
        return None
    want = name.strip().lower()
    for sc in scenes or []:
        if sc.get('active') is False:
            continue
        if (sc.get('name') or '').strip().lower() == want:
            return sc
    return None


def expand_scene(state, scene, rule_name):
    """Turn a scene's device chips into a list of command dicts.

    Per chip {t:'dev', v:'<token>'}:
      1. try parse_display_chip(token) — display/alexa/panel chips carry their
         own protocol + action (e.g. '@Alexa Balcony on') → use as-is.
      2. else strip a trailing ' on'/' off' → resolve '@Name [Channel]' via
         parse_dev_chip → emit {device_id, action:'turn_on'|'turn_off', channel?}.
    A chip with NO on/off action (and not a display chip) is skipped + logged —
    a scene can't act on a device whose state was never set.
    """
    if not scene:
        return []
    devices_by_name      = build_devices_by_name(state.devices)
    devices_by_name_desc = build_devices_by_name_desc(state.devices)
    cmds = []
    for seg in (scene.get('devices') or []):
        if not isinstance(seg, dict):
            continue
        tok = (seg.get('v') or '').strip()
        if not tok or not tok.startswith('@'):
            continue

        # 1. display / alexa / panel action chip (carries its own protocol+action)
        disp = parse_display_chip(tok, devices_by_name)
        if disp:
            cmds.append({**disp, 'rule': rule_name})
            continue

        # 2. plain device: trailing on/off → turn_on/turn_off on its channel
        m = _ONOFF_RE.search(tok)
        if not m:
            log.info("_scenes: scene '%s' chip %r has no on/off — skipped",
                     scene.get('name'), tok)
            continue
        action = 'turn_on' if m.group(1).lower() == 'on' else 'turn_off'
        base = tok[:m.start()].strip()
        parsed = parse_dev_chip(base, devices_by_name_desc)
        if not parsed:
            log.warning("_scenes: scene '%s' chip %r → device not found — skipped",
                        scene.get('name'), tok)
            continue
        dev_id, dps_key = parsed
        cmd = {'device_id': dev_id, 'action': action, 'rule': rule_name}
        if dps_key is not None:
            cmd['channel'] = dps_key
        cmds.append(cmd)
    return cmds
