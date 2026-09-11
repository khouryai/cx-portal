-- ============================================================
-- azure_auth_uid_shim.sql
--
-- THE LOAD-BEARING PIECE OF THE AZURE MIGRATION.
--
-- On Supabase, the `auth` schema is supplied by GoTrue and every RLS policy
-- calls auth.uid() / auth.role() / auth.jwt(). On Azure Database for PostgreSQL
-- with self-hosted PostgREST there is no GoTrue — but PostgREST sets the SAME
-- `request.jwt.claims` GUC from the bearer token, whoever issued it. So the
-- entire `auth` schema can be re-implemented as three small functions, and
-- every policy keeps working verbatim.
--
-- WHY THIS MATTERS, MEASURED against the live database:
--   349 RLS policies across 90 tables
--   331 of them (95%) reach authorization only through private.has_module_perm()
--    18 of them compare auth.uid() to a stored id
-- So the identity swap touches ONE function plus 18 policies that all do the
-- same thing — compare auth.uid() to a uuid column. Nothing needs rewriting:
-- it needs auth.uid() to return the right uuid.
--
-- THE ONE DATA STEP: Entra issues `oid` (a uuid) where Supabase issued `sub`.
-- Re-key profiles.id to each user's Entra object id during cutover and every
-- policy resolves identically. uid() below reads `oid` first and falls back to
-- `sub`, so the SAME database works against either issuer — which is what makes
-- a parallel run possible instead of a hard cutover.
--
-- Verified by tools/test_rls_portability.js, which stands this up on plain
-- PostgreSQL and asserts a Supabase-issued and an Entra-issued token resolve to
-- the same access decisions.
-- ============================================================

create schema if not exists auth;

-- The raw claim set PostgREST parsed out of the bearer token.
-- `true` on current_setting is missing_ok: outside a request there is no GUC,
-- and that must return an empty object rather than raising.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $function$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$function$;

-- The signed-in user's id.
--   Entra ID  -> `oid`  (the immutable object id; NOT `sub`, which is
--                        pairwise per-application and changes between apps)
--   Supabase  -> `sub`
-- Reading oid first and falling back to sub means one definition serves both
-- issuers, so the app can be pointed at Entra without a database change.
create or replace function auth.uid()
returns uuid
language sql
stable
as $function$
  select nullif(
    coalesce(
      auth.jwt() ->> 'oid',   -- Microsoft Entra ID
      auth.jwt() ->> 'sub'    -- Supabase GoTrue
    ), ''
  )::uuid;
$function$;

-- PostgREST puts the database role it switched to in `role`. GoTrue used the
-- same claim name, so policies that test auth.role() = 'authenticated' are
-- unaffected.
create or replace function auth.role()
returns text
language sql
stable
as $function$
  select coalesce(auth.jwt() ->> 'role', current_setting('role', true));
$function$;

-- Supabase exposes auth.email() and some policies/functions use it.
create or replace function auth.email()
returns text
language sql
stable
as $function$
  select auth.jwt() ->> 'email';
$function$;

comment on function auth.uid() is
  'Azure migration shim. Returns the Entra object id (oid) when present, else the Supabase subject (sub). Re-key profiles.id to Entra object ids at cutover and all 349 RLS policies work unchanged.';


-- ============================================================
-- Multifactor assurance under Entra
-- ============================================================
-- private.mfa_ok() (supabase_auth_hardening.sql §7) reads Supabase's `aal`
-- claim and the auth.mfa_factors table. Neither exists under Entra, where the
-- fact that MFA was performed arrives in `amr` (authentication methods
-- reference) — it contains 'mfa' when a second factor was satisfied.
--
-- Apply this ONLY at the Entra cutover, not before: while still on Supabase the
-- original definition is the correct one.
--
-- create or replace function private.mfa_ok()
-- returns boolean
-- language sql
-- stable
-- security definer
-- set search_path to 'public'
-- as $function$
--   select coalesce(auth.jwt() -> 'amr' ? 'mfa', false)
--       or coalesce(auth.jwt() ->> 'acr', '') = 'mfa';
-- $function$;
--
-- Conditional Access should require MFA for this application, so in practice
-- a token that reaches PostgREST at all has already satisfied it. Keeping the
-- check makes that a defence in depth rather than an assumption, and keeps the
-- ITSD I.2-1-1 answer true by inspection rather than by policy configuration.
