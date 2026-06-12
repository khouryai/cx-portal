-- ============================================================
-- HITACHI Rail T&C Portal — add drawing_sheets.page_number
--
-- Title blocks expose two distinct identifiers:
--   sheet_number  — CONTRACT SHEET NO. (e.g. E11004-W30)
--   page_number   — PAGE NO.           (e.g. 004)
-- We now capture both. page_number is nullable for back-compat.
--
-- Paste into: Supabase Dashboard → SQL Editor → Run
-- ============================================================

ALTER TABLE drawing_sheets
  ADD COLUMN IF NOT EXISTS page_number TEXT;
