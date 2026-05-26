-- ============================================================================
-- MIGRATION: form_test_item_links — add asset_id for scope-aware form linking
-- ============================================================================
-- Run this once against the existing database. Safe to re-run.
--
-- What this does:
--   • Adds a nullable `asset_id` column to form_test_item_links.
--   • NULL means "parent-scope" — the link covers every child asset of that
--     test case (or, for a non-parent test case, it just means the test case
--     itself; existing rows stay valid).
--   • A non-NULL asset_id means "per-asset" — the link is for that specific
--     child asset of the (parent) test_id.
--   • Drops the old uniqueness on (form_id, test_id) and replaces it with a
--     partial unique index so the same (form_id, test_id) can legitimately
--     have one parent-scope row AND multiple per-asset rows.
-- ============================================================================

alter table if exists form_test_item_links
  add column if not exists asset_id uuid null references assets(id) on delete cascade;

create index if not exists ftil_asset_idx on form_test_item_links (asset_id);

-- Replace the legacy (form_id, test_id) uniqueness with scope-aware variants.
alter table form_test_item_links drop constraint if exists form_test_item_links_form_id_test_id_key;

-- One parent-scope link per (form, test) pair.
create unique index if not exists ftil_unique_parent_scope
  on form_test_item_links (form_id, test_id)
  where asset_id is null;

-- One per-asset link per (form, test, asset) triple.
create unique index if not exists ftil_unique_asset_scope
  on form_test_item_links (form_id, test_id, asset_id)
  where asset_id is not null;
