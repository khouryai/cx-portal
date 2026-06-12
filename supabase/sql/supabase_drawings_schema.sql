-- ============================================================
-- HITACHI Rail T&C Portal — Drawings Module Schema
-- Paste into: Supabase Dashboard → SQL Editor → Run
--
-- NOTE: The storage bucket 'drawings' must be created manually
-- in the Supabase dashboard under Storage → New bucket.
-- Set it to private (not public).
-- ============================================================

-- Note: discipline is derived per sheet from the sheet-number prefix,
-- so it lives on drawing_sheets only — not on the set.
CREATE TABLE IF NOT EXISTS drawing_sets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT        NOT NULL,
  location      TEXT        NOT NULL,
  subsystem     TEXT,
  import_date   DATE,
  revision_date DATE,
  release_date  DATE,
  storage_path  TEXT,
  uploaded_by   TEXT,
  status        TEXT        NOT NULL DEFAULT 'processing',
  total_sheets  INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drawing_sheets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id       UUID        NOT NULL REFERENCES drawing_sets(id) ON DELETE CASCADE,
  location     TEXT        NOT NULL,
  page_index   INT         NOT NULL,            -- physical PDF page (0-based)
  sheet_number TEXT,                              -- e.g. E11004-W30
  page_number  TEXT,                              -- title-block PAGE NO. (e.g. 004)
  sheet_title  TEXT,
  discipline   TEXT,
  revision     TEXT,
  is_current   BOOLEAN     NOT NULL DEFAULT true,
  confirmed    BOOLEAN     NOT NULL DEFAULT false,
  needs_review BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drawing_markups (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id     UUID        NOT NULL REFERENCES drawing_sheets(id) ON DELETE CASCADE,
  created_by   UUID        REFERENCES profiles(id),
  creator_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  markup_data  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_published BOOLEAN     NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  published_by UUID        REFERENCES profiles(id)
);

-- ── Row-Level Security ──────────────────────────────────────
ALTER TABLE drawing_sets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawing_sheets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawing_markups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drawing_sets_auth_all    ON drawing_sets;
CREATE POLICY drawing_sets_auth_all ON drawing_sets
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS drawing_sheets_auth_all  ON drawing_sheets;
CREATE POLICY drawing_sheets_auth_all ON drawing_sheets
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS drawing_markups_auth_all ON drawing_markups;
CREATE POLICY drawing_markups_auth_all ON drawing_markups
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Data API grants ─────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE drawing_sets, drawing_sheets, drawing_markups
  TO authenticated, service_role;

-- ============================================================
-- STORAGE BUCKET — "drawings" (private)
-- ============================================================
-- Bucket must be created in the Supabase dashboard UI.
-- Then run these policy statements:

DROP POLICY IF EXISTS "drawings bucket read"   ON storage.objects;
DROP POLICY IF EXISTS "drawings bucket write"  ON storage.objects;
DROP POLICY IF EXISTS "drawings bucket update" ON storage.objects;
DROP POLICY IF EXISTS "drawings bucket delete" ON storage.objects;

CREATE POLICY "drawings bucket read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'drawings');

CREATE POLICY "drawings bucket write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'drawings');

CREATE POLICY "drawings bucket update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'drawings')
  WITH CHECK (bucket_id = 'drawings');

CREATE POLICY "drawings bucket delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'drawings');
