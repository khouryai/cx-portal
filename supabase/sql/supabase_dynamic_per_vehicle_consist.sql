-- ============================================================
-- HITACHI Rail T&C Portal — Per-vehicle consist sizes (dynamic testing)
-- Paste into: Supabase Dashboard → SQL Editor → Run
--
-- Gives access campaigns and their generated shifts a per-train consist
-- multiset, so the scheduler can require an EXACT consist match between a
-- test instance and the campaign/shift it is scheduled onto ("Any" on the
-- instance side stays a wildcard). Instances already carry
-- required_consists.sizes; these two columns are the campaign/shift side.
--
-- Shape: { "sizes": [4, 10, ...] } — one car-count per requested/available
-- train; a null entry means that train's size is unspecified ("Any").
-- The legacy single columns are kept in sync by the app for back-compat:
--   count        = sizes.length   (trains_requested / max_trains)
--   consist_size = first non-null size
-- ============================================================

ALTER TABLE access_campaigns
  ADD COLUMN IF NOT EXISTS required_consists jsonb;

ALTER TABLE zone_access_windows
  ADD COLUMN IF NOT EXISTS available_consists jsonb;

-- Backfill existing rows from the single-value columns (repeat the one consist
-- across the train count) so matching has data to work with immediately.
UPDATE access_campaigns
   SET required_consists = jsonb_build_object(
     'sizes',
     to_jsonb(array_fill(consist_size, ARRAY[GREATEST(COALESCE(trains_requested, 1), 1)]))
   )
 WHERE required_consists IS NULL
   AND consist_size IS NOT NULL;

UPDATE zone_access_windows
   SET available_consists = jsonb_build_object(
     'sizes',
     to_jsonb(array_fill(consist_size, ARRAY[GREATEST(COALESCE(max_trains, 1), 1)]))
   )
 WHERE available_consists IS NULL
   AND consist_size IS NOT NULL;
