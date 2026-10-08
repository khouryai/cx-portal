"use strict";
// The change log (supabase/sql/change_log_trigger.sql): records WHO made each
// change under Supabase AND Microsoft Entra, and stores only WHAT changed.
// Also runs the one-time compaction (supabase_change_log_compact.sql) over
// rows in the old full-copy shape, and the daily-log query app.js runs.
//
// Real PostgreSQL, simulating what PostgREST does per request
// (request.jwt.claims + SET ROLE). Needs PostgreSQL on 127.0.0.1:5433
// (superuser `postgres`, trust auth); skips cleanly without.
//   Run: node tools/test_change_log.js
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "cx_change_log_test";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const psql = (args) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const pg = (sql) => psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql]);
const runFile = (f) => psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq", "-f", path.join(ROOT, f)]);

console.log("=== change log: who, and only what changed ===\n");
try { psql(["-XAtqc", "select 1"]); }
catch (e) { console.log("SKIPPED: no PostgreSQL reachable on 127.0.0.1:5433\n0 passed, 0 failed."); process.exit(0); }

const U = "11111111-aaaa-bbbb-cccc-000000000001";
psql(["-XAtq", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
try {
  pg(`do $$ begin
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      end $$;
      create table public.profiles (id uuid primary key, email text, full_name text);
      create table public.db_change_log (id bigserial primary key, table_name text, record_id text, operation text,
        changed_at timestamptz default now(), changed_by text, actor_email text, actor_role text,
        changed_columns text[], old_row jsonb, new_row jsonb, source text);
      create table public.test_items (id serial primary key, test_case_code text, test_name text, phase text,
        location text, subsystem text, activity text, status text, failed_reason text, weight numeric,
        notes text, updated_at timestamptz default now());
      grant all on public.test_items to authenticated; grant usage, select on sequence test_items_id_seq to authenticated;
      insert into public.profiles values ('${U}', 'alexander.khoury@hitachirail.com', 'Alexander Khoury');`);
  runFile("supabase/sql/change_log_trigger.sql");
  pg(`create trigger audit_test_items after insert or update or delete on public.test_items
        for each row execute function public.audit_db_change()`);

  const asRequest = (claims, sql) => pg(`set request.jwt.claims = '${JSON.stringify(claims)}'; set role authenticated; ${sql}`);
  const last = () => pg(`select coalesce(changed_by,'∅') || ' | ' || coalesce(actor_email,'∅') || ' | ' || coalesce(actor_role,'∅')
                          || ' | ' || operation from public.db_change_log order by id desc limit 1`);
  const count = () => Number(pg("select count(*) from public.db_change_log"));
  const keys = (col) => pg(`select string_agg(k, ',' order by k) from public.db_change_log l, jsonb_object_keys(l.${col}) k
                            where l.id = (select max(id) from public.db_change_log)`);

  // ── WHO ──
  asRequest({ oid: U, roles: ["authenticated"], name: "Alexander Khoury" },
    `insert into public.test_items (test_case_code, test_name, phase, location, subsystem, activity, status, weight, notes)
     values ('TC-101', 'Brake test', 'P2', 'Yard', 'ATC', 'Static', 'Not Started', 1, 'long note')`);
  ok("Entra token without email: the change is attributed to the person",
    last() === "alexander.khoury@hitachirail.com | alexander.khoury@hitachirail.com | authenticated | INSERT", last());
  ok("an INSERT keeps the whole new row", keys("new_row").split(",").length === 12, keys("new_row"));

  asRequest({ sub: U, email: "alexander.khoury@hitachirail.com", role: "authenticated" },
    "update public.test_items set status = 'Fail', failed_reason = 'pressure low', updated_at = now()");
  ok("Supabase token: actor exactly as before", last() ===
    "alexander.khoury@hitachirail.com | alexander.khoury@hitachirail.com | authenticated | UPDATE", last());

  // ── WHAT ──
  ok("an UPDATE records which columns changed",
    pg("select changed_columns::text from public.db_change_log order by id desc limit 1") === "{failed_reason,status,updated_at}");
  ok("…and stores only those plus the identifying columns, not the whole row",
    keys("new_row") === "activity,failed_reason,id,location,phase,status,subsystem,test_case_code,test_name,updated_at", keys("new_row"));
  ok("…with old and new values side by side",
    pg("select old_row->>'status' || ' -> ' || (new_row->>'status') from public.db_change_log order by id desc limit 1") === "Not Started -> Fail");
  ok("unrelated large columns are not copied", !/notes|weight/.test(keys("old_row")));

  let before = count();
  pg("update public.test_items set notes = notes");
  ok("an update that changes nothing is not logged", count() === before);
  pg("update public.test_items set updated_at = now() + interval '1 minute'");
  ok("an update that only bumps updated_at is not logged", count() === before);

  // The daily-log rebuild in app.js: status changes today, with their context.
  const daily = pg(`select new_row->>'test_case_code' || ' ' || (new_row->>'location') || ' ' || (old_row->>'status') || '->' || (new_row->>'status')
                    || ' ' || (new_row->>'failed_reason')
                    from public.db_change_log where table_name='test_items' and operation='UPDATE'
                    and changed_columns @> '{status}' and changed_at >= current_date order by changed_at`);
  ok("the daily-log rebuild still gets code, location, status change and reason",
    daily === "TC-101 Yard Not Started->Fail pressure low", daily);

  asRequest({ oid: "22222222-aaaa-bbbb-cccc-000000000002", roles: ["authenticated"], preferred_username: "guest@bart.gov" },
    "delete from public.test_items");
  ok("no profile yet: the actor falls back to the address in the token", last() === "guest@bart.gov | guest@bart.gov | authenticated | DELETE", last());
  ok("a DELETE keeps the whole old row", keys("old_row").split(",").length === 12, keys("old_row"));

  pg("insert into public.test_items (test_name) values ('seeded')");
  ok("a change outside any request has no actor", last() === "∅ | ∅ | ∅ | INSERT", last());
  asRequest({ sub: "not-a-uuid", email: "x@y.z" }, "insert into public.test_items (test_name) values ('still saved')");
  ok("a malformed user id does not block the change", pg("select count(*) from public.test_items where test_name='still saved'") === "1");

  // ── One-time compaction of rows written the old way ──
  pg(`insert into public.db_change_log (table_name, record_id, operation, changed_columns, old_row, new_row) values
      ('test_items', '9', 'UPDATE', '{weight}',
        '{"id":9,"test_case_code":"TC-9","test_name":"Old","status":"Pass","weight":1,"notes":"big","phase":"P1"}',
        '{"id":9,"test_case_code":"TC-9","test_name":"Old","status":"Pass","weight":2,"notes":"big","phase":"P1"}'),
      ('test_items', '9', 'UPDATE', null, '{"id":9,"notes":"big"}', '{"id":9,"notes":"big"}'),
      ('test_items', '9', 'UPDATE', '{updated_at}', '{"id":9,"updated_at":"a"}', '{"id":9,"updated_at":"b"}'),
      ('test_items', '9', 'DELETE', null, '{"id":9,"test_case_code":"TC-9","notes":"big"}', null)`);
  before = count();
  runFile("supabase/sql/supabase_change_log_compact.sql");
  ok("compaction removes rows that recorded no change", count() === before - 2, `${before} -> ${count()}`);
  const compacted = pg(`select string_agg(k, ',' order by k) from public.db_change_log l, jsonb_object_keys(l.new_row) k
                        where l.record_id = '9' and l.operation = 'UPDATE'`);
  ok("compaction keeps the changed column and the identifying ones only", compacted === "id,phase,status,test_case_code,test_name,weight", compacted);
  ok("compaction keeps the old and new value", pg("select (old_row->>'weight') || '->' || (new_row->>'weight') from public.db_change_log where record_id='9' and operation='UPDATE'") === "1->2");
  ok("compaction leaves DELETE rows whole", pg("select old_row->>'notes' from public.db_change_log where record_id='9' and operation='DELETE'") === "big");
  const snapshot = pg("select md5(string_agg(id || coalesce(old_row::text,'') || coalesce(new_row::text,''), '|' order by id)) from public.db_change_log");
  runFile("supabase/sql/supabase_change_log_compact.sql");
  ok("running the compaction again changes nothing",
    pg("select md5(string_agg(id || coalesce(old_row::text,'') || coalesce(new_row::text,''), '|' order by id)) from public.db_change_log") === snapshot);
} finally {
  try { psql(["-XAtqc", `drop database if exists ${DB} with (force)`]); } catch (e) { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
