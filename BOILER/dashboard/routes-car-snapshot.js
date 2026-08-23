// Car camera "📷 Snapshot" — ask the car phone to capture one still now.
//
// Own module (single require line in server.js) so server.js stays free of new
// `app.<method>(` handlers (architecture-guard hook). THIN control publish — like
// routes-carlocate.js: it just fires one MQTT command. The car phone's CarCam app
// subscribes to the command topic, captures ONE JPEG (camera off between shots),
// and uploads it to the media agent (`Car Snapshots/latest.jpg`); the dashboard
// then shows it from `:8766/api/media/thumb`.
//
// No new ACL needed: server.js's MQTT user `rule_engine` already has
// `readwrite mur/home/esp/+/#`, and the phone's `esp_boards` user reads it.
//
//   POST /api/car/snapshot -> publishes mur/home/esp/car_camera/command {"action":"snapshot"}
//                          -> { ok:true }

const CMD_TOPIC = 'mur/home/esp/car_camera/command';

module.exports = function (app, getMqtt) {
  app.post('/api/car/snapshot', (req, res) => {
    const mqtt = getMqtt && getMqtt();
    if (!mqtt || !mqtt.connected) {
      return res.status(503).json({ ok: false, error: 'MQTT not connected' });
    }
    mqtt.publish(CMD_TOPIC, JSON.stringify({ action: 'snapshot' }), { qos: 1 }, (err) => {
      if (err) return res.status(500).json({ ok: false, error: String(err && err.message || err) });
      res.json({ ok: true });
    });
  });
};
