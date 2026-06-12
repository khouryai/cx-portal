-- ============================================================================
-- Lookahead activity status — manual override + free-text reason.
-- ----------------------------------------------------------------------------
-- Applied to production via MCP migration `planning_activities_add_status_override`.
--
-- Before this, the Lookahead row status ("On track / Blocked / …") was derived
-- ONLY from the shift schedule, where the only non-trivial signal was a
-- cancelled shift -> "Blocked" (misleading). Test Register / P6 links can't
-- drive it because other teams don't use those.
--
-- These columns let ANY team set the status explicitly with an optional reason.
-- When status_override is NULL the app auto-derives status from the schedule
-- (no shifts = Planned; all shifts past = Complete; a cancellation = At risk;
-- otherwise On track).
-- ============================================================================

alter table planning_activities
  add column if not exists status_override text
    check (status_override is null or status_override in ('ontrack','atrisk','blocked','done','plan')),
  add column if not exists status_note text,
  add column if not exists status_set_by text,
  add column if not exists status_set_at timestamptz;

comment on column planning_activities.status_override is 'Team-set activity status (ontrack/atrisk/blocked/done/plan). NULL = auto-derive from the shift schedule. Works for any team regardless of Test Register / P6 links.';
comment on column planning_activities.status_note is 'Free-text reason for the status, e.g. why At risk / Blocked.';
