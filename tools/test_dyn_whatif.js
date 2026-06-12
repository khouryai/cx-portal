// Dynamic Testing — what-if scope resolution, per-DOW extension, and metrics.
// Exercises the REAL app.js what-if engine with injected _dynPage state.
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);

// Two campaigns; campaign A has a short Sat window (2h) granting W40, campaign B
// a Mon window granting Y10. Pools of 20-min runs.
const shifts = [
  { id: "wA", campaign_id: "cA", status: "planned", control_zone_code: "W40", access_zones: ["W40"], shift_date: "2026-06-06", start_at: "2026-06-06T01:00:00Z", end_at: "2026-06-06T03:00:00Z", allowed_modes: ["CBTC"] }, // Sat 2h
  { id: "wB", campaign_id: "cB", status: "planned", control_zone_code: "Y10", access_zones: ["Y10"], shift_date: "2026-06-08", start_at: "2026-06-08T01:00:00Z", end_at: "2026-06-08T03:00:00Z", allowed_modes: ["CBTC"] }, // Mon 2h
];
const mk = (id, zone, camp) => Array.from({ length: 8 }, (_, n) => ({ id: id + n, test_id: id + "t" + n, code: id + n, track_section_under_test: zone, track_section_access_req: [zone], status: "Not Started", expected_duration_minutes: 20 }));
const instances = [...mk("a", "W40"), ...mk("b", "Y10")];
vm.runInContext(`
  _dynPage.campaigns = ${JSON.stringify([{ id: "cA", name: "Camp A", status: "active", zone_codes: ["W40"] }, { id: "cB", name: "Camp B", status: "active", zone_codes: ["Y10"] }])};
  _dynPage.shifts = ${JSON.stringify(shifts)};
  _dynPage.instances = ${JSON.stringify(instances)};
  window._dynWhatIf = { prereqs: [], mode: 'campaigns', campIds: new Set(['cA']), zones: new Set(), dateStart: '2026-06-01', dateEnd: '2026-06-30', dow: {} };
`, ctx);

// ── scope: single campaign ────────────────────────────────────────────────────
let sc = run("(function(){const s=_dynWhatIfScope();return {nw:s.windows.length,np:s.pool.length,label:s.label};})()");
assert(sc.nw === 1 && sc.np === 8 && sc.label === "Camp A", "single-campaign scope = 1 window, 8 W40 runs");

// ── scope: multiple campaigns ─────────────────────────────────────────────────
run("window._dynWhatIf.campIds = new Set(['cA','cB']);");
sc = run("(function(){const s=_dynWhatIfScope();return {nw:s.windows.length,np:s.pool.length,label:s.label};})()");
assert(sc.nw === 2 && sc.np === 16 && sc.label === "2 campaigns", "multi-campaign scope = 2 windows, 16 runs");

// ── scope: by location + date range ───────────────────────────────────────────
run("window._dynWhatIf.mode='locations'; window._dynWhatIf.zones=new Set(['W40']);");
sc = run("(function(){const s=_dynWhatIfScope();return {nw:s.windows.length,np:s.pool.length,label:s.label};})()");
assert(sc.nw === 1 && sc.np === 8 && sc.label === "W40", "location scope W40 = its 1 window + 8 W40 runs");
run("window._dynWhatIf.dateStart='2026-06-07';"); // excludes the Sat 6/6 window
sc = run("_dynWhatIfScope().windows.length");
assert(sc === 0, "date range filters out windows before the start date");

// ── per-DOW extension only touches matching days ──────────────────────────────
run("window._dynWhatIf.mode='campaigns'; window._dynWhatIf.campIds=new Set(['cA','cB']); window._dynWhatIf.dow={'6':5};"); // Sat → 5h
const ext = run(`(function(){
  const s=_dynWhatIfScope();
  const e=_dynWhatIfExtend(s.windows);
  const mins=w=> (new Date(w.end_at)-new Date(w.start_at))/60000;
  const sat=e.find(w=>w.id==='wA'), mon=e.find(w=>w.id==='wB');
  return { sat: mins(sat), mon: mins(mon) };
})()`);
assert(ext.sat === 300, "Saturday window extended to 5 h (300 min)");
assert(ext.mon === 120, "Monday window unchanged (still 120 min) — extension is per-day");

// ── metrics + compare: extending Sat schedules more & finishes utilization up ─
const cmp = run(`(function(){
  const r=_dynWhatIfCompute();
  return { basePlaced:r.base.placed, scenPlaced:r.scenario.placed, baseUtil:r.base.utilPct, scenWindows:r.nWindows,
           baseCum:r.base.cumulative.length, scenCum:r.scenario.cumulative.length, label:r.label };
})()`);
assert(cmp.scenPlaced >= cmp.basePlaced, "scenario schedules at least as many as current");
assert(cmp.scenPlaced > cmp.basePlaced, "extending Saturday to 5h schedules strictly more W40 runs");
assert(typeof cmp.baseUtil === "number", "utilization KPI computed");
assert(Array.isArray(run("_dynWhatIfCompute().base.cumulative")), "cumulative series produced for the chart");

console.log(`test_dyn_whatif: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
