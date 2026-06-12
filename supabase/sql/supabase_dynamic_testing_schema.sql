-- ============================================================
-- HITACHI Rail T&C Portal — Dynamic Vehicle Testing Schema
--
-- Foundation migration for the dynamic testing module:
--   • Track plan infrastructure ingested from Visio (devices,
--     zones, mileposts, equations, sections, train control
--     locations, plan_imports audit).
--   • test_items.scope_type column distinguishing static vs
--     dynamic test cases.
--   • dynamic_test_filters: optional helper that lets a planner
--     describe a candidate-instance generator on a dynamic test
--     case (filter is a template, not auto-materialized).
--   • dynamic_instances: first-class, directly authorable rows
--     that represent one executable scope of a dynamic test.
--   • View: vw_procedure_scope_rollup — aggregates scope_type
--     by procedure text for "mixed-scope procedure" UI hints
--     (no real procedures table exists today).
--
-- Follow-on migrations will add:
--   • dynamic_instance_compatibility (parallel-runnable matrix)
--   • test_results.instance_id + delay_log_vehicle (run history)
--   • KPI views (burndown, stuck-instance, coverage)
--
-- Idempotent; safe to re-run. Paste into Supabase SQL Editor.
-- ============================================================


-- ============================================================
-- TRACK PLAN: imports audit
-- One row per Visio→Excel ingest. Source of truth for which
-- revision produced each device/zone/milepost row.
-- ============================================================
create table if not exists track_plan_imports (
  id              uuid        primary key default gen_random_uuid(),
  source_file     text        not null,
  source_kind     text        not null default 'visio_xlsx',
  doc_code        text,
  project_name    text,
  layout_name     text,
  view_name       text,
  version_label   text,
  release_date    date,
  designer        text,
  verifier        text,
  approver        text,
  mp_unit         numeric,
  imported_by     text,
  imported_at     timestamptz not null default now(),
  devices_count   integer     default 0,
  zones_count     integer     default 0,
  mileposts_count integer     default 0,
  status          text        not null default 'processing'
                  check (status in ('processing','complete','failed')),
  notes           text
);

create index if not exists track_plan_imports_imported_at_idx
  on track_plan_imports (imported_at desc);


-- ============================================================
-- TRACK PLAN: zones (polymorphic via zone_type)
-- Covers ZC Area, Control Area, Interlocking, Control Zone,
-- Adhesion zone, CBTC Territory Limit. Deduplicated by
-- (zone_type, code); contributing Visio shape ids collected
-- in source_shape_ids[] so re-import can round-trip back to
-- the drawing.
-- ============================================================
create table if not exists track_zones (
  id                  uuid        primary key default gen_random_uuid(),
  zone_type           text        not null
                      check (zone_type in (
                        'zc_area','control_area','interlocking',
                        'control_zone','adhesion_zone','cbtc_territory_limit'
                      )),
  code                text        not null,
  display_color       text,
  parent_zone_id      uuid        references track_zones(id) on delete set null,
  parent_zone_code    text,
  system_label        text,
  start_milepost      numeric,
  end_milepost        numeric,
  attributes          jsonb       not null default '{}'::jsonb,
  source_shape_ids    bigint[]    not null default '{}',
  source_import_id    uuid        references track_plan_imports(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists track_zones_type_code_idx
  on track_zones (zone_type, code);
create index if not exists track_zones_parent_idx
  on track_zones (parent_zone_id);


-- ============================================================
-- TRACK PLAN: mileposts (spatial backbone)
-- ============================================================
create table if not exists track_mileposts (
  id                uuid        primary key default gen_random_uuid(),
  mp_value          numeric     not null,
  track_name        text,
  source_shape_id   bigint,
  source_import_id  uuid        references track_plan_imports(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists track_mileposts_value_idx
  on track_mileposts (mp_value);
-- Full (non-partial) unique index — PostgREST upserts can't infer a
-- partial unique index. NULLs are distinct in PG, so any number of
-- shape-less rows still coexist (same behavior as a WHERE-clause index).
create unique index if not exists track_mileposts_shape_idx
  on track_mileposts (source_shape_id);


-- ============================================================
-- TRACK PLAN: equations (milepost discontinuities)
-- ============================================================
create table if not exists track_equations (
  id                uuid        primary key default gen_random_uuid(),
  mp_left           numeric     not null,
  mp_right          numeric     not null,
  notes             text,
  source_shape_id   bigint,
  source_import_id  uuid        references track_plan_imports(id) on delete set null,
  created_at        timestamptz not null default now()
);

create unique index if not exists track_equations_shape_idx
  on track_equations (source_shape_id);


-- ============================================================
-- TRACK PLAN: train control locations
-- (TCRs — W10, Y10, W34, W30, W40, etc.)
-- ============================================================
create table if not exists train_control_locations (
  id                uuid        primary key default gen_random_uuid(),
  code              text        unique not null,
  milepost          numeric,
  tcl_type          text,
  uic_code          text,
  is_new            boolean     default false,
  is_removed        boolean     default false,
  source_shape_id   bigint,
  source_import_id  uuid        references track_plan_imports(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists train_control_locations_shape_idx
  on train_control_locations (source_shape_id);


-- ============================================================
-- TRACK PLAN: devices (single polymorphic table)
-- One row per Visio shape that resolves to a physical or
-- logical wayside device. Promoted columns drive the common
-- filter UX; attributes JSONB carries class-specific extras.
-- source_shape_id is the primary identity for re-import.
-- ============================================================
create table if not exists track_devices (
  id                          uuid        primary key default gen_random_uuid(),
  device_type                 text        not null
                              check (device_type in (
                                'signal','virtual_signal',
                                'switch',
                                'axle_counter','wab',
                                'derailer','end_of_track','pushbutton',
                                'ivb_limit','transition_point','clearance','overlap',
                                'platform','tunnel','area'
                              )),
  device_subtype              text,
  code                        text,
  uic_code                    text,
  milepost                    numeric,
  milepost_secondary          numeric,
  track_name                  text,
  track_type                  text
                              check (track_type in ('Subway','At grade','Aerial')
                                     or track_type is null),
  direction                   text,
  position                    text
                              check (position in ('Normal','Reverse')
                                     or position is null),
  is_controlled               boolean,
  is_new                      boolean     default false,
  is_removed                  boolean     default false,
  zone_id                     uuid        references track_zones(id) on delete set null,
  zone_code                   text,
  interlocking_id             uuid        references track_zones(id) on delete set null,
  interlocking_code           text,
  train_control_location_id   uuid        references train_control_locations(id) on delete set null,
  train_control_location_code text,
  attributes                  jsonb       not null default '{}'::jsonb,
  status                      text        not null default 'in_service'
                              check (status in ('in_service','planned','decommissioned')),
  source_shape_id             bigint,
  source_sheet                text,
  source_import_id            uuid        references track_plan_imports(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create unique index if not exists track_devices_shape_idx
  on track_devices (source_shape_id);
create index if not exists track_devices_type_idx       on track_devices (device_type);
create index if not exists track_devices_code_idx       on track_devices (code);
create index if not exists track_devices_zone_idx       on track_devices (zone_id);
create index if not exists track_devices_ixl_idx        on track_devices (interlocking_id);
create index if not exists track_devices_tcl_idx        on track_devices (train_control_location_id);
create index if not exists track_devices_mp_idx         on track_devices (milepost);
create index if not exists track_devices_track_type_idx on track_devices (track_type);
create index if not exists track_devices_attrs_gin      on track_devices using gin (attributes);


-- ============================================================
-- TRACK PLAN: sections (from Block sheet)
-- The Visio Block sheet supplies only a name (e.g. W10-R10).
-- Bounding axle counters are not in the Excel; populate
-- bounding_device_*_id later when geometry is available.
-- ============================================================
create table if not exists track_sections (
  id                    uuid        primary key default gen_random_uuid(),
  code                  text        unique not null,
  zone_id               uuid        references track_zones(id) on delete set null,
  zone_code             text,
  bounding_device_a_id  uuid        references track_devices(id) on delete set null,
  bounding_device_b_id  uuid        references track_devices(id) on delete set null,
  source_shape_id       bigint,
  source_import_id      uuid        references track_plan_imports(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists track_sections_shape_idx
  on track_sections (source_shape_id);


-- ============================================================
-- TEST CASE SCOPE: extend test_items
-- ============================================================
alter table if exists test_items
  add column if not exists scope_type text not null default 'static'
    check (scope_type in ('static','dynamic'));

create index if not exists test_items_scope_type_idx
  on test_items (scope_type);


-- ============================================================
-- Procedure rollup view (no procedures table exists today;
-- test_items.test_procedure is text). UI uses this to flag
-- procedures that contain both static and dynamic test cases.
-- ============================================================
create or replace view vw_procedure_scope_rollup as
select
  test_procedure,
  count(*)                                             as total_cases,
  count(*) filter (where scope_type = 'static')        as static_count,
  count(*) filter (where scope_type = 'dynamic')       as dynamic_count,
  (count(*) filter (where scope_type = 'static')  > 0
   and
   count(*) filter (where scope_type = 'dynamic') > 0) as is_mixed
from test_items
where test_procedure is not null and test_procedure <> ''
group by test_procedure;


-- ============================================================
-- DYNAMIC TEST FILTERS (optional candidate-instance helper)
-- Stored on a test case; saving it does NOT create instances.
-- The planner runs "generate candidates" to materialize rows.
-- ============================================================
create table if not exists dynamic_test_filters (
  id              uuid        primary key default gen_random_uuid(),
  test_id         text        references test_items(test_id) on delete cascade,
  name            text        not null,
  criteria        jsonb       not null default '{}'::jsonb,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists dynamic_test_filters_test_idx
  on dynamic_test_filters (test_id);


-- ============================================================
-- DYNAMIC INSTANCES (the core executable scope)
--
-- One row = one bookable test execution scope. Authored
-- manually, via CSV/Excel import, or via filter-generated
-- candidates. Status vocabulary mirrors the existing
-- test_items status set (Not Started / In Progress / Pass /
-- Fail / Blocked / Not Applicable / Future Test).
--
-- Scheduling has two layers:
--   • Conceptual planning  →  target_window_start/end,
--                             target_phase, target_track_sections[]
--   • Real-time scheduling →  linked_activity_id, scheduled_*
--
-- required_consists is captured as advisory JSONB only —
-- shift planning does not gate on it in this phase.
-- zone_compliance_status defaults to 'unrestricted' as an
-- ASA stub for a future zone-compliance module.
-- ============================================================
create table if not exists dynamic_instances (
  id                              uuid        primary key default gen_random_uuid(),
  test_id                         text        references test_items(test_id) on delete cascade,
  source_filter_id                uuid        references dynamic_test_filters(id) on delete set null,
  code                            text,
  title                           text,
  description                     text,
  device_ids                      uuid[]      not null default '{}',
  zone_ids                        uuid[]      not null default '{}',
  section_ids                     uuid[]      not null default '{}',
  required_mode                   text
                                  check (required_mode in ('CBTC','VATC')
                                         or required_mode is null),
  required_position_requirements  jsonb       not null default '{}'::jsonb,
  required_consists               jsonb       not null default '{}'::jsonb,
  target_track_sections           text[]      not null default '{}',
  target_window_start             date,
  target_window_end               date,
  target_phase                    text,
  linked_activity_id              uuid,
  scheduled_for_date              date,
  scheduled_window                tstzrange,
  status                          text        not null default 'Not Started'
                                  check (status in (
                                    'Not Started','In Progress','Pass','Fail',
                                    'Blocked','Not Applicable','Future Test'
                                  )),
  blocked_reason                  text,
  zone_compliance_status          text        not null default 'unrestricted',
  notes                           text,
  created_by                      text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

create index if not exists dynamic_instances_test_idx
  on dynamic_instances (test_id);
create index if not exists dynamic_instances_status_idx
  on dynamic_instances (status);
create index if not exists dynamic_instances_scheduled_idx
  on dynamic_instances (scheduled_for_date);
create index if not exists dynamic_instances_target_phase_idx
  on dynamic_instances (target_phase);
create index if not exists dynamic_instances_linked_activity_idx
  on dynamic_instances (linked_activity_id);
create index if not exists dynamic_instances_devices_gin
  on dynamic_instances using gin (device_ids);
create index if not exists dynamic_instances_zones_gin
  on dynamic_instances using gin (zone_ids);
create index if not exists dynamic_instances_sections_gin
  on dynamic_instances using gin (section_ids);


-- ============================================================
-- Row-Level Security (match existing module pattern)
-- ============================================================
alter table track_plan_imports       enable row level security;
alter table track_zones              enable row level security;
alter table track_mileposts          enable row level security;
alter table track_equations          enable row level security;
alter table train_control_locations  enable row level security;
alter table track_devices            enable row level security;
alter table track_sections           enable row level security;
alter table dynamic_test_filters     enable row level security;
alter table dynamic_instances        enable row level security;

drop policy if exists track_plan_imports_auth_all       on track_plan_imports;
drop policy if exists track_zones_auth_all              on track_zones;
drop policy if exists track_mileposts_auth_all          on track_mileposts;
drop policy if exists track_equations_auth_all          on track_equations;
drop policy if exists train_control_locations_auth_all  on train_control_locations;
drop policy if exists track_devices_auth_all            on track_devices;
drop policy if exists track_sections_auth_all           on track_sections;
drop policy if exists dynamic_test_filters_auth_all     on dynamic_test_filters;
drop policy if exists dynamic_instances_auth_all        on dynamic_instances;

create policy track_plan_imports_auth_all      on track_plan_imports       for all to authenticated using (true) with check (true);
create policy track_zones_auth_all             on track_zones              for all to authenticated using (true) with check (true);
create policy track_mileposts_auth_all         on track_mileposts          for all to authenticated using (true) with check (true);
create policy track_equations_auth_all         on track_equations          for all to authenticated using (true) with check (true);
create policy train_control_locations_auth_all on train_control_locations  for all to authenticated using (true) with check (true);
create policy track_devices_auth_all           on track_devices            for all to authenticated using (true) with check (true);
create policy track_sections_auth_all          on track_sections           for all to authenticated using (true) with check (true);
create policy dynamic_test_filters_auth_all    on dynamic_test_filters     for all to authenticated using (true) with check (true);
create policy dynamic_instances_auth_all       on dynamic_instances        for all to authenticated using (true) with check (true);


-- ============================================================
-- Data API grants
-- ============================================================
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on table
  track_plan_imports,
  track_zones,
  track_mileposts,
  track_equations,
  train_control_locations,
  track_devices,
  track_sections,
  dynamic_test_filters,
  dynamic_instances
  to authenticated, service_role;
grant select on vw_procedure_scope_rollup to authenticated, service_role;


-- ============================================================
-- RUNS + EQUIVALENCE (follow-on migration)
--
-- A dynamic_instances row is one executable "run": a movement
-- from a start point, through optional intermediate points, to
-- a finish point (points may be platforms, sidings, signals,
-- etc.). Planning is driven mainly by control_zone_code,
-- track_section_access_req[] and prerequisites.
--
-- equivalence_group_id models the "Substitute" concept: two or
-- more runs that are alternative ways to satisfy the same
-- coverage (different route/platform/method, possibly across
-- test cases). Completing ANY member satisfies the whole group,
-- and the group counts as ONE unit for KPIs. NULL group = the
-- run is its own singleton unit.
-- ============================================================
alter table dynamic_instances
  add column if not exists start_point               text,
  add column if not exists intermediate_points       text[] not null default '{}',
  add column if not exists finish_point              text,
  add column if not exists track_section_under_test  text,
  add column if not exists track_section_access_req  text[] not null default '{}',
  add column if not exists prerequisites             text,
  add column if not exists equivalence_group_id      uuid;

create index if not exists dynamic_instances_eqgroup_idx
  on dynamic_instances (equivalence_group_id);
create index if not exists dynamic_instances_tsut_idx
  on dynamic_instances (track_section_under_test);
create index if not exists dynamic_instances_access_gin
  on dynamic_instances using gin (track_section_access_req);

-- Per-instance unit key (group members collapse to one unit).
create or replace view vw_dynamic_units as
select
  coalesce(equivalence_group_id::text, id::text) as unit_key,
  test_id,
  status,
  equivalence_group_id
from dynamic_instances;

-- Per-test-case coverage; a unit is done if ANY member passed.
create or replace view vw_dynamic_case_coverage as
with units as (
  select
    test_id,
    coalesce(equivalence_group_id::text, id::text) as unit_key,
    bool_or(status = 'Pass') as unit_done
  from dynamic_instances
  group by test_id, coalesce(equivalence_group_id::text, id::text)
)
select
  test_id,
  count(*)                          as total_units,
  count(*) filter (where unit_done) as done_units,
  round(100.0 * count(*) filter (where unit_done) / nullif(count(*), 0), 1) as pct_complete
from units
group by test_id;

-- Global coverage; each equivalence group counts once even when
-- it spans multiple test cases.
create or replace view vw_dynamic_global_coverage as
with gunits as (
  select
    coalesce(equivalence_group_id::text, id::text) as unit_key,
    bool_or(status = 'Pass') as unit_done
  from dynamic_instances
  group by coalesce(equivalence_group_id::text, id::text)
)
select
  count(*)                          as total_units,
  count(*) filter (where unit_done) as done_units
from gunits;

grant select on vw_dynamic_units, vw_dynamic_case_coverage, vw_dynamic_global_coverage
  to authenticated, service_role;


notify pgrst, 'reload schema';


-- ============================================================
-- FOLLOW-ON: drop control_zone_code, add test-scope/cadence
-- (applied live as migration dynamic_drop_control_zone_add_scope)
--
-- track_section_under_test is now the single core zone — the planning,
-- booking, board and KPI axis. control_zone_code is removed; access zones
-- live in track_section_access_req[]. test_items gains a cadence
-- classification so one procedure can be per-location, per-phase, or
-- one-time functional.
-- ============================================================

-- control_zone_code superseded by track_section_under_test.
drop index if exists idx_dynamic_instances_control_zone;
alter table dynamic_instances drop column if exists control_zone_code;
create index if not exists idx_dynamic_instances_tsut
  on dynamic_instances (track_section_under_test);

-- Cadence classification on the test case.
alter table test_items
  add column if not exists test_scope text
    check (test_scope is null or test_scope in ('per_location','per_phase','functional')),
  add column if not exists applicable_locations text[] default '{}';
comment on column test_items.test_scope is
  'Dynamic-case cadence: per_location (repeat per applicable_locations), per_phase (once per phase), functional (one-time).';
comment on column test_items.applicable_locations is
  'For per_location scope: user-defined LOCS level-2 section codes (e.g. W40) the procedure repeats at.';

-- vw_dynamic_duration_variance and fn_feasible_instances are recreated to
-- group/filter on track_section_under_test instead of control_zone_code.
-- (Full bodies in migration dynamic_drop_control_zone_add_scope.)

notify pgrst, 'reload schema';


-- ============================================================
-- FOLLOW-ON 2: per-location activity branching
-- (applied live as migration dynamic_add_procedure_grouping)
--
-- A per_location procedure becomes ONE test activity PER location: the
-- procedure "DCS-SIT" run at W40/Y10/W34 splits into activities
-- W40-DCS-SIT, Y10-DCS-SIT, W34-DCS-SIT. Each activity's location lives in
-- the existing test_items.location column; applicable_locations is no longer
-- hand-maintained (the location is read off the activity's instances).
-- procedure_code is the shared base key so the per-location activities roll
-- up to one procedure for coverage. Splitting happens at CSV import and via
-- the "Add location" button in the Dynamic Test Cases tab.
-- ============================================================
alter table test_items
  add column if not exists procedure_code text,
  add column if not exists procedure_name text;
create index if not exists idx_test_items_procedure_code
  on test_items (procedure_code);
comment on column test_items.procedure_code is
  'Base procedure key shared by per-location activities (e.g. DCS-SIT for W40-DCS-SIT, Y10-DCS-SIT) so coverage rolls up across locations.';

-- Procedure-level coverage rollup (migration dynamic_procedure_coverage_view):
-- per-location activities sharing procedure_code collapse to one procedure so
-- KPIs read "passed at N of M locations". Standalone dynamic cases (null
-- procedure_code) are a one-location procedure keyed on their test_id.
create or replace view vw_dynamic_procedure_coverage as
with act as (
  select
    coalesce(ti.procedure_code, ti.test_id)       as procedure_key,
    coalesce(ti.procedure_name, ti.test_name)     as procedure_name,
    ti.test_id,
    ti.test_scope,
    coalesce(s.rollup_status, 'No Instances')     as rollup_status,
    coalesce(s.instance_count, 0)                 as instance_count,
    coalesce(s.complete_count, 0)                 as complete_count
  from test_items ti
  left join vw_dynamic_test_case_status s on s.test_id = ti.test_id
  where ti.scope_type = 'dynamic'
)
select
  procedure_key,
  max(procedure_name)                                                   as procedure_name,
  bool_or(test_scope = 'per_location')                                  as is_per_location,
  count(*)                                                              as location_count,
  count(*) filter (where rollup_status = 'Pass')                        as passed_count,
  count(*) filter (where rollup_status in ('Fail','Blocked'))           as fail_blocked_count,
  count(*) filter (where rollup_status = 'No Instances')                as empty_count,
  sum(instance_count)                                                   as instance_count,
  sum(complete_count)                                                   as complete_count,
  round(100.0 * count(*) filter (where rollup_status = 'Pass')
        / nullif(count(*), 0), 1)                                       as pct_locations_passed
from act
group by procedure_key;

grant select on vw_dynamic_procedure_coverage to authenticated, service_role;

notify pgrst, 'reload schema';
