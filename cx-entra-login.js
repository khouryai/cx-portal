// ==========================================
// HITACHI Rail T&C Portal — sign-in screen under an external identity provider
// (cx-entra-login.js)
//
// THE BUG THIS CLOSES: the sign-in card is a Supabase-shaped email/password
// form, and app.js's signIn() refuses to do anything without both fields —
//
//     if (!email || !password) { showAuthError('Enter your email and password.'); return; }
//
// Under Microsoft Entra there is no password to type. IT owns the credential and
// MSAL redirects to Microsoft to collect it. So on the Azure deployment that
// guard rejected every attempt before window.CXIdentity was ever called, and the
// Sign In button appeared to do nothing at all.
//
// The seam has advertised `managesPasswords: false` since it was built
// (cx-auth-provider.js). Nothing read it. This file is the missing reader.
//
// It ADAPTS the existing card rather than rendering a new one, so the sign-in
// screen the field team already knows stays where it is and only loses the
// controls that no longer mean anything. A Supabase deployment loads this file
// and it returns immediately.
//
// WHY A SEPARATE FILE: app.js only shrinks (CLAUDE.md), and overriding
// window.signIn from outside is enough — the form's onsubmit resolves the name
// at call time, so a later script wins without app.js changing at all.
// ==========================================
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var LABEL = 'Sign in with Microsoft';

  function byId(id) { return document.getElementById(id); }

  /** The provider owns credentials elsewhere — there is nothing to type here. */
  function external() {
    return !!(window.CXIdentity && window.CXIdentity.managesPasswords === false);
  }

  /** Hide a node without disturbing layout classes. */
  function hide(node) { if (node) node.style.display = 'none'; }

  /** The <label class="signin-field"> wrapping a control, or the control itself. */
  function field(id) {
    var el = byId(id);
    return (el && el.closest) ? (el.closest('.signin-field') || el) : el;
  }

  function adaptCard() {
    // Credentials, recovery and self-service enrolment are all Entra's now.
    hide(field('auth-email'));
    hide(field('auth-password'));
    var row = document.querySelector('#login-overlay .signin-row');
    hide(row);                                   // "keep me signed in" + "forgot password?"
    var request = document.querySelector('#login-overlay .signin-request');
    hide(request);                               // accounts are provisioned by IT

    var sub = document.querySelector('#login-overlay .signin-sub');
    if (sub) {
      sub.textContent = 'Your Hitachi Rail account signs you in. ' +
        'You will be redirected to Microsoft to continue.';
    }
    var btn = byId('auth-btn');
    if (btn) btn.textContent = LABEL;
    holdLabel(btn);
  }

  /**
   * Keep the button labelled after app.js overwrites it.
   *
   * _onSignedOut() hardcodes 'Sign In' and runs every time the login overlay is
   * shown — on first boot with no session, and again after every sign-out — so
   * a label set once at DOMContentLoaded does not survive to first paint. app.js
   * is at its size-ratchet cap (CLAUDE.md: the monolith only shrinks), so the
   * adaptation defends itself from out here instead.
   *
   * Only the literal default is corrected; transient states this file sets
   * ('Redirecting to Microsoft…') are left alone.
   */
  function holdLabel(btn) {
    if (!btn || holdLabel._on || typeof MutationObserver !== 'function') return;
    holdLabel._on = new MutationObserver(function () {
      if (btn.textContent.trim() === 'Sign In') btn.textContent = LABEL;
    });
    holdLabel._on.observe(btn, { childList: true, characterData: true, subtree: true });
  }

  /**
   * Replace app.js's password sign-in with the provider's redirect.
   * Resolves rather than hanging: on success the browser has already left this
   * page, so anything running after the call means the redirect never started.
   */
  function installSignIn() {
    window.signIn = function signIn() {
      var btn = byId('auth-btn');
      if (typeof window.showAuthError === 'function') window.showAuthError('');
      if (btn) { btn.textContent = 'Redirecting to Microsoft…'; btn.disabled = true; }
      return Promise.resolve(window.CXIdentity.signIn({})).then(function (r) {
        if (r && r.error) {
          if (typeof window.showAuthError === 'function') window.showAuthError(r.error.message);
          if (btn) { btn.textContent = LABEL; btn.disabled = false; }
        }
      }, function (e) {
        if (typeof window.showAuthError === 'function') {
          window.showAuthError((e && e.message) || 'Could not reach Microsoft sign-in.');
        }
        if (btn) { btn.textContent = LABEL; btn.disabled = false; }
      });
    };
  }

  function start() {
    if (!external()) return;
    adaptCard();
    installSignIn();
    try { console.log('[identity] sign-in screen adapted for ' + window.CXIdentity.kind); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.CXEntraLogin = { start: start, adaptCard: adaptCard, external: external };
})();
