// Dynamic Testing — aggressive duration-aware packing in _dynCascadeAllocate.
// A window is filled by the SUM of run durations up to (1 − slack) of its length,
// instead of a flat count, so short tests pack many per shift.
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const cascade = sandbox._dynCascadeAllocate;
if (typeof cascade !== "function") { console.error("FATAL: _dynCascadeAllocate missing"); process.exit(1); }

// One 120-minute (2 h) window granting W40.
const win = {
  id: "w1", status: "planned", control_zone_code: "W40", access_zones: ["W40"],
  shift_date: "2026-07-01", start_at: "2026-07-01T01:00:00Z", end_at: "2026-07-01T03:00:00Z",
  allowed_modes: ["CBTC", "VATC"],
};
// 8 runs of 20 minutes each, all W40.
const runs = Array.from({ length: 8 }, (_, n) => ({
  id: "r" + n, test_id: "t" + n, code: "C" + n,
  track_section_under_test: "W40", track_section_access_req: ["W40"],
  required_mode: null, status: "Not Started", expected_duration_minutes: 20,
}));

function alloc(slack) {
  return cascade({
    instances: runs, windows: [win], prereqs: [],
    runMinutesFn: i => i.expected_duration_minutes || 30,
    windowMinutesFn: w => (new Date(w.end_at) - new Date(w.start_at)) / 60000,
    slack,
  });
}

// 15% slack on 120 min = 102 min budget → 20-min runs → floor(102/20)=5 runs.
const d15 = alloc(0.15);
assert(d15.assignments.length === 5, "15% slack packs 5×20m into a 120m window (got " + d15.assignments.length + ")");
const used15 = d15.assignments.length * 20;
assert(used15 <= 120 * 0.85 + 0.01 && used15 >= 120 * 0.7, "fill (~" + Math.round(used15 / 120 * 100) + "%) leaves only the configured slack");

// 0% slack → fill to full 120 min → 6 runs.
const d0 = alloc(0);
assert(d0.assignments.length === 6, "0% slack packs 6×20m = full 120m (got " + d0.assignments.length + ")");

// Old count model (mins/40) would only place 3 — assert the duration model is
// strictly MORE aggressive than the legacy count capacity for short runs.
const legacy = cascade({ instances: runs, windows: [win], prereqs: [], capacityFn: w => Math.max(1, Math.min(8, Math.round(((new Date(w.end_at) - new Date(w.start_at)) / 60000) / 40))) });
assert(legacy.assignments.length === 3, "legacy count model placed only 3 (the under-fill the user saw)");
assert(d15.assignments.length > legacy.assignments.length, "duration packing schedules more than the old count model");

// A single run longer than the budget still gets placed (never strands work).
const longRun = [{ id: "rL", test_id: "tL", code: "L", track_section_under_test: "W40", track_section_access_req: ["W40"], status: "Not Started", expected_duration_minutes: 300 }];
const dLong = cascade({ instances: longRun, windows: [win], prereqs: [], runMinutesFn: i => i.expected_duration_minutes, windowMinutesFn: w => 120, slack: 0.15 });
assert(dLong.assignments.length === 1, "an over-length run is still placed (at least one per window)");

console.log(`test_dyn_alloc_pack: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
