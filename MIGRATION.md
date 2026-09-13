# Migration to the Hitachi Rail Microsoft Azure tenant

**Status: prepared, not started.** Every seam the move needs is built, and the
riskiest unknown has been tested rather than assumed. What remains needs an
Azure subscription, which IT owns.

This document is the hand-off for the IT team executing the move. It says what
exists today, what has already been done to make the move cheap, what is
genuinely unknown, and what the application needs from IT.

---

## 1. Why this is happening

The portal runs on a **personal, free-tier Supabase organisation** and GitHub
Pages. Company policy requires cloud services to be held under a company
contract. That is not something the application can be engineered around.

It is also still a **proof of concept** — a handful of test accounts, no
customer users, nothing in production. Which makes now the cheapest moment this
move will ever have: there is no production data to migrate and no user base to
cut over.

Moving into the Hitachi Azure tenant settles the contracting question, and four
technical gaps with it:

| Concern | Today | On Azure |
|---|---|---|
| **Contracting** | Personal free-tier account | Covered by the corporate Microsoft agreement |
| **Multifactor auth** | Built in-app, TOTP | Entra ID, enforced centrally |
| **Intrusion prevention** | **Impossible** — Supabase exposes none | Front Door WAF |
| **Encryption of Confidential data** | Storage-level only, which does not cover these fields | pgcrypto column encryption + CMK |
| **Public attack surface** | Internet-facing, partially hardened | Private endpoints + WAF |

Plus GitHub Pages stops being a second public cloud to account for.

---

## 2. Current architecture

| Layer | Today | Notes |
|---|---|---|
| Frontend | Static site, no build step; PWA service worker; GitHub Pages | **Verified host-portable** — no hardcoded host, relative PWA scope |
| API | Supabase PostgREST | Client speaks plain PostgREST; supabase-js works against either |
| Auth | Supabase GoTrue, email+password, TOTP MFA | Behind `CXIdentity` (see §4) |
| Authorization | **In the database**: 349 RLS policies, `private.has_module_perm()` | **331 of 349 route through that one function** |
| Database | PostgreSQL 17, ~59 MB, 53 triggers, 27 jsonb + 20 array columns | Region `us-west-2` |
| Storage | 5 buckets, signed URLs | Behind `CXStorage` (see §4) |
| Serverless | A `pg_cron` job | The three Edge Functions were removed — see below |
| Config seam | `config.js` | Backend URL + publishable key |

---

## 3. The load-bearing decision: keep PostgreSQL

Do **not** port to Azure SQL. The authorization model is 349 RLS policies, 53
triggers of scheduling logic, and 46 jsonb/array columns. Arrays alone force a
schema redesign, and RLS-based permissions would have to be reimplemented as API
middleware — which is a rewrite of the security model, not a migration.

**Azure Database for PostgreSQL Flexible Server** takes `pg_dump`/`pg_restore`
verbatim.

---

## 4. What has already been done

All of it is in the repository, all of it is covered by the test suite (45
suites, 0 failures), and none of it required an Azure subscription.

### 4.1 RLS portability — *proven, not assumed*

`supabase/sql/azure_auth_uid_shim.sql` re-implements the GoTrue-supplied `auth`
schema as three small functions over `request.jwt.claims` — the GUC PostgREST
sets from the bearer token, whoever issued it.

`auth.uid()` reads Entra's **`oid`** claim first and falls back to `sub`, so one
database serves both issuers and a **parallel run is possible instead of a hard
cutover**.

`tools/test_rls_portability.js` stands up a real PostgreSQL server, installs the
shim, recreates the permission functions and the policy shapes taken verbatim
from `pg_policies`, and asserts a Supabase token and an Entra token produce
**identical access decisions** — 22 checks, including jsonb/array round-trips and
a privilege-guard trigger firing under an Entra token.

### 4.1.1 Confirmed against a real restore

The test above uses reconstructed policy shapes. On 2026-09-13 the whole thing
was done for real: `pg_dump` from the live Supabase project into PostgreSQL 17
on Azure, with the shim in place.

| | Supabase | After restore |
|---|---|---|
| RLS policies | 349 | **349** |
| Tables | 90 | **90** |
| Functions | 77 | **77** |
| Triggers | 32 | **32** |
| `private.has_module_perm` | present | present |

Exact. Two objects failed, both referencing `auth.users` — GoTrue's user table,
which does not exist under Entra and should not. That is the design working, not
a shortfall.

**Order matters more than the commands do.** `psql` does not stop on error, so
getting it wrong loses objects silently: roles created after the dump cost 325
of the 349 policies, and the auth shim created after the dump cost a further 21
plus one table whose column defaults to `auth.uid()`. Roles and shim both go
first — see `azure/RUNBOOK.md` step 3.

> **The one data step:** re-key `profiles.id` to each user's Entra object id at
> cutover. Do it while the user count is small (currently 6). Every policy then
> resolves unchanged.

### 4.2 Identity seam

`cx-auth-provider.js` (`window.CXIdentity`) is the one file that changes to move
identity, as `config.js` is for the backend. All 10 auth call sites plus the
token plumbing route through it. `tools/test_identity_seam.js` fails the build if
a direct `_sb.auth.*` call returns to the monolith.

**The Entra provider is implemented**, against MSAL Browser (vendored at 5.21.0,
loaded lazily so a Supabase deployment never pays the 275 KB). It uses
`loginRedirect` rather than a popup — the PWA runs standalone on field tablets
where a popup has nowhere to return to — and maps MSAL's result onto the session
shape the app already reads, so no call site above it changes.
`tools/test_entra_provider.js` fakes MSAL and pins that mapping, in particular
that `user.id` is the `oid` claim: get that wrong and all 349 RLS policies
silently deny.

Under MSAL, two workarounds this stack currently needs disappear into
`acquireTokenSilent`: reading the session straight from localStorage, and
refreshing against GoTrue's REST endpoint. Both exist because supabase-js's auth
client can hang here.

### 4.3 Storage seam

`cx-storage.js` (`window.CXStorage`) covers all five buckets. The shapes map
cleanly (bucket→container, signed URL→SAS).

**One real difference:** Supabase mints signed URLs in the browser; a SAS must be
signed with a key that must never reach the browser. So `signMany` calls a small
Function that verifies the caller's Entra token and signs on their behalf —
**the only new server-side component the storage migration needs.**

**Both are written.** `azure/functions/sas/` holds the Function; the `azure`
provider in `cx-storage.js` calls it for reads, writes and deletes. It signs
with a *user delegation* key via managed identity, so the storage account key is
never used and can stay disabled. Its request-validation half is pure logic in
`src/sas-core.js` and is covered by `tools/test_sas_function.js` (48 checks) —
container allow-list, path-escape rejection, no `list` permission, expiry
clamped to an hour. Neither has met a real storage account.

### 4.4 Infrastructure as code

`infra/main.bicep` — every resource, annotated with the security property it
provides. Compiles clean (18 resources, no warnings). **Never deployed.**

`deployWaf` and `cheapMode` allow the same template to stand the stack up on a
throwaway personal subscription for roughly USD 30-60/month instead of the
USD 350+ the WAF alone costs; both are computed so `environment == 'prod'`
cannot opt out. See `infra/README.md` and `infra/main.parameters.personal.json`.

### 4.5 Already done previously

- All third-party libraries self-hosted in `vendor/` at pinned versions, except
  one (§6.1). A stale Google Fonts `@import` was also found and removed.
- Content-Security-Policy in `index.html`, pinned to `config.js` by `test_csp.js`.
- `config.js` as the single backend seam.
- Authentication hardening (`cx-auth-hardening.js` + `supabase_auth_hardening.sql`):
  MFA, password policy/rotation/lockout, `auth_events` audit trail. **Note §7.**

---

## 5. Target architecture

| Concern | Target | Mechanics |
|---|---|---|
| Database | Azure Database for PostgreSQL Flexible Server | `pg_dump` → `pg_restore`; apply the shim |
| API | Self-hosted **PostgREST** on Container Apps | Point it at Entra's JWKS |
| Auth | **Microsoft Entra ID** via MSAL.js | Implement the `entra` provider; re-key `profiles` |
| Photos, vehicle-files | **Azure Blob** + user-delegation SAS | Implement the `azure` storage provider + the SAS Function |
| Forms, drawings | **SharePoint via Graph** | `_formsStorage` was designed for this swap |
| Emails | **Azure Functions + Graph `sendMail`** | Nothing to port — to be built fresh on Azure |
| Hosting | **Azure Static Web Apps** | Files move unchanged |
| WAF | **Front Door Premium** | Must front the **API**, not just the static site |

---

## 6. Known risks

1. **xlsx 0.20.3** is the one remaining external script. SheetJS does not publish
   0.20.x to npm, so it cannot be npm-installed, and downgrading to 0.18.x is not
   acceptable. `tools/vendor_xlsx.js` fetches it, **verifies it against the
   SHA-384 already pinned in `index.html`**, and rewrites the tag, the CSP and
   `sw.js`. It could not be run from the development environment, whose egress
   proxy blocks `cdn.sheetjs.com` — as corporate egress will. Run it from a
   network that can reach the file, or `--from` a copy from an approved artifact
   store.
2. **Token lifetimes vs. field use.** The PWA and its IndexedDB photo queue
   assume long-lived sessions. **Test MSAL silent refresh on yard and tunnel
   devices with intermittent connectivity before cutover.** This is the risk most
   likely to be discovered late and hurt.
3. **Guest access for BART reviewers.** External reviewer accounts exist today.
   Under Entra they become guest (B2B) accounts, which is a tenant policy
   question, not an application one. **Raise it early** — it can be slow.
4. **No anonymous reads.** PostgREST + Entra means no anon key. The app already
   tolerates empty pre-auth loads.
5. **Photo/album ownership keys on `full_name`, not the user id.** Two policies
   compare `uploaded_by`/`created_by` to `profiles.full_name`. That is fragile
   regardless of migration — renaming a person breaks their ownership — and worth
   fixing to a uuid while the data is small.
6. **Bicep is unvalidated against a real subscription.** It compiles; it has
   never met Azure Policy.

---

## 7. What the migration retires

**Already retired.** The three Supabase Edge Functions — daily-log email, RMA
email and SharePoint photo sync — were removed from the application before the
move rather than ported. Two of them existed only in the Supabase dashboard and
were never in version control, so porting them would have meant recovering
source first in order to rewrite it immediately afterwards. The features they
backed are to be rebuilt natively on Azure (Graph `sendMail` for notifications,
Graph for SharePoint) when they are wanted.

> The database may still hold a sync queue and `sharepoint_*` columns on
> `photos` that nothing now reads. They were left in place deliberately — a
> schema change is a separate decision from a code change, and they cost
> nothing until the schema is next revised.

Be aware that a chunk of recent work is deliberately temporary. Under Entra,
**the identity half of `cx-auth-hardening.js` is retired**: the TOTP enrolment
and challenge UI, password policy, rotation clock, lockout, and both GoTrue auth
hooks. Entra does all of it centrally, and better than an application can — that is
the point.

**Surviving and still needed:** the `auth_events` privilege-change logging
(Entra logs sign-ins, not this app's role and template changes), the
access-review view, the CSP, the whole test suite, and the RLS MFA gate — whose
`private.mfa_ok()` changes from reading Supabase's `aal` claim to Entra's `amr`.
The replacement is written and commented in `azure_auth_uid_shim.sql`.

---

## 8. Suggested sequence

> Step-by-step commands for stages 2-7 below are in **`azure/RUNBOOK.md`**.

1. ✅ *(done)* Vendor dependencies; `config.js`; identity and storage seams; the
   `auth.uid()` shim, proven on plain PostgreSQL; Bicep.
2. **IT: provide a dev subscription.** Everything below is blocked on this.
3. Deploy `infra/main.bicep` to dev; `what-if` first, expect landing-zone edits.
4. Stand up Postgres + PostgREST; restore a dump; apply the shim; point a staging
   copy of the frontend at it via `config.js`. **Parallel run** — the dual-claim
   `auth.uid()` makes this possible.
5. ✅ *(done)* `entra` identity provider. Remaining at this step: create the app
   registration, fill `config.js`, and re-key `profiles` to Entra object ids.
6. ✅ *(done)* `azure` storage provider + the SAS Function. Remaining: deploy the
   Function and set `SAS_ENDPOINT`.
7. Static Web Apps hosting; port CI. Rebuild notification emails as Azure
   Functions if and when they are wanted.
8. Front Door + WAF in front of the API. **Closes I.2-6.**
9. Column-level encryption for Confidential fields. **Closes I.3-1.**
10. Re-verify the security posture against the new architecture.

---

## 9. What the application team needs from IT

Ask for these **as part of the migration scope**. Retrofitting developer access
after the environment is locked down is much harder than specifying it now.

- **A dev/staging subscription the application team can deploy to freely.** The
  single most important item. The app is currently developed against its only
  backend, and this separates the two as a side effect.
- **Repository access**, including the ability to open PRs.
- **Approval to run Claude Code on a managed workstation**, if AI-assisted
  development continues. This is a software/AI-tooling policy decision, not a
  GitHub one, and it is the item with the longest lead time — worth raising
  first. Claude Code edits a local checkout and pushes with the developer's own
  credentials; it needs no special GitHub integration to do that.
- *(Optional, lower priority)* the Claude GitHub App installed on the org. This
  buys cloud-hosted sessions and PR-native automation. Useful, not required —
  development continues without it.
- **A named reviewer** on the repo, so a one-line fix does not wait on a stranger.
- **Read access to App Insights / Log Analytics**, so the team can debug without
  filing a ticket.
- **A migration pipeline that runs from the repo**, so schema changes stay
  code-reviewed rather than hand-applied.
- **Decisions owned by IT:** region, landing-zone networking, naming and tagging,
  SKUs, whether CI is GitHub Actions or Azure DevOps, and the Entra app
  registration plus guest-access policy for BART reviewers.

Expect push-to-main to be replaced by PR gates. That is appropriate for a system
holding Confidential customer data, and the repo's test suite already gates every
change.
