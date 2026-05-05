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
  notes                 text,
  power_apps_id         text,
  synced_at             timestamptz default now()
);

create index if not exists test_items_phase_idx     on test_items (phase);
create index if not exists test_items_location_idx  on test_items (location);
create index if not exists test_items_subsystem_idx on test_items (subsystem);
create index if not exists test_items_status_idx    on test_items (status);


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

create table if not exists punch_history (
  id        uuid primary key default gen_random_uuid(),
  punch_id  text references punch_items (id) on delete cascade,
  action    text,
  by_user   text,
  at        timestamptz,
  note      text
);

create table if not exists punch_photos (
  id        uuid primary key default gen_random_uuid(),
  punch_id  text references punch_items (id) on delete cascade,
  type      text check (type in ('before', 'after')),
  storage_path text,
  uploaded_by  text,
  uploaded_at  timestamptz default now()
);


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

create table if not exists template_test_cases (
  id          uuid primary key default gen_random_uuid(),
  template_id text references templates (id) on delete cascade,
  code        text,
  name        text,
  procedure   text,
  duration    numeric default 1
);

create table if not exists deployments (
  id            text primary key,
  template_id   text references templates (id),
  template_name text,
  deployed_by   text,
  deployed_at   timestamptz default now()
);

create table if not exists deployment_locations (
  id                    uuid primary key default gen_random_uuid(),
  deployment_id         text references deployments (id) on delete cascade,
  location_code         text,
  applicable_test_cases text[],
  notes                 text
);


-- ============================================================
-- TEST INSTANCES (generated when templates are deployed)
-- ============================================================
create table if not exists test_instances (
  id               text primary key,
  deployment_id    text references deployments (id),
  template_name    text,
  subsystem        text,
  location         text,
  test_code        text,
  test_name        text,
  procedure        text,
  duration         numeric,
  status           text default 'not_started',
  applicable       boolean default true,
  na_reason        text,
  last_updated_by  text,
  last_updated_at  timestamptz,
  notes            text
);


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


-- ============================================================
-- ROW LEVEL SECURITY
-- Disabled for now (no Auth yet). Enable after Supabase Auth setup.
-- When ready: alter table test_items enable row level security; etc.
-- ============================================================
