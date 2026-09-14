"use strict";
// Browser proof for the STANDARD email/password sign-in on the Azure stack
// (CX_CONFIG.IDENTITY = 'postgrest').
//
// tools/test_local_auth.js proves the database half against a real PostgreSQL:
// login() mints a token whose signature and claims PostgREST will accept. This
// proves the browser half — that the sign-in card the field team already knows
// is still a sign-in card, that submitting it POSTs to /rpc/login, and that the
// session it gets back is stored where every `_db*` helper in app.js looks.
//
// It also pins the two things that differ from the Entra build and would
// otherwise be found the hard way:
//   * the password field must still be VISIBLE (cx-entra-login.js must stand
//     down when the provider manages passwords);
//   * supabase-js's client must have been re-pointed at REST_BASE, or the 59
//     `_sb.from(...)` call sites 404 against a bare PostgREST while the
//     native-fetch calls beside them succeed.
//
// Local server, no network, skips cleanly without playwright-core or Chromium.
//   Run: node tools/pw_local_login.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "alex@hitachirail.com";
const PASSWORD = "Correct-Horse-99!";

let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) {
  console.log("SKIPPED: playwright-core not installed (npm install --no-save playwright-core)");
  console.log("\n0 passed, 0 failed."); process.exit(0);
}

function findChromium() {
  const envPath = process.env.CX_CHROMIUM;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const d of fs.readdirSync(base)) {
      for (const n of ["headless_shell", "chrome"]) {
        for (const sub of ["chrome-linux", "chrome-linux64"]) {
          const p = path.join(base, d, sub, n);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch (e) { /* fall through */ }
  for (const p of ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".avif": "image/avif", ".webmanifest": "application/manifest+json",
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

/** An unsigned JWT: nothing in the browser verifies it, only the server does. */
function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64({ alg: "HS256", typ: "JWT" }) + "." + b64(claims) + ".sig";
}

(async () => {
  const exe = findChromium();
  if (!exe) {
    console.log("SKIPPED: no Chromium binary found");
    console.log("\n0 passed, 0 failed."); process.exit(0);
  }

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

  console.log("=== standard email/password sign-in on the Azure stack ===\n");

  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const allLogs = [];
  const consoleErrors = [];
  const cspViolations = [];
  page.on("console", (m) => {
    const t = m.text();
    allLogs.push(m.type() + ': ' + t);
    if (m.type() === "error") consoleErrors.push(t);
    if (/Content Security Policy/i.test(t)) cspViolations.push(t);
  });

  // The config azure/deploy-frontend.sh generates with IDENTITY=postgrest, with
  // the API pointed back at the test server so the page's own CSP permits it.
  await page.route(/\/config\.js$/, (r) => r.fulfill({
    status: 200, contentType: "text/javascript",
    body: `window.CX_CONFIG = {
      IDENTITY: 'postgrest',
      SUPABASE_URL: '${base}',
      SUPABASE_ANON_KEY: '',
      REST_PATH: '',
    };`,
  }));

  // Record what the page actually sends to /rpc/login.
  let loginBody = null;
  await page.route(new RegExp(`^${base}/rpc/login`), (r) => {
    try { loginBody = JSON.parse(r.request().postData() || "{}"); } catch (e) { loginBody = null; }
    const bad = !loginBody || loginBody.p_password !== PASSWORD;
    if (bad) {
      return r.fulfill({
        status: 400, contentType: "application/json",
        body: JSON.stringify({ message: "Invalid login credentials", code: "28P01" }),
      });
    }
    return r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        access_token: jwt({ sub: UID, role: "authenticated", roles: ["authenticated"], aal: "aal1",
                            email: EMAIL, exp: Math.floor(Date.now() / 1000) + 28800 }),
        token_type: "bearer", expires_in: 28800,
        expires_at: Math.floor(Date.now() / 1000) + 28800,
        user: { id: UID, email: EMAIL, user_metadata: { full_name: "Alex Khoury" },
                app_metadata: { provider: "postgrest" } },
      }),
    });
  });

  // Tables at the ROOT — a bare PostgREST, no /rest/v1 prefix. Anything that
  // asks for /rest/v1/... is a call site still using the unpatched client.
  const restV1Hits = [];
  await page.route(new RegExp(`^${base}/rest/v1/`), (r) => {
    restV1Hits.push(r.request().url());
    return r.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  // The profile row MUST come back: app.js signs a user straight back out when
  // _loadCurrentProfile finds none, which is correct behaviour (no profile means
  // no access) and makes a stub that returns [] look like a broken sign-in.
  const PROFILE = {
    id: UID, email: EMAIL, full_name: "Alex Khoury", role: "admin", subsystem: null,
    is_active: true, must_change_password: false, mfa_enforced: false,
    password_changed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    permission_template_id: null, company: "Hitachi Rail",
  };
  await page.route(new RegExp(`^${base}/profiles(\\?|$)`), (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
                headers: { "content-range": "0-0/1" }, body: JSON.stringify([PROFILE]) }));
  // cx-auth-hardening.js consults the lockout gate before every sign-in.
  await page.route(new RegExp(`^${base}/rpc/auth_login_gate`), (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
                body: JSON.stringify({ locked: false, retry_after: 0, remaining: 5 }) }));
  // Everything else: an empty table. Deliberately NOT matching /rpc/, because
  // playwright resolves routes in reverse registration order and a catch-all
  // registered after /rpc/login would swallow the sign-in itself.
  await page.route(new RegExp(`^${base}/(?!rpc/|profiles)[a-z_]+(\\?|$)`), (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
                headers: { "content-range": "0-0/0" }, body: "[]" }));

  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.signIn === "function", null, { timeout: 15000 });
  await page.waitForTimeout(600);

  // ── 1. the provider and the seam ─────────────────────────────────────────
  const seam = await page.evaluate(() => ({
    kind: window.CXIdentity && window.CXIdentity.kind,
    managesPasswords: window.CXIdentity && window.CXIdentity.managesPasswords,
    managesMfa: window.CXIdentity && window.CXIdentity.managesMfa,
    restBase: window.REST_BASE,
    clientRest: window._sb && window._sb.rest && String(window._sb.rest.url),
  }));
  ok("the postgrest identity provider is selected", seam.kind === "postgrest", String(seam.kind));
  ok("it declares that it manages passwords", seam.managesPasswords === true);
  ok("…and that it does NOT provide TOTP", seam.managesMfa === false);
  ok("supabase-js's REST url was re-pointed at REST_BASE",
    seam.clientRest === seam.restBase, `${seam.clientRest} vs ${seam.restBase}`);

  // ── 2. the sign-in card is a NORMAL sign-in card ─────────────────────────
  const card = await page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    return {
      email: vis(document.getElementById("auth-email")),
      password: vis(document.getElementById("auth-password")),
      button: (document.getElementById("auth-btn") || {}).textContent,
    };
  });
  ok("the email field is visible", card.email);
  ok("the PASSWORD field is visible — cx-entra-login.js stood down", card.password);
  ok("the button still reads 'Sign In', not 'Sign in with Microsoft'",
    /Sign In/i.test(card.button || "") && !/Microsoft/i.test(card.button || ""), String(card.button));

  // ── 3. a wrong password is reported, not swallowed ───────────────────────
  await page.fill("#auth-email", EMAIL);
  await page.fill("#auth-password", "not-the-password");
  await page.click("#auth-btn");
  await page.waitForTimeout(600);
  const errText = await page.evaluate(() => (document.getElementById("auth-error") || {}).textContent || "");
  ok("a wrong password surfaces the database's own message",
    /Invalid login credentials/i.test(errText), errText);
  ok("…and the button is re-enabled so it can be retried",
    await page.evaluate(() => !document.getElementById("auth-btn").disabled));

  // ── 4. the real thing ────────────────────────────────────────────────────
  await page.fill("#auth-password", PASSWORD);
  await page.click("#auth-btn");
  await page.waitForTimeout(900);

  if (process.env.CX_DEBUG) console.log("\n--- console ---\n" + allLogs.slice(-40).join("\n") + "\n");
  ok("submitting POSTs to /rpc/login", !!loginBody);
  ok("…with the parameter names the SQL function declares",
    !!loginBody && loginBody.p_email === EMAIL && loginBody.p_password === PASSWORD,
    JSON.stringify(loginBody));

  const stored = await page.evaluate(() => {
    const key = window.CXIdentity.storageKey();
    let raw = null;
    try { raw = localStorage.getItem(key); } catch (e) {}
    return { key: key, session: raw ? JSON.parse(raw) : null, header: window.CXIdentity.authHeader() };
  });
  ok("the session is persisted under the provider's storage key",
    !!stored.session && stored.session.user.id === UID, stored.key);
  ok("authHeader() returns the bearer token app.js's _db* helpers send",
    /^Bearer eyJ/.test(stored.header || ""), (stored.header || "").slice(0, 20));

  const overlayHidden = await page.evaluate(() =>
    document.getElementById("login-overlay").classList.contains("hidden"));
  ok("the login overlay is dismissed — the user is in", overlayHidden);

  // ── 5. nothing is still speaking Supabase's URL shape ────────────────────
  ok("no request went to /rest/v1/ — every call site uses the bare root",
    restV1Hits.length === 0, restV1Hits.slice(0, 3).join(", "));
  const fatal = consoleErrors.filter((e) => /ReferenceError|is not defined/.test(e));
  ok("no ReferenceError during boot or sign-in", fatal.length === 0, fatal.slice(0, 2).join(" | "));
  ok("no CSP violations on the sign-in path", cspViolations.length === 0, cspViolations[0]);

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
