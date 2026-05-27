-- ============================================================
-- HITACHI Rail T&C Portal — Lookahead Combined view migration
--
-- Adds the columns that back the redesigned Master Schedule
-- (Discipline → Phase → Location swimlane):
--   planning_activities.discipline   (text, nullable)
--   planning_activities.trade        (text, nullable)
--   locations.phase                  (text, nullable)
--
-- `phase` already exists on planning_activities. The new
-- `locations.phase` lets activities inherit phase from their
-- location without a hard FK, so location hierarchies that
-- drill into Tracks / Mileposts still group correctly.
--
-- Paste into: Supabase Dashboard → SQL Editor → Run.
-- Idempotent; safe to re-run.
-- ============================================================

alter table if exists public.planning_activities
  add column if not exists discipline text;

alter table if exists public.planning_activities
  add column if not exists trade text;

alter table if exists public.locations
  add column if not exists phase text;

create index if not exists planning_activities_discipline_idx
  on public.planning_activities (discipline);

create index if not exists planning_activities_trade_idx
  on public.planning_activities (trade);

create index if not exists locations_phase_idx
  on public.locations (phase);

notify pgrst, 'reload schema';
