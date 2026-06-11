// Unit test for the UI permission-gating layer in perms-admin.js (P4-1a):
//   PAGE_MODULE — nav page → permission-module mapping
//   uiCan(module, action) — signed-in user's effective check
//
// Also enforces two integrity invariants:
//   1. every nav-link data-page in index.html is either mapped or a known
//      non-module page (login) — so new nav entries can't silently bypass gating;
//   2. every mapped module key is a real perm_modules catalog key — so a typo
//      can't silently hide (or fail to hide) a page.
//
// Run: node tools/test_ui_can.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadApp, ROOT } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { PAGE_MODULE, uiCan } = sandbox;
if (!PAGE_MODULE || typeof uiCan !== "function") { console.error("FATAL: gating layer not found"); process.exit(1); }

// The 22 module keys of the live perm_modules catalog (P1-2 seed).
const CATALOG = new Set([
  "overview", "test_register", "dynamic_testing", "test_reporting", "punch_list",
  "rma", "forms", "photos", "meetings", "planning", "lookahead", "schedule_p6",
  "assets", "track_plan", "drawings", "locations", "directory", "templates",
  "weights", "config", "audit", "admin",
]);
// Nav entries that intentionally have no permission module.
const NON_MODULE_PAGES = new Set(["login"]);

console.log("=== UI permission gating (uiCan / PAGE_MODULE) ===\n");

console.log("mapping integrity:");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const navPages = [...new Set([...html.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]))];
  const unmapped = navPages.filter((p) => !PAGE_MODULE[p] && !NON_MODULE_PAGES.has(p));
  ok(`  every nav data-page is mapped or known non-module (${navPages.length} pages)`,
     unmapped.length === 0, "unmapped: " + unmapped.join(", "));
  const badTargets = Object.entries(PAGE_MODULE).filter(([, mod]) => !CATALOG.has(mod));
  ok("  every mapped module is a real catalog key",
     badTargets.length === 0, "bad: " + badTargets.map(([p, m]) => `${p}→${m}`).join(", "));
}

console.log("\nuiCan semantics:");
vm.runInContext(`_myPerms = 'admin';`, ctx);
ok("  global admin marker → everything", uiCan("audit", "delete") && uiCan("anything", "manage"));

vm.runInContext(`_myPerms = null;`, ctx);
ok("  not loaded / load failed → fail-open (UI only; RLS enforces)",
   uiCan("audit", "view") && uiCan("test_register", "delete"));

vm.runInContext(`_myPerms = new Map(Object.entries({
  test_register: ['view','export','create','edit'],
  punch_list: ['view','export'],
}));`, ctx);
ok("  granted module+action → true", uiCan("test_register", "edit"));
ok("  default action is 'view'", uiCan("punch_list"));
ok("  module present, action absent → false", uiCan("punch_list", "create") === false);
ok("  module absent from perms → false", uiCan("audit", "view") === false);

console.log("\nfeature predicates (real app.js fns now driven by uiCan):");
{
  const { _trpCanManage, _trpCanView } = sandbox;
  ok("  predicates exist", typeof _trpCanManage === "function" && typeof _trpCanView === "function");

  vm.runInContext(`_myPerms = new Map(Object.entries({ test_reporting: ['view','export'] }));`, ctx);
  ok("  read_only-style perms: view yes, manage no", _trpCanView() === true && _trpCanManage() === false);

  vm.runInContext(`_myPerms = new Map(Object.entries({ test_reporting: ['view','export','create','edit'] }));`, ctx);
  ok("  standard-style perms: manage yes", _trpCanManage() === true);

  vm.runInContext(`_myPerms = new Map();`, ctx);
  ok("  no module grant: view no", _trpCanView() === false);

  vm.runInContext(`_myPerms = 'admin';`, ctx);
  ok("  global admin: both yes", _trpCanManage() === true && _trpCanView() === true);
  vm.runInContext(`_myPerms = null;`, ctx);
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
