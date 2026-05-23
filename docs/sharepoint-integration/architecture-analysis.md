# CX Portal — Architecture Analysis for SharePoint / Azure Integration

> Internal prep document for the IT integration ticket. Captures the *current* architecture,
> the API/data flow, the secrets posture, and the proposed *target* architecture once the
> Hitachi Azure tenant is in the loop.

---

## 1. Current architecture (as built)

| Layer | Implementation | Notes |
|---|---|---|
| Frontend | Static HTML/CSS/JS (`index.html`, `app.js`, `styles.css`, `data.js`) | Single-page app, no build step. Served from GitHub Pages. |
| Hosting | GitHub Pages, deployed via `.github/workflows/deploy.yml` on push to `main` | HTTPS enforced by GitHub. |
| Auth | Supabase Auth — email + password, JWT in `localStorage` | `supabase-js` is loaded but the app reads the JWT directly out of `localStorage` and calls PostgREST via native `fetch` because the JS client was hanging after tab switches (`app.js:37-61`). |
| Data API | Direct browser → Supabase PostgREST (`https://<project>.supabase.co/rest/v1/...`) | Helpers `_dbInsert` / `_dbUpdate` / `_dbSelect` / `_dbDelete` in `app.js:63-198`. |
| Server-side logic | Two Supabase Edge Functions: `send-daily-log-email`, `send-rma-email` | Called from `app.js:5873` and `app.js:14620`. |
| Database | Supabase Postgres (project `uqtwiucxktljhukmgmxg`, US-East) | ~45 tables. Schema in `supabase_schema.sql`. |
| Authorization | Row-Level Security policies on every table; DB-level audit triggers writing to `db_change_log` (`supabase_schema.sql:313-373`) | UI role checks are advisory; RLS is the actual gate. |
| Document storage today | None for binaries — punch photos / xlsx / reports live as references only. `punch_photos` has a `storage_path` column but no upload code path is wired up in `app.js` yet. | This is exactly the gap SharePoint is meant to fill. |

### What the frontend actually holds

Searched `app.js`, `index.html`, and `sync_testplan.js` for credentials:

- **Supabase project URL** — `https://uqtwiucxktljhukmgmxg.supabase.co` (public).
- **Supabase `anon` JWT** — `app.js:13`, `sync_testplan.js:18`. This is the public API key by design; it grants zero data access on its own because RLS blocks every table for anonymous callers.
- **No service-role key, no SMTP creds, no SharePoint creds, no Graph secrets** anywhere in the client bundle. ✅
- **No PINs / passwords in code or DB** — the legacy PIN column exists in `users` but the live auth flow is `_sb.auth.signInWithPassword(...)` (`app.js:2413-2425`).

### How an API call flows today

1. User signs in → `supabase-js` POSTs to `/auth/v1/token` → returns a JWT.
2. JWT is persisted under `localStorage["sb-<ref>-auth-token"]`.
3. Every data call goes browser → `https://<project>.supabase.co/rest/v1/<table>` with `apikey: <anon>` + `Authorization: Bearer <user JWT>`.
4. PostgREST validates the JWT, runs the query inside a Postgres session whose `request.jwt.claims` reflect the user, and RLS policies decide which rows are visible / writable.
5. DB triggers (`audit_db_change`) capture INSERT/UPDATE/DELETE into `db_change_log` with the actor's email + role pulled from the JWT claims.
6. Two side-effects (RMA email, daily-log email) are POSTed to Supabase Edge Functions, which run server-side and hold the SMTP/Resend secrets out of the browser.

**Net:** there is **no application backend of our own today**. The "backend" is Supabase: Postgres + RLS + two Edge Functions. This works for a prototype but does not satisfy a corporate SharePoint/Graph integration, where the OAuth client secret and certificate **must** sit on a server we control.

---

## 2. Target architecture (post-integration)

The integration adds a thin first-party backend inside Hitachi's Azure tenant. The frontend stops talking directly to anything that requires a privileged credential; SharePoint access happens only through that backend.

See `architecture-diagram.mmd` for the picture. Key components:

| Component | Purpose | Where secrets live |
|---|---|---|
| **Microsoft Entra ID (Azure AD)** | Single sign-on + MFA + Conditional Access. Replaces (or fronts) Supabase Auth. | Tenant-managed. |
| **Azure Front Door / CDN** | Public TLS endpoint, WAF, rate limiting. | n/a |
| **Static SPA** (existing `index.html` / `app.js`) | Hosted on Azure Static Web Apps or App Service. **Still holds no secrets** — only the public Entra app/client ID and the API base URL. | n/a |
| **Azure API Management** | JWT validation, throttling, audit, surfaces a single `/api/*` to the SPA. | n/a |
| **Backend API** (Node/TypeScript on App Service or Container Apps) | Owns the Microsoft Graph client. Exchanges the user's Entra token (on-behalf-of) or uses an app-only credential to read/write SharePoint document libraries. Owns the Supabase service-role key for any operation that must bypass RLS. | All secrets pulled from **Azure Key Vault** via Managed Identity. Never logged, never returned. |
| **Azure Key Vault** | Stores: SharePoint/Graph app secret or certificate, Supabase service-role key, SMTP/Resend keys, signing keys. | The only place credentials exist outside Entra. |
| **SharePoint Online** | Document libraries for punch photos (before/after), daily log PDFs, test reports (CDRL), and lookahead xlsx files. Permissions inherited from existing site/library ACLs. | Tenant-managed. |
| **Supabase Postgres** | Stays as the structured-data store (test items, results, punch items, audit log). RLS remains in place. Frontend keeps using the `anon` key + user JWT for reads/writes that are already safe under RLS. | Service-role key moves to Key Vault and is used only by the backend. |
| **Azure Monitor / Log Analytics / Sentinel** | Central observability and security telemetry. | n/a |

### How an API call will flow after integration

1. User hits the portal → Entra ID SSO (with MFA + Conditional Access) → SPA receives an ID + access token.
2. SPA calls `https://portal.hitachi-rail-us.example/api/<endpoint>` with `Authorization: Bearer <Entra access token>`.
3. API Management validates the JWT, applies rate limits, forwards to the backend.
4. Backend re-validates the token, looks up the user's role/subsystem, then either:
   - For **document operations**: uses Microsoft Graph (on-behalf-of or app-only) to read/write the corresponding SharePoint document library. The Graph secret never leaves the backend.
   - For **structured data**: forwards the call to Supabase using either (a) the user's JWT (RLS path, unchanged) or (b) the service-role key from Key Vault for admin operations.
5. All requests, responses, and errors stream to Log Analytics. Auth events stream to Entra sign-in logs.

### What this buys us, security-wise

- No SharePoint / Graph / SMTP / service-role credentials ever ship to a browser.
- SSO + MFA + Conditional Access become available "for free" via Entra.
- Document ACLs are enforced by SharePoint itself, so corporate retention and DLP policies apply automatically.
- Every call has a clear audit trail across three independent systems: Entra sign-in logs, APIM access logs, and Supabase `db_change_log`.

---

## 3. Open questions for the IT meeting

These are the points I want answered before the ticket gets sized:

1. **Tenant + subscription.** Which Hitachi Azure subscription should the resources land in? Is there an existing landing zone / management group we have to deploy under?
2. **SSO model.** Do we onboard the portal as an Enterprise Application in the existing Entra tenant, or stand up a B2B/B2C tenant for BART client users? (We have an existing `client` role for the BART inspector.)
3. **SharePoint site.** Is there already a BART CBTC / T&C SharePoint site whose libraries we should target, or do we create new ones? What's the naming/retention policy?
4. **Graph permissions.** Are we approved for **delegated** (`Files.ReadWrite`, `Sites.ReadWrite.All` scoped) or **app-only** (`Sites.Selected`) permissions? `Sites.Selected` is preferred — least privilege, scoped per site.
5. **Hosting choice.** App Service vs. Container Apps vs. Static Web Apps + Functions — any standard the platform team wants us to follow?
6. **Data residency.** Supabase is US-East. Confirm that's acceptable for the structured data, or whether we need to migrate to Azure Database for PostgreSQL (Flexible Server, US region).
7. **Network policy.** Does the backend need to sit behind a private endpoint / VNet, or is the public APIM front door acceptable?
8. **Secrets rotation cadence.** Standard cadence for Key Vault-stored secrets / certificates?
9. **Compliance scope.** Which policies does this fall under — ISO 27001, SOC 2, NIST 800-171, ITAR? Anything specific to BART contract obligations?
10. **Pen-test requirement.** Internal or third-party pen test before go-live?
