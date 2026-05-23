# IT Ticket — Azure Hosting and Secure Backend Integration for the CX Portal

**Requester:** Alex Khoury — Hitachi Rail STS USA, T&C Manager (BART CBTC)
**Application:** CX Commissioning Portal
**Repository:** `khouryai/cx-portal`
**Date:** 2026-05-23

---

## Introduction

The CX Portal is the day-to-day system the T&C team uses on the BART CBTC project.
It covers test execution, look-ahead planning, the punch-list workflow, field
intake, RMAs, and audit logging across five role types: Admin, Field Engineer,
Punch Manager, Technician, and Client (BART inspector). Today it runs as a
prototype — a static single-page application hosted on GitHub Pages, with all
structured data in a Supabase PostgreSQL project. The current stack has served
us well for build-out, but it was always intended as a demonstration tier.
We're now ready to move the portal onto Hitachi's corporate infrastructure
ahead of broader rollout.

The primary driver is **document storage**. Punch photos (before and after),
daily field logs, CDRL test reports, and look-ahead workbooks need to live in
SharePoint Online, under the **`Commissioning` subsite of the BART CBTC
Project site**, so they inherit the corporate access model, retention rules,
and DLP policies that the team already relies on elsewhere. Both **Hitachi
and BART personnel** will need access to the portal, so we'd like to align
early on the right identity pattern (single Entra tenant with B2B guest
access, a dedicated tenant, or whatever the platform team prefers).

We've designed the portal with a clean separation between what the browser
sees and what stays server-side. The frontend ships no privileged credentials
of any kind — only the public Supabase `anon` API key, which on its own
returns no data because Row-Level Security gates every table. All write paths
require an authenticated JWT, and every change is captured by database
triggers into a tamper-resistant audit log. When we move to Azure, the
intent is to preserve that posture and tighten it further: the new backend
will be the only component that holds the SharePoint / Microsoft Graph
credential, any database service-role keys, and any mail-delivery secrets,
pulled at runtime from Azure Key Vault via Managed Identity. Sensitive
operations — document uploads, permission changes, administrative database
writes — will happen exclusively on the server side, behind the user's
Entra token.

With that in mind, we'd like to open a conversation with the IT team around
three areas:

1. **Azure hosting setup.** We'd appreciate guidance on the right shape
   inside Hitachi's Azure tenant — frontend hosting (Static Web Apps,
   App Service, or whatever is standard), a backend tier for the Graph
   integration, an API gateway in front, Key Vault for secrets, Managed
   Identity wiring, and centralized logging through Azure Monitor /
   Defender for Cloud. We're flexible on the specifics and would rather
   follow the platform team's preferred patterns than propose our own.

2. **Secure backend integration with SharePoint.** A first-party backend
   inside the Hitachi tenant brokering every call into the
   `Commissioning` subsite via Microsoft Graph, with Entra ID handling
   SSO, MFA, and Conditional Access for both Hitachi staff and BART
   guests. We'd lean toward the **least-privilege Graph scope** that
   still gets the job done — `Sites.Selected` on just the
   `Commissioning` subsite is our default preference, but we're open to
   whatever scope IT considers appropriate.

3. **A security review and corporate compliance check.** Before broad
   rollout, we'd like the portal reviewed against Hitachi's data
   protection policies — covering secrets handling, audit log retention,
   Conditional Access posture, and any contract-specific obligations
   tied to BART (ISO 27001, SOC 2, NIST 800-171, ITAR, or others as
   applicable). We're also planning to **migrate the database off
   Supabase and onto Azure Database for PostgreSQL** as part of this
   work — Supabase has been valuable as the demo tier, but if the
   functional equivalent lives natively in Azure we'd prefer to land
   there to simplify the compliance review.

We have a working application end-to-end and are happy to demo any part
of it. The intent of this ticket is to start the conversation and align
on direction — we can flex on hosting shape, identity model, network
posture, and rollout sequencing to match whatever the platform and
security teams need to see. We've put together a short architecture
write-up and a target-state diagram (attached) as background, but
those are starting points rather than a fixed proposal. Whatever
materials, demos, or additional detail would be most useful to the
review, please let us know and we'll get them over quickly.

Thanks very much — looking forward to working with you on this.

---

## Attachments

- `architecture-analysis.md` — high-level summary of the current architecture, the proposed Azure target state, and how sensitive operations are kept server-side.
- `architecture-diagram.mmd` — Mermaid source for the target-state architecture diagram (renders at https://mermaid.live).
