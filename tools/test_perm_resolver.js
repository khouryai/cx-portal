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
const { permBaseline, permEffective, PERM_ACTIONS } = sandbox;
if (typeof permBaseline !== "function" || typeof permEffective !== "function") {
  console.error("FATAL: resolver not found (perms-admin.js not loaded?)"); process.exit(1);
}

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

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
