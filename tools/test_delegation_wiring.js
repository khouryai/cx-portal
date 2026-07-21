"use strict";
// Delegation wiring guard (Tier 3 #11, Stage B). Every literal
// data-action="name" in the shipped markup must resolve to a real handler once
// the bundle is loaded — otherwise a converted button is silently dead. This
// loads the real bundle headlessly and asserts CXActions.has(name) for each
// distinct literal action found in app.js + index.html. Dynamic names
// (data-action="${…}") are skipped — they can't be checked statically.
// Run: node tools/test_delegation_wiring.js
const fs = require("fs");
const path = require("path");
const { loadApp, ROOT } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load failed in", loadErrorFile, "\n", loadError.message); process.exit(1); }

console.log("=== delegation wiring guard (Tier 3 #11 Stage B) ===\n");

const CXActions = sandbox.CXActions;
ok("CXActions is available on the bundle", CXActions && typeof CXActions.has === "function");

// Collect distinct, static action names from the shipped markup sources.
const RE = /data-action="([a-zA-Z_$][\w$]*)"/g;
const names = new Set();
for (const file of ["app.js", "index.html"]) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  let m;
  while ((m = RE.exec(text)) !== null) names.add(m[1]);
}

console.log(`  Found ${names.size} distinct static data-action name(s).\n`);
ok("at least one data-action exists (Stage B has begun)", names.size >= 1);

const unresolved = [];
for (const name of names) {
  if (!CXActions.has(name)) unresolved.push(name);
}
ok("every static data-action resolves to a handler", unresolved.length === 0,
  unresolved.length ? "unresolved: " + unresolved.join(", ") : "");

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
