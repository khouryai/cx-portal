# CX Portal — IT Request Deck Outline

A short presentation deck to walk Hitachi IT and management through the
hosting request. Designed for 12–15 minutes plus Q&A. Each slide is a
title + 3–5 bullets — no walls of text.

---

### Slide 1 — Title
- **CX Commissioning Portal**
- Moving from prototype to corporate Azure
- Alex Khoury · T&C Manager · BART CBTC · 2026-06-01

### Slide 2 — What the portal is
- Day-to-day system for the BART CBTC T&C team
- Test execution, look-ahead, punch lists, RMAs, audit, document handling
- 5 role types: Admin, Field Engineer, Punch Manager, Technician, Client (BART)
- Working end-to-end today on prototype hosting — ready for production tier

### Slide 3 — Why now
- Approaching broader rollout to field crews and BART inspectors
- Need SharePoint as the document system of record (forms, photos, drawings, reports)
- Mobile companion app planned — needs a real backend tier
- Personal-tier hosting (GitHub Pages, Supabase) is not a corporate-fit story

### Slide 4 — What we're asking for, in three parts
1. Azure hosting + supporting services in Hitachi's tenant
2. Secure backend integration with SharePoint (`Commissioning` subsite)
3. Security review + compliance check against corporate data policies

### Slide 5 — Architecture today (current state)
- Static SPA on GitHub Pages
- Supabase Postgres (US-East) with RLS on every table
- Two Supabase Edge Functions for transactional email
- No privileged credentials in the browser — anon key only, RLS-gated
- **Insert simplified "before" diagram**

### Slide 6 — Architecture proposed (target state)
- Entra ID SSO + MFA (Hitachi staff + BART B2B guests)
- Static Web App (SPA) + App Service (backend API)
- API Management as the single `/api/*` surface
- Azure DB for PostgreSQL — schema and RLS migrated unchanged
- Key Vault + Managed Identity — every secret lives there
- SharePoint via Microsoft Graph (least privilege: `Sites.Selected`)
- **Insert `02-architecture-diagram.mmd` rendered**

### Slide 7 — Security posture
- No SharePoint / Graph / DB-admin / mail secrets ever in the browser
- SSO + MFA + Conditional Access through Entra
- Document ACLs enforced by SharePoint — corporate DLP and retention apply
- Database RLS + tamper-resistant change log preserved
- Audit trail across 3 systems: Entra sign-in, APIM access, app change log

### Slide 8 — Why provision the mobile-ready footprint now
- Same backend serves web and mobile — no duplicate hosting later
- Entra handles mobile auth (MSAL) identically
- Avoids a second hosting ticket in 6 months
- Mobile-specific pieces (Notification Hubs, mobile pipelines) are a small delta

### Slide 9 — Resources we're requesting (high level)
- Hosting: Static Web App, App Service, API Management, Front Door
- Data: Azure DB for PostgreSQL, Blob Storage, SharePoint libraries
- Identity & secrets: Entra app registration, Managed Identity, Key Vault
- Ops: Log Analytics, Application Insights, Defender for Cloud
- Source control: **Azure DevOps Repos + Pipelines** (replaces personal GitHub)
- *Future:* Notification Hubs (mobile push)
- Full SKU table + `az` script attached

### Slide 10 — Migration & cutover plan
- Phase 1: Provision dev environment
- Phase 2: Move source control to Azure DevOps
- Phase 3: Migrate Postgres data + SharePoint document copy
- Phase 4: Cut auth over to Entra
- Phase 5: Smoke test → promote to prod → decommission Supabase + GitHub Pages
- Target: 2–4 weeks once dev is provisioned

### Slide 11 — Compliance & review
- Welcome a formal review against ISO 27001 / SOC 2 / NIST 800-171 / ITAR as applicable
- Welcome a pen test (internal or third party) before broad rollout
- Secrets rotation cadence to follow corporate standard
- All logs flow to Log Analytics for retention per policy

### Slide 12 — What I need from IT
- Subscription, landing zone, and naming standard
- Identity pattern for BART users (B2B vs. dedicated tenant)
- Hosting choice confirmation (Static Web App + App Service is our default)
- Network posture (public APIM front door, or private endpoint / VNet)
- Owner for the Entra app registrations and admin consent
- Compliance scope and pen-test ownership

### Slide 13 — Timeline ask
- Kick-off meeting this week
- Dev provisioned within 2 weeks of approval
- Production cutover 2–4 weeks after that
- Mobile app project planned for Q3 (foundational footprint already in place)

### Slide 14 — Q&A / Appendix
- Detailed request doc (`01-it-request.md`)
- Architecture diagram (`02-architecture-diagram.mmd`)
- Azure CLI provisioning script (`03-azure-provision.sh`)
- This deck (`04-slide-outline.md`)
- Live demo of the portal available on request

---

**Tone notes for delivery**

- This is a request and a conversation starter — not a fait accompli.
- Default to "we'll match your standard pattern" on every infrastructure choice.
- Highlight where the application already enforces good practice (RLS, audit
  log, no secrets in browser) so IT sees a mature partner, not a clean-up job.
- Be explicit that production cutover is gated on the security review.
