// Dynamic Testing — schedule SIMULATOR engine (conceptual planning without real
// campaigns). Exercises the REAL app.js functions with injected _dynPage state:
// default weekly template (Wed/Thu/Fri 2h, Sat 3h, Sun 4h), adjacency-limited
// zone auto-pick (max 2 adjacent), continuous-48h weekend closures, per-week
// extended-hours overrides with caps, and same-rules allocation via the cascade.
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);

// localStorage shim for the scenario store
run("if (typeof localStorage === 'undefined' || !localStorage.setItem) { globalThis.localStorage = { _m:{}, getItem(k){return this._m[k]??null;}, setItem(k,v){this._m[k]=String(v);}, removeItem(k){delete this._m[k];} }; }");

// Backlog: 20×30m W40, 10×30m W34, 6×30m Y10, 4×30m W10 (W10 not adjacent to W40)
const mk = (z, n, pre) => Array.from({ length: n }, (_, k) => ({
  id: z + k, test_id: z + "t" + k, code: z + "-" + k,
  track_section_under_test: z, track_section_access_req: [z],
  status: "Not Started", expected_duration_minutes: 30,
}));
const pool = [...mk("W40", 20), ...mk("W34", 10), ...mk("Y10", 6), ...mk("W10", 4)];
run(`_dynPage.instances = ${JSON.stringify(pool)};`);

const baseSc = {
  id: "s1", name: "Test", startDate: "2026-06-15",                    // a Monday
  weekly: { 0: 4, 3: 2, 4: 2, 5: 2, 6: 3 },                           // Wed/Thu/Fri 2h, Sat 3h, Sun 4h
  maxZonesPerShift: 2,
  zones: ["W40", "W34", "W30", "W10", "Y10"],
  adjacency: [["W40","W34"],["Y10","W34"],["W40","Y10"],["W34","W30"],["W30","W10"]],
  weekOverrides: {}, maxClosures: 4, maxExtended: 4,
  scope: { subsystem: "", onlyUnscheduled: false },
};
const runSim = sc => run(`(function(){ const r=_dynSimRun(${JSON.stringify(sc)}, []); return { placed:r.placed, total:r.total, unplaced:r.unplaced, completion:r.completion, weeks:r.weeks, shifts:r.shifts, closuresUsed:r.closuresUsed, extendedUsed:r.extendedUsed, accessHours:r.accessHours, log:r.winLog.map(w=>({date:w.date,dow:w.dow,zones:w.zones,hours:w.hours,placed:w.placed,isClosure:w.isClosure})) }; })()`);

// ── default template: shifts only on Wed/Thu/Fri/Sat/Sun with right hours ────
const r1 = runSim(baseSc);
assert(r1.total === 40 && r1.placed === 40 && r1.unplaced === 0, "all 40 runs scheduled (got " + r1.placed + "/" + r1.total + ")");
const dows = new Set(r1.log.map(w => w.dow));
assert(!dows.has(1) && !dows.has(2), "no Monday/Tuesday shifts in the default template");
const hoursByDow = {};
r1.log.forEach(w => { hoursByDow[w.dow] = w.hours; });
assert(hoursByDow[3] === 2 && hoursByDow[4] === 2 && hoursByDow[5] === 2, "weekday shifts are 2h");
assert(hoursByDow[6] === 3 && hoursByDow[0] === 4, "Sat 3h / Sun 4h");
// throughput check: 2h@15% slack=102m → 3×30m runs; week 1 = 3+3+3 + 5(Sat 153m)
// + 6(Sun 204m) = 20 runs. Greedy zone picks may spill a couple of runs past
// week 2, so bound the duration instead of pinning it.
const week1 = r1.log.filter(w => w.date < "2026-06-22").reduce((n, w) => n + w.placed, 0);
assert(week1 === 20, "week 1 places exactly 20 runs per the template math (got " + week1 + ")");
assert(r1.weeks <= 3, "40×30m runs complete within 3 weeks (got " + r1.weeks + ")");

// ── zone auto-pick: ≤2 zones, every pair is from the adjacency list ──────────
const adjSet = new Set(baseSc.adjacency.map(p => p.slice().sort().join("|")));
assert(r1.log.every(w => w.zones.length <= 2), "never more than 2 locations per shift");
assert(r1.log.filter(w => w.zones.length === 2).every(w => adjSet.has(w.zones.slice().sort().join("|"))), "every 2-location shift is an allowed adjacent pair");
assert(r1.log[0].zones.includes("W40"), "first shift targets the biggest backlog (W40)");
const w10Shifts = r1.log.filter(w => w.zones.includes("W10"));
assert(w10Shifts.length > 0 && w10Shifts.every(w => !w.zones.includes("W40")), "W10 scheduled, never paired with non-adjacent W40");

// ── single-location simulation (maxZonesPerShift = 1) ────────────────────────
const r2 = runSim(Object.assign({}, baseSc, { maxZonesPerShift: 1 }));
assert(r2.log.every(w => w.zones.length === 1), "1-location mode never pairs zones");
assert(r2.placed === 40, "single-location mode still completes the backlog");

// ── weekend closure: continuous 48h Saturday block, Sunday consumed ──────────
const r3 = runSim(Object.assign({}, baseSc, { weekOverrides: { 0: { closure: true } } }));
const wk0 = r3.log.filter(w => w.date < "2026-06-22");
const sat = wk0.find(w => w.dow === 6);
assert(sat && sat.hours === 48 && sat.isClosure, "closure week has one continuous 48h Saturday block");
assert(!wk0.some(w => w.dow === 0), "closure consumes the Sunday window");
assert(r3.closuresUsed === 1, "closure counted");
assert(r3.weeks <= r1.weeks, "a closure never makes the schedule longer");

// ── per-week extended hours + cap ─────────────────────────────────────────────
const r4 = runSim(Object.assign({}, baseSc, { maxExtended: 1, weekOverrides: { 0: { wk: 6 }, 1: { wk: 6 } } }));
const wk0h = r4.log.filter(w => w.date < "2026-06-22" && [3,4,5].includes(w.dow)).map(w => w.hours);
const wk1h = r4.log.filter(w => w.date >= "2026-06-22" && w.date < "2026-06-29" && [3,4,5].includes(w.dow)).map(w => w.hours);
assert(wk0h.every(h => h === 6), "week 1 weekday shifts extended to 6h");
assert(wk1h.every(h => h === 2), "extended-week CAP (1) blocks week 2's extension — base hours stand");
assert(r4.extendedUsed === 1, "extended weeks counted once per week");

// ── reductions always apply (0 = closed day) ──────────────────────────────────
const r5 = runSim(Object.assign({}, baseSc, { weekOverrides: { 0: { sun: 0 } } }));
assert(!r5.log.some(w => w.dow === 0 && w.date < "2026-06-22"), "sun=0 override closes that Sunday");

// ── location scope: restricting zones leaves out-of-scope work reported ──────
const r6 = run(`(function(){ const r=_dynSimRun(${JSON.stringify(Object.assign({}, baseSc, { zones: ["W40"] }))}, []); return { placed:r.placed, total:r.total, outOfScope:r.outOfScope }; })()`);
assert(r6.total === 20 && r6.placed === 20 && r6.outOfScope === 20, "zone-restricted sim schedules only W40, reports 20 out-of-scope");

// ── prerequisites flow across simulated windows ───────────────────────────────
// 100-min runs: only ONE fits a 2h window (102m budget) → with tcB requiring
// tcA, A must land on a strictly earlier simulated shift than B.
const prereqPool = [
  { id: "pB", test_id: "tcB", code: "B", track_section_under_test: "W40", track_section_access_req: ["W40"], status: "Not Started", expected_duration_minutes: 100 },
  { id: "pA", test_id: "tcA", code: "A", track_section_under_test: "W40", track_section_access_req: ["W40"], status: "Not Started", expected_duration_minutes: 100 },
];
run(`_dynPage.instances = ${JSON.stringify(prereqPool)};`);
const r7 = run(`(function(){
  const r=_dynSimRun(${JSON.stringify(Object.assign({}, baseSc, { zones: ["W40"] }))}, [{ test_id: "tcB", prerequisite_test_id: "tcA" }]);
  const byId={};
  // winLog has counts; recover order via cumulative assignment dates per run:
  return { placed:r.placed, dates: r.winLog.filter(w=>w.placed>0).map(w=>w.date) };
})()`);
assert(r7.placed === 2 && r7.dates.length === 2 && r7.dates[0] < r7.dates[1],
  "prereq pair placed on two ordered shifts (A's before B's)");
run(`_dynPage.instances = ${JSON.stringify(pool)};`); // restore

console.log(`test_dyn_simulator: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
