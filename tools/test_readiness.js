// Unit test for readiness.js — the Activity Readiness checklist engine that
// rides on the Tasks module: line completion per kind, PROPORTIONAL rollup of
// linked child activities, cycle guarding, derived prerequisite state,
// template seeding (due-date offsets) and delay-history math.
//
// Run: node tools/test_readiness.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }

const need = ["_rdTaskProgress", "_rdLineComplete", "_rdWouldCycle", "_taskPrereqEff", "_rdIsActivity", "_rdSeedRows", "_rdSlipDays", "_rdRollup", "_rdMatrixData", "_rdDelayStats"];
for (const fn of need) {
  if (typeof sandbox[fn] !== "function") { console.error("FATAL: missing", fn); process.exit(1); }
}

console.log("=== readiness.js unit ===\n");

// ── Fixture: A (parent) links B (child at 2/3); C is a plain task ───────────
vm.runInContext(`
  TASKS = [
    { id: 'A', task_name: 'DCS Site Testing — W40', subsystem: 'DCS' },
    { id: 'B', task_name: 'Approved Test Procedure' },
    { id: 'C', task_name: 'Order zip ties', prerequisite_met: true },
  ];
  TASK_CHK = [
    // A: two ticks (one done) + one linked-activity line → 3 counted lines
    { id: 'a1', task_id: 'A', seq: 10, title: 'Site engineering test completed', kind: 'check', done: true,  required: true },
    { id: 'a2', task_id: 'A', seq: 20, title: 'Latest DCS book of plans',        kind: 'check', done: false, required: true },
    { id: 'a3', task_id: 'A', seq: 30, title: 'Approved test procedure',         kind: 'task',  linked_task_id: 'B', required: true },
    // B: 2 of 3 complete (check done, passfail Pass, value empty)
    { id: 'b1', task_id: 'B', seq: 10, title: 'Draft issued',    kind: 'check',    done: true, required: true },
    { id: 'b2', task_id: 'B', seq: 20, title: 'Review verdict',  kind: 'passfail', verdict: 'Pass', required: true },
    { id: 'b3', task_id: 'B', seq: 30, title: 'Rev number',      kind: 'value',    value_text: null, required: true },
  ];
  TASK_DELAYS = [
    { id: 'd1', item_id: 'a2', old_due: '2026-07-01', new_due: '2026-07-08', reason: 'Need more time', created_at: '2026-06-30' },
    { id: 'd2', item_id: 'a2', old_due: '2026-07-08', new_due: '2026-07-10', reason: 'Waiting on design input', created_at: '2026-07-07' },
  ];
  RD_TPLS = [{ id: 'T', name: 'DCS Site Testing Start' }];
  RD_TPL_ITEMS = [
    { id: 't1', template_id: 'T', seq: 10, title: 'Approved test procedure', kind: 'check', required: true, due_offset_days: 14, default_responsible: 'QA Lead' },
    { id: 't2', template_id: 'T', seq: 20, title: 'Voltage reading', kind: 'value', unit: 'V', expected: '24', required: false },
  ];
`, ctx);

console.log("line completion per kind:");
{
  const line = id => vm.runInContext(`TASK_CHK.find(l => l.id === '${id}')`, ctx);
  ok("  check done → complete", sandbox._rdLineComplete(line("b1"), new Set()));
  ok("  check not done → incomplete", !sandbox._rdLineComplete(line("a2"), new Set()));
  ok("  passfail Pass → complete", sandbox._rdLineComplete(line("b2"), new Set()));
  ok("  value empty → incomplete", !sandbox._rdLineComplete(line("b3"), new Set()));
  ok("  linked task at 2/3 → incomplete (only 100% completes)", !sandbox._rdLineComplete(line("a3"), new Set()));
}

console.log("\nproportional rollup:");
{
  const pB = sandbox._rdTaskProgress("B");
  ok("  child B is 2/3 (67%)", pB.total === 3 && pB.pct === 67, JSON.stringify(pB));
  const pA = sandbox._rdTaskProgress("A");
  // A = (1 + 0 + 2/3) / 3 = 0.5556 → 56%
  ok("  parent A gets B's fraction: (1+0+0.667)/3 → 56%", pA.total === 3 && pA.pct === 56, JSON.stringify(pA));
  vm.runInContext(`TASK_CHK.find(l => l.id === 'b2').verdict = 'Fail';`, ctx);
  const pA2 = sandbox._rdTaskProgress("A");
  ok("  child Fail verdict propagates to parent fails", pA2.fails === 1, JSON.stringify(pA2));
  vm.runInContext(`TASK_CHK.find(l => l.id === 'b2').verdict = 'Pass';`, ctx);
}

console.log("\ncycle guard:");
{
  ok("  linking A under B would cycle (B is already under A)", sandbox._rdWouldCycle("B", "A"));
  ok("  self-link is a cycle", sandbox._rdWouldCycle("A", "A"));
  ok("  linking C under A is fine", !sandbox._rdWouldCycle("A", "C"));
  // A cycle already in the data must not hang or throw
  vm.runInContext(`TASK_CHK.push({ id: 'b4', task_id: 'B', seq: 40, title: 'loop', kind: 'task', linked_task_id: 'A', required: true });`, ctx);
  const pA = sandbox._rdTaskProgress("A");
  ok("  existing cycle terminates (no hang/throw)", typeof pA.pct === "number");
  vm.runInContext(`TASK_CHK = TASK_CHK.filter(l => l.id !== 'b4');`, ctx);
}

console.log("\nderived prerequisite state:");
{
  const A = vm.runInContext(`TASKS.find(t => t.id === 'A')`, ctx);
  const C = vm.runInContext(`TASKS.find(t => t.id === 'C')`, ctx);
  ok("  task with checklist derives from lines (A incomplete)", !sandbox._taskPrereqEff(A));
  ok("  task without checklist keeps manual flag (C met)", sandbox._taskPrereqEff(C));
  vm.runInContext(`
    TASK_CHK.find(l => l.id === 'a2').done = true;
    TASK_CHK.find(l => l.id === 'b3').value_text = 'Rev C';
  `, ctx);
  ok("  all lines (incl. child at 100%) complete → prereq met", sandbox._taskPrereqEff(A));
  ok("  parent now reads 100%", sandbox._rdTaskProgress("A").pct === 100);
}

console.log("\nreadiness-page membership:");
{
  ok("  checklist task is an activity", sandbox._rdIsActivity(vm.runInContext(`TASKS.find(t => t.id === 'A')`, ctx)));
  ok("  plain to-do is not", !sandbox._rdIsActivity(vm.runInContext(`TASKS.find(t => t.id === 'C')`, ctx)));
  ok("  subsystem alone qualifies", sandbox._rdIsActivity({ id: "X", subsystem: "DCS" }));
}

console.log("\ntemplate seeding + delay math:");
{
  const rows = sandbox._rdSeedRows("T", "NEW", "2026-08-01");
  ok("  copies both items in order", rows.length === 2 && rows[0].title === "Approved test procedure");
  ok("  due = target − offset (14d before 2026-08-01)", rows[0].due_date === "2026-07-18", rows[0].due_date);
  ok("  no offset → no due date", rows[1].due_date === null);
  ok("  default responsible carried", rows[0].responsible === "QA Lead");
  ok("  slip days accumulate across pushes (7+2)", sandbox._rdSlipDays("a2") === 9, String(sandbox._rdSlipDays("a2")));
}

// ── Fresh fixture for rollup / matrix / delay analytics ─────────────────────
vm.runInContext(`
  TASKS = [
    { id: 'P1', task_name: 'DCS P1', subsystem: 'DCS', phase: 'Phase 1', location: 'W40' },
    { id: 'P2', task_name: 'DCS P2', subsystem: 'DCS', phase: 'Phase 2', location: 'W40' },
    { id: 'P3', task_name: 'IXL P1', subsystem: 'IXL', phase: 'Phase 1', location: 'Y40' },
  ];
  TASK_CHK = [
    { id: 'p1a', task_id: 'P1', seq: 10, title: 'a', kind: 'check', done: true,  required: true, responsible: 'QA' },
    { id: 'p1b', task_id: 'P1', seq: 20, title: 'b', kind: 'check', done: false, required: true },
    { id: 'p2a', task_id: 'P2', seq: 10, title: 'a', kind: 'check', done: true,  required: true },
    { id: 'p2b', task_id: 'P2', seq: 20, title: 'b', kind: 'check', done: true,  required: true },
    { id: 'p3a', task_id: 'P3', seq: 10, title: 'a', kind: 'check', done: false, required: true, due_date: '2000-01-01', responsible: 'Design' },
    { id: 'p3b', task_id: 'P3', seq: 20, title: 'b', kind: 'check', done: false, required: true },
  ];
  TASK_DELAYS = [
    { id: 'x1', item_id: 'p3a', old_due: '2026-07-01', new_due: '2026-07-08', reason: 'Waiting on design input', created_at: '2026-06-30' },
    { id: 'x2', item_id: 'p3a', old_due: '2026-07-08', new_due: '2026-07-11', reason: 'Waiting on design input', created_at: '2026-07-07' },
    { id: 'x3', item_id: 'p1a', old_due: '2026-07-01', new_due: '2026-07-05', reason: 'Need more time', created_at: '2026-06-30' },
  ];
`, ctx);
const acts = vm.runInContext(`TASKS.filter(_rdIsActivity)`, ctx);

console.log("\nrollup by dimension (worst-first):");
{
  const bySub = sandbox._rdRollup(acts, "subsystem", null);
  ok("  two subsystems", bySub.length === 2);
  ok("  IXL (0%) sorts before DCS (75%)", bySub[0].key === "IXL" && bySub[0].pct === 0 && bySub[1].pct === 75,
     JSON.stringify(bySub.map(g => g.key + ":" + g.pct)));
  ok("  IXL flags its overdue item", bySub[0].overdue === 1, String(bySub[0].overdue));
  const byPhase = sandbox._rdRollup(acts, "phase", null);
  ok("  Phase 1 = 25% (1 of 4 items), Phase 2 = 100%",
     byPhase[0].key === "Phase 1" && byPhase[0].pct === 25 && byPhase[1].pct === 100,
     JSON.stringify(byPhase.map(g => g.key + ":" + g.pct)));
}

console.log("\nsubsystem × phase matrix:");
{
  const m = sandbox._rdMatrixData(acts, "phase", null);
  ok("  rows = [DCS, IXL]", JSON.stringify(m.rows) === JSON.stringify(["DCS", "IXL"]));
  ok("  cols = [Phase 1, Phase 2]", JSON.stringify(m.cols) === JSON.stringify(["Phase 1", "Phase 2"]));
  const c = (r, col) => m.cells.get(r + "||" + col);
  ok("  DCS×Phase1 cell = 1/2", c("DCS", "Phase 1").done === 1 && c("DCS", "Phase 1").total === 2);
  ok("  DCS×Phase2 cell = 2/2", c("DCS", "Phase 2").done === 2 && c("DCS", "Phase 2").total === 2);
  ok("  IXL×Phase2 has no activity (empty cell)", c("IXL", "Phase 2") === undefined);
}

console.log("\ndelay analytics:");
{
  const s = sandbox._rdDelayStats();
  ok("  total slip 14 days over 3 events", s.totalDays === 14 && s.totalEvents === 3, JSON.stringify([s.totalDays, s.totalEvents]));
  ok("  avg 4.7 days/event", s.avg === 4.7, String(s.avg));
  ok("  top reason = 'Waiting on design input' (10d ×2)",
     s.byReason[0].key === "Waiting on design input" && s.byReason[0].days === 10 && s.byReason[0].count === 2,
     JSON.stringify(s.byReason[0]));
  ok("  worst activity = IXL P1 (10d)", s.byActivity[0].name === "IXL P1" && s.byActivity[0].days === 10, JSON.stringify(s.byActivity[0]));
  ok("  slip attributed to responsible party 'Design' (10d)",
     s.byResponsible[0].key === "Design" && s.byResponsible[0].days === 10, JSON.stringify(s.byResponsible[0]));
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
