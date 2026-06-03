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
