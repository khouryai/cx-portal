-- ============================================================
-- supabase_auth_hardening_rollout.sql
--
-- The deliberate STARTING STATE applied to the accounts that already existed
-- when supabase_auth_hardening.sql went in (2026-09-11, 6 active accounts).
-- Recorded as its own file because it is a roll-out decision, not part of the
-- mechanism: re-running the mechanism is safe, re-running this is not
-- necessarily what you want.
--
-- WHY IT IS STAGED
-- The column defaults in §1 of the mechanism are the policy for NEW accounts:
-- MFA enforced, rotation clock unset. Applying them retroactively to live
-- accounts would, at the very next sign-in, push all six users through an
-- authenticator enrolment AND a password change at once. Worse, if TOTP
-- enrolment is not yet enabled on the project, the enrolment card cannot
-- complete — and because the portal blocks entry until it does, every user,
-- including all five admins, would be locked out of a working production
-- system with no in-app way back.
--
-- So:
--   password_changed_at = now()   The six-month clock starts today instead of
--                                 firing a forced reset for everyone at once.
--                                 The mechanism is live and enforces on
--                                 schedule (ITSD I.2-4-2(20)).
--   mfa_enforced = false          MFA is available but not yet demanded.
--
-- Everything else went live immediately and needed no staging: the audit trail,
-- the lockout functions, and the RLS MFA gate — the gate only bites once an
-- account has a verified factor, so it is dormant until someone enrols.
--
-- TURNING MFA ON (the remaining step, once TOTP enrolment is confirmed working)
--   1. Enrol ONE admin end to end and confirm they can still sign in.
--   2. Then, per account:
--        update public.profiles set mfa_enforced = true where email = '...';
--   3. Keep at least one admin at mfa_enforced = false as a break-glass account
--      until every other account has a verified factor. A user who loses their
--      authenticator has no in-app recovery — an admin must delete the factor
--      (Supabase dashboard → Authentication → Users, or
--       delete from auth.mfa_factors where user_id = '...').
--   4. To make MFA mandatory for everyone rather than "mandatory once enrolled",
--      delete the second branch of the return in private.mfa_ok().
-- ============================================================

update public.profiles
   set password_changed_at = coalesce(password_changed_at, now()),
       mfa_enforced = false
 where password_changed_at is null or mfa_enforced is distinct from false;
