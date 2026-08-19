# CLAUDE.md — Project conventions for the Construction Planner

> Copy this file to the ROOT of the construction-planner repo. Claude Code reads
> it automatically on every session and follows it as hard rules.

This app is being built **standalone now, merged into `cx-portal` later** (the
Hitachi Rail T&C Portal — the commissioning side of the same project). Every
rule below exists so that the merge is a *file copy*, not a rewrite. Follow them
even when a different approach would be marginally faster today.

## What this app is

Construction planning and access forecasting for installation work: conduit,
devices (by type), fiber, power cable, terminations. Scope items carry a
**quantity**; the activity catalog carries a **duration per unit**; crews and
**shift windows** (single-track 6–8 hr, short 2 hr windows, weekend shutdowns)
convert that into a **dated schedule** and an **access forecast** — how many
windows of each type the work actually needs.

**The whole point is the assumptions are wrong and get corrected.** Every rate,
crew size, mobilization allowance and window length must be editable in the UI
and exportable as JSON. If a number appears in a `.js` file outside the
assumptions object, it is a bug.

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
| Files | `cxc-*.js` / `cxc-*.css` | `cxc-model.js`, `cxc-schedule.js` |
| Globals | ONE object, `window.CXC` | `CXC.packSchedule(...)` |
| Functions | no bare globals; hang them off `CXC` | not `function packSchedule()` |
| CSS classes | `cxc-` prefix | `.cxc-window-row` |
| Store keys | `cxc.` prefix | `CXStore.set('cxc.scope', ...)` |
| Future DB tables | `cxc_` prefix | `cxc_activity_types` |
| localStorage keys | `cxc.` prefix | `cxc.assumptions.v1` |

## Architecture — pure core, thin shell

Split every file into one of three layers and never blur them:

1. **Model / engine** (`cxc-model.js`) — pure functions. No DOM, no storage, no
   `fetch`, no `Date.now()`, no globals read from outside. Data in, data out.
   This is the layer that merges untouched and the layer that gets tested.
2. **Persistence** (`cxc-store-local.js`) — the ONLY file that touches
   localStorage / file import / export. One narrow interface
   (`load()`, `save()`, `exportJson()`, `importJson()`), so swapping it for
   Supabase at merge time is a single-file change. **No storage calls anywhere
   else.**
3. **UI / render** (`cxc-ui-*.js`) — builds HTML strings, reads from the model,
   writes through the persistence layer.

New features land in **new files**, not by growing an existing one. cx-portal
learned this the hard way: `app.js` reached 50,000 lines and now has a
CI-enforced line-count ratchet that only moves down (`tools/size_baseline.json`).
Do not start a monolith that needs the same rescue.

## Frontend conventions — copied from cx-portal verbatim

Copy these files from cx-portal into this repo unchanged, and build on them.
Do **not** reimplement them:

- **`icons.js`** — inline SVG icon system. **No emoji as icons, ever.**
  Use `${icon('name')}` inside template-literal HTML, `' + icon('name') + '`
  inside quoted strings. Add new glyphs to the `ICONS` map. Icons use
  `currentColor`, so they inherit text color. (Plain typographic arrows
  → ← and ✓/✗ are fine.)
- **`format.js`** — `escapeHtml()`, `getLocationCode()`. **Every** value
  interpolated into markup goes through `escapeHtml()`.
- **`cx-state.js`** — `cxSkeleton()`, `cxEmpty()`, `cxError()` for loading /
  empty / error states. Use them rather than inventing new ones.
- **`cx-store.js`** — the observable store (`get`/`set`/`update`/`subscribe`).
  Hot state goes here under `cxc.*` keys, **not** in loose `let _foo` globals.
- **`cx-actions.js`** — event delegation. **No inline `onclick=`.** Write
  `data-action="fn" data-args='["x"]'`, emitted with `cxAct('fn', x)` /
  `cxOn('change', 'fn', '$cx.value')`. Module-local handlers register with
  `CXActions.register('name', fn)`. cx-portal is retiring ~1,000 inline
  handlers right now (they block a strict CSP and ES modules) — do not create
  more debt to inherit.
- **The `:root` token block** from the top of cx-portal's `styles.css`, and
  `DESIGN_TOKENS.md`. Colors come from **semantic tokens only** — `--surface`,
  `--text`, `--text-muted`, `--border`, plus the brand/status tokens
  (`--primary`, `--good`, `--warn`, `--bad`, `--info`). **No raw hex** in
  component CSS. Exactly ONE bare `:root {}` block in the whole stylesheet.
- **Dark mode was deliberately removed from cx-portal. Do not add it here.**

Accessibility rules that CI checks on the cx-portal side:
- Icon-only buttons need an `aria-label` (icons are `aria-hidden`).
- Every form control needs a real label.

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
