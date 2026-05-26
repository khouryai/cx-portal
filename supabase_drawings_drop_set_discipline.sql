-- ============================================================
-- HITACHI Rail T&C Portal — drop drawing_sets.discipline
--
-- Discipline is auto-derived per sheet from the sheet-number
-- prefix (E→Electrical, C→Civil, etc.) and lives on
-- drawing_sheets. The set-level column was unused.
--
-- Paste into: Supabase Dashboard → SQL Editor → Run
-- ============================================================

ALTER TABLE drawing_sets DROP COLUMN IF EXISTS discipline;
