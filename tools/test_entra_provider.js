"use strict";
// Microsoft Entra ID provider — behaviour, without a tenant.
//
// The Entra provider cannot be proven end-to-end without a real directory, but
// the part that MATTERS most is pure mapping and can be pinned here: turning an
// MSAL auth result into the session shape the rest of the app reads, and in
// particular resolving user.id from the `oid` claim. That value is what
// auth.uid() returns in supabase/sql/azure_auth_uid_shim.sql, so if this
// mapping is wrong every one of the 349 RLS policies silently denies.
//
// MSAL is replaced with a fake that answers exactly as the real one does for
// the calls this provider makes. That is enough to catch the failure modes that
// are actually likely: a renamed claim, a lost expiry, a password path that
// stops throwing.
//   Run: node tools/test_entra_provider.js
const path = require("path");
const { ROOT } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

console.log("=== Microsoft Entra ID provider ===\n");

const OID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "99999999-8888-7777-6666-555555555555";
const EXPIRES = new Date(Date.now() + 3600 * 1000);

const CLAIMS = {
  oid: OID,
  preferred_username: "alex.khoury@example.com",
  name: "Alex Khoury",
  amr: ["pwd", "mfa"],
  exp: Math.floor(EXPIRES.getTime() / 1000),
};
const ACCOUNT = {
  username: "alex.khoury@example.com",
  name: "Alex Khoury",
  localAccountId: "fallback-local-id",
  idTokenClaims: CLAIMS,
};

let requestedScopes = null, loginRedirectCalled = false;

function FakePCA(config) { this.config = config; this._active = null; }
FakePCA.prototype.initialize = function () { return Promise.resolve(); };
FakePCA.prototype.handleRedirectPromise = function () { return Promise.resolve(null); };
FakePCA.prototype.getAllAccounts = function () { return [ACCOUNT]; };
FakePCA.prototype.getActiveAccount = function () { return this._active; };
FakePCA.prototype.setActiveAccount = function (a) { this._active = a; };
FakePCA.prototype.acquireTokenSilent = function (req) {
  requestedScopes = req.scopes;
  return Promise.resolve({ accessToken: "tok-abc123", expiresOn: EXPIRES, idTokenClaims: CLAIMS });
};
FakePCA.prototype.loginRedirect = function () { loginRedirectCalled = true; };
FakePCA.prototype.logoutRedirect = function () { return Promise.resolve(); };

global.window = {
  CX_CONFIG: { IDENTITY: "entra", ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT },
  msal: { PublicClientApplication: FakePCA },
};
global.location = { origin: "https://portal.example.com", pathname: "/" };

delete require.cache[require.resolve(path.resolve(ROOT, "cx-auth-provider.js"))];
const { providers, selected } = require(path.resolve(ROOT, "cx-auth-provider.js"));
const entra = providers.entra;

ok("CX_CONFIG.IDENTITY='entra' selects the Entra provider", selected.kind === "entra");

entra.getSession().then(({ data, error }) => {
  const s = data.session;
  ok("a session is produced from the MSAL result", !!s, JSON.stringify(error));
  if (s) {
    ok("user.id is the `oid` claim — the value auth.uid() resolves", s.user.id === OID, s.user.id);
    ok("user.id is a uuid, so the ::uuid cast in auth.uid() succeeds",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.user.id));
    ok("access_token is carried through", s.access_token === "tok-abc123");
    ok("expires_at is seconds, not milliseconds",
      Math.abs(s.expires_at - Math.floor(EXPIRES.getTime() / 1000)) < 2, String(s.expires_at));
    ok("the refresh token is NOT exposed to page script", s.refresh_token === null);
    ok("email comes from preferred_username", s.user.email === CLAIMS.preferred_username);
    ok("full_name is mapped for the profile join", s.user.user_metadata.full_name === "Alex Khoury");
    ok("`amr` is carried through for private.mfa_ok()", s.user.amr.indexOf("mfa") !== -1);
    ok("provider is recorded as entra", s.user.app_metadata.provider === "entra");
  }

  ok("the API scope defaults to api://<client-id>/access_as_user",
    requestedScopes && requestedScopes[0] === "api://" + CLIENT + "/access_as_user",
    JSON.stringify(requestedScopes));

  ok("authHeader() is synchronous and returns the bearer token",
    entra.authHeader() === "Bearer tok-abc123", entra.authHeader());

  ok("storeSession() does not throw — it is a documented no-op",
    (() => { try { entra.storeSession({}); return true; } catch (e) { return false; } })());

  return entra.signIn({ email: "x", password: "y" }).then((r) => {
    ok("signIn() triggers loginRedirect", loginRedirectCalled);
    ok("signIn() resolves instead of hanging, so app.js's 12s timeout never fires",
      r && r.error === null);

    const pwOps = ["resetPassword", "updatePassword", "createUser", "directGrant"];
    return Promise.all(pwOps.map((op) =>
      Promise.resolve(entra[op]()).then(() => null, (e) => e.message)));
  }).then((msgs) => {
    ok("every credential operation still refuses, with actionable text",
      msgs.every((m) => m && /Entra ID/.test(m) && /managed by IT/.test(m)),
      JSON.stringify(msgs));

    console.log(`\n${pass} passed, ${fail} failed.\n`);
    process.exit(fail === 0 ? 0 : 1);
  });
}).catch((e) => { console.error(e); process.exit(1); });
