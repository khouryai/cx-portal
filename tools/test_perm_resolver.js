// Unit test for the client-side permission resolver in perms-admin.js.
//
// permBaseline/permEffective MUST mirror the DB's private.has_module_perm()
// + public._perm_baseline() resolution exactly (the UI's "Effective" preview
// must show what RLS will actually do). The expectations below are pinned
// against the deployed SQL:
//   baseline: admin → all 7; standard → view,export,create,edit;
//             read_only → view,export; none/other → [].
//   resolution: inactive → nothing; global admin (role='admin') → everything;
//             override level REPLACES template level; override grants MERGE
//             over template grants; grants true adds / false removes.
//
// Run: node tools/test_perm_resolver.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}
function eqArr(name, got, want) {
  ok(`${name} (=${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { permBaseline, permEffective, PERM_ACTIONS, PERM_CATALOG } = sandbox;
if (typeof permBaseline !== "function" || typeof permEffective !== "function") {
  console.error("FATAL: resolver not found (perms-admin.js not loaded?)"); process.exit(1);
}
const has = (name, arr, key) => ok(`${name} includes ${key}`, Array.isArray(arr) && arr.includes(key), `got ${JSON.stringify(arr)}`);
const lacks = (name, arr, key) => ok(`${name} excludes ${key}`, Array.isArray(arr) && !arr.includes(key), `got ${JSON.stringify(arr)}`);

const ALL = ["view", "export", "create", "edit", "delete", "approve", "manage"];
const user = { role: "field_engineer", is_active: true };

console.log("=== permission resolver (mirror of DB has_module_perm) ===\n");

console.log("permBaseline:");
eqArr("  admin → all 7", permBaseline("admin"), ALL);
eqArr("  standard", permBaseline("standard"), ["view", "export", "create", "edit"]);
eqArr("  read_only", permBaseline("read_only"), ["view", "export"]);
eqArr("  none → []", permBaseline("none"), []);
eqArr("  unknown level → []", permBaseline("bogus"), []);

console.log("\npermEffective — guards:");
eqArr("  inactive user → nothing (even with admin template)",
      permEffective({ role: "field_engineer", is_active: false }, { level: "admin", grants: {} }, null), []);
eqArr("  global admin → everything (template ignored)",
      permEffective({ role: "admin", is_active: true }, { level: "none", grants: {} }, null), ALL);
eqArr("  null profile → nothing", permEffective(null, { level: "admin", grants: {} }, null), []);

console.log("\npermEffective — template only:");
eqArr("  no template row → none-level → []", permEffective(user, null, null), []);
eqArr("  standard baseline", permEffective(user, { level: "standard", grants: {} }, null),
      ["view", "export", "create", "edit"]);
eqArr("  grant true ADDS beyond baseline (read_only + delete)",
      permEffective(user, { level: "read_only", grants: { delete: true } }, null),
      ["view", "export", "delete"]);
eqArr("  grant false REMOVES from baseline (standard − export)",
      permEffective(user, { level: "standard", grants: { export: false } }, null),
      ["view", "create", "edit"]);

console.log("\npermEffective — override semantics:");
eqArr("  override level REPLACES template level (standard → read_only)",
      permEffective(user, { level: "standard", grants: {} }, { level: "read_only", grants: {} }),
      ["view", "export"]);
eqArr("  override grants MERGE over template grants",
      permEffective(user,
        { level: "read_only", grants: { create: true } },          // template adds create
        { level: "read_only", grants: { export: false } }),        // override removes export
      ["view", "create"]);
eqArr("  override grant overwrites the SAME key from template",
      permEffective(user,
        { level: "read_only", grants: { delete: true } },
        { level: "read_only", grants: { delete: false } }),
      ["view", "export"]);
eqArr("  override with empty grants keeps template grants (merge, not replace)",
      permEffective(user,
        { level: "read_only", grants: { manage: true } },
        { level: "standard", grants: {} }),
      ["view", "export", "create", "edit", "manage"]);

console.log("\nordering / shape:");
eqArr("  result is always in canonical PERM_ACTIONS order",
      permEffective(user, { level: "none", grants: { manage: true, view: true } }, null),
      ["view", "manage"]);
ok("  PERM_ACTIONS exported and canonical", JSON.stringify(PERM_ACTIONS) === JSON.stringify(ALL));

// ── module-aware union baseline (mirror of public._perm_baseline(module,level)) ──
console.log("\nmodule-aware baseline (legacy verbs ∪ granular catalog):");
ok("  PERM_CATALOG exported with all 23 modules", PERM_CATALOG && Object.keys(PERM_CATALOG).length === 23,
   `got ${PERM_CATALOG ? Object.keys(PERM_CATALOG).length : "none"}`);
const trS = permBaseline("standard", "test_register");
has("  test_register/standard", trS, "edit_case");
has("  test_register/standard", trS, "add_test_case");
has("  test_register/standard", trS, "edit");            // legacy back-compat verb retained
lacks("  test_register/standard", trS, "bulk_edit");     // grant_only — never in baseline
lacks("  test_register/standard", trS, "delete_case");   // admin-level
const trA = permBaseline("admin", "test_register");
has("  test_register/admin", trA, "delete_case");
has("  test_register/admin", trA, "deploy_field");
has("  test_register/admin", trA, "import");
lacks("  test_register/admin", trA, "bulk_edit");        // grant_only even at admin
has("  photos/standard", permBaseline("standard", "photos"), "delete_own");
lacks("  photos/standard", permBaseline("standard", "photos"), "delete_any");
has("  photos/admin", permBaseline("admin", "photos"), "delete_any");
lacks("  directory/admin", permBaseline("admin", "directory"), "grant_global_admin"); // grant_only

console.log("\nmodule-aware grants + ownership keys:");
has("  grant_only key added by explicit grant",
    permEffective(user, { level: "standard", grants: { bulk_edit: true } }, null, "test_register"), "bulk_edit");
const pAdmin = permEffective(user, { level: "admin", grants: {} }, null, "photos");
has("  photos admin baseline carries delete_own", pAdmin, "delete_own");
has("  photos admin baseline carries delete_any", pAdmin, "delete_any");
eqArr("  unknown module falls back to legacy baseline", permBaseline("standard", "no_such_module"),
      ["view", "export", "create", "edit"]);

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
