// ==========================================
// HITACHI Rail T&C Portal — Child test cases (tr-children.js)
//
// A test case can be split into child test cases, one per device or item that
// has to be tested on its own (e.g. "702A" and "702B" under one ZC test). The
// parent row becomes a summary: its status is derived from its children, and
// every child carries its own status, notes, punch links and forms.
//
// Shape on test_items:
//   parent → is_parent = true
//   child  → parent_test_id = <parent test_id>, child_label = <device name>,
//            and the parent's test_case_code / test_name copied verbatim, so the
//            shared weight key (code + name) and every activity KPI keep
//            counting each child as one weighted test case.
//
// Children are created three ways: from an Activity Template deploy (the
// template case's "Child test cases" list, planned in tpl-deploy.js), from the
// Test Register's "Child test cases" button, and as regression attempts of an
// existing child. Child ids are never re-keyed — older children keep their
// historical `asc-…` ids, which punch links and results already reference.
//
// Loaded before app.js; everything here runs at call time against app.js
// globals (TI, _trDraftItems, _trEditMode, modal, _dbInsert, …).
// ==========================================

// The key per-child form links hang off: a child's ORIGINAL attempt id, so a
// device's data sheet follows it across retests (regression attempts share
// RegressionGroupId).
function _childKey(row) {
  return String((row && (row.RegressionGroupId || row.TestID)) || '');
}

// Children of a parent. Superseded regression attempts are left out by
// default — they are history, and counting them would let an old Fail block
// the parent's roll-up forever.
function _childrenOf(parentTestId, opts = {}) {
  const pid = String(parentTestId);
  return (typeof TI !== 'undefined' ? TI : []).filter(r =>
    String(r.ParentTestId) === pid && (opts.allAttempts || r.IsLatestAttempt !== false));
}

function _childStatusColor(s) {
  return ({Pass:'#16a34a',Fail:'#dc2626','In Progress':'#d97706',Blocked:'#7c3aed','Not Started':'#9ca3af','Not Applicable':'#6b7280','Future Test':'#3b82f6'})[s] || '#9ca3af';
}

// Pure: the status a parent takes from its children, or null with no children.
//   all Future Test          → Future Test
//   all Pass / N/A           → Pass
//   anything under way       → In Progress
//   otherwise                → Not Started
function _parentRollupStatus(children) {
  if (!children || !children.length) return null;
  const st = c => c.Status || 'Not Started';
  if (children.every(c => st(c) === 'Future Test')) return 'Future Test';
  if (children.every(c => st(c) === 'Pass' || st(c) === 'Not Applicable')) return 'Pass';
  if (children.some(c => st(c) !== 'Not Started' && st(c) !== 'Future Test')) return 'In Progress';
  return 'Not Started';
}

// Re-derive a parent's status from its children and persist it if it moved.
async function _parentRollupCheck(parentTestId) {
  if (!parentTestId) return;
  const parent = TI.find(r => String(r.TestID) === String(parentTestId));
  if (!parent || !parent.IsParent) return;
  const newStatus = _parentRollupStatus(_childrenOf(parentTestId));
  if (!newStatus || parent.Status === newStatus) { _parentUpdateDOMBadge(parentTestId, parent.Status); return; }
  parent.Status = newStatus;
  await _dbUpdate('test_items', { status: newStatus }, { test_id: String(parentTestId) });
  _parentUpdateDOMBadge(parentTestId, newStatus);
}

function _parentSummaryHTML(parentTestId) {
  const children  = _childrenOf(parentTestId);
  const total     = children.length;
  const passCount = children.filter(c => c.Status === 'Pass').length;
  const pending   = total - passCount;
  const canEdit   = _trEditMode && currentRoleUser?.role === 'admin' && !_trBulkMode;
  return `<span>${icon('git-branch')} ${total} child test case${total !== 1 ? 's' : ''} &nbsp;·&nbsp; `
    + `<span style="color:var(--good);">${passCount} Pass</span>`
    + (pending > 0 ? ` &nbsp;·&nbsp; <span style="color:var(--gray-500);">${pending} pending</span>` : '')
    + `</span>`
    + (canEdit ? ` <button class="form-secondary" style="font-size:10px;padding:2px 6px;line-height:1.4;" ${cxAct('_trAddChildrenModal', String(parentTestId))}>${icon('plus')} Child test cases</button>` : '');
}

// Patch the parent badge + summary line in the live DOM (no full re-render).
function _parentUpdateDOMBadge(parentTestId, newStatus) {
  const safeId  = String(parentTestId).replace(/[^a-zA-Z0-9]/g, '-');
  const badgeEl = document.getElementById(`apb-${safeId}`);
  const sumEl   = document.getElementById(`aps-${safeId}`);
  if (badgeEl && newStatus) {
    const badgeCls = {
      'Pass':'badge-passed', 'Fail':'badge-failed', 'Blocked':'badge-warn',
      'Not Applicable':'badge-notstarted', 'In Progress':'badge-inprog',
      'Future Test':'badge-futuretest', 'Not Started':'badge-notstarted',
    }[newStatus] || 'badge-notstarted';
    badgeEl.className = `badge ${badgeCls}`;
    badgeEl.textContent = newStatus;
  }
  if (sumEl) sumEl.innerHTML = _parentSummaryHTML(parentTestId);
}

// Pure: the test_items row for a new child of `parent` (a test_items-shaped,
// snake_case row). Code and name are the parent's — the device name lives in
// child_label — and children are always static scope, even under a dynamic
// parent, so Dynamic Testing never lists each device as its own test case.
function _childDbRow(parent, label, testId) {
  return {
    test_id:        testId,
    phase:          parent.phase          || null,
    location:       parent.location       || null,
    subsystem:      parent.subsystem      || null,
    activity:       parent.activity       || null,
    test_category:  parent.test_category  || null,
    test_case_code: parent.test_case_code || null,
    test_name:      parent.test_name      || null,
    test_procedure: parent.test_procedure || null,
    status:         'Not Started',
    weight:         1, // legacy column — real weight lives in test_case_weights
    scope_type:     'static',
    parent_test_id: String(parent.test_id),
    is_parent:      false,
    child_label:    String(label).trim(),
  };
}

// The snake_case view of an in-memory TI parent row that _childDbRow reads.
function _parentDbView(p) {
  return {
    test_id: p.TestID, phase: p.Phase, location: p.Location, subsystem: p.Subsystem,
    activity: p.Activity, test_category: p.TestCategory, test_case_code: p.TestCaseCode,
    test_name: p.TestName, test_procedure: p.TestProcedure,
  };
}

// A child id that cannot collide with an existing or previously deleted one.
function _childNewId(parentTestId, seq = 0) {
  let id;
  do { id = `${parentTestId}~c${Date.now().toString(36)}${seq++}`; }
  while (TI.some(r => String(r.TestID) === id));
  return id;
}

async function _childCreate(parentRow, label, seq = 0) {
  const name = String(label || '').trim();
  if (!parentRow || !name) return null;
  if (!parentRow.IsParent) {
    await _dbUpdate('test_items', { is_parent: true }, { test_id: String(parentRow.TestID) });
    parentRow.IsParent = true;
  }
  const row = _childDbRow(_parentDbView(parentRow), name, _childNewId(parentRow.TestID, seq));
  await _dbInsert('test_items', [row]);
  const ti = {
    TestID: row.test_id, Phase: parentRow.Phase, Location: parentRow.Location,
    Subsystem: parentRow.Subsystem, Activity: parentRow.Activity,
    TestCategory: parentRow.TestCategory || '', TestCaseCode: parentRow.TestCaseCode,
    TestName: parentRow.TestName, TestProcedure: parentRow.TestProcedure || '', TestSection: '',
    Status: 'Not Started', Weight: 1, ScopeType: 'static',
    ChildLabel: name, ParentTestId: String(parentRow.TestID), IsParent: false,
    RegressionGroupId: row.test_id, AttemptNumber: 1, IsLatestAttempt: true,
    CompletedBy: null, CompletedDate: null, FailedReason: null, BlockedReason: null, Notes: null,
  };
  TI.push(ti);
  return ti;
}

// Delete one child test case — every attempt of it, with its results and
// status history. Returns the parent id so the caller can settle the parent.
async function _childDelete(childTestId) {
  const child = TI.find(r => String(r.TestID) === String(childTestId));
  if (!child) return null;
  const key = _childKey(child);
  const attempts = TI.filter(r => String(r.ParentTestId) === String(child.ParentTestId) && _childKey(r) === key);
  for (const a of attempts) {
    try { await _dbDelete('test_results',             { test_id: a.TestID }); } catch (e) { _logSwallowed('child delete: prune results', e); }
    try { await _dbDelete('test_item_status_history', { test_id: a.TestID }); } catch (e) { _logSwallowed('child delete: prune history', e); }
    await _dbDelete('test_items', { test_id: a.TestID });
  }
  const gone = new Set(attempts.map(a => String(a.TestID)));
  TI.splice(0, TI.length, ...TI.filter(r => !gone.has(String(r.TestID))));
  if (Array.isArray(_trDraftItems)) _trDraftItems = _trDraftItems.filter(r => !gone.has(String(r.TestID)));
  return child.ParentTestId;
}

// After children were added or removed: a parent with none left goes back to
// being an ordinary test case; otherwise its derived status is refreshed.
async function _parentAfterChildrenChanged(parentTestId) {
  const parent = TI.find(r => String(r.TestID) === String(parentTestId));
  if (!parent) return;
  if (!_childrenOf(parentTestId, { allAttempts: true }).length) {
    if (parent.IsParent) {
      parent.IsParent = false;
      await _dbUpdate('test_items', { is_parent: false }, { test_id: String(parentTestId) });
    }
    return;
  }
  await _parentRollupCheck(parentTestId);
}

// ── Test Register: add / rename / remove ────────────────────────────────────
function _trAddChildrenModal(testId) {
  const parentRow = TI.find(r => String(r.TestID) === String(testId));
  if (!parentRow) return;
  modal({
    title: 'Add child test cases',
    sub: escapeHtml(`${parentRow.TestCaseCode || ''} ${parentRow.TestName || ''}`.trim()),
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full">
          <label for="tch-names">Names <span style="color:var(--bad)">*</span>
            <span style="font-weight:400;color:var(--gray-500);">— one per line</span></label>
          <textarea id="tch-names" class="form-input" rows="5" placeholder="e.g.&#10;702A&#10;702B"></textarea>
          <div style="font-size:11px;color:var(--gray-500);margin-top:4px;">
            Each name becomes its own child test case with its own status. The parent's status is derived from them.
          </div>
        </div>
      </div>`,
    footer: `
      <button class="form-secondary" data-action="closeModal">Cancel</button>
      <button class="form-submit" ${cxAct('_trSaveChildren', String(testId))}>Add</button>`,
  });
  setTimeout(() => document.getElementById('tch-names')?.focus(), 50);
}

async function _trSaveChildren(testId) {
  const parentRow = TI.find(r => String(r.TestID) === String(testId));
  if (!parentRow) { toast('Test case not found', 'error'); return; }
  const raw = document.getElementById('tch-names')?.value || '';
  const existing = new Set(_childrenOf(testId, { allAttempts: true }).map(c => (c.ChildLabel || '').toLowerCase()));
  const names = [];
  for (const n of raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (existing.has(n.toLowerCase())) continue;
    existing.add(n.toLowerCase());
    names.push(n);
  }
  if (!names.length) { toast(raw.trim() ? 'Those child test cases already exist' : 'Enter at least one name', 'warn'); return; }
  closeModal();
  let added = 0;
  try {
    for (const n of names) {
      const ti = await _childCreate(parentRow, n, added);
      if (!ti) continue;
      added++;
      if (Array.isArray(_trDraftItems)) _trDraftItems.push({ ...ti, _isNew: false, _dirty: false });
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    // A failed first insert must not leave the parent flagged with no children.
    if (!added) await _parentAfterChildrenChanged(testId).catch(err => _logSwallowed('child add: un-flag parent', err));
  }
  if (added) {
    await _parentRollupCheck(testId).catch(e => _logSwallowed('child add: roll-up', e));
    _trExpandedParents.add(String(testId));
    logAudit('Child Test Cases Added', parentRow.TestID, parentRow.TestName || '', names.slice(0, added).join(', '));
    toast(`Added ${added} child test case${added !== 1 ? 's' : ''}`, 'success');
  }
  _reRenderTR();
}

async function _trRenameChild(childTestId, value) {
  const child = TI.find(r => String(r.TestID) === String(childTestId));
  const label = String(value || '').trim();
  if (!child || !label || label === child.ChildLabel) return;
  try {
    // Rename every attempt of this child so its history reads consistently.
    const key = _childKey(child);
    const attempts = TI.filter(r => String(r.ParentTestId) === String(child.ParentTestId) && _childKey(r) === key);
    for (const a of attempts) {
      await _dbUpdate('test_items', { child_label: label }, { test_id: String(a.TestID) });
      a.ChildLabel = label;
      const d = Array.isArray(_trDraftItems) && _trDraftItems.find(x => String(x.TestID) === String(a.TestID));
      if (d) d.ChildLabel = label;
    }
    toast('Child test case renamed', 'success');
  } catch (e) {
    toast('Rename failed: ' + e.message, 'error');
  }
}

async function _trDeleteChildRow(childTestId) {
  if (typeof uiCan === 'function' && !uiCan('test_register', 'delete_case')) { toast('You do not have permission to delete test cases.', 'error'); return; }
  const child = TI.find(r => String(r.TestID) === String(childTestId));
  if (!child) return;
  const label = child.ChildLabel || child.TestCaseCode || childTestId;
  if (!await cxConfirm(`Remove child test case "${label}"? Its results and history go with it.\n\nThis cannot be undone.`)) return;
  try {
    const parentId = await _childDelete(childTestId);
    if (parentId) await _parentAfterChildrenChanged(parentId);
    logAudit('Child Test Case Deleted', child.TestID, child.TestName || '', label);
    toast(`Child test case "${label}" removed`, 'success');
    _reRenderTR();
  } catch (e) {
    toast('Remove failed: ' + e.message, 'error');
  }
}

// Inputs, spacer cells and badges inside the clickable parent row point here so
// a click on them is not taken as "expand / collapse" (delegation runs the
// nearest data-action only).
function _trNoop() {}

// ── Test Register: parent row + collapsible child rows ───────────────────────
function _trParentGroupRows(parent, children, statuses, legacyMap, isAdmin) {
  const latest     = children.filter(c => c.IsLatestAttempt !== false);
  const passCount  = latest.filter(c => c.Status === 'Pass').length;
  const totalCount = latest.length;
  const parentCur  = legacyMap[parent.Status] || parent.Status || 'Not Started';
  const badgeCls   = {'Pass':'badge-passed','Fail':'badge-failed','Blocked':'badge-warn','Not Applicable':'badge-notstarted','In Progress':'badge-inprog','Future Test':'badge-futuretest'}[parentCur] || 'badge-notstarted';
  const safeId     = String(parent.TestID).replace(/[^a-zA-Z0-9]/g, '-');
  const ptid       = String(parent.TestID);
  const expanded   = _trExpandedParents.has(ptid);
  const chevron    = expanded ? '▼' : '▶';
  const editing    = _trEditMode && isAdmin;
  const noop       = cxAct('_trNoop');

  const parentRowHtml = `
    <tr style="background:#f0f1f3;cursor:pointer;" ${cxAct('_trToggleParent', ptid)}>
      ${_trBulkMode ? `<td ${noop}></td>` : ''}
      ${editing ? `<td ${noop}></td>` : ''}
      <td style="font-size:11px;font-family:monospace;color:var(--gray-700);min-width:140px;">
        <span style="font-size:12px;margin-right:6px;color:var(--gray-500);transition:transform .15s;">${chevron}</span>
        ${editing
          ? `<input class="form-input" style="font-size:11px;font-family:monospace;min-width:120px;" value="${escapeHtml(parent.TestCaseCode||'')}" ${noop} ${cxOn('change', '_trDraftChange', ptid, 'TestCaseCode', '$cx.value')}>`
          : escapeHtml(parent.TestCaseCode || parent.TestID || '—')}
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;min-width:0;">${editing
            ? `<input class="form-input" style="font-weight:600;font-size:13px;" value="${escapeHtml(parent.TestName||'')}" ${noop} ${cxOn('change', '_trDraftChange', ptid, 'TestName', '$cx.value')}>`
            : `<div style="font-weight:600;font-size:13px;">${escapeHtml(parent.TestName || '—')}</div>`}</div>
          ${editing ? '' : _formsBadgeHTML(parent)}
        </div>
        <div id="aps-${safeId}" style="font-size:11px;color:var(--gray-500);margin-top:2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>${icon('git-branch')} ${totalCount} child test case${totalCount !== 1 ? 's' : ''} &nbsp;·&nbsp;
          <span style="color:var(--good);">${passCount} Pass</span>${totalCount - passCount > 0 ? ` &nbsp;·&nbsp; <span style="color:var(--gray-500);">${totalCount - passCount} pending</span>` : ''}</span>
          ${editing && !_trBulkMode ? `<button class="form-secondary" style="font-size:10px;padding:2px 6px;line-height:1.4;" ${cxAct('_trAddChildrenModal', ptid)}>${icon('plus')} Child test cases</button>` : ''}
        </div>
      </td>
      <td>
        <span class="badge ${badgeCls}" id="apb-${safeId}">${escapeHtml(parentCur)}</span>
        <span style="font-size:10px;color:var(--gray-400);">auto</span>
      </td>
      ${_dtRenderScopeCell(parent)}
      <td style="font-size:11px;color:var(--gray-400);font-style:italic;">${expanded ? 'Click to collapse' : 'Click to expand'}</td>
      ${editing ? `<td ${noop}><button title="Delete" aria-label="Delete" class="form-secondary" style="font-size:13px;padding:4px 7px;color:var(--bad);" ${cxAct('_trDeleteParentCase', ptid)} data-tippy-content="Delete parent + all child test cases">${icon('trash')}</button></td>` : ''}
    </tr>`;

  // Per-parent search/status filter on children. The toolbar appears once a
  // parent has more than 5 children, to keep the register tight.
  const childFilter = _trChildFilterGet(parent.TestID);
  const filteredChildren = expanded ? children.filter(c => {
    if (childFilter.status && (legacyMap[c.Status] || c.Status || 'Not Started') !== childFilter.status) return false;
    if (childFilter.search && !(c.ChildLabel || '').toLowerCase().includes(childFilter.search.toLowerCase())) return false;
    return true;
  }) : [];

  const filterToolbarHtml = (expanded && children.length > 5) ? `
    <tr style="background:#fafbfc;border-top:1px solid var(--gray-100);">
      <td colspan="100" style="padding:6px 12px 6px 32px;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;">
          <input placeholder="Search child test cases…" aria-label="Search child test cases" value="${escapeHtml(childFilter.search)}"
                 style="padding:4px 8px;border:1px solid var(--gray-300);border-radius:4px;font-size:12px;flex:1;min-width:160px;max-width:260px;"
                 ${cxOn('input', '_trChildFilterSet', ptid, 'search', '$cx.value')}>
          <select aria-label="Filter child test cases by status" style="padding:4px 6px;border:1px solid var(--gray-300);border-radius:4px;font-size:12px;"
                  ${cxOn('change', '_trChildFilterSet', ptid, 'status', '$cx.value')}>
            <option value="">All statuses</option>
            ${statuses.map(s => `<option value="${s}" ${childFilter.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
          <span style="color:var(--gray-500);">${filteredChildren.length} of ${children.length}</span>
          ${(childFilter.search || childFilter.status) ? `<button class="form-secondary" style="font-size:11px;padding:2px 8px;" ${cxAct('_trChildFilterClear', ptid)}>Clear</button>` : ''}
        </div>
      </td>
    </tr>` : '';

  // Child rows only rendered when expanded
  const childRowsHtml = expanded ? filteredChildren.map(c => {
    const label      = c.ChildLabel || '—';
    const cur        = legacyMap[c.Status] || c.Status || 'Not Started';
    const showReason = cur === 'Fail' || cur === 'Blocked';
    const reasonVal  = cur === 'Fail' ? (c.FailedReason || '') : (c.BlockedReason || '');
    const ctid       = String(c.TestID);
    const domId      = encodeURIComponent(ctid);
    const sc         = _childStatusColor(cur);
    return `
      <tr style="background:#fafafa;border-left:3px solid ${sc}40;">
        ${_trBulkMode ? `<td style="padding-left:20px;"><input type="checkbox" aria-label="Select child test case" ${_trSelected.has(ctid) ? 'checked' : ''} ${cxOn('change', '_trToggleSelect', ctid, '$cx.checked')}></td>` : ''}
        ${editing ? `<td></td>` : ''}
        <td style="padding-left:24px;font-size:11px;font-family:monospace;color:var(--gray-500);">
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="flex:1;min-width:0;">
              <span style="color:var(--gray-300);">└</span>
              ${editing
                ? `<input class="form-input" aria-label="Child test case name" style="font-size:11px;font-family:monospace;min-width:110px;display:inline-block;width:auto;" value="${escapeHtml(c.ChildLabel || '')}" placeholder="Name" ${cxOn('change', '_trRenameChild', ctid, '$cx.value')}>`
                : escapeHtml(label)}
            </div>
            ${editing ? '' : _formsBadgeHTML(c)}
          </div>
        </td>
        <td>
          ${c.CompletedBy ? `<div style="font-size:11px;color:var(--gray-500);">By ${escapeHtml(c.CompletedBy)}</div>` : ''}
          ${_swSnapshotChipHTML(c)}
        </td>
        <td>
          ${uiCan('test_register','edit') ? `
            <select class="form-input mx-status-select" aria-label="Status" style="font-size:12px;padding:4px 6px;" ${cxOn('change', '_mxStatusChange', ctid, '$cx.value', '$cx.el')}>
              ${statuses.map(s => `<option value="${s}" ${cur === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <div id="mx-reason-${domId}" class="mx-reason-wrap" style="${showReason ? '' : 'display:none;'}">
              <input type="text" id="mx-ri-${domId}" class="form-input mx-reason-input" style="font-size:11px;padding:3px 6px;margin-top:4px;"
                placeholder="${cur === 'Fail' ? 'Failure reason...' : 'Blocked reason...'}"
                value="${escapeHtml(reasonVal)}" ${cxOn('input', '_mxSaveReason', ctid, '$cx.value')}>
            </div>
          ` : `<span class="badge" style="background:${sc}20;color:${sc};border:1px solid ${sc}40;">${escapeHtml(cur)}</span>`}
          <div id="punch-actions-${domId}" style="margin-top:6px;display:${cur==='Fail'?'flex':'none'};flex-direction:column;gap:4px;">
            <div style="display:flex;gap:4px;">
              <button ${cxAct('openPunchFromTestCase', ctid)} style="flex:1;font-size:11px;padding:4px 6px;background:var(--bad-light);border:1px solid var(--bad-border);color:var(--bad);border-radius:5px;cursor:pointer;font-weight:600;">${icon('clipboard')} Create Punch</button>
              <button ${cxAct('openLinkPunchModal', ctid)} style="flex:1;font-size:11px;padding:4px 6px;background:var(--white);border:1px solid var(--gray-300);color:var(--gray-700);border-radius:5px;cursor:pointer;font-weight:600;">${icon('link')} Link Existing</button>
            </div>
            <div id="punch-chips-${domId}">${_punchLinksForTestHTML(ctid)}</div>
          </div>
        </td>
        <td><span style="font-size:11px;color:var(--gray-500);">Uses parent scope</span></td>
        <td>
          <input type="text" class="form-input" aria-label="Notes" style="font-size:12px;padding:4px 8px;" placeholder="Notes…"
            value="${escapeHtml(c.Notes || '')}" ${cxOn('change', '_mxSaveNotes', ctid, '$cx.value')}>
          <span id="regcell-${domId}">${_regressionCellHTML(c)}</span>
        </td>
        ${editing ? `<td><button title="Delete" aria-label="Delete" class="form-secondary" style="font-size:13px;padding:4px 7px;color:var(--bad);" ${cxAct('_trDeleteChildRow', ctid)} data-tippy-content="Remove child test case">${icon('trash')}</button></td>` : ''}
      </tr>`;
  }).join('') : '';

  return parentRowHtml + filterToolbarHtml + childRowsHtml;
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    _childKey, _childrenOf, _childStatusColor, _parentRollupStatus, _parentRollupCheck,
    _parentUpdateDOMBadge, _childDbRow, _childNewId, _childCreate, _childDelete,
    _parentAfterChildrenChanged, _trAddChildrenModal, _trSaveChildren, _trRenameChild,
    _trDeleteChildRow, _trNoop, _trParentGroupRows,
  });
}
