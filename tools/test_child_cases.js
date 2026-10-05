// Unit + characterization test for child test cases (tr-children.js, the
// child planner in tpl-deploy.js, and the child-aware Forms scoping in app.js).
//
// A parent test case carries one child test case per device. The device name
// lives in child_label; code + name are the parent's (so the shared weight key
// holds); the parent's status is derived from its latest-attempt children; and
// a form can cover all children or be linked to one child (keyed to the child's
// original attempt so it follows retests).
// Run: node tools/test_child_cases.js
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

const need = ["_parentRollupStatus", "_childDbRow", "_childKey", "_childrenOf", "_childNewId",
  "_deployChildNames", "_deployPlanRows", "_deployPlanChildRows", "_deployDuplicateIds",
  "_formsForTestRow", "_formsAttachmentPlanForTestCase", "_formPickerVisibleForms", "_fpResolveContext"];
const missing = need.filter((f) => typeof sandbox[f] !== "function");
ok("child test case helpers are loaded", missing.length === 0, missing.join(", "));
if (missing.length) { console.log(`\n${pass} passed, ${fail + 1} failed.\n`); process.exit(1); }

console.log("=== child test cases ===\n");

// ── Parent status roll-up ────────────────────────────────────────────────────
console.log("_parentRollupStatus:");
const roll = (...st) => sandbox._parentRollupStatus(st.map((s) => ({ Status: s })));
ok("  no children → null (parent keeps its own status)", sandbox._parentRollupStatus([]) === null);
ok("  all Future Test → Future Test", roll("Future Test", "Future Test") === "Future Test");
ok("  all Pass / Not Applicable → Pass", roll("Pass", "Not Applicable", "Pass") === "Pass");
ok("  any started → In Progress", roll("Pass", "Not Started") === "In Progress");
ok("  a Fail rolls up to In Progress (not Fail)", roll("Fail", "Pass") === "In Progress");
ok("  all Not Started → Not Started", roll("Not Started", "Not Started") === "Not Started");
ok("  a missing status counts as Not Started", roll(undefined, "Not Started") === "Not Started");

// ── Child row shape ─────────────────────────────────────────────────────────
console.log("\n_childDbRow:");
const parentDb = {
  test_id: "P1", phase: "Phase 2", location: "W40", subsystem: "ZC", activity: "ZC SAT",
  test_category: null, test_case_code: "4.1", test_name: "Zone controller boot",
  test_procedure: "PROC-9", test_section: "Hardware", scope_type: "dynamic",
};
const child = sandbox._childDbRow(parentDb, "  702A  ", "P1~c1");
ok("  keeps the parent's code + name (shared weight key)",
   child.test_case_code === "4.1" && child.test_name === "Zone controller boot");
ok("  device name goes in child_label, trimmed", child.child_label === "702A");
ok("  links to its parent and is not itself a parent",
   child.parent_test_id === "P1" && child.is_parent === false && child.test_id === "P1~c1");
ok("  is always static scope, even under a dynamic parent", child.scope_type === "static");
ok("  starts Not Started with weight 1", child.status === "Not Started" && child.weight === 1);
ok("  copies placement from the parent",
   child.phase === "Phase 2" && child.location === "W40" && child.subsystem === "ZC" && child.activity === "ZC SAT");
ok("  carries no device/asset reference", !("asset_id" in child));

// ── Keys, membership, ids ───────────────────────────────────────────────────
console.log("\n_childKey / _childrenOf / _childNewId:");
vm.runInContext(`TI = [
  { TestID: 'P', IsParent: true, TestCaseCode: '4.1', TestName: 'ZC boot', Status: 'In Progress' },
  { TestID: 'c1', ParentTestId: 'P', ChildLabel: '702A', RegressionGroupId: 'c1', Status: 'Fail', IsLatestAttempt: false },
  { TestID: 'c1::r2', ParentTestId: 'P', ChildLabel: '702A', RegressionGroupId: 'c1', Status: 'Pass', IsLatestAttempt: true },
  { TestID: 'c2', ParentTestId: 'P', ChildLabel: '702B', Status: 'Pass' },
  { TestID: 'S', TestCaseCode: '5.0', TestName: 'Standalone', Status: 'Pass' },
];`, ctx);
ok("  a retest keys to the child's original attempt", sandbox._childKey({ TestID: "c1::r2", RegressionGroupId: "c1" }) === "c1");
ok("  an original attempt keys to itself", sandbox._childKey({ TestID: "c2" }) === "c2");
ok("  _childrenOf skips superseded attempts by default",
   sandbox._childrenOf("P").map((c) => c.TestID).join(",") === "c1::r2,c2");
ok("  _childrenOf can include every attempt", sandbox._childrenOf("P", { allAttempts: true }).length === 3);
ok("  a superseded Fail no longer blocks the parent's Pass",
   sandbox._parentRollupStatus(sandbox._childrenOf("P")) === "Pass");
const nid = sandbox._childNewId("P");
ok("  new child ids are prefixed by the parent and unused",
   nid.startsWith("P~c") && !vm.runInContext("TI", ctx).some((r) => r.TestID === nid));

// ── Template deploy ─────────────────────────────────────────────────────────
console.log("\n_deployChildNames / _deployPlanChildRows:");
ok("  reads the children list", sandbox._deployChildNames({ children: "702A, 702B" }).join("|") === "702A|702B");
ok("  still reads templates saved under the old key",
   sandbox._deployChildNames({ assets: "MLK A,MLK B" }).join("|") === "MLK A|MLK B");
ok("  trims, drops blanks and case-insensitive repeats",
   sandbox._deployChildNames({ children: " a , ,A, b " }).join("|") === "a|b");
ok("  no list → no children", sandbox._deployChildNames({}).length === 0 && sandbox._deployChildNames(null).length === 0);

const tpl = { name: "Power SAT", subsystem: "PWR", testCases: [
  { code: "3.02.00", name: "Panel energisation", children: "Essential Panelboard 738, Power DCS LV Enclosure 739" },
  { code: "3.03.00", name: "Earthing check" },
]};
const sel = { locId: "L1", locName: "OTUH", phaseName: "Phase 1", tcCodes: ["3.02.00", "3.03.00"] };
const plan = sandbox._deployPlanRows(tpl, sel, "dep-9", "2026-10-05T00:00:00.000Z");
ok("  a case with children deploys as a parent", plan[0].row.is_parent === true);
ok("  a case without children deploys as an ordinary test case", plan[1].row.is_parent === false);
const kids = sandbox._deployPlanChildRows(plan);
ok("  one child row per child name", kids.length === 2);
ok("  child ids hang off the new parent id",
   kids.map((k) => k.test_id).join(",") === "dep-9-L1-3.02.00~c1,dep-9-L1-3.02.00~c2");
ok("  children inherit the parent's code, name and placement",
   kids.every((k) => k.parent_test_id === "dep-9-L1-3.02.00" && k.test_case_code === "3.02.00"
     && k.test_name === "Panel energisation" && k.location === "OTUH" && k.subsystem === "PWR"));
ok("  children are labelled by device", kids[1].child_label === "Power DCS LV Enclosure 739");
ok("  parents + children produce no duplicate ids",
   sandbox._deployDuplicateIds([...plan, ...kids.map((row) => ({ row }))]).length === 0);

// ── Forms scoped to child test cases ────────────────────────────────────────
console.log("\nForms scope:");
vm.runInContext(`
  FORMS = [{ id: 'fAll', name: 'Panel sheet' }, { id: 'fA', name: '702A sheet' },
           { id: 'fB', name: '702B sheet' }, { id: 'fS', name: 'Standalone sheet' }];
  FORM_TEST_LINKS = [
    { id: 1, form_id: 'fAll', test_id: 'P' },   // covers all child test cases
    { id: 2, form_id: 'fA',   test_id: 'c1' },  // 702A only (keyed to its original attempt)
    { id: 3, form_id: 'fB',   test_id: 'c2' },  // 702B only
    { id: 4, form_id: 'fS',   test_id: 'S' },
  ];`, ctx);
const ids = (forms) => forms.map((f) => f.id).sort().join(",");
const row = (id) => vm.runInContext("TI", ctx).find((r) => r.TestID === id);
ok("  a child sees forms covering all + its own", ids(sandbox._formsForTestRow(row("c2"))) === "fAll,fB");
ok("  a retested child keeps its device's form", ids(sandbox._formsForTestRow(row("c1::r2"))) === "fA,fAll");
ok("  the parent sees every form on the test case", ids(sandbox._formsForTestRow(row("P"))) === "fA,fAll,fB");
ok("  a standalone test case sees only its own", ids(sandbox._formsForTestRow(row("S"))) === "fS");

const planP = sandbox._formsAttachmentPlanForTestCase(row("P"));
ok("  the report extract lists each form once with its scope",
   planP.map((e) => e.scopeLabel).join("|") === "Covers all child test cases|Child: 702A|Child: 702B");
ok("  the picker from 702A shows inherited + 702A only",
   sandbox._formPickerVisibleForms("P", "c1").map((r) => r.form.id).sort().join(",") === "fA,fAll");
const c = sandbox._fpResolveContext("c1::r2", "");
ok("  opening forms from a child resolves to its parent + child scope",
   c.parentTestId === "P" && c.childKey === "c1" && c.childLabel === "702A");

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
