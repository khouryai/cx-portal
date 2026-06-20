-- ============================================================
-- HITACHI Rail T&C Portal — Documents Module: FOLDERS add-on
-- Paste into: Supabase Dashboard → SQL Editor → Run
-- (Run AFTER supabase_documents_schema.sql.)
--
-- Adds folder/subfolder organization on top of the metadata model:
--   · document_folders     — self-referencing tree (parent_id)
--   · documents.folder_id  — which folder a document lives in (NULL = root)
--
-- MIGRATION NOTE (Microsoft / Azure cutover): document_folders maps to the
-- SharePoint document-library folder tree; documents.folder_id maps to the
-- item's server-relative folder path. All access is through DocsAPI in app.js.
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

-- ── Row-Level Security ──────────────────────────────────────
ALTER TABLE document_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_folders_auth_all ON document_folders;
CREATE POLICY document_folders_auth_all ON document_folders
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Data API grants ─────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE document_folders TO authenticated, service_role;
