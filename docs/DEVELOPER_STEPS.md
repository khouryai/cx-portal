# cx Portal on Azure — the developer's steps

Everything **you** do for the move, in order, and when. Hitachi IT's part is
[`AZURE_HOSTING.md`](AZURE_HOSTING.md); this list says where the two meet.

| Stage | You | IT |
|---|---|---|
| A. Now | Steps 1–3 | — |
| B. When IT sends six values | Steps 4–6 | Has done Entra and the Azure resources |
| C. When IT says the site is live | Steps 7–8 | Restores the database, deploys the website |
| D. Afterwards | Step 9 | Runs it |

---

## Already done (2026-10-08) — nothing to run

All database preparation on Supabase is finished:

- change log: only what changed is recorded, existing rows compacted
  (`change_log_trigger.sql`, `supabase_change_log_compact.sql`);
- unused objects removed: the Meetings module, the old `users` table, leftover
  functions (`supabase_cleanup_2026_10.sql`);
- the scheduler removed (`supabase_drop_pg_cron.sql`);
- photo and album ownership moved from names to account ids
  (`supabase_photo_owner_ids.sql`).

Running any of these again changes nothing.

---

## A. Now

**1. Send IT the repository and the handover.** Git access, or a zip of the
repository, plus a pointer to `docs/AZURE_HOSTING.md`. That is all IT needs to
start.

**2. Check your own profile's email.** You will be the portal's first
administrator on Azure. Your profile's email must be the address you sign in to
Microsoft with; today it is `alexander.khoury@hitachirail.com`. If that is
right, nothing to do. Ask IT to add you to **CX Portal Users** as a member and
an owner (handover 2.1).

**3. Optional tidy-up before the backup.** Whatever is in the database when you
take the backup (step 5) is what Azure starts with.

- The **QA Automation Bot** profile (`qa-bot@cx-portal.test`, an admin) exists
  for automated tests; on Azure nobody can sign in as it. Remove it in
  Directory if you want a clean list.
- **Files are not moved.** The 9 test files in Supabase stay behind, so the
  records that point at them (4 photos, 4 forms, 1 drawing) will show without
  their file on Azure. Delete those records in the portal first if you want a
  clean start.

---

## B. When IT sends you the six values

IT sends: tenant ID, application (client) ID, the CX Portal Users object ID,
`siteUrl`, `apiFqdn`, `blobOrigin` (handover 3.5). Do steps 4–6 the same day.

**4. Build the website package.** In the repository, create
`config.hitachi.js` (no secrets in it; commit it, so the pipeline option works
later):

```js
window.CX_CONFIG = {
  API_URL:              'https://<apiFqdn>',
  REST_PATH:            '',
  IDENTITY:             'entra',
  ENTRA_TENANT_ID:      '<tenant id>',
  ENTRA_CLIENT_ID:      '<application (client) id>',
  ENTRA_USERS_GROUP_ID: '<CX Portal Users object id>',
  STORAGE:              'azure',
  BLOB_ORIGIN:          '<blobOrigin>',
};
```

Then, with Node.js 18 or later:

```powershell
node tools/build.js --config config.hitachi.js
Compress-Archive -Path dist\* -DestinationPath cx-portal-site.zip -Force
```

The build stops if the API or storage address is missing or malformed.

**5. Take the database backup.** Do this last, right before you send it:
anything entered in the Supabase portal afterwards does not reach Azure.

In the Supabase dashboard: **Connect → Session pooler**, copy the connection
string (user `postgres.<project ref>`, port 5432, with your database password).
The backup tool must be PostgreSQL 17. With Docker Desktop:

```powershell
docker run --rm -v "${PWD}:/out" postgres:17 `
  pg_dump "<session pooler connection string>" `
  --schema=public --schema=private --no-owner --no-privileges `
  -f /out/cxportal.sql
```

(Or install the PostgreSQL 17 command-line tools and run the same `pg_dump`
directly.) Do not save the connection string anywhere.

**6. Send IT both files:** `cxportal.sql` and `cx-portal-site.zip`. From now
on, treat the Supabase portal as read-only.

---

## C. When IT says the site is live

**7. Sign in first.** Open `siteUrl` and sign in with Microsoft. Your carried-
over profile links to your Microsoft account on this first sign-in, with your
permissions and history.

**8. Run the checks with IT** (handover section 7): upload and delete a photo
and a document, then add a colleague in Directory, switch them to Inactive and
remove them, and finally add the real team (BART staff get a Microsoft
invitation email).

---

## D. Afterwards

**9. Updates and the old system.**

- **Updating the portal:** change the code, run `node tools/run_tests.js`,
  build and zip as in step 4, and send IT the new zip (handover 6.1). If IT
  later sets up the pipeline (handover 6.2), merging to `main` deploys instead.
- **Supabase and GitHub Pages:** keep them, untouched, for two weeks as a
  fallback; then pause the Supabase project and turn GitHub Pages off.
