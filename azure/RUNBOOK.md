# Azure stand-up runbook

Step by step, from an empty Azure subscription to the portal running against it.

Written for a **personal subscription used as a learning environment**, with
synthetic data only. The same steps work against a corporate subscription; the
differences are called out.

> **Synthetic data only on a personal subscription.** Schema yes, structure yes,
> two or three fake users yes. No BART CBTC content, no real drawings, photos or
> commissioning records. That distinction is what makes this a development spike
> rather than a repeat of the problem the migration exists to solve.

Everything here runs on **your** machine, not in the Claude session — this
container has no Azure CLI and no credentials. Where a step produces a value the
application needs, it says **→ paste this back**.

---

## 0. Before you start

```bash
az --version            # install the Azure CLI if missing
az login
az account show --query "{sub:id, tenant:tenantId, name:name}" -o table
```

**→ paste this back:** subscription id, tenant id.

```bash
az account set --subscription "<subscription id>"
az ad signed-in-user show --query id -o tsv     # your Entra object id
```

**→ paste this back:** your object id. It goes in the parameters file as the
Postgres admin.

---

## 1. Deploy the infrastructure

Edit `infra/main.parameters.personal.json`: replace
`dbAdminGroupObjectId` with your object id and `dbAdminGroupName` with your
sign-in name (`user@domain`).

```bash
az group create -n rg-cxportal-dev -l westus2

# Always what-if first. On a corporate subscription this is where Azure Policy
# tells you which of these resources it will not allow as written.
az deployment group what-if -g rg-cxportal-dev \
  -f infra/main.bicep -p infra/main.parameters.personal.json

az deployment group create -g rg-cxportal-dev \
  -f infra/main.bicep -p infra/main.parameters.personal.json \
  --query properties.outputs -o json
```

**→ paste this back:** the whole outputs block. It carries `postgresFqdn`,
`storageAccountName`, `apiFqdn`, `sasEndpoint` and `appIdentityClientId`, all of
which end up in `config.js`.

If `what-if` reports errors, paste those instead — that is the landing-zone
conversation, and it is expected the first time.

---

## 2. Register the application in Entra ID

This is the part that has no `main.bicep` equivalent, because an app
registration is a directory object rather than a resource.

```bash
# 2a. the app registration, as a single-page application
az ad app create --display-name "BART T&C Portal (dev)" \
  --sign-in-audience AzureADMyOrg \
  --query "{appId:appId, objectId:id}" -o json
```

**→ paste this back:** `appId`. That is `ENTRA_CLIENT_ID`.

```bash
# 2b. redirect URI — SPA platform, NOT web. Web expects a client secret;
#     a browser app must not have one.
az ad app update --id <appId> --set spa.redirectUris="['http://localhost:5173/','https://<your-static-web-app>.azurestaticapps.net/']"

# 2c. expose the API scope PostgREST will validate
az ad app update --id <appId> --identifier-uris "api://<appId>"
```

Then, in the portal (this part is genuinely easier in the UI):
**Entra ID → App registrations → your app → Expose an API → Add a scope**,
named `access_as_user`. Add the same app as an authorized client application so
it can request its own scope without a consent prompt.

**On a corporate subscription:** you will not be allowed to do any of this. It
is IT's to create, and the two values you need back from them are the **client
id** and the **API scope**.

---

## 3. Restore the database

```bash
# 3a. dump from Supabase. Only the application schemas — auth/storage/realtime
#     are GoTrue's and Supabase Storage's, and are replaced rather than moved.
pg_dump "postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
  --schema=public --schema=private \
  --no-owner --no-privileges --no-publications --no-subscriptions \
  -Fc -f cxportal.dump
```

```bash
# 3b. the roles PostgREST switches to. GoTrue created these; here they are ours.
psql "<azure connection string>" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;
grant anon, authenticated to authenticator;
SQL
```

```bash
# 3c. extensions, then the data
psql "<conn>" -c "create extension if not exists pgcrypto; create extension if not exists \"uuid-ossp\"; create extension if not exists pg_cron;"
pg_restore -d "<conn>" --no-owner --no-privileges cxportal.dump

# 3d. THE LOAD-BEARING STEP — re-implement the auth schema over the JWT claims
psql "<conn>" -f supabase/sql/azure_auth_uid_shim.sql
```

**→ paste this back:** any errors from `pg_restore`. Some noise about missing
roles is normal and harmless; anything mentioning a policy or a function is not.

---

## 4. Point PostgREST at Entra

The Container App deployed in step 1 runs PostgREST but has no JWT
configuration yet. It needs:

| Setting | Value |
|---|---|
| `PGRST_DB_URI` | the Postgres connection string, as `authenticator` |
| `PGRST_DB_SCHEMAS` | `public` |
| `PGRST_DB_ANON_ROLE` | `anon` |
| `PGRST_JWT_SECRET` | `{"jwks_uri":"https://login.microsoftonline.com/<tenant>/discover/v2.0/keys"}` |
| `PGRST_JWT_AUD` | `api://<appId>` |
| `PGRST_JWT_ROLE_CLAIM_KEY` | `.role` |

The last one matters and is easy to miss: Entra tokens carry no `role` claim, so
PostgREST falls back to the anon role for every request. Add an **app role** or
an optional claim named `role` with value `authenticated` in the app
registration, or map it in the shim.

**→ tell me** when you hit this — it is the single most likely place for the
first cutover to fail, and the fix depends on which approach IT prefers.

---

## 5. Deploy the SAS Function

```bash
cd azure/functions/sas
npm install
func azure functionapp publish func-sas-cxportal-dev
```

Then set the audience it was deployed without:

```bash
az functionapp config appsettings set -g rg-cxportal-dev -n func-sas-cxportal-dev \
  --settings ENTRA_API_AUDIENCE="api://<appId>" ALLOWED_ORIGIN="https://<static-web-app-host>"
```

---

## 6. Point the front end at all of it

`config.js` — the one file that moves the backend:

```js
window.CX_CONFIG = {
  IDENTITY: 'entra',
  ENTRA_TENANT_ID: '<tenant id>',
  ENTRA_CLIENT_ID: '<appId>',
  ENTRA_API_SCOPE: 'api://<appId>/access_as_user',

  STORAGE: 'azure',
  SAS_ENDPOINT: 'https://func-sas-cxportal-dev.azurewebsites.net/api/sas',

  SUPABASE_URL: 'https://<apiFqdn>',   // now the PostgREST host
  SUPABASE_ANON_KEY: '',               // no anon key under Entra
};
```

Two things must change alongside it, or the app breaks in ways the console will
explain but the code will not:

1. **The CSP in `index.html`** — add the PostgREST host and the blob account
   origin to `connect-src`, and the blob origin to `img-src`.
   `tools/test_csp.js` fails the build if `config.js` and the CSP drift, which is
   the point.
2. **Re-key `profiles.id`** to each user's Entra object id. With two test users
   this is two `update` statements. Every RLS policy then resolves unchanged.

---

## 7. Verify

In order, because each step depends on the one before:

1. Sign in. You should be redirected to Microsoft, then back. The console prints
   `[identity] entra ready — signed in as …`.
2. `window.CXIdentity.storedSession().user.id` in the console should be a uuid,
   and should match `profiles.id` for your row.
3. Load any module list. If it is empty but the table has rows, PostgREST is
   resolving you as `anon` — go back to step 4.
4. Open the photos page. If tiles render, the SAS Function, the delegation key
   and the role assignment are all working together.
5. Upload a photo. That exercises the write SAS path, which is the one with an
   extra round trip.

---

## What is still unknown

- **The Bicep has never met Azure Policy.** It compiles and it is internally
  consistent. A corporate subscription will reject something.
- **MSAL silent refresh on intermittent connectivity** is untested and is the
  risk most likely to hurt in the field — see `MIGRATION.md` §6.
- **The `role` claim** (step 4) is the likeliest first failure.
- Nothing here has run against a real storage account or a real directory.
