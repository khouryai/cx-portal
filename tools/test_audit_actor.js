"use strict";
// The change log records WHO made each change — under Supabase AND under
// Microsoft Entra (supabase/sql/azure_audit_actor.sql).
//
// Runs on a real PostgreSQL with the gateway's roles, simulating what PostgREST
// does per request (request.jwt.claims + SET ROLE). Needs PostgreSQL on
// 127.0.0.1:5433 (superuser `postgres`, trust auth); skips cleanly without.
//   Run: node tools/test_audit_actor.js
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "cx_audit_actor_test";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const pg = (sql) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-d", DB,
  "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

console.log("=== change log records who made the change ===\n");
try { execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-XAtqc", "select 1"], { stdio: "ignore" }); }
catch (e) { console.log("SKIPPED: no PostgreSQL reachable on 127.0.0.1:5433\n0 passed, 0 failed."); process.exit(0); }

const U = "11111111-aaaa-bbbb-cccc-000000000001";
execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-XAtq", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`], { stdio: "ignore" });
try {
  pg(`do $$ begin
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      end $$;
      create table public.profiles (id uuid primary key, email text, full_name text);
      create table public.db_change_log (id bigserial primary key, table_name text, record_id text, operation text,
        changed_at timestamptz default now(), changed_by text, actor_email text, actor_role text,
        changed_columns text[], old_row jsonb, new_row jsonb, source text);
      create table public.punch_items (id serial primary key, title text, status text);
      grant all on public.punch_items to authenticated; grant usage, select on sequence punch_items_id_seq to authenticated;
      insert into public.profiles values ('${U}', 'alexander.khoury@hitachirail.com', 'Alexander Khoury');`);
  execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq",
    "-f", path.join(ROOT, "supabase/sql/azure_audit_actor.sql")], { stdio: ["ignore", "pipe", "pipe"] });
  pg(`create trigger audit_punch after insert or update or delete on public.punch_items
        for each row execute function public.audit_db_change()`);

  const asRequest = (claims, sql) => pg(`set request.jwt.claims = '${JSON.stringify(claims)}'; set role authenticated; ${sql}`);
  const last = () => pg(`select coalesce(changed_by,'∅') || ' | ' || coalesce(actor_email,'∅') || ' | ' || coalesce(actor_role,'∅')
                          || ' | ' || operation from public.db_change_log order by id desc limit 1`);

  // Microsoft Entra: oid + roles, no email, no role claim.
  asRequest({ oid: U, roles: ["authenticated"], name: "Alexander Khoury" }, "insert into public.punch_items (title) values ('cable')");
  ok("Entra token without email: the change is still attributed to the person",
    last() === "alexander.khoury@hitachirail.com | alexander.khoury@hitachirail.com | authenticated | INSERT", last());

  // Supabase: sub + email + role.
  asRequest({ sub: U, email: "alexander.khoury@hitachirail.com", role: "authenticated" }, "update public.punch_items set status = 'closed'");
  ok("Supabase token: exactly as before (email, email, authenticated)",
    last() === "alexander.khoury@hitachirail.com | alexander.khoury@hitachirail.com | authenticated | UPDATE", last());
  ok("changed columns are still recorded", pg("select changed_columns::text from public.db_change_log order by id desc limit 1") === "{status}");

  // Entra user with no portal profile yet (first sign-in edge): fall back to the token.
  asRequest({ oid: "22222222-aaaa-bbbb-cccc-000000000002", roles: ["authenticated"], preferred_username: "guest@bart.gov" },
    "delete from public.punch_items");
  ok("no profile yet: falls back to the address in the token", last() === "guest@bart.gov | guest@bart.gov | authenticated | DELETE", last());

  // A system change (no request at all) stays anonymous rather than guessing.
  pg("insert into public.punch_items (title) values ('seeded')");
  ok("a change outside any request has no actor", last() === "∅ | ∅ | ∅ | INSERT", last());

  // A malformed id in a token must never break the write itself.
  asRequest({ sub: "not-a-uuid", email: "x@y.z" }, "insert into public.punch_items (title) values ('still saved')");
  ok("a malformed user id does not block the change", pg("select count(*) from public.punch_items where title='still saved'") === "1");
} finally {
  try { execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-XAtqc", `drop database if exists ${DB} with (force)`], { stdio: "ignore" }); } catch (e) { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
