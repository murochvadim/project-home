// ══════════════════════════════════════════════════════════════
// Medical — in-dashboard DICOM viewer for zipped imaging studies (MRI/CT).
//
// Fully client-side (no server/DB changes): fetch the zip → unzip in the
// browser (JSZip) → render slices with cornerstone-core + dicom-parser +
// cornerstone-wado-image-loader (the NoWebWorkers bundle: main-thread decode
// with codecs included, so no cross-origin web-worker / WASM-path hassle).
// All libs are vendored under /vendor/dicom/ (same-origin).
//
// Launched from a zip document row's "🩻 View slices" button → medDicomOpen.
// Controls: scroll = change slice, slider = jump, left-drag = window/level,
// right-drag = pan, 🔍 buttons = zoom, ↺ Fit = reset, Esc = close.
// ══════════════════════════════════════════════════════════════

// Wire cornerstone-wado-image-loader to its peers (globals from vendored bundles).
(function () {
  try {
    if (window.cornerstoneWADOImageLoader && window.cornerstone && window.dicomParser) {
      cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
      cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
    }
  } catch (e) { /* surfaced when the viewer is opened */ }
})();

let _dcmIds = [];
let _dcmIdx = 0;
let _dcmEnabled = false;
let _dcmWired = false;

function _dcmEl()       { return document.getElementById('med-dicom-element'); }
function _dcmStatus(t)  { const e = document.getElementById('med-dicom-status'); if (e) e.textContent = t; }

async function medDicomOpen(id, name) {
  const modal = document.getElementById('med-dicom-modal');
  document.getElementById('med-dicom-title').textContent = name || 'DICOM study';
  document.getElementById('med-dicom-counter').textContent = '';
  modal.style.display = 'block';
  _dcmStatus('Loading & unzipping…');

  if (!(window.cornerstone && window.JSZip && window.cornerstoneWADOImageLoader && window.dicomParser)) {
    _dcmStatus('Viewer libraries failed to load — use Download instead.');
    return;
  }
  try {
    const buf = await fetch('/api/medical/documents/' + id + '/file').then(r => {
      if (!r.ok) throw new Error('download failed (' + r.status + ')');
      return r.arrayBuffer();
    });
    const zip = await JSZip.loadAsync(buf);
    const files = [];
    zip.forEach((p, f) => { if (!f.dir) files.push(f); });
    _dcmStatus('Scanning ' + files.length + ' files for DICOM…');

    const dicoms = [];
    for (const f of files) {
      const data  = await f.async('uint8array');
      const lname = f.name.toLowerCase();
      // DICOM = .dcm extension OR "DICM" magic at byte offset 128.
      const magic = data.length > 132 &&
        data[128] === 0x44 && data[129] === 0x49 && data[130] === 0x43 && data[131] === 0x4D;
      if (lname.endsWith('.dcm') || magic) {
        let instance = 0, series = '';
        try {
          const ds = dicomParser.parseDicom(data);
          instance = parseInt(ds.string('x00200013') || '0', 10) || 0;  // InstanceNumber
          series   = ds.string('x0020000e') || '';                      // SeriesInstanceUID
        } catch (e) { /* keep it; sort by name */ }
        dicoms.push({ name: f.name, data, instance, series });
      }
    }
    if (!dicoms.length) {
      _dcmStatus('No DICOM (.dcm) images found in this zip — use Download to open its contents.');
      return;
    }

    // Pick the largest series, order by InstanceNumber then filename.
    const bySeries = {};
    dicoms.forEach(d => { (bySeries[d.series] = bySeries[d.series] || []).push(d); });
    const chosen = Object.values(bySeries).sort((a, b) => b.length - a.length)[0];
    chosen.sort((a, b) => (a.instance - b.instance) || a.name.localeCompare(b.name));

    _dcmIds = chosen.map(d => cornerstoneWADOImageLoader.wadouri.fileManager.add(new File([d.data], d.name)));

    const el = _dcmEl();
    if (!_dcmEnabled) { cornerstone.enable(el); _dcmEnabled = true; }
    if (!_dcmWired)   { _wireDcmInteractions(el); _dcmWired = true; }
    try { cornerstone.resize(el, true); } catch (e) {}

    const slider = document.getElementById('med-dicom-slider');
    slider.max = _dcmIds.length - 1;
    slider.value = 0;
    _dcmIdx = 0;
    await medDicomShow(0);
    const seriesNote = Object.keys(bySeries).length > 1 ? ' (largest of ' + Object.keys(bySeries).length + ' series)' : '';
    _dcmStatus(_dcmIds.length + ' slice' + (_dcmIds.length > 1 ? 's' : '') + seriesNote +
               ' · scroll = slices · drag = window/level · Esc to close');
  } catch (e) {
    _dcmStatus('Could not open: ' + ((e && e.message) || e) + ' — try Download.');
  }
}

async function medDicomShow(i) {
  if (!_dcmIds.length) return;
  i = Math.max(0, Math.min(_dcmIds.length - 1, i));
  _dcmIdx = i;
  const el = _dcmEl();
  try {
    const img = await cornerstone.loadAndCacheImage(_dcmIds[i]);
    let vp;
    try { vp = cornerstone.getViewport(el); } catch (e) { vp = undefined; }
    cornerstone.displayImage(el, img, vp);   // vp undefined on first slice → default auto window/level
    document.getElementById('med-dicom-counter').textContent = (i + 1) + ' / ' + _dcmIds.length;
    document.getElementById('med-dicom-slider').value = i;
  } catch (e) {
    _dcmStatus('Slice ' + (i + 1) + ' could not decode (unsupported transfer syntax?): ' + ((e && e.message) || e));
  }
}

function medDicomZoom(f) {
  if (!_dcmEnabled) return;
  const el = _dcmEl();
  try { const vp = cornerstone.getViewport(el); vp.scale *= f; cornerstone.setViewport(el, vp); } catch (e) {}
}

function medDicomReset() {
  if (!_dcmEnabled) return;
  try { cornerstone.reset(_dcmEl()); } catch (e) {}
}

function medDicomClose() {
  document.getElementById('med-dicom-modal').style.display = 'none';
  _dcmIds = [];
  try {
    if (cornerstoneWADOImageLoader.wadouri.fileManager.purge) cornerstoneWADOImageLoader.wadouri.fileManager.purge();
  } catch (e) {}
}

function _wireDcmInteractions(el) {
  let drag = null;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    drag = { x: e.pageX, y: e.pageY, button: e.button, vp: cornerstone.getViewport(el) };
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.pageX - drag.x, dy = e.pageY - drag.y;
    const vp = cornerstone.getViewport(el);
    if (drag.button === 2) {                                 // right-drag = pan
      vp.translation.x = drag.vp.translation.x + dx / vp.scale;
      vp.translation.y = drag.vp.translation.y + dy / vp.scale;
    } else {                                                  // left-drag = window/level
      vp.voi.windowWidth  = Math.max(1, drag.vp.voi.windowWidth + dx);
      vp.voi.windowCenter = drag.vp.voi.windowCenter + dy;
    }
    cornerstone.setViewport(el, vp);
  });
  window.addEventListener('mouseup', () => { drag = null; });
  el.addEventListener('contextmenu', (e) => e.preventDefault());   // enable right-drag pan
  el.addEventListener('wheel', (e) => { e.preventDefault(); medDicomShow(_dcmIdx + (e.deltaY > 0 ? 1 : -1)); }, { passive: false });
}

document.addEventListener('keydown', (e) => {
  const m = document.getElementById('med-dicom-modal');
  if (e.key === 'Escape' && m && m.style.display === 'block') medDicomClose();
});

window.addEventListener('resize', () => {
  const m = document.getElementById('med-dicom-modal');
  if (_dcmEnabled && m && m.style.display === 'block') { try { cornerstone.resize(_dcmEl(), true); } catch (e) {} }
});
