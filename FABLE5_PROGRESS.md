# Fable 5 Progress Ledger

## ▶ Current position
- Phase: 0 — Orient & baseline
- Doing right now: First-session bootstrap — parallel audit agents running
  (frontend architecture; feature gaps). Baseline below is partial pending
  their results + screenshots/Lighthouse.
- Exact next action: Fold audit-agent findings into this ledger, finalize the
  architecture recommendation, report Phase 0 checkpoint to owner.
- Half-finished state: none (tree clean; no code/DB changes made yet).

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

## Phase plan & backlog
### Phase 0 — Orient & baseline
- [x] P0-1 (DONE) Read codebase + docs (CLAUDE/README/SECURITY/docs/)
- [x] P0-2 (DONE) Run security + performance advisors, snapshot counts (above)
- [ ] P0-3 (IN-PROGRESS) Parallel audits: frontend architecture; feature gaps
- [ ] P0-4 (TODO) Visual/perf baseline: screenshots, Lighthouse, query timings
- [ ] P0-5 (TODO) Phase 0 checkpoint report to owner (incl. architecture rec)

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
- (Phase 0 report pending — P0-5)

## Open questions for owner
- Confirm architecture direction: incremental modularization (recommended) vs.
  from-scratch framework rebuild.
