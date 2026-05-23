# IT Ticket — Azure Hosting + Secure Backend for CX Portal SharePoint Integration

**Requester:** Alex Khoury — Hitachi Rail STS USA, T&C Manager (BART CBTC)
**Application:** CX Commissioning Portal (a.k.a. HITACHI Rail T&C Portal)
**Repository:** `khouryai/cx-portal`
**Current hosting:** GitHub Pages (static SPA) + Supabase (Postgres, Auth, Edge Functions)
**Target hosting:** Hitachi Azure tenant
**Date:** 2026-05-23

---

## Introduction

The CX Portal is the T&C team's day-to-day system for the BART CBTC project — it covers
test execution, look-ahead planning, punch-list workflow, field intake, RMAs, and
audit logging for five role types (Admin, Field Engineer, Punch Manager, Technician,
Client). It is currently a static single-page application running on GitHub Pages,
backed by Supabase (PostgreSQL with Row-Level Security on every table, plus two
Edge Functions for transactional email). The frontend ships **no privileged
credentials** — only Supabase's public `anon` key, which is gated by RLS and
returns nothing to an unauthenticated caller. All write paths are JWT-authenticated
and audited at the database layer via triggers into `db_change_log`.

We are now ready to move the portal off prototype hosting and integrate it with
Hitachi's corporate infrastructure. The driver is **document storage**: punch
photos (before/after), daily logs, CDRL test reports, and look-ahead xlsx files
need to live in **SharePoint Online**, governed by existing corporate ACLs,
retention, and DLP policies, rather than in ad-hoc storage. To do that securely,
we need a first-party backend inside Hitachi's Azure tenant that owns the
Microsoft Graph credential — the SharePoint client secret / certificate must
never touch the browser.

I'm opening this ticket to request, in one package:

1. **Azure cloud hosting setup** in the appropriate Hitachi subscription —
   Static Web App (or App Service) for the SPA, App Service or Container Apps
   for the API, Azure API Management in front, Azure Key Vault for secrets,
   Managed Identity wiring, and Log Analytics / Defender for Cloud for
   observability and threat detection.
2. **Secure backend integration** between the portal and SharePoint via
   Microsoft Graph, fronted by Microsoft Entra ID SSO (with MFA and Conditional
   Access). The backend is the **only** component that holds the Graph
   credential, the Supabase service-role key, and any SMTP credentials —
   pulled at runtime from Key Vault via Managed Identity, never logged, never
   returned to the client. Sensitive operations (document upload, ACL changes,
   admin DB writes) happen exclusively server-side and are validated against
   the user's Entra token before reaching SharePoint or the database.
3. **A security review and corporate compliance check** against Hitachi's data
   protection policies prior to go-live — covering secrets handling, data
   residency (today's Supabase project is US-East; confirm acceptable or plan
   migration to Azure Database for PostgreSQL), least-privilege Graph scopes
   (preference: `Sites.Selected` on a specific BART CBTC site), Conditional
   Access posture, audit log retention, and any ISO 27001 / SOC 2 / NIST 800-171
   obligations that apply to the BART contract. A pen test before broad rollout
   would also be appreciated.

A full architecture analysis (current state, target state, secret-handling
posture, and the open questions I have for the platform team) is attached as
`architecture-analysis.md`, and a visual diagram of the target architecture
is attached as `architecture-diagram.mmd` (renders at https://mermaid.live).

I'm happy to walk through any of this on a call — I'd especially like to align
early on the SharePoint site target, the Graph permission model, and the
hosting/network shape before we start provisioning. Thanks for the help.

---

## Attachments

- `architecture-analysis.md` — current vs. target architecture, API flow, secrets posture, open questions.
- `architecture-diagram.mmd` — Mermaid source for the target architecture diagram.
