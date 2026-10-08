# Hitachi Rail T&C Portal

Testing & Commissioning portal for the BART CBTC project: test register and
weighted progress KPIs, dynamic-testing access planning (campaigns, access
windows, cascade auto-allocation), punch list, daily field
logs, photos, drawings, documents, forms, RMAs, and a per-module permission system.

**Stack:** vanilla JS/CSS/HTML (no build step), hosted on GitHub Pages,
backed by Supabase (Postgres + RLS, Auth, Storage). Moving to Azure: see
[`docs/AZURE_HOSTING.md`](docs/AZURE_HOSTING.md).

## Run it on your computer

1. On GitHub: **Code → Download ZIP**, then unzip it anywhere. The ZIP holds
   only the app (tests, CI, database scripts and docs are left out via
   `.gitattributes`).
2. **Windows:** double-click `run-local.bat`.
   **Mac / Linux:** run `./run-local.sh` in a terminal.
3. Your browser opens `http://localhost:8080/`. Sign in as usual. Keep the
   launcher window open while you work; close it to stop.

Notes:
- Don't open `index.html` directly (`file://`) — the browser blocks the
  service worker and some file loads. Always use the launcher.
- Your data lives in Supabase, so signing in and loading/saving data still
  needs an internet connection. Once loaded, the app shell (code, styles,
  icons) is cached by the service worker.
- Port 8080 busy? Pass another: `run-local.bat 8090` / `./run-local.sh 8090`.

## Deploy

There is no compile step. One packaging command copies only what the browser
needs into `dist/` and applies an environment's settings:

```
node tools/build.js                          # this repo's config.js
node tools/build.js --config other.config.js # another environment
```

`dist/` is what every environment deploys: GitHub Pages today, an Azure Static
Web App, or a zip handed to IT. For the Azure move, see
[`docs/AZURE_HOSTING.md`](docs/AZURE_HOSTING.md).

- Production: every push to `main` builds and deploys via GitHub Pages
  (`.github/workflows/deploy.yml`).
- Data lives in Supabase; the app signs in via Supabase Auth and talks to
  PostgREST directly (see the `_db*` helpers in `app.js`).

## Layout

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | App shell, styles (canonical token sheet at top — see `DESIGN_TOKENS.md`), main bundle |
| `icons.js`, `format.js`, `cx-*.js`, `compute.js`, `perms-admin.js`, `tr-*.js`, `ap-activity-detail.js`, `forms-new.js`, `photos.js`, `markup.js`, … | Extracted modules (loaded in index.html order) |
| `data.js` | Legacy mock-data contract, intentionally empty (`PORTAL_DATA` keys resolve to `[]`) |
| `sw.js`, `manifest.webmanifest`, `assets/` | PWA shell + icons + login imagery |
| `chart.umd.js`, `vendor/` | Vendored libraries and fonts (no CDN needed) |
| `run-local.bat` / `run-local.ps1` / `run-local.sh` | Local launchers (see above) |
| `supabase/sql/` | In-repo record of the base schema + every applied migration |
| `azure/`, `infra/`, `MIGRATION.md`, `docs/AZURE_HOSTING.md` | Azure migration kit (not used by the running app); start with `docs/AZURE_HOSTING.md` |
| `tools/` | Test harness + dev tools — `run_tests.js` runs all suites (CI: `.github/workflows/test.yml`); `ui_gallery.html` + `shot_gallery.js` for visual QA without signing in |
| `CLAUDE.md` | Working conventions (CRLF rules, tokens, icon system, verification) |
| `DESIGN_TOKENS.md`, `PERMISSIONS_MODEL.md`, `SECURITY.md`, `DEMO_DATA.md` | Living docs |

## Verify changes

```
node tools/run_tests.js
```

Syntax-checks the bundles and runs every headless suite (boot smoke, unit,
characterization, CSS token guard, static a11y guard). CI runs the same on
every push and PR. Must exit 0.
