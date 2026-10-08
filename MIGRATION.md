# Migration to the Hitachi Rail Azure tenant: background and decisions

> **For IT, start with [`docs/AZURE_HOSTING.md`](docs/AZURE_HOSTING.md)**, the
> complete handover procedure. This file records *why* the design is what it
> is, and what has already been proven.

**Status: prepared, not started.** Every change the move needs is built and
tested. What remains needs Azure access, which IT owns.

---

## Why

The portal runs on a personal, free-tier Supabase account and GitHub Pages.
Company policy requires cloud services under a company contract. It is a proof
of concept with one test user, so now is the cheapest moment to move: no
production data and no user base to cut over.

Moving also closes gaps Supabase cannot: MFA and guest access through Entra,
an optional WAF, private networking and customer-managed keys.

## Decisions

| Decision | Why |
|---|---|
| **Keep PostgreSQL** (Azure Database for PostgreSQL – Flexible Server), not Azure SQL | Permissions are enforced in the database: 349 row-level security policies, 53 triggers, 46 jsonb/array columns. Azure SQL would mean rewriting the security model. PostgreSQL takes a `pg_dump` restore unchanged. |
| **PostgREST** as the API | The app already speaks the PostgREST protocol (that is what Supabase runs). Off-the-shelf container, no custom code. |
| **Entra ID** for sign-in | Corporate accounts, BART as guests, MFA and Conditional Access set centrally. |
| **Profiles keyed by Entra object id, linked once by email** | An admin adds a person in the Team screen by email; their first Microsoft sign-in links the waiting profile to their Entra account (`public.claim_profile()`), and profiles carried over from Supabase link the same way. Permissions never use email. |
| **All files in Azure Blob, signed in the browser** | Each user's browser gets a user delegation key from Azure with their own Microsoft sign-in, and signs short-lived links with it. Same behaviour as Supabase's signed URLs, no server code. Access = membership of the portal users' Entra group, which matches today's rule (any signed-in user, any file). |
| **Static hosting** (Static Web Apps or Blob static website) | The site is plain files. `node tools/build.js` produces `dist/`, the one artifact for a pipeline or a hand-off zip. |

## What is already done and proven

All in the repository and covered by `node tools/run_tests.js`.

- **One settings file per environment.** `config.js` holds values only;
  `cx-config.js` derives the rest. The data API address is `API_URL` (old
  configs using `SUPABASE_URL` still work).
- **Sign-in is swappable.** `cx-auth-provider.js` is the only code that talks to
  an identity provider; the Entra provider is written (MSAL, redirect flow, so
  it works on field tablets) and its token mapping is tested.
- **Files are swappable.** `cx-storage.js` is the only code that touches file
  storage, for all five buckets. Its Azure signatures are pinned byte-for-byte
  against Microsoft's own SDK in `tools/test_storage_seam.js`.
- **Permissions survive the move.** `supabase/sql/azure_auth_uid_shim.sql` lets
  the database read Entra's user id (`oid`) as well as Supabase's, so the same
  349 policies work under both. `tools/test_rls_portability.js` proves identical
  decisions on a real PostgreSQL server.
- **A real restore matched exactly.** On 2026-09-13 the live Supabase database
  was dumped and restored into PostgreSQL 17 on Azure: 349/349 policies, 90/90
  tables, 77/77 functions, 32/32 triggers. PostgREST served it and RLS enforced
  itself. **Order matters:** roles and the shim go in *before* the dump, or
  objects are lost silently (RUNBOOK step 3).
- **Infrastructure template.** `infra/main.bicep` compiles clean; never yet
  deployed to a Hitachi subscription.
- **No outside scripts.** Every library ships in `vendor/`; the CSP allows no
  third-party script host, and a test keeps it that way.

## Known risks

1. ~~Microsoft's sign-in keys rotate~~ **Resolved:** the `jwks-refresh` helper
   beside the gateway reloads them every 6 hours with no restart
   (`supabase/sql/azure_pgrst_jwks.sql`, `tools/test_jwks_refresh.js`).
2. **Sign-in on field tablets.** Test MSAL's silent token refresh on yard and
   tunnel devices with poor signal before cutover.
3. **Guest access for BART** is a tenant policy decision. Raise it early.
4. **First real Microsoft sign-in.** The chain (key helper → gateway → database
   roles → row-level security) is rehearsed locally with Entra-shaped tokens
   and keys; a token issued by the real tenant is the first thing to verify.
5. **Photo and album ownership** compares names, not user ids. Fragile if
   someone is renamed; worth fixing to a uuid while data is small.
6. **Offline files stay on the device after sign-out.** Decide whether shared
   field tablets should clear them.

## Database inventory (2026-10 sweep)

Every table, view and function on the live database compared against what the
app and the database itself use.

**Removed by `supabase/sql/supabase_cleanup_2026_10.sql`** (run before the
backup): the Meetings module's 8 tables and its permission entries; `users`, a
pre-`profiles` people table nothing reads; three trigger functions left by
removed modules; change-log rows about tables that no longer exist.

**Kept, on purpose:**

| Object | Why it stays |
|---|---|
| `test_procedures` | Not named in app code, but `test_items` links to it and two report views read it |
| `auth_events`, `access_review_log`, `access_review_due` | Written by the database (privilege changes) and used for the periodic access review; not app screens |
| `demo_seed_log`, `fn_clear_dynamic_sim_demo` | The demo seed/teardown scripts (`DEMO_DATA.md`) |
| Views `kpi_test_progress`, `vw_dynamic_case_coverage`, `vw_dynamic_global_coverage`, `vw_dynamic_procedure_coverage`, `vw_dynamic_units`, `vw_procedure_scope_rollup` | Not used by the app. Cheap to keep; drop if no outside report (Power BI, SQL) reads them |
| `auth_login_gate`, `auth_record_event`, `password_verification_attempt`, `mfa_verification_attempt` | Used while sign-in is Supabase; obsolete after the Entra cutover |

**Size:** `db_change_log` is 38 MB of the 60 MB database (19,900 rows, 97 % from
`test_items`, mostly bulk imports). Each row stores the full old and new row.
See the proposals in the sweep notes before it grows further.

**Checked and safe for Azure:** every table has row-level security on, nothing
is readable without signing in, all views respect it (`security_invoker`),
every id default uses built-in `gen_random_uuid()`, no stored row contains a
Supabase address, and only two foreign keys point at Supabase's user table
(`profiles`, `user_column_prefs`) — the two expected restore errors.

## What the move retires

After cutover these can be deleted, because Entra does them centrally:
the in-app MFA (TOTP) screens, password policy, rotation and lockout in
`cx-auth-hardening.js`, the GoTrue auth hooks, and the local-password
`postgrest` sign-in provider (a stepping stone for testing without Entra).

Kept: the `auth_events` log of permission changes (Entra logs sign-ins, not the
app's role changes), the access-review view, the CSP and the test suite. The
database's MFA check switches from Supabase's `aal` claim to Entra's `amr`; the
replacement is written in `azure_auth_uid_shim.sql`.

The three Supabase Edge Functions (daily-log email, RMA email, SharePoint photo
sync) were removed before the move. If those features are wanted again they are
rebuilt on Azure (Microsoft Graph). Unused `sharepoint_*` columns on `photos`
stay until the schema is next revised.

## What the application team needs from IT

Everything in the handover, `docs/AZURE_HOSTING.md`, plus:

- Repository access, a named reviewer, and a pipeline that deploys on merge (or
  agreement on the hand-off zip instead).
- Read access to logs (Log Analytics) for debugging.
- If AI-assisted development continues: approval to run Claude Code on a
  managed workstation. Longest lead time, so worth raising first.
- IT's own decisions: region, networking, naming and tagging, and whether CI is
  GitHub Actions or Azure DevOps.
