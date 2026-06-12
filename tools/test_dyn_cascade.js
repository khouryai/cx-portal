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

// ── Scenario 5: start-point area clustering (soft grouping) ────────────────
console.log("\n=== Scenario 5: start-area clustering ===");
{
  const w2 = [
    { id: "g1", control_zone_code: "W40", shift_date: "2026-07-01", start_at: "2026-07-01T08:00:00Z", end_at: "2026-07-01T10:00:00Z", allowed_modes: ["CBTC", "VATC"], status: "planned" },
    { id: "g2", control_zone_code: "W40", shift_date: "2026-07-02", start_at: "2026-07-02T08:00:00Z", end_at: "2026-07-02T10:00:00Z", allowed_modes: ["CBTC", "VATC"], status: "planned" },
  ];
  // Two start areas: W45-* and W37-* (no prereqs/modes → only area should cluster).
  const runs = [
    { id: "m1", test_id: "tM1", code: "M1", track_section_under_test: "W40", start_point: "W45-J", required_mode: null, status: "Not Started" },
    { id: "n1", test_id: "tN1", code: "N1", track_section_under_test: "W40", start_point: "W37-C", required_mode: null, status: "Not Started" },
    { id: "m2", test_id: "tM2", code: "M2", track_section_under_test: "W40", start_point: "W45-L", required_mode: null, status: "Not Started" },
    { id: "n2", test_id: "tN2", code: "N2", track_section_under_test: "W40", start_point: "W37-E", required_mode: null, status: "Not Started" },
  ];
  const res = _dynCascadeAllocate({ instances: runs, windows: w2, prereqs: [], capacityPerWindow: 2 });
  const area = id => ({ m1: "W45", m2: "W45", n1: "W37", n2: "W37" }[id]);
  const perWin = {};
  for (const a of res.assignments) (perWin[a.windowId] = perWin[a.windowId] || []).push(a.instanceId);
  ok("all 4 runs placed", res.assignments.length === 4, JSON.stringify(res.assignments));
  const winAreas = Object.values(perWin).map(ids => new Set(ids.map(area)));
  ok("each shift holds a single start area", winAreas.every(s => s.size === 1), JSON.stringify(perWin));
  ok("the two shifts cover different areas",
     winAreas.length === 2 && [...winAreas[0]][0] !== [...winAreas[1]][0]);
}

// ── Scenario 6: per-WINDOW access-requirement gating (access_zones) ─────────
console.log("\n=== Scenario 6: track_section_access_req vs window.access_zones ===");
{
  const base = { control_zone_code: "W40", shift_date: "2026-08-01", start_at: "2026-08-01T08:00:00Z", end_at: "2026-08-01T12:00:00Z", allowed_modes: ["CBTC", "VATC"], status: "planned" };
  const winW40  = [{ ...base, id: "zA", access_zones: ["W40"] }];           // grants W40 only
  const winBoth = [{ ...base, id: "zB", access_zones: ["W40", "Y10"] }];    // grants W40 + Y10
  const winNone = [{ ...base, id: "zC" }];                                   // no access_zones ⇒ control zone only
  const runs = [
    { id: "ix", test_id: "tx", code: "X", track_section_under_test: "W40", track_section_access_req: ["W40"],        required_mode: null, status: "Not Started" },
    { id: "iy", test_id: "ty", code: "Y", track_section_under_test: "W40", track_section_access_req: ["W40", "Y10"], required_mode: null, status: "Not Started" },
    { id: "iw", test_id: "tw", code: "W", track_section_under_test: "W40", track_section_access_req: [],             required_mode: null, status: "Not Started" },
  ];
  const find = (res, id) => res.assignments.find(a => a.instanceId === id);

  const a = _dynCascadeAllocate({ instances: runs, windows: winW40, prereqs: [], capacityPerWindow: 9 });
  ok("W40-only shift: single-zone run placed", !!find(a, "ix"));
  ok("W40-only shift: no-access-req run placed", !!find(a, "iw"));
  ok("W40-only shift: run needing Y10 NOT placed", !find(a, "iy"));
  ok("W40-only shift: that run stays in the backlog (unplaced)", a.unplaced.includes("iy"));

  const b = _dynCascadeAllocate({ instances: runs, windows: winBoth, prereqs: [], capacityPerWindow: 9 });
  ok("W40+Y10 shift: run needing both zones now placed", !!find(b, "iy"));
  ok("W40+Y10 shift: single-zone run still placed too", !!find(b, "ix"));

  const cc = _dynCascadeAllocate({ instances: runs, windows: winNone, prereqs: [], capacityPerWindow: 9 });
  ok("no access_zones ⇒ falls back to control zone (Y10 run excluded)", !find(cc, "iy") && !!find(cc, "ix"));
}

// ── Scenario 7: per-day zones flow into shift generation (access_zones) ─────
console.log("\n=== Scenario 7: per-day zones in _dynGenerateShiftRows ===");
{
  const gen = sandbox._dynGenerateShiftRows;
  if (typeof gen !== "function") { console.error("FATAL: _dynGenerateShiftRows not found"); process.exit(1); }
  const campaign = {
    id: "cg", zone_codes: ["W40", "Y10"], days_of_week: [1, 2, 3, 4, 5, 6, 0],
    start_date: "2026-06-01", end_date: "2026-06-14",
    allowed_modes: ["CBTC", "VATC"], trains_requested: 1,
    shift_start: "07:00", shift_end: "09:00",
    day_schedule: {
      "1": { start: "22:00", end: "23:30", zones: ["W40"] },          // Mon: W40 only
      "6": { start: "01:00", end: "05:00", zones: ["W40", "Y10"] },   // Sat: both
    },
  };
  const rows = gen(campaign);
  ok("rows generated", rows.length > 0);
  // every window's access_zones equals its day's scheduled zone set
  const allMatch = rows.every(r => {
    const dow = new Date(r.shift_date + "T12:00:00").getDay();
    const want = (campaign.day_schedule[String(dow)] || {}).zones || campaign.zone_codes;
    return JSON.stringify([...r.access_zones].sort()) === JSON.stringify([...want].sort());
  });
  ok("each window's access_zones matches its day schedule", allMatch);
  const sizes = new Set(rows.map(r => r.access_zones.length));
  ok("mix of single- and multi-zone shifts generated", sizes.has(1) && sizes.has(2));
  // a single-zone day yields one window; a two-zone day yields two
  const monRows = rows.filter(r => new Date(r.shift_date + "T12:00:00").getDay() === 1);
  const satRows = rows.filter(r => new Date(r.shift_date + "T12:00:00").getDay() === 6);
  ok("single-zone day → 1 window per date", monRows.length > 0 && monRows.every(r => r.access_zones.length === 1));
  ok("two-zone day → 2 windows per date", satRows.length > 0 && satRows.length === 2 * new Set(satRows.map(r => r.shift_date)).size);
}

// ── Scenario 8: program-level params (windowAllows + capacityFn) ───────────
console.log("\n=== Scenario 8: windowAllows (per-campaign scope) + capacityFn ===");
{
  const wins = [
    { id: "wa", control_zone_code: "W40", shift_date: "2026-09-01", start_at: "2026-09-01T08:00:00Z", end_at: "2026-09-01T10:00:00Z", allowed_modes: ["CBTC", "VATC"], access_zones: ["W40"], status: "planned", campaign_id: "cA" },
    { id: "wb", control_zone_code: "W40", shift_date: "2026-09-02", start_at: "2026-09-02T08:00:00Z", end_at: "2026-09-02T10:00:00Z", allowed_modes: ["CBTC", "VATC"], access_zones: ["W40"], status: "planned", campaign_id: "cB" },
  ];
  const runs = [
    { id: "ra", test_id: "tA", code: "A", track_section_under_test: "W40", track_section_access_req: ["W40"], required_mode: null, status: "Not Started" },
    { id: "rb", test_id: "tB", code: "B", track_section_under_test: "W40", track_section_access_req: ["W40"], required_mode: null, status: "Not Started" },
  ];
  const scope = new Map([["cA", new Set(["tA"])], ["cB", new Set(["tB"])]]);
  const windowAllows = (i, w) => { const s = scope.get(w.campaign_id); return !s || s.has(i.test_id); };
  const res = _dynCascadeAllocate({ instances: runs, windows: wins, prereqs: [], capacityPerWindow: 9, windowAllows });
  const at = id => (res.assignments.find(a => a.instanceId === id) || {}).windowId;
  ok("campaign-scoped: rA lands only in campaign A's window", at("ra") === "wa");
  ok("campaign-scoped: rB lands only in campaign B's window", at("rb") === "wb");

  const capRes = _dynCascadeAllocate({ instances: runs, windows: [wins[0]], prereqs: [], capacityFn: () => 1 });
  ok("capacityFn caps a window to its computed capacity", capRes.assignments.length === 1 && capRes.unplaced.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
