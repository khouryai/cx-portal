-- ============================================================================
-- Remove the P6 Schedule integration and the Organization (org chart) page
-- (owner-directed, 2026-10).
--
-- Both features are gone from the app (commits "Remove the Organization (org
-- chart) page" and "Remove the P6 schedule integration"). Nothing in the portal
-- reads or writes these objects any more; this drops what backed them.
--
--   * team_members                          — the org chart
--   * p6_import_batches, p6_activities,
--     p6_activity_map, p6_learn_patterns,
--     p6_activity_dismissals                — the P6 schedule tool
--   * test_items.p6_*_date columns          — P6 dates fed by sync_testplan.js
--   * perm_modules 'schedule_p6' row        — its template/override grants
--                                             cascade (see PERMISSIONS_MODEL.md)
--   * capability keys directory.manage_org_chart and
--     test_register.manage_p6_links
--
-- DATA LOSS: every row in the tables above and the four test_items date
-- columns. Export anything you still want BEFORE running this.
-- Runs in one transaction; idempotent, safe to re-run.
-- ============================================================================

begin;

-- ── 1. Tables (RLS policies, indexes and FKs between them drop with them) ──
drop table if exists public.p6_activity_map        cascade;
drop table if exists public.p6_activity_dismissals cascade;
drop table if exists public.p6_learn_patterns      cascade;
drop table if exists public.p6_activities          cascade;
drop table if exists public.p6_import_batches      cascade;
drop table if exists public.team_members           cascade;

-- ── 2. P6 date columns on test_items ───────────────────────────────────────
-- No cascade on purpose: if a view still depends on one of these, fail loudly
-- rather than silently dropping the view.
alter table public.test_items
  drop column if exists p6_start_date,
  drop column if exists p6_finish_date,
  drop column if exists p6_start_date_current,
  drop column if exists p6_finish_date_current;

-- ── 3. Permission catalog ──────────────────────────────────────────────────
delete from public.perm_modules where key = 'schedule_p6';

update public.perm_modules
   set actions     = array_remove(actions, 'manage_org_chart'),
       action_meta = action_meta - 'manage_org_chart'
 where key = 'directory';

update public.perm_modules
   set actions     = array_remove(actions, 'manage_p6_links'),
       action_meta = action_meta - 'manage_p6_links'
 where key = 'test_register';

commit;

notify pgrst, 'reload schema';
