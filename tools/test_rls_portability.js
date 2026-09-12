"use strict";
// RLS portability rehearsal — the Azure migration's highest-risk unknown.
//
// THE QUESTION: do the 349 RLS policies, which were written against Supabase's
// GoTrue-supplied `auth` schema, still work on plain PostgreSQL with a
// self-hosted PostgREST and Microsoft Entra as the issuer — WITHOUT editing
// any policy?
//
// THE ANSWER this suite establishes: yes, provided auth.uid() returns the right
// uuid. It stands up a real PostgreSQL server, installs
// supabase/sql/azure_auth_uid_shim.sql, recreates the permission functions and
// a representative slice of the real policies (taken verbatim from the live
// database via pg_policies), and asserts that a Supabase-issued token and an
// Entra-issued token produce IDENTICAL access decisions.
//
// It also pins the shapes that would silently break the migration: the `oid`
// vs `sub` claim difference, jsonb/array column round-trips, and a trigger.
//
// SKIPS CLEANLY when no PostgreSQL server is available, so a normal
// `node tools/run_tests.js` on a machine without one stays green.
//   Run: node tools/test_rls_portability.js
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.CX_PGPORT || "5433";
const HOST = "127.0.0.1";
const DB = "cx_portability";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

function psql(sql, db) {
  // -q suppresses command tags (BEGIN/SET/COMMIT), so stdout carries only
  // query results and the last line is the value under test.
  const r = spawnSync("psql", [
    "-q", "-h", HOST, "-p", PORT, "-U", "postgres", "-d", db || "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8", env: Object.assign({}, process.env, { PGPASSWORD: "" }) });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "psql failed").trim());
  return r.stdout.trim();
}

// ── availability ────────────────────────────────────────────────────────────
try {
  psql("select 1");
} catch (e) {
  console.log(`SKIPPED: no PostgreSQL reachable on ${HOST}:${PORT} (${String(e.message).split("\n")[0]})`);
  console.log("  Start one with:  initdb -D /tmp/pgdata -U postgres --auth=trust");
  console.log("                   pg_ctl -D /tmp/pgdata -o '-p 5433' start");
  console.log("\n0 passed, 0 failed.");
  process.exit(0);
}

console.log("=== RLS portability: Supabase -> plain PostgreSQL + Entra ===\n");

psql(`drop database if exists ${DB}`);
psql(`create database ${DB}`);

// ── 1. the shim, exactly as it will ship ────────────────────────────────────
const shim = fs.readFileSync(path.join(ROOT, "supabase", "sql", "azure_auth_uid_shim.sql"), "utf8");
const shimFile = path.join(os.tmpdir(), "cx_shim.sql");
fs.writeFileSync(shimFile, shim);
execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", shimFile],
  { stdio: "pipe" });
ok("azure_auth_uid_shim.sql applies to a stock PostgreSQL with no Supabase extensions", true);

// ── 2. the permission machinery, verbatim from the live database ────────────
psql(`
create schema if not exists private;

create table profiles (
  id uuid primary key,
  email text,
  full_name text,
  role text,
  is_active boolean default true,
  permission_template_id uuid,
  custom_fields jsonb default '{}'::jsonb,
  linked_car_ids text[] default '{}'::text[]
);
create table perm_modules (key text primary key, actions text[], action_meta jsonb);
create table template_module_perms (template_id uuid, module_key text, level text, grants jsonb);
create table user_module_overrides (user_id uuid, module_key text, level text, grants jsonb);

create or replace function public._perm_baseline(p_level text)
returns text[] language sql immutable set search_path to '' as $fn$
  select case p_level
    when 'admin'     then array['view','export','create','edit','delete','approve','manage']
    when 'standard'  then array['view','export','create','edit']
    when 'read_only' then array['view','export']
    else array[]::text[]
  end;
$fn$;

create or replace function private._perm_baseline(p_module text, p_level text)
returns text[] language sql stable security definer set search_path to 'public' as $fn$
  select array(
    select distinct k from (
      select unnest(public._perm_baseline(p_level)) as k
      union
      select me.key as k
      from perm_modules pm
      cross join lateral jsonb_each(pm.action_meta) as me(key, val)
      where pm.key = p_module
        and coalesce((me.val->>'x')::boolean, false) = false
        and array_position(array['none','read_only','standard','admin'],
                           coalesce(me.val->>'m','admin'))
            <= array_position(array['none','read_only','standard','admin'], p_level)
    ) u
  );
$fn$;

create or replace function private.has_module_perm(p_module text, p_action text default 'view')
returns boolean language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  v_uid uuid := auth.uid();
  v_level text; v_grants jsonb := '{}'::jsonb;
  v_o_level text; v_o_grants jsonb; v_eff boolean;
begin
  if v_uid is null then return false; end if;
  if not exists (select 1 from profiles where id = v_uid and is_active) then return false; end if;
  if exists (select 1 from profiles where id = v_uid and role = 'admin' and is_active) then return true; end if;
  select tmp.level, tmp.grants into v_level, v_grants
  from profiles pr join template_module_perms tmp
    on tmp.template_id = pr.permission_template_id and tmp.module_key = p_module
  where pr.id = v_uid;
  v_level := coalesce(v_level, 'none');
  v_grants := coalesce(v_grants, '{}'::jsonb);
  select o.level, o.grants into v_o_level, v_o_grants
  from user_module_overrides o where o.user_id = v_uid and o.module_key = p_module;
  if v_o_level is not null then v_level := v_o_level; end if;
  if v_o_grants is not null then v_grants := v_grants || v_o_grants; end if;
  v_eff := p_action = any(private._perm_baseline(p_module, v_level));
  if v_grants ? p_action then v_eff := (v_grants ->> p_action)::boolean; end if;
  return coalesce(v_eff, false);
end;
$fn$;
`, DB);
ok("private.has_module_perm and _perm_baseline port with no changes", true);

// ── 3. representative policies, copied verbatim from the live pg_policies ───
// One of each shape that exists in production: pure has_module_perm (the large
// majority of policies), auth.uid() ownership, and the profiles self-update case.
// The old "own row OR capability" shape came only from pto_requests, which left
// with the Lookahead module; drawing_markups still exercises uid() ownership.
psql(`
create table test_items (test_id text primary key, test_name text, custom_fields jsonb, linked_car_ids text[]);
create table drawing_markups (id bigserial primary key, created_by uuid, is_published boolean default false);
create table audit_log (id text primary key, user_name text, action text);

alter table test_items      enable row level security;
alter table drawing_markups enable row level security;
alter table profiles        enable row level security;

-- shape 1: authorization entirely through has_module_perm (95% of policies)
create policy test_items_sel on test_items for select to public
  using ( (select private.has_module_perm('test_register','view')) );

-- shape 2: capability AND ownership, the drawings/photos pattern
create policy drawing_markups_sel on drawing_markups for select to public
  using ( (select private.has_module_perm('drawings','view'))
          and (is_published or (created_by = auth.uid())
               or (select private.has_module_perm('drawings','manage_markup_any'))) );

-- shape 3: self-update
create policy profiles_update on profiles for update to public
  using ( ((select auth.uid()) = id) or (select private.has_module_perm('directory','edit_profile')) );
create policy profiles_sel on profiles for select to public using (true);
`, DB);
ok("policy shapes from production create verbatim on plain PostgreSQL", true);

// ── 4. seed two users ───────────────────────────────────────────────────────
const ADMIN = "63033c03-d6b9-4954-8f6e-e89ce23a9758";
const VIEWER = "11111111-2222-3333-4444-555555555555";
const TEMPLATE = "99999999-8888-7777-6666-555555555555";
psql(`
insert into perm_modules(key, actions, action_meta) values
  ('test_register', array['view'], '{"view":{"m":"read_only"}}'::jsonb),
  ('drawings',      array['view','manage_markup_any'],
     '{"view":{"m":"read_only"},"manage_markup_any":{"m":"admin"}}'::jsonb),
  ('directory',     array['edit_profile'], '{"edit_profile":{"m":"admin"}}'::jsonb);
insert into template_module_perms values
  ('${TEMPLATE}','test_register','read_only','{}'::jsonb),
  ('${TEMPLATE}','drawings','read_only','{}'::jsonb);
insert into profiles(id,email,full_name,role,is_active,permission_template_id,custom_fields,linked_car_ids) values
  ('${ADMIN}','admin@hitachirail.com','Admin User','admin',true,null,
     '{"nested":{"a":[1,2,3]}}'::jsonb, array['car-1','car-2']),
  ('${VIEWER}','viewer@hitachirail.com','Viewer User','readonly',true,'${TEMPLATE}',
     '{}'::jsonb, array[]::text[]);
insert into test_items values ('T-1','Trackside SAT','{"k":"v"}'::jsonb, array['car-9']);
insert into drawing_markups(created_by, is_published) values ('${VIEWER}', false), ('${ADMIN}', true);
do $do$ begin
  -- roles are cluster-wide, so they outlive the per-run database
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
end $do$;
grant usage on schema public, auth, private to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema auth, private, public to authenticated;
`, DB);

// ── 5. the actual proof ─────────────────────────────────────────────────────
// Same user, same policies, two different issuers. PostgREST sets
// request.jwt.claims exactly like this.
function asUser(claims, sql) {
  const json = JSON.stringify(claims).replace(/'/g, "''");
  // BEGIN/COMMIT is required: `set local` only lives inside an explicit
  // transaction, and psql would otherwise put each statement in its own.
  // Switching off the superuser role is what makes RLS apply at all.
  const out = psql(
    `begin;
     set local role authenticated;
     select set_config('request.jwt.claims', '${json}', true);
     ${sql}
     commit;`, DB);
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}
const supabaseToken = (uid) => ({ sub: uid, role: "authenticated", aal: "aal1" });
const entraToken    = (uid) => ({ oid: uid, role: "authenticated",
                                  tid: "72f988bf-86f1-41af-91ab-2d7cd011db47",
                                  amr: ["pwd", "mfa"], preferred_username: "user@hitachirail.com" });

const q = {
  uid:     "select coalesce(auth.uid()::text,'(null)');",
  items:   "select count(*) from test_items;",
  markups: "select count(*) from drawing_markups;",
};

for (const [label, mk] of [["Supabase (sub)", supabaseToken], ["Entra (oid)", entraToken]]) {
  ok(`${label}: auth.uid() resolves the admin`, asUser(mk(ADMIN), q.uid).endsWith(ADMIN));
  ok(`${label}: admin sees the test item`,      asUser(mk(ADMIN), q.items) === "1");
  ok(`${label}: viewer sees the test item (read_only template)`, asUser(mk(VIEWER), q.items) === "1");
  ok(`${label}: viewer sees own unpublished + published markup`, asUser(mk(VIEWER), q.markups) === "2");
}

// The decisions must be identical between issuers — that is the whole claim.
const cases = [[ADMIN, q.items], [ADMIN, q.markups],
               [VIEWER, q.items], [VIEWER, q.markups]];
const diffs = cases.filter(([uid, sql]) =>
  asUser(supabaseToken(uid), sql) !== asUser(entraToken(uid), sql));
ok("EVERY access decision is identical under both issuers", diffs.length === 0,
  diffs.length + " differed");

// ── 6. the things that would break silently ─────────────────────────────────
const noClaims = (() => {
  const out = psql(`begin; set local role authenticated; select count(*) from test_items; commit;`, DB);
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
})();
ok("an unauthenticated session is refused (no claims at all)", noClaims === "0", "got " + noClaims);
ok("a token with neither oid nor sub yields a null uid",
  asUser({ role: "authenticated" }, q.uid) === "(null)");
ok("an Entra token for an unknown user sees nothing",
  asUser(entraToken("00000000-0000-0000-0000-000000000000"), q.items) === "0");
ok("jsonb columns round-trip",
  psql(`select custom_fields->'nested'->'a'->>1 from profiles where id='${ADMIN}';`, DB) === "2");
ok("text[] columns round-trip",
  psql(`select array_length(linked_car_ids,1) from profiles where id='${ADMIN}';`, DB) === "2");

// a trigger of the shape the app relies on
psql(`
create or replace function guard_demo() returns trigger language plpgsql as $fn$
begin
  if new.role is distinct from old.role and auth.uid() is not null
     and not private.has_module_perm('directory','edit_profile') then
    raise exception 'permission denied';
  end if;
  return new;
end; $fn$;
create trigger trg_guard_demo before update on profiles
  for each row execute function guard_demo();`, DB);
let blocked = false;
try {
  asUser(entraToken(VIEWER), `update profiles set role='admin' where id='${VIEWER}';`);
} catch (e) { blocked = /permission denied/.test(e.message); }
ok("a privilege-guard trigger still fires under an Entra token", blocked);

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
