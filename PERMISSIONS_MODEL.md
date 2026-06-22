# Permissions Model — granular per-module capabilities (cx-portal)

> **STATUS (2026-06-15): CANONICAL SPEC — supersedes the generic-7-verb model.**
> This document is the single source of truth for the permission system.
>
> **LIVE (this change):** the granular catalog is seeded in `perm_modules`
> (`actions` + new `action_meta`); the DB baseline is module-aware
> (`private._perm_baseline(module, level)`) computing **legacy-7 ∪ granular keys**
> and `private.has_module_perm` is rewired to it; the client resolver +
> ownership gate (`perms-admin.js`: `PERM_CATALOG`, `permBaseline(level,module)`,
> `permEffective(…,module)`, `can(module,verb,isOwner)`) and the Permissions
> admin UI (grouped granular chips, grant-only + ownership) are shipped; the
> photos delete gate routes through `can('photos','delete',isOwner)`. Pinned by
> `tools/test_perm_resolver.js` + `tools/test_ui_can.js`. The baseline is a
> **strict superset** of the old behaviour, so no existing RLS policy lost
> access and the 2 global admins bypass entirely.
>
> **RLS PILOT LIVE:** `test_register` + `photos` governed tables now enforce the
> granular keys in RLS (incl. photos `_own`/`_any` ownership, matched to
> `profiles.full_name` — no column migration needed).
>
> **REMAINING (batched, per the build plan):** converting the other modules'
> governed tables to *check* the granular keys, and gating the remaining
> per-call-site UI in `app.js`. Both vocabularies resolve in the meantime, so
> this is incremental and safe.

## Why
At the original design time ~27 tables had always-true (`USING(true)`) policies;
the only real gate was `is_admin()`. The first iteration fixed that with
per-module levels + a universal 7-verb vocabulary, enforced in RLS via
`private.has_module_perm()` / `private.is_admin()`. That vocabulary is too coarse:
the owner needs to distinguish, per module, things like *bulk edit* vs *single
edit*, *adding test cases* vs *adding activities*, *creating albums* vs *not*, and
*deleting your own photos* vs *anyone's*. This spec makes the action vocabulary
**module-specific** and adds an **ownership axis**, while keeping templates simple.

## Core concepts
- **Module** — a permission-controlled feature area (maps to nav pages + a set of
  tables). Catalog table `perm_modules`.
- **Level** — per module, one of `none` < `read_only` < `standard` < `admin`.
  Levels still exist; they are a *coarse baseline selector* so templates stay
  readable ("Field Engineer = standard on testing").
- **Capability key** — a named action a module supports (e.g.
  `test_register.bulk_edit`, `photos.create_album`). Each key declares:
  - `min_level` — the level at/above which the key is part of the baseline.
  - `grant_only` (the **†** marker below) — if true the key is **never** in the
    baseline at any level; an admin must add it as an explicit grant chip. Used for
    high-blast-radius or data-egress actions (bulk ops, privilege escalation,
    external sync, the permissions module's own writes).
  - The legacy 7 verbs are still valid keys — they are just the universal catalog
    that read-only/standard/admin map onto for simple modules.
- **Baseline(level, module)** = every catalog key with `grant_only=false` and
  `min_level <= level` (level order `none<read_only<standard<admin`).
- **Granular grant** — a `jsonb` per (template, module) that adds (`true`) or
  removes (`false`) individual keys on top of the baseline. Unchanged from today:
  the resolver already iterates arbitrary keys, so adding capability keys needs
  **no resolver/schema change** beyond the catalog and enforcement.
- **Ownership axis (`_own` / `_any`)** — for actions where "mine vs anyone's"
  matters, the capability is modelled as a **pair of keys**: `delete_own` +
  `delete_any`, `edit_metadata_own` + `edit_metadata_any`, etc. `_any` **implies**
  `_own`. This is the only behavioural addition to the gate (see below). It maps
  directly to RLS (`created_by = auth.uid()`). Tables already carry the needed
  columns (`photos.uploaded_by`, `drawing_markups.created_by`,
  `punch_items.created_by`, …).
- **Permission Template** — a named, reusable bundle of per-module level + grants
  (e.g. "Field Engineer"). Assigned via `profiles.permission_template_id`.
- **Per-user override** — `user_module_overrides` tweaks one user's level/grants
  for one module without a new template.
- **Subsystem scope** — `profiles.subsystem` remains the **row-scoping** dimension,
  orthogonal to capabilities, applied in RLS where a table is subsystem-bound. It
  is *not* the same as the `_own/_any` axis: subsystem scopes *which rows exist for
  you*; ownership scopes *which of those rows you may mutate*.

## Resolution & the gate
`permEffective(profile, tmpRow, ovRow)` is unchanged in shape:
1. User must exist and be `is_active` → else deny (empty set).
2. Global admin (`profiles.role='admin'`) → allow everything (backward compatible).
3. Start from template level + grants for the module.
4. Apply per-user override (override level replaces; override grants merge).
5. `effective = Baseline(level, module)` then apply grants (`true` adds / `false`
   removes). Returns the effective key set.

The **ownership implication is handled at the gate, not in `permEffective`**, so the
resolver stays a pure set computation:

```
can(module, verb, isOwner = false):
  eff = effective set for (user, module)
  return  eff.has(verb + '_any')                       // anyone's
       || eff.has(verb)                                 // flat (non-owned modules)
       || (eff.has(verb + '_own') && isOwner)           // only mine
```

Both RLS and the UI use this single rule. RLS DELETE example for photos:
`USING ( has_module_perm('photos','delete_any')
         OR (has_module_perm('photos','delete_own') AND uploaded_by = auth.uid()) )`.
The admin UI mirrors it: toggling a `_any` chip visually lights its `_own` partner.

Helpers stay SECURITY DEFINER, `search_path=public`, STABLE, in the non-exposed
`private` schema (RLS-only, not callable via `/rest/v1/rpc/`).

## Schema (what changed)
The four additive tables stay; only the **catalog metadata** on `perm_modules` grows:
- `perm_modules(key pk, label, category, sort_order, governs text[], description,
  actions text[], action_meta jsonb)`:
  - `actions` keeps the **ordered list of capability keys** for the module (so
    existing readers of the column keep working).
  - `action_meta` (new `jsonb`, default `{}`) maps each key →
    `{ "m": <min_level>, "x": <grant_only?> }`. Ownership pairs are encoded by the
    `_own`/`_any` suffix convention (no extra metadata). The admin UI derives chip
    grouping from `m`/`x` (e.g. dashed = grant-only).
- `permission_templates(id pk, name unique, description, is_system, timestamps)` — unchanged.
- `template_module_perms(template_id fk, module_key fk, level, grants jsonb,
  pk(template_id,module_key))` — unchanged; capability keys live in `grants`.
- `profiles.permission_template_id`, `user_module_overrides(...)` — unchanged.

No changes to the templates/overrides tables: capability keys are values inside the
existing `grants` jsonb, exactly like the 7 verbs were.

---

## Module catalogs

Legend: level letter = `min_level` (`R` read_only · `S` standard · `A` admin).
**†** = `grant_only` (never in baseline; must be explicitly granted). `_own`/`_any`
= ownership pair (`_any` implies `_own`). Pure view-state actions (filter, sort,
search, paginate, zoom, view-mode toggles, opening detail drawers) are **not**
permissions — they are gated by `view`.

### Overview / KPIs — `overview` (category: overview)
governs: kpi_* / vw_* (read views)

| Key | Guards | Lvl |
|---|---|---|
| `view` | dashboard KPIs | R |

### Test Register — `test_register` (category: testing)
governs: test_items, test_results, test_item_status_history, test_item_prerequisites, test_procedures, activity_records

| Key | Guards | Lvl |
|---|---|---|
| `view` | register, drilldowns, matrix | R |
| `export` | line-item CSV export, template + asset CSV export | R |
| `add_activity` | create a new activity / register entry | S |
| `add_test_case` | add/copy a test case, add section, generic child | S |
| `edit_case` | edit case fields/status, reorder, edit activity metadata | S |
| `set_status` | record Pass/Fail/Blocked verdict (**flat** — subsystem scope suffices) | S |
| `field_intake` | submit daily field logs | S |
| `bulk_edit` | bulk status/field apply across selected cases | S **†** |
| `manage_assets` | link/unlink/bulk-link assets, asset CSV import | S |
| `delete_case` | delete a single test case / parent / asset child | A |
| `delete_activity` | delete an activity (cascades cases + results) | A |
| `bulk_delete` | bulk-delete selected cases / activities | A |
| `deploy_field` | flip Future Test → Not Started (deploy to field) | A |
| `manage_p6_links` | link/propagate/unlink P6 activity mappings | A |
| `import` | CSV import of test items (**admin only**) | A |

Decisions: status is a single flat key (no `_own/_any`); `import` is admin-only;
freeform statuses → no per-transition gating.

### Dynamic Testing — `dynamic_testing` (category: testing)
governs: dynamic_instances, access_campaigns, train_requests, zone_access_windows, vw_dynamic_*

| Key | Guards | Lvl |
|---|---|---|
| `view` | instances, access plan, board | R |
| `export` | CSV export, template download | R |
| `create_instance` | new instance, add train request | S |
| `edit_instance` | edit instance fields | S |
| `set_status` | instance status (flat) | S |
| `schedule` | move/allocate/unschedule instances to shifts | S |
| `bulk_edit` | bulk-edit selected instances | S **†** |
| `manage_shifts` | confirm/cancel access windows | A |
| `approve_trains` | approve/deny/substitute/delete train requests | A |
| `delete_instance` | delete an instance | A |
| `import` | procedure/run CSV import | A |

### Test Reports — `test_reporting` (category: testing)
governs: test_reports

| Key | Guards | Lvl |
|---|---|---|
| `view` | report list, linked activities | R |
| `export` | report export | R |
| `create` | create / promote derived report | S |
| `edit` | status change, link/unlink activities | S |
| `sync` | bulk auto-create missing reports | S **†** |
| `delete` | delete report (cascades revisions + clears links) | A |

### Punch List — `punch_list` (category: field)
governs: punch_items, punch_history

| Key | Guards | Lvl |
|---|---|---|
| `view` | list + detail | R |
| `export` | export punch PDF | R |
| `create` | create punch item | S |
| `edit` | edit punch item | S |
| `comment` | add comments, attach/sign photos | S |
| `link_test` | link/unlink punch ↔ test case | S |
| `advance_status` | participate in transitions you're assigned to | S |
| `import` | bulk CSV import | S **†** |
| `delete` | soft-delete / restore (bin) | A |
| `override_workflow` | force a transition regardless of assignment | A **†** |

Wrinkle: the workflow state machine
(`draft→initiated→work_required→ready_for_review→ready_to_close→closed` + dispute
branches) is **relationship-gated on the record** via `punch_item_manager` /
`final_approver` — kept as-is. `advance_status` means "may act on transitions you
are assigned to"; `override_workflow` is the admin escape hatch.

### RMA — `rma` (category: field)
governs: rmas

| Key | Guards | Lvl |
|---|---|---|
| `view` | list + detail | R |
| `export` | CSV export, single PDF | R |
| `create` | create RMA | S |
| `edit` | edit RMA | S |
| `change_status` | status change — **triggers an external email** | S **†** |
| `delete` | delete RMA | A |

### Forms — `forms` (category: field)
governs: forms, form_test_item_links, form_template_links, fieldset_config

| Key | Guards | Lvl |
|---|---|---|
| `view` | view + download PDF | R |
| `upload` | upload / re-upload form file | S |
| `fill_pdf` | annotate / save field values | S |
| `link` | link/unlink to test items & templates | S |
| `delete` | delete a form | A |
| `manage_fieldsets` | edit dropdown option config (global) | A |

### Photos — `photos` (category: field)
governs: photos, photo_albums, photo_album_items

| Key | Guards | Lvl |
|---|---|---|
| `view` | browse timeline/albums, lightbox, **and download** originals | R |
| `upload` | upload / capture photos | S |
| `edit_metadata_own` | caption/tags/location on photos you uploaded | S |
| `edit_metadata_any` | edit metadata on anyone's photos (implies `_own`) | A |
| `delete_own` | delete photos you uploaded | S |
| `delete_any` | delete anyone's photos (implies `_own`) | A |
| `create_album` | create a manual album | S |
| `manage_album_contents` | add/remove photos to/from albums, set cover | S |
| `manage_album_own` | rename/delete albums you created | S |
| `manage_album_any` | rename/delete anyone's album (implies `_own`) | A |

Decisions: download is covered by `view` (no separate key); metadata edit is the
`_own`/`_any` pair (standard = own, admin = any).
**Deferred:** external photo sync (SharePoint, or possibly Azure Blob) lands after
the IT integration; a `sync_external` **†** key will be added then. Not in the
active catalog.

### Meetings — `meetings` (category: planning)
governs: meetings, meeting_*, meeting_action_items

| Key | Guards | Lvl |
|---|---|---|
| `view` | view meeting | R |
| `export` | export PDF | R |
| `create` | create meeting | S |
| `edit` | edit meeting metadata | S |
| `manage_agenda` | categories + items CRUD, apply template | S |
| `record_minutes` | per-item minutes, convert to Minutes mode | S |
| `manage_action_items` | create/edit/close/delete action items | S |
| `manage_attendees` | add/remove/import attendees | S |
| `create_followup` | clone + carry-forward open items | S |
| `delete` | delete meeting | A |

Today all of this is `role==='admin'`; the split lets a secretary record minutes +
manage action items without full meeting CRUD.

### Planning & Resources — `planning` (category: planning)
governs: planning_resources, planning_activities, pto_requests, shift_templates, planning_week_snapshots

| Key | Guards | Lvl |
|---|---|---|
| `view` | roster, conflicts, snapshots | R |
| `pto_submit` | submit own PTO (requires a linked resource) | S |
| `pto_approve` | approve/reject/reopen PTO | A |
| `resolve_conflicts` | acknowledge + resolve unmatched resources/activities | A |
| `manage_resources` | create/edit/(de)activate planning resources | A |

Delegation value: `pto_approve` / `resolve_conflicts` can go to a planning lead who
is not a global admin.

### Look-ahead — `lookahead` (category: planning)
governs: planning_events, planning_event_resources, planning_activity_resources, planning_conflicts

| Key | Guards | Lvl |
|---|---|---|
| `view` | grid, snapshots | R |
| `export` | PDF / XLSX / CSV export | R |
| `create_event` | cell creator | S |
| `edit_event` | drawer edit | S |
| `cancel` | cancel event + reason | S |
| `manage_activities` | activity row CRUD, status override, link to test schedule | S |
| `assign_resources` | assign/remove resources on event or activity | S |
| `bulk_edit` | bulk shift/location/hours/cancel | S **†** |
| `lock` | lock / unlock events | A |
| `delete` | hard-delete event | A |
| `import` | `.xlsx` lookahead import | A |

### P6 Schedule — `schedule_p6` (category: planning)
governs: p6_*

| Key | Guards | Lvl |
|---|---|---|
| `view` | schedule view | R |
| `import` | baseline/current P6 import | A |
| `rebaseline` | mark prior baseline superseded | A |
| `manage_links` | link/unlink/propagate mappings, accept suggestions | A |
| `remove_activities` | remove / bulk-remove P6 entries | A |

### Assets — `assets` (category: data)
governs: assets, asset_test_links, asset_import_batches

| Key | Guards | Lvl |
|---|---|---|
| `view` | table | R |
| `export` | CSV export / template | R |
| `add` | manual asset create | S |
| `edit` | edit asset | S |
| `link` | link/unlink asset ↔ test | S |
| `bulk_edit` | bulk device-type / location | S **†** |
| `import` | batch CSV import | A |
| `bulk_delete` | bulk delete assets | A |

### Track Plan — `track_plan` (category: data, data-only)
governs: track_*, train_control_locations

| Key | Guards | Lvl |
|---|---|---|
| `view` | preview matching devices/zones in dynamic-scope picker | R |
| `manage` | define/apply dynamic filters saved to test cases | A |

### Drawings — `drawings` (category: data)
governs: drawing_sets, drawing_sheets, drawing_markups

| Key | Guards | Lvl |
|---|---|---|
| `view` | view sets/sheets + published markups | R |
| `create_markup` | draw annotations (own draft) | S |
| `edit_markup_own` | edit/delete own draft (`created_by=me && !published`) | S |
| `publish` | publish draft → visible to all | S |
| `manage_markup_any` | load/edit/delete any markup incl. published (implies `_own`) | A |
| `upload_set` | upload + calibrate + confirm import drawing set | A |
| `delete_set` | delete a drawing set | A |

Second home of the ownership axis: `edit_markup_own` (standard) vs
`manage_markup_any` (admin); `is_published` is part of the "own" predicate.

### Locations — `locations` (category: data)
governs: locations

| Key | Guards | Lvl |
|---|---|---|
| `view` | location tree | R |
| `create` | create node | S |
| `edit` | edit node | S |
| `delete` | delete node | A |
| `import` | bulk CSV import | A |

### Directory / People — `directory` (category: admin)
governs: profiles, users

| Key | Guards | Lvl |
|---|---|---|
| `view` | people directory + org chart | R |
| `manage_org_chart` | add/edit/remove team-chart members | S |
| `invite` | create profile + auth account | A |
| `edit_profile` | name/company/subsystem edits | A |
| `activate` | toggle `is_active` (activate/deactivate) | A |
| `remove` | delete a profile | A |
| `assign_template` | set `permission_template_id` | A |
| `grant_global_admin` | set `role='admin'` — **privilege escalation** | A **†** |

`grant_global_admin` is the keys-to-the-kingdom action — `grant_only` even at admin,
so a delegated directory manager can invite/assign templates without minting admins.

### Test Templates — `templates` (category: admin)
governs: templates, template_test_cases, deployments, deployment_locations, test_instances

| Key | Guards | Lvl |
|---|---|---|
| `view` | view templates | R |
| `export` | test-case CSV export | R |
| `create` | create template / section / case, attach form | S |
| `edit` | edit template / cases | S |
| `delete` | delete template (cascades deployments) | A |
| `deploy` | deploy template → locations (writes to live register) | A |

### Scoring Weights — `weights` (category: admin)
governs: activity_weights, test_case_weights

| Key | Guards | Lvl |
|---|---|---|
| `view` | weights tables | R |
| `edit_activity` | activity weights | A |
| `edit_test_case` | per-case weights | A |
| `bulk_apply` | apply one weight to all cases in an activity | A **†** |

Weights drive every KPI → editing is admin-tier; bulk apply grant-gated on top.

### Software Config — `config` (category: admin)
governs: software_configs

| Key | Guards | Lvl |
|---|---|---|
| `view` | config history | R |
| `create` | add config | S |
| `new_version` | clone as a new version | S |
| `edit` | edit version fields | S |
| `delete` | delete a version / history row | A |

### Audit Log — `audit` (category: admin)
governs: audit_log, db_change_log (read)

| Key | Guards | Lvl |
|---|---|---|
| `view` | search/browse the log | R |
| `export` | CSV export | R |

Read-only by nature — no create/edit/delete.

### Permissions Admin — `admin` (category: admin)
governs: permission_templates, template_module_perms, user_module_overrides, perm_modules

| Key | Guards | Lvl |
|---|---|---|
| `view` | see templates / overrides | A |
| `manage_templates` | create/edit/duplicate/delete templates + module perms | A **†** |
| `manage_overrides` | edit per-user overrides | A **†** |

Governs the permission system itself → both write keys are `grant_only`, so "can see
who has what" is separable from "can change who has what".

---

## System templates (remapped to capability keys)
The six seed templates are rewritten in the new vocabulary. They must reproduce
existing effective access on cut-over (the migration maps old generic-verb grants to
the expanded set without changing anyone's reach):

- **Administrator** ← `admin` — `admin` on every module **plus** the `grant_only`
  keys (`grant_global_admin`, `manage_templates`, `manage_overrides`,
  `override_workflow`) granted explicitly. (Global-admin `role='admin'` users still
  bypass templates entirely.)
- **Field Engineer** ← `field_engineer`, `field` — `standard` on
  testing/field/lookahead/drawings (incl. `bulk_edit` grants where they curate);
  `read_only` on overview/planning/schedule/assets/locations; `none` on admin.
- **Punch Manager** ← `punch_manager` — `admin` on `punch_list` (incl.
  `override_workflow`) + `rma`; `standard` on `photos`/`forms`; `read_only` on
  overview/test_register; `none` on admin.
- **Technician** ← `technician` — `standard` on `punch_list` (assigned) + `photos`
  (own-scoped: `delete_own`, `edit_metadata_own`, `manage_album_own`); `read_only`
  on overview/test_register/drawings; `none` elsewhere.
- **Client Reviewer** ← `client` — `read_only` on
  overview/punch_list/test_reporting/forms/meetings/photos; `none` elsewhere.
- **Read Only** ← `readonly` — `read_only` on all non-admin view modules; `none` on
  admin.

---

## Build plan & status
The model ships behind a **strict-superset union baseline**, so steps land
incrementally with no interim breakage.

1. **Catalog seed — DONE.** `perm_modules.action_meta` (`{m:min_level, x:grant_only}`)
   + ordered `actions` for all 22 modules. Migration
   `perm_granular_catalog_seed`; recorded in
   `supabase/sql/supabase_perm_granular_catalog.sql`.
2. **DB baseline + resolver — DONE.** `private._perm_baseline(module, level)`
   returns legacy-7 ∪ granular keys; `private.has_module_perm` rewired (migration
   `perm_baseline_module_aware_union`). Client mirror in `perms-admin.js`
   (`PERM_CATALOG`, `permBaseline(level, module)`, `permEffective(…, module)`,
   `can(module, verb, isOwner)` with `_any ⇒ _own`). Pinned by
   `tools/test_perm_resolver.js`.
3. **Admin UI — DONE.** Permissions admin renders granular chips per module with
   grant-only (dashed) styling and `_own`/`_any` implication lighting; templates,
   overrides, and the Effective preview all use the module-aware resolver.
4. **UI gates — PILOT DONE, rest batched.** Photos delete routes through
   `can('photos','delete',isOwner)`. Remaining `app.js` call sites convert
   incrementally (fail-open; RLS authoritative).
5. **RLS per-table conversion — IN PROGRESS.** Recorded in
   `supabase/sql/supabase_perm_rls_granular.sql`; SELECT stays `view`; writes OR
   the capabilities that legitimately perform each command (no false denials);
   advisors re-run per batch (clean).
   - **Converted:** `test_register` (test_items, test_procedures,
     test_item_status_history, test_item_prerequisites, activity_records);
     `photos` (+ `_own`/`_any` ownership); `dynamic_testing` (dynamic_instances);
     `forms`; `drawings` (+ markup ownership via `created_by=auth.uid()`);
     `assets`; `schedule_p6`; `track_plan`; `weights`.
   - **Already aligned (no migration needed)** — catalog kept `view/create/edit/
     delete` as keys, so existing policies already check them: `rma`,
     `test_reporting`, `meetings`, `locations`, `config`, `templates`,
     `punch_list` (create/edit/delete; `advance_status`/`comment` are UPDATEs
     covered by `edit`), `audit`, `overview`.
   - **Deferred (need a decision, not a blind verb swap):**
     - `directory` + `admin`: a `profiles`/perm-table UPDATE can't be
       distinguished by column in RLS, so gating on `edit_profile` would let it
       also change `role`/`permission_template_id` — defeating
       `grant_global_admin`/`manage_*` being grant-only. Needs a **column-level
       guard** (trigger or restrictive policy on `role`/template columns). Global
       admins bypass, so today's behaviour is unchanged.
     - `planning` + `lookahead`: all `planning_*` tables are governed by the
       **`planning`** module in RLS, but the catalog assigns events/resources to
       **`lookahead`**. Converting would **reassign** governance — an
       access-semantics change to confirm first.
     - `dynamic_testing` secondary tables (`access_campaigns`, `train_requests`,
       `zone_access_windows`): no dedicated catalog key; left on the (still
       working) coarse verbs.
     - `test_results`: governed by `test_reporting`; already uses that module's
       create/edit/delete keys.
6. **Ownership-identity — RESOLVED for photos without a column migration.** Photos
   ownership RLS matches `uploaded_by`/`created_by` to the signed-in user's
   `profiles.full_name` (mirroring the UI's `=== userName()`); verified against
   live data. `drawing_markups.created_by` is already `uuid` and RLS-ready for the
   drawings batch.
7. **Template remap — N/A at cut-over.** Because the baseline is module-aware by
   *level*, existing template levels already yield the granular keys; the only
   non-empty grant in the DB (Client Reviewer · lookahead · `{view,export}`)
   remains valid. No regrant needed.

Verification: `node tools/run_tests.js` exits 0 (23 suites incl. resolver + UI-can
+ boot smoke + characterization). Per-table RLS conversion adds the per-template
matrix as it rolls out.
