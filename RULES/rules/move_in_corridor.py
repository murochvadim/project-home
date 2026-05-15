"""Move in Corridor — corridor presence chain entry rule.

On Corridor Presence rising edge (DPS '1' transitions 'none' → 'presence'):
  1. ALWAYS — Corridor Switch (DPS '1') → ON
  2. WHEN home_mode == 'home' —
       Awtrix preset push (saved app named by `awtrix_preset` sentence)
       Entrance Monitor Switch Ch.2 → ON
  3. AFTER `pixoo_delay_sec` seconds — Pixoo preset push (name from sentence).

Cooldown `cooldown_sec` between fires prevents flicker spam when the mmWave
sensor flutters on the edge of the cone.

Triggers list includes the presence sensor's id (rising-edge entry path)
AND `heartbeat` (so the delayed Pixoo push fires within 60 s even if the
sensor goes silent after the presence event). In practice the mmWave
sensor emits DPS updates 1-3×/sec during continued presence, so a 2-second
delay typically fires within ~1 s of target time. The 60-s heartbeat is
the safety net.

Sentence-driven knobs (container `r_move_in_corridor`):
  - s_mic1_light    — chip @Corridor Switch (informational; device id
                      hardcoded for safety)
  - s_mic2_monitor  — chip @Entrance Monitor Switch Ch.2 (same)
  - s_mic3_awtrix   — chip @Awtrix push <preset_name>
  - s_mic4_delay    — "pixoo delay is N seconds"
  - s_mic5_pixoo    — chip @Pixoo push <preset_name>
  - s_mic6_cooldown — "cooldown is N seconds"

The chip-bearing sentences are parsed inline by `_extract_push_preset()`:
@Awtrix push <name>  → awtrix_preset = <name>
@Pixoo push <name>   → pixoo_preset  = <name>

The text-only sentences are parsed by regex on the joined-text view.

Defaults below act only as fallbacks if the container is missing or
sentences can't be parsed — the source of truth is the sentence editor
under Main Agent → Base Rule Settings.
"""

import json
import logging
import re
import time

log = logging.getLogger("rule.move_in_corridor")

# Device IDs hardcoded — these are not the kind of knobs the user will
# want to tune from a sentence (changing them would mean rewiring the
# entire chain). The sentences document them via chips for visibility.
CORRIDOR_PRESENCE_ID = 'bfbdca138cb1c78c3dlbmc'
CORRIDOR_SWITCH_ID   = 'bfe47a84d7cb783f59inot'
ENTRANCE_MONITOR_ID  = 'bfb4de883ef1713bfdfdpw'
AWTRIX_ID            = 'awtrix_05ec2c'
PIXOO_ID             = 'pixoo'

# Fallback defaults — overridden by container `r_move_in_corridor` if
# sentences are present and parseable.
DEFAULTS = {
    'cooldown_sec':    60,
    'pixoo_delay_sec': 2,
    'awtrix_preset':   'move_on_main_door',
    'pixoo_preset':    'Corridor Stage 1',
}

# Cache parsed knobs for 30 s to avoid hitting the DB on every event.
# Sentence edits land via dashboard save → 30 s max before the rule
# picks them up. Same pattern as other sentence-driven rules.
_knob_cache = {'data': None, 'ts': 0.0}
_KNOB_TTL_SEC = 30.0


RULE = {
    "name": "Move in Corridor",
    "description": "Corridor presence chain — turn on light, conditional awtrix+monitor, delayed pixoo preset push",
    "triggers": [CORRIDOR_PRESENCE_ID, "heartbeat"],
    "controls": [],
    "category": "control",
    "group": "corridor",
    "priority": 10,
    "depends_on": ["Mode Buttons"],
    "test_event": {
        "device_id": CORRIDOR_PRESENCE_ID,
        "source": "event",
        "dps": {"1": "presence"},
    },
}


def _extract_push_preset(sentence, device_marker):
    """Find a chip segment whose v contains `device_marker` followed by
    'push <name>' and return <name>. Returns None if absent."""
    for seg in sentence.get('segments', []):
        if seg.get('t') != 'dev':
            continue
        v = seg.get('v', '')
        if device_marker not in v:
            continue
        m = re.search(r'push\s+(.+?)\s*$', v)
        if m:
            return m.group(1).strip()
    return None


def _read_knobs(state):
    """Parse the r_move_in_corridor sentence container. Returns dict of
    knob values, falling back to DEFAULTS on any parse failure."""
    now = time.time()
    if _knob_cache['data'] is not None and (now - _knob_cache['ts']) < _KNOB_TTL_SEC:
        return _knob_cache['data']

    knobs = dict(DEFAULTS)
    try:
        rows = state.db_query(
            "SELECT value FROM dashboard_settings WHERE key='apartment.rule_sentences'"
        )
        if not rows:
            raise RuntimeError("no sentence config row")
        containers = rows[0][0]
        if isinstance(containers, str):
            containers = json.loads(containers)
        container = next((c for c in containers if c.get('id') == 'r_move_in_corridor'), None)
        if not container:
            raise RuntimeError("container r_move_in_corridor not found")

        for sentence in container.get('sentences', []):
            if not sentence.get('active', True):
                continue
            # Reconstruct full text view (text + dev segments)
            full_text = ''.join(seg.get('v', '') for seg in sentence.get('segments', []))

            # Awtrix push preset from chip
            p = _extract_push_preset(sentence, '@Awtrix')
            if p:
                knobs['awtrix_preset'] = p

            # Pixoo push preset from chip
            p = _extract_push_preset(sentence, '@Pixoo')
            if p:
                knobs['pixoo_preset'] = p

            # Text-only knobs: cooldown + pixoo delay
            m = re.search(r'cooldown is\s+(\d+)\s*seconds?', full_text, re.I)
            if m:
                knobs['cooldown_sec'] = int(m.group(1))
            m = re.search(r'pixoo delay is\s+(\d+)\s*seconds?', full_text, re.I)
            if m:
                knobs['pixoo_delay_sec'] = int(m.group(1))

    except Exception as e:
        log.warning("Move in Corridor: knob parse failed (%s) — using defaults", e)

    _knob_cache['data'] = knobs
    _knob_cache['ts'] = now
    return knobs


def _try_fire_pending_pixoo(state):
    """If a scheduled Pixoo push is due, return the command and clear state.

    NOTE: state.shared keys are not deleted via pop() because save_shared_state
    only UPSERTs (never DELETEs), and load_shared_state restores any DB key
    that isn't in memory — popping leads to infinite refire every heartbeat.
    Set falsy sentinels instead so the keys stay in memory as 0/'' and
    load_shared_state's `if key not in self.shared` branch is skipped.
    """
    ts = state.shared.get('move_in_corridor.pending_pixoo_ts')
    if not ts:
        return None
    if time.time() < float(ts):
        return None
    preset = state.shared.get('move_in_corridor.pending_pixoo_preset', '')
    state.shared['move_in_corridor.pending_pixoo_ts'] = 0
    state.shared['move_in_corridor.pending_pixoo_preset'] = ''
    if not preset:
        return None
    log.info("Move in Corridor: firing scheduled Pixoo push '%s'", preset)
    return {
        "device_id":   PIXOO_ID,
        "protocol":    "pixoo",
        "action":      "push_preset",
        "preset_name": preset,
        "rule":        "Move in Corridor",
        "_skip_loop_guard": True,
    }


def evaluate(event, state):
    commands = []
    dev_id = event.get('device_id', '')

    # On every wake-up (any of this rule's triggers), check whether the
    # delayed Pixoo push is due. Both heartbeat and presence-sensor events
    # fire frequently enough to give sub-second-to-60-s precision.
    pending = _try_fire_pending_pixoo(state)
    if pending:
        commands.append(pending)

    # Only the Corridor Presence sensor itself triggers the chain entry.
    if dev_id != CORRIDOR_PRESENCE_ID:
        return commands

    dps = event.get('dps', {}) or {}
    if '1' not in dps:
        # Event from this device but no presence-state field — ignore
        # (other DPS like motion_amplitude / target_distance updates).
        return commands

    is_presence = dps.get('1') in ('presence', True, 'true', 1)

    # Track last-known presence in state.shared so we only fire on the
    # rising edge (none → presence). Updates BOTH directions so the next
    # rising edge can fire after the sensor reports 'none' first.
    last_pres = state.shared.get('move_in_corridor.last_presence', 'none')
    state.shared['move_in_corridor.last_presence'] = 'presence' if is_presence else 'none'

    if not is_presence:
        return commands  # falling edge — just update tracker, no actions
    if last_pres == 'presence':
        return commands  # already in presence; no rising edge

    # Cooldown — prevents the chain from firing repeatedly if presence
    # flickers on the cone edge.
    knobs = _read_knobs(state)
    cooldown = state.get_timer('move_in_corridor_cooldown')
    if cooldown < knobs['cooldown_sec']:
        log.info("Move in Corridor: rising edge but cooldown (%ds < %ds) — skipping",
                 cooldown, knobs['cooldown_sec'])
        return commands
    state.set_timer('move_in_corridor_cooldown')

    log.info("Move in Corridor: rising edge — firing chain (knobs=%s)", knobs)

    # 1. ALWAYS — Corridor light ON
    commands.append({
        "device_id": CORRIDOR_SWITCH_ID,
        "action":    "turn_on",
        "channel":   "1",
        "rule":      "Move in Corridor",
        "_skip_loop_guard": True,
    })

    # 2. WHEN home_mode == 'home' — Awtrix + Monitor Ch.2
    home_mode = state.shared.get('home_mode', 'away')
    if home_mode == 'home':
        if knobs.get('awtrix_preset'):
            commands.append({
                "device_id":   AWTRIX_ID,
                "protocol":    "awtrix",
                "action":      "push_preset",
                "preset_name": knobs['awtrix_preset'],
                "rule":        "Move in Corridor",
                "_skip_loop_guard": True,
            })
        commands.append({
            "device_id": ENTRANCE_MONITOR_ID,
            "action":    "turn_on",
            "channel":   "2",
            "rule":      "Move in Corridor",
            "_skip_loop_guard": True,
        })
    else:
        log.info("Move in Corridor: home_mode='%s' (not home) — skipping awtrix+monitor", home_mode)

    # 3. Schedule delayed Pixoo push. Stored in state.shared so heartbeat
    #    AND subsequent presence-sensor events both poll for it.
    if knobs.get('pixoo_preset') and knobs['pixoo_delay_sec'] > 0:
        fire_at = time.time() + knobs['pixoo_delay_sec']
        state.shared['move_in_corridor.pending_pixoo_ts'] = fire_at
        state.shared['move_in_corridor.pending_pixoo_preset'] = knobs['pixoo_preset']
        log.info("Move in Corridor: scheduled Pixoo '%s' in %ds",
                 knobs['pixoo_preset'], knobs['pixoo_delay_sec'])

    return commands
