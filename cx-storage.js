// ==========================================
// HITACHI Rail T&C Portal — Object storage seam (cx-storage.js)
//
// EVERY BYTE THE APP STORES GOES THROUGH THIS FILE.
//
// All five buckets — photos, forms, drawings, documents, vehicle-files — call
// the functions below and nothing else. Which storage service sits underneath
// is one value in config.js:
//
//   STORAGE: 'supabase'   (default)  Supabase Storage
//   STORAGE: 'azure'                 Azure Blob Storage, via SAS_ENDPOINT
//
// tools/test_storage_seam.js fails the build if any other file talks to a
// storage service directly, so it stays that way.
//
// WHY THE SHAPES MAP CLEANLY
//   Supabase Storage          Azure Blob Storage
//   ----------------          ------------------
//   bucket                    container
//   POST  /object/<b>/<p>     PUT    /<container>/<blob>      (x-ms-blob-type)
//   GET   /object/<b>/<p>     GET    /<container>/<blob>?<sas>
//   DELETE /object/<b>        DELETE /<container>/<blob>?<sas>
//   POST  /object/sign/<b>    a SAS token minted for the blob
// Both are "PUT bytes at a path, hand out a short-lived read URL".
//
// SIGNING IS THE ONE REAL DIFFERENCE. Supabase mints signed URLs from the
// caller's JWT, so the browser can do it. A SAS token must be signed with a
// key that must never reach the browser — so under Azure every operation first
// asks a small Function (azure/functions/sas) to sign it, after that Function
// has checked the caller's Entra token.
//
// OFFLINE FILES are cached here, in the page, under a key that does not depend
// on the provider (a SAS URL changes every time it is signed, so a cache keyed
// by URL would never hit). The service worker no longer knows about storage.
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

  /**
   * Run one fetch under a timeout and turn a non-OK answer into an Error
   * carrying `.status`, so callers can tell "not there" (404) from "broken".
   * @param {string} what   label for error messages, e.g. 'storage upload'
   * @param {number} ms
   * @param {function(AbortSignal): Promise<Response>} doFetch
   * @param {number[]} [okStatuses] extra statuses to treat as success
   * @returns {Promise<Response>}
   */
  function timed(what, ms, doFetch, okStatuses) {
    var to = withTimeout(ms);
    return doFetch(to.signal).then(function (res) {
      to.done();
      if (res.ok || (okStatuses && okStatuses.indexOf(res.status) !== -1)) return res;
      return res.text().then(function (t) {
        var err = new Error(what + ' failed (' + res.status + ')' + (t ? ': ' + t : ''));
        err.status = res.status;
        throw err;
      });
    }, function (e) {
      to.done();
      if (e && e.name === 'AbortError') throw new Error(what + ' timed out after ' + Math.round(ms / 1000) + 's');
      throw e;
    });
  }

  // ── Supabase Storage ──────────────────────────────────────────────────────
  var supabaseStorage = {
    kind: 'supabase',

    _url: function (bucket, path) {
      return cfg().SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + encPath(path);
    },

    put: function (bucket, path, body, contentType, ms) {
      return timed('storage upload', ms, function (signal) {
        return fetch(supabaseStorage._url(bucket, path), {
          method: 'POST', signal: signal, cache: 'no-store',
          headers: headers({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
          body: body,
        });
      });
    },

    get: function (bucket, path, ms) {
      // The query string defeats any HTTP cache between here and the bucket;
      // the object may have been overwritten in place (x-upsert).
      return timed('storage download', ms, function (signal) {
        return fetch(supabaseStorage._url(bucket, path) + '?t=' + Date.now(), {
          method: 'GET', signal: signal, cache: 'no-store',
          headers: headers({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' }),
        });
      }).then(function (res) { return res.blob(); });
    },

    del: function (bucket, paths, ms) {
      return timed('storage delete', ms, function (signal) {
        return fetch(cfg().SUPABASE_URL + '/storage/v1/object/' + bucket, {
          method: 'DELETE', signal: signal,
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ prefixes: paths }),
        });
      }, [404]);
    },

    copy: function (bucket, from, to, ms) {
      return timed('storage copy', ms, function (signal) {
        return fetch(cfg().SUPABASE_URL + '/storage/v1/object/copy', {
          method: 'POST', signal: signal,
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ bucketId: bucket, sourceKey: from, destinationKey: to }),
        });
      });
    },

    /** @returns {Promise<Object<string,string>>} path -> url (missing on failure) */
    signMany: function (bucket, paths, expiresIn) {
      return timed('storage sign', 20000, function (signal) {
        return fetch(cfg().SUPABASE_URL + '/storage/v1/object/sign/' + bucket, {
          method: 'POST', signal: signal,
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ expiresIn: expiresIn, paths: paths }),
        });
      }).then(function (res) { return res.json(); }).then(function (arr) {
        var out = {};
        (arr || []).forEach(function (it) {
          if (it && it.signedURL) out[it.path] = cfg().SUPABASE_URL + '/storage/v1' + it.signedURL;
        });
        return out;
      });
    },
  };

  // ── Azure Blob Storage ────────────────────────────────────────────────────
  // Set CX_CONFIG.STORAGE = 'azure' plus CX_CONFIG.SAS_ENDPOINT (the URL of the
  // Function in azure/functions/sas). The Function returns absolute URLs, so
  // the storage account name never has to be known to page script, and the
  // account key never exists in the browser.
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
      return timed('storage sign', 20000, function (signal) {
        return fetch(endpoint, {
          method: 'POST', signal: signal, cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
          body: JSON.stringify({
            container: container, paths: paths,
            permissions: permissions, expiresIn: expiresIn || 600,
          }),
        });
      }).then(function (res) { return res.json(); })
        .then(function (j) { return (j && j.urls) || {}; });
    },

    _signOne: function (container, path, permissions) {
      return azureBlobStorage._sign(container, [path], permissions, 600).then(function (urls) {
        if (!urls[path]) throw new Error('storage: no SAS returned for ' + path);
        return urls[path];
      });
    },

    put: function (bucket, path, body, contentType, ms) {
      return azureBlobStorage._signOne(bucket, path, 'w').then(function (url) {
        return timed('storage upload', ms, function (signal) {
          return fetch(url, {
            method: 'PUT', signal: signal, cache: 'no-store',
            headers: {
              // Required by Azure for a single-shot block blob PUT (up to
              // 5000 MiB on current service versions — far beyond anything
              // this app stores).
              'x-ms-blob-type': 'BlockBlob',
              'Content-Type': contentType || 'application/octet-stream',
            },
            body: body,
          });
        });
      });
    },

    get: function (bucket, path, ms) {
      return azureBlobStorage._signOne(bucket, path, 'r').then(function (url) {
        return timed('storage download', ms, function (signal) {
          return fetch(url, { method: 'GET', signal: signal, cache: 'no-store' });
        });
      }).then(function (res) { return res.blob(); });
    },

    del: function (bucket, paths, ms) {
      return azureBlobStorage._sign(bucket, paths, 'd', 600).then(function (urls) {
        return Promise.all(paths.map(function (p) {
          if (!urls[p]) throw new Error('storage: no SAS returned for ' + p);
          return timed('storage delete', ms, function (signal) {
            return fetch(urls[p], { method: 'DELETE', signal: signal });
          }, [404]);
        }));
      });
    },

    // Blob's server-side copy needs the source readable by the service; going
    // through the browser keeps the container fully private and the Function
    // unchanged. Forms PDFs are small, so the extra round trip is cheap.
    copy: function (bucket, from, to, ms) {
      return azureBlobStorage.get(bucket, from, ms).then(function (blob) {
        return azureBlobStorage.put(bucket, to, blob, blob.type, ms);
      });
    },

    signMany: function (bucket, paths, expiresIn) {
      return azureBlobStorage._sign(bucket, paths, 'r', expiresIn);
    },
  };

  // ── Offline file cache (provider-independent) ────────────────────────────
  // Lives in its own Cache Storage bucket, which sw.js leaves alone when it
  // clears old app-shell caches on deploy.
  var FILE_CACHE = 'cx-files-v1';

  function cacheKey(bucket, path) {
    var origin = (typeof location !== 'undefined' && location.origin) || 'https://cx.invalid';
    return origin + '/__cx-files/' + bucket + '/' + encPath(path);
  }

  function hasCaches() { return typeof caches !== 'undefined' && caches && typeof caches.open === 'function'; }

  function cachePut(bucket, path, blob) {
    if (!hasCaches()) return Promise.resolve(blob);
    return caches.open(FILE_CACHE).then(function (c) {
      return c.put(cacheKey(bucket, path), new Response(blob, {
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      }));
    }).then(function () { return blob; }, function () { return blob; });
  }

  function cacheGet(bucket, path) {
    if (!hasCaches()) return Promise.resolve(null);
    return caches.open(FILE_CACHE)
      .then(function (c) { return c.match(cacheKey(bucket, path)); })
      .then(function (hit) { return hit ? hit.blob() : null; }, function () { return null; });
  }

  function cacheDelete(bucket, paths) {
    if (!hasCaches()) return Promise.resolve();
    return caches.open(FILE_CACHE).then(function (c) {
      return Promise.all(paths.map(function (p) { return c.delete(cacheKey(bucket, p)); }));
    }).then(function () {}, function () {});
  }

  // ── Public interface ──────────────────────────────────────────────────────
  var DEFAULT_MS = 60000;

  function build(p) {
    var api = {
      kind: p.kind,

      /**
       * Upload bytes, overwriting whatever was at that path.
       * @param {string} bucket
       * @param {string} path
       * @param {Blob|ArrayBuffer} body
       * @param {string} [contentType]
       * @param {{timeoutMs?: number}} [opts]
       * @returns {Promise<string>} the path written
       */
      upload: function (bucket, path, body, contentType, opts) {
        return p.put(bucket, path, body, contentType, (opts && opts.timeoutMs) || DEFAULT_MS)
          .then(function () { return path; });
      },

      /**
       * Download an object as a Blob. A missing object rejects with an Error
       * whose `.status` is 404.
       *
       * With `offline: true` the device's file cache answers first (so the
       * file opens with no signal) and the network refreshes it behind; on a
       * cache miss the network answer is stored for next time.
       * @param {string} bucket
       * @param {string} path
       * @param {{timeoutMs?: number, offline?: boolean}} [opts]
       * @returns {Promise<Blob>}
       */
      download: function (bucket, path, opts) {
        var ms = (opts && opts.timeoutMs) || DEFAULT_MS;
        if (!(opts && opts.offline)) return p.get(bucket, path, ms);
        var network = function () {
          return p.get(bucket, path, ms).then(function (blob) { return cachePut(bucket, path, blob); });
        };
        return cacheGet(bucket, path).then(function (hit) {
          if (hit) { network().catch(function () {}); return hit; }
          return network();
        });
      },

      /**
       * Fetch an object from the network into the offline file cache.
       * @returns {Promise<true>}
       */
      makeOffline: function (bucket, path, opts) {
        return p.get(bucket, path, (opts && opts.timeoutMs) || DEFAULT_MS)
          .then(function (blob) { return cachePut(bucket, path, blob); })
          .then(function () { return true; });
      },

      /** Server-side copy within one bucket. */
      copy: function (bucket, from, to, opts) {
        return p.copy(bucket, from, to, (opts && opts.timeoutMs) || DEFAULT_MS);
      },

      /**
       * Delete objects, rejecting on failure. Already-missing objects are not
       * a failure.
       * @param {string} bucket
       * @param {string[]} paths
       * @returns {Promise<void>}
       */
      removeStrict: function (bucket, paths) {
        if (!paths || !paths.length) return Promise.resolve();
        return p.del(bucket, paths, 30000).then(function () { return cacheDelete(bucket, paths); });
      },

      /**
       * Delete objects. Best-effort by design — a failed cleanup must never
       * fail the user's action.
       * @returns {Promise<void>}
       */
      remove: function (bucket, paths) {
        return api.removeStrict(bucket, paths).catch(function (e) {
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
        if (!paths || !paths.length) return Promise.resolve({});
        return p.signMany(bucket, paths, expiresIn).catch(function (e) {
          try { console.warn('[storage] sign failed:', e && e.message); } catch (_) {}
          return {};
        });
      },

      /** One short-lived read URL, or null. */
      signedUrl: function (bucket, path, expiresIn) {
        return api.signMany(bucket, [path], expiresIn || 3600)
          .then(function (urls) { return urls[path] || null; });
      },

      /**
       * Bind to one bucket, so call sites read naturally:
       *   var store = CXStorage.forBucket('photos');
       *   await store.upload(path, blob, 'image/jpeg');
       * @param {string} bucket
       */
      forBucket: function (bucket) {
        return {
          kind: p.kind,
          bucket: bucket,
          upload: function (path, body, contentType, opts) { return api.upload(bucket, path, body, contentType, opts); },
          download: function (path, opts) { return api.download(bucket, path, opts); },
          makeOffline: function (path, opts) { return api.makeOffline(bucket, path, opts); },
          copy: function (from, to, opts) { return api.copy(bucket, from, to, opts); },
          remove: function (paths) { return api.remove(bucket, paths); },
          removeStrict: function (paths) { return api.removeStrict(bucket, paths); },
          signMany: function (paths, expiresIn) { return api.signMany(bucket, paths, expiresIn); },
          signedUrl: function (path, expiresIn) { return api.signedUrl(bucket, path, expiresIn); },
        };
      },
    };
    return api;
  }

  var providers = { supabase: supabaseStorage, azure: azureBlobStorage };
  var CXStorage = build(providers[(cfg().STORAGE || 'supabase')] || supabaseStorage);
  CXStorage.providers = providers;
  CXStorage.FILE_CACHE = FILE_CACHE;
  /** For tests: the same interface over a named provider. */
  CXStorage._withProvider = function (name) { return build(providers[name]); };

  if (typeof window !== 'undefined') window.CXStorage = CXStorage;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXStorage;
})();
