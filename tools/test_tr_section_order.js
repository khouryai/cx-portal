// Characterization test for Test Register section ordering —
// _trSortedSectionEntries (tr-activities.js) plus a render check that
// _amDrilldownHTML lays an activity's procedure cards out in procedure-name
// order regardless of the order the test_items rows arrived in.
// Run: node tools/test_tr_section_order.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load failed in", loadErrorFile, "\n", loadError.message); process.exit(1); }

const sortEntries = sandbox._trSortedSectionEntries;
ok("_trSortedSectionEntries is a function", typeof sortEntries === "function");
if (typeof sortEntries !== "function") { process.exit(1); }

const keys = (map) => sortEntries(map).map(([k]) => k);

// ── Unit: ordering rules ────────────────────────────────────────────────────
ok("plain procedure keys sort by name",
   JSON.stringify(keys({ "TP-Doors": [], "TP-Brakes": [], "TP-ATP": [] }))
     === JSON.stringify(["TP-ATP", "TP-Brakes", "TP-Doors"]));

ok("numbers sort naturally (TP-2 before TP-10)",
   JSON.stringify(keys({ "TP-10": [], "TP-2": [], "TP-1": [] }))
     === JSON.stringify(["TP-1", "TP-2", "TP-10"]));

ok("ordering is case-insensitive",
   JSON.stringify(keys({ "beta": [], "Alpha": [] })) === JSON.stringify(["Alpha", "beta"]));

ok("composite keys sort on the procedure, not the section",
   JSON.stringify(keys({ "S2~~TP-Alpha": [], "S1~~TP-Zulu": [] }))
     === JSON.stringify(["S2~~TP-Alpha", "S1~~TP-Zulu"]));

ok("same procedure in two sections tie-breaks on section name",
   JSON.stringify(keys({ "2. Wayside~~TP-Doors": [], "1. Depot~~TP-Doors": [] }))
     === JSON.stringify(["1. Depot~~TP-Doors", "2. Wayside~~TP-Doors"]));

ok("'(No Procedure)' sorts last",
   JSON.stringify(keys({ "(No Procedure)": [], "TP-Zulu": [], "TP-Alpha": [] }))
     === JSON.stringify(["TP-Alpha", "TP-Zulu", "(No Procedure)"]));

ok("a sectioned card with an empty procedure also sorts last",
   JSON.stringify(keys({ "S1~~": [], "TP-Zulu": [] })) === JSON.stringify(["TP-Zulu", "S1~~"]));

ok("entries keep their item arrays",
   sortEntries({ "TP-B": [1, 2], "TP-A": [3] })[0][1].length === 1);

ok("empty / missing map is safe",
   sortEntries({}).length === 0 && sortEntries(undefined).length === 0);

// ── Render: procedure cards come out sorted, whatever the row order ─────────
// Two activities, rows deliberately interleaved and out of order — each one
// must render its own sections in procedure order.
const rows = [
  { TestID: "r1", TestCaseCode: "1.1", TestName: "Zulu case",  Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act One", TestProcedure: "TP-Zulu",  TestSection: "", Status: "Pass" },
  { TestID: "r2", TestCaseCode: "1.2", TestName: "Ten case",   Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act One", TestProcedure: "TP-10",    TestSection: "", Status: "Not Started" },
  { TestID: "r3", TestCaseCode: "1.3", TestName: "No proc",    Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act One", TestProcedure: "",         TestSection: "", Status: "Not Started" },
  { TestID: "r4", TestCaseCode: "1.4", TestName: "Two case",   Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act One", TestProcedure: "TP-2",     TestSection: "", Status: "Not Started" },
  { TestID: "r5", TestCaseCode: "1.5", TestName: "Alpha case", Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act One", TestProcedure: "TP-Alpha", TestSection: "", Status: "Not Started" },
  { TestID: "s1", TestCaseCode: "2.1", TestName: "Sec Zulu",   Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act Two", TestProcedure: "TP-Zulu",  TestSection: "2. Wayside", Status: "Not Started" },
  { TestID: "s2", TestCaseCode: "2.2", TestName: "Sec Alpha",  Phase: "P1", Location: "Depot", Subsystem: "DCS", Activity: "Act Two", TestProcedure: "TP-Alpha", TestSection: "1. Depot",   Status: "Not Started" },
];

ctx._fixtureRows = rows;
vm.runInContext(
  "TI = _fixtureRows; _activityRecords = []; " +
  "currentRoleUser = { name: 'T', role: 'admin', subsystem: '' }; " +
  "_trEditMode = false; _trDraftItems = null; _trBulkMode = false; _trDrillStatusFilter = '';", ctx);

// Procedure headings, in render order: the <h3> inside each .proc-head.
function procOrder(html) {
  return (html.match(/<h3>[\s\S]*?<\/h3>/g) || []).map(h =>
    h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

const html1 = vm.runInContext("_amDrilldownHTML('P1||Depot||DCS||Act One')", ctx);
ok("_amDrilldownHTML renders the activity", typeof html1 === "string" && html1.includes("Act One"));
ok("sections render in procedure order, '(No Procedure)' last",
   JSON.stringify(procOrder(html1))
     === JSON.stringify(["TP-2", "TP-10", "TP-Alpha", "TP-Zulu", "(No Procedure)"]),
   JSON.stringify(procOrder(html1)));
ok("no test case is lost by the reorder",
   ["Zulu case", "Ten case", "No proc", "Two case", "Alpha case"].every(n => html1.includes(n)));

const html2 = vm.runInContext("_amDrilldownHTML('P1||Depot||DCS||Act Two')", ctx);
ok("sectioned cards keep their section subhead and sort on the procedure",
   JSON.stringify(procOrder(html2)) === JSON.stringify(["1. Depot TP-Alpha", "2. Wayside TP-Zulu"]),
   JSON.stringify(procOrder(html2)));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
