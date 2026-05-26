-- ============================================================================
-- MIGRATION: p6_learn_patterns — add test-case-level patterns + source tag
-- ============================================================================
-- Run once. Safe to re-run (idempotent).
--
-- Adds:
--   • portal_test_case_code (nullable) — when set, the pattern is keyed to a
--     specific portal test case under a given activity. NULL = activity-level
--     (existing behavior, all current rows stay valid).
--   • source — provenance of the pattern row, used by auto-suggest tie-break:
--     'manual'      → explicit user link in the Mapping tab (default)
--     'bulk_wizard' → seeded by the new Bulk Learn wizard
--     'promote'     → reserved for future "learn from existing links" tool
--
-- The auto-suggest sort order will prefer source='manual' over 'bulk_wizard',
-- so a single human-confirmed pattern always beats a stack of bulk seeds —
-- preventing confidence inflation when seeding many patterns at once.
-- ============================================================================

alter table if exists p6_learn_patterns
  add column if not exists portal_test_case_code text null,
  add column if not exists source text not null default 'manual';

-- Replace any pre-existing (pattern, activity) uniqueness with a TC-aware one.
-- We coalesce NULL TC codes to '' so activity-level rows still get one slot.
drop index if exists p6_learn_patterns_pat_act_idx;
drop index if exists p6_learn_patterns_pattern_activity_key;

create unique index if not exists p6_learn_patterns_pat_act_tc_idx
  on p6_learn_patterns (
    p6_name_pattern,
    portal_activity_name,
    coalesce(portal_test_case_code, '')
  );

create index if not exists p6_learn_patterns_tc_idx
  on p6_learn_patterns (portal_activity_name, portal_test_case_code)
  where portal_test_case_code is not null;
