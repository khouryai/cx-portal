-- ============================================================
-- HITACHI Rail T&C Portal — Forms / Test Data Sheets schema
-- Paste into: Supabase Dashboard → SQL Editor → Run
--
-- Adds:
--   • forms                      — every uploaded PDF (template or instance)
--   • form_test_item_links       — PDF ↔ test_items (many-to-many)
--   • form_template_links        — PDF ↔ templates (the blank attached
--                                  to an activity template; cloned at deploy)
--   • Storage bucket "forms"     — file-level storage
--   • RLS policies for the above
--   • Audit triggers wired in
-- ============================================================

-- ── forms ────────────────────────────────────────────────────
create table if not exists forms (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  description       text,
  subsystem         text,
  phase             text,
  location          text,
  storage_path      text not null,
  original_filename text,
  file_size         bigint,
  is_template       boolean default false,
  source_form_id    uuid references forms(id) on delete set null,
  created_by        text,
  created_at        timestamptz default now(),
  updated_by        text,
  updated_at        timestamptz default now()
);

create index if not exists forms_subsystem_idx   on forms (subsystem);
create index if not exists forms_phase_idx       on forms (phase);
create index if not exists forms_location_idx    on forms (location);
create index if not exists forms_is_template_idx on forms (is_template);
create index if not exists forms_source_idx      on forms (source_form_id);


-- ── forms ↔ test_items (manual + deployment-generated links) ─
create table if not exists form_test_item_links (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references forms(id) on delete cascade,
  test_id     text not null references test_items(test_id) on delete cascade,
  linked_by   text,
  linked_at   timestamptz default now(),
  unique (form_id, test_id)
);

create index if not exists ftil_form_idx on form_test_item_links (form_id);
create index if not exists ftil_test_idx on form_test_item_links (test_id);


-- ── forms ↔ templates (attached template-level blank PDF) ────
create table if not exists form_template_links (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references forms(id) on delete cascade,
  template_id text not null references templates(id) on delete cascade,
  linked_by   text,
  linked_at   timestamptz default now(),
  unique (form_id, template_id)
);

create index if not exists ftpl_form_idx     on form_template_links (form_id);
create index if not exists ftpl_template_idx on form_template_links (template_id);


-- ── Audit triggers (use existing audit_db_change function) ──
drop trigger if exists audit_forms_change on forms;
create trigger audit_forms_change
after insert or update or delete on forms
for each row execute function audit_db_change();

drop trigger if exists audit_form_test_item_links_change on form_test_item_links;
create trigger audit_form_test_item_links_change
after insert or update or delete on form_test_item_links
for each row execute function audit_db_change();

drop trigger if exists audit_form_template_links_change on form_template_links;
create trigger audit_form_template_links_change
after insert or update or delete on form_template_links
for each row execute function audit_db_change();


-- ── Row-Level Security ──────────────────────────────────────
alter table forms                  enable row level security;
alter table form_test_item_links   enable row level security;
alter table form_template_links    enable row level security;

drop policy if exists forms_auth_all on forms;
create policy forms_auth_all on forms
  for all to authenticated using (true) with check (true);

drop policy if exists ftil_auth_all on form_test_item_links;
create policy ftil_auth_all on form_test_item_links
  for all to authenticated using (true) with check (true);

drop policy if exists ftpl_auth_all on form_template_links;
create policy ftpl_auth_all on form_template_links
  for all to authenticated using (true) with check (true);


-- ============================================================
-- STORAGE BUCKET — "forms" (private)
-- ============================================================
-- Bucket creation (idempotent). Run in Supabase SQL editor.
insert into storage.buckets (id, name, public)
values ('forms', 'forms', false)
on conflict (id) do nothing;

-- Storage RLS policies — authenticated users may read/write/delete
-- objects in the "forms" bucket. (When SharePoint takes over, these go
-- away — Graph enforces ACLs at the SharePoint layer.)
drop policy if exists "forms bucket read"   on storage.objects;
drop policy if exists "forms bucket write"  on storage.objects;
drop policy if exists "forms bucket update" on storage.objects;
drop policy if exists "forms bucket delete" on storage.objects;

create policy "forms bucket read" on storage.objects
  for select to authenticated
  using (bucket_id = 'forms');

create policy "forms bucket write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'forms');

create policy "forms bucket update" on storage.objects
  for update to authenticated
  using (bucket_id = 'forms')
  with check (bucket_id = 'forms');

create policy "forms bucket delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'forms');
