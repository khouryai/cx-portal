# Design tokens & component patterns — cx-portal

The single source of truth for visual values is the **canonical `:root` token
sheet at the top of `styles.css`** (the only bare `:root {}` block in the file —
enforced by `tools/test_css_tokens.js`). History: the file had accreted four
competing `:root` blocks redefining the same names with different values; the
last-wins winners were consolidated into one sheet on 2026-06-12 (zero visual
change — every token kept its effective value).

Rules of engagement (also in CLAUDE.md):

- **New colors go through tokens, not raw hex.** If a value you need doesn't
  exist, add a token to the canonical sheet (in the right category) and use
  `var(--name)`.
- **Never open another bare `:root {}` block** anywhere in `styles.css` —
  the guard test fails the build. Conditional theming via attribute selectors
  (`:root[data-tr-*]`) is fine.
- Dark mode was intentionally removed — don't reintroduce it.

## Token catalog (categories, in sheet order)

| Category | Tokens | Use for |
|---|---|---|
| Brand | `--hitachi-red`, `--hitachi-red-hover`, `--hitachi-red-light`, `--primary`, `--primary-hover` | Primary actions, brand accents, active nav |
| Warm neutral ink | `--black` … `--gray-50`, `--white` | Ink, dividers, subtle fills on light surfaces |
| Slate (cool gray) | `--slate-900` … `--slate-50`, `--dark-surface(-2/-3)` | Sidenav and other dark chrome ONLY |
| Semantic surfaces/text | `--bg`, `--app-bg`, `--surface(-2/-3)`, `--card-bg`, `--text`, `--text-main`, `--text-muted`, `--text-subtle`, `--border`, `--border-strong`, `--line-soft`, `--line-strong` | Prefer these over raw grays — they're the themeable layer |
| Status | `--good`, `--warn`, `--bad`, `--info`, `--pending` (+ `-light` pair each), `--red-600`, `--red-300` | Badges, banners, validation |
| Status mid-dots | `--good-dot`, `--warn-dot`, `--bad-dot`, `--info-dot`, `--pending-dot` | Small indicator dots/pills where the full status color is too dark |
| Accents | `--accent-blue(-strong)`, `--brand-blue`, `--accent-indigo`, `--accent-amber`, `--green-700` | Charts, links, secondary emphasis |
| Lookahead disciplines | `--disc-tc`, `--disc-cons`, `--disc-design`, `--disc-default` (+ `-bg` each) | Discipline bands on lookahead/calendar |
| Typography | `--f-display`, `--f-ui`, `--f-mono`, `--f-input`, `--f-number`, `--input-size/weight`, `--number-size/weight` | `--f-mono` is REAL mono (Roboto Mono, imported in styles.css line 1) — used for eyebrows, KPI labels, table headers, metas. NOTE: app.js re-sets the input/number tokens at runtime from `_productionVisualDefaults` |
| Elevation/shape/motion | `--shadow-sm/md/lg` (layered scale), `--radius-sm/md/lg/xl`, `--easing`, `--dur-fast` (140ms micro), `--dur` (220ms transitions) | Cards, modals, transitions — use the duration tokens, don't invent new timings |
| Input focus ring | `--ring` | `box-shadow` focus halo for inputs/selects (pairs with a brand-tinted `border-color`) |
| Spacing | `--space-1` (4px) → `--space-6` (32px) | New layout work (legacy uses literal px — migrate opportunistically, don't sweep) |
| Focus ring | `--focus-ring`, `--focus-ring-offset` | The ONE focus style; the global `:focus-visible` rule consumes it (P4-2 a11y) |

## Component patterns

Reach for these before inventing new classes:

- **Status badges** — `.badge` + a status modifier (`.badge-passed`,
  `.badge-failed`, `.badge-warn`, `.badge-open`, `.badge-inprog`,
  `.badge-pending`, `.badge-notstarted`, `.badge-ready`, `.badge-draft`,
  `.badge-futuretest`, `.badge-review`, `.badge-accepted`, `.badge-resubmit`,
  `.badge-rejected`, `.badge-closed`…). In JS, get the class from
  `getStatusBadge(status)` (compute.js) — don't hand-map statuses.
  The Test Register offers user-selectable badge skins via
  `:root[data-tr-status="mono|mono-dot|bar"]` — new badge styling must work
  under those too (they restyle `.badge` inside table scopes).
- **Tags / subsystem chips** — `.tag` (+ `data-tr-color` palette slots in the
  Test Register; skins via `:root[data-tr-subsys]`).
- **Empty / loading / error states** — ALWAYS the shared helpers from
  cx-state.js: `cxSkeleton(n)`, `cxEmpty({...})`, `cxError({...})`. Don't write
  ad-hoc "Loading…" markup.
- **Icons** — inline SVG via `icon('name')` from icons.js (see CLAUDE.md; no
  emoji icons). Icon-only buttons need `aria-label`.
- **Buttons** — there is no single `.btn`; families are per-area
  (`admin-action-btn(-secondary)` in admin, `dyn-btn`/`dyn-btn primary` in
  Dynamic Testing, `v2-btn-mini/ghost/primary` in newer screens, `tr-mini-btn`
  in the Test Register, `cal-btn`, `pm-btn` in Photos, `drw-tool-btn`,
  `pdf-tb-btn`). Since the 2026-06-12 aesthetic layer they all share ONE
  interaction grammar (the `AESTHETIC OVERHAUL LAYER` at the bottom of
  styles.css): 8px radius, `--dur-fast` transitions, 1px press, 0.45-opacity
  disabled, and two visual roles — **solid Hitachi red = primary action**
  (`admin-action-btn`, `v2-btn-primary`, `dyn-btn.primary`, `pm-btn-primary`,
  `cal-btn-primary`), **bordered surface = everything else**. For new work
  reuse the area's family; the shared grammar keeps it coherent. Don't
  introduce an 11th family.

## Hero KPI chips (chip-stat) — the canonical stat vocabulary

Compact status/metric chips are the shared vocabulary across the app: a mono
uppercase micro-label + a bold tabular number in a pill, tinted by semantic
tone. There is ONE look, reached three ways depending on where you are:

- **Any page hero** — pass `stats:[{label,value,tone}]` to `renderPageHero()`.
  Tones are `red | amber | blue | good | muted` and render as tinted pills
  (`.page-hero-v3 .ph-stat.tone-*`). This is the default for a page's headline
  KPIs and every module inherits it for free.
- **Dashboard secondary metrics** — `.metric-tile` in `#metric-row` renders as
  the same chip rail (colored dot + mono label + tabular number).
- **Inside a module render layer** — reuse `.simx-chipstat` (`.is-good /
  .is-bad / .is-warn / .is-info`), already shared by the Dynamic Testing
  capacity/access/board/variance tabs.

All three share one visual system; prefer `renderPageHero({stats})` for page
headers so a new page never hand-rolls a KPI strip. Semantic tone → token:
good=`--good`, red/bad=`--bad`, amber/warn=`--warn`, blue/info=`--info`, each
over its `-light` background. Big landing numbers (dashboard `.kpi-card`) stay
large cards — the chip rail is for *supporting* detail, not the headline.

Each status family is a **complete triple**: strong ink (`--good`), pale
background (`--good-light`), and a soft border tint (`--good-border`, an rgba
of the ink — same for warn/bad/info). Purple (`--accent-purple` /
`--accent-purple-light`) covers Future Test / pending states. The P3
harmonization (2026-07) rewrote ~650 inline hex values in app.js/index.html
onto these tokens — when writing tag/badge/box styles inline, always use the
triple, never tailwind-style hex. Exceptions that stay literal hex on purpose:
Chart.js palettes (`COLORS`), canvas drawing, PDF-markup pen colors, and
console `%c` styles (CSS vars don't resolve there).

## Visual QA without signing in

`tools/ui_gallery.html` renders every core component (hero, KPI cards, table +
badges, all button families, form controls, modal, sidebar) against the real
styles.css using the exact markup app.js emits. Serve the repo root
(`npx http-server -p 8123 .`) and open it, or screenshot headlessly with
`node tools/shot_gallery.js /tmp/gallery.png` (playwright). Use it before/after
any styles.css change.

## Guard

`tools/test_css_tokens.js` (in the standard harness, `node tools/run_tests.js`)
asserts: exactly one bare `:root`; no duplicate definitions; the key token
families present at their consolidated values; the `:focus-visible` rule uses
`var(--focus-ring)`; core tokens never redefined later in the file; CRLF intact.
