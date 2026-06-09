// Scenes — run a saved scene on demand (Main Agent → Scenes tab ▶ Run button).
//
// Own module (wired from server.js via a single require line) so server.js stays
// free of new route handlers — the architecture-guard hook blocks adding
// `app.<method>(` directly to server.js.
//
// ARCHITECTURE: "running" a scene = fire its device on/off list, which is
// business logic and therefore lives on LXC 105 (the rule engine), NOT here.
// This endpoint only publishes a trigger event that the `Scene Runner` rule
// reacts to; that rule reuses _scenes.expand_scene so a manual Run dispatches
// the exact same commands as Start Away Mode (every device type routes through
// the engine's _dispatch_command — multi-gang channels, local-Tuya set_dps,
// Alexa, Pixoo, panels). The dashboard stays UI-only.
//
// Endpoint:
//   POST /api/scenes/run   { name }
//     -> publishes mur/home/device/scene_runner/event  {scene:<name>}
//     -> returns { ok:true, devices:<count> }  (count is a read-only sanity echo)
//
// `getMqtt` is a getter (not the client itself) because server.js can swap the
// mqtt client on its auto-heal path — we must read it live at request time.

module.exports = function (app, db, getMqtt) {
  app.post('/api/scenes/run', async (req, res) => {
    try {
      const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ ok: false, error: 'name required' });

      // Validate the scene exists + is active, and echo its device count.
      // Read-only — the actual dispatch happens on LXC 105.
      const r = await db.query(
        `SELECT value FROM dashboard_settings WHERE key = 'apartment.scenes'`
      );
      const scenes = (r.rows.length && Array.isArray(r.rows[0].value)) ? r.rows[0].value : [];
      const want = name.toLowerCase();
      const scene = scenes.find(s => s && (s.name || '').trim().toLowerCase() === want && s.active !== false);
      if (!scene) return res.status(404).json({ ok: false, error: `scene "${name}" not found or inactive` });
      const devCount = Array.isArray(scene.devices) ? scene.devices.length : 0;

      const mqtt = getMqtt && getMqtt();
      if (!mqtt) return res.status(503).json({ ok: false, error: 'MQTT not connected' });
      mqtt.publish('mur/home/device/scene_runner/event',
                   JSON.stringify({ scene: scene.name }), { qos: 1 });

      console.log(`scenes: run "${scene.name}" (${devCount} devices) -> trigger published`);
      res.json({ ok: true, devices: devCount });
    } catch (e) {
      console.error('POST /api/scenes/run:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
