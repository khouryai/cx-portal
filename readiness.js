// ==========================================
// HITACHI Rail T&C Portal — Activity Readiness module
// ------------------------------------------
// One engine, two views: a "readiness activity" IS a task (tasks table) that
// carries a structured checklist (task_checklist_items). This file owns:
//   • data loading for checklists / templates / delay log / attachments
//   • the checklist engine: sectioned lines of kind check | passfail | value |
//     note | task — the last links another task whose progress rolls up
//     PROPORTIONALLY into the parent (read-only there; cycle-guarded)
//   • per-line due date + responsible + completed stamps, with a mandatory
//     delay reason every time a due date is pushed later (task_item_delays)
//   • per-line photos (Photos module) and any-type file attachments
//   • the checklist builder (task scope + template scope), template manager
//     and "issue from template" flow (snapshot copy — fully editable after)
//   • the Activity Readiness page: overall readiness, per-activity progress,
//     filters by location / subsystem / phase / status / overdue
// Loaded as a classic <script> AFTER app.js (uses its globals at call time).
// Permissions ride the existing 'tasks' module; template editing additionally
// requires the 'manage_templates' action.
// ==========================================

// ── State ─────────────────────────────────────────────────────────────────
let TASK_CHK = [];       // task_checklist_items rows
let RD_TPLS = [];        // readiness_templates rows
let RD_TPL_ITEMS = [];   // readiness_template_items rows
let TASK_DELAYS = [];    // task_item_delays rows
let TASK_FILES = [];     // task_files rows
let _rdFilter = { search: '', kind: '', location: '', subsystem: '', phase: '', status: '', priority: '', type: '', mine: false, ready: false, overdue: false };
let _rdView = 'list';    // list | overview (matrix rollup) | delays (delay analytics)
let _rdMatrixDim = 'phase'; // matrix columns: phase | location (rows are always subsystem)
let _rdChkPhotos = {};   // checklist line id -> photo rows (lazy)

// ── Data loading ──────────────────────────────────────────────────────────
async function loadReadinessData() {
  try {
    const [chk, tpls, tplItems, delays, files] = await Promise.all([
      _dbSelect('task_checklist_items'),
      _dbSelect('readiness_templates'),
      _dbSelect('readiness_template_items'),
      _dbSelect('task_item_delays'),
      _dbSelect('task_files'),
    ]);
    TASK_CHK = chk || []; RD_TPLS = tpls || []; RD_TPL_ITEMS = tplItems || [];
    TASK_DELAYS = delays || []; TASK_FILES = files || [];
  } catch (e) { console.warn('[loadReadinessData]', e.message); }
}

// ── Small shared helpers ──────────────────────────────────────────────────
function _rdWho() { return (typeof currentRoleUser !== 'undefined' && currentRoleUser && currentRoleUser.name) || ''; }
function _rdCan(action) { return (typeof uiCan !== 'function') || uiCan('tasks', action); }
function _rdToday() { return new Date().toISOString().slice(0, 10); }
function _rdTask(id) { return (typeof TASKS !== 'undefined' ? TASKS : []).find(t => t.id === id); }

// ── Checklist selectors + progress math (pure — unit-tested) ──────────────
function _rdChkFor(taskId) {
  return TASK_CHK.filter(c => c.task_id === taskId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}
// Lines that count toward progress: required ones, or all when none is required.
function _rdCountedLines(taskId) {
  const all = _rdChkFor(taskId);
  const req = all.filter(l => l.required !== false);
  return req.length ? req : all;
}
// Proportional contribution of one line, in [0,1]. kind=task contributes the
// linked activity's own progress fraction (the user-chosen proportional rollup).
function _rdLineFraction(l, seen) {
  if (l.kind === 'task') {
    if (!l.linked_task_id) return 0;
    const p = _rdTaskProgress(l.linked_task_id, seen);
    return p.total ? p.done / p.total : 0;
  }
  if (l.kind === 'check') return l.done ? 1 : 0;
  if (l.kind === 'passfail') return (l.verdict === 'Pass' || l.verdict === 'N/A') ? 1 : 0;
  return (l.value_text && String(l.value_text).trim()) ? 1 : 0;
}
// Binary completion — drives completed_by/at stamping and the derived
// prerequisite state. A linked activity is complete only at 100%.
function _rdLineComplete(l, seen) {
  if (l.kind === 'task') return _rdLineFraction(l, seen) >= 1 && !!l.linked_task_id;
  if (l.kind === 'check') return !!l.done;
  if (l.kind === 'passfail') return l.verdict === 'Pass' || l.verdict === 'N/A';
  if (l.kind === 'value') return !!(l.value_text && String(l.value_text).trim());
  return l.required === false || !!(l.value_text && String(l.value_text).trim());
}
// Task progress: { total, done, pct, fails }. `done` is a fraction sum, so a
// linked child at 4/6 adds 0.67 of a line. `seen` guards against link cycles.
function _rdTaskProgress(taskId, seen) {
  seen = seen || new Set();
  if (seen.has(taskId)) return { total: 0, done: 0, pct: 0, fails: 0 };
  seen.add(taskId);
  const counted = _rdCountedLines(taskId);
  const all = _rdChkFor(taskId);
  let done = 0;
  for (const l of counted) done += _rdLineFraction(l, seen);
  let fails = all.filter(l => l.verdict === 'Fail').length;
  for (const l of all) {
    if (l.kind === 'task' && l.linked_task_id) fails += _rdTaskProgress(l.linked_task_id, seen).fails;
  }
  seen.delete(taskId);
  const total = counted.length;
  return { total, done, pct: total ? Math.round(done / total * 100) : 0, fails };
}
// Effective readiness state: every counted checklist line complete. (The
// legacy manual prerequisite_met flag was migrated into a checklist line and
// dropped in the Checkpoint merge; in-memory rows that still carry it are
// honoured as a fallback.)
function _taskPrereqEff(t) {
  if (!t) return false;
  const counted = _rdCountedLines(t.id);
  if (!counted.length) return !!t.prerequisite_met;
  const seen = new Set([t.id]);
  return counted.every(l => _rdLineComplete(l, seen));
}
function _rdLineOverdue(l, seen) {
  return !!(l.due_date && l.due_date < _rdToday() && !_rdLineComplete(l, seen || new Set()));
}
function _rdTaskOverdueLines(taskId) {
  const seen = new Set([taskId]);
  return _rdChkFor(taskId).filter(l => _rdLineOverdue(l, seen));
}
// Would linking `childId` as a line of `parentId` create a cycle?
function _rdWouldCycle(parentId, childId) {
  if (!childId) return false;
  if (parentId === childId) return true;
  const seen = new Set();
  const walk = (id) => {
    if (id === parentId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return _rdChkFor(id).some(l => l.kind === 'task' && l.linked_task_id && walk(l.linked_task_id));
  };
  return walk(childId);
}
// Derived membership test — kept as the fallback for rows created before the
// explicit tasks.kind column existed (and for in-memory rows without it).
function _rdIsActivity(t) {
  return !!(t && (_rdChkFor(t.id).length || t.template_id || t.location || t.subsystem || t.phase));
}
// Explicit type: 'task' (work item) vs 'activity' (readiness activity).
// tasks.kind is authoritative; derive only when it is absent.
function _rdKind(t) {
  if (!t) return 'task';
  if (t.kind) return t.kind === 'activity' ? 'activity' : 'task';
  return _rdIsActivity(t) ? 'activity' : 'task';
}
function _rdKindPill(t, opts) {
  const act = _rdKind(t) === 'activity';
  const compact = opts && opts.compact;
  return act
    ? `<span class="v2-pill is-info" title="Readiness activity — a gated checklist that must clear before work starts">${icon('target')}${compact ? '' : ' Readiness'}</span>`
    : `<span class="v2-pill is-muted" title="Task — a standalone work item">${icon('check')}${compact ? '' : ' Task'}</span>`;
}
function _rdDelaysFor(lineId) {
  return TASK_DELAYS.filter(d => d.item_id === lineId)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}
function _rdSlipDays(lineId) {
  let days = 0;
  for (const d of _rdDelaysFor(lineId)) {
    if (d.old_due && d.new_due) days += Math.round((new Date(d.new_due) - new Date(d.old_due)) / 86400000);
  }
  return days;
}

// ── Rollup analytics (pure — unit-tested) ─────────────────────────────────
const _RD_UNASSIGNED = '— Unassigned —';
// Item-weighted readiness grouped along a single dimension (subsystem / phase /
// location). Returns rows sorted worst-first so the drag on the project floats
// to the top: [{ key, done, total, pct, overdue, ready, count }].
function _rdRollup(acts, dim, progress) {
  const groups = new Map();
  for (const t of acts) {
    const key = (t[dim] || '').trim() || _RD_UNASSIGNED;
    const p = progress ? progress.get(t.id) : _rdTaskProgress(t.id);
    const g = groups.get(key) || { key, done: 0, total: 0, overdue: 0, ready: 0, count: 0, fails: 0 };
    g.done += p.done; g.total += p.total; g.fails += p.fails; g.count += 1;
    g.overdue += _rdTaskOverdueLines(t.id).length;
    if (p.total && p.pct === 100) g.ready += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => ({ ...g, pct: g.total ? Math.round(g.done / g.total * 100) : 0 }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total || String(a.key).localeCompare(String(b.key)));
}
// Subsystem (rows) × phase|location (cols) matrix. cells keyed 'row||col'.
function _rdMatrixData(acts, colDim, progress) {
  const rows = [], cols = [];
  const cells = new Map();
  for (const t of acts) {
    const r = (t.subsystem || '').trim() || _RD_UNASSIGNED;
    const c = (t[colDim] || '').trim() || _RD_UNASSIGNED;
    if (!rows.includes(r)) rows.push(r);
    if (!cols.includes(c)) cols.push(c);
    const key = r + '||' + c;
    const p = progress ? progress.get(t.id) : _rdTaskProgress(t.id);
    const cell = cells.get(key) || { done: 0, total: 0, overdue: 0, count: 0 };
    cell.done += p.done; cell.total += p.total; cell.count += 1;
    cell.overdue += _rdTaskOverdueLines(t.id).length;
    cells.set(key, cell);
  }
  const collate = (arr) => arr.sort((a, b) => a === _RD_UNASSIGNED ? 1 : b === _RD_UNASSIGNED ? -1 : String(a).localeCompare(String(b)));
  return { rows: collate(rows), cols: collate(cols), cells };
}
// Delay analytics across every recorded due-date push. Returns headline totals
// plus breakdowns by reason, by activity and by responsible party.
function _rdDelayStats() {
  const lineById = new Map(TASK_CHK.map(l => [l.id, l]));
  const byReason = new Map(), byAct = new Map(), byResp = new Map();
  let totalDays = 0, totalEvents = 0;
  for (const d of TASK_DELAYS) {
    if (!d.old_due || !d.new_due) continue;
    const days = Math.round((new Date(d.new_due) - new Date(d.old_due)) / 86400000);
    if (days <= 0) continue;
    totalDays += days; totalEvents += 1;
    const line = lineById.get(d.item_id);
    const reason = (d.reason || 'Unspecified').trim() || 'Unspecified';
    const rG = byReason.get(reason) || { key: reason, days: 0, count: 0 };
    rG.days += days; rG.count += 1; byReason.set(reason, rG);
    const resp = (line && line.responsible) || '— Unassigned —';
    const pG = byResp.get(resp) || { key: resp, days: 0, count: 0 };
    pG.days += days; pG.count += 1; byResp.set(resp, pG);
    const t = line ? _rdTask(line.task_id) : null;
    const aKey = t ? t.id : (line ? line.task_id : d.item_id);
    const aG = byAct.get(aKey) || { key: aKey, name: t ? t.task_name : 'Unknown activity', days: 0, count: 0 };
    aG.days += days; aG.count += 1; byAct.set(aKey, aG);
  }
  const byDays = m => [...m.values()].sort((a, b) => b.days - a.days || b.count - a.count);
  return {
    totalDays, totalEvents,
    avg: totalEvents ? Math.round(totalDays / totalEvents * 10) / 10 : 0,
    byReason: byDays(byReason), byActivity: byDays(byAct), byResponsible: byDays(byResp),
  };
}
// Green-tinted heat fill for a readiness %, token-only via color-mix.
function _rdHeatBg(pct) { return `color-mix(in srgb, var(--good) ${Math.max(6, Math.round(pct))}%, var(--surface-2))`; }
function _rdHeatFg(pct) { return pct >= 55 ? 'var(--white)' : 'var(--text)'; }

// ── Option vocabularies (reuse existing lists, allow free typing) ─────────
function _rdLocationOptions() {
  const set = new Set();
  if (typeof LOCS !== 'undefined') (LOCS || []).forEach(l => { if (l.name) set.add(l.name); });
  (typeof TASKS !== 'undefined' ? TASKS : []).forEach(t => { if (t.location) set.add(t.location); });
  return [...set].sort((a, b) => String(a).localeCompare(String(b)));
}
function _rdSubsystemOptions() {
  const set = new Set(typeof _fsOptions === 'function' ? _fsOptions('punch_subsystem') : []);
  if (typeof TI !== 'undefined') (TI || []).forEach(r => { if (r.Subsystem) set.add(r.Subsystem); });
  (typeof TASKS !== 'undefined' ? TASKS : []).forEach(t => { if (t.subsystem) set.add(t.subsystem); });
  return [...set].sort((a, b) => String(a).localeCompare(String(b)));
}
function _rdPhaseOptions() {
  const set = new Set(typeof _fsOptions === 'function' ? _fsOptions('lookahead_phase') : []);
  (typeof TASKS !== 'undefined' ? TASKS : []).forEach(t => { if (t.phase) set.add(t.phase); });
  return [...set].sort((a, b) => String(a).localeCompare(String(b)));
}
function _rdDelayReasons() {
  const opts = (typeof _fsOptions === 'function') ? _fsOptions('readiness_delay_reason') : [];
  return opts.length ? opts : ['Need more time', 'Waiting on design input', 'Waiting on client', 'Material / equipment delay', 'Access not available', 'Plan resequenced', 'Other'];
}
function _rdPeopleOptions(current) {
  let list = [];
  try { list = (typeof _taskAssigneeOptions === 'function') ? _taskAssigneeOptions(current) : []; } catch (_) { list = []; }
  if (current && !list.includes(current)) list.push(current);
  return list;
}
// Datalist-backed input: picks from existing values but accepts new ones.
function _rdDatalistField(id, label, value, options, placeholder) {
  return `<div class="form-field"><label>${escapeHtml(label)}</label>
    <input id="${id}" class="form-input" list="${id}-dl" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}" autocomplete="off">
    <datalist id="${id}-dl">${options.map(o => `<option value="${escapeHtml(o)}"></option>`).join('')}</datalist></div>`;
}

// Purge in-memory checklist state when a task is deleted (DB rows cascade).
function _rdOnTaskDeleted(taskId) {
  const lineIds = new Set(_rdChkFor(taskId).map(l => l.id));
  TASK_CHK = TASK_CHK.filter(c => c.task_id !== taskId);
  TASK_DELAYS = TASK_DELAYS.filter(d => !lineIds.has(d.item_id));
  TASK_FILES = TASK_FILES.filter(f => !lineIds.has(f.checklist_item_id));
  TASK_CHK.forEach(c => { if (c.linked_task_id === taskId) c.linked_task_id = null; });
}

// ── Checklist section inside the task view modal ──────────────────────────
function _rdTaskChecklistSection(t) {
  const canEdit = _rdCan('edit');
  return `<div style="margin:22px 0 0;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-size:11px;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:0.06em;">${icon('clipboard')} Readiness Checklist</div>
      <span style="display:inline-flex;gap:6px;">
        ${canEdit ? `<button class="v2-btn-mini" onclick="_rdChkBuilderModal('task','${t.id}')">${icon('sliders')} Edit checklist</button>` : ''}
        ${canEdit ? `<button class="v2-btn-mini" onclick="_rdApplyTplModal('${t.id}')">${icon('download')} Add from template</button>` : ''}
      </span>
    </div>
    <div id="rd-chk-wrap-${t.id}">${_rdChecklistBodyHTML(t, canEdit)}</div>
  </div>`;
}
function _rdChecklistBodyHTML(t, canEdit) {
  const lines = _rdChkFor(t.id);
  if (!lines.length) {
    return `<div style="font-size:12px;color:var(--gray-500);padding:10px 0;border-top:1px dashed var(--border);">No checklist yet — structured prerequisites (items with due dates, responsible parties, pass/fail criteria and attachments) appear here. ${canEdit ? 'Use “Edit checklist” or “Add from template” above to build one.' : ''}</div>`;
  }
  const p = _rdTaskProgress(t.id);
  const seen = new Set([t.id]);
  let h = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
    <div style="flex:1;height:7px;background:var(--gray-100);border-radius:4px;overflow:hidden;"><div style="width:${p.pct}%;height:100%;background:${p.fails ? 'var(--bad)' : 'var(--good)'};"></div></div>
    <span style="font-size:12px;font-weight:700;color:var(--text-subtle);">${p.pct}%</span>
  </div>`;
  let lastSection = null;
  for (const l of lines) {
    const sec = (l.section || '').trim();
    if (sec !== lastSection) {
      if (sec) h += `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--gray-400);margin:10px 0 3px;">${escapeHtml(sec)}</div>`;
      lastSection = sec;
    }
    h += _rdChkLineHTML(t, l, canEdit, seen);
  }
  return h;
}
function _rdChkLineHTML(t, l, canEdit, seen) {
  const complete = _rdLineComplete(l, seen);
  const overdue = _rdLineOverdue(l, seen);
  const dis = canEdit ? '' : 'disabled';
  let ctl = '';
  if (l.kind === 'task') {
    const child = _rdTask(l.linked_task_id);
    if (child) {
      const cp = _rdTaskProgress(child.id, new Set(seen));
      ctl = `<span style="display:inline-flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:80px;height:5px;background:var(--gray-100);border-radius:3px;overflow:hidden;"><span style="display:block;width:${cp.pct}%;height:100%;background:${cp.fails ? 'var(--bad)' : 'var(--good)'};"></span></span>
        <span style="font-size:11px;font-weight:700;color:var(--text-subtle);">${cp.pct}%</span>
        <button class="form-secondary" style="font-size:10px;padding:2px 7px;" title="Open the linked activity — this line is read-only here and is edited in its own checklist" onclick="closeModal();_taskViewModal('${child.id}')">${icon('external')} Open</button>
      </span>`;
    } else {
      ctl = `<span style="font-size:11px;color:var(--bad);">${icon('alert')} linked activity removed</span>`;
    }
  } else if (l.kind === 'check') {
    ctl = `<input type="checkbox" ${l.done ? 'checked' : ''} ${dis} onchange="_rdChkSetDone('${l.id}',this.checked)" aria-label="${escapeHtml(l.title)}" style="width:16px;height:16px;cursor:pointer;">`;
  } else if (l.kind === 'passfail') {
    ctl = ['Pass', 'Fail', 'N/A'].map(v => {
      const on = l.verdict === v;
      const col = v === 'Pass' ? 'var(--good)' : v === 'Fail' ? 'var(--bad)' : 'var(--text-subtle)';
      return `<button ${dis} onclick="_rdChkSetVerdict('${l.id}','${v}')" style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:5px;cursor:pointer;border:1px solid ${on ? col : 'var(--border)'};background:${on ? col : 'var(--surface)'};color:${on ? 'var(--white)' : 'var(--text)'};">${v}</button>`;
    }).join('');
  } else if (l.kind === 'value') {
    ctl = `<input type="text" value="${escapeHtml(l.value_text || '')}" ${dis} placeholder="value" aria-label="${escapeHtml(l.title)}" onchange="_rdChkSetValue('${l.id}',this.value)" style="width:110px;font-size:12px;padding:3px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);">${l.unit ? `<span style="font-size:11px;color:var(--gray-500);">${escapeHtml(l.unit)}</span>` : ''}`;
  } else {
    ctl = `<input type="text" value="${escapeHtml(l.value_text || '')}" ${dis} placeholder="note…" aria-label="${escapeHtml(l.title)}" onchange="_rdChkSetValue('${l.id}',this.value)" style="width:180px;font-size:12px;padding:3px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);">`;
  }
  const photos = _rdChkPhotos[l.id] || [];
  const files = TASK_FILES.filter(f => f.checklist_item_id === l.id);
  const delays = _rdDelaysFor(l.id);
  const dueChip = l.due_date
    ? `<button class="form-secondary" style="font-size:10px;padding:2px 7px;${overdue ? 'color:var(--bad);border-color:var(--bad);' : ''}" title="Due date — click to change (pushing it later asks for a delay reason)" ${canEdit ? `onclick="_rdDueModal('${l.id}')"` : 'disabled'}>${icon('calendar')} ${_fmtDate(l.due_date)}${overdue ? ' !' : ''}</button>`
    : (canEdit ? `<button class="form-secondary" style="font-size:10px;padding:2px 7px;color:var(--text-subtle);" title="Set a due date" onclick="_rdDueModal('${l.id}')">${icon('calendar')} due</button>` : '');
  const respChip = l.responsible
    ? `<button class="form-secondary" style="font-size:10px;padding:2px 7px;" title="Responsible — click to change" ${canEdit ? `onclick="_rdRespModal('${l.id}')"` : 'disabled'}>${icon('user')} ${escapeHtml(l.responsible)}</button>`
    : (canEdit ? `<button class="form-secondary" style="font-size:10px;padding:2px 7px;color:var(--text-subtle);" title="Assign a responsible party" onclick="_rdRespModal('${l.id}')">${icon('user')} assign</button>` : '');
  const delayChip = delays.length
    ? `<button class="form-secondary" style="font-size:10px;padding:2px 7px;color:var(--warn);" title="Delay history" onclick="_rdDelayHistoryModal('${l.id}')">${icon('clock')} +${_rdSlipDays(l.id)}d ×${delays.length}</button>`
    : '';
  const cCount = _cpChkCommentCount(l.id, t);
  const commentChip = cCount
    ? `<span style="font-size:10px;color:var(--text-subtle);display:inline-flex;align-items:center;gap:3px;" title="${cCount} comment${cCount !== 1 ? 's' : ''} linked to this item (see the thread below)">${icon('inbox')} ${cCount}</span>`
    : '';
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:7px 4px;border-bottom:1px solid var(--gray-100);flex-wrap:wrap;">
      <span aria-hidden="true" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:5px;background:${l.verdict === 'Fail' ? 'var(--bad)' : complete ? 'var(--good)' : overdue ? 'var(--warn)' : 'var(--gray-300)'};"></span>
      <span style="flex:1;min-width:170px;">
        <span style="font-size:13px;${complete ? 'color:var(--gray-500);' : ''}">${l.kind === 'task' ? icon('link') + ' ' : ''}${escapeHtml(l.title)}${l.required === false ? ' <span style="font-size:10px;color:var(--gray-400);">(optional)</span>' : ''}${l.kind === 'value' && l.expected ? ` <span style="font-size:10px;color:var(--gray-400);">exp. ${escapeHtml(l.expected)}${l.unit ? ' ' + escapeHtml(l.unit) : ''}</span>` : ''}</span>
        ${l.description ? `<span style="display:block;font-size:11px;color:var(--gray-500);margin-top:1px;">${escapeHtml(l.description)}</span>` : ''}
      </span>
      <span style="display:inline-flex;align-items:center;gap:5px;">${ctl}</span>
      <span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
        ${dueChip}${respChip}${delayChip}${commentChip}
        ${canEdit ? `<button class="form-secondary" style="font-size:10px;padding:2px 6px;" aria-label="Add photo" title="Add photo" onclick="document.getElementById('rdchkp-${l.id}').click()">${icon('camera')}${photos.length ? ' ' + photos.length : ''}</button>
        <input type="file" id="rdchkp-${l.id}" accept="image/*" multiple style="display:none" onchange="_rdChkPhotoChosen('${l.id}',this)" aria-label="Photo files">
        <button class="form-secondary" style="font-size:10px;padding:2px 6px;" aria-label="Attach file" title="Attach file" onclick="document.getElementById('rdchkf-${l.id}').click()">${icon('paperclip')}${files.length ? ' ' + files.length : ''}</button>
        <input type="file" id="rdchkf-${l.id}" multiple style="display:none" onchange="_rdChkFileChosen('${l.id}',this)" aria-label="Attachment files">` : ''}
      </span>
      ${l.completed_by ? `<span style="font-size:10px;color:var(--gray-400);margin-top:4px;" title="Closed ${l.completed_at ? _fmtDate(l.completed_at) : ''}">${icon('check')} ${escapeHtml(l.completed_by)}${l.completed_at ? ' · ' + _fmtDate(l.completed_at) : ''}</span>` : ''}
      ${(photos.length || files.length) ? `<div style="flex-basis:100%;display:flex;flex-wrap:wrap;gap:5px;padding-left:18px;">
        ${photos.map(ph => `<button onclick="_rdChkOpenPhoto('${escapeHtml(ph.storage_path)}')" style="font-size:10px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);padding:2px 7px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">${icon('image')} ${escapeHtml(ph.file_name || 'photo')}</button>`).join('')}
        ${files.map(f => `<span style="font-size:10px;border:1px solid var(--border);border-radius:5px;padding:2px 7px;display:inline-flex;align-items:center;gap:4px;"><button onclick="_rdFileOpen('${escapeHtml(f.storage_path)}')" style="border:none;background:none;cursor:pointer;font:inherit;color:var(--text);display:inline-flex;align-items:center;gap:4px;padding:0;">${icon('paperclip')} ${escapeHtml(f.file_name)}</button>${canEdit ? `<button aria-label="Delete file" title="Delete file" onclick="_rdFileDelete('${f.id}')" style="border:none;background:none;color:var(--text-subtle);cursor:pointer;padding:0;line-height:1;">${icon('x')}</button>` : ''}</span>`).join('')}
      </div>` : ''}
    </div>`;
}

// Refresh the open task modal's checklist wrap in place (keeps scroll), plus
// the Checkpoint list behind it.
function _rdRefresh(taskId) {
  const t = _rdTask(taskId);
  const wrap = document.getElementById('rd-chk-wrap-' + taskId);
  if (wrap && t) wrap.innerHTML = _rdChecklistBodyHTML(t, _rdCan('edit'));
  renderWork();
}

// ── Line responses ────────────────────────────────────────────────────────
async function _rdChkSaveLine(lineId, patch) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  const l = TASK_CHK.find(x => x.id === lineId); if (!l) return;
  const seen = new Set([l.task_id]);
  const probe = { ...l, ...patch };
  if (_rdLineComplete(probe, seen) && !_rdLineComplete(l, seen)) { patch.completed_by = _rdWho(); patch.completed_at = new Date().toISOString(); }
  else if (!_rdLineComplete(probe, seen)) { patch.completed_by = null; patch.completed_at = null; }
  try {
    const [row] = await _dbUpdate('task_checklist_items', patch, { id: lineId });
    Object.assign(l, row || patch);
    _rdRefresh(l.task_id);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}
function _rdChkSetDone(id, on) { _rdChkSaveLine(id, { done: !!on }); }
function _rdChkSetVerdict(id, v) { const l = TASK_CHK.find(x => x.id === id); _rdChkSaveLine(id, { verdict: (l && l.verdict === v) ? null : v }); }
function _rdChkSetValue(id, v) { _rdChkSaveLine(id, { value_text: (v || '').trim() || null }); }

// ── Due date + mandatory delay reason ─────────────────────────────────────
function _rdDueModal(lineId) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  const l = TASK_CHK.find(x => x.id === lineId); if (!l) return;
  const delays = _rdDelaysFor(lineId);
  const histHTML = delays.length ? `<div style="margin-top:12px;">
    <div style="font-size:11px;font-weight:700;color:var(--warn);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">${icon('clock')} Delay history (+${_rdSlipDays(lineId)}d total)</div>
    ${delays.map(d => `<div style="font-size:12px;color:var(--gray-600);padding:3px 0;border-bottom:1px solid var(--gray-100);">${d.old_due ? _fmtDate(d.old_due) : '—'} → ${d.new_due ? _fmtDate(d.new_due) : '—'} · <b>${escapeHtml(d.reason)}</b>${d.note ? ' — ' + escapeHtml(d.note) : ''} <span style="color:var(--gray-400);">(${escapeHtml(d.created_by || '—')}, ${d.created_at ? _fmtDate(d.created_at) : ''})</span></div>`).join('')}
  </div>` : '';
  modal({
    title: 'Due Date — ' + escapeHtml(l.title), size: 'medium',
    body: `<div class="form-grid">
      <div class="form-field"><label>Due date</label><input type="date" id="rd-due-input" class="form-input" value="${l.due_date || ''}" onchange="_rdDueChanged('${lineId}')"></div>
      <div class="form-field" id="rd-due-reason-wrap" style="display:none;"><label>Delay reason <span style="color:var(--bad)">*</span></label>
        <select id="rd-due-reason" class="form-input">${_rdDelayReasons().map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}</select></div>
      <div class="form-field form-field-full" id="rd-due-note-wrap" style="display:none;"><label>Note <span style="font-weight:400;color:var(--gray-500);font-size:11px;">(optional)</span></label>
        <input type="text" id="rd-due-note" class="form-input" placeholder="e.g. waiting on other input from design"></div>
    </div>${histHTML}`,
    footer: `<button class="form-secondary" onclick="_rdDueCancel('${l.task_id}')">Cancel</button>
      <button class="form-submit" onclick="_rdDueSave('${lineId}')">Save</button>`,
  });
}
function _rdDueChanged(lineId) {
  const l = TASK_CHK.find(x => x.id === lineId); if (!l) return;
  const v = document.getElementById('rd-due-input')?.value || '';
  const pushed = !!(l.due_date && v && v > l.due_date);
  const rw = document.getElementById('rd-due-reason-wrap');
  const nw = document.getElementById('rd-due-note-wrap');
  if (rw) rw.style.display = pushed ? '' : 'none';
  if (nw) nw.style.display = pushed ? '' : 'none';
}
function _rdDueCancel(taskId) { closeModal(); if (typeof _taskViewModal === 'function') _taskViewModal(taskId); }
async function _rdDueSave(lineId) {
  const l = TASK_CHK.find(x => x.id === lineId); if (!l) return;
  const v = document.getElementById('rd-due-input')?.value || '';
  const newDue = v || null;
  const pushed = !!(l.due_date && newDue && newDue > l.due_date);
  const reason = document.getElementById('rd-due-reason')?.value || '';
  const note = (document.getElementById('rd-due-note')?.value || '').trim() || null;
  if (pushed && !reason) { toast('A delay reason is required when pushing a due date later', 'error'); return; }
  try {
    const [row] = await _dbUpdate('task_checklist_items', { due_date: newDue }, { id: lineId });
    if (pushed) {
      const [d] = await _dbInsert('task_item_delays', [{ item_id: lineId, old_due: l.due_date, new_due: newDue, reason, note, created_by: _rdWho() }]);
      if (d) TASK_DELAYS.push(d);
    }
    Object.assign(l, row || { due_date: newDue });
    closeModal();
    if (typeof _taskViewModal === 'function') _taskViewModal(l.task_id);
    _rdRefresh(l.task_id);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}
function _rdDelayHistoryModal(lineId) { _rdDueModal(lineId); }

// ── Responsible party ─────────────────────────────────────────────────────
function _rdRespModal(lineId) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  const l = TASK_CHK.find(x => x.id === lineId); if (!l) return;
  const people = _rdPeopleOptions(l.responsible);
  modal({
    title: 'Responsible — ' + escapeHtml(l.title), size: 'small',
    body: `<div class="form-grid">
      <div class="form-field form-field-full"><label>Responsible party</label>
        <input id="rd-resp-input" class="form-input" list="rd-resp-dl" value="${escapeHtml(l.responsible || '')}" placeholder="Pick a person or type a name / company" autocomplete="off">
        <datalist id="rd-resp-dl">${people.map(p => `<option value="${escapeHtml(p)}"></option>`).join('')}</datalist></div>
    </div>`,
    footer: `<button class="form-secondary" onclick="_rdDueCancel('${l.task_id}')">Cancel</button>
      <button class="form-submit" onclick="_rdRespSave('${lineId}')">Save</button>`,
  });
}
async function _rdRespSave(lineId) {
  const l = TASK_CHK.find(x => x.id === lineId); if (!l) return;
  const v = (document.getElementById('rd-resp-input')?.value || '').trim() || null;
  try {
    const [row] = await _dbUpdate('task_checklist_items', { responsible: v }, { id: lineId });
    Object.assign(l, row || { responsible: v });
    closeModal();
    if (typeof _taskViewModal === 'function') _taskViewModal(l.task_id);
    _rdRefresh(l.task_id);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

// ── Per-line photos (Photos module) ───────────────────────────────────────
async function _rdChkHydratePhotos(taskId) {
  const ids = _rdChkFor(taskId).map(l => l.id);
  if (!ids.length) return;
  try {
    const rows = await _fetchAnon('photos?select=*&is_deleted=eq.false&source_type=eq.tasks&source_id=in.(' + ids.map(encodeURIComponent).join(',') + ')');
    let changed = false;
    for (const id of ids) {
      const mine = (rows || []).filter(r => r.source_id === id);
      if ((_rdChkPhotos[id] || []).length !== mine.length) changed = true;
      _rdChkPhotos[id] = mine;
    }
    if (changed) _rdRefresh(taskId);
  } catch (e) { console.warn('[rd chk photos]', e.message); }
}
async function _rdChkPhotoChosen(lineId, input) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  const files = [...(input.files || [])]; input.value = '';
  if (!files.length) return;
  if (!window.PhotosModule || !PhotosModule.uploadFile) { toast('Photos module unavailable', 'error'); return; }
  const l = TASK_CHK.find(x => x.id === lineId);
  const t = l ? _rdTask(l.task_id) : null;
  toast('Uploading ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + '…');
  for (const f of files) {
    try {
      const row = await PhotosModule.uploadFile(f, { source_type: 'tasks', source_id: lineId, source_label: 'Activity: ' + (t ? t.task_name : '') + (l ? ' · ' + l.title : '') });
      (_rdChkPhotos[lineId] = _rdChkPhotos[lineId] || []).push(row);
    } catch (e) { console.error('[rd chk photo]', e); toast('Photo upload failed: ' + e.message, 'error'); }
  }
  if (l) _rdRefresh(l.task_id);
}
function _rdChkOpenPhoto(path) {
  if (!window.PhotosModule || !PhotosModule.sign) return;
  PhotosModule.sign([path]).then(m => { const u = m && m[path]; if (u) window.open(u, '_blank'); });
}

// ── Any-type file attachments (task-files bucket) ─────────────────────────
// Same storage-adapter seam as _vfStorage / _formsStorage: swap internals at
// the Microsoft migration cutover, callers never change.
const _rdStorage = {
  bucket: 'task-files',
  async upload(path, file) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${this.bucket}/${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: _getAuthHeader(), 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' },
      body: file,
    });
    if (!res.ok) throw new Error('upload failed (' + res.status + ')');
  },
  async signedUrl(path) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${this.bucket}/${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: _getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!res.ok) throw new Error('sign failed (' + res.status + ')');
    const j = await res.json();
    return `${SUPABASE_URL}/storage/v1${j.signedURL || j.signedUrl}`;
  },
  async remove(path) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${this.bucket}/${path}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: _getAuthHeader() },
    });
    if (!res.ok && res.status !== 404) throw new Error('remove failed (' + res.status + ')');
  },
};
async function _rdChkFileChosen(lineId, input) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  const files = [...(input.files || [])]; input.value = '';
  if (!files.length) return;
  const l = TASK_CHK.find(x => x.id === lineId);
  toast('Uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '…');
  for (const file of files) {
    try {
      const safe = (file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
      const path = lineId + '/' + Date.now() + '_' + safe;
      await _rdStorage.upload(path, file);
      const [row] = await _dbInsert('task_files', [{ checklist_item_id: lineId, file_name: file.name || safe, storage_path: path, file_size: file.size || null, content_type: file.type || null, uploaded_by: _rdWho() }]);
      if (row) TASK_FILES.push(row);
    } catch (e) { console.error('[rd chk file]', e); toast('Upload failed: ' + e.message, 'error'); }
  }
  if (l) _rdRefresh(l.task_id);
}
async function _rdFileOpen(path) {
  try { const u = await _rdStorage.signedUrl(path); window.open(u, '_blank'); }
  catch (e) { toast('Open failed: ' + e.message, 'error'); }
}
async function _rdFileDelete(id) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  const f = TASK_FILES.find(x => x.id === id); if (!f) return;
  if (!await cxConfirm('Delete attachment "' + f.file_name + '"?')) return;
  const l = TASK_CHK.find(x => x.id === f.checklist_item_id);
  try {
    await _rdStorage.remove(f.storage_path);
    await _dbDelete('task_files', { id });
    TASK_FILES = TASK_FILES.filter(x => x.id !== id);
    if (l) _rdRefresh(l.task_id);
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

// ── Checklist builder (task scope + template scope) ───────────────────────
let _rdCkb = null;
function _rdChkBuilderModal(scope, parentId) {
  if (!_rdCan(scope === 'tpl' ? 'manage_templates' : 'edit')) { toast('Not permitted', 'error'); return; }
  const src = scope === 'tpl'
    ? RD_TPL_ITEMS.filter(x => x.template_id === parentId).sort((a, b) => (a.seq || 0) - (b.seq || 0))
    : _rdChkFor(parentId);
  _rdCkb = { scope, parentId, removed: [], lines: JSON.parse(JSON.stringify(src)) };
  const parentTitle = scope === 'tpl'
    ? ((RD_TPLS.find(t => t.id === parentId) || {}).name || '')
    : ((_rdTask(parentId) || {}).task_name || '');
  modal({
    title: (scope === 'tpl' ? 'Template Checklist · ' : 'Checklist · ') + escapeHtml(parentTitle), size: 'large',
    body: `<div style="font-size:12px;color:var(--gray-500);margin-bottom:10px;">Each line has a title + description and can be a tick, a Pass/Fail/N.A. verdict, a measured value (unit + expected), a note${scope === 'task' ? ', or a <b>linked activity</b> — another activity whose progress rolls up here read-only' : ''}. Group lines with the Section field.${scope === 'task' ? ' Responses already recorded are kept for lines you keep.' : ' Activities issued from this template receive a copy of these lines (later template edits never touch already-issued activities).'}</div>
      <div id="rdckb-rows"></div>
      <div style="margin-top:8px;"><button class="form-secondary" style="font-size:12px;" onclick="_rdCkbAdd()">${icon('plus')} Add line</button></div>`,
    footer: `<button class="form-secondary" onclick="${scope === 'tpl' ? `_rdTplItemsCancel()` : `_rdDueCancel('${parentId}')`}">Cancel</button>
      <button class="form-submit" onclick="_rdCkbSave()">Save Checklist</button>`,
  });
  _rdCkbRender();
}
function _rdCkbLinkOptions(line) {
  const parentId = _rdCkb.parentId;
  return (typeof TASKS !== 'undefined' ? TASKS : [])
    .filter(t => t.id !== parentId && (!_rdWouldCycle(parentId, t.id) || t.id === line.linked_task_id))
    .sort((a, b) => String(a.task_name || '').localeCompare(String(b.task_name || '')));
}
function _rdCkbRender() {
  const wrap = document.getElementById('rdckb-rows'); if (!wrap) return;
  const isTpl = _rdCkb.scope === 'tpl';
  const kinds = [['check', 'Checkbox'], ['passfail', 'Pass/Fail/N.A.'], ['value', 'Value'], ['note', 'Note']];
  if (!isTpl) kinds.push(['task', 'Linked activity']);
  wrap.innerHTML = _rdCkb.lines.length ? _rdCkb.lines.map((l, i) => `
    <div style="border:1px solid var(--border);border-radius:6px;padding:6px 8px;margin-bottom:5px;">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <input class="form-input rdckb-sec" data-i="${i}" placeholder="Section" value="${escapeHtml(l.section || '')}" style="width:110px;font-size:12px;">
        <input class="form-input rdckb-title" data-i="${i}" placeholder="Item title *" value="${escapeHtml(l.title || '')}" style="flex:1;min-width:150px;font-size:12px;">
        <select class="form-input rdckb-kind" data-i="${i}" onchange="_rdCkbKind(${i},this.value)" style="width:130px;font-size:12px;">
          ${kinds.map(([v, lbl]) => `<option value="${v}" ${l.kind === v ? 'selected' : ''}>${lbl}</option>`).join('')}
        </select>
        <input class="form-input rdckb-unit" data-i="${i}" placeholder="unit" value="${escapeHtml(l.unit || '')}" style="width:60px;font-size:12px;${l.kind === 'value' ? '' : 'display:none;'}">
        <input class="form-input rdckb-exp" data-i="${i}" placeholder="expected" value="${escapeHtml(l.expected || '')}" style="width:86px;font-size:12px;${l.kind === 'value' ? '' : 'display:none;'}">
        <label style="font-size:11px;display:inline-flex;gap:3px;align-items:center;"><input type="checkbox" class="rdckb-req" data-i="${i}" ${l.required !== false ? 'checked' : ''}> req</label>
        <button class="form-secondary" style="font-size:11px;padding:1px 6px;" ${i === 0 ? 'disabled' : ''} aria-label="Move line up" title="Move up" onclick="_rdCkbMove(${i},-1)">▲</button>
        <button class="form-secondary" style="font-size:11px;padding:1px 6px;" ${i === _rdCkb.lines.length - 1 ? 'disabled' : ''} aria-label="Move line down" title="Move down" onclick="_rdCkbMove(${i},1)">▼</button>
        <button class="form-secondary" style="font-size:11px;padding:1px 6px;color:var(--bad);" aria-label="Remove line" title="Remove line" onclick="_rdCkbRemove(${i})">${icon('x')}</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px;">
        <input class="form-input rdckb-desc" data-i="${i}" placeholder="Short description (optional)" value="${escapeHtml(l.description || '')}" style="flex:1;min-width:170px;font-size:12px;">
        ${l.kind === 'task' && !isTpl ? `
          <select class="form-input rdckb-link" data-i="${i}" aria-label="Linked activity" style="width:230px;font-size:12px;">
            <option value="">— pick the linked activity —</option>
            ${_rdCkbLinkOptions(l).map(t => `<option value="${t.id}" ${l.linked_task_id === t.id ? 'selected' : ''}>${escapeHtml(t.task_name || t.id)}</option>`).join('')}
          </select>` : ''}
        ${isTpl
          ? `<input type="number" class="form-input rdckb-off" data-i="${i}" placeholder="due offset (days)" title="Item due date = activity due date minus this many days" value="${l.due_offset_days != null ? l.due_offset_days : ''}" style="width:130px;font-size:12px;">
             <input class="form-input rdckb-resp" data-i="${i}" list="rdckb-resp-dl" placeholder="default responsible" value="${escapeHtml(l.default_responsible || '')}" style="width:160px;font-size:12px;" autocomplete="off">`
          : `<input type="date" class="form-input rdckb-due" data-i="${i}" title="Due date" aria-label="Due date" value="${l.due_date || ''}" style="width:140px;font-size:12px;">
             <input class="form-input rdckb-resp" data-i="${i}" list="rdckb-resp-dl" placeholder="responsible" value="${escapeHtml(l.responsible || '')}" style="width:150px;font-size:12px;" autocomplete="off">`}
      </div>
    </div>`).join('') + `<datalist id="rdckb-resp-dl">${_rdPeopleOptions('').map(p => `<option value="${escapeHtml(p)}"></option>`).join('')}</datalist>`
    : '<div style="font-size:12px;color:var(--gray-500);padding:8px;">No lines yet — add the first one.</div>';
}
function _rdCkbSync() {
  const get = (cls, i) => document.querySelector('.' + cls + '[data-i="' + i + '"]');
  const isTpl = _rdCkb.scope === 'tpl';
  _rdCkb.lines.forEach((l, i) => {
    l.section = (get('rdckb-sec', i)?.value || '').trim() || null;
    l.title = (get('rdckb-title', i)?.value || '').trim();
    l.kind = get('rdckb-kind', i)?.value || l.kind || 'check';
    l.description = (get('rdckb-desc', i)?.value || '').trim() || null;
    l.unit = (get('rdckb-unit', i)?.value || '').trim() || null;
    l.expected = (get('rdckb-exp', i)?.value || '').trim() || null;
    l.required = !!get('rdckb-req', i)?.checked;
    if (isTpl) {
      const off = get('rdckb-off', i)?.value;
      l.due_offset_days = (off !== undefined && off !== '') ? parseInt(off, 10) : null;
      l.default_responsible = (get('rdckb-resp', i)?.value || '').trim() || null;
    } else {
      l.due_date = get('rdckb-due', i)?.value || null;
      l.responsible = (get('rdckb-resp', i)?.value || '').trim() || null;
      l.linked_task_id = l.kind === 'task' ? (get('rdckb-link', i)?.value || null) : null;
      if (l.kind === 'task' && l.linked_task_id && !l.title) {
        const child = _rdTask(l.linked_task_id);
        if (child) l.title = child.task_name || '';
      }
    }
  });
}
function _rdCkbKind(i, v) { _rdCkbSync(); _rdCkb.lines[i].kind = v; _rdCkbRender(); }
function _rdCkbAdd() { _rdCkbSync(); const last = _rdCkb.lines[_rdCkb.lines.length - 1]; _rdCkb.lines.push({ section: last ? last.section : null, title: '', kind: 'check', required: true }); _rdCkbRender(); }
function _rdCkbMove(i, dir) { _rdCkbSync(); const j = i + dir; if (j < 0 || j >= _rdCkb.lines.length) return; [_rdCkb.lines[i], _rdCkb.lines[j]] = [_rdCkb.lines[j], _rdCkb.lines[i]]; _rdCkbRender(); }
function _rdCkbRemove(i) { _rdCkbSync(); const gone = _rdCkb.lines.splice(i, 1)[0]; if (gone && gone.id) _rdCkb.removed.push(gone.id); _rdCkbRender(); }
async function _rdCkbSave() {
  _rdCkbSync();
  const lines = _rdCkb.lines.filter(l => l.title);
  const isTpl = _rdCkb.scope === 'tpl';
  for (const l of lines) {
    if (!isTpl && l.kind === 'task') {
      if (!l.linked_task_id) { toast('Pick the linked activity for "' + l.title + '"', 'error'); return; }
      if (_rdWouldCycle(_rdCkb.parentId, l.linked_task_id)) { toast('That link would create a circular dependency', 'error'); return; }
    }
  }
  const table = isTpl ? 'readiness_template_items' : 'task_checklist_items';
  const parentCol = isTpl ? 'template_id' : 'task_id';
  try {
    for (const id of _rdCkb.removed) await _dbDelete(table, { id });
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const base = {
        section: l.section, seq: (i + 1) * 10, title: l.title, description: l.description,
        kind: l.kind, unit: l.kind === 'value' ? l.unit : null, expected: l.kind === 'value' ? l.expected : null,
        required: l.required !== false,
      };
      if (isTpl) { base.due_offset_days = l.due_offset_days; base.default_responsible = l.default_responsible; }
      else { base.due_date = l.due_date || null; base.responsible = l.responsible; base.linked_task_id = l.kind === 'task' ? l.linked_task_id : null; }
      if (l.id) { const [row] = await _dbUpdate(table, base, { id: l.id }); kept.push(row || { ...l, ...base }); }
      else { const [row] = await _dbInsert(table, [{ ...base, [parentCol]: _rdCkb.parentId, created_by: _rdWho() }]); if (row) kept.push(row); }
    }
    if (isTpl) {
      RD_TPL_ITEMS = RD_TPL_ITEMS.filter(x => x.template_id !== _rdCkb.parentId).concat(kept);
      toast('Template checklist saved', 'success');
      _rdTemplatesModal();
    } else {
      const lineIds = new Set(kept.map(k => k.id));
      TASK_DELAYS = TASK_DELAYS.filter(d => lineIds.has(d.item_id) || !_rdCkb.removed.includes(d.item_id));
      TASK_CHK = TASK_CHK.filter(x => x.task_id !== _rdCkb.parentId).concat(kept);
      toast('Checklist saved', 'success');
      closeModal();
      if (typeof _taskViewModal === 'function') _taskViewModal(_rdCkb.parentId);
      _rdRefresh(_rdCkb.parentId);
    }
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}
function _rdTplItemsCancel() { closeModal(); _rdTemplatesModal(); }

// ── Apply a template's lines onto an existing task ────────────────────────
function _rdApplyTplModal(taskId) {
  if (!_rdCan('edit')) { toast('Not permitted', 'error'); return; }
  if (!RD_TPLS.length) { toast('No templates yet — create one from the Activity Readiness page', 'error'); return; }
  modal({
    title: 'Add checklist from template', size: 'small',
    body: `<div class="form-grid"><div class="form-field form-field-full"><label>Template</label>
      <select id="rd-apply-tpl" class="form-input">${RD_TPLS.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${RD_TPL_ITEMS.filter(i => i.template_id === t.id).length} items)</option>`).join('')}</select></div>
      <div class="form-field form-field-full" style="font-size:12px;color:var(--gray-500);">Lines are appended to the existing checklist as a snapshot copy — edit them freely afterwards.</div></div>`,
    footer: `<button class="form-secondary" onclick="_rdDueCancel('${taskId}')">Cancel</button>
      <button class="form-submit" onclick="_rdApplyTplSave('${taskId}')">Add Items</button>`,
  });
}
async function _rdApplyTplSave(taskId) {
  const tplId = document.getElementById('rd-apply-tpl')?.value;
  if (!tplId) return;
  const t = _rdTask(taskId);
  try {
    const rows = _rdSeedRows(tplId, taskId, t ? t.due_date : null);
    if (rows.length) {
      const ins = await _dbInsert('task_checklist_items', rows);
      TASK_CHK.push(...(ins || []));
    }
    toast('Checklist items added', 'success');
    closeModal();
    if (typeof _taskViewModal === 'function') _taskViewModal(taskId);
    _rdRefresh(taskId);
  } catch (e) { toast('Add failed: ' + e.message, 'error'); }
}
// Build the insert rows that copy a template onto a task. Item due date =
// activity due date − due_offset_days (when both are set).
function _rdSeedRows(tplId, taskId, taskDue) {
  const baseSeq = _rdChkFor(taskId).reduce((m, x) => Math.max(m, x.seq || 0), 0);
  return RD_TPL_ITEMS.filter(x => x.template_id === tplId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map((l, i) => ({
      task_id: taskId, section: l.section, seq: baseSeq + (i + 1) * 10,
      title: l.title, description: l.description, kind: l.kind,
      unit: l.unit, expected: l.expected, required: l.required,
      responsible: l.default_responsible || null,
      due_date: (taskDue && l.due_offset_days != null)
        ? new Date(new Date(taskDue).getTime() - l.due_offset_days * 86400000).toISOString().slice(0, 10)
        : null,
      created_by: _rdWho(),
    }));
}

// ── Template manager ──────────────────────────────────────────────────────
function _rdTemplatesModal() {
  if (!_rdCan('view')) return;
  const canManage = _rdCan('manage_templates');
  const rows = RD_TPLS.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map(t => {
    const n = RD_TPL_ITEMS.filter(i => i.template_id === t.id).length;
    const used = (typeof TASKS !== 'undefined' ? TASKS : []).filter(x => x.template_id === t.id).length;
    return `<div style="display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid var(--gray-100);flex-wrap:wrap;">
      <span style="flex:1;min-width:170px;">
        <span style="font-size:13px;font-weight:600;">${escapeHtml(t.name)}</span>
        ${t.description ? `<span style="display:block;font-size:11px;color:var(--gray-500);">${escapeHtml(t.description)}</span>` : ''}
      </span>
      <span style="font-size:11px;color:var(--gray-500);">${n} item${n !== 1 ? 's' : ''}${used ? ' · issued ×' + used : ''}</span>
      <span style="display:inline-flex;gap:4px;">
        <button class="form-secondary" style="font-size:11px;padding:2px 8px;" onclick="_rdIssueModal('${t.id}')">${icon('plus')} Issue</button>
        ${canManage ? `<button class="form-secondary" style="font-size:11px;padding:2px 8px;" onclick="_rdChkBuilderModal('tpl','${t.id}')">${icon('sliders')} Items</button>
        <button class="form-secondary" style="font-size:11px;padding:2px 8px;" onclick="_rdTplEditModal('${t.id}')">${icon('edit')} Rename</button>
        <button class="form-secondary" style="font-size:11px;padding:2px 8px;color:var(--bad);" aria-label="Delete template" title="Delete template" onclick="_rdTplDelete('${t.id}')">${icon('trash')}</button>` : ''}
      </span>
    </div>`;
  }).join('');
  modal({
    title: 'Readiness Templates', size: 'large',
    body: `<div style="font-size:12px;color:var(--gray-500);margin-bottom:10px;">A template defines the checklist for one kind of activity (e.g. “DCS Site Testing Start”). Issuing it creates an activity with a snapshot copy of the items — fully editable afterwards; template edits only affect future issues.</div>
      ${rows || '<div style="font-size:12px;color:var(--gray-500);padding:12px 4px;">No templates yet.</div>'}
      ${canManage ? `<div style="margin-top:10px;"><button class="form-secondary" style="font-size:12px;" onclick="_rdTplEditModal(null)">${icon('plus')} New template</button></div>` : ''}`,
    footer: `<button class="form-secondary" onclick="closeModal()">Close</button>`,
  });
}
function _rdTplEditModal(id) {
  if (!_rdCan('manage_templates')) { toast('Not permitted', 'error'); return; }
  const t = id ? RD_TPLS.find(x => x.id === id) : null;
  modal({
    title: t ? 'Edit Template' : 'New Template', size: 'medium',
    body: `<div class="form-grid">
      <div class="form-field form-field-full"><label>Name <span style="color:var(--bad)">*</span></label>
        <input id="rd-tpl-name" class="form-input" placeholder="e.g. DCS Site Testing Start" value="${escapeHtml(t?.name || '')}"></div>
      <div class="form-field form-field-full"><label>Description</label>
        <input id="rd-tpl-desc" class="form-input" placeholder="What activity does this checklist gate?" value="${escapeHtml(t?.description || '')}"></div>
    </div>`,
    footer: `<button class="form-secondary" onclick="_rdTemplatesModal()">Cancel</button>
      <button class="form-submit" onclick="_rdTplSave(${id ? `'${id}'` : 'null'})">${t ? 'Save' : 'Create & add items'}</button>`,
  });
}
async function _rdTplSave(id) {
  const name = (document.getElementById('rd-tpl-name')?.value || '').trim();
  if (!name) { toast('Name is required', 'error'); return; }
  const description = (document.getElementById('rd-tpl-desc')?.value || '').trim() || null;
  try {
    if (id) {
      const [row] = await _dbUpdate('readiness_templates', { name, description, updated_by: _rdWho(), updated_at: new Date().toISOString() }, { id });
      const t = RD_TPLS.find(x => x.id === id);
      if (t) Object.assign(t, row || { name, description });
      toast('Template saved', 'success');
      _rdTemplatesModal();
    } else {
      const [row] = await _dbInsert('readiness_templates', [{ name, description, created_by: _rdWho() }]);
      if (row) RD_TPLS.push(row);
      toast('Template created', 'success');
      if (row) _rdChkBuilderModal('tpl', row.id); else _rdTemplatesModal();
    }
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}
async function _rdTplDelete(id) {
  if (!_rdCan('manage_templates')) { toast('Not permitted', 'error'); return; }
  const t = RD_TPLS.find(x => x.id === id); if (!t) return;
  if (!await cxConfirm('Delete template "' + t.name + '"?\n\nAlready-issued activities keep their checklists (they are snapshot copies). This cannot be undone.')) return;
  try {
    await _dbDelete('readiness_templates', { id });
    RD_TPLS = RD_TPLS.filter(x => x.id !== id);
    RD_TPL_ITEMS = RD_TPL_ITEMS.filter(x => x.template_id !== id);
    toast('Template deleted', 'success');
    _rdTemplatesModal();
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

// ── Issue an activity (from a template or blank) ──────────────────────────
function _rdIssueModal(tplId) {
  if (!_rdCan('create')) { toast('Not permitted', 'error'); return; }
  const tpl = tplId ? RD_TPLS.find(t => t.id === tplId) : null;
  const people = _rdPeopleOptions('');
  modal({
    title: 'New Readiness Activity', size: 'large',
    body: `<div class="form-grid">
      <div class="form-field form-field-full"><label>Template</label>
        <select id="rd-issue-tpl" class="form-input" onchange="_rdIssueTplChanged()">
          <option value="">— Blank (build the checklist manually) —</option>
          ${RD_TPLS.map(t => `<option value="${t.id}" ${tpl && tpl.id === t.id ? 'selected' : ''}>${escapeHtml(t.name)} (${RD_TPL_ITEMS.filter(i => i.template_id === t.id).length} items)</option>`).join('')}
        </select></div>
      <div class="form-field form-field-full"><label>Activity title <span style="color:var(--bad)">*</span></label>
        <input id="rd-issue-title" class="form-input" placeholder="e.g. DCS Site Testing — W40" value="${escapeHtml(tpl ? tpl.name : '')}"></div>
      <div class="form-field form-field-full"><label>Description</label>
        <input id="rd-issue-desc" class="form-input" value="${escapeHtml(tpl?.description || '')}"></div>
      ${_rdDatalistField('rd-issue-loc', 'Location', '', _rdLocationOptions(), 'pick or type')}
      ${_rdDatalistField('rd-issue-sub', 'Subsystem', '', _rdSubsystemOptions(), 'pick or type')}
      ${_rdDatalistField('rd-issue-phase', 'Phase', '', _rdPhaseOptions(), 'pick or type')}
      <div class="form-field"><label>Target date</label><input type="date" id="rd-issue-due" class="form-input"></div>
      <div class="form-field"><label>Owner</label>
        <input id="rd-issue-owner" class="form-input" list="rd-issue-owner-dl" placeholder="pick or type" autocomplete="off">
        <datalist id="rd-issue-owner-dl">${people.map(p => `<option value="${escapeHtml(p)}"></option>`).join('')}</datalist></div>
      <div class="form-field form-field-full" style="font-size:12px;color:var(--gray-500);">Template items are copied onto the new activity (item due dates = target date − each item’s offset). Everything stays editable afterwards.</div>
    </div>`,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="_rdIssueSave()">Create Activity</button>`,
  });
}
function _rdIssueTplChanged() {
  const tplId = document.getElementById('rd-issue-tpl')?.value;
  const tpl = RD_TPLS.find(t => t.id === tplId);
  const title = document.getElementById('rd-issue-title');
  const desc = document.getElementById('rd-issue-desc');
  if (tpl && title && !title.value.trim()) title.value = tpl.name;
  if (tpl && desc && !desc.value.trim()) desc.value = tpl.description || '';
}
async function _rdIssueSave() {
  const g = id => (document.getElementById(id)?.value || '').trim() || null;
  const title = g('rd-issue-title');
  if (!title) { toast('Activity title is required', 'error'); return; }
  const tplId = document.getElementById('rd-issue-tpl')?.value || null;
  const due = document.getElementById('rd-issue-due')?.value || null;
  const payload = {
    task_name: title, description: g('rd-issue-desc'),
    kind: 'activity',
    location: g('rd-issue-loc'), subsystem: g('rd-issue-sub'), phase: g('rd-issue-phase'),
    template_id: tplId, assignee: g('rd-issue-owner'), due_date: due,
    status: 'Not Started', priority: 'Medium', task_type: [],
    created_by: _rdWho(), updated_by: _rdWho(), updated_at: new Date().toISOString(),
  };
  try {
    const [created] = await _dbInsert('tasks', [payload]);
    if (!created) throw new Error('Activity was not created — you may not have permission.');
    if (typeof TASKS !== 'undefined') TASKS.unshift(created);
    if (tplId) {
      const rows = _rdSeedRows(tplId, created.id, due);
      if (rows.length) {
        const ins = await _dbInsert('task_checklist_items', rows);
        TASK_CHK.push(...(ins || []));
      }
    }
    if (typeof logAudit === 'function') logAudit('Readiness Activity Created', title, tplId ? 'From template' : 'Blank');
    toast('Activity created', 'success');
    closeModal();
    if (typeof _taskViewModal === 'function') _taskViewModal(created.id);
    _rdRefresh(created.id);
  } catch (e) { toast('Create failed: ' + e.message, 'error'); }
}

// ── Comment ↔ checklist-item linking (one merged thread) ──────────────────
// The composer offers "About: whole item / [checklist line]"; a linked comment
// stores item_id and renders with a chip naming the line. Comments migrated
// from the retired prerequisite thread carry legacy_prereq:true.
function _cpCommentItemSelectHTML(t, taskId) {
  const lines = _rdChkFor(taskId);
  if (!lines.length) return '';
  return `<select id="task-comment-item-${taskId}" class="form-input" aria-label="Link comment to a checklist item" title="Link this comment to a checklist item" style="max-width:210px;font-size:12px;">
    <option value="">About: whole ${_rdKind(t) === 'activity' ? 'activity' : 'task'}</option>
    ${lines.map(l => `<option value="${l.id}">↳ ${escapeHtml(_truncateRd(l.title, 40))}</option>`).join('')}
  </select>`;
}
function _cpCommentChips(c) {
  let h = '';
  if (c && c.item_id) {
    const l = TASK_CHK.find(x => x.id === c.item_id);
    h += `<span class="v2-pill is-info" style="font-size:10px;">${icon('link')} ${escapeHtml(_truncateRd(l ? l.title : 'checklist item', 44))}</span> `;
  }
  if (c && c.legacy_prereq) h += `<span class="v2-pill is-warn" style="font-size:10px;">${icon('flag')} prerequisite</span> `;
  return h;
}
function _cpCommentItemId(taskId) {
  return document.getElementById('task-comment-item-' + taskId)?.value || null;
}
function _cpChkCommentCount(lineId, t) {
  return (typeof _taskComments === 'function' ? _taskComments(t) : []).filter(c => c.item_id === lineId).length;
}
function _truncateRd(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── Checkpoint page (unified tasks + readiness workspace) ──────────────────
function _rdSetFilter(k, v) { _rdFilter[k] = v; renderReadiness(); }
function _rdClearFilters() { _rdFilter = { search: '', kind: '', location: '', subsystem: '', phase: '', status: '', priority: '', type: '', mine: false, ready: false, overdue: false }; renderReadiness(); }
function _rdSetView(v) { _rdView = v; renderReadiness(); }
function _rdSetMatrixDim(d) { _rdMatrixDim = d; renderReadiness(); }
// Drill from a rollup/matrix into the filtered list.
function _rdDrill(dim, key) {
  if (key && key !== _RD_UNASSIGNED) _rdFilter[dim] = key;
  _rdView = 'list';
  renderReadiness();
}
function _rdDrillCell(sub, col, colDim) {
  if (sub && sub !== _RD_UNASSIGNED) _rdFilter.subsystem = sub;
  if (col && col !== _RD_UNASSIGNED) _rdFilter[colDim] = col;
  _rdView = 'list';
  renderReadiness();
}

// Checkpoint owns the former Tasks page surface (page id 'tasks'); app.js's
// renderTasks() delegates here, so every legacy call site lands on this.
function renderWork() {
  const root = document.getElementById('tasks-content');
  const heroEl = document.getElementById('tasks-hero-content');
  if (!root || (typeof currentRoleUser !== 'undefined' && !currentRoleUser)) return;
  if (!_rdCan('view')) {
    root.innerHTML = cxEmpty({ icon: 'lock', title: 'Not authorized', message: 'You don’t have access to Checkpoint.' });
    return;
  }
  const items = (typeof TASKS !== 'undefined' ? TASKS : []);
  const acts = items.filter(t => _rdKind(t) === 'activity');
  const tasksOnly = items.length - acts.length;

  // Overall readiness — item-weighted across activities (an activity with
  // 20 items moves the needle more than one with 3).
  let sumDone = 0, sumTotal = 0, ready = 0, overdueItems = 0;
  const progress = new Map();
  for (const t of items) {
    const p = _rdTaskProgress(t.id);
    progress.set(t.id, p);
    if (_rdKind(t) === 'activity') { sumDone += p.done; sumTotal += p.total; }
    if (p.total && p.pct === 100) ready++;
    overdueItems += _rdTaskOverdueLines(t.id).length;
  }
  const overallPct = sumTotal ? Math.round(sumDone / sumTotal * 100) : 0;

  if (heroEl) heroEl.innerHTML = renderPageHero({
    eyebrow: 'Field',
    title: 'Checkpoint',
    sub: 'Tasks and readiness activities in one workspace — checklists, templates, delay tracking and rollup by location / subsystem / phase',
    stats: [
      { label: 'Readiness', value: overallPct + '%', tone: overallPct === 100 ? 'good' : 'blue' },
      { label: 'Tasks', value: tasksOnly, tone: 'muted' },
      { label: 'Activities', value: acts.length },
      { label: 'Ready', value: ready, tone: ready ? 'good' : 'muted' },
      { label: 'Overdue items', value: overdueItems, tone: overdueItems ? 'amber' : 'muted' },
    ],
  });

  _htmlPreserveFocus(root, _rdPageHTML(items, acts, progress, overallPct));
  setTimeout(_initPageLibraries, 80);
}
// Back-compat alias — internal handlers and older call sites use this name.
function renderReadiness() { renderWork(); }

function _rdPageHTML(items, acts, progress, overallPct) {
  const f = _rdFilter;
  const srch = (f.search || '').toLowerCase();
  const myName = (typeof currentRoleUser !== 'undefined' && currentRoleUser && currentRoleUser.name) || '';
  const isReadyItem = t => { const p = progress.get(t.id); return p && p.total > 0 && p.pct === 100; };
  const match = (t, except) => {
    if (except !== 'kind' && f.kind && _rdKind(t) !== f.kind) return false;
    if (except !== 'mine' && f.mine && (t.assignee || '') !== myName) return false;
    if (except !== 'ready' && f.ready && !isReadyItem(t)) return false;
    if (except !== 'status' && f.status && (t.status || 'Not Started') !== f.status) return false;
    if (except !== 'overdue' && f.overdue && !_rdTaskOverdueLines(t.id).length) return false;
    if (f.priority && (t.priority || '') !== f.priority) return false;
    if (f.type && !(typeof _taskTypeList === 'function' ? _taskTypeList(t) : []).includes(f.type)) return false;
    if (f.location && (t.location || '') !== f.location) return false;
    if (f.subsystem && (t.subsystem || '') !== f.subsystem) return false;
    if (f.phase && (t.phase || '') !== f.phase) return false;
    if (srch && !`${t.task_name || ''} ${t.description || ''} ${t.assignee || ''} ${t.location || ''} ${t.subsystem || ''} ${t.phase || ''} ${(typeof _taskCommentText === 'function' ? _taskCommentText(t) : '')} ${_rdChkFor(t.id).map(l => l.title).join(' ')}`.toLowerCase().includes(srch)) return false;
    return true;
  };
  const filtered = items.filter(t => match(t)).sort((a, b) =>
    String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) ||
    String(a.task_name || '').localeCompare(String(b.task_name || '')));

  // Filtered readiness rollup for the big bar (activities on screen).
  let fd = 0, ft = 0;
  for (const t of filtered) {
    if (_rdKind(t) !== 'activity') continue;
    const p = progress.get(t.id); fd += p.done; ft += p.total;
  }
  const fPct = ft ? Math.round(fd / ft * 100) : 0;

  const locOpts = [...new Set(items.map(t => t.location).filter(Boolean))].sort();
  const subOpts = [...new Set(items.map(t => t.subsystem).filter(Boolean))].sort();
  const phaseOpts = [...new Set(items.map(t => t.phase).filter(Boolean))].sort();
  const prioOpts = (typeof _taskPriorities === 'function') ? _taskPriorities() : [];
  const typeOpts = (typeof _taskTypes === 'function') ? _taskTypes() : [];
  const statuses = (typeof _taskStatuses === 'function') ? _taskStatuses() : ['Not Started', 'In Progress', 'Done'];
  const hasFilters = f.search || f.kind || f.location || f.subsystem || f.phase || f.status || f.priority || f.type || f.mine || f.ready || f.overdue;
  const overdueCount = items.filter(t => _rdTaskOverdueLines(t.id).length).length;
  const readyCount = items.filter(t => match(t, 'ready')).filter(isReadyItem).length;
  const myCount = myName ? items.filter(t => match(t, 'mine')).filter(t => (t.assignee || '') === myName).length : 0;
  const kindCount = k => items.filter(t => match(t, 'kind')).filter(t => _rdKind(t) === k).length;
  const delayEvents = TASK_DELAYS.filter(d => d.old_due && d.new_due && new Date(d.new_due) > new Date(d.old_due)).length;

  // View switcher — List (everything) / Overview (readiness matrix) / Delays.
  const seg = (v, label, ic, badge) => `<button class="rd-seg${_rdView === v ? ' active' : ''}" aria-pressed="${_rdView === v}" onclick="_rdSetView('${v}')">${icon(ic)} ${label}${badge != null ? ` <span class="rd-seg-n">${badge}</span>` : ''}</button>`;
  const switcher = `<div class="rd-segmented" role="group" aria-label="Checkpoint view">
    ${seg('list', 'Work Items', 'clipboard', items.length)}
    ${seg('overview', 'Readiness Overview', 'layers')}
    ${seg('delays', 'Delays', 'clock', delayEvents || null)}
  </div>`;

  if (_rdView === 'overview') return switcher + _rdOverviewHTML(acts, progress, overallPct);
  if (_rdView === 'delays') return switcher + _rdDelaysPanelHTML();

  return switcher + `
    <div class="v2-chips-row">
      <span class="v2-chip ${!hasFilters ? 'active' : ''}" onclick="_rdClearFilters()">All <span class="n">${items.length}</span></span>
      <span class="v2-chip is-muted ${f.kind === 'task' ? 'active' : ''}" onclick="_rdSetFilter('kind', _rdFilter.kind==='task' ? '' : 'task')">${icon('check')} Tasks <span class="n">${kindCount('task')}</span></span>
      <span class="v2-chip is-info ${f.kind === 'activity' ? 'active' : ''}" onclick="_rdSetFilter('kind', _rdFilter.kind==='activity' ? '' : 'activity')">${icon('target')} Readiness <span class="n">${kindCount('activity')}</span></span>
      ${myName ? `<span class="v2-chip is-info ${f.mine ? 'active' : ''}" onclick="_rdFilter.mine=!_rdFilter.mine;renderReadiness()">${icon('user')} Mine <span class="n">${myCount}</span></span>` : ''}
      ${readyCount ? `<span class="v2-chip is-good ${f.ready ? 'active' : ''}" onclick="_rdFilter.ready=!_rdFilter.ready;renderReadiness()">${icon('check-circle')} Ready <span class="n">${readyCount}</span></span>` : ''}
      ${statuses.map(s => {
        const count = items.filter(t => match(t, 'status')).filter(t => (t.status || 'Not Started') === s).length;
        if (!count && f.status !== s) return '';
        const tone = (typeof _taskStatusTone === 'function') ? _taskStatusTone(s) : 'is-muted';
        return `<span class="v2-chip ${tone} ${f.status === s ? 'active' : ''}" onclick="_rdSetFilter('status', _rdFilter.status==='${escapeHtml(s)}' ? '' : '${escapeHtml(s)}')"><span class="dot"></span>${escapeHtml(s)} <span class="n">${count}</span></span>`;
      }).join('')}
      ${overdueCount ? `<span class="v2-chip is-bad ${f.overdue ? 'active' : ''}" onclick="_rdFilter.overdue=!_rdFilter.overdue;renderReadiness()">${icon('alert')} Overdue <span class="n">${overdueCount}</span></span>` : ''}
      <span class="right">
        <button class="v2-btn-ghost" onclick="_taskCSVExport()">${icon('download')} Export CSV</button>
        ${_rdCan('view') ? `<button class="v2-btn-ghost" onclick="_rdTemplatesModal()">${icon('sliders')} Templates</button>` : ''}
        ${_rdCan('create') ? `<button class="v2-btn-ghost" onclick="openTaskModal(null)">＋ New Task</button>
        <button class="v2-btn-primary" onclick="_rdIssueModal(null)">＋ New Activity</button>` : ''}
      </span>
    </div>

    <div class="v2-filter-row">
      <div class="v2-search-wrap">
        <span class="icon">${icon('search')}</span>
        <input id="cp-search-input" type="text" value="${escapeHtml(f.search)}" placeholder="Search item, checklist line, owner, comments…" oninput="_rdFilter.search=this.value; renderReadiness()">
      </div>
      <select onchange="_rdSetFilter('priority', this.value)" aria-label="Filter by priority">
        <option value="">All Priorities</option>
        ${prioOpts.map(o => `<option value="${escapeHtml(o)}" ${f.priority === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
      <select onchange="_rdSetFilter('type', this.value)" aria-label="Filter by task type">
        <option value="">All Types</option>
        ${typeOpts.map(o => `<option value="${escapeHtml(o)}" ${f.type === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
      <select onchange="_rdSetFilter('location', this.value)" aria-label="Filter by location">
        <option value="">All Locations</option>
        ${locOpts.map(o => `<option value="${escapeHtml(o)}" ${f.location === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
      <select onchange="_rdSetFilter('subsystem', this.value)" aria-label="Filter by subsystem">
        <option value="">All Subsystems</option>
        ${subOpts.map(o => `<option value="${escapeHtml(o)}" ${f.subsystem === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
      <select onchange="_rdSetFilter('phase', this.value)" aria-label="Filter by phase">
        <option value="">All Phases</option>
        ${phaseOpts.map(o => `<option value="${escapeHtml(o)}" ${f.phase === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
      ${hasFilters ? `<button class="v2-btn-mini" onclick="_rdClearFilters()">${icon('x')} Reset</button>` : ''}
      <span class="count"><b>${filtered.length}</b> of ${items.length}</span>
    </div>

    ${ft || (!hasFilters && _cpItemTotal(acts, progress)) ? `<div style="display:flex;align-items:center;gap:12px;margin:6px 2px 14px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-subtle);white-space:nowrap;">${hasFilters ? 'Filtered' : 'Project'} readiness</span>
      <div style="flex:1;height:10px;background:var(--gray-100);border-radius:5px;overflow:hidden;"><div style="width:${hasFilters ? fPct : overallPct}%;height:100%;background:var(--good);"></div></div>
      <span style="font-size:13px;font-weight:700;">${hasFilters ? fPct : overallPct}%</span>
    </div>` : ''}

    <div class="v2-list">
      ${filtered.length ? filtered.map(t => _cpRowHTML(t, progress.get(t.id))).join('') : `
        <div style="padding:48px;text-align:center;color:var(--gray-500);">
          <div style="font-size:32px;margin-bottom:8px;">${icon('clipboard')}</div>
          <div style="font-size:14px;">${items.length ? 'Nothing matches your filters' : 'Nothing here yet — add a task, or create a template and issue your first readiness activity'}</div>
        </div>`}
    </div>`;
}
// Total checklist items across the activities — guards the project-readiness
// bar when the portfolio is pure tasks with no checklists.
function _cpItemTotal(acts, progress) {
  let n = 0;
  for (const t of acts) { const p = progress.get(t.id); if (p) n += p.total; }
  return n;
}

// Unified row — one layout for both kinds. Tasks lead with priority/effort,
// readiness activities with dimensions + progress; both carry the type pill.
function _cpRowHTML(t, p) {
  const isAct = _rdKind(t) === 'activity';
  const status = t.status || 'Not Started';
  const stTone = (typeof _taskStatusTone === 'function') ? _taskStatusTone(status) : 'is-muted';
  const overdue = _rdTaskOverdueLines(t.id).length;
  const lines = _rdChkFor(t.id);
  const delayed = lines.filter(l => _rdDelaysFor(l.id).length).length;
  const linkedIn = TASK_CHK.filter(c => c.linked_task_id === t.id).length;
  const isReady = p.total > 0 && p.pct === 100;
  const isDone = status === 'Done';
  const isOverdueTask = t.due_date && new Date(t.due_date) < new Date() && !isDone;
  const canEdit = _rdCan('edit');
  const comments = (typeof _taskComments === 'function') ? _taskComments(t) : [];
  const last = comments.length ? comments[comments.length - 1] : null;
  return `
    <div class="v2-list-row tone-${stTone.replace('is-', '')} ${overdue || isOverdueTask ? 'is-overdue' : ''}" onclick="_taskViewModal('${t.id}')">
      <div class="rma-row">
        <div class="rma-id-block">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
            ${_rdKindPill(t)}
            ${!isAct && t.priority ? `<span class="v2-pill ${typeof _taskPriorityTone === 'function' ? _taskPriorityTone(t.priority) : 'is-muted'}">${escapeHtml(t.priority)}</span>` : ''}
            <h3 class="rma-material" style="margin:0;" title="${escapeHtml(t.task_name || '')}">${escapeHtml(t.task_name || '—')}</h3>
          </div>
          ${t.description ? `<div class="v2-meta-line" style="margin-top:2px;">${escapeHtml(_truncateRd(t.description, 110))}</div>` : ''}
          <div class="v2-meta-line" style="margin-top:3px;display:flex;gap:6px;flex-wrap:wrap;">
            ${t.location ? `<span class="v2-pill is-muted">${icon('pin')} ${escapeHtml(t.location)}</span>` : ''}
            ${t.subsystem ? `<span class="v2-pill is-muted">${icon('layers')} ${escapeHtml(t.subsystem)}</span>` : ''}
            ${t.phase ? `<span class="v2-pill is-muted">${icon('flag')} ${escapeHtml(t.phase)}</span>` : ''}
            ${linkedIn ? `<span class="v2-pill is-info" title="Rolls up into ${linkedIn} other checklist${linkedIn !== 1 ? 's' : ''}">${icon('link')} ×${linkedIn}</span>` : ''}
            ${last ? `<span style="font-size:11px;color:var(--text-subtle);" title="${escapeHtml(last.text || '(photo)')}">${icon('inbox')} ${comments.length} · ${escapeHtml(_truncateRd(last.text || '(photo)', 40))}</span>` : ''}
          </div>
        </div>
        <div class="rma-parts">
          <span class="k">Owner</span><span class="v">${escapeHtml(t.assignee || '—')}</span>
          <span class="k">${isAct ? 'Target' : 'Due'}</span><span class="v ${isOverdueTask ? 'is-bad' : ''}">${t.due_date ? _fmtDate(t.due_date) : '—'}</span>
          <span class="k">${lines.length ? 'Items' : 'Effort'}</span><span class="v">${lines.length
            ? `${Math.round(p.done * 10) / 10}/${p.total}${overdue ? ` <span style="color:var(--bad);font-weight:600;">· ${overdue} overdue</span>` : ''}${delayed ? ` <span style="color:var(--warn);font-weight:600;">· ${delayed} delayed</span>` : ''}`
            : (t.effort ? `<span class="v2-pill ${typeof _taskEffortTone === 'function' ? _taskEffortTone(t.effort) : 'is-muted'}">${escapeHtml(t.effort)}</span>` : '—')}</span>
        </div>
        <div class="rma-status-block">
          ${isReady && !isDone ? `<span class="v2-pill is-good">${icon('check-circle')} Ready</span>` : `<span class="v2-pill ${stTone}">${escapeHtml(status)}</span>`}
          ${lines.length ? `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;min-width:150px;">
            <div style="flex:1;height:7px;background:var(--gray-100);border-radius:4px;overflow:hidden;"><div style="width:${p.pct}%;height:100%;background:${p.fails ? 'var(--bad)' : 'var(--good)'};"></div></div>
            <span style="font-size:12px;font-weight:700;color:var(--text-subtle);">${p.pct}%</span>
          </div>` : ''}
        </div>
        <div class="rma-actions" onclick="event.stopPropagation()">
          <button class="v2-btn-mini" onclick="_taskViewModal('${t.id}')">${icon('eye')} Open</button>
          ${canEdit ? `<div style="display:flex;gap:4px;">
            <button class="v2-btn-mini" onclick="openTaskModal('${t.id}')">${icon('edit')} Edit</button>
            ${_rdCan('delete') ? `<button aria-label="Delete" class="v2-btn-mini danger" onclick="deleteTask('${t.id}')" title="Delete">${icon('trash')}</button>` : ''}
          </div>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Overview: subsystem × phase/location matrix + grouped rollup bars ──────
function _rdOverviewHTML(acts, progress, overallPct) {
  if (!acts.length) {
    return `<div style="padding:48px;text-align:center;color:var(--gray-500);">
      <div style="font-size:32px;margin-bottom:8px;">${icon('layers')}</div>
      <div style="font-size:14px;">No activities yet — the readiness matrix appears once you issue activities with a subsystem / phase.</div>
    </div>`;
  }
  const colDim = _rdMatrixDim;
  const m = _rdMatrixData(acts, colDim, progress);
  const cell = (r, c) => m.cells.get(r + '||' + c);

  const th = `<th style="text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-subtle);padding:6px 8px;position:sticky;left:0;background:var(--surface);z-index:1;">Subsystem</th>`
    + m.cols.map(c => `<th style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-subtle);padding:6px 8px;min-width:78px;">${escapeHtml(c)}</th>`).join('');
  const body = m.rows.map(r => {
    const tds = m.cols.map(c => {
      const cl = cell(r, c);
      if (!cl || !cl.count) return `<td style="padding:3px;"><div style="height:44px;border-radius:6px;background:var(--surface-2);opacity:.4;display:flex;align-items:center;justify-content:center;color:var(--text-subtle);font-size:12px;">·</div></td>`;
      const pct = cl.total ? Math.round(cl.done / cl.total * 100) : 0;
      return `<td style="padding:3px;">
        <button class="rd-cell" title="${escapeHtml(r)} · ${escapeHtml(c)} — ${pct}% ready across ${cl.count} activit${cl.count === 1 ? 'y' : 'ies'}${cl.overdue ? ', ' + cl.overdue + ' overdue' : ''}" aria-label="${escapeHtml(r)} ${escapeHtml(c)} ${pct} percent ready" onclick="_rdDrillCell('${escapeHtml(r).replace(/'/g, "\\'")}','${escapeHtml(c).replace(/'/g, "\\'")}','${colDim}')" style="width:100%;height:44px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:${_rdHeatBg(pct)};color:${_rdHeatFg(pct)};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;line-height:1;">
          <span style="font-size:13px;font-weight:800;">${pct}%</span>
          <span style="font-size:9px;opacity:.85;">${cl.count} act${cl.overdue ? ' · ' + icon('alert') : ''}</span>
        </button></td>`;
    }).join('');
    return `<tr><th scope="row" style="text-align:left;font-size:12px;font-weight:600;padding:6px 8px;position:sticky;left:0;background:var(--surface);white-space:nowrap;"><button class="rd-rowlink" onclick="_rdDrill('subsystem','${escapeHtml(r).replace(/'/g, "\\'")}')" style="border:none;background:none;color:var(--text);font:inherit;font-weight:600;cursor:pointer;padding:0;">${escapeHtml(r)}</button></th>${tds}</tr>`;
  }).join('');

  const grid = (title, dim) => {
    const rows = _rdRollup(acts, dim, progress);
    return `<div style="flex:1;min-width:230px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-subtle);margin-bottom:6px;">${escapeHtml(title)}</div>
      ${rows.map(g => `<button class="rd-bar-row" onclick="_rdDrill('${dim}','${escapeHtml(g.key).replace(/'/g, "\\'")}')" style="display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;cursor:pointer;padding:4px 2px;text-align:left;font:inherit;color:var(--text);">
        <span style="flex:0 0 96px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(g.key)}</span>
        <span style="flex:1;height:8px;background:var(--gray-100);border-radius:4px;overflow:hidden;"><span style="display:block;width:${g.pct}%;height:100%;background:${g.fails ? 'var(--bad)' : 'var(--good)'};"></span></span>
        <span style="flex:0 0 34px;text-align:right;font-size:12px;font-weight:700;color:var(--text-subtle);">${g.pct}%</span>
        ${g.overdue ? `<span title="${g.overdue} overdue item${g.overdue !== 1 ? 's' : ''}" style="flex:0 0 auto;color:var(--bad);font-size:11px;font-weight:600;">${icon('alert')}${g.overdue}</span>` : '<span style="flex:0 0 auto;width:16px;"></span>'}
      </button>`).join('')}
    </div>`;
  };

  return `
    <div style="display:flex;align-items:center;gap:12px;margin:4px 2px 16px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-subtle);white-space:nowrap;">Project readiness</span>
      <div style="flex:1;height:10px;background:var(--gray-100);border-radius:5px;overflow:hidden;"><div style="width:${overallPct}%;height:100%;background:var(--good);"></div></div>
      <span style="font-size:13px;font-weight:700;">${overallPct}%</span>
    </div>

    <div class="cx-card" style="padding:14px 16px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
        <div style="font-size:13px;font-weight:700;">Readiness matrix <span style="font-weight:400;color:var(--text-subtle);">— subsystem × ${colDim}</span></div>
        <div class="rd-segmented rd-segmented-sm" role="group" aria-label="Matrix columns">
          <button class="rd-seg${colDim === 'phase' ? ' active' : ''}" aria-pressed="${colDim === 'phase'}" onclick="_rdSetMatrixDim('phase')">Phase</button>
          <button class="rd-seg${colDim === 'location' ? ' active' : ''}" aria-pressed="${colDim === 'location'}" onclick="_rdSetMatrixDim('location')">Location</button>
        </div>
      </div>
      <div style="overflow-x:auto;"><table style="border-collapse:separate;border-spacing:0;width:100%;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:8px;">Each cell is item-weighted readiness for that subsystem/${colDim}. Click a cell, a row, or a bar to drill into the activities.</div>
    </div>

    <div class="cx-card" style="padding:14px 16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Rollup by dimension</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;">
        ${grid('By subsystem', 'subsystem')}
        ${grid('By phase', 'phase')}
        ${grid('By location', 'location')}
      </div>
    </div>`;
}

// ── Delays: analytics over every recorded due-date push ───────────────────
function _rdDelaysPanelHTML() {
  const s = _rdDelayStats();
  if (!s.totalEvents) {
    return `<div style="padding:48px;text-align:center;color:var(--gray-500);">
      <div style="font-size:32px;margin-bottom:8px;">${icon('clock')}</div>
      <div style="font-size:14px;">No delays recorded yet. When a checklist item's due date is pushed later, the reason is logged and analysed here.</div>
    </div>`;
  }
  const maxDays = arr => arr.reduce((m, g) => Math.max(m, g.days), 0) || 1;
  const barList = (rows, opts) => {
    opts = opts || {};
    const mx = maxDays(rows);
    const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
    return shown.map(g => {
      const label = opts.activity ? (g.name || 'Unknown activity') : g.key;
      const click = opts.dim ? ` onclick="_rdDrill('${opts.dim}','${escapeHtml(String(g.key)).replace(/'/g, "\\'")}')" style="cursor:pointer;"` : '';
      const open = opts.activity ? ` onclick="_taskViewModal('${g.key}')" style="cursor:pointer;"` : '';
      return `<div class="rd-bar-row"${click || open} style="display:flex;align-items:center;gap:10px;padding:5px 2px;${(click || open) ? 'cursor:pointer;' : ''}">
        <span style="flex:0 0 150px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}</span>
        <span style="flex:1;height:9px;background:var(--gray-100);border-radius:5px;overflow:hidden;"><span style="display:block;width:${Math.round(g.days / mx * 100)}%;height:100%;background:var(--warn);"></span></span>
        <span style="flex:0 0 96px;text-align:right;font-size:12px;font-weight:700;color:var(--text-subtle);">+${g.days}d <span style="font-weight:400;">· ${g.count}×</span></span>
      </div>`;
    }).join('');
  };

  const card = (title, hint, inner) => `<div class="cx-card" style="padding:14px 16px;margin-bottom:16px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:2px;">${escapeHtml(title)}</div>
    ${hint ? `<div style="font-size:11px;color:var(--text-subtle);margin-bottom:10px;">${escapeHtml(hint)}</div>` : ''}
    ${inner}</div>`;

  return `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin:4px 2px 16px;">
      ${[['Total slip', s.totalDays + ' days', 'warn'], ['Delay events', s.totalEvents, 'muted'], ['Avg per event', s.avg + ' days', 'muted'], ['Reasons', s.byReason.length, 'muted']]
        .map(([l, v, tone]) => `<div class="cx-card" style="flex:1;min-width:130px;padding:12px 14px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-subtle);">${l}</div>
          <div style="font-size:22px;font-weight:800;color:${tone === 'warn' ? 'var(--warn)' : 'var(--text)'};margin-top:2px;">${v}</div>
        </div>`).join('')}
    </div>
    ${card('Slip by reason', 'Where the schedule is actually going — total days pushed, grouped by the reason given.', barList(s.byReason))}
    ${card('Worst-slipping activities', 'The activities carrying the most accumulated delay. Click to open.', barList(s.byActivity, { activity: true, limit: 8 }))}
    ${card('Slip by responsible party', 'Whose items are slipping — the responsible party on each delayed item.', barList(s.byResponsible, { limit: 10 }))}`;
}
