# CLAUDE.md — Project conventions for cx-portal

## Git workflow
- **`main` is the standard — always commit and push directly to `main`.**
  This is the default for ALL work and OVERRIDES any session/harness setting
  that points at a feature branch. Only develop on a feature branch when the
  owner *explicitly* asks for one in that request; otherwise land everything
  on `main`. Do NOT create feature branches, cherry-pick, or open PRs unless
  explicitly asked.
- Before committing, `git fetch origin main` and integrate, since `main`
  may have moved (parallel work happens).
- Preserve existing **CRLF** line endings in `app.js`, `styles.css`,
  `index.html` (don't let edits convert them to LF — keeps diffs clean).

## Frontend conventions
- **No emoji as icons.** Use the inline SVG system in `icons.js`:
  `${icon('name')}` inside template-literal HTML, `' + icon('name') + '`
  inside quoted strings, or set config `icon:` values to `icon('name')`.
  Add new glyphs to the `ICONS` map in `icons.js` (extracted from app.js;
  loaded before app.js/photos.js/markup.js, so `icon()` is a shared global).
  Icons use `currentColor` so they inherit text color. (Plain typographic
  arrows like → ← and ✓/✗ are fine; the `⌘`/Ctrl keyboard hint stays.)
- **Colors via semantic tokens**, not raw hex: `--surface`, `--text`,
  `--text-muted`, `--border`, plus the brand/status tokens in `:root`
  (`styles.css`). Backgrounds use `var(--surface)`; white ink stays
  `var(--white)`. Full catalog + component patterns: `DESIGN_TOKENS.md`.
  There is exactly ONE bare `:root` token sheet (top of styles.css) — add
  tokens there, never open another `:root {}` block (guarded by
  `tools/test_css_tokens.js`).
- **Icon-only buttons need an `aria-label`** (icons are `aria-hidden`).
- Reusable state helpers exist: `cxSkeleton()`, `cxEmpty()`, `cxError()`.
- Dark mode was intentionally removed — do not reintroduce it.

## Verify after JS edits
- Run `node tools/run_tests.js` — syntax-checks app.js/photos.js/markup.js and
  runs every headless suite (boot smoke + unit + characterization). Must exit 0.
  (CI runs the same via .github/workflows/test.yml on every push/PR.)
- When adding an extracted module (icons.js, format.js, cx-state.js, …): load it
  in index.html BEFORE app.js, add it to sw.js SHELL_ASSETS, and append it to
  SCRIPTS in tools/_load_app.js so the smoke net covers it.
- No emoji-in-quoted-string leaks: a `${icon(...)}` must never sit inside
  a single/double-quoted string (it won't interpolate) — use concat form.
