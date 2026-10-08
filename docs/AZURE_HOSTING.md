# Hosting cx Portal on Azure: what IT needs to set up

**In one sentence:** cx Portal is a folder of static web files plus a small
PostgreSQL database. It has no application server and no custom server code.

Everything below fits in one resource group in the Hitachi tenant.

---

## The simplest ask of IT

Three things, and the developer deploys everything else from the template in
the repo (`infra/main.bicep`):

1. **An empty resource group**, with Contributor rights for the developer.
2. **An Entra app registration** for the portal, with these delegated API
   permissions (admin consent granted):
   - its own API scope (`access_as_user`);
   - **Azure Storage → `user_impersonation`**.
3. **An Entra security group** for portal users (Hitachi staff plus BART guests),
   and a decision on guest access for BART.

IT can also build the pieces by hand if they'd rather. The list is below.

## The pieces

| # | Piece | What it is | Azure service | Setup |
|---|---|---|---|---|
| 1 | **Website** | 78 static files, about 6 MB (HTML, CSS, JavaScript) | Static Web Apps (or Blob static website) | Create it, then upload the `dist/` folder |
| 2 | **Database** | PostgreSQL, about 60 MB. The permission rules are built into it. | Azure Database for PostgreSQL – Flexible Server, smallest tier | Create it, then restore one backup file |
| 3 | **Database gateway** | [PostgREST](https://postgrest.org), an off-the-shelf open-source container. It checks the Microsoft sign-in token on every request. There's no custom code. | Container Apps | Run one public image with a handful of settings |
| 4 | **File storage** | Drawings, documents, forms, photos and attachments in 5 private containers | Storage account (Blob) | Create it, allow the website's address (CORS), give the portal users' group *Storage Blob Data Contributor* |
| 5 | **Sign-in** | Hitachi staff use their corporate account; BART staff use Entra guest access. MFA is set centrally. | Microsoft Entra ID | The app registration and group above |

## What is *not* needed

- **No servers or virtual machines**, and nothing to patch.
- **No application runtime** (Node, .NET, Java) for the website. It is plain files.
- **No custom server code at all.** The gateway is a standard product configured
  with settings. For files, the browser signs its own short-lived links using
  the person's Microsoft sign-in, so there is no file service to run.
- **No compile toolchain.** One Node.js script copies the right files into
  `dist/` and writes the environment settings.
- **No scheduled jobs on day one.** The database has two optional weekly jobs.
  One saves a weekly planning record that nothing in the app currently reads.
  The other clears audit-log entries older than 400 days, so it has nothing to
  do for over a year. The `pg_cron` extension can be turned on later if wanted.
- **No third-party scripts.** Every library ships inside the site; the page
  loads nothing from outside websites.
- **No user migration.** There is one test account today. Users sign in fresh
  with Entra.

## Where security is enforced

| Concern | Where it lives |
|---|---|
| Who you are, MFA, guest access | Entra ID, using Hitachi's own policies |
| What each person may see or change | **Inside the database**, on every request, by row-level security. A call that goes around the app still can't get past it. |
| Files | Containers are private. Only members of the portal users' group can get a file at all. The browser only ever holds a link to a single file that expires within an hour. The storage account key is switched off and never used. |
| The web page itself | A Content-Security-Policy limits the page to the hosts named in its config |

### Optional hardening (cyber's decision, not required to run)

`infra/main.bicep` has switches for each of these:

- A web application firewall (Front Door) in front of the database gateway
- Private networking (private endpoints, no public access to the database)
- Customer-managed encryption keys

### One open item

The gateway keeps a copy of Microsoft's public sign-in keys, and Microsoft
replaces those keys every few weeks. Before go-live, add a small daily job that
refreshes them, for example an Azure Automation runbook. Until then,
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
  API_URL:         'https://<gateway>.azurecontainerapps.io', // the database gateway
  REST_PATH:       '',
  IDENTITY:        'entra',
  ENTRA_TENANT_ID: '<tenant id>',
  ENTRA_CLIENT_ID: '<app registration id>',
  STORAGE:         'azure',
  BLOB_ORIGIN:     'https://<storage-account>.blob.core.windows.net',
};
```

None of these values are secrets.

## Order of work

1. IT provides the three things above.
2. The developer deploys the template, restores the database and applies the
   sign-in shim (`azure/RUNBOOK.md`).
3. Fill in the settings file, build, deploy.
4. The developer signs in and checks each module.

More detail, for whoever runs the steps: `azure/RUNBOOK.md`, then `MIGRATION.md`
for background and decisions.
