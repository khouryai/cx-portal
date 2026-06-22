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
