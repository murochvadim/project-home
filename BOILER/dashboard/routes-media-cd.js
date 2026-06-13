// Bedroom CD player — IR control via Home Assistant scenes.
//
// The CD player is an IR-only device (no media_player entity, no feedback). HA
// exposes 5 scenes that fire the IR codes; we just activate them via
// scene.turn_on. Own module (wired from server.js with one require line) so
// server.js stays free of new route handlers — the architecture-guard hook
// blocks adding app.<method>( directly. Firing HA scenes is within the
// dashboard's allowed "TV/HA control" scope.
//
// IR is one-way: these are fire-and-forget commands, there is no state to read.
//
// Endpoint:
//   POST /api/cd/:action   action ∈ power|play|stop|vol-up|vol-down

const CD_SCENES = {
  power: 'scene.cd_on_off',
  play: 'scene.cd_bedroom_play',
  stop: 'scene.cd_bedroom_stop',
  'vol-up': 'scene.cd_vol_2',
  'vol-down': 'scene.cd_vol',
};

module.exports = function (app, callHA) {
  app.post('/api/cd/:action', async (req, res) => {
    const entity = CD_SCENES[req.params.action];
    if (!entity) return res.status(400).json({ error: 'unknown CD action' });
    try {
      await callHA('scene', 'turn_on', { entity_id: entity });
      res.json({ ok: true, fired: entity });
    } catch (e) {
      console.error('[cd] action failed:', req.params.action, e.message);
      res.status(500).json({ error: e.message });
    }
  });
};
