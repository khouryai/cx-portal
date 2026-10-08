-- ============================================================================
-- Azure: point a portal profile at a person's Microsoft Entra account.
-- ----------------------------------------------------------------------------
-- Under Entra, the app finds a person's profile by their Entra object id (the
-- token's `oid`, which auth.uid() returns — see azure_auth_uid_shim.sql). A
-- profile carried over from Supabase still has its Supabase id, and a new
-- person has no profile yet. This function fixes both, keyed on email — the
-- one thing that carries over cleanly — and email is used ONLY for this link,
-- never for permissions.
--
--   select private.relink_profile('person@hitachirail.com', '<entra object id>');
--
-- The object id is on the person's page in Entra ID (Users → the person →
-- Object ID). For a BART guest, it is the guest account's object id in the
-- Hitachi tenant.
--
-- What it does, in one transaction: moves the profile to the new id, and every
-- reference to the old id with it — foreign keys, plain uuid columns and uuid
-- arrays across the public schema — so the person keeps their history,
-- permissions and ownership. Returns how many rows changed. Run as the
-- database administrator (it briefly drops and restores the foreign keys that
-- point at profiles). Idempotent: running it twice changes nothing.
--
-- Pinned by tools/test_relink_profile.js against a real PostgreSQL.
-- ============================================================================

create schema if not exists private;

create or replace function private.relink_profile(p_email text, p_new_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_old   uuid;
  v_n     integer;
  v_total integer := 0;
  r       record;
  v_fks   text[] := '{}';
  v_fk    text;
begin
  if p_new_id is null then raise exception 'relink_profile: new id is required'; end if;

  select id into v_old from public.profiles where lower(email) = lower(trim(p_email));
  if not found then
    raise exception 'relink_profile: no profile with email %', p_email;
  end if;
  if v_old = p_new_id then
    return 0;   -- already linked
  end if;
  if exists (select 1 from public.profiles where id = p_new_id) then
    raise exception 'relink_profile: another profile already uses id %', p_new_id;
  end if;

  -- 1. Foreign keys that point at profiles(id): remember, then drop.
  for r in
    select c.conrelid::regclass as tbl, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
  loop
    v_fks := v_fks || format('alter table %s add constraint %I %s', r.tbl, r.conname, r.def);
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;

  -- 2. Every uuid / uuid[] column in a public table that holds the old id,
  --    profiles.id itself included.
  for r in
    select c.table_name, c.column_name, c.udt_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.udt_name in ('uuid', '_uuid')
      and c.is_generated = 'NEVER'
  loop
    if r.udt_name = 'uuid' then
      execute format('update public.%I set %I = $1 where %I = $2',
                     r.table_name, r.column_name, r.column_name) using p_new_id, v_old;
    else
      execute format('update public.%I set %I = array_replace(%I, $2, $1) where $2 = any(%I)',
                     r.table_name, r.column_name, r.column_name, r.column_name) using p_new_id, v_old;
    end if;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;

  -- 3. Foreign keys back, exactly as they were (validated against the new ids).
  foreach v_fk in array v_fks loop
    execute v_fk;
  end loop;

  return v_total;
end;
$$;

revoke all on function private.relink_profile(text, uuid) from public;
