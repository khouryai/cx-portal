-- ============================================================================
-- Photo and album ownership by account id, not by name (2026-10).
-- ----------------------------------------------------------------------------
-- "Edit / delete my own photo" and "manage my own album" compared the row's
-- uploaded_by / created_by NAME with the signed-in person's full name. A
-- rename broke ownership, two people with one name shared it, and the name
-- was whatever the browser sent. Now:
--   * photos.uploaded_by_id and photo_albums.created_by_id hold the owner's
--     profile id, STAMPED BY THE DATABASE from the signed-in session on insert
--     and never changeable from the API afterwards;
--   * the four ownership policies compare that id with auth.uid();
--   * existing rows are backfilled where the stored name matches exactly one
--     profile; the rest have no owner (only "any" rights apply to them).
-- uploaded_by / created_by stay as the displayed name.
--
-- Both columns reference profiles(id) ON UPDATE CASCADE, so linking a profile
-- to its Microsoft Entra id on Azure (azure_relink_profile.sql) carries
-- ownership with it.
--
-- Run once on Supabase (SQL editor), before the backup for Azure. Idempotent.
-- Pinned by tools/test_photo_owner.js against a real PostgreSQL.
-- ============================================================================

alter table public.photos       add column if not exists uploaded_by_id uuid;
alter table public.photo_albums add column if not exists created_by_id  uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'photos_uploaded_by_id_fkey') then
    alter table public.photos add constraint photos_uploaded_by_id_fkey
      foreign key (uploaded_by_id) references public.profiles(id) on update cascade on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'photo_albums_created_by_id_fkey') then
    alter table public.photo_albums add constraint photo_albums_created_by_id_fkey
      foreign key (created_by_id) references public.profiles(id) on update cascade on delete set null;
  end if;
end $$;

create index if not exists photos_uploaded_by_id_idx       on public.photos (uploaded_by_id);
create index if not exists photo_albums_created_by_id_idx  on public.photo_albums (created_by_id);

-- ── The owner is whoever is signed in when the row is created. ──────────────
-- Requests arrive as the `authenticated` role: for those the id is set from
-- the session, whatever the request body says, and can never be changed
-- afterwards. The database itself (backfill below, profile relinking, the
-- foreign key's ON UPDATE CASCADE) runs as the table owner and may move it.
create or replace function private.stamp_photo_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.uploaded_by_id := auth.uid();
  elsif new.uploaded_by_id is distinct from old.uploaded_by_id then
    new.uploaded_by_id := old.uploaded_by_id;
  end if;
  return new;
end;
$$;

create or replace function private.stamp_album_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by_id := auth.uid();
  elsif new.created_by_id is distinct from old.created_by_id then
    new.created_by_id := old.created_by_id;
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_stamp_photo_owner') then
    create trigger trg_stamp_photo_owner before insert or update on public.photos
      for each row execute function private.stamp_photo_owner();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_stamp_album_owner') then
    create trigger trg_stamp_album_owner before insert or update on public.photo_albums
      for each row execute function private.stamp_album_owner();
  end if;
end $$;

-- ── Backfill: the stored name, where it names exactly one person. ───────────
update public.photos p set uploaded_by_id = pr.id
from public.profiles pr
where p.uploaded_by_id is null
  and lower(trim(pr.full_name)) = lower(trim(p.uploaded_by))
  and (select count(*) from public.profiles x where lower(trim(x.full_name)) = lower(trim(p.uploaded_by))) = 1;

update public.photo_albums a set created_by_id = pr.id
from public.profiles pr
where a.created_by_id is null
  and lower(trim(pr.full_name)) = lower(trim(a.created_by))
  and (select count(*) from public.profiles x where lower(trim(x.full_name)) = lower(trim(a.created_by))) = 1;

-- ── The four ownership policies: id, not name. ──────────────────────────────
alter policy photos_upd on public.photos
  using (
    (select private.has_module_perm('photos', 'edit_metadata_any'))
    or ((select private.has_module_perm('photos', 'edit_metadata_own')) and uploaded_by_id = (select auth.uid())))
  with check (
    (select private.has_module_perm('photos', 'edit_metadata_any'))
    or ((select private.has_module_perm('photos', 'edit_metadata_own')) and uploaded_by_id = (select auth.uid())));

alter policy photos_del on public.photos
  using (
    (select private.has_module_perm('photos', 'delete_any'))
    or ((select private.has_module_perm('photos', 'delete_own')) and uploaded_by_id = (select auth.uid())));

alter policy photo_albums_upd on public.photo_albums
  using (
    (select private.has_module_perm('photos', 'manage_album_any'))
    or (select private.has_module_perm('photos', 'manage_album_contents'))
    or ((select private.has_module_perm('photos', 'manage_album_own')) and created_by_id = (select auth.uid())))
  with check (
    (select private.has_module_perm('photos', 'manage_album_any'))
    or (select private.has_module_perm('photos', 'manage_album_contents'))
    or ((select private.has_module_perm('photos', 'manage_album_own')) and created_by_id = (select auth.uid())));

alter policy photo_albums_del on public.photo_albums
  using (
    (select private.has_module_perm('photos', 'manage_album_any'))
    or ((select private.has_module_perm('photos', 'manage_album_own')) and created_by_id = (select auth.uid())));

notify pgrst, 'reload schema';
