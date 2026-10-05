-- ============================================================================
-- Child test cases without Asset Management — PART 1 of 2 (additive, 2026-10)
--
-- A parent test case can still carry child test cases, one per device (e.g.
-- "702A" / "702B" under a ZC test). Until now a child's device name lived only
-- in the `assets` table (joined through test_items.asset_id). Asset Management
-- is being removed, so the name moves onto the child row itself:
--
--   test_items.child_label  — the child test case's name (the device)
--
-- Children keep the parent's test_case_code / test_name (the shared weight
-- key); only child_label tells them apart. Existing child ids (`asc-…`) are
-- NOT changed — results, status history and punch links reference them.
--
-- SAFE / NON-DESTRUCTIVE: adds a nullable column and fills it. Both the old and
-- the new app work against the result. Run this BEFORE (or right as) the new
-- front end deploys — until it runs, child test cases show no name and new
-- children cannot be added. Idempotent; safe to re-run, including after
-- PART 2 (supabase_drop_checkpoint_and_assets.sql) has dropped `assets`.
-- ============================================================================

alter table public.test_items add column if not exists child_label text;

comment on column public.test_items.child_label is
  'Name of a child test case (e.g. the device "702A"). Set only on rows with parent_test_id; the row keeps its parent''s test_case_code / test_name.';

-- Backfill from the asset each existing child was linked to. Wrapped so a re-run
-- after PART 2 (assets gone) is a no-op instead of an error.
do $$
begin
  if to_regclass('public.assets') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'test_items' and column_name = 'asset_id') then
    execute $q$
      update public.test_items c
         set child_label = a.name
        from public.assets a
       where c.asset_id = a.id
         and c.parent_test_id is not null
         and coalesce(c.child_label, '') = ''
    $q$;
  end if;
end$$;

-- Check afterwards: children still without a name (their asset was deleted
-- earlier). They render as "—" and can be renamed in Test Register edit mode.
--   select test_id, parent_test_id from public.test_items
--    where parent_test_id is not null and coalesce(child_label, '') = '';

notify pgrst, 'reload schema';
