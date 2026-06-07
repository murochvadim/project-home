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
    ${_renderApptReminderArea(c)}
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

// Render the appointment + reminder area as up to TWO nested cards (red
// appointment with date, blue reminder text). Side-by-side if both set;
// otherwise just the one that exists, centered. Returns '' if neither.
function _renderApptReminderArea(c) {
  const apptHtml = _renderApptCard(c);
  const remHtml  = _renderReminderCard(c);
  if (!apptHtml && !remHtml) return '';
  return `<div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:6px 0;">${apptHtml}${remHtml}</div>`;
}

// Nested red card: date + reason. Past appointments turn muted red +
// "past" badge — reminder to clear via Edit so the slot is free again.
function _renderApptCard(c) {
  if (!c.next_appointment_at) return '';
  const d = new Date(c.next_appointment_at);
  const when = isNaN(d) ? c.next_appointment_at :
    d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const past = !isNaN(d) && d.getTime() < Date.now();
  const borderColor = past ? '#d4a3a3' : '#e74c3c';
  const bgColor     = past ? '#fdf4f4' : '#fef2f2';
  const titleColor  = past ? '#a35858' : '#c0392b';
  const dateColor   = past ? '#8e3e3e' : '#a82a1f';
  const pastBadge   = past ? '<span style="margin-left:6px; padding:1px 8px; background:#a35858; color:#fff; border-radius:10px; font-size:0.7rem; font-weight:600;">past</span>' : '';
  const note = c.next_appointment_note
    ? `<div style="margin-top:1px; font-size:0.82rem; color:${dateColor}; font-style:italic; line-height:1.2;">${esc(c.next_appointment_note)}</div>`
    : '';
  return `<div style="flex:0 1 260px; padding:5px 14px; background:${bgColor}; border:1.5px solid ${borderColor}; border-radius:8px; box-shadow:0 1px 3px rgba(192,57,43,0.12); text-align:center; line-height:1.25;">
    <div style="font-size:0.72rem; color:${titleColor}; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:1px;">📅 Next appointment${pastBadge}</div>
    <div style="font-size:0.94rem; font-weight:700; color:${dateColor};">${esc(when)}</div>
    ${note}
  </div>`;
}

// Nested blue card: standalone reminder text — no date, just a note that
// stays put until the user clears it (e.g. "renew prescription", "bring
// last X-ray"). Matches the red card's vertical size for visual harmony.
function _renderReminderCard(c) {
  if (!c.reminder_text) return '';
  return `<div style="flex:0 1 260px; padding:5px 14px; background:#eef5ff; border:1.5px solid #3b82f6; border-radius:8px; box-shadow:0 1px 3px rgba(59,130,246,0.15); text-align:center; line-height:1.25;">
    <div style="font-size:0.72rem; color:#1e40af; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:1px;">🔔 Reminder</div>
    <div style="font-size:0.92rem; font-weight:600; color:#1e3a8a;">${esc(c.reminder_text)}</div>
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

// Split a TIMESTAMPTZ ISO string into date / hour / minute pieces for the
// three separate inputs. (Single `datetime-local` was dropped because the
// browser-native widget follows OS locale and shows AM/PM on en-US Windows
// regardless of HTML attributes — there's no way to force 24-hour there.)
function _isoToLocalParts(iso) {
  if (!iso) return { date: '', hour: '', minute: '' };
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', hour: '', minute: '' };
  const pad = n => String(n).padStart(2, '0');
  return {
    date:   `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour:   String(d.getHours()),
    minute: pad(d.getMinutes()),
  };
}

// Combine the 3 inputs into a UTC ISO. Date-only OR missing date → ''.
// Hour/minute default to 0 if blank.
function _partsToISO(date, hourStr, minStr) {
  if (!date) return '';
  const h = Math.max(0, Math.min(23, parseInt(hourStr || '0', 10) || 0));
  const m = Math.max(0, Math.min(59, parseInt(minStr  || '0', 10) || 0));
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(`${date}T${pad(h)}:${pad(m)}`);   // browser-local
  if (isNaN(d)) return '';
  return d.toISOString();
}

function renderContactForm(c) {
  const v = k => esc(c[k] || '');
  const kindVal = c.kind || 'doctor';
  const fundVal = c.health_fund || '';
  const apptParts = _isoToLocalParts(c.next_appointment_at);
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
    <div style="margin-top:10px; padding:10px 12px; background:#fef2f2; border-left:3px solid #c0392b; border-radius:4px;">
      <div style="font-weight:600; color:#c0392b; margin-bottom:6px; font-size:0.88rem;">📅 Next appointment</div>
      <div class="med-form-row">
        <label>When</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="date" id="cf-appt-date" value="${esc(apptParts.date)}" style="flex:1; min-width:130px;">
          <input type="number" id="cf-appt-hour" min="0" max="23" step="1" placeholder="HH" value="${esc(apptParts.hour)}" style="width:62px; text-align:center;" title="Hour (0–23)">
          <span style="font-weight:700; color:#666;">:</span>
          <input type="number" id="cf-appt-min" min="0" max="59" step="1" placeholder="MM" value="${esc(apptParts.minute)}" style="width:62px; text-align:center;" title="Minute (0–59)">
          <button type="button" class="btn btn-secondary btn-sm" onclick="medClearAppt()" title="Clear appointment">✕ clear</button>
        </div>
      </div>
      <div class="med-form-row"><label>Reason</label><input type="text" id="cf-appt-note" value="${v('next_appointment_note')}" placeholder="Routine check / Follow-up / fast 12h"></div>
    </div>
    <div style="margin-top:10px; padding:10px 12px; background:#eef5ff; border-left:3px solid #3b82f6; border-radius:4px;">
      <div style="font-weight:600; color:#1e40af; margin-bottom:6px; font-size:0.88rem;">🔔 Reminder</div>
      <div class="med-form-row">
        <label>Text</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="text" id="cf-reminder" value="${v('reminder_text')}" placeholder="Renew prescription / bring last X-ray" style="flex:1;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="medClearReminder()" title="Clear reminder">✕ clear</button>
        </div>
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-top:8px;">
      <button class="btn btn-success btn-sm" onclick="medSaveContact(${editing ? c.id : 'null'})">💾 ${editing ? 'Update' : 'Save'}</button>
      <button class="btn btn-secondary btn-sm" onclick="medCloseContactForm()">Cancel</button>
    </div>
    <div id="cf-err" style="color:#b55e5e; font-size:0.82rem; margin-top:6px;"></div>
  </div>`;
}

window.medClearAppt = function () {
  for (const id of ['cf-appt-date', 'cf-appt-hour', 'cf-appt-min', 'cf-appt-note']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
};

window.medClearReminder = function () {
  const el = document.getElementById('cf-reminder');
  if (el) el.value = '';
};

window.medSaveContact = async function (id) {
  const apptDate = document.getElementById('cf-appt-date').value.trim();
  const apptHour = document.getElementById('cf-appt-hour').value.trim();
  const apptMin  = document.getElementById('cf-appt-min').value.trim();
  const apptISO  = _partsToISO(apptDate, apptHour, apptMin);
  const apptNoteRaw = document.getElementById('cf-appt-note').value.trim();
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
    // Date + hour + minute combined to UTC ISO so the value stored is
    // anchored to the exact wall-clock the user typed. Empty date → '' → NULL.
    next_appointment_at:   apptISO,
    next_appointment_note: apptISO ? apptNoteRaw : '',
    reminder_text:         document.getElementById('cf-reminder').value.trim(),
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
let _pickedFile  = null;   // file dropped onto / picked via the drop zone

window.medLoadDocuments = async function () {
  // Make sure CONTACTS is fresh — the doctor + producer dropdowns reference it.
  if (CONTACTS.length === 0) {
    try { CONTACTS = await fetch('/api/medical/contacts').then(r => r.json()); } catch (_) {}
  }
  await medFetchDocuments();
  _populateDoctorFilter();
  // Wire up the drop zone the first time we visit the Documents tab.
  if (!_docsLoaded) _wireDropZone();
  _docsLoaded = true;
};

function _wireDropZone() {
  const zone = document.getElementById('med-drop-zone');
  if (!zone) return;
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach(ev => {
    zone.addEventListener(ev, e => {
      stop(e);
      zone.style.background = '#eef5ff';
      zone.style.borderColor = '#2563eb';
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    zone.addEventListener(ev, e => {
      stop(e);
      zone.style.background = '#fafaf6';
      zone.style.borderColor = '#b0a896';
    });
  });
  zone.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) window.medFileDropped(f);
  });
}

// Triggered by the drop zone's <input type="file"> onchange OR by drag-drop
// onto the zone. Opens the metadata form pre-attached to this file.
window.medFileDropped = function (file) {
  if (!file) return;
  _pickedFile = file;
  const stage = document.getElementById('med-camera-stage');
  if (stage) stage.style.display = 'none';   // close camera if open
  _stopCamera();
  const el = document.getElementById('med-doc-form');
  el.style.display = 'block';
  el.innerHTML = renderDocForm({ _mode: 'picked', name: file.name.replace(/\.[^.]+$/, '') });
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  // Total + filtered count badge in the card heading.
  const cnt = document.getElementById('med-doc-count');
  if (cnt) {
    cnt.textContent = DOCUMENTS.length === list.length
      ? `(${DOCUMENTS.length})`
      : `(${list.length} of ${DOCUMENTS.length})`;
  }
  const el = document.getElementById('med-doc-list');
  if (list.length === 0) {
    el.innerHTML = '<div class="med-empty">No documents yet — drop a file in the box above to get started.</div>';
    return;
  }
  el.innerHTML = list.map(renderDocCard).join('');
};

function renderDocCard(d) {
  const size = d.file_size != null ? _fmtSize(d.file_size) : '';
  const isImage = (d.mime_type || '').startsWith('image/');
  const isZip   = (d.mime_type || '').includes('zip') || /\.zip$/i.test(d.file_path || '');
  // Thumbnail: images open the in-page viewer; PDFs open in a new tab; zips
  // (imaging studies) only download — no preview, distinct 📦 icon.
  const thumb = isImage
    ? `<a href="#" onclick="medViewImage(${d.id}, ${JSON.stringify(d.name).replace(/"/g, '&quot;')}); return false;" title="Click to open viewer" style="flex-shrink:0;">
         <img src="/api/medical/documents/${d.id}/file" alt="" style="width:64px; height:64px; object-fit:cover; border-radius:4px; border:1px solid #ddd;">
       </a>`
    : isZip
    ? `<a href="/api/medical/documents/${d.id}/file?download=1" title="Download archive (zip)" style="flex-shrink:0; width:64px; height:64px; display:inline-flex; align-items:center; justify-content:center; background:#fef3c7; color:#854d0e; border-radius:4px; border:1px solid #f3e2a8; font-size:1.8rem; text-decoration:none;">📦</a>`
    : `<a href="/api/medical/documents/${d.id}/file" target="_blank" title="Click to open PDF" style="flex-shrink:0; width:64px; height:64px; display:inline-flex; align-items:center; justify-content:center; background:#fce7f3; color:#9d174d; border-radius:4px; border:1px solid #f4c8d8; font-size:1.8rem; text-decoration:none;">📄</a>`;
  // Zips (imaging studies): in-dashboard DICOM slice viewer instead of a raw Open.
  const openBtn = isZip
    ? `<a class="med-link-btn" href="#" onclick="medDicomOpen(${d.id}, ${JSON.stringify(d.name).replace(/"/g, '&quot;')}); return false;">🩻 View slices</a>`
    : isImage
    ? `<a class="med-link-btn" href="#" onclick="medViewImage(${d.id}, ${JSON.stringify(d.name).replace(/"/g, '&quot;')}); return false;">👁 Open</a>`
    : `<a class="med-link-btn" href="/api/medical/documents/${d.id}/file" target="_blank">👁 Open</a>`;
  return `<div class="med-list-card" id="med-doc-row-${d.id}">
    <div style="display:flex; gap:10px; align-items:flex-start;">
      ${thumb}
      <div style="flex:1; min-width:0;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <span class="med-chip type-${esc(d.doc_type)}">${esc(DOC_TYPE_LABELS[d.doc_type] || d.doc_type)}</span>
          <h3 style="margin:0; flex:1; overflow:hidden; text-overflow:ellipsis;">${esc(d.name)}</h3>
          ${openBtn}
          <a class="med-link-btn" href="/api/medical/documents/${d.id}/file?download=1">⬇ Download</a>
          <button class="btn btn-secondary btn-sm" onclick="medEditDoc(${d.id})">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="medDeleteDoc(${d.id})">✕</button>
        </div>
        ${d.doctor_name   ? `<div class="med-meta">👨‍⚕ ${esc(d.doctor_name)}</div>`   : ''}
        ${d.producer_name ? `<div class="med-meta">🏥 ${esc(d.producer_name)} (${esc(d.producer_kind)})</div>` : ''}
        ${d.doc_date      ? `<div class="med-meta">📅 ${esc(d.doc_date)}</div>` : ''}
        <div class="med-meta">${esc(d.mime_type)} · ${size}</div>
        ${d.notes ? `<div style="margin-top:4px; font-size:0.84rem;">${esc(d.notes)}</div>` : ''}
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// Image viewer — pan + zoom for uploaded image docs. PDFs still
// open in a new browser tab (browser handles PDFs natively).
// ══════════════════════════════════════════════════════════════
let _viewerScale = 1, _viewerX = 0, _viewerY = 0;
let _viewerDragging = false, _vsx, _vsy, _vstx, _vsty;
let _viewerWired = false;

window.medViewImage = function (id, name) {
  const modal = document.getElementById('med-viewer-modal');
  const img   = document.getElementById('med-viewer-img');
  const ttl   = document.getElementById('med-viewer-title');
  ttl.textContent  = name || ('Document ' + id);
  ttl.dataset.docId = String(id);   // read by medViewerRecrop
  img.onload = () => medViewerFit();
  img.src = '/api/medical/documents/' + id + '/file';
  modal.style.display = 'block';
  _wireViewer();
};

window.medViewerClose = function () {
  document.getElementById('med-viewer-modal').style.display = 'none';
  document.getElementById('med-viewer-img').src = '';   // free memory
};

window.medViewerFit = function () {
  const wrap = document.getElementById('med-viewer-canvas-wrap');
  const img  = document.getElementById('med-viewer-img');
  if (!img.naturalWidth) return;
  const sw = wrap.clientWidth;
  const sh = wrap.clientHeight;
  _viewerScale = Math.min(sw / img.naturalWidth, sh / img.naturalHeight) * 0.96;
  _viewerX = (sw - img.naturalWidth  * _viewerScale) / 2;
  _viewerY = (sh - img.naturalHeight * _viewerScale) / 2;
  _renderViewer();
};

window.medViewerZoomIn  = function () { _zoomViewerAt(1.25); };
window.medViewerZoomOut = function () { _zoomViewerAt(0.8);  };

// ══════════════════════════════════════════════════════════════
// Re-crop — opens a separate modal pre-loaded with the doc's image,
// lets the user pick a new crop rectangle, PATCHes the cropped JPEG
// back to /api/medical/documents/:id/file. Reuses the same crop
// helpers (_renderCrop / _wireCropHandlers / _hitTest) by feeding
// them through the recrop canvas + redirected globals.
// ══════════════════════════════════════════════════════════════
let _recropDocId   = null;
let _recropDocName = '';

window.medViewerRecrop = function () {
  const img = document.getElementById('med-viewer-img');
  if (!img || !img.naturalWidth) { alert('Image not loaded yet'); return; }
  // Stash full-res image into _origCanvas (the same global the camera-capture
  // crop helpers read). Note: img.src is the /file endpoint — same-origin so
  // canvas isn't tainted; we can extract bytes later via toBlob().
  _origCanvas = document.createElement('canvas');
  _origCanvas.width  = img.naturalWidth;
  _origCanvas.height = img.naturalHeight;
  _origCanvas.getContext('2d').drawImage(img, 0, 0);
  _recropDocId   = parseInt(document.getElementById('med-viewer-title').dataset.docId || '0');
  _recropDocName = document.getElementById('med-viewer-title').textContent;
  document.getElementById('med-recrop-title').textContent = 'Re-crop — ' + _recropDocName;
  // Hide viewer, show recrop modal.
  document.getElementById('med-viewer-modal').style.display = 'none';
  document.getElementById('med-recrop-modal').style.display = 'block';
  _initRecropCanvas();
};

function _initRecropCanvas() {
  const c = document.getElementById('med-recrop-canvas');
  // Pick the largest crop-canvas size that fits in viewport, preserving image
  // aspect ratio. Crop rect coordinates are in canvas-display space; the
  // existing crop helpers handle the rest.
  const wrap = c.parentElement;
  const maxW = wrap.clientWidth  - 20;
  const maxH = wrap.clientHeight - 20;
  const ar  = _origCanvas.width / _origCanvas.height;
  let w = maxW, h = maxW / ar;
  if (h > maxH) { h = maxH; w = maxH * ar; }
  c.width  = Math.round(w);
  c.height = Math.round(h);
  // Initialise crop to cover the whole image, then render + wire handlers.
  _cropRect = { x: 0, y: 0, w: c.width, h: c.height };
  // Temporarily point the rendering target at this canvas. The shared helper
  // reads `document.getElementById('med-cam-canvas')` — we shim by giving the
  // recrop canvas that id while it's in use.
  const camCanvas = document.getElementById('med-cam-canvas');
  c.dataset.prevId = c.id;
  if (camCanvas) camCanvas.id = 'med-cam-canvas-PARKED';
  c.id = 'med-cam-canvas';
  _renderCrop();
  _wireCropHandlers(c);
}

function _restoreCanvasIds() {
  const cur = document.getElementById('med-cam-canvas');
  if (cur && cur.id === 'med-cam-canvas' && cur.dataset.prevId) {
    cur.id = cur.dataset.prevId;
    delete cur.dataset.prevId;
  }
  const parked = document.getElementById('med-cam-canvas-PARKED');
  if (parked) parked.id = 'med-cam-canvas';
}

window.medRecropCancel = function () {
  document.getElementById('med-recrop-modal').style.display = 'none';
  _restoreCanvasIds();
  _origCanvas = null;
  _cropRect = null;
  _imgRect = null;
};

window.medRecropApply = async function () {
  const btn = document.getElementById('med-recrop-apply-btn');
  if (!_recropDocId || !_origCanvas || !_cropRect) return;
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const blob = await _getCroppedBlob();
    if (!blob) throw new Error('failed to build cropped blob');
    const fd = new FormData();
    fd.append('file', new File([blob], _recropDocName + '.jpg', { type: 'image/jpeg' }));
    const r = await fetch('/api/medical/documents/' + _recropDocId + '/file', {
      method: 'PATCH', body: fd,
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    // Close recrop, refresh docs list, re-open viewer with new image.
    document.getElementById('med-recrop-modal').style.display = 'none';
    _restoreCanvasIds();
    _origCanvas = null;
    _cropRect = null;
    _imgRect = null;
    await medFetchDocuments();
    // Re-open the viewer with cache-busting query so the new bytes load.
    const img = document.getElementById('med-viewer-img');
    img.src = '/api/medical/documents/' + _recropDocId + '/file?t=' + Date.now();
    img.onload = () => medViewerFit();
    document.getElementById('med-viewer-modal').style.display = 'block';
  } catch (e) {
    alert('Re-crop failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Apply & replace';
  }
};

function _zoomViewerAt(factor) {
  // Zoom around the canvas centre so the same point stays under the cursor-equivalent.
  const wrap = document.getElementById('med-viewer-canvas-wrap');
  const cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2;
  const oldS = _viewerScale;
  _viewerScale *= factor;
  // Adjust pan so the centre point stays at the centre.
  _viewerX = cx - (cx - _viewerX) * (_viewerScale / oldS);
  _viewerY = cy - (cy - _viewerY) * (_viewerScale / oldS);
  _renderViewer();
}

function _renderViewer() {
  const img = document.getElementById('med-viewer-img');
  img.style.transform = `translate(${_viewerX}px, ${_viewerY}px) scale(${_viewerScale})`;
}

function _wireViewer() {
  if (_viewerWired) return;
  _viewerWired = true;
  const wrap = document.getElementById('med-viewer-canvas-wrap');
  wrap.addEventListener('mousedown', e => {
    _viewerDragging = true;
    _vsx = e.clientX; _vsy = e.clientY;
    _vstx = _viewerX; _vsty = _viewerY;
    wrap.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!_viewerDragging) return;
    _viewerX = _vstx + (e.clientX - _vsx);
    _viewerY = _vsty + (e.clientY - _vsy);
    _renderViewer();
  });
  document.addEventListener('mouseup', () => {
    if (!_viewerDragging) return;
    _viewerDragging = false;
    wrap.style.cursor = 'grab';
  });
  wrap.addEventListener('wheel', e => {
    if (document.getElementById('med-viewer-modal').style.display === 'none') return;
    e.preventDefault();
    // Zoom toward the cursor — feels much better than centre-zoom.
    const r = wrap.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const oldS = _viewerScale;
    _viewerScale *= (e.deltaY < 0 ? 1.1 : 0.9);
    _viewerX = cx - (cx - _viewerX) * (_viewerScale / oldS);
    _viewerY = cy - (cy - _viewerY) * (_viewerScale / oldS);
    _renderViewer();
  }, { passive: false });
  document.addEventListener('keydown', e => {
    if (document.getElementById('med-viewer-modal').style.display === 'none') return;
    if (e.key === 'Escape')      medViewerClose();
    else if (e.key === '+' || e.key === '=') medViewerZoomIn();
    else if (e.key === '-')      medViewerZoomOut();
    else if (e.key === '0')      medViewerFit();
  });
}

// Brief yellow-flash + scroll-into-view on a doc row — used right after
// upload so the user can see exactly which row is the new one.
function _highlightDoc(id) {
  const row = document.getElementById('med-doc-row-' + id);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const orig = row.style.background;
  row.style.transition = 'background 0.6s';
  row.style.background = '#fff8b3';
  setTimeout(() => { row.style.background = orig || ''; }, 1800);
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
  _pickedFile = null;
  // Reset the drop-zone's hidden input so picking the SAME file twice in a
  // row still fires onchange (browsers debounce identical filenames).
  const inp = document.getElementById('med-drop-input');
  if (inp) inp.value = '';
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
    ${editing ? '' : (mode === 'picked' && _pickedFile
      ? `<div class="med-form-row"><label>File</label><span style="font-size:0.88rem;">📎 ${esc(_pickedFile.name)} (${_fmtSize(_pickedFile.size)})</span></div>`
      : mode === 'pdf'
      ? `<div class="med-form-row"><label>File</label><input type="file" id="df-file" accept="application/pdf,image/jpeg,image/png,image/heic,image/webp,application/zip,application/x-zip-compressed,.zip" onchange="medFillNameFromFile()"></div>`
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
let _origCanvas   = null;   // hidden full-res snapshot
let _imgRect      = null;   // {x,y,w,h,scale} — image-on-canvas placement
let _cropRect     = null;   // {x,y,w,h} crop region in canvas-display coords
const _VIEW_W = 960, _VIEW_H = 640;
const _HANDLE = 12;

// Redraw: black background, image fit-to-canvas, dim overlay outside crop,
// yellow crop border + 4 corner handles. Called on every drag tick.
function _renderCrop() {
  if (!_origCanvas) return;
  const c   = document.getElementById('med-cam-canvas');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const scale = Math.min(c.width / _origCanvas.width, c.height / _origCanvas.height);
  const w     = _origCanvas.width  * scale;
  const h     = _origCanvas.height * scale;
  const x     = (c.width  - w) / 2;
  const y     = (c.height - h) / 2;
  ctx.drawImage(_origCanvas, x, y, w, h);
  _imgRect = { x, y, w, h, scale };
  // Dim overlay outside the crop rectangle (4 strips).
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, c.width, _cropRect.y);
  ctx.fillRect(0, _cropRect.y + _cropRect.h, c.width, c.height - (_cropRect.y + _cropRect.h));
  ctx.fillRect(0, _cropRect.y, _cropRect.x, _cropRect.h);
  ctx.fillRect(_cropRect.x + _cropRect.w, _cropRect.y, c.width - (_cropRect.x + _cropRect.w), _cropRect.h);
  // Crop border
  ctx.strokeStyle = '#ffd400';
  ctx.lineWidth = 2;
  ctx.strokeRect(_cropRect.x + 1, _cropRect.y + 1, _cropRect.w - 2, _cropRect.h - 2);
  // 4 corner handles
  ctx.fillStyle = '#ffd400';
  for (const [cx, cy] of [
    [_cropRect.x,                 _cropRect.y                ],
    [_cropRect.x + _cropRect.w,   _cropRect.y                ],
    [_cropRect.x,                 _cropRect.y + _cropRect.h  ],
    [_cropRect.x + _cropRect.w,   _cropRect.y + _cropRect.h  ],
  ]) {
    ctx.fillRect(cx - _HANDLE/2, cy - _HANDLE/2, _HANDLE, _HANDLE);
  }
}

window.medResetCrop = function () {
  if (!_origCanvas) return;
  const c = document.getElementById('med-cam-canvas');
  const scale = Math.min(c.width / _origCanvas.width, c.height / _origCanvas.height);
  const w = _origCanvas.width  * scale;
  const h = _origCanvas.height * scale;
  const x = (c.width  - w) / 2;
  const y = (c.height - h) / 2;
  _cropRect = { x, y, w, h };
  _renderCrop();
};

// Return which control region the (canvas-local) point hits:
// 'nw'|'ne'|'sw'|'se' for resize-corner handles, 'move' for inside the
// crop rectangle, null otherwise.
function _hitTest(px, py) {
  if (!_cropRect) return null;
  const corners = {
    nw: [_cropRect.x,               _cropRect.y              ],
    ne: [_cropRect.x + _cropRect.w, _cropRect.y              ],
    sw: [_cropRect.x,               _cropRect.y + _cropRect.h],
    se: [_cropRect.x + _cropRect.w, _cropRect.y + _cropRect.h],
  };
  for (const [name, [cx, cy]] of Object.entries(corners)) {
    if (Math.abs(px - cx) <= _HANDLE && Math.abs(py - cy) <= _HANDLE) return name;
  }
  if (px >= _cropRect.x && px <= _cropRect.x + _cropRect.w &&
      py >= _cropRect.y && py <= _cropRect.y + _cropRect.h) return 'move';
  return null;
}

function _wireCropHandlers(c) {
  let mode = null;                  // 'move' | 'nw'|'ne'|'sw'|'se'
  let startX, startY, startRect;
  const localXY = e => {
    const r = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return [(t.clientX - r.left) * (c.width / r.width),
            (t.clientY - r.top)  * (c.height / r.height)];
  };
  const updateCursor = (px, py) => {
    const hit = _hitTest(px, py);
    c.style.cursor =
      hit === 'nw' || hit === 'se' ? 'nwse-resize' :
      hit === 'ne' || hit === 'sw' ? 'nesw-resize' :
      hit === 'move'                ? 'move'        : 'default';
  };
  const onDown = e => {
    const [px, py] = localXY(e);
    mode = _hitTest(px, py);
    if (!mode) return;
    startX = px; startY = py;
    startRect = { ..._cropRect };
    if (e.cancelable) e.preventDefault();
  };
  const onMove = e => {
    const [px, py] = localXY(e);
    if (!mode) { updateCursor(px, py); return; }
    if (e.cancelable) e.preventDefault();
    const dx = px - startX;
    const dy = py - startY;
    let nx = startRect.x, ny = startRect.y, nw = startRect.w, nh = startRect.h;
    if (mode === 'move') { nx += dx; ny += dy; }
    else if (mode === 'nw') { nx += dx; ny += dy; nw -= dx; nh -= dy; }
    else if (mode === 'ne') {           ny += dy; nw += dx; nh -= dy; }
    else if (mode === 'sw') { nx += dx;           nw -= dx; nh += dy; }
    else if (mode === 'se') {                     nw += dx; nh += dy; }
    // Clamp to canvas bounds + minimum 30px size.
    if (nw < 30 || nh < 30) return;
    nx = Math.max(0, Math.min(c.width  - nw, nx));
    ny = Math.max(0, Math.min(c.height - nh, ny));
    nw = Math.min(nw, c.width  - nx);
    nh = Math.min(nh, c.height - ny);
    _cropRect = { x: nx, y: ny, w: nw, h: nh };
    _renderCrop();
  };
  const onUp = () => { mode = null; };
  c.addEventListener('mousedown',  onDown);
  c.addEventListener('mousemove',  onMove);
  c.addEventListener('mouseup',    onUp);
  c.addEventListener('mouseleave', onUp);
  c.addEventListener('touchstart', onDown, { passive: false });
  c.addEventListener('touchmove',  onMove, { passive: false });
  c.addEventListener('touchend',   onUp);
}

// Build the final cropped JPEG by mapping the canvas-display crop rect
// back to original-image pixel coordinates. Returns a Promise<Blob>.
function _getCroppedBlob() {
  return new Promise(resolve => {
    if (!_origCanvas || !_cropRect || !_imgRect) return resolve(null);
    const sx = (_cropRect.x - _imgRect.x) / _imgRect.scale;
    const sy = (_cropRect.y - _imgRect.y) / _imgRect.scale;
    const sw = _cropRect.w / _imgRect.scale;
    const sh = _cropRect.h / _imgRect.scale;
    const out = document.createElement('canvas');
    out.width  = Math.round(sw);
    out.height = Math.round(sh);
    out.getContext('2d').drawImage(_origCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    out.toBlob(resolve, 'image/jpeg', 0.85);
  });
}

window.medCameraSnap = function () {
  const v = document.getElementById('med-cam-video');
  const c = document.getElementById('med-cam-canvas');
  // 1) Stash full-res frame offscreen — the source for every render.
  _origCanvas = document.createElement('canvas');
  _origCanvas.width  = v.videoWidth;
  _origCanvas.height = v.videoHeight;
  _origCanvas.getContext('2d').drawImage(v, 0, 0);
  // 2) Resize the visible canvas + show it in place of the live video.
  c.width  = _VIEW_W;
  c.height = _VIEW_H;
  c.style.display = 'block';
  v.style.display = 'none';
  medResetCrop();
  _wireCropHandlers(c);
  _stopCamera();
  // 3) Swap the button row: crop controls + Re-snap + Cancel. The actual
  //    upload blob is computed by _getCroppedBlob() at upload time.
  const btns = document.querySelector('#med-camera-stage .cam-btns');
  if (btns) {
    btns.innerHTML = `
      <button class="btn btn-secondary btn-sm" onclick="medResetCrop()" title="Reset crop to full image">↺ Reset</button>
      <button class="btn btn-secondary btn-sm" onclick="medOpenDocForm('camera')">↻ Re-snap</button>
      <button class="btn btn-secondary btn-sm" onclick="medCameraCancel()">Cancel</button>`;
  }
  let help = document.getElementById('med-cam-help');
  if (!help) {
    help = document.createElement('div');
    help.id = 'med-cam-help';
    help.className = 'zoom-help';
    const diag = document.getElementById('med-cam-diag');
    if (diag) diag.before(help); else document.getElementById('med-camera-stage').appendChild(help);
  }
  help.textContent = 'Drag the yellow corners to size the crop · drag inside to move · everything outside the box is discarded on Upload.';
  const picker = document.getElementById('med-cam-picker');
  if (picker) picker.disabled = true;
  _capturedBlob = true;   // truthy sentinel — actual bytes built at upload
};
window.medCameraCancel = function () {
  _stopCamera();
  _capturedBlob = null;
  _origCanvas   = null;
  _imgRect      = null;
  _cropRect     = null;
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
  if (_pickedFile) {
    file = _pickedFile;
  } else if (document.getElementById('df-file') && document.getElementById('df-file').files[0]) {
    file = document.getElementById('df-file').files[0];
  } else if (_capturedBlob && _origCanvas) {
    // Build the final JPEG by extracting the user's crop rectangle from
    // the original full-res frame at upload time (sharper than re-encoding
    // the on-screen canvas, which is downscaled to viewport size).
    const blob = await _getCroppedBlob();
    if (!blob) { errEl.textContent = 'Failed to serialize cropped image'; return; }
    file = new File([blob], (name || 'capture') + '.jpg', { type: 'image/jpeg' });
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
    prog.innerHTML = `✓ Uploaded — see "📁 Uploaded documents" below`;
    setTimeout(() => { prog.style.display = 'none'; }, 2400);
    _capturedBlob = null;
    medCloseDocForm();
    await medFetchDocuments();
    // Scroll + flash the new row so the user can immediately see it.
    if (r.id) _highlightDoc(r.id);
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
