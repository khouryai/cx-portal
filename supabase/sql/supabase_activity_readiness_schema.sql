-- ============================================================================
-- HITACHI Rail T&C Portal — Activity Readiness (merged into the Tasks module)
-- ----------------------------------------------------------------------------
-- One engine, two views: a "readiness activity" IS a task. This migration
--   • extends `tasks` with location / subsystem / phase / template_id
--   • adds structured checklists (`task_checklist_items`) — sectioned lines of
--     kind check | passfail | value | note | task (the last links another task
--     so its progress rolls up proportionally into the parent, read-only)
--   • adds reusable templates (`readiness_templates` + `readiness_template_items`)
--     that seed a new task's checklist as a snapshot (fully editable after issue)
--   • adds a due-date delay history (`task_item_delays`) — every push of a
--     line's due date records old → new + a mandatory reason
--   • adds any-type file attachments per line (`task_files` + `task-files` bucket)
--   • registers a `manage_templates` action on the existing `tasks` perm module
--
-- RLS mirrors the tasks module (private.has_module_perm('tasks', …)); template
-- editing requires the new manage_templates action. Audit reuses audit_db_change.
--
-- Idempotent — safe to re-run. Apply via Supabase SQL editor or MCP migration.
-- ============================================================================

-- ── tasks: readiness dimensions ──────────────────────────────
alter table public.tasks add column if not exists location    text;
alter table public.tasks add column if not exists subsystem   text;
alter table public.tasks add column if not exists phase       text;
alter table public.tasks add column if not exists template_id uuid;

create index if not exists tasks_subsystem_idx on public.tasks (subsystem);
create index if not exists tasks_phase_idx     on public.tasks (phase);

-- ── readiness_templates ──────────────────────────────────────
create table if not exists public.readiness_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

comment on table public.readiness_templates is 'Reusable Activity Readiness checklist definitions (e.g. "DCS Site Testing Start"). Issuing one copies its items onto a task — a snapshot; later template edits only affect future issues.';

-- ── readiness_template_items ─────────────────────────────────
create table if not exists public.readiness_template_items (
  id                  uuid primary key default gen_random_uuid(),
  template_id         uuid not null references public.readiness_templates(id) on delete cascade,
  section             text,
  seq                 integer not null default 0,
  title               text not null,
  description         text,
  kind                text not null default 'check',  -- check | passfail | value | note
  unit                text,
  expected            text,
  required            boolean not null default true,
  default_responsible text,
  due_offset_days     integer,                        -- item due = activity due − offset
  created_by          text,
  created_at          timestamptz not null default now()
);

create index if not exists readiness_template_items_tpl_idx on public.readiness_template_items (template_id);

-- ── task_checklist_items ─────────────────────────────────────
create table if not exists public.task_checklist_items (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references public.tasks(id) on delete cascade,
  section        text,
  seq            integer not null default 0,
  title          text not null,
  description    text,
  kind           text not null default 'check',       -- check | passfail | value | note | task
  linked_task_id uuid references public.tasks(id) on delete set null,
  unit           text,
  expected       text,
  required       boolean not null default true,
  done           boolean not null default false,
  verdict        text,
  value_text     text,
  due_date       date,
  responsible    text,
  completed_by   text,
  completed_at   timestamptz,
  created_by     text,
  created_at     timestamptz not null default now()
);

create index if not exists task_checklist_items_task_idx   on public.task_checklist_items (task_id);
create index if not exists task_checklist_items_linked_idx on public.task_checklist_items (linked_task_id);

comment on table public.task_checklist_items is 'Structured readiness checklist lines on a task. kind=task links another task whose progress rolls up read-only into this line.';

-- ── task_item_delays (due-date push history) ─────────────────
create table if not exists public.task_item_delays (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.task_checklist_items(id) on delete cascade,
  old_due    date,
  new_due    date,
  reason     text not null,
  note       text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists task_item_delays_item_idx on public.task_item_delays (item_id);

-- ── task_files (per-line any-type attachments) ───────────────
create table if not exists public.task_files (
  id                uuid primary key default gen_random_uuid(),
  checklist_item_id uuid not null references public.task_checklist_items(id) on delete cascade,
  file_name         text not null,
  storage_path      text not null,
  file_size         bigint,
  content_type      text,
  uploaded_by       text,
  created_at        timestamptz not null default now()
);

create index if not exists task_files_item_idx on public.task_files (checklist_item_id);

-- ── Audit triggers (shared audit_db_change) ──────────────────
drop trigger if exists audit_readiness_templates_change on public.readiness_templates;
create trigger audit_readiness_templates_change
after insert or update or delete on public.readiness_templates
for each row execute function audit_db_change();

drop trigger if exists audit_readiness_template_items_change on public.readiness_template_items;
create trigger audit_readiness_template_items_change
after insert or update or delete on public.readiness_template_items
for each row execute function audit_db_change();

drop trigger if exists audit_task_checklist_items_change on public.task_checklist_items;
create trigger audit_task_checklist_items_change
after insert or update or delete on public.task_checklist_items
for each row execute function audit_db_change();

drop trigger if exists audit_task_item_delays_change on public.task_item_delays;
create trigger audit_task_item_delays_change
after insert or update or delete on public.task_item_delays
for each row execute function audit_db_change();

drop trigger if exists audit_task_files_change on public.task_files;
create trigger audit_task_files_change
after insert or update or delete on public.task_files
for each row execute function audit_db_change();

-- ── RLS — mirrors the tasks module ───────────────────────────
alter table public.task_checklist_items     enable row level security;
alter table public.task_item_delays         enable row level security;
alter table public.task_files               enable row level security;
alter table public.readiness_templates      enable row level security;
alter table public.readiness_template_items enable row level security;

-- checklist lines / delays / files follow tasks view+edit
drop policy if exists task_chk_sel on public.task_checklist_items;
create policy task_chk_sel on public.task_checklist_items
  for select using ( (select private.has_module_perm('tasks','view')) );
drop policy if exists task_chk_ins on public.task_checklist_items;
create policy task_chk_ins on public.task_checklist_items
  for insert with check ( (select private.has_module_perm('tasks','edit')) );
drop policy if exists task_chk_upd on public.task_checklist_items;
create policy task_chk_upd on public.task_checklist_items
  for update using ( (select private.has_module_perm('tasks','edit')) )
           with check ( (select private.has_module_perm('tasks','edit')) );
drop policy if exists task_chk_del on public.task_checklist_items;
create policy task_chk_del on public.task_checklist_items
  for delete using ( (select private.has_module_perm('tasks','edit')) );

drop policy if exists task_delay_sel on public.task_item_delays;
create policy task_delay_sel on public.task_item_delays
  for select using ( (select private.has_module_perm('tasks','view')) );
drop policy if exists task_delay_ins on public.task_item_delays;
create policy task_delay_ins on public.task_item_delays
  for insert with check ( (select private.has_module_perm('tasks','edit')) );
drop policy if exists task_delay_del on public.task_item_delays;
create policy task_delay_del on public.task_item_delays
  for delete using ( (select private.has_module_perm('tasks','delete')) );

drop policy if exists task_files_sel on public.task_files;
create policy task_files_sel on public.task_files
  for select using ( (select private.has_module_perm('tasks','view')) );
drop policy if exists task_files_ins on public.task_files;
create policy task_files_ins on public.task_files
  for insert with check ( (select private.has_module_perm('tasks','edit')) );
drop policy if exists task_files_del on public.task_files;
create policy task_files_del on public.task_files
  for delete using ( (select private.has_module_perm('tasks','edit')) );

-- templates require the manage_templates action to change
drop policy if exists rd_tpl_sel on public.readiness_templates;
create policy rd_tpl_sel on public.readiness_templates
  for select using ( (select private.has_module_perm('tasks','view')) );
drop policy if exists rd_tpl_ins on public.readiness_templates;
create policy rd_tpl_ins on public.readiness_templates
  for insert with check ( (select private.has_module_perm('tasks','manage_templates')) );
drop policy if exists rd_tpl_upd on public.readiness_templates;
create policy rd_tpl_upd on public.readiness_templates
  for update using ( (select private.has_module_perm('tasks','manage_templates')) )
           with check ( (select private.has_module_perm('tasks','manage_templates')) );
drop policy if exists rd_tpl_del on public.readiness_templates;
create policy rd_tpl_del on public.readiness_templates
  for delete using ( (select private.has_module_perm('tasks','manage_templates')) );

drop policy if exists rd_tpl_items_sel on public.readiness_template_items;
create policy rd_tpl_items_sel on public.readiness_template_items
  for select using ( (select private.has_module_perm('tasks','view')) );
drop policy if exists rd_tpl_items_ins on public.readiness_template_items;
create policy rd_tpl_items_ins on public.readiness_template_items
  for insert with check ( (select private.has_module_perm('tasks','manage_templates')) );
drop policy if exists rd_tpl_items_upd on public.readiness_template_items;
create policy rd_tpl_items_upd on public.readiness_template_items
  for update using ( (select private.has_module_perm('tasks','manage_templates')) )
           with check ( (select private.has_module_perm('tasks','manage_templates')) );
drop policy if exists rd_tpl_items_del on public.readiness_template_items;
create policy rd_tpl_items_del on public.readiness_template_items
  for delete using ( (select private.has_module_perm('tasks','manage_templates')) );

-- ── Data API exposure grants ─────────────────────────────────
grant select, insert, update, delete on table public.task_checklist_items     to authenticated, service_role;
grant select, insert, update, delete on table public.task_item_delays         to authenticated, service_role;
grant select, insert, update, delete on table public.task_files               to authenticated, service_role;
grant select, insert, update, delete on table public.readiness_templates      to authenticated, service_role;
grant select, insert, update, delete on table public.readiness_template_items to authenticated, service_role;

-- ── Storage: task-files bucket (mirrors vehicle-files) ───────
insert into storage.buckets (id, name, public)
values ('task-files', 'task-files', false)
on conflict (id) do nothing;

drop policy if exists task_files_bucket_read on storage.objects;
create policy task_files_bucket_read on storage.objects
  for select to authenticated using ( bucket_id = 'task-files' );
drop policy if exists task_files_bucket_write on storage.objects;
create policy task_files_bucket_write on storage.objects
  for insert to authenticated with check ( bucket_id = 'task-files' );
drop policy if exists task_files_bucket_delete on storage.objects;
create policy task_files_bucket_delete on storage.objects
  for delete to authenticated using ( bucket_id = 'task-files' );

-- ── Permissions catalog — extend the tasks module ────────────
update public.perm_modules set
  governs     = array['tasks','task_checklist_items','task_item_delays','task_files','readiness_templates','readiness_template_items'],
  description = 'Field task tracker + Activity Readiness — task board with owners, priority, effort, type and progress, plus structured readiness checklists, templates and delay tracking.',
  actions     = case when 'manage_templates' = any(actions) then actions else array_append(actions, 'manage_templates') end,
  action_meta = action_meta || '{"manage_templates":{"m":"standard","x":true}}'::jsonb
where key = 'tasks';
