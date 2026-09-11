# SAS-minting Function

The one new server-side component the storage migration needs.

## Why it exists

Supabase Storage lets the **browser** mint signed URLs — the publishable key plus
the caller's JWT is enough, so `photos.js` signed its own. Azure cannot work that
way: a SAS must be signed with a key, and no key may reach page script.

So one small endpoint verifies the caller's Entra ID token and signs on their
behalf. `cx-storage.js`'s `azure` provider calls it; nothing above that file
knows it exists.

It signs with a **user delegation key** obtained through the Function's managed
identity — not the storage account key. The account key is never fetched, never
configured here, and should stay disabled on the account. If this Function is
ever compromised, the blast radius is the identity's role assignment on one
storage account, revocable without rotating a secret.

## Interface

```
POST /api/sas
Authorization: Bearer <Entra access token>

{ "container": "photos",        // or "bucket" — the Supabase name is accepted
  "paths":     ["2026/09/a.jpg"],
  "permissions": "r",           // r, w, d, or a combination. Never "l".
  "expiresIn": 600 }            // seconds; clamped to 3600

200 { "urls": { "2026/09/a.jpg": "https://…?sv=…&sig=…" }, "expiresIn": 600 }
```

Errors are terse to the caller and detailed in the log: a validation oracle on
token contents is worth more to an attacker than to a user.

## What it refuses

`src/sas-core.js` holds all of it, with no Azure SDK and no network, so it is
testable without a subscription — `node tools/test_sas_function.js`, 48 checks,
wired into `tools/run_tests.js`.

- Unknown containers. The caller does not get to name an arbitrary container.
- Path escapes: `..`, `.`, empty segments, leading `/` or `\`, control
  characters, anything over 1024 bytes.
- `l` (list) permission — it would turn one signed URL into an index of the
  whole container.
- Repeated or unknown permission verbs.
- More than 200 paths in one call.
- Expiry beyond one hour (clamped, not rejected).
- Tokens with no `oid`/`sub`, wrong audience, wrong issuer, or a bad signature.

## Authorization — read this before tightening it

`authorize()` currently accepts **any valid token from the tenant**, for any
container. That is not an oversight: it mirrors today's Supabase rule exactly.
The five bucket policies are `to authenticated using (bucket_id = '<name>')` —
any signed-in user can read any object in any bucket if they know its path. The
per-module permissions (`private.has_module_perm`) protect the *metadata rows*,
not the bytes.

A migration should not quietly change the security model, in either direction,
so this reproduces it. But it is the obvious place to tighten: map container to
module and call the same permission function the RLS policies use. The hook is
a single function so that change is one edit, not an audit.

## Configuration

Set by `infra/main.bicep`; listed here because you will set them by hand the
first time.

| App setting | Value |
|---|---|
| `ENTRA_TENANT_ID` | Directory the tokens must come from |
| `ENTRA_API_AUDIENCE` | The `aud` those tokens carry — the API app registration's application id or app id URI |
| `BLOB_ACCOUNT` | Storage account name |
| `ALLOWED_ORIGIN` | The portal's origin. **Never `*`** — this endpoint hands out credentials |
| `AZURE_CLIENT_ID` | Client id of the user-assigned identity |

The Function's identity needs **Storage Blob Data Contributor** on the account
(Reader is enough if only reads are ever signed). The Bicep assigns it.

Then point the front end at it:

```js
window.CX_CONFIG = {
  STORAGE: 'azure',
  SAS_ENDPOINT: 'https://func-sas-cxportal-dev.azurewebsites.net/api/sas',
  …
};
```

## Local run

```bash
npm install
func start          # Azure Functions Core Tools v4
```

`DefaultAzureCredential` picks up `az login` locally, so a developer signed in
with rights on the storage account can run it against real blobs.

## Not done

- **Never deployed.** It compiles and its logic is tested; it has not met a real
  storage account or a real token.
- No Application Insights connection string is set — the Bicep leaves it empty
  for IT to fill from whatever workspace they standardise on.
- Uploads use a single-shot block blob PUT, which caps at 256 MiB. Nothing this
  app stores comes close, and the failure would be immediate and loud.
