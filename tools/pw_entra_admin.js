"use strict";
// Real-browser proof of Directory → add, deactivate, reactivate and remove
// people under Microsoft sign-in, managed from the portal.
//
// Serves the BUILT AZURE PACKAGE (tools/build.js), signs in as a portal
// administrator through a stand-in for Microsoft's MSAL library, and clicks
// through the real screens. Microsoft Graph is answered by the simulated
// tenant in tools/fake_graph.js and the database API by a small in-memory
// PostgREST, both at the network level — so the page's real
// Content-Security-Policy and CORS apply to every request, as they will on
// Azure. After each step it checks BOTH sides: who is in the CX Portal Users
// group in "Microsoft", and what the Directory holds.
//
// Skips cleanly when playwright-core or Chromium is absent.
//   Run: node tools/pw_entra_admin.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("./build.js");
const { createTenant } = require("./fake_graph.js");

const TENANT_ID = "e62c5154-d15d-4c22-a489-aa656aff64a4";
const APP_ID = "a1301867-e12c-43c7-85e2-80cc5bd9d325";
const GROUP = "99999999-9999-4999-8999-999999999999";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) { console.log("SKIPPED: playwright-core not installed (npm install --no-save playwright-core)\n\n0 passed, 0 failed."); process.exit(0); }

function findChromium() {
  const envPath = process.env.CX_CHROMIUM;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const d of fs.readdirSync(base)) for (const n of ["headless_shell", "chrome"]) for (const sub of ["chrome-linux", "chrome-linux64"]) {
      const p = path.join(base, d, sub, n);
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* fall through */ }
  for (const p of ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (fs.existsSync(p)) return p;
  return null;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

// ── the built Azure package, served as static files ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cx-entra-admin-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
let SITE = null;
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(SITE, rel);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── a stand-in for MSAL: an administrator already signed in ──
const FAKE_MSAL = `window.msal = (function () {
  var ACCOUNT = { homeAccountId: '${ADMIN}.${TENANT_ID}', localAccountId: '${ADMIN}', username: 'portal.admin@hitachirail.com',
                  name: 'Portal Admin', idTokenClaims: { oid: '${ADMIN}', preferred_username: 'portal.admin@hitachirail.com', name: 'Portal Admin', amr: ['pwd', 'mfa'] } };
  function result(scopes) {
    var graph = scopes.some(function (s) { return s.indexOf('https://graph.microsoft.com/') === 0; });
    window.__tokenScopes = (window.__tokenScopes || []).concat([scopes]);
    return Promise.resolve({ accessToken: graph ? 'graph-token' : 'portal-token', account: ACCOUNT,
      expiresOn: new Date(Date.now() + 3600000), idTokenClaims: ACCOUNT.idTokenClaims, scopes: scopes });
  }
  function PCA() { this.active = null; }
  PCA.prototype.initialize = function () { return Promise.resolve(); };
  PCA.prototype.handleRedirectPromise = function () { return Promise.resolve(null); };
  PCA.prototype.getAllAccounts = function () { return [ACCOUNT]; };
  PCA.prototype.getActiveAccount = function () { return this.active; };
  PCA.prototype.setActiveAccount = function (a) { this.active = a; };
  PCA.prototype.acquireTokenSilent = function (r) { return result(r.scopes); };
  PCA.prototype.acquireTokenPopup = function (r) { return result(r.scopes); };
  PCA.prototype.acquireTokenRedirect = function () { window.__redirected = true; };
  PCA.prototype.loginRedirect = function () { window.__redirected = true; };
  PCA.prototype.logoutRedirect = function () { return Promise.resolve(); };
  return { PublicClientApplication: PCA };
})();`;

// ── a small in-memory PostgREST for the tables this screen touches ──
function restApi() {
  const db = {
    profiles: [{ id: ADMIN, email: "portal.admin@hitachirail.com", full_name: "Portal Admin", role: "admin", is_active: true,
      must_change_password: false, link_pending: false, permission_template_id: null, company: "Hitachi Rail",
      subsystem: null, mfa_enforced: false, created_at: "2026-01-01T00:00:00Z" }],
    permission_templates: [{ id: "tpl-1", name: "Field Engineer" }],
  };
  const writes = [];
  const likeRe = (pat) => new RegExp("^" + pat.replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]\\])/g,
    (m, esc, wild, re) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : wild ? (wild === "%" ? ".*" : ".") : "\\" + re) + "$", "i");
  function filtersOf(url) {
    const f = [];
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "columns", "on_conflict", "offset"].includes(k)) continue;
      if (v.startsWith("eq.")) f.push((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith("ilike.")) { const re = likeRe(v.slice(6)); f.push((r) => re.test(String(r[k] || ""))); }
      else if (v.startsWith("is.null")) f.push((r) => r[k] == null);
    }
    return f;
  }
  function handle(method, rawUrl, body) {
    const url = new URL(rawUrl);
    const table = url.pathname.replace(/^\//, "");
    if (table.startsWith("rpc/")) {
      writes.push({ method, table, body });
      return { status: 200, body: table === "rpc/claim_profile" ? null : {} };
    }
    const rows = db[table] || [];
    const match = (r) => filtersOf(url).every((t) => t(r));
    if (method === "GET") {
      let out = rows.filter(match);
      const lim = Number(url.searchParams.get("limit") || 0);
      if (lim) out = out.slice(0, lim);
      return { status: 200, body: out };
    }
    writes.push({ method, table, body, query: url.search });
    if (method === "POST") { const add = Array.isArray(body) ? body : [body]; if (db[table]) add.forEach((r) => db[table].push({ created_at: new Date().toISOString(), ...r })); return { status: 201 }; }
    if (method === "PATCH") { rows.filter(match).forEach((r) => Object.assign(r, body)); return { status: 204 }; }
    if (method === "DELETE") { if (db[table]) db[table] = rows.filter((r) => !match(r)); return { status: 204 }; }
    return { status: 400, body: { message: "unsupported" } };
  }
  return { db, writes, handle };
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("SKIPPED: no Chromium binary found\n\n0 passed, 0 failed."); process.exit(0); }

  const cfgFile = path.join(TMP, "azure.config.js");
  fs.writeFileSync(cfgFile, `window.CX_CONFIG = { IDENTITY: 'entra', API_URL: 'https://api.example.test', REST_PATH: '',
  ENTRA_TENANT_ID: '${TENANT_ID}', ENTRA_CLIENT_ID: '${APP_ID}', ENTRA_USERS_GROUP_ID: '${GROUP}' };\n`);
  SITE = build({ out: path.join(TMP, "site"), config: cfgFile, version: "cxp-ad0" }).out;
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;

  const tenant = createTenant({ caller: ADMIN, replicationLag: 1 });
  tenant.addGroup(GROUP, [ADMIN]);
  tenant.state.groups.get(GROUP).members.add(ADMIN);
  const colleague = tenant.addUser({ displayName: "Jane Smith", mail: "Jane.Smith@hitachirail.com", userPrincipalName: "jsmith@hitachirail.com" });
  const rest = restApi();

  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to connect/i.test(t)) problems.push("csp: " + t);
    if (m.type() === "error" && /TypeError|ReferenceError/.test(t)) problems.push("error: " + t);
  });

  await page.route(/\/config\.js$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript",
    body: `window.CX_CONFIG = { IDENTITY: 'entra', API_URL: '${base}', REST_PATH: '', SUPABASE_ANON_KEY: '',
      ENTRA_TENANT_ID: '${TENANT_ID}', ENTRA_CLIENT_ID: '${APP_ID}', ENTRA_REDIRECT_URI: '${base}/',
      ENTRA_USERS_GROUP_ID: '${GROUP}', MSAL_SRC: 'fake-msal.js' };` }));
  await page.route(/\/fake-msal\.js$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_MSAL }));
  // The database API: same origin as the site, tables at the root (bare PostgREST).
  await page.route(new RegExp(`^${base}/(profiles|permission_templates|rpc/[a-z_]+|[a-z_]+)(\\?|$)`), (r) => {
    const req = r.request();
    const res = rest.handle(req.method(), req.url(), req.postData() ? JSON.parse(req.postData()) : undefined);
    r.fulfill({ status: res.status, contentType: "application/json", body: res.body === undefined ? "" : JSON.stringify(res.body) });
  });
  // Microsoft Graph: cross-origin, so it answers CORS like the real service.
  const CORS = { "Access-Control-Allow-Origin": base, "Access-Control-Allow-Headers": "authorization, content-type",
                 "Access-Control-Allow-Methods": "GET, POST, DELETE" };
  await page.route(/^https:\/\/graph\.microsoft\.com\//, (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    const res = tenant.handle(req.method(), req.url(), req.headers(), req.postData() || undefined);
    r.fulfill({ status: res.status, headers: { ...CORS, "Content-Type": "application/json" },
      body: res.status === 204 ? "" : JSON.stringify(res.body) });
  });
  await page.route(/login\.microsoftonline\.com/, (r) => r.abort());

  console.log("=== Directory ↔ Microsoft, in a real browser (Azure package) ===\n");
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 20000 });
  const signedIn = await page.waitForFunction(() => {
    const o = document.getElementById("login-overlay");
    return !o || o.style.display === "none" || o.offsetParent === null;
  }, null, { timeout: 20000 }).then(() => true, () => false);
  ok("the administrator is signed in through Microsoft (stand-in MSAL), no redirect", signedIn && !(await page.evaluate(() => window.__redirected)));

  const toastText = async (re) => page.waitForFunction((src) => {
    const all = [...document.querySelectorAll(".toast")].map((t) => t.textContent);
    return all.find((t) => new RegExp(src).test(t)) || null;
  }, re.source, { timeout: 40000 }).then((h) => h.jsonValue(), () => null);
  const confirmDialog = async (re) => {
    const shown = await page.waitForFunction((src) => {
      const t = document.querySelector(".cx-dialog-text");
      return t && new RegExp(src).test(t.textContent) ? t.textContent : null;
    }, re.source, { timeout: 15000 }).then((h) => h.jsonValue(), () => null);
    if (shown) await page.click('[data-action="_cxDialogFinish"]');
    return shown;
  };
  // The app finishes its own start-up navigation after sign-in; open the
  // Directory until it is the page actually showing (a busy machine boots slower).
  const openDirectory = async () => {
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.showPage("admin-directory"));
      const shown = await page.waitForSelector('[data-action="openInviteUserModal"]', { state: "visible", timeout: 1000 })
        .then(() => true, () => false);
      if (shown) { await page.waitForTimeout(300); if (await page.isVisible('[data-action="openInviteUserModal"]')) return; }
    }
    throw new Error("the Directory page never stayed open");
  };
  const addPerson = async (name, email) => {
    await page.click('[data-action="openInviteUserModal"]');
    await page.waitForSelector("#inv-name", { timeout: 10000 });
    await page.fill("#inv-name", name);
    await page.fill("#inv-email", email);
    await page.selectOption("#inv-template", "tpl-1");
    await page.click('[data-action="inviteUser"]');
  };
  const members = () => tenant.state.groups.get(GROUP).members;
  const profile = (id) => rest.db.profiles.find((p) => p.id === id);

  await openDirectory();
  const modalText = await (async () => {
    await page.click('[data-action="openInviteUserModal"]');
    await page.waitForSelector("#inv-name");
    const t = await page.textContent(".modal, #modal, body");
    await page.click('[data-action="closeModal"]');
    return t || "";
  })();
  ok("Add Person explains the portal adds them to CX Portal Users itself — no IT step",
    /adds them to the CX Portal Users group in Microsoft/.test(modalText) && !/password/i.test((await page.$$eval("#inv-password", (e) => e.length)) ? "password" : ""));

  // ── 1. A colleague who already has a Microsoft account ──
  await addPerson("Jane Smith", "jane.smith@hitachirail.com");
  const t1 = await toastText(/can sign in now/);
  ok("adding a colleague: confirmed on screen", !!t1, t1 || "no toast");
  ok("…they are in CX Portal Users in Microsoft", members().has(colleague.id));
  ok("…and in the Directory under their Microsoft account id, ready to sign in",
    !!profile(colleague.id) && profile(colleague.id).link_pending === false && profile(colleague.id).permission_template_id === "tpl-1");
  const graphScopes = await page.evaluate(() => (window.__tokenScopes || []).filter((s) => s.some((x) => /graph\.microsoft/.test(x))).length);
  ok("…using a Microsoft Graph token obtained without leaving the page", graphScopes > 0 && !(await page.evaluate(() => window.__redirected)));
  ok("…and the new person appears in the Users list",
    await page.waitForFunction((id) => !!document.querySelector(`[data-change="updateProfileActive"][data-args*="${id}"]`), colleague.id,
      { timeout: 10000 }).then(() => true, () => false));

  // ── 2. A BART reviewer with no account: a guest invitation ──
  await addPerson("BART Reviewer", "reviewer@bart.gov");
  const asked = await confirmDialog(/Invite them as a guest/);
  ok("adding someone outside Hitachi asks before inviting them as a guest", !!asked, asked || "no dialog");
  const t2 = await toastText(/invited\. Microsoft has emailed reviewer@bart\.gov/);
  const guest = [...tenant.state.users.values()].find((u) => u.mail === "reviewer@bart.gov");
  ok("…Microsoft sends the invitation, pointing back to the portal",
    !!t2 && tenant.state.invitations.length === 1 && tenant.state.invitations[0].inviteRedirectUrl === `${base}/` &&
    tenant.state.invitations[0].sendInvitationMessage === true);
  ok("…the guest is put in CX Portal Users (after Microsoft's replication delay)", !!guest && members().has(guest.id));
  ok("…and their profile is saved under the guest account id", !!guest && !!profile(guest.id) && profile(guest.id).email === "reviewer@bart.gov");

  // ── 3. Inactive, then Active again ──
  const toggle = (id) => page.click(`[data-change="updateProfileActive"][data-args*="${id}"]`);
  await page.waitForSelector(`[data-change="updateProfileActive"][data-args*="${guest.id}"]`, { timeout: 10000 });
  await toggle(guest.id);
  const t3 = await toastText(/deactivated and removed from CX Portal Users/);
  ok("switching someone to Inactive takes them out of CX Portal Users and blocks their data",
    !!t3 && !members().has(guest.id) && profile(guest.id).is_active === false, t3 || "no toast");
  await page.waitForFunction((id) => { const c = document.querySelector(`[data-change="updateProfileActive"][data-args*="${id}"]`); return c && !c.checked; }, guest.id, { timeout: 10000 }).catch(() => {});
  await toggle(guest.id);
  const t4 = await toastText(/can sign in with Microsoft again/);
  ok("switching them back to Active puts them back in the group", !!t4 && members().has(guest.id) && profile(guest.id).is_active === true);

  // ── 4. Remove ──
  await page.waitForSelector(`[data-action="deleteUserConfirm"][data-args*="${guest.id}"]`, { timeout: 10000 });
  await page.click(`[data-action="deleteUserConfirm"][data-args*="${guest.id}"]`);
  const asked2 = await confirmDialog(/taken out of the CX Portal Users group in Microsoft/);
  const t5 = await toastText(/Removed BART Reviewer from the portal and from CX Portal Users/);
  ok("Remove asks, then takes them out of the group and the Directory",
    !!asked2 && !!t5 && !members().has(guest.id) && !profile(guest.id));

  // ── 5. Safety ──
  ok("the administrator's own account is untouched throughout", members().has(ADMIN) && profile(ADMIN).is_active === true);
  ok("every Microsoft call was a membership reference (…/$ref), never an account deletion",
    tenant.state.disasters.length === 0 && tenant.state.requests.filter((q) => q.method === "DELETE").every((q) => q.path.endsWith("/$ref")));
  ok("no script errors, and the page's security policy allowed every call", problems.length === 0, problems.slice(0, 3).join(" | "));

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
