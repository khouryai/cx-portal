# Hitachi Rail T&C Portal

Testing & Commissioning portal for the BART CBTC project: test register and
weighted progress KPIs, dynamic-testing access planning (campaigns, access
windows, cascade auto-allocation), lookahead planning, punch list, daily field
logs, photos, drawings, RMAs, meetings, and a per-module permission system.

**Stack:** vanilla JS/CSS/HTML (no build step), hosted on GitHub Pages,
backed by Supabase (Postgres + RLS, Auth, Storage, Edge Functions).

## Run / deploy

There is no build. The repo root **is** the site:

- Local: serve the root (`npx http-server -p 8123 .`) and open `index.html`.
- Production: every push to `main` deploys via GitHub Pages
  (`.github/workflows/deploy.yml`).
- Data lives in Supabase; the app signs in via Supabase Auth and talks to
  PostgREST directly (see the `_db*` helpers in `app.js`).

## Layout

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | App shell, styles (canonical token sheet at top — see `DESIGN_TOKENS.md`), main bundle |
| `icons.js`, `format.js`, `cx-state.js`, `compute.js`, `perms-admin.js`, `team.js`, `photos.js`, `markup.js`, `photos.css` | Extracted modules (loaded in index.html order) |
| `data.js` | Legacy mock-data contract, intentionally empty (`PORTAL_DATA` keys resolve to `[]`) |
| `sw.js`, `manifest.webmanifest`, `assets/` | PWA shell + icons + login imagery |
| `chart.umd.js` | Chart.js (vendored) |
| `supabase/functions/` | Edge Functions source (e.g. `photo-sharepoint-sync`) |
| `supabase/sql/` | In-repo record of the base schema + every applied migration |
| `sync_testplan.js`, `sync_track_plan.js`, `track_plan_importer.html` | Operational importers (test-plan master, Visio track-plan extract) |
| `tools/` | Test harness + dev tools — `run_tests.js` runs all suites (CI: `.github/workflows/test.yml`); `ui_gallery.html` + `shot_gallery.js` for visual QA without signing in |
| `CLAUDE.md` | Working conventions (CRLF rules, tokens, icon system, verification) |
| `DESIGN_TOKENS.md`, `PERMISSIONS_MODEL.md`, `SECURITY.md`, `INTEGRATION_SHAREPOINT.md`, `DEMO_DATA.md` | Living docs |
| `FABLE5_AUDIT_PROMPT.md`, `FABLE5_PROGRESS.md` | Audit engagement brief + progress ledger |

## Verify changes

```
node tools/run_tests.js
```

Syntax-checks the bundles and runs every headless suite (boot smoke, unit,
characterization, CSS token guard, static a11y guard). CI runs the same on
every push and PR. Must exit 0.
