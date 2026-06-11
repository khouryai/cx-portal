#!/usr/bin/env node
"use strict";
/*
 * Headless test runner for cx-portal.
 *
 * This repo is intentionally package.json-free: it ships as a static site to
 * GitHub Pages (see .github/workflows/deploy.yml, which publishes the repo
 * root verbatim) and loads every library — including dayjs — from a CDN. So
 * there is no `npm test`; the entry point is simply:  node tools/run_tests.js
 *
 * What it does:
 *   1. node --check on the hand-maintained browser sources (CLAUDE.md rule).
 *   2. Runs each headless unit suite under tools/ and aggregates by exit code.
 *
 * The only test-only dependency is `dayjs` (app.js uses it as a browser global;
 * test_copy_paste.js shims it via require). CI installs it with
 *   npm install --no-save dayjs@1.11.13
 * If dayjs is not resolvable locally, that one suite is SKIPPED (not failed) so
 * the deterministic suites still gate the run.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function run(label, cmd, args) {
  process.stdout.write(`\n──── ${label} ────\n`);
  return spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT }).status === 0;
}

// 1) Syntax checks — app.js + photos.js are the CLAUDE.md-mandated ones.
let syntaxOk = true;
for (const f of ["app.js", "photos.js", "markup.js"]) {
  if (!run(`node --check ${f}`, process.execPath, ["--check", f])) syntaxOk = false;
}

// 2) Unit suites (each prints "N passed, M failed" and exits non-zero on fail).
const suites = [
  { file: "tools/smoke_app.js", needs: [] },            // headless boot of data.js + icons.js + app.js
  { file: "tools/test_icons.js", needs: [] },           // extracted icon system
  { file: "tools/test_format.js", needs: [] },          // extracted format utils
  { file: "tools/test_cx_state.js", needs: [] },        // extracted cx* state helpers
  { file: "tools/test_wgtstat.js", needs: [] },         // KPI weighting math (real app.js fn)
  { file: "tools/test_activity_compute.js", needs: [] },// activity status + completion math
  { file: "tools/test_status_compute.js", needs: [] },  // status badges/buckets/lookahead status
  { file: "tools/test_trp_keys.js", needs: [] },        // report key normalization + lookup
  { file: "tools/test_planning_badges.js", needs: [] }, // lookahead cell badges + progress chips
  { file: "tools/test_activity_stats.js", needs: [] },
  { file: "tools/markup_test.js", needs: [] },
  { file: "tools/test_copy_paste.js", needs: ["dayjs"] },
];

const results = [];
for (const s of suites) {
  const missing = s.needs.filter((m) => {
    try { require.resolve(m, { paths: [ROOT] }); return false; }
    catch { return true; }
  });
  if (missing.length) {
    process.stdout.write(
      `\n──── ${s.file} — SKIPPED ` +
      `(missing: ${missing.join(", ")}; run \`npm install --no-save ${missing.join(" ")}\`) ────\n`
    );
    results.push({ file: s.file, status: "skip" });
    continue;
  }
  results.push({ file: s.file, status: run(s.file, process.execPath, [s.file]) ? "pass" : "fail" });
}

const failed = (syntaxOk ? 0 : 1) + results.filter((r) => r.status === "fail").length;
const passed = results.filter((r) => r.status === "pass").length;
const skipped = results.filter((r) => r.status === "skip").length;

console.log(
  `\n==== summary: ${passed} suite(s) passed, ` +
  `${results.filter((r) => r.status === "fail").length} failed, ${skipped} skipped; ` +
  `syntax ${syntaxOk ? "ok" : "FAILED"} ====`
);
process.exit(failed ? 1 : 0);
