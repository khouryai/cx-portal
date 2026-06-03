-- ============================================================================
-- Lookahead weekly snapshots — frozen Mon–Sun record of planned work.
-- ----------------------------------------------------------------------------
-- Applied to production via MCP migrations `planning_week_snapshots` and
-- `schedule_weekly_planning_snapshot`.
--
-- Why: the live Lookahead window is anchored to today and can't look back.
-- Raw past events DO persist, but they're mutable. These snapshots freeze each
-- completed week (activities + that week's events + assigned resources +
-- cancellation/completion status) into an immutable JSONB log for audit and
-- weekly reporting. A pg_cron job captures the just-finished week every Monday.
-- ============================================================================

create table if not exists planning_week_snapshots (
  id              uuid primary key default gen_random_uuid(),
  week_start      date not null unique,   -- Monday
  week_end        date not null,          -- Sunday
  captured_at     timestamptz not null default now(),
  activity_count  int  not null default 0,
  event_count     int  not null default 0,
  cancelled_count int  not null default 0,
  payload         jsonb not null default '[]'::jsonb
);

alter table planning_week_snapshots enable row level security;
do $$ begin
  create policy planning_week_snapshots_auth on planning_week_snapshots
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Build (or skip if already frozen) the Mon–Sun week starting p_week_start.
create or replace function capture_planning_week(p_week_start date)
returns planning_week_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week_end date := p_week_start + 6;
  v_payload  jsonb;
  v_acts int; v_evts int; v_canc int;
  v_row planning_week_snapshots;
begin
  select coalesce(jsonb_agg(act order by lower(coalesce(act->>'description',''))), '[]'::jsonb)
  into v_payload
  from (
    select jsonb_build_object(
      'id', a.id, 'activity_id_text', a.activity_id_text, 'description', a.description,
      'activity_group', a.activity_group, 'location', a.location, 'phase', a.phase,
      'subsystem', null, 'discipline', a.discipline, 'trade', a.trade,
      'sswp', a.sswp, 'work_hours_raw', a.work_hours_raw, 'party_to_action', a.party_to_action,
      'status_override', a.status_override, 'status_note', a.status_note,
      'linked_test_register_activity', a.linked_test_register_activity,
      'events', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', e.id, 'event_date', e.event_date, 'title', e.title, 'shift_type', e.shift_type,
          'start_time', e.start_time, 'end_time', e.end_time, 'all_day', e.all_day, 'location', e.location,
          'status', e.status, 'cancellation_category', e.cancellation_category,
          'cancellation_reason', e.cancellation_reason,
          'cancellation_responsible_party', e.cancellation_responsible_party,
          'notes', e.notes, 'is_locked', e.is_locked,
          'resources', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'resource_id', er.resource_id, 'name', r.display_name, 'initials', r.initials,
              'kind', r.kind, 'company', r.company, 'role', er.role, 'quantity', er.quantity,
              'denied', (er.denied_at is not null)
            ) order by r.display_name), '[]'::jsonb)
            from planning_event_resources er
            left join planning_resources r on r.id = er.resource_id
            where er.event_id = e.id
          )
        ) order by e.event_date, e.start_time nulls first), '[]'::jsonb)
        from planning_events e
        where e.planning_activity_id = a.id and e.event_date between p_week_start and v_week_end
      )
    ) as act
    from planning_activities a
    where a.deleted_at is null
      and exists (select 1 from planning_events e2
                  where e2.planning_activity_id = a.id and e2.event_date between p_week_start and v_week_end)
  ) sub;

  select count(distinct a.id), count(e.*), count(*) filter (where e.status = 'cancelled')
  into v_acts, v_evts, v_canc
  from planning_events e
  join planning_activities a on a.id = e.planning_activity_id and a.deleted_at is null
  where e.event_date between p_week_start and v_week_end;

  insert into planning_week_snapshots (week_start, week_end, payload, activity_count, event_count, cancelled_count)
  values (p_week_start, v_week_end, coalesce(v_payload,'[]'::jsonb), coalesce(v_acts,0), coalesce(v_evts,0), coalesce(v_canc,0))
  on conflict (week_start) do nothing
  returning * into v_row;
  return v_row;
end;
$$;

-- Backfill completed weeks that have events (run once):
--   select capture_planning_week(wk) from (
--     select distinct date_trunc('week', event_date)::date wk from planning_events
--     where date_trunc('week', event_date)::date <= (date_trunc('week', current_date)::date - 7)
--   ) m;

-- Server-side weekly schedule (pg_cron): every Monday 09:00 UTC freeze last week.
create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'capture-planning-week') then
    perform cron.unschedule('capture-planning-week');
  end if;
  perform cron.schedule('capture-planning-week', '0 9 * * 1',
    $cmd$ select capture_planning_week((date_trunc('week', current_date)::date - 7)); $cmd$);
end $$;
