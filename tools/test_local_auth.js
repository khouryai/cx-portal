"use strict";
// Email + password sign-in on the Azure stack, proven against a real PostgreSQL.
//
// supabase/sql/azure_local_auth.sql replaces GoTrue — the component the Azure
// build left behind — with a login() function inside the database. The thing
// that makes it work or silently fail is the TOKEN: PostgREST verifies the
// HMAC signature itself and says almost nothing useful when it does not match,
// so this suite verifies the signature independently with node's crypto against
// the same secret, and then checks every claim something actually reads:
//
//   sub    -> auth.uid(), and therefore all 349 RLS policies
//   roles  -> PGRST_JWT_ROLE_CLAIM_KEY '.roles[0]', the role switch off `anon`
//   aal    -> private.mfa_ok()
//   exp    -> PostgREST's own expiry check
//
// SKIPS CLEANLY when no PostgreSQL server is available.
//   Run: node tools/test_local_auth.js
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.CX_PGPORT || "5433";
const HOST = "127.0.0.1";
const DB = "cx_local_auth";
const SECRET = "test-secret-at-least-32-characters-long-for-hs256";
const UID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "alex@hitachirail.com";
const PASSWORD = "Correct-Horse-99!";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

function psql(sql, db) {
  const r = spawnSync("psql", [
    "-q", "-h", HOST, "-p", PORT, "-U", "postgres", "-d", db || "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "psql failed").trim());
  return r.stdout.trim();
}

/** Run SQL expected to fail, and return the error message. */
function psqlFails(sql, db) {
  try { psql(sql, db); return null; }
  catch (e) { return String(e.message).replace(/^ERROR:\s*/m, "").split("\n")[0].trim(); }
}

function runFile(rel) {
  execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB,
    "-v", "ON_ERROR_STOP=1", "-f", path.join(ROOT, rel)], { stdio: "pipe" });
}

// ── availability ────────────────────────────────────────────────────────────
try { psql("select 1"); }
catch (e) {
  console.log(`SKIPPED: no PostgreSQL reachable on ${HOST}:${PORT} (${String(e.message).split("\n")[0]})`);
  console.log("  Start one with:  initdb -D /tmp/pgdata -U postgres --auth=trust");
  console.log("                   pg_ctl -D /tmp/pgdata -o '-p 5433' start");
  console.log("\n0 passed, 0 failed.");
  process.exit(0);
}

console.log("=== local email/password auth on the Azure stack ===\n");

psql(`drop database if exists ${DB}`);
psql(`create database ${DB}`);

// Roles PostgREST switches between, and the slice of the real schema that
// login() reads. `private` usage is granted here because the live database
// already grants it (every RLS policy routes through private.has_module_perm);
// azure_local_auth.sql deliberately does not re-grant a schema it does not own.
psql(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists private;
  grant usage on schema private to anon, authenticated;
  create table public.profiles (
    id uuid primary key, email text not null, full_name text, role text default 'user',
    is_active boolean default true, must_change_password boolean default false,
    mfa_enforced boolean default false, password_changed_at timestamptz
  );
  insert into public.profiles (id, email, full_name)
  values ('${UID}', '${EMAIL}', 'Alex Khoury');
`, DB);

runFile("supabase/sql/azure_auth_uid_shim.sql");
ok("azure_auth_uid_shim.sql applies to stock PostgreSQL", true);
runFile("supabase/sql/azure_local_auth.sql");
ok("azure_local_auth.sql applies on top of it", true);

// The ORIGINAL mfa_ok from supabase_auth_hardening.sql §7, verbatim. If
// azure_local_auth.sql did not recreate auth.mfa_factors, this would error on
// every authorization check rather than returning a boolean.
psql(`
  create or replace function private.mfa_ok() returns boolean language sql stable security definer
  set search_path to 'public' as $$
    select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
        or not exists (select 1 from auth.mfa_factors f
                       where f.user_id = (select auth.uid()) and f.status = 'verified');
  $$;
`, DB);

psql(`select auth.set_jwt_secret('${SECRET}')`, DB);

// ── 1. seeding a credential ─────────────────────────────────────────────────
const seeded = psql(`select auth.set_password('${EMAIL}', '${PASSWORD}')`, DB);
ok("auth.set_password() seeds a credential against the EXISTING profile id",
  seeded === UID, seeded);
ok("…and starts the six-monthly rotation clock cx-auth-hardening.js reads",
  psql(`select password_changed_at is not null from public.profiles where id = '${UID}'`, DB) === "t");

ok("a short password is refused in the database, not only the browser",
  /at least 12 characters/i.test(psqlFails(`select auth.set_password('${EMAIL}', 'short1!A')`, DB) || ""));
ok("a password with too few character classes is refused",
  /3 of/i.test(psqlFails(`select auth.set_password('${EMAIL}', 'aaaaaaaaaaaaaaa')`, DB) || ""));
ok("seeding a password for an unknown profile is refused",
  /No profile with email/i.test(psqlFails(`select auth.set_password('ghost@x.com', '${PASSWORD}')`, DB) || ""));

// ── 2. login ────────────────────────────────────────────────────────────────
const session = JSON.parse(psql(`select public.login('${EMAIL}', '${PASSWORD}')`, DB));
ok("login() returns the supabase-js session shape the app already reads",
  !!session.access_token && session.token_type === "bearer" &&
  !!session.expires_at && session.user && session.user.id === UID,
  JSON.stringify(Object.keys(session)));

const wrong = psqlFails(`select public.login('${EMAIL}', 'not-the-password')`, DB);
const unknown = psqlFails(`select public.login('nobody@example.com', 'anything')`, DB);
ok("a wrong password is rejected", /Invalid login credentials/.test(wrong || ""), wrong);
ok("an unknown account gives the IDENTICAL message — no account enumeration",
  wrong === unknown, `${wrong} vs ${unknown}`);

psql(`update public.profiles set is_active = false where id = '${UID}'`, DB);
ok("a deactivated profile cannot sign in",
  /deactivated/i.test(psqlFails(`select public.login('${EMAIL}', '${PASSWORD}')`, DB) || ""));
psql(`update public.profiles set is_active = true where id = '${UID}'`, DB);

// ── 3. THE TOKEN — verified independently, as PostgREST will ────────────────
const [h, p, s] = session.access_token.split(".");
const expected = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
ok("the HMAC-SHA256 signature verifies against PGRST_JWT_SECRET", s === expected,
  "PostgREST would reject this with JWSError and no useful detail");

const header = JSON.parse(Buffer.from(h, "base64url").toString());
const claims = JSON.parse(Buffer.from(p, "base64url").toString());
ok("the header declares HS256", header.alg === "HS256" && header.typ === "JWT", JSON.stringify(header));
ok("sub is the profile id — auth.uid() falls back to it, so no re-keying",
  claims.sub === UID, claims.sub);
ok("roles is an ARRAY — PGRST_JWT_ROLE_CLAIM_KEY is '.roles[0]'",
  Array.isArray(claims.roles) && claims.roles[0] === "authenticated", JSON.stringify(claims.roles));
ok("role is also present for policies that call auth.role()",
  claims.role === "authenticated");
ok("aud matches the PGRST_JWT_AUD the runbook sets",
  claims.aud === "cx-portal", claims.aud);
ok("the token expires in eight hours, not never",
  claims.exp - claims.iat === 8 * 3600, String(claims.exp - claims.iat));

// ── 4. what the database makes of that token ────────────────────────────────
const asUser = (sql) => psql(
  `begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);` +
  ` set local role authenticated; ${sql}; commit;`, DB).split("\n").pop().trim();

ok("auth.uid() resolves to the signed-in user", asUser("select auth.uid()") === UID);
ok("auth.role() resolves to authenticated", asUser("select auth.role()") === "authenticated");
ok("auth.email() resolves", asUser("select auth.email()") === EMAIL);
ok("private.mfa_ok() PASSES — the original definition, no verified factor",
  asUser("select private.mfa_ok()") === "t",
  "false here denies every governed table and shows as a signed-in but empty app");
ok("auth.users is NOT readable by the authenticated role",
  asUser("select has_table_privilege('auth.users','select')") === "f");
ok("the signing secret is NOT readable by the authenticated role",
  asUser("select has_table_privilege('private.auth_secrets','select')") === "f");

// ── 5. refresh ──────────────────────────────────────────────────────────────
const refreshed = JSON.parse(asUser("select public.auth_refresh()"));
ok("auth_refresh() re-mints a session for the bearer of a valid token",
  !!refreshed.access_token && refreshed.user.id === UID);
const rclaims = JSON.parse(Buffer.from(refreshed.access_token.split(".")[1], "base64url").toString());
ok("…with the same subject and a later expiry", rclaims.sub === UID && rclaims.exp >= claims.exp);
// Two independent defences, and the grant is the one that fires first: anon
// never reaches the function body at all. The in-body check still matters for
// an `authenticated` session carrying no claims, so both are asserted.
ok("auth_refresh() is unreachable by anon — blocked by the grant, before any code runs",
  /permission denied for function/i.test(
    psqlFails(`begin; set local role anon; select public.auth_refresh(); commit;`, DB) || ""));
ok("…and refuses an authenticated session with no claims",
  /Not signed in/i.test(psqlFails(
    `begin; set local role authenticated; select public.auth_refresh(); commit;`, DB) || ""));

// ── 6. change_password ──────────────────────────────────────────────────────
const NEWPW = "Another-Real-Passphrase-7!";
ok("change_password() rejects a WRONG current password when one is offered",
  /not correct/i.test(psqlFails(
    `begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);` +
    ` set local role authenticated; select public.change_password('nope','${NEWPW}'); commit;`, DB) || ""));
// Supabase's updateUser({password}) did not require the old password either, and
// neither change-password card in index.html has a field for one. Omitting it
// must therefore be allowed, or first sign-in breaks. See the note on the
// function in azure_local_auth.sql for the trade-off this represents.
ok("…and ACCEPTS a null current password, as GoTrue did",
  psqlFails(
    `begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);` +
    ` set local role authenticated; select public.change_password(null,'Interim-Passphrase-3!'); commit;`, DB) === null);
ok("change_password() enforces the policy on the NEW password",
  /12 characters/i.test(psqlFails(
    `begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);` +
    ` set local role authenticated; select public.change_password(null,'weak'); commit;`, DB) || ""));
ok("change_password() refuses reuse of the password already set",
  /not used before/i.test(psqlFails(
    `begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);` +
    ` set local role authenticated; select public.change_password(null,'Interim-Passphrase-3!'); commit;`, DB) || ""));

asUser(`select public.change_password('Interim-Passphrase-3!','${NEWPW}')`);
ok("the new password works", !!JSON.parse(psql(`select public.login('${EMAIL}','${NEWPW}')`, DB)).access_token);
ok("the original password no longer works",
  /Invalid login credentials/.test(psqlFails(`select public.login('${EMAIL}','${PASSWORD}')`, DB) || ""));
ok("…and must_change_password is cleared, so the card does not reappear",
  psql(`select must_change_password from public.profiles where id='${UID}'`, DB) === "f");

// ── 7. the reachability control ─────────────────────────────────────────────
// PGRST_DB_SCHEMAS=public, so anything in `auth` is unreachable over HTTP
// whatever role is presented. That is what keeps set_password psql-only.
ok("auth.set_password lives outside the PostgREST-exposed schema",
  psql(`select n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'set_password'`, DB) === "auth");
ok("public.login is executable by anon (it must be — nobody is signed in yet)",
  psql(`select has_function_privilege('anon', 'public.login(text,text)', 'execute')`, DB) === "t");
ok("public.change_password is NOT executable by anon",
  psql(`select has_function_privilege('anon', 'public.change_password(text,text)', 'execute')`, DB) === "f");

psql(`drop database if exists ${DB}`);
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
