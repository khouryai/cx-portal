// Characterization test for Activity Template deployment row planning —
// _deployPlanRows / _deployTestId / _deployDuplicateIds (tpl-deploy.js).
//
// Regression: deploying "IXL Wayside SAT - LAB TESTING" failed with
//   test_items insert failed (409) 23505 duplicate key ... "test_items_pkey"
// because three of its cases share code 4.2, three share 4.3 and two share
// 4.4, and the old builder keyed test_id (and the row's content) off the CODE.
// Run: node tools/test_tpl_deploy.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load failed in", loadErrorFile, "\n", loadError.message); process.exit(1); }

const plan = sandbox._deployPlanRows, dupIds = sandbox._deployDuplicateIds;
ok("_deployPlanRows is a function", typeof plan === "function");
ok("_deployDuplicateIds is a function", typeof dupIds === "function");
if (typeof plan !== "function") { process.exit(1); }

const NOW = "2026-09-10T00:00:00.000Z";
const sel = (tcCodes) => ({ locId: "W40", locName: "W40 Millbrae Station", phaseName: "Phase 2", tcCodes });

// ── The real shape that broke: duplicate codes across different cases ───────
const lab = { name: "IXL Wayside SAT - LAB TESTING", subsystem: "IXL", testCases: [
  { code: "4.1", name: "Route setting",                              procedure: "TP-A", section: "4. CBTC" },
  { code: "4.2", name: "CBTC track status information (output to ZC)", procedure: "TP-A", section: "4. CBTC" },
  { code: "4.3", name: "CBTC_FREE_TO_MOVE Test",                     procedure: "TP-A", section: "4. CBTC" },
  { code: "4.2", name: "CBTC Approach Locking",                      procedure: "TP-B", section: "5. Locking" },
  { code: "4.3", name: "CBTC track status information (input from ZC)", procedure: "TP-B", section: "5. Locking" },
  { code: "4.4", name: "Switch blocking",                            procedure: "TP-B", section: "5. Locking" },
  { code: "4.2", name: "Permissive aspect (non-CBTC mode)",          procedure: "TP-C", section: "6. Non-CBTC" },
  { code: "4.3", name: "Call-on (non-CBTC mode)",                    procedure: "TP-C", section: "6. Non-CBTC" },
  { code: "4.4", name: "Make operation (non-CBTC mode)",             procedure: "TP-C", section: "6. Non-CBTC" },
]};
const allCodes = lab.testCases.map(tc => tc.code);   // what deployAddLocation stores
const p = plan(lab, sel(allCodes), "dep-1", NOW);

ok("every template case is deployed, not just the distinct codes", p.length === 9, `got ${p.length}`);
ok("no duplicate test_ids — the 23505 is gone", dupIds(p).length === 0, JSON.stringify(dupIds(p)));
ok("test_ids are unique across the batch",
   new Set(p.map(x => x.row.test_id)).size === 9);

// Each occurrence keeps ITS OWN content — the silent data loss half of the bug.
const byName = Object.fromEntries(p.map(x => [x.row.test_name, x.row]));
ok("2nd case with code 4.2 keeps its own name/procedure/section",
   byName["CBTC Approach Locking"]?.test_case_code === "4.2"
   && byName["CBTC Approach Locking"]?.test_procedure === "TP-B"
   && byName["CBTC Approach Locking"]?.test_section === "5. Locking");
ok("3rd case with code 4.3 keeps its own name/procedure/section",
   byName["Call-on (non-CBTC mode)"]?.test_case_code === "4.3"
   && byName["Call-on (non-CBTC mode)"]?.test_procedure === "TP-C"
   && byName["Call-on (non-CBTC mode)"]?.test_section === "6. Non-CBTC");
ok("no occurrence inherited the first same-code case's name",
   p.filter(x => x.row.test_name === "CBTC track status information (output to ZC)").length === 1);

// Id shape: unchanged for unique codes, suffixed only where it must be.
ok("a code unique in the template keeps the original id shape",
   byName["Route setting"].test_id === "dep-1-W40-4.1");
ok("duplicated codes get a URL-safe positional suffix",
   p.filter(x => x.row.test_case_code === "4.2").map(x => x.row.test_id).join(",")
     === "dep-1-W40-4.2~1,dep-1-W40-4.2~3,dep-1-W40-4.2~6");
ok("suffixed ids survive an encodeURIComponent round-trip",
   p.every(x => decodeURIComponent(encodeURIComponent(x.row.test_id)) === x.row.test_id));

// ── Selection, plumbing and the ordinary (unique-code) template ─────────────
const partial = plan(lab, sel(["4.4"]), "dep-2", NOW);
ok("selection still filters by code — both 4.4 cases deploy", partial.length === 2);
ok("unselected codes are dropped", plan(lab, sel([]), "dep-3", NOW).length === 0);

ok("plan carries tc + sel back to the caller (asset/form steps)",
   p[0].tc === lab.testCases[0] && p[0].sel.locId === "W40");
ok("row fields come from the selection and template",
   p[0].row.phase === "Phase 2" && p[0].row.location === "W40 Millbrae Station"
   && p[0].row.subsystem === "IXL" && p[0].row.activity === lab.name
   && p[0].row.status === "Not Started" && p[0].row.weight === 1
   && p[0].row.synced_at === NOW && p[0].row.test_category === null);

const clean = { name: "Clean", subsystem: "IXL", testCases: [
  { code: "1.1", name: "A" }, { code: "1.2", name: "B", scopeType: "dynamic" },
]};
const cp = plan(clean, sel(["1.1", "1.2"]), "dep-4", NOW);
ok("a template with unique codes is completely unaffected",
   cp.map(x => x.row.test_id).join(",") === "dep-4-W40-1.1,dep-4-W40-1.2");
ok("scope_type still maps dynamic/static",
   cp[0].row.scope_type === "static" && cp[1].row.scope_type === "dynamic");
ok("missing name falls back to the code",
   plan({ name: "T", testCases: [{ code: "9.9" }] }, sel(["9.9"]), "dep-5", NOW)[0].row.test_name === "9.9");

// ── Guard + degenerate inputs ──────────────────────────────────────────────
ok("_deployDuplicateIds reports a collision when one exists",
   dupIds([{ row: { test_id: "x" } }, { row: { test_id: "x" } }]).length === 1);
ok("empty / missing template is safe",
   plan({ testCases: [] }, sel(["1.1"]), "d", NOW).length === 0
   && plan({}, sel(["1.1"]), "d", NOW).length === 0);

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
