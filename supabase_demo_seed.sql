-- ============================================================================
-- PRESENTATION DEMO SEED — fully reversible.
-- ----------------------------------------------------------------------------
-- Applied to production via MCP migration `demo_seed_presentation` (2026-05-29).
-- Every row inserted here is recorded in demo_seed_log (table + pk) AND tagged
-- with the marker 'DEMO_SEED' / '[DEMO]'. The teardown
-- (supabase_demo_teardown.sql) deletes ONLY the exact pks recorded here, so
-- real data can never be touched. See DEMO_DATA.md.
-- ============================================================================

create table if not exists demo_seed_log (
  id          bigserial primary key,
  table_name  text not null,
  record_id   text not null,
  seeded_at   timestamptz not null default now()
);

-- ── Punch List (13 items spanning every status; some high/overdue for KPIs) ──
with rows_ins as (
  insert into punch_items
    (number, title, description, subsystem, location, phase, priority, status, type,
     created_by, created_at, due_date, assignees, punch_item_manager, final_approver, rtc_work_item_id)
  values
    (101,'IXL relay cabinet wiring discrepancy','Field wiring does not match approved schematic at W40.','IXL','loc-1778017101382-avjj','loc-1778017095958-gzsp','High','initiated','Defect','DEMO_SEED', now()-interval '9 days',  current_date+5,  '["Jordan Lee"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (102,'ATS workstation time-sync drift','LATS clock drifts ~3s/hr; NTP source to be confirmed.','ATS','loc-1778017101175-otuh','loc-1778017095958-gzsp','Medium','work_required','Issue','DEMO_SEED', now()-interval '14 days', current_date-2,  '["Sam Rivera","Jordan Lee"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (103,'DCS switch port mislabeled','Port 14 labeled as 41 in TCR rack.','DCS','loc-1778017101243-toa8','loc-1778017095958-gzsp','Low','closed','Observation','DEMO_SEED', now()-interval '30 days', current_date-12, '["Sam Rivera"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (104,'CORE CBTC transponder offset','Transponder placement 0.4m beyond tolerance.','CORE CBTC','loc-1778017101382-avjj','loc-1778017095958-gzsp','High','ready_for_review','Defect','DEMO_SEED', now()-interval '6 days',  current_date+3,  '["Pat Chen"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (105,'POWER UPS battery below spec','Runtime test fell short of 30-min requirement.','POWER','loc-1778017101243-toa8','loc-1778017095958-gzsp','Critical','work_required','NCR','DEMO_SEED', now()-interval '4 days',  current_date-1,  '["Jordan Lee"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (106,'SCADA alarm priority mismatch','Two alarms inverted vs. cause-and-effect matrix.','SCADA','loc-1778017101449-kjgs','loc-1778017095958-gzsp','Medium','in_dispute','Issue','DEMO_SEED', now()-interval '11 days', current_date+8,  '["Sam Rivera"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (107,'IXL signal aspect timing','Yellow aspect held 0.5s long during D/N test.','IXL','loc-1778017101175-otuh','loc-1778017095958-gzsp','High','ready_to_close','Defect','DEMO_SEED', now()-interval '18 days', current_date-3,  '["Pat Chen","Jordan Lee"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (108,'DCS fiber patch documentation gap','As-built patch schedule missing two strands.','DCS','loc-1778017101382-avjj','loc-1778017095958-gzsp','Low','draft','Observation','DEMO_SEED', now()-interval '2 days',  current_date+14, '[]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (109,'ATS map display rendering glitch','Track segment flickers at zoom > 8x.','ATS','loc-1778017101449-kjgs','loc-1778017095958-gzsp','Medium','work_not_accepted','Issue','DEMO_SEED', now()-interval '16 days', current_date-5,  '["Sam Rivera"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (110,'CORE CBTC handover latency','Zone handover exceeded budget by 80ms in sim.','CORE CBTC','loc-1778017101243-toa8','loc-1778017095958-gzsp','Critical','initiated','NCR','DEMO_SEED', now()-interval '3 days',  current_date+2,  '["Pat Chen"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (111,'POWER grounding continuity','One bond resistance reading above threshold.','POWER','loc-1778017101175-otuh','loc-1778017095958-gzsp','High','ready_for_review','Defect','DEMO_SEED', now()-interval '7 days',  current_date+4,  '["Jordan Lee"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (112,'SCADA historian retention','Trend retention configured for 30d, spec is 90d.','SCADA','loc-1778017101382-avjj','loc-1778017095958-gzsp','Medium','closed','Issue','DEMO_SEED', now()-interval '25 days', current_date-15, '["Sam Rivera"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO'),
    (113,'IXL spare relay inventory short','Two spare relays not yet delivered to site.','IXL','loc-1778017101243-toa8','loc-1778017095958-gzsp','Low','not_accepted','Observation','DEMO_SEED', now()-interval '20 days', current_date-6,  '["Pat Chen"]'::jsonb,'Alex Khoury','Alex Khoury','DEMO')
  returning id
)
insert into demo_seed_log (table_name, record_id)
select 'punch_items', id::text from rows_ins;

-- ── Software Configs (8 records, incl. a superseded version) ─────────────────
with sw_ins as (
  insert into software_configs
    (subsystem, location, device_label, software_name, version, install_date, installed_by, status, baseline, cdrl_ref, notes, created_by)
  values
    ('IXL','W40 Millbrae Station','IXL Vital Processor A','Hitachi IXL Core','R8.2.1', current_date-40,'Sam Rivera','active','Baseline 8.2','CDRL-A012','[DEMO] presentation data','DEMO_SEED'),
    ('ATS','W40 Millbrae Station','LATS Workstation 1','ATS Supervisory Suite','v5.4.0', current_date-35,'Jordan Lee','active','Baseline 5.4','CDRL-A013','[DEMO] presentation data','DEMO_SEED'),
    ('CORE CBTC','W20 S. San Francisco Station','Wayside Controller WC-12','CBTC Wayside FW','3.7.2', current_date-28,'Pat Chen','active','Baseline 3.7','CDRL-A014','[DEMO] presentation data','DEMO_SEED'),
    ('DCS','W30 San Bruno Station','DCS Core Switch','DCS Network OS','12.3R6', current_date-22,'Sam Rivera','active','Baseline 12.3','CDRL-A015','[DEMO] presentation data','DEMO_SEED'),
    ('POWER','W30 San Bruno Station','Power SCADA RTU-3','Power Mgmt FW','2.1.9', current_date-18,'Jordan Lee','active','Baseline 2.1','CDRL-A016','[DEMO] presentation data','DEMO_SEED'),
    ('SCADA','Y10 SF Int. Airport','SCADA Server Primary','SCADA HMI Platform','9.0.4', current_date-15,'Pat Chen','active','Baseline 9.0','CDRL-A017','[DEMO] presentation data','DEMO_SEED'),
    ('CORE CBTC','W40 Millbrae Station','Carborne CC-04','CBTC Carborne FW','3.7.0', current_date-60,'Sam Rivera','superseded','Baseline 3.7','CDRL-A014','[DEMO] superseded by 3.7.2','DEMO_SEED'),
    ('IXL','W20 S. San Francisco Station','IXL Vital Processor B','Hitachi IXL Core','R8.2.1', current_date-12,'Jordan Lee','active','Baseline 8.2','CDRL-A012','[DEMO] presentation data','DEMO_SEED')
  returning id
)
insert into demo_seed_log (table_name, record_id)
select 'software_configs', id::text from sw_ins;

-- ── Schedule: a demo "current" P6 batch + activity maps, so variance renders ──
do $$
declare
  v_batch uuid;
  r record;
  v_new  uuid;
  v_map  uuid;
  base_ids uuid[] := '{}';
  i int := 0;
begin
  insert into p6_import_batches (title, schedule_type, is_current, imported_by, row_count, notes)
  values ('[DEMO] Current Working Schedule — May 2026', 'current', true, 'DEMO_SEED', 10, '[DEMO] presentation data')
  returning id into v_batch;
  insert into demo_seed_log (table_name, record_id) values ('p6_import_batches', v_batch::text);

  for r in
    select a.id as base_id, a.p6_id, a.p6_name, a.start_date, a.finish_date, a.budgeted_units
    from p6_activities a
    join p6_import_batches b on b.id = a.batch_id and b.schedule_type='baseline' and b.is_current=true
    where a.finish_date is not null and a.p6_name not ilike '%(Deleted)%'
    order by a.finish_date
    limit 10
  loop
    i := i + 1;
    insert into p6_activities
      (batch_id, p6_id, p6_name, start_date, finish_date, remaining_duration_days, budgeted_units, is_actual)
    values
      (v_batch, r.p6_id, r.p6_name,
       r.start_date + ((i % 3)) * interval '2 days',
       r.finish_date + (((i % 4) + 1) * 4) * interval '1 day',
       0, r.budgeted_units, false)
    returning id into v_new;
    insert into demo_seed_log (table_name, record_id) values ('p6_activities', v_new::text);
    base_ids := array_append(base_ids, r.base_id);
  end loop;

  i := 0;
  for r in
    select phase, location, subsystem, activity_name
    from activity_records order by created_at limit 10
  loop
    i := i + 1;
    exit when i > array_length(base_ids, 1);
    insert into p6_activity_map
      (p6_activity_id, portal_phase, portal_location, portal_subsystem, portal_activity, linked_by, was_confirmed)
    values
      (base_ids[i], r.phase, r.location, r.subsystem, r.activity_name, 'DEMO_SEED', true)
    returning id into v_map;
    insert into demo_seed_log (table_name, record_id) values ('p6_activity_map', v_map::text);
  end loop;
end$$;
