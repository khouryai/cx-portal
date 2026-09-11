// ==========================================
// HITACHI Rail T&C Portal — Authentication hardening (cx-auth-hardening.js)
//
// The browser half of the authentication hardening. Pairs with
// supabase/sql/supabase_auth_hardening.sql, which carries the server-side half
// (the real enforcement — see the note on gate failure below).
//
//   Multifactor authentication (TOTP) — forced enrolment, then a challenge on
//   every sign-in until the session reaches AAL2.
//   Password policy: length + character classes.
//   Password rotation: six-monthly, tracked in profiles.password_changed_at.
//   Lockout: the sign-in screen consults auth_login_gate().
//   Authentication events (success, failure, blocked, MFA, password change)
//   recorded in auth_events.
//
// WHY THIS FILE LOADS *AFTER* app.js (the other extracted modules load before):
// it does not add new surface, it CONSTRAINS existing surface. It wraps
// signIn(), _loadCurrentProfile() and submitChangePassword() in place, so the
// functions have to exist first. Wrapping rather than editing keeps every line
// of this work out of the monolith (CLAUDE.md: app.js only shrinks) and means
// the sign-in path's timeout/fallback logic is untouched.
//
// FAIL-OPEN, DELIBERATELY: if a gate check itself fails (network down, RPC
// missing because the migration has not been applied yet) the user is let
// through to the normal flow. That is safe because the browser is NOT the
// enforcement point — private.has_module_perm() refuses every governed table to
// a session that has not cleared MFA, so an AAL1 session that slips past this
// file sees an empty app rather than data. Failing closed here would instead
// lock everyone out of a working system on a transient error.
// ==========================================
(function () {
  'use strict';

  // ── Policy ────────────────────────────────────────────────────────────────
  // The corporate baseline is six or more characters, eight preferred; the
  // portal sets a higher bar. Keep these in step with the
  // Supabase Auth password settings in the dashboard, which enforce the same
  // minimum server-side for password *reset* flows this file does not see.
  var POLICY = {
    minLength: 12,
    minClasses: 3,          // of: lower, upper, digit, symbol
    maxAgeDays: 180,        // six months — I.2-4-2(20)
    lockoutMax: 5,          // matches auth_login_gate() — I.2-4-2(30)
    lockoutWindowMinutes: 15,
  };

  // ── Pure helpers (unit-tested in tools/test_auth_hardening.js) ────────────

  /**
   * Count the distinct character classes present in a password.
   * @param {string} pw
   * @returns {number} 0-4
   */
  function passwordClasses(pw) {
    var s = String(pw || '');
    var n = 0;
    if (/[a-z]/.test(s)) n++;
    if (/[A-Z]/.test(s)) n++;
    if (/[0-9]/.test(s)) n++;
    if (/[^A-Za-z0-9]/.test(s)) n++;
    return n;
  }

  /**
   * Validate a candidate password against the portal policy.
   * @param {string} pw
   * @param {{email?: string, policy?: object}} [opts]
   * @returns {{ok: boolean, errors: string[]}}
   */
  function checkPassword(pw, opts) {
    opts = opts || {};
    var p = opts.policy || POLICY;
    var s = String(pw || '');
    var errors = [];
    if (s.length < p.minLength) {
      errors.push('Use at least ' + p.minLength + ' characters.');
    }
    if (passwordClasses(s) < p.minClasses) {
      errors.push('Mix at least ' + p.minClasses + ' of: lower case, upper case, numbers, symbols.');
    }
    // "passwords that other persons cannot easily infer" — I.2-4-2(40).
    var local = String(opts.email || '').split('@')[0];
    if (local && local.length >= 3 && s.toLowerCase().indexOf(local.toLowerCase()) !== -1) {
      errors.push('Do not include your email name in the password.');
    }
    if (/^(.)\1+$/.test(s)) errors.push('Do not repeat a single character.');
    if (/(012345|123456|abcdef|qwerty|password|hitachi|portal)/i.test(s)) {
      errors.push('Avoid common words and sequences (including "hitachi" and "portal").');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * Age of the current password in whole days.
   * @param {string|null} changedAtIso
   * @param {number} [nowMs]
   * @returns {number|null} null when never recorded
   */
  function passwordAgeDays(changedAtIso, nowMs) {
    if (!changedAtIso) return null;
    var t = Date.parse(changedAtIso);
    if (isNaN(t)) return null;
    return Math.floor(((nowMs || Date.now()) - t) / 86400000);
  }

  /**
   * Does this account have to rotate its password before entering? (I.2-4-2(20))
   * An unrecorded change date counts as expired: those accounts predate the
   * rotation clock, so their password age is unknown and therefore not provably
   * inside six months.
   * @param {{password_changed_at?: string}} profile
   * @param {number} [nowMs]
   * @param {object} [policy]
   * @returns {boolean}
   */
  function passwordExpired(profile, nowMs, policy) {
    var p = policy || POLICY;
    var age = passwordAgeDays(profile && profile.password_changed_at, nowMs);
    if (age === null) return true;
    return age >= p.maxAgeDays;
  }

  /**
   * Is multifactor authentication required for this account? (I.2-1-1)
   * @param {{mfa_enforced?: boolean}} profile
   * @returns {boolean}
   */
  function mfaRequired(profile) {
    if (!profile) return true;
    return profile.mfa_enforced !== false;
  }

  /**
   * Decide what the sign-in screen should do with an auth_login_gate() result.
   * @param {{locked?: boolean, retry_after?: number, remaining?: number}} gate
   * @returns {{blocked: boolean, message: string}}
   */
  function lockoutDecision(gate) {
    if (!gate || !gate.locked) {
      var left = gate && typeof gate.remaining === 'number' ? gate.remaining : null;
      if (left !== null && left > 0 && left <= 2) {
        return { blocked: false, message: left + (left === 1 ? ' attempt' : ' attempts') + ' left before this account is locked.' };
      }
      return { blocked: false, message: '' };
    }
    var secs = Math.max(0, Number(gate.retry_after) || 0);
    var mins = Math.ceil(secs / 60);
    return {
      blocked: true,
      message: 'Too many failed sign-in attempts. This account is locked — try again in ' +
        (mins <= 1 ? 'a minute' : mins + ' minutes') + '.',
    };
  }

  // ── Environment plumbing ──────────────────────────────────────────────────

  function win() { return typeof window !== 'undefined' ? window : null; }
  function doc() { var w = win(); return w && w.document ? w.document : null; }
  function cfg() {
    var w = win();
    return (w && w.CX_CONFIG) || {};
  }
  function el(id) { var d = doc(); return d && d.getElementById ? d.getElementById(id) : null; }
  function sb() { var w = win(); return w && w._sb ? w._sb : null; }

  function warn(what, e) {
    // console.warn, never console.error: these paths are expected to fail on a
    // mocked/offline backend and the browser smoke test asserts on error level.
    try { console.warn('[auth-hardening] ' + what + ':', e && e.message ? e.message : e); } catch (_) {}
  }

  /**
   * Call a Postgres function through PostgREST. Kept as a plain fetch (rather
   * than supabase-js .rpc) because the sign-in screen has no session yet and
   * because supabase-js's auth mutex is exactly what the fallback in signIn()
   * exists to route around.
   * @param {string} name
   * @param {object} body
   * @param {number} [timeoutMs]
   * @returns {Promise<*>} null on any failure (callers fail open)
   */
  function rpc(name, body, timeoutMs) {
    var c = cfg();
    var w = win();
    if (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY || !w || typeof w.fetch !== 'function') {
      return Promise.resolve(null);
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 6000);
    var headers = { apikey: c.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
    var auth = typeof w._getAuthHeader === 'function' ? w._getAuthHeader() : null;
    if (auth) headers.Authorization = auth;
    else headers.Authorization = 'Bearer ' + c.SUPABASE_ANON_KEY;
    return w.fetch(c.SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    }).catch(function (e) {
      clearTimeout(timer);
      warn('rpc ' + name, e);
      return null;
    });
  }

  /**
   * Append an authentication event to the audit trail.
   * Fire-and-forget: an audit write must never block or fail a sign-in.
   * @param {string} email
   * @param {string} event
   * @param {string} [detail]
   * @returns {Promise<void>}
   */
  function recordAuthEvent(email, event, detail) {
    return rpc('auth_record_event', { p_email: email || '', p_event: event, p_detail: detail || null })
      .then(function () {}, function () {});
  }

  /**
   * Ask the server whether this address is currently locked out (I.2-4-2(30)).
   * @param {string} email
   * @returns {Promise<object|null>}
   */
  function loginGate(email) {
    return rpc('auth_login_gate', { p_email: email || '' });
  }

  /**
   * Read the hardening columns for the signed-in user.
   * @param {string} userId
   * @param {string} [accessToken]
   * @returns {Promise<object|null>}
   */
  function fetchAuthProfile(userId, accessToken) {
    var c = cfg();
    var w = win();
    if (!c.SUPABASE_URL || !w || typeof w.fetch !== 'function' || !userId) return Promise.resolve(null);
    var authHeader = accessToken ? 'Bearer ' + accessToken
      : (typeof w._getAuthHeader === 'function' ? w._getAuthHeader() : null);
    if (!authHeader) return Promise.resolve(null);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    var url = c.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) +
      '&select=id,email,password_changed_at,mfa_enforced,must_change_password';
    return w.fetch(url, {
      headers: { apikey: c.SUPABASE_ANON_KEY, Authorization: authHeader, Accept: 'application/json' },
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) return null;
      return res.json();
    }).then(function (rows) {
      return (rows && rows[0]) || null;
    }).catch(function (e) {
      clearTimeout(timer);
      warn('profile read', e);
      return null;
    });
  }

  function storedSession() {
    var w = win();
    if (w && typeof w._getSessionFromStorage === 'function') {
      try { return w._getSessionFromStorage(); } catch (e) { return null; }
    }
    return null;
  }

  function hasSession() {
    var s = storedSession();
    return !!(s && s.access_token);
  }

  function currentAccessToken() {
    var s = storedSession();
    return (s && s.access_token) || null;
  }

  // ── Login-overlay card switching ──────────────────────────────────────────
  // The overlay hosts several `.login-card`s; exactly one is visible.

  function showCard(id) {
    var d = doc();
    if (!d || !d.querySelectorAll) return;
    var cards = d.querySelectorAll('#login-overlay .login-card');
    Array.prototype.forEach.call(cards, function (c) { c.style.display = 'none'; });
    var target = el(id);
    if (target) target.style.display = '';
    var overlay = el('login-overlay');
    if (overlay && overlay.classList) overlay.classList.remove('hidden');
  }

  function showSignInCard() {
    var d = doc();
    if (!d || !d.querySelector) return;
    var cards = d.querySelectorAll('#login-overlay .login-card');
    Array.prototype.forEach.call(cards, function (c) { c.style.display = 'none'; });
    var signin = d.querySelector('#login-overlay .login-card:not(#cp-card):not(#mfa-card):not(#mfa-setup-card)');
    if (signin) signin.style.display = '';
    var btn = el('auth-btn');
    if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
  }

  function setText(id, text) { var e = el(id); if (e) e.textContent = text; }

  // ── State for the in-flight gate ──────────────────────────────────────────
  var pending = { user: null, accessToken: null, profile: null, factorId: null };

  // ── MFA: challenge an already-enrolled user ───────────────────────────────

  /**
   * Verify the 6-digit code from the challenge card, then resume sign-in.
   * @returns {Promise<void>}
   */
  function verifyMfaChallenge() {
    var client = sb();
    var codeEl = el('mfa-code');
    var code = codeEl ? String(codeEl.value || '').replace(/\D/g, '') : '';
    var btn = el('mfa-verify-btn');
    setText('mfa-error', '');
    if (code.length !== 6) { setText('mfa-error', 'Enter the 6-digit code from your authenticator app.'); return Promise.resolve(); }
    if (!client || !client.auth || !client.auth.mfa) { setText('mfa-error', 'Authentication service unavailable.'); return Promise.resolve(); }
    if (btn) { btn.textContent = 'Verifying…'; btn.disabled = true; }

    return client.auth.mfa.listFactors().then(function (r) {
      var list = (r && r.data && (r.data.totp || r.data.all)) || [];
      var factor = list.filter(function (f) { return f.status === 'verified'; })[0];
      if (!factor) throw new Error('No verified authenticator is registered.');
      return client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code });
    }).then(function (res) {
      if (res && res.error) throw res.error;
      if (codeEl) codeEl.value = '';
      recordAuthEvent(emailOfPending(), 'login_success', 'MFA challenge passed');
      return resumeAfterGate();
    }).catch(function (e) {
      setText('mfa-error', (e && e.message) || 'That code was not accepted.');
      recordAuthEvent(emailOfPending(), 'mfa_challenge_failure', (e && e.message) || 'code rejected');
      if (btn) { btn.textContent = 'Verify'; btn.disabled = false; }
    });
  }

  // ── MFA: first-time enrolment ─────────────────────────────────────────────

  /**
   * Create a TOTP factor and render its QR code / secret on the setup card.
   * @returns {Promise<void>}
   */
  function startMfaEnrolment() {
    var client = sb();
    setText('mfa-setup-error', '');
    if (!client || !client.auth || !client.auth.mfa) {
      setText('mfa-setup-error', 'Authentication service unavailable.');
      return Promise.resolve();
    }
    // A previous, abandoned enrolment leaves an unverified factor behind and
    // the next enroll() call is rejected for the duplicate name — clear those.
    return client.auth.mfa.listFactors().then(function (r) {
      var list = (r && r.data && (r.data.totp || r.data.all)) || [];
      var stale = list.filter(function (f) { return f.status !== 'verified'; });
      return stale.reduce(function (chain, f) {
        return chain.then(function () { return client.auth.mfa.unenroll({ factorId: f.id }).catch(function () {}); });
      }, Promise.resolve());
    }).then(function () {
      return client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'T&C Portal ' + Date.now() });
    }).then(function (res) {
      if (res && res.error) throw res.error;
      var data = res && res.data;
      if (!data || !data.totp) throw new Error('Enrolment did not return a secret.');
      pending.factorId = data.id;
      var img = el('mfa-qr');
      if (img) img.src = data.totp.qr_code;
      setText('mfa-secret', data.totp.secret || '');
    }).catch(function (e) {
      setText('mfa-setup-error', (e && e.message) || 'Could not start enrolment.');
      warn('mfa enrol', e);
    });
  }

  /**
   * Confirm the first code from the authenticator, activating the factor.
   * @returns {Promise<void>}
   */
  function activateMfa() {
    var client = sb();
    var codeEl = el('mfa-setup-code');
    var code = codeEl ? String(codeEl.value || '').replace(/\D/g, '') : '';
    var btn = el('mfa-activate-btn');
    setText('mfa-setup-error', '');
    if (code.length !== 6) { setText('mfa-setup-error', 'Enter the 6-digit code shown in your authenticator app.'); return Promise.resolve(); }
    if (!pending.factorId) { setText('mfa-setup-error', 'Enrolment expired — reload and try again.'); return Promise.resolve(); }
    if (btn) { btn.textContent = 'Activating…'; btn.disabled = true; }

    return client.auth.mfa.challengeAndVerify({ factorId: pending.factorId, code: code }).then(function (res) {
      if (res && res.error) throw res.error;
      if (codeEl) codeEl.value = '';
      recordAuthEvent(emailOfPending(), 'mfa_enrolled', 'TOTP factor activated');
      return resumeAfterGate();
    }).catch(function (e) {
      setText('mfa-setup-error', (e && e.message) || 'That code was not accepted.');
      recordAuthEvent(emailOfPending(), 'mfa_challenge_failure', 'enrolment code rejected');
      if (btn) { btn.textContent = 'Activate'; btn.disabled = false; }
    });
  }

  function emailOfPending() {
    if (pending.profile && pending.profile.email) return pending.profile.email;
    if (pending.user && pending.user.email) return pending.user.email;
    var e = el('auth-email');
    return e ? String(e.value || '').trim() : '';
  }

  /**
   * Abandon the gate and return to the sign-in card (the "not now" escape on
   * the MFA cards is deliberately a SIGN OUT, not a skip).
   * @returns {Promise<void>}
   */
  function cancelGate() {
    var client = sb();
    pending = { user: null, accessToken: null, profile: null, factorId: null };
    showSignInCard();
    if (client && client.auth && typeof client.auth.signOut === 'function') {
      return Promise.resolve(client.auth.signOut()).catch(function () {});
    }
    return Promise.resolve();
  }

  /**
   * Re-enter the app's own profile load once every gate has been satisfied.
   * @returns {Promise<void>}
   */
  function resumeAfterGate() {
    var w = win();
    var user = pending.user;
    var token = currentAccessToken() || pending.accessToken;
    pending.factorId = null;
    if (!w || typeof w.__cxOrigLoadCurrentProfile !== 'function' || !user) {
      // Nothing sensible to resume into — reload and let the boot path run.
      if (w && w.location && typeof w.location.reload === 'function') w.location.reload();
      return Promise.resolve();
    }
    showSignInCard();
    return Promise.resolve(w.__cxOrigLoadCurrentProfile(user, token));
  }

  // ── The gate itself ───────────────────────────────────────────────────────

  /**
   * Decide whether this session may enter the app, showing the card that
   * unblocks it when it may not.
   * @param {object} user
   * @param {string} accessToken
   * @returns {Promise<boolean>} true when the caller should stop (a card is up)
   */
  function evaluateGates(user, accessToken) {
    var client = sb();
    pending.user = user;
    pending.accessToken = accessToken;

    if (!client || !client.auth || !client.auth.mfa) return Promise.resolve(false);

    return Promise.all([
      client.auth.mfa.getAuthenticatorAssuranceLevel().catch(function () { return null; }),
      client.auth.mfa.listFactors().catch(function () { return null; }),
      fetchAuthProfile(user && user.id, accessToken),
    ]).then(function (r) {
      var aal = r[0] && r[0].data ? r[0].data : null;
      var factorRes = r[1] && r[1].data ? r[1].data : null;
      var profile = r[2];
      pending.profile = profile;

      // A backend that cannot answer is not a reason to lock anyone out — the
      // RLS gate is the real enforcement. See the fail-open note at the top.
      if (!aal && !factorRes && !profile) return false;

      // DEPLOY ORDER SAFETY: the front end ships on every push to main, but
      // supabase_auth_hardening.sql is applied by hand. Until it has been, the
      // profile read below asks for columns that do not exist yet and comes
      // back null — and "I could not read the policy" must not be treated as
      // "the policy says enrol everyone right now" on a live site mid-shift.
      // So the enrolment and rotation gates below require a profile row; only
      // the challenge gate, which needs no policy to decide, runs without one.
      var policyKnown = !!profile;

      var factors = (factorRes && (factorRes.totp || factorRes.all)) || [];
      var verified = factors.filter(function (f) { return f.status === 'verified'; });

      // 1. Enrolled but this session is still single-factor → challenge.
      if (verified.length && aal && aal.currentLevel !== 'aal2') {
        showCard('mfa-card');
        var codeEl = el('mfa-code');
        if (codeEl) { codeEl.value = ''; try { codeEl.focus(); } catch (e) {} }
        setText('mfa-error', '');
        return true;
      }

      // 2. Not enrolled and MFA is required → enrol before entering.
      if (!verified.length && policyKnown && mfaRequired(profile)) {
        showCard('mfa-setup-card');
        startMfaEnrolment();
        return true;
      }

      // 3. Password past its rotation date → change it before entering.
      //    must_change_password is left to app.js's own intercept.
      if (policyKnown && !profile.must_change_password && passwordExpired(profile)) {
        showPasswordRotation(profile);
        return true;
      }

      return false;
    }).catch(function (e) {
      warn('gate', e);
      return false;
    });
  }

  /**
   * Reuse app.js's change-password card for a scheduled rotation, relabelled.
   * @param {object} profile
   */
  function showPasswordRotation(profile) {
    var w = win();
    if (!w || typeof w._showChangePasswordPanel !== 'function') return;
    w._showChangePasswordPanel(profile);
    var age = passwordAgeDays(profile && profile.password_changed_at);
    setText('cp-title', 'Time to change your password.');
    var sub = el('cp-sub');
    if (sub) {
      sub.textContent = age === null
        ? 'Portal passwords must be changed at least every six months. Choose a new password to continue.'
        : 'Your password is ' + age + ' days old. Portal passwords must be changed at least every six months.';
    }
    var btn = el('cp-btn');
    if (btn) btn.textContent = 'Update Password & Continue';
  }

  // ── Wrappers ──────────────────────────────────────────────────────────────

  function wrapSignIn(w) {
    var orig = w.signIn;
    if (typeof orig !== 'function' || orig.__cxWrapped) return;

    var wrapped = function signIn() {
      var self = this, args = arguments;
      var emailEl = el('auth-email');
      var email = emailEl ? String(emailEl.value || '').trim() : '';
      var resetBtn = function () {
        var b = el('auth-btn');
        if (b) { b.textContent = 'Sign In'; b.disabled = false; }
      };

      return Promise.resolve(email ? loginGate(email) : null).then(function (gate) {
        var decision = lockoutDecision(gate);
        if (decision.blocked) {
          if (typeof w.showAuthError === 'function') w.showAuthError(decision.message);
          recordAuthEvent(email, 'login_blocked', 'locked at sign-in screen');
          resetBtn();
          return undefined;
        }
        return Promise.resolve(orig.apply(self, args)).then(function (out) {
          if (hasSession()) {
            recordAuthEvent(email, 'login_success', 'portal session established');
            return out;
          }
          // No session and the original already surfaced its own message:
          // record the failure and, if it was the last one, say so.
          recordAuthEvent(email, 'login_failure', 'portal sign-in rejected');
          return loginGate(email).then(function (after) {
            var d = lockoutDecision(after);
            if (d.message && typeof w.showAuthError === 'function') {
              var current = el('auth-error');
              var existing = current ? current.textContent : '';
              w.showAuthError(d.blocked ? d.message : ((existing ? existing + ' ' : '') + d.message));
            }
            return out;
          });
        });
      }).catch(function (e) {
        warn('signIn gate', e);
        return orig.apply(self, args);
      });
    };
    wrapped.__cxWrapped = true;
    w.signIn = wrapped;
  }

  function wrapLoadCurrentProfile(w) {
    var orig = w._loadCurrentProfile;
    if (typeof orig !== 'function' || orig.__cxWrapped) return;
    w.__cxOrigLoadCurrentProfile = orig;

    var wrapped = function _loadCurrentProfile(user, accessToken) {
      var self = this, args = arguments;
      return Promise.resolve(evaluateGates(user, accessToken)).then(function (blocked) {
        if (blocked) return undefined;
        return orig.apply(self, args);
      }, function (e) {
        warn('profile gate', e);
        return orig.apply(self, args);
      });
    };
    wrapped.__cxWrapped = true;
    w._loadCurrentProfile = wrapped;
  }

  function wrapSubmitChangePassword(w) {
    var orig = w.submitChangePassword;
    if (typeof orig !== 'function' || orig.__cxWrapped) return;

    var wrapped = function submitChangePassword() {
      var self = this, args = arguments;
      var pw = (el('cp-new-password') || {}).value || '';
      var pw2 = (el('cp-confirm-password') || {}).value || '';
      var email = emailOfPending();
      var verdict = checkPassword(pw, { email: email });
      if (pw && pw === pw2 && !verdict.ok) {
        setText('cp-error', verdict.errors[0]);
        return Promise.resolve();
      }
      return Promise.resolve(orig.apply(self, args)).then(function (out) {
        var err = el('cp-error');
        if (err && err.textContent) return out;   // the original rejected it
        stampPasswordChanged(email);
        return out;
      });
    };
    wrapped.__cxWrapped = true;
    w.submitChangePassword = wrapped;
  }

  /**
   * Record that the password just changed, restarting the six-month clock.
   * @param {string} email
   * @returns {Promise<void>}
   */
  function stampPasswordChanged(email) {
    var w = win();
    var client = sb();
    var uid = (pending.user && pending.user.id) ||
      (pending.profile && pending.profile.id) ||
      (w && w.currentProfile && w.currentProfile.id) || null;
    recordAuthEvent(email, 'password_changed', 'portal password updated');
    if (!client || !uid || typeof client.from !== 'function') return Promise.resolve();
    return Promise.resolve(
      client.from('profiles').update({ password_changed_at: new Date().toISOString() }).eq('id', uid)
    ).then(function () {}, function (e) { warn('password stamp', e); });
  }

  // ── Install ───────────────────────────────────────────────────────────────

  function install() {
    var w = win();
    if (!w) return;
    wrapSignIn(w);
    wrapLoadCurrentProfile(w);
    wrapSubmitChangePassword(w);
    if (w.CXActions && typeof w.CXActions.register === 'function') {
      w.CXActions
        .register('cxMfaVerify', verifyMfaChallenge)
        .register('cxMfaActivate', activateMfa)
        .register('cxMfaRestart', startMfaEnrolment)
        .register('cxAuthCancel', cancelGate);
    }
  }

  var CXAuth = {
    POLICY: POLICY,
    passwordClasses: passwordClasses,
    checkPassword: checkPassword,
    passwordAgeDays: passwordAgeDays,
    passwordExpired: passwordExpired,
    mfaRequired: mfaRequired,
    lockoutDecision: lockoutDecision,
    recordAuthEvent: recordAuthEvent,
    loginGate: loginGate,
    openMfaSetup: function () { showCard('mfa-setup-card'); return startMfaEnrolment(); },
    verifyMfaChallenge: verifyMfaChallenge,
    activateMfa: activateMfa,
    install: install,
  };

  if (typeof window !== 'undefined') { window.CXAuth = CXAuth; install(); }
  if (typeof module !== 'undefined' && module.exports) module.exports = CXAuth;
})();
