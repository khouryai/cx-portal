# ADR 0001 — Frontend architecture direction

- **Status:** Accepted
- **Date:** 2026-07-21
- **Supersedes:** the informal "strangler now, revisit framework if we hit a wall"
  note in `FABLE5_PROGRESS.md`.

## Context

The frontend is a no-build, single-page PWA: `app.js` (~50.6k lines, one file),
`styles.css` (~15.5k lines), `index.html`, plus a handful of extracted classic
`<script>` modules. It works, it is deployable on every commit, and it backs a
real project. But four structural facts now limit it:

1. **The monolith is out-growing the strangler.** `app.js` was ~38.9k lines at
   the June 2026 baseline and is ~50.6k now — it grew ~30% *during* the last
   modularization effort, because new features kept landing inside it instead of
   in new files.
2. **~1,000 inline `onclick="fn(...)"` handlers.** Each one forces its handler
   onto the global scope and makes a strict Content-Security-Policy impossible
   (inline handlers require `script-src 'unsafe-inline'`). This is the single
   biggest structural blocker to both CSP and ES-module conversion.
3. **State is ~300 loose globals + re-render-everything.** A change mutates a
   global and re-`innerHTML`s a whole section; charts are destroyed and rebuilt
   on view switches; ~225 DOM queries sit inside loops.
4. **CSS is one 15.5k-line global namespace** with no scoping, so dead rules
   never die (a first audit finds ~347 class selectors with no literal
   reference).

## Decision

**Do NOT rebuild.** A from-scratch framework rewrite of a 15-module working app
under session limits parks feature work for months and risks a long broken
window — the exact failure the strangler was chosen to avoid. The domain logic
(weighting, dynamic-testing allocation, permissions) is large and battle-tested;
throwing it away is the wrong trade.

Instead, commit to a **staged, always-deployable modernization** with an
enforced ratchet so the monolith can only shrink. Each stage is shippable on its
own and none blocks feature work:

### Stage A — Stop the bleeding (this ADR's commit)
- **Line-count ratchet** (`tools/test_size_ratchet.js` + `size_baseline.json`,
  wired into CI): `app.js` may never exceed its recorded cap. New code lands in
  new files; extractions lower the cap. *Landed.*
- **Event-delegation dispatcher** (`cx-actions.js`): one delegated listener
  routes `[data-action]` clicks to registered/global handlers. Additive — zero
  behavior change until markup is converted. *Landed.*
- **Store seam** (`cx-store.js`): the designated home for hot state, with keyed
  subscriptions so a future render subscribes to one slice instead of re-drawing
  a section. *Landed.*
- **Dead-CSS audit** (`tools/audit_css_unused.js`, report-only). *Landed.*

### Stage B — Retire inline handlers (mechanical, incremental)
Convert `onclick="fn('x')"` → `data-action="fn" data-args='["x"]'` module by
module, protected by the boot-smoke suite. Prefer converting a module's markup
in one PR and, where the handler is module-local, `CXActions.register()` it so
the global can later be dropped. Order by blast radius: static `index.html`
markup first, then per-module template-literal renders. **Exit criterion:** zero
inline `on*=` attributes remain (grep-guarded in CI once at zero).

### Stage C — Adopt the store for hot state (incremental)
Move the highest-churn globals into `CXStore` one slice at a time — current
page, active filters, and the loaded record collections — subscribing the
affected render fn. Memoize chart instances instead of destroy/rebuild. No
big-bang; each slice is independently shippable.

### Stage D — ES modules + typed core (incremental)
Once inline handlers are gone (Stage B removes the global-function requirement),
convert extracted files to `type="module"` with explicit imports/exports.
Add **JSDoc-driven type checking** (`tsc --checkJs --noEmit`) file by file,
starting with the pure-computation modules (`compute.js`, `format.js`), to get
types with no change to the no-build deploy.

### Stage E — Introduce a build step (only when it pays for itself)
Add Vite (GitHub Pages serves `dist/` as happily as the repo root). This unlocks
minification, tree-shaking, code-splitting, and lazy vendor loading. A framework
(if ever) is layered here — but only if Stages B–D leave a concrete need. The
decision to add a framework is explicitly deferred to a future ADR and must be
justified against the app that exists then, not today's.

## Constraints & consequences

- **CSP needs a header-capable host.** A strict Content-Security-Policy is the
  payoff for Stage B, but GitHub Pages cannot set response headers and `<meta>`
  CSP cannot be report-only. So the strict CSP lands with the planned Azure
  migration (API Management / a first-party host) or a header-capable CDN — not
  before. Stage B is still worth doing now because it is also the prerequisite
  for ES modules, and it removes the inline-handler XSS-via-quote-escaping class.
- **The ratchet is a one-way valve.** Never raise a cap to make CI pass. If a
  bug fix genuinely needs lines in `app.js`, extract something first or bump the
  cap as a visible, reviewed act in the same commit.
- **No new global state without a plan.** New hot state goes in `CXStore`, not a
  new `let _foo`. New interactive markup uses `data-action`, not `onclick=`.

## Progress log

- **2026-07-21 — Stage A shipped** (ratchet, dispatcher, store seam, dead-CSS
  audit). See the commit history.
- **2026-07-21 — Stage B partial:** 345 handlers converted and verified — the
  fully-automatable classes: 108 `onclick="closeModal()"` + 237 no-arg
  `onclick="fname()"`. These are behaviour-preserving because a no-arg inline
  handler passes neither the event nor arguments. Inline-handler count 1479 →
  1134 (ratcheted). **Ceiling found:** the remaining ~1,134 handlers carry
  arguments, and a large share live inside JavaScript *string concatenations*
  (`'…onclick="fn(' + id + ')"…'`) where the argument quote is also a JS string
  delimiter — a naïve regex codemod corrupts them (verified: it mis-converted
  383 sites). So the remainder needs **either** an AST-aware codemod (parse the
  JS, find the HTML string/template quasis, rewrite the handler and emit
  `${act(name, …expr)}`) **or** manual per-module conversion — and, because the
  headless suite cannot click, **browser QA** to confirm behaviour. The
  inline-handler ratchet enforces that this only moves forward.
- **2026-07-21 — Stage D started:** `tsc --checkJs` (no build) green over
  cx-store.js, cx-actions.js, format.js, cx-state.js. app.js and its tightly
  coupled modules (e.g. compute.js) join as they are decoupled/typed.
- **2026-07-21 — Browser QA unlocked.** `tools/pw_smoke.js` (Playwright via the
  pre-installed `chrome-headless-shell`) serves the app, seeds an authenticated
  admin session into localStorage, MOCKS the Supabase REST/auth layer (offline +
  deterministic, no proxy/TLS dependency), boots the real bundle logged-in, and
  drives real UI. It verifies the delegation end-to-end — a real
  `data-action="closeModal"` click closes the modal — and that every
  `[data-action]` rendered in the live DOM resolves to a handler. Opt-in suite
  (needs `playwright-core`; self-skips otherwise), so a normal headless run is
  unaffected. This removes the "can't click" limitation: the Stage B remainder
  and Stage C can now be verified per-module in a real browser. A throwaway admin
  test user (`qa-bot@cx-portal.test`) backs future real-network E2E; the smoke
  itself needs no credentials because it mocks the backend.
- **Stage C (store adoption)** and the **Stage B remainder** are the next work,
  now browser-QA'able via pw_smoke.js.

## Alternatives considered

- **Full React/Vue rewrite now** — rejected: months of parked features, long
  broken window, discards proven domain logic. Revisit only via a future ADR
  after Stages B–D.
- **Do nothing / keep improving in place** — rejected: the 30% monolith growth
  during the last effort shows "discipline only" does not hold without an
  enforced ratchet.
