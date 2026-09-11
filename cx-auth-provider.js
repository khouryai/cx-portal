// ==========================================
// HITACHI Rail T&C Portal — Identity provider seam (cx-auth-provider.js)
//
// THE AZURE MIGRATION SEAM FOR AUTHENTICATION.
//
// `config.js` is the one file that changes to move the BACKEND. This is the one
// file that changes to move the IDENTITY PROVIDER. Together they are the whole
// cutover surface for "who is this user and how do we prove it".
//
// Measured against the code as it stands: 10 `_sb.auth.*` call sites plus three
// token-plumbing helpers. All of them now route through window.CXIdentity, so
// swapping Supabase GoTrue for Microsoft Entra ID means implementing the
// interface below once — not hunting call sites through a 50,000-line file.
//
// WHAT THE DATABASE SIDE NEEDS: see supabase/sql/azure_auth_uid_shim.sql.
// auth.uid() reads Entra's `oid` claim, so all 349 RLS policies keep working
// unchanged — proven by tools/test_rls_portability.js.
//
// DELIBERATELY NOT A REWRITE: the Supabase implementation below is the exact
// behaviour app.js had, moved rather than redesigned. That includes the two
// workarounds this stack needs and which a naive port would drop on the floor:
//   * the session is read straight out of localStorage, because supabase-js's
//     auth client can hang indefinitely after signInWithPassword here;
//   * the token is refreshed against GoTrue's REST endpoint directly, because
//     the client's auto-refresh hangs the same way.
// Under MSAL both disappear — acquireTokenSilent owns the cache and the
// refresh — which is one of the quieter wins of the migration.
// ==========================================
(function () {
  'use strict';

  function cfg() {
    return (typeof window !== 'undefined' && window.CX_CONFIG) || {};
  }
  function sb() {
    return (typeof window !== 'undefined' && window._sb) || null;
  }
  function log(msg) { try { console.log('[identity] ' + msg); } catch (e) {} }
  function warn(msg) { try { console.warn('[identity] ' + msg); } catch (e) {} }

  // ── Supabase GoTrue ───────────────────────────────────────────────────────
  var supabaseProvider = {
    kind: 'supabase',

    /** Whether this provider manages passwords itself (Entra does not). */
    managesPasswords: true,

    /** localStorage key supabase-js v2 keeps the session under. */
    storageKey: function () {
      var url = cfg().SUPABASE_URL || '';
      var ref = url.replace('https://', '').split('.')[0];
      return 'sb-' + ref + '-auth-token';
    },

    /**
     * The cached session, read straight from localStorage.
     * @returns {object|null}
     */
    storedSession: function () {
      try {
        var raw = localStorage.getItem(supabaseProvider.storageKey());
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    /**
     * Persist a session in the shape supabase-js expects to find.
     * @param {object} session
     */
    storeSession: function (session) {
      try { localStorage.setItem(supabaseProvider.storageKey(), JSON.stringify(session)); }
      catch (e) { warn('could not persist session: ' + e.message); }
    },

    /**
     * Authorization header for a REST call. Synchronous by design — every
     * `_db*` helper in app.js calls it inline.
     * @returns {string}
     */
    authHeader: function () {
      var session = supabaseProvider.storedSession();
      if (session && session.access_token) {
        var expiresAt = (session.expires_at || 0) * 1000;
        var minsLeft = ((expiresAt - Date.now()) / 60000).toFixed(1);
        var expired = Date.now() > expiresAt;
        log('token ' + (expired ? '⛔ EXPIRED' : '✓ valid') + ' | expires in ' + minsLeft + ' min');
        return 'Bearer ' + session.access_token;
      }
      warn('⚠ no session in localStorage — falling back to anon key');
      return 'Bearer ' + (cfg().SUPABASE_ANON_KEY || '');
    },

    /**
     * Refresh the JWT if it is within two minutes of expiry. Talks to GoTrue's
     * REST endpoint rather than the client, which can hang on this stack.
     * @returns {Promise<void>}
     */
    ensureFresh: function () {
      var s = supabaseProvider.storedSession();
      if (!s || !s.access_token || !s.refresh_token) return Promise.resolve();
      var msLeft = (s.expires_at || 0) * 1000 - Date.now();
      if (msLeft > 120000) return Promise.resolve();
      if (supabaseProvider._inflight) return supabaseProvider._inflight;

      supabaseProvider._inflight = (function () {
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
        return fetch(cfg().SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          signal: ctrl ? ctrl.signal : undefined,
          headers: { apikey: cfg().SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: s.refresh_token }),
        }).then(function (res) {
          clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function (fresh) {
          if (!fresh || !fresh.access_token) throw new Error('no access_token in refresh response');
          if (!fresh.expires_at && fresh.expires_in) {
            fresh.expires_at = Math.floor(Date.now() / 1000) + fresh.expires_in;
          }
          if (!fresh.user) fresh.user = s.user;
          supabaseProvider.storeSession(fresh);
          log('token refreshed via direct GoTrue REST');
          if (typeof window._hideSessionExpiredBanner === 'function') window._hideSessionExpiredBanner();
        }).catch(function (e) {
          warn('token refresh failed: ' + e.message);
          var cur = supabaseProvider.storedSession();
          if ((!cur || Date.now() > (cur.expires_at || 0) * 1000) &&
              typeof window._showSessionExpiredBanner === 'function') {
            window._showSessionExpiredBanner();
          }
        }).then(function () { supabaseProvider._inflight = null; });
      })();
      return supabaseProvider._inflight;
    },
    _inflight: null,

    // ── operations ──────────────────────────────────────────────────────────
    signIn: function (opts) { return sb().auth.signInWithPassword(opts); },
    signOut: function () { return sb().auth.signOut(); },
    getSession: function () { return sb().auth.getSession(); },
    onAuthStateChange: function (cb) { return sb().auth.onAuthStateChange(cb); },
    resetPassword: function (email, opts) { return sb().auth.resetPasswordForEmail(email, opts); },
    updatePassword: function (password) { return sb().auth.updateUser({ password: password }); },
    createUser: function (opts) { return sb().auth.signUp(opts); },

    /**
     * Direct grant, bypassing supabase-js entirely. app.js falls back to this
     * when signInWithPassword hangs on the client's shared navigator.locks
     * mutex. Entra has no equivalent and needs none.
     * @returns {Promise<{ok: boolean, session?: object, message?: string}>}
     */
    directGrant: function (email, password) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
      return fetch(cfg().SUPABASE_URL + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        signal: ctrl ? ctrl.signal : undefined,
        headers: { apikey: cfg().SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      }).then(function (res) {
        clearTimeout(timer);
        return res.json().then(function (j) {
          if (!res.ok) return { ok: false, message: j.error_description || j.msg || 'Sign-in failed.' };
          supabaseProvider.storeSession(j);
          return { ok: true, session: j };
        });
      }).catch(function () {
        clearTimeout(timer);
        return { ok: false, message: null };   // caller shows its own timeout copy
      });
    },
  };

  // ── Microsoft Entra ID (the migration target) ─────────────────────────────
  // Implement against MSAL Browser and set CX_CONFIG.IDENTITY = 'entra'.
  // Everything above this line stays; every call site already routes here.
  //
  //   storedSession() -> msal.getActiveAccount() + the cached token
  //   authHeader()    -> 'Bearer ' + (cached idToken/accessToken)
  //   ensureFresh()   -> msal.acquireTokenSilent({ scopes, account })
  //   signIn()        -> msal.loginRedirect({ scopes })   (redirect, not popup:
  //                      the PWA runs standalone on field tablets where a popup
  //                      has nowhere to go)
  //   signOut()       -> msal.logoutRedirect()
  //
  // The three password operations have NO Entra equivalent and must not fail
  // silently — IT provisions accounts and Entra owns credential lifecycle. They
  // throw, so any surviving caller surfaces immediately rather than appearing
  // to succeed. cx-auth-hardening.js's password policy, rotation clock and
  // lockout all retire at the same moment, because Entra enforces them and
  // ITSD I.2-4-2 is then answered by reference to the corporate IAM service.
  function notSupported(op) {
    return function () {
      return Promise.reject(new Error(
        op + ' is not available under Microsoft Entra ID — account and credential ' +
        'lifecycle is managed by IT. Remove this call path at the cutover.'));
    };
  }

  var entraProvider = {
    kind: 'entra',
    managesPasswords: false,
    storageKey: function () { return 'cx-entra-session'; },
    storedSession: function () { throw new Error('Entra provider not implemented yet'); },
    storeSession: function () { throw new Error('Entra provider not implemented yet'); },
    authHeader: function () { throw new Error('Entra provider not implemented yet'); },
    ensureFresh: function () { return Promise.resolve(); },
    signIn: function () { throw new Error('Entra provider not implemented yet'); },
    signOut: function () { throw new Error('Entra provider not implemented yet'); },
    getSession: function () { throw new Error('Entra provider not implemented yet'); },
    onAuthStateChange: function () { throw new Error('Entra provider not implemented yet'); },
    resetPassword: notSupported('Password reset'),
    updatePassword: notSupported('Password change'),
    createUser: notSupported('Account creation'),
    directGrant: notSupported('Direct password grant'),
  };

  var providers = { supabase: supabaseProvider, entra: entraProvider };
  var selected = providers[(cfg().IDENTITY || 'supabase')] || supabaseProvider;

  if (typeof window !== 'undefined') {
    window.CXIdentity = selected;
    window.CXIdentityProviders = providers;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { providers: providers, selected: selected };
  }
})();
