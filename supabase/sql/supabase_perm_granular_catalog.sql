-- ============================================================================
-- Granular per-module permission capability catalog (PERMISSIONS_MODEL.md)
--
-- In-repo record of applied migrations (project uqtwiucxktljhukmgmxg):
--   1) perm_granular_catalog_seed        — seed perm_modules.action_meta + actions
--   2) perm_baseline_module_aware_union  — module-aware union baseline + has_module_perm
--   3) perm_baseline_move_to_private     — keep baseline in the non-exposed
--      `private` schema (RLS-only, not PostgREST-RPC-callable). Final form below.
--
-- Design: the universal 7-verb model is replaced by a per-module capability
-- catalog. perm_modules.actions keeps the ordered key list (back-compat for
-- existing readers); perm_modules.action_meta carries {m: min_level, x:
-- grant_only} per key. Ownership pairs use the _own/_any suffix convention.
--
-- The baseline is computed as legacy-7-verbs(level) UNION granular-catalog-keys
-- (min_level <= level, grant_only excluded). This is a STRICT SUPERSET of the
-- previous behaviour, so every existing RLS policy that checks a legacy verb
-- ('edit'/'delete'/…) keeps resolving unchanged, while the new granular keys
-- become resolvable for policies/UI that adopt them. Global admins (role=admin)
-- still bypass everything.
-- ============================================================================

-- ── Migration 1: perm_granular_catalog_seed ────────────────────────────────
alter table public.perm_modules add column if not exists action_meta jsonb not null default '{}'::jsonb;

update public.perm_modules pm set
  actions = v.actions,
  action_meta = v.meta::jsonb
from (values
  ('overview',
   array['view'],
   '{"view":{"m":"read_only"}}'),
  ('test_register',
   array['view','export','add_activity','add_test_case','edit_case','set_status','field_intake','bulk_edit','manage_assets','delete_case','delete_activity','bulk_delete','deploy_field','manage_p6_links','import'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"add_activity":{"m":"standard"},"add_test_case":{"m":"standard"},"edit_case":{"m":"standard"},"set_status":{"m":"standard"},"field_intake":{"m":"standard"},"bulk_edit":{"m":"standard","x":true},"manage_assets":{"m":"standard"},"delete_case":{"m":"admin"},"delete_activity":{"m":"admin"},"bulk_delete":{"m":"admin"},"deploy_field":{"m":"admin"},"manage_p6_links":{"m":"admin"},"import":{"m":"admin"}}'),
  ('dynamic_testing',
   array['view','export','create_instance','edit_instance','set_status','schedule','bulk_edit','manage_shifts','approve_trains','delete_instance','import'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create_instance":{"m":"standard"},"edit_instance":{"m":"standard"},"set_status":{"m":"standard"},"schedule":{"m":"standard"},"bulk_edit":{"m":"standard","x":true},"manage_shifts":{"m":"admin"},"approve_trains":{"m":"admin"},"delete_instance":{"m":"admin"},"import":{"m":"admin"}}'),
  ('test_reporting',
   array['view','export','create','edit','sync','delete'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"sync":{"m":"standard","x":true},"delete":{"m":"admin"}}'),
  ('punch_list',
   array['view','export','create','edit','comment','link_test','advance_status','import','delete','override_workflow'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"comment":{"m":"standard"},"link_test":{"m":"standard"},"advance_status":{"m":"standard"},"import":{"m":"standard","x":true},"delete":{"m":"admin"},"override_workflow":{"m":"admin","x":true}}'),
  ('rma',
   array['view','export','create','edit','change_status','delete'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"change_status":{"m":"standard","x":true},"delete":{"m":"admin"}}'),
  ('forms',
   array['view','upload','fill_pdf','link','delete','manage_fieldsets'],
   '{"view":{"m":"read_only"},"upload":{"m":"standard"},"fill_pdf":{"m":"standard"},"link":{"m":"standard"},"delete":{"m":"admin"},"manage_fieldsets":{"m":"admin"}}'),
  ('photos',
   array['view','upload','edit_metadata_own','edit_metadata_any','delete_own','delete_any','create_album','manage_album_contents','manage_album_own','manage_album_any'],
   '{"view":{"m":"read_only"},"upload":{"m":"standard"},"edit_metadata_own":{"m":"standard"},"edit_metadata_any":{"m":"admin"},"delete_own":{"m":"standard"},"delete_any":{"m":"admin"},"create_album":{"m":"standard"},"manage_album_contents":{"m":"standard"},"manage_album_own":{"m":"standard"},"manage_album_any":{"m":"admin"}}'),
  ('meetings',
   array['view','export','create','edit','manage_agenda','record_minutes','manage_action_items','manage_attendees','create_followup','delete'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"manage_agenda":{"m":"standard"},"record_minutes":{"m":"standard"},"manage_action_items":{"m":"standard"},"manage_attendees":{"m":"standard"},"create_followup":{"m":"standard"},"delete":{"m":"admin"}}'),
  ('planning',
   array['view','pto_submit','pto_approve','resolve_conflicts','manage_resources'],
   '{"view":{"m":"read_only"},"pto_submit":{"m":"standard"},"pto_approve":{"m":"admin"},"resolve_conflicts":{"m":"admin"},"manage_resources":{"m":"admin"}}'),
  ('lookahead',
   array['view','export','create_event','edit_event','cancel','manage_activities','assign_resources','bulk_edit','lock','delete','import'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create_event":{"m":"standard"},"edit_event":{"m":"standard"},"cancel":{"m":"standard"},"manage_activities":{"m":"standard"},"assign_resources":{"m":"standard"},"bulk_edit":{"m":"standard","x":true},"lock":{"m":"admin"},"delete":{"m":"admin"},"import":{"m":"admin"}}'),
  ('schedule_p6',
   array['view','import','rebaseline','manage_links','remove_activities'],
   '{"view":{"m":"read_only"},"import":{"m":"admin"},"rebaseline":{"m":"admin"},"manage_links":{"m":"admin"},"remove_activities":{"m":"admin"}}'),
  ('assets',
   array['view','export','add','edit','link','bulk_edit','import','bulk_delete'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"add":{"m":"standard"},"edit":{"m":"standard"},"link":{"m":"standard"},"bulk_edit":{"m":"standard","x":true},"import":{"m":"admin"},"bulk_delete":{"m":"admin"}}'),
  ('track_plan',
   array['view','manage'],
   '{"view":{"m":"read_only"},"manage":{"m":"admin"}}'),
  ('drawings',
   array['view','create_markup','edit_markup_own','publish','manage_markup_any','upload_set','delete_set'],
   '{"view":{"m":"read_only"},"create_markup":{"m":"standard"},"edit_markup_own":{"m":"standard"},"publish":{"m":"standard"},"manage_markup_any":{"m":"admin"},"upload_set":{"m":"admin"},"delete_set":{"m":"admin"}}'),
  ('locations',
   array['view','create','edit','delete','import'],
   '{"view":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"delete":{"m":"admin"},"import":{"m":"admin"}}'),
  ('directory',
   array['view','manage_org_chart','invite','edit_profile','activate','remove','assign_template','grant_global_admin'],
   '{"view":{"m":"read_only"},"manage_org_chart":{"m":"standard"},"invite":{"m":"admin"},"edit_profile":{"m":"admin"},"activate":{"m":"admin"},"remove":{"m":"admin"},"assign_template":{"m":"admin"},"grant_global_admin":{"m":"admin","x":true}}'),
  ('templates',
   array['view','export','create','edit','delete','deploy'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"},"create":{"m":"standard"},"edit":{"m":"standard"},"delete":{"m":"admin"},"deploy":{"m":"admin"}}'),
  ('weights',
   array['view','edit_activity','edit_test_case','bulk_apply'],
   '{"view":{"m":"read_only"},"edit_activity":{"m":"admin"},"edit_test_case":{"m":"admin"},"bulk_apply":{"m":"admin","x":true}}'),
  ('config',
   array['view','create','new_version','edit','delete'],
   '{"view":{"m":"read_only"},"create":{"m":"standard"},"new_version":{"m":"standard"},"edit":{"m":"standard"},"delete":{"m":"admin"}}'),
  ('audit',
   array['view','export'],
   '{"view":{"m":"read_only"},"export":{"m":"read_only"}}'),
  ('admin',
   array['view','manage_templates','manage_overrides'],
   '{"view":{"m":"admin"},"manage_templates":{"m":"admin","x":true},"manage_overrides":{"m":"admin","x":true}}')
) as v(key, actions, meta)
where pm.key = v.key;

-- ── Migrations 2 + 3: module-aware union baseline (final: in `private`) ──────
create or replace function private._perm_baseline(p_module text, p_level text)
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  select array(
    select distinct k from (
      select unnest(public._perm_baseline(p_level)) as k
      union
      select me.key as k
      from perm_modules pm
      cross join lateral jsonb_each(pm.action_meta) as me(key, val)
      where pm.key = p_module
        and coalesce((me.val->>'x')::boolean, false) = false
        and array_position(array['none','read_only','standard','admin'],
                           coalesce(me.val->>'m','admin'))
            <= array_position(array['none','read_only','standard','admin'], p_level)
    ) u
  );
$function$;

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
