-- ============================================================================
-- Granular RLS conversion — pilot batch (test_register + photos)
--
-- In-repo record of applied migrations (project uqtwiucxktljhukmgmxg):
--   rls_test_register_granular_keys
--   rls_photos_granular_ownership_keys
--
-- Converts the coarse legacy-verb policies on these tables to the granular
-- capability keys (PERMISSIONS_MODEL.md). SELECT stays 'view'. Writes OR the
-- capabilities that legitimately perform each command so granular revocation
-- bites at the DB without false denials. Photos ownership mirrors the UI
-- (uploaded_by / created_by === userName(), which equals the signed-in user's
-- profiles.full_name) — no column migration required. Each has_module_perm call
-- is wrapped in its own subselect (initplan-friendly).
--
-- Original policies were all `(select private.has_module_perm('<mod>','<verb>'))`
-- with no other predicates (no subsystem scoping), so only the action vocabulary
-- changed. SELECT policies are unchanged (still 'view') and omitted here.
-- ============================================================================

-- ── rls_test_register_granular_keys ─────────────────────────────────────────
alter policy test_items_ins on public.test_items
  with check ( (select private.has_module_perm('test_register','add_test_case'))
            or (select private.has_module_perm('test_register','add_activity')) );
alter policy test_items_upd on public.test_items
  using ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','set_status'))
       or (select private.has_module_perm('test_register','deploy_field'))
       or (select private.has_module_perm('test_register','bulk_edit'))
       or (select private.has_module_perm('test_register','manage_assets')) )
  with check ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','set_status'))
       or (select private.has_module_perm('test_register','deploy_field'))
       or (select private.has_module_perm('test_register','bulk_edit'))
       or (select private.has_module_perm('test_register','manage_assets')) );
alter policy test_items_del on public.test_items
  using ( (select private.has_module_perm('test_register','delete_case'))
       or (select private.has_module_perm('test_register','delete_activity'))
       or (select private.has_module_perm('test_register','bulk_delete')) );

alter policy test_procedures_ins on public.test_procedures
  with check ( (select private.has_module_perm('test_register','add_test_case'))
            or (select private.has_module_perm('test_register','add_activity')) );
alter policy test_procedures_upd on public.test_procedures
  using ( (select private.has_module_perm('test_register','edit_case')) )
  with check ( (select private.has_module_perm('test_register','edit_case')) );
alter policy test_procedures_del on public.test_procedures
  using ( (select private.has_module_perm('test_register','delete_case'))
       or (select private.has_module_perm('test_register','delete_activity'))
       or (select private.has_module_perm('test_register','bulk_delete')) );

alter policy test_item_status_history_ins on public.test_item_status_history
  with check ( (select private.has_module_perm('test_register','set_status'))
            or (select private.has_module_perm('test_register','edit_case'))
            or (select private.has_module_perm('test_register','field_intake')) );
alter policy test_item_status_history_upd on public.test_item_status_history
  using ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','set_status')) )
  with check ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','set_status')) );
alter policy test_item_status_history_del on public.test_item_status_history
  using ( (select private.has_module_perm('test_register','delete_case'))
       or (select private.has_module_perm('test_register','delete_activity'))
       or (select private.has_module_perm('test_register','bulk_delete')) );

alter policy test_item_prerequisites_ins on public.test_item_prerequisites
  with check ( (select private.has_module_perm('test_register','edit_case'))
            or (select private.has_module_perm('test_register','add_test_case')) );
alter policy test_item_prerequisites_upd on public.test_item_prerequisites
  using ( (select private.has_module_perm('test_register','edit_case')) )
  with check ( (select private.has_module_perm('test_register','edit_case')) );
alter policy test_item_prerequisites_del on public.test_item_prerequisites
  using ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','delete_case')) );

alter policy activity_records_ins on public.activity_records
  with check ( (select private.has_module_perm('test_register','field_intake'))
            or (select private.has_module_perm('test_register','add_activity'))
            or (select private.has_module_perm('test_register','add_test_case')) );
alter policy activity_records_upd on public.activity_records
  using ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','set_status'))
       or (select private.has_module_perm('test_register','field_intake')) )
  with check ( (select private.has_module_perm('test_register','edit_case'))
       or (select private.has_module_perm('test_register','set_status'))
       or (select private.has_module_perm('test_register','field_intake')) );
alter policy activity_records_del on public.activity_records
  using ( (select private.has_module_perm('test_register','delete_activity'))
       or (select private.has_module_perm('test_register','bulk_delete')) );

-- ── rls_photos_granular_ownership_keys ──────────────────────────────────────
-- ownership: uploaded_by / created_by === current user's profiles.full_name
alter policy photos_ins on public.photos
  with check ( (select private.has_module_perm('photos','upload')) );
alter policy photos_upd on public.photos
  using ( (select private.has_module_perm('photos','edit_metadata_any'))
       or ( (select private.has_module_perm('photos','edit_metadata_own'))
            and uploaded_by = (select full_name from public.profiles where id = auth.uid()) ) )
  with check ( (select private.has_module_perm('photos','edit_metadata_any'))
       or ( (select private.has_module_perm('photos','edit_metadata_own'))
            and uploaded_by = (select full_name from public.profiles where id = auth.uid()) ) );
alter policy photos_del on public.photos
  using ( (select private.has_module_perm('photos','delete_any'))
       or ( (select private.has_module_perm('photos','delete_own'))
            and uploaded_by = (select full_name from public.profiles where id = auth.uid()) ) );

alter policy photo_albums_ins on public.photo_albums
  with check ( (select private.has_module_perm('photos','create_album')) );
alter policy photo_albums_upd on public.photo_albums
  using ( (select private.has_module_perm('photos','manage_album_any'))
       or (select private.has_module_perm('photos','manage_album_contents'))
       or ( (select private.has_module_perm('photos','manage_album_own'))
            and created_by = (select full_name from public.profiles where id = auth.uid()) ) )
  with check ( (select private.has_module_perm('photos','manage_album_any'))
       or (select private.has_module_perm('photos','manage_album_contents'))
       or ( (select private.has_module_perm('photos','manage_album_own'))
            and created_by = (select full_name from public.profiles where id = auth.uid()) ) );
alter policy photo_albums_del on public.photo_albums
  using ( (select private.has_module_perm('photos','manage_album_any'))
       or ( (select private.has_module_perm('photos','manage_album_own'))
            and created_by = (select full_name from public.profiles where id = auth.uid()) ) );

alter policy photo_album_items_ins on public.photo_album_items
  with check ( (select private.has_module_perm('photos','manage_album_contents')) );
alter policy photo_album_items_upd on public.photo_album_items
  using ( (select private.has_module_perm('photos','manage_album_contents')) )
  with check ( (select private.has_module_perm('photos','manage_album_contents')) );
alter policy photo_album_items_del on public.photo_album_items
  using ( (select private.has_module_perm('photos','manage_album_contents')) );

-- ── rls_granular_keys_batch2 ────────────────────────────────────────────────
-- Renamed-key modules with unambiguous table→capability maps. SELECT stays
-- 'view'. Deferred (need module-assignment / column-level decisions): the
-- dynamic_testing secondary tables (access_campaigns, train_requests,
-- zone_access_windows), planning + lookahead (all planning_* are governed by the
-- 'planning' module in RLS, but the catalog assigns events/resources to
-- 'lookahead'), directory + admin (profiles UPDATE can't distinguish a role/
-- template change from a profile edit → needs a column-level guard so
-- grant_global_admin stays meaningful).

-- dynamic_testing (primary table only)
alter policy dynamic_instances_ins on public.dynamic_instances
  with check ( (select private.has_module_perm('dynamic_testing','create_instance')) );
alter policy dynamic_instances_upd on public.dynamic_instances
  using ( (select private.has_module_perm('dynamic_testing','edit_instance'))
       or (select private.has_module_perm('dynamic_testing','set_status'))
       or (select private.has_module_perm('dynamic_testing','schedule'))
       or (select private.has_module_perm('dynamic_testing','bulk_edit')) )
  with check ( (select private.has_module_perm('dynamic_testing','edit_instance'))
       or (select private.has_module_perm('dynamic_testing','set_status'))
       or (select private.has_module_perm('dynamic_testing','schedule'))
       or (select private.has_module_perm('dynamic_testing','bulk_edit')) );
alter policy dynamic_instances_del on public.dynamic_instances
  using ( (select private.has_module_perm('dynamic_testing','delete_instance')) );

-- forms
alter policy forms_ins on public.forms
  with check ( (select private.has_module_perm('forms','upload')) );
alter policy forms_upd on public.forms
  using ( (select private.has_module_perm('forms','upload')) or (select private.has_module_perm('forms','fill_pdf')) )
  with check ( (select private.has_module_perm('forms','upload')) or (select private.has_module_perm('forms','fill_pdf')) );
alter policy forms_del on public.forms
  using ( (select private.has_module_perm('forms','delete')) );
alter policy form_test_item_links_ins on public.form_test_item_links with check ( (select private.has_module_perm('forms','link')) );
alter policy form_test_item_links_upd on public.form_test_item_links using ( (select private.has_module_perm('forms','link')) ) with check ( (select private.has_module_perm('forms','link')) );
alter policy form_test_item_links_del on public.form_test_item_links using ( (select private.has_module_perm('forms','link')) );
alter policy form_template_links_ins on public.form_template_links with check ( (select private.has_module_perm('forms','link')) );
alter policy form_template_links_upd on public.form_template_links using ( (select private.has_module_perm('forms','link')) ) with check ( (select private.has_module_perm('forms','link')) );
alter policy form_template_links_del on public.form_template_links using ( (select private.has_module_perm('forms','link')) );

-- drawings (ownership: drawing_markups.created_by = auth.uid())
alter policy drawing_markups_ins on public.drawing_markups
  with check ( (select private.has_module_perm('drawings','create_markup')) );
alter policy drawing_markups_upd on public.drawing_markups
  using ( (select private.has_module_perm('drawings','manage_markup_any'))
       or ( ( (select private.has_module_perm('drawings','edit_markup_own')) or (select private.has_module_perm('drawings','publish')) )
            and created_by = auth.uid() ) )
  with check ( (select private.has_module_perm('drawings','manage_markup_any'))
       or ( ( (select private.has_module_perm('drawings','edit_markup_own')) or (select private.has_module_perm('drawings','publish')) )
            and created_by = auth.uid() ) );
alter policy drawing_markups_del on public.drawing_markups
  using ( (select private.has_module_perm('drawings','manage_markup_any'))
       or ( (select private.has_module_perm('drawings','edit_markup_own')) and created_by = auth.uid() ) );
alter policy drawing_sets_ins on public.drawing_sets with check ( (select private.has_module_perm('drawings','upload_set')) );
alter policy drawing_sets_upd on public.drawing_sets using ( (select private.has_module_perm('drawings','upload_set')) ) with check ( (select private.has_module_perm('drawings','upload_set')) );
alter policy drawing_sets_del on public.drawing_sets using ( (select private.has_module_perm('drawings','delete_set')) );
alter policy drawing_sheets_ins on public.drawing_sheets with check ( (select private.has_module_perm('drawings','upload_set')) );
alter policy drawing_sheets_upd on public.drawing_sheets using ( (select private.has_module_perm('drawings','upload_set')) ) with check ( (select private.has_module_perm('drawings','upload_set')) );
alter policy drawing_sheets_del on public.drawing_sheets using ( (select private.has_module_perm('drawings','delete_set')) );

-- assets
alter policy assets_ins on public.assets with check ( (select private.has_module_perm('assets','add')) );
alter policy assets_upd on public.assets
  using ( (select private.has_module_perm('assets','edit')) or (select private.has_module_perm('assets','bulk_edit')) )
  with check ( (select private.has_module_perm('assets','edit')) or (select private.has_module_perm('assets','bulk_edit')) );
alter policy assets_del on public.assets using ( (select private.has_module_perm('assets','bulk_delete')) );
alter policy asset_test_links_ins on public.asset_test_links with check ( (select private.has_module_perm('assets','link')) );
alter policy asset_test_links_upd on public.asset_test_links using ( (select private.has_module_perm('assets','link')) ) with check ( (select private.has_module_perm('assets','link')) );
alter policy asset_test_links_del on public.asset_test_links using ( (select private.has_module_perm('assets','link')) );
alter policy asset_import_batches_ins on public.asset_import_batches with check ( (select private.has_module_perm('assets','import')) );
alter policy asset_import_batches_upd on public.asset_import_batches using ( (select private.has_module_perm('assets','import')) ) with check ( (select private.has_module_perm('assets','import')) );
alter policy asset_import_batches_del on public.asset_import_batches using ( (select private.has_module_perm('assets','import')) );

-- schedule_p6
alter policy p6_activities_ins on public.p6_activities with check ( (select private.has_module_perm('schedule_p6','import')) );
alter policy p6_activities_upd on public.p6_activities
  using ( (select private.has_module_perm('schedule_p6','manage_links')) or (select private.has_module_perm('schedule_p6','rebaseline')) )
  with check ( (select private.has_module_perm('schedule_p6','manage_links')) or (select private.has_module_perm('schedule_p6','rebaseline')) );
alter policy p6_activities_del on public.p6_activities using ( (select private.has_module_perm('schedule_p6','remove_activities')) );
alter policy p6_activity_map_ins on public.p6_activity_map with check ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_activity_map_upd on public.p6_activity_map using ( (select private.has_module_perm('schedule_p6','manage_links')) ) with check ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_activity_map_del on public.p6_activity_map using ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_activity_dismissals_ins on public.p6_activity_dismissals with check ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_activity_dismissals_upd on public.p6_activity_dismissals using ( (select private.has_module_perm('schedule_p6','manage_links')) ) with check ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_activity_dismissals_del on public.p6_activity_dismissals using ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_import_batches_ins on public.p6_import_batches with check ( (select private.has_module_perm('schedule_p6','import')) );
alter policy p6_import_batches_upd on public.p6_import_batches
  using ( (select private.has_module_perm('schedule_p6','import')) or (select private.has_module_perm('schedule_p6','rebaseline')) )
  with check ( (select private.has_module_perm('schedule_p6','import')) or (select private.has_module_perm('schedule_p6','rebaseline')) );
alter policy p6_import_batches_del on public.p6_import_batches
  using ( (select private.has_module_perm('schedule_p6','remove_activities')) or (select private.has_module_perm('schedule_p6','import')) );
alter policy p6_learn_patterns_ins on public.p6_learn_patterns with check ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_learn_patterns_upd on public.p6_learn_patterns using ( (select private.has_module_perm('schedule_p6','manage_links')) ) with check ( (select private.has_module_perm('schedule_p6','manage_links')) );
alter policy p6_learn_patterns_del on public.p6_learn_patterns using ( (select private.has_module_perm('schedule_p6','manage_links')) );

-- track_plan (view + manage only) — all writes gated on 'manage'
alter policy track_devices_ins on public.track_devices with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_devices_upd on public.track_devices using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_devices_del on public.track_devices using ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_equations_ins on public.track_equations with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_equations_upd on public.track_equations using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_equations_del on public.track_equations using ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_mileposts_ins on public.track_mileposts with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_mileposts_upd on public.track_mileposts using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_mileposts_del on public.track_mileposts using ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_plan_imports_ins on public.track_plan_imports with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_plan_imports_upd on public.track_plan_imports using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_plan_imports_del on public.track_plan_imports using ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_sections_ins on public.track_sections with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_sections_upd on public.track_sections using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_sections_del on public.track_sections using ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_zones_ins on public.track_zones with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_zones_upd on public.track_zones using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy track_zones_del on public.track_zones using ( (select private.has_module_perm('track_plan','manage')) );
alter policy train_control_locations_ins on public.train_control_locations with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy train_control_locations_upd on public.train_control_locations using ( (select private.has_module_perm('track_plan','manage')) ) with check ( (select private.has_module_perm('track_plan','manage')) );
alter policy train_control_locations_del on public.train_control_locations using ( (select private.has_module_perm('track_plan','manage')) );

-- weights
alter policy activity_weights_admin_write on public.activity_weights with check ( (select private.has_module_perm('weights','edit_activity')) );
alter policy activity_weights_admin_update on public.activity_weights using ( (select private.has_module_perm('weights','edit_activity')) ) with check ( (select private.has_module_perm('weights','edit_activity')) );
alter policy activity_weights_admin_delete on public.activity_weights using ( (select private.has_module_perm('weights','edit_activity')) );
alter policy test_case_weights_admin_write on public.test_case_weights with check ( (select private.has_module_perm('weights','edit_test_case')) );
alter policy test_case_weights_admin_update on public.test_case_weights using ( (select private.has_module_perm('weights','edit_test_case')) ) with check ( (select private.has_module_perm('weights','edit_test_case')) );
alter policy test_case_weights_admin_delete on public.test_case_weights using ( (select private.has_module_perm('weights','edit_test_case')) );

-- ── rls_planning_lookahead_reassign ─────────────────────────────────────────
-- Move look-ahead tables from the 'planning' module to 'lookahead' (match the
-- catalog/nav); convert planning-kept tables to planning's granular keys.
-- pto_requests preserves its user_id=auth.uid() self-service ownership.
alter policy planning_events_sel on public.planning_events using ( (select private.has_module_perm('lookahead','view')) );
alter policy planning_events_ins on public.planning_events with check ( (select private.has_module_perm('lookahead','create_event')) );
alter policy planning_events_upd on public.planning_events
  using ( (select private.has_module_perm('lookahead','edit_event')) or (select private.has_module_perm('lookahead','cancel')) or (select private.has_module_perm('lookahead','lock')) )
  with check ( (select private.has_module_perm('lookahead','edit_event')) or (select private.has_module_perm('lookahead','cancel')) or (select private.has_module_perm('lookahead','lock')) );
alter policy planning_events_del on public.planning_events using ( (select private.has_module_perm('lookahead','delete')) );
alter policy planning_event_resources_sel on public.planning_event_resources using ( (select private.has_module_perm('lookahead','view')) );
alter policy planning_event_resources_ins on public.planning_event_resources with check ( (select private.has_module_perm('lookahead','assign_resources')) );
alter policy planning_event_resources_upd on public.planning_event_resources using ( (select private.has_module_perm('lookahead','assign_resources')) ) with check ( (select private.has_module_perm('lookahead','assign_resources')) );
alter policy planning_event_resources_del on public.planning_event_resources using ( (select private.has_module_perm('lookahead','assign_resources')) );
alter policy planning_activity_resources_sel on public.planning_activity_resources using ( (select private.has_module_perm('lookahead','view')) );
alter policy planning_activity_resources_ins on public.planning_activity_resources with check ( (select private.has_module_perm('lookahead','assign_resources')) );
alter policy planning_activity_resources_upd on public.planning_activity_resources using ( (select private.has_module_perm('lookahead','assign_resources')) ) with check ( (select private.has_module_perm('lookahead','assign_resources')) );
alter policy planning_activity_resources_del on public.planning_activity_resources using ( (select private.has_module_perm('lookahead','assign_resources')) );
alter policy planning_activities_sel on public.planning_activities using ( (select private.has_module_perm('lookahead','view')) );
alter policy planning_activities_ins on public.planning_activities with check ( (select private.has_module_perm('lookahead','manage_activities')) );
alter policy planning_activities_upd on public.planning_activities using ( (select private.has_module_perm('lookahead','manage_activities')) ) with check ( (select private.has_module_perm('lookahead','manage_activities')) );
alter policy planning_activities_del on public.planning_activities using ( (select private.has_module_perm('lookahead','manage_activities')) );
alter policy planning_import_batches_sel on public.planning_import_batches using ( (select private.has_module_perm('lookahead','view')) );
alter policy planning_import_batches_ins on public.planning_import_batches with check ( (select private.has_module_perm('lookahead','import')) );
alter policy planning_import_batches_upd on public.planning_import_batches using ( (select private.has_module_perm('lookahead','import')) ) with check ( (select private.has_module_perm('lookahead','import')) );
alter policy planning_import_batches_del on public.planning_import_batches using ( (select private.has_module_perm('lookahead','import')) );
alter policy planning_resources_ins on public.planning_resources with check ( (select private.has_module_perm('planning','manage_resources')) );
alter policy planning_resources_upd on public.planning_resources using ( (select private.has_module_perm('planning','manage_resources')) ) with check ( (select private.has_module_perm('planning','manage_resources')) );
alter policy planning_resources_del on public.planning_resources using ( (select private.has_module_perm('planning','manage_resources')) );
alter policy shift_templates_ins on public.shift_templates with check ( (select private.has_module_perm('planning','manage_resources')) );
alter policy shift_templates_upd on public.shift_templates using ( (select private.has_module_perm('planning','manage_resources')) ) with check ( (select private.has_module_perm('planning','manage_resources')) );
alter policy shift_templates_del on public.shift_templates using ( (select private.has_module_perm('planning','manage_resources')) );
alter policy planning_week_snapshots_ins on public.planning_week_snapshots with check ( (select private.has_module_perm('planning','manage_resources')) );
alter policy planning_week_snapshots_upd on public.planning_week_snapshots using ( (select private.has_module_perm('planning','manage_resources')) ) with check ( (select private.has_module_perm('planning','manage_resources')) );
alter policy planning_week_snapshots_del on public.planning_week_snapshots using ( (select private.has_module_perm('planning','manage_resources')) );
alter policy planning_conflicts_ins on public.planning_conflicts with check ( (select private.has_module_perm('planning','resolve_conflicts')) );
alter policy planning_conflicts_upd on public.planning_conflicts using ( (select private.has_module_perm('planning','resolve_conflicts')) ) with check ( (select private.has_module_perm('planning','resolve_conflicts')) );
alter policy planning_conflicts_del on public.planning_conflicts using ( (select private.has_module_perm('planning','resolve_conflicts')) );
alter policy pto_requests_upd on public.pto_requests
  using ( (user_id = (select auth.uid())) or (select private.has_module_perm('planning','pto_approve')) )
  with check ( (user_id = (select auth.uid())) or (select private.has_module_perm('planning','pto_approve')) );
alter policy pto_requests_del on public.pto_requests
  using ( (user_id = (select auth.uid())) or (select private.has_module_perm('planning','pto_approve')) );

-- ── rls_directory_admin_escalation_guard ────────────────────────────────────
-- Trigger closes a pre-existing self-escalation hole: profiles_update allowed
-- auth.uid()=id (self-update) including the role column, so any signed-in user
-- could set their own role='admin'. The trigger blocks privileged-column changes
-- unless the actor holds the matching capability (service_role/internal bypass;
-- global admins pass via has_module_perm).
create or replace function private.guard_profile_privilege_changes()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if coalesce((select auth.role()), '') <> 'authenticated' then return new; end if;
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

alter policy profiles_update on public.profiles
  using ( ((select auth.uid()) = id)
       or (select private.has_module_perm('directory','edit_profile')) or (select private.has_module_perm('directory','activate'))
       or (select private.has_module_perm('directory','assign_template')) or (select private.has_module_perm('directory','grant_global_admin')) )
  with check ( ((select auth.uid()) = id)
       or (select private.has_module_perm('directory','edit_profile')) or (select private.has_module_perm('directory','activate'))
       or (select private.has_module_perm('directory','assign_template')) or (select private.has_module_perm('directory','grant_global_admin')) );
alter policy profiles_insert on public.profiles with check ( (select private.has_module_perm('directory','invite')) );
alter policy profiles_delete on public.profiles using ( (select private.has_module_perm('directory','remove')) );
alter policy users_ins on public.users with check ( (select private.has_module_perm('directory','invite')) );
alter policy users_upd on public.users using ( (select private.has_module_perm('directory','edit_profile')) ) with check ( (select private.has_module_perm('directory','edit_profile')) );
alter policy users_del on public.users using ( (select private.has_module_perm('directory','remove')) );
alter policy team_members_ins on public.team_members with check ( (select private.has_module_perm('directory','manage_org_chart')) );
alter policy team_members_upd on public.team_members using ( (select private.has_module_perm('directory','manage_org_chart')) ) with check ( (select private.has_module_perm('directory','manage_org_chart')) );
alter policy team_members_del on public.team_members using ( (select private.has_module_perm('directory','manage_org_chart')) );
alter policy perm_modules_ins on public.perm_modules with check ( (select private.has_module_perm('admin','manage_templates')) );
alter policy perm_modules_upd on public.perm_modules using ( (select private.has_module_perm('admin','manage_templates')) ) with check ( (select private.has_module_perm('admin','manage_templates')) );
alter policy perm_modules_del on public.perm_modules using ( (select private.has_module_perm('admin','manage_templates')) );
alter policy permission_templates_ins on public.permission_templates with check ( (select private.has_module_perm('admin','manage_templates')) );
alter policy permission_templates_upd on public.permission_templates using ( (select private.has_module_perm('admin','manage_templates')) ) with check ( (select private.has_module_perm('admin','manage_templates')) );
alter policy permission_templates_del on public.permission_templates using ( (select private.has_module_perm('admin','manage_templates')) );
alter policy template_module_perms_ins on public.template_module_perms with check ( (select private.has_module_perm('admin','manage_templates')) );
alter policy template_module_perms_upd on public.template_module_perms using ( (select private.has_module_perm('admin','manage_templates')) ) with check ( (select private.has_module_perm('admin','manage_templates')) );
alter policy template_module_perms_del on public.template_module_perms using ( (select private.has_module_perm('admin','manage_templates')) );
alter policy umo_ins on public.user_module_overrides with check ( (select private.has_module_perm('admin','manage_overrides')) );
alter policy umo_upd on public.user_module_overrides using ( (select private.has_module_perm('admin','manage_overrides')) ) with check ( (select private.has_module_perm('admin','manage_overrides')) );
alter policy umo_del on public.user_module_overrides using ( (select private.has_module_perm('admin','manage_overrides')) );
