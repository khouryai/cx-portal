# Fable 5 Progress Ledger

## ▶ Current position
- Phase: 0 — COMPLETE (visual baseline P0-4 deferred to start of Phase 4 —
  capture screenshots/Lighthouse immediately before UX changes begin, decision
  logged below). Phase 0 checkpoint report sent to owner.
- Doing right now: awaiting/continuing into Phase 1.
- Exact next action: P1-1 — design the Procore-style permissions schema
  (modules/levels/templates/grants doc + DDL draft). OWNER CHECKPOINT after
  design, before any RLS policy is written.
- Half-finished state: none (no code/DB changes made yet).

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
- [ ] P1-1 (TODO) Design Procore-style permissions schema (modules/levels/
      templates/granular grants) — OWNER CHECKPOINT before policies are written
- [ ] P1-2 (TODO) Build has_module_perm() helpers; migrate 5 legacy roles to
      starter templates; guard against zero-admin state
- [ ] P1-3 (TODO) Enable RLS on demo_seed_log
- [ ] P1-4 (TODO) Replace ~27 always-true policies with permission-driven ones
      (batched per module; advisor re-run per batch)
- [ ] P1-5 (TODO) Fix 9 SECURITY DEFINER views → invoker; lock anon EXECUTE on
      definer functions; set search_path on flagged functions
- [ ] P1-6 (TODO) Enable leaked-password protection
- [ ] P1-7 (TODO) Provision per-role test users (fable-test-*) + run per-role
      verification matrix
- [ ] P1-8 (TODO) Permissions admin UI: directory, template editor, per-user
      overrides, effective-permissions preview

### Phase 2 — DB performance
- [ ] P2-1 (TODO) Wrap auth.* calls in RLS policies ((select auth.uid())) — 49
- [ ] P2-2 (TODO) Add 42 FK covering indexes
- [ ] P2-3 (TODO) Evaluate + drop 77 unused / 1 duplicate index (confirm usage first)
- [ ] P2-4 (TODO) Consolidate multiple-permissive policies

### Phase 3 — Frontend foundation
- [ ] P3-1 (TODO) Execute architecture direction (incremental ES-module split)
- [ ] P3-2 (TODO) Test harness: package.json + npm test running tools/test_*.js
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
- (none yet)

## Checkpoints sent
- 2026-06-10: Phase 0 complete report — baseline, audit corrections,
  architecture rec (incremental modularization). Proceeding into P1-1 design
  (no hard gate); owner may redirect.

## Open questions for owner
- Architecture direction: proceeding with **incremental modularization**
  (audit-confirmed viable; from-scratch rebuild rejected as violating
  deployable-at-every-commit under session limits). Object if you want the
  full rebuild instead.
- Phase 5 will propose dropping dead tables (punch_photos, punch_history,
  template_test_cases, deployment_locations, test_instances) — destructive,
  needs explicit yes when we get there.
