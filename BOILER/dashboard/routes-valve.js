// Water valve control via Home Assistant — HCT-636 wireless water timer zones.
//
// The valves are HA 'valve.' domain entities (Tuya Sub-GHz behind the HCG-003
// gateway, exposed via the HA Tuya cloud integration). State is ingested by the
// device agent (ha_api.py HA_DIRECT_DEVICES); this module dispatches open/close.
//
// Own module (one require() line in server.js) so it stays past the
// architecture-guard hook — firing an HA service is within the dashboard's
// allowed "HA control" scope. Same shape as routes-vacuum.js.
//
// Endpoint:
//   POST /api/valve/:entity/:action    action in { open, close, stop }

module.exports = function (app, callHA) {
  const SERVICE = { open: 'open_valve', close: 'close_valve', stop: 'stop_valve' };

  app.post('/api/valve/:entity/:action', async (req, res) => {
    try {
      const action = String(req.params.action || '').toLowerCase();
      const service = SERVICE[action];
      if (!service) return res.status(400).json({ error: 'action must be open, close, or stop' });
      await callHA('valve', service, { entity_id: req.params.entity });
      res.json({ ok: true, entity_id: req.params.entity, service: `valve.${service}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
