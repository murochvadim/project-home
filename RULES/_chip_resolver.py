"""Shared chip resolver for sentence-driven rules.

Used by rules that need to turn chip tokens like

  @<DeviceName> <ChannelLabel> [on|off]
  @<DeviceName> push <PresetName>
  @<PanelName> Page <N>
  @<EchoName> say "<phrase>"

into command dicts ready for `rule_engine._dispatch_command`. Two layers:

  - `parse_display_chip` (imported from `_display_chips`) handles displays /
    panels / alexa chips — the well-defined "media" chip vocabulary.
  - `resolve_switch_chip` handles generic switches + ESP boards via the
    canonical lookup order: dps_config (controllable channels) →
    channel_config (Tuya multi-gang) → dps_labels (readable status keys
    last-resort). The order matters — see
    [feedback/move_in_corridor pop-sentinel & chip-order] for the
    incident that motivated this ordering.

`resolve_chip` is the single top-level entry every caller should use —
it tries display-chip parsing first, then falls back to switch-chip
resolution. The rule_name is threaded through so `cmd['rule']` is set
correctly for downstream logging.

Extracted 2026-05-16 from duplicated copies in `move_in_corridor.py`
and `face_recognition_loop.py`. When a future rule needs the same
chip-resolution shape, it should import from here instead of copying.
"""

import logging
import re

from _display_chips import parse_display_chip

log = logging.getLogger("rule._chip_resolver")

# `@<Device> Ch.<N>` — matches "Ch.2", "ch.7", etc. Channel is the captured N.
_CH_N_RE = re.compile(r'^Ch\.(\d+)$', re.IGNORECASE)


def resolve_switch_chip(token, devices_by_name, rule_name):
    """Resolve a generic switch / ESP / multi-channel chip to a command dict.

    Returns None if:
      - token is not a chip (doesn't start with @)
      - the device name doesn't resolve in devices_by_name
      - the device is a display / panel / alexa (caller should use
        `parse_display_chip` for those — this function explicitly skips
        them so the caller can chain the two)
      - a channel-label was specified but couldn't be matched against
        any of dps_config / channel_config / dps_labels

    Channel resolution order (matters — see incident log):
      1. `Ch.<N>` literal regex (e.g. "Ch.2" → "2")
      2. dps_config.<key>.name OR literal key — CONTROLLABLE channels first
      3. channel_config.<key>.name — Tuya multi-gang names
      4. dps_labels.<key> value — readable status labels (last resort)

    Defaults action to `turn_on` if no explicit `on`/`off` suffix. Defaults
    channel to `'1'` if the chip names only a device (single-channel safe).

    Sets protocol='esp' for ESP boards, protocol='hasp' for HASP panels —
    so the rule engine routes via the correct dispatch branch.
    """
    if not token or not token.startswith('@'):
        return None
    body = token[1:].strip()
    if not body:
        return None
    parts = body.split()
    dev = None
    rest_parts = []
    for split_at in range(len(parts), 0, -1):
        candidate = ' '.join(parts[:split_at])
        if candidate in devices_by_name:
            dev = devices_by_name[candidate]
            rest_parts = parts[split_at:]
            break
    if not dev:
        return None

    protocol = dev.get('protocol', '')
    dtype    = dev.get('device_type', '')
    if dtype == 'display' or protocol in ('pixoo', 'awtrix') or dtype == 'panel' or protocol == 'alexa':
        return None  # caller should fall back to parse_display_chip

    action = 'turn_on'
    if rest_parts and rest_parts[-1].lower() == 'on':
        rest_parts = rest_parts[:-1]
    elif rest_parts and rest_parts[-1].lower() == 'off':
        action = 'turn_off'
        rest_parts = rest_parts[:-1]

    channel_text = ' '.join(rest_parts).strip()
    channel = None

    if channel_text:
        m = _CH_N_RE.match(channel_text)
        if m:
            channel = m.group(1)
        else:
            # dps_config first (controllable channels)
            dps_config = dev.get('dps_config') or {}
            for k, v in dps_config.items():
                if not isinstance(v, dict):
                    continue
                if (v.get('name') or '').lower() == channel_text.lower() or k.lower() == channel_text.lower():
                    channel = k
                    break
            if not channel:
                # channel_config second (Tuya multi-gang)
                ch_config = dev.get('channel_config') or {}
                for k, v in ch_config.items():
                    if isinstance(v, dict) and (v.get('name') or '').lower() == channel_text.lower():
                        channel = k
                        break
            if not channel:
                # dps_labels last (readable status fields)
                dps_labels = dev.get('dps_labels') or {}
                for k, v in dps_labels.items():
                    if isinstance(v, str) and v.lower() == channel_text.lower():
                        channel = k
                        break

        if channel is None:
            log.warning("%s: chip %r — channel %r not found on device %s",
                        rule_name, token, channel_text, dev.get('id'))
            return None

    if not channel:
        channel = '1'

    cmd = {
        'device_id': dev.get('id'),
        'action':    action,
        'channel':   channel,
        'rule':      rule_name,
        '_skip_loop_guard': True,
    }
    if protocol == 'esp':
        cmd['protocol'] = 'esp'
    elif protocol == 'hasp':
        cmd['protocol'] = 'hasp'
    return cmd


def resolve_chip(token, devices_by_name, rule_name):
    """Top-level chip resolver.

    Tries display/panel/alexa chips first via `parse_display_chip`. Falls
    back to `resolve_switch_chip` for generic switches and ESP boards.
    Returns a command dict ready for `rule_engine._dispatch_command`, or
    None if the chip can't be resolved by any path.
    """
    cmd = parse_display_chip(token, devices_by_name)
    if cmd:
        cmd.setdefault('rule', rule_name)
        cmd['_skip_loop_guard'] = True
        return cmd
    return resolve_switch_chip(token, devices_by_name, rule_name)
