# cx Portal on Azure: architecture for review

**For:** Hitachi Rail IT and cyber security. **Status:** proposal, not yet
deployed. Every part is built and tested; nothing runs in a Hitachi
subscription yet. **Companion documents:** the step-by-step handover
[`AZURE_HOSTING.md`](AZURE_HOSTING.md), and the background and decision record
[`MIGRATION.md`](../MIGRATION.md).

This document describes what will run, how the pieces trust each other, where
each security control lives, and what is still open. Section 9 lists the
decisions we need from the review.

---

## Contents

1. [Summary](#1-summary)
2. [Context: users, data, scale](#2-context-users-data-scale)
3. [Components](#3-components)
4. [How a request flows](#4-how-a-request-flows)
5. [Security model](#5-security-model)
6. [Threats and mitigations](#6-threats-and-mitigations)
7. [Availability, backup and operations](#7-availability-backup-and-operations)
8. [Design decisions and alternatives](#8-design-decisions-and-alternatives)
9. [Open decisions for IT and cyber](#9-open-decisions-for-it-and-cyber)
10. [Known gaps and roadmap](#10-known-gaps-and-roadmap)
11. [Appendix: resource and endpoint inventory](#11-appendix-resource-and-endpoint-inventory)

---

## 1. Summary

cx Portal is the testing and commissioning portal for the BART CBTC project:
test register, dynamic testing, test reports, punch list, RMA, forms, photos,
drawings, documents and vehicle records.

On Azure it is **a static website, a database behind a stock API gateway, and
a storage account**, with sign-in by Microsoft Entra ID:

- There is **no application server and no custom server code.** The website is
  plain files. The API is the off-the-shelf PostgREST container, configured by
  settings only.
- **Permissions are enforced inside the database**, on every request, by
  PostgreSQL row-level security. Bypassing the website gains nothing.
- **The browser holds no secrets.** It signs in with Microsoft (MFA and
  Conditional Access apply) and sends the user's own token everywhere.
- **No scheduled jobs, no certificates to renew, no servers to patch.** One
  small helper container keeps Microsoft's signing keys current.

Everything except the Entra setup is created by one template,
`infra/main.bicep`.

---

## 2. Context: users, data, scale

| | |
|---|---|
| **Users** | Hitachi Rail project staff and BART staff (as Entra B2B guests). Used on office laptops and on field tablets in yards and tunnels, often with weak signal. |
| **Data** | Project test records, punch items, forms, photos, drawings and documents. Today it holds test data only, nothing confidential; the template tags its resources **Confidential** for when real project data arrives. US jurisdiction: the database and files stay in a US region. |
| **Size today** | Database about 45 MB (59 tables). Files are not carried over: storage starts empty. One real user (the developer) until cutover; designed for the project team, tens of concurrent users. |
| **Integrations** | None. No email, no SharePoint, no outside systems (removed before the move; rebuilt on Microsoft Graph if wanted later). |

---

## 3. Components

```
                       ┌──────────────────────────────┐
                       │      Microsoft Entra ID       │
                       │  app registration, groups,    │
                       │  MFA / Conditional Access,    │
                       │  B2B guests (BART)            │
                       └──────┬───────────────▲───────┘
             1. sign-in (MSAL, │               │ signing keys (public)
                redirect+PKCE) │               │ every 6 h
                               ▼               │
 ┌──────────────────┐  2. page ┌───────────────┴──────────────┐
 │ Browser          │◄─────────┤ Azure Static Web Apps        │
 │ (laptop, tablet) │          │ static files only, no secrets│
 │                  │          └──────────────────────────────┘
 │ holds: Entra     │  3. data + Entra token
 │ tokens only      ├─────────►┌──────────────────────────────┐
 │                  │          │ Container App (gateway)      │
 │                  │          │  PostgREST v12.2.3           │
 │                  │          │  + jwks-refresh helper       │
 │                  │          └──────────────┬───────────────┘
 │                  │                         │ password + TLS,
 │                  │                         │ as role `authenticator`
 │                  │                         ▼
 │                  │          ┌──────────────────────────────┐
 │                  │          │ Azure Database for PostgreSQL│
 │                  │          │ Flexible Server 17           │
 │                  │          │ row-level security decides   │
 │                  │          │ every row, every request     │
 │                  │          └──────────────────────────────┘
 │                  │  4. files: delegation key with the user's
 │                  │     token, then short-lived signed links
 │                  ├─────────►┌──────────────────────────────┐
 └──────────────────┘          │ Storage account (Blob)       │
                               │ 5 private containers         │
                               │ no account key, no anonymous │
                               └──────────────────────────────┘

 Supporting: Log Analytics (gateway logs, 400 days), Key Vault (database
 passwords for IT), user-assigned managed identity (attached, unused today),
 Front Door WAF policy (created, not attached; see 9.2).
```

| Component | Azure service | What it does | What it holds |
|---|---|---|---|
| Website | Static Web Apps (Standard) | Serves the HTML, CSS and JavaScript, and the offline service worker | Code and public settings (API address, tenant and client ids). No secrets. |
| Sign-in | Entra ID | Authenticates people, enforces MFA and Conditional Access, issues tokens | Identities, group memberships |
| API gateway | Container Apps: `postgrest/postgrest:v12.2.3` | Checks each token, then runs the request in the database as the role the token grants | Nothing persistent. Its database connection string is a setting. |
| Key helper | Same Container App: `postgres:17-alpine` running a 15-line script | Downloads Microsoft's public signing keys every 6 hours and gives them to the gateway | Nothing persistent |
| Database | PostgreSQL Flexible Server 17 | All data, and all permission rules (about 230 row-level security policies) | All records, permission templates, audit trails |
| Files | Storage account, containers `photos`, `forms`, `drawings`, `documents`, `vehicle-files` | Stores files; the browser reads and writes them directly with short-lived signed links | All files |
| Logs | Log Analytics | Gateway and helper logs, 400-day retention | Request logs |

**Front-end code structure, for reviewers who read code:** the website is
vanilla JavaScript with no build step; `tools/build.js` copies the files the
browser needs into `dist/` and applies the environment's settings. Three small
modules are the only code that touches the outside world, so each can be
reviewed on its own:

| Module | The only code that… |
|---|---|
| `cx-auth-provider.js` | talks to an identity provider (MSAL for Entra) |
| `cx-db.js` | builds API requests (a small PostgREST client) |
| `cx-storage.js` | reads or writes files (signs Blob links) |

All libraries are pinned copies in the repository (`vendor/`); the page loads
nothing from any third-party host.

---

## 4. How a request flows

### 4.1 Sign-in

1. The browser loads the static site. MSAL (Microsoft's library) redirects to
   Entra using the authorization-code flow with PKCE. There is no client secret
   anywhere; a browser app cannot keep one.
2. Entra applies **Assignment required** (only members of *CX Portal Users* get
   a token at all) and the **Conditional Access** policy (MFA; guests included).
3. The browser receives an access token for the portal's API (audience = the
   app registration, app role `authenticated`) and consents to Azure Storage
   access on the user's behalf. MSAL keeps the tokens in the browser's local
   storage and renews them silently.

### 4.2 A data request

1. The browser calls the gateway, for example `GET /punch_items?status=eq.Open`,
   with `Authorization: Bearer <Entra access token>`.
2. PostgREST verifies the token's signature against Microsoft's keys, its
   audience and its expiry. A request with no token runs as the `anon` role, for
   which every policy returns nothing. A bad token is refused.
3. PostgREST switches to the database role named in the token (`authenticated`)
   and makes the token's claims visible to the database for this request only.
4. Row-level security on each table decides what this person may see or change.
   It identifies the person by the token's Entra object id (`oid`) and checks
   their permissions with `private.has_module_perm(module, action)`: 17
   modules, each with a level (none, read-only, standard, admin) from the
   person's permission template, plus optional per-person overrides
   (`PERMISSIONS_MODEL.md`).
5. Data changes are recorded by a trigger in `db_change_log`: who (resolved
   from the token), what changed (only the changed columns), and when.

### 4.3 A file

1. The browser asks Blob Storage for a **user delegation key**, using the
   person's own Storage token. Azure issues it only if the person has *Storage
   Blob Data Contributor* on the account, which the template grants to the
   *CX Portal Users* group. The key is valid for 2 hours and kept in memory.
2. With that key the browser signs a link for one file and one operation
   (read, write or delete), HTTPS only, valid 10 minutes by default and never
   more than an hour.
3. The browser reads or writes the file directly on Blob Storage with that
   link. Storage CORS admits only the portal's own address.

There is no account key: it is disabled on the storage account, so no
long-lived credential for the files exists.

### 4.4 Adding and removing people

A portal administrator does it in one screen (**Directory → Users → + Invite
User**, which opens **Add Person**); nothing is done separately in Microsoft's
admin pages. The browser calls Microsoft Graph with the administrator's own
delegated token (`cx-entra-admin.js`):

1. **Find** the Microsoft account by email. None, and the address is on one of
   Hitachi's own domains: a typo, refused. None, and it is an outside address
   (BART): the administrator is asked, then Graph **invites** them as a B2B
   guest and Microsoft emails the invitation.
2. **Add** them to *CX Portal Users*. A just-invited guest takes a few seconds
   to reach every directory replica, so the add is retried briefly.
3. **Save** the profile under their Entra object id, so they can sign in at
   once; nothing waits to be linked.
4. If step 3 fails, step 2 is **undone**, so Microsoft and the portal never
   disagree silently.

**Inactive** and **Remove** take the person out of the group (they cannot sign
in, and see no data at once); **Active** puts them back. An administrator
cannot deactivate or remove themselves. Every removal uses Graph's
membership-reference call (`…/members/{id}/$ref`), which can never delete the
account itself.

Microsoft enforces who may do this: membership changes only for **owners of
CX Portal Users**, guest invitations only for people Hitachi's
external-collaboration settings allow (2.2 in the handover). A portal user
without those rights gets "access denied" from Microsoft whatever the page
does.

Profiles carried over from Supabase wait for their owner: an administrator
connects one at once by adding that email again (`public.admin_link_profile()`),
or it is linked on the person's first sign-in by the email in their token
(`public.claim_profile()`). Either way it is re-keyed to the Entra object id
once and audited (`entra_link` in `auth_events`); email never grants anything.

### 4.5 Offline use

A service worker caches the website itself, so it opens without signal, and
files a person has opened are cached on the device for offline viewing. Data
requests still need the network and a valid token. Cached files stay on the
device after sign-out (see 9.9).

---

## 5. Security model

### 5.1 Where each control lives

| Concern | Control | Where |
|---|---|---|
| Who can sign in | Assignment required; *CX Portal Users* group | Entra |
| Who can add or remove people | Portal administrators who are **owners** of *CX Portal Users*, acting with their own delegated Microsoft Graph token; guest invitations as Hitachi's external-collaboration settings allow | Entra (enforced by Microsoft), the Directory screen |
| How strongly | MFA, device and location rules | Entra Conditional Access |
| BART access | B2B guest invitation | Entra, Hitachi's external-collaboration policy |
| What each person may see or change | About 230 row-level security policies, per module and per action | Database, on every request |
| Who may administer permissions | The `admin` and `directory` modules' own permissions, enforced the same way | Database |
| File access | Group role on the storage account; one-file, short-lived links; no account key; no anonymous access | Storage account |
| Database access by people | Entra authentication for the *CX Portal DB Admins* group; password administrator `cxadmin` for the restore | PostgreSQL |
| Database access by the gateway | Login `authenticator` with a password, TLS 1.2+ required; it can only switch to the `anon` and `authenticated` roles, both subject to row-level security (`tools/test_azure_roles.js`) | PostgreSQL |
| Token trust | Signature, audience and expiry checked by the gateway; keys refreshed every 6 hours, and a failed or malformed download cannot replace good keys | Gateway, helper |
| Web page | Content-Security-Policy listing exactly the API, storage and Microsoft sign-in addresses; `nosniff`, framing and referrer headers | `index.html`, `staticwebapp.config.json` |
| Secrets in code or the website | None | n/a |

### 5.2 Secrets inventory

| Secret | Where it lives | Who uses it |
|---|---|---|
| Database administrator password (`cxadmin`) | Key Vault (IT puts it there) | IT, for the restore and administration |
| Gateway database password (`authenticator`) | Key Vault, and a Container Apps secret holding the gateway's connection string (not readable with Reader access) | PostgREST and its helper |
| Static Web Apps deployment token | Pipeline secret | The CI/CD pipeline only |

There is no client secret on the app registration, no storage account key, no
API key, and nothing secret in the website or the repository. Everything in the
website's settings file is public by nature.

### 5.3 Audit trail

| Record | What it holds | Where |
|---|---|---|
| Sign-ins, MFA, Conditional Access results | Every sign-in, including guests | Entra sign-in logs |
| Data changes | Table, record, operation, who, which columns changed, old and new values | `db_change_log` (database trigger; it cannot be bypassed from the API) |
| Permission and account changes | Role, template and activation changes; profile linking | `auth_events` (no insert, update or delete policy: written only by the database) |
| User actions in the app | Created, updated, deleted, status changes | `audit_log` |
| API requests | Gateway request and error logs | Log Analytics (400 days) |

Database and storage diagnostic logs are not sent to Log Analytics by the
template (see 9.5).

### 5.4 Data protection

- **In transit:** HTTPS everywhere; the database requires TLS 1.2 or later;
  storage requires HTTPS and TLS 1.2.
- **At rest:** Azure platform encryption (Microsoft-managed keys) for the
  database, its backups, and storage. Customer-managed keys and column-level
  encryption (`pgcrypto` is installed) are available if required (9.10).
- **Residency:** one US region, chosen by IT; geo-redundant backups (prod) go to
  the paired US region.

---

## 6. Threats and mitigations

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Someone outside the project tries to use the portal | Assignment required: no token without *CX Portal Users* membership; MFA by Conditional Access | Depends on group hygiene; the periodic access review (`access_review_due` view) supports it |
| T2 | A signed-in person calls the API directly to reach data the screens hide | Row-level security decides every row, whatever the client; the screens only mirror it | None identified; `tools/test_rls_portability.js` proves the same decisions under Entra tokens on a real PostgreSQL |
| T3 | Forged or altered token | Signature checked against Microsoft's keys; audience and expiry checked | None identified |
| T4 | Signing keys go stale after Microsoft rotates them | Helper refreshes every 6 hours, retries every 5 minutes on failure, keeps current keys if a download is bad | If the helper stops for weeks, sign-ins fail (not open): visible in its log |
| T5 | Script injection steals a token from the browser | CSP limits where scripts load from and where data can be sent; tokens are short-lived (about an hour) | CSP still allows inline scripts while about 290 inline handlers remain, and tokens sit in browser storage. Reduced step by step by the inline-handler ratchet (10) |
| T6 | A signed file link is forwarded | One file, one operation, HTTPS only, expires in 10 to 60 minutes | Anyone holding the link can use it until it expires (same as today's Supabase links) |
| T7 | A portal user reads files of a module they have no rights to | Files are reached through the app, which only shows what the database allows | **The storage role is group-wide**: a determined portal user could sign a link for any file in the account. Same rule as today. See 9.8 |
| T8 | The gateway's database password leaks | TLS required; the login can only take the `anon` and `authenticated` roles, so it is still subject to row-level security; firewall | Kept as a Container Apps secret, so only people allowed to list the app's secrets can read it. On the public path the database accepts connections from any Azure-hosted address (9.1) |
| T9 | An administrator abuses rights or makes a mistake | Every data change and permission change is logged with the actor; Entra logs admin sign-ins | Database administrators can alter logs; separate their duties from portal administration if required |
| T10 | Data loss or corruption | Point-in-time restore for 35 days; geo-redundant backups and zone-redundant HA in prod; 30-day soft delete for files and containers | Restores need a tested procedure (7.3) |
| T11 | Malicious or tampered dependency | All libraries vendored and pinned in the repository; no CDN; container images pinned by version | Images come from Docker Hub until mirrored (9.4) |
| T12 | Flooding or abusive traffic | Gateway scales 1 to 3 replicas; requests without a valid token get no data | No WAF in front of the gateway unless Front Door is added (9.2) |
| T13 | A shared or lost tablet | Entra session controls; tokens expire | Files opened offline stay on the device after sign-out (9.9) |
| T14 | The wrong person is given access (a mistyped email) | The account is looked up in Microsoft before anything is saved; a Hitachi-domain address with no account is refused as a typo, and an outside address is invited only after the administrator confirms it; the profile is created under that account's object id | An administrator who confirms a guest invitation to the wrong outside address grants that address access; the Users list shows every person and their email |
| T15 | A portal administrator's account is misused to add or remove people | MFA on that account; Microsoft limits it to membership of the one group it owns; every change is in Entra's audit log under the administrator's name | Anyone holding an owner's session can add or remove portal users until the session ends; keep the owner list small and review it with the access review |

---

## 7. Availability, backup and operations

### 7.1 Sizing (prod settings in the template)

| Piece | Setting | Notes |
|---|---|---|
| Website | Static Web Apps Standard | Global content delivery; no capacity to manage |
| Gateway | 0.5 vCPU / 1 GiB, plus 0.25 vCPU / 0.5 GiB for the helper; 1 to 3 replicas | Always at least one replica in prod: no cold start |
| Database | General Purpose `Standard_D2ds_v5`, 32 GB storage with auto-grow, zone-redundant HA | Dev uses Burstable `B2s` without HA. HA roughly doubles the database cost; IT's call |
| Storage | StorageV2, zone-redundant (prod) | |
| Logs | Log Analytics, 400-day retention | |

### 7.2 Availability

The website is served globally by Static Web Apps. The gateway runs at least
one replica. In prod the database runs zone-redundant HA with automatic
failover. During a gateway restart or database failover, requests in flight
fail and succeed when repeated; the website itself is unaffected.

### 7.3 Backup and restore

| What | How | Retention |
|---|---|---|
| Database | Automatic backups, point-in-time restore to any moment | 35 days; geo-redundant in prod |
| Files | Soft delete of files and containers | 30 days |
| Code and configuration | The repository; the template recreates every resource | n/a |

A database restore creates a new server; the gateway's connection string is
then pointed at it (handover step 5). We recommend one restore test before go-
live.

### 7.4 Deployment

The developer builds the website (`node tools/build.js --config
config.hitachi.js`) and hands IT a zip, which IT deploys to Static Web Apps
with three commands; each update is a new zip. A pipeline on every merge to
`main` (GitHub Actions or Azure DevOps; the test suite runs first) is the
backup option. Infrastructure changes go through the template with `what-if` first.
Database schema changes are SQL scripts in `supabase/sql/`, applied by a
database administrator.

### 7.5 Running costs of operation

Nothing needs routine attention: no patching (all managed services), no
scheduled jobs, no certificates (Azure manages TLS), no key rotation (no keys).
Adding or removing people is one screen in the portal, which updates Entra
itself (4.4; handover section 8).

---

## 8. Design decisions and alternatives

| Decision | Chosen | Considered | Why |
|---|---|---|---|
| Database | PostgreSQL Flexible Server | Azure SQL | The whole permission model is PostgreSQL row-level security (about 230 policies, 18 triggers, 42 jsonb and array columns). A `pg_dump` restore carries it unchanged; Azure SQL would mean rewriting it. |
| API | PostgREST container | Custom API (App Service, Functions); Microsoft Data API builder | The app already speaks PostgREST's protocol, and PostgREST runs each request under the database's own row-level security. A custom API is code to write, secure and maintain; Data API builder would need the permission model re-expressed in its configuration. |
| Website hosting | Static Web Apps | App Service; Blob static website | Static files only; Static Web Apps adds managed TLS, custom domains and response headers with no server. |
| File access | Browser signs user-delegation links with the person's own token | A signing function (Azure Functions); proxying files through the API | No server code and no stored key. The cost is that file access is decided per group, not per module (T7, 9.8). |
| Identity | Entra ID workforce tenant with B2B guests | Entra External ID; the app's own passwords | Corporate accounts and BART guests in one place; MFA and Conditional Access managed centrally by IT. The app's own password, MFA and lockout code is retired after cutover. |
| Managing people | From the Directory screen, through Microsoft Graph with the administrator's own delegated token | IT adds people in Entra by hand; a server-side function with application permissions | One step for the administrator and no ticket to IT. Delegated permissions never exceed what the administrator could do in Microsoft's own pages, and Microsoft limits that to the group they own. Application permissions would need a server, a stored secret, and rights over every group and user in the tenant. |
| Linking people to profiles | Entra object id, from the moment a person is added; profiles carried over from Supabase linked once by email | Email as the key | Object ids never change and are never reused; email is used only to find the account, and every link is audited. Administrators never handle Entra ids. |
| Gateway to database | Password login (`authenticator`) | Managed identity / Entra token | PostgREST cannot present an Entra token to PostgreSQL. The login is limited to switching into the two request roles. |
| Scheduled work | None | pg_cron jobs | Both former jobs were removed; nothing in the design needs a schedule. |

---

## 9. Open decisions for IT and cyber

Each item has a recommendation; none blocks a first deployment except where
noted.

**9.1 Network path for the database.** *Public path:* the database has a public
endpoint whose firewall admits only Azure-hosted addresses (the "allow Azure
services" rule; note this means any Azure address, including other customers'),
and every connection needs the password and TLS. *Private path:* VNet-integrated
Container Apps and a private endpoint for the database, which the template does
not build (a landing-zone decision). **Recommendation:** private path for
production if the landing zone provides the network; public path is acceptable
for a pilot.

**9.2 Web application firewall.** The template creates a Front Door WAF policy
(always in prod) but not the Front Door profile that would use it, so it
filters nothing today. Adding Front Door Premium in front of the gateway costs
about USD 330 per month. **Recommendation:** cyber's call; for this audience
(signed-in staff and guests only) Entra plus row-level security carry the main
risk.

**9.3 Where the gateway's database password lives.** *Done:* the template
keeps the gateway's connection string in a Container Apps secret, so Reader
access no longer shows it. **Option:** a Key Vault reference read with the
managed identity the template already attaches, if cyber wants the secret to
live only in Key Vault.

**9.4 Container images.** Both images come from Docker Hub, pinned by version.
**Recommendation (before go-live):** mirror them into an Azure Container
Registry and pull with the managed identity.

**9.5 Central logs for the database and storage.** **Recommendation:** add
diagnostic settings sending PostgreSQL logs and Blob read/write/delete logs to
the Log Analytics workspace, if cyber wants file and database access auditable
centrally.

**9.6 BART guest policy.** Whether BART staff can be B2B guests is a tenant
policy decision, and so is whether portal administrators may invite them from
the portal (the Guest Inviter role, or the external-collaboration settings).
**Recommendation:** raise early; it has the longest lead time. Without invite
rights, IT invites guests and the administrator then adds them in the portal.

**9.7 Conditional Access details.** MFA is assumed. Device compliance for field
tablets, sign-in frequency and location rules are IT's choice; test silent token
renewal on tablets with poor signal before cutover.

**9.8 File access granularity.** Today any portal user may obtain a link to any
file (T7), matching the current Supabase rule. **Options:** accept it; or split
access per container (for example, a separate group for `vehicle-files`) using
role assignments per container, which needs no code change. **Recommendation:**
accept for go-live, revisit if a container ever holds more sensitive material.

**9.9 Offline files on shared tablets.** Files opened offline stay on the
device after sign-out. **Options:** keep (field crews rely on it), or clear the
offline cache on sign-out (a small app change). **Recommendation:** clear on
sign-out if tablets are shared between people.

**9.10 Encryption keys.** Microsoft-managed keys by default. Customer-managed
keys for the database and storage, or column encryption for specific fields,
are available. **Recommendation:** only if Hitachi's data classification
requires it.

**9.11 The anonymous role.** As on Supabase, the `anon` role has table
privileges and row-level security returns it nothing. **Option:** remove its
privileges entirely on Azure as defence in depth (the sign-in screen's
connectivity check needs a small change). **Recommendation:** do it after
cutover.

**9.12 Retention of audit tables.** `db_change_log`, `auth_events` and
`audit_log` are kept indefinitely (about 21 MB today). **Recommendation:** set a
retention period if policy requires one; it is applied by a manual delete.

**9.13 Environments.** The template supports `dev`, `test` and `prod`.
**Recommendation:** a `dev` environment for changes before they reach `prod`
(today the portal is developed against its only environment).

**9.14 Owners of CX Portal Users.** The people who may add and remove portal
users are the group's owners in Entra. **Recommendation:** the portal's
administrators only (two or three people), with MFA, reviewed in the six-monthly
access review (`access_review_due`).

---

## 10. Known gaps and roadmap

| Item | Status |
|---|---|
| Strict Content-Security-Policy (no inline scripts) | In progress: about 290 inline handlers remain; a build check prevents new ones and the count only goes down. `'unsafe-eval'` remains while Alpine.js is used. |
| First token from the real tenant | The chain is rehearsed with Entra-shaped tokens and keys; the first real sign-in is the first check after deployment |
| In-app password, MFA and lockout code (Supabase era) | Retired after cutover; Entra does these |
| Penetration test | Recommended before broad roll-out |

---

## 11. Appendix: resource and endpoint inventory

### 11.1 Resources created by `infra/main.bicep`

| Resource | Name pattern | Notes |
|---|---|---|
| Static Web App | `stapp-cxportal-<env>` | Standard tier |
| Container Apps environment | `cae-cxportal-<env>` | Logs to Log Analytics |
| Container App (gateway + helper) | `ca-postgrest-<env>` | External HTTPS ingress, port 3000 inside |
| PostgreSQL Flexible Server | `psql-cxportal-<env>` | v17, TLS 1.2+, Entra admin group, 35-day backups |
| Storage account | `stcxportal<env><hash>` | No shared key, no public blobs, 5 containers, CORS for the site only, 30-day soft delete |
| Key Vault | `kvcxportal<env><hash>` | RBAC, soft delete, purge protection in prod |
| Log Analytics workspace | `log-cxportal-<env>` | 400-day retention |
| Managed identity | `id-cxportal-<env>` | Attached to the gateway, unused today (9.3, 9.4) |
| Role assignment | | *Storage Blob Data Contributor* for *CX Portal Users* on the storage account |
| Front Door WAF policy | `wafcxportal<env>` | Prevention mode in prod; not attached (9.2) |

Not created by the template: Entra app registration, groups and Conditional
Access (handover section 2); networking (9.1); Front Door profile (9.2).

### 11.2 Endpoints

| Endpoint | Reachable from | Authentication |
|---|---|---|
| `https://<site>.azurestaticapps.net` (or a custom domain) | Internet | None needed: public static files |
| `https://ca-postgrest-<env>.<region>.azurecontainerapps.io` | Internet | Entra access token; without one, no data |
| `https://<account>.blob.core.windows.net` | Internet (unless storage public access is off) | Entra token for the delegation key; signed links for files |
| `<server>.postgres.database.azure.com:5432` | Azure-hosted addresses (public path) or the VNet (private path) | Password or Entra, TLS required |
| `https://login.microsoftonline.com` | Internet | Microsoft |

### 11.3 Outbound connections

| From | To | Why |
|---|---|---|
| Browser | Static site, gateway, Blob, Entra; Microsoft Graph for administrators managing people | The only places the CSP allows (`graph.microsoft.com` for data only) |
| Key helper | `login.microsoftonline.com/<tenant>/discovery/v2.0/keys` | Microsoft's public signing keys |
| Gateway | Database | Queries |

Nothing else calls out.
