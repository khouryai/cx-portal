-- ============================================================
-- Dynamic Testing ⇄ Lookahead: occupancy-driven cell lifecycle + delete mirror
--
-- Owner-directed model change (2026-06): a Lookahead cell
-- (planning_events source='dynamic') exists for an access window ONLY while >=1
-- ACTIVE (not Pass/Not Applicable) test instance is scheduled on it.
--   • schedule the first test onto a window  -> mint the cell
--   • unschedule the last test from a window -> remove the cell (window stays in
--     the Access Plan)
--   • delete a window  -> its cell is removed too (FK cascade)
--   • delete a cell in the Lookahead -> its window is removed too (handled in the
--     app's deliberate delete action _planningDeleteEvent, which deletes the
--     window so the cell cascades — intentionally NOT a DB trigger, so the
--     Lookahead's internal move/copy/fill deletes never nuke a window)
-- So the two modules mirror each other and empty/planned-but-unallocated windows
-- no longer clutter the Lookahead.
--
-- Replaces the old behaviour where _dynEnsureShiftCell minted a cell for EVERY
-- generated window (cells full while nothing was actually scheduled) and the
-- dynamic_shift_id FK was ON DELETE SET NULL (deleting a window orphaned its cell).
--
-- Applied live as migration: dyn_lookahead_occupancy_cell_sync.
-- ============================================================

-- 1) Drop the SET-NULL FK so we can clean up and re-point it to CASCADE.
alter table planning_events drop constraint if exists planning_events_dynamic_shift_id_fkey;

-- 2) Clean slate: remove dynamic cells whose window has no active test, plus any
--    orphan dynamic cells (window already deleted -> dynamic_shift_id went NULL).
--    Safe here: no FK and the cell->window delete trigger is created further down,
--    so deleting these cells touches no windows.
delete from planning_events e
 where e.source = 'dynamic'
   and (e.dynamic_shift_id is null
        or not exists (select 1 from dynamic_instances i
                        where i.shift_id = e.dynamic_shift_id
                          and coalesce(i.status, '') not in ('Pass', 'Not Applicable')));

-- 3) Re-add the link as ON DELETE CASCADE: deleting a window now removes its cell.
alter table planning_events
  add constraint planning_events_dynamic_shift_id_fkey
  foreign key (dynamic_shift_id) references zone_access_windows(id) on delete cascade;

-- 4) One cell per window (guards both the trigger and the app create path).
create unique index if not exists planning_events_dynamic_shift_uniq
  on planning_events (dynamic_shift_id)
  where source = 'dynamic' and dynamic_shift_id is not null;

-- 5) Occupancy sync: reconcile a window's cell with its active-test count.
create or replace function dyn_sync_cell_occupancy(p_window uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_active int;
  v_cell   uuid;
  v_win    zone_access_windows%rowtype;
  v_camp   access_campaigns%rowtype;
  v_act    uuid;
  v_st     time;
  v_en     time;
begin
  if p_window is null then return; end if;
  select * into v_win from zone_access_windows where id = p_window;
  if not found then return; end if;          -- window gone; FK cascade took its cell

  select count(*) into v_active
    from dynamic_instances
   where shift_id = p_window
     and coalesce(status, '') not in ('Pass', 'Not Applicable');

  select id into v_cell
    from planning_events
   where dynamic_shift_id = p_window and source = 'dynamic'
   limit 1;

  if v_active > 0 and v_cell is null then
    -- first test landed: mint the cell (and the campaign's activity row if needed)
    if v_win.campaign_id is not null then
      select * into v_camp from access_campaigns where id = v_win.campaign_id;
      select id into v_act from planning_activities
        where access_campaign_id = v_win.campaign_id limit 1;
      if v_act is null then
        insert into planning_activities
          (access_campaign_id, description, activity_group, location, phase, match_status, sort_order)
        values
          (v_win.campaign_id, coalesce(v_camp.name, 'Dynamic testing'), 'dynamic_testing',
           array_to_string(coalesce(v_camp.zone_codes, '{}'), ', '), v_camp.phase, 'unmatched', 0)
        returning id into v_act;
      end if;
    end if;
    -- per-window wall time at UTC (drift-free; matches how windows are stored)
    v_st := case when v_win.start_at is not null then (v_win.start_at at time zone 'UTC')::time end;
    v_en := case when v_win.end_at   is not null then (v_win.end_at   at time zone 'UTC')::time end;
    insert into planning_events
      (planning_activity_id, title, event_date, start_time, end_time, all_day, location,
       cell_color_hex, source, status, dynamic_shift_id, notes)
    values
      (v_act,
       'Dynamic test — ' || v_win.control_zone_code || coalesce(' (' || v_camp.name || ')', ''),
       v_win.shift_date, v_st, v_en, false, v_win.control_zone_code,
       '#6d28d9', 'dynamic',
       case when v_win.status = 'cancelled' then 'cancelled' else 'planned' end,
       p_window,
       'Access plan cell' || coalesce(' · ' || v_camp.name, ''));
  elsif v_active = 0 and v_cell is not null then
    -- last test left: remove the cell (window itself stays in the Access Plan)
    delete from planning_events where id = v_cell;
  end if;
end; $$;

create or replace function dyn_instance_cell_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- reconcile both the window the run LEFT and the one it LANDED on
  if tg_op <> 'INSERT' and old.shift_id is not null then
    perform dyn_sync_cell_occupancy(old.shift_id);
  end if;
  if tg_op <> 'DELETE' and new.shift_id is not null then
    perform dyn_sync_cell_occupancy(new.shift_id);
  end if;
  return coalesce(new, old);
end; $$;

-- (The cell -> window delete mirror is handled in the app's _planningDeleteEvent,
--  NOT a DB trigger — see header. Deleting a window from either side already
--  removes the cell via the ON DELETE CASCADE FK above.)

revoke execute on function dyn_sync_cell_occupancy(uuid)  from public, anon;
revoke execute on function dyn_instance_cell_trigger()    from public, anon;

drop trigger if exists trg_dyn_instance_cell on dynamic_instances;
create trigger trg_dyn_instance_cell
  after insert or delete or update of shift_id, status on dynamic_instances
  for each row execute function dyn_instance_cell_trigger();
