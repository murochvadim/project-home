// privacy-places.js — Privacy > Places tab: a flat 2D Leaflet world map of every
// row in visited_places, plus a manual "Add place" form (browser geocodes the
// place via Nominatim/OSM, then POSTs lat/lon to /api/places). Reuses the global
// _esc() from privacy.js. Backend: routes-places.js.

let _pvMap = null;          // Leaflet map (inited once, when the tab is first shown)
let _pvMapLayer = null;     // layer group holding the saved-place markers
let _pvPlaces = [];         // last loaded rows
let _pvPendingMarker = null; // the "where to add" pin (from Find pick or a map click)
let _pvPendingLatLng = null; // {lat, lon} of the pending pin, or null
let _pvPendingLabel = '';    // resolved address of the pending pin (for the address field)
let _pvpFindResults = [];    // last 🔍 Find candidate list

// Marker color by source so Google/manual/Booking are visually distinct.
function _pvpColor(src) {
  return ({
    manual: '#2563eb',
    google_review: '#16a34a',
    google_reservation: '#a855f7',
    booking: '#e67e22',
  })[src] || '#6b7280';
}
function _pvpStatus(msg, color) {
  const st = document.getElementById('pvp-status');
  if (st) { st.style.color = color || '#888'; st.textContent = msg; }
}
function _pvpVal(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

// Called by privacy.js showTab('places'). Init the map once (Leaflet needs the
// container visible to size), then (re)load the places.
function pvPlacesOnShow() {
  if (typeof L === 'undefined') { setTimeout(pvPlacesOnShow, 150); return; }   // wait for deferred leaflet.js
  if (!_pvMap) {
    _pvMap = L.map('pvp-map', { worldCopyJump: true }).setView([30, 10], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(_pvMap);
    _pvMapLayer = L.layerGroup().addTo(_pvMap);
    _pvMap.on('click', e => pvPlaceSetPending(e.latlng.lat, e.latlng.lng, ''));   // click map = drop a manual pin
    setTimeout(() => { if (_pvMap) _pvMap.invalidateSize(); }, 80);   // ensure correct size after first paint
    pvPlacesLoad();
  } else {
    setTimeout(() => _pvMap.invalidateSize(), 60);   // fix sizing after the tab becomes visible
  }
}

async function pvPlacesLoad() {
  try {
    _pvPlaces = await (await fetch('/api/places')).json();
  } catch (e) { _pvPlaces = []; }
  pvPlacesRender();
}

function pvPlacesRender() {
  const cnt = document.getElementById('pvp-count');
  if (cnt) cnt.textContent = '(' + _pvPlaces.length + ')';
  // markers
  if (_pvMapLayer) {
    _pvMapLayer.clearLayers();
    const pts = [];
    _pvPlaces.forEach(p => {
      const lat = parseFloat(p.lat), lon = parseFloat(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      pts.push([lat, lon]);
      const when = p.visited_at ? new Date(p.visited_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
      const loc = [p.city, p.country].filter(Boolean).join(', ');
      const popup = `<div style="font-size:0.85rem; line-height:1.35;">
        <b>${_esc(p.place_name)}</b><br>
        ${loc ? _esc(loc) + '<br>' : ''}
        ${when ? '📅 ' + _esc(when) + '<br>' : ''}
        ${p.notes ? '<span style="color:#555;">' + _esc(p.notes) + '</span><br>' : ''}
        <span style="font-size:0.72rem; color:#999;">${_esc(p.source)}${p.kind ? ' · ' + _esc(p.kind) : ''}</span><br>
        <button onclick="pvPlaceDelete(${p.id})" style="margin-top:5px; font-size:0.72rem; color:#c0392b; background:none; border:1px solid #e0c0c0; border-radius:4px; padding:2px 8px; cursor:pointer;">🗑 Delete</button>
      </div>`;
      L.circleMarker([lat, lon], {
        radius: 7, color: '#fff', weight: 1.5, fillColor: _pvpColor(p.source), fillOpacity: 0.9,
      }).bindPopup(popup).addTo(_pvMapLayer);
    });
    if (pts.length) { try { _pvMap.fitBounds(pts, { padding: [40, 40], maxZoom: 6 }); } catch (e) {} }
  }
  // list
  const host = document.getElementById('pvp-list');
  if (host) {
    if (!_pvPlaces.length) { host.innerHTML = '<div style="color:#aaa;">No places yet — add one on the left.</div>'; return; }
    host.innerHTML = _pvPlaces.map(p => {
      const when = p.visited_at ? new Date(p.visited_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      const loc = [p.city, p.country].filter(Boolean).join(', ');
      return `<div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid #f0f0f0;">
        <span style="width:10px; height:10px; border-radius:50%; background:${_pvpColor(p.source)}; flex-shrink:0;"></span>
        <span style="flex:1; min-width:0;"><b>${_esc(p.place_name)}</b>${loc ? ' <span style="color:#888;">— ' + _esc(loc) + '</span>' : ''}</span>
        <span style="color:#888; font-size:0.8rem; white-space:nowrap;">${_esc(when)}</span>
        <button class="btn btn-secondary btn-sm" onclick="pvPlaceEdit(${p.id})">Edit</button>
        <button class="btn btn-secondary btn-sm" style="color:#c0392b;" onclick="pvPlaceDelete(${p.id})">Del</button>
      </div>`;
    }).join('');
  }
}

// Geocode via Nominatim (OSM). Returns up to `limit` matches: [{lat, lon, display_name}].
async function pvPlaceGeocodeMulti(q, limit) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=' + (limit || 5) + '&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    if (!Array.isArray(j)) return [];
    return j.map(x => ({ lat: parseFloat(x.lat), lon: parseFloat(x.lon), display_name: x.display_name }));
  } catch (e) { return []; }
}

// Place / move the pending "where to add" pin (orange) and remember it. Called by
// 🔍 Find (a picked candidate) AND by clicking anywhere on the map (manual).
function pvPlaceSetPending(lat, lon, label) {
  _pvPendingLatLng = { lat, lon };
  _pvPendingLabel = label || '';
  if (!_pvMap) return;
  if (_pvPendingMarker) { _pvPendingMarker.setLatLng([lat, lon]); }
  else {
    _pvPendingMarker = L.circleMarker([lat, lon], { radius: 10, color: '#111', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.95 })
      .addTo(_pvMap).bindTooltip('pin to add — fill the form, then ➕ Add');
  }
  _pvMap.panTo([lat, lon]);
  _pvpStatus(label ? ('📍 Pinned: ' + label) : '📍 Pin dropped on the map — fill the form, then ➕ Add.', '#b45309');
}
function pvPlaceClearPending() {
  _pvPendingLatLng = null; _pvPendingLabel = '';
  if (_pvPendingMarker && _pvMap) _pvMap.removeLayer(_pvPendingMarker);
  _pvPendingMarker = null;
  const c = document.getElementById('pvp-candidates'); if (c) c.innerHTML = '';
}

// 🔍 Find — geocode the form query and list candidates to pick from.
async function pvPlaceFind() {
  const name = _pvpVal('pvp-name'), city = _pvpVal('pvp-city'), country = _pvpVal('pvp-country');
  const query = [name, city, country].filter(Boolean).join(', ');
  const cand = document.getElementById('pvp-candidates');
  if (!query) { _pvpStatus('Type a place name (and ideally city + country).', '#c0392b'); return; }
  _pvpStatus('Searching “' + query + '”…', '#555');
  if (cand) cand.innerHTML = '';
  let results = await pvPlaceGeocodeMulti(query, 5);
  if (!results.length && (city || country)) results = await pvPlaceGeocodeMulti([city, country].filter(Boolean).join(', '), 5);
  if (!results.length) { _pvpStatus('No match — check spelling, or just click the map to drop a pin manually.', '#c0392b'); return; }
  _pvpFindResults = results;
  if (cand) {
    cand.innerHTML = results.map((g, i) =>
      `<button class="btn btn-secondary btn-sm" style="text-align:left; font-size:0.75rem; line-height:1.25; white-space:normal; height:auto; padding:4px 7px;" onclick="pvPlacePickCandidate(${i})">${_esc(g.display_name)}</button>`
    ).join('');
  }
  pvPlaceSetPending(results[0].lat, results[0].lon, results[0].display_name);   // auto-pin the top match
  _pvpStatus('Found ' + results.length + ' match(es). Top one pinned — pick another below if wrong, then ➕ Add.', '#555');
}
function pvPlacePickCandidate(i) {
  const g = _pvpFindResults[i]; if (g) pvPlaceSetPending(g.lat, g.lon, g.display_name);
}

// ➕ Add — save the pending pin (from Find OR a map click) + the form fields. If
// there's no pending pin, try a quick one-shot geocode as a convenience.
async function pvPlaceAdd() {
  const name = _pvpVal('pvp-name'), city = _pvpVal('pvp-city'), country = _pvpVal('pvp-country');
  const date = _pvpVal('pvp-date'), kind = _pvpVal('pvp-kind'), notes = _pvpVal('pvp-notes');
  if (!name) { _pvpStatus('Enter a place name.', '#c0392b'); return; }
  let latlng = _pvPendingLatLng, label = _pvPendingLabel;
  if (!latlng) {
    const query = [name, city, country].filter(Boolean).join(', ');
    _pvpStatus('Locating “' + query + '”…', '#555');
    let results = await pvPlaceGeocodeMulti(query, 1);
    if (!results.length && (city || country)) results = await pvPlaceGeocodeMulti([city, country].filter(Boolean).join(', '), 1);
    if (!results.length) { _pvpStatus('Locate it first: click 🔍 Find (then pick a match) or click the map to drop a pin.', '#c0392b'); return; }
    latlng = { lat: results[0].lat, lon: results[0].lon }; label = results[0].display_name;
  }
  const visited_at = date ? new Date(date + 'T12:00:00').toISOString() : null;
  try {
    const r = await fetch('/api/places', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_name: name, city, country, lat: latlng.lat, lon: latlng.lon, visited_at, kind, notes, address: label || null }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'save failed');
    _pvpStatus('✓ Added “' + name + '”', '#2e7d32');
    ['pvp-name', 'pvp-city', 'pvp-country', 'pvp-date', 'pvp-notes'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    pvPlaceClearPending();
    await pvPlacesLoad();
    if (_pvMap) _pvMap.setView([latlng.lat, latlng.lon], 6);
  } catch (e) { _pvpStatus('Save failed: ' + e.message, '#c0392b'); }
}

// ISO timestamp -> 'YYYY-MM-DD' (local components) for the date input.
function _pvpIsoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Edit a list row in a modal (PATCH /api/places/:id). Location is not edited here
// (move = delete + re-add); name/city/country/date/kind/notes are.
function pvPlaceEdit(id) {
  const p = _pvPlaces.find(x => x.id === id);
  if (!p) return;
  document.getElementById('pvp-edit-id').value = p.id;
  document.getElementById('pvp-edit-name').value = p.place_name || '';
  document.getElementById('pvp-edit-city').value = p.city || '';
  document.getElementById('pvp-edit-country').value = p.country || '';
  document.getElementById('pvp-edit-date').value = _pvpIsoToDateInput(p.visited_at);
  document.getElementById('pvp-edit-kind').value = p.kind || 'visit';
  document.getElementById('pvp-edit-notes').value = p.notes || '';
  document.getElementById('pvp-edit-status').textContent = '';
  document.getElementById('pvp-edit-modal').style.display = 'flex';
}
function pvPlaceEditCancel() { document.getElementById('pvp-edit-modal').style.display = 'none'; }
async function pvPlaceEditSave() {
  const id = document.getElementById('pvp-edit-id').value;
  const st = document.getElementById('pvp-edit-status');
  const name = _pvpVal('pvp-edit-name');
  if (!name) { if (st) st.textContent = 'Place name is required.'; return; }
  const date = _pvpVal('pvp-edit-date');
  const body = {
    place_name: name,
    city: _pvpVal('pvp-edit-city'),
    country: _pvpVal('pvp-edit-country'),
    kind: _pvpVal('pvp-edit-kind'),
    notes: _pvpVal('pvp-edit-notes'),
    visited_at: date ? new Date(date + 'T12:00:00').toISOString() : null,
  };
  try {
    const r = await fetch('/api/places/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error || 'save failed');
    pvPlaceEditCancel();
    await pvPlacesLoad();
  } catch (e) { if (st) st.textContent = 'Save failed: ' + e.message; }
}

async function pvPlaceDelete(id) {
  const p = _pvPlaces.find(x => x.id === id);
  if (!confirm('Delete “' + (p ? p.place_name : 'this place') + '” from the map?')) return;
  try {
    const r = await fetch('/api/places/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error('delete failed');
    await pvPlacesLoad();
  } catch (e) { alert('Delete failed: ' + e.message); }
}
