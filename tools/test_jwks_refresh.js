"use strict";
// Sign-in key refresh, end to end (Azure migration).
//
// PostgREST verifies Entra tokens against Microsoft's signing keys, which it
// cannot fetch for itself, and Microsoft rotates them every few weeks. The fix
// is supabase/sql/azure_pgrst_jwks.sql plus the 'jwks-refresh' sidecar in
// infra/main.bicep. This runs the sidecar's EXACT script (read out of
// main.bicep) against a real PostgreSQL and a real PostgREST, rotates the keys,
// and checks sign-in follows the rotation with no restart.
//
// Needs PostgreSQL on 127.0.0.1:5433 (superuser `postgres`, trust auth), a
// `postgrest` binary (PATH or POSTGREST_BIN) and `wget`; skips cleanly without.
//   Run: node tools/test_jwks_refresh.js
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PG = { host: "127.0.0.1", port: "5433" };
const DB = "cx_jwks_test";
const AUD = "11111111-1111-1111-1111-111111111111";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function skip(why) { console.log("SKIPPED: " + why + "\n0 passed, 0 failed."); process.exit(0); }

console.log("=== sign-in key refresh (Azure migration) ===\n");

function which(cmd) { const r = spawnSync("sh", ["-c", "command -v " + cmd]); return r.status === 0 ? String(r.stdout).trim() : null; }
const POSTGREST = process.env.POSTGREST_BIN || which("postgrest");
if (!POSTGREST) skip("no postgrest binary (set POSTGREST_BIN)");
if (!which("wget") || !which("psql")) skip("wget and psql are needed");
const pg = (db, sql) => execFileSync("psql", ["-h", PG.host, "-p", PG.port, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
try { pg("postgres", "select 1"); } catch (e) { skip("no PostgreSQL reachable on 127.0.0.1:5433"); }

// ── The script, exactly as deployed ──
const bicep = fs.readFileSync(path.join(ROOT, "infra/main.bicep"), "utf8");
const m = bicep.match(/var jwksRefreshScript = '''\n([\s\S]*?)'''/);
ok("main.bicep carries the jwks-refresh script", !!m);
const SCRIPT = m ? m[1] : "exit 1";
ok("the sidecar runs that script and reloads every few hours",
  /name: 'jwks-refresh'[\s\S]*?jwksRefreshScript[\s\S]*?REFRESH_SECONDS/.test(bicep));
ok("PostgREST reads its keys from the database", /PGRST_DB_PRE_CONFIG', value: 'private\.pgrst_pre_config'/.test(bicep));
ok("no stale literal key set is configured", !/PGRST_JWT_SECRET/.test(bicep));

// ── A clean database with the gateway's roles ──
pg("postgres", `drop database if exists ${DB}`);
pg("postgres", `create database ${DB}`);
pg(DB, `do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'authpw'; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant anon, authenticated to authenticator;
create function public.whoami() returns text language sql stable as $f$ select current_user::text $f$;
grant execute on function public.whoami() to anon, authenticated;`);
execFileSync("psql", ["-h", PG.host, "-p", PG.port, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq",
  "-f", path.join(ROOT, "supabase/sql/azure_pgrst_jwks.sql")], { stdio: ["ignore", "pipe", "pipe"] });
const DB_URI = `postgres://authenticator:authpw@${PG.host}:${PG.port}/${DB}`;

// ── Keys shaped like Entra's (no "alg"; x5t, issuer …) ──
function makeKey(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  // x5t is a SHA-1 thumbprint (20 bytes) in real Entra keys; a malformed one
  // makes PostgREST reject the key, so the fake must be well-formed too.
  const x5t = crypto.randomBytes(20).toString("base64url");
  return { kid, privateKey, jwk: { kty: "RSA", use: "sig", kid, x5t, n: jwk.n, e: jwk.e,
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" } };
}
const entraSample = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/entra_jwks_sample.json"), "utf8")).keys;
const k1 = makeKey("key-one"), k2 = makeKey("key-two");
const b64u = (b) => Buffer.from(b).toString("base64url");
function token(k) {
  const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: k.kid }));
  const p = b64u(JSON.stringify({ aud: AUD, roles: ["authenticated"], oid: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 600 }));
  return h + "." + p + "." + crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), k.privateKey).toString("base64url");
}

// ── Microsoft's key endpoint, played by a local server ──
let served = "";
const keySrv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(served); });

// Async on purpose: the key server lives in this process and must keep serving.
function runScript() {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", SCRIPT], { env: { ...process.env, PGRST_DB_URI: DB_URI,
      JWKS_URL: `http://127.0.0.1:${keySrv.address().port}/keys`, RUN_ONCE: "1" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => child.kill(), 30000);
    child.on("close", () => { clearTimeout(t); resolve(out.trim()); });
  });
}

async function whoami(port, tok) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc/whoami`, { headers: tok ? { Authorization: "Bearer " + tok } : {} });
    return res.ok ? await res.json() : res.status;
  } catch (e) { return "down"; }
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); }
}

(async () => {
  await new Promise((r) => keySrv.listen(0, "127.0.0.1", r));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const api = spawn(POSTGREST, [], { env: { ...process.env,
    PGRST_DB_URI: DB_URI, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon",
    PGRST_DB_PRE_CONFIG: "private.pgrst_pre_config", PGRST_JWT_ROLE_CLAIM_KEY: ".roles[0]",
    PGRST_JWT_AUD: AUD, PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: "127.0.0.1" }, stdio: "ignore" });
  try {
    ok("PostgREST starts before any keys exist (sidecar not run yet)",
      (await until(async () => (await whoami(port)) === "anon")) === true);
    ok("…and refuses a token until keys arrive", (await whoami(port, token(k1))) !== "authenticated");

    served = JSON.stringify({ keys: [...entraSample, k1.jwk] });
    const out1 = await runScript();
    ok("first run loads the keys", /new keys loaded/.test(out1), out1);
    ok("a signed-in user is accepted, with no restart (real Entra key format)",
      (await until(async () => (await whoami(port, token(k1))) === "authenticated")) === true);
    ok("running again with the same keys changes nothing", /keys unchanged/.test(await runScript()));

    // Microsoft rotates: key-one retired, key-two in.
    served = JSON.stringify({ keys: [...entraSample, k2.jwk] });
    ok("a rotation is picked up", /new keys loaded/.test(await runScript()));
    ok("tokens signed with the new key are accepted",
      (await until(async () => (await whoami(port, token(k2))) === "authenticated")) === true);
    ok("tokens signed with the retired key are refused", (await whoami(port, token(k1))) === 401);

    served = "<html>proxy error</html>";
    const bad = await runScript();
    ok("a bad download is reported and changes nothing", /refresh failed/.test(bad) &&
      (await whoami(port, token(k2))) === "authenticated", bad);
    served = JSON.stringify({ keys: [] });
    await runScript();
    ok("an empty key set is refused, so nobody gets locked out", (await whoami(port, token(k2))) === "authenticated");

    const asUser = spawnSync("psql", [DB_URI, "-XAtq", "-c", "set role authenticated; select private.set_pgrst_jwks('{}')"], { encoding: "utf8" });
    ok("a signed-in user's database role cannot replace the keys", asUser.status !== 0);
  } finally {
    api.kill();
    keySrv.close();
    try { pg("postgres", `drop database if exists ${DB} with (force)`); } catch (e) { /* best effort */ }
  }
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
