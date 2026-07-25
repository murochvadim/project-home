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
//   POST /api/vacuum/:entity/fan-speed   body { speed: "<any value from the device's own fan_speed_list>" }
//
// Fan-speed names differ per vacuum (Roborock: Silent/Basic/Strong/Full Speed;
// Roomba: Automatic/Eco/Performance), so we do NOT hardcode a list — we accept
// any non-empty value and let HA's vacuum.set_fan_speed validate it against the
// entity's own fan_speed_list (an unknown value comes back as an HA error).

module.exports = function (app, callHA) {
  app.post('/api/vacuum/:entity/fan-speed', async (req, res) => {
    try {
      const speed = String((req.body || {}).speed || '').trim();
      if (!speed) return res.status(400).json({ error: 'speed required' });
      await callHA('vacuum', 'set_fan_speed', { entity_id: req.params.entity, fan_speed: speed });
      res.json({ ok: true, fan_speed: speed });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
