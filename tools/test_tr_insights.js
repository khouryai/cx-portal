// Characterization test for the Blockers & Failures "Failure Insights" —
// _trComputeBlockerInsights (pure: systemic multi-location failures, fail
// consistency from attempt history, retest-failed flags, staleness, location
// hotspots) plus a render smoke of _trInsightsHTML against seeded TI.
// Run: node tools/test_tr_insights.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load failed in", loadErrorFile, "\n", loadError.message); process.exit(1); }

const compute = sandbox._trComputeBlockerInsights;
ok("_trComputeBlockerInsights is a function", typeof compute === "function");
if (typeof compute !== "function") { process.exit(1); }

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

// Fixture: TC-A fails at 3 of 5 locations (one is a retest failure with prior
// attempts), TC-B blocked at 1 location, TC-C passes everywhere, plus one
// dynamic row and one other-subsystem row that must be excluded.
const rows = [
  // TC-A — exists at 5 locations, currently failing at W40, W42, W44
  { TestID: "a1", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W40", Subsystem: "DCS", Status: "Fail", FailedReason: "Wiring fault", UpdatedAt: iso(20), AttemptNumber: 1 },
  { TestID: "a2", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W42", Subsystem: "DCS", Status: "Fail", FailedReason: "Wiring fault", UpdatedAt: iso(3), AttemptNumber: 2, RegressionGroupId: "a2g" },
  { TestID: "a2p", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W42", Subsystem: "DCS", Status: "Fail", IsLatestAttempt: false, AttemptNumber: 1, RegressionGroupId: "a2g" },
  { TestID: "a3", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W44", Subsystem: "DCS", Status: "Failed", FailedReason: "Sensor gap", UpdatedAt: iso(1), AttemptNumber: 1 },
  { TestID: "a4", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W46", Subsystem: "DCS", Status: "Pass", AttemptNumber: 1 },
  { TestID: "a5", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W48", Subsystem: "DCS", Status: "Pass", AttemptNumber: 1 },
  // TC-B — blocked at one location only
  { TestID: "b1", TestCaseCode: "TC-B", TestName: "Relay Timing", Location: "W40", Subsystem: "DCS", Status: "Blocked", BlockedReason: "No track access", UpdatedAt: iso(2), AttemptNumber: 1 },
  // TC-C — passing everywhere → must NOT appear in cases
  { TestID: "c1", TestCaseCode: "TC-C", TestName: "Clean Case", Location: "W40", Subsystem: "DCS", Status: "Pass" },
  // Excluded: dynamic scope + other subsystem
  { TestID: "d1", TestCaseCode: "TC-D", TestName: "Dyn Case", Location: "W40", Subsystem: "DCS", Status: "Fail", ScopeType: "dynamic" },
  { TestID: "e1", TestCaseCode: "TC-E", TestName: "Other Sub", Location: "W40", Subsystem: "ATS", Status: "Fail" },
  // Parent rollup row — excluded
  { TestID: "p1", TestCaseCode: "TC-A", TestName: "Axle Counter Check", Location: "W40", Subsystem: "DCS", Status: "Fail", IsParent: true },
];

// Punch items linked to test cases — the structured defect record.
const punch = [
  // Two Hardware Failure defects on TC-A (one linked to a prior-attempt TestID)
  { id: "P1", linked_test_ids: ["a1"],        category_of_failure: "Hardware Failure", status: "open" },
  { id: "P2", linked_test_ids: ["a2p", "zz"], category_of_failure: "Hardware Failure", status: "closed" },
  // One uncategorised punch on TC-A → falls back to punch type
  { id: "P3", linked_test_ids: ["a3"],        type: "NCR", status: "open" },
  // Deleted punch on TC-B → excluded entirely
  { id: "P4", linked_test_ids: ["b1"],        category_of_failure: "Environmental", is_deleted: true },
  // Punch linked only to an unknown test id → ignored
  { id: "P5", linked_test_ids: ["nope"],      category_of_failure: "Design Issue" },
  // Punch linked to TWO instances of TC-A — must count once, not twice
  { id: "P6", linked_test_ids: ["a1", "a3"],  category_of_failure: "Software Defect" },
];

console.log("=== _trComputeBlockerInsights (failure insights) ===\n");

const ins = compute(rows, "DCS", punch);

// Systemic multi-location detection
const tcA = ins.cases.find(c => c.code === "TC-A");
ok("TC-A present in cases", !!tcA);
ok("TC-A ranked first (most systemic)", ins.cases[0] && ins.cases[0].code === "TC-A");
ok("TC-A failing at 3 locations", tcA && tcA.openLocs === 3, tcA && "openLocs=" + tcA.openLocs);
ok("TC-A exists at 5 locations total", tcA && tcA.totalLocs === 5, tcA && "totalLocs=" + tcA.totalLocs);
ok("legacy 'Failed' spelling normalised into the count", tcA && tcA.openCount === 3);

// Consistency from attempt history (3 latest fails + 1 frozen prior fail + 2 passes = 4/6)
ok("fail attempts counted across attempt history (4)", tcA && tcA.fails === 4, tcA && "fails=" + tcA.fails);
ok("executed attempts counted (6: 4 fail + 2 pass)", tcA && tcA.attempts === 6, tcA && "attempts=" + tcA.attempts);
ok("failRate ≈ 0.667", tcA && Math.abs(tcA.failRate - 4 / 6) < 1e-9);

// Repeat-offender flag (W42 failed on attempt 2)
ok("TC-A flagged as retest-failed", tcA && tcA.repeat === true);
ok("kpis.repeat = 1", ins.kpis.repeat === 1, "got " + ins.kpis.repeat);

// Top reason = mode of recorded reasons
ok("top reason is the most frequent ('Wiring fault' ×2)", tcA && tcA.topReason === "Wiring fault", tcA && tcA.topReason);

// Blocked-only case included; clean case excluded
const tcB = ins.cases.find(c => c.code === "TC-B");
ok("blocked-only TC-B included with its reason", !!tcB && tcB.topReason === "No track access");
ok("passing TC-C not in cases", !ins.cases.some(c => c.code === "TC-C"));

// Exclusions
ok("dynamic-scope rows excluded", !ins.cases.some(c => c.code === "TC-D"));
ok("other-subsystem rows excluded under the sub lock", !ins.cases.some(c => c.code === "TC-E"));
ok("without a sub lock the other subsystem appears", compute(rows, "").cases.some(c => c.code === "TC-E"));

// KPIs + hotspots
ok("kpis.systemic = 1 (only TC-A spans ≥2 locations)", ins.kpis.systemic === 1, "got " + ins.kpis.systemic);
ok("kpis.stale counts open items >14d (W40 @20d)", ins.kpis.stale === 1, "got " + ins.kpis.stale);
ok("kpis.locations = distinct open locations (3)", ins.kpis.locations === 3, "got " + ins.kpis.locations);
ok("hotspot #1 is W40 with 2 open (TC-A fail + TC-B blocked)",
   ins.hotspots[0] && ins.hotspots[0].loc === "W40" && ins.hotspots[0].n === 2,
   JSON.stringify(ins.hotspots[0]));

// ── Punch-linked defect analytics ────────────────────────────────────────────
ok("TC-A has 4 linked punch defects (incl. prior-attempt link)", tcA && tcA.punchCount === 4, tcA && "punchCount=" + tcA.punchCount);
ok("TC-A top defect is Hardware Failure ×2",
   tcA && tcA.defects[0] && tcA.defects[0].cat === "Hardware Failure" && tcA.defects[0].n === 2,
   tcA && JSON.stringify(tcA.defects));
ok("uncategorised punch falls back to its punch type (NCR)", tcA && tcA.defects.some(d => d.cat === "NCR" && d.n === 1));
ok("punch linked to two instances of one case counts once", tcA && tcA.defects.some(d => d.cat === "Software Defect" && d.n === 1));
ok("deleted punch excluded (TC-B has none)", tcB && tcB.punchCount === 0, tcB && "punchCount=" + tcB.punchCount);
ok("unknown-test punch ignored", !ins.defectCats.some(d => d.cat === "Design Issue"));
ok("kpis.defects totals linked defects on open cases (4)", ins.kpis.defects === 4, "got " + ins.kpis.defects);
ok("defectCats aggregated and sorted (Hardware Failure ×2 first)",
   ins.defectCats[0] && ins.defectCats[0].cat === "Hardware Failure" && ins.defectCats[0].n === 2,
   JSON.stringify(ins.defectCats));
ok("compute without punch arg still works (backward compatible)",
   compute(rows, "DCS").cases.every(c => c.punchCount === 0 && Array.isArray(c.defects)));

// Empty input → empty result, no throw
const empty = compute([], "");
ok("empty input → no cases, zeroed KPIs", empty.cases.length === 0 && empty.kpis.systemic === 0 && empty.kpis.stale === 0 && empty.kpis.defects === 0);

// ── Render smoke: _trInsightsHTML against the real TI binding ────────────────
// TI/currentRoleUser are let-bindings inside the vm context, so reassign them
// with an in-context script rather than a sandbox property.
ctx._fixtureRows = rows;
ctx._fixturePunch = punch;
vm.runInContext("TI = _fixtureRows; PUNCH_DB = _fixturePunch; currentRoleUser = { name: 'T', role: 'admin', subsystem: '' };", ctx);
const html = vm.runInContext("_trInsightsHTML()", ctx);
ok("_trInsightsHTML renders the systemic case", typeof html === "string" && html.includes("TC-A") && html.includes("3 of 5"));
ok("panel shows attempt consistency (4/6)", html.includes("4/6"));
ok("panel shows the RETEST FAILED pill", html.includes("RETEST FAILED"));
ok("panel shows location hotspots", html.includes("Location hotspots") && html.includes("W40"));
ok("KPI header shows systemic + stale counts", html.includes("systemic case") && html.includes("stale"));
ok("panel renders the defect-categories breakdown", html.includes("Defect categories") && html.includes("Hardware Failure"));
ok("case row shows punch defect count, not the free-text reason", html.includes("Hardware Failure ×2") && html.includes("linked punch defect"));
ok("no-punch case falls back to its recorded reason", html.includes("No track access"));
const collapsed = vm.runInContext("_trInsightsOpen = false; _trInsightsHTML();", ctx);
ok("collapsed state renders header only", collapsed.includes("Failure Insights") && !collapsed.includes("Location hotspots"));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
