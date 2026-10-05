// ==========================================
// HITACHI Rail T&C Portal — Forms: upload a new form from the Forms page
// (forms-new.js)
//
// Until now a form could only be created from somewhere else — the paperclip
// on a test-case row (attach + link) or the Activity Templates editor (template
// blank). The Forms page itself, the repository of every form, had no way to
// add one. This module gives it a "+ New Form" button: pick a PDF, name and
// place it (subsystem / phase / location), mark it as a template blank or not,
// and optionally link it to a test case in the same step.
//
// It reuses the existing storage + DB helpers in app.js (_formsCreate,
// _formsLinkToTest, renderFormsPage), so the stored row is identical to one
// made by the other two entry points. Loaded AFTER app.js.
// ==========================================

function _fnCanUpload() { return (typeof uiCan !== 'function') || uiCan('forms', 'upload'); }
function _fnVal(id) { return (document.getElementById(id)?.value || '').trim(); }

// Header button rendered into the Forms page (hidden without forms.upload).
function _formsNewBtnHTML() {
  if (!_fnCanUpload()) return '';
  return `<button class="form-submit" data-action="openNewFormFromPage">${icon('plus')} New Form</button>`;
}

// Distinct values already in use, for the datalist suggestions.
function _fnDistinct(rows, keys) {
  const out = new Set();
  (rows || []).forEach(r => keys.forEach(k => { const v = r && r[k]; if (v != null && String(v).trim()) out.add(String(v).trim()); }));
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function _fnDatalist(id, values) {
  return `<datalist id="${id}">${values.map(v => `<option value="${escapeHtml(v)}"></option>`).join('')}</datalist>`;
}

// Test cases a form can be linked to: latest attempts, labelled by code + name.
function _fnTestOptions() {
  const rows = (typeof TI !== 'undefined' ? TI : []).filter(r => typeof _isLatestAttempt !== 'function' || _isLatestAttempt(r));
  return rows.map(r => ({
    id: String(r.TestID),
    label: [r.TestCaseCode, r.TestName].filter(Boolean).join(' — ') || String(r.TestID),
  }));
}

function openNewFormFromPage() {
  if (!_fnCanUpload()) { toast('You do not have permission to upload forms', 'error'); return; }
  const src = [...(typeof FORMS !== 'undefined' ? FORMS : []), ...(typeof TI !== 'undefined' ? TI : [])];
  const subs = _fnDistinct(src, ['subsystem', 'Subsystem']);
  const phases = _fnDistinct(src, ['phase', 'Phase']);
  const locs = _fnDistinct(src, ['location', 'Location']);
  const tests = _fnTestOptions();
  modal({
    title: 'New Form',
    sub: 'Upload a PDF to the forms repository',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full"><label for="fn-file">PDF File</label><input type="file" id="fn-file" accept="application/pdf" class="form-input"></div>
        <div class="form-field form-field-full"><label for="fn-name">Form Name</label><input type="text" id="fn-name" class="form-input" placeholder="e.g. PWR-001 Data Sheet"></div>
        <div class="form-field"><label for="fn-sub">Subsystem</label><input type="text" id="fn-sub" class="form-input" list="fn-sub-list">${_fnDatalist('fn-sub-list', subs)}</div>
        <div class="form-field"><label for="fn-phase">Phase</label><input type="text" id="fn-phase" class="form-input" list="fn-phase-list">${_fnDatalist('fn-phase-list', phases)}</div>
        <div class="form-field form-field-full"><label for="fn-loc">Location</label><input type="text" id="fn-loc" class="form-input" list="fn-loc-list">${_fnDatalist('fn-loc-list', locs)}</div>
        <div class="form-field form-field-full"><label for="fn-desc">Notes / Description</label><textarea id="fn-desc" class="form-input" rows="2" placeholder="Optional high-level description"></textarea></div>
        <div class="form-field form-field-full">
          <label style="display:flex;align-items:center;gap:8px;font-weight:500;">
            <input type="checkbox" id="fn-template" data-change="_fnToggleTemplate" data-args='["$cx.checked"]'>
            Template blank (reusable, not tied to a single test case)
          </label>
        </div>
        <div class="form-field form-field-full" id="fn-link-wrap">
          <label for="fn-test">Link to Test Case <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label>
          <input type="text" id="fn-test" class="form-input" list="fn-test-list" placeholder="Start typing a test case code or name">
          ${_fnDatalist('fn-test-list', tests.map(t => t.label))}
        </div>
      </div>
    `,
    footer: `<button class="form-secondary" data-action="closeModal">Cancel</button>
             <button class="form-submit" data-action="submitNewFormFromPage">Upload</button>`,
  });
  setTimeout(() => document.getElementById('fn-file')?.focus(), 100);
}

function _fnToggleTemplate(checked) {
  const wrap = document.getElementById('fn-link-wrap');
  if (wrap) wrap.style.display = checked ? 'none' : '';
}

// Resolve the typed test-case label back to a TestID ('' = no link, null = no match).
function _fnResolveTest(label) {
  if (!label) return '';
  const hit = _fnTestOptions().find(t => t.label === label || t.id === label);
  return hit ? hit.id : null;
}

async function submitNewFormFromPage() {
  if (!_fnCanUpload()) { toast('You do not have permission to upload forms', 'error'); return; }
  const file = document.getElementById('fn-file')?.files?.[0];
  if (!file) { toast('Select a PDF', 'error'); return; }
  if (file.type !== 'application/pdf') { toast('File must be a PDF', 'error'); return; }
  const name = _fnVal('fn-name');
  if (!name) { toast('Name is required', 'error'); return; }
  const isTemplate = !!document.getElementById('fn-template')?.checked;
  const testId = isTemplate ? '' : _fnResolveTest(_fnVal('fn-test'));
  if (testId === null) { toast('Pick a test case from the list, or leave it blank', 'error'); return; }

  const btn = document.querySelector('.modal-footer .form-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  try {
    const created = await _formsCreate({
      name,
      description: _fnVal('fn-desc'),
      subsystem: _fnVal('fn-sub'),
      phase: _fnVal('fn-phase'),
      location: _fnVal('fn-loc'),
      isTemplate, originalFilename: file.name, fileSize: file.size, file,
    });
    if (testId) await _formsLinkToTest(created.id, testId);
    if (typeof logAudit === 'function') logAudit('Form Uploaded', name, testId ? `Linked to ${testId}` : (isTemplate ? 'Template blank' : 'Unlinked'));
    toast('✓ Form uploaded', 'success');
    closeModal();
    if (isTemplate && typeof _formsPageFilters !== 'undefined') _formsPageFilters.showTemplates = true;
    renderFormsPage();
  } catch (e) {
    toast('Upload failed: ' + (e.message || e), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
  }
}
