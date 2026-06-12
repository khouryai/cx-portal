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
| Typography | `--f-display`, `--f-ui`, `--f-mono`, `--f-input`, `--f-number`, `--input-size/weight`, `--number-size/weight` | NOTE: app.js re-sets the input/number tokens at runtime from `_productionVisualDefaults` |
| Elevation/shape/motion | `--shadow-sm/md/lg`, `--radius-sm/md/lg/xl`, `--easing` | Cards, modals, transitions |
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
- **Buttons** — legacy reality: there is no single `.btn`; families are
  per-area (`admin-action-btn(-secondary)` in admin, `dyn-btn`/`dyn-btn primary`
  in Dynamic Testing, `v2-btn-mini/ghost/primary` in newer screens,
  `tr-mini-btn` in the Test Register, `cal-btn`, `drw-tool-btn`, `pdf-tb-btn`).
  **For new work inside an area, reuse that area's family** so the screen stays
  coherent; don't introduce an 11th family. A future unification pass should
  pick one family and alias the rest — out of scope for now (high-churn,
  needs browser QA).

## Guard

`tools/test_css_tokens.js` (in the standard harness, `node tools/run_tests.js`)
asserts: exactly one bare `:root`; no duplicate definitions; the key token
families present at their consolidated values; the `:focus-visible` rule uses
`var(--focus-ring)`; core tokens never redefined later in the file; CRLF intact.
