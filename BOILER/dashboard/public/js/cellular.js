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
let _cellHomeMarker = null;
let _cellCircle = null;
let _cellData = null;            // last /nearby payload
let _cellSort = { key: 'dist_m', dir: 1 };   // 1 = asc, -1 = desc
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

function cellularOnTabShow() {
  if (!_cellMap) _cellInitMap();
  // The map div was display:none until this tab opened — Leaflet needs a nudge
  // to recompute its size, otherwise tiles render in the wrong place.
  if (_cellMap) setTimeout(() => _cellMap.invalidateSize(), 50);
  _cellLoad();
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
    _cellRenderMap();
    _cellRenderList();
    _cellRenderSummary();
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
    m.bindTooltip(
      `<b>${_cellCarrierShort(a.carrier)}</b><br>` +
      `${a.address || ''}${a.city ? ', ' + a.city : ''}<br>` +
      `${a.technology || ''}<br>` +
      `Radiation: <b style="color:${_cellRadColor(pct)}">` +
        `${pct == null ? '—' : pct + '%'}</b> of threshold<br>` +
      `Distance: ${dist}`,
      { direction: 'top', opacity: 0.95 }
    );
    m.addTo(_cellLayer);
    _cellMarkerById[a.id] = m;
  });
}

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
    return `<tr style="cursor:pointer;" onclick="_cellFocus(${a.id})">
      <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;
        background:${_cellCarrierColor(a.carrier)};margin-right:5px;"></span>
        ${_cellCarrierShort(a.carrier)}</td>
      <td>${a.address || ''}${a.city ? ', ' + a.city : ''}</td>
      <td>${a.technology || '—'}</td>
      <td style="text-align:center;font-weight:600;color:${_cellRadColor(pct)};">
        ${pct == null ? '—' : pct + '%'}</td>
      <td style="text-align:right;">${a.dist_m == null ? '—' : a.dist_m + ' m'}</td>
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
  _cellMap.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
}

// Fit the whole radius circle (all antennas) back into view.
function cellZoomAll() {
  if (!_cellMap) return;
  if (_cellCircle) _cellMap.fitBounds(_cellCircle.getBounds(), { padding: [20, 20] });
}
