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

  // ── Microsoft Entra ID ────────────────────────────────────────────────────
  // Implemented against MSAL Browser (vendor/js/msal-browser.min.js, refreshed
  // by tools/vendor_msal.js). Selected with CX_CONFIG.IDENTITY = 'entra'.
  //
  // CONFIG IT MUST SUPPLY (config.js):
  //   ENTRA_TENANT_ID    the directory (tenant) id of the app registration
  //   ENTRA_CLIENT_ID    the application (client) id
  //   ENTRA_API_SCOPE    scope PostgREST validates, e.g.
  //                      'api://<client-id>/access_as_user'. Defaults to that.
  //   ENTRA_REDIRECT_URI optional; defaults to this page's own URL, which must
  //                      also be registered as a redirect URI (SPA platform).
  //   ENTRA_AUTHORITY    optional; defaults to login.microsoftonline.com/<tenant>.
  //                      Sovereign or B2C clouds override it.
  //
  // WHY REDIRECT AND NOT POPUP: the PWA runs standalone on field tablets, where
  // a popup has no window chrome to return to and iOS may block it outright.
  //
  // WHY MSAL IS LOADED LAZILY: it is ~275 KB, and a Supabase-backed deployment
  // must not pay for it. The first call that needs identity pulls it in.
  //
  // THE SESSION SHAPE IS SUPABASE'S, DELIBERATELY. Everything above this file
  // reads session.user.id, session.access_token and session.expires_at. Mapping
  // Entra's result into that shape is what keeps those call sites untouched —
  // and user.id is the `oid` claim, which is exactly what auth.uid() reads in
  // supabase/sql/azure_auth_uid_shim.sql. One definition, both issuers.
  var entra = {
    app: null,         // msal.PublicClientApplication
    ready: null,       // Promise — initialize() + handleRedirectPromise()
    session: null,     // the Supabase-shaped view of the current MSAL token
    listeners: [],
    redirecting: false,
  };

  function entraCfg() {
    var c = cfg();
    var tenant = c.ENTRA_TENANT_ID || '';
    var client = c.ENTRA_CLIENT_ID || '';
    return {
      tenant: tenant,
      client: client,
      authority: c.ENTRA_AUTHORITY || ('https://login.microsoftonline.com/' + tenant),
      scope: c.ENTRA_API_SCOPE || (client ? 'api://' + client + '/access_as_user' : ''),
      redirectUri: c.ENTRA_REDIRECT_URI ||
        (typeof location !== 'undefined' ? location.origin + location.pathname : ''),
      src: c.MSAL_SRC || 'vendor/js/msal-browser.min.js',
    };
  }

  /** Load the MSAL UMD bundle once, on demand. @returns {Promise<object>} */
  function loadMsal() {
    if (typeof window !== 'undefined' && window.msal) return Promise.resolve(window.msal);
    if (loadMsal._p) return loadMsal._p;
    loadMsal._p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = entraCfg().src;
      s.async = false;
      s.onload = function () {
        if (window.msal) resolve(window.msal);
        else reject(new Error('msal-browser loaded but defined no global'));
      };
      s.onerror = function () { reject(new Error('could not load ' + s.src)); };
      document.head.appendChild(s);
    });
    return loadMsal._p;
  }

  /** Map an MSAL auth result onto the session shape the app already reads. */
  function toSession(result, account) {
    var claims = (result && result.idTokenClaims) || (account && account.idTokenClaims) || {};
    var expSec = result && result.expiresOn
      ? Math.floor(result.expiresOn.getTime() / 1000)
      : (claims.exp || 0);
    return {
      access_token: result ? result.accessToken : null,
      token_type: 'Bearer',
      expires_at: expSec,
      expires_in: Math.max(0, expSec - Math.floor(Date.now() / 1000)),
      // MSAL owns the refresh token and never exposes it to page script. That
      // is a security improvement, not a gap — ensureFresh() goes through
      // acquireTokenSilent instead of holding the credential itself.
      refresh_token: null,
      user: {
        // `oid` is the immutable directory object id and the value auth.uid()
        // resolves. localAccountId is MSAL's mirror of it — the fallback only
        // matters if a token arrives without the claim mapped.
        id: claims.oid || (account && account.localAccountId) || '',
        email: claims.preferred_username || (account && account.username) || '',
        user_metadata: { full_name: claims.name || (account && account.name) || '' },
        app_metadata: { provider: 'entra' },
        // Carried through for private.mfa_ok(): Entra reports the factors used
        // in `amr` where Supabase reported an assurance level in `aal`.
        amr: claims.amr || [],
      },
    };
  }

  function emit(event) {
    for (var i = 0; i < entra.listeners.length; i++) {
      try { entra.listeners[i](event, entra.session); }
      catch (e) { warn('auth listener threw: ' + e.message); }
    }
  }

  /** Refresh the cached token from MSAL. Never rejects. */
  function acquire() {
    var account = entra.app && entra.app.getActiveAccount();
    if (!account) { entra.session = null; return Promise.resolve(null); }
    var e = entraCfg();
    return entra.app.acquireTokenSilent({ scopes: [e.scope], account: account })
      .then(function (r) {
        entra.session = toSession(r, account);
        return entra.session;
      })
      .catch(function (err) {
        var name = (err && (err.errorCode || err.name)) || '';
        // The one recoverable failure: consent expired, MFA now required, or
        // the refresh token aged out. Interactive sign-in is the only cure.
        if (/interaction_required|login_required|consent_required|InteractionRequired/i.test(name + ' ' + (err && err.message))) {
          warn('silent token acquisition needs interaction — redirecting to sign in');
          if (!entra.redirecting) {
            entra.redirecting = true;
            entra.app.acquireTokenRedirect({ scopes: [e.scope], account: account });
          }
        } else {
          warn('silent token acquisition failed: ' + (err && err.message));
        }
        entra.session = null;
        return null;
      });
  }

  /** Construct MSAL, complete any redirect in progress, prime the token. */
  function initEntra() {
    if (entra.ready) return entra.ready;
    entra.ready = loadMsal().then(function (msal) {
      var e = entraCfg();
      if (!e.client || !e.tenant) {
        throw new Error('CX_CONFIG.ENTRA_CLIENT_ID and ENTRA_TENANT_ID must be set to use the entra identity provider');
      }
      entra.app = new msal.PublicClientApplication({
        auth: {
          clientId: e.client,
          authority: e.authority,
          redirectUri: e.redirectUri,
          navigateToLoginRequestUrl: true,
        },
        // localStorage, not sessionStorage: the PWA is reopened from the home
        // screen as a fresh tab and must not demand a sign-in each time.
        cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false },
      });
      return entra.app.initialize();
    }).then(function () {
      // Completes the sign-in if this load is the return leg of a redirect.
      return entra.app.handleRedirectPromise();
    }).then(function (result) {
      entra.redirecting = false;
      if (result && result.account) {
        entra.app.setActiveAccount(result.account);
      } else if (!entra.app.getActiveAccount()) {
        var accounts = entra.app.getAllAccounts();
        if (accounts.length) entra.app.setActiveAccount(accounts[0]);
      }
      return acquire().then(function () {
        emit(result ? 'SIGNED_IN' : 'INITIAL_SESSION');
        log('entra ready — ' + (entra.session ? 'signed in as ' + entra.session.user.email : 'no account'));
      });
    }).catch(function (err) {
      warn('entra initialisation failed: ' + (err && err.message));
      entra.ready = null;          // let a later call retry rather than wedge
      throw err;
    });
    return entra.ready;
  }

  // The three password operations have NO Entra equivalent and must not fail
  // silently — IT provisions accounts and Entra owns credential lifecycle. They
  // throw, so any surviving caller surfaces immediately rather than appearing
  // to succeed. cx-auth-hardening.js's password policy, rotation clock and
  // lockout all retire at the same moment, because Entra enforces all three
  // centrally and does it better than an application can.
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

    /** MSAL keeps its own cache under its own keys; this names ours for parity. */
    storageKey: function () { return 'cx-entra-session'; },

    /**
     * The current session, synchronously. app.js calls this inline during boot,
     * so it can only ever return what MSAL has already given us — initEntra()
     * is kicked off here so the first call warms the cache for the next one.
     * @returns {object|null}
     */
    storedSession: function () {
      if (!entra.ready) { initEntra().catch(function () {}); }
      return entra.session;
    },

    /**
     * No-op: MSAL owns the token cache. Present so the interface is uniform —
     * a caller that writes a session under Entra is writing to a cache that is
     * not the source of truth, and should be told rather than silently ignored.
     */
    storeSession: function () {
      warn('storeSession is a no-op under Entra — MSAL owns the token cache');
    },

    /**
     * Authorization header for a REST call. Synchronous by design.
     * @returns {string} '' when there is no token: PostgREST then treats the
     *   request as anonymous, which is what the pre-auth boot path expects.
     */
    authHeader: function () {
      var s = entra.session;
      if (s && s.access_token) return 'Bearer ' + s.access_token;
      if (!entra.ready) { initEntra().catch(function () {}); }
      return '';
    },

    /**
     * Refresh if the token is within two minutes of expiry. MSAL's own cache
     * makes this cheap — acquireTokenSilent returns immediately when the token
     * is still good.
     * @returns {Promise<void>}
     */
    ensureFresh: function () {
      return initEntra().then(function () {
        var s = entra.session;
        if (s && s.access_token && (s.expires_at * 1000 - Date.now()) > 120000) return null;
        return acquire();
      }).then(function () {}, function () {});
    },

    /**
     * Begin interactive sign-in. Ignores any email/password passed by the
     * caller — Entra owns credentials, and the browser leaves this page.
     * @returns {Promise<{data: object, error: null}>}
     */
    signIn: function () {
      return initEntra().then(function () {
        var e = entraCfg();
        entra.redirecting = true;
        entra.app.loginRedirect({ scopes: [e.scope] });
        // The navigation has been requested; nothing after this runs. Resolving
        // rather than hanging keeps app.js's sign-in timeout from firing and
        // falling through to directGrant, which Entra does not support.
        return { data: {}, error: null };
      }).catch(function (err) {
        return { data: {}, error: { message: err.message } };
      });
    },

    signOut: function () {
      return initEntra().then(function () {
        entra.session = null;
        emit('SIGNED_OUT');
        return entra.app.logoutRedirect();
      }).catch(function () { entra.session = null; });
    },

    getSession: function () {
      return initEntra()
        .then(function () { return { data: { session: entra.session }, error: null }; })
        .catch(function (err) { return { data: { session: null }, error: { message: err.message } }; });
    },

    /**
     * @param {function(string, object|null)} cb
     * @returns {{data: {subscription: {unsubscribe: function}}}} supabase-js shape
     */
    onAuthStateChange: function (cb) {
      entra.listeners.push(cb);
      initEntra().catch(function () {});
      return {
        data: {
          subscription: {
            unsubscribe: function () {
              var i = entra.listeners.indexOf(cb);
              if (i !== -1) entra.listeners.splice(i, 1);
            },
          },
        },
      };
    },

    resetPassword: notSupported('Password reset'),
    updatePassword: notSupported('Password change'),
    createUser: notSupported('Account creation'),
    directGrant: notSupported('Direct password grant'),

    // Exposed for tests and for the cutover runbook; not part of the interface.
    _internals: entra,
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
