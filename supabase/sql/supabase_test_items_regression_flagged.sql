-- ============================================================
-- test_items.regression_flagged — per-test-case regression opt-in
--
-- Regression availability rule (owner-approved):
--   • A FAILED completed test always offers the "⟳ Regression" button
--     (a failure inherently invites a retest).
--   • Any OTHER completed test (Pass / Blocked / Complete) offers the
--     button ONLY once an admin/engineer flags that specific test case
--     for regression — i.e. a new software release or an updated test
--     procedure means a previously-passing test must be re-run.
--
-- The flag lives at the individual test-case row level inside a test
-- activity (no global/activity-level switch), and is toggled from the
-- Test Register via toggleRegressionFlag() in app.js.
--
-- Applied live as migration: test_items_add_regression_flagged. Idempotent.
-- Updates are gated by the existing test_items RLS
-- (has_module_perm('test_register','edit')); no policy change needed for
-- an additive column.
-- ============================================================
alter table test_items add column if not exists regression_flagged boolean not null default false;

comment on column test_items.regression_flagged is
  'Per-test-case opt-in for regression on a non-failed completed test. Failed tests always offer the regression button; Pass/Blocked/Complete tests offer it only when this flag is true (set by an admin/engineer after a new software release or updated test procedure warrants re-running a previously passing test).';
