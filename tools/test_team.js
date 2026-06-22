// Unit test for the pure helpers in team.js (real fns via tools/_load_app.js):
//   _teamInitials(name) — avatar initials, incl. "A / B" multi-person + TBD
//   _teamRows(members)  — group into ordered level rows
// (CRUD + render go through Supabase/DOM and are covered by the smoke load.)
//
// Run: node tools/test_team.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { _teamInitials, _teamRows, _buildTeamTree } = sandbox;
if (typeof _teamInitials !== "function" || typeof _teamRows !== "function" ||
    typeof _buildTeamTree !== "function") {
  console.error("FATAL: team helpers not found"); process.exit(1);
}

console.log("=== team.js helpers ===\n");

console.log("_teamInitials:");
ok("  two-word name → first letters", _teamInitials("Christopher Burford") === "CB");
ok("  single name → one letter", _teamInitials("Madonna") === "M");
ok("  multi-person 'A / B' → first letter of first two tokens",
   _teamInitials("Alex Khoury / Syed Rahman") === "AK");
ok("  TBD → '?'", _teamInitials("TBD") === "?");
ok("  empty/null → '?'", _teamInitials("") === "?" && _teamInitials(null) === "?");
ok("  caps the result at 2", _teamInitials("a b c d e").length === 2);

console.log("\n_teamRows:");
{
  const members = [
    { name: "Top", level: 0, sort_order: 0 },
    { name: "B1", level: 1, sort_order: 1 },
    { name: "A1", level: 1, sort_order: 0 },
    { name: "C2", level: 2, sort_order: 0 },
  ];
  const rows = _teamRows(members);
  ok("  one row per distinct level (3)", rows.length === 3);
  ok("  rows ordered by level ascending", rows[0][0].level === 0 && rows[2][0].level === 2);
  ok("  level-1 row preserves the input order it was given",
     rows[1].map((m) => m.name).join(",") === "B1,A1");
  ok("  empty input → no rows", _teamRows([]).length === 0 && _teamRows(null).length === 0);
}

console.log("\n_buildTeamTree:");
{
  const members = [
    { id: "mgr", name: "Manager", level: 0, sort_order: 0, reports_to: null },
    { id: "ats", name: "Lead ATS", level: 1, sort_order: 1, reports_to: "mgr" },
    { id: "cbtc", name: "Lead CBTC", level: 1, sort_order: 0, reports_to: "mgr" },
    { id: "ats1", name: "ATS One", level: 2, sort_order: 0, reports_to: "ats" },
    { id: "ats2", name: "ATS Two", level: 2, sort_order: 1, reports_to: "ats" },
  ];
  const roots = _buildTeamTree(members);
  ok("  one root (the manager)", roots.length === 1 && roots[0].id === "mgr");
  ok("  manager has 2 direct reports", roots[0].children.length === 2);
  ok("  siblings ordered by sort_order (CBTC before ATS)",
     roots[0].children.map((c) => c.id).join(",") === "cbtc,ats");
  const ats = roots[0].children.find((c) => c.id === "ats");
  ok("  ATS lead branch carries the 2 ATS members", ats.children.length === 2);
  ok("  deep report nested under its lead, not at root",
     roots.length === 1 && ats.children.map((c) => c.id).sort().join(",") === "ats1,ats2");
  ok("  orphaned reports_to falls back to a root",
     _buildTeamTree([{ id: "x", name: "X", level: 3, sort_order: 0, reports_to: "ghost" }]).length === 1);
  ok("  empty input → no roots", _buildTeamTree([]).length === 0 && _buildTeamTree(null).length === 0);
}

console.log("\n_teamDescendantIds (re-parent cycle guard):");
{
  const members = [
    { id: "mgr", name: "Manager", level: 0, sort_order: 0, reports_to: null },
    { id: "ats", name: "Lead ATS", level: 1, sort_order: 0, reports_to: "mgr" },
    { id: "ats1", name: "ATS One", level: 2, sort_order: 0, reports_to: "ats" },
    { id: "cbtc", name: "Lead CBTC", level: 1, sort_order: 1, reports_to: "mgr" },
  ];
  const { _teamDescendantIds } = sandbox;
  const ds = _teamDescendantIds("ats", members);
  ok("  includes self", ds.has("ats"));
  ok("  includes nested report", ds.has("ats1"));
  ok("  excludes unrelated branch", !ds.has("cbtc"));
  ok("  manager's set covers the whole tree", _teamDescendantIds("mgr", members).size === 4);
}

console.log("\n_teamFitScale (fit-to-window scaling):");
{
  const { _teamFitScale } = sandbox;
  ok("  wide chart scales down to fit", _teamFitScale(1900, 950) === 0.5);
  ok("  chart narrower than window is never enlarged", _teamFitScale(600, 1200) === 1);
  ok("  exact fit stays at 1", _teamFitScale(1000, 1000) === 1);
  ok("  zero/undefined measurement → no scaling (1)",
     _teamFitScale(0, 1000) === 1 && _teamFitScale(1900, 0) === 1 && _teamFitScale(undefined, undefined) === 1);
  ok("  readability floor caps how small it shrinks", _teamFitScale(2000, 1000, 0.8) === 0.8);
  ok("  floor doesn't kick in when it already fits larger", _teamFitScale(1100, 1000, 0.8) > 0.8);
  ok("  floor never enlarges a chart that fits", _teamFitScale(500, 1000, 0.8) === 1);
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
