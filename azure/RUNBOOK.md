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

## 3. Load the database

On a free-trial subscription the database is the `postgres:17` **container**, not
the managed service (see `infra/README.md` for why). It has **internal ingress
only** — Azure refuses external TCP ingress without a custom VNet — so Cloud
Shell cannot reach it with `psql`.

That turns out not to matter, because the container already has everything
needed: PostgreSQL 17 client tools of exactly the right version, and outbound
internet. So the dump and the restore both happen *inside* it, in one pipe,
with nothing staged in between.

```bash
az containerapp exec -g rg-cxportal-dev -n ca-postgres-dev --command /bin/bash
```

Then, inside the container. **The order below is not cosmetic** — it was
established the hard way, and getting it wrong silently loses objects:

```bash
PW='<supabase-password>'; REF='<project-ref>'
SRC="postgresql://postgres.$REF:$PW@aws-1-us-west-2.pooler.supabase.com:5432/postgres"

# 1. ROLES FIRST. Every `create policy ... to authenticated` in the dump fails
#    if the role does not exist yet, and pg_restore does not stop — it just
#    keeps going and you end up with a fraction of your policies.
psql -U cxadmin -d postgres <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
SQL

# 2. Clean slate, then THE AUTH SHIM — also before the dump. Policies and
#    column defaults reference auth.uid(); if the schema is not there yet they
#    fail exactly the same silent way the missing roles did.
psql -U cxadmin -d postgres <<'SQL'
drop schema if exists public cascade;
drop schema if exists private cascade;
create schema public;
create schema private;
grant usage on schema public to anon, authenticated, service_role;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$f$;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(coalesce(auth.jwt() ->> 'oid', auth.jwt() ->> 'sub'), '')::uuid;
$f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(auth.jwt() ->> 'role', current_setting('role', true));
$f$;
create or replace function auth.email() returns text language sql stable as $f$
  select auth.jwt() ->> 'email';
$f$;
grant usage on schema auth to anon, authenticated, service_role;
SQL

# 3. Now the dump. Errors are grouped so 400 identical lines do not hide the
#    two that matter.
pg_dump "$SRC" --schema=public --schema=private \
  --no-owner --no-privileges --no-publications --no-subscriptions \
| psql -U cxadmin -d postgres 2>&1 | grep -E '^ERROR' | sort | uniq -c | sort -rn | head
```

> The connection string is the **Session pooler** one from the Supabase
> dashboard, not "Direct connection". Supabase dropped IPv4 for direct
> connections on the free tier, and an Azure container has no IPv6 egress — the
> direct host simply times out. Note the username is `postgres.<ref>` and the
> port is 5432 (session mode); 6543 is transaction mode and `pg_dump` cannot
> use it.
>
> The `postgres:17` image has no `curl`, so the shim is inlined above rather
> than fetched from the repo.

# 4. THE MFA GATE. private.mfa_ok() reads Supabase's `aal` claim and queries
#    auth.mfa_factors — a GoTrue table that does not exist here. Every one of
#    the 331 policies that route through has_module_perm() calls it FIRST, so
#    leaving it alone means every read errors. The symptom is not a crash: the
#    app signs in happily and shows empty lists.
#
#    Entra reports the factors actually used in `amr` instead. This replacement
#    is written and commented in supabase/sql/azure_auth_uid_shim.sql, to be
#    applied at the Entra cutover and not before.
psql -U cxadmin -d postgres <<'SQL'
create or replace function private.mfa_ok()
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(auth.jwt() -> 'amr' ? 'mfa', false)
      or coalesce(auth.jwt() ->> 'acr', '') = 'mfa';
$function$;
SQL
```

# 5. THE TABLE GRANTS. `pg_dump --no-privileges` deliberately strips GRANTs,
#    which includes the ones Supabase gives anon/authenticated on every table.
#    Without them PostgREST returns 42501 "permission denied for table X" —
#    a GRANT denial, not an RLS denial, and easy to misread as a policy problem.
#    These are Supabase's defaults: broad table privileges with RLS as the gate.
psql -U cxadmin -d postgres <<'SQL'
grant usage on schema public, auth, private to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
notify pgrst, 'reload schema';
SQL
```

Sanity check:

```bash
psql -U cxadmin -d postgres -tAc "select 'policies: ' || count(*) from pg_policies;"
psql -U cxadmin -d postgres -tAc "select 'tables:   ' || count(*) from pg_tables where schemaname='public';"
psql -U cxadmin -d postgres -tAc "select 'auth.uid: ' || (to_regprocedure('auth.uid()') is not null);"
psql -U cxadmin -d postgres -tAc "select 'mfa_ok:   ' || private.mfa_ok();"
psql -U cxadmin -d postgres -tAc "select 'perm_fn:  ' || private.has_module_perm('tasks','view');"
```

Around **349 policies and 90 tables** means the whole authorization model came
across. A policy count in the 300s with `ERROR: schema "auth" does not exist`
in the log means the shim ran too late — go back to step 2.

> **This database is ephemeral.** A container restart loses all of it. Keep this
> block to hand — you will run it again. That is the price of the free tier, and
> the reason nothing real goes in here.

Sanity check before moving on:

```bash
psql -U cxadmin -d postgres -c "select count(*) from pg_policies;"
psql -U cxadmin -d postgres -c "select auth.uid();"     -- null outside a request, but must EXIST
```

If `pg_policies` returns a few hundred rows and `auth.uid()` resolves rather
than erroring, the whole authorization model came across intact.

---

## 4. Point PostgREST at Entra

The Container App deployed in step 1 runs PostgREST but has no JWT
configuration yet. It needs:

| Setting | Value |
|---|---|
| `PGRST_DB_URI` | the Postgres connection string, as `authenticator` |
| `PGRST_DB_SCHEMAS` | `public` |
| `PGRST_DB_ANON_ROLE` | `anon` |
| `PGRST_JWT_SECRET` | `{"jwks_uri":"https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys"}` |
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
