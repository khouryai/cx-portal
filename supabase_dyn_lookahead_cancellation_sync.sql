-- ============================================================
-- Bidirectional cancellation / delay sync (Increment B)
--
-- planning_events (source='dynamic') ⇄ zone_access_windows, linked by
-- planning_events.dynamic_shift_id = zone_access_windows.id.
--
-- A cancellation (or delay, captured as a cancellation category) made in
-- EITHER module is mirrored to the other, along with reason + category.
-- Only cancel / un-cancel transitions are mirrored, so each module keeps its
-- own confirmed/completed lifecycle. IS DISTINCT FROM guards in the mirror
-- UPDATEs make the return path update 0 rows, breaking the trigger ping-pong.
-- SECURITY DEFINER so the shared-record invariant holds regardless of which
-- module's RLS the acting user has on the sibling table.
--
-- Applied live as migration: dyn_lookahead_bidirectional_cancellation_sync.
-- ============================================================

create or replace function dyn_sync_pe_to_window()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source <> 'dynamic' or new.dynamic_shift_id is null then
    return new;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update zone_access_windows w
       set status='cancelled', cancellation_reason=new.cancellation_reason,
           cancellation_category=new.cancellation_category
     where w.id = new.dynamic_shift_id
       and (w.status is distinct from 'cancelled'
            or w.cancellation_reason is distinct from new.cancellation_reason
            or w.cancellation_category is distinct from new.cancellation_category);
  elsif old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    update zone_access_windows w
       set status='planned', cancellation_reason=null, cancellation_category=null
     where w.id = new.dynamic_shift_id and w.status='cancelled';
  elsif new.status = 'cancelled'
        and (old.cancellation_reason is distinct from new.cancellation_reason
             or old.cancellation_category is distinct from new.cancellation_category) then
    update zone_access_windows w
       set cancellation_reason=new.cancellation_reason,
           cancellation_category=new.cancellation_category
     where w.id = new.dynamic_shift_id
       and (w.cancellation_reason is distinct from new.cancellation_reason
            or w.cancellation_category is distinct from new.cancellation_category);
  end if;
  return new;
end; $$;

create or replace function dyn_sync_window_to_pe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update planning_events e
       set status='cancelled', cancellation_reason=new.cancellation_reason,
           cancellation_category=new.cancellation_category
     where e.dynamic_shift_id = new.id and e.source='dynamic'
       and (e.status is distinct from 'cancelled'
            or e.cancellation_reason is distinct from new.cancellation_reason
            or e.cancellation_category is distinct from new.cancellation_category);
  elsif old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    update planning_events e
       set status='planned', cancellation_reason=null, cancellation_category=null
     where e.dynamic_shift_id = new.id and e.source='dynamic' and e.status='cancelled';
  elsif new.status = 'cancelled'
        and (old.cancellation_reason is distinct from new.cancellation_reason
             or old.cancellation_category is distinct from new.cancellation_category) then
    update planning_events e
       set cancellation_reason=new.cancellation_reason,
           cancellation_category=new.cancellation_category
     where e.dynamic_shift_id = new.id and e.source='dynamic'
       and (e.cancellation_reason is distinct from new.cancellation_reason
            or e.cancellation_category is distinct from new.cancellation_category);
  end if;
  return new;
end; $$;

revoke execute on function dyn_sync_pe_to_window() from public, anon;
revoke execute on function dyn_sync_window_to_pe() from public, anon;

drop trigger if exists trg_dyn_sync_pe_to_window on planning_events;
create trigger trg_dyn_sync_pe_to_window
  after update of status, cancellation_reason, cancellation_category on planning_events
  for each row execute function dyn_sync_pe_to_window();

drop trigger if exists trg_dyn_sync_window_to_pe on zone_access_windows;
create trigger trg_dyn_sync_window_to_pe
  after update of status, cancellation_reason, cancellation_category on zone_access_windows
  for each row execute function dyn_sync_window_to_pe();
