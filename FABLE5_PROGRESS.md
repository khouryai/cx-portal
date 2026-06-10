# Fable 5 Progress Ledger

## ▶ Current position
- Phase: 2 — DB performance. P1 (security) DONE; P2-1/P2-2/P2-4 DONE, P2-3
  decided (no-op, see below). Security advisors: only auth_leaked_password
  remains (dashboard-only, P1-6). Performance advisors: ALL WARN-level lints
  CLEARED (auth_rls_initplan 49→0, unindexed_foreign_keys 42→0, duplicate_index
  1→0, multiple_permissive_policies 1→0). Only INFO unused_index remains (121,
  expected — see P2-3). All verified (RLS still permits as authenticated admin).
- Doing right now: Phase 3 started — P3-2 (test harness + CI) DONE & committed.
  Next = P3-1 (incremental ES-module split of app.js) or P3-3 (dead-code/data.js
  audit) — both larger, multi-step; P3-1 is the architecture spine.
- Exact next action: P3-1 — carve the first safe ES-module seam out of app.js
  (start with leaf pure-helpers already unit-tested, e.g. planning stats / copy-
  paste logic) behind existing globals, keeping the app deployable each commit.
- AUTHORIZATION FINDING — RESOLVED (P1-9, owner chose "tighten all"): the 43
  blanket `auth_all` tables now enforce the permission model. 40 mapped 1:1 to a
  module (full per-command has_module_perm gating); fieldset_config + locations =
  reference data (SELECT to all authenticated, writes module-gated, so cross-
  module UI dropdowns don't break); pto_requests = self-service (own-row + planning
  manager override); audit_log/db_change_log = audit module (admin-only reads).
  Verified per-role: Field Engineer sees test_items/meetings/locations but 0 of
  18,513 db_change_log rows (admin sees all). No advisor regressions.
- P1-6 BLOCKER (leaked-password protection): not doable from this environment.
  It is a GoTrue/Auth config toggle, not SQL; no Management API PAT is present
  in env, no Supabase CLI, no token file (api.supabase.com reachable but 403),
  and the Supabase MCP server exposes no auth-config tool. Requires the owner to
  flip it in Dashboard → Authentication → Sign In / Providers → Password →
  "Leaked password protection" (or PATCH /v1/projects/{ref}/config/auth
  {"password_hibp_enabled":true} with a PAT). One toggle, ~15s.
- Half-finished state: none. All DB changes are applied migrations + verified.
- Verification note: test profiles can't be persisted (profiles.id FK→auth.users);
  RLS verified via ephemeral rolled-back JWT-claim simulation. Real auth test
  users to be created in Phase 4 for UI/E2E. profiles_role_check allows only
  admin/field_engineer/readonly (legacy data inconsistency; templates supersede).

## Architecture decision (2026-06-10, owner-authorized)
- **Deliver a modern framework end-state via STRANGLER migration**, not a
  big-bang rewrite. Owner authorized a full rebuild "if needed"; chosen execution
  stands up the new stack alongside legacy and ports module-by-module so the app
  stays deployable every commit. Phase 1 (perms/security) is framework-agnostic
  DB work → proceeds first; the permissions ADMIN UI (P1-8) will be built natively
  in the new stack (Phase 3) rather than thrown away in legacy.
- README.md flagged STALE/outdated by owner (2026-06-10) — ignore as source of
  truth; rewrite or delete in Phase 7. Ground truth = live DB + code.

## Decisions log
- 2026-06-10: Engagement begun per FABLE5_AUDIT_PROMPT.md. Owner directives:
  full implementation, all priority areas, full DB latitude, modern rebuild
  allowed if justified, work directly on `main` (test repo, no real users yet).
- 2026-06-10: Architecture direction (proposed, pending owner ack): **incremental
  modularization (strangler pattern), NOT a from-scratch rebuild.** Rationale:
  ~39k-line app.js is splittable into ES modules behind the existing globals;
  a ground-up framework rebuild of a 15-module working app under session limits
  risks a long broken/parallel period and violates "deployable at every commit."
  Introduce design tokens + component patterns within the current stack first;
  revisit a framework only if modularization hits a wall.

## Baseline (Phase 0 snapshot — 2026-06-10)
- Git: main @ 067e779 (clean).
- Code size: app.js 38,920 lines (1.98MB); styles.css 13,509; index.html 1,551;
  photos.js 1,050; markup.js ~38KB; data.js 1.23MB (mock-data legacy, audit pending).
- Security advisors: 1 CRITICAL (RLS disabled on `demo_seed_log`); 9 SECURITY
  DEFINER views (vw_dynamic_*, vw_test_case_completion, vw_procedure_completion,
  kpi_test_progress); ~27 tables with always-true ALL policies; 3 SECURITY
  DEFINER functions executable by anon (audit_db_change, capture_planning_week,
  is_admin); 2 functions with mutable search_path; leaked-password protection OFF.
- Performance advisors: 49 auth_rls_initplan; 42 unindexed FKs; 77 unused
  indexes; 1 duplicate index; 1 multiple-permissive-policies.
- DB: ~76 public tables. Empty (candidate unfinished features): test_results,
  punch_history, punch_photos, template_test_cases, deployments,
  deployment_locations, test_instances, meeting_templates(+cats/items),
  meeting_attendees, planning_import_batches, software_configs,
  form_template_links, drawing_markups, access_campaigns, train_requests,
  photo_album_items, test_item_prerequisites.
- Nav/IA: two grab-bag sections ("Work", "Views") + full-swap Admin mode;
  inconsistent grouping (drawings/dynamic-testing under Views; schedule split
  from admin-p6); sidebar uses ad-hoc inline SVGs, not the icon() map.
- Pending baseline items: screenshots (incl. sidebar), Lighthouse/perf snapshot,
  heavy-query timings. (P0-4)

## Audit findings — feature gaps (P0-3a, 2026-06-10)
**Corrections to baseline assumptions:**
- **Photos: FULLY WIRED** (not stubbed). photos.js uploads to Storage bucket
  `photos` via REST (`storageUpload()` ~line 137), client-side compression,
  offline IndexedDB queue w/ auto-flush, paginated gallery w/ lazy signed URLs,
  albums (auto + manual), punch/daily-log integration, ZIP download. Missing:
  SharePoint sync (sp_* columns are stubs). → P5-1 rescoped: verify e2e + add
  tests, not build.
- **Dead schema (no code refs): `punch_photos` (replaced by `photos`),
  `punch_history`, `template_test_cases`, `deployment_locations`,
  `test_instances`.** → candidates for documented drop (HARD GATE: owner yes).
- **`deployments` HALF-BUILT:** read-only from in-memory DATA.deployments
  (data.js seed); count shown in UI; no DB read/write. → finish or retire.
- **`test_results` write-only:** 9 write sites, zero UI reads (attempt log only).
  → decide: surface in UI or document as log-only.
- Wired-but-empty (just unused, no work needed): meeting_templates/attendees,
  planning_import_batches, software_configs, form_template_links,
  drawing_markups, access_campaigns, train_requests, photo_album_items,
  test_item_prerequisites.
- **Nav stubs without handlers:** activities, audit, lineitems, team (+
  punch-workflow flagged ambiguously — verify; login handled separately).
  `tcv` page has handler but no nav link (internal).
- Edge functions: send-daily-log-email (app.js:7063, fire-and-forget inside
  submitIntakeFinal), send-rma-email (app.js:17604). No other invocations.
- TODO/FIXME/HACK markers: zero across all JS.

## Audit findings — frontend architecture (P0-3b, 2026-06-10)
- Structure: ~40 banner-delimited sections; admin renders dominate (lines
  ~3473–38920). Init at DOMContentLoaded ~2275. Auth/session 2896–3421.
- State: 277 underscore-prefixed globals; no framework; rendering = template
  literals + innerHTML (102 full-section replaces) + 198 appendChild/insertAdjacentHTML.
- Coupling: **44 inline onclick= handlers in index.html require global fns** —
  blocks naive ES-module export. Mitigation: global-shim module first (Option B),
  event-delegation refactor later. window.* exports: icon, PhotosModule, _p (75
  uses), etc. Load order strict: data.js → app.js → photos.js → markup.js.
- Data layer: _db* helpers well-adopted (115 update / 90 insert / 78 delete /
  27 select); native-fetch by design (supabase-js hang workaround); 4 direct
  supabase.* calls (auth only). No dead code in data layer.
- Dead weight: data.js (1.2MB) is **fallback-only** — removable once Supabase
  is mandatory (also cached by SW — real load cost). chart.umd.js active (13
  charts). photos.js/markup.js feature-critical.
- Perf: ~225 DOM queries inside loops; dashboard destroys+rebuilds all charts
  on view switch; innerHTML layout thrash. Grade C+; quick wins identified.
- Modularization verdict: **incremental strangler split is viable** —
  (0) .gitattributes/CRLF guard, (1) extract non-handler utils to lib/,
  (2) table/dashboard modules, (3) admin feature modules, (4) onclick →
  event delegation last. GitHub Pages supports type="module" (no build needed).

## Phase plan & backlog
### Phase 0 — Orient & baseline
- [x] P0-1 (DONE) Read codebase + docs (CLAUDE/README/SECURITY/docs/)
- [x] P0-2 (DONE) Run security + performance advisors, snapshot counts (above)
- [x] P0-3 (DONE) Parallel audits: frontend architecture; feature gaps (findings above)
- [ ] P0-4 (DEFERRED→Phase 4 start) Visual/perf baseline: screenshots,
      Lighthouse, query timings — capture immediately before UX work begins
- [x] P0-5 (DONE) Phase 0 checkpoint report to owner (incl. architecture rec)

### Phase 1 — Permission model + security hardening
- [x] P1-1 (DONE) Design Procore-style permissions schema → PERMISSIONS_MODEL.md
- [x] P1-2 (DONE) Built has_module_perm()/_perm_baseline(); 22-module catalog;
      6 system templates absorbing all 6 legacy role values; assigned 3/3
      profiles. Verified (75 grants, resolver correct). Global-admin shortcut +
      is_active guard prevent zero-admin/lockout. Migrations: perm_module_
      infrastructure, perm_module_seed_and_assign, perm_baseline_fix_search_path.
- [x] P1-3 (DONE) Enabled RLS on demo_seed_log (admin-only policy). Advisor
      delta: rls_disabled_in_public 1→0. Migration: enable_rls_demo_seed_log.
- [x] P1-4 (DONE) Rewrote 24 always-true tables → command-specific
      has_module_perm()-driven policies, (select ...)-wrapped. Advisor delta:
      rls_policy_always_true 24→0. Verified via per-role matrix (all 6 templates
      correct). Migration: rls_rewrite_alwaystrue_to_permission_model.
- [x] P1-5 (DONE) 9 SECURITY DEFINER views → security_invoker (re-verified an
      authenticated admin still reads them: tcc=1111, kpi=1111, gcov=1). Locked
      EXECUTE: audit_db_change + capture_planning_week → postgres/service_role
      only (trigger-only / cron-only, never frontend); is_admin → dropped
      anon+PUBLIC, kept authenticated (RLS needs it). Pinned search_path=public
      on planning_touch_updated_at + fn_feasible_instances. THEN moved the two
      RLS helpers (is_admin, has_module_perm) to a new non-exposed `private`
      schema so they are no longer PostgREST-RPC-callable, clearing the residual
      0029 warnings while RLS keeps working (policies bind by OID; authenticated
      granted USAGE on private). Advisor delta: security_definer_view 9→0,
      function_search_path_mutable 2→0, anon_security_definer 3→0,
      authenticated_security_definer 4→0. Verified RLS post-move (perm_modules=22,
      dynamic_instances=22 as authenticated admin). Migrations:
      p1_5_secdef_views_func_execute_searchpath, p1_5_move_rls_helpers_to_private_schema.
- [ ] P1-6 (BLOCKED — owner action) Enable leaked-password protection. NOT doable
      from this environment (Auth/GoTrue config, not SQL; no Management API PAT /
      CLI / token available; MCP has no auth-config tool). Owner: Dashboard →
      Authentication → Password policy → enable "Leaked password protection".
- [x] P1-7 (DONE for DB layer) Per-role verification via ephemeral JWT-claim
      simulation. Real auth test users deferred to Phase 4 (UI/E2E).
- [x] P1-9 (DONE) Tightened all 43 remaining `auth_all` (any-authenticated full
      CRUD) tables onto the permission model. 40 module-scoped (meetings/planning/
      schedule_p6/punch_list/rma/assets/templates/test_register/test_reporting/
      audit) with per-command has_module_perm gating; fieldset_config+locations as
      read-all reference data with module-gated writes; pto_requests self-service
      (own-row + planning override). Verified per-role (FE: 0/18513 db_change_log;
      admin: all). No advisor regressions. Migration:
      p1_tighten_auth_all_tables_onto_permission_model. NOTE: a few module
      mappings are best-judgment (activity_records→test_register,
      delay_log/test_results→test_reporting, test_instances→templates) — revisit
      if a screen turns up empty for a role that should see it.
- [ ] P1-8 (TODO, Phase 3 stack) Permissions admin UI: directory, template
      editor, per-user overrides, effective-permissions preview

### Phase 2 — DB performance
- [x] P2-1 (DONE) Wrapped auth.<fn>() in (select ...) across 49 policies:
      43 `auth_all` (loop), profiles_select/_update, 4 user_column_prefs.
      Semantics-preserving. Advisor: auth_rls_initplan 49→0. Verified RLS still
      permits as authenticated admin. Migration: p2_1_wrap_auth_calls_in_rls_initplan.
- [x] P2-2 (DONE) Added 42 FK covering indexes (catalog-derived, IF NOT EXISTS).
      Advisor: unindexed_foreign_keys 42→0. Migration: p2_2_add_fk_covering_indexes.
- [x] P2-3 (DECIDED — deliberate no-op) Did NOT drop "unused" indexes. On this
      seed/low-traffic DB "unused" = no scan stats yet, not redundant; 42 of them
      are the FK indexes just added (best practice; prevent prod lock/scan), and
      pre-existing lookup indexes will be used under real traffic. Dropping to
      satisfy an INFO lint would regress production. Revisit only with real
      pg_stat_user_indexes data from production traffic (Phase 7). The genuinely
      redundant case (1 duplicate index) WAS dropped under P2-4.
- [x] P2-4 (DONE) Dropped duplicate index idx_dynamic_instances_tsut (identical
      to dynamic_instances_tsut_idx). Split shift_templates_write (FOR ALL,
      overlapped SELECT) into command-specific ins/upd/del admin policies so
      SELECT has a single permissive policy. Advisor: duplicate_index 1→0,
      multiple_permissive_policies 1→0. Behavior preserved (all auth read; admin
      writes). Migration: p2_4_dedupe_index_and_consolidate_shift_templates.
- NOTE: unused_index INFO rose 80→121 by design (new FK indexes unscanned until
  traffic). Not a regression; see P2-3.

### Phase 3 — Frontend foundation
- [ ] P3-1 (TODO) Execute architecture direction (incremental ES-module split)
- [x] P3-2 (DONE) Test harness — committed `tools/run_tests.js` (node --check on
      app.js/photos.js/markup.js + runs the 3 headless suites: test_activity_stats,
      markup_test, test_copy_paste = 88 assertions, all green) + CI workflow
      `.github/workflows/test.yml` (push/PR). DELIBERATELY package.json-free:
      repo deploys static to GH Pages publishing the root verbatim, and root
      package.json is gitignored by owner convention. Sole test dep `dayjs` is
      installed transiently in CI (`npm install --no-save dayjs@1.11.13`); runner
      SKIPs (not fails) the copy/paste suite if dayjs is absent locally. If owner
      later prefers a committed package.json, trivial to switch.
- [ ] P3-3 (TODO) Dead-code removal (data.js audit, unused functions)
- [ ] P3-4 (TODO) Design tokens / component patterns on Hitachi palette

### Phase 4 — UX, visual & accessibility
- [ ] P4-1 (TODO) Restructure left-sidebar IA (permission-driven groups; dissolve
      Admin-mode swap; icon() unification; mobile/PWA)
- [ ] P4-2 (TODO) A11y pass (labels/contrast/keyboard/focus; axe clean)
- [ ] P4-3 (TODO) Loading/empty/error states consistency pass

### Phase 5 — Feature completeness
- [ ] P5-1 (TODO) Photo upload end-to-end via storage-agnostic adapter
- [ ] P5-2 (TODO) Triage empty-table features (finish / wire / deprecate, per audit)

### Phase 6 — Integration prep
- [ ] P6-1 (TODO) Azure/SharePoint incremental steps per docs/sharepoint-integration

### Phase 7 — Hardening & handoff
- [ ] P7-1 (TODO) Full regression + advisor zero + docs update + final report

## Migrations applied
- perm_module_infrastructure (2026-06-10) — new tables (perm_modules,
  permission_templates, template_module_perms, user_module_overrides) +
  profiles.permission_template_id + has_module_perm()/_perm_baseline() + RLS on
  new tables + FK indexes. Advisor delta: +1 WARN (_perm_baseline search_path),
  no new ERRORs/always-true. Reversible (additive).
- perm_module_seed_and_assign (2026-06-10) — 22 modules, 6 templates, 75 grants,
  3/3 profiles assigned. Data-only.
- perm_baseline_fix_search_path (2026-06-10) — set search_path='' on
  _perm_baseline. Advisor delta: -1 WARN (back to baseline security counts).
- enable_rls_demo_seed_log (2026-06-10) — RLS + admin-only policy on
  demo_seed_log. Advisor delta: rls_disabled_in_public 1→0 (CRITICAL resolved).
- rls_rewrite_alwaystrue_to_permission_model (2026-06-10) — 24 tables: dropped
  always-true ALL policies, created select/insert/update/delete policies driven
  by has_module_perm() wrapped in (select ...). Advisor delta:
  rls_policy_always_true 24→0; contributes to initplan perf fix. Reversible
  (could restore permissive policies). Verified per-role matrix.
- p1_5_secdef_views_func_execute_searchpath (2026-06-10) — 9 views→security_invoker;
  revoked EXECUTE (audit_db_change, capture_planning_week from public/anon/auth;
  is_admin from public/anon); pinned search_path=public on planning_touch_updated_at
  + fn_feasible_instances. Advisor delta: security_definer_view 9→0,
  function_search_path_mutable 2→0, anon_security_definer 3→0. Verified invoker
  views still read for authenticated admin.
- p1_5_move_rls_helpers_to_private_schema (2026-06-10) — created `private` schema
  (USAGE→authenticated,service_role), moved is_admin() + has_module_perm(text,text)
  into it. RLS unaffected (OID-bound policies). Advisor delta:
  authenticated_security_definer 2→0. Only remaining lint: auth_leaked_password
  (dashboard-only). Verified RLS post-move as authenticated admin.
- p2_1_wrap_auth_calls_in_rls_initplan (2026-06-10) — wrapped auth.<fn>() in
  (select ...) across 49 policies (43 auth_all via loop + profiles x2 + 4 ucp).
  Advisor delta: auth_rls_initplan 49→0. Semantics-preserving; verified.
- p2_2_add_fk_covering_indexes (2026-06-10) — 42 FK covering indexes
  (IF NOT EXISTS). Advisor delta: unindexed_foreign_keys 42→0; unused_index
  80→121 (expected, FK indexes unscanned until traffic).
- p2_4_dedupe_index_and_consolidate_shift_templates (2026-06-10) — dropped dup
  idx_dynamic_instances_tsut; split shift_templates_write FOR ALL → ins/upd/del.
  Advisor delta: duplicate_index 1→0, multiple_permissive_policies 1→0.
- p1_tighten_auth_all_tables_onto_permission_model (2026-06-10) — replaced
  `auth_all` on 43 tables with command-specific policies: 40 module-scoped via
  private.has_module_perm(module,action) (loop), fieldset_config+locations
  read-all/module-write, pto_requests own-row+planning, audit_log/db_change_log
  audit-only. All (select ...)-wrapped → no initplan/permissive regressions.
  Verified per-role. Closes the auth_all authorization gap.

## Checkpoints sent
- 2026-06-10: Phase 0 complete report — baseline, audit corrections,
  architecture rec. Owner replied: do a full framework rebuild if best (→ chose
  strangler), full DB latitude, README is stale, continue.
- 2026-06-10: P1 GATE — permission model built & verified; requesting OK to
  rewrite the ~27 existing-table RLS policies onto it (this message).

## Open questions for owner
- Architecture direction: proceeding with **incremental modularization**
  (audit-confirmed viable; from-scratch rebuild rejected as violating
  deployable-at-every-commit under session limits). Object if you want the
  full rebuild instead.
- Phase 5 will propose dropping dead tables (punch_photos, punch_history,
  template_test_cases, deployment_locations, test_instances) — destructive,
  needs explicit yes when we get there.
