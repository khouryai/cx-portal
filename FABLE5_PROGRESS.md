# Fable 5 Progress Ledger

## ▶ Current position
- Phase: 7 is all that's materially left. P1 (security) DONE, P2 (DB perf) DONE
  (advisors: only the Pro-plan-gated auth_leaked_password WONT-FIX + expected
  INFO unused_index remain), P3 DONE (strangler modules icons/format/cx-state/
  compute/perms-admin + 18-suite characterization harness + P3-4 token
  consolidation), P4-1 mostly done (perm-driven nav, IA regroup, uiCan batch 1;
  admin-mode dissolve + sidebar icon() unification deferred pending browser QA),
  P4-2 headless a11y pass DONE (browser/axe pass remains), P4-3 cx* adoption
  done, P5-1 verified, P6-1 CODE COMPLETE (SharePoint sync deployed, awaiting
  IT credentials only). The Dynamic Testing ⇄ Lookahead integration (owner-
  directed, beyond original scope) is fully built: shared records, bidirectional
  cancel sync, auto-roll-forward, cascade + program-level auto-allocation,
  per-day multi-zone access, what-if compare, closures.
- Doing right now: between batches. Last 3 commits: P3-4 token consolidation
  (034d234), P4-2 static a11y pass (493a78a), P6-1 SharePoint sync (03cbe38).
- Exact next action: the remaining items all need OWNER INPUT or a browser:
  (1) browser QA of Dynamic Testing UI + sidebar regroup + a11y/axe run;
  (2) prerequisite hard-gate decision (soft-ordering today, owner choice);
  (3) IT ticket for SharePoint credentials (then set 4 secrets, test 1 photo);
  (4) P7-1 final hardening: full regression, advisor re-run, README rewrite
      (flagged stale by owner), final report — best done AFTER 1–3 land.
  (P5-2 dead-table drops: DONE 2026-06-12, owner-approved.)
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
- [x] P1-6 (CLOSED — WONT-FIX, plan-gated) Leaked-password protection. Owner
      confirmed Free plan (2026-06-11); the HaveIBeenPwned toggle (Auth → Sign In/
      Providers → Email → Passwords) is Pro-plan-and-above only, so it cannot be
      enabled on the current plan by anyone (dashboard, PAT, or MCP). Re-enable in
      one toggle if/when the project upgrades to Pro. Accepted residual WARN.
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
- [x] P1-8 (DONE — v1) Permissions admin UI shipped as a NEW module
      perms-admin.js (strangler-native, loaded after app.js): Admin →
      Permissions page (nav + page-admin-permissions + showPage hook).
      • Templates tab: per-template 22-module grid grouped by category — level
        select (none/read_only/standard/admin) + 7 action chips with explicit-
        grant highlighting; immediate upsert to template_module_perms (PK
        verified template_id,module_key); new/rename/duplicate/delete (system
        templates protected; delete blocked while users assigned).
      • Users & Overrides tab: assign profiles.permission_template_id; per-user
        override editor (add/edit/remove user_module_overrides, PK verified);
        EFFECTIVE preview per module with source (template/override/global-admin/
        inactive) computed by a pure client resolver permEffective() that mirrors
        private.has_module_perm — pinned by tools/test_perm_resolver.js (18
        assertions: baseline tiers, inactive/global-admin guards, override level
        REPLACES / grants MERGE, grant true-adds/false-removes, canonical order).
      • Writes ride the admin's JWT through _sb; RLS (admin-only policies from
        P1-2) is the real enforcement; UI additionally gates non-admins.
      • Wired: index.html (nav/page/script, CRLF), sw.js precache, _adminPages,
        _load_app SCRIPTS, smoke assertion. Harness 13 suites / 270 assertions.
      • v1 captures the full management loop; polish (search/filter on big
        directories, modal instead of prompt()) can come with the Phase 4 UX pass.
- [x] P1-10 (DONE — owner-directed: "admin permissions per module") Per-module
      admin delegation. Migrated all is_admin()-gated admin-area RLS to
      has_module_perm(<module>,<action>) per the perm_modules `governs` catalog:
      weights (activity/test_case_weights), planning (shift_templates), directory
      (profiles write + users → 4 command policies), admin (perm infra). demo_seed_log
      stays is_admin (internal infra, no module). Strict SUPERSET — global admins
      unaffected (has_module_perm keeps the role='admin' shortcut). UI: page guards
      for weights/templates/locations/forms/directory/audit/planning → uiCan(mod,
      'view') (cxEmpty not-authorized); renderAdminPermissions → uiCan('admin',
      'view'); _cmCanManage → uiCan('config','edit'); admin-mode bar revealed to
      non-admins via uiCanAnyAdmin()/ADMIN_AREA_MODULES so delegated users enter
      admin mode and see only permitted links. Legacy combined-portal fns
      (AM/Overview/Portal, not nav-wired) stay role-admin. Verified per-role (JWT
      sim): delegated FE(weights=admin) CAN write weights, CANNOT touch perm infra.
      test_ui_can.js +5. Migration: per_module_admin_delegation.
- [x] P1-11 (DONE — owner feedback on the permissions UI) Per-module action
      relevance + self-describing catalog. Owner: "why approve/manage for
      everything? actions should be unique to the module" + "hard to map
      permission to actual module". Evidence-grounded fix: approve/manage were
      checked NOWHERE (decorative); export exists on test_register/punch_list/
      audit; approve flows exist in punch (acceptance), planning (PTO review),
      test_reporting (approval status); manage only meaningful on admin.
      • DB (perm_modules_actions_and_descriptions): perm_modules += `actions`
        text[] (per-module relevant set; overview/audit read-only-style) and
        `description` (plain-language, incl. Track Plan = topology data consumed
        by Dynamic Testing, data-only; Planning & Resources = roster/activities/
        PTO/shift templates behind Admin Planning).
      • UI: chips in template grid / overrides / effective preview now render
        ONLY the module's relevant actions; module cells show description +
        live "appears as" page chips derived from PAGE_MODULE (can't drift);
        data-only modules say so. Resolver unchanged (baselines identical;
        irrelevant actions simply never offered/checked).
      • test_ui_can.js +7 (_paModuleActions filter/order/back-compat,
        _paModulePages reverse map incl. track_plan = data-only).
- [x] P1-12 (DONE — owner-directed: "directory should use permissions, not Role")
      Role retired from the UI. Role survives ONLY as (a) the global-admin flag
      (is_admin()/has_module_perm shortcut + escalation guard) and (b) the legacy
      fail-open nav fallback. Changes:
      • Directory: Role dropdown (which offered "Client" — REJECTED by
        profiles_role_check, a latent bug) → permission-template select + a single
        "Global admin" toggle. updateProfileRole removed; updateProfileTemplate +
        updateProfileGlobalAdmin added (off-state role = readonly, least privilege
        for the legacy fallback).
      • Invite flow: Role select → template select + Global admin checkbox;
        new profiles insert role admin|readonly + permission_template_id.
      • Nav is now permission-AUTHORITATIVE when perms load (_paLinkDecision:
        show/hide per uiCan for mapped pages — templates can now REVEAL pages the
        legacy role filter hid, e.g. a readonly-role user with an FE template gets
        the full FE nav); section labels auto-hide when all their links hide;
        global-admin/fail-open/unmapped keep legacy visibility.
      • User pill shows "Global Administrator" or the user's TEMPLATE name
        (async) instead of a role label. perms-admin Users tab Role column →
        Global admin toggle (_paSetGlobalAdmin).
      • Existing role values grandfathered (constraint-valid); test_ui_can.js +6
        (_paLinkDecision matrix). Harness 15 suites / 319 assertions.
- [x] SECURITY FIX (found during P1-10 testing) profiles privilege-escalation:
      own-row update let a non-admin set their OWN role/is_active/permission_
      template_id and self-escalate (PRE-EXISTING — own-row clause predates
      delegation). Closed with BEFORE UPDATE trigger profiles_guard_privileged_cols:
      those 3 cols change only with directory-edit perm; self name/subsystem edits
      still allowed. Verified: FE self-name ALLOWED, self-role-escalation BLOCKED,
      admin role change ALLOWED. No advisor regressions. Migration:
      profiles_protect_privileged_columns.

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
- [~] P3-1 (IN-PROGRESS) Incremental strangler split of app.js.
      • GROUNDWORK: headless boot/smoke (tools/smoke_app.js) loads the page's
        classic scripts in index.html order under a universal-Proxy DOM/lib shim
        and asserts full top-level execution + bootstrap registration.
      • SEAM #1 (DONE): extracted the ICONS map + icon() SVG system (~12.9KB,
        lines 14-109) → icons.js, loaded before app.js/photos.js/markup.js in
        index.html, added to sw.js precache. app.js now references icon() purely
        as a global (312 call sites, 0 ICONS refs left). New tools/test_icons.js
        (11 assertions) + smoke updated (loads data.js→icons.js→app.js). Harness:
        5 suites / 108 assertions green. CRLF preserved (Node-based edit).
      • SEAM #2 (DONE): extracted escapeHtml (1083 call sites) + getLocationCode
        → format.js. Wired index.html (data→icons→format→app), sw.js precache,
        smoke load order. New tools/test_format.js (10 assertions incl. XSS-payload
        escaping). Harness: 6 suites / 119 assertions green.
      • SEAM #3 (DONE): extracted cx* state helpers (cxSkeleton/cxEmpty/cxError)
        → cx-state.js, loaded after icons+format (runtime deps) and before app.js.
        New tools/test_cx_state.js (13 assertions) loads format+icons+cx-state and
        verifies cross-module integration (cxEmpty uses icon()+escapeHtml, XSS-safe).
        index.html order: data→icons→format→cx-state→app. Harness: 7 suites /
        133 assertions green.
      • PATTERN ESTABLISHED for subsequent leaves: move self-contained block →
        new classic script exporting via global/window → wire index.html + sw.js +
        smoke load order → add a unit test → run tools/run_tests.js. 3 module files
        extracted so far (icons.js, format.js, cx-state.js); app.js: 38,920→38,786 ln.
      • PIVOT (after seam #3): leaf-carving was 0.3% of app.js for the effort.
        Switched to test-driven hardening — see "Doing right now". The split
        continues, but now DRIVEN by testability/value: characterize a computation,
        then extract it into a tested module, rather than picking pure leaves blind.
- [~] P3-5 (IN-PROGRESS) Behavioral test net for the computational core.
      • tools/_load_app.js — reusable headless loader; loads data→icons→format→
        cx-state→app into one vm context under a DOM/lib shim, returns the sandbox
        so tests call the REAL app.js functions. smoke_app.js refactored onto it.
      • tools/test_wgtstat.js — characterizes _wgtStat (weighted completion %/pass
        rate; the headline KPI math), 22 assertions: weight = activityW × testCaseW,
        default 1, status buckets (Pass/Passed/Complete→pass, Fail/Failed→fail, NA,
        Blocked, In Progress, Future Test, Not Started/missing), completeW/testedW.
      • tools/test_activity_compute.js — _amComputeStatus (rollup state-machine:
        Open/Future Test/Closed/Partial Completion; parent rows excluded),
        _amComputeCompletion (weighted %, Future Test in denominator), and the pure
        resolvers _tcWeightFor/_actWeightFor. 23 assertions.
      • tools/test_status_compute.js — getStatusBadge (19 mappings), getPriorityPill,
        _trpStatusCounts (case-insensitive buckets), _liMatchKpiStatus (module state
        driven via vm.runInContext), _laAutoStatus/_laActStatus (incl. discovered
        precedence: done outranks cancellation once all active shifts are past —
        matches the doc comment). 29 assertions.
      • CONVERGENCE STEP (DONE): extracted the characterized compute core →
        compute.js (~6.5KB, 9 functions + _P6_DONE_STATUSES): getStatusBadge,
        getPriorityPill, _tcWeightFor, _actWeightFor, _amComputeStatus,
        _amComputeCompletion, _p6WeightedCompletion, _trpStatusCounts, _wgtStat.
        Left in app.js BY DESIGN: weight-lookup builders, _liMatchKpiStatus,
        _laAutoStatus/_laActStatus (all read app.js module state). Default-lookup
        cross-script seam (_wgtStat() with no args resolves app.js builders) is
        pinned by test (Scenario F). Wired index.html (…cx-state→compute→app),
        sw.js precache, _load_app SCRIPTS, smoke assertion. 74 characterization
        assertions now exercise the functions from their new home.
      • Harness now 10 suites / 209 assertions, all green + CI.
      • test_activity_stats.js CONVERTED from re-implementation → real function:
        now loads the bundle and injects fixtures into app.js's actual TI /
        PLANNING_TEST_RESULTS via vm.runInContext. Same 23 assertions pass against
        the real _planningTestActivityStats (proved no drift had occurred; locked
        against future drift). All characterization now tests real code only.
      • tools/test_trp_keys.js (26) — report-key normalization characterized:
        _trpCleanReportValue, _trpReportKey (CDRL-prefix-insensitive canonical
        keys), _trpInferCdrlNumber, _trpRecordKeys, _trpFindRecordByText (state
        injected). THEN extracted the pure quartet → compute.js (find stays in
        app.js, reads _testReports).
      • tools/test_planning_badges.js (17) — _planningCellBadge (past/today/
        future branches, issue escalation), _planningRowProgressChip (% color
        tiers), _planningDeriveInitials. State-injected; left in app.js.
      • Harness now 12 suites / 252 assertions, all green + CI.
      • NEXT: P1-8 permissions admin UI SHIPPED (see Phase 1) — built as a new
        module (perms-admin.js), validating the strangler direction for FEATURE
        work, not just extractions. Remaining compute clusters (date/format
        helpers) have diminishing returns; next priorities are Phase 4 UX/a11y
        or Phase 5 feature triage. Modules: icons, format, cx-state, compute,
        perms-admin.
- [x] P3-2 (DONE) Test harness — committed `tools/run_tests.js` (node --check on
      app.js/photos.js/markup.js + runs the 3 headless suites: test_activity_stats,
      markup_test, test_copy_paste = 88 assertions, all green) + CI workflow
      `.github/workflows/test.yml` (push/PR). DELIBERATELY package.json-free:
      repo deploys static to GH Pages publishing the root verbatim, and root
      package.json is gitignored by owner convention. Sole test dep `dayjs` is
      installed transiently in CI (`npm install --no-save dayjs@1.11.13`); runner
      SKIPs (not fails) the copy/paste suite if dayjs is absent locally. If owner
      later prefers a committed package.json, trivial to switch.
- [x] P3-3 (DONE — owner-directed) data.js wiped: 1,230,062 → 1,016 bytes
      (-99.9%, removed from every page load + offline precache). Owner chose
      "keep only real data"; the three mock-only screens were re-sourced to real
      data first, THEN the file emptied (all keys kept as [] so the
      window.PORTAL_DATA contract still resolves; dead LI/ORG globals removed):
      • Test Activities ← _amGetActivities() (real test register); idempotent
        re-init. • Test Cases (was "Line Items") — already TI-sourced; nav was
        already relabeled; DATA.lineItems (496KB) was fully dead. • Team ← new
        team_members Supabase table (editable, directory-gated). • Legacy punch
        list page (PL) not nav-reachable → renders empty harmlessly; admin
        deployments demo → existing empty state. Verified: smoke loads the empty
        data.js through the full bundle; behavioral tests pin the new sources.
      [original audit, for reference:]
      • Supabase-backed w/ mock fallback: testItems→TI (replaced on login);
        templates→TEMPLATES (loader intentionally MERGES data.js baseline rows).
      • MOCK-ONLY screens (no Supabase source — these show static May-2026 demo
        data in production): actionPlans→AP ("activities" page), lineItems→LI
        ("lineitems" page), punchList→PL (legacy punch filter views; the live
        punch list uses PUNCH_DB/Supabase), org→ORG ("team" page),
        deployments/testInstances (admin portal demo).
      • Nearly dead: locations (LOCS=Supabase), users_v2, auditLog, fieldUsers,
        config (≤3 refs each).
      ⇒ data.js is NOT safely removable today. The heavy keys back mock-only
      screens whose fate is a PRODUCT call (owner): migrate activities/lineitems/
      team to real tables (activity_records exists, 73 rows) or deprecate the
      screens — overlaps P5-2 triage. Decision pending; flagged to owner.
- [x] P3-4 (DONE — 2026-06-12) Design tokens consolidated + component patterns
      documented. FINDING: styles.css had accreted FOUR competing bare `:root`
      blocks (lines 6 / 3755 / 8240 / 11631) redefining the same custom props —
      36 tokens had 2–3 conflicting values (e.g. --good was #00875a, #027a48,
      AND #0d7a4f); the effective value was simply whichever block came last.
      • Consolidated to ONE canonical categorized sheet at the top of styles.css
        via a generated edit: every token's value computed last-wins from the
        live cascade, the sheet emitted programmatically from that map, later
        blocks replaced with pointer comments, then the effective map re-parsed
        and asserted byte-identical (93 tokens, ZERO visual change). CRLF kept.
      • NEW tokens: --space-1..6 spacing scale (new layout work), --focus-ring +
        --focus-ring-offset (the global :focus-visible rule now consumes them —
        groundwork for P4-2; previously a raw rgba literal).
      • GUARD: tools/test_css_tokens.js (28 assertions, 17th suite) — exactly one
        bare :root; no duplicate defs; key families at consolidated values;
        focus rule uses the token; core tokens never redefined later; CRLF.
        Sprawl cannot silently return.
      • DESIGN_TOKENS.md — token catalog by category + component patterns
        (badge/status via getStatusBadge, .tag skins, cx* state helpers, icon(),
        and the honest button-family map: 10+ per-area families exist; new work
        reuses its area's family; unification deliberately deferred as a
        high-churn browser-QA item). CLAUDE.md points at it + states the
        one-:root rule.
      • Deliberately NOT done in this pass: button-family unification and a
        raw-hex sweep of rgba(230,0,18,*) alpha variants (52 sites) — both are
        rendering-visible refactors that belong with the P4 browser-QA'd passes.

### Phase 4 — UX, visual & accessibility
- [~] P4-1 (IN-PROGRESS) Sidebar IA / permission-driven UI.
      • P4-1a (DONE): UI now consumes the permission model. perms-admin.js gained
        PAGE_MODULE (28 nav pages → 22 catalog modules), loadMyPermissions(profile)
        (loads the signed-in user's template rows + own overrides — select
        policies verified readable by non-admins), uiCan(module, action), and
        _applyPermNav (hides nav links lacking 'view'). Hooked into onLoggedIn
        (all 3 login paths set currentProfile first — verified). FAIL-OPEN by
        design: load failure → legacy role-based nav (showing too much is
        harmless, RLS rejects; hiding everything would brick nav). Gating only
        ever HIDES beyond the legacy role filter, never reveals. uiCan() is now
        available for incremental adoption by feature code (replacing the ~30
        scattered role==='admin' checks over time). tools/test_ui_can.js (8)
        incl. 2 integrity invariants: every nav data-page mapped (or known
        non-module) + every mapping targets a real catalog key — new nav entries
        can't silently bypass gating. NOTE for owner: needs a quick browser spin
        (sign in as the Field Engineer; admin-category links should be hidden,
        everything else unchanged).
      • REMAINING P4-1: IA regrouping ("Work"/"Views" grab-bags), dissolve
        Admin-mode swap, icon() unification in sidebar, mobile/PWA pass —
        visual work, needs owner browser QA per direction note.
      • P4-1c (DONE) Sidebar IA regrouped: the two arbitrary "Work"/"Views"
        grab-bags → 5 permission-aligned sections (Overview / Testing / Field /
        Planning / Project), fixing miscategorized links (Dashboard, Dynamic
        Testing, Schedule, Lookahead were split illogically). Done programmatically
        — every <a>'s data-page/data-role/icon/label preserved exactly (16 links,
        verified unique + all placed); section-label data-role = union of children.
        No JS touched (onLoggedIn role filter, _applyPermNav, showPage all iterate
        by class/attr, order-independent). Nav-mapping integrity test still green.
        DEFERRED (debatable UX, unverifiable headlessly — needs owner): dissolving
        the admin-mode full-swap (kept; now permission-gated via uiCanAnyAdmin) and
        icon() unification of the sidebar's inline SVGs (would require JS-rendering
        nav icons). NEEDS BROWSER QA: confirm grouping/labels render well.
- [~] P4-2 (HEADLESS PASS DONE — 2026-06-12; browser/axe pass remains) A11y.
      Everything verifiable without a browser is fixed AND guarded:
      • Accessible names: scanned every <button> in index.html + the template
        literals of app.js/photos.js/markup.js/perms-admin.js/team.js — the
        CLAUDE.md aria-label convention had held remarkably well; only 5 unnamed
        "×" close buttons existed (ta-tag clear/remove, generic modal close,
        meeting-attendee remove, signature-pad close). All labelled (dynamic
        names where useful: "Remove <tag>", "Remove attendee <name>").
      • Form controls: 25 visible <label>s associated via for= (daily-log r-*/
        d-* report forms), 19 aria-labels on label-less filter/search controls
        (ap-/li-/pl- filter bars, drawing page/find inputs), fp-email label
        paired. Sign-in controls were already label-wrapped.
      • Structure: skip-to-content link (visible on focus), <main id="main-
        content"> landmark wrapping all page sections (verified no body>
        child-combinator deps), aria-label="Primary" on the sidenav.
      • Contrast (WCAG AA 4.5:1, computed): --text-muted #74777f was 4.48 on
        white → #6e7179 (4.88/4.67 on surface/-2); --text-subtle #98a2b3 was
        2.58 → #697280 (4.86/4.65). All five status-on-light pairs, brand red
        on white, and sidenav ink already passed. Raw-gray-as-text (e.g.
        --gray-500) left for the browser pass — usage-dependent.
      • Motion: global prefers-reduced-motion rule (animation/transition →
        0.01ms) on top of the existing scoped login/pdf-shimmer ones.
      • Focus: :focus-visible already consumed --focus-ring (P3-4); skip-link
        focus style added. icon() SVGs verified aria-hidden.
      • GUARD: tools/test_a11y_static.js (26 assertions, 18th suite) — unnamed-
        button scan across all 6 HTML-emitting files must stay at ZERO, every
        static control must have an accessible name, landmarks/skip-link/lang
        present, text-token contrast recomputed live from the sheet ≥ 4.5,
        reduced-motion + focus invariants. Regressions now fail CI.
      • REMAINS (needs real browser/axe + owner QA): keyboard operability of
        JS-driven widgets (onclick-div grids, drag-fill, lookahead cells),
        focus management in modals (deliberately NOT adding Escape-close: the
        generic modal's no-outside-click is an explicit product decision),
        color-only information checks, axe run on each page.
- [~] P4-3 (IN-PROGRESS) Loading/empty/error states. FINDING: the cx* helpers
      (cxSkeleton/cxEmpty/cxError) existed but had ZERO call sites in app.js.
      Adopted at 8 sites: 7 ad-hoc "Loading…" placeholders (directory users,
      punch photos, RMA list, lookahead history modal + week body, dynamic
      instances + test cases) → cxSkeleton(n); field-intake access guard →
      cxEmpty(); 4 catch-block error renders → cxError with retry handlers
      (directory users, meeting detail, dynamic cases; drawing-import modal
      without retry — footer Close exists). 12 cx* call sites total. Remaining:
      per-table "no rows" cells — reviewed, most are contextually fine as-is;
      revisit only during the visual IA pass.
- [~] P4-1b uiCan ADOPTION (batch 1, DONE): replaced ALL 6 legacy role-array
      predicates in app.js (0 remain): _trpCanManage→uiCan('test_reporting',
      'edit'), _trpCanView→('test_reporting','view'), field-intake guard→
      ('test_register','create'), 2 inline matrix status-selects→
      ('test_register','edit'), _regressionCellHTML canManage→same,
      _rmaPageHTML canEdit→('rma','edit'). All target modules use
      has_module_perm-driven RLS (P1-4/P1-9) and the seeded templates reproduce
      today's behavior exactly (FE=standard, readonly/client=read_only); custom
      templates now shape these UIs as intended. Fail-open preserved. Integration-
      tested via real predicates with injected _myPerms (test_ui_can.js, now 13).
      NOTE: ~24 bare role==='admin' checks remain — those gate admin-only pages
      whose RLS is still is_admin()-based (weights, templates, config…), so
      migrating them is NOT behavior-preserving; they stay until/unless the
      owner wants per-module admin delegation.

### Phase 5 — Feature completeness
- [x] P5-1 (DONE — Phase-0 note was STALE) Photo upload is already end-to-end:
      photos.js (rebuilt May 29, commit e42659a) has the full pipeline — client
      compression, native-fetch storage uploads, signed URLs, offline IndexedDB
      queue, storage cleanup on delete. Verified infra: `photos` bucket exists
      (plus forms/drawings), storage.objects policies per bucket, ALL
      authenticated-only (no anon storage access). Private bucket + signed URLs.
      Remaining: a browser upload smoke (owner QA) — nothing to build.
- [x] P5-2 (DONE — owner-approved 2026-06-12) Dead tables dropped + advisor
      cleanup. Re-verified against the LIVE DB before dropping: all six still
      0 rows, 0 code reads/writes (the app.js "deployments" refs are to the
      in-memory DATA.deployments array, now [], not the DB table), and the ONLY
      inbound FKs were internal to the set (deployment_locations + test_instances
      → deployments). Dropped in dependency order via migration
      p5_2_drop_dead_tables: deployment_locations, test_instances, deployments,
      punch_history, punch_photos, template_test_cases. DROP TABLE cleared their
      RLS policies + indexes too. Verified gone; harness still 18/18; no advisor
      regressions (perf still only INFO unused_index).
      • BONUS advisor cleanup: the security advisor surfaced 3 NEW security WARNs
        introduced earlier this engagement by the Dynamic Testing work — the
        dyn_roll_forward_on_cancel / dyn_sync_pe_to_window / dyn_sync_window_to_pe
        SECURITY DEFINER TRIGGER functions were RPC-callable by `authenticated`
        (advisor 0029). They're trigger-only (return trigger, no args) so no
        caller needs EXECUTE; revoked from anon/authenticated/public (migration
        p5_2_revoke_execute_dyn_trigger_fns), same pattern as P1-5. Security
        advisors back to ONLY the plan-gated auth_leaked_password WONT-FIX.
      • In-repo record: supabase_p5_2_drop_dead_tables.sql; supabase_schema.sql
        table defs replaced with drop-note comments.
      [prior audit findings, for reference:]
      Empty-table triage.
      Method: exact row counts + code-reference scan (incl. PostgREST embedded-
      resource syntax, which a naive grep misses — caught meeting_template_
      categories/items as wired).
      • WIRED, keep (empty = awaiting use): test_results (daily log), photos/
        photo_albums/photo_album_items, software_configs, drawing_markups,
        train_requests, access_campaigns, zone_access_windows, meeting_templates
        + categories + items, meeting_attendees, planning_import_batches,
        form_template_links, form_test_item_links, test_item_prerequisites.
      • DEAD SCHEMA — 0 rows AND 0 code mentions anywhere, drop candidates
        (presented to owner per standing wipe rule, NOT executed):
        punch_history (superseded by db_change_log audit), punch_photos (photos
        feature uses `photos` w/ source links), template_test_cases (templates
        store test_cases inline as jsonb), deployments + deployment_locations +
        test_instances (deployment flow was mock-demo only, never DB-wired).
        Drops are data-loss-free; would also clear their RLS policies + unused
        FK indexes.

### Phase 6 — Integration prep
- [~] P6-1 (CODE COMPLETE — 2026-06-12; blocked on IT credentials only)
      Azure/SharePoint photo sync per INTEGRATION_SHAREPOINT design.
      • Edge Function `photo-sharepoint-sync` implemented + DEPLOYED (verify_jwt
        on; additionally enforces global-admin via service-role profile check).
        Source committed at supabase/functions/photo-sharepoint-sync/index.ts.
        Flow: client-credentials Graph token → batch photos where sp_sync_status
        in (pending,error) → download from `photos` bucket → Graph PUT (simple
        ≤4MB / upload-session chunks above) into "CX-Portal Photos/<Punch List|
        Daily Logs|General>/…" per the doc's folder mapping → write back
        sp_item_id/sp_web_url/sp_synced_at/sp_sync_status, sp_error on failure
        (stays retryable). Returns {processed, synced, failed, remaining}.
      • UNCONFIGURED-SAFE: until the secrets exist (SP_TENANT_ID, SP_CLIENT_ID,
        SP_CLIENT_SECRET, SP_DRIVE_ID) it answers 200 {configured:false} — no
        external calls, friendly UI message. Enabling = set 4 secrets, no code.
      • Photos toolbar: the reserved disabled "Sync to SharePoint" button is now
        LIVE for admins — drains the queue in batches (≤20 rounds), shows
        progress on the button, toasts a summary; non-admins don't see it.
      • INTEGRATION_SHAREPOINT.md status updated. Remaining: IT provisions the
        Entra app (brief in docs/sharepoint-integration/it-ticket-intro.md),
        owner sets the 4 function secrets, one end-to-end test photo; optional
        cron schedule for hands-free sync.

### Phase 7 — Hardening & handoff
- [~] P7-1 (PARTIAL) Repo cleanup + README rewrite done (owner-directed,
      2026-06-12): deleted update_data.py (regenerated the now-wiped data.js
      from CSVs not in the repo), assets/hsts-2.png + docs/punch-icons-preview
      .html (unreferenced); moved all 28 supabase_*.sql applied-migration
      records → supabase/sql/ (git mv; updated the 3 app.js comment refs +
      live doc paths); REWROTE the stale README (was still describing the
      browser-memory demo prototype with PIN sign-in) to the real architecture,
      run/deploy story, layout table and verify instructions. KEPT (operational,
      verified referenced): sync_testplan.js / sync_track_plan.js /
      track_plan_importer.html (importers), lookahead template tools,
      DEMO_DATA.md + demo seed/teardown SQL, .claude/ (session tooling).
      Remaining for P7: full regression, advisor re-run, final report.

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

## Dynamic Testing ⇄ Lookahead integration (2026-06-11, owner-directed)
Owner goal: dynamic-testing access planning and the Lookahead should be ONE
linked plan; cancellations/delays visible from either side; tests auto-allocated
to access windows by prerequisite order and auto-rolled-forward on cancellation.
Owner decisions (this session): **shared records** (one source of truth, not a
sync layer); build **all four** increments A→B→D→C; commit **directly to main**
(CLAUDE.md wins over the session branch directive — explicit). Model: a campaign
ROW = a Lookahead activity; each per-day access window = a planning_event CELL.
- **A — shared rows (DONE, commit 35e3904).** planning_activities.access_campaign_id
  link; 'dynamic_testing' activity-group band; 'dynamic' added to
  planning_events.source check. _dynEnsureCampaignActivity/_dynEnsureShiftCell
  mint the row+cells on campaign create; _dynCreateShiftEvent made idempotent/
  additive + sets planning_activity_id. Backfilled the existing campaign → 1 row
  + 13 cells (campaign wall-clock times to dodge start_at UTC drift). Renders
  natively under a "Dynamic Testing" band in the Lookahead grid.
- **B — bidirectional cancel/delay (DONE, commit 444fa1e).** SECURITY DEFINER
  trigger pair (dyn_sync_pe_to_window / dyn_sync_window_to_pe) mirrors cancel/
  un-cancel + reason + category both ways via dynamic_shift_id; IS DISTINCT FROM
  guards break recursion; each module keeps its own confirmed/completed lifecycle.
  Verified both directions round-trip + restore. FK audit: campaign delete
  cascades cleanly (activity→cells CASCADE; windows SET NULL on instances).
- **D — auto-roll-forward (DONE, commit a45bf24).** dynamic_instances trail cols
  (moved_from_window_id/roll_count/rolled_at/roll_note) + SECURITY DEFINER trigger
  dyn_roll_forward_on_cancel on zone_access_windows status→cancelled: assigned
  runs move to the earliest future PLANNED window of the same campaign+core zone
  (mode-compatible) or fall back to flagged backlog. Fires no matter which module
  cancelled (B routes a cell cancel to a window UPDATE). "↻ moved" badge in the
  instances list. Verified roll 06-17→06-18 + restore.
- **C — cascade auto-allocation (DONE, commit 4e74676).** "Auto-allocate campaign"
  in Capacity Planning: pure _dynCascadeAllocate + _dynTopoRank place unscheduled
  runs into planned windows in date order by prerequisite CHAINS (filter enforces
  no-dependent-before-prereq; sort tie-breaks by downstream-unblock then mode-
  constraint so scarce windows aren't wasted), editable draft → commit writes
  shift_id/scheduled_for_date/scheduled_window. Prereq-capture UI
  (_dtOpenPrereqEditor) + fn_feasible_instances scoring already existed (table was
  just empty). tools/test_dyn_cascade.js (20 assertions) → harness now 16 suites.
- Migrations applied: dyn_lookahead_shared_records_campaign_activity,
  dyn_lookahead_bidirectional_cancellation_sync, dyn_auto_roll_forward_on_window_cancel.
  In-repo SQL: supabase_dyn_lookahead_shared_records.sql,
  supabase_dyn_lookahead_cancellation_sync.sql, supabase_dyn_auto_roll_forward.sql.
- Follow-ups (not blocking): capacity-aware roll distribution (currently piles onto
  next window; planner rebalances); surface the "moved from" trail in the Lookahead
  cell tooltip; optional draft-editing UI before commit (today: edit post-commit via
  Shift Builder/Access Plan). Needs a browser QA pass (owner).

## Dynamic Testing — planning features (2026-06-12, owner-directed)
Built on the shared-record integration to support a multi-level testing strategy
(DCS→CBTC→ATS→ATC, contract non-revenue hours, weekend closures, prereq chains).
- **Access requirement = per SHIFT** (commit 7dcceaf): zone_access_windows.access_zones
  is the set a shift grants; a run needs access_req ⊆ access_zones. Gated in Shift
  Builder, assign guard, cascade allocator (per-window), roll-forward, and the
  fn_feasible_instances RPC. Single-zone runs fit any shift incl. its zone.
- **Per-day multi-zone** (commit e925984): each weekday in a campaign can carry its
  own window time AND zone subset (day_schedule jsonb { start,end,zones }); zone_codes
  = union; generation tags each window with that day's zone grant. So W40-only
  Mon–Wed + W40+Y10 Fri/Sat in one campaign.
- **Program-level auto-allocate** (commit b8220f3): one cascade across ALL active
  campaigns' windows + all unscheduled runs, so prereqs order ACROSS campaigns.
  _dynCascadeAllocate gained capacityFn(window) + windowAllows(i,window).
- **Subsystem/level tagging + contract presets** (commit 934d547): DCS/CBTC/ATS/
  ATC/IXL in the subsystem field; cards grouped + left-accent-coloured by level;
  "Apply contract hours" (2h wk / 3h Sat / 4h Sun) one-click preset.
- **What-if window compare** (commit 22ebb24): runs the cascade at contract vs an
  extended shift length and shows the marginal runs scheduled — to justify more
  access to the client. Read-only.
- **Weekend/line closure type** (commit a03c221): access_campaigns.campaign_kind
  ('standard'|'closure'); closures badged + outlined on week/month grids for the
  6-month plan. Visual only.
- Tests: tools/test_dyn_cascade.js now 39 cascade assertions (+ per-day generation
  + per-window access + program params); harness 16 suites green. Migrations:
  zone_access_window_access_zones, feasible_instances_enforce_access_req,
  access_campaign_scope_and_per_day_schedule, access_campaign_kind_closure (+ in-repo SQL).
- OPEN (owner choice): prerequisites are soft-ordered for planning + a hard-completion
  readiness flag for execution; can add a HARD scheduling gate (block dependents
  until prereq passes) on request. Browser QA still pending.

## UI/UX aesthetic overhaul (2026-06-12, owner-directed)
Owner: "full overhaul… flows great, looks great, good depth… still maps to the
Hitachi rail color theme." Executed WITH visual verification: built
tools/ui_gallery.html (every core component rendered from the exact markup
app.js emits) + tools/shot_gallery.js (playwright, chromium available in this
env) and iterated on before/after screenshots headlessly.
- DIAGNOSIS from the BEFORE shot: solid foundation (KPI cards, badges, sidebar
  glow nav) but (a) buttons were 8 visually unrelated families — dyn-btn (48
  uses), pm-btn and cal-btn had NO css at all; (b) form-label referenced 59x,
  never styled; (c) --f-mono was an Archivo placeholder so every "technical"
  accent (eyebrows, KPI labels, table headers) rendered as plain sans; (d) depth
  minimal (near-flat shadow scale); (e) no motion grammar.
- TOKENS (canonical sheet): --f-mono → real Roboto Mono stack (already imported,
  never used); layered elevation scale (--shadow-sm/md/lg); --dur-fast 140ms /
  --dur 220ms; --ring input-focus halo.
- AESTHETIC OVERHAUL LAYER (appended end of styles.css, like the production
  visual layer): ① tabular numerals on all data cells/KPIs; ② ONE button
  grammar across all 10+ families (8px radius, --dur-fast transitions, 1px
  press, unified disabled) with two roles — solid Hitachi red = primary
  (admin-action-btn, v2-btn-primary [was black], dyn-btn.primary,
  pm-btn-primary, cal-btn-primary), bordered surface = secondary — and real
  bases for the unstyled families; ③ one form-control focus grammar (brand
  border + --ring halo) + .form-label finally styled; ④ card/table depth
  (data-card elevation, row hover, stronger thead rule); ⑤ modal: deeper
  shadow, blur scrim, 220ms entrance; ⑥ page-hero brand signature (2px red
  gradient line + faint red radial wash); ⑦ sidebar ink bump; ⑧ 240ms page-
  enter transition (transform clears post-animation → fixed descendants safe).
  prefers-reduced-motion global rule (P4-2) covers all new motion.
- Verified: gallery + real login page screenshots before/after; harness 18/18
  (token guard + a11y contrast suites included); CRLF preserved.
- Owner QA notes: v2-btn-primary changed black→red (intentional: one primary
  color); dyn board-view toggles now show solid red active state; eyebrows/KPI
  labels/table headers now true mono (Roboto Mono).

## Resource picker company filter + profiles.company (2026-06-12, owner-directed)
Owner: in Lookahead → assign resources, filter the picker to BART vs Hitachi;
and add a company field to the Directory tied to the user so it flows into the
resource roster automatically.
- DB: profiles.company text (migration profiles_add_company; in-repo
  supabase/sql/supabase_profiles_company.sql). Backfilled existing users to
  'Hitachi Rail'; synced person-linked planning_resources.company from the
  profile. No advisor changes. planning_resources already had `company`.
- Lookahead picker: new _laResPanelCompany state + All/Hitachi/BART chips at the
  top of _laResourcePanelHTML() (counts shown, solid-red active), filtered via
  _laResPanelCompanyMatch (BART = company 'BART'; Hitachi = everything else —
  same convention as the existing Resource-view _laResCompanyFilter, kept
  separate so the two don't interfere). _laSetResPanelCompany re-renders the
  panel preserving the typed search. CSS chips added to styles.css.
- Directory: new Company column (Hitachi Rail / BART / none) + updateProfileCompany
  which writes profiles.company AND mirrors it onto the user's planning_resources
  row (and patches in-memory PLANNING_RESOURCES) so the picker reflects it without
  a reload. Invite modal gained a Company select (defaults Hitachi Rail) persisted
  on the new profile. Bootstrap (_planningBootstrapResources) now inherits
  company from the profile (default Hitachi Rail) and tags kind:'person'.
- COMPANIES_LIST constant added next to SUBSYSTEMS_LIST.
- Test: tools/test_la_resource_picker.js (18 assertions, 19th suite) exercises the
  REAL picker fn with injected resources — match logic + chip counts + filtered
  lists. Harness 19/19. Verified the picker visually (headless render of all
  three filter states). CRLF preserved.

## Dynamic Testing — campaign edit + Non-Revenue Hours (2026-06-12, owner-directed)
Owner: fully edit a campaign after creation; rename "contract hours" to
"Non-Revenue Hours" and make its settings a small button next to Apply.
- EDIT: _dynOpenNewCampaign refactored into a shared _dynCampaignModal(camp)
  (null = create, object = edit). Edit prefills every field (name, zones, dates,
  per-day schedule via new _dynCampLoadDays, trains, consist, modes, subsystem,
  phase, kind, permit, scope, notes). New "Edit" button (primary) on each
  campaign card → _dynEditCampaign.
- SAVE: _dynSaveCampaign(editId) branches; edit routes to _dynUpdateCampaign,
  which UPDATEs the campaign row then RECONCILES generated shifts instead of
  wipe-and-recreate: matched (date|zone) windows updated in place (preserving
  the window id + any assigned dynamic_instances), new ones inserted (+ Lookahead
  cell via _dynEnsureShiftCell), removed ones deleted (cells cascade). Removing a
  window with assigned instances unschedules them (shift_id/scheduled_for_date/
  scheduled_window nulled) and the planner is asked to confirm first, with an
  added/updated/removed summary. No DB writes happen if they cancel.
- NON-REVENUE HOURS: hardcoded "contract hours" preset → configurable
  _dynNonRevHours() (localStorage, defaults 2h wk / 3h Sat / 4h Sun). Button
  renamed "Apply Non-Revenue Hours"; a gear button beside it toggles an INLINE
  settings panel (kept inline so it doesn't replace the campaign modal) with
  per-day-type start/end + Save & apply / Reset. What-if comparison text also
  renamed ("Non-Revenue Hours (current)"). No "contract hour" strings remain.
- Test: tools/test_dyn_campaign_edit.js (18 assertions, 20th suite) — real-fn
  schedule round-trip (_dynCampLoadDays), NRH defaults+apply+settings HTML, and
  the reconcile keying (_dynGenerateShiftRows + _dynReconcileShiftKey classifying
  added/updated/removed). Harness 20/20. Edit modal verified visually (all fields
  prefilled, settings panel open). CRLF preserved.

## Dynamic Testing — one window per access day + NRH fit (2026-06-12, owner)
Owner: a 2-location day was creating two Access-Plan/Lookahead rows instead of
one; and the edit Non-Revenue Hours time boxes overflowed.
- ONE WINDOW PER DAY: _dynGenerateShiftRows looped per zone (2 zones → 2
  zone_access_windows → 2 access-plan cells + 2 Lookahead cells). Now emits ONE
  window per access day with control_zone_code = primary (first) zone and
  access_zones = the full day set, so a two-location day is a single row/cell
  that grants both (the cell label already renders "W40+Y10"). Access gating
  (access_req ⊆ access_zones), the cascade allocator, and roll-forward are
  unchanged — they already keyed off access_zones.
- RECONCILE now DATE-based (was date|zone): one expected window per date updates
  one existing window on that date in place (preserving id + assignments); any
  EXTRA windows on that date (legacy one-per-zone rows) are removed, so editing
  an old duplicated campaign COLLAPSES it to one row/day. Whole dropped dates
  still removed (with the assigned-instance confirm).
- NRH FIT: the inline Non-Revenue Hours settings panel and the per-day Start/End
  time inputs clipped ("02:00 A" + clock cut off). Reworked to CSS grids with
  box-sizing + min-width:0 — NRH panel is a 4-col grid capped at 440px with
  Start/End headers; day rows widened the time columns 78→104px. Both fit now.
- Tests: test_dyn_campaign_edit (now 19) asserts one-row-per-day generation +
  access_zones + date-based reconcile + legacy collapse; test_dyn_cascade
  Scenario 7 updated (two-zone day → ONE window granting both, control = primary).
  Harness 20/20. Verified the edit modal visually (boxes fit). CRLF preserved.

## Dynamic Testing — unified allocate + board↔access-plan gating (2026-06-12)
Owner: the two allocate buttons gave different results and should share rules;
"Auto-allocate campaign" should ask which campaign; clarify the "moved" feature;
and the Planning Board must only schedule onto access-plan shifts that meet a
test's requirements (no access date → can't schedule there).
- UNIFIED ALLOCATE: _dynAutoAllocateRun + _dynProgramAllocateRun collapsed into
  one engine _dynAllocateInto(campIds|null) — identical rules (same prereq DAG,
  per-window capacity _dynWindowCapacity, per-campaign scope gate windowAllows,
  access/zone/mode gating). Difference is ONLY scope: one campaign vs all active.
  The single button now opens a campaign PICKER modal (was a prompt that could be
  skipped via the cached filter); Program = _dynAllocateInto(null).
  ROOT CAUSE of the divergence: single used a campaign-fixed capacity
  (_dynAllocCapacity) + no windowAllows + zone-prefiltered pool; program used
  per-window capacity + windowAllows. Now both per-window + windowAllows.
- CASCADE ZONE FIX (needed by one-window-per-day): candidate match changed from
  i.track_section_under_test === w.control_zone_code → window GRANTS the run's
  zone (winZonesOf(w).has(under_test)). So a two-zone day's single window can
  host BOTH zones' runs (previously the secondary zone could never be placed).
- BOARD ↔ ACCESS PLAN: the board move dropdowns no longer offer arbitrary
  scheduled dates. New _dynWindowGrantsRun(w,r) (same gate as the cascade) +
  _dynEligibleWindowsFor(r) list only PLANNED access windows that grant the run's
  zone, cover its access_req, and allow its mode. Per-instance + bulk move now
  set shift_id (+ date + window) from the chosen window; bulk skips ineligible
  runs with a count. No eligible window → "no eligible access shift" (can't
  schedule). Unschedule clears shift_id too. Removed dead _dynScheduledShifts/
  _dynShiftLabel.
- "MOVED" badge now states the destination: "↻ moved to <date>" (rolled to the
  next planned window) or "↻ moved to backlog" (no feasible window) — answering
  "where does it go". Roll-forward DB trigger updated to match on access_zones
  membership + access_req subset (migration dyn_roll_forward_access_zones_match),
  consistent with the new zone semantics. Advisors unchanged.
- Test: tools/test_dyn_board_schedule.js (12 assertions, 21st suite) — the
  eligibility gate (single/two-zone/secondary-zone/mode/cancelled), eligible-
  window listing, and the cascade placing both zones of a two-zone window.
  Harness 21/21. CRLF preserved.

## Dynamic Testing — aggressive packing + campaign KPIs/scope/release (2026-06-12)
Owner: pack shifts harder (10-20% slack, not 50%); bulk-unschedule a campaign
from the access plan; see scheduled/unscheduled per test-case scope; max KPIs
per campaign; mark-Pass releases a future slot with a tag.
- AGGRESSIVE PACKING: _dynCascadeAllocate is now duration-aware. New params
  runMinutesFn/windowMinutesFn/slack fill each window by the SUM of run durations
  up to (1−slack) of its length instead of a flat mins/40 count (which under-
  filled — a 2 h window got ~3 short runs = 50%). _dynAllocateInto passes
  expected_duration_minutes (default 30) + _dynWinMinutes + _dynAllocSlack()
  (localStorage, default 15%, editable in the allocate picker, 10-20% rec'd).
  Always places ≥1 run even if it exceeds the budget. Count model kept as
  fallback (legacy tests). Preview now shows per-window Fill % and the slack.
- CAMPAIGN PICKER got a slack input; both buttons honor it (one engine).
- BULK UNSCHEDULE: _dynCampaignUnscheduleAll(campId) frees every scheduled run in
  a campaign (button on the Progress modal, count shown).
- SCHEDULE BY TEST CASE: _dynCampaignScheduleMap(campId) — per test_id in scope,
  a sched/unsch/done roll-up + per-instance chips (date / "✓ Passed" / unsched).
- KPIs: _dynCampaignProgressData expanded (passed/failed/blocked/NA/inProgress/
  future/notStarted, passRate, scheduled/unscheduled, window utilization %). The
  Progress modal now shows a status-breakdown pill row + a scheduling row +
  Schedule-by-test-case and Unschedule-all actions.
- PASS RELEASES FUTURE SLOT: marking a run Pass with a FUTURE scheduled_for_date
  frees its shift_id/scheduled (client in _dynInstanceUpdateStatus + BEFORE-UPDATE
  trigger dyn_release_future_slot_on_pass for robustness; search_path pinned). The
  instances list scheduled column shows a green "✓ Passed" / "✓ N/A" tag for done
  runs instead of a date. Migrations: dyn_release_future_slot_on_pass (+search_path).
- Tests: tools/test_dyn_alloc_pack.js (6 assertions — 15%/0% slack fill counts,
  more-aggressive-than-legacy, over-length run still placed). Harness 22/22.
  Verified Progress + Schedule-map modals visually. Advisors clean. CRLF preserved.

## Dynamic Testing — what-if rebuild (2026-06-12, owner-directed)
Owner: what-if should show many more schedule KPIs; apply to single/multiple
campaigns OR a location/locations over a period; show a comparison chart; and
extend shift hours per INDIVIDUAL DAY, not uniformly for the week.
- SCOPE: _dynWhatIfScope() resolves either mode — 'campaigns' (multi-select
  checklist; windows = those campaigns' planned windows, pool = their zones +
  union test-case scope) or 'locations' (multi-select zones + date range;
  windows granting any selected zone within the range, pool = those zones).
- PER-DAY EXTENSION: _dynWhatIfExtend() applies a per-DOW target-hours map
  (Mon–Sun inputs, blank = keep) — extend Saturday to 5 h without touching
  weekdays. Each window's end = start + that DOW's target.
- KPIs (current vs scenario vs Δ): runs scheduled, % of scope, backlog, shifts
  used/avail, avg runs/shift, window utilization, total access hours, completion
  date (Δ in "days sooner"), calendar days to finish. Uses the duration-aware
  cascade + alloc slack so the projection matches real allocation.
- CHART: Chart.js stepped line of CUMULATIVE runs scheduled over time, Current
  vs Scenario — shows the work finishing sooner/higher. Redraws live on any
  scope/extension change (chart instance on _dynPage._whatIfChart, destroyed
  first). Replaced the old single-campaign / global-hours / count-based version.
- Test: tools/test_dyn_whatif.js (10 assertions — single/multi-campaign scope,
  location+date-range scope, per-DOW extension isolation, metrics + scenario
  improvement + cumulative series). Harness 23/23. Verified the modal + live
  chart visually. CRLF preserved. (No DB change.)

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
