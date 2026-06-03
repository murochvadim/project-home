// ══════════════════════════════════════════════════════════════
// Medical Agent — Contacts only.
// Flat address book: doctors / clinics / hospitals + health fund.
// Single sub-tab. Single endpoint cluster /api/medical/contacts/*.
// ══════════════════════════════════════════════════════════════

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

const KIND_LABELS = { doctor: 'Doctor', clinic: 'Clinic', hospital: 'Hospital' };
const HEALTH_FUNDS = ['Clalit', 'Maccabi', 'Meuhedet', 'Leumit'];

let CONTACTS = [];

window.medRefresh = async function () {
  try {
    const r = await fetch('/api/medical/contacts').then(r => r.json());
    CONTACTS = Array.isArray(r) ? r : [];
    window.medRenderContacts();
    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('med-contact-list').innerHTML =
      '<div class="med-empty" style="color:#b55e5e;">Failed: ' + esc(e.message) + '</div>';
  }
};

window.medRenderContacts = function () {
  const k = document.getElementById('med-filter-kind').value;
  const q = document.getElementById('med-filter-search').value.trim().toLowerCase();
  let list = CONTACTS;
  if (k) list = list.filter(c => c.kind === k);
  if (q) list = list.filter(c =>
    (c.name && c.name.toLowerCase().includes(q)) ||
    (c.specialty && c.specialty.toLowerCase().includes(q)) ||
    (c.health_fund && c.health_fund.toLowerCase().includes(q)) ||
    (c.address && c.address.toLowerCase().includes(q))
  );
  const el = document.getElementById('med-contact-list');
  if (list.length === 0) {
    el.innerHTML = '<div class="med-empty">No contacts yet — click + New to add one.</div>';
    return;
  }
  el.innerHTML = list.map(renderContactCard).join('');
};

function renderContactCard(c) {
  return `<div class="med-list-card">
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <span class="med-chip kind-${esc(c.kind)}">${esc(KIND_LABELS[c.kind] || c.kind)}</span>
      <h3 style="margin:0; flex:1;">${esc(c.name)}</h3>
      <button class="btn btn-secondary btn-sm" onclick="medEditContact(${c.id})">Edit</button>
      <button class="btn btn-secondary btn-sm" onclick="medDeleteContact(${c.id})">✕</button>
    </div>
    ${c.specialty ? `<div class="med-meta">${esc(c.specialty)}</div>` : ''}
    ${c.health_fund ? `<div class="med-meta">Health fund: ${esc(c.health_fund)}</div>` : ''}
    ${c.address ? `<div class="med-meta">📍 ${esc(c.address)}</div>` : ''}
    <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
      ${c.phone_main      ? `<a class="med-link-btn" href="tel:${esc(c.phone_main)}"      title="Main">📞 ${esc(c.phone_main)}</a>` : ''}
      ${c.phone_private   ? `<a class="med-link-btn" href="tel:${esc(c.phone_private)}"   title="Privet">🔒 ${esc(c.phone_private)}</a>` : ''}
      ${c.phone_zimun_tor ? `<a class="med-link-btn" href="tel:${esc(c.phone_zimun_tor)}" title="Zimun Tor">📅 ${esc(c.phone_zimun_tor)}</a>` : ''}
      ${c.phone_fax       ? `<a class="med-link-btn" href="tel:${esc(c.phone_fax)}"       title="Fax">📠 ${esc(c.phone_fax)}</a>` : ''}
      ${c.email ? `<a class="med-link-btn" href="mailto:${esc(c.email)}">✉ ${esc(c.email)}</a>` : ''}
      ${c.website_url ? `<a class="med-link-btn" href="${esc(c.website_url)}" target="_blank" rel="noopener">🌐 site</a>` : ''}
    </div>
    ${c.notes ? `<div style="margin-top:4px; font-size:0.84rem;">${esc(c.notes)}</div>` : ''}
  </div>`;
}

window.medOpenContactForm = function () {
  const el = document.getElementById('med-contact-form');
  el.style.display = 'block';
  el.innerHTML = renderContactForm({});
};

window.medCloseContactForm = function () {
  const el = document.getElementById('med-contact-form');
  el.style.display = 'none';
  el.innerHTML = '';
};

window.medEditContact = function (id) {
  const c = CONTACTS.find(x => x.id === id);
  if (!c) return;
  const el = document.getElementById('med-contact-form');
  el.style.display = 'block';
  el.innerHTML = renderContactForm(c);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function renderContactForm(c) {
  const v = k => esc(c[k] || '');
  const kindVal = c.kind || 'doctor';
  const fundVal = c.health_fund || '';
  const editing = !!c.id;
  return `<div style="background:#fafaf6; padding:12px; border-radius:6px;">
    <div class="med-form-row"><label>Kind</label>
      <select id="cf-kind">
        ${['doctor','clinic','hospital'].map(k =>
          `<option value="${k}"${k === kindVal ? ' selected' : ''}>${KIND_LABELS[k]}</option>`).join('')}
      </select>
    </div>
    <div class="med-form-row"><label>Name</label><input type="text" id="cf-name" value="${v('name')}" placeholder="Dr. Cohen / Clalit Tel Aviv / Sourasky"></div>
    <div class="med-form-row"><label>Specialty</label><input type="text" id="cf-specialty" value="${v('specialty')}" placeholder="Cardiology / Family / Imaging"></div>
    <div class="med-form-row"><label>Health fund</label>
      <select id="cf-health-fund">
        <option value=""${fundVal === '' ? ' selected' : ''}>—</option>
        ${HEALTH_FUNDS.map(f => `<option value="${f}"${f === fundVal ? ' selected' : ''}>${f}</option>`).join('')}
        ${fundVal && !HEALTH_FUNDS.includes(fundVal) ? `<option value="${esc(fundVal)}" selected>${esc(fundVal)} (other)</option>` : ''}
      </select>
    </div>
    <div class="med-form-row"><label>Address</label><input type="text" id="cf-address" value="${v('address')}" placeholder="Street, City"></div>
    <div class="med-form-row"><label>Phone — Main</label><input type="text" id="cf-phone-main" value="${v('phone_main')}" placeholder="Clinic main line"></div>
    <div class="med-form-row"><label>Phone — Privet</label><input type="text" id="cf-phone-private" value="${v('phone_private')}" placeholder="Doctor's direct / personal"></div>
    <div class="med-form-row"><label>Phone — Zimun Tor</label><input type="text" id="cf-phone-zimun-tor" value="${v('phone_zimun_tor')}" placeholder="Appointment booking line"></div>
    <div class="med-form-row"><label>Phone — Fax</label><input type="text" id="cf-phone-fax" value="${v('phone_fax')}" placeholder="Fax number"></div>
    <div class="med-form-row"><label>Email</label><input type="email" id="cf-email" value="${v('email')}"></div>
    <div class="med-form-row"><label>Website</label><input type="url" id="cf-website" value="${v('website_url')}" placeholder="https://"></div>
    <div class="med-form-row"><label>Notes</label><textarea id="cf-notes">${v('notes')}</textarea></div>
    <div style="display:flex; gap:8px; margin-top:8px;">
      <button class="btn btn-success btn-sm" onclick="medSaveContact(${editing ? c.id : 'null'})">💾 ${editing ? 'Update' : 'Save'}</button>
      <button class="btn btn-secondary btn-sm" onclick="medCloseContactForm()">Cancel</button>
    </div>
    <div id="cf-err" style="color:#b55e5e; font-size:0.82rem; margin-top:6px;"></div>
  </div>`;
}

window.medSaveContact = async function (id) {
  const payload = {
    kind: document.getElementById('cf-kind').value,
    name: document.getElementById('cf-name').value.trim(),
    specialty: document.getElementById('cf-specialty').value.trim(),
    health_fund: document.getElementById('cf-health-fund').value.trim(),
    address: document.getElementById('cf-address').value.trim(),
    phone_main:      document.getElementById('cf-phone-main').value.trim(),
    phone_private:   document.getElementById('cf-phone-private').value.trim(),
    phone_zimun_tor: document.getElementById('cf-phone-zimun-tor').value.trim(),
    phone_fax:       document.getElementById('cf-phone-fax').value.trim(),
    email: document.getElementById('cf-email').value.trim(),
    website_url: document.getElementById('cf-website').value.trim(),
    notes: document.getElementById('cf-notes').value.trim(),
  };
  if (!payload.name) { document.getElementById('cf-err').textContent = 'Name is required'; return; }
  try {
    const url = id ? '/api/medical/contacts/' + id : '/api/medical/contacts';
    const method = id ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    medCloseContactForm();
    medRefresh();
  } catch (e) { document.getElementById('cf-err').textContent = e.message; }
};

window.medDeleteContact = async function (id) {
  if (!confirm('Delete this contact?')) return;
  await fetch('/api/medical/contacts/' + id, { method: 'DELETE' });
  medRefresh();
};

// Auto-load Contacts on first paint. Registered at the bottom of the file
// so all window.medXxx assignments above have run by the time the handler
// is registered (previously this was at the top and `medRefresh` was
// undeclared, throwing ReferenceError + halting the rest of the script).
document.addEventListener('DOMContentLoaded', medRefresh);

// ══════════════════════════════════════════════════════════════
// Medical Documents tab — PDF upload + camera capture.
// Lazy-loaded: medLoadDocuments() runs on first tab-switch click.
// Two upload modes: file picker (PDF) OR laptop camera (JPEG).
// Storage: \\192.168.1.155\Claude_Data\Medical_Documents\ on QNAP
// (server.js writes directly; delete tunneled via LXC 104 SSH).
// ══════════════════════════════════════════════════════════════

const DOC_TYPE_LABELS = {
  lab_result:     'Lab Result',
  imaging:        'Imaging',
  prescription:   'Prescription',
  visit_summary:  'Visit Summary',
  referral:       'Referral',
  insurance:      'Insurance',
  vaccine_record: 'Vaccine Record',
  id_card:        'ID / Card',
  other:          'Other',
};

let DOCUMENTS    = [];
let _camStream   = null;   // MediaStream when camera card is open
let _docsLoaded  = false;  // first tab-switch triggers full load

window.medLoadDocuments = async function () {
  // Make sure CONTACTS is fresh — the doctor + producer dropdowns reference it.
  if (CONTACTS.length === 0) {
    try { CONTACTS = await fetch('/api/medical/contacts').then(r => r.json()); } catch (_) {}
  }
  await medFetchDocuments();
  _populateDoctorFilter();
  _docsLoaded = true;
};

async function medFetchDocuments() {
  try {
    const r = await fetch('/api/medical/documents').then(r => r.json());
    DOCUMENTS = Array.isArray(r) ? r : [];
    window.medRenderDocuments();
  } catch (e) {
    document.getElementById('med-doc-list').innerHTML =
      '<div class="med-empty" style="color:#b55e5e;">Failed: ' + esc(e.message) + '</div>';
  }
}

function _populateDoctorFilter() {
  const sel = document.getElementById('med-doc-filter-doctor');
  if (!sel) return;
  const cur = sel.value;
  const doctors = CONTACTS.filter(c => c.kind === 'doctor').sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">Any doctor</option>' +
    doctors.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  if (cur) sel.value = cur;
}

window.medRenderDocuments = function () {
  const t = document.getElementById('med-doc-filter-type').value;
  const d = document.getElementById('med-doc-filter-doctor').value;
  const q = document.getElementById('med-doc-filter-search').value.trim().toLowerCase();
  let list = DOCUMENTS;
  if (t) list = list.filter(x => x.doc_type === t);
  if (d) list = list.filter(x => String(x.doctor_id) === d);
  if (q) list = list.filter(x =>
    (x.name && x.name.toLowerCase().includes(q)) ||
    (x.notes && x.notes.toLowerCase().includes(q))
  );
  const el = document.getElementById('med-doc-list');
  if (list.length === 0) {
    el.innerHTML = '<div class="med-empty">No documents yet — click + Upload PDF or + Camera capture above.</div>';
    return;
  }
  el.innerHTML = list.map(renderDocCard).join('');
};

function renderDocCard(d) {
  const size = d.file_size != null ? _fmtSize(d.file_size) : '';
  return `<div class="med-list-card">
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <span class="med-chip type-${esc(d.doc_type)}">${esc(DOC_TYPE_LABELS[d.doc_type] || d.doc_type)}</span>
      <h3 style="margin:0; flex:1;">${esc(d.name)}</h3>
      <a class="med-link-btn" href="/api/medical/documents/${d.id}/file" target="_blank">👁 View</a>
      <a class="med-link-btn" href="/api/medical/documents/${d.id}/file?download=1">⬇ Download</a>
      <button class="btn btn-secondary btn-sm" onclick="medEditDoc(${d.id})">Edit</button>
      <button class="btn btn-secondary btn-sm" onclick="medDeleteDoc(${d.id})">✕</button>
    </div>
    ${d.doctor_name   ? `<div class="med-meta">👨‍⚕ ${esc(d.doctor_name)}</div>`   : ''}
    ${d.producer_name ? `<div class="med-meta">🏥 ${esc(d.producer_name)} (${esc(d.producer_kind)})</div>` : ''}
    ${d.doc_date      ? `<div class="med-meta">📅 ${esc(d.doc_date)}</div>` : ''}
    <div class="med-meta">${esc(d.mime_type)} · ${size} · uploaded ${esc(d.uploaded_at)}</div>
    ${d.notes ? `<div style="margin-top:4px; font-size:0.84rem;">${esc(d.notes)}</div>` : ''}
  </div>`;
}

function _fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

window.medOpenDocForm = function (mode) {
  // mode: 'pdf' | 'camera' | 'edit'
  const stage = document.getElementById('med-camera-stage');
  stage.style.display = 'none';
  const el = document.getElementById('med-doc-form');
  el.style.display = 'block';
  el.innerHTML = renderDocForm({ _mode: mode });
  if (mode === 'camera') {
    // Rebuild the stage's innerHTML every time — a prior error inside
    // _startCamera() may have replaced it with a failure message that
    // doesn't include the <video> / <canvas> / button row.
    // Header row: camera picker on the left, Snap + Cancel buttons pushed
    // to the right via margin-left:auto on the button group. Video fills
    // the full stage width below (no max-width cap).
    stage.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
        <label style="color:#ddd; font-size:0.84rem;">Camera:</label>
        <select id="med-cam-picker" onchange="medSwitchCamera(this.value)" style="flex:1; max-width:280px; padding:4px 6px; background:#222; color:#fff; border:1px solid #444; border-radius:3px; font-size:0.84rem;">
          <option value="">— scanning… —</option>
        </select>
        <div class="cam-btns">
          <button class="btn btn-success btn-sm" onclick="medCameraSnap()">📸 Snap</button>
          <button class="btn btn-secondary btn-sm" onclick="medCameraCancel()">Cancel</button>
        </div>
      </div>
      <video id="med-cam-video" autoplay muted playsinline style="display:block;"></video>
      <canvas id="med-cam-canvas"></canvas>`;
    stage.style.display = 'block';
    _startCamera();
  }
};

window.medSwitchCamera = async function (deviceId) {
  if (!deviceId) return;
  _stopCamera();
  await _startCamera(deviceId);
};

window.medEditDoc = function (id) {
  const d = DOCUMENTS.find(x => x.id === id);
  if (!d) return;
  const el = document.getElementById('med-doc-form');
  el.style.display = 'block';
  el.innerHTML = renderDocForm({ ...d, _mode: 'edit' });
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.medCloseDocForm = function () {
  document.getElementById('med-doc-form').style.display = 'none';
  document.getElementById('med-doc-form').innerHTML = '';
  _stopCamera();
  document.getElementById('med-camera-stage').style.display = 'none';
  document.getElementById('med-upload-progress').style.display = 'none';
};

function renderDocForm(d) {
  const v   = k => esc(d[k] || '');
  const idV = d.id || null;
  const editing = d._mode === 'edit';
  const mode    = d._mode || 'pdf';
  const doctors  = CONTACTS.filter(c => c.kind === 'doctor').sort((a, b) => a.name.localeCompare(b.name));
  const producers= CONTACTS.filter(c => c.kind === 'clinic' || c.kind === 'hospital').sort((a, b) => a.name.localeCompare(b.name));
  const optDoctor = doctors.map(c =>
    `<option value="${c.id}"${c.id === d.doctor_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const optProducer = producers.map(c =>
    `<option value="${c.id}"${c.id === d.producer_id ? ' selected' : ''}>${esc(c.name)} (${esc(c.kind)})</option>`).join('');
  const optType = Object.entries(DOC_TYPE_LABELS).map(([k, lbl]) =>
    `<option value="${k}"${k === d.doc_type ? ' selected' : ''}>${esc(lbl)}</option>`).join('');
  return `<div style="background:#fafaf6; padding:12px; border-radius:6px;">
    ${editing ? '' : (mode === 'pdf'
      ? `<div class="med-form-row"><label>PDF file</label><input type="file" id="df-file" accept="application/pdf" onchange="medFillNameFromFile()"></div>`
      : `<div class="med-form-row"><label>Image</label><span style="font-size:0.84rem;color:#666;">Use Snap below to capture; preview will appear after.</span></div>`)}
    <div class="med-form-row"><label>Name</label><input type="text" id="df-name" value="${v('name')}" placeholder="auto from filename"></div>
    <div class="med-form-row"><label>Type</label><select id="df-type">${optType}</select></div>
    <div class="med-form-row"><label>Doctor</label>
      <select id="df-doctor"><option value="">— none —</option>${optDoctor}</select>
    </div>
    <div class="med-form-row"><label>Producer</label>
      <select id="df-producer"><option value="">— none —</option>${optProducer}</select>
    </div>
    <div class="med-form-row"><label>Doc date</label><input type="date" id="df-doc-date" value="${v('doc_date')}"></div>
    <div class="med-form-row"><label>Notes</label><textarea id="df-notes">${v('notes')}</textarea></div>
    <div style="display:flex; gap:8px; margin-top:8px;">
      <button class="btn btn-success btn-sm" onclick="${editing ? `medSaveDocMeta(${idV})` : 'medUploadDoc()'}">
        💾 ${editing ? 'Update' : 'Upload'}
      </button>
      <button class="btn btn-secondary btn-sm" onclick="medCloseDocForm()">Cancel</button>
    </div>
    <div id="df-err" style="color:#b55e5e; font-size:0.82rem; margin-top:6px;"></div>
  </div>`;
}

window.medFillNameFromFile = function () {
  const fi = document.getElementById('df-file');
  const nm = document.getElementById('df-name');
  if (fi && fi.files && fi.files[0] && nm && !nm.value) {
    nm.value = fi.files[0].name.replace(/\.[^.]+$/, '');
  }
};

function _camDiag(msg, color) {
  const el = document.getElementById('med-cam-diag');
  if (!el) return;
  el.innerHTML += `<div style="color:${color || '#ddd'}; font-size:0.78rem; font-family:monospace;">${msg}</div>`;
  console.log('[medical camera]', msg);
}

async function _startCamera(forceDeviceId) {
  const stage = document.getElementById('med-camera-stage');
  // Reset diag for each (re)start so the panel doesn't grow forever.
  let diag = document.getElementById('med-cam-diag');
  if (!diag) {
    diag = document.createElement('div');
    diag.id = 'med-cam-diag';
    diag.style.cssText = 'margin-top:6px; padding:8px; background:#0a0a0a; border:1px solid #333; border-radius:4px; min-height:24px;';
    stage.appendChild(diag);
  } else {
    diag.innerHTML = '';
  }
  _camDiag('1. opening location=' + location.protocol + '//' + location.hostname + ':' + location.port);
  _camDiag('2. mediaDevices=' + !!navigator.mediaDevices + ', getUserMedia=' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));

  const v = document.getElementById('med-cam-video');
  v.style.display = 'block';
  document.getElementById('med-cam-canvas').style.display = 'none';
  v.srcObject = null;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _camDiag('FAIL: mediaDevices.getUserMedia not present in this context. Open dashboard at http://localhost:3000 (not LAN IP).', '#ff7f7f');
    return;
  }
  // Enumerate available cameras so the user can switch from the (default)
  // virtual-phone-camera to the laptop's real webcam. Labels are only
  // populated AFTER a successful getUserMedia, so call it once for the
  // permission-granting side effect even if we'll restart with a chosen id.
  _camDiag('3. requesting camera' + (forceDeviceId ? ' (deviceId=' + forceDeviceId.slice(0,8) + '…)' : '') + '...');
  try {
    const constraints = forceDeviceId
      ? { video: { deviceId: { exact: forceDeviceId } }, audio: false }
      : { video: true, audio: false };
    _camStream = await navigator.mediaDevices.getUserMedia(constraints);
    const tracks = _camStream.getVideoTracks();
    _camDiag('4. stream OK — ' + tracks.length + ' video track(s). Label="' + (tracks[0] && tracks[0].label) + '"');
    // Populate the camera picker (labels available now that permission is granted).
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter(d => d.kind === 'videoinput');
      const picker = document.getElementById('med-cam-picker');
      if (picker && cams.length) {
        const curLabel = tracks[0] && tracks[0].label;
        picker.innerHTML = cams.map(c => {
          const sel = c.label === curLabel ? ' selected' : '';
          return `<option value="${c.deviceId}"${sel}>${esc(c.label || ('Camera ' + c.deviceId.slice(0,6)))}</option>`;
        }).join('');
      }
      _camDiag('   ' + cams.length + ' camera(s) available — pick from the dropdown above to switch.', '#aaa');
    } catch (_) { /* enumerateDevices not critical */ }
    v.srcObject = _camStream;
    _camDiag('5. srcObject set');
    try {
      await v.play();
      _camDiag('6. video.play() resolved');
    } catch (pe) {
      _camDiag('6. video.play() rejected: ' + (pe.name || '') + ' ' + (pe.message || pe), '#ffa500');
    }
    // Poll for the first frame — videoWidth becomes non-zero when the
    // browser actually starts decoding frames. If it stays 0 for >3s, the
    // stream is connected but frames aren't flowing (driver issue / camera
    // physically blocked / etc.).
    let polls = 0;
    const iv = setInterval(() => {
      polls++;
      if (v.videoWidth > 0) {
        _camDiag('7. frames flowing — ' + v.videoWidth + 'x' + v.videoHeight, '#7fff7f');
        clearInterval(iv);
      } else if (polls > 15) {  // 3 s
        _camDiag('FAIL: stream connected but videoWidth stayed 0 for 3s. Driver / camera-in-use elsewhere?', '#ff7f7f');
        clearInterval(iv);
      }
    }, 200);
  } catch (e) {
    let hint = '';
    if (e.name === 'NotAllowedError') hint = ' — permission denied. Click the camera icon in the URL bar and re-allow.';
    else if (e.name === 'NotFoundError') hint = ' — no camera device available.';
    else if (e.name === 'NotReadableError') hint = ' — camera busy. Another app or tab is using it (Zoom, Teams, OBS, etc.). Close those and retry.';
    else if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      hint = ' — opened from "' + location.hostname + '". Camera requires HTTPS or localhost. Open http://localhost:3000/medical.html instead.';
    }
    _camDiag('FAIL: ' + (e.name || 'Error') + ' — ' + (e.message || '') + hint, '#ff7f7f');
  }
}
function _stopCamera() {
  if (_camStream) {
    _camStream.getTracks().forEach(t => t.stop());
    _camStream = null;
  }
}

let _capturedBlob = null;
window.medCameraSnap = function () {
  const v = document.getElementById('med-cam-video');
  const c = document.getElementById('med-cam-canvas');
  c.width  = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  c.toBlob(blob => {
    _capturedBlob = blob;
    _stopCamera();
    // Show the captured image preview in place of the live video.
    c.style.display = 'block';
    v.style.display = 'none';
    // Replace the Snap button with a "Re-snap" so the user can retry, and
    // disable the camera picker (no live stream now). Keep Cancel.
    const btns = document.querySelector('#med-camera-stage .cam-btns');
    if (btns) {
      btns.innerHTML = `
        <span style="color:#7fff7f; font-size:0.84rem; align-self:center; margin-right:6px;">Captured ${_fmtSize(blob.size)}</span>
        <button class="btn btn-secondary btn-sm" onclick="medOpenDocForm('camera')">↻ Re-snap</button>
        <button class="btn btn-secondary btn-sm" onclick="medCameraCancel()">Cancel</button>`;
    }
    const picker = document.getElementById('med-cam-picker');
    if (picker) picker.disabled = true;
  }, 'image/jpeg', 0.85);
};
window.medCameraCancel = function () {
  _stopCamera();
  _capturedBlob = null;
  medCloseDocForm();
};

window.medUploadDoc = async function () {
  const errEl = document.getElementById('df-err');
  errEl.textContent = '';
  const name      = document.getElementById('df-name').value.trim();
  const doc_type  = document.getElementById('df-type').value;
  const doctor_id = document.getElementById('df-doctor').value;
  const producer_id = document.getElementById('df-producer').value;
  const doc_date  = document.getElementById('df-doc-date').value;
  const notes     = document.getElementById('df-notes').value.trim();

  let file = null;
  const fi = document.getElementById('df-file');
  if (fi && fi.files && fi.files[0]) {
    file = fi.files[0];
  } else if (_capturedBlob) {
    file = new File([_capturedBlob], (name || 'capture') + '.jpg', { type: 'image/jpeg' });
  } else {
    errEl.textContent = 'Pick a PDF or capture an image first';
    return;
  }
  if (!name) { errEl.textContent = 'Name is required'; return; }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('meta', JSON.stringify({ name, doc_type, doctor_id, producer_id, doc_date, notes }));

  const prog = document.getElementById('med-upload-progress');
  prog.style.display = 'block';
  prog.textContent = `Uploading ${_fmtSize(file.size)}…`;
  try {
    const r = await fetch('/api/medical/documents', { method: 'POST', body: fd }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    prog.textContent = '✓ Uploaded';
    setTimeout(() => { prog.style.display = 'none'; }, 1200);
    _capturedBlob = null;
    medCloseDocForm();
    await medFetchDocuments();
  } catch (e) {
    prog.style.display = 'none';
    errEl.textContent = e.message;
  }
};

window.medSaveDocMeta = async function (id) {
  const errEl = document.getElementById('df-err');
  errEl.textContent = '';
  const payload = {
    name:        document.getElementById('df-name').value.trim(),
    doc_type:    document.getElementById('df-type').value,
    doctor_id:   document.getElementById('df-doctor').value || null,
    producer_id: document.getElementById('df-producer').value || null,
    doc_date:    document.getElementById('df-doc-date').value || null,
    notes:       document.getElementById('df-notes').value.trim(),
  };
  if (!payload.name) { errEl.textContent = 'Name is required'; return; }
  try {
    const r = await fetch('/api/medical/documents/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    medCloseDocForm();
    await medFetchDocuments();
  } catch (e) { errEl.textContent = e.message; }
};

window.medDeleteDoc = async function (id) {
  if (!confirm('Delete this document? The file on QNAP will be removed too.')) return;
  try {
    const r = await fetch('/api/medical/documents/' + id, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    await medFetchDocuments();
  } catch (e) { alert('Delete failed: ' + e.message); }
};
