// ── Privacy → Budget tab (x-spreadsheet) ─────────────────────────────────────
// Multi-sheet Excel-like table built on the x-spreadsheet library (vendored,
// MIT). PHASE 1 — PLAINTEXT: the workbook is saved to / loaded from
// dashboard_settings.privacy.offers via the generic dashboard-settings API.
// Phase 2 moves storage to a privacy_sheets table + adds server-blind
// encryption (Lock/Unlock with the Vaultwarden Documents password).
// The library exposes the global factory window.x_spreadsheet(el, opts).

let _pvofXs = null;        // the x-spreadsheet instance (created once, lazily)
let _pvofLoaded = false;   // saved workbook fetched + applied once

function _pvofStatus(msg, ok) {
  const el = document.getElementById('pvof-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok === false ? '#c0392b' : '#2e7d32';
}

// Called by the Budget tab button (after showTab makes the panel visible, so the
// container has a real width). Creates the grid once, then loads saved data once.
function pvofOnTabShow() {
  const host = document.getElementById('pvof-xs');
  if (!host) return;
  if (typeof x_spreadsheet === 'undefined') {
    _pvofStatus('x-spreadsheet failed to load', false);
    return;
  }

  if (!_pvofXs) {
    _pvofXs = x_spreadsheet(host, {
      mode: 'edit',
      showToolbar: true,
      showGrid: true,
      showContextmenu: true,
      // showBottomBar defaults true → multi-sheet tabs along the bottom
      view: {
        height: () => Math.max(420, window.innerHeight - 300),
        width: () => host.clientWidth || (window.innerWidth - 280),
      },
      row: { len: 200, height: 25 },
      col: { len: 26, width: 100 },
    });
    // any edit marks the workbook dirty (until 💾 Save)
    _pvofXs.change(() => _pvofStatus('Unsaved changes — click 💾 Save'));
  }

  if (!_pvofLoaded) {
    _pvofLoaded = true;
    pvofLoad();
  }
}

async function pvofLoad() {
  try {
    const r = await fetch('/api/dashboard-settings/privacy.offers');
    const j = await r.json();
    const v = j && j.value;
    const hasData = v && (Array.isArray(v) ? v.length : Object.keys(v).length);
    if (hasData) {
      _pvofXs.loadData(v);            // array of sheet objects, or a single sheet
      _pvofStatus('Loaded');
    } else {
      _pvofStatus('Empty — start typing');
    }
  } catch (e) {
    _pvofStatus('Load failed: ' + (e && e.message || e), false);
  }
}

async function pvofSave() {
  if (!_pvofXs) { _pvofStatus('Nothing to save yet', false); return; }
  try {
    const data = _pvofXs.getData();   // array of sheet objects (one per bottom tab)
    const r = await fetch('/api/dashboard-settings/privacy.offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: data }),
    });
    const j = await r.json();
    if (j && j.ok) _pvofStatus('Saved ✓');
    else _pvofStatus('Save failed', false);
  } catch (e) {
    _pvofStatus('Save failed: ' + (e && e.message || e), false);
  }
}
