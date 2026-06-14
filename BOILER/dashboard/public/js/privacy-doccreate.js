// Privacy → Doc Create tab.
//
// Template-driven document generator + visual e-signature, all client-side.
// Build a styled (RTL Hebrew) document from a form, add an electronic-signature
// box + optional hand-drawn signature, then export to PDF (html2pdf) or DOCX
// ("Google Doc" — opens in Google Docs/Word; html-docx-js) and either download
// or save into a chosen site's encrypted/plain Docs (reuses privacy.js crypto).
//
// Extensible: add a template by adding an entry to PVDC_TEMPLATES (fields + an
// html(data, sigHtml) renderer). "Bank Transfer" is the first one.

let _pvdcSigPad = null;
let _pvdcLastBlob = null;     // {blob, ext, mime} of the last generated doc

// ── Templates ────────────────────────────────────────────────────────────────
const PVDC_TEMPLATES = {
  bank_transfer: {
    label: 'Bank Transfer · בקשה להעברה בנקאית',
    fields: [
      { id: 'date',           label: 'Date',                type: 'date' },
      { id: 'requester_name', label: 'Requester name · שם המבקש',          type: 'text' },
      { id: 'id_number',      label: 'ID number · תעודת זהות',             type: 'text' },
      { id: 'beneficiary',    label: 'Beneficiary · מוטב (העברה לטובת)',   type: 'text' },
      { id: 'target_bank',    label: 'Target bank · פרטי בנק היעד',        type: 'text', placeholder: 'בנק הפועלים (קוד בנק 12)' },
      { id: 'branch',         label: 'Branch · סניף',                      type: 'text' },
      { id: 'account_number', label: 'Account number · מספר חשבון',        type: 'text' },
      { id: 'amount',         label: 'Amount · סכום ההעברה',               type: 'text', placeholder: '300,000 ₪' },
      { id: 'amount_words',   label: 'Amount in words · סכום במילים',      type: 'text', placeholder: 'שלוש מאות אלף שקלים חדשים' },
      { id: 'purpose',        label: 'Purpose · מטרת ההעברה',              type: 'text' },
    ],
    title: 'בקשה לביצוע העברה בנקאית',
    fileName: d => `bank_transfer_${(d.requester_name || 'doc').replace(/\s+/g, '_')}`,
    html: (d, sigHtml) => `
      <div style="font-family:'Segoe UI',Arial,sans-serif; color:#2b2b2b; direction:rtl; text-align:right;">
        <div style="text-align:center; color:#1f3a5f; font-size:24px; font-weight:700; padding-bottom:8px; border-bottom:2px solid #1f3a5f; margin-bottom:18px;">${_pvdcEsc(d.title)}</div>
        <div style="color:#666; font-size:13px; margin-bottom:14px;">תאריך: ${_pvdcDateHe(d.date)}</div>
        <div style="font-weight:700; margin-bottom:10px;">לכל מאן דבעי,</div>
        <div style="margin-bottom:16px; line-height:1.6;">אני החתום מטה מבקש לבצע העברה בנקאית מחשבוני בהתאם לפרטים המפורטים להלן:</div>
        <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:18px;">
          ${_pvdcRow('שם המבקש', d.requester_name)}
          ${_pvdcRow('תעודת זהות', d.id_number)}
          ${_pvdcRow('מוטב (העברה לטובת)', d.beneficiary)}
          ${_pvdcRow('פרטי בנק היעד', d.target_bank)}
          ${_pvdcRow('סניף', d.branch)}
          ${_pvdcRow('מספר חשבון', d.account_number)}
          ${_pvdcRow('סכום ההעברה', (d.amount || '') + (d.amount_words ? ` <span style="color:#a82a1f;">(${_pvdcEsc(d.amount_words)})</span>` : ''), true)}
          ${_pvdcRow('מטרת ההעברה', d.purpose)}
        </table>
        <div style="margin:18px 0 10px;">בברכה,</div>
        ${sigHtml}
      </div>`,
  },
};
function _pvdcRow(label, value, hi) {
  return `<tr style="border-bottom:1px solid #eee;">
    <td style="padding:7px 10px; font-weight:700; color:#1f3a5f; width:42%;">${_pvdcEsc(label)}:</td>
    <td style="padding:7px 10px; ${hi ? 'font-weight:700;' : ''}">${value || ''}</td></tr>`;
}

// ── E-signature box (matches the example) + optional hand-drawn image ─────────
function _pvdcSignatureHtml(name, id) {
  const ts = _pvdcNow();
  const drawn = (_pvdcSigPad && !_pvdcSigPad.isEmpty())
    ? `<div style="text-align:center; margin-top:10px;"><img src="${_pvdcSigPad.toDataURL('image/png')}" style="max-height:90px;"></div>` : '';
  return `
    <div style="max-width:340px; margin:12px auto 0; padding:12px 16px; border:2px dashed #6b7a99; border-radius:8px; text-align:center;">
      <div style="font-size:11px; font-weight:700; color:#1f3a5f; letter-spacing:.4px;">חתימה אלקטרונית / ELECTRONIC SIGNATURE</div>
      <div style="border-top:1px solid #cfd6e4; margin:8px 0;"></div>
      <div style="font-family:'Segoe Script','Brush Script MT',cursive; font-size:26px; color:#1f3a5f;">${_pvdcEsc(name || '—')}</div>
      <div style="font-size:10px; color:#777; line-height:1.5; margin-top:6px;">
        נחתם דיגיטלית ע"י: ${_pvdcEsc(name || '')}<br>
        תעודת זהות: ${_pvdcEsc(id || '')}<br>
        תאריך ושעה: ${ts} IDT<br>
        סטטוס: מאושר / CONFIRMED
      </div>
    </div>${drawn}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _pvdcEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _pvdcNow() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function _pvdcDateHe(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00'); if (isNaN(d)) return iso;
  const months = ['בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני', 'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function _pvdcFields() {
  const data = {};
  (PVDC_TEMPLATES[_pvdcKind()].fields).forEach(f => { const el = document.getElementById('pvdc-f-' + f.id); data[f.id] = el ? el.value.trim() : ''; });
  data.title = PVDC_TEMPLATES[_pvdcKind()].title;
  return data;
}
function _pvdcKind() { return document.getElementById('pvdc-kind').value; }

// ── Tab lifecycle ────────────────────────────────────────────────────────────
function pvdcOnShow() {
  pvdcRenderForm();
  pvdcInitSigPad();
  pvdcFillSites();
}
function pvdcKindChanged() { pvdcRenderForm(); pvdcRenderPreview(); }
function pvdcRenderForm() {
  const t = PVDC_TEMPLATES[_pvdcKind()];
  const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  document.getElementById('pvdc-form').innerHTML = t.fields.map(f =>
    `<label style="display:flex; flex-direction:column; font-size:0.78rem; color:#555; gap:3px; margin-bottom:7px;">${f.label}
      <input id="pvdc-f-${f.id}" type="${f.type}" ${f.type === 'date' ? `value="${iso}"` : ''} placeholder="${f.placeholder || ''}"
        oninput="pvdcRenderPreview()" style="font-size:0.9rem; padding:5px 7px; border:1px solid #ccc; border-radius:4px;"></label>`).join('');
  pvdcRenderPreview();
}
function pvdcRenderPreview() {
  const d = _pvdcFields();
  const sig = _pvdcSignatureHtml(d.requester_name, d.id_number);
  const inner = PVDC_TEMPLATES[_pvdcKind()].html(d, sig);
  document.getElementById('pvdc-preview').innerHTML = inner;
}

// ── Signature pad ────────────────────────────────────────────────────────────
function pvdcInitSigPad() {
  const c = document.getElementById('pvdc-sigpad');
  if (!c || _pvdcSigPad) return;
  _pvdcSigPad = new SignaturePad(c, { penColor: '#15235c', backgroundColor: 'rgba(255,255,255,0)' });
  _pvdcSigPad.addEventListener('endStroke', pvdcRenderPreview);
}
function pvdcClearSig() { if (_pvdcSigPad) { _pvdcSigPad.clear(); pvdcRenderPreview(); } }

// ── Generate the document blob in the chosen format ──────────────────────────
function _pvdcFmt() { return (document.querySelector('input[name="pvdc-fmt"]:checked') || {}).value || 'pdf'; }
async function _pvdcGenerate() {
  const d = _pvdcFields();
  if (!d.requester_name) throw new Error('Fill the requester name first');
  const preview = document.getElementById('pvdc-preview');
  const baseName = (PVDC_TEMPLATES[_pvdcKind()].fileName(d) || 'document');
  const fmt = _pvdcFmt();
  if (fmt === 'pdf') {
    const worker = html2pdf().set({
      margin: 12, filename: baseName + '.pdf', image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    }).from(preview);
    const blob = await worker.outputPdf('blob');
    return { blob, ext: 'pdf', mime: 'application/pdf', name: baseName + '.pdf' };
  } else {
    const full = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body dir="rtl" style="font-family:Arial,sans-serif;">${preview.innerHTML}</body></html>`;
    const blob = window.htmlDocx.asBlob(full);
    return { blob, ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: baseName + '.docx' };
  }
}

// ── Download ─────────────────────────────────────────────────────────────────
async function pvdcDownload() {
  const st = document.getElementById('pvdc-status');
  st.textContent = 'Generating…';
  try {
    const g = await _pvdcGenerate();
    const url = URL.createObjectURL(g.blob);
    const a = document.createElement('a'); a.href = url; a.download = g.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    st.textContent = '✓ downloaded ' + g.name;
  } catch (e) { st.textContent = '✗ ' + e.message; }
}

// ── Save into a chosen site's Docs (encrypted or plain) ──────────────────────
function pvdcFillSites() {
  const sel = document.getElementById('pvdc-site');
  const sites = (typeof _pvSites !== 'undefined' && _pvSites.length) ? _pvSites : [];
  sel.innerHTML = sites.length
    ? sites.map(s => `<option value="${s.id}">${_pvdcEsc(s.name)}</option>`).join('')
    : '<option value="">(no sites — add one in the Sites tab)</option>';
}
async function pvdcSaveToSite() {
  const st = document.getElementById('pvdc-status');
  const siteId = document.getElementById('pvdc-site').value;
  if (!siteId) { st.textContent = '✗ pick a site (add one in the Sites tab first)'; return; }
  const enc = document.getElementById('pvdc-enc').checked;
  st.textContent = 'Generating…';
  try {
    const g = await _pvdcGenerate();
    const fd = new FormData();
    let meta;
    if (enc) {
      if (!(await pvEnsureUnlocked())) { st.textContent = 'Cancelled (Documents password needed)'; return; }
      const bytes = await g.blob.arrayBuffer();
      const encFile = await _pvEncBytes(_pvKey, bytes);
      const encName = await _pvEncStr(_pvKey, g.name + '||' + g.name);
      meta = { encrypted: true, enc_name: encName.ct, name_iv: encName.iv, file_iv: encFile.iv, file_size: encFile.ct.byteLength };
      fd.append('file', new Blob([encFile.ct], { type: 'application/octet-stream' }), 'enc.bin');
    } else {
      meta = { encrypted: false, doc_name: g.name, mime_type: g.mime };
      fd.append('file', g.blob, g.name);
    }
    fd.append('meta', JSON.stringify(meta));
    const r = await fetch(`/api/privacy/sites/${siteId}/docs`, { method: 'POST', body: fd });
    if (!r.ok) { st.textContent = '✗ save failed: ' + (await r.json()).error; return; }
    st.textContent = `✓ saved ${enc ? '🔒 encrypted' : '🔓 plain'} to “${document.getElementById('pvdc-site').selectedOptions[0].textContent}” → Docs`;
    if (typeof pvLoadSites === 'function') pvLoadSites();
  } catch (e) { st.textContent = '✗ ' + e.message; }
}
