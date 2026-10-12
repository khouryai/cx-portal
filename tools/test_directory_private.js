"use strict";
// The directory is private to those who manage it
// (supabase/sql/supabase_directory_private.sql).
//
// Starts from the live shape (any signed-in user reads every profile), applies
// the script, then checks as the gateway runs requests: a person sees only
// their own profile; Directory or Admin rights see everyone; every signed-in
// user still gets the names and roles other screens need, and nothing else;
// nobody signed out gets anything.
//
// Needs PostgreSQL on 127.0.0.1:5433 (superuser `postgres`, trust auth); skips
// cleanly without.   Run: node tools/test_directory_private.js
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "cx_directory_private_test";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const psql = (args) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const pg = (sql) => psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql]);
const fails = (sql) => { try { pg(sql); return ""; } catch (e) { return String(e.stderr || e.message); } };

console.log("=== the directory is private to those who manage it ===\n");
try { psql(["-XAtqc", "select 1"]); }
catch (e) { console.log("SKIPPED: no PostgreSQL reachable on 127.0.0.1:5433\n0 passed, 0 failed."); process.exit(0); }

const ANA = "11111111-0000-4000-8000-000000000001";   // field engineer
const BEN = "22222222-0000-4000-8000-000000000002";   // directory manager
const GONE = "33333333-0000-4000-8000-000000000003";  // deactivated

psql(["-XAtq", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
try {
  pg(`do $$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      end $$;
      create schema private;`);
  psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq", "-f", path.join(ROOT, "supabase/sql/azure_auth_uid_shim.sql")]);
  pg(`create function private.has_module_perm(p_module text, p_action text) returns boolean language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'test_perms' ? (p_module || '.' || p_action), false) $$;
      grant usage on schema private, auth to authenticated, anon; grant execute on all functions in schema private, auth to authenticated, anon;
      create table public.profiles (id uuid primary key, email text, full_name text, role text, company text, is_active boolean default true);
      alter table public.profiles enable row level security;
      grant select on public.profiles to authenticated, anon;
      create policy profiles_select on public.profiles for select using ((select auth.role()) = 'authenticated');
      insert into public.profiles values
        ('${ANA}', 'ana@hitachirail.com', 'Ana Lopez', 'field_engineer', 'Hitachi Rail', true),
        ('${BEN}', 'ben@hitachirail.com', 'Ben Ito', 'readonly', 'Hitachi Rail', true),
        ('${GONE}', 'gone@bart.gov', 'Gone Person', 'readonly', 'BART', false);`);
  const as = (uid, perms, sql) => pg(`set request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated", test_perms: perms })}';
    set role authenticated; ${sql}`);
  ok("before: any signed-in user reads every email (the gap being closed)",
    as(ANA, [], "select count(*) from public.profiles") === "3");

  psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq", "-f", path.join(ROOT, "supabase/sql/supabase_directory_private.sql")]);
  psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq", "-f", path.join(ROOT, "supabase/sql/supabase_directory_private.sql")]);
  ok("the script runs twice without error", true);

  ok("a person without Directory rights reads only their own profile",
    as(ANA, ["photos.view"], "select string_agg(email, ',') from public.profiles") === "ana@hitachirail.com");
  ok("…but still gets the names and roles other screens need (active people only)",
    as(ANA, [], "select string_agg(full_name || ':' || role, ',') from public.portal_people()") === "Ana Lopez:field_engineer,Ben Ito:readonly");
  ok("…and that list carries no email, company or id",
    pg("select pg_get_function_result('public.portal_people()'::regprocedure)") === "TABLE(full_name text, role text)");
  ok("someone with Directory rights reads the whole directory",
    as(BEN, ["directory.view"], "select count(*) from public.profiles") === "3");
  ok("…and so does someone with Admin rights", as(BEN, ["admin.view"], "select count(*) from public.profiles") === "3");
  ok("a signed-out request gets no profiles",
    pg("set request.jwt.claims = '{}'; set role anon; select count(*) from public.profiles") === "0");
  ok("…and cannot call the name list", /permission denied/.test(fails("set role anon; select * from public.portal_people()")));
  ok("a token without a person gets an empty name list",
    pg(`set request.jwt.claims = '{"role":"authenticated"}'; set role authenticated; select count(*) from public.portal_people()`) === "0");
} catch (e) {
  ok("runs", false, String(e.stderr || e.message));
} finally {
  try { psql(["-XAtqc", `drop database if exists ${DB} with (force)`]); } catch (e) { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
