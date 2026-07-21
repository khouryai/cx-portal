"use strict";
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

  console.log("=== browser smoke — Playwright (Stage B verification) ===\n");
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block" });

  // Seed an authenticated session before any app script runs.
  const session = {
    access_token: "qa-test-token", token_type: "bearer", refresh_token: "qa-refresh",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER,
  };
  await context.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }, [SESSION_KEY, JSON.stringify(session)]);

  const page = await context.newPage();

  // Mock the Supabase layer deterministically. NOTE: Playwright uses the
  // LAST-registered matching route, so register the generic table mock FIRST and
  // the specific profiles mock LAST (so profiles wins). Auth endpoints are mocked
  // so supabase-js doesn't fail-and-signOut (which would wipe our seeded token).
  await page.route(/\/rest\/v1\//i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/0" }, body: "[]" }));
  await page.route(/\/rest\/v1\/profiles/i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([PROFILE]) }));
  await page.route(/\/auth\/v1\/(token|logout|verify)/i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route(/\/auth\/v1\/user/i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(USER) }));
  // The one external CDN script (xlsx, lazy at runtime): abort it so its SRI hash
  // isn't checked against a stub body. Boot does not depend on it.
  await page.route(/cdn\.sheetjs\.com/i, (route) => route.abort());

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });

  // 1) The bundle boots and the delegation dispatcher is present.
  await page.waitForFunction(() => typeof window.CXActions !== "undefined", null, { timeout: 15000 }).catch(() => {});
  const hasDispatcher = await page.evaluate(() => typeof window.CXActions === "object" && typeof window.CXActions.dispatch === "function");
  ok("bundle boots; CXActions dispatcher present", hasDispatcher);

  // 2) The seeded session logs the app in. NOTE: currentRoleUser is a top-level
  //    `let`, so it is NOT on window — the login signal is the overlay being
  //    hidden; the role is read via the global lexical binding.
  let loggedIn = false;
  try {
    await page.waitForFunction(() => {
      const o = document.getElementById("login-overlay");
      return !!o && o.classList.contains("hidden");
    }, null, { timeout: 20000 });
    loggedIn = true;
  } catch (e) { /* fall through to assertion */ }
  ok("seeded session logs the app in (login overlay hidden)", loggedIn);
  if (loggedIn) {
    const role = await page.evaluate(() => (typeof currentRoleUser !== "undefined" && currentRoleUser) ? currentRoleUser.role : null);
    ok("logged-in role is admin", role === "admin", "got " + role);
  }

  // 3) THE KEY TEST: a real data-action="closeModal" button, clicked like a user,
  //    routes through the delegation dispatcher and closes the modal.
  await page.evaluate(() => {
    window.modal({ title: "QA delegation test", body: '<button id="qa-close" data-action="closeModal">Close</button>' });
  });
  const openedActive = await page.evaluate(() => {
    const o = document.getElementById("modal-overlay");
    return !!o && o.classList.contains("active");
  });
  ok("modal() opens an active overlay", openedActive);

  await page.click("#qa-close");
  const closedAfterClick = await page.evaluate(() => {
    const o = document.getElementById("modal-overlay");
    return !!o && !o.classList.contains("active");
  });
  ok("clicking data-action=\"closeModal\" closes the modal (delegation works)", closedAfterClick);

  // 3b) A data-args handler receives the correctly parsed arguments when a real
  //     user clicks it (verifies the full onclick→data-action/data-args path).
  const argRoundTrip = await page.evaluate(async () => {
    let got = null;
    window.CXActions.register("__qaArgProbe", (a, b) => { got = [a, b]; });
    const btn = document.createElement("button");
    btn.setAttribute("data-action", "__qaArgProbe");
    btn.setAttribute("data-args", "[5,\"x\"]");
    btn.id = "qa-arg-probe";
    document.body.appendChild(btn);
    return new Promise((resolve) => {
      btn.addEventListener("click", () => setTimeout(() => resolve(got), 0), { once: true });
      btn.click();
    });
  });
  ok("data-args are parsed and passed to the handler (5,\"x\")",
    Array.isArray(argRoundTrip) && argRoundTrip[0] === 5 && argRoundTrip[1] === "x",
    JSON.stringify(argRoundTrip));

  // 3c) A real DOM `change` event on a data-change element routes through
  //     delegation and the $cx.value sentinel resolves to the live element value.
  const changeSentinel = await page.evaluate(async () => {
    let got = null;
    window.CXActions.register("__qaChangeProbe", (id, val) => { got = [id, val]; });
    const inp = document.createElement("input");
    inp.setAttribute("data-change", "__qaChangeProbe");
    inp.setAttribute("data-args", '["field","$cx.value"]');
    document.body.appendChild(inp);
    inp.value = "user-typed";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => resolve(got), 0));
  });
  ok("real change event + $cx.value sentinel → handler gets live value",
    Array.isArray(changeSentinel) && changeSentinel[0] === "field" && changeSentinel[1] === "user-typed",
    JSON.stringify(changeSentinel));

  // 3d) A real click on an action SEQUENCE runs both handlers in order (chained
  //     inline handler replacement).
  const seqOrder = await page.evaluate(async () => {
    const order = [];
    window.CXActions.register("__qaSeq1", () => order.push("one"));
    window.CXActions.register("__qaSeq2", (v) => order.push("two:" + v));
    const b = document.createElement("button");
    b.setAttribute("data-action", "__qaSeq1;__qaSeq2");
    b.setAttribute("data-args", '[[],["z"]]');
    document.body.appendChild(b);
    b.click();
    return new Promise((r) => setTimeout(() => r(order.join(",")), 0));
  });
  ok("action sequence runs both handlers in order on real click", seqOrder === "one,two:z", seqOrder);

  // 3e) punch-actions.js registered its wrapper actions, and one really triggers
  //     the hidden file input it proxies (hand-refactored punch module).
  const punch = await page.evaluate(async () => {
    const registered = window.CXActions.has("_punchAttachComment") &&
      window.CXActions.has("_punchClickNewPhotoFile") && window.CXActions.has("_punchCaptureCtxPhoto");
    let fired = false;
    const inp = document.createElement("input");
    inp.type = "file"; inp.id = "punch-newphoto-file";
    inp.addEventListener("click", (e) => { e.preventDefault(); fired = true; });
    document.body.appendChild(inp);
    const btn = document.createElement("button");
    btn.setAttribute("data-action", "_punchClickNewPhotoFile");
    document.body.appendChild(btn);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    return { registered, fired };
  });
  ok("punch-actions.js registered its wrapper actions", punch.registered);
  ok("_punchClickNewPhotoFile proxy-clicks the hidden file input", punch.fired);

  // 3f) dyn-actions.js bulk-delete: registered, and deletes each selected
  //     instance + clears the selection (deps stubbed so no real DB/UI needed).
  const bulkDel = await page.evaluate(async () => {
    if (!window.CXActions.has("_dynInstBulkDelete")) return { registered: false };
    const deleted = [];
    window._dbDelete = async (t, m) => { deleted.push(m.id); };
    window.uiCan = () => true;
    window.cxConfirm = async () => true;
    window._dynLoadAll = async () => {};
    window._dynRenderInstances = () => {};
    window._dynRenderBoard = () => {};
    if (typeof _dynPage === "undefined") return { registered: true, noPage: true };
    _dynPage.selInstances = new Set(["i1", "i2", "i3"]);
    _dynPage.tab = "instances";
    await window.CXActions.dispatch({ getAttribute: (k) => (k === "data-action" ? "_dynInstBulkDelete" : null) }, {});
    await new Promise((r) => setTimeout(r, 20));
    return { registered: true, deletedCount: deleted.length, cleared: _dynPage.selInstances.size };
  });
  ok("_dynInstBulkDelete is registered (dyn-actions.js loaded)", bulkDel.registered);
  ok("bulk-delete removes each selected instance (3)", bulkDel.deletedCount === 3, JSON.stringify(bulkDel));
  ok("bulk-delete clears the selection afterward", bulkDel.cleared === 0);

  // 4) Every static data-action rendered in the live DOM resolves to a handler.
  const liveUnresolved = await page.evaluate(() => {
    const names = new Set();
    document.querySelectorAll("[data-action]").forEach((el) => {
      const n = el.getAttribute("data-action");
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    });
    return [...names].filter((n) => !window.CXActions.has(n));
  });
  ok("all data-action elements in the live DOM resolve", liveUnresolved.length === 0,
    liveUnresolved.length ? "unresolved: " + liveUnresolved.join(", ") : "");

  // 5) No uncaught page errors during boot (console.error is our proxy).
  // Filter environment/network noise (mocked backend, aborted CDN script): we
  // assert on genuine app errors only, not the deterministic-mock artifacts.
  const NOISE = /Failed to load resource|net::ERR|status of 4|status of 5|integrity|cdn\.sheetjs|Failed to fetch|supabase\.js/i;
  const realErrors = consoleErrors.filter((t) => !NOISE.test(t));
  ok("no uncaught console errors during boot", realErrors.length === 0,
    realErrors.slice(0, 3).join(" | "));

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed.\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
