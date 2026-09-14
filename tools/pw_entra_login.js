"use strict";
// Browser proof for the AZURE deployment shape, in a real browser with the real
// bundle — the configuration that GitHub Pages never exercises.
//
// Three defects only appeared here, and each one presented as something else:
//
//   1. The generated Azure config.js defined window.CX_CONFIG and nothing else,
//      so window.REST_BASE did not exist. app.js reads REST_BASE as a bare
//      global, so every data call threw ReferenceError before it built a URL,
//      and _checkDbStatus() reported "SYSTEM OFFLINE" over a healthy API.
//   2. app.js's signIn() returns early unless BOTH email and password are
//      filled. Entra users have no password to type, so the button did nothing
//      and window.CXIdentity.signIn was never reached.
//   3. cx-auth-hardening.js wrapped the sign-in path unconditionally. An Entra
//      profile has no password_changed_at, which passwordExpired() treats as
//      expired, so a correct Microsoft sign-in landed on a rotation card whose
//      submit calls updatePassword() — which the Entra provider rejects.
//
// Same shape as tools/pw_auth_gates.js: local static server, no network, skips
// cleanly when playwright-core or Chromium is absent.
//   Run: node tools/pw_entra_login.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TENANT = "e62c5154-d15d-4c22-a489-aa656aff64a4";
const APPID = "a1301867-e12c-43c7-85e2-80cc5bd9d325";

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

/**
 * The config azure/deploy-frontend.sh generates, with the API pointed back at
 * the test server so it is same-origin and the page's own CSP permits it.
 * Values only — that is the contract cx-config.js exists to protect.
 */
function azureConfig(base) {
  return `window.CX_CONFIG = {
  IDENTITY: 'entra',
  ENTRA_TENANT_ID: '${TENANT}',
  ENTRA_CLIENT_ID: '${APPID}',
  ENTRA_API_SCOPE: 'api://${APPID}/access_as_user',
  ENTRA_REDIRECT_URI: '${base}/',
  SUPABASE_URL: '${base}',
  SUPABASE_ANON_KEY: '',
  REST_PATH: '',
};`;
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

  console.log("=== azure / entra deployment shape — browser proof ===\n");

  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();

  const consoleErrors = [];
  const cspViolations = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") consoleErrors.push(t);
    if (/Content Security Policy/i.test(t)) cspViolations.push(t);
  });

  // The Azure config replaces the tracked one, exactly as the deploy does.
  await page.route(/\/config\.js$/, (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: azureConfig(base) }));

  // A bare PostgREST: tables at the ROOT, no /rest/v1 prefix. Anonymous reads
  // come back as an empty array — RLS denying is a healthy API, not a failure.
  await page.route(new RegExp(`^${base}/(profiles|[a-z_]+)\\?`), (r) =>
    r.fulfill({
      status: 200, contentType: "application/json",
      headers: { "content-range": "0-0/0" }, body: "[]",
    }));

  // Nothing should reach Microsoft in a test; fail loudly rather than hang.
  await page.route(/login\.microsoftonline\.com/, (r) => r.abort());

  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.signIn === "function", null, { timeout: 15000 });
  await page.waitForTimeout(600);

  // ── 1. the seam ──────────────────────────────────────────────────────────
  const seam = await page.evaluate(() => ({
    restBase: window.REST_BASE,
    hasHeader: !!window.API_KEY_HEADER,
    headerKeys: Object.keys(window.API_KEY_HEADER || {}),
    kind: window.CXIdentity && window.CXIdentity.kind,
  }));
  ok("window.REST_BASE is defined (the ReferenceError that read as SYSTEM OFFLINE)",
    typeof seam.restBase === "string" && seam.restBase.length > 0, String(seam.restBase));
  ok("REST_BASE has no /rest/v1 prefix on a bare PostgREST",
    seam.restBase === base, seam.restBase);
  ok("window.API_KEY_HEADER is defined", seam.hasHeader);
  ok("…and carries no apikey, since there is no Supabase gateway",
    seam.headerKeys.length === 0, JSON.stringify(seam.headerKeys));
  ok("the entra identity provider is selected", seam.kind === "entra", String(seam.kind));

  // ── 2. the connectivity indicator ────────────────────────────────────────
  await page.waitForFunction(
    () => { const l = document.getElementById("login-db-label"); return l && /ONLINE|OFFLINE|DEGRADED/.test(l.textContent); },
    null, { timeout: 15000 });
  const status = await page.evaluate(() => document.getElementById("login-db-label").textContent.trim());
  ok("the sign-in page reports SYSTEM ONLINE", status === "SYSTEM ONLINE", status);

  // ── 3. the sign-in card ──────────────────────────────────────────────────
  const card = await page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const wrap = (id) => { const e = document.getElementById(id); return e && e.closest ? e.closest(".signin-field") : null; };
    return {
      passwordShown: vis(wrap("auth-password")),
      emailShown: vis(wrap("auth-email")),
      forgotRowShown: vis(document.querySelector("#login-overlay .signin-row")),
      button: (document.getElementById("auth-btn") || {}).textContent,
    };
  });
  ok("the password field is hidden — Entra owns the credential", !card.passwordShown);
  ok("the email field is hidden too", !card.emailShown);
  ok("the 'forgot password?' row is hidden", !card.forgotRowShown);
  ok("the button reads 'Sign in with Microsoft'",
    /Microsoft/.test(card.button || ""), String(card.button));

  // ── 4. the click actually reaches the provider ───────────────────────────
  // This is the regression: it used to stop at "Enter your email and password."
  const reached = await page.evaluate(async () => {
    let called = false;
    window.CXIdentity.signIn = function () { called = true; return Promise.resolve({ data: {}, error: null }); };
    document.getElementById("auth-btn").click();
    await new Promise((r) => setTimeout(r, 300));
    return { called, error: (document.getElementById("auth-error") || {}).textContent || "" };
  });
  ok("clicking Sign In calls CXIdentity.signIn", reached.called);
  ok("…and does not demand a password that does not exist",
    !/email and password/i.test(reached.error), reached.error);

  // ── 5. the password-policy layer stands down ─────────────────────────────
  const stoodDown = await page.evaluate(() => {
    const gate = ["cp-card", "mfa-card", "mfa-setup-card"]
      .map((id) => document.getElementById(id))
      .filter((el) => el && el.offsetParent !== null);
    return { wrapped: !!(window.signIn && window.signIn.__cxWrapped), gates: gate.map((e) => e.id) };
  });
  ok("cx-auth-hardening did not wrap the Entra sign-in path", !stoodDown.wrapped);
  ok("no password/MFA gate card is shown", stoodDown.gates.length === 0, stoodDown.gates.join(", "));

  // ── 6. nothing broke on the way ──────────────────────────────────────────
  const fatal = consoleErrors.filter((e) => /ReferenceError|is not defined|TypeError/.test(e));
  ok("no ReferenceError or TypeError during boot", fatal.length === 0, fatal.slice(0, 3).join(" | "));
  ok("no CSP violations on the Azure login path", cspViolations.length === 0, cspViolations[0]);

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
