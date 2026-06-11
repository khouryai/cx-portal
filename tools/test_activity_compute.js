// Characterization tests for the activity status + weighted-completion logic in
// app.js (real functions, loaded headlessly via tools/_load_app.js):
//   _amComputeStatus(act)         — activity rollup status state-machine
//   _amComputeCompletion(act,tcw) — weighted completion {done,total,doneW,totalW,pct}
//   _tcWeightFor(r,tcw) / _actWeightFor(r,aw) — pure weight resolvers
//
// These drive the activity matrix, P6 progress chips and completion %. Pinning
// them guards the business logic and makes a future extraction into a tested
// `compute` module safe. Run: node tools/test_activity_compute.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}
function eq(name, got, want) { ok(`${name} (=${JSON.stringify(want)})`, got === want, `got ${JSON.stringify(got)}`); }

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { _amComputeStatus, _amComputeCompletion, _tcWeightFor, _actWeightFor } = sandbox;
for (const [n, f] of Object.entries({ _amComputeStatus, _amComputeCompletion, _tcWeightFor, _actWeightFor })) {
  if (typeof f !== "function") { console.error(`FATAL: ${n} not found`); process.exit(1); }
}
const map = (o) => new Map(Object.entries(o || {}));

console.log("=== activity compute characterization ===\n");

// ── _amComputeStatus: rollup state-machine ──
console.log("_amComputeStatus:");
eq("  no items → Open", _amComputeStatus({ items: [] }), "Open");
eq("  only parent rows (filtered out) → Open",
   _amComputeStatus({ items: [{ IsParent: true, Status: "Pass" }] }), "Open");
eq("  all Future Test → Future Test",
   _amComputeStatus({ items: [{ Status: "Future Test" }, { Status: "Future Test" }] }), "Future Test");
eq("  all done (Pass/NA/Complete/Passed) → Closed",
   _amComputeStatus({ items: [{ Status: "Pass" }, { Status: "Not Applicable" }, { Status: "Complete" }, { Status: "Passed" }] }), "Closed");
eq("  some done + rest Future → Partial Completion",
   _amComputeStatus({ items: [{ Status: "Pass" }, { Status: "Future Test" }] }), "Partial Completion");
eq("  done + In Progress → Open",
   _amComputeStatus({ items: [{ Status: "Pass" }, { Status: "In Progress" }] }), "Open");
eq("  done + Failed → Open",
   _amComputeStatus({ items: [{ Status: "Pass" }, { Status: "Failed" }] }), "Open");
eq("  done + Future + Blocked → Open (not all done|future)",
   _amComputeStatus({ items: [{ Status: "Pass" }, { Status: "Future Test" }, { Status: "Blocked" }] }), "Open");
eq("  parent excluded, lone child Pass → Closed",
   _amComputeStatus({ items: [{ IsParent: true, Status: "Failed" }, { Status: "Pass" }] }), "Closed");

// ── _amComputeCompletion: weighted completion ──
console.log("\n_amComputeCompletion (explicit tc weights):");
{
  const act = { items: [
    { TestCaseCode: "C", TestName: "T", Status: "Pass" },        // done, w=3
    { TestCaseCode: "C", TestName: "T", Status: "Future Test" }, // not done, w=3 (still in denom)
  ]};
  const r = _amComputeCompletion(act, map({ "C||T": 3 }));
  eq("  done count", r.done, 1);
  eq("  total (Future Test included in denom)", r.total, 2);
  eq("  doneW", r.doneW, 3);
  eq("  totalW", r.totalW, 6);
  eq("  pct = round(doneW/totalW*100)", r.pct, 50);
}
{
  const r = _amComputeCompletion({ items: [{ IsParent: true, Status: "Pass" }] }, map({}));
  eq("  no eligible rows → pct 0", r.pct, 0);
  eq("  no eligible rows → totalW 0", r.totalW, 0);
}
{
  // default weight 1 when key absent: 3 done of 4 → 75%
  const act = { items: [
    { Status: "Pass" }, { Status: "Complete" }, { Status: "Not Applicable" }, { Status: "In Progress" },
  ]};
  const r = _amComputeCompletion(act, map({}));
  eq("  unweighted 3/4 → pct 75", r.pct, 75);
  eq("  done 3", r.done, 3);
  eq("  total 4", r.total, 4);
}

// ── pure weight resolvers ──
console.log("\n_tcWeightFor / _actWeightFor:");
eq("  _tcWeightFor hit", _tcWeightFor({ TestCaseCode: "C", TestName: "T" }, map({ "C||T": 4 })), 4);
eq("  _tcWeightFor miss → default 1", _tcWeightFor({ TestCaseCode: "X", TestName: "Y" }, map({})), 1);
eq("  _actWeightFor hit", _actWeightFor({ Subsystem: "S", Activity: "A" }, map({ "S||A": 5 })), 5);
eq("  _actWeightFor miss → default 1", _actWeightFor({}, map({})), 1);

// ── _apBuildRows: the Test Activities page, now sourced from the real Test
//    Register (grouped TI) instead of data.js actionPlans demo ──
console.log("\n_apBuildRows (Activities page ← real test register):");
{
  const { _apBuildRows } = sandbox;
  ok("  _apBuildRows exists", typeof _apBuildRows === "function");
  vm.runInContext(`TI = ${JSON.stringify([
    { Phase: "2", Location: "W40", Subsystem: "CBTC", Activity: "Wayside Verif", Status: "Pass", TestCaseCode: "C1", TestName: "N1" },
    { Phase: "2", Location: "W40", Subsystem: "CBTC", Activity: "Wayside Verif", Status: "Not Started", TestCaseCode: "C2", TestName: "N2" },
    { Phase: "3", Location: "X10", Subsystem: "DCS", Activity: "DCS SIT", Status: "Pass", TestCaseCode: "C3", TestName: "N3" },
  ])}; _activityWeights = []; _testCaseWeights = [];`, ctx);
  const rows = _apBuildRows();
  eq("  groups TI into activities", rows.length, 2);
  const wv = rows.find((r) => r.Name === "Wayside Verif");
  const dcs = rows.find((r) => r.Name === "DCS SIT");
  eq("  partial activity → Open status", wv.Status, "Open");
  eq("  partial activity → 50% progress", wv.Progress, "50%");
  eq("  carries subsystem/phase/location", `${wv["SubSystem-"]}|${wv.Phase}|${wv.Location}`, "CBTC|2|W40");
  eq("  all-done activity → Closed status", dcs.Status, "Closed");
  eq("  all-done activity → 100% progress", dcs.Progress, "100%");
  eq("  empty TI → no rows", (vm.runInContext(`TI = [];`, ctx), _apBuildRows().length), 0);
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
