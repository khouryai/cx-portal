-- ============================================================
-- Optimistic-concurrency support (Tier 1 #4) — 2026-07
-- ============================================================
-- The app's _dbUpdate({ expect: { updated_at } }) guard (app.js) folds the
-- expected updated_at into the PATCH's WHERE clause so a row changed by
-- someone else since it was read matches zero rows and surfaces a CONFLICT
-- instead of a silent last-write-wins overwrite.
--
-- That guard is only meaningful if updated_at ACTUALLY changes on every UPDATE.
-- The base schema only set updated_at via `default now()` (insert-time only),
-- and delay_log had no updated_at column at all. This migration:
--   1. adds delay_log.updated_at,
--   2. installs a shared BEFORE UPDATE trigger that stamps updated_at = now()
--      on the hot, human-edited single-row tables (delay_log, punch_items).
--
-- Backward-compatible: writers that don't pass the { expect } guard are
-- unaffected — they simply get an accurate updated_at. SECURITY INVOKER with a
-- pinned empty search_path so it does not trip the mutable-search_path advisor.
--
-- Applied to project uqtwiucxktljhukmgmxg via MCP apply_migration
-- (name: optimistic_concurrency_updated_at_triggers).
-- ============================================================

alter table public.delay_log add column if not exists updated_at timestamptz default now();

create or replace function public.cx_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_delay_log on public.delay_log;
create trigger set_updated_at_delay_log
before update on public.delay_log
for each row execute function public.cx_set_updated_at();

drop trigger if exists set_updated_at_punch_items on public.punch_items;
create trigger set_updated_at_punch_items
before update on public.punch_items
for each row execute function public.cx_set_updated_at();

-- To extend the guard to another table later: add its updated_at column (if
-- missing) and attach the same trigger:
--   create trigger set_updated_at_<tbl> before update on public.<tbl>
--   for each row execute function public.cx_set_updated_at();
