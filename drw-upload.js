// ==========================================
// HITACHI Rail T&C Portal — Drawings: upload a drawing set (drw-upload.js)
//
// Upload Drawing Set modal: pick a PDF, calibrate title-block fields, read
// every sheet's number / title / revision / page, review, import.
// Moved verbatim out of app.js; loaded AFTER app.js (uses DRAWING_SETS/
// DRAWING_SHEETS, modal(), _db*, _drawStorage, loadDrawingsData).
// ==========================================

// ── Discipline detection ───────────────────────────────────────────────────
function _drwDiscipline(sheetNum) {
  if (!sheetNum) return 'General';
  const prefix = (sheetNum.match(/^([A-Z]+)/i) || [])[1]?.toUpperCase() || '';
  const map = { C:'Civil', E:'Electrical', G:'General', IN:'Index', I:'Index',
                TC:'Train Control', T:'Train Control', M:'Mechanical',
                S:'Structural', A:'Architectural', L:'Landscape',
                FP:'Fire Protection', FS:'Fire & Safety' };
  return map[prefix] || prefix || 'General';
}

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

// ── PDF text parsing ───────────────────────────────────────────────────────
// Title-block field labels we must NOT confuse for values.
const _DRW_LABELS = [
  /^contract\s*sheet\s*no\.?:?$/i,
  /^sheet\s*no\.?:?(\s*of\s*\d+)?$/i,
  /^page\s*no\.?:?$/i,
  /^pg\.?\s*no\.?:?$/i,
  /^dwg\.?\s*no\.?:?$/i,
  /^drawing\s*no\.?:?$/i,
  /^drawing\s*number:?$/i,
  /^drawing\s*title:?$/i,
  /^rev\.?(ision)?:?$/i,
  /^revisions?:?$/i,
  /^scale:?$/i,
  /^size:?$/i,
  /^date:?$/i,
  /^drawn\s*by:?$/i,
  /^designed\s*by:?$/i,
  /^approved\s*by:?$/i,
  /^checked\s*by:?$/i,
  /^title:?$/i,
  /^sheet:?$/i,
  /^of$/i,
  /^cadd\s*filename:?$/i,
  /^filename:?$/i,
  /^nts$/i,
  /^n\.t\.s\.?$/i,
  /^project:?$/i,
  /^description:?$/i,
  /^bart$/i,
  /^contract\s*no\.?:?$/i,
  /^contract:?$/i,
  // PLM / PDM system labels that appear in some title blocks
  /^teamcenter(\s+(dwg|drawing|doc))?\s*(no\.?|number|#):?$/i,
  /^[a-z][a-z\s]+(dwg|drawing|doc)\s*no\.?:$/i,  // e.g. "WBS DWG NO.:"
  /^wbs\s*(no\.?|number)?:?$/i,
  /^wbs\s*bs:?$/i,
  /^cont\.?\s*on:?$/i,
  /^field\s*office:?$/i,
  /^master\s*copy:?$/i,
  /^inspire\s*the\s*next:?$/i,
  /^hitachi:?$/i,
  /^approved$/i,                           // bare approval stamp
  /^cdrl\s*(dwg|drawing)\s*no\.?:?$/i,    // CDRL DWG NO:
];

// Project-banner text that appears on every sheet — should NEVER be picked as a title.
// Match by characteristic keywords so spelling variants ("COMMUNICATIONS" vs
// "COMMINICATIONS") and line splits don't matter.
const _DRW_BANNER_PATTERNS = [
  /design[\s-]+build/i,
  /\bCBTC\b/,
  /communications?\s+based\s+train\s+control/i,
  /train\s+control\s+\(?CBTC/i,
  /\bBART\b/i,                 // BART — always a project/agency name
  /\bBAY\s+AREA\b/i,           // "San Francisco Bay Area" project header
  /rapid\s+transit/i,          // any transit authority name
  /transit\s+district/i,
  /transit\s+authority/i,
  /\bHITACHI\b/i,              // company banner
  /inspire\s+the\s+next/i,     // Hitachi tagline
  /field\s+office\s+master/i,  // "FIELD OFFICE MASTER COPY" stamp
];

// Sheet-number formats — checked in order from most specific to least.
//   E11004-W30-001     long form with page suffix
//   E11004-W30         2-segment contract sheet no.
//   496H-110           mixed alpha/digit prefix
//   E-1001 / E101      legacy short form
const _DRW_SHEET_PATTERNS = [
  /^[A-Z]{1,4}\d{2,}-[A-Z0-9]+-\d+[A-Z]?$/i,   // E11004-W30-001
  /^[A-Z]{1,4}\d{2,}-[A-Z0-9]+$/i,             // E11004-W30
  /^\d+[A-Z]+-\d+[A-Z]?$/i,                      // 496H-110
  /^[A-Z]{1,4}-\d+[A-Z]?$/i,                     // E-1001
  /^[A-Z]{1,3}\d{1,4}[A-Z]?$/i,                  // E101, M22A
];

const _DRW_FILENAME_RE = /([A-Z]{1,4}\d{2,}-[A-Z0-9]+(?:-\d+[A-Z]?)?)/i;

const _DRW_CAL_FIELDS = [
  { key: 'sheetNumber', label: 'Sheet #',  color: '#2563eb' },
  { key: 'pageNumber',  label: 'Page #',   color: '#16a34a' },
  { key: 'sheetTitle',  label: 'Title',    color: '#9333ea' },
  { key: 'revision',    label: 'Revision', color: '#d97706' },
];

function _drwIsLabel(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return _DRW_LABELS.some(re => re.test(t));
}

function _drwIsBanner(s) {
  return _DRW_BANNER_PATTERNS.some(re => re.test(s));
}

function _drwMatchSheetNum(s) {
  const t = s.trim();
  return _DRW_SHEET_PATTERNS.some(re => re.test(t));
}

// Returns true when a string is clearly not a drawing title:
//   • Written-out month dates  → "January 31, 2025"
//   • No-space hyphenated IDs  → "W37-275-375LB24-D", "779-MAIN", "W39ALNX-D"
//     (real titles are English phrases and always contain spaces)
function _drwIsJunkTitle(s) {
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(s)) return true;
  if (!/\s/.test(s) && /-/.test(s)) return true;
  return false;
}

function _drwBuildCells(items, W, H, region) {
  let pdfXMin = 0, pdfXMax = W, pdfYMin = 0, pdfYMax = H * 0.35;
  if (region && region.fw > 0.01 && region.fh > 0.01) {
    pdfYMax = H * (1 - region.fy);
    pdfYMin = H * (1 - region.fy - region.fh);
    pdfXMin = W * region.fx;
    pdfXMax = W * (region.fx + region.fw);
  }
  // Small tolerance so text items on the exact region boundary aren't excluded
  // due to float rounding (the difference between (1-fy-fh)*H and the original
  // boundary can be ~1e-13 even when they're conceptually identical).
  const EPS = 1;
  return items
    .map(it => {
      const x = it.transform[4], y = it.transform[5];
      return { x, y, w: it.width || 0, h: it.height || 10, str: (it.str || '').trim() };
    })
    .filter(c => c.str
      && c.x >= pdfXMin - EPS && c.x <= pdfXMax + EPS
      && c.y >= pdfYMin - EPS && c.y <= pdfYMax + EPS);
}

// Label-anchored value extraction: find the cell matching labelRe, then return the
// closest non-label cell that satisfies valueOk, preferring cells directly below
// or directly to the right of the label (the two standard title-block layouts).
function _drwFindNearLabel(cells, labelRe, valueOk = (() => true), opts = {}) {
  const { maxDist = 120 } = opts;
  const label = cells.find(c => labelRe.test(c.str));
  if (!label) return null;
  const cands = cells
    .filter(c => c !== label && !_drwIsLabel(c.str) && c.str !== label.str)
    .filter(c => valueOk(c.str))
    .map(c => {
      // PDF coords: y increases upward, so "below the label" means c.y < label.y.
      const below = label.y - c.y;     // positive when c is below
      const right = c.x - label.x;     // positive when c is to the right
      const vertical   = below > 0 && below < 40 && Math.abs(right) < 120;
      const horizontal = Math.abs(below) < 14 && right > 0 && right < 140;
      if (vertical)   return { c, dist: below + Math.abs(right) * 0.4 };
      if (horizontal) return { c, dist: right + Math.abs(below) * 0.4 };
      return { c, dist: Math.hypot(below, right) * 3 };
    })
    .filter(o => o.dist < maxDist)
    .sort((a, b) => a.dist - b.dist);
  return cands.length ? cands[0].c.str.trim() : null;
}

function _drwParseSheetInfo(items, W, H, fieldRegions) {
  // If a calibrated region exists for a field, text is pulled directly from
  // that spatial area.  Otherwise falls back to the strategies below.
  const regs = (fieldRegions && typeof fieldRegions.fx !== 'number') ? (fieldRegions || {}) : {};

  // baseCells: all text in the bottom 35% of the page (title-block strip).
  const baseCells = _drwBuildCells(items, W, H, null);
  if (!baseCells.length) {
    return { sheetNumber: null, sheetTitle: null, revision: null, pageNumber: null, discipline: 'General' };
  }

  function fieldCellsFor(key) {
    const r = regs[key];
    if (!r || !r.fw) return null;
    const fc = _drwBuildCells(items, W, H, r);
    return fc.length ? fc : null;
  }

  // ── CONTRACT SHEET NO. ────────────────────────────────────────────────────
  let sheetNumber = null;
  const snCells = fieldCellsFor('sheetNumber');
  if (snCells) {
    for (const c of snCells) {
      if (_drwMatchSheetNum(c.str)) { sheetNumber = c.str.toUpperCase(); break; }
    }
    if (!sheetNumber && snCells.length) sheetNumber = snCells[0].str.toUpperCase();
  } else {
    sheetNumber = _drwFindNearLabel(baseCells, /^contract\s*sheet\s*no\.?$/i, s => _drwMatchSheetNum(s));
    if (!sheetNumber) sheetNumber = _drwFindNearLabel(baseCells, /^(sheet|dwg|drawing)\s*no\.?$/i, s => _drwMatchSheetNum(s));
    if (!sheetNumber) {
      const contractNoVal = _drwFindNearLabel(baseCells, /^contract\s*no\.?$/i, () => true);
      for (const c of baseCells) {
        if (c.str === contractNoVal) continue;
        if (_drwMatchSheetNum(c.str) && !_drwIsLabel(c.str)) { sheetNumber = c.str.toUpperCase(); break; }
      }
    }
    if (!sheetNumber) {
      for (const c of baseCells) {
        if (/\.(dgn|dwg|pdf)\b/i.test(c.str)) {
          const m = c.str.match(_DRW_FILENAME_RE);
          if (m) { sheetNumber = m[1].toUpperCase(); break; }
        }
      }
    }
  }
  if (sheetNumber) sheetNumber = sheetNumber.toUpperCase();

  // ── REV — short code only (01, A, B…), never prose text ──────────────────
  let revision = null;
  const rvCells = fieldCellsFor('revision');
  if (rvCells) {
    for (const c of rvCells) {
      if (/^[A-Z0-9]{1,3}$/.test(c.str) && !/^(OF|NO|TO|NTS|REV|D)$/i.test(c.str)) {
        revision = c.str.toUpperCase(); break;
      }
    }
    if (!revision && rvCells.length) revision = rvCells[0].str.toUpperCase();
  } else {
    revision = _drwFindNearLabel(baseCells, /^rev\.?(ision)?$/i,
      s => /^[A-Z0-9]{1,3}$/.test(s.trim()) && !/^(OF|NO|TO|NTS|REV|REVISION|D)$/i.test(s.trim()),
      { maxDist: 200 });
    if (!revision) {
      for (const c of baseCells) {
        const m = c.str.match(/^rev\.?(?:ision)?[:.\s]+([A-Z0-9]{1,3})$/i);
        if (m) { revision = m[1]; break; }
      }
    }
  }
  if (revision) revision = revision.toUpperCase();

  // ── PAGE NO. — digits only ────────────────────────────────────────────────
  let pageNumber = null;
  const pnCells = fieldCellsFor('pageNumber');
  if (pnCells) {
    for (const c of pnCells) {
      if (/^\d{1,4}$/.test(c.str.trim()) && c.str !== sheetNumber) { pageNumber = c.str.trim(); break; }
    }
    if (!pageNumber && pnCells.length) pageNumber = pnCells[0].str;
  } else {
    pageNumber = _drwFindNearLabel(baseCells, /^(page|pg)\s*no\.?$/i,
      s => /^\d{1,4}$/.test(s.trim()) && s !== sheetNumber,
      { maxDist: 200 });
  }

  // ── TITLE — template anchor: before "DESIGN-BUILD" banner in PDF stream ───
  // In this CBTC drawing template the CAD software writes the per-sheet title
  // text into the PDF content stream BEFORE the "DESIGN-BUILD OF A
  // COMMUNICATIONS BASED TRAIN CONTROL (CBTC) SYSTEM" banner object.
  // Strategy: find the banner item, collect items that (a) appear before it
  // in the stream AND (b) sit spatially below the banner (lower PDF y-coord)
  // within the left column (x < 65% of page width, the title-text area).
  // Multi-line titles are sorted top→bottom and joined with spaces.
  let sheetTitle = null;
  const stCells = fieldCellsFor('sheetTitle');
  if (stCells) {
    // When the user has explicitly calibrated a region, trust their box —
    // just concatenate whatever non-empty text is there, sorted top→bottom.
    const cands = stCells.filter(c => c.str.trim().length > 0);
    if (cands.length) {
      sheetTitle = [...cands].sort((a, b) => b.y - a.y).map(c => c.str.trim()).join(' ').trim();
    }
  }
  if (!sheetTitle) {
    const bannerIdx = items.findIndex(it => /design[\s-]+build/i.test((it.str || '').trim()));
    if (bannerIdx > 0) {
      const bannerY = items[bannerIdx].transform[5];
      const titleLines = items
        .slice(0, bannerIdx)
        .filter(it => {
          const s = (it.str || '').trim();
          const iy = it.transform[5], ix = it.transform[4];
          return s.length >= 3
            && iy < bannerY              // below banner in PDF y-coords
            && iy > bannerY - H * 0.25  // within 25% page-height below banner
            && ix < W * 0.65            // left column (title area, not right data column)
            && !_drwIsLabel(s) && !_drwIsBanner(s) && !_drwMatchSheetNum(s)
            && !/^\d{1,4}$/.test(s) && !_drwIsJunkTitle(s);
        })
        .sort((a, b) => b.transform[5] - a.transform[5]) // top→bottom reading order
        .map(it => (it.str || '').trim());
      if (titleLines.length) sheetTitle = titleLines.join(' ');
    }
  }
  if (!sheetTitle) {
    // Secondary: near an explicit "TITLE" / "DRAWING TITLE" label
    sheetTitle = _drwFindNearLabel(baseCells, /^(drawing\s*)?title$/i,
      s => s.length >= 4 && !_drwIsBanner(s) && !_drwIsLabel(s) && !_drwMatchSheetNum(s) && !_drwIsJunkTitle(s));
  }
  if (!sheetTitle) {
    // Last resort: longest non-banner text in bottom strip.
    // Only applies when a DESIGN-BUILD banner is present (confirms CBTC format).
    // Drawings without that banner (plumbing, wiring sheets, etc.) return null
    // rather than picking legend text or cross-reference content.
    const hasBanner = items.some(it => /design[\s-]+build/i.test((it.str || '').trim()));
    if (hasBanner) {
      const contractNo = _drwFindNearLabel(baseCells, /^contract\s*no\.?$/i, () => true);
      const known = new Set([sheetNumber, revision, pageNumber, contractNo].filter(Boolean).map(s => s.toUpperCase()));
      const cands = baseCells.filter(c => {
        const s = c.str;
        return s.length >= 4 && !_drwIsLabel(s) && !_drwIsBanner(s)
          && !known.has(s.toUpperCase()) && !/^\d+$/.test(s)
          && !/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(s)
          && !/\.(dgn|dwg|pdf)\b/i.test(s) && !_drwMatchSheetNum(s)
          && !_drwIsJunkTitle(s);
      });
      if (cands.length) sheetTitle = cands.reduce((a, b) => b.str.length > a.str.length ? b : a).str;
    }
  }

  return { sheetNumber, sheetTitle, revision, pageNumber, discipline: _drwDiscipline(sheetNumber) };
}

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
}

function _drwOpenUpload() {
  if (typeof uiCan === 'function' && !uiCan('drawings', 'upload_set')) { toast('You do not have permission to upload drawing sets', 'error'); return; }
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
      <button class="admin-action-btn" data-action="_drwStep1Next">Next: Calibrate →</button>`,
  });

  const zone = document.getElementById('drw-drop-zone');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.style.borderColor='var(--hitachi-red)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor=''; });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.style.borderColor='';
    const f = e.dataTransfer.files[0];
    if (f && f.type === 'application/pdf') { document.getElementById('drw-file-name').textContent = f.name; zone._file = f; }
  });
}

function _drwFileChosen(inp) {
  const f = inp.files[0];
  if (f) { document.getElementById('drw-file-name').textContent = f.name; document.getElementById('drw-drop-zone')._file = f; }
}

async function _drwStep1Next() {
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

  _drwUploadMeta = { title, location: loc, import_date: impDate, revision_date: revDate, release_date: relDate, file };

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 16px;"></div>
      <p style="color:var(--gray-500);">Loading PDF…</p>
    </div>`;
  document.querySelector('#modal-overlay .modal-footer').innerHTML = '';

  try {
    if (!await CXLazy.pdfjs()) throw new Error('PDF.js could not be loaded');
    _drwUploadPdfDoc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    await _drwShowCalibrate();
  } catch(e) {
    document.querySelector('#modal-overlay .modal-body').innerHTML = `<p style="color:var(--bad);padding:20px;">${escapeHtml(e.message)}</p>`;
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
    + '<li>Fields without a region use auto-detection</li>'
    + '</ol>'
    + '</div>'
    + '</div>'
    + '</div>';

  document.querySelector('#modal-overlay .modal-footer').innerHTML = ''
    + '<button class="admin-action-btn-secondary" data-action="_drwOpenUpload">← Back</button>'
    + '<button class="admin-action-btn-secondary" data-action="_drwCloseUpload">Cancel</button>'
    + '<button class="admin-action-btn" data-action="_drwRunExtract">Extract with Regions →</button>';

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
    // Cache text items for the live preview (getTextContent uses PDF coords at scale=1)
    const vp1 = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    _drwCalPageItems = { items: content.items, W: vp1.width, H: vp1.height };

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
    // Live preview: show what text items fall inside this region on the current page
    let previewHtml = '';
    if (_drwCalPageItems && _drwCalPageItems.items) {
      const cells = _drwBuildCells(_drwCalPageItems.items, _drwCalPageItems.W, _drwCalPageItems.H, r);
      const found = cells.filter(c => c.str.trim().length > 0).map(c => c.str.trim());
      if (found.length) {
        previewHtml = '<div style="margin-top:7px;padding:6px 8px;background:var(--good-light);border:1px solid var(--good-border);border-radius:5px;">'
          + '<div style="font-size:10px;font-weight:700;color:var(--good);margin-bottom:4px;">Found in region:</div>'
          + found.slice(0, 8).map(s => '<div style="font-size:11px;color:var(--good);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(s) + '</div>').join('')
          + (found.length > 8 ? '<div style="font-size:10px;color:#4ade80;">+' + (found.length - 8) + ' more</div>' : '')
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

async function _drwRunExtract() {
  const _loc = _drwUploadMeta?.location;
  if (_loc) _DRW_CAL_FIELDS.forEach(f => {
    if (_drwFieldRegions[f.key]) _drwSaveFieldRegion(_loc, f.key, _drwFieldRegions[f.key]);
    else localStorage.removeItem(_drwFieldRegionKey(_loc, f.key));
  });
  const numPages = _drwUploadPdfDoc.numPages;

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 16px;"></div>
      <p id="drw-parse-status" style="color:var(--gray-500);">Extracting page 1 of ${numPages}…</p>
      <div style="margin-top:12px;background:var(--gray-100);border-radius:6px;height:6px;width:260px;margin-left:auto;margin-right:auto;">
        <div id="drw-parse-bar" style="background:var(--hitachi-red);height:6px;border-radius:6px;width:0%;transition:width .2s;"></div>
      </div>
    </div>`;
  document.querySelector('#modal-overlay .modal-footer').innerHTML = '';

  try {
    const sheets = [];
    for (let i = 1; i <= numPages; i++) {
      document.getElementById('drw-parse-status').textContent = `Extracting page ${i} of ${numPages}…`;
      document.getElementById('drw-parse-bar').style.width = `${Math.round(i/numPages*100)}%`;
      const page     = await _drwUploadPdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content  = await page.getTextContent();
      const parsed   = _drwParseSheetInfo(content.items, viewport.width, viewport.height, _drwFieldRegions);
      sheets.push({
        pageIndex: i-1, ...parsed,
        needsReview: !parsed.sheetNumber || !parsed.sheetTitle,
        // Pre-uncheck pages with no sheet number AND no title — usually covers/index pages.
        included: !!(parsed.sheetNumber || parsed.sheetTitle || parsed.pageNumber),
      });
    }
    // Safety dedup: if the same revision value appears on every single included
    // sheet AND it looks like a label (e.g. "REV" or "REVISION") rather than
    // an actual revision identifier, clear it.  Title deduplication was removed
    // because legitimate drawing sets can share the same per-sheet title text.
    const _dedupRevision = () => {
      const src = sheets.filter(s => s.included && s.revision);
      if (src.length < 3) return;
      const counts = {};
      src.forEach(s => { const v = s.revision.trim().toUpperCase(); counts[v] = (counts[v]||0) + 1; });
      Object.entries(counts).forEach(([v, n]) => {
        if (n === src.length && /^(REV|REVISION|NO\.?)$/i.test(v)) {
          sheets.forEach(s => { if (s.revision && s.revision.trim().toUpperCase() === v) s.revision = null; });
        }
      });
    };
    _dedupRevision();
    _drwParsedSheets = sheets;
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

function _drwShowReview(numPages) {
  // Detect up-revs: existing current sheets at this location with matching drawing numbers.
  const _normNumR = n => (n == null ? '' : String(n).trim().toUpperCase());
  const reviewLoc = _drwUploadMeta?.location;
  const existingByNum = {};
  DRAWING_SHEETS.filter(s => s.location === reviewLoc && s.is_current)
    .forEach(s => { if (s.sheet_number) existingByNum[_normNumR(s.sheet_number)] = s; });
  // On first show, auto-bump revisions for up-rev sheets.
  _drwParsedSheets.forEach(s => {
    if (!s._upRevInit) {
      const ex = existingByNum[_normNumR(s.sheetNumber || '')];
      if (ex) {
        s._existingSheet = ex;
        // Up-rev: always advance past the existing sheet's revision. The extract
        // usually reads the same number off the title block, so bump regardless.
        s.revision = _drwBumpRev(ex.revision);
      }
      s._upRevInit = true;
    }
  });

  const needsReview   = _drwParsedSheets.filter(s => s.needsReview).length;
  const includedCount = _drwParsedSheets.filter(s => s.included).length;
  const upRevCount    = _drwParsedSheets.filter(s => s.included && s._existingSheet).length;

  // Keep the wide modal (from calibrate) so the PDF preview is readable.
  const modalEl = document.querySelector('#modal-overlay .modal');
  if (modalEl) { modalEl.className = 'modal modal-large'; modalEl.style.maxWidth = '98vw'; modalEl.style.width = '98vw'; modalEl.style.maxHeight = '95vh'; }

  document.querySelector('#modal-overlay .modal-head .modal-title').textContent = 'Review Sheets';
  const subEl = document.querySelector('#modal-overlay .modal-head .modal-sub');
  if (subEl) subEl.textContent = 'Click any row to preview that PDF page, fix anything the extract got wrong, uncheck pages to omit, then Confirm.';

  document.querySelector('#modal-overlay .modal-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
      <span style="font-size:13px;color:var(--gray-600);">${numPages} pages parsed.</span>
      <span id="drw-included-pill" style="background:#e0e7ff;color:var(--info);padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">${includedCount} of ${numPages} to import</span>
      ${upRevCount ? `<span id="drw-uprev-pill" style="background:var(--warn-light);color:#c2410c;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">↑ ${upRevCount} up-rev</span>` : `<span id="drw-uprev-pill" style="display:none;background:var(--warn-light);color:#c2410c;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;"></span>`}
      ${needsReview
        ? `<span style="background:var(--warn-light);color:var(--warn);padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">${icon('alert')} ${needsReview} need manual entry</span>`
        : `<span style="background:var(--good-light);color:var(--good);padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">✓ All sheets parsed</span>`}
      <button class="admin-action-btn-secondary" data-action="_drwReviewSelectAll" data-args="[true]" style="font-size:12px;padding:5px 10px;">Select all</button>
      <button class="admin-action-btn-secondary" data-action="_drwReviewSelectAll" data-args="[false]" style="font-size:12px;padding:5px 10px;">Select none</button>
      <button class="admin-action-btn-secondary" data-action="_drwShowCalibrate" style="font-size:12px;padding:5px 10px;margin-left:auto;">↩ Recalibrate region</button>
    </div>
    ${_drwDisciplineListHTML()}
    <div style="display:flex;gap:16px;align-items:flex-start;">
      <!-- PDF preview -->
      <div style="flex:1 1 52%;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <button class="admin-action-btn-secondary" id="drw-rev-prev" style="padding:5px 11px;font-size:13px;">◀</button>
          <span id="drw-rev-prev-label" style="font-size:12.5px;font-weight:600;color:var(--gray-700);">Page —</span>
          <button class="admin-action-btn-secondary" id="drw-rev-next" style="padding:5px 11px;font-size:13px;">▶</button>
          <span id="drw-rev-prev-meta" style="font-size:12px;color:var(--warn);font-weight:600;"></span>
          <span style="display:inline-flex;align-items:center;gap:4px;margin-left:auto;">
            <button class="admin-action-btn-secondary" id="drw-rev-zoom-out" style="padding:5px 10px;font-size:14px;font-weight:700;" title="Zoom out">−</button>
            <span id="drw-rev-zoom-label" style="font-size:12px;font-weight:600;color:var(--gray-600);min-width:42px;text-align:center;">Fit</span>
            <button class="admin-action-btn-secondary" id="drw-rev-zoom-in" style="padding:5px 10px;font-size:14px;font-weight:700;" title="Zoom in">+</button>
            <button class="admin-action-btn-secondary" id="drw-rev-zoom-reset" style="padding:5px 10px;font-size:12px;" title="Fit to width">Fit</button>
          </span>
        </div>
        <div id="drw-rev-stage" style="position:relative;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:6px;overflow:auto;max-height:64vh;min-height:300px;display:flex;align-items:flex-start;justify-content:center;">
          <canvas id="drw-rev-pdf" style="display:block;"></canvas>
        </div>
      </div>
      <!-- Editable list -->
      <div style="flex:1 1 48%;min-width:0;">
        <div style="max-height:64vh;overflow-y:auto;border:1px solid var(--gray-200);border-radius:8px;">
          <table class="data-table">
            <thead><tr>
              <th style="width:40px;"><input type="checkbox" id="drw-rev-toggle-all" ${includedCount === _drwParsedSheets.length ? 'checked' : ''} ${cxOn('change', '_drwReviewSelectAll', '$cx.checked')} title="Toggle all" /></th>
              <th style="width:34px;">Pg</th><th>Sheet #</th><th>Page #</th><th>Title</th><th>Rev</th><th>Discipline</th><th style="width:70px;">Status</th>
            </tr></thead>
            <tbody>
              ${_drwParsedSheets.map((s, i) => {
                const rowUpRev = !!s._existingSheet;
                const rowStyle = !s.included
                  ? `opacity:0.45;background:var(--gray-50);${rowUpRev ? 'border-left:3px solid var(--accent-amber);' : ''}`
                  : rowUpRev ? 'background:var(--warn-light);border-left:3px solid var(--accent-amber);'
                  : s.needsReview ? 'background:var(--warn-light);' : '';
                const statusCell = rowUpRev
                  ? `<span style="display:inline-flex;align-items:center;background:var(--warn-light);color:var(--warn);padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap;">↑ Rev</span><br><span style="font-size:10px;color:var(--gray-400);">was: ${escapeHtml(s._existingSheet.revision || '—')}</span>`
                  : `<span style="font-size:10px;color:var(--gray-400);">New</span>`;
                return `
                <tr id="drw-rev-row-${i}" class="drw-rev-clickable" ${cxAct('_drwReviewShowPage', i)} style="${rowStyle}">
                  <td style="text-align:center;" data-action=""><input type="checkbox" ${s.included ? 'checked' : ''} ${cxOn('change', '_drwReviewToggle', i, '$cx.checked')} /></td>
                  <td style="color:var(--gray-400);font-size:12px;">${s.pageIndex+1}</td>
                  <td><input class="form-input" value="${escapeHtml(s.sheetNumber||'')}"
                    style="width:110px;font-family:monospace;font-size:12px;padding:3px 6px;border-color:${s.sheetNumber?'var(--gray-200)':'var(--warn)'};"
                    ${cxOn('change', '_drwReviewEdit', i, 'sheetNumber', '$cx.value')} /></td>
                  <td><input class="form-input" value="${escapeHtml(s.pageNumber||'')}"
                    style="width:54px;font-family:monospace;font-size:12px;padding:3px 6px;text-align:center;"
                    ${cxOn('change', '_drwReviewEdit', i, 'pageNumber', '$cx.value')} /></td>
                  <td><input class="form-input" value="${escapeHtml(s.sheetTitle||'')}"
                    style="width:100%;min-width:130px;font-size:12px;padding:3px 6px;border-color:${s.sheetTitle?'var(--gray-200)':'var(--warn)'};"
                    ${cxOn('change', '_drwReviewEdit', i, 'sheetTitle', '$cx.value')} /></td>
                  <td><input class="form-input" value="${escapeHtml(s.revision||'')}"
                    style="width:48px;font-size:12px;padding:3px 6px;"
                    ${cxOn('change', '_drwReviewEdit', i, 'revision', '$cx.value')} /></td>
                  <td id="drw-disc-cell-${i}" style="font-size:12px;color:var(--gray-500);">${escapeHtml(s.discipline||'—')}</td>
                  <td style="text-align:center;padding:4px;">${statusCell}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <p style="font-size:11px;color:var(--gray-400);margin-top:8px;">Click a row to preview its page. Edit any field directly; discipline suggestions come from Field Config.</p>
      </div>
    </div>`;

  _drwHydrateDisciplineReviewInputs();

  document.querySelector('#modal-overlay .modal-footer').innerHTML = `
    <button class="admin-action-btn-secondary" data-action="_drwShowCalibrate">← Recalibrate</button>
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
  _drwReviewZoomScale = 0; // 0 = fit-to-width
  // Preview the first page that's set to import (fall back to page 1).
  const firstIncluded = _drwParsedSheets.findIndex(s => s.included);
  _drwReviewShowPage(firstIncluded >= 0 ? firstIncluded : 0);
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

async function _drwReviewRenderPage(pageNum) {
  if (!_drwUploadPdfDoc || _drwReviewRendering) return;
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
    // Draw field-region overlays so the user can see exactly where calibration lands.
    const _revLoc = _drwUploadMeta?.location;
    const _revRegs = Object.keys(_drwFieldRegions).length > 0
      ? _drwFieldRegions
      : (_revLoc ? _drwLoadAllFieldRegions(_revLoc) : {});
    if (Object.keys(_revRegs).length > 0) {
      const ctx2 = cv.getContext('2d');
      const lw = Math.max(2, cv.width / 300);
      const fs = Math.max(11, Math.round(cv.width / 55));
      _DRW_CAL_FIELDS.forEach(f => {
        const r = _revRegs[f.key];
        if (!r || !r.fw || !r.fh) return;
        const rx = r.fx * cv.width, ry = r.fy * cv.height;
        const rw = r.fw * cv.width,  rh = r.fh * cv.height;
        ctx2.save();
        ctx2.strokeStyle = f.color; ctx2.lineWidth = lw;
        ctx2.setLineDash([8, 4]);
        ctx2.strokeRect(rx + lw, ry + lw, rw - lw*2, rh - lw*2);
        ctx2.fillStyle = f.color + '1a';
        ctx2.fillRect(rx + lw, ry + lw, rw - lw*2, rh - lw*2);
        ctx2.setLineDash([]);
        ctx2.font = `bold ${fs}px sans-serif`;
        const tw = ctx2.measureText(f.label).width;
        ctx2.fillStyle = f.color + 'cc';
        ctx2.fillRect(rx + lw, ry + lw, tw + 8, fs + 6);
        ctx2.fillStyle = '#fff';
        ctx2.fillText(f.label, rx + lw + 4, ry + lw + fs);
        ctx2.restore();
      });
    }
    const zl = document.getElementById('drw-rev-zoom-label');
    if (zl) zl.textContent = _drwReviewZoomScale ? `${Math.round((_drwReviewZoomScale / _drwReviewFitScale) * 100)}%` : 'Fit';
  } catch (e) {
    console.warn('[drw-review] preview render failed:', e.message);
  } finally {
    _drwReviewRendering = false;
  }
}

function _drwHydrateDisciplineReviewInputs() {
  _drwParsedSheets.forEach((s, i) => {
    const cell = document.getElementById(`drw-disc-cell-${i}`);
    if (!cell) return;
    cell.innerHTML = `
      <input id="drw-discipline-${i}" class="form-input" list="drw-discipline-options" value="${escapeHtml(s.discipline || '')}"
        style="width:160px;font-size:12px;padding:3px 6px;"
        placeholder="Discipline..." ${cxOn('change', '_drwReviewEdit', i, 'discipline', '$cx.value')} />`;
  });
}

function _drwReviewEdit(idx, field, value) {
  if (_drwParsedSheets[idx]) {
    _drwParsedSheets[idx][field] = value;
    if (field === 'sheetNumber') {
      _drwParsedSheets[idx].discipline = _drwDiscipline(value);
      const disciplineInput = document.getElementById(`drw-discipline-${idx}`);
      if (disciplineInput) disciplineInput.value = _drwParsedSheets[idx].discipline || '';
    }
  }
}

function _drwReviewToggle(idx, included) {
  if (!_drwParsedSheets[idx]) return;
  _drwParsedSheets[idx].included = !!included;
  const row = document.getElementById(`drw-rev-row-${idx}`);
  if (row) {
    const s = _drwParsedSheets[idx];
    const hasUpRev = !!s._existingSheet;
    row.style.cssText = !s.included
      ? `opacity:0.45;background:var(--gray-50);${hasUpRev ? 'border-left:3px solid var(--accent-amber);' : ''}`
      : hasUpRev ? 'background:var(--warn-light);border-left:3px solid var(--accent-amber);'
      : s.needsReview ? 'background:var(--warn-light);' : '';
  }
  _drwReviewUpdateCounts();
}

function _drwReviewSelectAll(checked) {
  _drwParsedSheets.forEach((s, i) => {
    s.included = !!checked;
    const row = document.getElementById(`drw-rev-row-${i}`);
    const cb  = row?.querySelector('td:first-child input[type="checkbox"]');
    if (cb) cb.checked = !!checked;
    if (row) {
      const hasUpRev = !!s._existingSheet;
      row.style.cssText = !s.included
        ? `opacity:0.45;background:var(--gray-50);${hasUpRev ? 'border-left:3px solid var(--accent-amber);' : ''}`
        : hasUpRev ? 'background:var(--warn-light);border-left:3px solid var(--accent-amber);'
        : s.needsReview ? 'background:var(--warn-light);' : '';
    }
  });
  const toggle = document.getElementById('drw-rev-toggle-all');
  if (toggle) toggle.checked = !!checked;
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
