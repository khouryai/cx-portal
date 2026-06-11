// Unit tests for the dynamic-testing cascade auto-allocator (Increment C),
// exercising the REAL app.js functions via tools/_load_app.js:
//   _dynCascadeAllocate({instances,windows,prereqs,capacityPerWindow})
//   _dynTopoRank(prereqMap)
//
// Covers: zone fit, mode fit, per-shift capacity, prerequisite-chain ordering
// (a dependent run never precedes its prerequisites' runs), backlog leftovers,
// topological ranking, and cycle safety. Run: node tools/test_dyn_cascade.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { _dynCascadeAllocate, _dynTopoRank } = sandbox;
for (const [n, f] of Object.entries({ _dynCascadeAllocate, _dynTopoRank })) {
  if (typeof f !== "function") { console.error(`FATAL: ${n} not found`); process.exit(1); }
}

// ── Fixtures: 3 planned W40 windows (one VATC-only) + 4 runs ───────────────
const windows = [
  { id: "w1", control_zone_code: "W40", shift_date: "2026-06-01", start_at: "2026-06-01T08:00:00Z", end_at: "2026-06-01T10:00:00Z", allowed_modes: ["CBTC", "VATC"], status: "planned" },
  { id: "w2", control_zone_code: "W40", shift_date: "2026-06-02", start_at: "2026-06-02T08:00:00Z", end_at: "2026-06-02T10:00:00Z", allowed_modes: ["CBTC", "VATC"], status: "planned" },
  { id: "w3", control_zone_code: "W40", shift_date: "2026-06-03", start_at: "2026-06-03T08:00:00Z", end_at: "2026-06-03T10:00:00Z", allowed_modes: ["VATC"], status: "planned" },
  { id: "wX", control_zone_code: "W40", shift_date: "2026-06-04", start_at: null, end_at: null, allowed_modes: ["CBTC", "VATC"], status: "cancelled" }, // ignored (not planned)
];
const instances = [
  { id: "iA", test_id: "A", code: "A-1", track_section_under_test: "W40", required_mode: null,   status: "Not Started" },
  { id: "iB", test_id: "B", code: "B-1", track_section_under_test: "W40", required_mode: null,   status: "Not Started" }, // prereq: A
  { id: "iC", test_id: "C", code: "C-1", track_section_under_test: "W40", required_mode: "CBTC", status: "Not Started" }, // CBTC-only
  { id: "iZ", test_id: "Z", code: "Z-1", track_section_under_test: "Y10", required_mode: null,   status: "Not Started" }, // wrong zone
  { id: "iP", test_id: "A", code: "A-2", track_section_under_test: "W40", required_mode: null,   status: "Pass" },        // done → skipped
];
const prereqs = [{ test_id: "B", prerequisite_test_id: "A" }];

const winIdx = id => ({ w1: 0, w2: 1, w3: 2 }[id]);
const findA = (res, instId) => res.assignments.find(a => a.instanceId === instId);

// ── Scenario 1: capacity 1 per window → forces spread across days ──────────
console.log("\n=== Scenario 1: capacity=1 (spread) ===");
{
  const res = _dynCascadeAllocate({ instances, windows, prereqs, capacityPerWindow: 1 });
  ok("iZ (wrong zone) unplaced", res.unplaced.includes("iZ"));
  ok("iP (already Pass) not assigned and not in unplaced", !findA(res, "iP") && !res.unplaced.includes("iP"));
  ok("iA placed", !!findA(res, "iA"));
  ok("iB placed", !!findA(res, "iB"));
  ok("iC placed", !!findA(res, "iC"));
  ok("3 placements total", res.assignments.length === 3, JSON.stringify(res.assignments));
  ok("iA lands in the first window", findA(res, "iA").windowId === "w1");
  ok("iB never precedes its prerequisite A",
     winIdx(findA(res, "iB").windowId) >= winIdx(findA(res, "iA").windowId));
  ok("iC (CBTC-only) avoids the VATC-only window w3", findA(res, "iC").windowId !== "w3");
  ok("cancelled window wX never used", !res.assignments.some(a => a.windowId === "wX"));
}

// ── Scenario 2: capacity 3 → A,B,C can share w1; A must come before B ───────
console.log("\n=== Scenario 2: capacity=3 (same-window prereq order) ===");
{
  const res = _dynCascadeAllocate({ instances, windows, prereqs, capacityPerWindow: 3 });
  const a = findA(res, "iA"), b = findA(res, "iB");
  ok("iA and iB both placed", a && b);
  ok("iB not before iA (window index)", winIdx(b.windowId) >= winIdx(a.windowId));
  if (a.windowId === b.windowId) {
    const order = res.assignments.filter(x => x.windowId === a.windowId).map(x => x.instanceId);
    ok("within the shared window, A is sequenced before B", order.indexOf("iA") < order.indexOf("iB"), order.join(","));
  } else {
    ok("A is in an earlier window than B", winIdx(a.windowId) < winIdx(b.windowId));
  }
  ok("iZ still unplaced (zone)", res.unplaced.includes("iZ"));
}

// ── Scenario 3: no windows → everything to backlog ─────────────────────────
console.log("\n=== Scenario 3: no planned windows ===");
{
  const res = _dynCascadeAllocate({ instances, windows: [windows[3]], prereqs, capacityPerWindow: 3 });
  ok("no assignments", res.assignments.length === 0);
  ok("eligible runs all unplaced (iA,iB,iC)", ["iA", "iB", "iC"].every(id => res.unplaced.includes(id)));
}

// ── Scenario 4: topological rank + cycle safety ────────────────────────────
console.log("\n=== Scenario 4: _dynTopoRank ===");
{
  // chain C → B → A  (C depends on B depends on A)
  const m = new Map([["B", new Set(["A"])], ["C", new Set(["B"])]]);
  const r = _dynTopoRank(m);
  ok("A rank 0 (root)", r.get("A") === 0);
  ok("B rank 1", r.get("B") === 1);
  ok("C rank 2", r.get("C") === 2);

  // cycle A ↔ B must terminate and yield finite ranks
  const cyc = new Map([["A", new Set(["B"])], ["B", new Set(["A"])]]);
  let threw = false, rc = null;
  try { rc = _dynTopoRank(cyc); } catch (_) { threw = true; }
  // NB: rc is a Map built in the vm realm, so cross-realm `instanceof Map` is
  // false even though it's a real Map — assert on the duck-typed API instead.
  ok("cycle does not throw / hang", !threw && rc && typeof rc.get === "function");
  ok("cycle ranks are finite numbers", rc && Number.isFinite(rc.get("A")) && Number.isFinite(rc.get("B")));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
