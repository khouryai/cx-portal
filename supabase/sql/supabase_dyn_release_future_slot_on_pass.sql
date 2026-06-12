-- ============================================================
-- Release a future schedule slot when a run is marked Pass
--
-- A completed (Pass) dynamic_instance doesn't need its UPCOMING shift, so free
-- the slot for other runs. Past/today slots are kept as the record of where it
-- ran. BEFORE-UPDATE trigger so it fires no matter which surface set the status.
-- The Dynamic Testing instances list shows a "✓ Passed" tag in the scheduled
-- column for these runs (client-side).
--
-- Applied live as migrations: dyn_release_future_slot_on_pass +
-- dyn_release_future_slot_pin_search_path. Idempotent.
-- ============================================================
create or replace function dyn_release_future_slot_on_pass()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'Pass'
     and new.scheduled_for_date is not null
     and new.scheduled_for_date > current_date then
    new.shift_id := null;
    new.scheduled_for_date := null;
    new.scheduled_window := null;
  end if;
  return new;
end; $$;

drop trigger if exists trg_dyn_release_future_slot on dynamic_instances;
create trigger trg_dyn_release_future_slot
  before update of status on dynamic_instances
  for each row execute function dyn_release_future_slot_on_pass();
