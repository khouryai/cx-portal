// ==========================================
// HITACHI Rail T&C Portal — Team: add a person (team-invite.js)
//
// Extracted from app.js. Loaded after app.js: it uses app.js globals (modal,
// escapeHtml, _sb, toast, closeModal, SUBSYSTEMS_LIST, COMPANIES_LIST,
// _loadDirectoryUsers). Wired by data-action="openInviteUserModal" and
// data-action="inviteUser".
//
// TWO WAYS TO ADD SOMEONE, chosen by who signs people in (config.js IDENTITY):
//
//   Supabase / local passwords — create the account with a temporary password,
//     then the profile with that account's id (unchanged behaviour).
//
//   Microsoft Entra — the portal creates no accounts: Microsoft does. The
//     admin enters name, email and permissions; the profile is saved WAITING
//     for its owner (link_pending). On that person's first Microsoft sign-in,
//     the database links it to their Entra account by email
//     (public.claim_profile(), supabase/sql/azure_relink_profile.sql), and
//     from then on only their Entra object id is used.
// ==========================================

function _invUsesMicrosoft() {
  return !!(window.CXIdentity && window.CXIdentity.kind === 'entra');
}

async function openInviteUserModal() {
  const microsoft = _invUsesMicrosoft();
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
        ${microsoft
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { openInviteUserModal, inviteUser, _invLikeExact };
}
