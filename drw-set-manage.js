// ==========================================
// HITACHI Rail T&C Portal — Drawings: drawing-set lifecycle management
// (drw-set-manage.js)
//
// Uploading a set auto-supersedes the current sheets that share its Drawing
// Numbers (same location), and a prior set left with no current sheets is
// marked 'superseded'. Before this module, that chain only ran forward:
//
//   • Deleting the newer set left the older revision's sheets superseded with
//     nothing current in their place — they vanished from Current Drawings
//     and lingered in history as orphaned "superseded" records.
//   • A superseded set dropped out of the Drawing Sets tab (it listed only
//     'ready' sets), so it could no longer be viewed or deleted.
//   • Revision History was read-only, so failed / stale uploads stayed forever.
//
// This module makes the chain reversible and every set manageable:
//   _drwRestorePriorRevisions — after sheets are removed, the most recently
//       uploaded remaining revision of each affected drawing becomes current
//       again, and its set is returned to 'ready'.
//   _drwDeleteSet             — delete + verify + restore (replaces app.js').
//   _drwTabHistory            — history with status + View / Delete actions.
//   _drwSetStatus/_drwSetStatusPill — one status vocabulary for both tabs.
// Loaded AFTER app.js (uses DRAWING_SETS/SHEETS/MARKUPS, _db*, _drawStorage).
// ==========================================

function _drwNormNum(n) { return n == null ? '' : String(n).trim().toUpperCase(); }

// Status of a set derived from its sheets (the stored status lags behind
// partial supersedes): processing | error | current | partial | superseded.
function _drwSetStatus(set) {
  if (set.status === 'processing' || set.status === 'error') return set.status;
  const sheets = DRAWING_SHEETS.filter(s => s.set_id === set.id);
  const cur = sheets.filter(s => s.is_current).length;
  if (!sheets.length) return set.status === 'superseded' ? 'superseded' : 'current';
  if (cur === sheets.length) return 'current';
  if (cur === 0) return 'superseded';
  return 'partial';
}

function _drwSetStatusPill(set) {
  const st = _drwSetStatus(set);
  const map = {
    current:    ['is-current', 'Current'],
    partial:    ['is-current', 'Partly superseded'],
    superseded: ['is-old',     'Superseded'],
    processing: ['is-old',     'Import incomplete'],
    error:      ['is-old',     'Import failed'],
  };
  const [cls, label] = map[st] || ['is-old', st];
  return `<span class="drw-status-pill ${cls}">${escapeHtml(label)}</span>`;
}

// After `removed` sheets are gone (deleted), promote the newest remaining
// revision of each drawing that had its current sheet removed. Returns the
// promoted sheets. Pure selection is in _drwPickRestorations (unit-testable).
function _drwPickRestorations(removed, remaining) {
  const removedIds = new Set(removed.map(s => s.id));
  const keys = new Set(removed
    .filter(s => s.is_current && _drwNormNum(s.sheet_number))
    .map(s => s.location + '||' + _drwNormNum(s.sheet_number)));
  const picks = [];
  keys.forEach(key => {
    const family = remaining.filter(s => !removedIds.has(s.id) &&
      (s.location + '||' + _drwNormNum(s.sheet_number)) === key);
    if (!family.length || family.some(s => s.is_current)) return; // nothing to restore
    family.sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
      String(b.revision || '').localeCompare(String(a.revision || ''), undefined, { numeric: true }));
    picks.push(family[0]);
  });
  return picks;
}

// Drawings in a location with NO current revision left (e.g. a newer set was
// deleted before this module existed). Returns the newest sheet of each such
// drawing — the one a repair would make current.
function _drwFindOrphans(sheets, loc) {
  const fam = new Map();
  sheets.filter(s => s.location === loc && _drwNormNum(s.sheet_number)).forEach(s => {
    const k = _drwNormNum(s.sheet_number);
    if (!fam.has(k)) fam.set(k, []);
    fam.get(k).push(s);
  });
  const out = [];
  fam.forEach(list => {
    if (list.some(s => s.is_current)) return;
    list.sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
      String(b.revision || '').localeCompare(String(a.revision || ''), undefined, { numeric: true }));
    out.push(list[0]);
  });
  return out;
}

async function _drwApplyRestorations(picks) {
  for (const s of picks) {
    await _dbUpdate('drawing_sheets', { is_current: true }, { id: s.id });
    s.is_current = true;
  }
  const setIds = new Set(picks.map(s => s.set_id).filter(Boolean));
  for (const sid of setIds) {
    const set = DRAWING_SETS.find(x => x.id === sid);
    if (set && set.status === 'superseded') {
      await _dbUpdate('drawing_sets', { status: 'ready' }, { id: sid }).catch(() => {});
      set.status = 'ready';
    }
  }
  return picks;
}

async function _drwRepairOrphans(loc) {
  if (typeof uiCan === 'function' && !uiCan('drawings', 'upload_set')) { toast('You do not have permission to manage drawing revisions', 'error'); return; }
  const picks = _drwFindOrphans(DRAWING_SHEETS, loc);
  if (!picks.length) { toast('Every drawing already has a current revision', 'success'); return; }
  if (!await cxConfirm(`${picks.length} drawing${picks.length === 1 ? ' has' : 's have'} no current revision (left over from a deleted set).\n\nMake the latest remaining revision of each one Current again?`)) return;
  try {
    await _drwApplyRestorations(picks);
    logAudit?.('Drawing revisions restored', loc, `${picks.length} drawing${picks.length === 1 ? '' : 's'} back to latest remaining revision`);
    toast(`${picks.length} drawing${picks.length === 1 ? '' : 's'} restored to the latest remaining revision`, 'success');
  } catch (e) { toast('Restore failed: ' + (e.message || 'unknown error'), 'error'); }
  await loadDrawingsData().catch(() => {});
  renderDrawingsPage();
  _drwRenderLocationView(loc, 'history');
}

async function _drwRestorePriorRevisions(removed) {
  return _drwApplyRestorations(_drwPickRestorations(removed, DRAWING_SHEETS));
}

// ── Delete an entire drawing set — pages, markups, PDF — and put the previous
// revision of each of its drawings back in force.
async function _drwDeleteSet(setId, loc, subtab) {
  if (typeof uiCan === 'function' && !uiCan('drawings', 'delete_set')) { toast('You do not have permission to delete drawing sets', 'error'); return; }
  const set = DRAWING_SETS.find(s => s.id === setId);
  if (!set) { toast('Drawing set not found', 'error'); return; }
  const sheetsOfSet = DRAWING_SHEETS.filter(s => s.set_id === setId);
  const restorable = _drwPickRestorations(sheetsOfSet, DRAWING_SHEETS);
  const restoreNote = restorable.length
    ? `\n\n${restorable.length} drawing${restorable.length === 1 ? '' : 's'} will go back to the previous revision (it becomes Current again).`
    : '';
  if (!await cxConfirm(`Delete drawing set "${set.title}"?\n\nThis permanently removes the set, all ${sheetsOfSet.length} of its page${sheetsOfSet.length === 1 ? '' : 's'}, their markups, and the uploaded PDF.${restoreNote}\n\nThis cannot be undone.`)) return;
  try {
    const sheetIds = new Set(sheetsOfSet.map(s => s.id));
    const mk = DRAWING_MARKUPS.filter(m => sheetIds.has(m.sheet_id));
    for (const m of mk) await _dbDelete('drawing_markups', { id: m.id });
    if (sheetsOfSet.length) {
      const gone = await _dbDelete('drawing_sheets', { set_id: setId });
      // RLS can silently match zero rows — never report a delete that didn't happen.
      if (Array.isArray(gone) && gone.length === 0) throw new Error('the database did not remove the pages (check your Drawings delete permission)');
    }
    const goneSet = await _dbDelete('drawing_sets', { id: setId });
    if (Array.isArray(goneSet) && goneSet.length === 0) throw new Error('the database did not remove the set (check your Drawings delete permission)');
    if (set.storage_path) {
      try { await _drawStorage.remove(set.storage_path); }
      catch (e) { console.warn('[drw] storage remove failed:', e.message); }
    }
    // Drop the removed rows locally so restoration only sees what remains.
    DRAWING_SHEETS = DRAWING_SHEETS.filter(s => !sheetIds.has(s.id));
    const restored = await _drwRestorePriorRevisions(sheetsOfSet);
    logAudit?.('Drawing set deleted', set.title,
      `${sheetsOfSet.length} pages${restored.length ? ` · ${restored.length} restored to previous revision` : ''}`);
    toast(`Drawing set deleted${restored.length ? ` — ${restored.length} drawing${restored.length === 1 ? '' : 's'} back to the previous revision` : ''}`, 'success');
    _drwActiveSetId = '';
    await loadDrawingsData();
    renderDrawingsPage();
    _drwRenderLocationView(loc || _drwActiveLocation, subtab || 'sets');
  } catch (e) {
    toast('Delete failed: ' + (e.message || 'unknown error'), 'error');
    await loadDrawingsData().catch(() => {});
    _drwRenderLocationView(loc || _drwActiveLocation, subtab || 'sets');
  }
}

// ── Tab 3: Revision History — every upload for the location, newest first,
// with what is still in force and actions to view or remove it.
function _drwTabHistory(loc, el) {
  const sets = DRAWING_SETS.filter(s => s.location === loc)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!sets.length) {
    el.innerHTML = `<div class="docs-empty"><p>No upload history for this location.</p></div>`;
    return;
  }
  const canDelete = (typeof uiCan !== 'function') || uiCan('drawings', 'delete_set');
  const orphans = _drwFindOrphans(DRAWING_SHEETS, loc);
  const canFix = (typeof uiCan !== 'function') || uiCan('drawings', 'upload_set');
  el.innerHTML = `
    ${orphans.length ? `<div class="drw-orphan-banner" role="status">
      <span>${icon('alert')} <b>${orphans.length}</b> drawing${orphans.length === 1 ? ' has' : 's have'} no current revision (left over from a deleted set).</span>
      ${canFix ? `<button class="form-submit tr-mini-btn" ${cxAct('_drwRepairOrphans', String(loc))}>Restore latest revision</button>` : ''}
    </div>` : ''}
    <p class="section-sub" style="margin:0 0 10px;">Deleting a set puts the previous revision of each of its drawings back in force.</p>
    <div class="data-card" style="padding:0;overflow:hidden;">
      <table class="data-table">
        <thead><tr>
          <th>Title</th><th>Sheets</th><th>Current</th><th>Import Date</th><th>Rev Date</th><th>Release Date</th><th>Uploaded By</th><th>Status</th><th style="width:120px;">Actions</th>
        </tr></thead>
        <tbody>${sets.map(set => {
          const sheets = DRAWING_SHEETS.filter(s => s.set_id === set.id);
          const cur = sheets.filter(s => s.is_current).length;
          const viewable = set.status === 'ready' || set.status === 'superseded';
          return `<tr>
            <td style="font-weight:600;">${escapeHtml(set.title)}</td>
            <td>${sheets.length}</td>
            <td>${cur}</td>
            <td style="font-size:12px;">${escapeHtml(set.import_date || '—')}</td>
            <td style="font-size:12px;">${escapeHtml(set.revision_date || '—')}</td>
            <td style="font-size:12px;">${escapeHtml(set.release_date || '—')}</td>
            <td style="font-size:12px;">${escapeHtml(set.uploaded_by || '—')}</td>
            <td>${_drwSetStatusPill(set)}</td>
            <td style="white-space:nowrap;">
              ${viewable ? `<button class="admin-action-btn tr-mini-btn" ${cxAct('_drwOpenSet', String(loc), String(set.id))}>View</button>` : ''}
              ${canDelete ? `<button aria-label="Delete set" class="form-secondary tr-mini-btn" style="margin-left:4px;color:var(--bad);border-color:var(--bad-border);" ${cxAct('_drwDeleteSet', String(set.id), String(loc), 'history')} title="Delete this set; earlier revisions of its drawings become current again">${icon('trash')}</button>` : ''}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { _drwPickRestorations, _drwFindOrphans, _drwNormNum };
