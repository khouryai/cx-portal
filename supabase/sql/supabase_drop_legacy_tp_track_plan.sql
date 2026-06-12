-- ============================================================
-- HITACHI Rail T&C Portal — Drop legacy tp_* track plan schema
--
-- Removes the sandbox / corridor track plan tables introduced
-- on 2026-05-19:
--   • track_plan_sandbox_schema      (20260519020807)
--   • track_plan_sandbox_seed        (20260519020838)
--   • track_plan_corridor_import     (20260519024404)
--
-- These have been superseded by the track_* / train_* / dynamic_*
-- schema in supabase_dynamic_testing_schema.sql. All Visio→Excel
-- ingestion now lives in track_devices / track_zones /
-- track_mileposts / track_sections / etc., authored by
-- sync_track_plan.js and track_plan_importer.html.
--
-- CASCADE so any dependent views / FKs come down with them.
-- Re-enables RLS on the newer track_* tables that had it
-- inadvertently disabled.
-- ============================================================

drop table if exists public.tp_route_segments    cascade;
drop table if exists public.tp_routes            cascade;
drop table if exists public.tp_corridor_assets   cascade;
drop table if exists public.tp_corridor_tracks   cascade;
drop table if exists public.tp_corridor_meta     cascade;
drop table if exists public.tp_platforms         cascade;
drop table if exists public.tp_track_circuits    cascade;
drop table if exists public.tp_switches          cascade;
drop table if exists public.tp_signals           cascade;
drop table if exists public.tp_segments          cascade;
drop table if exists public.tp_nodes             cascade;

alter table public.track_plan_imports       enable row level security;
alter table public.track_zones              enable row level security;
alter table public.train_control_locations  enable row level security;
alter table public.track_sections           enable row level security;

notify pgrst, 'reload schema';
