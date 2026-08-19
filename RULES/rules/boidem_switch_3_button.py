"""Boidem Switch 3 Button — mirror the Hallway Switch Zigbee's buttons to lights.

Sentence-driven. The container "Boidem Switch 3 Button"
(id r_boidem_switch_3_button_init) in dashboard_settings.apartment.rule_sentences
holds one sentence per button. Each sentence pairs a SOURCE button chip
(@Hallway Switch Zigbee Button N) with an optional TARGET device chip
(@<Light>). This rule mirrors each wired button's LATCHING state onto its
target: button ON -> target turn_on, button OFF -> target turn_off.

FLIP (toggle) mode: if a sentence contains the word "flip" or "toggle" (or
the target chip ends with " toggle"/" flip"), that button instead FLIPS its
target on every press — reads the target's current on/off and commands the
opposite. Use this when the target can also be operated elsewhere (its own
switch / remote), so the gang latch drifts out of sync with the real state
and a plain mirror needs two presses to "catch up". Per-sentence, so mirror
buttons and flip buttons coexist. First flip use: Button 2 -> Antic Bra.

The switch (Hallway Switch Zigbee, 0xa4c1386be3572ed1) is the rule's fixed
identity, hardcoded in triggers. Its three gangs are latching relays —
state_l1/l2/l3 hold their value (verified live 2026-08-06: Button 3 set ON
stayed ON). Only buttons that carry a target chip act; Buttons 1 & 2 are
seeded targetless (no-op) until the user adds a +Dev chip in Base Rule
Settings. Only Button 3 -> Boidem Light is wired today.

Edge-detected in both directions against a per-button snapshot in
state.shared['_boidem_sw3_last']. A button not yet in the snapshot is primed
silently (no fire) on its first event, so neither a Reload nor newly wiring a
button ever spuriously drives a target.

Reuses the canonical sentence/chip helpers from evening_lights.py (inlined to
keep the rule self-contained). No engine change: the zigbee dispatch already
defaults state_key = channel or 'state', so a single-gang target (Boidem's
'state') is driven correctly.
"""

import json
import logging
import re
import time

log = logging.getLogger('rule.boidem_switch_3_button')

_SWITCH_ID      = "0xa4c1386be3572ed1"                 # Hallway Switch Zigbee (3-gang, latching)
_BUTTON_KEYS    = ("state_l1", "state_l2", "state_l3")
_CONTAINER_NAME = "boidem switch 3 button"
_TRUTHY         = (True, 1, "1", "on", "ON", "true", "True")
_CACHE_TTL_SEC  = 30

_map_cache = {"data": None, "ts": 0.0}


RULE = {
    "name": "Boidem Switch 3 Button",
    "description": (
        "Pressing a button on the Hallway Switch controls its assigned light. "
        "Button 1 controls the Hallway Spot, Button 3 controls the Boidem Light "
        "(both match the switch position). Button 2 FLIPS the Antic Bra light — "
        "every press turns it on if it's off, or off if it's on. Assign or change "
        "these in Base Rule Settings."
    ),
    "triggers": [_SWITCH_ID],
    "controls": [],
    "category": "control",
    "group": "boidem_switch",       # own single-rule group — no per-group mutual-exclusion
    "priority": 10,
    "depends_on": [],
    # Test button: simulate Button 3 pressed ON.
    "test_event": {
        "device_id": _SWITCH_ID,
        "source": "zigbee",
        "dps": {"state_l1": "OFF", "state_l2": "OFF", "state_l3": "ON"},
    },
}


# ─────────────────────────── Helpers (inlined from evening_lights.py) ──────────

def _sentence_text(s):
    segs = s.get('segments')
    if isinstance(segs, list) and segs:
        return ''.join((seg or {}).get('v', '') for seg in segs)
    return s.get('text') or ''


def _iter_dev_chips(sentence):
    segs = sentence.get('segments')
    if not isinstance(segs, list):
        return []
    out = []
    for seg in segs:
        if isinstance(seg, dict) and (seg.get('t') or '').lower() == 'dev':
            v = seg.get('v') or ''
            if v.startswith('@'):
                out.append(v)
    return out


def _parse_dev_chip(chip_value, devices_by_name_desc):
    """'@<DeviceName> <ChannelLabel>' -> (device_id, dps_key) via longest-prefix
    name match; channel label resolved through the device's dps_labels."""
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


def _build_devices_by_name_desc(state_devices):
    by_name = {}
    for dev_id, dev in state_devices.items():
        name = (dev.get('name') or '').strip()
        if not name:
            continue
        merged = dict(dev)
        merged['id'] = dev_id
        by_name[name] = merged
    return sorted(by_name.items(), key=lambda kv: len(kv[0]), reverse=True)


def _read_container(state):
    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ('apartment.rule_sentences',),
    )
    if not rows:
        return None
    raw = rows[0][0]
    if isinstance(raw, str):
        try:
            rules = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            log.warning("boidem_switch_3_button: apartment.rule_sentences not valid JSON")
            return None
    elif isinstance(raw, list):
        rules = raw
    else:
        return None
    for r in rules or []:
        if not r.get('active'):
            continue
        if (r.get('name') or '').strip().lower() == _CONTAINER_NAME:
            return r
    return None


def _load_button_map(state):
    """Return {source_dps_key: (target_id, target_channel, is_flip)} from the container.

    Per sentence: the chip resolving to (switch, state_l*) is the source button;
    the other chip is the target. A sentence whose text carries "flip"/"toggle"
    (or a target chip ending in " toggle"/" flip") marks that button as FLIP —
    each press toggles the target instead of mirroring the latch. Sentences with
    no target are skipped. 30s cache.
    """
    now = time.time()
    if _map_cache["data"] is not None and (now - _map_cache["ts"]) < _CACHE_TTL_SEC:
        return _map_cache["data"]

    mapping = {}
    container = _read_container(state)
    if container:
        by_name = _build_devices_by_name_desc(state.devices)
        for s in (container.get('sentences') or []):
            if not s.get('active'):
                continue
            is_flip = bool(re.search(r'\b(flip|toggle)', _sentence_text(s), re.I))
            source_key = None
            target = None
            for chip in _iter_dev_chips(s):
                raw = chip
                m = re.search(r'\s+(toggle|flip)\s*$', raw, re.I)   # marker on the chip itself
                if m:
                    is_flip = True
                    raw = raw[:m.start()]
                parsed = _parse_dev_chip(raw, by_name)
                if not parsed:
                    continue
                dev_id, dps_key = parsed
                if dev_id == _SWITCH_ID and dps_key in _BUTTON_KEYS:
                    source_key = dps_key           # the button this sentence is for
                else:
                    target = (dev_id, dps_key)     # what that button controls
            if source_key and target:
                mapping[source_key] = (target[0], target[1], is_flip)

    _map_cache["data"] = mapping
    _map_cache["ts"] = now
    return mapping


def _is_on(val):
    return val in _TRUTHY


def _ha_entity_for(tdev, target_chan):
    """HA switch entity for a firmware-locked target, from dps_config.<ch>.ha_entity.
    Present => the target's local write fake-ACKs, so drive it via HA (Tuya cloud)."""
    cfg = tdev.get('dps_config') or {}
    if target_chan is not None:
        cc = cfg.get(target_chan)
        if isinstance(cc, dict) and cc.get('ha_entity'):
            return cc['ha_entity']
    for cc in cfg.values():
        if isinstance(cc, dict) and cc.get('ha_entity'):
            return cc['ha_entity']
    return None


def _target_is_on(tdev, target_chan):
    """Current on/off of a target device (for local flip mode)."""
    dps = tdev.get('dps') or {}
    if target_chan is not None:
        return _is_on(dps.get(target_chan))
    # bare chip: use the device's local-DPS on/off recipe key if it has one
    cfg = tdev.get('dps_config') or {}
    for cc in cfg.values():
        don = (cc or {}).get('dps_on')
        if isinstance(don, dict) and don:
            return _is_on(dps.get(next(iter(don))))
    for k in ('1', 'state', 'output1'):
        if k in dps:
            return _is_on(dps.get(k))
    return False


def evaluate(event, state):
    if event.get('device_id') != _SWITCH_ID:
        return []

    button_map = _load_button_map(state)
    if not button_map:
        return []

    event_dps = event.get('dps') or {}
    live_dps  = (state.devices.get(_SWITCH_ID) or {}).get('dps') or {}
    snapshot  = state.shared.get('_boidem_sw3_last') or {}
    new_snapshot = dict(snapshot)
    commands = []

    for src_key, (target_id, target_chan, is_flip) in button_map.items():
        # Prefer this event's payload (authoritative for what changed); fall
        # back to live merged state. Skip if this button isn't reported at all.
        if src_key in event_dps:
            cur = _is_on(event_dps.get(src_key))
        elif src_key in live_dps:
            cur = _is_on(live_dps.get(src_key))
        else:
            continue

        prev = snapshot.get(src_key)
        new_snapshot[src_key] = cur

        if src_key not in snapshot:
            continue                               # newly mapped button — prime, no fire
        if prev == cur:
            continue                               # no edge for this button

        tdev      = state.devices.get(target_id) or {}
        ha_entity = _ha_entity_for(tdev, target_chan)

        if ha_entity:
            # Firmware-locked switch (local set_dps fake-ACKs) -> drive via HA
            # (Tuya cloud). Flip = switch.toggle (server-side, no state read);
            # mirror = turn_on/off from the gang latch.
            service = 'toggle' if is_flip else ('turn_on' if cur else 'turn_off')
            cmd = {
                'device_id':        target_id,
                'protocol':         'ha_switch',
                'entity_id':        ha_entity,
                'service':          service,
                'rule':             'Boidem Switch 3 Button',
                # Reacts to human button input — opt out of the loop guard.
                '_skip_loop_guard': True,
            }
            log.info(
                "boidem_switch_3_button: %s %s -> %s ha_switch.%s (%s)%s",
                src_key, 'ON' if cur else 'OFF', target_id, service, ha_entity,
                ' [flip]' if is_flip else '',
            )
        else:
            if is_flip:
                # FLIP: toggle the target to the opposite of its real state
                # (survives out-of-sync gang latch vs lamp).
                action = 'turn_off' if _target_is_on(tdev, target_chan) else 'turn_on'
            else:
                # MIRROR: copy the gang's latch position onto the target.
                action = 'turn_on' if cur else 'turn_off'
            cmd = {
                'device_id':        target_id,
                'action':           action,
                'rule':             'Boidem Switch 3 Button',
                # Reacts to human button input — opt out of the loop guard so rapid
                # intentional presses can't auto-disable the rule.
                '_skip_loop_guard': True,
            }
            if target_chan is not None:
                cmd['channel'] = target_chan
            log.info(
                "boidem_switch_3_button: %s %s -> %s %s%s%s",
                src_key, 'ON' if cur else 'OFF', target_id, action,
                (' ch=%s' % target_chan) if target_chan else '',
                ' [flip]' if is_flip else '',
            )
        commands.append(cmd)

    # Private (_-prefixed) key → doesn't inflate the Runs counter.
    state.shared['_boidem_sw3_last'] = new_snapshot
    return commands
