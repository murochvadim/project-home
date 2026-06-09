"""Scene Runner — fire a named scene's device on/off list on demand.

Triggered by a synthetic event on device id 'scene_runner' carrying the scene
name in dps.scene — published by the dashboard's Scenes-tab ▶ Run button via
POST /api/scenes/run → mur/home/device/scene_runner/event. Reuses the shared
_scenes helpers (load_scene + expand_scene) so a manual Run dispatches the
EXACT same commands Start Away Mode runs: every device type (multi-gang
channels, local-Tuya set_dps, Alexa, Pixoo, panels) routes identically through
the engine's _dispatch_command. One source of truth — no logic in the dashboard.

Manual, human-initiated: each command carries _skip_loop_guard so firing a
large scene (dozens of devices) never trips the engine's 4-cmd/10s loop guard.

The 'scene_runner' device id is synthetic (not a real device); update_device is
in-memory only so no DB row / device_events pollution. depends_on is empty — the
rule needs no other rule's output, only the scene definition from the DB.

Companion: _scenes.py (load_scene / expand_scene).
"""

import logging
import os
import sys

# RULES/ is the parent of rules/ — on sys.path so `import _scenes` works
# under the engine's importlib loader.
_RULES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _RULES_DIR not in sys.path:
    sys.path.insert(0, _RULES_DIR)
from _scenes import load_scene, expand_scene  # noqa: E402

log = logging.getLogger('rule.scene_runner')


RULE = {
    "name":        "Scene Runner",
    "description": "Run a named scene's device on/off list on demand (Main Agent → Scenes ▶ Run). Reuses _scenes.expand_scene so it dispatches the same commands as Start Away Mode.",
    "triggers":    ["scene_runner"],
    "controls":    [],
    "category":    "control",
    # Own group — NOT 'info'. The info group is full of wildcard rules (Home
    # Activity / People Home / Mode Buttons, all triggers=['*']) that also match
    # the synthetic scene_runner event; if one of them returns a command first
    # (e.g. Mode Buttons' default-to-home), the engine's same-group competition
    # would skip this rule and the scene would silently not run. A dedicated
    # group with no competitors guarantees a Run always fires.
    "group":       "scenes",
    "priority":    10,
    "depends_on":  [],
    "test_event":  {"device_id": "scene_runner", "source": "event", "dps": {"scene": ""}},
}


def evaluate(event, state):
    if event.get('device_id') != 'scene_runner':
        return []
    name = (event.get('dps') or {}).get('scene')
    if not name:
        return []
    scene = load_scene(state, name)
    if not scene:
        log.warning("Scene Runner: scene %r not found or inactive — nothing run", name)
        return []
    cmds = expand_scene(state, scene, 'Scene Runner')
    for c in cmds:
        c['_skip_loop_guard'] = True
    log.info("Scene Runner: ran scene '%s' -> %d command(s)", name, len(cmds))
    return cmds
