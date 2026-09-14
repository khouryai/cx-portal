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
  // See config.js: `apikey` is a Supabase gateway header, meaningless to a
  // self-hosted PostgREST. Spread so it is ABSENT off Supabase rather than
  // present-and-empty.
  function apiKeyHeader() {
    var k = cfg().SUPABASE_ANON_KEY;
    return k ? { apikey: k } : {};
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

    /** GoTrue's mfa.* API backs the enrolment and challenge cards. */
    managesMfa: true,

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
          headers: { ...apiKeyHeader(), 'Content-Type': 'application/json' },
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
        headers: { ...apiKeyHeader(), 'Content-Type': 'application/json' },
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
    settled: false,   // has initEntra() finished at least once?
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
        entra.settled = true;
        // Emit on whether a SESSION EXISTS, not on whether this page load was a
        // redirect return. app.js ignores INITIAL_SESSION by design (it restores
        // synchronously from storage), so a cached MSAL session emitted as
        // INITIAL_SESSION would leave the user staring at the sign-in screen
        // with a perfectly good token in hand, every single load.
        emit(entra.session ? 'SIGNED_IN' : 'INITIAL_SESSION');
        if (result && !entra.session) {
          warn('sign-in returned from Microsoft but no access token could be acquired — ' +
               'check that the API scope is consented and matches CX_CONFIG.ENTRA_API_SCOPE');
        }
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

    // Entra performs MFA itself, before it ever issues a token, and reports it
    // in `amr`. The browser must not run its own enrolment flow on top.
    managesMfa: false,

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
      // If initialisation already finished, this listener missed the event.
      // Replay it — otherwise whether the app sees its own sign-in depends on
      // the race between module load order and a network round trip.
      if (entra.settled) {
        setTimeout(function () {
          try { cb(entra.session ? 'SIGNED_IN' : 'INITIAL_SESSION', entra.session); }
          catch (e) { warn('auth listener threw on replay: ' + e.message); }
        }, 0);
      }
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


  // ── Self-hosted PostgREST: email + password ───────────────────────────────
  // Selected with CX_CONFIG.IDENTITY = 'postgrest'. Pairs with
  // supabase/sql/azure_local_auth.sql, which holds the half that matters.
  //
  // WHAT THIS IS FOR. Supabase was two services: PostgREST served the data and
  // GoTrue checked passwords. The Azure build kept PostgREST and left GoTrue
  // behind, so nothing there could turn a password into a session. The SQL file
  // puts that back as public.login(), and this provider is its client. The
  // sign-in screen then behaves exactly as it did on Supabase — same card, same
  // lockout, same rotation clock, no redirect to anywhere.
  //
  // WHY IT NEEDS NO WORKAROUNDS. The two Supabase quirks above (the auth client
  // hanging on navigator.locks, the refresh that never returns) came from
  // supabase-js, not from passwords. This talks to PostgREST with plain fetch,
  // so signIn and directGrant are the same call and neither can deadlock.
  //
  // THERE IS NO REFRESH TOKEN, DELIBERATELY. Sessions last eight hours and
  // renew through /rpc/auth_refresh, which PostgREST only reaches after it has
  // already verified the bearer token. Possession of a live session is the
  // credential, so nothing long-lived sits in localStorage waiting to be stolen.
  var pgrestProvider = {
    kind: 'postgrest',

    /** It does: login(), change_password() and the policy all live in the DB. */
    managesPasswords: true,

    // NO TOTP ON THIS DEPLOYMENT, and this flag is what stops that becoming a
    // dead end. Enrolment and challenge in cx-auth-hardening.js are written
    // against GoTrue's auth.mfa.* API, which does not exist here; without this
    // flag a profile with mfa_enforced set would be sent to an enrolment card
    // that can never complete. private.mfa_ok() still passes server-side
    // because auth.mfa_factors is empty (azure_local_auth.sql §3), so access is
    // unaffected — but second-factor authentication is genuinely NOT available
    // on a local-password deployment. It is one of the things Entra brings.
    managesMfa: false,

    storageKey: function () { return 'cx-portal-auth-token'; },

    storedSession: function () {
      try {
        var raw = localStorage.getItem(pgrestProvider.storageKey());
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    storeSession: function (session) {
      try { localStorage.setItem(pgrestProvider.storageKey(), JSON.stringify(session)); }
      catch (e) { warn('could not persist session: ' + e.message); }
    },

    clearSession: function () {
      try { localStorage.removeItem(pgrestProvider.storageKey()); } catch (e) {}
    },

    /** Synchronous by design — every `_db*` helper in app.js calls it inline. */
    authHeader: function () {
      var s = pgrestProvider.storedSession();
      if (s && s.access_token) return 'Bearer ' + s.access_token;
      // No anon-key fallback: there is no gateway key on this stack, and a
      // malformed Authorization header is harder to read in the logs than none.
      return '';
    },

    /** POST to a PostgREST RPC with the current session, if any. @private */
    _rpc: function (fn, body, useAuth) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
      var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (useAuth) {
        var h = pgrestProvider.authHeader();
        if (h) headers.Authorization = h;
      }
      var base = (typeof window !== 'undefined' && window.REST_BASE) || '';
      return fetch(base + '/rpc/' + fn, {
        method: 'POST',
        signal: ctrl ? ctrl.signal : undefined,
        headers: headers,
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) {}
          if (!res.ok) {
            // PostgREST surfaces a RAISE EXCEPTION as {message, code, details}.
            // The message is written for the user in azure_local_auth.sql, so
            // pass it through rather than inventing copy here.
            var msg = (json && (json.message || json.hint || json.details)) ||
                      ('Sign-in failed (HTTP ' + res.status + ').');
            var err = new Error(msg);
            err.code = json && json.code;
            throw err;
          }
          return json;
        });
      }).catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('The server did not respond. Check your connection and try again.');
        throw e;
      });
    },

    ensureFresh: function () {
      var s = pgrestProvider.storedSession();
      if (!s || !s.access_token) return Promise.resolve();
      var msLeft = (s.expires_at || 0) * 1000 - Date.now();
      if (msLeft > 120000) return Promise.resolve();
      if (pgrestProvider._inflight) return pgrestProvider._inflight;

      pgrestProvider._inflight = pgrestProvider._rpc('auth_refresh', {}, true)
        .then(function (fresh) {
          if (!fresh || !fresh.access_token) throw new Error('no access_token in refresh response');
          pgrestProvider.storeSession(fresh);
          log('session renewed via /rpc/auth_refresh');
          if (typeof window._hideSessionExpiredBanner === 'function') window._hideSessionExpiredBanner();
        })
        .catch(function (e) {
          warn('session renewal failed: ' + e.message);
          var cur = pgrestProvider.storedSession();
          if ((!cur || Date.now() > (cur.expires_at || 0) * 1000) &&
              typeof window._showSessionExpiredBanner === 'function') {
            window._showSessionExpiredBanner();
          }
        })
        .then(function () { pgrestProvider._inflight = null; });
      return pgrestProvider._inflight;
    },
    _inflight: null,

    // ── operations ──────────────────────────────────────────────────────────
    /** supabase-js's {data, error} shape, so app.js's signIn() is unchanged. */
    signIn: function (opts) {
      return pgrestProvider._rpc('login', {
        p_email: (opts && opts.email) || '',
        p_password: (opts && opts.password) || '',
      }, false).then(function (session) {
        pgrestProvider.storeSession(session);
        pgrestProvider._emit('SIGNED_IN', session);
        return { data: { session: session, user: session.user }, error: null };
      }).catch(function (e) {
        return { data: { session: null, user: null }, error: { message: e.message } };
      });
    },

    signOut: function () {
      pgrestProvider.clearSession();
      pgrestProvider._emit('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    },

    getSession: function () {
      return Promise.resolve({ data: { session: pgrestProvider.storedSession() }, error: null });
    },

    onAuthStateChange: function (cb) {
      pgrestProvider._listeners.push(cb);
      // The session is restored synchronously from localStorage, so INITIAL_SESSION
      // is the honest event here — app.js ignores it and reads storage itself.
      try { cb('INITIAL_SESSION', pgrestProvider.storedSession()); } catch (e) {}
      return { data: { subscription: { unsubscribe: function () {
        var i = pgrestProvider._listeners.indexOf(cb);
        if (i >= 0) pgrestProvider._listeners.splice(i, 1);
      } } } };
    },
    _listeners: [],
    _emit: function (event, session) {
      for (var i = 0; i < pgrestProvider._listeners.length; i++) {
        try { pgrestProvider._listeners[i](event, session); }
        catch (e) { warn('auth listener threw: ' + e.message); }
      }
    },

    /**
     * NOT SUPPORTED, and it fails loudly rather than pretending to send mail.
     * Nothing in this stack can send email — there is no SMTP service and no
     * Edge Function. A reset is an administrator running, in psql:
     *     select auth.set_password('user@example.com', 'a new passphrase');
     * That is the honest cost of holding passwords yourself; Entra is what
     * removes it.
     */
    resetPassword: function () {
      return Promise.reject(new Error(
        'Password reset by email is not available on this deployment — nothing here can send mail. ' +
        'Ask an administrator to set a new password for you.'));
    },

    updatePassword: function (password, current) {
      return pgrestProvider._rpc('change_password', {
        p_current: current || '',
        p_new: password,
      }, true).then(function () {
        return { data: {}, error: null };
      }).catch(function (e) {
        return { data: {}, error: { message: e.message } };
      });
    },

    /**
     * Account creation is deliberately administrative: a profile row is created
     * by the Team module, then an administrator sets the first password with
     * auth.set_password() in psql. Self-service sign-up would mean an anonymous
     * caller could mint credentials against this database.
     */
    createUser: function () {
      return Promise.reject(new Error(
        'Accounts are created by an administrator on this deployment. ' +
        'Add the person in Team, then ask an administrator to set their first password.'));
    },

    /** Same call as signIn — plain fetch cannot deadlock, so there is nothing to fall back FROM. */
    directGrant: function (email, password) {
      return pgrestProvider.signIn({ email: email, password: password }).then(function (out) {
        if (out.error) return { ok: false, message: out.error.message };
        return { ok: true, session: out.data.session };
      });
    },
  };

  var providers = { supabase: supabaseProvider, entra: entraProvider, postgrest: pgrestProvider };
  var selected = providers[(cfg().IDENTITY || 'supabase')] || supabaseProvider;

  if (typeof window !== 'undefined') {
    window.CXIdentity = selected;
    window.CXIdentityProviders = providers;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { providers: providers, selected: selected };
  }
})();
