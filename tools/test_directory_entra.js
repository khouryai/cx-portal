"use strict";
// Directory → add, deactivate, reactivate and remove people under Microsoft
// sign-in, managed from the portal (team-invite.js + cx-entra-admin.js).
//
// The real modules run in a sandbox against a simulated Entra tenant
// (tools/fake_graph.js) and an in-memory profiles table. Every path is checked
// for what lands in BOTH places, because the promise of this feature is that
// Microsoft and the portal never disagree silently: when one side refuses, the
// other is left (or put back) as it was, and the administrator is told what
// happened in words they can act on.
//   Run: node tools/test_directory_entra.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createTenant } = require("./fake_graph.js");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
console.log("=== Directory ↔ Microsoft: add, deactivate, remove ===\n");

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP = "99999999-9999-4999-8999-999999999999";
const ADMIN_SRC = fs.readFileSync(path.join(ROOT, "cx-entra-admin.js"), "utf8");
const TEAM_SRC = fs.readFileSync(path.join(ROOT, "team-invite.js"), "utf8");

/** In-memory profiles table with the query shapes team-invite.js uses. */
function profilesTable(rows, failures) {
  const likeToRe = (pat) => new RegExp("^" + pat.replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]\\])/g,
    (m, esc, wild, re) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : wild ? (wild === "%" ? ".*" : ".") : "\\" + re) + "$", "i");
  return (table) => {
    if (table === "permission_templates") {
      return { select: () => ({ order: async () => ({ data: [{ id: "tpl-1", name: "Field Engineer" }], error: null }) }) };
    }
    const q = { filters: [], op: "select", patch: null };
    const match = () => rows.filter((r) => q.filters.every(([c, test]) => test(r[c])));
    const run = async () => {
      if (q.op === "select") return { data: match().slice(0, q.lim || 1000).map((r) => ({ ...r })), error: null };
      if (failures[q.op]) return { data: null, error: { message: failures[q.op] } };
      if (q.op === "insert") { rows.push({ ...q.patch }); return { data: null, error: null }; }
      if (q.op === "update") { match().forEach((r) => Object.assign(r, q.patch)); return { data: null, error: null }; }
      if (q.op === "delete") { const gone = match(); gone.forEach((r) => rows.splice(rows.indexOf(r), 1)); return { data: null, error: null }; }
    };
    Object.assign(q, {
      select() { return q; },
      ilike(c, p) { const re = likeToRe(p); q.filters.push([c, (v) => re.test(String(v))]); return q; },
      eq(c, v) { q.filters.push([c, (x) => x === v]); return q; },
      limit(n) { q.lim = n; return run(); },
      insert(row) { q.op = "insert"; q.patch = row; return run(); },
      update(p) { q.op = "update"; q.patch = p; return q; },
      delete() { q.op = "delete"; return q; },
      then(a, b) { return run().then(a, b); },
    });
    return q;
  };
}

function world(opts = {}) {
  const tenant = createTenant({ caller: ADMIN });
  tenant.addGroup(GROUP, opts.notOwner ? [] : [ADMIN]);
  const rows = opts.rows || [];
  const failures = {};
  const log = { toasts: [], confirms: [], closed: false, reloads: 0, rpc: [] };
  const answers = opts.answers || [];   // cxConfirm answers, in order (default yes)
  const button = { textContent: "Add Person", disabled: false, dataset: {} };
  const form = {
    "inv-name": "Jane Smith", "inv-email": "jane.smith@hitachirail.com", "inv-template": "tpl-1",
    "inv-subsystem": "", "inv-company": "Hitachi Rail", "inv-admin": false, ...(opts.form || {}),
  };
  async function rpc(url, init) {
    const body = JSON.parse(init.body);
    log.rpc.push({ url, body, auth: init.headers.Authorization });
    if (failures.rpc) return new Response(JSON.stringify({ message: failures.rpc }), { status: 400 });
    const r = rows.find((x) => x.id === body.p_profile_id);
    Object.assign(r, { id: body.p_oid, link_pending: false });
    return new Response(JSON.stringify(r), { status: 200 });
  }
  const ctx = {
    console, crypto: globalThis.crypto, setTimeout, Response, Promise,
    fetch: (url, init) => String(url).startsWith("https://graph.microsoft.com/") ? tenant.fetch(url, init) : rpc(url, init),
    window: {
      location: { origin: "https://portal.example.com", pathname: "/" },
      CX_CONFIG: { IDENTITY: "entra", ENTRA_USERS_GROUP_ID: opts.groupId === undefined ? GROUP : opts.groupId },
      REST_BASE: "https://api.example.com", API_KEY_HEADER: {},
      CXIdentity: { kind: opts.kind || "entra", tokenFor: async () => "graph-token", authHeader: () => "Bearer portal-token",
        createUser: async () => ({ data: { user: { id: "supabase-id" } }, error: null }) },
    },
    document: {
      getElementById: (id) => ({ value: form[id] || "", checked: !!form[id] }),
      querySelector: (sel) => sel === '[data-action="inviteUser"]' ? button : null,
    },
    _sb: { from: profilesTable(rows, failures) },
    modal: () => {}, closeModal: () => { log.closed = true; },
    toast: (m, k) => log.toasts.push({ m, k }),
    cxConfirm: async (text) => { log.confirms.push(text); return answers.length ? answers.shift() : true; },
    _loadDirectoryUsers: () => { log.reloads++; },
    escapeHtml: (s) => String(s), uiCan: () => true,
    SUBSYSTEMS_LIST: ["ATC"], COMPANIES_LIST: ["Hitachi Rail", "BART"],
    currentProfile: { id: ADMIN },
  };
  vm.createContext(ctx);
  vm.runInContext(ADMIN_SRC, ctx, { filename: "cx-entra-admin.js" });
  ctx.window.CXEntraAdmin._delays = [0, 0, 0, 0, 0];
  vm.runInContext(TEAM_SRC, ctx, { filename: "team-invite.js" });
  const members = () => tenant.state.groups.get(GROUP).members;
  const lastToast = () => (log.toasts.at(-1) || {});
  return { ctx, tenant, rows, failures, log, button, members, lastToast };
}

(async () => {
  // ── A. A Hitachi colleague who already has a Microsoft account ──
  let w = world();
  const jane = w.tenant.addUser({ displayName: "Jane Smith", mail: "Jane.Smith@hitachirail.com" });
  await w.ctx.inviteUser();
  let p = w.rows[0];
  ok("Add Person puts a colleague into CX Portal Users in Microsoft", w.members().has(jane.id));
  ok("…and saves their profile under their Microsoft account id, ready to use (nothing to link later)",
    p && p.id === jane.id && p.link_pending === false && p.must_change_password === false && p.is_active === true &&
    p.full_name === "Jane Smith" && p.permission_template_id === "tpl-1" && p.role === "readonly");
  ok("…with no invitation and no question for an existing account", w.tenant.state.invitations.length === 0 && w.log.confirms.length === 0);
  ok("…tells the admin they can sign in now, closes the dialog, refreshes the list",
    /can sign in now/.test(w.lastToast().m) && w.lastToast().k === "success" && w.log.closed && w.log.reloads === 1);
  ok("…and the Add button is usable again", w.button.disabled === false && w.button.textContent === "Add Person");

  // ── B. A BART reviewer with no account: invited as a guest ──
  w = world({ form: { "inv-name": "BART Reviewer", "inv-email": "reviewer@bart.gov", "inv-company": "BART" } });
  await w.ctx.inviteUser();
  p = w.rows[0];
  const guestId = w.tenant.state.invitations.length && [...w.tenant.state.users.values()].find((u) => u.mail === "reviewer@bart.gov").id;
  ok("someone outside Hitachi: the admin is asked before a guest invitation goes out",
    w.log.confirms.length === 1 && /not in your organisation's Microsoft directory/.test(w.log.confirms[0]) && /Invite them as a guest/.test(w.log.confirms[0]));
  ok("…Microsoft emails the invitation", w.tenant.state.invitations.length === 1 && w.tenant.state.invitations[0].sendInvitationMessage === true);
  ok("…the new guest goes into CX Portal Users (after Microsoft's short replication delay)", guestId && w.members().has(guestId));
  ok("…and their profile is saved under the guest account's id", p && p.id === guestId && p.link_pending === false && p.company === "BART");
  ok("…and the admin is told to expect the invitation to be accepted", /invited\. Microsoft has emailed reviewer@bart\.gov/.test(w.lastToast().m));

  // ── C. Declining the invitation ──
  w = world({ form: { "inv-email": "someone@bart.gov" }, answers: [false] });
  await w.ctx.inviteUser();
  ok("declining the guest invitation changes nothing anywhere",
    w.tenant.state.invitations.length === 0 && w.members().size === 0 && w.rows.length === 0 && !w.log.closed &&
    /Nothing was changed/.test(w.lastToast().m));

  // ── D. A typo on Hitachi's own domain ──
  w = world({ form: { "inv-email": "jane.smiht@hitachirail.com" } });
  await w.ctx.inviteUser();
  ok("a Hitachi address with no account is a typo: no guest invited, nothing saved, admin told to check the spelling",
    w.tenant.state.invitations.length === 0 && w.rows.length === 0 && /Check the spelling/.test(w.lastToast().m) && !w.log.closed);

  // ── E. The admin is not an owner of the group ──
  w = world({ notOwner: true });
  w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  await w.ctx.inviteUser();
  ok("an admin Microsoft will not let change the group: nothing saved, and told what IT does",
    w.rows.length === 0 && /owners of that group/.test(w.lastToast().m) && w.lastToast().k === "error" && !w.log.closed);

  // ── F. The portal's save fails after Microsoft said yes ──
  w = world();
  const j2 = w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  w.failures.insert = "duplicate key value violates unique constraint";
  await w.ctx.inviteUser();
  ok("if the profile cannot be saved, the person is taken back out of the group (Microsoft and portal agree)",
    !w.members().has(j2.id) && w.rows.length === 0 && /taken back out of the CX Portal Users group/.test(w.lastToast().m));

  // ── G. …but someone who was already in the group stays there ──
  w = world();
  const j3 = w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  w.members().add(j3.id);
  w.failures.insert = "network error";
  await w.ctx.inviteUser();
  ok("…unless they were already in the group before: then their access is left as it was",
    w.members().has(j3.id) && !/taken back out/.test(w.lastToast().m) && /Profile save failed/.test(w.lastToast().m));

  // ── H/I. Already in the Directory ──
  w = world({ rows: [{ id: "x-1", email: "Jane.Smith@hitachirail.com", link_pending: false, is_active: true }] });
  w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  await w.ctx.inviteUser();
  ok("an email already on the team is refused before anything is asked of Microsoft",
    /already on the team/.test(w.lastToast().m) && w.tenant.state.requests.length === 0);
  w = world({ rows: [{ id: "x-1", email: "jane.smith@hitachirail.com", link_pending: false, is_active: false }] });
  await w.ctx.inviteUser();
  ok("an Inactive person: the admin is pointed to the Active switch instead", /Switch them back to Active/.test(w.lastToast().m));

  // ── J. A profile already waiting (carried over from Supabase) ──
  w = world({ rows: [{ id: "old-supabase-id", email: "jane.smith@hitachirail.com", link_pending: true, is_active: true, full_name: "Jane S" }] });
  const j4 = w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  await w.ctx.inviteUser();
  ok("a waiting profile is connected to the Microsoft account at once, not duplicated",
    w.rows.length === 1 && w.rows[0].id === j4.id && w.rows[0].link_pending === false && w.members().has(j4.id));
  ok("…through the database function, as the signed-in admin",
    w.log.rpc.length === 1 && /\/rpc\/admin_link_profile$/.test(w.log.rpc[0].url) &&
    w.log.rpc[0].body.p_profile_id === "old-supabase-id" && w.log.rpc[0].body.p_oid === j4.id && w.log.rpc[0].auth === "Bearer portal-token");
  ok("…and the admin is told permissions and history are kept", /permissions and history are kept/.test(w.lastToast().m));

  // ── J2. A waiting profile that was switched off ──
  w = world({ rows: [{ id: "old-id", email: "jane.smith@hitachirail.com", link_pending: true, is_active: false }] });
  w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  await w.ctx.inviteUser();
  ok("an Inactive waiting profile is not connected behind the admin's back: switch it to Active first",
    /Switch it to Active, then add them again/.test(w.lastToast().m) && w.tenant.state.requests.length === 0 && w.rows[0].id === "old-id");

  // ── K. The Microsoft account already belongs to someone else's profile ──
  w = world({ rows: [] });
  const j5 = w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  w.rows.push({ id: j5.id, email: "jsmith.old@hitachirail.com", link_pending: false, is_active: true });
  await w.ctx.inviteUser();
  ok("a Microsoft account that already has a profile is refused, and the group is not touched",
    /already belongs to jsmith\.old@hitachirail\.com/.test(w.lastToast().m) && w.members().size === 0 && w.rows.length === 1);

  // ── L. Double-click ──
  w = world();
  const j6 = w.tenant.addUser({ mail: "jane.smith@hitachirail.com" });
  await Promise.all([w.ctx.inviteUser(), w.ctx.inviteUser()]);
  ok("a double-click adds the person once", w.rows.length === 1 && w.members().size === 1 && w.members().has(j6.id));

  // ── Deactivate / reactivate ──
  const PERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const linkedRow = () => ({ id: PERSON, email: "p@hitachirail.com", link_pending: false, is_active: true });
  w = world({ rows: [linkedRow()] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  await w.ctx.updateProfileActive(PERSON, false);
  ok("Inactive: they see no data in the portal AND are taken out of CX Portal Users",
    w.rows[0].is_active === false && !w.members().has(PERSON) && /removed from CX Portal Users in Microsoft/.test(w.lastToast().m));
  await w.ctx.updateProfileActive(PERSON, true);
  ok("Active again: back into CX Portal Users and active in the portal",
    w.rows[0].is_active === true && w.members().has(PERSON) && /can sign in with Microsoft again/.test(w.lastToast().m));

  w = world({ rows: [{ ...linkedRow(), id: ADMIN }] });
  w.members().add(ADMIN);
  await w.ctx.updateProfileActive(ADMIN, false);
  ok("an admin cannot deactivate themselves (no lock-out)",
    w.rows[0].is_active === true && w.members().has(ADMIN) && /cannot deactivate yourself/.test(w.lastToast().m) && w.log.reloads === 1);

  w = world({ rows: [linkedRow()], notOwner: true });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  await w.ctx.updateProfileActive(PERSON, false);
  ok("if Microsoft refuses the removal, they are still deactivated in the portal, and the admin is told what remains",
    w.rows[0].is_active === false && w.members().has(PERSON) && /see no data/.test(w.lastToast().m) && /owners of that group/.test(w.lastToast().m));

  w = world({ rows: [{ ...linkedRow(), is_active: false }], notOwner: true });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" });
  await w.ctx.updateProfileActive(PERSON, true);
  ok("if Microsoft refuses to add them back, the profile stays Inactive (no half-active state)",
    w.rows[0].is_active === false && !w.members().has(PERSON) && w.lastToast().k === "error" && w.log.reloads === 1);

  w = world({ rows: [{ ...linkedRow(), is_active: false }] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" });
  w.failures.update = "permission denied";
  await w.ctx.updateProfileActive(PERSON, true);
  ok("if the portal cannot reactivate them, they are taken back out of the group",
    w.rows[0].is_active === false && !w.members().has(PERSON) && /Update failed/.test(w.lastToast().m));

  // ── Remove ──
  w = world({ rows: [linkedRow()] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  await w.ctx.deleteUserConfirm(PERSON, "Pat");
  ok("Remove asks first, saying Microsoft access goes too", /taken out of the CX Portal Users group in Microsoft/.test(w.log.confirms[0]));
  ok("…then removes them from the group and the Directory",
    !w.members().has(PERSON) && w.rows.length === 0 && /from the portal and from CX Portal Users/.test(w.lastToast().m));

  w = world({ rows: [linkedRow()], answers: [false] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  await w.ctx.deleteUserConfirm(PERSON, "Pat");
  ok("cancelling Remove changes nothing", w.members().has(PERSON) && w.rows.length === 1);

  w = world({ rows: [{ ...linkedRow(), id: ADMIN }] });
  await w.ctx.deleteUserConfirm(ADMIN, "Me");
  ok("an admin cannot remove themselves", w.rows.length === 1 && w.log.confirms.length === 0 && /cannot remove yourself/.test(w.lastToast().m));

  w = world({ rows: [linkedRow()], notOwner: true, answers: [true, false] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  await w.ctx.deleteUserConfirm(PERSON, "Pat");
  ok("if Microsoft refuses, the admin chooses: declining keeps everything as it was",
    w.log.confirms.length === 2 && /did not take Pat out/.test(w.log.confirms[1]) && w.rows.length === 1);
  w = world({ rows: [linkedRow()], notOwner: true, answers: [true, true] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  await w.ctx.deleteUserConfirm(PERSON, "Pat");
  ok("…accepting removes the profile and says IT must finish in Microsoft", w.rows.length === 0 && w.members().has(PERSON) &&
    /until IT removes them from the group/.test(w.log.confirms[1]));

  w = world({ rows: [linkedRow()] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  w.failures.delete = "update or delete on table \"profiles\" violates foreign key constraint";
  await w.ctx.deleteUserConfirm(PERSON, "Pat");
  ok("if the profile cannot be removed, their Microsoft access is restored (still a portal user, consistently)",
    w.rows.length === 1 && w.members().has(PERSON) && /Microsoft access was restored/.test(w.lastToast().m));

  w = world({ rows: [{ id: "waiting-1", email: "never@bart.gov", link_pending: true, is_active: true }] });
  await w.ctx.deleteUserConfirm("waiting-1", "Never Signed In");
  ok("a profile that never signed in is removed without touching Microsoft",
    w.rows.length === 0 && w.tenant.state.requests.length === 0 && /nothing to change in Microsoft/.test(w.log.confirms[0]));

  w = world({ rows: [linkedRow()] });
  w.tenant.addUser({ id: PERSON, mail: "p@hitachirail.com" }); w.members().add(PERSON);
  const realFrom = w.ctx._sb.from;
  w.ctx._sb.from = (t) => { const q = realFrom(t); const lim = q.limit; q.limit = async (n) => (q.op === "select" ? { data: null, error: { message: "network down" } } : lim(n)); return q; };
  await w.ctx.updateProfileActive(PERSON, false);
  ok("if the profile cannot even be read, nothing is changed on either side",
    w.rows[0].is_active === true && w.members().has(PERSON) && /Could not read the profile/.test(w.log.toasts[0].m));

  // ── Without the group configured, and under Supabase: unchanged behaviour ──
  w = world({ groupId: "" });
  await w.ctx.inviteUser();
  ok("without ENTRA_USERS_GROUP_ID: the waiting-profile way, no Graph calls",
    w.rows[0] && w.rows[0].link_pending === true && w.tenant.state.requests.length === 0);
  w = world({ kind: "supabase", rows: [linkedRow()] });
  await w.ctx.updateProfileActive(PERSON, false);
  await w.ctx.deleteUserConfirm(PERSON, "Pat");
  ok("under Supabase sign-in: deactivate and remove are exactly as before, no Graph calls",
    w.tenant.state.requests.length === 0 && w.rows.length === 0 && /Supabase auth account is preserved/.test(w.log.confirms[0]));

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
