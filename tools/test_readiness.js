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

const need = ["_rdTaskProgress", "_rdLineComplete", "_rdWouldCycle", "_taskPrereqEff", "_rdIsActivity", "_rdSeedRows", "_rdSlipDays"];
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

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
