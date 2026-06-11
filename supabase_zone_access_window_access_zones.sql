-- ============================================================
-- zone_access_windows.access_zones — per-shift granted zone set
--
-- A window/shift grants access to a SET of zones (aligned to its times). A
-- dynamic instance can run on a shift only if ALL of its track_section_access_req
-- zones are within that shift's access_zones. So a [W40, Y10] run needs a window
-- that grants BOTH zones (e.g. a two-zone Fri/Sat campaign) and is rejected by a
-- single-zone W40 shift; a single-zone run fits any shift that includes its zone.
--
-- The gate lives on the WINDOW (not the campaign) so access can differ by shift.
-- Generation tags each window with its campaign's zone set; the Shift Builder,
-- assign guard, cascade allocator, and auto-roll-forward all gate on it.
--
-- Applied live as migration: zone_access_window_access_zones (which also adds the
-- access_req predicate to dyn_roll_forward_on_cancel). Idempotent.
-- ============================================================

alter table zone_access_windows
  add column if not exists access_zones text[] not null default '{}';

comment on column zone_access_windows.access_zones is
  'Full set of zones this shift grants access to (aligned to its times). A dynamic instance is runnable here only if its track_section_access_req is a subset. Defaults to the campaign zone set; stand-alone windows grant their own control_zone_code.';

-- Backfill: campaign windows grant the campaign's full zone set; stand-alone
-- windows grant just their own control zone.
update zone_access_windows w
   set access_zones = coalesce(c.zone_codes, array[w.control_zone_code])
  from access_campaigns c
 where w.campaign_id = c.id and (w.access_zones is null or w.access_zones = '{}');
update zone_access_windows w
   set access_zones = array[w.control_zone_code]
 where w.campaign_id is null and w.control_zone_code is not null
   and (w.access_zones is null or w.access_zones = '{}');

-- (dyn_roll_forward_on_cancel gains, in its target-window WHERE clause:)
--   and (inst.track_section_access_req is null
--        or inst.track_section_access_req = '{}'
--        or inst.track_section_access_req <@ (case when array_length(w.access_zones,1) is null
--                                                  then array[w.control_zone_code] else w.access_zones end))
