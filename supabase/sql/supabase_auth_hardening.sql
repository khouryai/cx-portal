-- ============================================================
-- supabase_auth_hardening.sql
--
-- Authentication hardening — the server half. Provides:
--
--   Multifactor authentication .... TOTP, enforced server-side inside
--                                   private.has_module_perm()
--   Password management ........... six-monthly rotation clock, plus account
--                                   lockout on repeated failures
--   Account disposal .............. six-monthly access-review evidence
--   Access logging ................ authentication events, repeated failures
--                                   and privilege escalation, retained for
--                                   more than one year
--
-- The browser half lives in cx-auth-hardening.js. Neither half depends on any
-- external identity system: this is all deliverable on the current platform.
--
-- Apply order: after supabase_perm_granular_catalog.sql and
-- supabase_perm_rls_granular.sql (it re-creates functions defined there).
-- Idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1. profiles — password rotation clock and per-user MFA policy
-- ============================================================
alter table public.profiles add column if not exists password_changed_at timestamptz;
alter table public.profiles add column if not exists mfa_enforced boolean not null default true;

comment on column public.profiles.password_changed_at is
  'Last password change (six-monthly rotation). Null = never changed since this column shipped; the client treats null as "rotate now".';
comment on column public.profiles.mfa_enforced is
  'When true the portal refuses to admit the account without a verified MFA factor. Set false only for a documented exception.';

-- These defaults are the policy for NEW accounts. For the accounts that already
-- existed when this was applied, the roll-out was staged deliberately — see
-- supabase_auth_hardening_rollout.sql for what was set and why.


-- ============================================================
-- 2. auth_events — the authentication / privilege audit trail  (O.1-5)
-- ============================================================
-- Kept separate from audit_log deliberately: audit_log records what a
-- SIGNED-IN user did, and its RLS lets any authenticated user write to it.
-- Authentication failures happen with no session at all, so those rows have to
-- be written by a SECURITY DEFINER routine instead — and a table that anonymous
-- callers can cause writes to must not share the readership of the business
-- audit log.
create table if not exists public.auth_events (
  id          bigserial primary key,
  email       text,
  user_id     uuid,
  event       text        not null,
  detail      text,
  created_at  timestamptz not null default now()
);

comment on table public.auth_events is
  'Authentication and privilege audit trail. Written only by SECURITY DEFINER functions; readable only with audit.view. Retention: 400 days (see the pg_cron job at the end of this file), which exceeds the one-year minimum.';

create index if not exists auth_events_email_time_idx on public.auth_events (email, created_at desc);
create index if not exists auth_events_event_time_idx on public.auth_events (event, created_at desc);
create index if not exists auth_events_user_time_idx  on public.auth_events (user_id, created_at desc);

alter table public.auth_events enable row level security;

-- Read: audit viewers only. There is deliberately NO insert/update/delete
-- policy, so even a signed-in user cannot write or tamper with the trail —
-- every write goes through the definer functions below.
drop policy if exists auth_events_sel on public.auth_events;
create policy auth_events_sel on public.auth_events
  for select to authenticated
  using ( (select private.has_module_perm('audit','view')) );

revoke all on public.auth_events from anon, authenticated;
grant select on public.auth_events to authenticated;


-- ============================================================
-- 3. auth_record_event() — append-only event recorder
-- ============================================================
-- Callable by anon because a failed sign-in has no session. Guarded so it
-- cannot be used to grow the table without bound, and it accepts only a fixed
-- vocabulary of event names.
create or replace function public.auth_record_event(
  p_email  text,
  p_event  text,
  p_detail text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email  text;
  v_recent integer;
begin
  if p_event is null or p_event not in (
       'login_failure', 'login_success', 'login_blocked',
       'mfa_challenge_failure', 'mfa_enrolled', 'mfa_unenrolled',
       'password_changed', 'privilege_change_denied'
     ) then
    return;
  end if;

  v_email := lower(left(trim(coalesce(p_email, '')), 200));
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    return;
  end if;

  -- Flood guard: an anonymous caller can generate at most 60 rows per address
  -- per hour. Beyond that the events are dropped, not stored — the lockout
  -- decision below only ever needs the first handful inside its window.
  select count(*) into v_recent
  from auth_events
  where email = v_email and created_at > now() - interval '1 hour';
  if v_recent >= 60 then return; end if;

  insert into auth_events (email, user_id, event, detail)
  values (v_email, auth.uid(), p_event, left(coalesce(p_detail, ''), 500));
end;
$function$;

grant execute on function public.auth_record_event(text, text, text) to anon, authenticated;


-- ============================================================
-- 4. auth_login_gate() — lockout decision for the sign-in screen
-- ============================================================
-- Returns the same shape for every address, including ones that do not exist,
-- so it cannot be used to enumerate accounts.
create or replace function public.auth_login_gate(p_email text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email        text;
  v_failures     integer := 0;
  v_last         timestamptz;
  v_last_success timestamptz;
  v_window   constant interval := interval '15 minutes';
  v_lockout  constant interval := interval '15 minutes';
  v_max      constant integer  := 5;
begin
  v_email := lower(left(trim(coalesce(p_email, '')), 200));
  if v_email = '' then
    return json_build_object('locked', false, 'retry_after', 0, 'remaining', v_max);
  end if;

  -- A successful sign-in ends the streak. The failure rows stay in the trail
  -- for O.1-5; they simply stop counting toward a lockout.
  select max(ae.created_at) into v_last_success
  from auth_events ae
  where ae.email = v_email and ae.event = 'login_success';

  select count(*), max(ae.created_at) into v_failures, v_last
  from auth_events ae
  where ae.email = v_email
    and ae.event = 'login_failure'
    and ae.created_at > now() - v_window
    and ae.created_at > coalesce(v_last_success, '-infinity'::timestamptz);

  if v_failures >= v_max then
    return json_build_object(
      'locked', true,
      'retry_after', greatest(0, ceil(extract(epoch from (v_last + v_lockout - now()))))::integer,
      'remaining', 0);
  end if;

  return json_build_object('locked', false, 'retry_after', 0, 'remaining', v_max - v_failures);
end;
$function$;

grant execute on function public.auth_login_gate(text) to anon, authenticated;

-- Both of the above are deliberately anon-callable and the Supabase security
-- advisor flags them as such; that is accepted, because a failed sign-in has no
-- session. They are hardened for it: a fixed event vocabulary, an address
-- format check, a 60-rows-per-hour-per-address flood guard, and a response
-- shape identical for addresses that do not exist.
comment on function public.auth_record_event(text, text, text) is
  'Deliberately anon-callable: failed sign-ins have no session. Append-only, fixed event vocabulary, flood-guarded.';
comment on function public.auth_login_gate(text) is
  'Deliberately anon-callable: consulted by the sign-in screen before authentication. Returns an identical shape for unknown addresses so it cannot enumerate accounts.';


-- ============================================================
-- 5. password_verification_attempt() — SERVER-SIDE lockout   (I.2-4-2(30))
-- ============================================================
-- The gate in §4 is what the sign-in screen consults, but a client-side gate
-- only stops the portal's own form. This function is a Supabase Auth Hook: it
-- runs inside GoTrue on every password verification, so it also covers anyone
-- calling the auth endpoint directly.
--
--   ENABLE IT IN THE DASHBOARD:  Authentication → Hooks →
--   "Password Verification Attempt" → Postgres → public.password_verification_attempt
--   Until it is enabled this function is inert and lockout is client-side only.
--
-- Payload: { "user_id": uuid, "valid": boolean }
-- Response: { "decision": "continue" | "reject", "message": text }
create or replace function public.password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id      uuid;
  v_valid        boolean;
  v_email        text;
  v_failures     integer := 0;
  v_last_success timestamptz;
  v_window   constant interval := interval '15 minutes';
  v_max      constant integer  := 5;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_valid   := coalesce((event ->> 'valid')::boolean, false);

  select lower(p.email) into v_email from profiles p where p.id = v_user_id;

  if v_valid then
    -- A correct password ends the streak. Failure rows are never deleted —
    -- O.1-5 wants the record of repeated failures kept; they just stop
    -- counting, because the count below only looks after the last success.
    insert into auth_events (email, user_id, event, detail)
    values (v_email, v_user_id, 'login_success', 'password verified');
    return jsonb_build_object('decision', 'continue');
  end if;

  select max(ae.created_at) into v_last_success
  from auth_events ae
  where ae.user_id = v_user_id and ae.event = 'login_success';

  select count(*) into v_failures
  from auth_events ae
  where ae.user_id = v_user_id
    and ae.event = 'login_failure'
    and ae.created_at > now() - v_window
    and ae.created_at > coalesce(v_last_success, '-infinity'::timestamptz);

  insert into auth_events (email, user_id, event, detail)
  values (v_email, v_user_id, 'login_failure', 'password rejected');

  if v_failures + 1 >= v_max then
    insert into auth_events (email, user_id, event, detail)
    values (v_email, v_user_id, 'login_blocked',
            format('locked after %s failed attempts in %s', v_failures + 1, v_window));
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Too many failed sign-in attempts. This account is locked for 15 minutes.');
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$function$;


-- ============================================================
-- 6. mfa_verification_attempt() — lockout on repeated MFA failures
-- ============================================================
--   ENABLE IT IN THE DASHBOARD:  Authentication → Hooks →
--   "MFA Verification Attempt" → Postgres → public.mfa_verification_attempt
--
-- Payload: { "user_id": uuid, "factor_id": uuid, "valid": boolean }
create or replace function public.mfa_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id  uuid;
  v_valid    boolean;
  v_email    text;
  v_failures integer := 0;
  v_window   constant interval := interval '15 minutes';
  v_max      constant integer  := 5;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_valid   := coalesce((event ->> 'valid')::boolean, false);
  select lower(p.email) into v_email from profiles p where p.id = v_user_id;

  if v_valid then
    return jsonb_build_object('decision', 'continue');
  end if;

  select count(*) into v_failures
  from auth_events ae
  where ae.user_id = v_user_id
    and ae.event = 'mfa_challenge_failure'
    and ae.created_at > now() - v_window;

  insert into auth_events (email, user_id, event, detail)
  values (v_email, v_user_id, 'mfa_challenge_failure', 'authenticator code rejected');

  if v_failures + 1 >= v_max then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Too many incorrect authentication codes. Try again in 15 minutes.');
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$function$;

-- Auth hooks run as supabase_auth_admin, and must NOT be callable by clients.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema public to supabase_auth_admin';
    execute 'grant execute on function public.password_verification_attempt(jsonb) to supabase_auth_admin';
    execute 'grant execute on function public.mfa_verification_attempt(jsonb) to supabase_auth_admin';
    execute 'grant insert, select, delete on table public.auth_events to supabase_auth_admin';
    execute 'grant usage, select on sequence public.auth_events_id_seq to supabase_auth_admin';
    execute 'grant select on table public.profiles to supabase_auth_admin';
  end if;
end $$;

revoke execute on function public.password_verification_attempt(jsonb) from anon, authenticated, public;
revoke execute on function public.mfa_verification_attempt(jsonb)      from anon, authenticated, public;


-- ============================================================
-- 7. private.mfa_ok() + the has_module_perm gate               (I.2-1-1)
-- ============================================================
-- Enforcing MFA in the browser alone would be theatre: an AAL1 session is a
-- valid session, and PostgREST would happily serve it. Every governed table in
-- this database routes its RLS through private.has_module_perm(), so adding the
-- check there enforces MFA server-side for all ~325 policies at one choke point.
--
-- ROLL-OUT SAFETY: the check only bites once a user actually has a verified
-- factor. Users who have not enrolled yet keep working exactly as before, so
-- this can ship before anyone has enrolled. To make MFA mandatory for everyone
-- (rather than "mandatory once enrolled"), delete the second branch of the
-- return below — that one line is the hard cut-over.
create or replace function private.mfa_ok()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = (select auth.uid()) and f.status = 'verified'
    );
$function$;

comment on function private.mfa_ok() is
  'True when the session has completed multifactor authentication, or when the user has no verified factor yet (graceful roll-out). Called by private.has_module_perm().';

-- Re-created verbatim from supabase_perm_granular_catalog.sql with ONE addition:
-- the private.mfa_ok() gate immediately after the null-uid check.
create or replace function private.has_module_perm(p_module text, p_action text default 'view')
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_level text;
  v_grants jsonb := '{}'::jsonb;
  v_o_level text;
  v_o_grants jsonb;
  v_eff boolean;
begin
  if v_uid is null then return false; end if;
  -- a session that has not cleared its second factor gets nothing.
  if not private.mfa_ok() then return false; end if;
  if not exists (select 1 from profiles where id = v_uid and is_active) then
    return false;
  end if;
  if exists (select 1 from profiles where id = v_uid and role = 'admin' and is_active) then
    return true;
  end if;
  select tmp.level, tmp.grants into v_level, v_grants
  from profiles pr
  join template_module_perms tmp
    on tmp.template_id = pr.permission_template_id and tmp.module_key = p_module
  where pr.id = v_uid;
  v_level := coalesce(v_level, 'none');
  v_grants := coalesce(v_grants, '{}'::jsonb);
  select o.level, o.grants into v_o_level, v_o_grants
  from user_module_overrides o
  where o.user_id = v_uid and o.module_key = p_module;
  if v_o_level is not null then v_level := v_o_level; end if;
  if v_o_grants is not null then v_grants := v_grants || v_o_grants; end if;
  v_eff := p_action = any(private._perm_baseline(p_module, v_level));
  if v_grants ? p_action then
    v_eff := (v_grants ->> p_action)::boolean;
  end if;
  return coalesce(v_eff, false);
end;
$function$;


-- ============================================================
-- 8. Privilege-change logging                                  (O.1-5)
-- ============================================================
-- Re-created from supabase_perm_rls_granular.sql (verified against the LIVE
-- definition before replacing) with the same enforcement, plus an auth_events
-- row for every privilege change.
--
-- Logging happens BEFORE the "service_role / internal: trusted" shortcut, so a
-- change made directly against the database — the dashboard, a service-role
-- key, a psql session — is recorded too. O.1-5 wants the record of privilege
-- escalation regardless of who made it.
--
-- Denied attempts raise, which rolls back any row written in the same
-- statement, so those are recorded from the client instead
-- (cx-auth-hardening.js -> auth_record_event('privilege_change_denied', ...)).
--
-- NOTE: profiles carries a SECOND, independent guard,
-- public.profiles_guard_privileged_cols() — see
-- supabase_profiles_guard_privileged_cols.sql. It fires after this one
-- (alphabetical trigger order) and blocks role / is_active /
-- permission_template changes outright without directory.edit.
create or replace function private.guard_profile_privilege_changes()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_actor uuid := (select auth.uid());
  v_who   text := coalesce((select auth.uid())::text, coalesce((select auth.role()), 'system'));
begin
  -- 1. Record. Any actor, before any early return.
  if new.role is distinct from old.role then
    insert into auth_events (email, user_id, event, detail)
    values (lower(new.email), new.id, 'privilege_change',
            format('role %s -> %s (by %s)', coalesce(old.role,'null'), coalesce(new.role,'null'), v_who));
  end if;
  if new.permission_template_id is distinct from old.permission_template_id then
    insert into auth_events (email, user_id, event, detail)
    values (lower(new.email), new.id, 'privilege_change',
            format('permission_template %s -> %s (by %s)', coalesce(old.permission_template_id::text,'null'),
                   coalesce(new.permission_template_id::text,'null'), v_who));
  end if;
  if new.is_active is distinct from old.is_active then
    insert into auth_events (email, user_id, event, detail)
    values (lower(new.email), new.id, 'privilege_change',
            format('is_active %s -> %s (by %s)', old.is_active, new.is_active, v_who));
  end if;
  if new.mfa_enforced is distinct from old.mfa_enforced then
    insert into auth_events (email, user_id, event, detail)
    values (lower(new.email), new.id, 'privilege_change',
            format('mfa_enforced %s -> %s (by %s)', old.mfa_enforced, new.mfa_enforced, v_who));
  end if;

  -- 2. Enforce. Unchanged from the original guard.
  if coalesce((select auth.role()), '') <> 'authenticated' then
    return new;  -- service_role / internal: trusted
  end if;
  if new.role is distinct from old.role
     and not private.has_module_perm('directory','grant_global_admin') then
    raise exception 'permission denied: changing role requires directory.grant_global_admin';
  end if;
  if new.permission_template_id is distinct from old.permission_template_id
     and not private.has_module_perm('directory','assign_template') then
    raise exception 'permission denied: changing permission_template_id requires directory.assign_template';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_profile_privilege on public.profiles;
create trigger trg_guard_profile_privilege before update on public.profiles
  for each row execute function private.guard_profile_privilege_changes();

-- 'privilege_change' is written by the trigger, never by a client, so it is
-- deliberately absent from auth_record_event()'s accepted vocabulary.


-- ============================================================
-- 9. Six-monthly access review evidence                        (I.2-5-2(20))
-- ============================================================
-- The review itself is a process, but it needs a record. This view is what the
-- reviewer works from, and completing a review is one insert into
-- access_review_log.
create table if not exists public.access_review_log (
  id            bigserial primary key,
  reviewed_by   uuid,
  reviewed_at   timestamptz not null default now(),
  accounts_seen integer,
  accounts_removed integer,
  notes         text
);

alter table public.access_review_log enable row level security;

drop policy if exists access_review_log_sel on public.access_review_log;
create policy access_review_log_sel on public.access_review_log
  for select to authenticated
  using ( (select private.has_module_perm('audit','view')) );

drop policy if exists access_review_log_ins on public.access_review_log;
create policy access_review_log_ins on public.access_review_log
  for insert to authenticated
  with check ( (select private.has_module_perm('directory','edit_profile')) );

create or replace view public.access_review_due as
  select
    (select max(reviewed_at) from access_review_log)                                as last_review_at,
    (select max(reviewed_at) from access_review_log) + interval '6 months'          as next_review_due,
    (coalesce((select max(reviewed_at) from access_review_log), 'epoch'::timestamptz)
       + interval '6 months') < now()                                              as overdue,
    (select count(*) from profiles where is_active)                                 as active_accounts,
    (select count(*) from profiles p
      where p.is_active
        and not exists (select 1 from auth_events e
                        where e.user_id = p.id and e.event = 'login_success'
                          and e.created_at > now() - interval '90 days'))           as dormant_90d;

-- Run the view as the caller so the RLS above still applies (a definer view
-- would hand these counts to anyone signed in).
alter view public.access_review_due set (security_invoker = on);

comment on view public.access_review_due is
  'Drives the six-monthly access review: when it was last done, whether it is overdue, and which active accounts have not signed in for 90 days.';


-- ============================================================
-- 10. Retention                                                (O.1-5)
-- ============================================================
-- The requirement is a MINIMUM of one year. 400 days keeps a full year plus a
-- margin, while bounding a table that anonymous callers can cause writes to.
-- audit_log is deliberately NOT purged — business audit history is kept.
create or replace function public.purge_auth_events()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_deleted integer;
begin
  delete from auth_events where created_at < now() - interval '400 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

-- `create function` grants EXECUTE to PUBLIC by default, which made this
-- reachable at /rest/v1/rpc/purge_auth_events — a tamper vector on the audit
-- trail itself. Caught by the Supabase security advisor; only the cron job
-- (running as the table owner) needs it.
revoke execute on function public.purge_auth_events() from public, anon, authenticated;

comment on function public.purge_auth_events() is
  'Audit-trail retention (400 days). EXECUTE revoked from clients; invoked only by the purge-auth-events pg_cron job.';

create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-auth-events') then
    perform cron.unschedule('purge-auth-events');
  end if;
  perform cron.schedule('purge-auth-events', '30 3 * * 0',
    $cmd$ select purge_auth_events(); $cmd$);
end $$;
