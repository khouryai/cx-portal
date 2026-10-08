-- ============================================================================
-- Cleanup before the Azure move — objects nothing uses any more (2026-10).
-- ----------------------------------------------------------------------------
-- Found by the pre-migration sweep: every table, view and function compared
-- against what the app and the database itself actually use. Only objects with
-- NO reference from the app, from another table (foreign key), from a view or
-- from a trigger are dropped here. Run once in the Supabase SQL editor, BEFORE
-- the backup for Azure is taken, so none of it is carried over.
--
-- Pair with the app change in the same commit: the Meetings module leaves the
-- permissions catalog (perms-admin.js PERM_CATALOG, tools/test_ui_can.js).
--
-- NOT dropped here, deliberately (see the sweep notes in MIGRATION.md):
--   test_procedures        still linked from test_items and two report views
--   demo_seed_log, fn_clear_dynamic_sim_demo   used by the demo seed/teardown scripts
--   access_review_log / access_review_due      the periodic access-review control
--   auth_login_gate, auth_record_event, password_/mfa_verification_attempt
--                          in use while sign-in is Supabase; obsolete under Entra
-- ============================================================================

begin;

-- 1. Meetings module — removed from the app; 8 tables, 7 rows.
--    Its permission entries go too, or the Permissions screen keeps offering a
--    module that no longer exists.
delete from public.user_module_overrides where module_key = 'meetings';
delete from public.template_module_perms where module_key = 'meetings';
delete from public.perm_modules          where key        = 'meetings';
drop table if exists
  public.meeting_action_items,
  public.meeting_attendees,
  public.meeting_items,
  public.meeting_categories,
  public.meeting_template_items,
  public.meeting_template_categories,
  public.meetings,
  public.meeting_templates
  cascade;

-- 2. public.users — the pre-`profiles` people table. 6 rows, none matching a
--    real profile; nothing reads or writes it.
drop table if exists public.users;

-- 3. Trigger functions left behind by removed modules (no trigger uses them).
drop function if exists public.planning_touch_updated_at();
drop function if exists public.shift_templates_touch_updated();
drop function if exists public.team_members_touch_updated_at();

-- 4. Change-log rows about tables that no longer exist (tasks, readiness, …).
delete from public.db_change_log
where table_name in (select distinct l.table_name from public.db_change_log l
                     where to_regclass('public.' || quote_ident(l.table_name)) is null);

commit;

-- 5. The scheduler leftovers (job already off): see supabase_drop_pg_cron.sql.
