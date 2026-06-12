-- ============================================================
-- HITACHI Rail T&C Portal — Supabase Schema
-- Paste this entire file into: Supabase Dashboard → SQL Editor → Run
-- ============================================================


-- ============================================================
-- CORE: test_items (synced from TestPlan_Master.xlsm)
-- Source of truth for all test cases. Never written by the portal.
-- Updated via sync_testplan.js when the Excel file changes.
-- ============================================================
create table if not exists test_items (
  test_id               text primary key,
  phase                 text,
  location              text,
  subsystem             text,
  activity              text,
  test_category         text,
  test_case_code        text,
  test_name             text,
  test_procedure        text,
  test_phase            text,
  status                text default 'Future',
  activity_id           text,
  planned_date          timestamptz,
  p6_start_date         timestamptz,
  p6_finish_date        timestamptz,
  p6_start_date_current timestamptz,
  p6_finish_date_current timestamptz,
  weight                numeric,
  actual_start_date     timestamptz,
  actual_finish_date    timestamptz,
  completed_date        timestamptz,
  completed_by          text,
  blocked_reason        text,
  failed_reason         text,
  notes                 text,
  power_apps_id         text,
  synced_at             timestamptz default now()
);

create index if not exists test_items_phase_idx     on test_items (phase);
create index if not exists test_items_location_idx  on test_items (location);
create index if not exists test_items_subsystem_idx on test_items (subsystem);
create index if not exists test_items_status_idx    on test_items (status);

alter table test_items add column if not exists failed_reason text;

create table if not exists test_item_status_history (
  id             uuid primary key default gen_random_uuid(),
  test_id        text references test_items (test_id) on delete set null,
  test_case_code text,
  test_name      text,
  phase          text,
  location       text,
  subsystem      text,
  activity       text,
  old_status     text,
  new_status     text,
  changed_by     text,
  changed_role   text,
  changed_at     timestamptz default now(),
  source         text,
  reason         text,
  notes          text
);

create index if not exists test_item_status_history_test_id_idx on test_item_status_history (test_id);
create index if not exists test_item_status_history_changed_at_idx on test_item_status_history (changed_at desc);
create index if not exists test_item_status_history_new_status_idx on test_item_status_history (new_status);


-- ============================================================
-- CORE: test_results (written by Field Intake)
-- One row per test submission from the portal.
-- ============================================================
create table if not exists test_results (
  id                uuid primary key default gen_random_uuid(),
  result_id         text unique,
  test_id           text references test_items (test_id) on delete set null,
  test_name         text,
  attempt_number    integer default 1,
  phase             text,
  location          text,
  subsystem         text,
  activity          text,
  test_case_code    text,
  test_procedure    text,
  result            text check (result in ('Pass', 'Fail', 'Partial', 'Blocked')),
  team              text,
  completed_by      text,
  date_tested       date,
  submitted_at      timestamptz default now(),
  submitted_by      text,
  number_of_testers integer default 1,
  test_hours        numeric,
  failed_reason     text,
  blocked_reason    text,
  notes             text,
  new_status        text
);

create index if not exists test_results_test_id_idx      on test_results (test_id);
create index if not exists test_results_submitted_by_idx on test_results (submitted_by);
create index if not exists test_results_date_tested_idx  on test_results (date_tested);


-- ============================================================
-- CORE: delay_log (written by Field Intake daily log)
-- One row per end-of-day submission.
-- ============================================================
create table if not exists delay_log (
  id                  uuid primary key default gen_random_uuid(),
  log_id              text unique,
  log_date            date,
  location            text,
  subsystem           text,
  submitted_by        text,
  submitted_at        timestamptz default now(),
  number_of_testers   integer default 1,
  idle_hours          numeric default 0,
  total_tests_logged  integer default 0,
  total_passed        integer default 0,
  total_failed        integer default 0,
  total_partial       integer default 0,
  total_blocked       integer default 0,
  delay_occurred      text default 'No',
  delay_category      text,
  delay_duration      numeric default 0,
  delay_notes         text,
  overall_notes       text,
  next_day_plan       text
);

create index if not exists delay_log_submitted_by_idx on delay_log (submitted_by);
create index if not exists delay_log_log_date_idx     on delay_log (log_date);


-- ============================================================
-- USERS (replaces users_v2 / PIN system — ready for Supabase Auth later)
-- ============================================================
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  role       text check (role in ('admin', 'field', 'punch_manager', 'technician', 'client')),
  title      text,
  pin        text,
  email      text unique,
  active     boolean default true,
  created_at timestamptz default now()
);

-- Seed initial users (update PINs before going live)
insert into users (name, role, title, pin) values
  ('Alex Khoury',       'admin',         'T&C Manager',             '1234'),
  ('John Sterrett',     'field',         'Field Engineer',          '1111'),
  ('Mustafa Isik',      'punch_manager', 'Punch List Manager',      '5555'),
  ('Davinder Nagra',    'technician',    'Technician',              '6666'),
  ('Alpin Saglambilek', 'technician',    'Technician',              '7777'),
  ('BART Inspector',    'client',        'Client / Inspector',      '0000')
on conflict (name) do nothing;


-- ============================================================
-- PUNCH ITEMS (V2 workflow — replaces in-memory punchItems)
-- ============================================================
create table if not exists punch_items (
  id                    text primary key,
  number                integer,
  title                 text,
  description           text,
  subsystem             text,
  location              text,
  created_by            text,
  created_at            timestamptz,
  assigned_to           text,
  assigned_to_technician text,
  priority              text check (priority in ('high', 'medium', 'low')),
  status                text,
  type                  text,
  trade                 text,
  closure_notes         text,
  client_approved       boolean default false,
  client_approval_notes text,
  updated_at            timestamptz default now()
);

-- punch_history and punch_photos were dropped 2026-06-12 (migration
-- p5_2_drop_dead_tables): both were empty and unreferenced — punch history is
-- covered by db_change_log, punch photos by the `photos` feature.


-- ============================================================
-- ADMIN: Templates & Deployments
-- ============================================================
create table if not exists templates (
  id          text primary key,
  name        text,
  subsystem   text,
  description text,
  created_by  text,
  created_at  timestamptz default now()
);

-- template_test_cases, deployments, deployment_locations and test_instances
-- were dropped 2026-06-12 (migration p5_2_drop_dead_tables): all empty and
-- never DB-wired. Templates store their test_cases inline as jsonb; the
-- template→deploy→instance flow only ever ran off the in-memory data.js demo
-- seed (DATA.deployments), so the tables held no data and no code read or
-- wrote them.


-- ============================================================
-- AUDIT LOG
-- ============================================================
create table if not exists audit_log (
  id        text primary key,
  user_name text,
  role      text,
  action    text,
  target    text,
  details   text,
  timestamp timestamptz default now(),
  notes     text
);

alter table audit_log add column if not exists table_name text;
alter table audit_log add column if not exists record_id text;
alter table audit_log add column if not exists source text default 'Portal Audit';

create index if not exists audit_log_timestamp_idx on audit_log (timestamp desc);
create index if not exists audit_log_action_idx on audit_log (action);
create index if not exists audit_log_table_name_idx on audit_log (table_name);


-- ============================================================
-- GENERIC DB CHANGE LOG
-- Captures INSERT / UPDATE / DELETE changes made from any source.
-- ============================================================
create table if not exists db_change_log (
  id              uuid primary key default gen_random_uuid(),
  table_name      text not null,
  record_id       text,
  operation       text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  changed_at      timestamptz default now(),
  changed_by      text,
  actor_email     text,
  actor_role      text,
  changed_columns text[],
  old_row         jsonb,
  new_row         jsonb,
  source          text default 'database_trigger'
);

create index if not exists db_change_log_changed_at_idx on db_change_log (changed_at desc);
create index if not exists db_change_log_table_name_idx on db_change_log (table_name);
create index if not exists db_change_log_operation_idx on db_change_log (operation);

create or replace function audit_db_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_data jsonb;
  new_data jsonb;
  claims jsonb;
  changed_cols text[];
  rec_id text;
begin
  claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);

  if tg_op = 'DELETE' then
    old_data := to_jsonb(old);
    new_data := null;
    rec_id := coalesce(old_data->>'id', old_data->>'test_id', old_data->>'result_id', old_data->>'log_id');
  elsif tg_op = 'INSERT' then
    old_data := null;
    new_data := to_jsonb(new);
    rec_id := coalesce(new_data->>'id', new_data->>'test_id', new_data->>'result_id', new_data->>'log_id');
  else
    old_data := to_jsonb(old);
    new_data := to_jsonb(new);
    rec_id := coalesce(new_data->>'id', new_data->>'test_id', new_data->>'result_id', new_data->>'log_id');
    select array_agg(key order by key)
    into changed_cols
    from jsonb_each(new_data) n
    where (old_data->n.key) is distinct from n.value;
  end if;

  insert into db_change_log (
    table_name,
    record_id,
    operation,
    changed_by,
    actor_email,
    actor_role,
    changed_columns,
    old_row,
    new_row
  ) values (
    tg_table_name,
    rec_id,
    tg_op,
    coalesce(nullif(claims->>'full_name', ''), nullif(claims->>'email', '')),
    claims->>'email',
    claims->>'role',
    changed_cols,
    old_data,
    new_data
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ============================================================
-- TEST REPORTS — tracks CDRL submissions, revisions, acceptance status
-- ============================================================
create table if not exists test_reports (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  cdrl_number     text,
  revision        text default 'A',
  status          text default 'Not Started',
  -- valid statuses: Not Started | In Review | Accepted | Accepted as Noted
  --                 Accepted as Noted Resubmit | Resubmit | Rejected
  phase           text,
  location        text,
  subsystem       text,
  notes           text,
  parent_id       uuid references test_reports(id) on delete cascade,
  -- parent_id null = original report; non-null = revision of parent
  created_by      text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  updated_by      text
);

create index if not exists test_reports_parent_idx on test_reports (parent_id);
create index if not exists test_reports_status_idx on test_reports (status);
alter table test_reports add column if not exists phase text;
alter table test_reports add column if not exists location text;


-- ============================================================
-- ACTIVITY RECORDS — stores activity-level metadata
-- (future_test_reason, manual overrides) keyed by
-- phase + location + subsystem + activity_name
-- ============================================================
create table if not exists activity_records (
  id                  uuid primary key default gen_random_uuid(),
  phase               text not null,
  location            text not null,
  subsystem           text not null,
  activity_name       text not null,
  future_test_reason  text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique (phase, location, subsystem, activity_name)
);

drop trigger if exists audit_test_items_change on test_items;
create trigger audit_test_items_change
after insert or update or delete on test_items
for each row execute function audit_db_change();

drop trigger if exists audit_test_results_change on test_results;
create trigger audit_test_results_change
after insert or update or delete on test_results
for each row execute function audit_db_change();

drop trigger if exists audit_delay_log_change on delay_log;
create trigger audit_delay_log_change
after insert or update or delete on delay_log
for each row execute function audit_db_change();

drop trigger if exists audit_punch_items_change on punch_items;
create trigger audit_punch_items_change
after insert or update or delete on punch_items
for each row execute function audit_db_change();

drop trigger if exists audit_test_reports_change on test_reports;
create trigger audit_test_reports_change
after insert or update or delete on test_reports
for each row execute function audit_db_change();

drop trigger if exists audit_activity_records_change on activity_records;
create trigger audit_activity_records_change
after insert or update or delete on activity_records
for each row execute function audit_db_change();


-- ============================================================
-- Additional columns added to test_items after initial schema
-- ============================================================
alter table test_items add column if not exists test_report   text;
alter table test_items add column if not exists test_report_id uuid references test_reports(id) on delete set null;
alter table test_items add column if not exists failed_reason text;
alter table test_items add column if not exists blocked_reason text;

create index if not exists test_items_test_report_id_idx on test_items (test_report_id);

update test_items ti
set test_report_id = tr.id
from test_reports tr
where ti.test_report_id is null
  and ti.test_report is not null
  and (
    upper(regexp_replace(ti.test_report, '^CDRL[\s#:.\-]*', '', 'i')) = upper(regexp_replace(coalesce(tr.cdrl_number, ''), '^CDRL[\s#:.\-]*', '', 'i'))
    or upper(regexp_replace(ti.test_report, '^CDRL[\s#:.\-]*', '', 'i')) = upper(regexp_replace(coalesce(tr.title, ''), '^CDRL[\s#:.\-]*', '', 'i'))
  );


-- ============================================================
-- ROW LEVEL SECURITY
-- Disabled for now (no Auth yet). Enable after Supabase Auth setup.
-- When ready: alter table test_items enable row level security; etc.
-- ============================================================
