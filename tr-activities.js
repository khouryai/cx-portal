// ==========================================
// HITACHI Rail T&C Portal — Test Register: create + duplicate activities
// (tr-activities.js)
//
// An "activity" in the register is not its own row: _amGetActivities() derives
// it from the test_items that share Phase||Location||Subsystem||Activity. Until
// now the only ways to get one were a CSV import or a template deployment —
// the `test_register.add_activity` capability existed with nothing behind it.
// This module gives the register two entry points of its own:
//
//   • New Activity   — name it, place it (phase / location / subsystem), give
//                      it its starter test cases, and it exists.
//   • Duplicate      — copy an existing activity to a new name/location, with
//                      its test-case structure and statuses reset to
//                      Not Started (a copy is a fresh run, never a result).
//
// Both write test_items rows and then re-derive the register from the DB, so
// nothing here needs its own view of what an activity is. Loaded AFTER app.js
// (it calls _amGetActivities/_dbInsert/loadTestItems and is called back from
// two markup hooks in _testRegisterHTML).
// ==========================================

// Modal state — which mode the open form is in, and the source activity key
// when duplicating. In CXStore rather than loose globals (see docs/adr/0001).
const _TRA_MODE_KEY = 'tr.actFormMode';   // 'create' | 'duplicate'
const _TRA_SRC_KEY  = 'tr.actFormSource'; // source activity key when duplicating

function _traState(key) { return (typeof CXStore !== 'undefined' && CXStore.get(key)) || ''; }
function _traSetState(key, v) { if (typeof CXStore !== 'undefined') CXStore.set(key, v); }

function _traCan() { return (typeof uiCan !== 'function') || uiCan('test_register', 'add_activity'); }
function _traVal(id) { return (document.getElementById(id)?.value || '').trim(); }

// Activity keys reach the markup HTML-escaped (the Edit button does the same),
// so match on both forms rather than trusting the round-trip.
function _traFind(key) {
  const all = (typeof _amGetActivities === 'function') ? _amGetActivities() : [];
  return all.find(a => a.key === key) || all.find(a => escapeHtml(a.key) === key) || null;
}

function _traUniqueId(seed, i) {
  const taken = new Set((typeof TI !== 'undefined' ? TI : []).map(r => String(r.TestID)));
  let id = `${seed}-${i}`;
  while (taken.has(id)) id = `${seed}-${i}-${Math.random().toString(36).slice(2, 5)}`;
  return id;
}

// ── Markup hooks (called from _testRegisterHTML in app.js) ────────────────
function _trNewActivityBtnHTML() {
  if (!_traCan()) return '';
  return `<button class="v2-btn-primary" data-action="_trNewActivityModal" title="Create a new activity in the register">${icon('plus')} New Activity</button>`;
}
function _trDupBtnHTML(key) {
  if (!_traCan()) return '';
  return `<button class="form-secondary tr-mini-btn" aria-label="Duplicate activity" title="Duplicate — copies this activity's test cases into a new activity, statuses reset" ${cxAct('_trDuplicateActivityModal', String(key))}>${icon('copy')}</button>`;
}

// ── The shared form ───────────────────────────────────────────────────────
function _traPhaseOptions() {
  const fromLocs = (typeof LOCS !== 'undefined' ? LOCS : []).filter(l => l.level === 1).map(l => l.name);
  const fromTI   = (typeof TI !== 'undefined' ? TI : []).map(r => r.Phase);
  return [...new Set([...fromLocs, ...fromTI].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function _traLocationOptions(phase) {
  const scoped = (typeof _amLocationsForPhase === 'function') ? _amLocationsForPhase(phase) : [];
  if (scoped.length) return scoped;
  return [...new Set((typeof TI !== 'undefined' ? TI : []).map(r => r.Location).filter(Boolean))].sort();
}
function _traSubsystemOptions() {
  return [...new Set((typeof TI !== 'undefined' ? TI : []).map(r => r.Subsystem).filter(Boolean))].sort();
}
function _traOptionList(values) {
  return values.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
}

// Phase drives which locations are offered — refresh the datalist in place.
function _traPhaseChanged() {
  const list = document.getElementById('tra-loc-list');
  if (list) list.innerHTML = _traOptionList(_traLocationOptions(_traVal('tra-phase')));
}

function _traFormHTML(o) {
  const userSub = (typeof currentRoleUser !== 'undefined' && currentRoleUser?.subsystem) || '';
  const subsystem = o.subsystem || userSub || '';
  return `
    <div class="form-grid">
      <div class="form-field form-field-full">
        <label>Activity Name</label>
        <input type="text" id="tra-name" class="form-input" value="${escapeHtml(o.name || '')}" placeholder="e.g. M90 · ATS/IXL Lab Testing" autocomplete="off">
      </div>
      <div class="form-field">
        <label>Phase</label>
        <input type="text" id="tra-phase" class="form-input" list="tra-phase-list" value="${escapeHtml(o.phase || '')}" placeholder="Pick or type a phase" autocomplete="off" ${cxOn('change', '_traPhaseChanged')}>
        <datalist id="tra-phase-list">${_traOptionList(_traPhaseOptions())}</datalist>
      </div>
      <div class="form-field">
        <label>Location</label>
        <input type="text" id="tra-location" class="form-input" list="tra-loc-list" value="${escapeHtml(o.location || '')}" placeholder="Pick or type a location" autocomplete="off">
        <datalist id="tra-loc-list">${_traOptionList(_traLocationOptions(o.phase || ''))}</datalist>
      </div>
      <div class="form-field">
        <label>Subsystem</label>
        <input type="text" id="tra-subsystem" class="form-input" list="tra-sub-list" value="${escapeHtml(subsystem)}" placeholder="Pick or type a subsystem" autocomplete="off" ${userSub ? 'readonly title="Locked to your assigned subsystem"' : ''}>
        <datalist id="tra-sub-list">${_traOptionList(_traSubsystemOptions())}</datalist>
      </div>
      <div class="form-field">
        <label>Test Report</label>
        ${(typeof _trpReportSelectHTML === 'function') ? _trpReportSelectHTML('', o.report || '') : ''}
      </div>
      ${o.extra || ''}
    </div>`;
}

// ── New activity ──────────────────────────────────────────────────────────
function _trNewActivityModal() {
  if (!_traCan()) { toast('You do not have permission to create activities.', 'error'); return; }
  _traSetState(_TRA_MODE_KEY, 'create');
  _traSetState(_TRA_SRC_KEY, '');
  const f = (typeof _amFilters !== 'undefined') ? _amFilters : {};
  const extra = `
    <div class="form-field form-field-full">
      <label>Test Section / Procedure <span style="font-weight:400;text-transform:none;letter-spacing:normal;color:var(--gray-500);">(optional — applied to every starter case)</span></label>
      <input type="text" id="tra-proc" class="form-input" placeholder="e.g. Interlocking Functional Tests" autocomplete="off">
    </div>
    <div class="form-field form-field-full">
      <label>Test Cases <span style="font-weight:400;text-transform:none;letter-spacing:normal;color:var(--gray-500);">one per line — “CODE | Name”, or just a name</span></label>
      <textarea id="tra-cases" class="form-input" rows="6" placeholder="IXL-001 | Power-up and self test&#10;IXL-002 | Route setting and cancellation&#10;IXL-003 | Emergency stop"></textarea>
    </div>`;
  modal({
    title: 'New Activity',
    size: 'large',
    body: _traFormHTML({ phase: f.phase || '', location: f.location || '', subsystem: f.subsystem || '', extra }) +
      `<p style="font-size:12px;color:var(--gray-500);margin-top:12px;">An activity is defined by its test cases — leave the list empty and one placeholder case is created so you can build it out in the drill-down. Every case starts at Not Started.</p>`,
    footer: `<button class="form-secondary" data-action="closeModal">Cancel</button>` +
      `<button class="admin-action-btn" data-action="_traSave">${icon('plus')} Create Activity</button>`,
  });
}

// ── Duplicate an existing activity ────────────────────────────────────────
function _trDuplicateActivityModal(key) {
  if (!_traCan()) { toast('You do not have permission to create activities.', 'error'); return; }
  const src = _traFind(key);
  if (!src) { toast('Activity not found', 'error'); return; }
  _traSetState(_TRA_MODE_KEY, 'duplicate');
  _traSetState(_TRA_SRC_KEY, key);
  const parents  = src.items.filter(r => !r.ParentTestId);
  const children = src.items.length - parents.length;
  const extra = `
    <div class="form-field form-field-full">
      <label>Test Cases</label>
      <label style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:normal;color:var(--text);cursor:pointer;">
        <input type="checkbox" id="tra-copy-cases" checked style="width:15px;height:15px;cursor:pointer;">
        Copy all ${parents.length} test case${parents.length !== 1 ? 's' : ''} from “${escapeHtml(src.activity)}”
      </label>
      <label style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:normal;color:var(--text);cursor:pointer;margin-top:6px;">
        <input type="checkbox" id="tra-copy-notes" style="width:15px;height:15px;cursor:pointer;">
        Also copy the case notes
      </label>
    </div>`;
  modal({
    title: 'Duplicate Activity',
    size: 'large',
    body: `<div style="font-size:12px;color:var(--gray-600);margin-bottom:14px;padding:9px 12px;background:var(--gray-50);border-radius:6px;">
        ${icon('copy')} Copying <b>${escapeHtml(src.activity)}</b> — ${escapeHtml(src.phase)} · ${escapeHtml(src.location)} · ${escapeHtml(src.subsystem)}
      </div>` +
      _traFormHTML({
        name: src.activity + ' (Copy)', phase: src.phase === '—' ? '' : src.phase,
        location: src.location === '—' ? '' : src.location, subsystem: src.subsystem === '—' ? '' : src.subsystem,
        report: src.testReport || '', extra,
      }) +
      `<p style="font-size:12px;color:var(--gray-500);margin-top:12px;">The copy is a fresh run: every case comes across at Not Started, and results, status history, completion sign-off, blocked/failed reasons, photos and asset links stay with the original.${children ? ` ${children} asset/dynamic child row${children !== 1 ? 's are' : ' is'} not copied — they are regenerated from their parent case.` : ''} Change the location or name so the copy doesn’t collide with the original.</p>`,
    footer: `<button class="form-secondary" data-action="closeModal">Cancel</button>` +
      `<button class="admin-action-btn" data-action="_traSave">${icon('copy')} Create Copy</button>`,
  });
}

// ── Parse the starter test-case lines: "CODE | Name", "CODE<TAB>Name", "Name"
function _traParseCases(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.{1,40}?)\s*(?:\||\t)\s*(.+)$/);
    return m ? { code: m[1].trim(), name: m[2].trim() } : { code: '', name: line };
  });
}

// ── Save (both modes) ─────────────────────────────────────────────────────
async function _traSave() {
  if (!_traCan()) { toast('You do not have permission to create activities.', 'error'); return; }
  const mode = _traState(_TRA_MODE_KEY) || 'create';
  const src  = mode === 'duplicate' ? _traFind(_traState(_TRA_SRC_KEY)) : null;
  if (mode === 'duplicate' && !src) { toast('Source activity not found', 'error'); return; }

  const name      = _traVal('tra-name');
  const phase     = _traVal('tra-phase');
  const location  = _traVal('tra-location');
  const subsystem = _traVal('tra-subsystem');
  if (!name)      { toast('Activity name is required', 'error'); document.getElementById('tra-name')?.focus(); return; }
  if (!phase)     { toast('Phase is required', 'error'); document.getElementById('tra-phase')?.focus(); return; }
  if (!location)  { toast('Location is required', 'error'); document.getElementById('tra-location')?.focus(); return; }
  if (!subsystem) { toast('Subsystem is required', 'error'); document.getElementById('tra-subsystem')?.focus(); return; }

  // The register keys an activity on all four fields — a collision would merge
  // the new cases into the existing activity instead of creating one.
  const key = `${phase}||${location}||${subsystem}||${name}`;
  if (_traFind(key)) {
    toast('An activity with that name already exists at this phase / location / subsystem', 'error');
    return;
  }

  const btn = [...document.querySelectorAll('.modal-footer .admin-action-btn')].pop();
  const btnHTML = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = mode === 'duplicate' ? 'Copying…' : 'Creating…'; }

  try {
    let link = (typeof _trpReportLinkFromModal === 'function') ? _trpReportLinkFromModal() : null;
    if (typeof _trpResolveReportLink === 'function') link = await _trpResolveReportLink(link, { phase, location, subsystem, activity: name });
    const reportPatch = (typeof _trpReportLinkPatch === 'function') ? _trpReportLinkPatch(link) : {};

    const seed = `TC-${Date.now().toString(36)}`;
    const base = { phase, location, subsystem, activity: name, status: 'Not Started', ...reportPatch };
    let rows;

    if (mode === 'duplicate' && document.getElementById('tra-copy-cases')?.checked) {
      const keepNotes = !!document.getElementById('tra-copy-notes')?.checked;
      rows = src.items.filter(r => !r.ParentTestId).map((r, i) => ({
        ...base,
        test_id:        _traUniqueId(seed, i + 1),
        test_case_code: r.TestCaseCode  || null,
        test_name:      r.TestName      || null,
        test_procedure: r.TestProcedure || null,
        test_section:   r.TestSection   || null,
        test_category:  r.TestCategory  || null,
        test_phase:     r.TestPhase     || null,
        scope_type:     String(r.ScopeType || 'static').toLowerCase() === 'dynamic' ? 'dynamic' : 'static',
        weight:         r.Weight ?? 1,
        notes:          keepNotes ? (r.Notes || null) : null,
        is_parent:      false,
      }));
    } else {
      const proc = _traVal('tra-proc');
      const cases = mode === 'duplicate' ? [] : _traParseCases(_traVal('tra-cases'));
      const list = cases.length ? cases : [{ code: '', name: 'New test case' }];
      rows = list.map((c, i) => ({
        ...base,
        test_id:        _traUniqueId(seed, i + 1),
        test_case_code: c.code || null,
        test_name:      c.name || null,
        test_procedure: proc || null,
        test_section:   '',
        scope_type:     'static',
        weight:         1, // legacy column — real weight lives in test_case_weights
      }));
    }

    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) await _dbInsert('test_items', rows.slice(i, i + BATCH));

    await loadTestItems();
    if (typeof currentRoleUser !== 'undefined' && currentRoleUser?.subsystem) {
      TI = TI.filter(t => (t.Subsystem || '').toLowerCase() === currentRoleUser.subsystem.toLowerCase());
    }
    if (typeof logAudit === 'function') {
      logAudit(mode === 'duplicate' ? 'Activity Duplicated' : 'Activity Created', name,
        [mode === 'duplicate' ? `From: ${src.activity}` : null, `${rows.length} test case${rows.length !== 1 ? 's' : ''}`,
          `Phase: ${phase} · Location: ${location} · Subsystem: ${subsystem}`].filter(Boolean).join(' · '));
    }
    toast(`${mode === 'duplicate' ? 'Copied' : 'Created'} “${name}” · ${rows.length} test case${rows.length !== 1 ? 's' : ''}`, 'success');
    closeModal();
    // Land in the new activity so the next step (filling it in) is one click away.
    if (typeof renderTestRegister === 'function') renderTestRegister();
    if (typeof _amOpenDrilldown === 'function') _amOpenDrilldown(key);
  } catch (e) {
    toast((mode === 'duplicate' ? 'Duplicate' : 'Create') + ' failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; if (btnHTML) btn.innerHTML = btnHTML; }
  }
}

if (typeof CXActions !== 'undefined') {
  CXActions.register('_trNewActivityModal', _trNewActivityModal)
           .register('_trDuplicateActivityModal', _trDuplicateActivityModal)
           .register('_traPhaseChanged', _traPhaseChanged)
           .register('_traSave', _traSave);
}
