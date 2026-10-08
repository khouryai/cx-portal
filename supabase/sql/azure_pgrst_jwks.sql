-- ============================================================================
-- Azure: keep PostgREST's copy of Microsoft's sign-in keys current.
-- ----------------------------------------------------------------------------
-- PostgREST verifies every Entra token against Microsoft's public signing keys
-- (a JWKS), but it cannot fetch them from a URL — it needs the key material
-- itself, and Microsoft rotates those keys every few weeks. A stale copy means
-- every sign-in fails.
--
-- So the keys live in this one-row table:
--   * PostgREST reads them every time it loads its configuration, through
--     private.pgrst_pre_config() (PGRST_DB_PRE_CONFIG, set in infra/main.bicep).
--   * A small helper container beside PostgREST (the 'jwks-refresh' sidecar in
--     infra/main.bicep) fetches Microsoft's keys every few hours and hands them
--     to private.set_pgrst_jwks(), which stores them only if they changed and
--     tells PostgREST to reload. No restart, no downtime.
--
-- Why a table and not `ALTER ROLE authenticator SET pgrst.jwt_secret`: from
-- PostgreSQL 15 only a superuser may set a custom parameter on a role, and the
-- managed Azure database gives nobody superuser.
--
-- Run once on the Azure database, after the restore (azure/RUNBOOK.md).
-- Idempotent. Pinned by tools/test_jwks_refresh.js against a real PostgREST.
-- Not used on Supabase, which manages its own keys.
-- ============================================================================

create schema if not exists private;
grant usage on schema private to authenticator;

create table if not exists private.pgrst_jwks (
  id         boolean primary key default true check (id),   -- exactly one row
  jwks       jsonb not null,
  updated_at timestamptz not null default now()
);
revoke all on private.pgrst_jwks from public;

-- Called by PostgREST, as `authenticator`, whenever it (re)loads config.
-- With no row yet (first boot, or a deployment using local passwords) it sets
-- nothing, and PostgREST keeps whatever PGRST_JWT_SECRET says.
create or replace function private.pgrst_pre_config()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  select jwks::text into v from private.pgrst_jwks where id;
  if v is not null then
    perform set_config('pgrst.jwt_secret', v, true);
  end if;
end;
$$;

-- Called by the refresh sidecar, as `authenticator`. Refuses anything that is
-- not a usable key set, so a bad download can never lock everyone out: the
-- previous keys stay in force. Returns true when the keys changed.
create or replace function private.set_pgrst_jwks(p_jwks text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb;
begin
  begin
    v_new := p_jwks::jsonb;
  exception when others then
    raise exception 'jwks-refresh: not JSON';
  end;
  if jsonb_typeof(v_new -> 'keys') is distinct from 'array'
     or jsonb_array_length(v_new -> 'keys') = 0 then
    raise exception 'jwks-refresh: no keys in the key set';
  end if;
  if exists (select 1 from jsonb_array_elements(v_new -> 'keys') k
             where k ->> 'kty' is null or k ->> 'kid' is null) then
    raise exception 'jwks-refresh: a key is missing kty or kid';
  end if;

  select jwks into v_old from private.pgrst_jwks where id;
  if v_old = v_new then
    return false;
  end if;

  insert into private.pgrst_jwks (id, jwks, updated_at) values (true, v_new, now())
  on conflict (id) do update set jwks = excluded.jwks, updated_at = excluded.updated_at;
  perform pg_notify('pgrst', 'reload config');
  return true;
end;
$$;

-- Only the gateway's own login may call these — never a signed-in user, whose
-- requests run as anon/authenticated.
revoke all on function private.pgrst_pre_config() from public;
revoke all on function private.set_pgrst_jwks(text) from public;
grant execute on function private.pgrst_pre_config() to authenticator;
grant execute on function private.set_pgrst_jwks(text) to authenticator;
