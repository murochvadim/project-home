// Car "Locate now" — ask the car phone's OwnTracks to report its GPS immediately.
//
// Own module (wired from server.js via a single require line) so server.js stays
// free of new `app.<method>(` handlers (the architecture-guard hook blocks those).
//
// ARCHITECTURE: this is a THIN control publish (like the device-toggle / scene /
// corridor-sim publishes) — it just fires one OwnTracks remote command; no
// business logic. OwnTracks on the car phone subscribes to its `…/cmd` topic and,
// with Remote Commands enabled (`cmd:true`), reports its current location, which
// flows back through the normal ingest.
//
// Endpoint:
//   POST /api/geolocation/car/locate
//     -> publishes owntracks/owntracks_phone/car/cmd  {"_type":"cmd","action":"reportLocation"}
//     -> returns { ok:true }
//
// ⚠ Requires on LXC 107: `user rule_engine` (the dashboard's MQTT user) must have
//   `topic write owntracks/owntracks_phone/+/cmd` — otherwise mosquitto silently
//   drops the publish. `getMqtt` is a getter because server.js can swap the client
//   on its auto-heal path, so we read it live at request time.

const CMD_TOPIC = 'owntracks/owntracks_phone/car/cmd';

module.exports = function (app, getMqtt) {
  app.post('/api/geolocation/car/locate', (req, res) => {
    const mqtt = getMqtt && getMqtt();
    if (!mqtt || !mqtt.connected) {
      return res.status(503).json({ ok: false, error: 'MQTT not connected' });
    }
    const payload = JSON.stringify({ _type: 'cmd', action: 'reportLocation' });
    mqtt.publish(CMD_TOPIC, payload, { qos: 1 }, (err) => {
      if (err) return res.status(500).json({ ok: false, error: String(err && err.message || err) });
      res.json({ ok: true });
    });
  });
};
