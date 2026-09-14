// ==========================================
// HITACHI Rail T&C Portal — Object storage seam (cx-storage.js)
//
// THE AZURE MIGRATION SEAM FOR FILES.
//
// Three of the five buckets already sat behind swappable adapters
// (`_formsStorage`, `_vfStorage`, `_rdStorage`). Photos — much the highest
// volume, and the one captured in the field — did not: photos.js talked to
// Supabase Storage's REST API directly. This closes that gap, so every byte the
// app stores now goes through one interface and Azure Blob Storage is a
// drop-in.
//
// WHY THE SHAPES MAP CLEANLY
//   Supabase Storage          Azure Blob Storage
//   ----------------          ------------------
//   bucket                    container
//   POST  /object/<b>/<p>     PUT    /<container>/<blob>      (x-ms-blob-type)
//   DELETE /object/<b>        DELETE /<container>/<blob>
//   POST  /object/sign/<b>    a SAS token minted for the blob
//   signed URL, TTL seconds   SAS URL, `se` expiry
// Both are "PUT bytes at a path, hand out a short-lived read URL", which is why
// the call sites above this file do not care which one is underneath.
//
// SIGNING IS THE ONE REAL DIFFERENCE. Supabase mints signed URLs from the
// anon key plus the caller's JWT, so the browser can do it. A SAS token must be
// signed with an account key, which must never reach the browser — so under
// Azure, `signMany` calls a small Azure Function that mints user-delegation SAS
// after checking the caller's Entra token. That function is the only new
// server-side component the storage migration needs; the interface below does
// not change.
// ==========================================
(function () {
  'use strict';

  function cfg() { return (typeof window !== 'undefined' && window.CX_CONFIG) || {}; }

  function authHeader() {
    if (typeof window !== 'undefined' && window.CXIdentity &&
        typeof window.CXIdentity.authHeader === 'function') {
      return window.CXIdentity.authHeader();
    }
    return 'Bearer ' + (cfg().SUPABASE_ANON_KEY || '');
  }

  // See config.js — absent rather than empty when there is no key.
  function apiKeyHeader() {
    var k = cfg().SUPABASE_ANON_KEY;
    return k ? { apikey: k } : {};
  }

  function headers(extra) {
    var h = { ...apiKeyHeader(), Authorization: authHeader() };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function encPath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }

  function withTimeout(ms) {
    var c = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (c) c.abort(); }, ms);
    return { signal: c ? c.signal : undefined, done: function () { clearTimeout(t); } };
  }

  // ── Supabase Storage ──────────────────────────────────────────────────────
  var supabaseStorage = {
    kind: 'supabase',

    /**
     * Upload bytes, overwriting whatever was at that path.
     * @param {string} bucket
     * @param {string} path
     * @param {Blob|ArrayBuffer} body
     * @param {string} [contentType]
     * @returns {Promise<string>} the path written
     */
    upload: function (bucket, path, body, contentType) {
      var to = withTimeout(60000);
      return fetch(cfg().SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + encPath(path), {
        method: 'POST', signal: to.signal, cache: 'no-store',
        headers: headers({
          'Content-Type': contentType || 'application/octet-stream',
          'x-upsert': 'true',
        }),
        body: body,
      }).then(function (res) {
        to.done();
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error('storage upload ' + res.status + ': ' + t);
          });
        }
        return path;
      }, function (e) { to.done(); throw e; });
    },

    /**
     * Delete objects. Best-effort by design — a failed cleanup must never
     * fail the user's action.
     * @param {string} bucket
     * @param {string[]} paths
     * @returns {Promise<void>}
     */
    remove: function (bucket, paths) {
      if (!paths || !paths.length) return Promise.resolve();
      return fetch(cfg().SUPABASE_URL + '/storage/v1/object/' + bucket, {
        method: 'DELETE',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: paths }),
      }).then(function () {}, function (e) {
        try { console.warn('[storage] remove failed (non-fatal):', e && e.message); } catch (_) {}
      });
    },

    /**
     * Mint short-lived read URLs.
     * @param {string} bucket
     * @param {string[]} paths
     * @param {number} expiresIn seconds
     * @returns {Promise<Object<string,string>>} path -> url (missing on failure)
     */
    signMany: function (bucket, paths, expiresIn) {
      var out = {};
      if (!paths || !paths.length) return Promise.resolve(out);
      return fetch(cfg().SUPABASE_URL + '/storage/v1/object/sign/' + bucket, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: expiresIn, paths: paths }),
      }).then(function (res) {
        if (!res.ok) return out;
        return res.json().then(function (arr) {
          (arr || []).forEach(function (it) {
            if (it && it.signedURL) out[it.path] = cfg().SUPABASE_URL + '/storage/v1' + it.signedURL;
          });
          return out;
        });
      }).catch(function (e) {
        try { console.warn('[storage] sign failed:', e && e.message); } catch (_) {}
        return out;
      });
    },
  };

  // ── Azure Blob Storage ────────────────────────────────────────────────────
  // Set CX_CONFIG.STORAGE = 'azure' plus CX_CONFIG.SAS_ENDPOINT (the URL of the
  // Function in azure/functions/sas). BLOB_ACCOUNT is not needed here — the
  // Function returns absolute URLs, so the account name never has to be known
  // to page script.
  //
  // EVERY operation goes through the Function first, because every operation
  // needs a credential and the browser may not hold one. That is one extra
  // round trip per upload and per delete versus Supabase, and zero extra for
  // reads (signMany was already a batch call). The upload round trip is the
  // real cost, and it is the price of the account key never existing in the
  // browser — which is not a trade, it is the correct design.
  var azureBlobStorage = {
    kind: 'azure-blob',

    /**
     * Ask the Function to sign paths.
     * @param {string} container
     * @param {string[]} paths
     * @param {string} permissions 'r', 'w', 'd' or a combination
     * @param {number} expiresIn seconds
     * @returns {Promise<Object<string,string>>} path -> absolute SAS URL
     */
    _sign: function (container, paths, permissions, expiresIn) {
      var endpoint = cfg().SAS_ENDPOINT;
      if (!endpoint) return Promise.reject(new Error('CX_CONFIG.SAS_ENDPOINT is not set'));
      var to = withTimeout(20000);
      return fetch(endpoint, {
        method: 'POST', signal: to.signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
        body: JSON.stringify({
          container: container, paths: paths,
          permissions: permissions, expiresIn: expiresIn || 600,
        }),
      }).then(function (res) {
        to.done();
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error('sas ' + res.status + ': ' + t);
          });
        }
        return res.json().then(function (j) { return (j && j.urls) || {}; });
      }, function (e) { to.done(); throw e; });
    },

    upload: function (bucket, path, body, contentType) {
      return azureBlobStorage._sign(bucket, [path], 'w', 600).then(function (urls) {
        var url = urls[path];
        if (!url) throw new Error('storage upload: no SAS returned for ' + path);
        var to = withTimeout(60000);
        return fetch(url, {
          method: 'PUT', signal: to.signal, cache: 'no-store',
          headers: {
            // Required by Azure for a single-shot block blob PUT. Files larger
            // than 256 MiB need the staged-block API instead; nothing this app
            // stores comes close, and the Function caps nothing here because the
            // failure is loud and immediate.
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': contentType || 'application/octet-stream',
          },
          body: body,
        }).then(function (res) {
          to.done();
          if (!res.ok) {
            return res.text().then(function (t) {
              throw new Error('storage upload ' + res.status + ': ' + t);
            });
          }
          return path;
        }, function (e) { to.done(); throw e; });
      });
    },

    /**
     * Delete objects. Best-effort by design, exactly as the Supabase provider
     * is — a failed cleanup must never fail the user's action.
     */
    remove: function (bucket, paths) {
      if (!paths || !paths.length) return Promise.resolve();
      return azureBlobStorage._sign(bucket, paths, 'd', 600).then(function (urls) {
        return Promise.all(paths.map(function (p) {
          if (!urls[p]) return null;
          return fetch(urls[p], { method: 'DELETE' }).catch(function () {});
        }));
      }).then(function () {}, function (e) {
        try { console.warn('[storage] remove failed (non-fatal):', e && e.message); } catch (_) {}
      });
    },

    signMany: function (bucket, paths, expiresIn) {
      if (!paths || !paths.length) return Promise.resolve({});
      return azureBlobStorage._sign(bucket, paths, 'r', expiresIn).catch(function (e) {
        try { console.warn('[storage] sign failed:', e && e.message); } catch (_) {}
        return {};
      });
    },
  };

  var providers = { supabase: supabaseStorage, azure: azureBlobStorage };
  var selected = providers[(cfg().STORAGE || 'supabase')] || supabaseStorage;

  /**
   * Bind the selected provider to one bucket, so call sites read naturally:
   *   var store = CXStorage.forBucket('photos');
   *   await store.upload(path, blob, 'image/jpeg');
   * @param {string} bucket
   */
  function forBucket(bucket) {
    return {
      kind: selected.kind,
      bucket: bucket,
      upload: function (path, body, contentType) { return selected.upload(bucket, path, body, contentType); },
      remove: function (paths) { return selected.remove(bucket, paths); },
      signMany: function (paths, expiresIn) { return selected.signMany(bucket, paths, expiresIn); },
    };
  }

  var CXStorage = {
    kind: selected.kind,
    forBucket: forBucket,
    providers: providers,
    upload: function () { return selected.upload.apply(selected, arguments); },
    remove: function () { return selected.remove.apply(selected, arguments); },
    signMany: function () { return selected.signMany.apply(selected, arguments); },
  };

  if (typeof window !== 'undefined') window.CXStorage = CXStorage;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXStorage;
})();
