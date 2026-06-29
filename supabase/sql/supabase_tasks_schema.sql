-- ============================================================================
-- HITACHI Rail T&C Portal — Tasks (Field task tracker) schema
-- ----------------------------------------------------------------------------
-- Adds the `tasks` table behind the new "Tasks" module (Field section), plus:
--   • granular RLS mirroring the RMA module (private.has_module_perm('tasks', …))
--   • audit trigger (reuses audit_db_change)
--   • Data-API grants for signed-in users
--   • a perm_modules row so the module appears in Admin → Permissions, and its
--     action catalog (action_meta) so the granular resolver/RLS line up
--
-- Dropdown vocabularies (Task Type, Status, Priority, Effort) are NOT stored
-- here — they live in fieldset_config and are seeded lazily by Field Config
-- (keys: task_type, task_status, task_priority, task_effort).
--
-- Idempotent — safe to re-run. Apply via Supabase SQL editor or MCP migration.
-- ============================================================================

-- ── tasks ───────────────────────────────────────────────────
create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  task_name     text not null,
  description   text,
  prerequisites text,                       -- "Prerequisites / Status" column
  status        text not null default 'Not Started',
  priority      text default 'Medium',
  effort        text,                        -- Small / Medium / Large
  assignee      text,
  due_date      date,
  task_type     text[] not null default '{}'::text[],  -- multi-valued
  updates       text,
  created_by    text,
  created_at    timestamptz default now(),
  updated_by    text,
  updated_at    timestamptz default now()
);

create index if not exists tasks_status_idx   on tasks (status);
create index if not exists tasks_priority_idx on tasks (priority);
create index if not exists tasks_assignee_idx on tasks (assignee);
create index if not exists tasks_due_date_idx on tasks (due_date);

comment on table tasks is 'Field task tracker — owners, priority, effort, type and progress. Surfaced by the Tasks module under the Field section.';

-- ── Audit trigger (reuse the shared audit_db_change function) ─
drop trigger if exists audit_tasks_change on tasks;
create trigger audit_tasks_change
after insert or update or delete on tasks
for each row execute function audit_db_change();

-- ── Row-Level Security — granular, mirrors the rmas policies ──
alter table tasks enable row level security;

drop policy if exists tasks_sel on tasks;
create policy tasks_sel on tasks
  for select using ( (select private.has_module_perm('tasks','view')) );

drop policy if exists tasks_ins on tasks;
create policy tasks_ins on tasks
  for insert with check ( (select private.has_module_perm('tasks','create')) );

drop policy if exists tasks_upd on tasks;
create policy tasks_upd on tasks
  for update using ( (select private.has_module_perm('tasks','edit')) )
           with check ( (select private.has_module_perm('tasks','edit')) );

drop policy if exists tasks_del on tasks;
create policy tasks_del on tasks
  for delete using ( (select private.has_module_perm('tasks','delete')) );

-- ── Data API exposure grants ─────────────────────────────────
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on table tasks to authenticated, service_role;

-- ── Permissions catalog — register the module ────────────────
-- sort_order 65 places Tasks between RMA (60) and Forms (70) in the Field group.
insert into public.perm_modules (key, label, category, sort_order, governs, description, actions, action_meta)
values (
  'tasks', 'Tasks', 'field', 65, array['tasks'],
  'Field task tracker — task board with owners, priority, effort, type and progress.',
  array['view','export','create','edit','change_status','assign','delete'],
  '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"change_status":{"m":"standard","x":true},"assign":{"m":"standard","x":true},"delete":{"m":"admin"}}'::jsonb
)
on conflict (key) do update set
  label       = excluded.label,
  category    = excluded.category,
  sort_order  = excluded.sort_order,
  governs     = excluded.governs,
  description = excluded.description,
  actions     = excluded.actions,
  action_meta = excluded.action_meta;
