-- ============================================================
-- HITACHI Rail T&C Portal — Drawings markup privacy
-- Paste into: Supabase Dashboard → SQL Editor → Run
--
-- Makes DRAFT markups private to their creator while keeping
-- PUBLISHED markups visible to the whole team.
--
-- The drawing_markups table uses the granular-permission RLS
-- model (private.has_module_perm(module, action)). Its SELECT
-- policy previously let ANY user with 'drawings.view' read every
-- row — including other users' unpublished drafts. This narrows
-- the read policy so a row is only visible when the requester
-- has drawings.view AND one of:
--   • the markup is published, OR
--   • the requester created it, OR
--   • the requester has 'manage_markup_any' (the admin markup
--     tool relies on seeing everyone's markups).
--
-- INSERT / UPDATE / DELETE policies are intentionally left
-- unchanged — they already enforce the drawings permissions.
-- ============================================================

ALTER TABLE drawing_markups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drawing_markups_sel ON drawing_markups;

CREATE POLICY drawing_markups_sel ON drawing_markups
  FOR SELECT TO authenticated
  USING (
    (SELECT private.has_module_perm('drawings'::text, 'view'::text))
    AND (
      is_published
      OR created_by = auth.uid()
      OR (SELECT private.has_module_perm('drawings'::text, 'manage_markup_any'::text))
    )
  );
