"use strict";
// private.relink_profile() — moving a profile onto a person's Entra object id.
//
// Under Entra the app finds a profile by the token's `oid`. This function moves
// a profile (and every reference to it) onto that id, keyed on email. It runs
// on a real PostgreSQL against a schema with the same shapes the portal has:
// foreign keys with and without ON DELETE CASCADE, plain uuid columns, uuid
// arrays, a view, and the profiles privilege-guard trigger.
//
// Needs PostgreSQL on 127.0.0.1:5433 (superuser `postgres`, trust auth); skips
// cleanly without.   Run: node tools/test_relink_profile.js
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "cx_relink_test";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const pg = (db, sql) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-d", db,
  "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const fails = (sql) => { try { pg(DB, sql); return null; } catch (e) { return String(e.stderr || e.message); } };

console.log("=== relink a profile to its Entra object id ===\n");
try { pg("postgres", "select 1"); } catch (e) {
  console.log("SKIPPED: no PostgreSQL reachable on 127.0.0.1:5433\n0 passed, 0 failed.");
  process.exit(0);
}

const OLD = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000002";
const NEW = "cccccccc-1111-2222-3333-444444444444";

pg("postgres", `drop database if exists ${DB}`);
pg("postgres", `create database ${DB}`);
try {
  pg(DB, `
    create schema private;
    create table public.templates (id uuid primary key);
    create table public.profiles (
      id uuid primary key, email text unique, full_name text, role text,
      is_active boolean default true, permission_template_id uuid references public.templates(id));
    -- the real privilege guard: blocks role/active/template changes, not id changes
    create function private.has_module_perm(text, text) returns boolean language sql as $$ select false $$;
    create function public.guard() returns trigger language plpgsql as $$ begin
      if (new.role is distinct from old.role or new.is_active is distinct from old.is_active
          or new.permission_template_id is distinct from old.permission_template_id)
         and not private.has_module_perm('directory','edit') then raise exception 'guard'; end if;
      return new; end $$;
    create trigger trg_guard before update on public.profiles for each row execute function public.guard();
    create table public.drawing_markups (id serial primary key,
      created_by uuid references public.profiles(id), published_by uuid references public.profiles(id));
    create table public.user_module_overrides (user_id uuid references public.profiles(id) on delete cascade, module_key text);
    create table public.punch_items (id serial primary key, created_by uuid, title text);
    create table public.crews (id serial primary key, member_ids uuid[]);
    create view public.my_markups as select * from public.drawing_markups;
    insert into public.templates values ('dddddddd-0000-0000-0000-000000000000');
    insert into public.profiles values
      ('${OLD}', 'Aik.Khoury@Example.com', 'Aik', 'admin', true, 'dddddddd-0000-0000-0000-000000000000'),
      ('${OTHER}', 'someone@example.com', 'Someone', 'readonly', true, null);
    insert into public.drawing_markups (created_by, published_by) values ('${OLD}', '${OLD}'), ('${OTHER}', '${OLD}');
    insert into public.user_module_overrides values ('${OLD}', 'photos'), ('${OTHER}', 'photos');
    insert into public.punch_items (created_by, title) values ('${OLD}', 'mine'), ('${OTHER}', 'theirs');
    insert into public.crews (member_ids) values (array['${OLD}', '${OTHER}']::uuid[]);
  `);
  execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq",
    "-f", path.join(ROOT, "supabase/sql/azure_relink_profile.sql")], { stdio: ["ignore", "pipe", "pipe"] });
  const fkDefs = () => pg(DB, `select string_agg(conname || ' ' || pg_get_constraintdef(oid), ' | ' order by conname)
    from pg_constraint where contype='f' and confrelid='public.profiles'::regclass`);
  const before = fkDefs();

  const n = Number(pg(DB, `select private.relink_profile('  aik.khoury@example.com ', '${NEW}')`));
  ok("matches the email regardless of case and spaces, and reports what moved", n === 7, "changed " + n);
  ok("the profile now has the Entra id, with role, template and status intact",
    pg(DB, `select role || ',' || is_active || ',' || (permission_template_id is not null) from public.profiles where id='${NEW}'`) === "admin,true,true");
  ok("the old id is gone everywhere",
    pg(DB, `select (select count(*) from public.profiles where id='${OLD}') + (select count(*) from public.drawing_markups where created_by='${OLD}' or published_by='${OLD}')
      + (select count(*) from public.user_module_overrides where user_id='${OLD}') + (select count(*) from public.punch_items where created_by='${OLD}')
      + (select count(*) from public.crews where '${OLD}' = any(member_ids))`) === "0");
  ok("foreign-key references moved", pg(DB, `select count(*) from public.drawing_markups where published_by='${NEW}'`) === "2");
  ok("plain uuid columns moved (ownership kept)", pg(DB, `select title from public.punch_items where created_by='${NEW}'`) === "mine");
  ok("uuid arrays moved, other members kept",
    pg(DB, `select member_ids::text from public.crews`) === `{${NEW},${OTHER}}`);
  ok("another person's rows are untouched",
    pg(DB, `select count(*) from public.punch_items where created_by='${OTHER}'`) === "1" &&
    pg(DB, `select count(*) from public.user_module_overrides where user_id='${OTHER}'`) === "1");
  ok("foreign keys are restored exactly, ON DELETE CASCADE included", fkDefs() === before, fkDefs());
  ok("running it again changes nothing", pg(DB, `select private.relink_profile('aik.khoury@example.com', '${NEW}')`) === "0");
  ok("an unknown email is refused", /no profile with email/.test(fails(`select private.relink_profile('nobody@example.com', '${NEW}')`) || ""));
  ok("an id another profile already uses is refused, and nothing changes",
    /already uses id/.test(fails(`select private.relink_profile('someone@example.com', '${NEW}')`) || "") &&
    pg(DB, `select count(*) from public.profiles where id='${OTHER}'`) === "1");
  pg(DB, "create role cx_tester_user nologin");
  ok("a signed-in user's role cannot run it",
    /permission denied/.test(fails(`set role cx_tester_user; select private.relink_profile('x', '${NEW}')`) || ""));
} finally {
  try { pg("postgres", `drop database if exists ${DB} with (force)`); pg("postgres", "drop role if exists cx_tester_user"); } catch (e) { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
