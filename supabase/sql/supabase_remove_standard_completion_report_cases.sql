-- ============================================================================
-- DATA CLEANUP — remove the "STANDARD TEST COMPLETION REPORT -xx" test cases
-- ----------------------------------------------------------------------------
-- These rows are report placeholders that rode in with the test-plan import and
-- sit inside the IXL activities as if they were executable test cases. They
-- inflate every activity's item count and completion %, so they come out of
-- public.test_items entirely.
--
-- HOW TO RUN (Supabase → SQL Editor, project uqtwiucxktljhukmgmxg):
--   1. Run STEP 1 on its own and read the output. Nothing is modified.
--      Confirm the names, the count, and that the subsystem breakdown is only
--      what you expect (IXL). If anything looks wrong, STOP — do not run STEP 2.
--   2. Run STEP 2 as a single block. It ends in `rollback`, so the first run is
--      a dry run: check the verification row, then switch the last line to
--      `commit;` and run it again to make it stick.
--
-- THE MATCH (identical everywhere below — keep them in sync if you edit it):
--   trimmed, whitespace-collapsed, case-insensitive prefix match on test_name:
--     'STANDARD TEST COMPLETION REPORT%'
--   so "Standard  Test Completion Report -01", " -02", "-A1" all match, while a
--   real test case that merely mentions the phrase mid-name does not.
--
-- WHAT ELSE MOVES:
--   • Child asset rows (parent_test_id → a matched row) go with their parent.
--   • form_test_item_links, dynamic_instances and dynamic_test_filters cascade
--     (on delete cascade) — no separate statement needed.
--   • test_item_status_history and test_results keep their rows with test_id
--     set to null (on delete set null) — the audit trail survives, which is
--     what the app's own _trDeleteCase leaves behind too.
--   • punch_items.linked_test_ids has no FK. STEP 1e reports any punch pointing
--     at a row you are about to delete — review those by hand; a stale id in
--     that array is inert in the UI but worth knowing about. (Skip 1e if this
--     project's punch_items has no linked_test_ids column.)
--
-- AFTERWARDS: sync_testplan.js upserts from TestPlan_Master.xlsm. If these rows
-- are still in that workbook, the next sync re-creates them — take them out
-- there too, or this cleanup only holds until the next import.
--
-- RLS: deleting from test_items needs test_register.delete_case /
-- delete_activity / bulk_delete (policy test_items_del). The Supabase SQL
-- Editor runs as the service role and bypasses RLS.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1 — PREVIEW (read-only; modifies nothing)
-- ════════════════════════════════════════════════════════════════════════════

-- 1a. The exact names being matched, and how many rows carry each.
select test_name, count(*) as rows
from public.test_items
where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
      like 'STANDARD TEST COMPLETION REPORT%'
group by test_name
order by test_name;

-- 1b. Where they live. Every row here should be an IXL activity — if another
--     subsystem shows up, decide whether you want it gone before STEP 2.
select subsystem, phase, location, activity, count(*) as rows
from public.test_items
where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
      like 'STANDARD TEST COMPLETION REPORT%'
group by subsystem, phase, location, activity
order by subsystem, phase, location, activity;

-- 1c. Child asset rows that will be removed alongside a matched parent.
select c.test_id, c.test_case_code, c.test_name, c.parent_test_id,
       c.subsystem, c.activity
from public.test_items c
join public.test_items p on p.test_id = c.parent_test_id
where upper(btrim(regexp_replace(coalesce(p.test_name, ''), '\s+', ' ', 'g')))
      like 'STANDARD TEST COMPLETION REPORT%'
  and upper(btrim(regexp_replace(coalesce(c.test_name, ''), '\s+', ' ', 'g')))
      not like 'STANDARD TEST COMPLETION REPORT%'
order by c.parent_test_id, c.test_id;

-- 1d. Near-misses: rows whose CODE or PROCEDURE says completion report, or that
--     carry the phrase mid-name, but that the match above does NOT take. These
--     are left alone. If any belong in the cleanup, widen the match
--     deliberately and re-run STEP 1 before deleting anything.
select test_id, test_case_code, test_name, test_procedure, subsystem, activity
from public.test_items
where (   upper(coalesce(test_case_code, '')) like '%COMPLETION REPORT%'
       or upper(coalesce(test_procedure, '')) like '%COMPLETION REPORT%'
       or upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
          like '%STANDARD TEST COMPLETION REPORT%')
  and upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
      not like 'STANDARD TEST COMPLETION REPORT%'
order by subsystem, activity, test_case_code;

-- 1e. Punch items linked to a row about to be deleted (report only — no FK).
--     to_jsonb() normalises the column whether it is text[] or jsonb.
select p.id, p.number, p.title, p.status, p.linked_test_ids
from public.punch_items p
cross join lateral (select to_jsonb(p.linked_test_ids) as j) x
where p.linked_test_ids is not null
  and jsonb_typeof(x.j) = 'array'
  and exists (
    select 1
    from jsonb_array_elements_text(x.j) as lid(test_id)
    join public.test_items t on t.test_id = lid.test_id
    where upper(btrim(regexp_replace(coalesce(t.test_name, ''), '\s+', ' ', 'g')))
          like 'STANDARD TEST COMPLETION REPORT%'
  )
order by p.number;

-- 1f. The headline number: matched rows + their child rows = total deletions.
with matched as (
  select test_id
  from public.test_items
  where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
        like 'STANDARD TEST COMPLETION REPORT%'
)
select
  (select count(*) from matched) as matched_rows,
  (select count(*)
     from public.test_items c
    where c.parent_test_id in (select test_id from matched)
      and c.test_id not in (select test_id from matched)) as child_rows;


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 2 — DELETE (run as ONE block, only after STEP 1 looks right)
--
-- Ends on `rollback`, so running it as-is is a dry run. Check the verification
-- row, then change the last line to `commit;` and run the block again.
--
-- To scope the cleanup to IXL only, uncomment the subsystem line in `matched`.
-- Unscoped, remaining_matches must come back 0; scoped to IXL it comes back as
-- the count of deliberately-kept rows in other subsystems (STEP 1b lists them).
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Prerequisite edges first: test_item_prerequisites has no cascade to lean on.
-- Guarded with to_regclass so the block still runs if the table is absent.
do $$
begin
  if to_regclass('public.test_item_prerequisites') is not null then
    execute $q$
      delete from public.test_item_prerequisites e
      where e.test_id in (
              select test_id from public.test_items
              where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
                    like 'STANDARD TEST COMPLETION REPORT%')
         or e.prerequisite_test_id in (
              select test_id from public.test_items
              where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
                    like 'STANDARD TEST COMPLETION REPORT%')
    $q$;
  end if;
end $$;

-- The rows themselves, plus any child asset row hanging off a matched parent.
with matched as (
  select test_id
  from public.test_items
  where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
        like 'STANDARD TEST COMPLETION REPORT%'
    -- and subsystem = 'IXL'        -- uncomment to restrict the cleanup to IXL
),
doomed as (
  select ti.test_id
  from public.test_items ti
  where ti.test_id in (select test_id from matched)
     or ti.parent_test_id in (select test_id from matched)
)
delete from public.test_items t
where t.test_id in (select test_id from doomed);

-- Verification — 0 unless you scoped the delete (see the STEP 2 note above).
select
  (select count(*) from public.test_items
    where upper(btrim(regexp_replace(coalesce(test_name, ''), '\s+', ' ', 'g')))
          like 'STANDARD TEST COMPLETION REPORT%') as remaining_matches,
  (select count(*) from public.test_items) as test_items_now;

rollback;   -- ← change to `commit;` once the verification row looks right
