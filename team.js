/* ==========================================================================
   HITACHI Rail T&C Portal — Team / Org chart (real, editable)

   The org chart moved from data.js demo into the Supabase `team_members` table
   (owner-directed). Any authenticated user can VIEW; add/edit/remove requires
   directory-edit permission (uiCan('directory','edit') — RLS enforces server-
   side). Loaded after app.js as a classic <script>; uses _sb, escapeHtml, icon,
   cxEmpty, toast, uiCan, currentRoleUser as runtime globals.
   ========================================================================== */
"use strict";

let TEAM = [];   // team_members rows

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

// Pure: group members into ordered level rows.
function _teamRows(members) {
  const byLevel = {};
  (members || []).forEach(p => { (byLevel[p.level] = byLevel[p.level] || []).push(p); });
  return Object.keys(byLevel).sort((a, b) => Number(a) - Number(b)).map(l => byLevel[l]);
}

function _teamCanEdit() {
  return typeof uiCan === 'function' ? uiCan('directory', 'edit') : (currentRoleUser?.role === 'admin');
}

function initOrg() { renderOrg(); }

function renderOrg() {
  const tree = document.getElementById('org-tree');
  if (!tree) return;
  const canEdit = _teamCanEdit();

  const toolbar = canEdit
    ? `<div class="team-toolbar" style="display:flex;justify-content:flex-end;margin-bottom:14px;">
         <button class="admin-action-btn" onclick="_teamAdd()">${icon('plus')} Add member</button>
       </div>`
    : '';

  if (!TEAM.length) {
    tree.innerHTML = toolbar + cxEmpty({
      icon: 'users', title: 'No team members',
      message: canEdit ? 'Add the first member with the button above.' : 'The team roster is empty.',
    });
    return;
  }

  const rows = _teamRows(TEAM)
    .map(row => `<div class="org-row">${row.map(p => orgCard(p, p.level === 0, canEdit)).join('')}</div>`)
    .join('');
  tree.innerHTML = toolbar + rows;
}

function orgCard(p, isLead, canEdit) {
  const actions = canEdit ? `
      <div class="org-card-actions" style="display:flex;gap:4px;margin-top:8px;justify-content:center;">
        <button class="form-secondary" style="font-size:11px;padding:3px 8px;" aria-label="Edit ${escapeHtml(p.name)}" onclick="_teamEdit('${p.id}')">${icon('edit')}</button>
        <button class="form-secondary" style="font-size:11px;padding:3px 8px;color:var(--bad);" aria-label="Remove ${escapeHtml(p.name)}" onclick="_teamRemove('${p.id}')">${icon('trash')}</button>
      </div>` : '';
  return `
    <div class="org-card ${isLead ? 'org-lead' : ''}">
      <div class="org-avatar">${escapeHtml(_teamInitials(p.name))}</div>
      <div class="org-info">
        <div class="org-title">${escapeHtml(p.title || '')}</div>
        <div class="org-name">${escapeHtml(p.name)}</div>
      </div>
      ${actions}
    </div>`;
}

async function _teamAdd() {
  if (!_teamCanEdit()) return;
  const name = prompt('Member name:');
  if (!name || !name.trim()) return;
  const title = (prompt('Title / role:', '') || '').trim();
  const levelStr = prompt('Org level (0 = top of chart, higher = lower in hierarchy):', '2');
  const level = parseInt(levelStr, 10);
  if (Number.isNaN(level) || level < 0) { toast('Level must be a non-negative number.', 'error'); return; }
  const peers = TEAM.filter(t => t.level === level).map(t => t.sort_order || 0);
  const sort_order = peers.length ? Math.max(...peers) + 1 : 0;
  const { data, error } = await _sb.from('team_members')
    .insert({ name: name.trim(), title, level, sort_order }).select().single();
  if (error) { toast('Add failed: ' + error.message, 'error'); return; }
  TEAM.push(data); toast('Member added'); renderOrg();
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
  if (!confirm(`Remove ${m.name} from the team roster?`)) return;
  const { error } = await _sb.from('team_members').delete().eq('id', id);
  if (error) { toast('Remove failed: ' + error.message, 'error'); return; }
  TEAM = TEAM.filter(t => t.id !== id); toast('Member removed'); renderOrg();
}

window.loadTeamMembers = loadTeamMembers;
window.initOrg = initOrg;
window.renderOrg = renderOrg;
window.orgCard = orgCard;
window._teamAdd = _teamAdd;
window._teamEdit = _teamEdit;
window._teamRemove = _teamRemove;
window._teamInitials = _teamInitials;
window._teamRows = _teamRows;
