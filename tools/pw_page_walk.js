"use strict";
// Browser page walk: open EVERY page of the app, signed in, and fail on any
// JavaScript error. Pages come from index.html (<section class="page"
// id="page-…">), so adding or removing a module is covered without editing
// this file. Data calls are mocked (empty tables), like tools/pw_smoke.js.
//
// Written after it found a live router entry for a page whose render
// function no longer existed (Back/Forward or a bookmarked #tcv threw).
// Skips cleanly when playwright-core or Chromium is absent.
//   Run: node tools/pw_page_walk.js
// Browser smoke via Playwright (Tier 2 #8 / the Stage B verification unlock).
// Serves the app from the repo root, seeds an authenticated session into
// localStorage, MOCKS the Supabase REST/auth layer (so the run is deterministic
// and offline — no prod data, no proxy/TLS dependency, identical in CI), boots
// the real bundle "logged in", and drives real UI to verify the event-delegation
// conversions work end-to-end in a real browser.
//
// Skips cleanly when playwright-core or the Chromium build is absent, so it
// never turns a normal `node tools/run_tests.js` run red.
//   Run: node tools/pw_smoke.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_REF = "uqtwiucxktljhukmgmxg";
const SESSION_KEY = `sb-${PROJECT_REF}-auth-token`;
const USER = { id: "63033c03-d6b9-4954-8f6e-e89ce23a9758", email: "qa-bot@cx-portal.test" };
const PROFILE = {
  id: USER.id, email: USER.email, full_name: "QA Automation Bot",
  role: "admin", subsystem: null, is_active: true, must_change_password: false,
  permission_template_id: null, company: "QA",
  // cx-auth-hardening.js gates entry on the six-monthly password rotation, so
  // a fixture account has to look like a compliant one or the boot stops on
  // the "change your password" card instead of the app.
  password_changed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
  mfa_enforced: false,
};

// ── locate playwright-core + a launchable Chromium; skip if missing ──────────
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) { console.log("SKIPPED: playwright-core not installed (npm install --no-save playwright-core)"); console.log("\n0 passed, 0 failed."); process.exit(0); }

function findChromium() {
  const envPath = process.env.CX_CHROMIUM;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const candidates = [];
  try {
    for (const d of fs.readdirSync(base)) {
      if (/headless_shell/.test(d)) candidates.push(path.join(base, d, "chrome-linux", "headless_shell"));
    }
    for (const d of fs.readdirSync(base)) {
      if (/^chromium-/.test(d)) candidates.push(path.join(base, d, "chrome-linux", "chrome"));
    }
  } catch (e) { /* base missing */ }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".pdf": "application/pdf", ".map": "application/json", ".txt": "text/plain",
};

function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

async function main() {
  const exe = findChromium();
  if (!exe) { console.log("SKIPPED: no Chromium build found under PLAYWRIGHT_BROWSERS_PATH"); console.log("\n0 passed, 0 failed."); process.exit(0); }
  console.log("=== browser page walk — every page, signed in ===\n");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const pages = [...html.matchAll(/<section class="page[^"]*" id="page-([a-z0-9-]+)"/g)].map((m) => m[1]).filter((p) => p !== "login");

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const session = {
    access_token: "qa-test-token", token_type: "bearer", refresh_token: "qa-refresh",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER,
  };
  await context.addInitScript(([key, value]) => { try { window.localStorage.setItem(key, value); } catch (e) {} },
    [SESSION_KEY, JSON.stringify(session)]);
  const page = await context.newPage();
  await page.route(/\/rest\/v1\//i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/0" }, body: "[]" }));
  await page.route(/\/rest\/v1\/profiles/i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([PROFILE]) }));
  await page.route(/\/auth\/v1\//i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route(/\/storage\/v1\//i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  let current = "boot";
  const errors = {};
  const note = (msg) => { (errors[current] = errors[current] || []).push(msg); };
  page.on("pageerror", (e) => note(e.message.split("\n")[0]));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|net::ERR|status of 4|status of 5|favicon/i.test(m.text())) note(m.text().slice(0, 200));
  });

  await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
  let loggedIn = false;
  try {
    await page.waitForFunction(() => { const o = document.getElementById("login-overlay"); return !!o && o.classList.contains("hidden"); }, null, { timeout: 20000 });
    loggedIn = true;
  } catch (e) { /* reported below */ }
  ok("signed in with the seeded session", loggedIn);
  await page.waitForTimeout(1200);
  ok("no JavaScript errors while booting", !errors.boot, (errors.boot || []).join(" | "));
  ok("the PDF libraries are not loaded at startup (cx-lazy.js)",
    await page.evaluate(() => typeof window.pdfjsLib === "undefined" && typeof window.PDFLib === "undefined"));

  for (const p of pages) {
    current = p;
    try { await page.evaluate((id) => showPage(id), p); }
    catch (e) { note("showPage threw: " + e.message.split("\n")[0]); }
    await page.waitForTimeout(600);
    ok(`page "${p}" opens without errors`, !errors[p], (errors[p] || []).join(" | "));
  }

  // PDF pages preloaded the libraries; prove both work: build a PDF with
  // pdf-lib, render it with pdf.js (worker included).
  const pdf = await page.evaluate(async () => {
    const [pdfjs, PDFLib] = await Promise.all([CXLazy.pdfjs(), CXLazy.pdflib()]);
    if (!pdfjs || !PDFLib) return { error: "not loaded" };
    const doc = await PDFLib.PDFDocument.create();
    const pg = doc.addPage([200, 100]);
    pg.drawText("cx", { x: 20, y: 40, size: 24, font: await doc.embedFont(PDFLib.StandardFonts.Helvetica) });
    const bytes = await doc.save();
    const loaded = await pdfjs.getDocument({ data: bytes }).promise;
    const p1 = await loaded.getPage(1);
    const text = (await p1.getTextContent()).items.map((i) => i.str).join("");
    return { pages: loaded.numPages, text, worker: pdfjs.GlobalWorkerOptions.workerSrc };
  });
  ok("on demand: pdf-lib builds a PDF and pdf.js renders it (worker set)",
    pdf.pages === 1 && pdf.text === "cx" && /pdf\.worker\.min\.js$/.test(pdf.worker || ""), JSON.stringify(pdf));

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
