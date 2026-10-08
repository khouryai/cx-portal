-- ============================================================================
-- Remove scheduled jobs (pg_cron) — Azure migration simplification, 2026-10.
-- ----------------------------------------------------------------------------
-- The app needs no scheduled jobs, so the Azure database needs no pg_cron.
--   * capture-planning-week: already removed with the lookahead module
--     (supabase_drop_lookahead.sql).
--   * purge-auth-events: deleted auth_events rows older than 400 days. Removed:
--     the table grows by a few rows per permission change, and keeping audit
--     history longer is the safer default. If a retention rule is ever set,
--     run a delete by hand or schedule one then.
-- Reverse: re-run the pg_cron block in supabase_auth_hardening.sql.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cmd$ select cron.unschedule(jobid) from cron.job
                   where jobname = 'purge-auth-events' $cmd$;
  end if;
end $$;

drop function if exists public.purge_auth_events();

-- Nothing else is scheduled; the extension itself can go.
drop extension if exists pg_cron;
