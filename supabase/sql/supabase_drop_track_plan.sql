-- ============================================================================
-- Remove the abandoned "track plan" topology experiment (migration
-- drop_track_plan_experiment, project uqtwiucxktljhukmgmxg).
--
-- The track_* topology catalog was an import-based feature that was never wired
-- into the running app (no app.js code queried these tables). It is removed in
-- full: the tables, their RLS policies, the two track-only views
-- (vw_track_devices_unresolved, vw_track_sections_unresolved), and the
-- 'track_plan' permission module.
--
-- Dynamic Testing is intentionally UNAFFECTED: it keys off
-- dynamic_instances.track_section_under_test / track_section_access_req
-- (zone-code strings) and the zone_adjacency table, none of which are touched.
-- ============================================================================

drop table if exists
  public.track_devices,
  public.track_equations,
  public.track_mileposts,
  public.track_plan_imports,
  public.track_sections,
  public.track_zones,
  public.train_control_locations
cascade;  -- also drops dependent RLS policies and the vw_track_*_unresolved views

delete from public.perm_modules where key = 'track_plan';
