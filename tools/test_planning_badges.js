// Characterization tests for the lookahead planning badge/chip logic in app.js
// (real functions via tools/_load_app.js):
//   _planningCellBadge(activity, date) — per-cell badge: past=accountability,
//     today=live progress, future=workload preview
//   _planningRowProgressChip(activity) — N/M progress chip with % color
//   _planningDeriveInitials(name)      — resource initials
//
// Fixtures are injected into app.js's real TI / PLANNING_TEST_RESULTS state via
// the shared vm context. Run: node tools/test_planning_badges.js
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
const { _planningCellBadge, _planningRowProgressChip, _planningDeriveInitials } = sandbox;
for (const [n, f] of Object.entries({ _planningCellBadge, _planningRowProgressChip, _planningDeriveInitials })) {
  if (typeof f !== "function") { console.error(`FATAL: ${n} not found`); process.exit(1); }
}

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const PAST = day(-2), TODAY = day(0), FUTURE = day(3);

// Activity "ActA": 4 tests, 2 Complete → remaining 2.
function setState(results) {
  const TI = [
    { TestID: "a1", Activity: "ActA", Status: "Complete" },
    { TestID: "a2", Activity: "ActA", Status: "Complete" },
    { TestID: "a3", Activity: "ActA", Status: "Not Started" },
    { TestID: "a4", Activity: "ActA", Status: "Not Started" },
  ];
  vm.runInContext(
    `TI = ${JSON.stringify(TI)}; PLANNING_TEST_RESULTS = ${JSON.stringify(results || [])};`,
    ctx
  );
}
const res = (date, result, test_id = "a1") => ({ test_id, activity: "ActA", date_tested: date, result });

console.log("=== planning badge characterization ===\n");

// ── guards ──
console.log("guards:");
setState([]);
ok("  no linked activity → ''", _planningCellBadge(null, PAST) === "");
ok("  unknown activity (0 tests) → ''", _planningCellBadge("Nope", PAST) === "");

// ── PAST: accountability ──
console.log("\npast date:");
setState([]);
{
  const b = _planningCellBadge("ActA", PAST);
  ok("  planned but nothing recorded → '✗ 0 done' (badge-none)",
     b.includes("tlg-cell-badge-none") && b.includes("✗ 0 done"), b);
}
setState([res(PAST, "Pass")]);
{
  const b = _planningCellBadge("ActA", PAST);
  ok("  clean execution → ok badge with count + check icon",
     b.includes("tlg-cell-badge-ok") && b.includes("1 done") && b.includes("<svg"), b);
}
setState([res(PAST, "Fail", "a1"), res(PAST, "Blocked", "a2")]);
{
  const b = _planningCellBadge("ActA", PAST);
  ok("  issues → warn badge, title lists '1 fail, 1 blk'",
     b.includes("tlg-cell-badge-warn") && b.includes("1 fail, 1 blk") && b.includes("2 done"), b);
}

// ── TODAY: live progress ──
console.log("\ntoday:");
setState([res(TODAY, "Pass")]);
{
  const b = _planningCellBadge("ActA", TODAY);
  ok("  executed clean → '1✓ · 2↻' (today class)",
     b.includes("tlg-cell-badge-today") && b.includes("1✓ · 2↻"), b);
}
setState([]);
{
  const b = _planningCellBadge("ActA", TODAY);
  ok("  nothing yet → remaining only '2↻'", b.includes("tlg-cell-badge-today") && b.includes("2↻") && !b.includes("✓ ·"), b);
}
setState([res(TODAY, "Fail")]);
{
  const b = _planningCellBadge("ActA", TODAY);
  ok("  failure today → warn class", b.includes("tlg-cell-badge-warn"), b);
}

// ── FUTURE: workload preview ──
console.log("\nfuture date:");
setState([]);
{
  const b = _planningCellBadge("ActA", FUTURE);
  ok("  2 remaining → '2 left' (future class)",
     b.includes("tlg-cell-badge-future") && b.includes("2 left"), b);
}
// all complete → "✓ done"
vm.runInContext(`TI = ${JSON.stringify([
  { TestID: "a1", Activity: "ActA", Status: "Complete" },
  { TestID: "a2", Activity: "ActA", Status: "Pass" },
])}; PLANNING_TEST_RESULTS = [];`, ctx);
{
  const b = _planningCellBadge("ActA", FUTURE);
  ok("  nothing remaining → '✓ done' (ok class)",
     b.includes("tlg-cell-badge-ok") && b.includes("✓ done"), b);
}

// ── row progress chip ──
console.log("\nrow progress chip:");
ok("  no activity → ''", _planningRowProgressChip(null) === "");
setState([]);
{
  const c = _planningRowProgressChip("ActA");           // 2/4 = 50%
  ok("  2/4 → '2/4' with 50%-tier color #0891b2", c.includes("2/4") && c.includes("#0891b2"), c);
}
vm.runInContext(`TI = ${JSON.stringify([
  { TestID: "a1", Activity: "ActA", Status: "Complete" },
  { TestID: "a2", Activity: "ActA", Status: "Passed" },
])};`, ctx);
{
  const c = _planningRowProgressChip("ActA");           // 2/2 = 100%
  ok("  100% → green #16a34a", c.includes("2/2") && c.includes("#16a34a"), c);
}
vm.runInContext(`TI = ${JSON.stringify([
  { TestID: "a1", Activity: "ActA", Status: "Complete" },
  { TestID: "a2", Activity: "ActA", Status: "Not Started" },
  { TestID: "a3", Activity: "ActA", Status: "Not Started" },
  { TestID: "a4", Activity: "ActA", Status: "Not Started" },
])};`, ctx);
{
  const c = _planningRowProgressChip("ActA");           // 1/4 = 25%
  ok("  <50% → gray #6b7280", c.includes("1/4") && c.includes("#6b7280"), c);
}

// ── initials ──
console.log("\n_planningDeriveInitials:");
ok("  empty → ''", _planningDeriveInitials("") === "");
ok("  'John Smith' → 'JS'", _planningDeriveInitials("John Smith") === "JS");
ok("  5 words → first 4 letters, uppercased", _planningDeriveInitials("a b c d e") === "ABCD");

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
