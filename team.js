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
      ? `<button class="form-secondary" onclick="_teamAdd()">${icon('plus')} Add top-level member</button>`
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

async function _teamAdd() {
  if (!_teamCanEdit()) return;
  const name = prompt('Member name:');
  if (!name || !name.trim()) return;
  const title = (prompt('Title / role:', '') || '').trim();
  const levelStr = prompt('Org level (0 = top of chart, higher = lower in hierarchy):', '0');
  const level = parseInt(levelStr, 10);
  if (Number.isNaN(level) || level < 0) { toast('Level must be a non-negative number.', 'error'); return; }
  const sort_order = _teamNextSort(null);
  const { data, error } = await _sb.from('team_members')
    .insert({ name: name.trim(), title, level, sort_order, reports_to: null }).select().single();
  if (error) { toast('Add failed: ' + error.message, 'error'); return; }
  TEAM.push(data); toast('Member added'); renderOrg();
}

// Add a direct report that hangs as a branch under the given manager/position.
async function _teamAddReport(managerId) {
  if (!_teamCanEdit()) return;
  const mgr = TEAM.find(t => t.id === managerId); if (!mgr) return;
  const name = prompt(`Add a direct report under ${mgr.name}${mgr.title ? ` (${mgr.title})` : ''}:\n\nReport name:`);
  if (!name || !name.trim()) return;
  const title = (prompt('Title / role:', '') || '').trim();
  const level = (Number(mgr.level) || 0) + 1;
  const sort_order = _teamNextSort(managerId);
  const { data, error } = await _sb.from('team_members')
    .insert({ name: name.trim(), title, level, sort_order, reports_to: managerId }).select().single();
  if (error) { toast('Add failed: ' + error.message, 'error'); return; }
  TEAM.push(data); toast('Direct report added'); renderOrg();
}

async function _teamEdit(id) {
  if (!_teamCanEdit()) return;
  const m = TEAM.find(t => t.id === id); if (!m) return;
  const name = prompt('Name:', m.name); if (name === null) return;
  if (!name.trim()) { toast('Name cannot be empty.', 'error'); return; }
  const title = prompt('Title / role:', m.title || ''); if (title === null) return;
  const { error } = await _sb.from('team_members').update({ name: name.trim(), title: title.trim() }).eq('id', id);
  if (error) { toast('Update failed: ' + error.message, 'error'); return; }
  m.name = name.trim(); m.title = title.trim(); toast('Updated'); renderOrg();
}

async function _teamRemove(id) {
  if (!_teamCanEdit()) return;
  const m = TEAM.find(t => t.id === id); if (!m) return;
  const reports = TEAM.filter(t => t.reports_to === id);
  if (reports.length) {
    toast(`${m.name} has ${reports.length} direct report${reports.length > 1 ? 's' : ''}. Reassign or remove them first.`, 'error');
    return;
  }
  if (!confirm(`Remove ${m.name} from the team roster?`)) return;
  const { error } = await _sb.from('team_members').delete().eq('id', id);
  if (error) { toast('Remove failed: ' + error.message, 'error'); return; }
  TEAM = TEAM.filter(t => t.id !== id); toast('Member removed'); renderOrg();
}

window.loadTeamMembers = loadTeamMembers;
window.initOrg = initOrg;
window.renderOrg = renderOrg;
window.orgCard = orgCard;
window._teamToggleEdit = _teamToggleEdit;
window._teamAdd = _teamAdd;
window._teamAddReport = _teamAddReport;
window._teamEdit = _teamEdit;
window._teamRemove = _teamRemove;
window._teamInitials = _teamInitials;
window._teamRows = _teamRows;
window._buildTeamTree = _buildTeamTree;
