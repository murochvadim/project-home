// LetPot hydroponic control via Home Assistant — LPH-Max (A687) and future LetPot units.
//
// The device's entities come from the official HA LetPot cloud integration and
// span several HA domains (switch / number / select / time; sensors are
// read-only). State is ingested by the device agent (ha_api.py HA_DIRECT_DEVICES,
// row id 'lph_max_a687'); this module dispatches control by calling the right HA
// service per domain, inferred from the entity_id.
//
// Own module (one require() line in server.js) so it stays past the
// architecture-guard hook — firing an HA service is within the dashboard's
// allowed "HA control" scope. Same shape as routes-valve.js / routes-vacuum.js.
//
// Endpoint:
//   POST /api/letpot/set   body { entity_id, value }
//     switch.* -> switch.turn_on|turn_off   (value truthy => on)
//     number.* -> number.set_value          { value: <number> }
//     select.* -> select.select_option       { option: <string> }
//     time.*   -> time.set_value             { time: "HH:MM[:SS]" }

module.exports = function (app, callHA) {
  // allowlist: only LetPot's controllable domains + entity prefix (blocks arbitrary HA control)
  const ALLOW = /^(switch|number|select|time)\.(lph_|letpot_)/;
  const truthy = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

  app.post('/api/letpot/set', async (req, res) => {
    try {
      const b = req.body || {};
      const entity_id = String(b.entity_id || '').trim();
      if (!ALLOW.test(entity_id)) return res.status(400).json({ error: 'entity_id not a controllable LetPot entity' });
      const domain = entity_id.split('.')[0];
      const value = b.value;

      if (domain === 'switch') {
        const service = truthy(value) ? 'turn_on' : 'turn_off';
        await callHA('switch', service, { entity_id });
        return res.json({ ok: true, entity_id, service: `switch.${service}` });
      }
      if (domain === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) return res.status(400).json({ error: 'value must be a number' });
        await callHA('number', 'set_value', { entity_id, value: n });
        return res.json({ ok: true, entity_id, value: n });
      }
      if (domain === 'select') {
        const option = String(value == null ? '' : value);
        if (!option) return res.status(400).json({ error: 'value (option) required' });
        await callHA('select', 'select_option', { entity_id, option });
        return res.json({ ok: true, entity_id, option });
      }
      if (domain === 'time') {
        const time = String(value == null ? '' : value);
        if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return res.status(400).json({ error: 'value must be HH:MM[:SS]' });
        await callHA('time', 'set_value', { entity_id, time });
        return res.json({ ok: true, entity_id, time });
      }
      return res.status(400).json({ error: 'unsupported domain' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
