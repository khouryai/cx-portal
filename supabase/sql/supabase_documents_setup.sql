-- ============================================================
-- HITACHI Rail T&C Portal — Documents Module: ONE-SHOT SETUP
-- Paste into: Supabase Dashboard → SQL Editor → Run   (safe to re-run)
--
-- Symptom this fixes: opening Documents shows
--   "Failed to load: documents, document_versions, document_folders"
-- because the tables were never created (PostgREST PGRST205).
--
-- This script = supabase_documents_schema.sql + supabase_documents_folders.sql
-- + creation of the private 'documents' storage bucket (so no manual
-- dashboard step is needed), then reloads the PostgREST schema cache.
-- ============================================================

-- ── Storage bucket "documents" (private) ────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

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
-- Same permission model as the Drawings module (the Documents page is gated
-- by the 'drawings' permission module in PAGE_MODULE): reading needs
-- drawings.view; adding / editing / archiving / deleting needs drawings.edit
-- (standard level — admins and field engineers, matching _docsCanManage()).
ALTER TABLE documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_auth_all ON documents;
DROP POLICY IF EXISTS documents_sel ON documents;
DROP POLICY IF EXISTS documents_ins ON documents;
DROP POLICY IF EXISTS documents_upd ON documents;
DROP POLICY IF EXISTS documents_del ON documents;
CREATE POLICY documents_sel ON documents FOR SELECT TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'view')));
CREATE POLICY documents_ins ON documents FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_module_perm('drawings', 'edit')));
CREATE POLICY documents_upd ON documents FOR UPDATE TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'edit')))
  WITH CHECK ((SELECT private.has_module_perm('drawings', 'edit')));
CREATE POLICY documents_del ON documents FOR DELETE TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'edit')));

DROP POLICY IF EXISTS document_versions_auth_all ON document_versions;
DROP POLICY IF EXISTS document_versions_sel ON document_versions;
DROP POLICY IF EXISTS document_versions_ins ON document_versions;
DROP POLICY IF EXISTS document_versions_upd ON document_versions;
DROP POLICY IF EXISTS document_versions_del ON document_versions;
CREATE POLICY document_versions_sel ON document_versions FOR SELECT TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'view')));
CREATE POLICY document_versions_ins ON document_versions FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_module_perm('drawings', 'edit')));
CREATE POLICY document_versions_upd ON document_versions FOR UPDATE TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'edit')))
  WITH CHECK ((SELECT private.has_module_perm('drawings', 'edit')));
CREATE POLICY document_versions_del ON document_versions FOR DELETE TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'edit')));

-- ── Data API grants ─────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE documents, document_versions
  TO authenticated, service_role;

-- ============================================================
-- STORAGE BUCKET — "documents" (private)
-- ============================================================
-- (The bucket itself is created at the top of this script.)

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

-- ============================================================
-- FOLDERS add-on
-- ============================================================
CREATE TABLE IF NOT EXISTS document_folders (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  parent_id   UUID        REFERENCES document_folders(id) ON DELETE SET NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_folders_parent ON document_folders(parent_id);

-- Each document optionally lives in a folder. Deleting a folder in the app
-- re-parents its contents first, so ON DELETE SET NULL is just a safety net.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES document_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);

-- ── Row-Level Security (same model as documents above) ─────
ALTER TABLE document_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_folders_auth_all ON document_folders;
DROP POLICY IF EXISTS document_folders_sel ON document_folders;
DROP POLICY IF EXISTS document_folders_ins ON document_folders;
DROP POLICY IF EXISTS document_folders_upd ON document_folders;
DROP POLICY IF EXISTS document_folders_del ON document_folders;
CREATE POLICY document_folders_sel ON document_folders FOR SELECT TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'view')));
CREATE POLICY document_folders_ins ON document_folders FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_module_perm('drawings', 'edit')));
CREATE POLICY document_folders_upd ON document_folders FOR UPDATE TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'edit')))
  WITH CHECK ((SELECT private.has_module_perm('drawings', 'edit')));
CREATE POLICY document_folders_del ON document_folders FOR DELETE TO authenticated
  USING ((SELECT private.has_module_perm('drawings', 'edit')));

-- ── Data API grants ─────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE document_folders TO authenticated, service_role;

-- Make the new tables visible to the Data API immediately.
NOTIFY pgrst, 'reload schema';
