"use strict";
// Team → add a person (team-invite.js), under both sign-in setups.
//
// Microsoft Entra: no password, no account creation; the profile is saved
// waiting for its owner (link_pending) under a placeholder id, and their first
// Microsoft sign-in links it (public.claim_profile, see test_relink_profile.js).
// Supabase: exactly the old behaviour — temporary password, account, profile.
//   Run: node tools/test_team_invite.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
console.log("=== Team: add a person ===\n");

const SRC = fs.readFileSync(path.join(ROOT, "team-invite.js"), "utf8");

function sandbox(identityKind, form, existing) {
  const log = { inserts: [], toasts: [], modal: null, closed: false, reloaded: false, createUser: [], lookups: [] };
  const query = (table) => {
    const q = {
      select() { return q; }, order() { return Promise.resolve({ data: [{ id: "tpl-1", name: "Field Engineer" }], error: null }); },
      ilike(col, val) { log.lookups.push({ table, col, val }); return q; },
      limit() { return Promise.resolve({ data: existing ? [{ id: "x" }] : [], error: null }); },
      insert(row) { log.inserts.push({ table, row }); return Promise.resolve({ error: null }); },
    };
    return q;
  };
  const ctx = {
    console, crypto: globalThis.crypto,
    window: {
      location: { origin: "https://portal.example.com", pathname: "/" },
      CXIdentity: {
        kind: identityKind,
        createUser: async (args) => { log.createUser.push(args); return { data: { user: { id: "supabase-user-id" } }, error: null }; },
      },
    },
    document: { getElementById: (id) => ({ value: form[id] || "", checked: !!form[id] }) },
    _sb: { from: query },
    modal: (o) => { log.modal = o; },
    toast: (m, k) => log.toasts.push({ m, k }),
    closeModal: () => { log.closed = true; },
    _loadDirectoryUsers: () => { log.reloaded = true; },
    escapeHtml: (s) => String(s),
    uiCan: () => true,
    SUBSYSTEMS_LIST: ["ATC"], COMPANIES_LIST: ["Hitachi Rail", "BART"],
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "team-invite.js" });
  return { ctx, log };
}

const FORM = { "inv-name": "BART Reviewer", "inv-email": "reviewer@bart.gov", "inv-template": "tpl-1",
  "inv-subsystem": "", "inv-company": "BART" };

(async () => {
  // ── Microsoft Entra ──
  let { ctx, log } = sandbox("entra", FORM, false);
  await ctx.openInviteUserModal();
  ok("the form asks for no password under Microsoft sign-in", !/inv-password/.test(log.modal.body));
  ok("…and explains first sign-in and the Entra group", /first time they sign in with Microsoft/.test(log.modal.body) &&
    /CX Portal Users/.test(log.modal.body) && /Add Person/.test(log.modal.footer));

  await ctx.inviteUser();
  const ins = log.inserts[0] && log.inserts[0].row;
  ok("no account is created — Microsoft owns accounts", log.createUser.length === 0);
  ok("one profile is saved, waiting for its owner", log.inserts.length === 1 && log.inserts[0].table === "profiles" &&
    ins.link_pending === true && ins.must_change_password === false);
  ok("…under a placeholder id (a fresh uuid)", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ins.id));
  ok("…with the chosen name, email, template and company",
    ins.full_name === "BART Reviewer" && ins.email === "reviewer@bart.gov" && ins.permission_template_id === "tpl-1" &&
    ins.company === "BART" && ins.role === "readonly" && ins.is_active === true);
  ok("the admin is told what happens next", log.closed && log.reloaded && /first Microsoft sign-in/.test(log.toasts[0].m));

  ({ ctx, log } = sandbox("entra", { ...FORM, "inv-email": "some_one@bart.gov" }, true));
  await ctx.inviteUser();
  ok("an email already on the team is refused", log.inserts.length === 0 && /already on the team/.test(log.toasts[0].m));
  ok("…matched exactly, even with _ in the address", log.lookups[0].val === "some\\_one@bart.gov");

  ({ ctx, log } = sandbox("entra", { ...FORM, "inv-email": "not-an-email" }, false));
  await ctx.inviteUser();
  ok("a malformed email is refused", log.inserts.length === 0 && log.toasts[0].k === "error");

  ({ ctx, log } = sandbox("entra", { ...FORM, "inv-name": "" }, false));
  await ctx.inviteUser();
  ok("name is required", log.inserts.length === 0 && /required/.test(log.toasts[0].m));

  // ── Supabase: unchanged ──
  ({ ctx, log } = sandbox("supabase", { ...FORM, "inv-password": "temp-pass-1" }, false));
  await ctx.openInviteUserModal();
  ok("Supabase still asks for a temporary password", /inv-password/.test(log.modal.body) && /Create Account/.test(log.modal.footer));
  await ctx.inviteUser();
  const sIns = log.inserts[0] && log.inserts[0].row;
  ok("Supabase still creates the account first", log.createUser.length === 1 && log.createUser[0].password === "temp-pass-1");
  ok("…then the profile under that account's id, password change required",
    sIns && sIns.id === "supabase-user-id" && sIns.must_change_password === true && sIns.link_pending === undefined);

  ({ ctx, log } = sandbox("supabase", FORM, false));
  await ctx.inviteUser();
  ok("Supabase still requires the password", log.createUser.length === 0 && /password are all required/.test(log.toasts[0].m));

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
