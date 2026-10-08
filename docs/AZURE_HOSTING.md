# cx Portal on Azure — handover to Hitachi IT

This is the complete procedure for hosting cx Portal in the Hitachi Rail Azure
tenant. **Every step in it is done by IT.** The developer's own part (preparing
the database backup and the website package) is in a separate checklist; this
document says exactly when you will receive each item from them.

**What cx Portal is:** a folder of static web files plus a small PostgreSQL
database. No application server, no custom server code, no scheduled jobs, no
third-party scripts.

For the architecture and security review (components, data flows, threat model,
open decisions), see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Contents

0. [How it fits together](#0-how-it-fits-together)
1. [The order of work, and what the developer sends you](#1-the-order-of-work-and-what-the-developer-sends-you)
2. [Entra ID: groups and the app registration](#2-entra-id-groups-and-the-app-registration)
3. [Azure resources](#3-azure-resources)
4. [The database](#4-the-database)
5. [Connect the gateway to the database](#5-connect-the-gateway-to-the-database)
6. [The website](#6-the-website)
7. [Check it works](#7-check-it-works)
8. [Running it](#8-running-it)
9. [Security summary](#9-security-summary)
10. [Troubleshooting](#10-troubleshooting)

---

## 0. How it fits together

```
 Browser (staff laptops, field tablets, BART guests)
   │
   ├─ 1. Sign in ───────────────────────► Microsoft Entra ID (MFA, guests)
   │     (administrators: add/remove people ► Microsoft Graph, CX Portal Users)
   │
   ├─ 2. Web page (static files) ───────► Azure Static Web Apps
   │
   ├─ 3. Data, with the Entra token ────► Database gateway (PostgREST, Container Apps)
   │                                        │  + jwks-refresh helper (keeps
   │                                        │    Microsoft's signing keys current)
   │                                        ▼
   │                                      Azure Database for PostgreSQL
   │                                      (permissions enforced here, per row)
   │
   └─ 4. Files, via short-lived links ──► Azure Blob Storage (5 private containers)
```

| Piece | Azure service | Notes |
|---|---|---|
| Website | Static Web Apps | 79 files, about 6 MB |
| Database | Azure Database for PostgreSQL – Flexible Server, v17 | About 45 MB. All permission rules live in it. |
| Database gateway | Container Apps: `postgrest/postgrest:v12.2.3` plus a `postgres:17-alpine` helper | Off-the-shelf images; configured by settings only |
| Files | Storage account, 5 private containers | Start empty: no files are carried over |
| Sign-in | Microsoft Entra ID | App registration, two groups, Conditional Access |
| Supporting | Managed identity, Key Vault, Log Analytics | Created by the template |

Everything except Entra is created by one template, `infra/main.bicep`.

---

## 1. The order of work, and what the developer sends you

| When | IT does | Exchange with the developer |
|---|---|---|
| Start | — | **You receive:** the repository (Git access or a zip). It holds the template (`infra/`), the database scripts (`supabase/sql/`) and this document. |
| 1 | Section 2 (Entra) and section 3 (Azure resources) | **You send the developer** the six values in 3.5. |
| 2 | — | **You receive** two files: `cxportal.sql` (the database backup) and `cx-portal-site.zip` (the website, already set up with your values). Usually within a day. |
| 3 | Sections 4 to 7 | — |
| 4 | — | **Tell the developer** the site is live; they sign in first as the portal's first administrator and add everyone else from the portal. |

The database holds test data only today, nothing confidential. Transfer the
backup through Hitachi's usual file sharing all the same, and delete copies once
the restore is checked.

---

## 2. Entra ID: groups and the app registration

### 2.1 Two security groups

| Group | Members | Owners | Used for |
|---|---|---|---|
| **CX Portal Users** | Everyone who uses the portal, BART guests included. **The portal fills it**: you add only the developer, as the first administrator. | **The portal administrators** (the developer to begin with) | Sign-in to the app, and access to files |
| **CX Portal DB Admins** | IT staff who administer the database | IT | Entra administrator on PostgreSQL |

Record both **object IDs**.

**Why the portal administrators own CX Portal Users.** Administrators add and
remove people in the portal (Directory), and the portal puts them in or takes
them out of this group in Microsoft, with the administrator's own Microsoft
sign-in. Microsoft allows that only to the group's owners (or to directory
roles such as Groups Administrator, which are far broader). Ownership of this
one group is the least privilege that works: an owner can change this group's
membership and nothing else. The group must be an ordinary security group with
assigned membership (not dynamic, not role-assignable).

### 2.2 BART guest users

A portal administrator adds a BART user in the portal like anyone else; when
the address has no account in Hitachi's directory, the portal asks the
administrator, then invites them as a B2B guest (Microsoft emails the
invitation) and adds them to **CX Portal Users**.

For that to work, Hitachi's external-collaboration settings must let the portal
administrators invite guests: either members may invite, or give the portal
administrators the **Guest Inviter** role (Entra ID → Roles and administrators).
Guest access is governed by Hitachi's policy; that decision belongs to IT and
cyber, not the app. If guests are not allowed to be invited this way, IT
invites them (Entra ID → Users → Invite external user) and the administrator
then adds them in the portal by the same address.

### 2.3 App registration

Entra ID → App registrations → **New registration**:

| Setting | Value |
|---|---|
| Name | `cx Portal` |
| Supported account types | **Accounts in this organizational directory only** (single tenant). Guests are covered because they are in this directory. |
| Redirect URI | Platform **Single-page application (SPA)**. Leave the address blank for now; it is filled in step 3.4. |

Then, on the registration:

1. **Expose an API**
   - Application ID URI: accept the default `api://<application id>`.
   - Add a scope: name `access_as_user`, who can consent **Admins and users**,
     display name "Access cx Portal".
2. **Manifest** — set `"requestedAccessTokenVersion": 2` (in the `api` section).
   The gateway expects the token's audience to be the bare application id, which
   is what version-2 tokens carry.
3. **App roles** → Create app role:
   - Display name `Portal user`, allowed member types **Users/Groups**,
     value **`authenticated`** (exactly this word; the database switches to the
     role of that name), enabled.
4. **API permissions** → Add a permission:
   - **My APIs** → cx Portal → `access_as_user` (delegated).
   - **Azure Storage** → `user_impersonation` (delegated). This lets the
     browser create short-lived file links on the signed-in person's behalf.
   - **Microsoft Graph**, delegated: `User.Read` (present by default; keep it),
     `User.ReadBasic.All`, `GroupMember.ReadWrite.All` and `User.Invite.All`.
     These let the Directory screen find a person's account, invite a guest, and
     add or remove them in **CX Portal Users**. Being delegated, they never let
     anyone do more than they could already do in Microsoft's own admin pages:
     a portal user who does not own the group gets "access denied" from
     Microsoft. `User.Invite.All` is needed only if administrators may invite
     guests from the portal (2.2); without it everything else still works.
   - **Grant admin consent** for the tenant.
5. **Token configuration** → Add optional claim → token type **Access** →
   `email`. On first sign-in the portal matches this address to a profile
   carried over from the old system (4.5). Version-2 tokens also carry
   `preferred_username`, which is used too.
6. **Authentication** — no client secret, no certificate. A browser app must
   not hold one.

Then Entra ID → **Enterprise applications** → cx Portal:

7. **Properties** → **Assignment required: Yes**. Only assigned people can get
   a token at all.
8. **Users and groups** → Add assignment → group **CX Portal Users**, role
   **Portal user**. (Assigning a *group* to an app role needs Entra ID P1.)

Finally, **Conditional Access**: a policy requiring MFA for the cx Portal
enterprise application, including guests. This is where MFA is enforced.

**Record:** tenant ID, application (client) ID.

---

## 3. Azure resources

### 3.1 Resource group and parameters

Create a resource group in the chosen region. Fill in
`infra/main.parameters.hitachi.json`:

| Parameter | Value |
|---|---|
| `environment` | `prod` (zone-redundant database, geo-redundant backups, larger database size) or `dev` (single-zone, smaller, cheaper) |
| `location` | the region (a US region) |
| `dbAdminGroupObjectId` / `dbAdminGroupName` | the **CX Portal DB Admins** group |
| `portalUsersGroupObjectId` | the **CX Portal Users** group |
| `entraApiAudience` | the application (client) ID from 2.3 |
| `databasePublicAccess` | see 3.2 |
| `storagePublicAccess` | `true` (see 3.2) |
| `allowedOrigin`, `postgrestDbUri` | leave empty now; set in 3.4 and step 5 |
| `deployWaf` | `false`. In `prod` the template creates the WAF policy anyway; on its own it filters nothing (see 9.2) |

### 3.2 Network access

**Database (`databasePublicAccess`).** The gateway runs in Container Apps and
must reach the database.

- **`true`** — the database accepts connections only from inside Azure (the
  gateway, Cloud Shell), and every connection needs a password and TLS 1.2 or
  later. Nothing else to build.
- **`false`** — the database has no public endpoint at all. Then IT connects
  the Container Apps environment and the database to a virtual network (VNet
  integration plus a private endpoint) before step 4; the template does not
  build that network.

**File storage (`storagePublicAccess: true`).** Browsers, including field
tablets and BART guests, download and upload files directly. Access is still
gated: only members of CX Portal Users can obtain a link, links expire within an
hour, and the account key is disabled. Set `false` only if every user reaches
Azure over a private network.

### 3.3 Deploy

From Azure Cloud Shell (or any machine with the Azure CLI), in the repository
folder:

```bash
RG=<resource group>
az deployment group what-if -g $RG -f infra/main.bicep -p infra/main.parameters.hitachi.json \
  -p administratorLoginPassword='<database admin password>'

az deployment group create  -g $RG -f infra/main.bicep -p infra/main.parameters.hitachi.json \
  -p administratorLoginPassword='<database admin password>' \
  --query properties.outputs -o json
```

> **On every deployment, always pass `administratorLoginPassword` — and, from
> step 5 on, `postgrestDbUri` too.** Leaving the password out switches the
> database's password sign-in off; leaving the connection string out removes
> it from the gateway. Either way the portal goes dark. Keep both in Key Vault.

Run `what-if` first and review the changes before `create`.

**Record the outputs:** `siteUrl`, `apiFqdn`, `postgresFqdn`, `blobOrigin`,
`staticSiteName`.

What it creates: the PostgreSQL server (TLS 1.2+, 35-day backups, Entra admin =
DB Admins group), the storage account (5 private containers, no account key,
30-day soft delete), the Static Web App, the Container Apps environment with the
gateway and its key helper, a managed identity, Key Vault, Log Analytics, and
the role assignment giving CX Portal Users access to the files.

### 3.4 Point sign-in and file access at the website

With `siteUrl` from the outputs:

1. App registration → Authentication → SPA redirect URIs → add
   **`<siteUrl>/`** (with the trailing slash). Add the custom domain too, if one
   is used later.
2. Set `allowedOrigin` to `<siteUrl>` in the parameters file and deploy again
   (3.3). This sets the storage CORS rule that lets the website reach files.

### 3.5 Send the developer these six values

None of them is a secret.

| Value | Where it comes from |
|---|---|
| Tenant ID | Entra ID overview |
| Application (client) ID | The app registration (2.3) |
| Object ID of **CX Portal Users** | 2.1 |
| `siteUrl` | Outputs (3.3) |
| `apiFqdn` | Outputs (3.3) |
| `blobOrigin` | Outputs (3.3) |

The developer sends back `cxportal.sql` and `cx-portal-site.zip` (section 1).
Steps 4 and 5 need only the backup; step 6 needs the zip.

---

## 4. The database

All commands from Cloud Shell (or any machine with `psql`), connected as the
database administrator created by the template (`cxadmin`), in the repository
folder, with `cxportal.sql` from the developer beside it:

```bash
export PGHOST=<postgresFqdn> PGUSER=cxadmin PGDATABASE=postgres PGSSLMODE=require
export PGPASSWORD='<database admin password>'
```

### 4.1 Before the restore

Choose a strong password for the gateway's own login (`authenticator`) and
keep it in Key Vault; it is used again in step 5.

```bash
psql -v ON_ERROR_STOP=1 -v authenticator_password='<gateway password>' \
     -f supabase/sql/azure_before_restore.sql
```

This creates the database roles, extensions and the sign-in shim. **It must run
before the restore**: the backup's security policies refer to these, and a
restore without them silently skips those policies.

### 4.2 Restore the backup

```bash
psql -f cxportal.sql 2>&1 | grep -E '^(psql:.*)?ERROR' | sort | uniq -c
```

A few errors are expected and harmless:

- `schema "private" already exists` or `schema "public" already exists`;
- anything mentioning **`auth.users`** — that is Supabase's own user table,
  which does not exist on Azure, by design;
- `invalid command \restrict` / `\unrestrict`, if this `psql` is older than
  the backup tool (a safety marker newer backups carry; it changes nothing);
- `unrecognized configuration parameter "transaction_timeout"`, only if the
  server is older than PostgreSQL 17.

This sequence (4.1 → 4.5, then a signed-in request through the real gateway)
was rehearsed end to end on a Supabase-shaped database before handover.

Any other error: stop and send the full output to the developer.

### 4.3 After the restore

```bash
psql -v ON_ERROR_STOP=1 -f supabase/sql/azure_after_restore.sql
```

This adapts the MFA check to Entra, restores table privileges, creates the
signing-key table the gateway's helper fills, and installs the profile-link
functions.

### 4.4 Check

```bash
psql -tAc "select count(*) from pg_policies where schemaname = 'public'"   # about 227
psql -tAc "select count(*) from pg_tables where schemaname = 'public'"     # 59
psql -tAc "select to_regprocedure('auth.uid()') is not null"               # t
```

### 4.5 People carried over: nothing to do

Profiles carried over from the old system wait for their owner. The first time
each person signs in with Microsoft, the portal matches the email in their
Microsoft sign-in to their profile and links it to their Entra account for good,
permissions and history included. A portal administrator can also do it at once
by adding the same email in Directory. Email is never used for permissions.

If someone's portal email is not the address they sign in to Microsoft with,
link them directly with their **Entra object ID** (Entra ID → Users → the
person → Object ID):

```bash
psql -c "select private.relink_profile('person@hitachirail.com', '<object id>')"
```

---

## 5. Connect the gateway to the database

Deploy the template again (3.3) with the connection string added:

```bash
-p postgrestDbUri='postgres://authenticator:<gateway password>@<postgresFqdn>:5432/postgres?sslmode=require'
```

(URL-encode any special characters in the password: `@` → `%40`, `:` → `%3A`,
`/` → `%2F`, `#` → `%23`.)

The template stores it as a **Container Apps secret** (`pgrst-db-uri`), which
both containers in the gateway app read: PostgREST and the `jwks-refresh`
helper. It does not appear in the app's settings or in `az containerapp show`;
reading it needs the `listSecrets` permission, which Reader does not have. From
now on, pass `postgrestDbUri` on every deployment (3.3).

**Check:**

```bash
az containerapp logs show -g $RG -n ca-postgrest-<environment> --container jwks-refresh --tail 20
#   jwks-refresh: new keys loaded

curl -s https://<apiFqdn>/profiles
#   []      ← correct: no sign-in, so the database's rules return nothing
```

### About the key helper

The gateway checks every Entra token against Microsoft's public signing keys.
It cannot download them itself, and Microsoft rotates them every few weeks. The
`jwks-refresh` helper downloads them every 6 hours and stores them in the
database; the gateway reloads them without a restart. A failed download, or a
malformed key set, changes nothing — the current keys stay — and it retries in
5 minutes. The helper uses the same database login as the gateway and needs no
other permission.

---

## 6. The website

### 6.1 Deploy the developer's package

`cx-portal-site.zip` is the finished website, already pointed at your gateway,
storage and app registration. It contains only the files the browser needs: no
tests, database scripts, internal documents or secrets.

In Cloud Shell, upload the zip (toolbar → Manage files → Upload), then:

```bash
unzip -o cx-portal-site.zip -d cx-portal-site
TOKEN=$(az staticwebapp secrets list -g $RG -n <staticSiteName> --query properties.apiKey -o tsv)
npx @azure/static-web-apps-cli deploy ./cx-portal-site --deployment-token "$TOKEN" --env production
```

Opening `siteUrl` now shows the sign-in page. Updates arrive the same way: the
developer sends a new zip, and you repeat these three commands. There is no
downtime; people get the new version on their next page load.

### 6.2 Backup option: a pipeline on every merge

If Hitachi later prefers deploying straight from its own Git, the repository
supports it. The developer adds `config.hitachi.js` (your six values, no
secrets) to the repository, and a pipeline builds and deploys on every merge
to `main`. Store the deployment token (6.1) as a pipeline secret.

GitHub Actions:

```yaml
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node tools/run_tests.js
      - run: node tools/build.js --config config.hitachi.js --version "cxp-${GITHUB_SHA::8}"
      - uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.SWA_TOKEN }}
          action: upload
          app_location: dist
          skip_app_build: true
```

Azure DevOps:

```yaml
trigger: [main]
pool: { vmImage: ubuntu-latest }
steps:
  - script: node tools/run_tests.js
  - script: node tools/build.js --config config.hitachi.js --version "cxp-${BUILD_SOURCEVERSION:0:8}"
  - task: AzureStaticWebApp@0
    inputs:
      app_location: dist
      skip_app_build: true
      azure_static_web_apps_api_token: $(SWA_TOKEN)
```

---

## 7. Check it works

Tell the developer the site is live. They sign in first (they are the portal's
first administrator and a member of CX Portal Users), then go through these with
you, in order:

| # | Check | If it fails |
|---|---|---|
| 1 | Opening `siteUrl` redirects to Microsoft and back | Redirect URI (3.4) |
| 2 | The dashboard loads with their name | "Account not set up yet", or empty lists: section 10 |
| 3 | Lists show data in each module | Section 10 |
| 4 | Upload a photo and a document; both open | Storage CORS (`allowedOrigin`), group role, or Azure Storage permission (2.3) |
| 5 | Delete them again | Same as 4 |
| 6 | In Directory, add a colleague, switch them to Inactive, then Remove them: each time they appear in or leave **CX Portal Users** in Entra | Group owners (2.1), Graph permissions and admin consent (2.3) |
| 7 | A BART guest added this way can sign in and sees only what their permissions allow | Guest invitation rights (2.2), Conditional Access |

---

## 8. Running it

**Adding and removing people** is done by portal administrators in the portal,
not by IT: Admin menu → **Directory** → **Users** → **+ Invite User** (opens
**Add Person**) for name, email and permission template. The portal finds the
person's Microsoft account (or, for someone outside Hitachi and after asking,
invites them as a guest), adds them to **CX Portal Users** and saves their
profile. **Remove**, or switching someone to **Inactive**, takes them out of
the group. An address on Hitachi's own domain with no account is treated as a
typo and never invited as a guest. If Microsoft refuses part of a change, the
other part is undone and the administrator is told what to fix (section 10).
Every change shows in Entra's audit log under the administrator's name.

What stays with IT: who **owns** CX Portal Users (that is who may add and
remove people), the guest-invitation settings, and Conditional Access.

**Updating the app:** deploy the new zip the developer sends (6.1).

**Backups:** the database has automatic backups with point-in-time restore for
35 days (geo-redundant in `prod`). Deleted files and containers are recoverable
for 30 days (soft delete).

**Logs:** Log Analytics, created by the template. The gateway and its key
helper log to the Container App; the database to its server logs.

**Microsoft's signing keys:** nothing to do; the helper keeps them current. To
confirm, read the helper's log (section 5).

**Things that never need doing:** no servers to patch, no scheduled jobs, no
certificates to renew (Azure manages TLS), no secrets in the website.

---

## 9. Security summary

### 9.1 Where each control lives

| Concern | Where it lives |
|---|---|
| Who you are, MFA, guest access | Entra ID: assignment required, Conditional Access |
| Adding and removing people | Portal administrators, in the Directory screen. The portal changes CX Portal Users with the administrator's own Microsoft sign-in (delegated Graph permissions); Microsoft allows it only because they own that one group, so no one else can, and nothing beyond that group's membership can change. Logged in Entra's audit log. |
| Linking a profile to a person | New people: their profile is created under their Microsoft object id when they are added. Profiles carried over: linked once, by an administrator or on the person's first sign-in by the email in their token, and only while still waiting. Every link is in the audit log. Email is never used for permissions. |
| What each person may see or change | **Inside the database**, on every request, by row-level security (about 230 policies, per module and per action). A request that bypasses the website still cannot get past it. |
| Files | Private containers, account key disabled. Only CX Portal Users members can obtain a link; each link covers one file and expires within an hour. |
| The gateway's database login | Can switch only to the two request roles, both under row-level security. Its password is in a Container Apps secret (not readable with Reader access) and in Key Vault; TLS required. |
| Signing keys | Public keys from Microsoft, refreshed automatically; a bad download cannot replace good keys |
| The web page | Content-Security-Policy limited to the portal's own gateway, storage, Microsoft sign-in and Microsoft Graph; no third-party scripts; `nosniff`, framing and referrer headers from `staticwebapp.config.json` |
| Secrets in the website | None. Every value the website holds is public by nature. |

### 9.2 Optional hardening — cyber's decision

- **Web application firewall.** The template creates a Front Door WAF policy
  (always in `prod`, otherwise with `deployWaf`), but not the Front Door profile
  that would carry it, so it filters nothing until one exists. Putting Front
  Door (Premium) in front of the gateway is a separate step, about USD 330 per
  month.
- **Central access logs.** The template sends the gateway's logs to Log
  Analytics, but creates no diagnostic settings for the database or the storage
  account. Add them if cyber wants database and file access logged centrally.
- **Private networking** for the database and storage (3.2).
- **Customer-managed keys** for database and storage encryption.
- **Column encryption** for specific sensitive fields (`pgcrypto` is installed).

---

## 10. Troubleshooting

Several failures here are silent or look like something else. In order of
likelihood:

| Symptom | Cause | Fix |
|---|---|---|
| Signs in, then every list is empty | Token has no `roles: ["authenticated"]`, so the gateway treats the person as anonymous | App role value `authenticated` (2.3) and group assignment (2.3 step 8) |
| Gateway returns `PGRST301 JWT not in audience` | Token version or audience mismatch | Manifest `requestedAccessTokenVersion: 2`, and `entraApiAudience` = the bare application ID |
| Every sign-in refused with an invalid-signature error | Signing keys not loaded | Helper log (section 5); was `postgrestDbUri` passed on the last deployment? |
| `permission denied for table …` (42501) | Table privileges missing | Re-run `azure_after_restore.sql` |
| Far fewer than ~227 policies after restore | `azure_before_restore.sql` ran after the restore, or not at all | Drop and recreate the database; run 4.1 → 4.3 in order |
| "Your account is not set up yet" | No portal profile has this person's sign-in email | A portal administrator adds them in Directory, or link them (4.5) |
| "Account not set up yet" for one of two people sharing an email | Two waiting profiles have the same address; the portal will not guess | Link with `relink_profile` (4.5) |
| Add Person: "Your Microsoft account cannot change the CX Portal Users group" | The administrator is not an owner of the group | Add them as an owner of CX Portal Users (2.1) |
| Add Person: "not allowed to invite guests" | Hitachi's external-collaboration settings | Guest Inviter role, or the settings (2.2); or IT invites the guest and the administrator adds them again |
| "IT must grant admin consent for the portal's Microsoft Graph permissions" | The Graph permissions are missing or not consented | 2.3 step 4 |
| "Allow pop-ups for this site" | Microsoft needed one extra confirmation and the browser blocked its window | Allow pop-ups for the portal's address and retry |
| "No Microsoft account in your organisation has the address …" | A typo, or the staff account does not exist yet | Check the spelling; IT creates staff accounts |
| A guest was added but cannot sign in | They have not accepted Microsoft's invitation email | Ask them to look for it (and in spam); IT can resend it (Entra ID → Users → the guest → Resend invitation) |
| Add Person says IT adds people to the group | The website package was built without the CX Portal Users object ID | Ask the developer for a new zip with it (3.5) |
| Files fail to load; browser console mentions CORS | `allowedOrigin` not set to `siteUrl` | 3.4 |
| Files fail with 403 on `userdelegationkey` | Person not in CX Portal Users, or role assignment missing | `portalUsersGroupObjectId` |
| Consent prompt or error on first file access | Azure Storage permission not admin-consented | 2.3 step 4 |
| Portal stopped working after a redeploy | The deployment left out `administratorLoginPassword` or `postgrestDbUri` | Redeploy with both (3.3) |
| Gateway logs "could not connect" | Database not reachable from the gateway | 3.2 |

For anything else: the browser console names the failing request, and the
gateway's log names the database error.

---

*Architecture and security review: [`ARCHITECTURE.md`](ARCHITECTURE.md).
Background and design decisions: [`MIGRATION.md`](../MIGRATION.md). The
developer's own steps: [`DEVELOPER_STEPS.md`](DEVELOPER_STEPS.md).*
