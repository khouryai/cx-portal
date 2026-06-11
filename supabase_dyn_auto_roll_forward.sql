-- ============================================================
-- Auto-roll-forward on cancellation (Increment D)
--
-- When an access window is cancelled (from either module — Increment B routes a
-- Lookahead cell cancel to a window UPDATE), its assigned dynamic_instances
-- auto-move to the earliest FUTURE PLANNED window of the same campaign + core
-- zone (mode-compatible), leaving a "moved from" trail (moved_from_window_id,
-- roll_count, rolled_at, roll_note). If none is feasible the run returns to the
-- backlog, flagged. Capacity is not hard-gated (planner rebalances);
-- allocation stays auto-suggest-then-edit. Done runs (Pass / Not Applicable)
-- are left untouched.
--
-- Applied live as migration: dyn_auto_roll_forward_on_window_cancel.
-- ============================================================

alter table dynamic_instances
  add column if not exists moved_from_window_id uuid references zone_access_windows(id) on delete set null,
  add column if not exists roll_count integer not null default 0,
  add column if not exists rolled_at timestamptz,
  add column if not exists roll_note text;
create index if not exists dynamic_instances_moved_from_idx
  on dynamic_instances (moved_from_window_id);

create or replace function dyn_roll_forward_on_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inst   record;
  target zone_access_windows%rowtype;
begin
  if new.status <> 'cancelled' or old.status is not distinct from 'cancelled' then
    return new;
  end if;
  for inst in
    select * from dynamic_instances
     where shift_id = new.id and status not in ('Pass','Not Applicable')
  loop
    select w.* into target
      from zone_access_windows w
     where w.id <> new.id
       and w.status = 'planned'
       and w.control_zone_code = coalesce(inst.track_section_under_test, new.control_zone_code)
       and (w.shift_date > new.shift_date
            or (w.shift_date = new.shift_date and w.start_at > new.start_at))
       and (inst.required_mode is null or w.allowed_modes @> array[inst.required_mode])
       and (new.campaign_id is null or w.campaign_id is not distinct from new.campaign_id)
     order by w.shift_date asc nulls last, w.start_at asc nulls last
     limit 1;

    if target.id is not null then
      update dynamic_instances
         set shift_id=target.id, scheduled_for_date=target.shift_date,
             scheduled_window = case when target.start_at is not null and target.end_at is not null
                                     then tstzrange(target.start_at, target.end_at, '[)') end,
             moved_from_window_id=new.id, roll_count=coalesce(roll_count,0)+1, rolled_at=now(),
             roll_note='Auto-rolled from cancelled ' || new.control_zone_code || ' on ' || new.shift_date::text,
             updated_at=now()
       where id = inst.id;
    else
      update dynamic_instances
         set shift_id=null, scheduled_for_date=null, scheduled_window=null,
             moved_from_window_id=new.id, roll_count=coalesce(roll_count,0)+1, rolled_at=now(),
             roll_note='Unscheduled — no feasible window after cancelled ' || new.control_zone_code || ' on ' || new.shift_date::text,
             updated_at=now()
       where id = inst.id;
    end if;
  end loop;
  return new;
end; $$;

revoke execute on function dyn_roll_forward_on_cancel() from public, anon;

drop trigger if exists trg_dyn_roll_forward on zone_access_windows;
create trigger trg_dyn_roll_forward
  after update of status on zone_access_windows
  for each row execute function dyn_roll_forward_on_cancel();
