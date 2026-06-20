-- ============================================================
-- HITACHI Rail T&C Portal — Documents Module Schema
-- Paste into: Supabase Dashboard → SQL Editor → Run
--
-- Controlled document library for the field team:
--   · documents          — the logical "document of record" + metadata
--   · document_versions  — every uploaded revision (supersede chain)
--
-- Storage bucket 'documents' must be created manually in the Supabase
-- dashboard under Storage → New bucket. Set it to PRIVATE (not public).
--
-- MIGRATION NOTE (Microsoft / Azure cutover):
--   All app access goes through the DocsAPI seam in app.js. At cutover,
--   these two tables map to SharePoint list columns / Dataverse, and the
--   'documents' storage bucket maps to a SharePoint document library or
--   Azure Blob container. Column names were chosen to map cleanly to
--   SharePoint metadata (Title, Category, DocNumber, Revision, etc).
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT        NOT NULL,
  doc_type            TEXT        NOT NULL DEFAULT 'other',  -- procedure|specification|drawing|permit|report|manual|other
  doc_number          TEXT,                                  -- controlled document number (optional)
  discipline          TEXT,
  location            TEXT,
  subsystem           TEXT,
  tags                TEXT[]      NOT NULL DEFAULT '{}',
  status              TEXT        NOT NULL DEFAULT 'active',  -- active|archived
  current_version_id  UUID,                                  -- FK set after first version insert (see below)
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision      TEXT        NOT NULL DEFAULT 'A',  -- e.g. A, B, 1.0, 2.1
  storage_path  TEXT        NOT NULL,              -- object key inside the 'documents' bucket
  file_name     TEXT,                              -- original filename as uploaded
  file_ext      TEXT,                              -- pdf, docx, xlsx, png ...
  mime_type     TEXT,
  file_size     BIGINT,
  sha256        TEXT,                              -- integrity hash of the uploaded bytes
  change_note   TEXT,                              -- what changed in this revision
  is_current    BOOLEAN     NOT NULL DEFAULT true,
  superseded_at TIMESTAMPTZ,                       -- set when a newer revision replaces this one
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- current_version_id points at the live revision; nullable + deferred-style FK
-- to avoid the chicken/egg insert order (document created before its first version).
ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_current_version_fk;
ALTER TABLE documents
  ADD  CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_document_versions_doc      ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_document_versions_current  ON document_versions(document_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_documents_type             ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_location         ON documents(location);

-- ── Row-Level Security ──────────────────────────────────────
-- Matches the drawings module: any authenticated user can read/write.
-- Field-level role gating (admin + field upload; everyone views) is enforced
-- in the app/UI layer, same convention as the rest of the portal.
ALTER TABLE documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_auth_all ON documents;
CREATE POLICY documents_auth_all ON documents
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS document_versions_auth_all ON document_versions;
CREATE POLICY document_versions_auth_all ON document_versions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Data API grants ─────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE documents, document_versions
  TO authenticated, service_role;

-- ============================================================
-- STORAGE BUCKET — "documents" (private)
-- ============================================================
-- Bucket must be created in the Supabase dashboard UI (Storage → New bucket,
-- name = documents, Public = OFF). Then run these policy statements:

DROP POLICY IF EXISTS "documents bucket read"   ON storage.objects;
DROP POLICY IF EXISTS "documents bucket write"  ON storage.objects;
DROP POLICY IF EXISTS "documents bucket update" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket delete" ON storage.objects;

CREATE POLICY "documents bucket read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents');

CREATE POLICY "documents bucket write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents');

CREATE POLICY "documents bucket update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'documents')
  WITH CHECK (bucket_id = 'documents');

CREATE POLICY "documents bucket delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents');
