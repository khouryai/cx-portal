"use strict";
// Authentication hardening guard (cx-auth-hardening.js).
//
// Covers the decision logic behind the authentication hardening, which is
// exactly the part that must not drift:
//   I.2-4-2(10) password policy — length + character classes + inference
//   I.2-4-2(20) six-monthly rotation, including the "never recorded" case
//   I.2-4-2(30) lockout messaging from auth_login_gate()
//   I.2-1-1     which accounts multifactor authentication is demanded from
// and asserts the module actually installs its wrappers over the real bundle.
//   Run: node tools/test_auth_hardening.js
const path = require("path");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

console.log("=== authentication hardening ===\n");

const CXAuth = require(path.resolve(__dirname, "..", "cx-auth-hardening.js"));

// ── password policy — I.2-4-2(10) ────────────────────────────────────────────
ok("policy minimum comfortably exceeds the six-character floor", CXAuth.POLICY.minLength >= 8);

ok("counts character classes", CXAuth.passwordClasses("aB3$") === 4);
ok("counts a single class", CXAuth.passwordClasses("aaaa") === 1);
ok("empty password has no classes", CXAuth.passwordClasses("") === 0);

ok("rejects a short password", CXAuth.checkPassword("Ab3$xy").ok === false);
ok("rejects a long but single-class password", CXAuth.checkPassword("aaaaaaaaaaaaaaaa").ok === false);
ok("accepts a compliant password", CXAuth.checkPassword("Trackside-42-Yard").ok === true,
  JSON.stringify(CXAuth.checkPassword("Trackside-42-Yard").errors));
ok("rejects a password containing the email name",
  CXAuth.checkPassword("akhoury-Winter-2026", { email: "akhoury@hitachirail.com" }).ok === false);
ok("rejects common sequences", CXAuth.checkPassword("Qwerty-123456-ab").ok === false);
ok("rejects the project's own words", CXAuth.checkPassword("Hitachi-Portal-99").ok === false);
ok("reports at least one human-readable reason", CXAuth.checkPassword("short").errors.length > 0);
ok("treats null/undefined as a failure", CXAuth.checkPassword(null).ok === false);

// ── rotation — I.2-4-2(20) ───────────────────────────────────────────────────
const NOW = Date.parse("2026-09-10T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

ok("age is measured in whole days", CXAuth.passwordAgeDays(daysAgo(30), NOW) === 30);
ok("age of an unrecorded change is null", CXAuth.passwordAgeDays(null, NOW) === null);
ok("age of a malformed date is null", CXAuth.passwordAgeDays("not-a-date", NOW) === null);

ok("a fresh password is not expired",
  CXAuth.passwordExpired({ password_changed_at: daysAgo(10) }, NOW) === false);
ok("a password just inside six months is not expired",
  CXAuth.passwordExpired({ password_changed_at: daysAgo(179) }, NOW) === false);
ok("a password at six months IS expired",
  CXAuth.passwordExpired({ password_changed_at: daysAgo(180) }, NOW) === true);
ok("an unrecorded change date counts as expired (accounts predating the clock)",
  CXAuth.passwordExpired({ password_changed_at: null }, NOW) === true);
ok("a profile with no field at all counts as expired",
  CXAuth.passwordExpired({}, NOW) === true);

// ── MFA applicability — I.2-1-1 ──────────────────────────────────────────────
ok("MFA is required by default", CXAuth.mfaRequired({}) === true);
ok("MFA is required when the flag is true", CXAuth.mfaRequired({ mfa_enforced: true }) === true);
ok("MFA is waived only by an explicit false", CXAuth.mfaRequired({ mfa_enforced: false }) === false);
ok("a missing profile still demands MFA", CXAuth.mfaRequired(null) === true);

// ── lockout messaging — I.2-4-2(30) ──────────────────────────────────────────
ok("an unlocked gate does not block",
  CXAuth.lockoutDecision({ locked: false, remaining: 5 }).blocked === false);
ok("an unlocked gate with attempts to spare says nothing",
  CXAuth.lockoutDecision({ locked: false, remaining: 5 }).message === "");
ok("the last attempts are warned about",
  /1 attempt left/.test(CXAuth.lockoutDecision({ locked: false, remaining: 1 }).message));
ok("a locked gate blocks", CXAuth.lockoutDecision({ locked: true, retry_after: 600 }).blocked === true);
ok("a locked gate reports the wait in minutes",
  /10 minutes/.test(CXAuth.lockoutDecision({ locked: true, retry_after: 600 }).message));
ok("a sub-minute wait reads naturally",
  /a minute/.test(CXAuth.lockoutDecision({ locked: true, retry_after: 20 }).message));
ok("a missing gate response fails open (no block)",
  CXAuth.lockoutDecision(null).blocked === false);

// ── installation over the real bundle ────────────────────────────────────────
const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) {
  ok("bundle loads with cx-auth-hardening.js in it", false, loadErrorFile + ": " + loadError.message);
} else {
  ok("bundle loads with cx-auth-hardening.js in it", true);
  ok("CXAuth is exposed on the bundle", typeof sandbox.CXAuth === "object");
  ok("signIn is wrapped", typeof sandbox.signIn === "function" && sandbox.signIn.__cxWrapped === true);
  ok("_loadCurrentProfile is wrapped",
    typeof sandbox._loadCurrentProfile === "function" && sandbox._loadCurrentProfile.__cxWrapped === true);
  ok("the original _loadCurrentProfile is kept for resuming after a gate",
    typeof sandbox.__cxOrigLoadCurrentProfile === "function");
  ok("submitChangePassword is wrapped",
    typeof sandbox.submitChangePassword === "function" && sandbox.submitChangePassword.__cxWrapped === true);
  const acts = ["cxMfaVerify", "cxMfaActivate", "cxMfaRestart", "cxAuthCancel"];
  const missing = acts.filter((a) => !(sandbox.CXActions && sandbox.CXActions.has(a)));
  ok("every MFA card action is registered", missing.length === 0, "missing: " + missing.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
