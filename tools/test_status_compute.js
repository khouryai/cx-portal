// Characterization tests for the status presentation + bucketing logic in app.js
// (real functions via tools/_load_app.js):
//   getStatusBadge(status)   — status → badge HTML class mapping
//   getPriorityPill(priority)— priority → pill HTML
//   _trpStatusCounts(items)  — case-insensitive status bucketing for test reports
//   _liMatchKpiStatus(r)     — KPI-card filter predicate (module state via setter)
//   _laAutoStatus(evs)       — schedule-derived lookahead status state-machine
//   _laActStatus(a, evs)     — override-aware activity status
//
// Run: node tools/test_status_compute.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}
function eq(name, got, want) { ok(`${name} (=${JSON.stringify(want)})`, got === want, `got ${JSON.stringify(got)}`); }

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { getStatusBadge, getPriorityPill, _trpStatusCounts, _liMatchKpiStatus, _laAutoStatus, _laActStatus } = sandbox;
for (const [n, f] of Object.entries({ getStatusBadge, getPriorityPill, _trpStatusCounts, _liMatchKpiStatus, _laAutoStatus, _laActStatus })) {
  if (typeof f !== "function") { console.error(`FATAL: ${n} not found`); process.exit(1); }
}

console.log("=== status compute characterization ===\n");

// ── getStatusBadge ──
console.log("getStatusBadge:");
eq("  falsy → em-dash notstarted badge", getStatusBadge(null), '<span class="badge badge-notstarted">—</span>');
const badgeCases = {
  "Pass": "badge-passed", "Passed": "badge-passed", "Closed": "badge-closed",
  "Fail": "badge-failed", "Failed": "badge-failed", "Blocked": "badge-warn",
  "Not Started": "badge-notstarted", "Not Applicable": "badge-notstarted",
  "Future Test": "badge-futuretest", "In Progress": "badge-inprog", "Open": "badge-open",
  "Pending Test Report Acceptance": "badge-pending", "Work Required": "badge-work",
  "Ready To Close": "badge-ready", "Ready For Review": "badge-ready",
  "Initiated": "badge-initiated", "Draft": "badge-draft",
  "Work Not Accepted": "badge-failed", "Not Accepted By Creator": "badge-failed",
};
ok(`  all ${Object.keys(badgeCases).length} known statuses map to their class`,
   Object.entries(badgeCases).every(([s, cls]) => getStatusBadge(s) === `<span class="badge ${cls}">${s}</span>`),
   Object.entries(badgeCases).find(([s, cls]) => getStatusBadge(s) !== `<span class="badge ${cls}">${s}</span>`)?.[0]);
eq("  unknown status → notstarted class, label preserved",
   getStatusBadge("Bogus"), '<span class="badge badge-notstarted">Bogus</span>');

// ── getPriorityPill ──
console.log("\ngetPriorityPill:");
eq("  falsy → low em-dash pill", getPriorityPill(null), '<span class="priority-pill priority-low">—</span>');
eq("  lowercases the priority", getPriorityPill("HIGH"), '<span class="priority-pill priority-high">high</span>');

// ── _trpStatusCounts ──
console.log("\n_trpStatusCounts:");
{
  const items = [
    { Status: "Pass" }, { Status: "PASSED" }, { Status: "complete" }, { Status: "Completed" }, // 4 passed (case-insensitive)
    { Status: "fail" }, { Status: "Failed" },                                                   // 2 failed
    { Status: "Blocked" },                                                                      // 1 blocked
    { Status: "In Progress" },                                                                  // 1 inProgress
    { Status: "Future Test" }, { Status: "future" },                                            // 2 future
    { Status: "Not Started" }, {}, { Status: "Something Else" },                                // 3 notStarted (fallback)
  ];
  const c = _trpStatusCounts(items);
  eq("  total", c.total, 13);
  eq("  passed (incl. case-insensitive + completed)", c.passed, 4);
  eq("  failed", c.failed, 2);
  eq("  blocked", c.blocked, 1);
  eq("  inProgress", c.inProgress, 1);
  eq("  future (Future Test + future)", c.future, 2);
  eq("  notStarted = fallback bucket", c.notStarted, 3);
}
eq("  empty input → all zeros",
   JSON.stringify(_trpStatusCounts([])),
   JSON.stringify({ total: 0, passed: 0, failed: 0, blocked: 0, inProgress: 0, notStarted: 0, future: 0 }));

// ── _liMatchKpiStatus (module state set via the shared vm context) ──
console.log("\n_liMatchKpiStatus:");
const setFilter = (v) => vm.runInContext(`_liKpiFilter = ${JSON.stringify(v)};`, ctx);
eq("  no filter → everything matches", _liMatchKpiStatus({ Status: "Blocked" }), true);
setFilter("pass");
ok("  pass: Pass/Passed/Complete/Not Applicable match; Fail doesn't",
   ["Pass", "Passed", "Complete", "Not Applicable"].every((s) => _liMatchKpiStatus({ Status: s })) &&
   !_liMatchKpiStatus({ Status: "Fail" }));
setFilter("inprog");
ok("  inprog: only In Progress",
   _liMatchKpiStatus({ Status: "In Progress" }) && !_liMatchKpiStatus({ Status: "Pass" }));
setFilter("blocked");
ok("  blocked: Fail/Failed/Blocked",
   ["Fail", "Failed", "Blocked"].every((s) => _liMatchKpiStatus({ Status: s })) &&
   !_liMatchKpiStatus({ Status: "Pass" }));
setFilter("notstarted");
ok("  notstarted: missing or Not Started",
   _liMatchKpiStatus({}) && _liMatchKpiStatus({ Status: "Not Started" }) &&
   !_liMatchKpiStatus({ Status: "Pass" }));
setFilter("");

// ── _laAutoStatus (schedule-derived; relative dates around today) ──
console.log("\n_laAutoStatus:");
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
eq("  no shifts → plan", _laAutoStatus([]), "plan");
eq("  non-array → plan", _laAutoStatus(null), "plan");
eq("  all past → done", _laAutoStatus([{ event_date: day(-3) }, { event_date: day(-1) }]), "done");
eq("  future shift, none cancelled → ontrack", _laAutoStatus([{ event_date: day(2) }]), "ontrack");
eq("  future shift + a cancellation → atrisk",
   _laAutoStatus([{ event_date: day(2) }, { event_date: day(1), status: "cancelled" }]), "atrisk");
eq("  only cancelled shifts → atrisk", _laAutoStatus([{ event_date: day(1), status: "cancelled" }]), "atrisk");
eq("  all ACTIVE shifts past + a cancellation → done (done outranks cancel; per doc: 'all non-cancelled past → Complete')",
   _laAutoStatus([{ event_date: day(-2) }, { event_date: day(-1), status: "cancelled" }]), "done");
eq("  mixed: future active + past cancel → atrisk (cancel only matters while not done)",
   _laAutoStatus([{ event_date: day(2) }, { event_date: day(-1), status: "cancelled" }]), "atrisk");

// ── _laActStatus (override-aware) ──
console.log("\n_laActStatus:");
eq("  valid team override wins", _laActStatus({ status_override: "done" }, [{ event_date: day(5) }]), "done");
eq("  invalid override falls back to schedule",
   _laActStatus({ status_override: "bogus" }, [{ event_date: day(5) }]), "ontrack");
eq("  no override → schedule", _laActStatus({}, []), "plan");

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
