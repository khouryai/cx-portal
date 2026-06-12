# Photos Module → SharePoint Integration Plan

> Status: **built & deployed, awaiting IT credentials.** The Photos Module is
> built, the database carries the `sp_*` columns (see
> `supabase_photos_schema.sql`), the sync worker is implemented AND deployed as
> the `photo-sharepoint-sync` Edge Function (source:
> `supabase/functions/photo-sharepoint-sync/index.ts`), and the Photos toolbar
> "⇅ Sync to SharePoint" button is live for admins. Until IT provisions the
> Entra app and the secrets below are set, the function answers
> `{ configured: false }` and the button explains that — no external calls are
> made. **Enabling it is now zero-code:** set the 4 secrets and click Sync.
> This document remains the brief for the meeting with IT.

## Goal

Mirror photos captured in the T&C Portal into the company SharePoint document
library so they live alongside other project records, are backed up under
corporate retention, and are reachable by people who don't use the portal.

Sync is **one-way to start** (Portal → SharePoint). The portal/Supabase remains
the system of record for capture; SharePoint is the corporate archive.

## How it fits the data model

Every row in `photos` already has the columns the sync needs:

| column | meaning |
|---|---|
| `sp_sync_status` | `pending` → `queued` → `synced` / `error` / `skipped` |
| `sp_drive_id` | SharePoint drive (document library) the file was written to |
| `sp_item_id` | Graph driveItem id of the uploaded file |
| `sp_web_url` | shareable link back to the file in SharePoint |
| `sp_synced_at` | last successful sync timestamp |
| `sp_error` | last error message (for retry/triage) |

A photo is eligible for sync once it has a `storage_path`. The sync worker walks
`photos where sp_sync_status in ('pending','error')`, downloads the object from
the Supabase `photos` bucket, and uploads it to SharePoint via Microsoft Graph.

## Folder mapping in SharePoint

Proposed library layout (confirm with IT — they may have a naming standard):

```
/<Document Library>/CX-Portal Photos/
    Punch List/<punch source_label>/...
    Daily Logs/<YYYY-MM>/<log source_label>/...
    General/<YYYY-MM>/...
```

Derived from `source_type` + `source_label` + `taken_at`, so the SharePoint tree
mirrors the in-app albums.

## What IT needs to provision (Azure CLI)

We need an Entra (Azure AD) **app registration** with application permission to
write to the target SharePoint site. Indicative commands for IT — they will
adjust tenant/site specifics:

```bash
# 1. Create the app registration
az ad app create --display-name "CX-Portal Photo Sync"

# 2. Create a client secret (capture the value — shown once)
az ad app credential reset --id <APP_ID> --append --display-name "supabase-sync"

# 3. Grant Microsoft Graph application permissions, then admin-consent them.
#    Least privilege options, in order of preference:
#      - Sites.Selected      (scope the app to ONLY the one target site — preferred)
#      - Files.ReadWrite.All / Sites.ReadWrite.All  (broader; only if required)
az ad app permission add --id <APP_ID> \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions <PERMISSION_ID>=Role
az ad app permission admin-consent --id <APP_ID>
```

If `Sites.Selected` is used, IT also grants the app write access to the specific
site via a Graph call to `/sites/{site-id}/permissions`.

**Outputs we need back from IT:**
- Tenant ID
- Client (application) ID
- Client secret
- Target SharePoint **site ID** and **drive (library) ID**

## Where the sync code will live

A **Supabase Edge Function** (`photo-sharepoint-sync`) — chosen so the client
secret never touches the browser. It will:

1. Acquire an app-only Graph token (client-credentials flow against
   `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`).
2. Select unsynced `photos` rows.
3. For each: download from the `photos` bucket, `PUT` to
   `/drives/{drive-id}/root:/{folder}/{file}:/content` (or an upload session for
   files > 4 MB), then write back `sp_item_id`, `sp_web_url`, `sp_synced_at`,
   and set `sp_sync_status='synced'`. On failure, store `sp_error` and set
   `error` for retry.

Secrets are stored as Edge Function env vars (`SP_TENANT_ID`, `SP_CLIENT_ID`,
`SP_CLIENT_SECRET`, `SP_SITE_ID`, `SP_DRIVE_ID`) — never committed to the repo.

Trigger: scheduled (Supabase cron, e.g. every 15 min) and/or an in-app
"Sync now" button visible to Admins (the Photos Module already reserves a
disabled "Sync to SharePoint" affordance for this).

## Open questions for IT

1. Which SharePoint site / document library is the destination?
2. Can we use `Sites.Selected` (scoped) rather than tenant-wide Graph perms?
3. Retention / naming conventions we must follow inside the library?
4. Any file-type or size limits, or DLP rules that affect uploads?
5. Do they want metadata (location, subsystem, caption) written as SharePoint
   column metadata, or is folder structure + filename enough?
