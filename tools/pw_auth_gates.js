"use strict";
// Browser proof for the authentication gates (cx-auth-hardening.js).
//
// tools/test_auth_hardening.js pins the DECISIONS; this pins the CONSEQUENCE —
// that a session which should not reach the app really is stopped at the login
// overlay, in a real browser, with the real bundle and the real markup:
//
//   A. password past its six-monthly rotation  → change-password card  (I.2-4-2(20))
//   B. MFA required, no factor enrolled        → enrolment card + QR   (I.2-1-1)
//   C. factor enrolled, session still AAL1     → challenge card        (I.2-1-1)
//   D. compliant account                       → straight into the app
//
// Same shape as tools/pw_smoke.js: local static server, mocked Supabase, no
// network, skips cleanly when playwright-core or Chromium is absent.
//   Run: node tools/pw_auth_gates.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_REF = "uqtwiucxktljhukmgmxg";
const SESSION_KEY = `sb-${PROJECT_REF}-auth-token`;
const USER_ID = "63033c03-d6b9-4954-8f6e-e89ce23a9758";
const EMAIL = "qa-bot@cx-portal.test";

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
  const names = ["headless_shell", "chrome"];
  try {
    for (const d of fs.readdirSync(base)) {
      for (const n of names) {
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

// An unsigned JWT is enough: supabase-js only base64-decodes the payload
// client-side to read the assurance level, it does not verify the signature.
function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64({ alg: "HS256", typ: "JWT" }) + "." +
    b64(Object.assign({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 }, claims)) + ".sig";
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/**
 * Boot the app with a seeded session and a chosen profile/user shape, then
 * report which login card (if any) the gate stopped on.
 */
async function boot(browser, base, opts) {
  const profile = Object.assign({
    id: USER_ID, email: EMAIL, full_name: "QA Automation Bot", role: "admin",
    subsystem: null, is_active: true, must_change_password: false,
    permission_template_id: null, company: "QA",
  }, opts.profile);

  const user = Object.assign({ id: USER_ID, email: EMAIL }, opts.user);
  const session = {
    access_token: opts.accessToken || jwt({ aal: "aal1" }),
    token_type: "bearer", refresh_token: "qa-refresh",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  };

  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(([k, v]) => { try { window.localStorage.setItem(k, v); } catch (e) {} },
    [SESSION_KEY, JSON.stringify(session)]);
  const page = await context.newPage();

  await page.route(/\/rest\/v1\//i, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/0" }, body: "[]" }));
  await page.route(/\/rest\/v1\/rpc\//i, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locked: false, retry_after: 0, remaining: 5 }) }));
  await page.route(/\/rest\/v1\/profiles/i, (r) => {
    // Before supabase_auth_hardening.sql is applied, PostgREST rejects ONLY the
    // queries that name the new columns — app.js's own `select=*` still works.
    if (opts.breakProfileRead && /mfa_enforced/.test(r.request().url())) {
      return r.fulfill({
        status: 400, contentType: "application/json",
        body: JSON.stringify({ message: 'column profiles.mfa_enforced does not exist' }),
      });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profile ? [profile] : []) });
  });
  await page.route(/\/auth\/v1\/factors/i, (r) =>
    r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        id: "factor-qa-1", type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,<svg xmlns='http://www.w3.org/2000/svg'/>",
          secret: "QATESTSECRET234567", uri: "otpauth://totp/qa",
        },
      }),
    }));
  await page.route(/\/auth\/v1\/(token|logout|verify)/i, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route(/\/auth\/v1\/user/i, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.route(/cdn\.sheetjs\.com/i, (r) => r.abort());

  const cspViolations = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
  });

  await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.CXAuth !== "undefined", null, { timeout: 15000 }).catch(() => {});
  // Let the gate's async profile/MFA reads settle.
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => {
    const vis = (id) => {
      const e = document.getElementById(id);
      return !!e && e.style.display !== "none";
    };
    const overlay = document.getElementById("login-overlay");
    return {
      overlayHidden: !!overlay && overlay.classList.contains("hidden"),
      cp: vis("cp-card"),
      mfaChallenge: vis("mfa-card"),
      mfaSetup: vis("mfa-setup-card"),
      cpTitle: (document.getElementById("cp-title") || {}).textContent || "",
      qrSrc: (document.getElementById("mfa-qr") || {}).src || "",
      secret: (document.getElementById("mfa-secret") || {}).textContent || "",
    };
  });
  state.cspViolations = cspViolations;
  await context.close();
  return state;
}

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.log("SKIPPED: no Chromium build found (set CX_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH)");
    console.log("\n0 passed, 0 failed."); process.exit(0);
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

  console.log("=== authentication gates — browser proof ===\n");

  // ── D. the compliant baseline ────────────────────────────────────────────
  const okCase = await boot(browser, base, {
    profile: { password_changed_at: daysAgo(5), mfa_enforced: false },
  });
  ok("compliant account reaches the app", okCase.overlayHidden === true, JSON.stringify(okCase));
  ok("no CSP violations on the login path", okCase.cspViolations.length === 0,
    okCase.cspViolations.slice(0, 2).join(" | "));

  // ── A. password rotation — I.2-4-2(20) ───────────────────────────────────
  const stale = await boot(browser, base, {
    profile: { password_changed_at: daysAgo(400), mfa_enforced: false },
  });
  ok("a password older than six months is stopped at the overlay", stale.overlayHidden === false);
  ok("…on the change-password card", stale.cp === true, JSON.stringify(stale));
  ok("…relabelled as a rotation, not a first login", /change your password/i.test(stale.cpTitle),
    stale.cpTitle);

  const never = await boot(browser, base, {
    profile: { password_changed_at: null, mfa_enforced: false },
  });
  ok("an account with no recorded change date is also stopped", never.cp === true);

  // ── B. MFA enrolment — I.2-1-1 ───────────────────────────────────────────
  const enrol = await boot(browser, base, {
    profile: { password_changed_at: daysAgo(5), mfa_enforced: true },
  });
  ok("MFA-required account with no factor is stopped", enrol.overlayHidden === false);
  ok("…on the enrolment card", enrol.mfaSetup === true, JSON.stringify(enrol));
  ok("…with the QR code rendered", /^data:image\/svg\+xml/.test(enrol.qrSrc), enrol.qrSrc.slice(0, 40));
  ok("…and the manual key shown", enrol.secret === "QATESTSECRET234567", enrol.secret);

  // ── C. MFA challenge — I.2-1-1 ───────────────────────────────────────────
  const challenge = await boot(browser, base, {
    profile: { password_changed_at: daysAgo(5), mfa_enforced: true },
    user: { factors: [{ id: "factor-qa-1", status: "verified", factor_type: "totp", friendly_name: "QA" }] },
    accessToken: jwt({ aal: "aal1" }),
  });
  ok("an enrolled account on a single-factor session is stopped", challenge.overlayHidden === false);
  ok("…on the challenge card", challenge.mfaChallenge === true, JSON.stringify(challenge));

  const cleared = await boot(browser, base, {
    profile: { password_changed_at: daysAgo(5), mfa_enforced: true },
    user: { factors: [{ id: "factor-qa-1", status: "verified", factor_type: "totp", friendly_name: "QA" }] },
    accessToken: jwt({ aal: "aal2" }),
  });
  ok("the same account with a completed second factor gets in", cleared.overlayHidden === true,
    JSON.stringify(cleared));

  // ── deploy-order safety ──────────────────────────────────────────────────
  // The front end ships on every push to main; the migration is applied by
  // hand. Until it is, the gate cannot read its policy — and must not invent
  // one and lock a live site out.
  const preMigration = await boot(browser, base, {
    breakProfileRead: true,
    profile: { password_changed_at: undefined, mfa_enforced: undefined },
  });
  ok("with the migration not yet applied, the app still loads",
    preMigration.overlayHidden === true, JSON.stringify(preMigration));
  ok("…and no gate card is shown",
    preMigration.cp === false && preMigration.mfaSetup === false && preMigration.mfaChallenge === false);

  // …but an already-enrolled user is still challenged, because that decision
  // needs no policy row.
  const enrolledPreMigration = await boot(browser, base, {
    breakProfileRead: true,
    profile: { password_changed_at: undefined, mfa_enforced: undefined },
    user: { factors: [{ id: "factor-qa-1", status: "verified", factor_type: "totp", friendly_name: "QA" }] },
    accessToken: jwt({ aal: "aal1" }),
  });
  ok("…while an enrolled account is still challenged", enrolledPreMigration.mfaChallenge === true,
    JSON.stringify(enrolledPreMigration));

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed.\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("auth-gate smoke crashed:", e); process.exit(1); });
