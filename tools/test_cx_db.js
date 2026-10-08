"use strict";
// cx-db.js must behave exactly like supabase-js for every call shape the app
// uses — because the Azure build ships cx-db.js INSTEAD of supabase-js.
//
// Runs each shape through both against a real PostgREST + PostgreSQL, resets
// the tables in between, and requires the same result ({data, error, status})
// and the same table contents afterwards.
//
// Needs PostgreSQL on 127.0.0.1:5433 (superuser `postgres`, trust auth) and a
// `postgrest` binary (PATH or POSTGREST_BIN); skips cleanly without.
//   Run: node tools/test_cx_db.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawn, spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "cx_db_test";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function skip(why) { console.log("SKIPPED: " + why + "\n0 passed, 0 failed."); process.exit(0); }
console.log("=== cx-db.js vs supabase-js, against a real PostgREST ===\n");

const which = (c) => { const r = spawnSync("sh", ["-c", "command -v " + c]); return r.status === 0 ? String(r.stdout).trim() : null; };
const POSTGREST = process.env.POSTGREST_BIN || which("postgrest");
if (!POSTGREST) skip("no postgrest binary (set POSTGREST_BIN)");
const psql = (args) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
try { psql(["-XAtqc", "select 1"]); } catch (e) { skip("no PostgreSQL reachable on 127.0.0.1:5433"); }
const pg = (sql) => psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql]);

const T1 = "aaaaaaaa-0000-0000-0000-000000000001", T2 = "aaaaaaaa-0000-0000-0000-000000000002";
const U1 = "bbbbbbbb-0000-0000-0000-000000000001";
const SEED = `
  truncate public.profiles, public.permission_templates, public.template_module_perms,
           public.user_module_overrides, public.fieldset_config, public.punch_items restart identity;
  insert into public.permission_templates (id, name, is_system) values
    ('${T1}', 'Field Engineer', true), ('${T2}', 'Administrator', false);
  insert into public.profiles (id, email, full_name, created_at) values
    ('${U1}', 'some_one@bart.gov', 'Some One', '2026-01-01'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'someXone@bart.gov', 'Decoy', '2026-01-02');
  insert into public.template_module_perms values ('${T1}', 'photos', 'standard', '{}'), ('${T1}', 'forms', 'read_only', '{}');
  insert into public.user_module_overrides values ('${U1}', 'photos', 'admin', '{}');
  insert into public.fieldset_config values ('status', 'Status', '["Open"]', '2026-01-01');`;

psql(["-XAtq", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
pg(`do $$ begin if not exists (select 1 from pg_roles where rolname='cxdb_anon') then create role cxdb_anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='cxdb_auth') then create role cxdb_auth login password 'pw' noinherit; end if; end $$;
    grant cxdb_anon to cxdb_auth;
    create table public.profiles (id uuid primary key, email text unique, full_name text not null, role text default 'readonly',
      created_at timestamptz default now());
    create table public.permission_templates (id uuid primary key default gen_random_uuid(), name text unique not null,
      description text default '', is_system boolean default false);
    create table public.template_module_perms (template_id uuid, module_key text, level text, grants jsonb,
      primary key (template_id, module_key));
    create table public.user_module_overrides (user_id uuid, module_key text, level text, grants jsonb,
      primary key (user_id, module_key));
    create table public.fieldset_config (field_key text primary key, label text, options jsonb, updated_at timestamptz);
    create table public.punch_items (id serial primary key, title text not null, status text default 'Open', notes text);
    grant usage on schema public to cxdb_anon;
    grant all on all tables in schema public to cxdb_anon; grant all on all sequences in schema public to cxdb_anon;`);

// ── the two clients ──
global.window = { CX_CONFIG: {}, CXIdentity: { authHeader: () => "" } };
const CXDb = require(path.join(ROOT, "cx-db.js"));
// supabase-js exactly as the app has it off Supabase: created, then assigned
// to window._sb, whose hook in cx-config.js points it at REST_BASE and swaps
// its Authorization for CXIdentity's.
function appSupabaseClient(base) {
  const ctx = vm.createContext({ console, fetch, Headers, Request, Response, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, TextEncoder, TextDecoder, navigator: {},
    location: { href: "http://127.0.0.1/", protocol: "http:" },
    document: { currentScript: { src: "http://127.0.0.1/vendor/js/supabase.js", tagName: "SCRIPT" }, getElementsByTagName: () => [] } });
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
  ctx.CX_CONFIG = { API_URL: base, REST_PATH: "" };
  ctx.CXIdentity = { kind: "postgrest", authHeader: () => "" };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "vendor/js/supabase.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "cx-config.js"), "utf8"), ctx);
  ctx._sb = ctx.supabase.createClient(base, "unused", { auth: { persistSession: false, autoRefreshToken: false } });
  return ctx._sb;
}

const SHAPES = [
  ["select * order", (c) => c.from("profiles").select("*").order("created_at"), "profiles"],
  ["select cols order", (c) => c.from("permission_templates").select("id,name").order("name"), null],
  ["two orders, one descending", (c) => c.from("permission_templates").select("*").order("is_system", { ascending: false }).order("name"), null],
  ["select eq", (c) => c.from("user_module_overrides").select("*").eq("user_id", U1), null],
  ["select eq single", (c) => c.from("permission_templates").select("name").eq("id", T1).single(), null],
  ["single with no match is an error", (c) => c.from("permission_templates").select("name").eq("id", U1).single(), null],
  ["ilike exact with escaped _ , limit", (c) => c.from("profiles").select("id").ilike("email", "some\\_one@bart.gov").limit(1), null],
  ["insert one row (array), no return", (c) => c.from("punch_items").insert([{ title: "cable" }]), "punch_items"],
  ["insert object .select().single()", (c) => c.from("punch_items").insert({ title: "gland", status: "Closed" }).select().single(), "punch_items"],
  ["insert rows with different keys", (c) => c.from("punch_items").insert([{ title: "a", notes: "n" }, { title: "b", status: "Closed" }]), "punch_items"],
  ["duplicate key is an error", (c) => c.from("permission_templates").insert({ name: "Field Engineer" }), "permission_templates"],
  ["update eq", (c) => c.from("profiles").update({ role: "admin" }).eq("id", U1), "profiles"],
  ["upsert onConflict (insert)", (c) => c.from("fieldset_config").upsert({ field_key: "phase", label: "Phase", options: ["P1"], updated_at: "2026-02-01T00:00:00+00:00" }, { onConflict: "field_key" }), "fieldset_config"],
  ["upsert onConflict (merge)", (c) => c.from("fieldset_config").upsert({ field_key: "status", label: "State", options: ["Open", "Done"], updated_at: "2026-02-02T00:00:00+00:00" }, { onConflict: "field_key" }), "fieldset_config"],
  ["upsert composite onConflict", (c) => c.from("template_module_perms").upsert({ template_id: T1, module_key: "photos", level: "admin", grants: { x: true } }, { onConflict: "template_id,module_key" }), "template_module_perms"],
  ["delete eq", (c) => c.from("template_module_perms").delete().eq("template_id", T1), "template_module_perms"],
  ["delete eq eq", (c) => c.from("user_module_overrides").delete().eq("user_id", U1).eq("module_key", "photos"), "user_module_overrides"],
  ["unknown table is an error", (c) => c.from("no_such_table").select("*"), null],
];

function normal(r) {
  return JSON.stringify({ data: r.data, error: r.error ? { code: r.error.code || null } : null, status: r.status });
}
const tableState = (t) => t ? pg(`select coalesce(json_agg(x order by x::text)::text, '[]') from public.${t} x`) : "";

const port = 30000 + Math.floor(Math.random() * 20000);
const api = spawn(POSTGREST, [], { env: { ...process.env,
  PGRST_DB_URI: `postgres://cxdb_auth:pw@127.0.0.1:5433/${DB}`, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "cxdb_anon",
  PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: "127.0.0.1" }, stdio: "ignore" });

(async () => {
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/"); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
    window.REST_BASE = base;
    const sb = appSupabaseClient(base);
    const cx = CXDb.client();

    for (const [name, run, table] of SHAPES) {
      pg(SEED); const a = await run(sb); const aState = tableState(table);
      pg(SEED); const b = await run(cx); const bState = tableState(table);
      ok(`${name}: same result`, normal(a) === normal(b), `\n      supabase-js ${normal(a)}\n      cx-db       ${normal(b)}`);
      if (table) ok(`${name}: same table contents`, aState === bState, `\n      ${aState}\n      ${bState}`);
    }
    // Error messages the app tests for by text.
    pg(SEED);
    const dup = await cx.from("permission_templates").insert({ name: "Field Engineer" });
    ok("a duplicate-key error message mentions it (app.js matches /duplicate key|23505/)", /duplicate key|23505/.test(dup.error.message + dup.error.code));
    // Network failure resolves with an error, never throws (as supabase-js does).
    window.REST_BASE = "http://127.0.0.1:1";
    const down = await CXDb.client().from("profiles").select("*");
    ok("unreachable API resolves { data: null, error } instead of throwing", down.data === null && !!down.error && !!down.error.message);
    // Token and apikey headers.
    let seen = null;
    const realFetch = global.fetch;
    global.fetch = async (u, init) => { seen = init.headers; return new Response("[]", { status: 200 }); };
    window.CXIdentity = { authHeader: () => "Bearer entra-token" };
    await CXDb.client().from("profiles").select("*");
    ok("requests carry the CXIdentity token and no Supabase apikey", seen.Authorization === "Bearer entra-token" && !("apikey" in seen));
    global.fetch = realFetch;
  } catch (e) {
    ok("runs", false, e.stack);
  } finally {
    api.kill();
    try { psql(["-XAtqc", `drop database if exists ${DB} with (force)`]); } catch (e) { /* best effort */ }
  }
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
