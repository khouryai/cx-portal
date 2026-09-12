# Azure infrastructure — Hitachi Rail T&C Portal

A **reviewable proposal**, not a deployed environment. Nothing here has been
run: there is no Azure subscription for this application yet, which is the
first thing IT needs to provide.

## What is here

| File | What it is |
|---|---|
| `main.bicep` | Every resource the app needs, annotated with the security property it provides |
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
  intrusion-prevention layer the current Supabase architecture cannot provide
  at all.
- **`pg_cron`**, which runs the weekly planning snapshot and the `auth_events`
  retention purge.
- **Entra JWKS on PostgREST.** That is what makes `auth.uid()` resolve — see
  `supabase/sql/azure_auth_uid_shim.sql`.

## Not in this template

- **Networking** (VNet, subnets, private endpoints, DNS zones) — deliberately
  omitted, because it is entirely a landing-zone decision. `databasePublicAccess`
  defaults to `false` so the template does not quietly stand up a public database.
- **The SAS-minting Function** the storage seam needs (see `cx-storage.js`) —
  it needs real container names and an app registration first.
- **CI/CD.** Porting `deploy.yml` needs a federated credential IT must create.

---

## Deploying to a personal subscription (learning / spike only)

`main.parameters.personal.json` exists so the same template can be stood up on a
throwaway personal Azure subscription to rehearse the migration and validate the
Entra sign-in flow. **Synthetic data only** — no customer content, no real
project records. Tear it down afterwards.

It differs from the corporate parameter file in four ways, all cost or access:

| Parameter | Personal | Why |
|---|---|---|
| `deployWaf` | `false` | `Premium_AzureFrontDoor` is ~USD 330/month and teaches you nothing the rest of the stack doesn't |
| `cheapMode` | `true` | Static Web Apps → Free, log retention → 30 days |
| `databasePublicAccess` | `true` | So you can reach Postgres with `psql` from your laptop without standing up a VNet and a jumpbox |
| `dbAdminGroupObjectId` | your own user | A personal tenant has no admin group; use your own object id (`az ad signed-in-user show --query id -o tsv`) |
| `dbAdminPrincipalType` | `User` | The default `Group` is right for IT's admin group and wrong for one person's account — Azure rejects the mismatch |
| `deployDbEntraAdmin` | `false` | A personal subscription signed up with a Gmail address makes you a **guest** (`#EXT#`) in your own tenant, which is not reliable as a Postgres Entra admin. Password auth is used instead |

`environment` must stay `dev` or `test`. Both switches are ignored when
`environment == 'prod'` — `thrifty` and `wantWaf` are computed so that
production cannot accidentally deploy without a WAF or on Free SKUs, whatever a
parameter file says.

The database password is the one value that must NOT live in the parameters
file, so it is passed on the command line:

```bash
# Generate one and keep it in your password manager — you need it for pg_restore.
DBPW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)Aa1!"
echo "$DBPW"

az group create -n rg-cxportal-dev -l westus2

az deployment group what-if -g rg-cxportal-dev \
  -f infra/main.bicep -p infra/main.parameters.personal.json \
  -p administratorLoginPassword="$DBPW"

az deployment group create -g rg-cxportal-dev \
  -f infra/main.bicep -p infra/main.parameters.personal.json \
  -p administratorLoginPassword="$DBPW" \
  --query properties.outputs -o json
```

Leaving `administratorLoginPassword` empty deploys the server **Entra-only** with
no password login, which is the target state after cutover — but during the
migration `pg_restore` needs a password, so set one now.

Rough running cost with these settings: **USD 30-60/month**, much of it covered
by the free-trial credit. Stop the Postgres server when you are not using it
(`az postgres flexible-server stop`) and it is less. Delete the whole resource
group to stop all of it at once.

