# cx Portal on Azure — handover to Hitachi IT

This is the complete procedure for hosting cx Portal in the Hitachi Rail Azure
tenant. It is written so IT can do the whole move; the developer's part is
limited to handing over three things (section 1) and testing at the end.

**What cx Portal is:** a folder of static web files plus a small PostgreSQL
database. No application server, no custom server code, no scheduled jobs, no
third-party scripts.

---

## Contents

0. [How it fits together](#0-how-it-fits-together)
1. [What the developer hands over](#1-what-the-developer-hands-over)
2. [Entra ID: groups and the app registration](#2-entra-id-groups-and-the-app-registration)
3. [Azure resources](#3-azure-resources)
4. [The database](#4-the-database)
5. [Connect the gateway to the database](#5-connect-the-gateway-to-the-database)
6. [Files](#6-files)
7. [The website](#7-the-website)
8. [Check it works](#8-check-it-works)
9. [Running it](#9-running-it)
10. [Security summary](#10-security-summary)
11. [Troubleshooting](#11-troubleshooting)

---

## 0. How it fits together

```
 Browser (staff laptops, field tablets, BART guests)
   │
   ├─ 1. Sign in ───────────────────────► Microsoft Entra ID (MFA, guests)
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
| Website | Static Web Apps | 78 files, about 6 MB |
| Database | Azure Database for PostgreSQL – Flexible Server, v17 | About 60 MB. All permission rules live in it. |
| Database gateway | Container Apps: `postgrest/postgrest:v12.2.3` plus a `postgres:17-alpine` helper | Off-the-shelf images; configured by settings only |
| Files | Storage account, 5 private containers | About 4 MB today |
| Sign-in | Microsoft Entra ID | App registration, two groups, Conditional Access |
| Supporting | Managed identity, Key Vault, Log Analytics | Created by the template |

Everything except Entra is created by one template, `infra/main.bicep`.

---

## 1. What the developer hands over

| # | Item | How the developer makes it |
|---|---|---|
| 1 | **The repository** (source, template, scripts) | Git, or a zip of the repository |
| 2 | **`cxportal.sql`** — the database backup | Appendix A.1 |
| 3 | **`cxportal-files/`** — every stored file | Appendix A.2 |

The repository contains everything referenced below: `infra/` (template),
`supabase/sql/` (database scripts), `tools/build.js` (packages the website).

> The backup and the files folder contain project data. Transfer them the way
> Hitachi transfers Confidential material, and delete local copies after the
> restore is checked.

---

## 2. Entra ID: groups and the app registration

### 2.1 Two security groups

| Group | Members | Used for |
|---|---|---|
| **CX Portal Users** | Everyone who uses the portal, BART guests included | Sign-in to the app, and access to files |
| **CX Portal DB Admins** | IT staff who administer the database | Entra administrator on PostgreSQL |

Record both **object IDs**.

### 2.2 BART guest users

Invite each BART user as a B2B guest (Entra ID → Users → Invite external
user), then add them to **CX Portal Users**. Guest access is governed by
Hitachi's external-collaboration policy; that decision belongs to IT and
cyber, not the app.

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
   - Microsoft Graph `User.Read` is present by default; keep it.
   - **Grant admin consent** for the tenant.
5. **Token configuration** → Add optional claim → token type **Access** →
   `email`. On first sign-in the portal matches this address to the profile an
   administrator created for the person (section 9). Version-2 tokens also
   carry `preferred_username`, which is used too.
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
| `location` | the region |
| `dbAdminGroupObjectId` / `dbAdminGroupName` | the **CX Portal DB Admins** group |
| `portalUsersGroupObjectId` | the **CX Portal Users** group |
| `entraApiAudience` | the application (client) ID from 2.3 |
| `databasePublicAccess` | see 3.2 |
| `storagePublicAccess` | `true` (see 3.2) |
| `allowedOrigin`, `postgrestDbUri` | leave empty now; set in 3.4 and step 5 |
| `deployWaf` | `false` unless cyber wants it (see 10.2) |

### 3.2 Two network decisions

**Database.** The gateway runs in Container Apps and must reach the database.

- **Simple path (`databasePublicAccess: true`)** — the database has a public
  endpoint, but the template's firewall rule admits only Azure services, and
  every connection needs a password and TLS. No network build-out.
- **Private path (`false`)** — the database is reachable only from a virtual
  network. Then the Container Apps environment must be VNet-integrated and the
  database given a private endpoint (or VNet injection). The template does not
  build that network; it is a landing-zone decision.

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

> **Always pass `administratorLoginPassword`, on every deployment.** Leaving it
> out switches the database's password sign-in off, and the gateway signs in
> with a password — the portal would go dark. Keep the password in Key Vault.

`what-if` first: Azure Policy in the landing zone may require changes (tags,
SKUs, private endpoints). The template annotates the security purpose of each
resource.

**Record the outputs:** `siteUrl`, `apiFqdn`, `postgresFqdn`, `blobOrigin`.

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

---

## 4. The database

All commands from Cloud Shell (or any machine with `psql`), connected as the
database administrator created by the template (`cxadmin`), in the repository
folder:

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
function used next.

### 4.4 Check

```bash
psql -tAc "select count(*) from pg_policies where schemaname = 'public'"   # 227 (263 if the cleanup in A.0 was skipped)
psql -tAc "select count(*) from pg_tables where schemaname = 'public'"     # 59  (68 if the cleanup was skipped)
psql -tAc "select to_regprocedure('auth.uid()') is not null"               # t
```

### 4.5 People carried over: nothing to do

Every profile restored from the backup is marked as waiting for its owner. The
first time each person signs in with Microsoft, the portal matches the email
in their Microsoft sign-in to their profile and links it to their Entra account
for good — permissions, history and ownership of photos and markups included.
From then on only their Entra object ID is used; email is never used for
permissions.

This needs their portal email to be the address they sign in to Microsoft
with. If it differs, either correct the email first
(`update public.profiles set email = '<sign-in address>' where email = '<old>'`)
or link them directly with their **Entra object ID** (Entra ID → Users → the
person → Object ID):

```bash
psql -c "select private.relink_profile('person@hitachirail.com', '<object id>')"
```

Test accounts that should not carry over can be switched off:

```bash
psql -c "update public.profiles set is_active = false where email = '<email>'"
```

---

## 5. Connect the gateway to the database

Deploy the template again (3.3) with the connection string added:

```bash
-p postgrestDbUri='postgres://authenticator:<gateway password>@<postgresFqdn>:5432/postgres?sslmode=require'
```

(URL-encode any special characters in the password: `@` → `%40`, `:` → `%3A`,
`/` → `%2F`, `#` → `%23`.)

Both containers in the gateway app receive it: PostgREST, and the
`jwks-refresh` helper.

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

## 6. Files

Upload the developer's `cxportal-files/` folder, one container per subfolder.
The person running this needs **Storage Blob Data Contributor** on the storage
account (for example, temporary membership of CX Portal Users).

```bash
ACCOUNT=<storage account name>     # the host part of blobOrigin
for c in photos forms drawings documents vehicle-files; do
  [ -d "cxportal-files/$c" ] && az storage blob upload-batch --auth-mode login \
    --account-name $ACCOUNT -d "$c" -s "cxportal-files/$c"
done
```

The folder paths match what the database rows refer to; nothing needs renaming.

---

## 7. The website

### 7.1 Settings file

Create `config.hitachi.js` (no secrets in it; it can live in the repository):

```js
window.CX_CONFIG = {
  API_URL:         'https://<apiFqdn>',
  REST_PATH:       '',
  IDENTITY:        'entra',
  ENTRA_TENANT_ID: '<tenant id>',
  ENTRA_CLIENT_ID: '<application (client) id>',
  STORAGE:         'azure',
  BLOB_ORIGIN:     '<blobOrigin>',
};
```

### 7.2 Build

Needs Node.js 18 or later, nothing else:

```bash
node tools/build.js --config config.hitachi.js
```

This produces `dist/`: only the files the browser needs, with these settings
applied and the page's security policy narrowed to exactly these addresses. It
contains no tests, database scripts or internal documents.

### 7.3 Deploy — choose one

**Option A: pipeline (on every merge).** With the repository in Hitachi's Git:

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

The deployment token: Static Web App → **Manage deployment token**. Store it as
a pipeline secret.

**Option B: hand-off.** The developer (or IT) runs 7.2, zips `dist/`, and IT
uploads it:

```bash
npx @azure/static-web-apps-cli deploy ./dist --deployment-token <token> --env production
```

---

## 8. Check it works

Sign in as a linked person (4.5) and go through, in order:

| # | Check | If it fails |
|---|---|---|
| 1 | Opening `siteUrl` redirects to Microsoft and back | Redirect URI (3.4) |
| 2 | The dashboard loads with your name | "Account not set up yet": see section 11. Empty lists: see section 11 |
| 3 | Lists show data in each module | Section 11 |
| 4 | A photo, a drawing and a document open | Storage CORS (`allowedOrigin`), group role, or Azure Storage permission (2.3) |
| 5 | Upload a photo; delete it | Same as 4 |
| 6 | A BART guest can sign in and sees only what their permissions allow | Guest invitation, group membership, Conditional Access |

---

## 9. Running it

**Adding a person** — two steps, in either order:

1. **IT, in Entra:** add them to **CX Portal Users** (invite them as a guest
   first if they are BART staff). This is what lets them sign in at all.
2. **A portal administrator, in the portal:** Team → **Add Person** — name,
   the email they sign in to Microsoft with, and their permission template. No
   password and no Microsoft ID are needed. The Team list shows them as
   *Not signed in yet*.

Their first Microsoft sign-in links the profile to their Entra account
automatically (and writes an `entra_link` event to the audit log).

**Removing a person:** remove them from CX Portal Users (they can no longer
sign in), and set `is_active = false` on their profile to keep their history.

**Updating the app:** merge to the main branch (Option A), or build and
upload a new `dist/` (Option B). Users get the new version on their next page
load; no downtime.

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

## 10. Security summary

### 10.1 Where each control lives

| Concern | Where it lives |
|---|---|
| Who you are, MFA, guest access | Entra ID: assignment required, Conditional Access |
| Linking a profile to a person | Once, on their first Microsoft sign-in, by the email Microsoft puts in their token — only to a profile an administrator created and that is still waiting. Linked profiles can never be claimed again, and every link is in the audit log. Email is never used for permissions. |
| What each person may see or change | **Inside the database**, on every request, by row-level security (about 230 policies, per module and per action). A request that bypasses the website still cannot get past it. |
| Files | Private containers, account key disabled. Only CX Portal Users members can obtain a link; each link covers one file and expires within an hour. |
| The gateway's database login | Password, held only in the Container App's configuration; TLS required |
| Signing keys | Public keys from Microsoft, refreshed automatically; a bad download cannot replace good keys |
| The web page | Content-Security-Policy limited to the exact addresses in 7.1; no third-party scripts |
| Secrets in the website | None. Every value in `config.hitachi.js` is public by nature. |

### 10.2 Optional hardening — cyber's decision

- **Web application firewall.** `deployWaf` creates a Front Door WAF policy, but
  not the Front Door profile that would carry it. Putting Front Door (Premium)
  in front of the gateway is a separate step, about USD 330 per month.
- **Private networking** for the database and storage (3.2).
- **Customer-managed keys** for database and storage encryption.
- **Column encryption** for specific Confidential fields (`pgcrypto` is installed).

---

## 11. Troubleshooting

Several failures here are silent or look like something else. In order of
likelihood:

| Symptom | Cause | Fix |
|---|---|---|
| Signs in, then every list is empty | Token has no `roles: ["authenticated"]`, so the gateway treats the person as anonymous | App role value `authenticated` (2.3) and group assignment (2.3 step 8) |
| Gateway returns `PGRST301 JWT not in audience` | Token version or audience mismatch | Manifest `requestedAccessTokenVersion: 2`, and `entraApiAudience` = the bare application ID |
| Every sign-in refused with an invalid-signature error | Signing keys not loaded | Helper log (section 5); is `postgrestDbUri` set? |
| `permission denied for table …` (42501) | Table privileges missing | Re-run `azure_after_restore.sql` |
| Far fewer than ~227 policies after restore | `azure_before_restore.sql` ran after the restore, or not at all | Drop and recreate the database; run 4.1 → 4.3 in order |
| "Your account is not set up yet" | No portal profile has this person's sign-in email: not added in Team, or added under a different address | Add them in Team (section 9) with the address they sign in with, or correct the email (4.5) |
| "Account not set up yet" for one of two people sharing an email | Two waiting profiles have the same address; the portal will not guess | Correct one email, or link with `relink_profile` (4.5) |
| Files fail to load; browser console mentions CORS | `allowedOrigin` not set to `siteUrl` | 3.4 |
| Files fail with 403 on `userdelegationkey` | Person not in CX Portal Users, or role assignment missing | `portalUsersGroupObjectId` |
| Consent prompt or error on first file access | Azure Storage permission not admin-consented | 2.3 step 4 |
| Portal stopped working after a redeploy | Deployment ran without `administratorLoginPassword`, which turned password sign-in off | Redeploy with it (3.3) |
| Gateway logs "could not connect" | Network path: firewall rule, or private networking incomplete | 3.2 |

For anything else: the browser console names the failing request, and the
gateway's log names the database error.

---

## Appendix A — the developer's exports

### A.0 First, clear out what is no longer used

In the Supabase SQL editor, run `supabase/sql/supabase_cleanup_2026_10.sql`
(removed Meetings module, a legacy people table, orphaned functions) and
`supabase/sql/supabase_drop_pg_cron.sql` (the switched-off scheduler), so none
of it is carried to Azure.

### A.1 Database backup

In the Supabase dashboard: **Connect → Session pooler**, copy the connection
string (user `postgres.<project ref>`, port 5432). The backup tool must be
PostgreSQL 17, which Docker provides:

```bash
docker run --rm -v "$PWD:/out" postgres:17 \
  pg_dump "<session pooler connection string>" \
  --schema=public --schema=private --no-owner --no-privileges \
  -f /out/cxportal.sql
```

### A.2 Files

```bash
SUPABASE_URL=https://<project ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API → service_role key> \
node tools/export_supabase_files.js cxportal-files
```

It prints a count per container. Do not save the service role key anywhere.

---

*Background and design decisions: [`MIGRATION.md`](../MIGRATION.md). The
developer's own trial on a personal subscription: [`azure/RUNBOOK.md`](../azure/RUNBOOK.md).*
