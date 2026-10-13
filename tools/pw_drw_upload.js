"use strict";
// Real-browser proof of the Upload Drawing Set modal (drw-upload.js + drw-parse.js):
// a generated drawing set is uploaded through the real UI, read, reviewed and
// imported against a mocked backend.
//   1. CBTC set saved with /Rotate 90 → every sheet read, up-revs handled,
//      the rows posted to drawing_sheets are what the review showed.
//   2. A set whose sheet number sits where nothing finds it → click the text on
//      the drawing to fill page 1, "read from this spot on every page" fills the rest.
// Skips cleanly when playwright-core or Chromium is absent.
//   Run: node tools/pw_drw_upload.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const F = require("./drw_fixtures.js");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_REF = "uqtwiucxktljhukmgmxg";
const SESSION_KEY = `sb-${PROJECT_REF}-auth-token`;
const USER = { id: "63033c03-d6b9-4954-8f6e-e89ce23a9758", email: "qa-bot@cx-portal.test" };
const PROFILE = {
  id: USER.id, email: USER.email, full_name: "QA Automation Bot",
  role: "admin", subsystem: null, is_active: true, must_change_password: false,
  permission_template_id: null, company: "QA",
  password_changed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
  mfa_enforced: false,
};

let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) { console.log("SKIPPED: playwright-core not installed (npm install --no-save playwright-core)"); console.log("\n0 passed, 0 failed."); process.exit(0); }

function findChromium() {
  const envPath = process.env.CX_CHROMIUM;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const candidates = [];
  try {
    for (const d of fs.readdirSync(base)) if (/headless_shell/.test(d)) candidates.push(path.join(base, d, "chrome-linux", "headless_shell"));
    for (const d of fs.readdirSync(base)) if (/^chromium-/.test(d)) candidates.push(path.join(base, d, "chrome-linux", "chrome"));
  } catch (e) { /* base missing */ }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".pdf": "application/pdf" };
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
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); } };

// Sheet number at the top-left corner, no label — automatic reading can't find it.
function oddPage(n) {
  return [
    { s: `XY-100${n}`, x: 60, y: 60, size: 20 },
    { s: "DRAWING TITLE", x: 1700, y: 1600, size: 7 },
    { s: ["RELAY ROOM PLAN", "CABLE SCHEDULE", "GROUNDING PLAN", "EQUIPMENT LAYOUT"][n - 1], x: 1700, y: 1630, size: 16 },
    { s: "REV", x: 2300, y: 1600, size: 7 }, { s: "0", x: 2310, y: 1630, size: 16 },
  ];
}

async function main() {
  const exe = findChromium();
  if (!exe) { console.log("SKIPPED: no Chromium build found under PLAYWRIGHT_BROWSERS_PATH"); console.log("\n0 passed, 0 failed."); process.exit(0); }
  console.log("=== browser: upload a drawing set ===\n");

  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "cx-drw-"));
  const cbtcPdf = path.join(tmp, "cbtc-rotated.pdf"), oddPdf = path.join(tmp, "odd.pdf");
  fs.writeFileSync(cbtcPdf, await F.buildPdf(F.cbtcPages(), "rotate90"));
  fs.writeFileSync(oddPdf, await F.buildPdf([1, 2, 3, 4].map(oddPage)));

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1600, height: 1000 } });
  const session = { access_token: "qa-test-token", token_type: "bearer", refresh_token: "qa-refresh",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER };
  await context.addInitScript(([key, value]) => { try { window.localStorage.setItem(key, value); } catch (e) {} },
    [SESSION_KEY, JSON.stringify(session)]);
  const page = await context.newPage();

  // A location with two current sheets that the upload will up-rev.
  const existing = {
    drawing_sets: [{ id: "old-set", location: "W30 LOOP", title: "Older set", status: "ready", created_at: "2026-01-01" }],
    drawing_sheets: [
      { id: "s1", set_id: "old-set", location: "W30 LOOP", sheet_number: "E11004-W30-001", revision: "0", is_current: true, page_index: 0 },
      { id: "s3", set_id: "old-set", location: "W30 LOOP", sheet_number: "E11004-W30-003", revision: "A", is_current: true, page_index: 2 },
    ],
  };
  const posted = { sets: [], sheets: [] };
  await page.route(/\/rest\/v1\//i, (route) => {
    const req = route.request(), url = req.url();
    const table = (url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
    if (req.method() === "GET" && existing[table]) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(existing[table]) });
    if (req.method() === "POST" && /drawing_sets/.test(url)) {
      const body = JSON.parse(req.postData() || "{}");
      posted.sets.push(body);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify([{ id: "set-" + posted.sets.length, ...body }]) });
    }
    if (req.method() === "POST" && /drawing_sheets/.test(url)) {
      const body = JSON.parse(req.postData() || "[]");
      posted.sheets.push(...(Array.isArray(body) ? body : [body]));
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (req.method() === "PATCH") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "x" }]) });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/0" }, body: "[]" });
  });
  await page.route(/\/rest\/v1\/profiles/i, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([PROFILE]) }));
  await page.route(/\/auth\/v1\//i, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route(/\/storage\/v1\//i, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ Key: "drawings/x" }) }));

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|status of 4|status of 5|favicon/i.test(m.text())) errors.push(m.text().slice(0, 200)); });

  await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const o = document.getElementById("login-overlay"); return !!o && o.classList.contains("hidden"); }, null, { timeout: 20000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => showPage("drawings"));
  await page.waitForFunction(() => DRAWING_SHEETS.length === 2, null, { timeout: 10000 });

  async function startUpload(file, title) {
    await page.evaluate(() => _drwOpenUpload());
    await page.fill("#drw-title", title);
    await page.selectOption("#drw-location", "W30 LOOP");
    await page.setInputFiles("#drw-file-input", file);
    await page.click("button:has-text('Read sheets')");
    await page.waitForSelector("#drw-rev-body", { timeout: 30000 });
    await page.waitForFunction(() => window._drwRevPhrases !== undefined && typeof _drwRevPhrases === "object" && _drwRevPhrases, null, { timeout: 15000 }).catch(() => {});
  }
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#drw-rev-body tr")].map((tr) =>
    ["sheetNumber", "sheetTitle", "revision", "pageNumber"].map((f) => tr.querySelector(`input[data-field="${f}"]`).value)));

  // ── 1. Rotated CBTC set ────────────────────────────────────────────────
  await startUpload(cbtcPdf, "W30 Signal Plans");
  const r1 = await rows();
  const want = F.CBTC_SET.map((p) => [`E11004-W30-00${p.n}`, p.title.join(" "), p.rev, String(p.n)]);
  want[0][2] = "1";   // up-rev: drawing reads 0, current is 0 → next revision
  ok("rotated set: every sheet read in the review table", JSON.stringify(r1) === JSON.stringify(want), JSON.stringify(r1));
  ok("up-rev keeps a newer revision read off the drawing (A → 1, not B)", r1[2][2] === "1");
  const pill = await page.textContent("#drw-needs-pill");
  ok("nothing flagged to check", /All sheets read/.test(pill), pill);
  const boxes = await page.evaluate(() => _drwParsedSheets.every((s) => s.sources.sheetNumber && s.sources.sheetTitle));
  ok("each value knows where on the page it was read", boxes);

  await page.click("button:has-text('Confirm & Import')");
  await page.waitForFunction(() => !document.querySelector("#modal-overlay.active"), null, { timeout: 20000 }).catch(() => {});
  const sheetRows = posted.sheets.map((s) => [s.sheet_number, s.sheet_title, s.revision, s.page_number, s.needs_review]);
  ok("imported rows are what the review showed", JSON.stringify(sheetRows) === JSON.stringify(want.map((w) => [...w, false])), JSON.stringify(sheetRows));
  ok("discipline stored per sheet", posted.sheets.every((s) => s.discipline === "Electrical"));

  // ── 2. Click-to-fill + teach the spot ──────────────────────────────────
  posted.sheets.length = 0;
  existing.drawing_sheets = [];   // a fresh location state for the second upload
  await startUpload(oddPdf, "Odd template");
  let r2 = await rows();
  ok("sheet number not found automatically → flagged", r2.every((r) => r[0] === "") && /4 to check/.test(await page.textContent("#drw-needs-pill")), JSON.stringify(r2));
  ok("titles still read from the DRAWING TITLE label", r2.map((r) => r[1]).join("|") === "RELAY ROOM PLAN|CABLE SCHEDULE|GROUNDING PLAN|EQUIPMENT LAYOUT");

  await page.click('#drw-rev-row-0 input[data-field="sheetNumber"]');
  await page.waitForFunction(() => _drwRevPhrases && _drwRevPhrases.page === 1);
  const pt = await page.evaluate(() => {
    const p = _drwRevPhrases.list.find((x) => x.str === "XY-1001");
    const r = document.getElementById("drw-rev-pdf").getBoundingClientRect();
    return p && { x: r.left + (p.x + p.w / 2) * r.width, y: r.top + (p.y + p.h / 2) * r.height };
  });
  ok("the sheet number is clickable text on the preview", !!pt);
  if (pt) await page.mouse.click(pt.x, pt.y);
  r2 = await rows();
  ok("clicking the text fills the focused field", r2[0][0] === "XY-1001", JSON.stringify(r2[0]));
  ok("…and offers to read that spot on every page", await page.isVisible("#drw-rev-teach"));

  await page.click("#drw-rev-teach");
  await page.waitForFunction(() => { const ins = [...document.querySelectorAll('#drw-rev-body input[data-field="sheetNumber"]')]; return ins.length === 4 && ins.every((i) => i.value); }, null, { timeout: 30000 }).catch(() => {});
  r2 = await rows();
  ok("every page now read from that spot", r2.map((r) => r[0]).join(",") === "XY-1001,XY-1002,XY-1003,XY-1004", JSON.stringify(r2.map((r) => r[0])));
  ok("titles kept after re-reading", r2.map((r) => r[1]).join("|") === "RELAY ROOM PLAN|CABLE SCHEDULE|GROUNDING PLAN|EQUIPMENT LAYOUT");
  ok("the spot is remembered for the location", await page.evaluate(() => !!_drwLoadFieldRegion("W30 LOOP", "sheetNumber")));
  ok("all clear after teaching", /All sheets read/.test(await page.textContent("#drw-needs-pill")));

  // Typing a duplicate sheet number flags both rows; fixing it clears them.
  await page.fill('#drw-rev-row-1 input[data-field="sheetNumber"]', "XY-1001");
  await page.press('#drw-rev-row-1 input[data-field="sheetNumber"]', "Tab");
  ok("a typed duplicate is flagged on both rows", /2 to check/.test(await page.textContent("#drw-needs-pill")) && /also on page 2/.test(await page.textContent("#drw-rev-status-0")));
  await page.fill('#drw-rev-row-1 input[data-field="sheetNumber"]', "XY-1002");
  await page.press('#drw-rev-row-1 input[data-field="sheetNumber"]', "Tab");
  ok("…and cleared when fixed", /All sheets read/.test(await page.textContent("#drw-needs-pill")));
  ok("review says saved boxes are in use", /Using saved boxes: Sheet #/.test(await page.textContent("#modal-overlay .modal-body")));
  await page.click("button:has-text('Forget')");
  await page.waitForFunction(() => { const ins = [...document.querySelectorAll('#drw-rev-body input[data-field="sheetNumber"]')]; return ins.length === 4 && !/Using saved boxes/.test(document.querySelector("#modal-overlay .modal-body").textContent); }, null, { timeout: 30000 }).catch(() => {});
  ok("Forget clears the location's boxes and re-reads", await page.evaluate(() => !_drwLoadFieldRegion("W30 LOOP", "sheetNumber")) && (await rows())[3][0] === "");
  ok("…keeping what was entered by hand", (await rows())[0][0] === "XY-1001" && (await rows())[1][0] === "XY-1002");
  await page.evaluate(() => _drwCloseUpload());

  ok("no JavaScript errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
