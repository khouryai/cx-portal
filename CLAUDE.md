# CLAUDE.md — Project conventions for the Construction Planner

> Copy this file to the ROOT of the construction-planner repo. Claude Code reads
> it automatically on every session and follows it as hard rules.

This app is being built **standalone now, merged into `cx-portal` later** (the
Hitachi Rail T&C Portal — the commissioning side of the same project). Every
rule below exists so that the merge is a *file copy*, not a rewrite. Follow them
even when a different approach would be marginally faster today.

## What this app is

Construction planning and access forecasting for installation work. The user
manages every input in the app — **locations, phases, activities, materials,
crews, work vehicles, shift windows and scope** — and gets back a dated
schedule, a timeline, and an access forecast.

The chain: scope items carry a **quantity**; the activity catalog carries a
**duration per unit** at a reference crew size; crews, vehicles, materials and
**shift windows** (single-track 6–8 hr, short 2 hr windows, weekend shutdowns)
constrain when that work can actually happen.

**The whole point is that the assumptions are wrong and get corrected.** Every
rate, crew size, mobilization allowance and window length is editable in the UI
and exportable as JSON. If a number appears in a `.js` file outside the seed in
`cxc-data.js`, it is a bug.

## Stack — match cx-portal exactly

- **Vanilla JS + CSS + HTML. No build step, no framework, no bundler, no npm
  runtime deps.** The repo root *is* the site; open `index.html` and it runs.
- **Classic `<script>` tags**, loaded in dependency order in `index.html`.
  Not ES modules yet — cx-portal is mid-migration to them (ADR 0001 Stage D)
  and this app follows whenever that lands.
- Third-party libraries are **vendored** into `vendor/js/`, never loaded from a
  CDN at runtime.
- Node is a **dev-time tool only** (test runner). No `package.json` runtime
  dependency; tests must run with plain `node`.

## Namespacing — the merge contract

Everything ships under a `cxc` prefix so it can be dropped into cx-portal
alongside `app.js` with zero collisions. Non-negotiable:

| Thing | Rule | Example |
|---|---|---|
| Files | `cxc-*.js` / `cxc*.css` | `cxc-model.js`, `cxc.css` |
| Globals | one per module, `CXC*` | `CXC`, `CXCData`, `CXCApp` |
| Functions | no bare globals; hang them off a module object | not `function packSchedule()` |
| CSS classes | `cxc-` prefix | `.cxc-tl-bar` |
| Store keys | `cxc.` prefix | `CXStore.set('cxc.data', …)` |
| Actions | `cxc` prefix | `CXActions.register('cxcEdit', …)` |
| Future DB tables | `cxc_` prefix | `cxc_activity_types` |
| localStorage keys | `cxc.` prefix | `cxc.data` |

## The layers — know which file you are in

Never blur these. It is the whole reason the app stays workable:

1. **Engine** — `cxc-model.js`, `cxc-timeline.js`. Pure functions. No DOM, no
   storage, no `fetch`, no `Date.now()`. Data in, data out. All scheduling and
   layout maths lives here and nowhere else, which is why it can be tested
   headlessly and why it merges untouched.
2. **Schema + data** — `cxc-data.js`. What every entity IS: its fields, their
   types, the seed dataset, CRUD helpers and validation. Also pure.
3. **Persistence** — `cxc-store-local.js`. **The only file in the app allowed
   to touch localStorage or files.** Five functions. Swapping to Supabase at
   merge time must stay a one-file change, so no storage call goes anywhere
   else, ever.
4. **UI** — `cxc-ui-*.js`. Builds HTML strings, reads the engine, writes through
   the CRUD helpers, calls `CXCApp.save()`. Never does schedule maths.

## Adding things — the paths that already exist

Use these instead of inventing a new pattern; each is a one-liner because the
generic machinery is already built.

- **A new field on an entity** (say, a cost rate on activities): add one entry
  to that entity's `fields` array in `cxc-data.js`. The table column, the right
  input type, validation, persistence and export all follow automatically.
  Do **not** hand-write a form.
- **A whole new entity**: add it to `ENTITIES` + `ENTITY_ORDER` + `PREFIX` in
  `cxc-data.js`. A management screen appears in the sidebar with full CRUD.
- **A new screen** (a report, a chart): write `cxc-ui-<name>.js` exposing an
  `install()` that calls `CXCApp.registerView(key, {title, icon, group, render})`,
  load it in `index.html`, and add one `install()` call in `cxc-boot.js`.
  The shell has no list of screens to update.
- **A new field type** for the editor (a colour picker, a slider): add a `case`
  to `cell()` in `cxc-ui-manage.js` and use it from the schema.
- **New scheduling behaviour**: it goes in `cxc-model.js` with a test in the
  same commit. If a UI file starts computing durations or dates, it is in the
  wrong file.

## State and events

- **All hot state is in `CXStore`** under `cxc.*` keys — the dataset, the packed
  result, the active tab, timeline grouping. Never add a loose `let _foo`.
- **Every handler is a registered `CXAction`.** No inline `on*=` attributes
  anywhere in this app, ever. Write `data-action`/`data-change` via
  `cxAct(...)` / `cxOn(...)` and register the handler with
  `CXActions.register('cxcThing', fn)`.
- **`CXCApp.save()` is the single write path.** It persists, re-runs the
  schedule and re-renders. Call it after any mutation; never re-render by hand.
  It renders on a deferred tick on purpose — a synchronous re-render inside a
  change handler rips the focused element out of the DOM mid-dispatch.
- **Editable cells carry `data-focus-key`** so the shell can restore the cursor
  across a re-render. Any new editable control needs one.

## Frontend conventions — copied from cx-portal verbatim

`icons.js`, `format.js`, `cx-state.js`, `cx-store.js` and `cx-actions.js` are
copied from cx-portal **unchanged and already in this repo**. Build on them; do
not reimplement or edit them — an edit here becomes a merge conflict later. If
one needs a fix, it belongs upstream in cx-portal.

- **`icons.js`** — inline SVG icon system. **No emoji as icons, ever.**
  Use `${icon('name')}` inside template-literal HTML, `' + icon('name') + '`
  inside quoted strings. Add new glyphs to the `ICONS` map. Icons use
  `currentColor`, so they inherit text color. (Plain typographic arrows
  → ← and ✓/✗ are fine.)
- **`format.js`** — `escapeHtml()`. **Every** value interpolated into markup
  goes through it. This app builds HTML from user-entered strings on every
  screen; one unescaped interpolation is an XSS bug.
- **`cx-state.js`** — `cxSkeleton()`, `cxEmpty()`, `cxError()`.
- **`cx-store.js`** — the observable store. See "State and events" above.
- **`cx-actions.js`** — event delegation. See "State and events" above.
- **`cxc.css`** carries ONE bare `:root` token block, copied from cx-portal's
  `styles.css`. Colors come from **semantic tokens only** — `--surface`,
  `--text`, `--text-muted`, `--border`, the status tokens, and the
  `--phase-*` palette. **No raw hex below the token block.** Never open a
  second `:root {}`.
- **Dark mode was deliberately removed from cx-portal. Do not add it here.**

Accessibility rules CI checks on the cx-portal side, so honour them here:
- Icon-only buttons need an `aria-label` (icons are `aria-hidden`).
- Every input needs a real label or an `aria-label` — the generated table cells
  do this from the schema, so keep it up in anything hand-written.

## Verify after every JS edit

```
node tools/run_tests.js
```

Must exit 0 before any commit. The runner does two things, matching cx-portal's:

1. `node --check` on every hand-written `.js` file.
2. Runs each suite under `tools/`, aggregating by exit code.

**Write the test with the feature, in the same commit.** The engine is pure
precisely so this is cheap — `tools/test_cxc_model.js` is the pattern to copy:
plain `node`, no framework, prints `N passed, M failed`, exits non-zero on
failure. Scheduling math that nobody can verify is worth nothing to a planner.

## Git workflow

- Commit and push directly to `main`. Small, working, self-describing commits.
- Do not create feature branches or open PRs unless explicitly asked.
- `git fetch origin main` and integrate before committing.

## Explicitly out of scope for now

Do not build these without being asked — they are what the cx-portal merge
brings, and duplicating them creates conflict work later:

- Auth / login / user accounts (cx-portal has Supabase Auth).
- A permissions model (cx-portal has one — `PERMISSIONS_MODEL.md`).
- A server, an API, or a hosted database.
- Photos, punch list, documents, RMAs, drawings — all exist in cx-portal.

Build the **construction domain**: activity catalog, scope, crews, shift
windows, the schedule, and the access forecast. Nothing else.
