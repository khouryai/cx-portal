-- ============================================================================
-- Azure database: run AFTER restoring the backup.   (docs/AZURE_HOSTING.md, step 4)
--
--   psql "<admin connection>" -v ON_ERROR_STOP=1 -f supabase/sql/azure_after_restore.sql
-- ============================================================================

-- 1. MFA check. On Supabase, private.mfa_ok() read Supabase's own MFA tables,
--    which do not exist here; left alone, EVERY query errors and the app signs
--    in but shows empty lists. Entra reports the factors used in `amr`.
--    A profile that does not require MFA still passes (mfa_enforced = false),
--    exactly as on Supabase — Conditional Access is where MFA is enforced.
create or replace function private.mfa_ok()
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(auth.jwt() -> 'amr' ? 'mfa', false)
      or coalesce(auth.jwt() ->> 'acr', '') = 'mfa'
      or not coalesce(
           (select p.mfa_enforced from public.profiles p where p.id = (select auth.uid())),
           true);
$function$;

--    New profiles default to mfa_enforced = true, a Supabase-era setting. Under
--    Entra, Conditional Access performs MFA before any token is issued, and
--    whether the token then reports it in `amr` depends on the token version —
--    so leaving the default on risks shutting out every new person. MFA is
--    Entra's job here; make the app's own check opt-in.
alter table public.profiles alter column mfa_enforced set default false;
update public.profiles set mfa_enforced = false where mfa_enforced;

-- 2. Table privileges. The backup is restored without Supabase's grants (they
--    name Supabase-only roles). Without these the gateway answers 42501
--    "permission denied for table" — a privilege error, not a policy one.
--    Broad privileges with row-level security as the gate is Supabase's model,
--    unchanged.
grant usage on schema public, auth, private to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- 3. Microsoft's sign-in keys, kept current by the gateway's jwks-refresh helper.
\ir azure_pgrst_jwks.sql

-- 4. Linking a profile to a person's Entra account (used in step 4.5 and when
--    adding people later).
\ir azure_relink_profile.sql

-- 5. Tell a running gateway to re-read the schema.
notify pgrst, 'reload schema';
