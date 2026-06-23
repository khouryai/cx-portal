-- ============================================================
-- Security-advisor remediation (2026-06)
--
-- Clears two Supabase security linter findings:
--   • fn_clear_dynamic_sim_demo had a role-mutable search_path
--   • zone_adjacency had a single ALL policy with USING(true)/WITH CHECK(true),
--     so any signed-in user could rewrite the track adjacency map.
--
-- Applied live as migration: harden_sim_demo_fn_and_zone_adjacency_rls.
-- (The dyn occupancy functions were separately re-grant-revoked from
--  authenticated in dyn_harden_occupancy_function_grants.)
-- ============================================================

-- Pin the demo-clear helper's search_path.
create or replace function public.fn_clear_dynamic_sim_demo()
returns text language plpgsql
set search_path = public
as $function$
declare n_inst int; n_case int; n_pre int;
begin
  delete from public.test_item_prerequisites
    where test_id like 'SIMDEMO-%' or prerequisite_test_id like 'SIMDEMO-%';
  get diagnostics n_pre = row_count;
  delete from public.dynamic_instances where test_id like 'SIMDEMO-%';
  get diagnostics n_inst = row_count;
  delete from public.test_items where test_id like 'SIMDEMO-%';
  get diagnostics n_case = row_count;
  return format('Cleared SIMDEMO: %s test cases, %s instances, %s prerequisite edges', n_case, n_inst, n_pre);
end $function$;

-- zone_adjacency: keep reads open (reference data the simulator/allocator needs),
-- but gate writes to track_plan managers. Subselect form also avoids the per-row
-- auth re-evaluation performance lint.
drop policy if exists zone_adjacency_auth_all on zone_adjacency;

create policy zone_adjacency_sel on zone_adjacency
  for select to authenticated using (true);
create policy zone_adjacency_ins on zone_adjacency
  for insert to authenticated
  with check ((select private.has_module_perm('track_plan','manage')));
create policy zone_adjacency_upd on zone_adjacency
  for update to authenticated
  using ((select private.has_module_perm('track_plan','manage')))
  with check ((select private.has_module_perm('track_plan','manage')));
create policy zone_adjacency_del on zone_adjacency
  for delete to authenticated
  using ((select private.has_module_perm('track_plan','manage')));
