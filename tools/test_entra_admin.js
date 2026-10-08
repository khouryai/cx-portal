"use strict";
// cx-entra-admin.js: the Directory screen managing people in Microsoft Entra.
// Run against a simulated tenant (tools/fake_graph.js) that answers the way
// Microsoft's Graph reference documents: only group OWNERS may change
// membership, an existing member answers 400, a just-invited guest is not
// visible to the group for a few seconds, and so on.
//   Run: node tools/test_entra_admin.js
const path = require("path");
const { createTenant } = require("./fake_graph.js");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }
console.log("=== Directory ↔ Microsoft Entra (cx-entra-admin.js) ===\n");

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP = "99999999-9999-4999-8999-999999999999";
const tokenCalls = [];
let tokenBehaviour = null;   // null = fine, else an Error to throw

function setup(opts = {}) {
  const tenant = createTenant({ caller: ADMIN, ...opts });
  tenant.addGroup(GROUP, opts.notOwner ? [] : [ADMIN]);
  global.window = {
    location: { origin: "https://portal.example.com", pathname: "/" },
    CX_CONFIG: { IDENTITY: "entra", ENTRA_USERS_GROUP_ID: opts.groupId === undefined ? GROUP : opts.groupId },
    CXIdentity: {
      kind: opts.kind || "entra",
      tokenFor: async (scopes, o) => {
        tokenCalls.push({ scopes, o });
        const e = typeof tokenBehaviour === "function" ? tokenBehaviour(scopes) : tokenBehaviour;
        if (e) throw e;
        return "graph-token";
      },
    },
  };
  global.fetch = tenant.fetch;
  delete require.cache[require.resolve(path.join(ROOT, "cx-entra-admin.js"))];
  const A = require(path.join(ROOT, "cx-entra-admin.js"));
  A._delays = [0, 0, 0, 0, 0];
  return { A, tenant };
}

(async () => {
  // ── when it is on ──
  let { A, tenant } = setup();
  ok("on under Microsoft sign-in with the group configured", A.enabled() === true);
  ok("off without the group id (falls back to IT adding people)", setup({ groupId: "" }).A.enabled() === false);
  ok("off under Supabase sign-in", setup({ kind: "supabase" }).A.enabled() === false);

  // ── finding people ──
  ({ A, tenant } = setup());
  const staff = tenant.addUser({ displayName: "Jane Smith", mail: "Jane.Smith@HitachiRail.com", userPrincipalName: "jsmith@hitachirail.com" });
  const obrien = tenant.addUser({ displayName: "Pat O'Brien", mail: "pat.o'brien@hitachirail.com" });
  let u = await A.findUser("  jane.smith@hitachirail.com ");
  ok("finds a staff account by mail, ignoring case and spaces", u && u.id === staff.id && u.guest === false);
  ok("…and by sign-in name", (await A.findUser("JSMITH@hitachirail.com")).id === staff.id);
  ok("an apostrophe in an address is escaped, not an injection", (await A.findUser("pat.o'brien@hitachirail.com")).id === obrien.id);
  ok("nobody with that address → null", (await A.findUser("nobody@hitachirail.com")) === null);
  const tok = tokenCalls.at(-1);
  ok("finding someone asks only for User.ReadBasic.All, with a pop-up (never a redirect) if Microsoft needs one",
    tok && tok.o && tok.o.interactive === "popup" && tok.scopes.length === 1 && tok.scopes[0] === "https://graph.microsoft.com/User.ReadBasic.All");
  tenant.addUser({ mail: "dup@hitachirail.com" }); tenant.addUser({ mail: "DUP@hitachirail.com" });
  ok("two accounts with one address is an error, not a guess", (await rejects(A.findUser("dup@hitachirail.com")))?.code === "ambiguous");
  ok("a malformed address is refused before calling Microsoft", (await rejects(A.findUser("not-an-email")))?.code === "bad_email");

  // ── resolving: existing, guest invite, home-domain typo ──
  ({ A, tenant } = setup());
  const known = tenant.addUser({ mail: "known@hitachirail.com" });
  let asked = [];
  const yes = async (a) => { asked.push(a); return true; };
  let acct = await A.resolveAccount("known@hitachirail.com", "Known", yes);
  ok("an existing account is used as is: no invitation, no question", acct.id === known.id && !acct.invited && asked.length === 0 &&
    tenant.state.invitations.length === 0);
  acct = await A.resolveAccount("Reviewer@BART.gov", "BART Reviewer", yes);
  const inv = tenant.state.invitations[0];
  ok("an outside address is invited as a guest, after asking", acct.invited && acct.guest && asked[0] === "reviewer@bart.gov" && !!acct.id);
  ok("…Microsoft sends the invitation email, which brings them back to the portal",
    inv.sendInvitationMessage === true && inv.inviteRedirectUrl === "https://portal.example.com/" &&
    inv.invitedUserEmailAddress === "Reviewer@BART.gov" && inv.invitedUserDisplayName === "BART Reviewer");
  asked = [];
  ok("declining the question invites nobody", (await A.resolveAccount("other@bart.gov", "X", async () => false)) === null &&
    tenant.state.invitations.length === 1);
  const typo = await rejects(A.resolveAccount("jane.smiht@hitachirail.com", "Jane", yes));
  ok("a missing address on the organisation's own domain is a typo, never invited",
    typo && typo.code === "no_account" && tenant.state.invitations.length === 1 && /Check the spelling/.test(A.explain(typo)));

  const perOp = tokenCalls.map((c) => c.scopes.join(" "));
  ok("each operation asks only for its own permission (invite: User.Invite.All; domains: User.Read)",
    perOp.includes("https://graph.microsoft.com/User.Invite.All") && perOp.includes("https://graph.microsoft.com/User.Read") &&
    tokenCalls.every((c) => c.scopes.length === 1));

  // ── IT did not grant guest invitations: everything else still works ──
  ({ A, tenant } = setup());
  tenant.addUser({ id: "abcdefab-1111-4111-8111-111111111111", mail: "staff@hitachirail.com" });
  tokenBehaviour = (scopes) => scopes.some((s) => /User\.Invite\.All$/.test(s))
    ? Object.assign(new Error("AADSTS65001: consent required"), { errorCode: "consent_required" }) : null;
  const staffAcct = await A.resolveAccount("staff@hitachirail.com", "Staff", async () => true);
  const staffAdd = await A.addToGroup(staffAcct.id);
  ok("without the invite permission, adding a colleague still works", staffAdd.added === true);
  const noInvite = await rejects(A.resolveAccount("guest@bart.gov", "Guest", async () => true));
  ok("…and only the guest invitation stops, saying which permission and the way round it",
    noInvite && /invite guests/.test(A.explain(noInvite)) && /User\.Invite\.All/.test(A.explain(noInvite)) &&
    /invite the guest in Entra/.test(A.explain(noInvite)));
  tokenBehaviour = null;

  // ── the group ──
  ({ A, tenant } = setup());
  const p1 = tenant.addUser({ mail: "p1@hitachirail.com" });
  let r = await A.addToGroup(p1.id);
  ok("adds a person to CX Portal Users", r.added === true && tenant.state.groups.get(GROUP).members.has(p1.id));
  r = await A.addToGroup(p1.id);
  ok("adding someone already in it is fine (no error, nothing duplicated)", r.added === false && tenant.state.groups.get(GROUP).members.size === 1);
  const guest = await A.resolveAccount("new.guest@bart.gov", "New Guest", async () => true);
  ok("a just-invited guest is not in the directory yet (Microsoft: replication delay)", tenant.state.lagging.get(guest.id) === 2);
  r = await A.addToGroup(guest.id);
  ok("…so adding them retries until Microsoft has them, then succeeds",
    r.added === true && tenant.state.groups.get(GROUP).members.has(guest.id) &&
    tenant.state.requests.filter((q) => q.method === "POST" && /members/.test(q.path) &&
      q.body["@odata.id"].endsWith(guest.id)).length === 3);   // 2 "doesn't exist yet" + the one that worked
  const posted = tenant.state.requests.filter((q) => q.method === "POST" && /members/.test(q.path)).at(-1);
  ok("…with the documented request: POST …/members/$ref and an @odata.id",
    posted.path === `/groups/${GROUP}/members/$ref` && posted.body["@odata.id"] === `https://graph.microsoft.com/v1.0/directoryObjects/${guest.id}`);
  r = await A.removeFromGroup(p1.id);
  ok("removes a person from CX Portal Users", r.removed === true && !tenant.state.groups.get(GROUP).members.has(p1.id));
  r = await A.removeFromGroup(p1.id);
  ok("removing someone not in it is fine", r.removed === false);
  ok("every removal uses …/$ref, so it can never delete the account itself",
    tenant.state.requests.filter((q) => q.method === "DELETE").every((q) => q.path.endsWith("/$ref")) && tenant.state.disasters.length === 0);
  const before = tenant.state.requests.length;
  ok("an id that is not a Microsoft object id is refused without calling Microsoft",
    (await rejects(A.addToGroup("../users/x")))?.code === "bad_id" && tenant.state.requests.length === before);
  const lost = await rejects(A.addToGroup("12345678-1234-4234-8234-123456789012"));
  ok("an account that never appears gives up after the retries, with an actionable message",
    lost && lost.status === 404 && /not finished creating/.test(A.explain(lost)));

  // ── refusals become sentences an administrator can act on ──
  ({ A, tenant } = setup({ notOwner: true }));
  const p2 = tenant.addUser({ mail: "p2@hitachirail.com" });
  let e = await rejects(A.addToGroup(p2.id));
  ok("not an owner of the group → Microsoft refuses, and the message says what IT does",
    e && e.status === 403 && /owners of that group/.test(A.explain(e)));
  e = await rejects(A.removeFromGroup(p2.id));
  ok("…same for removing", e && e.status === 403 && /owners of that group/.test(A.explain(e)));
  ({ A, tenant } = setup());
  tenant.state.invitesAllowed = false;
  e = await rejects(A.resolveAccount("x@bart.gov", "X", async () => true));
  ok("not allowed to invite guests → says how IT allows it", e && e.status === 403 && /Guest Inviter/.test(A.explain(e)));
  tokenBehaviour = Object.assign(new Error("AADSTS65001: The user or administrator has not consented"), { errorCode: "consent_required" });
  e = await rejects(A.findUser("a@hitachirail.com"));
  ok("no admin consent for the Graph permissions → says so", e && /admin consent/.test(A.explain(e)));
  tokenBehaviour = Object.assign(new Error("Error opening popup window."), { errorCode: "popup_window_error" });
  e = await rejects(A.findUser("a@hitachirail.com"));
  ok("pop-up blocked → asks to allow pop-ups", e && /Allow pop-ups/.test(A.explain(e)));
  tokenBehaviour = Object.assign(new Error("User cancelled the flow."), { errorCode: "user_cancelled" });
  e = await rejects(A.findUser("a@hitachirail.com"));
  ok("Microsoft window closed → nothing changed", e && /nothing was changed/.test(A.explain(e)));
  tokenBehaviour = null;
  tenant.state.failNext = { method: "GET", path: /^\/users$/, status: 429, code: "TooManyRequests" };
  e = await rejects(A.findUser("a@hitachirail.com"));
  ok("throttled → try again shortly", e && /Try again in a minute/.test(A.explain(e)));
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  e = await rejects(A.findUser("a@hitachirail.com"));
  ok("offline → says Microsoft could not be reached", e && e.code === "network" && /Could not reach Microsoft/.test(A.explain(e)));

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
