-- ============================================================
-- HITACHI Rail T&C Portal — Track-plan resolver diagnostics
--
-- The importer (sync_track_plan.js / track_plan_importer.html)
-- resolves devices/sections → zone/interlocking by matching the
-- code prefix against track_zones. Anything left with both
-- zone_id and interlocking_id NULL is "unresolved" and won't
-- appear in zone-scoped queries.
--
-- vw_track_devices_unresolved   one row per (prefix, device_type)
--                               bucket, with sample codes and the
--                               source Visio sheet(s).
-- vw_track_sections_unresolved  one row per orphan section.
--
-- Both views are SECURITY INVOKER so they inherit the caller's
-- RLS context (same pattern as vw_procedure_scope_rollup).
-- Idempotent.
-- ============================================================

create or replace view public.vw_track_devices_unresolved
with (security_invoker = true) as
select
  case when code is null            then '(no code)'
       when position('-' in code)>0 then split_part(code, '-', 1)
       else code end                                          as prefix,
  device_type,
  count(*)                                                    as n,
  (array_agg(coalesce(code,'(null)') order by code))[1:5]     as sample_codes,
  string_agg(distinct source_sheet, ', ')                     as source_sheets,
  (array_agg(source_import_id order by created_at desc))[1]   as last_import_id
from public.track_devices
where zone_id is null and interlocking_id is null
group by prefix, device_type
order by count(*) desc, prefix;

create or replace view public.vw_track_sections_unresolved
with (security_invoker = true) as
select
  id,
  code,
  source_shape_id,
  source_import_id
from public.track_sections
where zone_id is null;

grant select on
  public.vw_track_devices_unresolved,
  public.vw_track_sections_unresolved
to authenticated, service_role;

notify pgrst, 'reload schema';
