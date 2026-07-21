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
      // Full device picture: every NAMED device (online or offline — one row per
      // MAC, its newest host row) PLUS any currently-connected UNNAMED host. So
      // offline named devices (cameras/APs that stopped answering) still show,
      // with their last-known IP + last_seen, marked offline.
      const r = await db.query(`
        WITH named AS (
          SELECT DISTINCT ON (lower(n.mac))
                 n.mac, n.name, h.ip, h.last_seen, h.rtt_ms,
                 (h.last_seen IS NOT NULL AND h.last_seen > now() - interval '15 min') AS online
          FROM kazir15_names n
          LEFT JOIN kazir15_hosts h ON lower(h.mac) = lower(n.mac)
          ORDER BY lower(n.mac), h.last_seen DESC NULLS LAST
        ),
        unnamed AS (
          SELECT h.mac, NULL::text AS name, h.ip, h.last_seen, h.rtt_ms, true AS online
          FROM kazir15_hosts h
          WHERE h.last_seen > now() - interval '15 min'
            AND NOT EXISTS (SELECT 1 FROM kazir15_names n WHERE lower(n.mac) = lower(h.mac))
        )
        SELECT * FROM named
        UNION ALL
        SELECT * FROM unnamed
        ORDER BY online DESC, name NULLS LAST, ip
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

  // Category on/off counts (Cameras / Access Points / Deco). Counted against the
  // PERSISTENT named inventory (kazir15_names survives pruning), so "off" = a
  // named device that isn't currently connected. Classified by the name each
  // device was given (Cam / UniFi AP / Deco). "online" = seen within 15 min
  // (same grace as the host list).
  app.get('/api/kazir15/summary', async (req, res) => {
    try {
      // GROUP BY mac so a device that appears on >1 IP (e.g. two DHCP leases) is
      // counted ONCE; online = any of its host rows seen within 15 min.
      const r = await db.query(`
        SELECT n.name,
               bool_or(h.last_seen IS NOT NULL AND h.last_seen > now() - interval '15 minutes') AS online
        FROM kazir15_names n
        LEFT JOIN kazir15_hosts h ON lower(h.mac) = lower(n.mac)
        GROUP BY n.mac, n.name
      `);
      const cat = { cameras: { on: 0, off: 0 }, aps: { on: 0, off: 0 }, deco: { on: 0, off: 0 } };
      for (const row of r.rows) {
        const nm = row.name || '';
        let b = null;
        if (/deco/i.test(nm))               b = 'deco';
        else if (/\bap\b|unifi/i.test(nm))   b = 'aps';
        else if (/cam/i.test(nm))            b = 'cameras';   // NVR/Router/other excluded on purpose
        if (!b) continue;
        cat[b][row.online ? 'on' : 'off']++;
      }
      res.json(cat);
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
