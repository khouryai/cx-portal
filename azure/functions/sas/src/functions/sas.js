"use strict";
// POST /api/sas — mint short-lived user-delegation SAS URLs for blob paths.
//
// WHY THIS EXISTS AT ALL. Supabase Storage lets the BROWSER mint signed URLs:
// the anon key plus the caller's JWT is enough, so photos.js could sign its own.
// Azure cannot work that way. A SAS must be signed with a key, and no key may
// ever reach page script. So one small server-side component verifies the
// caller's Entra token and signs on their behalf. This is that component, and
// it is the ONLY new server-side code the storage migration needs.
//
// It signs with a USER DELEGATION key, not the storage account key. The account
// key is never fetched, never configured here, and ideally is disabled on the
// account entirely (see infra/main.bicep). The delegation key is obtained via
// the Function's managed identity and is itself short-lived, so the worst case
// if this Function is compromised is bounded by the identity's role assignment
// rather than being "the whole storage account, forever".
//
// CONFIGURATION (app settings):
//   ENTRA_TENANT_ID     directory the tokens must come from
//   ENTRA_API_AUDIENCE  the `aud` these tokens carry — the API app registration's
//                       application id or app id URI
//   BLOB_ACCOUNT        storage account name
//   ALLOWED_ORIGIN      the portal's origin, for CORS. No wildcard: this hands
//                       out credentials.
//
// The Function's managed identity needs 'Storage Blob Data Contributor' (or
// Reader, if only reads are ever signed) on the account.
const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const {
  BlobServiceClient,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const core = require("../sas-core.js");

const TENANT = process.env.ENTRA_TENANT_ID || "";
const AUDIENCE = process.env.ENTRA_API_AUDIENCE || "";
const ACCOUNT = process.env.BLOB_ACCOUNT || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

const ACCOUNT_URL = "https://" + ACCOUNT + ".blob.core.windows.net";

// One JWKS cache for the process; `jose` handles refresh and rotation.
let jwks = null;
function keyStore() {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL("https://login.microsoftonline.com/" + TENANT + "/discovery/v2.0/keys")
    );
  }
  return jwks;
}

let blobService = null;
function service() {
  if (!blobService) {
    blobService = new BlobServiceClient(ACCOUNT_URL, new DefaultAzureCredential());
  }
  return blobService;
}

// User delegation keys are valid for up to 7 days, so re-fetching one per
// request would be a pointless round trip on every photo grid paint. Cached
// until five minutes before expiry.
let delegationKey = null;
let delegationKeyExpiry = 0;
async function userDelegationKey() {
  const now = Date.now();
  if (delegationKey && now < delegationKeyExpiry - 5 * 60 * 1000) return delegationKey;
  const startsOn = new Date(now - 5 * 60 * 1000);       // clock-skew allowance
  const expiresOn = new Date(now + 60 * 60 * 1000);
  delegationKey = await service().getUserDelegationKey(startsOn, expiresOn);
  delegationKeyExpiry = expiresOn.getTime();
  return delegationKey;
}

function corsHeaders() {
  const h = { "Content-Type": "application/json" };
  if (ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
    h["Access-Control-Allow-Headers"] = "authorization,content-type";
    h["Access-Control-Allow-Methods"] = "POST,OPTIONS";
    h["Vary"] = "Origin";
  }
  return h;
}

app.http("sas", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",   // the Entra token below is the authentication
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return { status: 204, headers: corsHeaders() };

    for (const [name, value] of Object.entries({ ENTRA_TENANT_ID: TENANT, ENTRA_API_AUDIENCE: AUDIENCE, BLOB_ACCOUNT: ACCOUNT })) {
      if (!value) {
        context.error("missing app setting: " + name);
        return { status: 500, headers: corsHeaders(), jsonBody: { error: "Function is not configured." } };
      }
    }

    let parsed, oid;
    try {
      const token = core.bearerToken(request.headers.get("authorization"));
      const { payload } = await jwtVerify(token, keyStore(), {
        audience: AUDIENCE,
        // Both issuer spellings: v2.0 endpoints issue the first, v1.0 the second.
        issuer: [
          "https://login.microsoftonline.com/" + TENANT + "/v2.0",
          "https://sts.windows.net/" + TENANT + "/",
        ],
      });
      ({ oid } = core.authorize(payload));
      parsed = core.parseRequest(await request.json().catch(() => null));
    } catch (err) {
      const status = err.status || 401;
      // Deliberately terse to the caller, detailed in the log: a validation
      // oracle on token contents is worth more to an attacker than to a user.
      context.warn("sas request rejected (" + status + "): " + err.message);
      return { status, headers: corsHeaders(), jsonBody: { error: err.message } };
    }

    try {
      const key = await userDelegationKey();
      const startsOn = new Date(Date.now() - 5 * 60 * 1000);
      const expiresOn = new Date(Date.now() + parsed.expiresIn * 1000);
      const permissions = BlobSASPermissions.parse(parsed.permissions);

      const out = {};
      for (const blobPath of parsed.paths) {
        const sas = generateBlobSASQueryParameters({
          containerName: parsed.container,
          blobName: blobPath,
          permissions,
          startsOn,
          expiresOn,
          protocol: SASProtocol.Https,
        }, key, ACCOUNT).toString();
        out[blobPath] = ACCOUNT_URL + "/" + parsed.container + "/" +
          blobPath.split("/").map(encodeURIComponent).join("/") + "?" + sas;
      }

      context.log("signed " + parsed.paths.length + " path(s) in " + parsed.container +
        " for " + oid + " (" + parsed.permissions + ", " + parsed.expiresIn + "s)");

      return {
        status: 200,
        headers: Object.assign(corsHeaders(), { "Cache-Control": "no-store" }),
        jsonBody: { urls: out, expiresIn: parsed.expiresIn },
      };
    } catch (err) {
      context.error("sas signing failed: " + (err && err.message));
      return { status: 502, headers: corsHeaders(), jsonBody: { error: "Could not sign the requested paths." } };
    }
  },
});
