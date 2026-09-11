"use strict";
// Identity provider seam guard (cx-auth-provider.js) — Azure migration.
//
// The seam is only worth anything if it stays the ONLY way the app talks to an
// identity provider. This pins that: no direct `_sb.auth.*` call may come back
// into the monolith, and any provider added later must implement the whole
// interface rather than silently missing a method that then fails in the field.
//   Run: node tools/test_identity_seam.js
const fs = require("fs");
const path = require("path");
const { loadApp, ROOT } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

console.log("=== identity provider seam (Azure migration) ===\n");

const mod = require(path.resolve(ROOT, "cx-auth-provider.js"));
const { providers, selected } = mod;

ok("a supabase provider exists", !!providers.supabase);
ok("an entra provider exists", !!providers.entra);
ok("supabase is the default until CX_CONFIG.IDENTITY says otherwise", selected.kind === "supabase");

// The interface contract: whatever a provider is, it implements all of it.
const REQUIRED = [
  "kind", "managesPasswords", "storageKey", "storedSession", "storeSession",
  "authHeader", "ensureFresh", "signIn", "signOut", "getSession",
  "onAuthStateChange", "resetPassword", "updatePassword", "createUser", "directGrant",
];
for (const name of Object.keys(providers)) {
  const missing = REQUIRED.filter((k) => providers[name][k] === undefined);
  ok(`${name} implements the full interface`, missing.length === 0, "missing: " + missing.join(", "));
}
const shapes = Object.keys(providers).map((n) =>
  REQUIRED.filter((k) => typeof providers[n][k] === "function").sort().join(","));
ok("both providers expose the same callable shape", new Set(shapes).size === 1);

// Entra does not own passwords — those paths must fail loudly, not silently.
ok("supabase declares it manages passwords", providers.supabase.managesPasswords === true);
ok("entra declares it does NOT manage passwords", providers.entra.managesPasswords === false);
const pwOps = ["resetPassword", "updatePassword", "createUser"];
Promise.all(pwOps.map((op) =>
  Promise.resolve(providers.entra[op]()).then(() => null, (e) => e.message)
)).then((msgs) => {
  ok("entra rejects every password operation with actionable text",
    msgs.every((m) => m && /Entra ID/.test(m) && /managed by IT/.test(m)),
    JSON.stringify(msgs));

  // The monolith must not reacquire a direct dependency on the auth client.
  const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const stray = appJs.split(/\r?\n/)
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /_sb\.auth\./.test(l) && !/^\s*(\/\/|\*)/.test(l.trim()));
  ok("app.js has no direct _sb.auth.* calls left",
    stray.length === 0, stray.map(([n]) => "line " + n).join(", "));

  // …and it routes the token plumbing through the provider too.
  ok("app.js delegates _getAuthHeader to the provider",
    /function _getAuthHeader\(\)\s*\{\s*return window\.CXIdentity\.authHeader\(\);/.test(appJs));
  ok("app.js delegates _getSessionFromStorage to the provider",
    /function _getSessionFromStorage\(\)\s*\{\s*return window\.CXIdentity\.storedSession\(\);/.test(appJs));
  ok("app.js delegates session refresh to the provider",
    /_ensureFreshSession\(\)\s*\{\s*return window\.CXIdentity\.ensureFresh\(\);/.test(appJs));

  // The storage key must follow config.js, not a hardcoded project ref.
  const configJs = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  const ref = (configJs.match(/SUPABASE_URL:\s*'https:\/\/([a-z0-9]+)\./) || [])[1];
  global.window = { CX_CONFIG: { SUPABASE_URL: "https://" + ref + ".supabase.co" } };
  ok("the session storage key is derived from config.js",
    providers.supabase.storageKey() === `sb-${ref}-auth-token`,
    providers.supabase.storageKey());
  delete global.window;

  // And the seam survives a real bundle load.
  const { sandbox, loadError, loadErrorFile } = loadApp();
  ok("the bundle boots with the provider wired in", !loadError,
    loadError ? loadErrorFile + ": " + loadError.message : "");
  if (!loadError) {
    ok("window.CXIdentity is live on the booted bundle", typeof sandbox.CXIdentity === "object");
  }

  console.log(`\n${pass} passed, ${fail} failed.\n`);
  process.exit(fail === 0 ? 0 : 1);
});
