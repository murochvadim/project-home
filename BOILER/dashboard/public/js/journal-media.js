// Daily Journal media plumbing, shared by the Privacy page (the journal itself) and the
// Communication page (saving a WhatsApp photo into the journal).
//
// Extracted from js/privacy.js so the two pages can never drift into writing to different
// folders, naming files differently, or asking different questions after an upload.
//   window.journalUploadMedia(file, dateStr, name?)   -> /mnt/media path
//   window.journalMediaMetaPrompt(fileName, dateStr)  -> {event,year,location,person[]} | null
//   window.journalApplyMediaMeta(path, meta)
//   window.journalMediaScan()
(function () {
  const INGEST = 'http://192.168.1.138:8767';   // media agent: upload / scan / library PATCH
  const PLAYER = 'http://192.168.1.138:8766';   // player: library read
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Bytes go browser -> media agent -> /mnt/media (QNAP) ONLY; Postgres stores just the path.
  // `name` is optional: the journal leaves it random (upload does f.save(), which OVERWRITES a
  // same-name file), while a caller that wants re-saving the SAME item to overwrite its own file
  // -- e.g. keyed by a WhatsApp message id -- passes an explicit one.
  window.journalUploadMedia = async function (file, dateStr, name) {
    const now = new Date();
    const hms = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
    const ext = (/(\.[a-z0-9]+)$/i.exec(file.name || '') || ['', ''])[1].toLowerCase();
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
    const dname = dm ? (dm[1] + '-' + (MONTHS[+dm[2] - 1] || dm[2]) + '-' + dm[3]) : String(dateStr || '');
    // Folder is per-MONTH; the filename stays day-stamped so each item still reads as its day.
    const mname = dm ? (dm[1] + '-' + (MONTHS[+dm[2] - 1] || dm[2])) : String(dateStr || '');
    const uni = name || (dname + '_' + hms + '_' + Math.random().toString(36).slice(2, 5) + ext);
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('relativePath', uni);
    fd.append('targetPath', 'Daily Journal/' + mname);
    const r = await fetch(INGEST + '/api/media/upload', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.path) throw new Error(j.error || 'upload failed');
    return j.path;
  };

  // Event / Year / Location / People. Uses the page's own #pvj-media-meta markup when present
  // (Privacy); elsewhere it builds the identical overlay AND injects the styles, because those
  // classes live inside privacy.html, not in a shared stylesheet.
  function ensureOverlay() {
    let ov = document.getElementById('pvj-media-meta');
    if (ov) return ov;
    if (!document.getElementById('jm-css')) {
      const st = document.createElement('style');
      st.id = 'jm-css';
      st.textContent = '.pv-modal{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:100001;padding:16px;}'
        + '.pv-modal-box{background:#fff;border-radius:10px;padding:18px 20px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,0.3);}'
        + '.pv-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;}'
        + '.pv-form-grid label{display:flex;flex-direction:column;font-size:0.78rem;color:#555;gap:3px;}'
        + '.pv-form-grid input{padding:6px 8px;border:1px solid #cbd5e1;border-radius:5px;font-size:0.85rem;font-family:inherit;}';
      document.head.appendChild(st);
    }
    ov = document.createElement('div');
    ov.id = 'pvj-media-meta';
    ov.className = 'pv-modal';
    ov.style.display = 'none';
    ov.innerHTML =
      '<div class="pv-modal-box" style="max-width:440px;">' +
        '<h3 style="margin:0 0 4px;font-size:1.02rem;">📸 Add details</h3>' +
        '<div id="pvjmm-file" style="font-size:0.78rem;color:#888;margin-bottom:12px;word-break:break-all;"></div>' +
        '<div class="pv-form-grid">' +
          '<label style="grid-column:1 / -1;">Event<input id="pvjmm-event" type="text" placeholder="wedding / birthday / vacation..."></label>' +
          '<label>Year<input id="pvjmm-year" type="number" min="1900" max="2100" placeholder="2024"></label>' +
          '<label>Location<input id="pvjmm-location" type="text" placeholder="city / place"></label>' +
          '<label style="grid-column:1 / -1;">People<input id="pvjmm-person" type="text" placeholder="name1, name2..."></label>' +
        '</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
          '<button id="pvjmm-skip" style="padding:6px 14px;border:1px solid #ccc;background:#f4f4f4;border-radius:5px;cursor:pointer;">Skip</button>' +
          '<button id="pvjmm-save" style="padding:6px 16px;border:none;background:#2b7a4b;color:#fff;border-radius:5px;cursor:pointer;font-weight:600;">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }

  window.journalMediaMetaPrompt = function (fileName, dateStr) {
    return new Promise((resolve) => {
      const ov = ensureOverlay();
      if (!ov) { resolve(null); return; }
      document.getElementById('pvjmm-file').textContent = fileName || '';
      document.getElementById('pvjmm-event').value = '';
      document.getElementById('pvjmm-year').value = (String(dateStr || '').slice(0, 4)) || '';
      document.getElementById('pvjmm-location').value = '';
      document.getElementById('pvjmm-person').value = '';
      ov.style.display = 'flex';
      const saveBtn = document.getElementById('pvjmm-save');
      const skipBtn = document.getElementById('pvjmm-skip');
      const done = (val) => { ov.style.display = 'none'; saveBtn.onclick = null; skipBtn.onclick = null; resolve(val); };
      saveBtn.onclick = () => {
        const event = document.getElementById('pvjmm-event').value.trim() || null;
        const yr = document.getElementById('pvjmm-year').value.trim();
        const year = yr ? parseInt(yr, 10) : null;
        const location = document.getElementById('pvjmm-location').value.trim() || null;
        const pr = document.getElementById('pvjmm-person').value.trim();
        const person = pr ? pr.split(',').map(s => s.trim()).filter(Boolean) : null;
        done({ event, year, location, person });
      };
      skipBtn.onclick = () => done(null);
      setTimeout(() => document.getElementById('pvjmm-event').focus(), 50);
    });
  };

  // The scan that registers the library row is async, so wait for the row before PATCHing.
  window.journalApplyMediaMeta = async function (path, meta) {
    for (let i = 0; i < 8; i++) {
      try { const g = await fetch(PLAYER + '/api/media/library/' + encodeURIComponent(path)); if (g.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    try {
      await fetch(INGEST + '/api/media/library?path=' + encodeURIComponent(path), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
      });
    } catch (_) { /* metadata will apply after the next scan */ }
  };

  window.journalMediaScan = function () {
    return fetch(INGEST + '/api/media/scan', { method: 'POST' }).catch(() => {});
  };
})();
