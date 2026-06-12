// Cellular antennas — read-only API for the Project Network "Cellular" tab.
//
// Kept in its own module (wired from server.js via a single require line) so
// server.js stays free of new route handlers — the repo's architecture-guard
// hook blocks adding `app.<method>(` directly to server.js.
//
// The data is populated entirely by the LXC-104 ingest
// (CELLULAR_NETWORK/ingest_antennas.py, weekly timer) into `cellular_antennas`
// on LXC 102 — only the ~76 antennas within 2 km of home, never the national
// set. This module just SELECTs them, computes each one's distance from the
// home center, and returns them sorted nearest-first. UI-only: no ingest, no
// external calls, no business logic.
//
// Endpoints:
//   GET /api/cellular/nearby         { center, radius_m, count, generated_at, antennas[] }
//   GET /api/cellular/phone-signal   live phone cellular signal (uplink-TX proxy)

const RADIUS_M = 2000; // matches the ingest's filter radius

const HA_URL = 'http://192.168.1.110:8123';
// Companion-app sensor prefixes for the tracked phone (Galaxy Z Fold5).
// Update here if the phone (and thus its HA entity prefix) changes.
const PHONE_PREFIXES = ['sm_f946b', 'fold5'];

// LTE RSRP / signal-strength (dBm) → quality + the IMPLIED uplink behaviour.
// The honest point: a WEAK downlink makes the phone transmit HARDER (uplink TX
// up), and the phone is centimetres from you — so weak signal = MORE personal
// exposure. Strong signal = the phone throttles down = less exposure.
function _signalQuality(dbm) {
  if (dbm == null || isNaN(dbm)) return null;
  if (dbm >= -80) return { label: 'Excellent', tx: 'low', exposure: 'low', color: '#2e7d32' };
  if (dbm >= -90) return { label: 'Good', tx: 'low', exposure: 'low', color: '#2e7d32' };
  if (dbm >= -100) return { label: 'Fair', tx: 'medium', exposure: 'medium', color: '#e67e22' };
  if (dbm >= -110) return { label: 'Poor', tx: 'high', exposure: 'high', color: '#c0392b' };
  return { label: 'Very poor', tx: 'very high', exposure: 'high', color: '#c0392b' };
}

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

module.exports = function (app, db, getHaToken) {
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

  // Live phone cellular signal — the most honest proxy for PERSONAL RF exposure
  // (your phone's uplink TX, which rises when the tower signal is weak). Reads
  // the HA Companion-app sensors for the tracked phone. Auto-discovers the
  // cellular-signal entity by pattern so it works regardless of the exact name
  // and lights up the moment the sensor is enabled in the companion app.
  app.get('/api/cellular/phone-signal', async (_req, res) => {
    try {
      const r = await fetch(`${HA_URL}/api/states`, {
        headers: { Authorization: `Bearer ${getHaToken()}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return res.status(502).json({ error: 'HA ' + r.status });
      const all = await r.json();
      const mine = all.filter((e) =>
        PHONE_PREFIXES.some((p) => e.entity_id.toLowerCase().includes(p)));
      const isWifi = (id) => id.includes('wi_fi') || id.includes('wifi');

      // Cellular signal: a sensor.*_signal_strength or *_cellular* that ISN'T wifi.
      const cellEnt = mine.find((e) =>
        e.entity_id.startsWith('sensor.') &&
        /signal_strength|cellular/.test(e.entity_id) && !isWifi(e.entity_id));
      const netEnt = mine.find((e) =>
        e.entity_id.startsWith('sensor.') && /network_type|phone_state/.test(e.entity_id));
      const wifiSig = mine.find((e) => e.entity_id.includes('wi_fi_signal'));
      const wifiConn = mine.find((e) => e.entity_id.includes('wi_fi_connection'));
      const battery = mine.find((e) => e.entity_id.endsWith('_battery_level'));

      let dbm = cellEnt ? Number(cellEnt.state) : null;
      // Some firmwares report the dBm in an attribute rather than the state.
      if (cellEnt && (dbm == null || isNaN(dbm))) {
        const a = cellEnt.attributes || {};
        const cand = a.dbm ?? a.signal_strength ?? a.rsrp ?? null;
        dbm = cand == null ? null : Number(cand);
      }
      const haveDbm = dbm != null && !isNaN(dbm);

      res.json({
        found: !!cellEnt,
        cellular_dbm: haveDbm ? dbm : null,
        cellular_raw: cellEnt ? cellEnt.state : null,
        cellular_entity: cellEnt ? cellEnt.entity_id : null,
        cellular_unit: cellEnt?.attributes?.unit_of_measurement || null,
        network_type:
          (cellEnt?.attributes?.network_type) ||
          (netEnt && /[a-zA-Z]/.test(netEnt.state) ? netEnt.state : null),
        quality: _signalQuality(haveDbm ? dbm : null),
        wifi_dbm: wifiSig ? Number(wifiSig.state) : null,
        wifi_connection: wifiConn ? wifiConn.state : null,
        battery: battery ? Number(battery.state) : null,
        hint: cellEnt ? null :
          'Cellular signal sensor not enabled yet — turn it on in the HA Companion ' +
          'app on the phone: Settings → Companion app → Manage sensors → ' +
          '“Cellular signal strength” → enable.',
      });
    } catch (e) {
      console.error('[cellular] /phone-signal failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
};
