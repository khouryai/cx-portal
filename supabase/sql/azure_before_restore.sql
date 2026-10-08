-- ============================================================================
-- Azure database: run BEFORE restoring the backup.   (docs/AZURE_HOSTING.md, step 4)
--
--   psql "<admin connection>" -v ON_ERROR_STOP=1 \
--        -v authenticator_password='<new strong password>' \
--        -f supabase/sql/azure_before_restore.sql
--
-- ORDER MATTERS. The backup's 260+ security policies name these roles and call
-- auth.uid(). If either is missing when the backup is restored, the restore
-- does not stop — it skips those policies silently and the app shows nothing.
-- ============================================================================

-- 1. The database roles the gateway switches between: anon (no token) and
--    authenticated (a valid Entra token). service_role exists only because
--    some restored policies name it. On Supabase it bypasses row-level
--    security; here it does NOT, and the gateway's login cannot switch to it,
--    so the gateway password alone never reaches past row-level security.
--    (BYPASSRLS would also fail here: the Azure administrator is not a
--    superuser, and only a role with BYPASSRLS may create one.)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated to authenticator;
-- Re-runs on a database prepared by an earlier version of this script.
do $$ begin
  if pg_has_role('authenticator', 'service_role', 'member') then
    revoke service_role from authenticator;
  end if;
exception when others then
  raise warning 'could not revoke service_role from authenticator: %', sqlerrm;
end $$;

-- The gateway's own login. Its password goes into the gateway's connection
-- string (postgrestDbUri) and nowhere else.
alter role authenticator with login password :'authenticator_password';

-- 2. Extensions the schema uses (allow-listed on the server by infra/main.bicep).
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- 3. The schema that holds the permission functions.
create schema if not exists private;

-- 4. The sign-in shim: auth.uid() returns the Microsoft Entra user id.
\ir azure_auth_uid_shim.sql
grant usage on schema auth to service_role;
