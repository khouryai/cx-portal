-- ============================================================================
-- HITACHI Rail T&C Portal — Checkpoint (Tasks + Activity Readiness merge)
-- ----------------------------------------------------------------------------
-- The Tasks and Activity Readiness surfaces merge into ONE module,
-- "Checkpoint". This migration:
--   • adds tasks.kind ('task' | 'activity') — the explicit type that drives
--     the Task/Readiness pill, filters and the Overview/Delays scoping
--   • backfills kind='activity' for rows that were born as readiness
--     activities (template, dimensions, or an existing checklist)
--   • retires the legacy prerequisite trio:
--       - prerequisites (free text)      → converted to a checklist line
--       - prerequisite_met (checkbox)    → the line's done state
--       - prerequisite_comments (thread) → appended into the main comments
--         thread tagged {"legacy_prereq":true} so history stays readable
--     then DROPS the three columns (owner-approved clean break)
--   • relabels the perm module to Checkpoint (key stays 'tasks' — no
--     permission template changes needed)
--
-- Idempotent — safe to re-run (the prereq conversion only runs while the
-- legacy columns still exist). Apply via Supabase SQL editor or MCP.
-- ============================================================================

-- ── tasks.kind ───────────────────────────────────────────────
alter table public.tasks add column if not exists kind text not null default 'task';

-- Backfill BEFORE converting prereq text (a plain task with a prereq note
-- must not be misclassified as a readiness activity by its new line).
update public.tasks t set kind = 'activity'
where t.kind = 'task'
  and (t.template_id is not null
       or t.location is not null or t.subsystem is not null or t.phase is not null
       or exists (select 1 from public.task_checklist_items i where i.task_id = t.id));

-- ── Legacy prerequisite → checklist line + merged comments ───
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks'
               and column_name = 'prerequisites') then

    -- free-text prerequisite becomes a structured checklist line
    insert into public.task_checklist_items
      (task_id, seq, title, description, kind, required, done, completed_by, completed_at, created_by)
    select t.id,
           coalesce((select max(i.seq) from public.task_checklist_items i where i.task_id = t.id), 0) + 10,
           'Prerequisite', t.prerequisites, 'check', true, t.prerequisite_met,
           case when t.prerequisite_met then coalesce(t.updated_by, t.created_by) end,
           case when t.prerequisite_met then coalesce(t.updated_at, now()) end,
           coalesce(t.updated_by, t.created_by)
    from public.tasks t
    where t.prerequisites is not null and btrim(t.prerequisites) <> '';

    -- prerequisite comment thread merges into the main thread, tagged
    update public.tasks t set comments = t.comments || (
      select coalesce(jsonb_agg(elem || '{"legacy_prereq":true}'::jsonb), '[]'::jsonb)
      from jsonb_array_elements(t.prerequisite_comments) elem
    )
    where jsonb_typeof(t.prerequisite_comments) = 'array'
      and jsonb_array_length(t.prerequisite_comments) > 0;

    alter table public.tasks drop column prerequisites;
    alter table public.tasks drop column prerequisite_met;
    alter table public.tasks drop column prerequisite_comments;
  end if;
end $$;

-- ── Permissions catalog — relabel the module ─────────────────
update public.perm_modules set
  label       = 'Checkpoint',
  description = 'Checkpoint — unified tasks + activity-readiness workspace: work items and readiness activities with structured checklists, templates, delay tracking and rollup dashboards.'
where key = 'tasks';
