/* ==========================================================================
   HITACHI Rail T&C Portal — Permissions Admin (P1-8)

   Admin UI for the Procore-style permission model (see PERMISSIONS_MODEL.md):
     • Templates tab — edit per-module levels + granular action grants on
       permission_templates / template_module_perms; create/duplicate/delete.
     • Users tab — assign templates to profiles, manage per-user module
       overrides (user_module_overrides), preview EFFECTIVE permissions.

   Enforcement lives in RLS (private.has_module_perm / private.is_admin);
   this UI is the management surface. All writes go through the user's own
   JWT via the supabase client (_sb) — RLS rejects non-admins server-side.

   Loaded AFTER app.js (uses _sb, escapeHtml, icon, toast, currentRoleUser
   as runtime globals). The pure resolver below mirrors the DB's
   has_module_perm()/_perm_baseline() resolution exactly and is pinned by
   tools/test_perm_resolver.js — keep both in sync.
   ========================================================================== */
"use strict";

/* ── Pure resolver (mirror of private.has_module_perm + _perm_baseline) ── */

const PERM_ACTIONS = ['view', 'export', 'create', 'edit', 'delete', 'approve', 'manage'];
const PERM_LEVELS  = ['none', 'read_only', 'standard', 'admin'];

function permBaseline(level) {
  if (level === 'admin')     return ['view', 'export', 'create', 'edit', 'delete', 'approve', 'manage'];
  if (level === 'standard')  return ['view', 'export', 'create', 'edit'];
  if (level === 'read_only') return ['view', 'export'];
  return [];
}

// Effective action set for one user × one module.
//   profile: { role, is_active }
//   tmpRow:  { level, grants } from template_module_perms (or null)
//   ovRow:   { level, grants } from user_module_overrides  (or null)
// Mirrors the DB resolution order: inactive → nothing; global admin → all;
// override level replaces template level; override grants merge over template
// grants; effective = baseline(level) then grants add (true) / remove (false).
function permEffective(profile, tmpRow, ovRow) {
  if (!profile || profile.is_active === false) return [];
  if (profile.role === 'admin') return PERM_ACTIONS.slice();
  let level  = (tmpRow && tmpRow.level) || 'none';
  let grants = Object.assign({}, (tmpRow && tmpRow.grants) || {});
  if (ovRow && ovRow.level)  level  = ovRow.level;
  if (ovRow && ovRow.grants) grants = Object.assign(grants, ovRow.grants);
  const eff = new Set(permBaseline(level));
  for (const [action, allowed] of Object.entries(grants)) {
    if (allowed === true) eff.add(action);
    else if (allowed === false) eff.delete(action);
  }
  return PERM_ACTIONS.filter(a => eff.has(a));
}

window.permBaseline  = permBaseline;
window.permEffective = permEffective;
window.PERM_ACTIONS  = PERM_ACTIONS;

/* ── Signed-in user's effective permissions (UI gating, P4-1a) ──────────────
   The UI mirrors what RLS enforces: after login, app.js calls
   loadMyPermissions(currentProfile); nav links whose page module lacks 'view'
   are hidden, and feature code can ask uiCan(module, action).
   FAIL-OPEN BY DESIGN: if the load errors, the UI falls back to the legacy
   role-based visibility — showing too much is harmless (RLS rejects), while
   hiding everything would brick navigation. */

const PAGE_MODULE = {
  'dashboard': 'overview',
  'activities': 'test_register', 'lineitems': 'test_register',
  'field-intake': 'test_register', 'test-register': 'test_register', 'tcv': 'test_register',
  'test-reporting': 'test_reporting',
  'punch-workflow': 'punch_list',
  'rma': 'rma',
  'forms': 'forms',
  'meetings': 'meetings',
  'lookahead': 'lookahead',
  'schedule': 'schedule_p6',
  'drawings': 'drawings',
  'dynamic-testing': 'dynamic_testing',
  'locations': 'locations',
  'team': 'directory',
  'audit': 'audit',
  'admin-templates': 'templates',
  'admin-weights': 'weights',
  'admin-locations': 'locations',
  'admin-fieldconfig': 'forms',
  'admin-directory': 'directory',
  'admin-permissions': 'admin',
  'admin-p6': 'schedule_p6',
  'admin-assets': 'assets',
  'admin-config': 'config',
  'admin-planning': 'planning',
};

let _myPerms = null;   // 'admin' | Map(moduleKey -> actions[]) | null (not loaded / failed)

async function loadMyPermissions(profile) {
  _myPerms = null;
  if (profile && profile.role === 'admin') { _myPerms = 'admin'; _applyPermNav(); return; }
  if (!profile) { _applyPermNav(); return; }
  try {
    const [tmp, ovs] = await Promise.all([
      profile.permission_template_id
        ? _sb.from('template_module_perms').select('*').eq('template_id', profile.permission_template_id)
        : Promise.resolve({ data: [] }),
      _sb.from('user_module_overrides').select('*').eq('user_id', profile.id),
    ]);
    if (tmp.error || ovs.error) throw (tmp.error || ovs.error);
    const tmpMap = new Map((tmp.data || []).map(r => [r.module_key, r]));
    const ovMap  = new Map((ovs.data || []).map(r => [r.module_key, r]));
    const keys = new Set([...tmpMap.keys(), ...ovMap.keys()]);
    const perms = new Map();
    for (const k of keys) perms.set(k, permEffective(profile, tmpMap.get(k) || null, ovMap.get(k) || null));
    _myPerms = perms;
    // Show the template name in the sidebar user pill (role is retired from the UI).
    if (profile.permission_template_id) {
      _sb.from('permission_templates').select('name').eq('id', profile.permission_template_id).single()
        .then(({ data }) => {
          const el = document.querySelector('.sidenav-user-role');
          if (data && data.name && el) {
            const sub = profile.subsystem ? ' · ' + profile.subsystem : '';
            el.textContent = data.name + sub;
          }
        });
    }
  } catch (e) {
    console.warn('[perms] UI permission load failed — falling back to role-based nav (RLS still enforces):', e.message || e);
    _myPerms = null;
  }
  _applyPermNav();
}

function uiCan(moduleKey, action) {
  action = action || 'view';
  if (_myPerms === 'admin') return true;
  if (!_myPerms) return true;                 // fail-open: UI only, RLS is the gate
  const acts = _myPerms.get(moduleKey);
  return !!acts && acts.includes(action);
}

// Pure visibility decision for one nav page:
//   'show' / 'hide'  — permissions are loaded and AUTHORITATIVE (role no longer
//                      decides; templates fully shape the nav)
//   'legacy'         — global admin, perms not loaded (fail-open), or unmapped
//                      page: leave the legacy role-filter visibility untouched.
function _paLinkDecision(page) {
  if (_myPerms === 'admin' || !_myPerms) return 'legacy';
  const mod = PAGE_MODULE[page];
  if (!mod) return 'legacy';
  return uiCan(mod, 'view') ? 'show' : 'hide';
}

function _applyPermNav() {
  if (_myPerms === 'admin' || !_myPerms) return;   // legacy visibility stands
  document.querySelectorAll('.nav-link[data-page]').forEach(link => {
    const d = _paLinkDecision(link.dataset.page);
    if (d === 'show') link.style.display = '';
    else if (d === 'hide') link.style.display = 'none';
  });
  // Section labels: visible iff any link in their section is visible.
  document.querySelectorAll('#nav-regular-items .sidenav-section-label').forEach(label => {
    let any = false;
    for (let el = label.nextElementSibling; el && !el.classList.contains('sidenav-section-label'); el = el.nextElementSibling) {
      if (el.classList.contains('nav-link') && el.style.display !== 'none') { any = true; break; }
    }
    label.style.display = any ? '' : 'none';
  });
  // Per-module admin delegation: a non-admin who can VIEW any admin-area module
  // needs the Admin-mode entry (the legacy nav-role filter hid it by role).
  if (uiCanAnyAdmin()) {
    const bar = document.getElementById('sidenav-admin-bar');
    if (bar) bar.style.display = '';
  }
}
window._paLinkDecision = _paLinkDecision;

// Modules whose management pages live behind the Admin-mode toggle.
const ADMIN_AREA_MODULES = ['templates', 'weights', 'locations', 'forms', 'directory',
  'admin', 'audit', 'schedule_p6', 'assets', 'planning', 'config'];

function uiCanAnyAdmin() {
  return ADMIN_AREA_MODULES.some(m => uiCan(m, 'view'));
}

window.uiCanAnyAdmin = uiCanAnyAdmin;
window.ADMIN_AREA_MODULES = ADMIN_AREA_MODULES;

window.PAGE_MODULE = PAGE_MODULE;
window.loadMyPermissions = loadMyPermissions;
window.uiCan = uiCan;

/* ── Module presentation helpers ────────────────────────────────────────────
   The catalog now carries per-module `actions` (only what the module really
   supports — owner feedback: approve/manage everywhere was noise) and a
   `description`. The UI renders only relevant actions; "appears as" page chips
   are derived live from PAGE_MODULE so the mapping can never drift. */

function _paModuleActions(mod) {
  const a = mod && Array.isArray(mod.actions) && mod.actions.length ? mod.actions : PERM_ACTIONS;
  return PERM_ACTIONS.filter(x => a.includes(x));   // canonical order
}

function _paModulePages(modKey) {
  return Object.keys(PAGE_MODULE).filter(p => PAGE_MODULE[p] === modKey);
}

function _paModuleMetaHTML(mod) {
  const pages = _paModulePages(mod.key);
  const pagesHtml = pages.length
    ? `<div style="margin-top:3px;">${pages.map(p => `<span class="tag" style="font-size:9px;margin-right:3px;">${escapeHtml(p)}</span>`).join('')}</div>`
    : `<div style="margin-top:3px;font-size:10px;color:var(--text-muted);font-style:italic;">data-only — no page of its own</div>`;
  return `${mod.description ? `<div style="font-weight:400;font-size:10px;color:var(--text-muted);margin-top:2px;max-width:260px;">${escapeHtml(mod.description)}</div>` : ''}${pagesHtml}`;
}

window._paModuleActions = _paModuleActions;
window._paModulePages = _paModulePages;

/* ── State ── */

let _paTab = 'templates';            // 'templates' | 'users'
let _paModules = [];                 // perm_modules rows (sorted)
let _paTemplates = [];               // permission_templates rows
let _paTmp = new Map();              // templateId -> Map(moduleKey -> {level, grants})
let _paUsers = [];                   // profiles rows
let _paOverrides = new Map();        // userId -> Map(moduleKey -> {level, grants})
let _paSelTpl = null;                // selected template id
let _paUserPanel = {};               // userId -> 'overrides' | 'effective' | undefined

/* ── Entry point (called from showPage) ── */

function renderAdminPermissions() {
  const root = document.getElementById('admin-permissions-content');
  if (!root || !currentRoleUser) return;
  if (!uiCan('admin', 'view')) {
    root.innerHTML = '<div class="docs-empty"><h3>Not authorized</h3><p>Permission management requires access to the Permissions Admin module.</p></div>';
    return;
  }
  root.innerHTML = cxSkeleton(6);
  _paLoad().then(() => _paRender()).catch(err => {
    root.innerHTML = cxError({ message: 'Could not load permission data: ' + (err.message || err), retry: 'renderAdminPermissions()' });
  });
}

async function _paLoad() {
  const [mods, tpls, tmp, users, ovs] = await Promise.all([
    _sb.from('perm_modules').select('*').order('sort_order'),
    _sb.from('permission_templates').select('*').order('is_system', { ascending: false }).order('name'),
    _sb.from('template_module_perms').select('*'),
    _sb.from('profiles').select('id,full_name,email,role,is_active,permission_template_id').order('created_at'),
    _sb.from('user_module_overrides').select('*'),
  ]);
  for (const r of [mods, tpls, tmp, users, ovs]) if (r.error) throw r.error;
  _paModules   = mods.data || [];
  _paTemplates = tpls.data || [];
  _paUsers     = users.data || [];
  _paTmp = new Map();
  for (const row of (tmp.data || [])) {
    if (!_paTmp.has(row.template_id)) _paTmp.set(row.template_id, new Map());
    _paTmp.get(row.template_id).set(row.module_key, { level: row.level, grants: row.grants || {} });
  }
  _paOverrides = new Map();
  for (const row of (ovs.data || [])) {
    if (!_paOverrides.has(row.user_id)) _paOverrides.set(row.user_id, new Map());
    _paOverrides.get(row.user_id).set(row.module_key, { level: row.level, grants: row.grants || {} });
  }
  if (!_paSelTpl || !_paTemplates.find(t => t.id === _paSelTpl)) {
    _paSelTpl = _paTemplates[0] ? _paTemplates[0].id : null;
  }
}

/* ── Shell ── */

function _paRender() {
  const root = document.getElementById('admin-permissions-content');
  if (!root) return;
  root.innerHTML = `
    <div class="admin-tabs">
      <button class="admin-tab${_paTab === 'templates' ? ' active' : ''}" onclick="_paSetTab('templates')">Templates</button>
      <button class="admin-tab${_paTab === 'users' ? ' active' : ''}" onclick="_paSetTab('users')">Users &amp; Overrides</button>
    </div>
    <div id="pa-tab-body">${_paTab === 'templates' ? _paTemplatesHTML() : _paUsersHTML()}</div>
  `;
}

function _paSetTab(t) { _paTab = t; _paRender(); }

/* ── Templates tab ── */

function _paTplAssignedCount(tplId) {
  return _paUsers.filter(u => u.permission_template_id === tplId).length;
}

function _paTemplatesHTML() {
  const tpl = _paTemplates.find(t => t.id === _paSelTpl);
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Permission Templates</div>
          <p class="section-sub">A template bundles per-module access levels. Users get a template; per-user overrides come on top.</p>
        </div>
        <button class="admin-action-btn" onclick="_paNewTemplate()">+ New Template</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        ${_paTemplates.map(t => `
          <button class="admin-tab${t.id === _paSelTpl ? ' active' : ''}" style="border:1px solid var(--border);border-radius:8px;"
            onclick="_paSelectTemplate('${t.id}')">
            ${escapeHtml(t.name)}
            <span style="margin-left:6px;font-size:10px;opacity:.7;">${_paTplAssignedCount(t.id)} user${_paTplAssignedCount(t.id) === 1 ? '' : 's'}</span>
          </button>`).join('')}
      </div>
      ${tpl ? _paTplPanelHTML(tpl) : cxEmpty({ icon: 'lock', title: 'No templates', message: 'Create a template to start assigning permissions.' })}
    </div>
  `;
}

function _paTplPanelHTML(tpl) {
  const assigned = _paTplAssignedCount(tpl.id);
  const canDelete = !tpl.is_system && assigned === 0;
  const byCat = new Map();
  for (const m of _paModules) {
    const cat = m.category || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(m);
  }
  return `
    <div class="data-card" style="padding:18px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:15px;font-weight:700;">${escapeHtml(tpl.name)}</span>
            ${tpl.is_system ? '<span class="tag" title="Built-in template — can be edited but not renamed or deleted">system</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${escapeHtml(tpl.description || '')}</div>
        </div>
        <div style="display:flex;gap:8px;">
          ${!tpl.is_system ? `<button class="form-secondary" onclick="_paRenameTemplate('${tpl.id}')">${icon('edit')} Rename</button>` : ''}
          <button class="form-secondary" onclick="_paDuplicateTemplate('${tpl.id}')">${icon('clipboard')} Duplicate</button>
          <button class="form-secondary" ${canDelete ? '' : 'disabled'}
            title="${canDelete ? 'Delete this template' : (tpl.is_system ? 'System templates cannot be deleted' : 'Reassign its ' + assigned + ' user(s) first')}"
            onclick="${canDelete ? `_paDeleteTemplate('${tpl.id}')` : ''}"
            style="${canDelete ? 'color:var(--bad);' : 'opacity:.5;cursor:not-allowed;'}">${icon('trash')} Delete</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
        Level sets a baseline; click action chips to grant (filled) / revoke beyond it. Changes save immediately and apply on the user's next query.
      </div>
      ${[...byCat.entries()].map(([cat, mods]) => `
        <div style="margin-top:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px;">${escapeHtml(cat)}</div>
          <table class="data-table" style="font-size:12px;">
            <tbody>
              ${mods.map(m => _paTplRowHTML(tpl.id, m)).join('')}
            </tbody>
          </table>
        </div>`).join('')}
    </div>
  `;
}

function _paTplRowHTML(tplId, mod) {
  const row = (_paTmp.get(tplId) || new Map()).get(mod.key) || { level: 'none', grants: {} };
  const eff = new Set(permEffective({ role: 'x', is_active: true }, row, null));
  const base = new Set(permBaseline(row.level));
  return `
    <tr>
      <td style="width:280px;font-weight:600;vertical-align:top;">${escapeHtml(mod.label)}${_paModuleMetaHTML(mod)}</td>
      <td style="width:130px;vertical-align:top;">
        <select class="form-input" style="font-size:12px;padding:4px 8px;" aria-label="Access level for ${escapeHtml(mod.label)}"
          onchange="_paSetLevel('${tplId}','${mod.key}',this.value)">
          ${PERM_LEVELS.map(l => `<option value="${l}" ${row.level === l ? 'selected' : ''}>${l.replace('_', ' ')}</option>`).join('')}
        </select>
      </td>
      <td style="vertical-align:top;">
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${_paModuleActions(mod).map(a => {
            const on = eff.has(a);
            const isGrant = on !== base.has(a);   // differs from the baseline → explicit grant
            return `<button class="tag" style="cursor:pointer;border:1px solid ${on ? 'var(--brand,#0f62fe)' : 'var(--border)'};
                ${on ? 'background:var(--brand,#0f62fe);color:var(--white,#fff);' : 'background:var(--surface);color:var(--text-muted);'}
                ${isGrant ? 'box-shadow:0 0 0 2px var(--warn,#f59e0b) inset;' : ''}"
              title="${a}${isGrant ? ' (explicit grant override)' : ''} — click to ${on ? 'revoke' : 'grant'}"
              onclick="_paToggleAction('${tplId}','${mod.key}','${a}')">${a}</button>`;
          }).join('')}
        </div>
      </td>
    </tr>
  `;
}

function _paSelectTemplate(id) { _paSelTpl = id; _paRender(); }

async function _paSaveTplRow(tplId, modKey, level, grants) {
  const { error } = await _sb.from('template_module_perms')
    .upsert({ template_id: tplId, module_key: modKey, level, grants }, { onConflict: 'template_id,module_key' });
  if (error) { toast('Save failed: ' + error.message, 'error'); return false; }
  if (!_paTmp.has(tplId)) _paTmp.set(tplId, new Map());
  _paTmp.get(tplId).set(modKey, { level, grants });
  return true;
}

async function _paSetLevel(tplId, modKey, level) {
  // A level change resets explicit grants — the new baseline becomes the truth.
  if (await _paSaveTplRow(tplId, modKey, level, {})) { toast('Level updated'); _paRender(); }
}

async function _paToggleAction(tplId, modKey, action) {
  const cur = (_paTmp.get(tplId) || new Map()).get(modKey) || { level: 'none', grants: {} };
  const eff = new Set(permEffective({ role: 'x', is_active: true }, cur, null));
  const want = !eff.has(action);
  const base = new Set(permBaseline(cur.level));
  const grants = Object.assign({}, cur.grants);
  if (want === base.has(action)) delete grants[action];   // matches baseline → no explicit grant needed
  else grants[action] = want;
  if (await _paSaveTplRow(tplId, modKey, cur.level, grants)) _paRender();
}

async function _paNewTemplate() {
  const name = prompt('New template name:');
  if (!name || !name.trim()) return;
  const { data, error } = await _sb.from('permission_templates')
    .insert({ name: name.trim(), description: '', is_system: false }).select().single();
  if (error) { toast('Create failed: ' + error.message, 'error'); return; }
  _paTemplates.push(data); _paSelTpl = data.id;
  toast('Template created'); _paRender();
}

async function _paRenameTemplate(tplId) {
  const tpl = _paTemplates.find(t => t.id === tplId); if (!tpl) return;
  const name = prompt('Rename template:', tpl.name);
  if (!name || !name.trim() || name.trim() === tpl.name) return;
  const { error } = await _sb.from('permission_templates').update({ name: name.trim() }).eq('id', tplId);
  if (error) { toast('Rename failed: ' + error.message, 'error'); return; }
  tpl.name = name.trim(); toast('Renamed'); _paRender();
}

async function _paDuplicateTemplate(tplId) {
  const src = _paTemplates.find(t => t.id === tplId); if (!src) return;
  const name = prompt('Name for the copy:', src.name + ' (copy)');
  if (!name || !name.trim()) return;
  const { data, error } = await _sb.from('permission_templates')
    .insert({ name: name.trim(), description: src.description || '', is_system: false }).select().single();
  if (error) { toast('Duplicate failed: ' + error.message, 'error'); return; }
  const rows = [...(_paTmp.get(tplId) || new Map()).entries()]
    .map(([module_key, r]) => ({ template_id: data.id, module_key, level: r.level, grants: r.grants }));
  if (rows.length) {
    const { error: e2 } = await _sb.from('template_module_perms').insert(rows);
    if (e2) { toast('Copied template, but copying grants failed: ' + e2.message, 'error'); }
    else _paTmp.set(data.id, new Map(rows.map(r => [r.module_key, { level: r.level, grants: r.grants }])));
  }
  _paTemplates.push(data); _paSelTpl = data.id;
  toast('Template duplicated'); _paRender();
}

async function _paDeleteTemplate(tplId) {
  const tpl = _paTemplates.find(t => t.id === tplId); if (!tpl) return;
  if (tpl.is_system || _paTplAssignedCount(tplId) > 0) return;
  if (!confirm(`Delete template "${tpl.name}"? This cannot be undone.`)) return;
  const { error: e1 } = await _sb.from('template_module_perms').delete().eq('template_id', tplId);
  if (e1) { toast('Delete failed: ' + e1.message, 'error'); return; }
  const { error: e2 } = await _sb.from('permission_templates').delete().eq('id', tplId);
  if (e2) { toast('Delete failed: ' + e2.message, 'error'); return; }
  _paTemplates = _paTemplates.filter(t => t.id !== tplId);
  _paTmp.delete(tplId); _paSelTpl = _paTemplates[0] ? _paTemplates[0].id : null;
  toast('Template deleted'); _paRender();
}

/* ── Users & Overrides tab ── */

function _paUsersHTML() {
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Users &amp; Overrides</div>
          <p class="section-sub">Assign a template to each user; add per-user overrides only where a template doesn't fit. Global admins (role = admin) bypass templates entirely.</p>
        </div>
      </div>
      <div class="data-card" style="padding:0;">
        <table class="dir-table">
          <thead><tr>
            <th style="width:40px;"></th><th>User</th><th>Global admin</th><th>Template</th>
            <th>Overrides</th><th style="width:190px;"></th>
          </tr></thead>
          <tbody>
            ${_paUsers.map(u => _paUserRowHTML(u)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function _paUserRowHTML(u) {
  const name = u.full_name || u.email || '?';
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0]).join('').toUpperCase() || '?';
  const nOv = (_paOverrides.get(u.id) || new Map()).size;
  const isGlobalAdmin = u.role === 'admin';
  const panel = _paUserPanel[u.id];
  return `
    <tr ${u.is_active ? '' : 'style="opacity:.55;"'}>
      <td><div class="user-avatar-sm">${escapeHtml(initials)}</div></td>
      <td style="font-weight:500;">${escapeHtml(name)}<div style="font-weight:400;font-size:11px;color:var(--text-muted);">${escapeHtml(u.email || '')}</div></td>
      <td style="font-size:12px;">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;" title="Global admins bypass templates: every action on every module">
          <input type="checkbox" ${isGlobalAdmin ? 'checked' : ''} onchange="_paSetGlobalAdmin('${u.id}',this.checked)">
          <span style="color:${isGlobalAdmin ? 'var(--bad)' : 'var(--text-muted)'};font-weight:600;">${isGlobalAdmin ? 'all access' : 'off'}</span>
        </label>
      </td>
      <td>
        <select class="form-input" style="font-size:12px;padding:4px 8px;min-width:150px;" aria-label="Permission template for ${escapeHtml(name)}"
          ${isGlobalAdmin ? 'title="Assigned but ignored while role is admin"' : ''}
          onchange="_paAssignTemplate('${u.id}',this.value)">
          <option value="" ${!u.permission_template_id ? 'selected' : ''}>— none —</option>
          ${_paTemplates.map(t => `<option value="${t.id}" ${u.permission_template_id === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        </select>
      </td>
      <td style="font-size:12px;">${nOv ? `${nOv} module${nOv === 1 ? '' : 's'}` : '<span style="color:var(--text-muted);">none</span>'}</td>
      <td>
        <button class="form-secondary" style="font-size:11px;padding:4px 8px;" onclick="_paToggleUserPanel('${u.id}','overrides')">${panel === 'overrides' ? 'Close' : 'Overrides'}</button>
        <button class="form-secondary" style="font-size:11px;padding:4px 8px;" onclick="_paToggleUserPanel('${u.id}','effective')">${panel === 'effective' ? 'Close' : 'Effective'}</button>
      </td>
    </tr>
    ${panel ? `<tr><td colspan="6" style="background:var(--surface);padding:14px 18px;">${panel === 'overrides' ? _paOverridesPanelHTML(u) : _paEffectivePanelHTML(u)}</td></tr>` : ''}
  `;
}

function _paToggleUserPanel(userId, which) {
  _paUserPanel[userId] = _paUserPanel[userId] === which ? undefined : which;
  _paRender();
}

// Global admin = profiles.role flag (the has_module_perm/is_admin shortcut).
// Off-state is 'readonly': least privilege for the legacy role fallbacks.
async function _paSetGlobalAdmin(userId, makeAdmin) {
  const { error } = await _sb.from('profiles')
    .update({ role: makeAdmin ? 'admin' : 'readonly' }).eq('id', userId);
  if (error) { toast('Update failed: ' + error.message, 'error'); _paRender(); return; }
  const u = _paUsers.find(x => x.id === userId);
  if (u) u.role = makeAdmin ? 'admin' : 'readonly';
  toast(makeAdmin ? 'Global admin granted' : 'Global admin revoked');
  _paRender();
}

async function _paAssignTemplate(userId, tplId) {
  const { error } = await _sb.from('profiles')
    .update({ permission_template_id: tplId || null }).eq('id', userId);
  if (error) { toast('Assign failed: ' + error.message, 'error'); return; }
  const u = _paUsers.find(x => x.id === userId);
  if (u) u.permission_template_id = tplId || null;
  toast('Template assigned'); _paRender();
}

/* Overrides panel */

function _paOverridesPanelHTML(u) {
  const ovs = _paOverrides.get(u.id) || new Map();
  const available = _paModules.filter(m => !ovs.has(m.key));
  return `
    <div style="font-size:12px;font-weight:700;margin-bottom:8px;">Per-module overrides for ${escapeHtml(u.full_name || u.email || '')}</div>
    ${ovs.size ? `
      <table class="data-table" style="font-size:12px;margin-bottom:10px;">
        <tbody>
          ${[...ovs.entries()].map(([key, row]) => {
            const mod = _paModules.find(m => m.key === key) || { label: key, key };
            const eff = new Set(permEffective({ role: 'x', is_active: true }, row, null));
            const base = new Set(permBaseline(row.level));
            return `<tr>
              <td style="width:200px;font-weight:600;">${escapeHtml(mod.label)}</td>
              <td style="width:130px;">
                <select class="form-input" style="font-size:12px;padding:4px 8px;" aria-label="Override level for ${escapeHtml(mod.label)}"
                  onchange="_paSetOverride('${u.id}','${key}',this.value)">
                  ${PERM_LEVELS.map(l => `<option value="${l}" ${row.level === l ? 'selected' : ''}>${l.replace('_', ' ')}</option>`).join('')}
                </select>
              </td>
              <td><div style="display:flex;gap:4px;flex-wrap:wrap;">
                ${_paModuleActions(mod).map(a => {
                  const on = eff.has(a); const isGrant = on !== base.has(a);
                  return `<button class="tag" style="cursor:pointer;border:1px solid ${on ? 'var(--brand,#0f62fe)' : 'var(--border)'};
                      ${on ? 'background:var(--brand,#0f62fe);color:var(--white,#fff);' : 'background:var(--surface);color:var(--text-muted);'}
                      ${isGrant ? 'box-shadow:0 0 0 2px var(--warn,#f59e0b) inset;' : ''}"
                    title="${a}${isGrant ? ' (explicit grant)' : ''}" onclick="_paToggleOverrideAction('${u.id}','${key}','${a}')">${a}</button>`;
                }).join('')}
              </div></td>
              <td style="width:40px;text-align:right;">
                <button class="form-secondary" style="font-size:11px;padding:3px 7px;color:var(--bad);" aria-label="Remove override for ${escapeHtml(mod.label)}"
                  onclick="_paRemoveOverride('${u.id}','${key}')">${icon('trash')}</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">No overrides — this user gets exactly their template.</div>`}
    ${available.length ? `
      <div style="display:flex;gap:8px;align-items:center;">
        <select class="form-input" id="pa-add-ov-${u.id}" style="font-size:12px;padding:4px 8px;max-width:240px;" aria-label="Module to override">
          ${available.map(m => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}
        </select>
        <button class="form-secondary" style="font-size:12px;"
          onclick="_paAddOverride('${u.id}', document.getElementById('pa-add-ov-${u.id}').value)">${icon('plus')} Add override</button>
      </div>` : ''}
  `;
}

async function _paSaveOverride(userId, modKey, level, grants) {
  const { error } = await _sb.from('user_module_overrides')
    .upsert({ user_id: userId, module_key: modKey, level, grants }, { onConflict: 'user_id,module_key' });
  if (error) { toast('Save failed: ' + error.message, 'error'); return false; }
  if (!_paOverrides.has(userId)) _paOverrides.set(userId, new Map());
  _paOverrides.get(userId).set(modKey, { level, grants });
  return true;
}

async function _paAddOverride(userId, modKey) {
  if (!modKey) return;
  // Seed from the user's current template level so the override starts as a no-op.
  const u = _paUsers.find(x => x.id === userId);
  const tmpRow = u && u.permission_template_id
    ? (_paTmp.get(u.permission_template_id) || new Map()).get(modKey) : null;
  if (await _paSaveOverride(userId, modKey, (tmpRow && tmpRow.level) || 'none', {})) {
    toast('Override added'); _paRender();
  }
}

async function _paSetOverride(userId, modKey, level) {
  if (await _paSaveOverride(userId, modKey, level, {})) { toast('Override updated'); _paRender(); }
}

async function _paToggleOverrideAction(userId, modKey, action) {
  const cur = (_paOverrides.get(userId) || new Map()).get(modKey) || { level: 'none', grants: {} };
  const eff = new Set(permEffective({ role: 'x', is_active: true }, cur, null));
  const want = !eff.has(action);
  const base = new Set(permBaseline(cur.level));
  const grants = Object.assign({}, cur.grants);
  if (want === base.has(action)) delete grants[action]; else grants[action] = want;
  if (await _paSaveOverride(userId, modKey, cur.level, grants)) _paRender();
}

async function _paRemoveOverride(userId, modKey) {
  const { error } = await _sb.from('user_module_overrides')
    .delete().eq('user_id', userId).eq('module_key', modKey);
  if (error) { toast('Remove failed: ' + error.message, 'error'); return; }
  (_paOverrides.get(userId) || new Map()).delete(modKey);
  toast('Override removed'); _paRender();
}

/* Effective panel */

function _paEffectivePanelHTML(u) {
  if (u.is_active === false) {
    return `<div style="font-size:12px;color:var(--bad);">${icon('ban')} Inactive user — all access denied regardless of template/overrides.</div>`;
  }
  if (u.role === 'admin') {
    return `<div style="font-size:12px;">${icon('check-circle')} <b>Global admin</b> — every action on every module (template and overrides are bypassed).</div>`;
  }
  const tplMap = u.permission_template_id ? (_paTmp.get(u.permission_template_id) || new Map()) : new Map();
  const ovMap  = _paOverrides.get(u.id) || new Map();
  const tplName = (_paTemplates.find(t => t.id === u.permission_template_id) || {}).name || '— none —';
  return `
    <div style="font-size:12px;font-weight:700;margin-bottom:8px;">Effective permissions for ${escapeHtml(u.full_name || u.email || '')} <span style="font-weight:400;color:var(--text-muted);">(template: ${escapeHtml(tplName)})</span></div>
    <table class="data-table" style="font-size:12px;">
      <thead><tr><th>Module</th><th>Source</th><th>Effective actions</th></tr></thead>
      <tbody>
        ${_paModules.map(m => {
          const tmpRow = tplMap.get(m.key) || null;
          const ovRow  = ovMap.get(m.key) || null;
          const relevant = _paModuleActions(m);
          const eff = permEffective(u, tmpRow, ovRow).filter(a => relevant.includes(a));
          return `<tr>
            <td style="width:260px;font-weight:600;vertical-align:top;">${escapeHtml(m.label)}${_paModuleMetaHTML(m)}</td>
            <td style="width:110px;vertical-align:top;">${ovRow ? '<span class="tag" title="A per-user override applies to this module">override</span>' : '<span style="color:var(--text-muted);">template</span>'}</td>
            <td style="vertical-align:top;">${eff.length
              ? eff.map(a => `<span class="tag" style="margin-right:3px;">${a}</span>`).join('')
              : '<span style="color:var(--text-muted);">no access</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}
