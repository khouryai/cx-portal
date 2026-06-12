-- ============================================================
-- P5-2 — drop dead tables + lock down dyn_* trigger functions
--
-- Applied live as two migrations on 2026-06-12:
--   p5_2_drop_dead_tables
--   p5_2_revoke_execute_dyn_trigger_fns
-- Owner-approved. Both idempotent / data-loss-free. In-repo record of what ran.
-- ============================================================

-- ── 1. Drop six dead tables ─────────────────────────────────
-- All six: 0 rows, 0 code reads/writes, and the only inbound FKs were internal
-- to the set (deployment_locations, test_instances → deployments). DROP TABLE
-- also clears each table's RLS policies and indexes.
--   punch_history        — punch history is covered by db_change_log
--   punch_photos         — superseded by the `photos` feature (source links)
--   template_test_cases  — templates store test_cases inline as jsonb
--   deployments          — the template→deploy→instance flow only ever ran off
--   deployment_locations    the in-memory data.js demo seed (DATA.deployments);
--   test_instances          never DB-wired
-- (dependents before parent)
drop table if exists deployment_locations;
drop table if exists test_instances;
drop table if exists deployments;
drop table if exists punch_history;
drop table if exists punch_photos;
drop table if exists template_test_cases;

-- ── 2. Revoke EXECUTE on the dyn_* trigger functions ────────
-- These three SECURITY DEFINER functions (Dynamic Testing ⇄ Lookahead sync +
-- auto-roll-forward) are TRIGGER functions — they fire as the table owner, so
-- no caller needs EXECUTE. PostgREST had exposed them as /rpc endpoints to the
-- `authenticated` role (advisor 0029). Same fix as P1-5 for audit_db_change /
-- capture_planning_week: triggers keep firing, RPC surface removed.
revoke execute on function public.dyn_roll_forward_on_cancel() from anon, authenticated, public;
revoke execute on function public.dyn_sync_pe_to_window()       from anon, authenticated, public;
revoke execute on function public.dyn_sync_window_to_pe()       from anon, authenticated, public;
