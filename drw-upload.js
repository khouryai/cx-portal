// ==========================================
// HITACHI Rail T&C Portal — Drawings: upload a drawing set (drw-upload.js)
//
// Upload Drawing Set modal: pick a PDF → (optionally) calibrate title-block
// boxes → read every page with DrwParse (drw-parse.js) → review → import.
// The review screen shows where each value was read and how sure the reader
// is; clicking text on the drawing fills the focused field, and one click can
// teach that spot to every page of the set.
// Loaded AFTER app.js (uses DRAWING_SETS/DRAWING_SHEETS, modal(), _db*,
// _drawStorage, loadDrawingsData).
// ==========================================

function _drwDisciplineOptions() {
  const opts = [
    ..._fsOptions('drawing_discipline'),
    ...DRAWING_SHEETS.map(s => s.discipline).filter(Boolean),
  ];
  const seen = new Set();
  return opts
    .map(v => String(v || '').trim())
    .filter(v => {
      if (!v) return false;
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function _drwDisciplineListHTML() {
  return `<datalist id="drw-discipline-options">
    ${_drwDisciplineOptions().map(d => `<option value="${escapeHtml(d)}"></option>`).join('')}
  </datalist>`;
}

// Calibration fields (colours match the boxes drawn on the page).
const _DRW_CAL_FIELDS = [
  { key: 'sheetNumber', label: 'Sheet #',  color: '#2563eb' },
  { key: 'pageNumber',  label: 'Page #',   color: '#16a34a' },
  { key: 'sheetTitle',  label: 'Title',    color: '#9333ea' },
  { key: 'revision',    label: 'Revision', color: '#d97706' },
];

// ── Upload Flow ────────────────────────────────────────────────────────────
let _drwUploadMeta    = null;
let _drwParsedSheets  = [];
let _drwUploadPdfDoc  = null;
let _drwFieldRegions   = {};
let _drwCalActiveField = 'sheetNumber';
let _drwCalSel         = { active: false, x0:0, y0:0, x1:0, y1:0 };
let _drwCalPage        = 1;
let _drwCalRendering   = false;
let _drwCalZoom        = 1.0;
let _drwCalPageItems   = [];   // text items for the currently displayed calibration page
const _DRW_CAL_ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6];

function _drwFieldRegionKey(loc, k) { return 'drw_field_' + k + '_' + loc; }
function _drwLoadFieldRegion(loc, k) { try { return JSON.parse(localStorage.getItem(_drwFieldRegionKey(loc, k))); } catch { return null; } }
function _drwSaveFieldRegion(loc, k, r) { localStorage.setItem(_drwFieldRegionKey(loc, k), JSON.stringify(r)); }
function _drwLoadAllFieldRegions(loc) {
  const regs = {};
  _DRW_CAL_FIELDS.forEach(f => { const r = _drwLoadFieldRegion(loc, f.key); if (r) regs[f.key] = r; });
  return regs;
}

function _drwCloseUpload() {
  closeModal();
  _drwUploadMeta = null; _drwParsedSheets = []; _drwUploadPdfDoc = null; _drwFieldRegions = {}; _drwCalActiveField = 'sheetNumber';
  _drwCalPage = 1; _drwCalRendering = false; _drwCalZoom = 1.0;
  _drwRevActiveField = null; _drwRevPhrases = null; _drwRevSpot = null;
}

// from === 'back' when returning from Calibrate (keeps what was entered).
function _drwOpenUpload(from) {
  if (typeof uiCan === 'function' && !uiCan('drawings', 'upload_set')) { toast('You do not have permission to upload drawing sets', 'error'); return; }
  if (from !== 'back') { _drwUploadMeta = null; _drwParsedSheets = []; _drwUploadPdfDoc = null; }
  const locs    = [...new Set([...DRAWING_SETS.map(s=>s.location), ...TI.map(r=>r.Location)].filter(Boolean))].sort();
  const locOpts = locs.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
  const today   = new Date().toISOString().slice(0,10);

  modal({
    title: 'Upload Drawing Set',
    sub:   'Import a multi-page PDF book of plans',
    body: `
      <div class="form-group">
        <label class="form-label">Document Title *</label>
        <input id="drw-title" class="form-input" placeholder="e.g. W40 Electrical Plans Rev B" />
      </div>
      <div class="form-group">
        <label class="form-label">Location *</label>
        <select id="drw-location" class="form-input">
          <option value="">Select location…</option>${locOpts}
        </select>
        <p style="font-size:11px;color:var(--gray-500);margin:4px 0 0;">
          Discipline is auto-detected per sheet from the sheet-number prefix (e.g. <strong>E</strong>→Electrical, <strong>C</strong>→Civil, <strong>S</strong>→Structural).
        </p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div class="form-group">
          <label class="form-label">Import Date</label>
          <input id="drw-import-date" class="form-input" type="date" value="${today}" />
        </div>
        <div class="form-group">
          <label class="form-label">Revision Date</label>
          <input id="drw-rev-date" class="form-input" type="date" />
        </div>
        <div class="form-group">
          <label class="form-label">Release Date</label>
          <input id="drw-rel-date" class="form-input" type="date" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">PDF File *</label>
        <div id="drw-drop-zone" class="drw-drop-zone">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:36px;height:36px;color:var(--gray-400);margin-bottom:8px;"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>
          <p style="color:var(--gray-500);font-size:13px;margin:0;">Drop PDF here or <label for="drw-file-input" style="color:var(--hitachi-red);cursor:pointer;font-weight:600;">browse</label></p>
          <p id="drw-file-name" style="color:var(--gray-600);font-size:12px;margin-top:4px;font-weight:600;"></p>
          <input id="drw-file-input" type="file" accept="application/pdf" style="display:none;" ${cxOn('change', '_drwFileChosen', '$cx.el')} />
        </div>
      </div>
      <div id="drw-upload-err" style="color:var(--bad);font-size:12px;margin-top:4px;display:none;"></div>`,
    footer: `
      <button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Cancel</button>
      <button class="admin-action-btn-secondary" ${cxAct('_drwStep1Next', 'calibrate')} title="Draw boxes around the title-block fields first">Calibrate fields…</button>
      <button class="admin-action-btn" ${cxAct('_drwStep1Next', 'read')}>Read sheets →</button>`,
  });

  const zone = document.getElementById('drw-drop-zone');
  // Coming back from Calibrate keeps what was already entered.
  const prev = _drwUploadMeta;
  if (prev) {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    setVal('drw-title', prev.title); setVal('drw-location', prev.location);
    setVal('drw-import-date', prev.import_date); setVal('drw-rev-date', prev.revision_date); setVal('drw-rel-date', prev.release_date);
    if (prev.file) { zone._file = prev.file; document.getElementById('drw-file-name').textContent = prev.file.name; }
  }
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.style.borderColor='var(--hitachi-red)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor=''; });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.style.borderColor='';
    const f = e.dataTransfer.files[0];
    if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) { document.getElementById('drw-file-name').textContent = f.name; zone._file = f; }
  });
}

function _drwFileChosen(inp) {
  const f = inp.files[0];
  if (f) { document.getElementById('drw-file-name').textContent = f.name; document.getElementById('drw-drop-zone')._file = f; }
}

// mode: 'read' → straight to reading the sheets; 'calibrate' → draw boxes first.
async function _drwStep1Next(mode) {
  const title   = document.getElementById('drw-title')?.value.trim();
  const loc     = document.getElementById('drw-location')?.value;
  const impDate = document.getElementById('drw-import-date')?.value;
  const revDate = document.getElementById('drw-rev-date')?.value;
  const relDate = document.getElementById('drw-rel-date')?.value;
  const file    = document.getElementById('drw-drop-zone')?._file || document.getElementById('drw-file-input')?.files[0];
  const errEl   = document.getElementById('drw-upload-err');

  if (!title) { errEl.textContent = 'Document title is required.'; errEl.style.display='block'; return; }
  if (!loc)   { errEl.textContent = 'Location is required.';       errEl.style.display='block'; return; }
  if (!file)  { errEl.textContent = 'Please select a PDF file.';   errEl.style.display='block'; return; }

  const sameFile = _drwUploadMeta && _drwUploadMeta.file === file && _drwUploadPdfDoc;
  _drwUploadMeta = { title, location: loc, import_date: impDate, revision_date: revDate, release_date: relDate, file };
  if (!sameFile) { _drwParsedSheets = []; _drwUploadPdfDoc = null; }

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 16px;"></div>
      <p style="color:var(--gray-500);">Loading PDF…</p>
    </div>`;
  document.querySelector('#modal-overlay .modal-footer').innerHTML = '';

  try {
    if (!_drwUploadPdfDoc) {
      if (!await CXLazy.pdfjs()) throw new Error('PDF.js could not be loaded');
      _drwUploadPdfDoc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    }
    if (mode === 'calibrate') await _drwShowCalibrate();
    else { _drwFieldRegions = _drwLoadAllFieldRegions(loc); await _drwRunExtract(); }
  } catch(e) {
    const msg = e && e.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password (or print it to a new PDF) and upload it again.'
      : (e && e.message) || String(e);
    document.querySelector('#modal-overlay .modal-body').innerHTML = `<p style="color:var(--bad);padding:20px;">${escapeHtml(msg)}</p>`;
    document.querySelector('#modal-overlay .modal-footer').innerHTML = `<button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Close</button>`;
  }
}

async function _drwShowCalibrate() {
  const loc      = _drwUploadMeta.location;
  _drwFieldRegions   = _drwLoadAllFieldRegions(loc);
  _drwCalActiveField = 'sheetNumber';
  const numPages = _drwUploadPdfDoc.numPages;
  _drwCalPage = Math.min(Math.max(1, _drwCalPage || 1), numPages);

  _drwCalZoom = 1.0;

  const modalEl = document.querySelector('#modal-overlay .modal');
  modalEl.className = 'modal modal-large';
  modalEl.style.maxWidth  = '98vw';
  modalEl.style.width     = '98vw';
  modalEl.style.maxHeight = '95vh';
  document.querySelector('#modal-overlay .modal-head .modal-title').textContent = 'Calibrate Fields';
  const subEl = document.querySelector('#modal-overlay .modal-head .modal-sub');
  if (subEl) subEl.textContent = 'Zoom in to draw precise regions for each field. Regions are saved per location and reused.';

  const savedCount = Object.keys(_drwFieldRegions).length;
  const fieldBtnsHTML = _DRW_CAL_FIELDS.map(f => {
    const hasSaved = !!_drwFieldRegions[f.key];
    return '<button id="drw-cal-field-' + f.key + '" ' + cxAct('_drwCalSetField', String(f.key)) + ' aria-label="Calibrate ' + f.label + ' field"'
      + ' style="display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--gray-200);background:var(--gray-50);cursor:pointer;font-size:12px;color:var(--gray-600);font-weight:500;text-align:left;">'
      + '<span style="display:inline-block;width:10px;height:10px;flex-shrink:0;border-radius:2px;background:' + f.color + ';"></span>'
      + escapeHtml(f.label)
      + '<span id="drw-cal-check-' + f.key + '" style="margin-left:auto;font-size:11px;color:var(--good);">' + (hasSaved ? '✓' : '') + '</span>'
      + '</button>';
  }).join('');

  document.querySelector('#modal-overlay .modal-body').innerHTML = '<div style="display:flex;gap:16px;align-items:flex-start;">'
    + '<div style="flex:1;min-width:0;">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">'
    + '<button class="admin-action-btn-secondary" id="drw-cal-prev" style="padding:6px 12px;font-size:13px;">◀ Prev</button>'
    + '<span style="font-size:13px;color:var(--gray-700);">Page</span>'
    + '<input id="drw-cal-page-input" type="number" min="1" max="' + numPages + '" value="' + _drwCalPage + '" style="width:56px;padding:5px 8px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px;text-align:center;" />'
    + '<span style="font-size:13px;color:var(--gray-500);">of ' + numPages + '</span>'
    + '<button class="admin-action-btn-secondary" id="drw-cal-next" style="padding:6px 12px;font-size:13px;">Next ▶</button>'
    + '<span style="display:inline-block;width:1px;height:20px;background:var(--gray-200);margin:0 4px;"></span>'
    + '<button class="admin-action-btn-secondary" id="drw-cal-zoom-out" aria-label="Zoom out" data-action="_drwCalChangeZoom" data-args="[-1]" style="padding:4px 10px;font-size:15px;font-weight:700;line-height:1;">−</button>'
    + '<span id="drw-cal-zoom-label" style="font-size:12px;font-weight:600;color:var(--gray-700);min-width:32px;text-align:center;">1×</span>'
    + '<button class="admin-action-btn-secondary" id="drw-cal-zoom-in" aria-label="Zoom in" ' + cxAct('_drwCalChangeZoom', 1) + ' style="padding:4px 10px;font-size:15px;font-weight:700;line-height:1;">+</button>'
    + '<span style="flex:1;"></span>'
    + '<span style="font-size:12px;color:var(--gray-500);">'
    + (savedCount > 0
        ? '<span style="color:var(--good);font-weight:600;">✓ ' + savedCount + ' of ' + _DRW_CAL_FIELDS.length + ' fields calibrated for ' + escapeHtml(loc) + '</span>'
        : 'Zoom in, then drag a box over each field value.')
    + '</span>'
    + '</div>'
    + '<div id="drw-cal-stage" style="position:relative;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:6px;overflow:auto;min-height:300px;max-height:72vh;">'
    + '<canvas id="drw-cal-pdf" style="display:block;"></canvas>'
    + '<canvas id="drw-cal-sel" style="position:absolute;top:0;left:0;cursor:crosshair;"></canvas>'
    + '</div>'
    + '</div>'
    + '<div style="width:220px;flex-shrink:0;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Fields</div>'
    + '<div style="display:flex;flex-direction:column;gap:4px;" id="drw-cal-field-bar">' + fieldBtnsHTML + '</div>'
    + '<div id="drw-cal-info" style="margin-top:12px;padding:10px;background:var(--gray-50);border-radius:6px;font-size:11px;color:var(--gray-500);line-height:1.6;">Select a field above, then draw a box around it</div>'
    + '<button class="admin-action-btn-secondary" data-action="_drwCalClear" style="margin-top:8px;font-size:12px;padding:6px 12px;width:100%;">Clear Field Region</button>'
    + '<div style="margin-top:14px;font-size:11px;color:var(--gray-500);line-height:1.7;">'
    + '<div style="font-weight:700;color:var(--gray-600);margin-bottom:4px;">How it works</div>'
    + '<ol style="padding-left:14px;margin:0;">'
    + '<li>Navigate to a sheet with a full title block</li>'
    + '<li>Click a field button to select it</li>'
    + '<li>Drag a box around that field\'s value on the PDF</li>'
    + '<li>Repeat for each field to calibrate</li>'
    + '<li>Fields without a region are found automatically</li>'
    + '</ol>'
    + '<div style="margin-top:8px;">Boxes are optional: on the review screen you can also click the text on the drawing to fill a field, and teach that spot to every page.</div>'
    + '</div>'
    + '</div>'
    + '</div>';

  document.querySelector('#modal-overlay .modal-footer').innerHTML = ''
    + '<button class="admin-action-btn-secondary" ' + cxAct('_drwOpenUpload', 'back') + '>← Back</button>'
    + '<button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Cancel</button>'
    + '<button class="admin-action-btn" data-action="_drwRunExtract">Read sheets →</button>';

  // Wire navigation
  document.getElementById('drw-cal-prev').onclick = () => _drwCalGoToPage(_drwCalPage - 1);
  document.getElementById('drw-cal-next').onclick = () => _drwCalGoToPage(_drwCalPage + 1);
  document.getElementById('drw-cal-page-input').onchange = function() { _drwCalGoToPage(parseInt(this.value, 10) || 1); };

  _drwCalUpdateFieldBar();
  await _drwCalRenderPage(_drwCalPage);
}

async function _drwCalGoToPage(n) {
  if (!_drwUploadPdfDoc) return;
  const target = Math.min(Math.max(1, n|0), _drwUploadPdfDoc.numPages);
  const inp = document.getElementById('drw-cal-page-input');
  if (inp) inp.value = String(target);
  if (target === _drwCalPage) return;
  _drwCalPage = target;
  await _drwCalRenderPage(target);
}

async function _drwCalChangeZoom(dir) {
  const idx = _DRW_CAL_ZOOM_STEPS.indexOf(_drwCalZoom);
  const next = _DRW_CAL_ZOOM_STEPS[Math.max(0, Math.min(_DRW_CAL_ZOOM_STEPS.length - 1, idx + dir))];
  if (next === _drwCalZoom) return;

  // Preserve the scroll center fraction so the same spot stays centered after zoom
  const stage = document.getElementById('drw-cal-stage');
  const centerFx = stage ? (stage.scrollLeft + stage.clientWidth / 2)  / (stage.scrollWidth  || 1) : 0.5;
  const centerFy = stage ? (stage.scrollTop  + stage.clientHeight / 2) / (stage.scrollHeight || 1) : 0.5;

  _drwCalZoom = next;
  const lbl = document.getElementById('drw-cal-zoom-label');
  if (lbl) lbl.textContent = (next === 1 ? '1' : next < 1 ? next.toFixed(2).replace(/\.?0+$/, '') : next % 1 === 0 ? String(next) : next.toFixed(1)) + '×';
  const zOut = document.getElementById('drw-cal-zoom-out');
  const zIn  = document.getElementById('drw-cal-zoom-in');
  if (zOut) zOut.disabled = _drwCalZoom <= _DRW_CAL_ZOOM_STEPS[0];
  if (zIn)  zIn.disabled  = _drwCalZoom >= _DRW_CAL_ZOOM_STEPS[_DRW_CAL_ZOOM_STEPS.length - 1];

  await _drwCalRenderPage(_drwCalPage);

  // Restore scroll center
  if (stage) {
    stage.scrollLeft = centerFx * stage.scrollWidth  - stage.clientWidth  / 2;
    stage.scrollTop  = centerFy * stage.scrollHeight - stage.clientHeight / 2;
  }
}

async function _drwCalRenderPage(pageNum) {
  if (_drwCalRendering) return;
  _drwCalRendering = true;
  try {
    const page  = await _drwUploadPdfDoc.getPage(pageNum);
    const vp0   = page.getViewport({ scale: 1 });
    const stage = document.getElementById('drw-cal-stage');
    // Fit-to-stage scale (ignoring scrollbars — use clientWidth)
    const stageW = Math.max(400, (stage?.clientWidth  || window.innerWidth  * 0.7) - 4);
    const stageH = Math.max(300, Math.min(window.innerHeight * 0.72, 900));
    const fitScale = Math.min(stageW / vp0.width, stageH / vp0.height);
    const scale = fitScale * _drwCalZoom;
    const viewport = page.getViewport({ scale });
    const pdfCv = document.getElementById('drw-cal-pdf');
    const selCv = document.getElementById('drw-cal-sel');
    if (!pdfCv || !selCv) return;
    pdfCv.width  = viewport.width;  pdfCv.height  = viewport.height;
    selCv.width  = viewport.width;  selCv.height  = viewport.height;
    selCv.style.width  = viewport.width  + 'px';
    selCv.style.height = viewport.height + 'px';
    await page.render({ canvasContext: pdfCv.getContext('2d'), viewport }).promise;
    // Text items + the scale-1 viewport, for the live "reads as" preview.
    const vp1 = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    _drwCalPageItems = { items: content.items, viewport: vp1 };
    _drwCalUpdateInfo();

    _drwCalRedrawRegions(selCv, null);

    _drwCalSel = { active: false, x0:0, y0:0, x1:0, y1:0 };
    selCv.onpointerdown = _drwCalDown;
    selCv.onpointermove = _drwCalMove;
    selCv.onpointerup   = _drwCalUp;
  } finally {
    _drwCalRendering = false;
  }
}

function _drwDrawFieldRegion(canvas, r, color, isActive) {
  const ctx = canvas.getContext('2d');
  const x = r.fx*canvas.width, y = r.fy*canvas.height, w = r.fw*canvas.width, h = r.fh*canvas.height;
  ctx.strokeStyle = color;
  ctx.lineWidth = isActive ? 2.5 : 1.5;
  ctx.setLineDash(isActive ? [] : [5,3]);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = color + (isActive ? '22' : '11');
  ctx.fillRect(x, y, w, h);
  ctx.setLineDash([]);
  if (isActive) {
    const field = _DRW_CAL_FIELDS.find(f => f.key === _drwCalActiveField);
    if (field) {
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(field.label, x + 4, y + 13);
    }
  }
}

function _drwCalRedrawRegions(canvas, dragReg) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  _DRW_CAL_FIELDS.forEach(f => {
    const r = (f.key === _drwCalActiveField && dragReg) ? dragReg : _drwFieldRegions[f.key];
    if (r) _drwDrawFieldRegion(canvas, r, f.color, f.key === _drwCalActiveField);
  });
}

function _drwCalSetField(key) {
  _drwCalActiveField = key;
  _drwCalUpdateFieldBar();
  const c = document.getElementById('drw-cal-sel');
  if (c) _drwCalRedrawRegions(c, null);
  _drwCalUpdateInfo();
}

function _drwCalUpdateFieldBar() {
  _DRW_CAL_FIELDS.forEach(f => {
    const btn = document.getElementById('drw-cal-field-' + f.key);
    if (!btn) return;
    const isActive = f.key === _drwCalActiveField;
    const hasRegion = !!_drwFieldRegions[f.key];
    btn.style.background   = isActive ? f.color : (hasRegion ? f.color + '18' : 'var(--gray-50)');
    btn.style.color        = isActive ? '#fff'   : (hasRegion ? f.color        : 'var(--gray-600)');
    btn.style.borderColor  = isActive ? f.color  : (hasRegion ? f.color        : 'var(--gray-200)');
    btn.style.fontWeight   = isActive ? '600'    : '500';
    const chk = document.getElementById('drw-cal-check-' + f.key);
    if (chk) chk.textContent = hasRegion ? '✓' : '';
  });
}

function _drwCalUpdateInfo() {
  const info = document.getElementById('drw-cal-info');
  if (!info) return;
  const field = _DRW_CAL_FIELDS.find(f => f.key === _drwCalActiveField);
  if (!field) return;
  const r = _drwFieldRegions[_drwCalActiveField];
  if (r) {
    // Live preview: what this box reads on the current page, exactly as the import will.
    let previewHtml = '';
    if (_drwCalPageItems && _drwCalPageItems.items) {
      const pv = DrwParse.regionPreview(_drwCalPageItems.items, _drwCalPageItems.viewport, _drwCalActiveField, r);
      const found = pv.lines || [];
      if (found.length) {
        const shaky = !pv.value || pv.conf === 'low';
        previewHtml = '<div style="margin-top:7px;padding:6px 8px;background:' + (shaky ? 'var(--warn-light)' : 'var(--good-light)') + ';border:1px solid ' + (shaky ? 'var(--warn)' : 'var(--good-border)') + ';border-radius:5px;">'
          + '<div style="font-size:10px;font-weight:700;color:' + (shaky ? 'var(--warn)' : 'var(--good)') + ';margin-bottom:2px;">Reads as:</div>'
          + '<div style="font-size:12px;font-weight:700;color:var(--text);font-family:monospace;word-break:break-word;">' + (pv.value ? escapeHtml(pv.value) : '—') + '</div>'
          + (shaky ? '<div style="font-size:10px;color:var(--warn);margin-top:2px;">That doesn\'t look like a ' + escapeHtml(field.label.toLowerCase()) + ' — check the box covers the value.</div>' : '')
          + '<div style="font-size:10px;font-weight:700;color:var(--text-muted);margin:6px 0 2px;">Text in the box:</div>'
          + found.slice(0, 6).map(s => '<div style="font-size:11px;color:var(--text-muted);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(s) + '</div>').join('')
          + (found.length > 6 ? '<div style="font-size:10px;color:var(--text-muted);">+' + (found.length - 6) + ' more</div>' : '')
          + '</div>';
      } else {
        previewHtml = '<div style="margin-top:7px;padding:6px 8px;background:var(--bad-light);border:1px solid var(--bad-border);border-radius:5px;font-size:10px;color:var(--bad);">'
          + 'No text found in this region on this page. Try a different area or check the PDF has selectable text.</div>';
      }
    }
    info.innerHTML = '<span style="color:' + field.color + ';font-weight:600;">' + escapeHtml(field.label) + '</span> region set<br>'
      + '<span style="font-size:10px;color:var(--gray-400);">Redraw to change</span>'
      + previewHtml;
  } else {
    info.innerHTML = 'Draw a box around the <strong>' + escapeHtml(field.label) + '</strong> value on the PDF';
  }
}

function _drwCalDown(e) {
  const c = document.getElementById('drw-cal-sel'), r = c.getBoundingClientRect();
  _drwCalSel = { active:true, x0:e.clientX-r.left, y0:e.clientY-r.top, x1:e.clientX-r.left, y1:e.clientY-r.top };
  c.setPointerCapture(e.pointerId);
}
function _drwCalMove(e) {
  if (!_drwCalSel.active) return;
  const c = document.getElementById('drw-cal-sel'), r = c.getBoundingClientRect();
  _drwCalSel.x1 = e.clientX-r.left; _drwCalSel.y1 = e.clientY-r.top;
  _drwCalRedrawRegions(c, { fx:Math.min(_drwCalSel.x0,_drwCalSel.x1)/c.width, fy:Math.min(_drwCalSel.y0,_drwCalSel.y1)/c.height, fw:Math.abs(_drwCalSel.x1-_drwCalSel.x0)/c.width, fh:Math.abs(_drwCalSel.y1-_drwCalSel.y0)/c.height });
}
function _drwCalUp(e) {
  if (!_drwCalSel.active) return;
  _drwCalSel.active = false;
  const c = document.getElementById('drw-cal-sel');
  const reg = { fx:Math.min(_drwCalSel.x0,_drwCalSel.x1)/c.width, fy:Math.min(_drwCalSel.y0,_drwCalSel.y1)/c.height, fw:Math.abs(_drwCalSel.x1-_drwCalSel.x0)/c.width, fh:Math.abs(_drwCalSel.y1-_drwCalSel.y0)/c.height };
  if (reg.fw < 0.02 || reg.fh < 0.02) return;
  _drwFieldRegions[_drwCalActiveField] = reg;
  _drwCalRedrawRegions(c, null);
  _drwCalUpdateInfo();
  _drwCalUpdateFieldBar();
}
function _drwCalClear() {
  const loc = _drwUploadMeta?.location;
  if (loc) localStorage.removeItem(_drwFieldRegionKey(loc, _drwCalActiveField));
  delete _drwFieldRegions[_drwCalActiveField];
  const c = document.getElementById('drw-cal-sel');
  if (c) _drwCalRedrawRegions(c, null);
  _drwCalUpdateInfo();
  _drwCalUpdateFieldBar();
}

// Bookmarks and page labels often carry "E-101 - POWER PLAN" per page — the
// only source on scanned pages. Best effort: a broken outline is ignored.
async function _drwPdfHints(pdf) {
  const hints = Array.from({ length: pdf.numPages }, () => ({}));
  try {
    const labels = await pdf.getPageLabels();
    if (labels) labels.forEach((l, i) => { if (hints[i] && l) hints[i].pageLabel = l; });
  } catch (e) { /* no page labels */ }
  try {
    const outline = await pdf.getOutline();
    let seen = 0;
    const walk = async (nodes, depth) => {
      for (const n of nodes || []) {
        if (++seen > 5000) return;
        let dest = n.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          const h = hints[idx];
          // the deepest bookmark on a page is the sheet (parents are the set / discipline)
          if (h && n.title && (h._depth == null || depth > h._depth)) { h.bookmark = n.title; h._depth = depth; }
        }
        if (n.items && n.items.length) await walk(n.items, depth + 1);
      }
    };
    if (outline) await walk(outline, 0);
  } catch (e) { /* no usable outline */ }
  return hints;
}

const _DRW_EDIT_FIELDS = ['sheetNumber', 'sheetTitle', 'revision', 'pageNumber', 'discipline'];

async function _drwRunExtract() {
  const _loc = _drwUploadMeta?.location;
  if (_loc) _DRW_CAL_FIELDS.forEach(f => {
    try {
      if (_drwFieldRegions[f.key]) _drwSaveFieldRegion(_loc, f.key, _drwFieldRegions[f.key]);
      else localStorage.removeItem(_drwFieldRegionKey(_loc, f.key));
    } catch (e) { /* storage unavailable — regions just aren't remembered */ }
  });
  const numPages = _drwUploadPdfDoc.numPages;

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 16px;"></div>
      <p id="drw-parse-status" style="color:var(--gray-500);">Reading page 1 of ${numPages}…</p>
      <div style="margin-top:12px;background:var(--gray-100);border-radius:6px;height:6px;width:260px;margin-left:auto;margin-right:auto;">
        <div id="drw-parse-bar" style="background:var(--hitachi-red);height:6px;border-radius:6px;width:0%;transition:width .2s;"></div>
      </div>
    </div>`;
  document.querySelector('#modal-overlay .modal-footer').innerHTML = '';

  try {
    const hints = await _drwPdfHints(_drwUploadPdfDoc);
    const models = [];
    for (let i = 1; i <= numPages; i++) {
      const st = document.getElementById('drw-parse-status'), bar = document.getElementById('drw-parse-bar');
      if (st) st.textContent = `Reading page ${i} of ${numPages}…`;
      if (bar) bar.style.width = `${Math.round(i/numPages*100)}%`;
      const page     = await _drwUploadPdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content  = await page.getTextContent();
      models.push(DrwParse.analyzePage(content.items, viewport, { regions: _drwFieldRegions }));
      page.cleanup();
    }
    const parsed = DrwParse.extractSet(models, { hints });
    // Re-reading the same PDF (recalibrated, or a spot taught from the review)
    // keeps everything the user already typed or ticked.
    const prev = _drwParsedSheets.length === parsed.length ? _drwParsedSheets : null;
    const sheets = parsed.map((p, i) => {
      // Pre-uncheck pages with nothing on them (covers / index pages); scanned
      // pages stay in — they are usually real sheets that need typing in.
      const s = { ...p, included: p.noText || !!(p.sheetNumber || p.sheetTitle || p.pageNumber), _edited: {} };
      const o = prev && prev[i];
      if (o) {
        _DRW_EDIT_FIELDS.forEach(f => { if (o._edited && o._edited[f]) { s[f] = o[f]; s._edited[f] = true; } });
        if (o._includedSet) { s.included = o.included; s._includedSet = true; }
      }
      return s;
    });
    _drwParsedSheets = sheets;
    _drwReviewRefreshFlags(false);
    _drwShowReview(numPages);
  } catch(e) {
    document.querySelector('#modal-overlay .modal-body').innerHTML = `<p style="color:var(--bad);padding:20px;">${escapeHtml(e.message)}</p>`;
    document.querySelector('#modal-overlay .modal-footer').innerHTML = `<button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Close</button>`;
  }
}

let _drwReviewSelectedIdx = 0;
let _drwReviewRendering   = false;

function _drwBumpRev(rev) {
  if (!rev) return '01';
  const t = rev.trim();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10) + 1;
    return String(n).padStart(Math.max(t.length, String(n).length), '0');
  }
  const up = t.toUpperCase();
  if (/^[A-Z]+$/.test(up)) {
    const chars = up.split('');
    let i = chars.length - 1;
    while (i >= 0 && chars[i] === 'Z') { chars[i] = 'A'; i--; }
    if (i < 0) return 'A' + chars.join('');
    chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
    return chars.join('');
  }
  const m = t.match(/^(.*?)(\d+)$/);
  if (m) return m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
  return t + '-R2';
}

// Review-screen state
let _drwRevActiveField = null;   // field the next click on the drawing fills
let _drwRevPhrases     = null;   // { page, list } text on the previewed page (for click-to-fill)
let _drwRevSpot        = null;   // { field, idx, box } last text clicked — can be taught to every page

const _DRW_VIA_TEXT = {
  label: 'next to its title-block label', region: 'from your calibrated box', template: 'from the CBTC title-block layout',
  learned: 'where the other sheets in this set have it', layout: 'from the title-block layout', pattern: 'from its shape',
  file: 'from the CAD file name', bookmark: 'from the PDF bookmark', pagelabel: 'from the PDF page label', sequence: 'from the pages either side',
};
const _DRW_FIELD_LABEL = { sheetNumber: 'Sheet #', sheetTitle: 'Title', revision: 'Rev', pageNumber: 'Page #' };

// Border + tooltip for one review input: how sure the reader is, and why.
function _drwRevFieldLook(s, f) {
  if (s._edited && s._edited[f]) return { border: 'var(--gray-200)', dash: false, tip: 'Entered by you' };
  const v = s[f], c = s.confidence && s.confidence[f], via = _DRW_VIA_TEXT[s.via && s.via[f]] || '';
  if (!v) return { border: (f === 'sheetNumber' || f === 'sheetTitle') ? 'var(--warn)' : 'var(--gray-200)', dash: false, tip: 'Not found — type it, or click it on the drawing' };
  if (c === 'low') return { border: 'var(--warn)', dash: true, tip: 'A guess' + (via ? ' (' + via + ')' : '') + ' — check it' };
  return { border: 'var(--gray-200)', dash: false, tip: (c === 'high' ? 'Read ' : 'Probably right — read ') + via };
}

function _drwRevIssues(s) {
  const out = [];
  if (s.noText) out.push('No selectable text (scanned?) — type the details');
  if (s.duplicate) out.push('Sheet # also on page ' + (s._dupPages || []).join(', '));
  const guess = f => s[f] && s.confidence && s.confidence[f] === 'low' && !(s._edited && s._edited[f]);
  if (!s.sheetNumber) out.push('No sheet # found'); else if (guess('sheetNumber')) out.push('Sheet # is a guess');
  if (!s.sheetTitle) out.push('No title found'); else if (guess('sheetTitle')) out.push('Title is a guess');
  return out;
}

function _drwRevRowStyle(s) {
  const upRev = !!s._existingSheet;
  if (!s.included) return `opacity:0.45;background:var(--gray-50);${upRev ? 'border-left:3px solid var(--accent-amber);' : ''}`;
  if (upRev) return 'background:var(--warn-light);border-left:3px solid var(--accent-amber);';
  return s.needsReview ? 'background:var(--warn-light);' : '';
}

// One short line under the title: up-rev, and what needs a look (all of it on hover).
function _drwRevStatusHtml(s) {
  const bits = [];
  if (s._existingSheet) bits.push(`<span style="color:var(--warn);font-weight:700;">↑ up-rev (was ${escapeHtml(s._existingSheet.revision || '—')})</span>`);
  const iss = s.included ? _drwRevIssues(s) : [];
  if (iss.length) bits.push(`<span style="color:var(--warn);font-weight:600;" title="${escapeHtml(iss.join('\n'))}">${icon('alert')} ${escapeHtml(iss[0])}${iss.length > 1 ? ` +${iss.length - 1} more` : ''}</span>`);
  return bits.join(' · ');
}

// Recompute duplicates / needs-review across the set; restyle rows in place
// (never re-render them — that would steal focus from the field being typed in).
function _drwReviewRefreshFlags(updateDom = true) {
  const byNum = {};
  _drwParsedSheets.forEach(s => {
    s.duplicate = false; s._dupPages = null;
    const n = DrwParse.normSheet(s.sheetNumber || '');
    if (n && s.included) (byNum[n] = byNum[n] || []).push(s);
  });
  Object.values(byNum).forEach(g => {
    if (g.length < 2) return;
    const pages = g.map(s => s.pageNumber || '');
    if (pages.every(Boolean) && new Set(pages).size === pages.length) return;   // one drawing over several pages
    g.forEach(s => { s.duplicate = true; s._dupPages = g.filter(o => o !== s).map(o => o.pageIndex + 1); });
  });
  _drwParsedSheets.forEach(s => {
    const low = f => s.confidence && s.confidence[f] === 'low' && !(s._edited && s._edited[f]);
    s.needsReview = !s.sheetNumber || !s.sheetTitle || !!s.duplicate || low('sheetNumber') || low('sheetTitle');
  });
  if (!updateDom) return;
  _drwParsedSheets.forEach((s, i) => {
    const row = document.getElementById(`drw-rev-row-${i}`);
    if (!row) return;
    row.style.cssText = _drwRevRowStyle(s);
    ['sheetNumber', 'sheetTitle', 'revision', 'pageNumber'].forEach(f => {
      const inp = row.querySelector(`input[data-field="${f}"]`);
      if (!inp) return;
      const look = _drwRevFieldLook(s, f);
      inp.style.borderColor = look.border; inp.style.borderStyle = look.dash ? 'dashed' : 'solid'; inp.title = look.tip;
    });
    const st = document.getElementById(`drw-rev-status-${i}`);
    if (st) st.innerHTML = _drwRevStatusHtml(s);
  });
  const pill = document.getElementById('drw-needs-pill');
  if (pill) {
    const n = _drwParsedSheets.filter(s => s.included && s.needsReview).length;
    pill.style.background = n ? 'var(--warn-light)' : 'var(--good-light)';
    pill.style.color = n ? 'var(--warn)' : 'var(--good)';
    pill.innerHTML = n ? `${icon('alert')} ${n} to check` : '✓ All sheets read';
  }
}

function _drwRevInput(s, i, f, style) {
  const look = _drwRevFieldLook(s, f);
  return `<input class="form-input" value="${escapeHtml(s[f] || '')}" data-idx="${i}" data-field="${f}" title="${escapeHtml(look.tip)}"
    aria-label="${escapeHtml(_DRW_FIELD_LABEL[f])}, page ${s.pageIndex + 1}"
    style="${style}border-color:${look.border};border-style:${look.dash ? 'dashed' : 'solid'};"
    ${cxOn('change', '_drwReviewEdit', i, f, '$cx.value')} />`;
}

function _drwShowReview(numPages) {
  // Detect up-revs: existing current sheets at this location with matching drawing numbers.
  const _normNumR = n => (n == null ? '' : String(n).trim().toUpperCase());
  const reviewLoc = _drwUploadMeta?.location;
  const existingByNum = {};
  DRAWING_SHEETS.filter(s => s.location === reviewLoc && s.is_current)
    .forEach(s => { if (s.sheet_number) existingByNum[_normNumR(s.sheet_number)] = s; });
  // On first show, set the revision for up-rev sheets: the one read off the
  // drawing when it is newer than the current one, otherwise the next revision.
  _drwParsedSheets.forEach(s => {
    if (!s._upRevInit) {
      const ex = existingByNum[_normNumR(s.sheetNumber || '')];
      if (ex) {
        s._existingSheet = ex;
        const readNewer = s.revision && s.confidence && s.confidence.revision !== 'low'
          && DrwParse.revRank(s.revision) > DrwParse.revRank(ex.revision || '');
        if (!(s._edited && s._edited.revision) && !readNewer) s.revision = _drwBumpRev(ex.revision);
      }
      s._upRevInit = true;
    }
  });
  _drwReviewRefreshFlags(false);

  const includedCount = _drwParsedSheets.filter(s => s.included).length;
  const upRevCount    = _drwParsedSheets.filter(s => s.included && s._existingSheet).length;
  const scanned       = _drwParsedSheets.filter(s => s.noText).length;
  const boxes         = _DRW_CAL_FIELDS.filter(f => _drwFieldRegions[f.key]).map(f => f.label);

  // Keep the wide modal (from calibrate) so the PDF preview is readable.
  const modalEl = document.querySelector('#modal-overlay .modal');
  if (modalEl) { modalEl.className = 'modal modal-large'; modalEl.style.maxWidth = '98vw'; modalEl.style.width = '98vw'; modalEl.style.maxHeight = '95vh'; }

  document.querySelector('#modal-overlay .modal-head .modal-title').textContent = 'Review Sheets';
  const subEl = document.querySelector('#modal-overlay .modal-head .modal-sub');
  if (subEl) subEl.textContent = 'Check what was read from each page. Amber = needs a look. Click a field, then click its text on the drawing to fill it.';

  const legend = _DRW_CAL_FIELDS.map(f => `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border:2px solid ${f.color};border-radius:2px;"></span>${escapeHtml(f.label)}</span>`).join('');

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
      <span style="font-size:13px;color:var(--gray-600);">${numPages} pages read.</span>
      <span id="drw-included-pill" style="background:#e0e7ff;color:var(--info);padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">${includedCount} of ${numPages} to import</span>
      ${upRevCount ? `<span id="drw-uprev-pill" style="background:var(--warn-light);color:#c2410c;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">↑ ${upRevCount} up-rev</span>` : `<span id="drw-uprev-pill" style="display:none;background:var(--warn-light);color:#c2410c;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;"></span>`}
      <span id="drw-needs-pill" style="padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;"></span>
      ${scanned ? `<span style="background:var(--gray-100);color:var(--text-muted);padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;" title="These pages are images with no selectable text">${scanned} scanned page${scanned === 1 ? '' : 's'}</span>` : ''}
      ${boxes.length ? `<span style="font-size:12px;color:var(--text-muted);" title="Calibrated boxes remembered for ${escapeHtml(_drwUploadMeta?.location || '')}">Using saved boxes: ${escapeHtml(boxes.join(', '))} · <button data-action="_drwReviewForgetBoxes" style="background:none;border:none;padding:0;color:var(--hitachi-red);font-weight:600;cursor:pointer;font-size:12px;">Forget</button></span>` : ''}
      <button class="admin-action-btn-secondary" data-action="_drwReviewSelectAll" data-args="[true]" style="font-size:12px;padding:5px 10px;">Select all</button>
      <button class="admin-action-btn-secondary" data-action="_drwReviewSelectAll" data-args="[false]" style="font-size:12px;padding:5px 10px;">Select none</button>
      <button class="admin-action-btn-secondary" data-action="_drwShowCalibrate" style="font-size:12px;padding:5px 10px;margin-left:auto;">Calibrate boxes…</button>
    </div>
    ${_drwDisciplineListHTML()}
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
      <!-- PDF preview (stacks above the table on narrow screens) -->
      <div style="flex:1 1 420px;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <button class="admin-action-btn-secondary" id="drw-rev-prev" aria-label="Previous page" style="padding:5px 11px;font-size:13px;">◀</button>
          <span id="drw-rev-prev-label" style="font-size:12.5px;font-weight:600;color:var(--gray-700);">Page —</span>
          <button class="admin-action-btn-secondary" id="drw-rev-next" aria-label="Next page" style="padding:5px 11px;font-size:13px;">▶</button>
          <span id="drw-rev-prev-meta" style="font-size:12px;color:var(--warn);font-weight:600;"></span>
          <span style="display:inline-flex;align-items:center;gap:4px;margin-left:auto;">
            <button class="admin-action-btn-secondary" id="drw-rev-zoom-out" aria-label="Zoom out" style="padding:5px 10px;font-size:14px;font-weight:700;" title="Zoom out">−</button>
            <span id="drw-rev-zoom-label" style="font-size:12px;font-weight:600;color:var(--gray-600);min-width:42px;text-align:center;">Fit</span>
            <button class="admin-action-btn-secondary" id="drw-rev-zoom-in" aria-label="Zoom in" style="padding:5px 10px;font-size:14px;font-weight:700;" title="Zoom in">+</button>
            <button class="admin-action-btn-secondary" id="drw-rev-zoom-reset" style="padding:5px 10px;font-size:12px;" title="Fit to width">Fit</button>
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;font-size:11.5px;color:var(--text-muted);">
          <span id="drw-rev-hint" style="flex:1 1 220px;">Click a field in the table, then click its text on the drawing. Shift-click adds more text to a title.</span>
          <button class="admin-action-btn" id="drw-rev-teach" data-action="_drwReviewTeachSpot" style="display:none;font-size:12px;padding:5px 10px;"></button>
        </div>
        <div id="drw-rev-stage" style="position:relative;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:6px;overflow:auto;max-height:60vh;min-height:300px;display:flex;align-items:flex-start;justify-content:center;">
          <canvas id="drw-rev-pdf" style="display:block;cursor:crosshair;" title="Click text to fill the selected field"></canvas>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--text-muted);">Read from: ${legend}<span>(dashed = your calibrated box)</span></div>
      </div>
      <!-- Editable list -->
      <div style="flex:1 1 420px;min-width:0;">
        <div style="max-height:64vh;overflow:auto;border:1px solid var(--gray-200);border-radius:8px;">
          <table class="data-table drw-rev-table">
            <thead><tr>
              <th style="width:40px;"><input type="checkbox" id="drw-rev-toggle-all" aria-label="Import all pages" ${includedCount === _drwParsedSheets.length ? 'checked' : ''} ${cxOn('change', '_drwReviewSelectAll', '$cx.checked')} title="Toggle all" /></th>
              <th style="width:34px;">Pg</th><th>Sheet #</th><th>Page #</th><th>Title</th><th>Rev</th><th>Discipline</th>
            </tr></thead>
            <tbody id="drw-rev-body">
              ${_drwParsedSheets.map((s, i) => `
                <tr id="drw-rev-row-${i}" class="drw-rev-clickable" ${cxAct('_drwReviewShowPage', i)} style="${_drwRevRowStyle(s)}">
                  <td style="text-align:center;" data-action=""><input type="checkbox" aria-label="Import page ${s.pageIndex + 1}" ${s.included ? 'checked' : ''} ${cxOn('change', '_drwReviewToggle', i, '$cx.checked')} /></td>
                  <td style="color:var(--gray-400);font-size:12px;">${s.pageIndex+1}</td>
                  <td>${_drwRevInput(s, i, 'sheetNumber', 'width:118px;font-family:monospace;font-size:12px;padding:3px 6px;')}</td>
                  <td>${_drwRevInput(s, i, 'pageNumber', 'width:54px;font-family:monospace;font-size:12px;padding:3px 6px;text-align:center;')}</td>
                  <td>${_drwRevInput(s, i, 'sheetTitle', 'width:100%;min-width:130px;font-size:12px;padding:3px 6px;')}
                    <div id="drw-rev-status-${i}" style="font-size:10.5px;line-height:1.3;margin-top:3px;">${_drwRevStatusHtml(s)}</div></td>
                  <td>${_drwRevInput(s, i, 'revision', 'width:48px;font-size:12px;padding:3px 6px;')}</td>
                  <td id="drw-disc-cell-${i}" style="font-size:12px;color:var(--gray-500);">${escapeHtml(s.discipline||'—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p style="font-size:11px;color:var(--gray-400);margin-top:8px;">Hover a field to see where it was read. Discipline suggestions come from Field Config.</p>
      </div>
    </div>`;

  _drwHydrateDisciplineReviewInputs();
  _drwReviewRefreshFlags(true);

  document.querySelector('#modal-overlay .modal-footer').innerHTML = `
    <button class="admin-action-btn-secondary" data-action="_drwShowCalibrate">← Calibrate boxes</button>
    <button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Cancel</button>
    <button class="admin-action-btn" data-action="_drwConfirmImport">Confirm &amp; Import</button>`;

  const prevBtn = document.getElementById('drw-rev-prev');
  const nextBtn = document.getElementById('drw-rev-next');
  if (prevBtn) prevBtn.onclick = () => _drwReviewStep(-1);
  if (nextBtn) nextBtn.onclick = () => _drwReviewStep(1);
  const zInBtn  = document.getElementById('drw-rev-zoom-in');
  const zOutBtn = document.getElementById('drw-rev-zoom-out');
  const zRstBtn = document.getElementById('drw-rev-zoom-reset');
  if (zInBtn)  zInBtn.onclick  = () => _drwReviewZoom(1.25);
  if (zOutBtn) zOutBtn.onclick = () => _drwReviewZoom(0.8);
  if (zRstBtn) zRstBtn.onclick = () => _drwReviewZoom(0);
  const cv = document.getElementById('drw-rev-pdf');
  if (cv) cv.onclick = _drwReviewCanvasClick;
  const body = document.getElementById('drw-rev-body');
  if (body) body.addEventListener('focusin', e => {
    const inp = e.target.closest && e.target.closest('input[data-field]');
    if (!inp) return;
    _drwRevActiveField = inp.dataset.field;
    const hint = document.getElementById('drw-rev-hint');
    if (hint) hint.textContent = `Click the ${_DRW_FIELD_LABEL[_drwRevActiveField]} text on the drawing to fill it${_drwRevActiveField === 'sheetTitle' ? ' (Shift-click adds a line)' : ''}.`;
  });
  _drwRevPhrases = null;
  _drwRevSpot = null;
  _drwReviewZoomScale = 0; // 0 = fit-to-width
  // Preview the first page that needs a look, else the first one to import.
  let first = _drwParsedSheets.findIndex(s => s.included && s.needsReview);
  if (first < 0) first = _drwParsedSheets.findIndex(s => s.included);
  _drwReviewShowPage(first >= 0 ? first : 0);
}

// Zoom the review preview. factor 0 = fit-to-width; otherwise multiply current scale.
function _drwReviewZoomScaleClamp(v) { return Math.max(0.25, Math.min(8, v)); }
let _drwReviewZoomScale = 0;
let _drwReviewFitScale  = 1;
function _drwReviewZoom(factor) {
  if (factor === 0) {
    _drwReviewZoomScale = 0;
  } else {
    const base = _drwReviewZoomScale || _drwReviewFitScale;
    _drwReviewZoomScale = _drwReviewZoomScaleClamp(base * factor);
  }
  const s = _drwParsedSheets[_drwReviewSelectedIdx];
  if (s) _drwReviewRenderPage(s.pageIndex + 1);
}

function _drwReviewShowPage(idx) {
  if (idx == null || idx < 0 || idx >= _drwParsedSheets.length) return;
  _drwReviewSelectedIdx = idx;
  _drwParsedSheets.forEach((_, i) => {
    const row = document.getElementById(`drw-rev-row-${i}`);
    if (row) row.classList.toggle('drw-rev-selected', i === idx);
  });
  const s = _drwParsedSheets[idx];
  const lbl  = document.getElementById('drw-rev-prev-label');
  const meta = document.getElementById('drw-rev-prev-meta');
  if (lbl)  lbl.textContent  = `Page ${s.pageIndex + 1} of ${_drwParsedSheets.length}`;
  if (meta) meta.textContent = s.included
    ? (s._existingSheet ? `↑ up-rev — was Rev ${s._existingSheet.revision || '—'}` : '')
    : 'omitted from import';
  _drwReviewRenderPage(s.pageIndex + 1);
}

function _drwReviewStep(delta) {
  _drwReviewShowPage(Math.max(0, Math.min(_drwParsedSheets.length - 1, _drwReviewSelectedIdx + delta)));
}

let _drwReviewPending = null;    // a page asked for while another was rendering
async function _drwReviewRenderPage(pageNum) {
  if (!_drwUploadPdfDoc) return;
  if (_drwReviewRendering) { _drwReviewPending = pageNum; return; }
  _drwReviewRendering = true;
  try {
    const page  = await _drwUploadPdfDoc.getPage(pageNum);
    const vp0   = page.getViewport({ scale: 1 });
    const stage = document.getElementById('drw-rev-stage');
    const maxW  = Math.max(320, (stage?.clientWidth || 500) - 4);
    // Fit-to-width scale; the stage scrolls when the page is taller/wider.
    _drwReviewFitScale = maxW / vp0.width;
    const scale = _drwReviewZoomScale || _drwReviewFitScale;
    const viewport = page.getViewport({ scale });
    const cv = document.getElementById('drw-rev-pdf');
    if (!cv) return;
    cv.width = viewport.width; cv.height = viewport.height;
    cv.style.width = viewport.width + 'px'; cv.style.height = viewport.height + 'px';
    // Center horizontally only when wider than the stage; otherwise left-align.
    if (stage) stage.style.justifyContent = viewport.width > maxW ? 'flex-start' : 'center';
    await page.render({ canvasContext: cv.getContext('2d'), viewport }).promise;
    const ctx2 = cv.getContext('2d');
    const lw = Math.max(2, cv.width / 300);
    const fs = Math.max(11, Math.round(cv.width / 55));
    // Calibrated boxes (dashed) …
    const _revLoc = _drwUploadMeta?.location;
    const _revRegs = Object.keys(_drwFieldRegions).length > 0
      ? _drwFieldRegions
      : (_revLoc ? _drwLoadAllFieldRegions(_revLoc) : {});
    _DRW_CAL_FIELDS.forEach(f => {
      const r = _revRegs[f.key];
      if (!r || !r.fw || !r.fh) return;
      const rx = r.fx * cv.width, ry = r.fy * cv.height;
      const rw = r.fw * cv.width,  rh = r.fh * cv.height;
      ctx2.save();
      ctx2.strokeStyle = f.color; ctx2.lineWidth = lw;
      ctx2.setLineDash([8, 4]);
      ctx2.strokeRect(rx + lw, ry + lw, rw - lw*2, rh - lw*2);
      ctx2.fillStyle = f.color + '12';
      ctx2.fillRect(rx + lw, ry + lw, rw - lw*2, rh - lw*2);
      ctx2.restore();
    });
    // … and where each value on this page was actually read (solid, labelled;
    // tags step aside when two values sit close together).
    const sheet = _drwParsedSheets.find(x => x.pageIndex + 1 === pageNum);
    if (sheet && sheet.sources) {
      const placed = [];
      const hits = (a) => placed.some(b => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
      _DRW_CAL_FIELDS.forEach(f => {
        const b = sheet.sources[f.key];
        if (!b || !(b.w > 0) || !(b.h > 0)) return;
        const pad = lw * 2;
        const rx = b.x * cv.width - pad, ry = b.y * cv.height - pad, rw = b.w * cv.width + pad * 2, rh = b.h * cv.height + pad * 2;
        ctx2.save();
        ctx2.strokeStyle = f.color; ctx2.lineWidth = lw;
        ctx2.strokeRect(rx, ry, rw, rh);
        ctx2.font = `bold ${fs}px sans-serif`;
        const tw = ctx2.measureText(f.label).width + 8, th = fs + 6;
        const spots = [[rx, ry - th], [rx, ry + rh], [rx + rw - tw, ry - th - th], [rx + rw - tw, ry + rh + th], [rx + rw + 2, ry]];
        let tag = spots.map(([x, y]) => [Math.max(0, Math.min(cv.width - tw, x)), Math.max(0, Math.min(cv.height - th, y))])
          .map(([x, y]) => [x, y, x + tw, y + th]).find(r => !hits(r));
        if (!tag) tag = [Math.max(0, rx), Math.max(0, ry - th), Math.max(0, rx) + tw, Math.max(0, ry - th) + th];
        placed.push(tag);
        ctx2.fillStyle = f.color;
        ctx2.fillRect(tag[0], tag[1], tw, th);
        ctx2.fillStyle = '#fff';
        ctx2.fillText(f.label, tag[0] + 4, tag[1] + fs + 1);
        ctx2.restore();
      });
    }
    const zl = document.getElementById('drw-rev-zoom-label');
    if (zl) zl.textContent = _drwReviewZoomScale ? `${Math.round((_drwReviewZoomScale / _drwReviewFitScale) * 100)}%` : 'Fit';
    // Text on this page, for click-to-fill.
    if (!_drwRevPhrases || _drwRevPhrases.page !== pageNum) {
      const tc = await page.getTextContent();
      _drwRevPhrases = { page: pageNum, list: DrwParse.pagePhrases(tc.items, page.getViewport({ scale: 1 })) };
    }
  } catch (e) {
    console.warn('[drw-review] preview render failed:', e.message);
  } finally {
    _drwReviewRendering = false;
    if (_drwReviewPending != null) { const n = _drwReviewPending; _drwReviewPending = null; _drwReviewRenderPage(n); }
  }
}

// The value a clicked piece of text gives a field ("DWG NO: E-101" → "E-101").
function _drwRevValueFrom(field, str) {
  const lab = DrwParse.classifyLabel(str);
  const text = lab && lab.rest && lab.f === field ? lab.rest : String(str || '').trim();
  const toks = text.split(/\s+/);
  if (field === 'sheetNumber') {
    const t = toks.find(x => DrwParse.sheetWeight(x) > 0);
    return DrwParse.normSheet(t || text);
  }
  if (field === 'revision') {
    const m = text.toUpperCase().match(/\bREV(?:ISION)?\.?\s*[:#]?\s*([A-Z0-9]{1,3})\b/);
    if (m && DrwParse.isRevCode(m[1])) return m[1];
    const t = toks.find(x => DrwParse.isRevCode(x));
    return (t || text).toUpperCase();
  }
  if (field === 'pageNumber') {
    const m = text.match(/(\d{1,4})\s*(?:of|\/)\s*\d+/i) || text.match(/\d{1,4}/);
    return m ? (m[1] || m[0]) : text;
  }
  return text;
}

function _drwReviewCanvasClick(e) {
  const hint = document.getElementById('drw-rev-hint');
  const say = t => { if (hint) hint.textContent = t; };
  const field = _drwRevActiveField;
  if (!field || !_DRW_FIELD_LABEL[field]) { say('First click a Sheet #, Title, Rev or Page # field in the table, then click its text here.'); return; }
  const s = _drwParsedSheets[_drwReviewSelectedIdx];
  if (!s || !_drwRevPhrases || _drwRevPhrases.page !== s.pageIndex + 1) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
  const tol = 0.004;
  const hits = _drwRevPhrases.list.filter(p => fx >= p.x - tol && fx <= p.x + p.w + tol && fy >= p.y - tol && fy <= p.y + p.h + tol);
  if (!hits.length) { say(s.noText ? 'This page is a scanned image — there is no text to click. Type the value instead.' : 'No text there — click directly on the words.'); return; }
  const p = hits.sort((a, b) => a.w * a.h - b.w * b.h)[0];
  const idx = _drwReviewSelectedIdx;
  let value = _drwRevValueFrom(field, p.str);
  let box = [p.x, p.y, p.x + p.w, p.y + p.h];
  const sp = _drwRevSpot;
  if (field === 'sheetTitle' && e.shiftKey && s.sheetTitle && sp && sp.field === field && sp.idx === idx) {
    value = s.sheetTitle + ' ' + value;
    box = [Math.min(box[0], sp.box[0]), Math.min(box[1], sp.box[1]), Math.max(box[2], sp.box[2]), Math.max(box[3], sp.box[3])];
  }
  _drwRevSpot = { field, idx, box };
  const inp = document.querySelector(`#drw-rev-row-${idx} input[data-field="${field}"]`);
  if (inp) inp.value = value;
  _drwReviewEdit(idx, field, value);
  s.sources = s.sources || {};
  s.sources[field] = { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] };
  const teach = document.getElementById('drw-rev-teach');
  if (teach && _drwParsedSheets.length > 1) {
    teach.textContent = `Read ${_DRW_FIELD_LABEL[field]} from this spot on every page`;
    teach.style.display = '';
  }
  say(`${_DRW_FIELD_LABEL[field]} set to “${value}”.`);
  _drwReviewRenderPage(s.pageIndex + 1);
}

// Turn the last clicked text into a calibrated box for that field and re-read
// the whole set from it (everything already typed is kept).
async function _drwReviewTeachSpot() {
  const sp = _drwRevSpot;
  if (!sp) return;
  const w = sp.box[2] - sp.box[0], h = sp.box[3] - sp.box[1];
  const padX = Math.max(0.006, w * 0.3), padY = Math.max(0.004, h * (sp.field === 'sheetTitle' ? 0.6 : 0.35));
  const x0 = Math.max(0, sp.box[0] - padX), y0 = Math.max(0, sp.box[1] - padY);
  const x1 = Math.min(1, sp.box[2] + padX), y1 = Math.min(1, sp.box[3] + padY);
  _drwFieldRegions[sp.field] = { fx: x0, fy: y0, fw: x1 - x0, fh: y1 - y0 };
  _drwRevSpot = null;
  const label = _DRW_FIELD_LABEL[sp.field];
  await _drwRunExtract();
  toast(`${label} is now read from that spot on every page (remembered for ${_drwUploadMeta?.location || 'this location'}).`, 'success');
}

// Drop this location's calibrated boxes and re-read with automatic detection.
async function _drwReviewForgetBoxes() {
  _drwFieldRegions = {};
  await _drwRunExtract();   // saving no regions clears them for the location
  toast('Saved boxes forgotten — sheets re-read automatically.', 'success');
}

function _drwHydrateDisciplineReviewInputs() {
  _drwParsedSheets.forEach((s, i) => {
    const cell = document.getElementById(`drw-disc-cell-${i}`);
    if (!cell) return;
    cell.innerHTML = `
      <input id="drw-discipline-${i}" class="form-input" list="drw-discipline-options" value="${escapeHtml(s.discipline || '')}"
        aria-label="Discipline, page ${s.pageIndex + 1}" style="width:104px;font-size:12px;padding:3px 6px;"
        placeholder="Discipline..." ${cxOn('change', '_drwReviewEdit', i, 'discipline', '$cx.value')} />`;
  });
}

function _drwReviewEdit(idx, field, value) {
  const s = _drwParsedSheets[idx];
  if (!s) return;
  s[field] = typeof value === 'string' ? value.trim() : value;
  s._edited = s._edited || {};
  s._edited[field] = true;
  if (field === 'sheetNumber' && !s._edited.discipline) {
    s.discipline = DrwParse.discipline(s[field]);
    const disciplineInput = document.getElementById(`drw-discipline-${idx}`);
    if (disciplineInput) disciplineInput.value = s.discipline || '';
  }
  if (field !== 'discipline') _drwReviewRefreshFlags(true);
}

function _drwReviewToggle(idx, included) {
  if (!_drwParsedSheets[idx]) return;
  _drwParsedSheets[idx].included = !!included;
  _drwParsedSheets[idx]._includedSet = true;
  _drwReviewRefreshFlags(true);
  _drwReviewUpdateCounts();
}

function _drwReviewSelectAll(checked) {
  _drwParsedSheets.forEach((s, i) => {
    s.included = !!checked;
    s._includedSet = true;
    const row = document.getElementById(`drw-rev-row-${i}`);
    const cb  = row?.querySelector('td:first-child input[type="checkbox"]');
    if (cb) cb.checked = !!checked;
  });
  const toggle = document.getElementById('drw-rev-toggle-all');
  if (toggle) toggle.checked = !!checked;
  _drwReviewRefreshFlags(true);
  _drwReviewUpdateCounts();
}

function _drwReviewUpdateCounts() {
  const total    = _drwParsedSheets.length;
  const included = _drwParsedSheets.filter(s => s.included).length;
  const upRevs   = _drwParsedSheets.filter(s => s.included && s._existingSheet).length;
  const pill = document.getElementById('drw-included-pill');
  if (pill) pill.textContent = `${included} of ${total} to import`;
  const upRevPill = document.getElementById('drw-uprev-pill');
  if (upRevPill) {
    upRevPill.style.display = upRevs ? '' : 'none';
    upRevPill.textContent = `↑ ${upRevs} up-rev`;
  }
  const toggle = document.getElementById('drw-rev-toggle-all');
  if (toggle) toggle.checked = included === total && total > 0;
}

function _drwSheetInsertRows(setId, meta, sheets, includePageNumber = true) {
  return sheets.map(s => {
    const row = {
      set_id: setId, location: meta.location, page_index: s.pageIndex,
      sheet_number: s.sheetNumber || null, sheet_title: s.sheetTitle || null,
      discipline: s.discipline || null, revision: s.revision || null,
      is_current: true, confirmed: true, needs_review: s.needsReview || false,
    };
    if (includePageNumber) row.page_number = s.pageNumber || null;
    return row;
  });
}

async function _drwInsertSheetRows(setId, meta, sheets) {
  try {
    await _dbInsert('drawing_sheets', _drwSheetInsertRows(setId, meta, sheets, true));
    return { pageNumberSkipped: false };
  } catch (e) {
    const msg = String(e?.message || '');
    if (!msg.includes("'page_number' column") && !msg.includes('page_number')) throw e;
    console.warn('[drawings import] page_number column missing; retrying without page_number. Run supabase/sql/supabase_drawings_add_page_number.sql to preserve PAGE NO.');
    await _dbInsert('drawing_sheets', _drwSheetInsertRows(setId, meta, sheets, false));
    return { pageNumberSkipped: true };
  }
}

async function _drwConfirmImport() {
  const meta = _drwUploadMeta;
  if (!meta) return;
  const toImport = _drwParsedSheets.filter(s => s.included);
  if (!toImport.length) { toast('Select at least one sheet to import.', 'error'); return; }

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 16px;"></div>
      <p id="drw-confirm-status" style="color:var(--gray-500);">Creating drawing set record…</p>
    </div>`;
  document.querySelector('#modal-overlay .modal-footer').innerHTML = '';

  try {
    const inserted = await _dbInsert('drawing_sets', {
      title: meta.title, location: meta.location,
      import_date: meta.import_date || null, revision_date: meta.revision_date || null,
      release_date: meta.release_date || null,
      uploaded_by: currentRoleUser?.name || 'Admin',
      status: 'processing', total_sheets: toImport.length,
    });
    const setId = inserted[0]?.id;
    if (!setId) throw new Error('Failed to create drawing set record.');

    document.getElementById('drw-confirm-status').textContent = 'Uploading PDF to storage…';
    const storagePath = `${setId}/full.pdf`;
    await _drawStorage.upload(storagePath, meta.file);
    await _dbUpdate('drawing_sets', { storage_path: storagePath }, { id: setId });

    document.getElementById('drw-confirm-status').textContent = 'Checking for existing revisions…';
    // Up-rev: any current sheet in this location whose Drawing Number matches an
    // incoming one is superseded (compared case/space-insensitively so the same
    // number always matches). A prior set left with no current sheets is retired
    // from the active list so re-uploading the same drawings doesn't pile up
    // duplicate sets — it folds in as a new revision instead.
    const _normNum = n => (n == null ? '' : String(n).trim().toUpperCase());
    const newNums = new Set(toImport.map(s => _normNum(s.sheetNumber)).filter(Boolean));
    const toSupersede = DRAWING_SHEETS.filter(s =>
      s.location === meta.location && s.is_current && newNums.has(_normNum(s.sheet_number)));
    if (toSupersede.length) {
      await Promise.all(toSupersede.map(s => _dbUpdate('drawing_sheets', { is_current: false }, { id: s.id })));
      const supersededIds = new Set(toSupersede.map(s => s.id));
      const priorSetIds = new Set(toSupersede.map(s => s.set_id).filter(id => id && id !== setId));
      for (const sid of priorSetIds) {
        const stillCurrent = DRAWING_SHEETS.some(s => s.set_id === sid && s.is_current && !supersededIds.has(s.id));
        if (!stillCurrent) await _dbUpdate('drawing_sets', { status: 'superseded' }, { id: sid }).catch(() => {});
      }
    }

    document.getElementById('drw-confirm-status').textContent = 'Saving sheet records…';
    const insertResult = await _drwInsertSheetRows(setId, meta, toImport);

    const confirmedDisciplines = toImport.map(s => s.discipline).filter(Boolean);
    let addedDisciplines = [];
    try {
      addedDisciplines = await _fscEnsureOptions('drawing_discipline', confirmedDisciplines);
    } catch (cfgErr) {
      console.warn('[drawings import] discipline config update failed:', cfgErr.message);
    }
    await _dbUpdate('drawing_sets', { status: 'ready' }, { id: setId });

    await loadDrawingsData();
    _drwCloseUpload();
    renderDrawingsPage();
    const skipped = _drwParsedSheets.length - toImport.length;
    toast(`Drawing set imported: ${toImport.length} sheets${skipped ? `, ${skipped} skipped` : ''}${toSupersede.length ? `, ${toSupersede.length} auto-upreved` : ''}${addedDisciplines.length ? `, ${addedDisciplines.length} discipline${addedDisciplines.length===1?'':'s'} added` : ''}${insertResult.pageNumberSkipped ? ', page numbers skipped until DB migration is run' : ''}`, 'success');
  } catch(e) {
    document.querySelector('#modal-overlay .modal-body').innerHTML = cxError({ message: 'Import failed: ' + (e.message || e) });
    document.querySelector('#modal-overlay .modal-footer').innerHTML = `<button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Close</button>`;
  }
}
