-- ============================================================================
-- Remove Asset Management and Checkpoint / Activity Readiness — PART 2 of 2
-- (owner-directed, 2026-10)
--
-- Run AFTER supabase_child_test_cases.sql (PART 1) and after the new front end
-- has deployed (so no open browser is still on a build that reads these
-- tables). Both features are already gone from the app.
--
-- ASSET MANAGEMENT
--   Child test cases stay — they now carry their own name in
--   test_items.child_label (PART 1). This drops what only the asset module used:
--     • tables assets, asset_test_links, asset_import_batches
--     • columns test_items.asset_id and form_test_item_links.asset_id
--       (a per-device form link now sits on the child test case's own id)
--     • permission module 'assets' and capability test_register.manage_assets
--   Activity Templates keep their child test case list; the key inside
--   templates.test_cases is renamed from `assets` to `children`.
--
-- CHECKPOINT / ACTIVITY READINESS
--     • tables tasks, task_checklist_items, task_item_delays, task_files,
--       readiness_templates, readiness_template_items
--     • the task-files storage policies, permission module 'tasks', and the
--       Field Config vocabularies only Checkpoint used
--
-- SAFETY NET: every dropped table is first copied into the non-exposed
-- `private` schema (private.archive_*_2026_10), so the rows stay recoverable.
-- The 'task-files' storage bucket must be deleted separately (Supabase blocks
-- SQL deletes on storage.buckets): Dashboard → Storage → task-files → Delete.
--
-- One transaction; idempotent, safe to re-run.
-- ============================================================================

begin;

-- ── 0. Archive copies of everything this drops ──────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['assets','asset_test_links','asset_import_batches',
                           'tasks','task_checklist_items','task_item_delays','task_files',
                           'readiness_templates','readiness_template_items'] loop
    if to_regclass('public.' || t) is not null
       and to_regclass('private.archive_' || t || '_2026_10') is null then
      execute format('create table private.%I as table public.%I', 'archive_' || t || '_2026_10', t);
    end if;
  end loop;
end$$;

-- ── 1. Assets → child test cases ────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'test_items' and column_name = 'asset_id') then
    -- Catch any child added by a not-yet-refreshed browser since PART 1 ran.
    if to_regclass('public.assets') is not null then
      execute $q$
        update public.test_items c set child_label = a.name
          from public.assets a
         where c.asset_id = a.id and c.parent_test_id is not null and coalesce(c.child_label, '') = ''
      $q$;
    end if;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'form_test_item_links' and column_name = 'asset_id') then
    -- A per-device form link (test_id = parent, asset_id = device) moves onto
    -- the child test case it belonged to — its ORIGINAL attempt, which is what
    -- the app keys per-child forms to — unless that child already has it.
    execute $q$
      insert into public.form_test_item_links (form_id, test_id, linked_by, linked_at)
      select distinct on (l.form_id, c.test_id) l.form_id, c.test_id, l.linked_by, l.linked_at
        from public.form_test_item_links l
        join public.test_items c
          on c.parent_test_id = l.test_id
         and c.asset_id = l.asset_id
         and coalesce(c.regression_group_id, c.test_id) = c.test_id
       where l.asset_id is not null
         and not exists (select 1 from public.form_test_item_links x
                          where x.form_id = l.form_id and x.test_id = c.test_id and x.asset_id is null)
    $q$;
    execute 'delete from public.form_test_item_links where asset_id is not null';
    -- Drops the asset FK, ftil_asset_idx and both partial unique indexes.
    execute 'alter table public.form_test_item_links drop column asset_id';
  end if;
end$$;

-- One link per (form, test case) — the shape the app reads and writes.
create unique index if not exists ftil_unique_form_test
  on public.form_test_item_links (form_id, test_id);

alter table public.test_items drop column if exists asset_id;

-- software_configs.device_id referenced assets (no rows use it); its FK goes
-- with the table, the unused column stays.
drop table if exists public.asset_test_links     cascade;
drop table if exists public.assets               cascade;
drop table if exists public.asset_import_batches cascade;

-- Activity Templates: the child test case list moves from `assets` to `children`.
update public.templates t
   set test_cases = (
     select jsonb_agg(case when e ? 'assets'
                           then (e - 'assets') || jsonb_build_object('children', e->'assets')
                           else e end
                      order by ord)
       from jsonb_array_elements(t.test_cases) with ordinality as x(e, ord))
 where jsonb_typeof(t.test_cases) = 'array'
   and exists (select 1 from jsonb_array_elements(t.test_cases) e where e ? 'assets');

-- ── 2. Checkpoint / Activity Readiness ──────────────────────────────────────
drop table if exists public.task_files               cascade;
drop table if exists public.task_item_delays         cascade;
drop table if exists public.task_checklist_items     cascade;
drop table if exists public.readiness_template_items cascade;
drop table if exists public.readiness_templates      cascade;
drop table if exists public.tasks                    cascade;

drop policy if exists task_files_bucket_read   on storage.objects;
drop policy if exists task_files_bucket_write  on storage.objects;
drop policy if exists task_files_bucket_delete on storage.objects;

delete from public.fieldset_config
 where field_key in ('task_type', 'task_status', 'task_priority', 'task_effort',
                     'readiness_delay_reason', 'lookahead_phase');

-- ── 3. Permissions ──────────────────────────────────────────────────────────
-- Template / per-user grant rows cascade from perm_modules.
delete from public.perm_modules where key in ('assets', 'tasks');

update public.perm_modules
   set actions     = array_remove(actions, 'manage_assets'),
       action_meta = action_meta - 'manage_assets'
 where key = 'test_register';

-- Same policy, minus the removed capability. Flagging a parent (is_parent) when
-- a child is added is an UPDATE, covered by edit_case.
alter policy test_items_upd on public.test_items
  using (
    (select private.has_module_perm('test_register','edit_case'))
    or (select private.has_module_perm('test_register','set_status'))
    or (select private.has_module_perm('test_register','deploy_field'))
    or (select private.has_module_perm('test_register','bulk_edit'))
  )
  with check (
    (select private.has_module_perm('test_register','edit_case'))
    or (select private.has_module_perm('test_register','set_status'))
    or (select private.has_module_perm('test_register','deploy_field'))
    or (select private.has_module_perm('test_register','bulk_edit'))
  );

commit;

notify pgrst, 'reload schema';
