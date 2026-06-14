// Privacy → Doc Create tab.
//
// Template-driven document generator + visual e-signature, all client-side.
// Build a styled (RTL Hebrew) document from a form, add an electronic-signature
// box + optional hand-drawn signature, then either PRINT it to PDF (the browser's
// native print engine — html2canvas was removed; it mangled RTL Hebrew) or save a
// DOCX ("Google Doc"; html-docx-js) into a chosen site's encrypted/plain Docs
// (reuses privacy.js crypto).
//
// Extensible: add a template by adding an entry to PVDC_TEMPLATES (fields + an
// html(data, sigHtml) renderer). "Bank Transfer" is the first one.

let _pvdcSigPad = null;

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
      <div style="font-family:'Segoe UI',Arial,sans-serif; color:#333333; direction:rtl; text-align:right; font-size:13px; line-height:1.45;">
        <div style="background:#2b4c7e; color:#ffffff; text-align:center; font-size:20px; font-weight:700; padding:11px 10px; border-radius:6px; margin-bottom:12px;">${_pvdcEsc(d.title)}</div>
        <div style="color:#64748b; font-size:12px; margin-bottom:11px;"><span style="font-weight:700;">תאריך:</span> ${_pvdcDateHe(d.date)}</div>
        <div style="font-weight:700; margin-bottom:6px;">לכבוד,<br>מחלקת העברות בנקאיות</div>
        <div style="margin-bottom:11px;">אני החתום/ה מטה מבקש/ת לבצע העברה בנקאית מחשבוני, בהתאם לפרטים המפורטים בטבלה שלהלן:</div>
        <div style="border-top:1px solid #e0e0e0; font-size:13px; margin-bottom:13px;">
          ${_pvdcRow('שם המבקש', d.requester_name)}
          ${_pvdcRow('תעודת זהות', d.id_number)}
          ${_pvdcRow('מוטב (העברה לטובת)', d.beneficiary)}
          ${_pvdcRow('פרטי בנק היעד', d.target_bank)}
          ${_pvdcRow('סניף', d.branch)}
          ${_pvdcRow('מספר חשבון', d.account_number)}
          ${_pvdcRow('סכום ההעברה', (d.amount || '—') + (d.amount_words ? ` (${d.amount_words})` : ''), true)}
          ${_pvdcRow('מטרת ההעברה', d.purpose)}
        </div>
        <div style="margin-bottom:11px;">אבקש לבצע את ההעברה בהקדם. תודה על הטיפול.</div>
        <div style="font-weight:700; margin-bottom:4px;">בברכה,</div>
        ${sigHtml}
      </div>`,
  },
};
// Flex-div "table" — html2canvas mis-renders <table> + border-collapse (phantom row
// gaps that bloat the doc to 2 pages). Divs render reliably. In RTL the first child
// (label) sits on the right; the label's border-left is the internal column divider.
function _pvdcRow(label, value, hi) {
  return `<div style="display:flex; border:1px solid #e0e0e0; border-top:none;">
    <div style="flex:0 0 40%; font-weight:700; color:#2b4c7e; background:#f4f7fa; padding:8px 12px; box-sizing:border-box; border-left:1px solid #e0e0e0;">${_pvdcEsc(label)}</div>
    <div style="flex:1; padding:8px 12px; box-sizing:border-box; ${hi ? 'font-weight:700; color:#b13d3d;' : 'color:#333333;'}">${_pvdcEsc(value == null || value === '' ? '—' : String(value))}</div>
  </div>`;
}

// ── E-signature box: ONLY the label + the hand-drawn signature (if drawn) ─────
function _pvdcSignatureHtml() {
  const drawn = (_pvdcSigPad && !_pvdcSigPad.isEmpty())
    ? `<img src="${_pvdcSigPad.toDataURL('image/png')}" style="max-height:80px;">`
    : '<div style="height:46px;"></div>'; // empty signing space
  return `
    <div class="pvdc-sigbox" style="width:340px; margin:12px auto 0; border:2px dashed #2b4c7e; text-align:center;">
      <div style="font-size:11px; font-weight:700; color:#2b4c7e; letter-spacing:.4px; padding:8px 10px; border-bottom:1px solid #e0e0e0;">חתימה אלקטרונית / ELECTRONIC SIGNATURE</div>
      <div style="padding:9px 10px 11px;">${drawn}</div>
    </div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _pvdcEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
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
    `<label style="display:flex; flex-direction:column; font-size:0.78rem; color:#64748b; gap:3px; margin-bottom:7px;">${f.label}
      <input id="pvdc-f-${f.id}" type="${f.type}" ${f.type === 'date' ? `value="${iso}"` : ''} placeholder="${f.placeholder || ''}"
        oninput="pvdcRenderPreview()" style="font-size:0.9rem; padding:5px 7px; border:1px solid #ccc; border-radius:4px;"></label>`).join('');
  pvdcRenderPreview();
}
function pvdcRenderPreview() {
  const d = _pvdcFields();
  const sig = _pvdcSignatureHtml();
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

// ── DOCX blob ("Google Doc" — opens in Google Docs / Word) ──────────────────
// html2canvas (any mode) is REMOVED: on RTL Hebrew it produced cut / clipped / BLANK
// PDFs. Two reliable engines remain: html-docx-js (a real DOCX blob, never empty) for
// save-to-site, and the browser's native print (pvdcPrint) for a pixel-perfect PDF to
// disk. A correct PDF *blob* can't be produced reliably client-side, so a PDF is
// obtained via Print → "Save as PDF"; sites store the editable DOCX.
function _pvdcFmt() { return (document.querySelector('input[name="pvdc-fmt"]:checked') || {}).value || 'pdf'; }
function _pvdcDocxBlob() {
  const d = _pvdcFields();
  if (!d.requester_name) throw new Error('Fill the requester name first');
  const baseName = (PVDC_TEMPLATES[_pvdcKind()].fileName(d) || 'document');
  const innerHtml = PVDC_TEMPLATES[_pvdcKind()].html(d, _pvdcSignatureHtml());
  const full = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body dir="rtl" style="font-family:Arial,sans-serif;">${innerHtml}</body></html>`;
  const blob = window.htmlDocx.asBlob(full);
  if (!blob || !blob.size) throw new Error('DOCX generation produced an empty file');
  return { blob, ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: baseName + '.docx' };
}

// ── Print / Save as PDF (native — bulletproof RTL + colors via the browser engine) ─
function pvdcPrint() {
  const st = document.getElementById('pvdc-status');
  const d = _pvdcFields();
  if (!d.requester_name) { st.textContent = '✗ Fill the requester name first'; return; }
  const inner = PVDC_TEMPLATES[_pvdcKind()].html(d, _pvdcSignatureHtml());
  const w = window.open('', '_blank');
  if (!w) { st.textContent = '✗ pop-up blocked — allow pop-ups to print'; return; }
  w.document.open();
  w.document.write('<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>' + _pvdcEsc(d.title) + '</title>'
    + '<style>*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;} @page{size:A4;margin:16mm;} html,body{margin:0;} body{font-family:"Segoe UI",Arial,sans-serif;background:#fdfbf7;} .pvdc-print-bar{text-align:center;margin:22px 0;} @media print{.pvdc-print-bar{display:none;}}</style>'
    + '</head><body><div style="max-width:760px;margin:0 auto;">' + inner + '</div>'
    + '<div class="pvdc-print-bar"><button onclick="window.print()" style="padding:8px 18px;font-size:14px;cursor:pointer;">🖨 Print / Save as PDF</button></div>'
    + '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},350);};</scr' + 'ipt>'
    + '</body></html>');
  w.document.close();
  st.textContent = '🖨 opened print view — choose “Save as PDF”';
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
  if (_pvdcFmt() === 'pdf') {
    st.textContent = '⚠ For a PDF use 🖨 Print → “Save as PDF”. To save into a site, switch Format to Google Doc (DOCX).';
    return;
  }
  const enc = document.getElementById('pvdc-enc').checked;
  st.textContent = 'Generating…';
  try {
    const g = _pvdcDocxBlob();
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
