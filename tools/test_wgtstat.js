// Characterization test for _wgtStat — the weighted status math that drives the
// headline KPIs (overall completion %, pass rate) on the dashboard and test
// register. This exercises the REAL function from app.js (loaded headlessly via
// tools/_load_app.js), pinning its current behavior so future refactors — or the
// eventual extraction of this logic into its own module — can't silently change
// how project completion is calculated.
//
// _wgtStat(items, awLookup, tcwLookup): effective weight per item =
//   activityWeight(`${Subsystem}||${Activity}`) × testCaseWeight(`${TestCaseCode}||${TestName}`),
// defaulting to 1 when a key is absent. Returns weighted sums bucketed by Status.
//
// Run: node tools/test_wgtstat.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}
function eq(name, got, want) {
  ok(name + ` (=${want})`, got === want, `got ${got}`);
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: bundle failed to load —", loadErrorFile, loadError.message); process.exit(1); }

const _wgtStat = sandbox._wgtStat;
if (typeof _wgtStat !== "function") { console.error("FATAL: _wgtStat not found in app.js"); process.exit(1); }

console.log("=== _wgtStat characterization ===\n");

// Helper to build the lookup Maps the function consumes.
const awMap  = (o) => new Map(Object.entries(o || {}));
const tcwMap = (o) => new Map(Object.entries(o || {}));

// ── Scenario A: effective weight = activityWeight × testCaseWeight ──
{
  const items = [{ Subsystem: "SubA", Activity: "Act1", TestCaseCode: "TC1", TestName: "N1", Status: "Pass" }];
  const r = _wgtStat(items, awMap({ "SubA||Act1": 2 }), tcwMap({ "TC1||N1": 3 }));
  console.log("Scenario A — weight multiplication (2 × 3):");
  eq("  totalW", r.totalW, 6);
  eq("  passW", r.passW, 6);
  eq("  completeW = passW + naW", r.completeW, 6);
  eq("  testedW = passW + failW + blockedW", r.testedW, 6);
  eq("  failW", r.failW, 0);
}

// ── Scenario B: missing keys default to weight 1 ──
{
  const items = [{ Subsystem: "X", Activity: "Y", TestCaseCode: "Z", TestName: "Q", Status: "Pass" }];
  const r = _wgtStat(items, awMap({}), tcwMap({}));
  console.log("\nScenario B — default weight 1 when keys absent:");
  eq("  totalW", r.totalW, 1);
  eq("  passW", r.passW, 1);
}

// ── Scenario C: full status bucketing (all weight 1) ──
{
  const items = [
    { Status: "Pass" },          // passW
    { Status: "Passed" },        // passW (alias)
    { Status: "Complete" },      // passW (alias)
    { Status: "Not Applicable" },// naW
    { Status: "Fail" },          // failW
    { Status: "Failed" },        // failW (alias)
    { Status: "Blocked" },       // blockedW
    { Status: "In Progress" },   // inprogW
    { Status: "Future Test" },   // futureW
    { Status: "Not Started" },   // notStartW
    {},                          // notStartW (no Status)
  ];
  const r = _wgtStat(items, awMap({}), tcwMap({}));
  console.log("\nScenario C — status buckets (all weight 1):");
  eq("  totalW (11 items)", r.totalW, 11);
  eq("  passW (Pass+Passed+Complete)", r.passW, 3);
  eq("  naW (Not Applicable)", r.naW, 1);
  eq("  failW (Fail+Failed)", r.failW, 2);
  eq("  blockedW", r.blockedW, 1);
  eq("  inprogW (In Progress)", r.inprogW, 1);
  eq("  futureW (Future Test)", r.futureW, 1);
  eq("  notStartW (Not Started + missing)", r.notStartW, 2);
  eq("  completeW = passW + naW", r.completeW, 4);
  eq("  testedW = passW + failW + blockedW", r.testedW, 6);
}

// ── Scenario D: weights compound with status buckets ──
{
  const aw  = awMap({ "S||A": 5 });
  const tcw = tcwMap({ "C||T": 2 });          // weight = 10 for matching items
  const items = [
    { Subsystem: "S", Activity: "A", TestCaseCode: "C", TestName: "T", Status: "Pass" },  // 10 → passW
    { Subsystem: "S", Activity: "A", TestCaseCode: "C", TestName: "T", Status: "Fail" },  // 10 → failW
    { Status: "Pass" },                                                                    // 1  → passW
  ];
  const r = _wgtStat(items, aw, tcw);
  console.log("\nScenario D — weighting compounds with buckets:");
  eq("  totalW (10+10+1)", r.totalW, 21);
  eq("  passW (10+1)", r.passW, 11);
  eq("  failW (10)", r.failW, 10);
  eq("  testedW (passW+failW+blockedW = 11+10+0)", r.testedW, 21);
}

// ── Scenario E: empty input is all zeros ──
{
  const r = _wgtStat([], awMap({}), tcwMap({}));
  console.log("\nScenario E — empty input:");
  const allZero = ["totalW","passW","naW","failW","blockedW","inprogW","futureW","notStartW","completeW","testedW"]
    .every((k) => r[k] === 0);
  ok("  every weighted bucket is 0", allZero, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
