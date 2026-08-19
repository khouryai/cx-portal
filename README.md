# Construction Planner — startup kit

A starting point for the **construction/installation** counterpart to cx-portal's
commissioning planning: installation scope with quantities → durations → crews →
shift windows → a dated schedule and an access forecast.

It is built to run **standalone now and merge into cx-portal later** with no
rewrite. This branch is a self-contained project: it has no shared history with
cx-portal and none of its files.

## Open it — 30 seconds, nothing to install

**There is an `index.html` at the root of this repo. Double-click it and the app
runs.** No build, no npm install, no server, no account. It is plain
HTML/CSS/JavaScript, exactly like cx-portal.

If you prefer a local server (identical result, and required later if you add
anything that fetches files):

```
npx http-server -p 8124 .     # then open http://localhost:8124
```

To run the tests you need Node installed — that is the only tool this repo uses,
and only for tests:

```
node tools/run_tests.js       # 176 assertions, must exit 0 before you commit
```

## What is in here

```
index.html            ← THE APP. Open this.
cxc.css               one :root token block + every cxc- style

  engine (pure — no DOM, no storage, fully unit-tested)
cxc-model.js          durations, window budgets, constraints, the packer
cxc-data.js           entity schema, seed dataset, CRUD, validation
cxc-timeline.js       Gantt geometry: bars, sub-lanes, date axis, milestones

  persistence
cxc-store-local.js    the ONLY file that touches localStorage

  screens (each registers itself with the shell)
cxc-ui-shell.js       nav, state, recompute loop, modal, toast
cxc-ui-plan.js        forecast, access-by-month, material take-off
cxc-ui-timeline.js    the Gantt
cxc-ui-manage.js      every management screen, generated from the schema
cxc-boot.js           installs the views and starts the app

  copied from cx-portal, unchanged — do not edit
icons.js  format.js  cx-state.js  cx-store.js  cx-actions.js

  tests
tools/run_tests.js  tools/test_cxc_model.js
tools/test_cxc_data.js  tools/test_cxc_timeline.js

CLAUDE.md             conventions. Claude Code reads this every session.
```

This is the entire project — standalone, sharing no history with cx-portal.

## What it does today

**Everything is managed in the app.** Sidebar screens with full add / edit /
duplicate / delete for:

| Screen | What it drives |
|---|---|
| **Scope** | the work: location, phase, activity, quantity, crew pin, predecessors |
| **Locations** | where crews mobilize to; relocating mid-shift costs time |
| **Phases** | ordered stages; a phase can be blocked until the earlier one finishes at that location |
| **Activities** | the rate library — minutes per unit at a reference crew size, setup time, how finely it splits, and its bill of materials |
| **Materials** | on-hand quantity and on-site date — work cannot be scheduled before its material lands, and stops when tracked stock runs out |
| **Crews** | size, efficiency, which activities they are qualified for, which vehicles they need, which shifts they may work |
| **Work vehicles** | a vehicle serves ONE crew per window, so a shared hi-rail limits how many crews can work the same night |
| **Shift windows** | start/end or an explicit duration, mobilization in/out, days of week, max crews |
| **Assumptions** | productivity factor, crew scaling exponent, breaks, contingency, relocation, phase-order enforcement, blackout dates |

Edits are inline and immediate — change a cell and the whole schedule re-runs.

**Plan & forecast** — crew-hours, windows needed, access forecast by month and
window type, material take-off with shortfalls, per-window utilization, and
every unscheduled item with the reason it did not fit.

**Timeline** — a Gantt of every run, grouped by location, crew, phase or
activity, coloured by phase, with weekend shading and dated event markers for
material deliveries and phase completions.

## Answers to the setup questions

**Build locally first? Yes.** No hosting, no accounts, no deploy pipeline. The
repo root is the site — open `index.html` and it runs, exactly like cx-portal.
The estimating work (are the production rates right? does a 2-hour window buy
anything?) is where the value is, and none of it needs a server. Standing up
infrastructure first would spend the early weeks on the part that gets thrown
away at the merge anyway.

**A storage backend? Not yet — but isolate storage from day one.** Use
`localStorage` plus JSON import/export, all of it behind `cxc-store-local.js`,
which is the *only* file permitted to touch persistence. When this merges into
cx-portal, swapping to Supabase is one file: reimplement five functions against
`cxc_*` tables. If storage calls get sprinkled through the UI instead, that
one-file swap becomes a rewrite. This is the single highest-leverage rule in the
kit.

Two consequences worth telling him up front: browser storage is **per-browser and
not backed up**, so "Export JSON" is the save-file — he should export after every
real work session and commit the export to the repo. And a shared scenario is a
JSON file passed around, not a link.

**When to add a backend:** when a second person needs to edit the same plan, or
when the plan must be reviewed by someone who isn't him. Not before. That moment
is also the natural merge point into cx-portal, which already has the auth, the
permissions model and the database.

**Don't build:** auth, users, permissions, photos, punch list, documents,
drawings. cx-portal has all of it. Building parallel versions creates conflict
work at the merge and buys nothing in the meantime.

## How the engine decides things

All of it is pure and unit-tested (`cxc-model.js`, `cxc-timeline.js`), and all
of it is driven by data you edit in the app.

- **Duration per quantity.** Each activity carries `minutesPerUnit` at a
  reference crew size, plus a per-task `setupMin` for rigging and staging.
- **Crew efficiency, non-linearly.** Doubling a crew does not halve the
  duration. `crewScalingExponent` is the dial: `1` is perfectly linear, `0`
  means extra people add nothing, real trades sit around `0.75–0.9`. Each crew
  also has its own efficiency multiplier and skill list.
- **What a window actually buys.** Gross time minus mobilization in/out, minus
  breaks, minus a contingency reserve. This is why an 8-hour night is ~5.2
  productive hours — and why, with the sample numbers, a 2-hour window is worth
  27 minutes and never gets used at all. That result is the tool working.
- **Vehicles.** A vehicle serves one crew per window. Two crews sharing a
  hi-rail means only one of them works that night.
- **Materials.** Work cannot be scheduled before every material it consumes is
  on site, and a tracked stock caps how much gets installed.
- **Phases.** With phase order enforced, a phase cannot start at a location
  until every earlier phase there is complete — per location, not project-wide.
- **Splitting.** An activity splits `continuous` (cut conduit anywhere), by
  `unit` (whole devices only), or `none` (must finish inside one window — a
  cutover). This is what makes a weekend shutdown worth having.
- **Every unplaced item gets a reason.** "no window long enough — a single ea
  needs 187 min of productive time" is more useful to a planner than any chart.
- **Nothing is hard-coded.** The seed in `cxc-data.js` is a worked example to
  overwrite. **Its rates are placeholders — replace them with real estimating
  data before anyone reads a forecast off this.**

## Where to take it next

1. **Real rates.** Replace the seed catalog with actual production data. Nothing
   else matters until this is done.
2. **Scope import** — CSV/XLSX paste from the estimate instead of typing rows.
   cx-portal vendors SheetJS if you want spreadsheet parsing.
3. **Scenarios** — clone a dataset, run both, show the delta ("what does losing
   the weekend shutdown cost us?"). cx-portal's dynamic-testing simulator does
   exactly this; copy that pattern when you merge.
4. **Progress tracking** — actuals against plan, so the productivity factor gets
   calibrated from real performance instead of guessed.
5. **Printable forecast** — a one-page access request for operations.

## Why the conventions in CLAUDE.md are strict

cx-portal's `app.js` reached 50,000 lines and now carries a CI-enforced
line-count ratchet that only moves downward, plus a program to retire ~1,000
inline `onclick=` handlers that block a strict CSP and ES modules
(`docs/adr/0001-frontend-architecture.md`). None of that was avoidable in
hindsight without the rules that are now in `CLAUDE.md` up front: new code in new
files, `data-action` instead of `onclick=`, state in `CXStore`, semantic color
tokens instead of raw hex, SVG icons instead of emoji, and a test with every
feature. Starting the second app with those rules costs nothing now and saves the
same rescue later.

## Merge checklist (for later)

The `cxc-` prefix on every file, global, CSS class, storage key and future table
name is what makes this a copy rather than a merge. When the time comes:

1. Copy `cxc-*.js` and `cxc.css` into the cx-portal root. The five shared
   primitives (`icons.js`, `format.js`, `cx-state.js`, `cx-store.js`,
   `cx-actions.js`) are already cx-portal's — do not copy those back.
2. Add them to `index.html` (after `app.js`), to `sw.js` `SHELL_ASSETS`, and to
   `SCRIPTS` in `tools/_load_app.js`.
3. Append `tools/test_cxc_*.js` to the suite list in `tools/run_tests.js`.
4. Reimplement `cxc-store-local.js` against Supabase (`cxc_*` tables + RLS);
   seed from an `exportJson()` file.
5. Fold the CSS into `styles.css` — tokens only, no second `:root {}` block.
6. Add a nav entry and wire it into the permissions model.
