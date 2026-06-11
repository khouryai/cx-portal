// Characterization test for _planningTestActivityStats — the core math that
// drives per-cell badges and row-level progress chips for the Lookahead↔Test
// Register Activity link.
//
// Exercises the REAL function from app.js (loaded headlessly via
// tools/_load_app.js); fixtures are injected into the app's actual module state
// (`TI`, `PLANNING_TEST_RESULTS` — both top-level `let`s) through the shared vm
// context. Originally this suite tested a hand-copied re-implementation, which
// could silently drift from app.js — now it can't.
//
// Run from cx-portal directory:  node tools/test_activity_stats.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function ok(name, cond, details = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const _planningTestActivityStats = sandbox._planningTestActivityStats;
if (typeof _planningTestActivityStats !== "function") {
  console.error("FATAL: _planningTestActivityStats not found in app.js"); process.exit(1);
}

function resetFixtures() {
  const TI = [
    { TestID: "t1", Activity: "CBTC Wayside Verification", Status: "Complete" },
    { TestID: "t2", Activity: "CBTC Wayside Verification", Status: "Complete" },
    { TestID: "t3", Activity: "CBTC Wayside Verification", Status: "Failed" },
    { TestID: "t4", Activity: "CBTC Wayside Verification", Status: "Not Started" },
    { TestID: "t5", Activity: "CBTC Wayside Verification", Status: "Not Started" },
    { TestID: "t6", Activity: "DCS SIT - Static",           Status: "Complete" },
    { TestID: "t7", Activity: "DCS SIT - Static",           Status: "Complete" },
    { TestID: "t8", Activity: "IXL Field - Sim Test",       Status: "In Progress" },
  ];
  const PLANNING_TEST_RESULTS = [
    { test_id: "t1", activity: "CBTC Wayside Verification", date_tested: "2026-05-15", result: "Pass" },
    { test_id: "t2", activity: "CBTC Wayside Verification", date_tested: "2026-05-15", result: "Pass" },
    { test_id: "t3", activity: "CBTC Wayside Verification", date_tested: "2026-05-15", result: "Fail" },
    { test_id: "t1", activity: "CBTC Wayside Verification", date_tested: "2026-05-16", result: "Pass" }, // retest
    { test_id: "t6", activity: "DCS SIT - Static",          date_tested: "2026-05-15", result: "Pass" },
    { test_id: "t8", activity: "IXL Field - Sim Test",      date_tested: "2026-05-16", result: "Blocked" },
  ];
  // Reassign the app's real top-level `let` bindings inside the shared context.
  vm.runInContext(
    `TI = ${JSON.stringify(TI)}; PLANNING_TEST_RESULTS = ${JSON.stringify(PLANNING_TEST_RESULTS)};`,
    ctx
  );
}

console.log("\n=== Test 1: Row-level totals (no date) ===");
resetFixtures();
const r1 = _planningTestActivityStats("CBTC Wayside Verification");
ok("5 total test items",                 r1.totalInActivity === 5);
ok("2 complete (Status=Complete)",       r1.completeInActivity === 2);
ok("executedToday=0 for row total",      r1.executedToday === 0);

console.log("\n=== Test 2: Per-cell stats for a specific date ===");
resetFixtures();
const r2 = _planningTestActivityStats("CBTC Wayside Verification", "2026-05-15");
ok("3 unique tests executed",            r2.executedToday === 3, `got ${r2.executedToday}`);
ok("2 passed",                           r2.passed === 2);
ok("1 failed",                           r2.failed === 1);
ok("0 blocked",                          r2.blocked === 0);
ok("total still 5",                      r2.totalInActivity === 5);

console.log("\n=== Test 3: Date with no execution (planned but stale) ===");
resetFixtures();
const r3 = _planningTestActivityStats("CBTC Wayside Verification", "2026-05-20");
ok("0 executed",                         r3.executedToday === 0);
ok("Total still resolves",               r3.totalInActivity === 5);
ok("passed/failed/blocked = 0",          r3.passed === 0 && r3.failed === 0 && r3.blocked === 0);

console.log("\n=== Test 4: Retest counts once per test_id ===");
resetFixtures();
// t1 was tested on both 5/15 and 5/16. On 5/16 we should see 1 unique test, not double-count.
const r4 = _planningTestActivityStats("CBTC Wayside Verification", "2026-05-16");
ok("1 unique test (retest of t1)",       r4.executedToday === 1);
ok("1 pass result",                      r4.passed === 1);

console.log("\n=== Test 5: Different activity returns its own stats ===");
resetFixtures();
const r5 = _planningTestActivityStats("DCS SIT - Static", "2026-05-15");
ok("1 test executed",                    r5.executedToday === 1);
ok("Total = 2 for this activity",        r5.totalInActivity === 2);
ok("1 passed",                           r5.passed === 1);

console.log("\n=== Test 6: Blocked counted correctly ===");
resetFixtures();
const r6 = _planningTestActivityStats("IXL Field - Sim Test", "2026-05-16");
ok("1 blocked",                          r6.blocked === 1);
ok("0 passed",                           r6.passed === 0);

console.log("\n=== Test 7: Unlinked / empty activity returns null ===");
resetFixtures();
ok("null for empty name",                _planningTestActivityStats(null) === null);
ok("null for empty string",              _planningTestActivityStats("") === null);

console.log("\n=== Test 8: Unknown activity returns 0/0 stats ===");
resetFixtures();
const r8 = _planningTestActivityStats("Activity That Does Not Exist", "2026-05-15");
ok("totalInActivity = 0",                r8.totalInActivity === 0);
ok("executedToday = 0",                  r8.executedToday === 0);

console.log("\n=== Test 9: Whitespace-tolerant matching ===");
resetFixtures();
const r9 = _planningTestActivityStats("  CBTC Wayside Verification  ", "2026-05-15");
ok("Trims and matches",                  r9.executedToday === 3);

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
