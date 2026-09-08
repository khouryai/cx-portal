-- ============================================================================
-- Pre-delete snapshot of the "STANDARD TEST COMPLETION REPORT" placeholder rows
--
-- In-repo record of applied migration (project uqtwiucxktljhukmgmxg):
--   archive_standard_completion_report_cases   — applied 2026-09-08
--
-- Taken immediately before supabase_remove_standard_completion_report_cases.sql
-- deleted those 104 rows from public.test_items, so the cleanup is reversible.
-- Lives in the private schema: not exposed through PostgREST, so it adds no RLS
-- surface and the app cannot see it.
--
-- Restore everything:
--   insert into public.test_items select * from private.archive_stcr_2026_09;
-- Drop it once the removal is confirmed good:
--   drop table private.archive_stcr_2026_09;
-- ============================================================================

create table if not exists private.archive_stcr_2026_09 as
select * from public.test_items
where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
      like 'STANDARD TEST COMPLETION REPORT%';

comment on table private.archive_stcr_2026_09 is
  'Pre-delete snapshot (2026-09-08) of the STANDARD TEST COMPLETION REPORT placeholder test cases removed from public.test_items. Restore: insert into public.test_items select * from private.archive_stcr_2026_09;';
