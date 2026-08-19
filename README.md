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
node tools/run_tests.js       # 50 assertions, must exit 0 before you commit
```

## What is in here

```
CLAUDE.md            ← conventions. Claude Code reads this every session.
index.html           ← THE APP. Open this.
cxc-model.js         ← THE FILE TO START ON: durations, windows, packer.
cxc-store-local.js   ← the only file allowed to touch localStorage.
cxc-ui-demo.js       ← throwaway starter UI; replace with real modules.
tools/run_tests.js   ← test runner
tools/test_cxc_model.js
README.md            ← this file
```

That is the entire project — it is deliberately standalone and shares no code or
history with cx-portal.

### Grab these from cx-portal before you build UI

Copy them in **unchanged**, so both apps share the same primitives and the
eventual merge is a file move rather than a rewrite:

`icons.js`, `format.js`, `cx-state.js`, `cx-store.js`, `cx-actions.js`,
`DESIGN_TOKENS.md`, and the `:root` token block from the top of `styles.css`
(a trimmed copy is already inlined in `index.html`). Load them in `index.html`
**before** `cxc-model.js`.

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

## What the model already does

`cxc-model.js` is a complete, tested engine — not a stub. Every function is pure
(data in, data out, no DOM, no storage), which is what makes it testable and
what lets it merge untouched.

- **Duration per quantity.** Each activity type carries `minutesPerUnit` at a
  reference crew size — conduit by linear foot, devices by type and count, fiber
  pull and splice, power cable, terminations — plus a per-task `setupMin` for
  rigging and staging.
- **Crew efficiency, non-linearly.** Doubling a crew does not halve the
  duration. `crewScalingExponent` makes that curve a dial: `1` is perfectly
  linear, `0` means extra people add nothing, real trades sit around `0.75–0.9`.
  Each crew also carries its own `efficiency` multiplier and a `skills` list.
- **Shift windows, and what they actually buy.** A pattern declares clock times
  (or an explicit duration for a 52-hour shutdown), `daysOfWeek`, `maxCrews`, and
  **mobilization in/out** — the time the window is granted but no work happens.
  `windowBudget()` takes gross time, subtracts mobilization, breaks and a
  contingency reserve, and returns the productive minutes. This is what shows
  that an 8-hour night is ~5 productive hours and a 2-hour window is ~30
  productive minutes — often less than one device takes.
- **Mapping to a schedule.** `generateWindows()` expands patterns across a date
  range (honouring blackout dates); `packSchedule()` packs work into them
  chronologically, per crew, respecting prerequisites, crew qualification,
  location relocation cost, and how finely each activity may be split
  (`continuous` / `unit` / `none`).
- **Every unplaced item gets a reason.** "no window long enough — a single ea
  needs 187 min of productive time" is more useful to a planner than any chart.
  Never drop work silently.
- **Nothing is hard-coded.** Every number lives in one `assumptions` object that
  the UI edits and exports as JSON. `DEFAULT_ASSUMPTIONS` is a seed to overwrite,
  not a source of truth. **The rates in it are placeholders — replace them with
  real estimating data before anyone reads a forecast off this.**

## Suggested build order

1. **Assumptions editors** — activity catalog, crews, shift patterns. Full CRUD,
   JSON export/import. This is the product; the schedule is a report on it.
2. **Scope import** — paste or CSV/XLSX from the estimate: location, activity,
   quantity. cx-portal vendors SheetJS if you want spreadsheet import.
3. **Schedule views** — the window table already exists; add a calendar/Gantt.
   cx-portal vendors `vis-timeline` for exactly this.
4. **Access forecast** — windows needed by type per month. This is the number
   that gets negotiated with operations, so make it the headline.
5. **Scenarios** — clone an assumption set, run both, show the delta. cx-portal's
   dynamic-testing simulator does this; copy the pattern when you merge.

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

1. Copy `cxc-*.js` / `cxc-*.css` into the cx-portal root.
2. Add them to `index.html` (after `app.js`), to `sw.js` `SHELL_ASSETS`, and to
   `SCRIPTS` in `tools/_load_app.js`.
3. Append `tools/test_cxc_*.js` to the suite list in `tools/run_tests.js`.
4. Reimplement `cxc-store-local.js` against Supabase (`cxc_*` tables + RLS);
   seed from an `exportJson()` file.
5. Fold the CSS into `styles.css` — tokens only, no second `:root {}` block.
6. Add a nav entry and wire it into the permissions model.
