# Hosting cx Portal on Azure: what IT needs to set up

**In one sentence:** cx Portal is a folder of static web files plus a small
PostgreSQL database. It needs no application server and no custom backend.

Everything below fits in one resource group in the Hitachi tenant.

---

## The pieces

| # | Piece | What it is | Azure service | IT effort |
|---|---|---|---|---|
| 1 | **Website** | 78 static files, about 6 MB (HTML, CSS, JavaScript) | Static Web Apps (or Blob static website) | Create it, then upload the `dist/` folder |
| 2 | **Database** | PostgreSQL, about 60 MB. The permission rules are built into it. | Azure Database for PostgreSQL – Flexible Server, smallest tier | Create it, then restore one backup file |
| 3 | **Database gateway** | [PostgREST](https://postgrest.org), an off-the-shelf open-source container. It checks the Microsoft sign-in token on every request. There's no custom code. | Container Apps | Run one public image with a handful of settings |
| 4 | **File storage** | Drawings, documents, forms, photos and attachments in 5 private containers | Storage account (Blob) | Create it and allow the website's address (CORS) |
| 5 | **File-link signer** | About 280 lines in `azure/functions/sas/`. It gives the browser a short-lived link (one hour at most) to one file, after checking who's asking. | Functions (consumption plan) | Deploy it and give it a managed identity |
| 6 | **Sign-in** | Hitachi staff use their corporate account; BART staff use Entra guest access. MFA is set centrally. | Microsoft Entra ID | One app registration |

## What is *not* needed

- **No servers or virtual machines**, and nothing to patch.
- **No application runtime** (Node, .NET, Java) for the website. It is plain files.
- **No custom backend API.** The gateway is a standard product, configured with settings only.
- **No compile toolchain.** One Node.js script copies the right files into `dist/` and writes the environment settings.
- **No scheduled jobs on day one.** The database has two optional weekly jobs. One saves a weekly planning record that nothing in the app currently reads. The other clears audit-log entries older than 400 days, so it has nothing to do for over a year. The `pg_cron` extension can be turned on later if wanted.
- **No user migration.** There is one test account today. Users sign in fresh with Entra.

## Where security is enforced

| Concern | Where it lives |
|---|---|
| Who you are, MFA, guest access | Entra ID, using Hitachi's own policies |
| What each person may see or change | **Inside the database**, on every request, by row-level security. A call that goes around the app still can't get past it. |
| Files | Containers are private. The browser only ever gets a short-lived link to a single file. The storage account key is never used; the signer uses its managed identity. |
| The web page itself | A Content-Security-Policy limits the page to the hosts named in its config |

### Optional hardening (cyber's decision, not required to run)

`infra/main.bicep` has switches for each of these:

- A web application firewall (Front Door) in front of the database gateway
- Private networking (private endpoints, no public access to the database)
- Customer-managed encryption keys

### One open item

The gateway keeps a copy of Microsoft's public sign-in keys, and Microsoft
replaces those keys every few weeks. Before go-live, add a small daily job that
refreshes them. It could be a timer in the same Function App. Until then,
re-running `azure/configure-postgrest.sh` refreshes them by hand.

## Deploying

The same output works for both options:

```
node tools/build.js --config hitachi.config.js
```

This produces `dist/`: only the files the browser needs, with that
environment's settings applied. It contains no tests, database scripts or
internal documents.

- **Option A: pipeline.** The repo lives in Hitachi's Git. On each merge, the
  pipeline runs the command above and uploads `dist/` to the Static Web App.
  That's two steps in GitHub Actions or Azure DevOps.
- **Option B: hand-off.** The developer runs the same command, zips `dist/`
  and sends it. IT uploads it to the Static Web App with the deployment token,
  or copies it into the `$web` container of a Blob static website.

### The settings file (the only thing that differs per environment)

```js
window.CX_CONFIG = {
  SUPABASE_URL:    'https://<gateway>.azurecontainerapps.io', // the database gateway (name kept for history)
  REST_PATH:       '',
  IDENTITY:        'entra',
  ENTRA_TENANT_ID: '<tenant id>',
  ENTRA_CLIENT_ID: '<app registration id>',
  STORAGE:         'azure',
  SAS_ENDPOINT:    'https://<function-app>.azurewebsites.net/api/sas',
  BLOB_ORIGIN:     'https://<storage-account>.blob.core.windows.net',
};
```

None of these values are secrets.

## Order of work

1. IT creates the pieces above, by hand or with `infra/main.bicep`.
2. Restore the database backup and apply the sign-in shim (`azure/RUNBOOK.md`, step 3).
3. Create the Entra app registration and invite BART guests.
4. Fill in the settings file, build, deploy.
5. The developer signs in and checks each module.

More detail, for whoever runs the steps: `azure/RUNBOOK.md`, `MIGRATION.md`.
