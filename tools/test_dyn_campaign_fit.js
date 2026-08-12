// Unit test for the access-campaign "Test Case scope" fit engine
// (cx-dyn-campaign-fit.js): does a test case's runs fit the shifts a campaign
// would generate, and the decision metrics (utilization, coverage, footprint).
// Run: node tools/test_dyn_campaign_fit.js
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);

// A prospective shift as _dynGenerateShiftRows would emit it (2h window = 120m).
const shift = (zones, opts) => Object.assign({
  control_zone_code: zones[0], access_zones: zones, status: 'planned',
  allowed_modes: ['CBTC', 'VATC'], max_trains: 1, available_consists: { sizes: [null] },
  start_at: '2026-06-15T07:00:00.000Z', end_at: '2026-06-15T09:00:00.000Z',
}, opts || {});
const inst = (tid, n, o) => Array.from({ length: n }, (_, k) => Object.assign({
  id: tid + k, test_id: tid, code: tid + '-' + k, track_section_under_test: 'X',
  track_section_access_req: ['W40'], status: 'Not Started', expected_duration_minutes: 30,
  trains_needed: 1,
}, o || {}));

console.log("=== campaign scope fit engine ===\n");

// Pool: T1 all-fit, T2 wrong zone, T3 needs 2 trains, T4 too long, T5 partial.
const pool = [
  ...inst('T1', 3),
  ...inst('T2', 2, { track_section_access_req: ['W22'] }),
  ...inst('T3', 1, { trains_needed: 2, required_consists: { sizes: [4, 10] } }),
  ...inst('T4', 1, { expected_duration_minutes: 200 }),
  ...inst('T5', 2, { track_section_access_req: ['W40'] }).map((r, k) =>
    k === 1 ? Object.assign(r, { required_mode: 'VATC' }) : r),
];
run(`_dynPage.instances = ${JSON.stringify(pool)};`);

// One shift granting W40, CBTC-only, 1 train, 120 minutes.
const single = shift(['W40'], { allowed_modes: ['CBTC'] });
run(`__ctx = _dynCampBuildFitCtx(${JSON.stringify([single])});`);
const fit = id => run(`_dynCampFitForCase(${JSON.stringify(id)}, __ctx)`);

let m = fit('T1');
assert(m.fit === 3 && m.total === 3 && Math.abs(m.coverage - 1) < 1e-9, `T1 all 3 runs fit (got ${m.fit}/${m.total})`);
assert(Math.abs(m.footprint - 1) < 1e-9, `T1 footprint 1.0 on a 1-zone shift (got ${m.footprint})`);
assert(Math.abs(m.util - 90 / 120) < 1e-9, `T1 utilization = 90/120 = 0.75 (got ${m.util})`);

m = fit('T2');
assert(m.fit === 0 && m.reasons.zone === 2 && [...m.missZones].join() === 'W22', `T2 blocked on zone W22 (got ${JSON.stringify(m.reasons)}, miss ${[...m.missZones]})`);

m = fit('T3');
assert(m.fit === 0 && m.reasons.trains === 1, `T3 blocked on trains/consist (got ${JSON.stringify(m.reasons)})`);

m = fit('T4');
assert(m.fit === 0 && m.reasons.dur === 1, `T4 blocked as too long for the window (got ${JSON.stringify(m.reasons)})`);

m = fit('T5');
assert(m.fit === 1 && m.total === 2 && m.reasons.mode === 1, `T5 partial: 1 fits, 1 wrong mode (got ${m.fit}/${m.total}, ${JSON.stringify(m.reasons)})`);

// Footprint: a W40-only run on a 2-zone (W40+W34) shift wastes half the access.
run(`__ctx2 = _dynCampBuildFitCtx(${JSON.stringify([shift(['W40', 'W34'])])});`);
m = run(`_dynCampFitForCase('T1', __ctx2)`);
assert(Math.abs(m.footprint - 0.5) < 1e-9, `footprint 0.5 for a 1-zone run on a 2-zone shift (got ${m.footprint})`);

// With BOTH a 1-zone and 2-zone shift, footprint uses the tightest (1.0).
run(`__ctx3 = _dynCampBuildFitCtx(${JSON.stringify([shift(['W40']), shift(['W40', 'W34'])])});`);
m = run(`_dynCampFitForCase('T1', __ctx3)`);
assert(Math.abs(m.footprint - 1) < 1e-9, `footprint 1.0 when a tight 1-zone shift is available (got ${m.footprint})`);

console.log(`\ncampaign scope fit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
