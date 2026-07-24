// Vacuum extras — fan-speed control via Home Assistant.
//
// The basic verbs (start/stop/pause/dock/locate) live inline in server.js as
// POST /api/vacuum/:entity/:verb. Fan speed takes a VALUE, so it lives here in
// its own module (wired from server.js with one require line) — the
// architecture-guard hook blocks adding new app.<method>( to server.js, and
// firing an HA service is within the dashboard's allowed "HA control" scope.
//
// This module is also the future home for Phase-2 room/zone cleaning
// (app_segment_clean / app_zoned_clean via vacuum.send_command).
//
// Endpoint:
//   POST /api/vacuum/:entity/fan-speed   body { speed: "Silent"|"Basic"|"Strong"|"Full Speed" }

const VACUUM_FAN_SPEEDS = ['Silent', 'Basic', 'Strong', 'Full Speed'];

module.exports = function (app, callHA) {
  app.post('/api/vacuum/:entity/fan-speed', async (req, res) => {
    try {
      const speed = String((req.body || {}).speed || '');
      if (!VACUUM_FAN_SPEEDS.includes(speed)) {
        return res.status(400).json({ error: `unknown speed '${speed}' (allowed: ${VACUUM_FAN_SPEEDS.join(', ')})` });
      }
      await callHA('vacuum', 'set_fan_speed', { entity_id: req.params.entity, fan_speed: speed });
      res.json({ ok: true, fan_speed: speed });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
