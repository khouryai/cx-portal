// ==========================================
// HITACHI Rail T&C Portal — Directory: add, deactivate and remove people
// (team-invite.js)
//
// Extracted from app.js. Loaded after app.js: it uses app.js globals (modal,
// escapeHtml, _sb, toast, closeModal, cxConfirm, SUBSYSTEMS_LIST,
// COMPANIES_LIST, _loadDirectoryUsers, currentProfile). Wired by
// data-action="openInviteUserModal" / "inviteUser" / "deleteUserConfirm" and
// data-change="updateProfileActive".
//
// THREE WAYS, chosen by who signs people in (config.js):
//
//   Supabase / local passwords — create the account with a temporary password,
//     then the profile with that account's id (unchanged behaviour).
//
//   Microsoft Entra, managed from the portal (ENTRA_USERS_GROUP_ID set) — the
//     normal Azure setup. Add Person finds the person's Microsoft account (or
//     invites them as a guest), adds them to the CX Portal Users group, and
//     saves their profile under their Entra object id: they can sign in at
//     once, with no step in Microsoft's admin pages and nothing to link later.
//     Inactive and Remove take them back out of the group; Active puts them
//     back. Graph calls: cx-entra-admin.js. If the portal's own save fails
//     after Microsoft said yes, the group change is undone, so the two never
//     disagree silently.
//
//   Microsoft Entra without ENTRA_USERS_GROUP_ID — the profile is saved WAITING
//     for its owner (link_pending), IT adds them to the group, and their first
//     sign-in links it (public.claim_profile()).
//
// A profile that is already waiting (one carried over from Supabase, or added
// the old way) is connected to the Microsoft account on the spot by
// public.admin_link_profile(), keeping its permissions and history.
// ==========================================

function _invUsesMicrosoft() {
  return !!(window.CXIdentity && window.CXIdentity.kind === 'entra');
}

/** Microsoft sign-in, and the portal manages the CX Portal Users group itself. */
function _invManagesMicrosoft() {
  return _invUsesMicrosoft() && !!(window.CXEntraAdmin && window.CXEntraAdmin.enabled());
}

async function openInviteUserModal() {
  const microsoft = _invUsesMicrosoft();
  const managed = _invManagesMicrosoft();
  const { data: _invTpls } = await _sb.from('permission_templates').select('id,name').order('name');
  const invTemplates = _invTpls || [];
  modal({
    title: microsoft ? 'Add Person' : 'Invite User',
    sub: microsoft ? 'They sign in with their Microsoft account' : 'Create a new portal account',
    size: 'medium',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full">
          <label>Full Name</label>
          <input type="text" id="inv-name" class="form-input" placeholder="Jane Smith">
        </div>
        <div class="form-field form-field-full">
          <label>Email${microsoft ? ' <span style="font-weight:400;color:var(--gray-500);">(the address they sign in to Microsoft with)</span>' : ''}</label>
          <input type="email" id="inv-email" class="form-input" placeholder="jane@example.com">
        </div>
        ${microsoft ? '' : `
        <div class="form-field form-field-full">
          <label>Temporary Password <span style="font-weight:400;color:var(--gray-500);">(share this securely with the user)</span></label>
          <input type="text" id="inv-password" class="form-input" placeholder="At least 6 characters">
        </div>`}
        <div class="form-field">
          <label>Permission template</label>
          <select id="inv-template" class="form-input">
            <option value="">— no template (no access until assigned) —</option>
            ${invTemplates.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:6px;cursor:pointer;" title="Global admins bypass templates: every action on every module">
            <input type="checkbox" id="inv-admin"> Global admin
          </label>
        </div>
        <div class="form-field">
          <label>Subsystem <span style="font-weight:400;color:var(--gray-500);">(optional — blank = all)</span></label>
          <select id="inv-subsystem" class="form-input">
            <option value="">All subsystems</option>
            ${SUBSYSTEMS_LIST.map(s=>`<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Company</label>
          <select id="inv-company" class="form-input">
            <option value="">— none —</option>
            ${COMPANIES_LIST.map(c=>`<option value="${c}" ${c==='Hitachi Rail'?'selected':''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
      </div>
      <p style="font-size:12px;color:var(--gray-500);margin-top:14px;line-height:1.5;">
        ${managed
          ? `There is no password to share. The portal adds them to the <strong>CX Portal Users</strong> group in Microsoft, so they can sign in straight away.
             Someone outside your organisation (for example BART staff) first gets an invitation email from Microsoft to accept.`
          : microsoft
          ? `There is no password to share. The first time they sign in with Microsoft, this profile is linked to their account automatically.
             They must also be in the <strong>CX Portal Users</strong> group in Microsoft Entra — BART staff are invited there as guests by Hitachi IT.`
          : `Share the temporary password securely. On first sign-in, the user will be prompted to set their own password before accessing the portal.
             If email confirmation is enabled in Supabase Auth settings, they must confirm their email first.`}
      </p>
    `,
    footer: `
      <button class="form-secondary" data-action="closeModal">Cancel</button>
      <button class="form-submit" data-action="inviteUser">${microsoft ? 'Add Person' : 'Create Account'}</button>
    `,
  });
}

/** PostgREST `ilike` treats % and _ as wildcards; an email may contain _. */
function _invLikeExact(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }

let _invInFlight = false;

/** Disable the dialog's submit button while Microsoft is being asked. */
function _invBusy(on) {
  const b = typeof document.querySelector === 'function' ? document.querySelector('[data-action="inviteUser"]') : null;
  if (!b) return;
  if (on) { b.dataset.label = b.textContent; b.textContent = 'Adding…'; b.disabled = true; }
  else { if (b.dataset.label) b.textContent = b.dataset.label; b.disabled = false; }
}

/** POST to a database function, as the signed-in person. Never throws. */
async function _invRpc(name, body) {
  try {
    const auth = window.CXIdentity && typeof window.CXIdentity.authHeader === 'function' ? window.CXIdentity.authHeader() : '';
    const res = await fetch(`${window.REST_BASE}/rpc/${name}`, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
                 ...(window.API_KEY_HEADER || {}), ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!res.ok) return { data: null, error: { message: (json && (json.message || json.hint)) || text || res.statusText } };
    return { data: json, error: null };
  } catch (e) {
    return { data: null, error: { message: e.message } };
  }
}

async function inviteUser() {
  if (typeof uiCan === 'function' && !uiCan('directory', 'invite')) { toast('You do not have permission to invite users', 'error'); return; }
  const microsoft = _invUsesMicrosoft();
  const name      = document.getElementById('inv-name').value.trim();
  const email     = document.getElementById('inv-email').value.trim();
  const password  = microsoft ? '' : document.getElementById('inv-password').value;
  const tplId     = document.getElementById('inv-template').value;
  const isAdmin   = document.getElementById('inv-admin').checked;
  const subsystem = document.getElementById('inv-subsystem').value;
  const company   = document.getElementById('inv-company').value;
  const profile = {
    email, full_name: name,
    role: isAdmin ? 'admin' : 'readonly',   // role survives only as the global-admin flag
    permission_template_id: tplId || null,
    subsystem: subsystem || null, company: company || null, is_active: true,
  };

  if (microsoft) {
    if (!name || !email) { toast('Name and email are both required', 'error'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('That does not look like an email address', 'error'); return; }
    if (_invManagesMicrosoft()) {
      if (_invInFlight) return;
      _invInFlight = true;
      _invBusy(true);
      try { await _invAddWithMicrosoft(profile); }
      finally { _invInFlight = false; _invBusy(false); }
      return;
    }
    // One profile per person: their first sign-in links by email.
    const { data: existing, error: lookErr } = await _sb.from('profiles').select('id').ilike('email', _invLikeExact(email)).limit(1);
    if (lookErr) { toast('Could not check for an existing profile: ' + lookErr.message, 'error'); return; }
    if (existing && existing.length) { toast('Someone with that email is already on the team', 'error'); return; }

    const { error: profErr } = await _sb.from('profiles').insert({
      ...profile,
      // A placeholder until their first Microsoft sign-in replaces it with
      // their Entra object id.
      id: crypto.randomUUID(),
      must_change_password: false,
      link_pending: true,
    });
    if (profErr) { toast('Profile save failed: ' + profErr.message, 'error'); return; }

    closeModal();
    toast(`${name} added. Their first Microsoft sign-in links this profile to their account.`, 'success');
    _loadDirectoryUsers();
    return;
  }

  if (!name || !email || !password) { toast('Name, email, and password are all required', 'error'); return; }
  if (password.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }

  const { data, error } = await window.CXIdentity.createUser({
    email, password,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      data: { full_name: name },
    },
  });
  if (error) { toast('Account creation failed: ' + error.message, 'error'); return; }
  if (!data.user) { toast('Unexpected error — no user returned', 'error'); return; }

  const { error: profErr } = await _sb.from('profiles').insert({
    ...profile,
    id: data.user.id,
    must_change_password: true,
  });
  if (profErr) { toast('Profile save failed: ' + profErr.message, 'error'); return; }

  closeModal();
  toast(`Account created for ${name}. They'll be prompted to set a new password on first sign-in.`, 'success');
  _loadDirectoryUsers();
}

/**
 * Add Person under Microsoft sign-in, managed from the portal:
 *   1. one profile per email (a waiting one is connected, not duplicated);
 *   2. the Microsoft account: found, or a guest invited (after asking);
 *   3. into CX Portal Users;
 *   4. the profile, under the Entra object id — or, if step 4 fails, step 3
 *      is undone so Microsoft and the portal agree.
 */
async function _invAddWithMicrosoft(profile) {
  const A = window.CXEntraAdmin;
  const name = profile.full_name, email = profile.email;

  // 1. Already in the Directory?
  const { data: existing, error: lookErr } = await _sb.from('profiles')
    .select('id,email,link_pending,is_active').ilike('email', _invLikeExact(email)).limit(2);
  if (lookErr) { toast('Could not check for an existing profile: ' + lookErr.message, 'error'); return; }
  const rows = existing || [];
  const waiting = rows.length === 1 && rows[0].link_pending ? rows[0] : null;
  if (waiting && waiting.is_active === false) {
    toast('That person already has a profile, set to Inactive. Switch it to Active, then add them again.', 'error');
    return;
  }
  if (rows.length && !waiting) {
    toast(rows.length > 1 ? 'Two profiles already use that email. Correct one of them first.'
      : rows[0].is_active === false
        ? 'That person is already in the Directory but Inactive. Switch them back to Active instead.'
        : 'Someone with that email is already on the team', 'error');
    return;
  }

  // 2. Their Microsoft account.
  let account;
  try {
    account = await A.resolveAccount(email, name, (addr) => cxConfirm(
      `${addr} is not in your organisation's Microsoft directory.\n\n` +
      `Invite them as a guest? Microsoft emails them an invitation; once they accept it they can sign in to the portal.`));
  } catch (err) { toast(A.explain(err), 'error'); return; }
  if (!account) { toast('Nothing was changed.', 'info'); return; }

  const { data: owner, error: ownErr } = await _sb.from('profiles').select('id,email').eq('id', account.id).limit(1);
  if (ownErr) { toast('Could not check the Directory: ' + ownErr.message, 'error'); return; }
  if (owner && owner.length) {
    toast(`That Microsoft account already belongs to ${owner[0].email} in the Directory.`, 'error');
    return;
  }

  // 3. Into CX Portal Users.
  let membership;
  try { membership = await A.addToGroup(account.id); }
  catch (err) {
    toast(A.explain(err) + (account.invited ? ' The invitation email has gone; adding them again reuses it.' : ''), 'error');
    return;
  }

  // 4. The profile.
  let saveErr;
  if (waiting) {
    const { error } = await _invRpc('admin_link_profile', { p_profile_id: waiting.id, p_oid: account.id });
    saveErr = error;
  } else {
    const { error } = await _sb.from('profiles').insert({
      ...profile, id: account.id, must_change_password: false, link_pending: false,
    });
    saveErr = error;
  }
  if (saveErr) {
    let undone = '';
    if (membership.added) {
      try { await A.removeFromGroup(account.id); undone = ' They were taken back out of the CX Portal Users group.'; }
      catch (e) { undone = ' They are still in the CX Portal Users group: remove them there, or add them again here.'; }
    }
    toast('Profile save failed: ' + saveErr.message + '.' + undone, 'error');
    return;
  }

  closeModal();
  toast(waiting
    ? `${name}'s existing profile is now connected to their Microsoft account; permissions and history are kept.`
    : account.invited
      ? `${name} invited. Microsoft has emailed ${email}; once they accept, they can sign in.`
      : `${name} added. They can sign in now with their Microsoft account.`, 'success');
  _loadDirectoryUsers();
}

/** The signed-in person's own profile id (app.js `currentProfile`). */
function _invMyId() {
  try { return (typeof currentProfile !== 'undefined' && currentProfile && currentProfile.id) || null; }
  catch (e) { return null; }
}

/**
 * Under managed Microsoft sign-in: is this profile linked to an Entra account?
 * @returns {Promise<{ok:boolean, linked:boolean}>} ok=false: could not tell (the caller stops)
 */
async function _invLinkedProfile(id) {
  const { data, error } = await _sb.from('profiles').select('id,email,link_pending').eq('id', id).limit(1);
  if (error) { toast('Could not read the profile: ' + error.message, 'error'); return { ok: false, linked: false }; }
  return { ok: true, linked: !!(data && data.length && !data[0].link_pending) };
}

async function updateProfileActive(id, is_active) {
  if (!_invManagesMicrosoft()) {
    const { error } = await _sb.from('profiles').update({ is_active }).eq('id', id);
    if (error) toast('Update failed: ' + error.message, 'error');
    else toast(is_active ? 'User activated' : 'User deactivated', 'success');
    return;
  }

  const A = window.CXEntraAdmin;
  if (!is_active && id === _invMyId()) {
    toast('You cannot deactivate yourself. Ask another administrator.', 'error');
    _loadDirectoryUsers();
    return;
  }
  const look = await _invLinkedProfile(id);
  if (!look.ok) { _loadDirectoryUsers(); return; }
  const linked = look.linked;

  if (is_active) {
    // Microsoft first: an Active profile nobody can sign in to helps no one.
    let membership = { added: false };
    if (linked) {
      try { membership = await A.addToGroup(id); }
      catch (err) { toast(A.explain(err), 'error'); _loadDirectoryUsers(); return; }
    }
    const { error } = await _sb.from('profiles').update({ is_active: true }).eq('id', id);
    if (error) {
      if (membership.added) { try { await A.removeFromGroup(id); } catch (e) { /* reported below */ } }
      toast('Update failed: ' + error.message, 'error');
      _loadDirectoryUsers();
      return;
    }
    toast(linked ? 'User activated. They can sign in with Microsoft again.' : 'User activated', 'success');
    _loadDirectoryUsers();
    return;
  }

  // The portal first: from this moment they see no data, whatever Microsoft says.
  const { error } = await _sb.from('profiles').update({ is_active: false }).eq('id', id);
  if (error) { toast('Update failed: ' + error.message, 'error'); _loadDirectoryUsers(); return; }
  if (linked) {
    try { await A.removeFromGroup(id); }
    catch (err) {
      toast('Deactivated in the portal, so they see no data. But Microsoft did not take them out of the CX Portal Users group: ' +
        A.explain(err), 'error');
      _loadDirectoryUsers();
      return;
    }
  }
  toast(linked ? 'User deactivated and removed from CX Portal Users in Microsoft.' : 'User deactivated', 'success');
  _loadDirectoryUsers();
}

async function deleteUserConfirm(id, name) {
  if (!_invManagesMicrosoft()) {
    if (!await cxConfirm(`Remove "${name}" from the portal?\n\nThis removes their profile and access. Their Supabase auth account is preserved.`)) return;
    const { error } = await _sb.from('profiles').delete().eq('id', id);
    if (error) { toast('Remove failed: ' + error.message, 'error'); return; }
    toast(`Removed ${name}`, 'success');
    _loadDirectoryUsers();
    return;
  }

  const A = window.CXEntraAdmin;
  if (id === _invMyId()) { toast('You cannot remove yourself. Ask another administrator.', 'error'); return; }
  const look = await _invLinkedProfile(id);
  if (!look.ok) return;
  const linked = look.linked;
  if (!await cxConfirm(`Remove "${name}" from the portal?\n\n` + (linked
    ? 'They are taken out of the CX Portal Users group in Microsoft, so they can no longer sign in, and their portal profile is removed.'
    : 'Their portal profile is removed. (They never signed in, so there is nothing to change in Microsoft.)'))) return;

  let membership = { removed: false };
  if (linked) {
    try { membership = await A.removeFromGroup(id); }
    catch (err) {
      if (!await cxConfirm(`Microsoft did not take ${name} out of the CX Portal Users group:\n${A.explain(err)}\n\n` +
        'Remove their portal profile anyway? They will see no data, but can still sign in until IT removes them from the group.')) return;
    }
  }
  const { error } = await _sb.from('profiles').delete().eq('id', id);
  if (error) {
    // Keep Microsoft and the portal in step: they are still a portal user.
    if (membership.removed) { try { await A.addToGroup(id); } catch (e) { /* the message below still applies */ } }
    toast('Remove failed: ' + error.message + (membership.removed ? '. Their Microsoft access was restored.' : ''), 'error');
    return;
  }
  toast(`Removed ${name}` + (membership.removed ? ' from the portal and from CX Portal Users in Microsoft.' : ''), 'success');
  _loadDirectoryUsers();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { openInviteUserModal, inviteUser, updateProfileActive, deleteUserConfirm, _invLikeExact };
}
