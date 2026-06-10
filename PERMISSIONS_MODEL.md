# Permissions Model — Procore-style granular permissions (cx-portal)

> Design artifact for Phase 1 (P1-1). The DB infrastructure below is **additive
> and reversible**. The rewrite of the ~27 existing-table RLS policies onto this
> model is the **gated** step — owner reviews this document first.

## Why
Today: ~27 tables have always-true (`USING(true)`) policies — any signed-in user
can read/write/delete everything; the only real gate is `is_admin()`. Role data
is inconsistent (`admin`, `field_engineer`, `field`, `punch_manager`,
`technician`, `client`). UI does ~30 scattered advisory `role==='admin'` checks.

Target (Procore-modeled): **per-module permission levels + reusable templates +
granular overrides**, enforced authoritatively in RLS and mirrored in the UI.

## Concepts
- **Module** — a permission-controlled feature area (maps to nav groups + a set
  of tables). Catalog table `perm_modules`.
- **Level** — per module, one of: `none` < `read_only` < `standard` < `admin`.
- **Action** — `view, export, create, edit, delete, approve, manage`. Baseline
  per level:
  - none → (nothing)
  - read_only → view, export
  - standard → view, export, create, edit
  - admin → all of the above + delete, approve, manage
- **Granular grants** — a `jsonb` per (template, module) that adds/removes
  individual actions on top of the level (e.g. `{"delete": true}` or
  `{"export": false}`). Enables "read-only + can export", "standard + can delete".
- **Permission Template** — a named, reusable bundle of per-module level+grants
  (e.g. "Field Engineer"). Assigned to users via `profiles.permission_template_id`.
- **Per-user override** — `user_module_overrides` lets an admin tweak one user's
  level/grants for one module without a new template.
- **Scope** — `profiles.subsystem` remains the row-scoping dimension (orthogonal
  to module permission), applied in RLS where a table is subsystem-bound.

## Resolution order (in `has_module_perm(module, action)`)
1. User must exist and be `is_active` → else deny.
2. Global admin (`profiles.role='admin'`) → allow all (backward compatible).
3. Start from the user's template level+grants for the module.
4. Apply per-user override (override level replaces; override grants merge).
5. Compute baseline actions for the level, then apply grants (true adds / false
   removes). Return whether `action` is in the effective set.

SECURITY DEFINER, `search_path=public`, STABLE; `EXECUTE` granted to
`authenticated`, revoked from `anon`.

## New tables (additive)
- `perm_modules(key pk, label, category, sort_order, governs text[])`
- `permission_templates(id pk, name unique, description, is_system, timestamps)`
- `template_module_perms(template_id fk, module_key fk, level, grants jsonb, pk(template_id,module_key))`
- `profiles.permission_template_id` (new nullable FK column)
- `user_module_overrides(user_id fk, module_key fk, level nullable, grants jsonb, pk(user_id,module_key))`
All FKs indexed; new tables get RLS (catalog/templates readable by authenticated,
writable by admins; overrides readable by self+admin, writable by admin).

## Module catalog (maps to nav groups & tables)
| key | label | category | governs (tables) |
|---|---|---|---|
| overview | Overview / KPIs | overview | kpi_* / vw_* (read views) |
| test_register | Test Register | testing | test_items, test_results, test_item_status_history, test_item_prerequisites, test_procedures, activity_records |
| dynamic_testing | Dynamic Testing | testing | dynamic_instances, access_campaigns, train_requests, zone_access_windows, vw_dynamic_* |
| test_reporting | Test Reports | testing | test_reports |
| punch_list | Punch List | field | punch_items, punch_history |
| rma | RMA | field | rmas |
| forms | Forms | field | forms, form_test_item_links, form_template_links, fieldset_config |
| photos | Photos | field | photos, photo_albums, photo_album_items |
| meetings | Meetings | planning | meetings, meeting_*, meeting_action_items |
| planning | Planning & Resources | planning | planning_resources, planning_activities, pto_requests, shift_templates, planning_week_snapshots |
| lookahead | Look-ahead | planning | planning_events, planning_event_resources, planning_activity_resources, planning_conflicts |
| schedule_p6 | P6 Schedule | planning | p6_* |
| assets | Assets | data | assets, asset_test_links, asset_import_batches |
| track_plan | Track Plan | data | track_*, train_control_locations |
| drawings | Drawings | data | drawing_sets, drawing_sheets, drawing_markups |
| locations | Locations | data | locations |
| directory | Directory / People | admin | profiles, users |
| templates | Test Templates | admin | templates, template_test_cases, deployments, deployment_locations, test_instances |
| weights | Scoring Weights | admin | activity_weights, test_case_weights |
| config | Software Config | admin | software_configs |
| audit | Audit Log | admin | audit_log, db_change_log (read) |
| admin | Permissions Admin | admin | permission_templates, template_module_perms, user_module_overrides, perm_modules |

## System templates (absorb the 6 legacy role values)
- **Administrator** ← `admin` — admin on every module.
- **Field Engineer** ← `field_engineer`, `field` — standard on testing/field/
  lookahead/drawings; read_only on overview/planning/schedule/assets/locations;
  none on admin modules.
- **Punch Manager** ← `punch_manager` — admin on punch_list (incl. approve) + rma;
  standard on photos/forms; read_only on overview/test_register; none on admin.
- **Technician** ← `technician` — standard on punch_list (assigned) + photos;
  read_only on overview/test_register/drawings; none elsewhere.
- **Client Reviewer** ← `client` — read_only on overview/punch_list/test_reporting/
  forms/meetings/photos; none elsewhere.
- **Read Only** ← `readonly` — read_only on all non-admin view modules; none on admin.

## Planned RLS rewrite (GATED — not applied until owner OK)
For each governed table, replace the always-true policy with command-specific
policies, all wrapping auth in a subselect (fixes initplan perf too):
- SELECT  `using (has_module_perm('<module>','view'))`
- INSERT  `with check (has_module_perm('<module>','create'))`
- UPDATE  `using (has_module_perm('<module>','edit')) with check (...)`
- DELETE  `using (has_module_perm('<module>','delete'))`
Plus subsystem row-scoping where applicable. Rolled out **batched per module**,
advisors re-run per batch, per-role verification matrix run with test users.

This single rewrite resolves: always-true policies (P1-4), the permissions
feature (P1), and contributes to initplan perf (P2-1).
