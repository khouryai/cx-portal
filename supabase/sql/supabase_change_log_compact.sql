-- ============================================================================
-- One-time: shrink the existing change log (2026-10).
-- ----------------------------------------------------------------------------
-- Brings the rows written before change_log_trigger.sql into the same shape:
--   * UPDATE rows keep only the changed columns plus the identifying ones;
--   * UPDATE rows where nothing but updated_at changed are removed — they
--     record no change;
--   * INSERT and DELETE rows are untouched.
-- No information about WHAT changed, WHO changed it or WHEN is lost.
--
-- Run once on Supabase, after change_log_trigger.sql and before the backup for
-- Azure. Idempotent: a second run changes nothing. Applied to the live project
-- on 2026-10-08.
--
-- Safe to paste into the Supabase SQL editor as a whole: the editor already
-- runs a script as one transaction, so it holds no BEGIN/COMMIT and no VACUUM
-- (which cannot run inside one). Optionally afterwards, ON ITS OWN:
--     vacuum full public.db_change_log;
-- ============================================================================

delete from public.db_change_log
where operation = 'UPDATE'
  and (changed_columns is null or changed_columns <@ array['updated_at']);

update public.db_change_log l
set old_row = s.old_keep, new_row = s.new_keep
from (
  select l2.id,
         jsonb_object_agg(k, l2.old_row -> k) as old_keep,
         jsonb_object_agg(k, l2.new_row -> k) as new_keep
  from public.db_change_log l2,
       lateral (select distinct unnest(l2.changed_columns || array[
                  'id', 'test_id', 'test_case_code', 'test_name', 'title', 'name',
                  'phase', 'location', 'subsystem', 'activity',
                  'status', 'failed_reason', 'blocked_reason']) as k) keys
  where l2.operation = 'UPDATE' and l2.new_row ? k
  group by l2.id
) s
where l.id = s.id
  and (select count(*) from jsonb_object_keys(l.new_row)) > (select count(*) from jsonb_object_keys(s.new_keep));
