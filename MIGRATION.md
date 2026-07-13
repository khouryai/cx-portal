# Migration Assessment — cx-portal → Microsoft (Azure / M365) Environment

Status: pre-migration preparation is **done in this repo** (see "Already completed"
below). This document is the hand-off for the IT team executing the move.

## 1. Current architecture inventory

| Layer | Today | Notes |
|---|---|---|
| Frontend | Static site, no build step; PWA service worker (`sw.js`); deployed to GitHub Pages via `.github/workflows/deploy.yml` | All third-party libraries now self-hosted in `vendor/` (one exception, §4) |
| API | Supabase PostgREST (auto REST over Postgres) | Client calls flow through supabase-js (`_sb`) + thin fetch helpers (`_dbSelect/Insert/Update/Delete`, `_fetchAnon`) |
| Auth | Supabase GoTrue — email/password, in-app invites (`signUp`) | Session JWT in localStorage; identity = `auth.uid()` |
| Authorization | **In the database**: ~325 RLS policies + `private.has_module_perm()` + `private._perm_baseline()` reading `perm_modules` / `permission_templates` / `template_module_perms` / `user_module_overrides` | This IS the permission-template system; the client only mirrors it for UI gating (`perms-admin.js`) |
| Database | Postgres: 82 tables, 20 functions (incl. SECURITY DEFINER RPCs `create_vehicle_patch`, `fn_feasible_instances`), 53 triggers, 26 jsonb columns, 20 array columns | ~59 MB data at time of writing |
| File storage | 5 Supabase Storage buckets: `photos`, `forms`, `drawings`, `vehicle-files`, `task-files`; signed URLs | `forms`, `vehicle-files` and `task-files` I/O already flow through swappable adapters (`_formsStorage`, `_vfStorage`, `_rdStorage`) |
| Serverless | 3 Edge Functions: `send-daily-log-email`, `send-rma-email`, `photo-sharepoint-sync` | Small; replace with Azure Functions |
| Config seam | `config.js` — the single file holding backend URL + publishable key | Loaded before every other script |

## 2. The load-bearing decision: keep PostgreSQL

Do **not** port to Azure SQL / SQL Server. The authorization model (325 RLS
policies), 53 triggers of scheduling/business logic, and 46 jsonb/array columns
(`linked_car_ids`, `custom_fields`, punch `comments`/`history`, template
configs) have no direct SQL Server equivalents — arrays alone force a schema
redesign, and RLS-based permissions would have to be reimplemented as API
middleware. **Azure Database for PostgreSQL (Flexible Server)** is an
IT-managed Microsoft service and `pg_dump`/`pg_restore` moves the schema,
policies, functions, and triggers verbatim.

## 3. Target architecture (least-rewrite path)

| Concern | Target | Migration mechanics |
|---|---|---|
| Database | Azure Database for PostgreSQL Flexible Server | `pg_dump` → `pg_restore`; configure automated backups, region per data-residency policy |
| REST API | Self-hosted **PostgREST** on Azure Container Apps | supabase-js works against plain PostgREST — the client seam is `config.js`, not call sites |
| Auth | **Microsoft Entra ID** via MSAL.js | PostgREST validates Entra JWTs (JWKS). Create a compatible `auth.uid()` shim in the DB that reads the Entra `oid` claim → **zero policy edits**. Re-key `profiles` rows to Entra object IDs (do this while user count is small). In-app invites/password flows retire in favor of IT provisioning |
| Photos + vehicle-files | **Azure Blob Storage** with SAS tokens | Drop-in for the signed-URL pattern. `vehicle-files` I/O is already behind `_vfStorage`; photos I/O is encapsulated in `photos.js` (`storageUpload`/`sign`) |
| Forms + drawings | **SharePoint via MS Graph** | `_formsStorage` was explicitly designed for this swap ("nothing above the adapter changes"); a `photo-sharepoint-sync` edge function already prototypes Graph access |
| Emails | **Azure Functions + Graph `sendMail`** | Replaces `send-daily-log-email` / `send-rma-email`; native M365 mail is an upgrade over the current sender |
| Hosting | **Azure Static Web Apps** | Port `deploy.yml` (keep the `CACHE_VERSION` bump step); SWA staging slots + Entra integration built in |
| CI | GitHub Actions → company standard | Note: current convention pushes to `main` directly; expect IT to require PR gates |

## 4. Known exceptions / risks

1. **xlsx 0.20.3** (`cdn.sheetjs.com`) is the one remaining external script —
   SheetJS does not publish 0.20.x to the npm registry. At cutover, mirror the
   exact file into `vendor/js/` from an approved artifact store. Do **not**
   downgrade to npm's 0.18.x.
2. **Token lifetimes vs. field use**: the PWA + IndexedDB photo queue assume
   long-lived sessions. Test MSAL silent refresh on yard/tunnel devices with
   intermittent connectivity before cutover.
3. **Anon/pre-auth reads**: PostgREST + Entra means no anonymous key; the app
   already tolerates empty pre-auth loads (all data reloads after sign-in).
4. **Supabase-specific APIs** in use: `_sb.auth.*` (replace with MSAL wrapper),
   `_sb.storage.*` (behind adapters), `.from()` query chains (work against
   plain PostgREST unchanged).
5. **Data migration timing**: DB is small; migrate early. Storage objects and
   the four buckets move with a simple copy script.

## 5. Suggested sequence

1. ✅ *(done)* Vendor third-party libraries + fonts; extract `config.js`;
   storage adapters for forms and vehicle-files.
2. Stand up Azure Postgres + PostgREST + the `auth.uid()` shim; point a staging
   copy of the frontend at it via `config.js`.
3. Entra/MSAL swap + `profiles` re-keying (while user count is small).
4. Storage cutover (Blob SAS for photos/vehicle-files; Graph/SharePoint for
   forms/drawings); emails to Azure Functions.
5. Azure Static Web Apps hosting + CI port; parallel-run, then cutover.

## 6. Already completed in this repo (behavior-preserving)

- All CDN dependencies self-hosted in `vendor/` at the **exact pinned
  versions** (15 JS libraries incl. the pdf.js worker + jszip, 5 stylesheets),
  and Google Fonts replaced by self-hosted variable Archivo/Inter + IBM Plex
  Mono (`vendor/fonts/fonts.css`). No external CDN calls remain except xlsx
  (§4.1). All vendor assets are in the service-worker shell, making the PWA
  fully offline-capable.
- `config.js`: backend URL + publishable key extracted to a single first-loaded
  file — the one-file cutover seam.
- `_vfStorage` adapter for vehicle checklist attachments (mirrors
  `_formsStorage`).
- Permission enforcement moved fully into RLS (see the permissions audit
  commit) — the permission-template system survives migration intact because it
  lives in the database.
