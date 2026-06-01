# CX Commissioning Portal — Corporate Hosting & Integration Request

**Requester:** Alex Khoury — Hitachi Rail STS USA, T&C Manager (BART CBTC)
**Application:** CX Commissioning Portal (web today, mobile companion planned)
**Audience:** Hitachi IT — Platform, Security, and Identity teams
**Date:** 2026-06-01
**Status:** Request for review and discussion

---

## 1. Executive Summary

The CX Portal is the day-to-day system the T&C team uses on the BART CBTC
project — test execution, look-ahead planning, punch-list workflow, field
intake, RMAs, document handling, and audit logging across five role types
(Admin, Field Engineer, Punch Manager, Technician, Client/BART Inspector).
It has been running as a prototype on personal infrastructure and is now
ready to move onto Hitachi's corporate Azure environment ahead of broader
rollout. A companion **mobile application** is planned for field crews, and
we'd like to provision the backend in a shape that serves both.

This package requests three things, in one workstream:

1. **Azure hosting and supporting services** inside Hitachi's tenant.
2. **Secure backend integration with SharePoint Online** (the
   `Commissioning` subsite under the existing BART CBTC Project site).
3. **A security review and corporate compliance check** prior to go-live.

We have a working application end-to-end and are happy to demonstrate any
part of it. The shape proposed below is a starting point — we will flex
to the platform team's preferred patterns.

---

## 2. Application overview (current state)

| Layer | Today | Notes |
|---|---|---|
| Frontend | Static single-page app (HTML/CSS/JS) | No build step. |
| Hosting | GitHub Pages (personal repo) | To be retired at cutover. |
| Identity | Supabase Auth (email + password, JWT) | Replace with Entra ID SSO. |
| Database | Supabase PostgreSQL (US-East) | Migrate to Azure DB for PostgreSQL. |
| Document storage | Supabase Storage (forms / test data sheets) | Migrate to SharePoint. |
| Server-side logic | Two Supabase Edge Functions (email) | Move to backend API tier. |
| Audit | Database triggers → tamper-resistant change log | Preserve unchanged. |

**Secrets posture.** The frontend ships **no privileged credentials**.
The only client-side key is Supabase's public `anon` key, which on its
own returns nothing because Row-Level Security gates every table. All
write paths require an authenticated JWT and are audited at the
database layer.

**Document handling (new — built into the application).** A "Forms / Test
Data Sheets" module is in place: fillable PDFs attach to any test case
(unique ID per attachment, multi-attach supported), can be opened and
saved in the browser, and clone automatically per (location, test case)
when an activity template is deployed. Storage is currently Supabase;
the implementation already routes through a single adapter layer
designed to swap to Microsoft Graph against the `Commissioning` subsite
at cutover with no upstream changes.

Two further modules are planned on the same adapter pattern:

- **Book of Plans** — drawings library, organized by location.
- **Documents** — general project documents with user-managed folder
  structure (test reports, procedures, references).

---

## 3. Target Azure architecture

See `02-architecture-diagram.mmd` for the visual. Key components, all
open to platform-team preference:

| Component | Purpose |
|---|---|
| **Microsoft Entra ID** | SSO, MFA, Conditional Access. Hitachi staff in the home tenant; BART users as B2B guests (or whichever pattern IT prefers). |
| **Azure Front Door / CDN** | Public TLS termination, WAF, rate limiting. |
| **Azure Static Web Apps** | Hosts the SPA. |
| **Azure App Service** (or Container Apps) | Hosts the backend API. Owns the Graph client, owns the database service-role credential, owns mail-delivery. Serves both web SPA and the future mobile app. |
| **Azure API Management** | JWT validation, throttling, audit, single `/api/*` surface. |
| **Azure Key Vault** | All secrets. Pulled at runtime via Managed Identity; never logged, never returned to the client. |
| **Azure Database for PostgreSQL — Flexible Server** | Migration target from Supabase. Same schema, same RLS model, inside the Hitachi tenant for compliance. |
| **Azure Blob Storage** | Application-internal binaries that don't belong in SharePoint (e.g., session uploads in flight, lookahead imports). |
| **SharePoint Online — `Commissioning` subsite** | Document libraries for forms, photos, test reports, drawings, project documents. ACLs and retention inherited from existing site configuration. |
| **Azure Monitor + Log Analytics + Defender for Cloud** | Observability and security telemetry. |
| **Azure DevOps — Repos + Pipelines** | Corporate source control (replaces personal GitHub) and CI/CD for both web and mobile. |
| **Azure Notification Hubs** *(when mobile ships)* | Push notifications to iOS/Android. |

### How a request flows after cutover

1. User opens the portal → Entra ID SSO (MFA + Conditional Access) →
   SPA receives an Entra ID/access token.
2. SPA calls `https://portal.<tenant>/api/<endpoint>` with the bearer
   token.
3. API Management validates the JWT, applies rate limits, forwards to
   the backend.
4. Backend re-validates the token, looks up the user's role, then:
   - For **document operations** → Microsoft Graph against the
     `Commissioning` subsite (on-behalf-of or app-only).
   - For **structured data** → PostgreSQL, either with the user's JWT
     (RLS path) or the service-role credential (admin path).
5. All requests stream to Log Analytics. Auth events stream to Entra
   sign-in logs. Data changes stream to the existing application
   change log inside PostgreSQL.

---

## 4. Azure resources requested

A complete shopping list with rough SKU guidance. We will adjust to
whatever the platform team standardises on.

| # | Resource | Suggested SKU | Notes |
|---|---|---|---|
| 1 | Resource Group | — | One per environment (dev / prod). |
| 2 | Static Web App | Standard | Hosts the SPA. |
| 3 | App Service Plan | P1v3 Linux | Right-sized for SPA + light backend; can scale. |
| 4 | App Service (backend API) | Node 20 LTS, Linux | Container Apps acceptable alternative. |
| 5 | API Management | Developer (dev) / Standard v2 (prod) | JWT validation, throttling. |
| 6 | Key Vault | Standard | Secrets + cert; soft-delete + purge protection on. |
| 7 | PostgreSQL Flexible Server | Burstable B2ms (dev) / GP D2s_v3 (prod) | 100 GB to start. |
| 8 | Storage Account | Standard LRS | Blob container for application-internal files. |
| 9 | Log Analytics Workspace | Pay-as-you-go | Central log sink. |
| 10 | Application Insights | Workspace-based | App telemetry. |
| 11 | Front Door (Standard) + WAF policy | Standard | Public edge. |
| 12 | Entra ID App Registration | — | OAuth client for the API + SPA. |
| 13 | Azure DevOps Organization + Project + Repo | — | Source control + CI/CD. |
| 14 | Managed Identity (system-assigned) | — | Backend → Key Vault, Graph, DB. |
| 15 | *(mobile, when ready)* Notification Hubs | Basic | Push to iOS/Android. |

A ready-to-run Azure CLI script that provisions items 1–10 and the
Managed Identity wiring is in `03-azure-provision.sh`. Every command
is annotated; nothing executes secrets in the open.

---

## 5. Security & compliance

- **No privileged credentials in the browser.** SharePoint, Graph,
  database service-role, and mail-delivery secrets live exclusively
  in Key Vault and are accessed by the backend via Managed Identity.
- **SSO + MFA + Conditional Access** through Entra ID — both for
  Hitachi staff and for BART users (B2B pattern, pending IT
  preference).
- **Document ACLs** enforced by SharePoint itself — corporate
  retention and DLP policies apply automatically.
- **Database access** gated by Row-Level Security policies on every
  table.
- **Audit trail** across three independent systems: Entra sign-in
  logs, API Management access logs, and the application's
  `db_change_log` (per-row INSERT/UPDATE/DELETE with actor identity).
- **Least-privilege Graph scope.** Preference is `Sites.Selected`
  scoped to the `Commissioning` subsite only.
- **Secrets rotation** on whatever cadence the platform team
  standardises.
- **Pen test** prior to broad rollout — internal team, third party,
  or both, per IT's preference.

We'd value a formal review against the policies and frameworks that
apply to the BART contract (ISO 27001, SOC 2, NIST 800-171, ITAR if
in scope) so we can address findings before go-live.

---

## 6. Migration & cutover plan

Phased, with no big-bang switch:

| Phase | What happens | Who |
|---|---|---|
| **0. Approval** | This document reviewed, scope agreed. | IT + Alex |
| **1. Provision (dev)** | Run `03-azure-provision.sh` against a dev resource group. | IT (or jointly) |
| **2. Source control move** | Code mirrored from current repo into the new Azure DevOps repo. Existing personal GitHub repo set private, then archived after cutover. | Alex |
| **3. Data + storage migration** | Supabase Postgres dump → Azure PostgreSQL restore. Storage objects (forms PDFs) copied to SharePoint via Graph. | Alex + IT |
| **4. Identity cutover** | Switch frontend auth from Supabase to Entra ID. | Alex |
| **5. Smoke test in dev** | Full role matrix walkthrough. | Alex |
| **6. Promote to prod** | Repeat provision in prod RG, point Front Door at it. | IT |
| **7. Decommission** | Supabase project destroyed, GitHub Pages disabled, all keys rotated. | Alex |

Estimated elapsed time: **2–4 weeks** once Phase 1 is provisioned,
depending on IT bandwidth and review cycles.

---

## 7. Access model

| Group | Access | Identity source |
|---|---|---|
| Hitachi T&C staff (Admin, Field Engineer, Punch Manager, Technician) | Full per role | Entra ID (home tenant) |
| BART personnel (Client / Inspector role) | Read-only to assigned items, sign-off where applicable | Entra ID guest invite (B2B) — IT to confirm preference |
| Platform team | Resource-level RBAC | Entra ID |
| Application admins | Backend admin endpoints behind app-role check | Entra ID app roles |

Roles inside the application are enforced at two layers: UI nav
visibility and database RLS. The database is the authoritative gate.

---

## 8. Future mobile application

A native iOS/Android companion is planned for field crews — primarily
to support test execution and punch-list workflows in places with
limited connectivity. We're requesting that the backend tier (App
Service + APIM + PostgreSQL + Key Vault + SharePoint) be provisioned
**now** rather than added later, because:

- The same API surface serves both clients — no duplicate backend.
- Entra ID handles mobile auth (MSAL) the same way it handles web.
- Adding the mobile-specific pieces later (Notification Hubs, mobile
  build pipelines in Azure DevOps) is a small delta on top of an
  existing footprint.

We are not asking IT to plan the mobile rollout now — only to size
the foundational footprint so the mobile project doesn't require a
second hosting ticket.

---

## 9. Open items for the IT conversation

Items where we want IT's preference before finalising the design:

- Subscription, landing zone, and resource-group naming convention.
- Identity pattern for BART users (B2B guests vs. dedicated tenant).
- Hosting choice — Static Web Apps + Functions, App Service, or
  Container Apps for the backend.
- Network posture — public APIM, or private endpoint / VNet
  integration.
- Graph permission scope confirmation (`Sites.Selected` preferred).
- Secrets rotation cadence and certificate-vs-client-secret
  preference for the SharePoint app registration.
- Compliance frameworks in scope.
- Pen test ownership.

---

## Attachments in this package

| File | What it is |
|---|---|
| `01-it-request.md` | This document. |
| `02-architecture-diagram.mmd` | Mermaid source for the target-state diagram (renders at https://mermaid.live). |
| `03-azure-provision.sh` | Ready-to-run Azure CLI script for items 1–10 above. |
| `04-slide-outline.md` | Outline for a short deck to present the request. |

Older background materials referenced during prep are in
`../sharepoint-integration/` and remain available on request.

Thanks for the review — happy to demo, iterate on shape, or take
this in whatever direction the platform team prefers.
