"use strict";
// Linking portal profiles to Entra accounts (supabase/sql/azure_relink_profile.sql):
// private.relink_profile() for IT, and public.claim_profile() for a person's
// first Microsoft sign-in.
//
// Under Entra the app finds a profile by the token's `oid`. These move a
// profile (and every reference to it) onto that id. Runs on a real PostgreSQL
// against a schema with the shapes the portal has: foreign keys with and
// without ON DELETE CASCADE, plain uuid columns, uuid arrays, a view, the
// profiles privilege-guard trigger, the audit table, and the real auth shim.
//
// Needs PostgreSQL on 127.0.0.1:5433 (superuser `postgres`, trust auth); skips
// cleanly without.   Run: node tools/test_relink_profile.js
const path = require("path");
const crypto = require("crypto");
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
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema private;
    create table public.auth_events (id bigserial primary key, email text, user_id uuid, event text not null, detail text, created_at timestamptz default now());
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
  const runFile = (f) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq",
    "-f", path.join(ROOT, f)], { stdio: ["ignore", "pipe", "pipe"] });
  runFile("supabase/sql/azure_auth_uid_shim.sql");
  runFile("supabase/sql/azure_relink_profile.sql");
  const fkDefs = () => pg(DB, `select string_agg(conname || ' ' || pg_get_constraintdef(oid), ' | ' order by conname)
    from pg_constraint where contype='f' and confrelid='public.profiles'::regclass`);

  ok("profiles carried over are marked as waiting for their owner",
    pg(DB, "select count(*) filter (where link_pending) || '/' || count(*) from public.profiles") === "2/2");
  ok("foreign keys to profiles now follow an id change, delete behaviour kept",
    /drawing_markups_created_by_fkey FOREIGN KEY \(created_by\) REFERENCES profiles\(id\) ON UPDATE CASCADE/.test(fkDefs()) &&
    /user_module_overrides_user_id_fkey .*ON UPDATE CASCADE ON DELETE CASCADE|user_module_overrides_user_id_fkey .*ON DELETE CASCADE ON UPDATE CASCADE/.test(fkDefs()), fkDefs());
  runFile("supabase/sql/azure_relink_profile.sql");
  ok("running the script again changes nothing (no re-marking, no FK churn)",
    pg(DB, "select count(*) from public.profiles where link_pending") === "2" && /ON UPDATE CASCADE/.test(fkDefs()));
  const before = fkDefs();

  const n = Number(pg(DB, `select private.relink_profile('  aik.khoury@example.com ', '${NEW}')`));
  // 3 = the profile, a plain uuid column and an array; foreign-key columns follow on their own.
  ok("IT can link directly: email matched regardless of case and spaces", n === 3, "changed " + n);
  ok("a linked profile is no longer waiting", pg(DB, `select link_pending from public.profiles where id='${NEW}'`) === "f");
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
  ok("foreign keys are untouched by a link", fkDefs() === before, fkDefs());
  ok("running it again changes nothing", pg(DB, `select private.relink_profile('aik.khoury@example.com', '${NEW}')`) === "0");
  ok("an unknown email is refused", /no profile with email/.test(fails(`select private.relink_profile('nobody@example.com', '${NEW}')`) || ""));
  ok("an id another profile already uses is refused, and nothing changes",
    /already uses id/.test(fails(`select private.relink_profile('someone@example.com', '${NEW}')`) || "") &&
    pg(DB, `select count(*) from public.profiles where id='${OTHER}'`) === "1");
  pg(DB, "create role cx_tester_user nologin");
  ok("a signed-in user's role cannot run it",
    /permission denied/.test(fails(`set role cx_tester_user; select private.relink_profile('x', '${NEW}')`) || ""));

  // ── First Microsoft sign-in: public.claim_profile(), as the gateway runs it ──
  const claim = (claims) => pg(DB, `set request.jwt.claims = '${JSON.stringify(claims)}'; set role authenticated;
    select coalesce((public.claim_profile()).id::text, 'null')`);
  const INVITED = "eeeeeeee-0000-0000-0000-000000000005";   // placeholder id from the Team screen
  const BART_OID = "ffffffff-1111-2222-3333-444444444444";
  pg(DB, `insert into public.profiles (id, email, full_name, role, link_pending)
          values ('${INVITED}', 'Reviewer@BART.gov', 'BART Reviewer', 'readonly', true)`);
  pg(DB, `insert into public.punch_items (created_by, title) values ('${INVITED}', 'pre-assigned')`);

  ok("an anonymous request cannot claim anything", claim({}) === "null");
  ok("a stranger with no matching invite gets nothing", claim({ oid: crypto.randomUUID(), preferred_username: "stranger@example.com" }) === "null");
  ok("first sign-in links the invited profile by the token's email",
    claim({ oid: BART_OID, preferred_username: "reviewer@bart.gov" }) === BART_OID &&
    pg(DB, `select link_pending || ',' || full_name from public.profiles where id='${BART_OID}'`) === "false,BART Reviewer");
  ok("…and everything already assigned to them moves too",
    pg(DB, `select count(*) from public.punch_items where created_by='${BART_OID}'`) === "1");
  ok("…and the link is written to the audit trail",
    pg(DB, `select count(*) from public.auth_events where event='entra_link' and user_id='${BART_OID}'`) === "1");
  ok("signing in again just returns the same profile", claim({ oid: BART_OID, preferred_username: "reviewer@bart.gov" }) === BART_OID);
  ok("a linked profile can never be claimed by another account with the same email",
    claim({ oid: crypto.randomUUID(), email: "reviewer@bart.gov" }) === "null" &&
    pg(DB, `select count(*) from public.profiles where id='${BART_OID}'`) === "1");
  ok("the email claim works as well as preferred_username",
    (pg(DB, `insert into public.profiles (id, email, full_name, link_pending) values ('${crypto.randomUUID()}', 'tech@hitachirail.com', 'Tech', true)`), true) &&
    /^[0-9a-f-]{36}$/.test(claim({ oid: crypto.randomUUID(), email: "Tech@HitachiRail.com" })));
  ok("a Supabase-style token (sub, no oid) never claims", (pg(DB, `insert into public.profiles (id, email, full_name, link_pending) values ('${crypto.randomUUID()}', 'sub@example.com', 'Sub', true)`), claim({ sub: crypto.randomUUID(), email: "sub@example.com" })) === "null");
  ok("anon cannot call it", /permission denied/.test(fails(`set role anon; select public.claim_profile()`) || ""));

  // ── An administrator connects a waiting profile now: public.admin_link_profile() ──
  // The permission check is the real call shape; the stub grants exactly the
  // right named in the test token, so "has it" and "lacks it" are both real.
  pg(DB, `create or replace function private.has_module_perm(p_module text, p_action text) returns boolean language sql stable as $$
            select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'test_perm', '') = p_module || '.' || p_action $$`);
  const ADMIN = "abababab-0000-0000-0000-000000000001";
  const WAIT = "12121212-0000-0000-0000-000000000001", WAIT_OID = "34343434-1111-2222-3333-444444444444";
  pg(DB, `insert into public.profiles (id, email, full_name, role, link_pending)
          values ('${WAIT}', 'carried.over@hitachirail.com', 'Carried Over', 'readonly', true)`);
  pg(DB, `insert into public.punch_items (created_by, title) values ('${WAIT}', 'carried item')`);
  const adminLink = (perm, profileId, oid) => pg(DB, `set request.jwt.claims = '${JSON.stringify({ oid: ADMIN, test_perm: perm })}';
    set role authenticated; select (public.admin_link_profile('${profileId}', '${oid}')).id`);
  const adminFails = (perm, profileId, oid) => fails(`set request.jwt.claims = '${JSON.stringify({ oid: ADMIN, test_perm: perm })}';
    set role authenticated; select public.admin_link_profile('${profileId}', '${oid}')`) || "";

  ok("someone without the right to add people cannot connect a profile, and nothing changes",
    /not allowed to add people/.test(adminFails("directory.view", WAIT, WAIT_OID)) &&
    pg(DB, `select link_pending from public.profiles where id='${WAIT}'`) === "t");
  ok("an administrator connects a waiting profile to the Microsoft account at once",
    adminLink("directory.invite", WAIT, WAIT_OID) === WAIT_OID &&
    pg(DB, `select link_pending || ',' || full_name from public.profiles where id='${WAIT_OID}'`) === "false,Carried Over");
  ok("…and what was theirs moves with it",
    pg(DB, `select count(*) from public.punch_items where created_by='${WAIT_OID}' and title='carried item'`) === "1");
  ok("…and it is audited, naming the administrator",
    pg(DB, `select count(*) from public.auth_events where event='entra_link' and user_id='${WAIT_OID}' and detail like '%administrator (${ADMIN})%'`) === "1");
  ok("a profile already connected cannot be moved again",
    /already connected/.test(adminFails("directory.invite", WAIT_OID, crypto.randomUUID())));
  const W2 = crypto.randomUUID();
  pg(DB, `insert into public.profiles (id, email, full_name, link_pending) values ('${W2}', 'second@hitachirail.com', 'Second', true)`);
  ok("a Microsoft account that already has a profile is refused, and nothing changes",
    /already has a profile/.test(adminFails("directory.invite", W2, WAIT_OID)) &&
    pg(DB, `select link_pending from public.profiles where id='${W2}'`) === "t");
  pg(DB, `insert into public.profiles (id, email, full_name, link_pending) values ('${crypto.randomUUID()}', 'SECOND@hitachirail.com', 'Second again', true)`);
  ok("two waiting profiles with the same email are refused (no guessing)",
    /2 profiles use/.test(adminFails("directory.invite", W2, crypto.randomUUID())));
  ok("an unknown profile is refused", /no profile/.test(adminFails("directory.invite", crypto.randomUUID(), crypto.randomUUID())));
  ok("anon cannot call it", /permission denied/.test(fails(`set role anon; select public.admin_link_profile('${W2}', '${crypto.randomUUID()}')`) || ""));
} finally {
  try { pg("postgres", `drop database if exists ${DB} with (force)`); pg("postgres", "drop role if exists cx_tester_user"); } catch (e) { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
