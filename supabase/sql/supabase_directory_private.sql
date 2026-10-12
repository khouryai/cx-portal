-- ============================================================================
-- The directory is private to those who manage it (2026-10).
-- ----------------------------------------------------------------------------
-- profiles held everyone's name, work email, company, role and status, and
-- every signed-in user could read all of it. Now:
--   * profiles: a person reads their OWN row; the whole directory needs the
--     Directory module's `view` right (or the Admin module's), set per
--     permission template like every other module;
--   * public.portal_people(): what every other screen needs, and nothing
--     more: the names and roles of active people, for "assigned to" and
--     similar pickers. No email, no company, no ids.
-- The app reads the name list through portal_people() (app.js
-- _loadProfileUsers).
--
-- Run once on Supabase (SQL editor). Idempotent. Carried to Azure by the
-- backup. Pinned by tools/test_directory_private.js against a real PostgreSQL.
-- ============================================================================

create or replace function public.portal_people()
returns table (full_name text, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name, p.role
  from public.profiles p
  where p.is_active
    and p.full_name is not null
    and (select auth.uid()) is not null      -- signed-in callers only
  order by p.full_name;
$$;

revoke all on function public.portal_people() from public;
revoke all on function public.portal_people() from anon;
grant execute on function public.portal_people() to authenticated;

alter policy profiles_select on public.profiles
  using (
    id = (select auth.uid())
    or (select private.has_module_perm('directory', 'view'))
    or (select private.has_module_perm('admin', 'view')));

notify pgrst, 'reload schema';
