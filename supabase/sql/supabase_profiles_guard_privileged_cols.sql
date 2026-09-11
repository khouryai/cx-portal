-- ============================================================
-- supabase_profiles_guard_privileged_cols.sql
--
-- CAPTURED FROM THE LIVE DATABASE, NOT AUTHORED HERE.
--
-- Found on 2026-09-11 while applying supabase_auth_hardening.sql: `profiles`
-- carries TWO before-update guards, and only one of them
-- (private.guard_profile_privilege_changes, in supabase_perm_rls_granular.sql)
-- was recorded in this repo. This file closes that gap so the in-repo record of
-- the schema matches what is actually deployed — `supabase/sql/` is supposed to
-- be exactly that record (see README).
--
-- HOW THE TWO INTERACT
-- Trigger order is alphabetical, so:
--   1. trg_guard_profile_privilege        → logs the change to auth_events,
--                                           then blocks role / template changes
--                                           without the matching capability
--   2. trg_profiles_guard_privileged_cols → blocks role / is_active /
--                                           permission_template changes without
--                                           directory.edit, for ANY actor
-- Because (2) raises, a change it rejects is rolled back together with the
-- auth_events row (1) just wrote — denied attempts are therefore recorded from
-- the client instead, not by the trigger.
--
-- Note this guard has no service_role exemption: it applies to every caller,
-- which is why a direct `update profiles set is_active = …` from a privileged
-- SQL session is refused too.
--
-- NOT MODIFIED — reproduced verbatim from pg_get_functiondef() so the file can
-- be re-applied to rebuild an equivalent database.
-- ============================================================

create or replace function public.profiles_guard_privileged_cols()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if (new.role is distinct from old.role
      or new.is_active is distinct from old.is_active
      or new.permission_template_id is distinct from old.permission_template_id)
     and not private.has_module_perm('directory', 'edit')
  then
    raise exception 'Not authorized to change role, active status, or permission template (requires directory management).'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_profiles_guard_privileged_cols on public.profiles;
create trigger trg_profiles_guard_privileged_cols before update on public.profiles
  for each row execute function public.profiles_guard_privileged_cols();
