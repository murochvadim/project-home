// Cellular antennas — read-only API for the Project Network "Cellular" tab.
//
// Kept in its own module (wired from server.js via a single require line) so
// server.js stays free of new route handlers — the repo's architecture-guard
// hook blocks adding `app.<method>(` directly to server.js.
//
// The data is populated entirely by the LXC-104 ingest
// (CELLULAR_NETWORK/ingest_antennas.py, weekly timer) into `cellular_antennas`
// on LXC 102 — only the ~134 antennas within 3 km of home, never the national
// set. This module just SELECTs them, computes each one's distance from the
// home center, and returns them sorted nearest-first. UI-only: no ingest, no
// external calls, no business logic.
//
// Endpoints:
//   GET /api/cellular/nearby   { center, radius_m, count, generated_at, antennas[] }

const RADIUS_M = 3000; // matches the ingest's filter radius

function _haversine(la1, lo1, la2, lo2) {
  const R = 6371000;
  const d1 = ((la2 - la1) * Math.PI) / 180;
  const d2 = ((lo2 - lo1) * Math.PI) / 180;
  const a =
    Math.sin(d1 / 2) ** 2 +
    Math.cos((la1 * Math.PI) / 180) *
      Math.cos((la2 * Math.PI) / 180) *
      Math.sin(d2 / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = function (app, db) {
  // Antennas within the ingest radius of home, nearest-first, plus the home
  // center (read from the same dashboard_settings.geolocation row the map uses
  // so the circle + pin line up exactly with the Geolocation tab).
  app.get('/api/cellular/nearby', async (_req, res) => {
    try {
      const geo = await db.query(
        "SELECT value FROM dashboard_settings WHERE key = 'geolocation'"
      );
      const center = (geo.rows[0]?.value || {}).center || {};
      const homeLat = Number(center.lat);
      const homeLon = Number(center.lon);

      const { rows } = await db.query(`
        SELECT id, carrier, city, address, lat, lon, site_type, technology,
               max_measured_pct_of_threshold, max_theoretical_uw_per_cm2,
               operating_permit_date, construction_permit_date,
               last_inspection_date, construction_pdf_url, operating_pdf_url,
               last_ingest
          FROM cellular_antennas
         WHERE lat IS NOT NULL AND lon IS NOT NULL
      `);

      const haveHome = Number.isFinite(homeLat) && Number.isFinite(homeLon);
      const antennas = rows.map((r) => ({
        ...r,
        // numeric coercion (pg returns NUMERIC as string)
        lat: Number(r.lat),
        lon: Number(r.lon),
        max_measured_pct_of_threshold:
          r.max_measured_pct_of_threshold == null
            ? null
            : Number(r.max_measured_pct_of_threshold),
        max_theoretical_uw_per_cm2:
          r.max_theoretical_uw_per_cm2 == null
            ? null
            : Number(r.max_theoretical_uw_per_cm2),
        dist_m: haveHome
          ? Math.round(_haversine(homeLat, homeLon, Number(r.lat), Number(r.lon)))
          : null,
      }));

      if (haveHome) antennas.sort((a, b) => a.dist_m - b.dist_m);

      res.json({
        center: haveHome ? { lat: homeLat, lon: homeLon } : null,
        radius_m: RADIUS_M,
        count: antennas.length,
        generated_at: rows[0]?.last_ingest || null,
        antennas,
      });
    } catch (e) {
      console.error('[cellular] /nearby failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
};
