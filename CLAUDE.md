# CLAUDE.md — Project conventions for cx-portal

## Git workflow
- **Commit and push directly to `main`.** Do NOT create feature branches,
  cherry-pick, or open PRs unless explicitly asked. The owner works on
  `main` directly and wants all changes to land there.
- Before committing, `git fetch origin main` and integrate, since `main`
  may have moved (parallel work happens).
- Preserve existing **CRLF** line endings in `app.js`, `styles.css`,
  `index.html` (don't let edits convert them to LF — keeps diffs clean).

## Frontend conventions
- **No emoji as icons.** Use the inline SVG system in `app.js`:
  `${icon('name')}` inside template-literal HTML, `' + icon('name') + '`
  inside quoted strings, or set config `icon:` values to `icon('name')`.
  Add new glyphs to the `ICONS` map near the top of `app.js`. Icons use
  `currentColor` so they inherit text color. (Plain typographic arrows
  like → ← and ✓/✗ are fine; the `⌘`/Ctrl keyboard hint stays.)
- **Colors via semantic tokens**, not raw hex: `--surface`, `--text`,
  `--text-muted`, `--border`, plus the brand/status tokens in `:root`
  (`styles.css`). Backgrounds use `var(--surface)`; white ink stays
  `var(--white)`.
- **Icon-only buttons need an `aria-label`** (icons are `aria-hidden`).
- Reusable state helpers exist: `cxSkeleton()`, `cxEmpty()`, `cxError()`.
- Dark mode was intentionally removed — do not reintroduce it.

## Verify after JS edits
- `node --check app.js` (and `photos.js`) must pass.
- No emoji-in-quoted-string leaks: a `${icon(...)}` must never sit inside
  a single/double-quoted string (it won't interpolate) — use concat form.
