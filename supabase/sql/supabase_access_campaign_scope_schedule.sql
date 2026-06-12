-- ============================================================
-- Access campaign: test-case scope + per-day-of-week access times
--
-- • test_case_ids — the dynamic test_ids a campaign covers. Empty = all
--   in-zone dynamic instances (back-compat). Scopes the progress rollup and
--   the auto-allocation pool so a campaign only reflects the tests chosen for
--   it, not every instance in the zone.
-- • day_schedule — per-day-of-week window times so access can differ by day:
--   { "<dow 0-6>": {"start":"HH:MM","end":"HH:MM"} }. A missing day falls back
--   to shift_start/shift_end.
--
-- Applied live as migration: access_campaign_scope_and_per_day_schedule.
-- Idempotent.
-- ============================================================

alter table access_campaigns
  add column if not exists test_case_ids text[] not null default '{}',
  add column if not exists day_schedule  jsonb  not null default '{}'::jsonb;

comment on column access_campaigns.test_case_ids is
  'Dynamic test_ids this campaign covers (scope). Empty = all in-zone dynamic instances. Drives progress rollup and auto-allocation pool.';
comment on column access_campaigns.day_schedule is
  'Per-day-of-week access window times: { "<dow 0-6>": {"start":"HH:MM","end":"HH:MM"} }. Empty / missing day falls back to shift_start/shift_end.';
