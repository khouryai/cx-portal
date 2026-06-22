/* ==========================================================================
   HITACHI Rail T&C Portal — Team / Org chart (real, editable)

   The org chart moved from data.js demo into the Supabase `team_members` table
   (owner-directed). Any authenticated user can VIEW; add/edit/remove requires
   directory-edit permission (uiCan('directory','edit') — RLS enforces server-
   side). Loaded after app.js as a classic <script>; uses _sb, escapeHtml, icon,
   cxEmpty, toast, uiCan, currentRoleUser as runtime globals.

   Hierarchy: each row carries a self-referencing `reports_to` (manager id). The
   chart renders as a real tree so a manager's direct reports hang as a branch
   beneath them (e.g. the ATS team under "Lead ATS T&C Engineer"). `level` is
   kept for sibling ordering / back-compat. Edit affordances (add report, edit,
   remove) only appear once the viewer turns on Edit mode — the view is clean by
   default.
   ========================================================================== */
"use strict";

let TEAM = [];            // team_members rows
let _teamEditMode = false; // edit affordances are hidden until toggled on

async function loadTeamMembers() {
  try {
    const { data, error } = await _sb.from('team_members')
      .select('*').order('level', { ascending: true }).order('sort_order', { ascending: true });
    if (error) throw error;
    TEAM = data || [];
  } catch (e) {
    console.warn('[team] load failed:', e.message || e);
    TEAM = [];
  }
}

// Pure: initials from a member name (handles "A / B" multi-person cells + TBD).
function _teamInitials(name) {
  if (!name || name === 'TBD') return '?';
  return name.split(/[\s/]+/).filter(s => s.length > 0).slice(0, 2).map(n => n[0]).join('').toUpperCase();
}

// Pure: group members into ordered level rows. (Retained for back-compat / tests.)
function _teamRows(members) {
  const byLevel = {};
  (members || []).forEach(p => { (byLevel[p.level] = byLevel[p.level] || []).push(p); });
  return Object.keys(byLevel).sort((a, b) => Number(a) - Number(b)).map(l => byLevel[l]);
}

// Pure: build a reports_to tree. Roots are members with no (resolvable) manager.
// Children are sorted by sort_order then level then name for a stable layout.
function _buildTeamTree(members) {
  const map = {};
  (members || []).forEach(p => { map[p.id] = { ...p, children: [] }; });
  const roots = [];
  (members || []).forEach(p => {
    const parent = p.reports_to && map[p.reports_to];
    if (parent) parent.children.push(map[p.id]);
    else roots.push(map[p.id]);
  });
  const sortKids = node => {
    node.children.sort((a, b) =>
      (a.sort_order - b.sort_order) || (a.level - b.level) || a.name.localeCompare(b.name));
    node.children.forEach(sortKids);
  };
  roots.sort((a, b) => (a.sort_order - b.sort_order) || (a.level - b.level) || a.name.localeCompare(b.name));
  roots.forEach(sortKids);
  return roots;
}

function _teamCanEdit() {
  return typeof uiCan === 'function' ? uiCan('directory', 'edit') : (currentRoleUser?.role === 'admin');
}

function initOrg() { renderOrg(); }

function renderOrg() {
  const tree = document.getElementById('org-tree');
  if (!tree) return;
  const canEdit = _teamCanEdit();
  const editing = canEdit && _teamEditMode;
  tree.classList.toggle('org-editing', editing);

  let toolbar = '';
  if (canEdit) {
    const toggle = `<button class="admin-action-btn ${editing ? 'is-on' : ''}" onclick="_teamToggleEdit()">`
      + `${icon(editing ? 'check' : 'edit')} ${editing ? 'Done editing' : 'Edit organization'}</button>`;
    const add = editing
      ? `<button class="form-secondary" onclick="_teamAdd()">${icon('plus')} Add member</button>`
      : '';
    toolbar = `<div class="team-toolbar">${add}${toggle}</div>`;
  }

  if (!TEAM.length) {
    tree.innerHTML = toolbar + cxEmpty({
      icon: 'users', title: 'No team members',
      message: editing ? 'Add the first member with the button above.' : 'The team roster is empty.',
    });
    return;
  }

  const roots = _buildTeamTree(TEAM);
  const list = `<ul class="org-tree-list org-root">${roots.map(n => _renderTeamNode(n, editing)).join('')}</ul>`;
  tree.innerHTML = toolbar + `<div class="org-chart-scroll">${list}</div>`;
  // Scale the whole chart down so it always fits the window — never scroll sideways.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_teamFitToWidth);
  else _teamFitToWidth();
}

// Pure: scale factor that makes a `natural`-wide chart fit `avail` px — never
// enlarges (caps at 1) and never shrinks past `min` (readability floor), so the
// chart stays legible; guards against zero/undefined measurements.
function _teamFitScale(natural, avail, min) {
  if (!natural || !avail) return 1;
  return Math.max(min || 0, Math.min(1, avail / natural));
}

// Below this the text gets hard to read — stop shrinking and let the (rare)
// extra-wide chart scroll sideways instead of becoming illegible.
const _TEAM_MIN_SCALE = 0.8;

// Shrink the chart to fit its container width so the org never scrolls left/right.
// (Transform-only: layout is untouched; we just collapse the leftover height.)
function _teamFitToWidth() {
  const scroll = document.querySelector('#org-tree .org-chart-scroll');
  const list = scroll && scroll.querySelector('.org-root');
  if (!scroll || !list) return;
  // Reset, then measure the chart's natural (unscaled) width.
  list.style.transformOrigin = 'top center';
  list.style.transform = 'none';
  const prevWidth = list.style.width;
  list.style.width = 'max-content';
  const natural = list.offsetWidth;
  list.style.width = prevWidth;
  const avail = scroll.clientWidth;
  if (!avail || !natural) return;            // page hidden / not laid out yet
  const scale = _teamFitScale(natural, avail, _TEAM_MIN_SCALE);
  list.style.transform = scale < 1 ? `scale(${scale})` : 'none';
  // If the readability floor still overflows, allow a horizontal scroll rather
  // than clip; otherwise keep it pinned with no sideways scrolling.
  scroll.style.overflowX = (natural * scale > avail + 1) ? 'auto' : 'hidden';
  // A scaled element keeps its original layout box, leaving dead space below —
  // pin the container to the scaled height so the page flows naturally.
  scroll.style.height = Math.ceil(list.getBoundingClientRect().height) + 'px';
}

// Re-fit on viewport resize (rAF-debounced), bound once.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !window.__teamFitBound) {
  window.__teamFitBound = true;
  let _fitQueued = false;
  window.addEventListener('resize', () => {
    if (_fitQueued) return;
    _fitQueued = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn => setTimeout(fn, 16));
    raf(() => { _fitQueued = false; _teamFitToWidth(); });
  });
}

// Render one subtree as an <li> card with a nested <ul> branch of direct reports.
function _renderTeamNode(node, editing) {
  const isLead = !node.reports_to;
  const branch = node.children.length
    ? `<ul class="org-tree-list">${node.children.map(c => _renderTeamNode(c, editing)).join('')}</ul>`
    : '';
  return `<li>${orgCard(node, isLead, editing)}${branch}</li>`;
}

function orgCard(p, isLead, editing) {
  const actions = editing ? `
      <div class="org-card-actions">
        <button class="org-act-report" aria-label="Add direct report under ${escapeHtml(p.name)}" onclick="_teamAddReport('${p.id}')">${icon('plus')} Report</button>
        <button class="org-act-edit" aria-label="Edit ${escapeHtml(p.name)}" onclick="_teamEdit('${p.id}')">${icon('edit')}</button>
        <button class="org-act-remove" aria-label="Remove ${escapeHtml(p.name)}" onclick="_teamRemove('${p.id}')">${icon('trash')}</button>
      </div>` : '';
  return `
    <div class="org-card ${isLead ? 'org-lead' : ''}">
      <div class="org-card-head">
        <div class="org-avatar">${escapeHtml(_teamInitials(p.name))}</div>
        <div class="org-info">
          <div class="org-title">${escapeHtml(p.title || '')}</div>
          <div class="org-name">${escapeHtml(p.name)}</div>
        </div>
      </div>
      ${actions}
    </div>`;
}

function _teamToggleEdit() {
  if (!_teamCanEdit()) { _teamEditMode = false; return; }
  _teamEditMode = !_teamEditMode;
  renderOrg();
}

// Next sort_order among a given set of siblings (those sharing a manager).
function _teamNextSort(reportsTo) {
  const peers = TEAM.filter(t => (t.reports_to || null) === (reportsTo || null)).map(t => t.sort_order || 0);
  return peers.length ? Math.max(...peers) + 1 : 0;
}

// Pure: id + every id beneath it in the reports_to tree (cycle-guard for re-parenting).
function _teamDescendantIds(id, members) {
  const list = members || TEAM || [];
  const ids = new Set([id]);
  let added = true;
  while (added) {
    added = false;
    list.forEach(t => {
      if (t.reports_to && ids.has(t.reports_to) && !ids.has(t.id)) { ids.add(t.id); added = true; }
    });
  }
  return ids;
}

// "Reports to" <option> list, ordered top-down, skipping any excluded ids.
function _teamManagerOptions(selectedId, excludeIds) {
  const skip = excludeIds || new Set();
  const opts = [`<option value=""${selectedId ? '' : ' selected'}>— None (top of chart) —</option>`];
  (TEAM || []).filter(t => !skip.has(t.id))
    .slice()
    .sort((a, b) => (a.level - b.level) || (a.sort_order - b.sort_order) || a.name.localeCompare(b.name))
    .forEach(t => {
      const label = (t.title ? t.title + ' — ' : '') + t.name;
      opts.push(`<option value="${t.id}"${t.id === selectedId ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    });
  return opts.join('');
}

// Shared modal body: name, title, and a "Reports to" control (locked or a picker).
function _teamFormBody({ name, title, mgrId, excludeIds, mgrLocked, mgrLabel }) {
  const mgrControl = mgrLocked
    ? `<input type="text" class="form-input" value="${escapeHtml(mgrLabel || '')}" disabled>`
    : `<select id="team-mgr" class="form-input">${_teamManagerOptions(mgrId || '', excludeIds)}</select>`;
  return `
      <div class="form-field">
        <label>Name</label>
        <input type="text" id="team-name" class="form-input" value="${escapeHtml(name || '')}" placeholder="e.g. Jane Smith">
      </div>
      <div class="form-field" style="margin-top:12px;">
        <label>Title / role</label>
        <input type="text" id="team-title" class="form-input" value="${escapeHtml(title || '')}" placeholder="e.g. ATS T&C Engineer">
      </div>
      <div class="form-field" style="margin-top:12px;">
        <label>Reports to</label>
        ${mgrControl}
      </div>`;
}

function _teamAdd() {
  if (!_teamCanEdit()) return;
  modal({
    title: 'Add team member', size: 'small',
    body: _teamFormBody({ mgrId: '', excludeIds: new Set() }),
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button>
             <button class="form-submit" onclick="_teamSaveNew()">Add member</button>`,
  });
  setTimeout(() => document.getElementById('team-name')?.focus(), 50);
}

// Add a direct report that hangs as a branch under the given manager/position.
function _teamAddReport(managerId) {
  if (!_teamCanEdit()) return;
  const mgr = TEAM.find(t => t.id === managerId); if (!mgr) return;
  const mgrLabel = (mgr.title ? mgr.title + ' — ' : '') + mgr.name;
  modal({
    title: 'Add direct report', sub: `Reporting to ${escapeHtml(mgrLabel)}`, size: 'small',
    body: _teamFormBody({ mgrId: managerId, mgrLocked: true, mgrLabel }),
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button>
             <button class="form-submit" onclick="_teamSaveNew('${managerId}')">Add report</button>`,
  });
  setTimeout(() => document.getElementById('team-name')?.focus(), 50);
}

// Insert a member. managerId (from "Add report") overrides the picker when present.
async function _teamSaveNew(managerId) {
  if (!_teamCanEdit()) return;
  const name = (document.getElementById('team-name')?.value || '').trim();
  if (!name) { toast('Name is required.', 'error'); return; }
  const title = (document.getElementById('team-title')?.value || '').trim();
  const reports_to = managerId || (document.getElementById('team-mgr')?.value || '') || null;
  const mgr = reports_to ? TEAM.find(t => t.id === reports_to) : null;
  const level = mgr ? (Number(mgr.level) || 0) + 1 : 0;
  const sort_order = _teamNextSort(reports_to);
  const { data, error } = await _sb.from('team_members')
    .insert({ name, title, level, sort_order, reports_to }).select().single();
  if (error) { toast('Add failed: ' + error.message, 'error'); return; }
  TEAM.push(data); closeModal(); toast(reports_to ? 'Direct report added' : 'Member added'); renderOrg();
}

function _teamEdit(id) {
  if (!_teamCanEdit()) return;
  const m = TEAM.find(t => t.id === id); if (!m) return;
  modal({
    title: 'Edit team member', size: 'small',
    body: _teamFormBody({ name: m.name, title: m.title, mgrId: m.reports_to || '', excludeIds: _teamDescendantIds(id) }),
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button>
             <button class="form-submit" onclick="_teamSaveEdit('${id}')">Save</button>`,
  });
  setTimeout(() => document.getElementById('team-name')?.focus(), 50);
}

async function _teamSaveEdit(id) {
  if (!_teamCanEdit()) return;
  const m = TEAM.find(t => t.id === id); if (!m) return;
  const name = (document.getElementById('team-name')?.value || '').trim();
  if (!name) { toast('Name is required.', 'error'); return; }
  const title = (document.getElementById('team-title')?.value || '').trim();
  const reports_to = (document.getElementById('team-mgr')?.value || '') || null;
  const mgr = reports_to ? TEAM.find(t => t.id === reports_to) : null;
  const patch = { name, title, reports_to, level: mgr ? (Number(mgr.level) || 0) + 1 : 0 };
  // Moved to a new manager → drop to the end of the new sibling group.
  if ((m.reports_to || null) !== reports_to) patch.sort_order = _teamNextSort(reports_to);
  const { error } = await _sb.from('team_members').update(patch).eq('id', id);
  if (error) { toast('Update failed: ' + error.message, 'error'); return; }
  Object.assign(m, patch); closeModal(); toast('Updated'); renderOrg();
}

function _teamRemove(id) {
  if (!_teamCanEdit()) return;
  const m = TEAM.find(t => t.id === id); if (!m) return;
  const reports = TEAM.filter(t => t.reports_to === id);
  if (reports.length) {
    toast(`${m.name} has ${reports.length} direct report${reports.length > 1 ? 's' : ''}. Reassign or remove them first.`, 'error');
    return;
  }
  modal({
    title: 'Remove team member', size: 'small',
    body: `<p style="margin:0;color:var(--text);line-height:1.5;">Remove <strong>${escapeHtml(m.name)}</strong>${m.title ? ` <span style="color:var(--text-muted);">(${escapeHtml(m.title)})</span>` : ''} from the org chart? This cannot be undone.</p>`,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button>
             <button class="form-submit" style="background:var(--bad);border-color:var(--bad);" onclick="_teamDoRemove('${id}')">Remove</button>`,
  });
}

async function _teamDoRemove(id) {
  if (!_teamCanEdit()) return;
  const m = TEAM.find(t => t.id === id); if (!m) return;
  const { error } = await _sb.from('team_members').delete().eq('id', id);
  if (error) { toast('Remove failed: ' + error.message, 'error'); return; }
  TEAM = TEAM.filter(t => t.id !== id); closeModal(); toast('Member removed'); renderOrg();
}

window.loadTeamMembers = loadTeamMembers;
window.initOrg = initOrg;
window.renderOrg = renderOrg;
window.orgCard = orgCard;
window._teamToggleEdit = _teamToggleEdit;
window._teamAdd = _teamAdd;
window._teamAddReport = _teamAddReport;
window._teamSaveNew = _teamSaveNew;
window._teamEdit = _teamEdit;
window._teamSaveEdit = _teamSaveEdit;
window._teamRemove = _teamRemove;
window._teamDoRemove = _teamDoRemove;
window._teamInitials = _teamInitials;
window._teamRows = _teamRows;
window._buildTeamTree = _buildTeamTree;
window._teamDescendantIds = _teamDescendantIds;
window._teamManagerOptions = _teamManagerOptions;
window._teamFitToWidth = _teamFitToWidth;
window._teamFitScale = _teamFitScale;
