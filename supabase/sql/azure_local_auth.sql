-- ============================================================
-- azure_local_auth.sql
--
-- EMAIL + PASSWORD SIGN-IN ON THE AZURE STACK, WITHOUT SUPABASE AND WITHOUT
-- MICROSOFT ENTRA.
--
-- WHY THIS FILE EXISTS. Supabase is two services, not one: PostgREST serves the
-- data, GoTrue checked passwords and minted the JWT. The Azure build kept
-- PostgREST and left GoTrue behind, and PostgREST only ever VALIDATES tokens —
-- it has no login endpoint. So moving off Supabase removed the one component
-- that could turn a password into a session. This file puts that component
-- back, inside the database, which is the documented PostgREST pattern.
--
-- WHAT IT GIVES YOU: the sign-in screen behaves exactly as it did on Supabase —
-- email and password, lockout, the six-monthly rotation clock, must-change on
-- first sign-in. No redirect anywhere.
--
-- WHAT YOU TAKE ON, STATED PLAINLY, because it is the real cost of this choice:
--   * You own credential storage. bcrypt via pgcrypto is used below, which is
--     the right primitive, but the operational burden (rotation, breach
--     response, offboarding) is now yours rather than an identity provider's.
--   * There is no password-reset email, because nothing here can send mail.
--     A reset is an administrator running auth.set_password() in psql.
--   * Hitachi IT will review this as a homegrown credential store. Entra exists
--     precisely so applications do not have to hold passwords, and the switch
--     back is deliberately small — see THE WAY BACK at the foot of this file.
--
-- IT COMPOSES WITH THE REST OF THE MIGRATION UNCHANGED:
--   * auth.uid() (azure_auth_uid_shim.sql) reads `oid` and falls back to `sub`.
--     Tokens minted here carry `sub` = profiles.id, so all 349 RLS policies
--     resolve with no re-keying and no policy edits.
--   * private.mfa_ok() is the ORIGINAL Supabase definition, which passes when a
--     user has no verified factor. auth.mfa_factors is recreated (empty) below
--     so that definition keeps working verbatim rather than being rewritten.
--
-- APPLY ORDER:  azure_auth_uid_shim.sql  ->  the schema dump  ->  THIS FILE.
-- Proven end to end by tools/test_local_auth.js against a real PostgreSQL.
-- ============================================================

create extension if not exists pgcrypto;

create schema if not exists auth;
create schema if not exists private;

-- Re-asserted here rather than assumed from the shim or the dump: a restore
-- run with --no-privileges strips it, and the failure it causes ("permission
-- denied for schema auth" on every authenticated request) looks like broken
-- RLS rather than a missing grant.
grant usage on schema auth to anon, authenticated;


-- ============================================================
-- 1. The signing secret
-- ============================================================
-- Kept in a table with NO grants rather than a database GUC: a GUC set with
-- ALTER DATABASE is readable by every role that can connect, including `anon`.
-- Here only the SECURITY DEFINER functions below can see it.
create table if not exists private.auth_secrets (
  name  text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.auth_secrets from public;

-- The value must match PGRST_JWT_SECRET exactly, or every token this file mints
-- is rejected with JWSError. Set both from one generated value:
--   openssl rand -base64 48
create or replace function auth.set_jwt_secret(p_secret text)
returns void
language sql
as $function$
  insert into private.auth_secrets (name, value)
  values ('jwt_secret', p_secret)
  on conflict (name) do update set value = excluded.value, updated_at = now();
$function$;

create or replace function auth.jwt_secret()
returns text
language sql
stable
security definer
set search_path to 'private', 'pg_temp'
as $function$
  select value from private.auth_secrets where name = 'jwt_secret';
$function$;


-- ============================================================
-- 2. JWT signing  (the pgjwt construction, inlined)
-- ============================================================
-- Inlined rather than depending on the pgjwt extension, which is not available
-- on Azure Database for PostgreSQL. pgcrypto's hmac() is, and is all this needs.
create or replace function auth.url_encode(data bytea)
returns text
language sql
immutable
as $function$
  -- base64url: '+'->'-', '/'->'_', and '=' / newline dropped (translate deletes
  -- any character in `from` with no counterpart in `to`).
  select translate(encode(data, 'base64'), E'+/=\n', '-_');
$function$;

create or replace function auth.sign_jwt(p_claims jsonb)
returns text
language sql
stable
security definer
set search_path to 'auth', 'pg_temp'
as $function$
  with parts as (
    select auth.url_encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8')) || '.' ||
           auth.url_encode(convert_to(p_claims::text, 'utf8')) as signables
  )
  select signables || '.' ||
         auth.url_encode(public.hmac(signables, auth.jwt_secret(), 'sha256'))
  from parts;
$function$;


-- ============================================================
-- 3. Credential storage — GoTrue's shape, deliberately
-- ============================================================
-- Same table and column names Supabase used, so the mental model, the runbook
-- and private.mfa_ok() all carry over without translation.
create table if not exists auth.users (
  id                 uuid primary key,
  email              text not null,
  encrypted_password text,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  banned_until       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists users_email_lower_idx on auth.users (lower(email));

-- Recreated EMPTY and on purpose. private.mfa_ok() (supabase_auth_hardening.sql
-- §7) reads this table and passes when the user has no verified factor. Leaving
-- the table absent would make that function error on every authorization check;
-- recreating it empty means the original definition keeps working verbatim and
-- TOTP can be added later without another migration.
create table if not exists auth.mfa_factors (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type   text not null default 'totp',
  status        text not null default 'unverified',
  secret        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists mfa_factors_user_idx on auth.mfa_factors (user_id);

revoke all on auth.users from public;
revoke all on auth.mfa_factors from public;
-- private.mfa_ok() is SECURITY DEFINER, so it reads auth.mfa_factors as its
-- owner; no grant to authenticated is needed or wanted.


-- ============================================================
-- 4. Password policy, enforced in the database
-- ============================================================
-- cx-auth-hardening.js applies the same rule in the browser. The browser is not
-- the enforcement point — a password set through any other path must still meet
-- it, so the rule lives here too. Keep the two in step (POLICY in that file).
create or replace function auth.check_password_policy(p_password text)
returns void
language plpgsql
immutable
as $function$
declare
  classes int := 0;
begin
  if p_password is null or length(p_password) < 12 then
    raise exception 'Password must be at least 12 characters.' using errcode = '22023';
  end if;
  if p_password ~ '[a-z]' then classes := classes + 1; end if;
  if p_password ~ '[A-Z]' then classes := classes + 1; end if;
  if p_password ~ '[0-9]' then classes := classes + 1; end if;
  if p_password ~ '[^a-zA-Z0-9]' then classes := classes + 1; end if;
  if classes < 3 then
    raise exception 'Password must mix at least 3 of: lower case, upper case, numbers, symbols.'
      using errcode = '22023';
  end if;
end;
$function$;


-- ============================================================
-- 5. Administrative password set  — psql only, BY DESIGN
-- ============================================================
-- This lives in the `auth` schema, and PostgREST is configured with
-- PGRST_DB_SCHEMAS=public. That is not a convention, it is the control: no
-- HTTP request can reach this function, whatever role it presents. It is how
-- you seed the first account and how you perform a password reset, since
-- nothing in this stack can send email.
--
--   select auth.set_password('alex@hitachirail.com', 'a-real-passphrase');
--
-- The profile row must already exist; the account id is taken from it, so
-- auth.uid() keeps resolving to the same uuid every RLS policy already uses.
create or replace function auth.set_password(p_email text, p_password text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  perform auth.check_password_policy(p_password);

  select p.id into v_id from public.profiles p
   where lower(p.email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'No profile with email %. Create the profile row first — its id is the identity every RLS policy already uses.', p_email
      using errcode = 'P0002';
  end if;

  insert into auth.users (id, email, encrypted_password, email_confirmed_at)
  values (v_id, lower(trim(p_email)), crypt(p_password, gen_salt('bf', 12)), now())
  on conflict (id) do update
    set encrypted_password = excluded.encrypted_password,
        email              = excluded.email,
        updated_at         = now();

  -- Starts the six-monthly rotation clock that cx-auth-hardening.js reads.
  update public.profiles
     set password_changed_at = now()
   where id = v_id;

  return v_id;
end;
$function$;


-- ============================================================
-- 6. login()  — the endpoint that replaces GoTrue
-- ============================================================
-- POST /rpc/login {"p_email": "...", "p_password": "..."}
--
-- Returns the SAME session shape supabase-js returned, because everything above
-- cx-auth-provider.js reads session.access_token, session.expires_at and
-- session.user.id. Matching the shape is what keeps those call sites untouched.
--
-- TIMING: the password is verified against a dummy hash when the account does
-- not exist, so a missing account and a wrong password take the same time and
-- the response cannot be used to enumerate who has an account.
create or replace function public.login(p_email text, p_password text)
returns json
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_user    auth.users%rowtype;
  v_profile public.profiles%rowtype;
  v_ttl     int  := 8 * 60 * 60;          -- eight hours: one working shift
  v_now     timestamptz := now();
  v_exp     int;
  v_claims  jsonb;
  v_ok      boolean := false;
  -- bcrypt hash of a value no one can present; only ever used to burn time.
  v_dummy   text := '$2a$12$C6UzMDM.H6dfI/f/IKcEe.2Y3yZ0m0bJfF1uJqfQ0Qe0kZ0e0kZ0e';
begin
  select * into v_user from auth.users u where lower(u.email) = v_email;

  if v_user.id is null then
    perform crypt(coalesce(p_password, ''), v_dummy);   -- constant-ish time
  else
    v_ok := v_user.encrypted_password is not null
        and v_user.encrypted_password = crypt(coalesce(p_password, ''), v_user.encrypted_password);
  end if;

  if v_user.id is not null and v_user.banned_until is not null and v_user.banned_until > v_now then
    raise exception 'This account is suspended. Contact your administrator.' using errcode = '28000';
  end if;

  if not v_ok then
    raise exception 'Invalid login credentials' using errcode = '28P01';
  end if;

  select * into v_profile from public.profiles p where p.id = v_user.id;
  if v_profile.id is null then
    raise exception 'This account has no portal profile. Contact your administrator.' using errcode = '28000';
  end if;
  if v_profile.is_active is false then
    raise exception 'This account has been deactivated. Contact your administrator.' using errcode = '28000';
  end if;

  update auth.users set last_sign_in_at = v_now where id = v_user.id;

  v_exp := extract(epoch from v_now)::int + v_ttl;

  -- CLAIM SHAPE IS LOAD-BEARING, and each one is read by something specific:
  --   sub    -> auth.uid() (the shim falls back to it when `oid` is absent),
  --             so every RLS policy resolves with no re-keying.
  --   roles  -> PGRST_JWT_ROLE_CLAIM_KEY is '.roles[0]'; this is what makes
  --             PostgREST switch the database role away from `anon`. Kept as an
  --             array, identical to Entra's shape, so returning to Entra is a
  --             change of secret and audience only.
  --   role   -> auth.role(), used by policies that test it directly.
  --   aal    -> private.mfa_ok(). 'aal1' here; the original definition passes
  --             because the user has no verified factor in auth.mfa_factors.
  v_claims := jsonb_build_object(
    'sub',   v_user.id,
    'email', v_user.email,
    'role',  'authenticated',
    'roles', jsonb_build_array('authenticated'),
    'aal',   'aal1',
    'iss',   'cx-portal',
    'aud',   'cx-portal',
    'iat',   extract(epoch from v_now)::int,
    'exp',   v_exp
  );

  return json_build_object(
    'access_token', auth.sign_jwt(v_claims),
    'token_type',   'bearer',
    'expires_in',   v_ttl,
    'expires_at',   v_exp,
    'user', json_build_object(
      'id',    v_user.id,
      'email', v_user.email,
      'user_metadata', json_build_object('full_name', v_profile.full_name),
      'app_metadata',  json_build_object('provider', 'postgrest')
    )
  );
end;
$function$;

revoke all on function public.login(text, text) from public;
grant execute on function public.login(text, text) to anon, authenticated;


-- ============================================================
-- 7. auth_refresh()  — extend a session that is already valid
-- ============================================================
-- There is no refresh TOKEN, and that is the point: PostgREST has already
-- verified the bearer token's signature and expiry before this function runs,
-- so possession of a live session is the only credential it needs. Nothing
-- long-lived is stored in the browser to be stolen.
create or replace function public.auth_refresh()
returns json
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_user    auth.users%rowtype;
  v_profile public.profiles%rowtype;
  v_ttl     int  := 8 * 60 * 60;
  v_now     timestamptz := now();
  v_exp     int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select * into v_user    from auth.users u    where u.id = v_uid;
  select * into v_profile from public.profiles p where p.id = v_uid;
  if v_user.id is null or v_profile.id is null or v_profile.is_active is false then
    raise exception 'This account is no longer active.' using errcode = '28000';
  end if;

  v_exp := extract(epoch from v_now)::int + v_ttl;

  return json_build_object(
    'access_token', auth.sign_jwt(jsonb_build_object(
      'sub',   v_uid,
      'email', v_user.email,
      'role',  'authenticated',
      'roles', jsonb_build_array('authenticated'),
      'aal',   'aal1',
      'iss',   'cx-portal',
      'aud',   'cx-portal',
      'iat',   extract(epoch from v_now)::int,
      'exp',   v_exp
    )),
    'token_type', 'bearer',
    'expires_in', v_ttl,
    'expires_at', v_exp,
    'user', json_build_object(
      'id',    v_uid,
      'email', v_user.email,
      'user_metadata', json_build_object('full_name', v_profile.full_name),
      'app_metadata',  json_build_object('provider', 'postgrest')
    )
  );
end;
$function$;

revoke all on function public.auth_refresh() from public;
grant execute on function public.auth_refresh() to authenticated;


-- ============================================================
-- 8. change_password()  — first sign-in and the rotation clock
-- ============================================================
-- Drives both app.js's must_change_password card and cx-auth-hardening.js's
-- six-monthly rotation card.
--
-- p_current IS OPTIONAL, MATCHING SUPABASE. GoTrue's updateUser({password})
-- did not ask for the current password either — the session was the proof — and
-- neither card in index.html has a field for one. Requiring it here would break
-- both flows on the first sign-in, which is exactly when they run.
--
-- THE TRADE-OFF, SO IT IS A DECISION AND NOT AN OVERSIGHT: a token lifted from
-- an unlocked machine can change the password without knowing the old one. That
-- was equally true on Supabase. When the current password IS supplied it is
-- verified, so hardening this later is a form field and a caller change, not a
-- migration: add the input, pass it as p_current, and make the null branch below
-- raise instead.
create or replace function public.change_password(p_current text default null, p_new text default null)
returns json
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_uid  uuid := auth.uid();
  v_user auth.users%rowtype;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select * into v_user from auth.users u where u.id = v_uid;
  if v_user.id is null then
    raise exception 'No credential on file for this account.' using errcode = '28000';
  end if;

  -- Verified when offered, skipped when not; see the note above the function.
  if p_current is not null and p_current <> '' then
    if v_user.encrypted_password is null
       or v_user.encrypted_password <> crypt(p_current, v_user.encrypted_password) then
      raise exception 'Your current password is not correct.' using errcode = '28P01';
    end if;
  end if;

  perform auth.check_password_policy(p_new);

  if crypt(p_new, v_user.encrypted_password) = v_user.encrypted_password then
    raise exception 'Choose a password you have not used before.' using errcode = '22023';
  end if;

  update auth.users
     set encrypted_password = crypt(p_new, gen_salt('bf', 12)),
         updated_at = now()
   where id = v_uid;

  update public.profiles
     set password_changed_at   = now(),
         must_change_password  = false
   where id = v_uid;

  return json_build_object('ok', true);
end;
$function$;

revoke all on function public.change_password(text, text) from public;
grant execute on function public.change_password(text, text) to authenticated;


-- ============================================================
-- THE WAY BACK TO ENTRA
-- ============================================================
-- Nothing here is a one-way door. The app, the schema and all 349 policies are
-- issuer-agnostic; only two settings and one claim source differ:
--
--   local passwords          Microsoft Entra
--   ---------------          ---------------
--   PGRST_JWT_SECRET = the shared secret in private.auth_secrets
--                            PGRST_JWT_SECRET = Entra's JWKS
--   PGRST_JWT_AUD    = 'cx-portal'
--                            PGRST_JWT_AUD    = the application (client) id
--   CX_CONFIG.IDENTITY = 'postgrest'
--                            CX_CONFIG.IDENTITY = 'entra'
--   auth.uid() reads `sub`   auth.uid() reads `oid`  (the shim already does both)
--
-- PGRST_JWT_ROLE_CLAIM_KEY stays '.roles[0]' either way, which is why login()
-- above emits `roles` as an array it does not otherwise need.
--
-- The one data step when switching to Entra is re-keying profiles.id to each
-- user's Entra object id, exactly as azure_auth_uid_shim.sql describes. Drop
-- auth.users at that point: leaving password hashes behind an identity provider
-- that no longer consults them is how credential stores outlive their purpose.
