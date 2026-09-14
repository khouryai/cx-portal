// ==========================================
// HITACHI Rail T&C Portal — derived backend constants (cx-config.js)
//
// WHY THIS IS NOT IN config.js, WHICH IS WHERE IT USED TO LIVE.
//
// config.js is the file every environment REPLACES. azure/deploy-frontend.sh
// generates one; at the Hitachi cutover a human writes one. That makes it the
// seam, and a seam must hold nothing but VALUES — the moment it also holds
// logic, a replacement that sets only the values silently deletes the logic.
//
// That is not hypothetical, it is the bug this file exists to close. The
// generated Azure config.js assigned window.CX_CONFIG and nothing else, which
// removed window.REST_BASE. app.js reads REST_BASE as a bare global, so every
// data call threw ReferenceError before it built a URL. _checkDbStatus() caught
// it and painted "SYSTEM OFFLINE" — a missing variable wearing the costume of
// an unreachable API. The API was healthy the entire time, which is why curl
// and a hand-typed fetch in the console both worked while the app did not.
//
// So: config.js holds values, this file holds everything derived from them.
// Loaded immediately after config.js and before anything that reads these.
// tools/test_config_seam.js enforces the split, including against the config
// that azure/deploy-frontend.sh actually generates.
// ==========================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var c = window.CX_CONFIG || {};

  // REST_PATH — the one shape difference between Supabase's gateway and a bare
  // PostgREST. Supabase mounts PostgREST under /rest/v1/, so a table lives at
  // /rest/v1/profiles; a self-hosted PostgREST serves at the root: /profiles.
  // Set REST_PATH to '' when pointing at your own PostgREST, and leave it unset
  // for Supabase. Getting it wrong is a flat 404 on EVERY table while
  // authentication works perfectly — which reads like an empty database and is
  // nothing but a URL prefix.
  window.REST_BASE = (c.SUPABASE_URL || '') +
    (typeof c.REST_PATH === 'string' ? c.REST_PATH : '/rest/v1');

  // `apikey` is a SUPABASE GATEWAY header: the gateway uses it to route and
  // rate-limit. PostgREST itself has never read it, so off Supabase it is dead
  // weight — and not free weight, because it is not a CORS-safelisted header
  // and so forces a preflight on requests that would otherwise be simple.
  //
  // Callers SPREAD this (`...API_KEY_HEADER`) so that with no key configured
  // the header is ABSENT rather than present-and-empty.
  //
  // Note for future debugging: PostgREST's CORS policy echoes back whatever the
  // browser asks for in Access-Control-Request-Headers, so an unknown header
  // name here does NOT by itself fail a preflight. If the API looks unreachable,
  // read the error _checkDbStatus() logs rather than suspecting a header.
  window.API_KEY_HEADER = c.SUPABASE_ANON_KEY ? { apikey: c.SUPABASE_ANON_KEY } : {};
})();
