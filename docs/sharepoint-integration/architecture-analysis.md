# CX Portal — Architecture Analysis for SharePoint / Azure Integration

> Internal prep document for the IT integration ticket. Captures the *current* architecture,
> the API/data flow, the secrets posture, and the proposed *target* architecture once the
> Hitachi Azure tenant is in the loop. Intended as a starting point for discussion with
> IT, not a fixed proposal.

---

## 1. Current architecture (as built — prototype tier)

| Layer | Implementation | Notes |
|---|---|---|
| Frontend | Static HTML/CSS/JS (`index.html`, `app.js`, `styles.css`, `data.js`) | Single-page app, no build step. |
| Hosting | GitHub Pages, deployed via `.github/workflows/deploy.yml` on push to `main` | HTTPS enforced by GitHub. |
| Auth | Supabase Auth — email + password, JWT in `localStorage` | The JWT is read directly from `localStorage` and attached to native `fetch` calls (`app.js:37-61`). |
| Data API | Direct browser → Supabase PostgREST (`/rest/v1/...`) | Helpers `_dbInsert / _dbUpdate / _dbSelect / _dbDelete` in `app.js:63-198`. |
| Server-side logic | Two Supabase Edge Functions — `send-daily-log-email`, `send-rma-email` | Called from `app.js:5873` and `app.js:14620`. |
| Database | Supabase Postgres (US-East), ~45 tables | Schema in `supabase_schema.sql`. |
| Authorization | Row-Level Security on every table; DB triggers (`audit_db_change`) write all INSERT/UPDATE/DELETE into `db_change_log` | UI role checks are advisory; RLS is the actual gate. |
| Document storage | Not yet implemented in the application. `punch_photos.storage_path` exists in the schema but no upload code path is wired up. | This is exactly the gap SharePoint is meant to fill. |

### What the frontend actually holds

- **Supabase project URL** — public.
- **Supabase `anon` JWT** (`app.js:13`, `sync_testplan.js:18`) — public API key by design. Grants zero data access on its own because RLS blocks every table for anonymous callers.
- **No service-role key, no SMTP credentials, no SharePoint credentials, no Graph secrets** anywhere in the client bundle.
- **No PINs or passwords in code or database.** The live auth flow is `signInWithPassword` against Supabase Auth.

### How an API call flows today

1. User signs in → JWT returned and persisted in `localStorage`.
2. Every data call goes browser → Supabase PostgREST with `apikey: <anon>` + `Authorization: Bearer <user JWT>`.
3. PostgREST validates the JWT, runs the query inside a Postgres session whose `request.jwt.claims` reflect the user, and RLS policies decide which rows are visible / writable.
4. DB triggers capture every write into `db_change_log` with the actor's email and role.
5. Side-effects requiring secrets (RMA email, daily-log email) are POSTed to Supabase Edge Functions that run server-side.

**Net:** there is **no application backend of our own today**. The "backend" is Supabase. This works as a demo tier but doesn't satisfy a corporate SharePoint integration, where the Microsoft Graph credential must sit on a server we control.

---

## 2. Target architecture (post-integration)

The integration adds a thin first-party backend inside Hitachi's Azure tenant. The frontend stops talking directly to anything that requires a privileged credential; SharePoint access happens only through that backend.

See `architecture-diagram.mmd` for the visual. Key components (all open to IT's preferred patterns):

| Component | Purpose | Where secrets live |
|---|---|---|
| **Microsoft Entra ID** | Single sign-on, MFA, Conditional Access. Covers both **Hitachi staff** and **BART personnel** — likely as B2B guests in the Hitachi tenant, or whatever pattern IT recommends. | Tenant-managed. |
| **Azure Front Door / CDN** | Public TLS endpoint, WAF, rate limiting. | n/a |
| **Static SPA** | Hosted on Azure Static Web Apps or App Service. Holds no secrets — only the public Entra app/client ID and the API base URL. | n/a |
| **Azure API Management** | JWT validation, throttling, audit, single `/api/*` surface for the SPA. | n/a |
| **Backend API** | Owns the Microsoft Graph client. Exchanges the user's Entra token (on-behalf-of) or uses an app-only credential to read/write the `Commissioning` subsite document libraries. Owns the database service-role key for operations that must bypass RLS. | All secrets pulled from **Azure Key Vault** via Managed Identity. Never logged, never returned to the client. |
| **Azure Key Vault** | Stores: SharePoint/Graph app secret or certificate, database service-role key, mail-delivery keys, signing keys. | The only place credentials exist outside Entra. |
| **SharePoint Online — `Commissioning` subsite under `BART CBTC Project`** | Document libraries for punch photos (before/after), daily logs, CDRL test reports, and look-ahead workbooks. Permissions inherited from existing site/library ACLs. | Tenant-managed. |
| **Azure Database for PostgreSQL** (Flexible Server) | Migration target from Supabase Postgres. Keeps the schema and RLS model intact, lands the data inside the Hitachi tenant for compliance. | Tenant-managed; credentials in Key Vault. |
| **Azure Monitor / Log Analytics / Sentinel** | Central observability and security telemetry. | n/a |

### How an API call will flow after integration

1. User hits the portal → Entra SSO (with MFA + Conditional Access) → SPA receives an ID + access token.
2. SPA calls `https://portal.<tenant>/api/<endpoint>` with `Authorization: Bearer <Entra access token>`.
3. API Management validates the JWT, applies rate limits, forwards to the backend.
4. Backend re-validates the token, looks up the user's role / subsystem / tenant (Hitachi vs. BART guest), then either:
   - For **document operations**: calls Microsoft Graph (on-behalf-of or app-only) to read/write the relevant library inside the `Commissioning` subsite. The Graph secret never leaves the backend.
   - For **structured data**: forwards to Azure Database for PostgreSQL using either the user's JWT (RLS path) or the service-role key from Key Vault for admin operations.
5. All requests, responses, and errors stream to Log Analytics. Auth events stream to Entra sign-in logs.

### What this buys us, security-wise

- No SharePoint / Graph / database service-role / mail-delivery credentials ever ship to a browser.
- SSO + MFA + Conditional Access come "for free" via Entra, and BART users can be invited as guests rather than getting their own credential set.
- Document ACLs are enforced by SharePoint itself, so corporate retention and DLP policies apply automatically.
- Every call has a clear audit trail across three independent systems: Entra sign-in logs, APIM access logs, and the database change log.

---

## 3. Photo upload — interim plan

The `punch_photos` table exists in the schema but no upload UI is wired up yet. We can:

- **Option A — Wait for SharePoint.** Don't build the upload UI until the Graph backend is in place. Cleanest, but the demo we show IT during the review won't include the end-to-end punch-photo flow.
- **Option B — Build a thin MVP now against a storage-agnostic interface** (a small `uploadPhoto(file)` / `getPhotoURL(id)` adapter, initially backed by Supabase Storage). When the Azure backend lands, swap the adapter for a Microsoft Graph client pointing at the `Commissioning` subsite's document library. The app code above the adapter is unchanged.

We're leaning toward Option B so the IT review sees a working feature instead of a stub. Open to either; if IT prefers the migration not have a Supabase-Storage interim hop, we'll go with Option A.

---

## 4. Resolved direction (per Alex, 2026-05-23)

| Question | Direction |
|---|---|
| SharePoint target | `Commissioning` subsite under the existing `BART CBTC Project` site. |
| User base | Both Hitachi staff and BART personnel. Identity pattern (B2B guests vs. dedicated tenant) to follow IT recommendation. |
| Database hosting | **Migrate to Azure Database for PostgreSQL** to keep everything inside the Hitachi tenant and simplify compliance. Supabase remains as the demo tier only. |
| Photos | Build a storage-agnostic MVP now (Option B above), migrate the adapter to Graph when the Azure backend is ready — pending IT preference. |

---

## 5. Still open — for the IT conversation

We're not prescribing the shape; these are the questions where IT's preference drives the design:

- Which Hitachi Azure subscription / landing zone should the resources land in?
- Identity model for BART users — B2B guest invites into the Hitachi tenant, or a separate tenant?
- Preferred hosting pattern (Static Web Apps + Functions, App Service, Container Apps, AKS, etc.)?
- Graph permission scope — comfortable with `Sites.Selected` on just the `Commissioning` subsite, or do you want broader / narrower?
- Network posture — public APIM front door, or private endpoint / VNet integration?
- Secrets rotation cadence and certificate vs. client-secret preference for the SharePoint app registration?
- Compliance scope — which policies and frameworks apply (ISO 27001, SOC 2, NIST 800-171, ITAR, BART-contract-specific)?
- Pen test — internal team, third party, or both, and at what point in the rollout?
