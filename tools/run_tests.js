#!/usr/bin/env node
"use strict";
/*
 * Headless test runner for the construction planner.
 *
 * Same shape as cx-portal's tools/run_tests.js. This repo is intentionally
 * package.json-free — it ships as a static site and vendors its libraries — so
 * there is no `npm test`. The entry point is simply:
 *
 *     node tools/run_tests.js
 *
 * 1. node --check on every hand-written browser source (catches syntax errors
 *    that would otherwise only show as a blank page).
 * 2. Runs each headless suite under tools/ and aggregates by exit code.
 *
 * Must exit 0 before you commit. Add every new cxc-*.js to SOURCES and every
 * new tools/test_*.js to SUITES.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function run(label, args) {
  process.stdout.write(`\n──── ${label} ────\n`);
  return spawnSync(process.execPath, args, { stdio: "inherit", cwd: ROOT }).status === 0;
}

// 1) Syntax-check every cxc-*.js at the repo root (auto-discovered, so a new
//    module is covered the moment it exists).
const SOURCES = fs.readdirSync(ROOT).filter((f) => /^cxc-.*\.js$/.test(f)).sort();
let syntaxOk = true;
for (const f of SOURCES) {
  if (!run(`node --check ${f}`, ["--check", f])) syntaxOk = false;
}
if (!SOURCES.length) console.log("\n(no cxc-*.js sources found at the repo root)");

// 2) Unit suites.
const SUITES = [
  "tools/test_cxc_model.js",     // durations, window budgets, the packer
  "tools/test_cxc_data.js",      // entity schema, seed, CRUD, validation
  "tools/test_cxc_timeline.js",  // Gantt geometry: bars, sub-lanes, axis
];

const results = [];
for (const s of SUITES) {
  if (!fs.existsSync(path.join(ROOT, s))) {
    console.log(`\n──── ${s} — MISSING ────`);
    results.push({ file: s, status: "fail" });
    continue;
  }
  results.push({ file: s, status: run(s, [s]) ? "pass" : "fail" });
}

const failedCount = results.filter((r) => r.status === "fail").length;
const passedCount = results.filter((r) => r.status === "pass").length;

console.log(
  `\n==== summary: ${passedCount} suite(s) passed, ${failedCount} failed; ` +
  `syntax ${syntaxOk ? "ok" : "FAILED"} (${SOURCES.length} file(s)) ====`
);
process.exit(failedCount || !syntaxOk ? 1 : 0);
