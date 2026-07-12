// Kazir 15 — read + name endpoints for the KZ15 building-network monitor page.
//
// Own module (wired from server.js via one require line) so server.js stays
// clear of the architecture-guard hook. Reads kazir15_hosts (filled by the
// LXC-104 `kazir15-ingest` daemon) + esp_boards.last_status (board eth/host
// summary, written by the rule engine), and lets the user name devices by MAC
// (kazir15_names) — same pattern as naming a device on Project Network. KZ15
// data is deliberately separate from the home net_devices/devices inventory.

module.exports = (app, db) => {
  // Who's connected on KZ15 — host list + any user-set name (joined by MAC).
  app.get('/api/kazir15/hosts', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT h.ip, h.mac, h.up, h.rtt_ms, h.subnet,
               h.first_seen, h.last_seen, h.last_scan_at, n.name
        FROM kazir15_hosts h
        LEFT JOIN kazir15_names n ON lower(n.mac) = lower(h.mac)
        ORDER BY h.up DESC, h.ip::inet
      `);
      res.json(r.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Set / clear a device name (keyed by MAC — survives IP changes + pruning).
  app.post('/api/kazir15/name', async (req, res) => {
    try {
      const mac = (req.body && req.body.mac || '').trim().toLowerCase();
      const name = (req.body && req.body.name || '').trim();
      if (!mac) return res.status(400).json({ error: 'mac required' });
      if (!name) {
        await db.query('DELETE FROM kazir15_names WHERE lower(mac) = $1', [mac]);
      } else {
        await db.query(
          `INSERT INTO kazir15_names (mac, name, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (mac) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
          [mac, name]
        );
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Board summary — eth link/ip/gateway + host counts + last scan.
  app.get('/api/kazir15/status', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT last_status, last_seen, sketch_version, enabled
        FROM esp_boards WHERE id = 'kazir_15'
      `);
      res.json(r.rows[0] || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
