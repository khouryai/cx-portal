// Dynamic Testing — planning board schedules ONLY onto eligible access windows,
// and the two allocate buttons share one engine. Exercises the REAL app.js fns.
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);

// ── _dynWindowGrantsRun: the board/cascade eligibility gate ───────────────────
const grants = (w, r) => run(`_dynWindowGrantsRun(${JSON.stringify(w)}, ${JSON.stringify(r)})`);

const wW40       = { id: "wA", status: "planned", control_zone_code: "W40", access_zones: ["W40"], shift_date: "2026-06-10", allowed_modes: ["CBTC", "VATC"] };
const wW40Y10    = { id: "wB", status: "planned", control_zone_code: "W40", access_zones: ["W40", "Y10"], shift_date: "2026-06-12", allowed_modes: ["CBTC", "VATC"] };
const wCancelled = { id: "wC", status: "cancelled", control_zone_code: "W40", access_zones: ["W40"], shift_date: "2026-06-11", allowed_modes: ["CBTC"] };
const wCBTConly  = { id: "wD", status: "planned", control_zone_code: "W40", access_zones: ["W40"], shift_date: "2026-06-13", allowed_modes: ["CBTC"] };

const runW40        = { id: "r1", track_section_under_test: "W40", track_section_access_req: ["W40"], required_mode: null };
const runW40Y10     = { id: "r2", track_section_under_test: "W40", track_section_access_req: ["W40", "Y10"], required_mode: null };
const runY10        = { id: "r3", track_section_under_test: "Y10", track_section_access_req: ["Y10"], required_mode: null };
const runW40VATC    = { id: "r4", track_section_under_test: "W40", track_section_access_req: ["W40"], required_mode: "VATC" };

assert(grants(wW40, runW40) === true, "single-zone window grants a same-zone run");
assert(grants(wW40, runW40Y10) === false, "single-zone W40 window does NOT grant a [W40,Y10] run");
assert(grants(wW40Y10, runW40Y10) === true, "two-zone window grants the [W40,Y10] run");
assert(grants(wW40Y10, runY10) === true, "two-zone window grants a SECONDARY-zone (Y10) run");
assert(grants(wW40, runY10) === false, "W40 window does not grant a Y10 run");
assert(grants(wCancelled, runW40) === false, "cancelled window grants nothing");
assert(grants(wCBTConly, runW40VATC) === false, "CBTC-only window rejects a VATC-required run");
assert(grants(wW40Y10, runW40VATC) === true, "VATC-capable window grants the VATC run");

// ── _dynEligibleWindowsFor: lists only granting windows, date-sorted ──────────
vm.runInContext(`_dynPage.shifts = ${JSON.stringify([wCancelled, wW40Y10, wW40, wCBTConly])};`, ctx);
const eligIds = run(`_dynEligibleWindowsFor(${JSON.stringify(runW40)}).map(w => w.id)`);
assert(JSON.stringify(eligIds) === JSON.stringify(["wA", "wB", "wD"]),
  "eligible W40 windows are the 3 planning ones in date order, cancelled excluded (got " + JSON.stringify(eligIds) + ")");
const eligY10 = run(`_dynEligibleWindowsFor(${JSON.stringify(runY10)}).map(w => w.id)`);
assert(JSON.stringify(eligY10) === JSON.stringify(["wB"]), "Y10 run is only eligible for the two-zone window");
const eligNone = run(`_dynEligibleWindowsFor(${JSON.stringify({ id: "rz", track_section_under_test: "Z99", track_section_access_req: ["Z99"] })}).length`);
assert(eligNone === 0, "a run whose zone no window grants has NO eligible shifts (can't be scheduled)");

// ── cascade: a two-zone window hosts BOTH zones' runs (one-window-per-day) ─────
const cascade = sandbox._dynCascadeAllocate;
if (typeof cascade === "function") {
  const draft = cascade({
    instances: [runW40, runY10],
    windows: [{ id: "wB", status: "planned", control_zone_code: "W40", access_zones: ["W40", "Y10"], shift_date: "2026-06-12", start_at: "2026-06-12T01:00:00Z", end_at: "2026-06-12T05:00:00Z", allowed_modes: ["CBTC", "VATC"] }],
    prereqs: [], capacityPerWindow: 8,
  });
  const placedZones = draft.assignments.map(a => a.instanceId).sort();
  assert(draft.assignments.length === 2 && JSON.stringify(placedZones) === JSON.stringify(["r1", "r3"]),
    "cascade places BOTH the W40 and the Y10 run into the single two-zone window");
} else {
  assert(false, "_dynCascadeAllocate not found on sandbox");
}

console.log(`test_dyn_board_schedule: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
