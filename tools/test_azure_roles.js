"use strict";
// The Azure database roles (supabase/sql/azure_before_restore.sql).
//
// The gateway's login (`authenticator`) may switch only to `anon` and
// `authenticated`, both subject to row-level security. On Supabase,
// `service_role` bypasses row-level security; on Azure it must not, and the
// gateway must not be able to become it — otherwise the gateway's password
// alone would read every row. BYPASSRLS would also break the script on Azure:
// the administrator is not a superuser, and only a role with BYPASSRLS may
// create one (verified against PostgreSQL 16+ as a CREATEROLE non-superuser).
//   Run: node tools/test_azure_roles.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
console.log("=== Azure database roles ===\n");

const code = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/--[^\n]*/g, "");
const before = code("supabase/sql/azure_before_restore.sql");
const grants = before.match(/grant\s+[^;]*\bto\s+authenticator\s*;/gi) || [];

ok("the gateway login is granted anon and authenticated",
  grants.some((g) => /\banon\b/.test(g) && /\bauthenticated\b/.test(g)), grants.join(" | "));
ok("…and never service_role", !grants.some((g) => /\bservice_role\b/.test(g)), grants.join(" | "));
ok("no role is created with BYPASSRLS", !/\bbypassrls\b/i.test(before));
ok("a database prepared by the old script has service_role revoked from the gateway",
  /revoke\s+service_role\s+from\s+authenticator/i.test(before));
ok("the personal-trial runbook matches",
  !/grant anon, authenticated, service_role to authenticator/.test(fs.readFileSync(path.join(ROOT, "azure/RUNBOOK.md"), "utf8")));

// The gateway's connection string carries the authenticator password: it must
// be a Container Apps secret, never a plain setting anyone with Reader can see.
const bicep = fs.readFileSync(path.join(ROOT, "infra/main.bicep"), "utf8");
ok("the template never sets the gateway connection string as a plain value",
  !/name:\s*'PGRST_DB_URI',\s*value:/.test(bicep));
ok("…it is a Container Apps secret, referenced by both containers",
  /name:\s*'PGRST_DB_URI',\s*secretRef:\s*'pgrst-db-uri'/.test(bicep) &&
  (bicep.match(/\.\.\.pgrstDbUriEnv/g) || []).length === 2 && /secrets:\s*pgrstSecrets/.test(bicep));
ok("the personal-trial script stores it as a secret too",
  /secretref:pgrst-db-uri/.test(fs.readFileSync(path.join(ROOT, "azure/configure-postgrest.sh"), "utf8")) &&
  !/"PGRST_DB_URI=\$\{DB_URI\}"/.test(fs.readFileSync(path.join(ROOT, "azure/configure-postgrest.sh"), "utf8")));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
