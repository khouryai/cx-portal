-- ============================================================================
-- Remove the Lookahead / Planning module in full (owner-directed, 2026-09).
--
-- The Lookahead page, its Admin Planning page, the Excel importer, the resource
-- roster, PTO, the conflicts engine and the weekly snapshot log are all gone
-- from the app. This migration removes what backed them.
--
-- ALSO REMOVED — the Dynamic Testing <-> Lookahead shared-record bridge. Until
-- now a dynamic-testing access campaign WAS a Lookahead activity row and each
-- zone_access_window WAS a planning_event cell, kept in step by four trigger
-- pairs. The owner does not want that relationship, so the triggers go and
-- Dynamic Testing keeps its own tables only:
--   access_campaigns, zone_access_windows, dynamic_instances, train_requests,
--   zone_adjacency — none of which are touched here.
--
-- dyn_roll_forward_on_cancel (auto-roll-forward when a window is cancelled) is
-- KEPT: it moves dynamic_instances between zone_access_windows and never reads
-- or writes a planning_* table.
--
-- delay_log is KEPT — it belongs to the Daily Log / Field Productivity feature.
-- The Lookahead only read it for the Delays & Cancellations report.
--
-- DATA LOSS: this drops the planning tables and their rows, including the
-- frozen planning_week_snapshots audit log. Export anything you still need
-- BEFORE running this. Idempotent; safe to re-run.
-- ============================================================================

-- ── 1. Dynamic Testing <-> Lookahead sync triggers ──────────────────────────
-- Occupancy sync: minted/removed a Lookahead cell as tests were (un)scheduled
-- onto an access window (supabase_dyn_lookahead_occupancy_sync.sql).
drop trigger if exists trg_dyn_instance_cell on public.dynamic_instances;
drop function if exists public.dyn_instance_cell_trigger();
drop function if exists public.dyn_sync_cell_occupancy(uuid);

-- Bidirectional cancellation / delay mirror
-- (supabase_dyn_lookahead_cancellation_sync.sql). Both triggers must go before
-- their functions — the planning_events one still depends on dyn_sync_pe_to_window
-- at this point, since that table is only dropped in step 3.
drop trigger if exists trg_dyn_sync_pe_to_window on public.planning_events;
drop trigger if exists trg_dyn_sync_window_to_pe on public.zone_access_windows;
drop function if exists public.dyn_sync_pe_to_window();
drop function if exists public.dyn_sync_window_to_pe();

-- ── 2. The weekly snapshot cron job + its capture function ──────────────────
-- The cron.job reference lives inside EXECUTE: plpgsql plans a static query even
-- on a branch it never takes, so a direct reference would fail wherever pg_cron
-- is not installed. Unscheduling by jobid is a no-op when the job is not there.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cmd$ select cron.unschedule(jobid) from cron.job
                   where jobname = 'capture-planning-week' $cmd$;
  end if;
end $$;
drop function if exists public.capture_planning_week(date);

-- ── 3. The planning tables (dependents before parents) ──────────────────────
-- CASCADE also clears each table's RLS policies, indexes and constraints, and
-- removes planning_activities.access_campaign_id / planning_events.dynamic_shift_id
-- (the shared-record FKs into access_campaigns / zone_access_windows).
drop table if exists
  public.planning_event_resources,
  public.planning_activity_resources,
  public.planning_conflicts,
  public.planning_events,
  public.planning_activities,
  public.planning_import_batches,
  public.planning_week_snapshots,
  public.planning_resources,
  public.pto_requests,
  public.shift_templates
cascade;

-- ── 4. The permission modules ───────────────────────────────────────────────
-- 'lookahead' governed the board; 'planning' governed the roster, PTO, conflicts
-- and shift_templates. Both are now empty. Template/override grant rows for them
-- cascade from perm_modules (see PERMISSIONS_MODEL.md).
delete from public.perm_modules where key in ('lookahead', 'planning');

-- ── 5. Field-settings vocabularies ──────────────────────────────────────────
-- cancel_category, lookahead_discipline and lookahead_trade were Lookahead-only.
-- lookahead_phase is deliberately KEPT: Checkpoint / Activity Readiness reads it
-- via _fsOptions('lookahead_phase'), and renaming the key would orphan the
-- options already saved against it.
delete from public.fieldset_config
 where field_key in ('cancel_category', 'lookahead_discipline', 'lookahead_trade');

notify pgrst, 'reload schema';
