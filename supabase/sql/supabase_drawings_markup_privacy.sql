-- ============================================================
-- HITACHI Rail T&C Portal — Drawings markup privacy
-- Paste into: Supabase Dashboard → SQL Editor → Run
--
-- Makes DRAFT markups private to their creator while keeping
-- PUBLISHED markups visible to the whole team.
--
-- Before this migration, drawing_markups used a single
-- `USING (true)` policy, so every client downloaded every
-- other user's unpublished drafts. This replaces the read
-- policy so that a row is only SELECT-able when:
--   • it is published, OR
--   • the requester created it, OR
--   • the requester is an admin (needed for the in-app
--     "Manage markups" admin tool).
--
-- Writes stay permissive so existing rows (including any that
-- were saved before created_by was populated) remain editable
-- and nothing regresses. Draft privacy is a read-side concern.
-- ============================================================

ALTER TABLE drawing_markups ENABLE ROW LEVEL SECURITY;

-- Drop the old catch-all policy (published + drafts visible to all).
DROP POLICY IF EXISTS drawing_markups_auth_all   ON drawing_markups;
DROP POLICY IF EXISTS drawing_markups_select     ON drawing_markups;
DROP POLICY IF EXISTS drawing_markups_insert     ON drawing_markups;
DROP POLICY IF EXISTS drawing_markups_update     ON drawing_markups;
DROP POLICY IF EXISTS drawing_markups_delete     ON drawing_markups;

-- READ: published to everyone; drafts only to their creator (or admins).
CREATE POLICY drawing_markups_select ON drawing_markups
  FOR SELECT TO authenticated
  USING (
    is_published
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- WRITE: unchanged behaviour (app layer enforces the drawings permissions).
CREATE POLICY drawing_markups_insert ON drawing_markups
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY drawing_markups_update ON drawing_markups
  FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY drawing_markups_delete ON drawing_markups
  FOR DELETE TO authenticated
  USING (true);
