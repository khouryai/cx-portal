-- ============================================================================
-- Azure: link portal profiles to people's Microsoft Entra accounts.
-- ----------------------------------------------------------------------------
-- Under Entra the app finds a person's profile by their Entra object id (the
-- token's `oid`, which auth.uid() returns — see azure_auth_uid_shim.sql). A
-- profile carried over from Supabase still has its Supabase id, and a person
-- invited in the Directory screen has a placeholder id until they first sign in.
--
-- HOW LINKING WORKS
--   * A profile waiting for its owner has link_pending = true: every profile
--     carried over from Supabase (marked when this script first runs), and
--     every person an admin invites in the Directory screen.
--   * On first Microsoft sign-in the app calls public.claim_profile(). If no
--     profile has this person's object id yet, it looks for a WAITING profile
--     whose email matches the email Microsoft put in the token, moves it onto
--     the object id, clears the flag and writes an audit event.
--   * From then on only the object id is used. Email is used for this one-time
--     link and never for permissions; a linked profile can never be claimed
--     again, and only members of the portal users group can get a token at all.
--
-- IT can also link someone directly, without waiting for them to sign in:
--   select private.relink_profile('person@hitachirail.com', '<entra object id>');
--
-- Run once on the Azure database (azure_after_restore.sql includes it).
-- Idempotent. Pinned by tools/test_relink_profile.js against a real PostgreSQL.
-- ============================================================================

create schema if not exists private;

-- ── 1. The waiting flag. Profiles that exist when it is first added came from
--       Supabase, so they all wait for their owner's first Microsoft sign-in.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'link_pending') then
    alter table public.profiles add column link_pending boolean not null default false;
    update public.profiles set link_pending = true;
  end if;
end $$;

-- ── 2. Foreign keys that point at profiles(id) follow an id change
--       (ON UPDATE CASCADE). Converted once; their ON DELETE behaviour is kept.
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confupdtype <> 'c'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s on update cascade', r.tbl, r.conname,
                   regexp_replace(r.def, '\s+ON UPDATE (NO ACTION|RESTRICT|SET NULL|SET DEFAULT)', '', 'i'));
  end loop;
end $$;

-- ── 3. Move one profile, and every reference to it, onto a new id.
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

  -- The profile first: foreign keys follow it (step 2).
  update public.profiles set id = p_new_id, link_pending = false where id = v_old;
  v_total := 1;

  -- Then every other uuid / uuid[] column in a public table still holding the
  -- old id: ownership columns without a foreign key, member lists, and so on.
  for r in
    select c.table_name, c.column_name, c.udt_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.udt_name in ('uuid', '_uuid')
      and c.is_generated = 'NEVER'
      and not (c.table_name = 'profiles' and c.column_name = 'id')
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

  return v_total;
end;
$$;

revoke all on function private.relink_profile(text, uuid) from public;

-- ── 4. First Microsoft sign-in: claim the waiting profile with my email.
--       Called by the app (cx-auth-provider.js, claimProfile) when no profile
--       has the signed-in person's object id. Returns the profile, or null.
create or replace function public.claim_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_oid    uuid;
  v_emails text[];
  v_email  text;
  v_count  integer;
  v_row    public.profiles;
begin
  -- Entra tokens only: `oid` is the immutable directory id. (A Supabase token
  -- carries `sub` instead, and never reaches this database.)
  begin
    v_oid := nullif(auth.jwt() ->> 'oid', '')::uuid;
  exception when others then
    return null;
  end;
  if v_oid is null then return null; end if;

  select * into v_row from public.profiles where id = v_oid;
  if found then return v_row; end if;          -- already linked

  -- The addresses Microsoft vouches for in this token.
  select array_agg(distinct lower(trim(x))) into v_emails
  from unnest(array[auth.jwt() ->> 'email', auth.jwt() ->> 'preferred_username', auth.jwt() ->> 'upn']) x
  where x is not null and position('@' in x) > 1;
  if v_emails is null then return null; end if;

  select count(*), min(email) into v_count, v_email
  from public.profiles where link_pending and lower(trim(email)) = any(v_emails);
  if v_count = 0 then return null; end if;
  if v_count > 1 then
    raise exception 'claim_profile: more than one invited profile matches this account; ask an administrator';
  end if;

  perform private.relink_profile(v_email, v_oid);

  if to_regclass('public.auth_events') is not null then
    insert into public.auth_events (email, user_id, event, detail)
    values (v_email, v_oid, 'entra_link', 'First Microsoft sign-in linked the waiting profile to this Entra account');
  end if;

  select * into v_row from public.profiles where id = v_oid;
  return v_row;
end;
$$;

revoke all on function public.claim_profile() from public;
grant execute on function public.claim_profile() to authenticated;

-- ── 5. An administrator connects a waiting profile to a Microsoft account now
--       (Directory → Add Person with that person's email; team-invite.js),
--       instead of waiting for the person's first sign-in. The app has just
--       looked the account up in Microsoft Graph and put the person in the
--       portal users group; this moves the profile, and everything that refers
--       to it, onto that account's object id. Needs the same right as adding a
--       person; only a profile still waiting can be moved; audited.
create or replace function public.admin_link_profile(p_profile_id uuid, p_oid uuid)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   public.profiles;
  v_count integer;
begin
  if not (select private.has_module_perm('directory', 'invite')) then
    raise exception 'admin_link_profile: not allowed to add people' using errcode = '42501';
  end if;
  if p_profile_id is null or p_oid is null then
    raise exception 'admin_link_profile: profile id and Microsoft account id are both required';
  end if;

  select * into v_row from public.profiles where id = p_profile_id;
  if not found then
    raise exception 'admin_link_profile: no profile %', p_profile_id;
  end if;
  if not v_row.link_pending then
    raise exception 'admin_link_profile: % is already connected to a Microsoft account', v_row.email;
  end if;
  if exists (select 1 from public.profiles where id = p_oid) then
    raise exception 'admin_link_profile: that Microsoft account already has a profile';
  end if;
  select count(*) into v_count from public.profiles where lower(trim(email)) = lower(trim(v_row.email));
  if v_count <> 1 then
    raise exception 'admin_link_profile: % profiles use %; correct the duplicates first', v_count, v_row.email;
  end if;

  perform private.relink_profile(v_row.email, p_oid);

  if to_regclass('public.auth_events') is not null then
    insert into public.auth_events (email, user_id, event, detail)
    values (lower(v_row.email), p_oid, 'entra_link',
            'Connected to this Entra account by an administrator (' || coalesce((select auth.uid())::text, 'unknown') || ')');
  end if;

  select * into v_row from public.profiles where id = p_oid;
  return v_row;
end;
$$;

revoke all on function public.admin_link_profile(uuid, uuid) from public;
grant execute on function public.admin_link_profile(uuid, uuid) to authenticated;
