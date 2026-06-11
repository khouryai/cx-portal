-- ============================================================
-- Dynamic Testing ⇄ Lookahead: SHARED RECORDS bridge (Increment A)
--
-- A dynamic-testing access campaign IS a Lookahead activity row, and each
-- per-day access window IS a planning_event cell on that row. One plan,
-- rendered natively in both modules (no parallel copy / sync layer).
--
--   access_campaigns      ⇄  planning_activities.access_campaign_id  (the ROW)
--   zone_access_windows   ⇄  planning_events.dynamic_shift_id        (the CELLS)
--                            (source='dynamic')
--
-- Applied live as migration: dyn_lookahead_shared_records_campaign_activity.
-- Idempotent; safe to re-run.
-- ============================================================

-- 'dynamic' becomes a valid planning_events source (the bridge discriminator).
alter table planning_events drop constraint if exists planning_events_source_check;
alter table planning_events add constraint planning_events_source_check
  check (source = any (array['lookahead','manual','pto','p6_overlay','dynamic']));

-- A dedicated activity-group band for dynamic-testing rows.
alter table planning_activities drop constraint if exists planning_activities_activity_group_check;
alter table planning_activities add constraint planning_activities_activity_group_check
  check (activity_group is null or activity_group = any (array[
    'tc','construction','design','training','other','dynamic_testing'
  ]));

-- The shared-record link: when set, this Lookahead activity row IS a campaign.
alter table planning_activities
  add column if not exists access_campaign_id uuid
    references access_campaigns(id) on delete cascade;
create index if not exists planning_activities_access_campaign_idx
  on planning_activities (access_campaign_id);
comment on column planning_activities.access_campaign_id is
  'Shared-record link: when set, this Lookahead activity row IS a dynamic-testing access campaign. Its planning_events (source=dynamic, dynamic_shift_id set) are the per-day access cells.';

-- Backfill: one Lookahead activity row per existing campaign.
insert into planning_activities
  (access_campaign_id, description, activity_group, location, phase,
   activity_id_text, match_status, sort_order)
select c.id, c.name, 'dynamic_testing',
       array_to_string(c.zone_codes, ', '), c.phase,
       'DYN-' || left(replace(c.id::text, '-', ''), 8), 'unmatched', 0
from access_campaigns c
where not exists (select 1 from planning_activities a where a.access_campaign_id = c.id);

-- Backfill: one planning_event cell per campaign-linked window. Uses the
-- campaign's wall-clock shift_start/end (canonical intended time) rather than
-- start_at::time, which is UTC-shifted in storage.
insert into planning_events
  (planning_activity_id, dynamic_shift_id, title, event_date,
   start_time, end_time, all_day, location, cell_color_hex, source, status, notes)
select a.id, w.id,
       'Dynamic test — ' || w.control_zone_code || ' (' || c.name || ')',
       w.shift_date, c.shift_start, c.shift_end, false,
       w.control_zone_code, '#6d28d9', 'dynamic',
       case when w.status = 'cancelled' then 'cancelled' else 'planned' end,
       'Access plan cell · ' || c.name
from zone_access_windows w
join access_campaigns c    on c.id = w.campaign_id
join planning_activities a on a.access_campaign_id = c.id
where w.shift_date is not null
  and not exists (select 1 from planning_events e where e.dynamic_shift_id = w.id);

notify pgrst, 'reload schema';
