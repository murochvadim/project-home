// Project Network → Cellular tab.
//
// Reuses the same Leaflet + OpenStreetMap free-tile approach as the Geolocation
// tab (project-general.html): a home pin + 2 km radius circle + one
// carrier-colored pin per cellular antenna within 2 km of home, with a hover
// tooltip + a sortable list below the map. Data comes from
// GET /api/cellular/nearby (read-only; the actual ingest runs on LXC 104).
//
// Entry point cellularOnTabShow() is called by network.js's showTab().

let _cellMap = null;
let _cellLayer = null;           // LayerGroup holding all antenna pins
let _cellHeatLayer = null;       // leaflet.heat layer (estimated influence)
let _cellHomeMarker = null;
let _cellCircle = null;
let _cellData = null;            // last /nearby payload
let _cellSort = { key: '_inflShare', dir: -1 };   // 1 = asc, -1 = desc (default: strongest influence first)
let _cellMarkerById = {};        // id -> leaflet marker (for row → map focus)
let _cellLoaded = false;

// Carrier → pin color (the 3 carriers present in the registry near home).
function _cellCarrierColor(carrier) {
  const c = carrier || '';
  if (c.indexOf('סלקום') !== -1) return '#8e44ad';     // Cellcom — purple
  if (c.indexOf('פלאפון') !== -1) return '#2980b9';     // Pelephone — blue
  if (c.indexOf('PHI') !== -1) return '#e74c3c';        // PHI (HOT+Partner) — red
  return '#7f8c8d';                                     // unknown — grey
}

// Short Latin label for the carrier (the registry stores Hebrew names).
function _cellCarrierShort(carrier) {
  const c = carrier || '';
  if (c.indexOf('סלקום') !== -1) return 'Cellcom';
  if (c.indexOf('פלאפון') !== -1) return 'Pelephone';
  if (c.indexOf('PHI') !== -1) return 'PHI (HOT/Partner)';
  return c || '—';
}

// Radiation % of the health threshold → color (green/amber/red).
function _cellRadColor(pct) {
  if (pct == null) return '#999';
  if (pct < 5) return '#2e7d32';
  if (pct < 20) return '#e67e22';
  return '#c0392b';
}

// ── Estimated influence at home ──────────────────────────────────────────────
// THIS IS AN ESTIMATE, NOT A MEASUREMENT. The registry's radiation number is
// measured at each tower's own worst-case point, not at our apartment. We model
// the *relative* contribution each tower makes at home with the inverse-square
// law: RF power density falls off ~1/distance². Source strength = the tower's
// theoretical max power density (µW/cm²); influence ∝ strength / distance².
// Results are normalised so they only mean something relative to each other —
// they CANNOT be read as an absolute exposure at home. A real reading needs an
// RF meter or a full propagation model (EIRP, azimuth, tilt, buildings).
function _cellComputeInfluence() {
  if (!_cellData) return;
  const A = _cellData.antennas || [];
  let total = 0, maxRaw = 0;
  A.forEach((a) => {
    const strength = (a.max_theoretical_uw_per_cm2 > 0)
      ? a.max_theoretical_uw_per_cm2
      : (a.max_measured_pct_of_threshold > 0 ? a.max_measured_pct_of_threshold : 0);
    const d = a.dist_m && a.dist_m > 1 ? a.dist_m : 1;
    a._inflRaw = strength > 0 ? strength / (d * d) : 0;
    total += a._inflRaw;
    if (a._inflRaw > maxRaw) maxRaw = a._inflRaw;
  });
  A.forEach((a) => {
    a._inflShare = total > 0 ? (a._inflRaw / total) * 100 : 0;   // % of local RF
    a._inflNorm = maxRaw > 0 ? a._inflRaw / maxRaw : 0;           // 0..1 vs strongest
  });
  _cellData._inflTotal = total;
  _cellData._inflMaxRaw = maxRaw;
}

// Influence share % → color ramp (low grey-blue → high red).
function _cellInflColor(share) {
  if (share == null) return '#999';
  if (share < 5) return '#7f8c8d';
  if (share < 15) return '#e67e22';
  return '#c0392b';
}

let _cellPhoneTimer = null;

function cellularOnTabShow() {
  if (!_cellMap) _cellInitMap();
  // The map div was display:none until this tab opened — Leaflet needs a nudge
  // to recompute its size, otherwise tiles render in the wrong place.
  if (_cellMap) setTimeout(() => _cellMap.invalidateSize(), 50);
  _cellLoad();
  _cellLoadPhone();
  if (!_cellPhoneTimer) _cellPhoneTimer = setInterval(_cellLoadPhone, 20_000);
}

// Live phone cellular signal — the honest personal-exposure proxy.
async function _cellLoadPhone() {
  try {
    const r = await fetch('/api/cellular/phone-signal');
    _cellRenderPhone(await r.json());
  } catch (e) {
    const el = document.getElementById('cell-phone');
    if (el) el.innerHTML = `<span style="color:#888;">phone signal unavailable: ${e.message}</span>`;
  }
}

function _cellRenderPhone(d) {
  const el = document.getElementById('cell-phone');
  if (!el) return;
  if (!d || !d.found) {
    el.innerHTML =
      `<div style="font-size:0.82rem;color:#555;">` +
      `<b>📱 Your phone (uplink) — the RF closest to you</b><br>` +
      `<span style="color:#a60;">Cellular signal sensor not enabled yet.</span> ` +
      `${d && d.hint ? d.hint : ''}` +
      (d && d.wifi_dbm != null
        ? `<br><span style="color:#888;">Wi-Fi: ${d.wifi_dbm} dBm` +
          `${d.wifi_connection ? ' (' + d.wifi_connection + ')' : ''} — ` +
          `Wi-Fi calling, if on, offloads the cellular uplink.</span>`
        : '') +
      `</div>`;
    return;
  }
  const q = d.quality || {};
  const dbm = d.cellular_dbm;
  el.innerHTML =
    `<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:0.85rem;">` +
      `<div><b>📱 Your phone (uplink) — the RF closest to you</b></div>` +
      `<div>Signal: <b style="color:${q.color || '#333'}">${dbm} dBm` +
        `${d.cellular_unit && d.cellular_unit !== 'dBm' ? ' ' + d.cellular_unit : ''}</b> ` +
        `<span style="color:${q.color || '#333'}">(${q.label || '—'})</span>` +
        `${d.network_type ? ' · ' + d.network_type : ''}</div>` +
      `<div>Phone transmit effort: <b style="color:${q.color || '#333'}">${q.tx || '—'}</b></div>` +
      `<div>Est. personal exposure: <b style="color:${q.color || '#333'}">${q.exposure || '—'}</b></div>` +
      (d.wifi_dbm != null ? `<div style="color:#888;">Wi-Fi ${d.wifi_dbm} dBm` +
        `${d.wifi_connection ? ' (' + d.wifi_connection + ')' : ''}</div>` : '') +
    `</div>` +
    `<div style="font-size:0.76rem;color:#888;margin-top:4px;">` +
    `Weaker tower signal → phone transmits harder → more exposure from the device in your hand. ` +
    `Strong signal lets it throttle down. This is usually the dominant RF source at home, ` +
    `more than the towers themselves.</div>`;
}

function _cellInitMap() {
  if (!window.L) { setTimeout(_cellInitMap, 200); return; }
  const el = document.getElementById('cell-map');
  if (!el) return;
  // Restore last view from localStorage; fall back to the apartment default
  // (same default coords the Geolocation tab uses).
  let initLat = 32.1593, initLon = 34.8932, initZoom = 14;
  try {
    const saved = JSON.parse(localStorage.getItem('cell.mapView') || 'null');
    if (saved && typeof saved.lat === 'number') {
      initLat = saved.lat; initLon = saved.lon; initZoom = saved.zoom;
    }
  } catch (e) {}
  _cellMap = L.map('cell-map').setView([initLat, initLon], initZoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  }).addTo(_cellMap);
  _cellLayer = L.layerGroup().addTo(_cellMap);
  const saveView = () => {
    try {
      const c = _cellMap.getCenter();
      localStorage.setItem('cell.mapView', JSON.stringify({
        lat: c.lat, lon: c.lng, zoom: _cellMap.getZoom(),
      }));
    } catch (e) {}
  };
  _cellMap.on('moveend', saveView);
  _cellMap.on('zoomend', saveView);
}

async function _cellLoad() {
  try {
    const r = await fetch('/api/cellular/nearby');
    const d = await r.json();
    _cellData = d;
    _cellComputeInfluence();
    _cellRenderMap();
    _cellRenderHeat();
    _cellRenderList();
    _cellRenderSummary();
    _cellRenderInfluence();
  } catch (e) {
    const s = document.getElementById('cell-summary');
    if (s) s.textContent = 'Failed to load cellular data: ' + e.message;
  }
  // Fit to the 2 km circle once, the first time we have a center.
  if (!_cellLoaded && _cellData && _cellData.center && _cellCircle) {
    _cellMap.fitBounds(_cellCircle.getBounds(), { padding: [20, 20] });
    _cellLoaded = true;
  }
}

function _cellRenderMap() {
  if (!_cellMap || !_cellData) return;
  _cellLayer.clearLayers();
  _cellMarkerById = {};

  const center = _cellData.center;
  if (center) {
    // Home pin + 2 km radius circle (same intent as the Geolocation tab).
    _cellHomeMarker = L.marker([center.lat, center.lon])
      .bindTooltip('Apartment', { permanent: false })
      .addTo(_cellLayer);
    _cellCircle = L.circle([center.lat, center.lon], {
      radius: _cellData.radius_m, color: '#1565c0', weight: 1,
      fillColor: '#1565c0', fillOpacity: 0.05,
    }).addTo(_cellLayer);
  }

  (_cellData.antennas || []).forEach((a) => {
    const color = _cellCarrierColor(a.carrier);
    const m = L.circleMarker([a.lat, a.lon], {
      radius: 6, color: '#fff', weight: 1.5,
      fillColor: color, fillOpacity: 0.9,
    });
    const pct = a.max_measured_pct_of_threshold;
    const dist = a.dist_m == null ? '—' : a.dist_m + ' m';
    const share = a._inflShare;
    m.bindTooltip(
      `<b>${_cellCarrierShort(a.carrier)}</b><br>` +
      `${a.address || ''}${a.city ? ', ' + a.city : ''}<br>` +
      `${a.technology || ''}<br>` +
      `Radiation: <b style="color:${_cellRadColor(pct)}">` +
        `${pct == null ? '—' : pct + '%'}</b> of threshold<br>` +
      `Distance: ${dist}<br>` +
      `Est. influence at home: <b style="color:${_cellInflColor(share)}">` +
        `${share == null ? '—' : share.toFixed(1) + '%'}</b>`,
      { direction: 'top', opacity: 0.95 }
    );
    m.addTo(_cellLayer);
    _cellMarkerById[a.id] = m;
  });
}

// Estimated-influence heatmap (leaflet.heat). Each tower contributes a heat
// point weighted by its normalised influence (strength / distance²), so near +
// strong towers glow hottest — you see which direction the strongest RF comes
// from. Toggled by the "Influence heatmap" checkbox; estimate only.
function _cellRenderHeat() {
  if (!_cellMap || !_cellData) return;
  const on = document.getElementById('cell-heat-toggle');
  const show = on ? on.checked : false;
  if (_cellHeatLayer) { _cellMap.removeLayer(_cellHeatLayer); _cellHeatLayer = null; }
  if (!show || typeof L.heatLayer !== 'function') return;
  const pts = (_cellData.antennas || [])
    .filter((a) => a._inflNorm > 0)
    // emphasise contrast: weight by sqrt so mid towers still register visually
    .map((a) => [a.lat, a.lon, Math.max(0.15, Math.sqrt(a._inflNorm))]);
  _cellHeatLayer = L.heatLayer(pts, {
    radius: 38, blur: 28, maxZoom: 17, minOpacity: 0.25,
    gradient: { 0.2: '#2c7fb8', 0.5: '#f0ad4e', 0.8: '#e8702a', 1.0: '#c0392b' },
  }).addTo(_cellMap);
}

// Checkbox handler (wired from the markup).
function cellToggleHeat() { _cellRenderHeat(); }

function _cellRenderSummary() {
  const s = document.getElementById('cell-summary');
  if (!s || !_cellData) return;
  const carriers = {};
  (_cellData.antennas || []).forEach((a) => {
    const k = _cellCarrierShort(a.carrier);
    carriers[k] = (carriers[k] || 0) + 1;
  });
  const parts = Object.keys(carriers).sort().map((k) => {
    // find a representative carrier value for the color
    const rep = (_cellData.antennas.find(
      (a) => _cellCarrierShort(a.carrier) === k) || {}).carrier;
    return `<span style="display:inline-flex;align-items:center;gap:4px;">` +
      `<span style="width:10px;height:10px;border-radius:50%;` +
      `background:${_cellCarrierColor(rep)};display:inline-block;"></span>` +
      `${k} (${carriers[k]})</span>`;
  });
  const gen = _cellData.generated_at
    ? new Date(_cellData.generated_at).toLocaleString('en-GB', { hour12: false })
    : '—';
  s.innerHTML =
    `<b>${_cellData.count}</b> antennas within ` +
    `${(_cellData.radius_m / 1000).toFixed(0)} km of home &nbsp;·&nbsp; ` +
    parts.join(' &nbsp; ') +
    ` &nbsp;·&nbsp; <span style="color:#888;">last ingest: ${gen}</span>`;
}

// Estimated-influence summary: which tower dominates at home + per-carrier
// share, with the mandatory "this is an estimate" caveat.
function _cellRenderInfluence() {
  const el = document.getElementById('cell-influence');
  if (!el || !_cellData) return;
  const A = (_cellData.antennas || []).filter((a) => a._inflShare > 0);
  if (!A.length) { el.innerHTML = ''; return; }
  const top = A.slice().sort((a, b) => b._inflShare - a._inflShare)[0];
  // Per-carrier share
  const byCarrier = {};
  A.forEach((a) => {
    const k = _cellCarrierShort(a.carrier);
    byCarrier[k] = (byCarrier[k] || 0) + a._inflShare;
  });
  const carrierStr = Object.keys(byCarrier)
    .sort((a, b) => byCarrier[b] - byCarrier[a])
    .map((k) => `${k} ${byCarrier[k].toFixed(0)}%`)
    .join(' · ');
  el.innerHTML =
    `<div style="font-size:0.82rem;line-height:1.5;">` +
    `<b>Estimated influence at home</b> (relative, inverse-square model): ` +
    `strongest is <b style="color:${_cellInflColor(top._inflShare)}">` +
    `${_cellCarrierShort(top.carrier)}</b> @ ${top.dist_m} m ` +
    `(${top._inflShare.toFixed(1)}% of the local RF). ` +
    `By carrier: ${carrierStr}.` +
    `<br><span style="color:#b00;">⚠ Estimate only — not a measurement.</span> ` +
    `<span style="color:#888;">The registry's radiation figures are measured at each tower's own ` +
    `worst-case point, not at your apartment. This ranks relative contributions using ` +
    `strength ÷ distance²; a true reading needs an RF meter or a full propagation model.</span>` +
    `</div>`;
}

function _cellSortBy(key) {
  if (_cellSort.key === key) _cellSort.dir *= -1;
  else { _cellSort.key = key; _cellSort.dir = 1; }
  _cellRenderList();
}

function _cellRenderList() {
  const tbody = document.getElementById('cell-list-body');
  if (!tbody || !_cellData) return;
  const rows = (_cellData.antennas || []).slice();
  const { key, dir } = _cellSort;
  rows.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'carrier') { va = _cellCarrierShort(a.carrier); vb = _cellCarrierShort(b.carrier); }
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });

  tbody.innerHTML = rows.map((a) => {
    const pct = a.max_measured_pct_of_threshold;
    const pdf = a.operating_pdf_url || a.construction_pdf_url;
    const insp = a.last_inspection_date
      ? new Date(a.last_inspection_date).toLocaleDateString('en-GB')
      : '—';
    const share = a._inflShare || 0;
    const barW = Math.round((a._inflNorm || 0) * 100);
    return `<tr style="cursor:pointer;" onclick="_cellFocus(${a.id})">
      <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;
        background:${_cellCarrierColor(a.carrier)};margin-right:5px;"></span>
        ${_cellCarrierShort(a.carrier)}</td>
      <td>${a.address || ''}${a.city ? ', ' + a.city : ''}</td>
      <td>${a.technology || '—'}</td>
      <td style="text-align:center;font-weight:600;color:${_cellRadColor(pct)};">
        ${pct == null ? '—' : pct + '%'}</td>
      <td style="text-align:right;">${a.dist_m == null ? '—' : a.dist_m + ' m'}</td>
      <td style="min-width:120px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;height:8px;background:#eee;border-radius:4px;overflow:hidden;">
            <div style="width:${barW}%;height:100%;background:${_cellInflColor(share)};"></div>
          </div>
          <span style="font-size:0.78rem;color:${_cellInflColor(share)};font-weight:600;min-width:34px;text-align:right;">${share.toFixed(1)}%</span>
        </div></td>
      <td style="text-align:center;">${insp}</td>
      <td style="text-align:center;">${pdf ? `<a href="${pdf}" target="_blank" onclick="event.stopPropagation()">📄</a>` : '—'}</td>
    </tr>`;
  }).join('');
}

// Row click → pan/zoom the map to that antenna and open its tooltip.
function _cellFocus(id) {
  const m = _cellMarkerById[id];
  if (!m || !_cellMap) return;
  _cellMap.setView(m.getLatLng(), Math.max(_cellMap.getZoom(), 16));
  m.openTooltip();
}

// Fit the map to the N nearest antennas (+ home), like the Geolocation tab's
// "fit to track" — antennas are already sorted nearest-first by the endpoint.
function cellZoomNearest(n) {
  if (!_cellMap || !_cellData) return;
  const near = (_cellData.antennas || []).slice(0, n);
  if (!near.length) return;
  const pts = near.map((a) => [a.lat, a.lon]);
  if (_cellData.center) pts.push([_cellData.center.lat, _cellData.center.lon]);
  const b = L.latLngBounds(pts);
  // Fit the nearest cluster, then one step tighter (between plain-fit and +2).
  let z = _cellMap.getBoundsZoom(b, false, [50, 50]);
  z = Math.min(z + 1, 19);
  _cellMap.setView(b.getCenter(), z);
}

// Fit the whole radius circle (all antennas) back into view.
function cellZoomAll() {
  if (!_cellMap) return;
  if (_cellCircle) _cellMap.fitBounds(_cellCircle.getBounds(), { padding: [20, 20] });
}
