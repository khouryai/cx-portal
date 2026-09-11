# Azure infrastructure — Hitachi Rail T&C Portal

A **reviewable proposal**, not a deployed environment. Nothing here has been
run: there is no Azure subscription for this application yet, which is the
first thing IT needs to provide.

## What is here

| File | What it is |
|---|---|
| `main.bicep` | Every resource the app needs, annotated with the ITSD Public Clouds requirement it satisfies |
| `main.parameters.json` | Placeholder values — **`dbAdminGroupObjectId` is a dummy** and must be a real Entra group |

## Status

`main.bicep` **compiles clean** (`bicep build`, 15 resources, no errors, no
warnings). That is the only validation performed. It has never been deployed,
so ARM-side and policy-side rejections are still ahead — expect the landing
zone to have opinions about naming, tags, region, SKUs and networking. Those
are IT's call, not the application's.

```
bicep build infra/main.bicep                 # what was verified
az deployment group what-if -g <rg> \
  -f infra/main.bicep -p @infra/main.parameters.json    # do this next
```

## What the application actually requires

Most of this template is negotiable. These are not:

- **PostgreSQL, not Azure SQL.** The authorization model is 349 RLS policies,
  53 triggers and 27 jsonb + 20 array columns. `pg_dump`/`pg_restore` carries
  them verbatim; a SQL Server port is a rewrite of the permission system.
  Proven portable by `tools/test_rls_portability.js`.
- **A WAF in front of the API**, not just the static site. The front end holds
  no data — every Confidential record flows through PostgREST. This is the
  resource that closes ITSD I.2-6, the one requirement the current
  Supabase architecture cannot satisfy at all.
- **`pg_cron`**, which runs the weekly planning snapshot and the `auth_events`
  retention purge (ITSD O.1-5).
- **Entra JWKS on PostgREST.** That is what makes `auth.uid()` resolve — see
  `supabase/sql/azure_auth_uid_shim.sql`.

## Not in this template

- **Networking** (VNet, subnets, private endpoints, DNS zones) — deliberately
  omitted, because it is entirely a landing-zone decision. `databasePublicAccess`
  defaults to `false` so the template does not quietly stand up a public database.
- **The SAS-minting Function** the storage seam needs (see `cx-storage.js`) —
  it needs real container names and an app registration first.
- **CI/CD.** Porting `deploy.yml` needs a federated credential IT must create.
