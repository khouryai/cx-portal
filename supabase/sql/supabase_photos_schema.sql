-- ============================================================================
-- Photos Module — schema
-- ----------------------------------------------------------------------------
-- A unified photo store for the T&C Portal. Every image in the app — whether it
-- originates from a Punch List item, a Daily Log, or a standalone field upload —
-- lands in the single `photos` table. Albums are driven off that table:
--   • "auto" albums group by source_type (Punch List / Daily Logs / General)
--   • "manual" albums are user-curated via the photo_album_items join table
--
-- Conventions mirror the existing schema files (forms / drawings):
--   • snake_case tables & columns, uuid PKs, timestamptz default now()
--   • storage_path points into a private Supabase Storage bucket
--   • blanket "authenticated" RLS (role nuance is enforced in the app layer)
--   • audit triggers reuse the shared audit_db_change() function when present
--
-- The sp_* columns are intentionally added now (stubbed) so the future
-- SharePoint sync (Microsoft Graph via an Entra app provisioned with Azure CLI)
-- can be layered on without another migration. See INTEGRATION_SHAREPOINT.md.
-- ============================================================================

-- ── photos ──────────────────────────────────────────────────────────────────
create table if not exists photos (
  id            uuid primary key default gen_random_uuid(),

  -- storage
  storage_path  text not null,                 -- object key in the 'photos' bucket
  thumb_path    text,                          -- optional separate thumbnail key
  file_name     text,
  mime_type     text,
  file_size     bigint,
  width         integer,
  height        integer,

  -- descriptive / filterable metadata
  caption       text,
  source_type   text not null default 'standalone'
                  check (source_type in ('punch','daily_log','standalone')),
  source_id     text,                          -- punch_items.id / delay_log.log_id / null
  source_label  text,                          -- human label e.g. "Punch #142" or "2026-05-29"
  capture_kind  text not null default 'general'
                  check (capture_kind in ('general','before','after')),
  phase         text,
  location      text,
  subsystem     text,
  tags          text[] default '{}',

  -- timeline
  taken_at      timestamptz default now(),     -- EXIF capture time when available, else upload time
  uploaded_by   text,
  uploaded_at   timestamptz default now(),

  -- SharePoint sync (stubbed — populated by the future Graph sync layer)
  sp_sync_status text default 'pending'
                  check (sp_sync_status in ('pending','queued','synced','error','skipped')),
  sp_item_id    text,
  sp_drive_id   text,
  sp_web_url    text,
  sp_synced_at  timestamptz,
  sp_error      text,

  -- housekeeping
  is_deleted    boolean default false,
  created_at    timestamptz default now()
);

create index if not exists photos_source_idx     on photos (source_type, source_id);
create index if not exists photos_taken_idx       on photos (taken_at desc);
create index if not exists photos_uploaded_idx    on photos (uploaded_at desc);
create index if not exists photos_location_idx    on photos (location);
create index if not exists photos_subsystem_idx   on photos (subsystem);
create index if not exists photos_uploadedby_idx  on photos (uploaded_by);
create index if not exists photos_capture_kind_idx on photos (capture_kind);
create index if not exists photos_notdeleted_idx  on photos (is_deleted) where is_deleted = false;

-- ── photo_albums ─────────────────────────────────────────────────────────────
create table if not exists photo_albums (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text unique,
  description      text,
  kind             text not null default 'manual'
                     check (kind in ('auto','manual')),
  -- for kind='auto': which source_type this album mirrors
  auto_source_type text check (auto_source_type in ('punch','daily_log','standalone')),
  cover_photo_id   uuid references photos (id) on delete set null,
  created_by       text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  is_deleted       boolean default false
);

create index if not exists photo_albums_kind_idx on photo_albums (kind);

-- ── photo_album_items (manual album membership; many-to-many) ─────────────────
-- auto albums derive their membership from photos.source_type and need no rows here.
create table if not exists photo_album_items (
  id         uuid primary key default gen_random_uuid(),
  album_id   uuid not null references photo_albums (id) on delete cascade,
  photo_id   uuid not null references photos (id) on delete cascade,
  added_by   text,
  added_at   timestamptz default now(),
  unique (album_id, photo_id)
);

create index if not exists photo_album_items_album_idx on photo_album_items (album_id);
create index if not exists photo_album_items_photo_idx on photo_album_items (photo_id);

-- ── Row-Level Security (matches forms/drawings: blanket authenticated) ─────────
alter table photos            enable row level security;
alter table photo_albums      enable row level security;
alter table photo_album_items enable row level security;

drop policy if exists photos_auth_all on photos;
create policy photos_auth_all on photos
  for all to authenticated using (true) with check (true);

drop policy if exists photo_albums_auth_all on photo_albums;
create policy photo_albums_auth_all on photo_albums
  for all to authenticated using (true) with check (true);

drop policy if exists photo_album_items_auth_all on photo_album_items;
create policy photo_album_items_auth_all on photo_album_items
  for all to authenticated using (true) with check (true);

-- ── Storage bucket + policies (private; same pattern as the 'forms' bucket) ───
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "photos bucket read" on storage.objects;
create policy "photos bucket read" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos');

drop policy if exists "photos bucket write" on storage.objects;
create policy "photos bucket write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos');

drop policy if exists "photos bucket update" on storage.objects;
create policy "photos bucket update" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos');

drop policy if exists "photos bucket delete" on storage.objects;
create policy "photos bucket delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos');

-- ── Audit triggers (reuse shared audit_db_change() only if it exists) ─────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'audit_db_change') then
    execute 'drop trigger if exists audit_photos_change on photos';
    execute 'create trigger audit_photos_change after insert or update or delete on photos
             for each row execute function audit_db_change()';

    execute 'drop trigger if exists audit_photo_albums_change on photo_albums';
    execute 'create trigger audit_photo_albums_change after insert or update or delete on photo_albums
             for each row execute function audit_db_change()';

    execute 'drop trigger if exists audit_photo_album_items_change on photo_album_items';
    execute 'create trigger audit_photo_album_items_change after insert or update or delete on photo_album_items
             for each row execute function audit_db_change()';
  end if;
end$$;

-- ── Seed the three auto albums ────────────────────────────────────────────────
insert into photo_albums (name, slug, kind, auto_source_type, description)
values
  ('Punch List', 'punch',      'auto', 'punch',      'Before/after photos captured against punch list items.'),
  ('Daily Logs', 'daily_log',  'auto', 'daily_log',  'Photos attached to daily field logs.'),
  ('General',    'standalone', 'auto', 'standalone', 'Standalone site & progress photos not tied to a record.')
on conflict (slug) do nothing;
