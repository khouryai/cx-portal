/* ============================================================================
   Photos Module — self-contained, self-bootstrapping.

   Loaded as a classic <script> right after app.js so it shares the global
   lexical scope and reuses the app's existing primitives:
     • SUPABASE_URL / SUPABASE_ANON_KEY / _sb   (globals from app.js)
     • _getAuthHeader()        — fresh JWT from localStorage (tab-resume safe)
     • _dbInsert / _dbUpdate   — native-fetch DB writes
     • _fetchAnon(path)        — REST reads (parsed JSON)
     • modal({...}) / closeModal()
     • currentRoleUser         — { name, role }
     • showPage(name)

   Injects its own nav link + #page-photos section (no deep app.js edits).

   Capabilities:
     • Reliability  — native-fetch uploads, client-side compression to a
       display image + thumbnail, lazy IntersectionObserver signed-URL
       hydration (batched), storage cleanup on delete.
     • Scale        — server-side filtered, paginated (infinite-scroll) reads;
       album counts/covers fetched on demand.
     • Offline      — uploads are queued in IndexedDB first, then processed;
       survives reload and flushes automatically on reconnect. Direct mobile
       camera capture.
     • Management   — edit metadata, before/after tagging, manual albums
       (create/rename/delete/cover), add-to-album, bulk select (delete /
       add-to-album / download).

   Public surface: window.PhotosModule.
   ============================================================================ */
(function () {
  'use strict';

  // ── config ──────────────────────────────────────────────────────────────
  var BUCKET       = 'photos';
  var SIGN_TTL     = 3600;            // signed-URL lifetime (s)
  var PAGE_SIZE    = 60;              // photos per page
  var MAX_DISPLAY  = 1600;           // px, longest edge of stored display image
  var MAX_THUMB    = 400;            // px, longest edge of stored thumbnail
  var JPEG_Q       = 0.82;
  var UPLOAD_ROLES = ['admin', 'field_engineer', 'technician', 'punch_manager'];
  var SOURCE_LABELS = { punch: 'Punch List', daily_log: 'Daily Logs', standalone: 'General' };
  var KIND_LABELS   = { before: 'Before', after: 'After', general: '' };

  var S = {
    view: 'timeline',                // 'timeline' | 'albums' | 'album'
    photos: [],                      // accumulated page rows for current scope
    offset: 0,
    hasMore: true,
    loadingPage: false,
    booted: false,
    albums: [],                      // album rows (with async count/cover filled in)
    activeAlbum: null,
    activeAlbumIds: null,            // for manual albums: member photo ids
    filters: { source: 'all', location: 'all', subsystem: 'all', kind: 'all', q: '' },
    distinct: { location: [], subsystem: [], loaded: false },
    signed: new Map(),               // path -> { url, exp }
    selecting: false,
    selected: new Set(),
    queueCount: 0,
    processing: false,
    lb: { list: [], i: 0 },
  };

  // ── tiny utils ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function elFrom(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function role() { try { return (typeof currentRoleUser !== 'undefined' && currentRoleUser && currentRoleUser.role) || null; } catch (e) { return null; } }
  function userName() { try { return (typeof currentRoleUser !== 'undefined' && currentRoleUser && currentRoleUser.name) || 'unknown'; } catch (e) { return 'unknown'; } }
  function canUpload() { return UPLOAD_ROLES.indexOf(role()) !== -1; }
  function canDeletePhoto(p) { return role() === 'admin' || (p && p.uploaded_by === userName()); }
  function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2)); }
  function encPath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }
  function authHeader() { try { return (typeof _getAuthHeader === 'function') ? _getAuthHeader() : ('Bearer ' + SUPABASE_ANON_KEY); } catch (e) { return 'Bearer ' + SUPABASE_ANON_KEY; } }
  function restHeaders(extra) {
    var h = { apikey: SUPABASE_ANON_KEY, Authorization: authHeader() };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  function toast(msg) {
    try { if (typeof window.toast === 'function') return window.toast(msg); } catch (e) {}
    console.log('[photos]', msg);
  }

  function fmtDayHeader(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return 'Undated';
    var today = new Date(); var y = new Date(); y.setDate(today.getDate() - 1);
    var key = function (x) { return x.toISOString().slice(0, 10); };
    if (key(d) === key(today)) return 'Today';
    if (key(d) === key(y)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function dayKey(iso) { var d = new Date(iso); return isNaN(d) ? '0000-00-00' : d.toISOString().slice(0, 10); }

  // ── project metadata (shared with the rest of the app) ──────────────────────
  // LOCS (global) is the hierarchical location tree: level 1 = phases,
  // level 2 = locations (parent_id -> phase). Subsystems come from the field-
  // settings config (_fsCfg) with SUBSYSTEMS_LIST as fallback.
  function projPhases() {
    try { return (typeof LOCS !== 'undefined' ? LOCS : []).filter(function (l) { return l.level === 1; })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); }); } catch (e) { return []; }
  }
  function projLocations(phaseName) {
    try {
      var all = (typeof LOCS !== 'undefined' ? LOCS : []).filter(function (l) { return l.level === 2; });
      if (phaseName) {
        var ph = projPhases().filter(function (p) { return p.name === phaseName; })[0];
        all = ph ? all.filter(function (l) { return l.parent_id === ph.id; }) : all;
      }
      return all.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
    } catch (e) { return []; }
  }
  function projSubsystems() {
    try { if (typeof _fsCfg === 'function') { var c = _fsCfg('punch_subsystem'); if (c && c.length) return c; } } catch (e) {}
    try { if (typeof SUBSYSTEMS_LIST !== 'undefined' && SUBSYSTEMS_LIST.length) return SUBSYSTEMS_LIST; } catch (e) {}
    return [];
  }
  // Build <option>s; keeps a current value even if it's no longer in the list.
  function optionList(values, selected, placeholder) {
    var vals = (values || []).slice();
    if (selected && vals.indexOf(selected) === -1) vals.unshift(selected);
    return '<option value="">' + esc(placeholder || '— select —') + '</option>' +
      vals.map(function (v) { return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
  }
  function phaseNames() { return projPhases().map(function (p) { return p.name; }); }
  function locationNames(phaseName) { return projLocations(phaseName).map(function (l) { return l.name; }); }

  // ── storage (native fetch — mirrors _formsStorage for tab-resume safety) ────
  function withTimeout(ms) { var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, ms); return { signal: c.signal, done: function () { clearTimeout(t); } }; }

  async function storageUpload(path, blob, contentType) {
    var to = withTimeout(60000);
    try {
      var res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + encPath(path), {
        method: 'POST', signal: to.signal, cache: 'no-store',
        headers: restHeaders({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
        body: blob,
      });
      to.done();
      if (!res.ok) throw new Error('storage upload ' + res.status + ': ' + (await res.text()));
      return path;
    } catch (e) { to.done(); throw e; }
  }

  async function storageRemove(paths) {
    if (!paths || !paths.length) return;
    try {
      await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
        method: 'DELETE', headers: restHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: paths }),
      });
    } catch (e) { console.warn('[photos] storage remove failed (non-fatal):', e && e.message); }
  }

  // Batch sign — caches, only signs what's missing/expired.
  async function signPaths(paths) {
    var out = {}; var need = [];
    paths.forEach(function (p) {
      if (!p) return;
      var h = S.signed.get(p);
      if (h && h.exp > Date.now() + 30000) out[p] = h.url;
      else need.push(p);
    });
    if (!need.length) return out;
    try {
      var res = await fetch(SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET, {
        method: 'POST', headers: restHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: SIGN_TTL, paths: need }),
      });
      if (res.ok) {
        var arr = await res.json();
        arr.forEach(function (it) {
          if (it && it.signedURL) {
            var url = SUPABASE_URL + '/storage/v1' + it.signedURL;
            S.signed.set(it.path, { url: url, exp: Date.now() + SIGN_TTL * 1000 });
            out[it.path] = url;
          }
        });
      }
    } catch (e) { console.warn('[photos] sign failed:', e && e.message); }
    return out;
  }

  async function signOne(path) { var m = await signPaths([path]); return m[path] || ''; }

  // PostgREST exact-count without pulling rows.
  async function countRows(table, qs) {
    try {
      var res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + qs, {
        method: 'GET', headers: restHeaders({ Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' }),
      });
      var cr = res.headers.get('content-range') || '';
      return parseInt(cr.split('/')[1], 10) || 0;
    } catch (e) { return 0; }
  }

  // ── IndexedDB upload queue (offline-first) ─────────────────────────────────
  // Some mobile contexts block IndexedDB (iOS private browsing, locked storage).
  // When that happens we fall back to an in-memory queue so an upload can still
  // proceed instead of hanging forever.
  var _memQueue = [];
  var _memId = 1;
  function idb() {
    return new Promise(function (res, rej) {
      var r;
      try { r = indexedDB.open('pm-photos', 1); } catch (e) { return rej(e); }
      var to = setTimeout(function () { rej(new Error('idb open timeout')); }, 5000);
      r.onupgradeneeded = function () { try { r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }); } catch (e) {} };
      r.onsuccess = function () { clearTimeout(to); res(r.result); };
      r.onerror   = function () { clearTimeout(to); rej(r.error || new Error('idb open error')); };
      r.onblocked = function () { clearTimeout(to); rej(new Error('idb blocked')); };
    });
  }
  async function idbAdd(item) {
    try {
      var db = await idb();
      return await new Promise(function (res, rej) { var tx = db.transaction('queue', 'readwrite'); tx.objectStore('queue').add(item); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; });
    } catch (e) {
      item.id = 'mem-' + (_memId++); _memQueue.push(item);   // in-memory fallback
    }
  }
  async function idbAll() {
    try {
      var db = await idb();
      var rows = await new Promise(function (res, rej) { var tx = db.transaction('queue', 'readonly'); var q = tx.objectStore('queue').getAll(); q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { rej(q.error); }; });
      return rows.concat(_memQueue);
    } catch (e) { return _memQueue.slice(); }
  }
  async function idbDel(id) {
    if (typeof id === 'string' && id.indexOf('mem-') === 0) { _memQueue = _memQueue.filter(function (x) { return x.id !== id; }); return; }
    try {
      var db = await idb();
      return await new Promise(function (res, rej) { var tx = db.transaction('queue', 'readwrite'); tx.objectStore('queue').delete(id); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; });
    } catch (e) { /* best-effort */ }
  }

  async function refreshQueueCount() {
    try { S.queueCount = (await idbAll()).length; } catch (e) { S.queueCount = 0; }
    var b = document.getElementById('pm-queue-badge');
    if (b) { b.textContent = S.queueCount ? (S.queueCount + ' queued') : ''; b.style.display = S.queueCount ? '' : 'none'; }
  }

  // ── image processing (compress + thumbnail) ────────────────────────────────
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      var done = false;
      var to = setTimeout(function () { if (!done) { done = true; try { URL.revokeObjectURL(url); } catch (e) {} rej(new Error('decode timeout')); } }, 20000);
      im.onload = function () { if (done) return; done = true; clearTimeout(to); im._url = url; res(im); };
      im.onerror = function () { if (done) return; done = true; clearTimeout(to); try { URL.revokeObjectURL(url); } catch (e) {} rej(new Error('decode failed')); };
      im.src = url;
    });
  }
  // Resolves with a Blob, or null if encoding fails/stalls (caller falls back).
  function scaleBlob(img, max, q) {
    return new Promise(function (res) {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        var r = Math.min(1, max / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * r)), ch = Math.max(1, Math.round(h * r));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        var settled = false;
        var to = setTimeout(function () { if (!settled) { settled = true; res(null); } }, 15000);
        c.toBlob(function (b) { if (settled) return; settled = true; clearTimeout(to); res(b); }, 'image/jpeg', q);
      } catch (e) { res(null); }
    });
  }
  async function processImage(file) {
    try {
      var img = await loadImage(file);
      var display = await scaleBlob(img, MAX_DISPLAY, JPEG_Q);
      var thumb = await scaleBlob(img, MAX_THUMB, JPEG_Q);
      var dims = { w: img.naturalWidth, h: img.naturalHeight };
      if (img._url) URL.revokeObjectURL(img._url);
      return { display: display || file, thumb: thumb || display || file, dims: dims };
    } catch (e) {
      // Non-decodable (e.g. some HEIC): fall back to the original bytes.
      return { display: file, thumb: file, dims: { w: null, h: null } };
    }
  }

  // ── enqueue + process uploads ──────────────────────────────────────────────
  async function enqueueFiles(files, meta) {
    var n = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      // Allow empty type (mobile camera often omits it); skip clearly non-image files.
      if (!f || (f.type && f.type.indexOf('image/') !== 0)) continue;
      try {
        var proc = await processImage(f);
        await idbAdd({
          display: proc.display, thumb: proc.thumb, dims: proc.dims,
          file_name: f.name || ('photo-' + Date.now() + '.jpg'),
          last_modified: f.lastModified || Date.now(),
          meta: meta, created_at: Date.now(),
        });
        n++;
      } catch (e) { console.error('[photos] file skipped:', e && e.message); }
    }
    await refreshQueueCount();
    return n;
  }

  async function processQueue() {
    if (S.processing) return;
    if (typeof _dbInsert !== 'function') return;
    S.processing = true;
    var uploaded = 0;
    try {
      var items = await idbAll();
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        try {
          var m = it.meta || {};
          var id = uuid();
          var displayPath = m.source_type + '/' + id + '.jpg';
          var thumbPath   = m.source_type + '/thumb/' + id + '.jpg';
          await storageUpload(displayPath, it.display, 'image/jpeg');
          try { await storageUpload(thumbPath, it.thumb, 'image/jpeg'); } catch (te) { thumbPath = null; }
          var row = {
            storage_path: displayPath, thumb_path: thumbPath,
            file_name: it.file_name, mime_type: 'image/jpeg',
            file_size: (it.display && it.display.size) || null,
            width: it.dims && it.dims.w, height: it.dims && it.dims.h,
            caption: m.caption || null,
            source_type: m.source_type || 'standalone',
            source_id: m.source_id || null,
            source_label: m.source_label || null,
            capture_kind: m.capture_kind || 'general',
            location: m.location || null, subsystem: m.subsystem || null, phase: m.phase || null,
            taken_at: new Date(it.last_modified || it.created_at || Date.now()).toISOString(),
            uploaded_by: m.uploaded_by || userName(),
          };
          var inserted = await _dbInsert('photos', [row]);
          var newId = inserted && inserted[0] && inserted[0].id;
          if (newId && m.album_id) {
            try { await _dbInsert('photo_album_items', [{ album_id: m.album_id, photo_id: newId, added_by: userName() }]); } catch (e) {}
          }
          await idbDel(it.id);
          uploaded++;
        } catch (e) {
          // Likely offline / network — stop and leave the rest queued for retry.
          console.warn('[photos] queued upload deferred:', e && e.message);
          break;
        }
      }
    } finally {
      S.processing = false;
      await refreshQueueCount();
      if (uploaded) {
        S.distinct.loaded = false;
        await loadPage(true);
        paint();
        toast(uploaded + ' photo' + (uploaded === 1 ? '' : 's') + ' uploaded');
      }
    }
  }

  // ── distinct filter values (cheap two-column scan, cached) ──────────────────
  async function loadDistinct() {
    if (S.distinct.loaded) return;
    try {
      var rows = await _fetchAnon('photos?select=location,subsystem&is_deleted=eq.false');
      var L = {}, Sub = {};
      (rows || []).forEach(function (r) { if (r.location) L[r.location] = 1; if (r.subsystem) Sub[r.subsystem] = 1; });
      S.distinct.location = Object.keys(L).sort();
      S.distinct.subsystem = Object.keys(Sub).sort();
      S.distinct.loaded = true;
    } catch (e) { /* non-fatal */ }
  }

  // ── paginated reads ────────────────────────────────────────────────────────
  function currentFilterQS() {
    var f = S.filters, parts = ['is_deleted=eq.false'];
    var forcedSource = (S.view === 'album' && S.activeAlbum && S.activeAlbum.kind === 'auto') ? S.activeAlbum.auto_source_type : null;
    if (forcedSource) parts.push('source_type=eq.' + forcedSource);
    else if (f.source !== 'all') parts.push('source_type=eq.' + f.source);
    if (f.location !== 'all') parts.push('location=eq.' + encodeURIComponent(f.location));
    if (f.subsystem !== 'all') parts.push('subsystem=eq.' + encodeURIComponent(f.subsystem));
    if (f.kind !== 'all') parts.push('capture_kind=eq.' + f.kind);
    if (S.view === 'album' && S.activeAlbum && S.activeAlbum.kind === 'manual') {
      var ids = S.activeAlbumIds || [];
      parts.push('id=in.(' + (ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000') + ')');
    }
    var q = (f.q || '').trim().replace(/[(),]/g, ' ');
    if (q) {
      var term = '*' + encodeURIComponent(q) + '*';
      parts.push('or=(caption.ilike.' + term + ',source_label.ilike.' + term + ',uploaded_by.ilike.' + term + ',location.ilike.' + term + ',subsystem.ilike.' + term + ')');
    }
    return parts.join('&');
  }

  async function loadPage(reset) {
    if (reset) { S.photos = []; S.offset = 0; S.hasMore = true; }
    if (!S.hasMore || S.loadingPage) return;
    S.loadingPage = true;
    try {
      var qs = currentFilterQS() + '&order=taken_at.desc&limit=' + PAGE_SIZE + '&offset=' + S.offset;
      var rows = await _fetchAnon('photos?' + qs);
      rows = Array.isArray(rows) ? rows : [];
      S.photos = S.photos.concat(rows);
      S.offset += rows.length;
      S.hasMore = rows.length === PAGE_SIZE;
    } catch (e) {
      console.error('[photos] page load failed:', e && e.message);
      S.hasMore = false;
    } finally { S.loadingPage = false; }
  }

  async function loadAlbums() {
    try {
      var rows = await _fetchAnon('photo_albums?is_deleted=eq.false&order=kind.asc,name.asc');
      S.albums = Array.isArray(rows) ? rows : [];
    } catch (e) { S.albums = []; }
  }

  // ── DOM bootstrap ───────────────────────────────────────────────────────────
  function navIcon() {
    return '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>';
  }
  function injectNav() {
    if (document.querySelector('.nav-link[data-page="photos"]')) return true;
    var after = document.querySelector('.nav-link[data-page="drawings"]')
      || document.querySelector('.nav-link[data-page="punch-workflow"]')
      || document.querySelector('.nav-link[data-page]');
    if (!after) return false;
    var link = elFrom('<a class="nav-link" data-page="photos" href="#" onclick="return false;">' + navIcon() + '<span>Photos</span></a>');
    after.parentNode.insertBefore(link, after.nextSibling);
    link.addEventListener('click', function (e) { e.preventDefault(); gotoPage(); });
    return true;
  }
  function injectPage() {
    if (document.getElementById('page-photos')) return true;
    var anchor = document.getElementById('page-punch-workflow') || document.querySelector('.page');
    if (!anchor) return false;
    anchor.parentNode.appendChild(elFrom('<section class="page" id="page-photos"><div class="container"><div id="pm-root" class="pm-wrap"></div></div></section>'));
    return true;
  }

  // ── lazy image hydration via IntersectionObserver (batched signing) ─────────
  var imgObserver = null, pendingNodes = [], signTimer = null;
  function ensureObserver() {
    if (imgObserver || !('IntersectionObserver' in window)) return;
    imgObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { imgObserver.unobserve(e.target); pendingNodes.push(e.target); } });
      clearTimeout(signTimer); signTimer = setTimeout(flushSign, 80);
    }, { rootMargin: '300px' });
  }
  async function flushSign() {
    var nodes = pendingNodes.splice(0);
    if (!nodes.length) return;
    var paths = [];
    nodes.forEach(function (n) { var p = n.getAttribute('data-thumb'); if (p && paths.indexOf(p) === -1) paths.push(p); });
    var map = await signPaths(paths);
    nodes.forEach(function (n) { var u = map[n.getAttribute('data-thumb')]; if (u) n.src = u; });
  }
  function observeImages(container) {
    ensureObserver();
    var imgs = container.querySelectorAll('img[data-thumb]:not([data-obs])');
    Array.prototype.forEach.call(imgs, function (n) {
      n.setAttribute('data-obs', '1');
      if (imgObserver) imgObserver.observe(n);
      else signOne(n.getAttribute('data-thumb')).then(function (u) { if (u) n.src = u; });
    });
  }

  // infinite-scroll sentinel
  var sentinelObserver = null;
  function observeSentinel() {
    var s = document.getElementById('pm-sentinel');
    if (!s || !('IntersectionObserver' in window)) return;
    if (sentinelObserver) sentinelObserver.disconnect();
    sentinelObserver = new IntersectionObserver(function (entries) {
      if (entries[0] && entries[0].isIntersecting && S.hasMore && !S.loadingPage) {
        loadPage(false).then(function () { paint(); });
      }
    }, { rootMargin: '400px' });
    sentinelObserver.observe(s);
  }

  // ── navigation ──────────────────────────────────────────────────────────────
  function gotoPage() { try { showPage('photos'); } catch (e) {} enter(); }
  async function enter() {
    var r = root(); if (!r) { injectPage(); r = root(); if (!r) return; }
    r.innerHTML = emptyState('Loading photos…', '');
    await loadDistinct();
    await loadPage(true);
    paint();
  }
  function root() { return document.getElementById('pm-root'); }

  // ── rendering ───────────────────────────────────────────────────────────────
  function toolbarHTML() {
    var up = canUpload() ? '<button class="pm-btn pm-btn-primary" id="pm-upload-btn">+ Add photos</button>' : '';
    var cam = canUpload() ? '<button class="pm-btn" id="pm-camera-btn" title="Capture from camera">' + icon('camera') + ' Camera</button>' : '';
    var newAlbum = canUpload() ? '<button class="pm-btn" id="pm-newalbum-btn">+ New album</button>' : '';
    var sel = '<button class="pm-btn ' + (S.selecting ? 'pm-btn-primary' : '') + '" id="pm-select-btn">' + (S.selecting ? 'Done' : 'Select') + '</button>';
    var sp = '<button class="pm-btn" disabled title="Configured after IT provisions SharePoint access">⇅ Sync to SharePoint</button>';
    var queue = '<span id="pm-queue-badge" class="pm-queue-badge" style="display:' + (S.queueCount ? '' : 'none') + '">' + (S.queueCount ? S.queueCount + ' queued' : '') + '</span>';
    return '<div class="pm-toolbar">' +
      '<div class="pm-toggle">' +
        '<button data-view="timeline" class="' + (S.view !== 'albums' && S.view !== 'album' ? 'active' : '') + '">Timeline</button>' +
        '<button data-view="albums" class="' + (S.view === 'albums' || S.view === 'album' ? 'active' : '') + '">Albums</button>' +
      '</div>' + queue + '<div class="pm-spacer"></div>' +
      sel + newAlbum + cam + sp + up +
    '</div>';
  }

  function filtersHTML() {
    var f = S.filters;
    var srcChip = function (val, label) { return '<button class="pm-chip ' + (f.source === val ? 'active' : '') + '" data-src="' + val + '">' + esc(label) + '</button>'; };
    var opts = function (vals, cur) { return vals.map(function (v) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); };
    return '<div class="pm-filters">' +
      srcChip('all', 'All') + srcChip('punch', 'Punch List') + srcChip('daily_log', 'Daily Logs') + srcChip('standalone', 'General') +
      '<select class="pm-select" id="pm-f-kind">' +
        '<option value="all"' + (f.kind === 'all' ? ' selected' : '') + '>Any kind</option>' +
        '<option value="before"' + (f.kind === 'before' ? ' selected' : '') + '>Before</option>' +
        '<option value="after"' + (f.kind === 'after' ? ' selected' : '') + '>After</option>' +
        '<option value="general"' + (f.kind === 'general' ? ' selected' : '') + '>General</option>' +
      '</select>' +
      '<select class="pm-select" id="pm-f-loc"><option value="all">All locations</option>' + opts(S.distinct.location, f.location) + '</select>' +
      '<select class="pm-select" id="pm-f-sub"><option value="all">All subsystems</option>' + opts(S.distinct.subsystem, f.subsystem) + '</select>' +
      '<input class="pm-input" id="pm-f-q" type="search" placeholder="Search caption, person…" value="' + esc(f.q) + '" />' +
    '</div>';
  }

  function tileHTML(p) {
    var label = p.caption || p.source_label || '';
    var thumb = p.thumb_path || p.storage_path;
    var kindBadge = (p.capture_kind && p.capture_kind !== 'general') ? '<span class="pm-tile-kind ' + esc(p.capture_kind) + '">' + esc(KIND_LABELS[p.capture_kind]) + '</span>' : '';
    var checked = S.selected.has(p.id);
    var check = S.selecting ? '<span class="pm-check ' + (checked ? 'on' : '') + '">' + (checked ? '✓' : '') + '</span>' : '';
    return '<div class="pm-tile ' + (checked ? 'sel' : '') + '" data-id="' + esc(p.id) + '">' +
      '<span class="pm-tile-badge ' + esc(p.source_type) + '">' + esc(SOURCE_LABELS[p.source_type] || p.source_type) + '</span>' +
      kindBadge + check +
      '<img data-thumb="' + esc(thumb) + '" alt="' + esc(label) + '" loading="lazy" />' +
      (label ? '<div class="pm-tile-meta">' + esc(label) + '</div>' : '') +
    '</div>';
  }

  function selectionBarHTML() {
    if (!S.selecting) return '';
    var n = S.selected.size;
    return '<div class="pm-selbar">' +
      '<span>' + n + ' selected</span>' +
      '<button class="pm-btn" id="pm-sel-album" ' + (n ? '' : 'disabled') + '>Add to album…</button>' +
      '<button class="pm-btn" id="pm-sel-dl" ' + (n ? '' : 'disabled') + '>Download</button>' +
      '<button class="pm-btn pm-btn-danger" id="pm-sel-del" ' + (n ? '' : 'disabled') + '>Delete</button>' +
    '</div>';
  }

  function paint() {
    var r = root(); if (!r) return;
    if (S.view === 'album' && S.activeAlbum) return paintList(true);
    if (S.view === 'albums') return paintAlbums();
    return paintList(false);
  }

  function gridSection(list) {
    if (!list.length && !S.loadingPage) return emptyState('No photos', canUpload() ? 'Use “Add photos” to capture one.' : 'Photos will appear here once captured.');
    // group by day
    var groups = {}, order = [];
    list.forEach(function (p) { var k = dayKey(p.taken_at || p.uploaded_at); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(p); });
    order.sort().reverse();
    return order.map(function (k) {
      var ps = groups[k];
      return '<div class="pm-day"><div class="pm-day-head"><span>' + esc(fmtDayHeader(ps[0].taken_at || ps[0].uploaded_at)) + '</span><span class="pm-day-count">' + ps.length + '</span></div>' +
        '<div class="pm-grid">' + ps.map(tileHTML).join('') + '</div></div>';
    }).join('') + '<div id="pm-sentinel"></div>';
  }

  function paintList(isAlbum) {
    var r = root();
    var head = toolbarHTML();
    if (isAlbum) {
      var a = S.activeAlbum;
      var manageBtns = (a.kind === 'manual' && canUpload())
        ? '<button class="pm-btn" id="pm-album-rename">Rename</button><button class="pm-btn pm-btn-danger" id="pm-album-del">Delete album</button>'
        : '';
      head += '<div class="pm-toolbar"><button class="pm-btn" id="pm-album-back">‹ All albums</button><div class="pm-spacer"></div><strong style="font-size:16px">' + esc(a.name) + '</strong>' +
        (a.kind === 'auto' ? ' <span class="pm-album-kind">Auto</span>' : '') + ' ' + manageBtns + '</div>';
    }
    head += filtersHTML() + selectionBarHTML();
    r.innerHTML = head + '<div id="pm-body">' + gridSection(S.photos) + '</div>';
    wireChrome();
    if (isAlbum) {
      bind('pm-album-back', function () { S.view = 'albums'; S.activeAlbum = null; S.activeAlbumIds = null; clearSelection(); paint(); });
      bind('pm-album-rename', renameActiveAlbum);
      bind('pm-album-del', deleteActiveAlbum);
    }
    bindTiles();
    observeImages(r);
    observeSentinel();
  }

  async function paintAlbums() {
    var r = root();
    if (!S.albums.length) await loadAlbums();
    var cards = S.albums.map(function (a) {
      return '<div class="pm-album" data-album="' + esc(a.id) + '">' +
        '<div class="pm-album-cover" id="pm-cover-' + esc(a.id) + '">' + icon('camera') + '</div>' +
        '<div class="pm-album-body"><div class="pm-album-name">' + esc(a.name) + '</div>' +
          '<div class="pm-album-sub" id="pm-count-' + esc(a.id) + '">…</div>' +
          '<span class="pm-album-kind">' + (a.kind === 'auto' ? 'Auto' : 'Album') + '</span></div></div>';
    }).join('');
    r.innerHTML = toolbarHTML() + '<div class="pm-albums">' + (cards || emptyState('No albums', '')) + '</div>';
    wireChrome();
    Array.prototype.forEach.call(r.querySelectorAll('.pm-album'), function (node) {
      node.addEventListener('click', function () { openAlbum(node.getAttribute('data-album')); });
    });
    S.albums.forEach(hydrateAlbumCard);
  }

  async function hydrateAlbumCard(a) {
    // count
    var cnt, coverPath;
    if (a.kind === 'auto') {
      cnt = await countRows('photos', 'is_deleted=eq.false&source_type=eq.' + a.auto_source_type);
      var cov = await _fetchAnon('photos?select=thumb_path,storage_path&is_deleted=eq.false&source_type=eq.' + a.auto_source_type + '&order=taken_at.desc&limit=1');
      if (cov && cov[0]) coverPath = cov[0].thumb_path || cov[0].storage_path;
    } else {
      cnt = await countRows('photo_album_items', 'album_id=eq.' + a.id);
      if (a.cover_photo_id) {
        var cp = await _fetchAnon('photos?select=thumb_path,storage_path&id=eq.' + a.cover_photo_id + '&limit=1');
        if (cp && cp[0]) coverPath = cp[0].thumb_path || cp[0].storage_path;
      }
      if (!coverPath) {
        var item = await _fetchAnon('photo_album_items?select=photo_id&album_id=eq.' + a.id + '&limit=1');
        if (item && item[0]) {
          var ph = await _fetchAnon('photos?select=thumb_path,storage_path&id=eq.' + item[0].photo_id + '&limit=1');
          if (ph && ph[0]) coverPath = ph[0].thumb_path || ph[0].storage_path;
        }
      }
    }
    var cEl = document.getElementById('pm-count-' + a.id);
    if (cEl) cEl.textContent = cnt + ' photo' + (cnt === 1 ? '' : 's');
    if (coverPath) {
      var url = await signOne(coverPath);
      var coverEl = document.getElementById('pm-cover-' + a.id);
      if (coverEl && url) coverEl.innerHTML = '<img src="' + esc(url) + '" alt="" />';
    }
  }

  function emptyState(title, sub) {
    return '<div class="pm-empty"><div class="pm-empty-icon">' + icon('camera') + '</div><div class="pm-empty-title">' + esc(title) + '</div>' + (sub ? '<div>' + esc(sub) + '</div>' : '') + '</div>';
  }

  async function openAlbum(id) {
    var a = S.albums.find(function (x) { return x.id === id; });
    if (!a) return;
    S.activeAlbum = a; S.view = 'album'; clearSelection();
    if (a.kind === 'manual') {
      var items = await _fetchAnon('photo_album_items?select=photo_id&album_id=eq.' + a.id + '&limit=500');
      S.activeAlbumIds = (items || []).map(function (x) { return x.photo_id; });
    } else { S.activeAlbumIds = null; }
    await loadPage(true);
    paint();
  }

  // ── chrome wiring ───────────────────────────────────────────────────────────
  function bind(id, fn) { var e = document.getElementById(id); if (e) e.addEventListener('click', fn); }
  function wireChrome() {
    var r = root();
    Array.prototype.forEach.call(r.querySelectorAll('.pm-toggle button'), function (b) {
      b.addEventListener('click', function () { S.view = b.getAttribute('data-view'); S.activeAlbum = null; S.activeAlbumIds = null; clearSelection(); if (S.view === 'albums') paintAlbums(); else loadPage(true).then(paint); });
    });
    bind('pm-upload-btn', function () { openUpload(); });
    bind('pm-camera-btn', function () { openUpload({ camera: true }); });
    bind('pm-newalbum-btn', openNewAlbum);
    bind('pm-select-btn', function () { S.selecting = !S.selecting; clearSelection(); paint(); });
    bind('pm-sel-album', bulkAddToAlbum);
    bind('pm-sel-dl', bulkDownload);
    bind('pm-sel-del', bulkDelete);
    // filters
    Array.prototype.forEach.call(r.querySelectorAll('.pm-chip[data-src]'), function (c) {
      c.addEventListener('click', function () { S.filters.source = c.getAttribute('data-src'); loadPage(true).then(paint); });
    });
    var kind = document.getElementById('pm-f-kind'); if (kind) kind.addEventListener('change', function () { S.filters.kind = kind.value; loadPage(true).then(paint); });
    var loc = document.getElementById('pm-f-loc'); if (loc) loc.addEventListener('change', function () { S.filters.location = loc.value; loadPage(true).then(paint); });
    var sub = document.getElementById('pm-f-sub'); if (sub) sub.addEventListener('change', function () { S.filters.subsystem = sub.value; loadPage(true).then(paint); });
    var q = document.getElementById('pm-f-q');
    if (q) { var t; q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { S.filters.q = q.value; loadPage(true).then(function () { paint(); var nq = document.getElementById('pm-f-q'); if (nq) { nq.focus(); try { nq.setSelectionRange(nq.value.length, nq.value.length); } catch (e) {} } }); }, 300); }); }
  }

  function bindTiles() {
    var r = root();
    Array.prototype.forEach.call(r.querySelectorAll('.pm-tile'), function (node) {
      node.addEventListener('click', function () {
        var id = node.getAttribute('data-id');
        if (S.selecting) {
          if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
          node.classList.toggle('sel');
          var chk = node.querySelector('.pm-check'); if (chk) { chk.classList.toggle('on'); chk.textContent = S.selected.has(id) ? '✓' : ''; }
          var bar = document.querySelector('.pm-selbar span'); if (bar) bar.textContent = S.selected.size + ' selected';
          ['pm-sel-album', 'pm-sel-dl', 'pm-sel-del'].forEach(function (bid) { var b = document.getElementById(bid); if (b) b.disabled = !S.selected.size; });
          return;
        }
        var idx = S.photos.findIndex(function (p) { return p.id === id; });
        openLightbox(S.photos, idx < 0 ? 0 : idx);
      });
    });
  }
  function clearSelection() { S.selected.clear(); }

  // ── lightbox ────────────────────────────────────────────────────────────────
  function ensureLightbox() {
    if (document.getElementById('pm-lightbox')) return;
    var lb = elFrom('<div class="pm-lightbox" id="pm-lightbox">' +
      '<div class="pm-lb-top"><div class="pm-lb-title" id="pm-lb-title"></div><button class="pm-lb-close" id="pm-lb-close" aria-label="Close">&times;</button></div>' +
      '<div class="pm-lb-stage"><button class="pm-lb-nav pm-lb-prev" id="pm-lb-prev">‹</button><img id="pm-lb-img" alt="" /><button class="pm-lb-nav pm-lb-next" id="pm-lb-next">›</button></div>' +
      '<div class="pm-lb-info" id="pm-lb-info"></div></div>');
    document.body.appendChild(lb);
    bind('pm-lb-close', closeLightbox);
    bind('pm-lb-prev', function () { stepLightbox(-1); });
    bind('pm-lb-next', function () { stepLightbox(1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    });
  }
  function openLightbox(list, i) { ensureLightbox(); S.lb.list = list; S.lb.i = i; document.getElementById('pm-lightbox').classList.add('open'); showLightbox(); }
  function closeLightbox() { var lb = document.getElementById('pm-lightbox'); if (lb) lb.classList.remove('open'); }
  function stepLightbox(d) { if (!S.lb.list.length) return; S.lb.i = (S.lb.i + d + S.lb.list.length) % S.lb.list.length; showLightbox(); }
  function showLightbox() {
    var p = S.lb.list[S.lb.i]; if (!p) return;
    var img = document.getElementById('pm-lb-img'); img.src = '';
    signOne(p.storage_path).then(function (u) { if (u) img.src = u; });
    document.getElementById('pm-lb-title').textContent = (S.lb.i + 1) + ' / ' + S.lb.list.length;
    var when = p.taken_at || p.uploaded_at;
    var rows = [
      ['Source', SOURCE_LABELS[p.source_type] || p.source_type],
      ['Reference', p.source_label || '—'],
      ['Kind', KIND_LABELS[p.capture_kind] || 'General'],
      ['Caption', p.caption || '—'],
      ['Location', p.location || '—'],
      ['Subsystem', p.subsystem || '—'],
      ['Phase', p.phase || '—'],
      ['Taken', when ? new Date(when).toLocaleString() : '—'],
      ['Uploaded by', p.uploaded_by || '—'],
    ];
    var btns = '';
    if (canUpload()) btns += '<button class="pm-btn" id="pm-lb-edit">Edit</button>';
    if (canUpload()) btns += '<button class="pm-btn" id="pm-lb-add">Add to album…</button>';
    if (S.view === 'album' && S.activeAlbum && S.activeAlbum.kind === 'manual' && canUpload()) btns += '<button class="pm-btn" id="pm-lb-cover">Set as cover</button>';
    if (canDeletePhoto(p)) btns += '<button class="pm-btn pm-btn-danger" id="pm-lb-del">Delete</button>';
    document.getElementById('pm-lb-info').innerHTML = '<dl>' + rows.map(function (kv) { return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>'; }).join('') + '</dl><div class="pm-lb-actions">' + btns + '</div>';
    bind('pm-lb-edit', function () { openEditPhoto(p); });
    bind('pm-lb-add', function () { openAddToAlbum([p.id]); });
    bind('pm-lb-cover', function () { setAlbumCover(S.activeAlbum, p.id); });
    bind('pm-lb-del', function () { deletePhoto(p); });
  }

  // ── upload modal (with optional direct camera) ──────────────────────────────
  function openUpload(preset) {
    if (!canUpload()) { toast('Your role cannot upload photos.'); return; }
    preset = preset || {};
    var manual = S.albums.filter(function (a) { return a.kind === 'manual'; });
    var albumOpts = manual.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('');
    var captureAttr = preset.camera ? ' capture="environment"' : '';
    var body =
      '<div class="pm-drop" id="pm-drop">' + (preset.camera ? 'Tap to open camera' : 'Click to choose photos, or drop them here') +
        '<input type="file" id="pm-file" accept="image/*"' + captureAttr + ' multiple style="display:none" /></div>' +
      '<div class="pm-preview-row" id="pm-previews"></div>' +
      '<div class="pm-field" style="margin-top:14px"><label>Source</label><select id="pm-src">' +
        '<option value="standalone"' + (!preset.source_type || preset.source_type === 'standalone' ? ' selected' : '') + '>General (standalone)</option>' +
        '<option value="punch"' + (preset.source_type === 'punch' ? ' selected' : '') + '>Punch List item</option>' +
        '<option value="daily_log"' + (preset.source_type === 'daily_log' ? ' selected' : '') + '>Daily Log</option>' +
      '</select></div>' +
      '<div class="pm-field" id="pm-kind-wrap" style="display:' + (preset.source_type === 'punch' ? '' : 'none') + '"><label>Before / after</label><select id="pm-kind">' +
        '<option value="general">General</option><option value="before"' + (preset.capture_kind === 'before' ? ' selected' : '') + '>Before</option><option value="after"' + (preset.capture_kind === 'after' ? ' selected' : '') + '>After</option>' +
      '</select></div>' +
      '<div class="pm-field"><label>Reference / label</label><input id="pm-ref" value="' + esc(preset.source_label || '') + '" placeholder="e.g. punch # or log date" /></div>' +
      '<div class="pm-field"><label>Caption</label><input id="pm-cap" placeholder="Optional description" /></div>' +
      '<div class="pm-field"><label>Phase</label><select id="pm-pha">' + optionList(phaseNames(), preset.phase || '', 'Select phase…') + '</select></div>' +
      '<div class="pm-field"><label>Location</label><select id="pm-loc">' + optionList(locationNames(preset.phase || ''), preset.location || '', 'Select location…') + '</select></div>' +
      '<div class="pm-field"><label>Subsystem</label><select id="pm-sub">' + optionList(projSubsystems(), preset.subsystem || '', 'Select subsystem…') + '</select></div>' +
      (albumOpts ? '<div class="pm-field"><label>Also add to album (optional)</label><select id="pm-alb"><option value="">— none —</option>' + albumOpts + '</select></div>' : '') +
      '<div id="pm-up-status" style="font-size:12px;color:#71717a"></div>';
    var footer = '<button class="pm-btn" onclick="closeModal()">Cancel</button><button class="pm-btn pm-btn-primary" id="pm-do-upload">Upload</button>';
    modal({ title: preset.camera ? 'Capture photo' : 'Add photos', sub: 'Photos are compressed, queued offline-safe, and appear in the timeline + matching album.', body: body, footer: footer, size: 'large' });

    var chosen = [];
    var fileInput = document.getElementById('pm-file');
    var drop = document.getElementById('pm-drop');
    var previews = document.getElementById('pm-previews');
    var srcSel = document.getElementById('pm-src');
    srcSel.addEventListener('change', function () { document.getElementById('pm-kind-wrap').style.display = srcSel.value === 'punch' ? '' : 'none'; });
    // Phase drives the Location list (matches the punch form behaviour).
    var phaSel = document.getElementById('pm-pha'), locSel = document.getElementById('pm-loc');
    if (phaSel && locSel) phaSel.addEventListener('change', function () {
      var cur = locSel.value;
      locSel.innerHTML = optionList(locationNames(phaSel.value), locationNames(phaSel.value).indexOf(cur) !== -1 ? cur : '', 'Select location…');
    });
    function addFiles(files) {
      Array.prototype.forEach.call(files, function (f) { if (f.type.indexOf('image/') === 0) chosen.push(f); });
      previews.innerHTML = chosen.map(function (f) { return '<img class="pm-preview" src="' + URL.createObjectURL(f) + '" />'; }).join('');
    }
    drop.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { addFiles(fileInput.files); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('drag'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('drag'); addFiles(e.dataTransfer.files); });

    bind('pm-do-upload', async function () {
      if (!chosen.length) { toast('Choose at least one photo.'); return; }
      var meta = {
        source_type: srcSel.value,
        capture_kind: srcSel.value === 'punch' ? (document.getElementById('pm-kind').value || 'general') : 'general',
        source_id: preset.source_id || null,
        source_label: document.getElementById('pm-ref').value.trim() || null,
        caption: document.getElementById('pm-cap').value.trim() || null,
        location: document.getElementById('pm-loc').value.trim() || null,
        subsystem: document.getElementById('pm-sub').value.trim() || null,
        phase: document.getElementById('pm-pha').value.trim() || null,
        album_id: (document.getElementById('pm-alb') || {}).value || null,
        uploaded_by: userName(),
      };
      var btn = document.getElementById('pm-do-upload'); if (btn) btn.disabled = true;
      var status = document.getElementById('pm-up-status'); if (status) status.textContent = 'Processing…';
      var n = 0;
      try {
        n = await enqueueFiles(chosen, meta);
      } catch (e) {
        console.error('[photos] enqueue failed:', e && e.message);
        if (status) status.textContent = '';
        if (btn) btn.disabled = false;
        toast('Could not process the photo: ' + ((e && e.message) || 'unknown error'));
        return;
      }
      if (!n) {
        if (status) status.textContent = '';
        if (btn) btn.disabled = false;
        toast('Could not read that photo — try again or pick from your library.');
        return;
      }
      closeModal();
      toast(n + ' photo' + (n === 1 ? '' : 's') + (navigator.onLine ? ' uploading…' : ' queued (offline)'));
      processQueue();
    });
  }

  // ── edit photo metadata ─────────────────────────────────────────────────────
  function openEditPhoto(p) {
    var kindWrap = p.source_type === 'punch'
      ? '<div class="pm-field"><label>Before / after</label><select id="pe-kind"><option value="general"' + (p.capture_kind === 'general' ? ' selected' : '') + '>General</option><option value="before"' + (p.capture_kind === 'before' ? ' selected' : '') + '>Before</option><option value="after"' + (p.capture_kind === 'after' ? ' selected' : '') + '>After</option></select></div>'
      : '';
    var body =
      '<div class="pm-field"><label>Caption</label><input id="pe-cap" value="' + esc(p.caption || '') + '" /></div>' +
      kindWrap +
      '<div class="pm-field"><label>Phase</label><select id="pe-pha">' + optionList(phaseNames(), p.phase || '', 'Select phase…') + '</select></div>' +
      '<div class="pm-field"><label>Location</label><select id="pe-loc">' + optionList(locationNames(p.phase || ''), p.location || '', 'Select location…') + '</select></div>' +
      '<div class="pm-field"><label>Subsystem</label><select id="pe-sub">' + optionList(projSubsystems(), p.subsystem || '', 'Select subsystem…') + '</select></div>' +
      '<div class="pm-field"><label>Tags (comma-separated)</label><input id="pe-tags" value="' + esc((p.tags || []).join(', ')) + '" /></div>';
    modal({ title: 'Edit photo', body: body, footer: '<button class="pm-btn" onclick="closeModal()">Cancel</button><button class="pm-btn pm-btn-primary" id="pe-save">Save</button>' });
    var pePha = document.getElementById('pe-pha'), peLoc = document.getElementById('pe-loc');
    if (pePha && peLoc) pePha.addEventListener('change', function () {
      var cur = peLoc.value;
      peLoc.innerHTML = optionList(locationNames(pePha.value), locationNames(pePha.value).indexOf(cur) !== -1 ? cur : '', 'Select location…');
    });
    bind('pe-save', async function () {
      var patch = {
        caption: document.getElementById('pe-cap').value.trim() || null,
        location: document.getElementById('pe-loc').value.trim() || null,
        subsystem: document.getElementById('pe-sub').value.trim() || null,
        phase: document.getElementById('pe-pha').value.trim() || null,
        tags: document.getElementById('pe-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      };
      var kindEl = document.getElementById('pe-kind'); if (kindEl) patch.capture_kind = kindEl.value;
      try {
        await _dbUpdate('photos', patch, { id: p.id });
        Object.assign(p, patch);
        closeModal(); toast('Photo updated.'); S.distinct.loaded = false;
        showLightbox(); paint();
      } catch (e) { toast('Could not save: ' + (e && e.message)); }
    });
  }

  // ── manual albums ────────────────────────────────────────────────────────────
  function openNewAlbum() {
    if (!canUpload()) return;
    modal({ title: 'New album', sub: 'A custom album you fill by adding photos.', body:
      '<div class="pm-field"><label>Album name</label><input id="pm-na-name" placeholder="e.g. Station A — Progress" /></div>' +
      '<div class="pm-field"><label>Description</label><textarea id="pm-na-desc" rows="3"></textarea></div>',
      footer: '<button class="pm-btn" onclick="closeModal()">Cancel</button><button class="pm-btn pm-btn-primary" id="pm-na-save">Create album</button>' });
    bind('pm-na-save', async function () {
      var name = document.getElementById('pm-na-name').value.trim();
      if (!name) { toast('Album needs a name.'); return; }
      try {
        await _dbInsert('photo_albums', [{ name: name, slug: slugify(name) + '-' + Math.random().toString(16).slice(2, 6), kind: 'manual', description: document.getElementById('pm-na-desc').value.trim() || null, created_by: userName() }]);
        closeModal(); toast('Album created.'); await loadAlbums(); S.view = 'albums'; paintAlbums();
      } catch (e) { toast('Could not create album: ' + (e && e.message)); }
    });
  }
  function renameActiveAlbum() {
    var a = S.activeAlbum; if (!a || a.kind !== 'manual') return;
    modal({ title: 'Rename album', body: '<div class="pm-field"><label>Name</label><input id="pm-rn" value="' + esc(a.name) + '" /></div>', footer: '<button class="pm-btn" onclick="closeModal()">Cancel</button><button class="pm-btn pm-btn-primary" id="pm-rn-save">Save</button>' });
    bind('pm-rn-save', async function () {
      var name = document.getElementById('pm-rn').value.trim(); if (!name) return;
      try { await _dbUpdate('photo_albums', { name: name, updated_at: new Date().toISOString() }, { id: a.id }); a.name = name; closeModal(); toast('Renamed.'); paint(); } catch (e) { toast('Could not rename: ' + (e && e.message)); }
    });
  }
  async function deleteActiveAlbum() {
    var a = S.activeAlbum; if (!a || a.kind !== 'manual') return;
    if (!window.confirm('Delete album “' + a.name + '”? Photos are not deleted — only the album.')) return;
    try {
      await _dbUpdate('photo_albums', { is_deleted: true }, { id: a.id });
      toast('Album deleted.'); S.view = 'albums'; S.activeAlbum = null; await loadAlbums(); paintAlbums();
    } catch (e) { toast('Could not delete album: ' + (e && e.message)); }
  }
  async function setAlbumCover(a, photoId) {
    if (!a || a.kind !== 'manual') return;
    try { await _dbUpdate('photo_albums', { cover_photo_id: photoId, updated_at: new Date().toISOString() }, { id: a.id }); a.cover_photo_id = photoId; toast('Album cover set.'); } catch (e) { toast('Could not set cover: ' + (e && e.message)); }
  }

  function openAddToAlbum(photoIds) {
    var manual = S.albums.filter(function (a) { return a.kind === 'manual'; });
    if (!manual.length) { modal({ title: 'No albums yet', body: '<p>Create an album first (Albums tab → “New album”).</p>', footer: '<button class="pm-btn pm-btn-primary" onclick="closeModal()">OK</button>' }); return; }
    var opts = manual.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('');
    modal({ title: 'Add to album', body: '<div class="pm-field"><label>Album</label><select id="pm-ata">' + opts + '</select></div>', footer: '<button class="pm-btn" onclick="closeModal()">Cancel</button><button class="pm-btn pm-btn-primary" id="pm-ata-save">Add ' + photoIds.length + '</button>' });
    bind('pm-ata-save', async function () {
      var albumId = document.getElementById('pm-ata').value;
      var rows = photoIds.map(function (pid) { return { album_id: albumId, photo_id: pid, added_by: userName() }; });
      var ok = 0;
      for (var i = 0; i < rows.length; i++) { try { await _dbInsert('photo_album_items', [rows[i]]); ok++; } catch (e) { /* dup ignored */ } }
      closeModal(); toast(ok + ' added to album.');
    });
  }

  // ── bulk actions ──────────────────────────────────────────────────────────────
  function selectedPhotos() { return S.photos.filter(function (p) { return S.selected.has(p.id); }); }
  function bulkAddToAlbum() { if (S.selected.size) openAddToAlbum(Array.from(S.selected)); }
  async function bulkDownload() {
    var list = selectedPhotos();
    for (var i = 0; i < list.length; i++) {
      var u = await signOne(list[i].storage_path);
      if (!u) continue;
      try {
        var blob = await (await fetch(u)).blob();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = list[i].file_name || (list[i].id + '.jpg');
        document.body.appendChild(a); a.click(); a.remove();
        await new Promise(function (r) { setTimeout(r, 300); });
      } catch (e) { console.warn('[photos] download failed:', e && e.message); }
    }
    toast('Downloaded ' + list.length + ' photo' + (list.length === 1 ? '' : 's') + '.');
  }
  async function bulkDelete() {
    var list = selectedPhotos();
    if (!list.length) return;
    var deletable = list.filter(canDeletePhoto);
    if (deletable.length < list.length) toast('Some photos can only be deleted by their uploader or an admin.');
    if (!deletable.length) return;
    if (!window.confirm('Delete ' + deletable.length + ' photo' + (deletable.length === 1 ? '' : 's') + '?')) return;
    var paths = [];
    for (var i = 0; i < deletable.length; i++) {
      try {
        await _dbUpdate('photos', { is_deleted: true }, { id: deletable[i].id });
        if (deletable[i].storage_path) paths.push(deletable[i].storage_path);
        if (deletable[i].thumb_path) paths.push(deletable[i].thumb_path);
      } catch (e) { /* keep going */ }
    }
    await storageRemove(paths);
    toast('Deleted ' + deletable.length + '.'); clearSelection(); S.distinct.loaded = false;
    await loadPage(true); paint();
  }

  async function deletePhoto(p) {
    if (!canDeletePhoto(p)) return;
    if (!window.confirm('Delete this photo? It will be removed from the timeline and albums.')) return;
    try {
      await _dbUpdate('photos', { is_deleted: true }, { id: p.id });
      await storageRemove([p.storage_path, p.thumb_path].filter(Boolean));
      closeLightbox(); toast('Photo deleted.'); S.distinct.loaded = false;
      await loadPage(true); paint();
    } catch (e) { toast('Could not delete: ' + (e && e.message)); }
  }

  // ── external API helpers (used by app.js, e.g. punch detail view) ───────────
  // List photos for a given source (e.g. a punch item), newest first.
  async function listFor(opts) {
    opts = opts || {};
    var parts = ['is_deleted=eq.false'];
    if (opts.source_type) parts.push('source_type=eq.' + opts.source_type);
    if (opts.source_id)   parts.push('source_id=eq.' + encodeURIComponent(opts.source_id));
    parts.push('order=taken_at.desc');
    try { return (await _fetchAnon('photos?' + parts.join('&'))) || []; }
    catch (e) { console.warn('[photos] listFor failed:', e && e.message); return []; }
  }
  // Direct (non-queued) upload of one file; compresses, stores, inserts the row,
  // and returns the inserted photo row. Used for inline/attached uploads where the
  // caller needs the row back immediately.
  async function uploadFile(file, meta) {
    meta = meta || {};
    var proc = await processImage(file);
    var id = uuid();
    var src = meta.source_type || 'standalone';
    var displayPath = src + '/' + id + '.jpg';
    var thumbPath   = src + '/thumb/' + id + '.jpg';
    await storageUpload(displayPath, proc.display, 'image/jpeg');
    try { await storageUpload(thumbPath, proc.thumb, 'image/jpeg'); } catch (e) { thumbPath = null; }
    var row = {
      storage_path: displayPath, thumb_path: thumbPath,
      file_name: file.name || ('photo-' + Date.now() + '.jpg'),
      mime_type: 'image/jpeg', file_size: (proc.display && proc.display.size) || null,
      width: proc.dims && proc.dims.w, height: proc.dims && proc.dims.h,
      caption: meta.caption || null,
      source_type: src, source_id: meta.source_id || null, source_label: meta.source_label || null,
      capture_kind: meta.capture_kind || 'general',
      location: meta.location || null, subsystem: meta.subsystem || null, phase: meta.phase || null,
      taken_at: new Date(file.lastModified || Date.now()).toISOString(),
      uploaded_by: userName(),
    };
    var inserted = await _dbInsert('photos', [row]);
    return (inserted && inserted[0]) || row;
  }

  // ── boot ────────────────────────────────────────────────────────────────────
  function boot() {
    if (S.booted) return; S.booted = true;
    injectNav();
    injectPage();
    ensureLightbox();
    refreshQueueCount().then(function () { if (S.queueCount) processQueue(); });
    window.addEventListener('online', processQueue);
    window.addEventListener('popstate', function () { if ((location.hash || '').slice(1) === 'photos') enter(); });
    if ((location.hash || '').slice(1) === 'photos') setTimeout(gotoPage, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.PhotosModule = {
    enter: enter, goto: gotoPage, openUpload: openUpload,
    captureFor: function (opts) { openUpload(opts || {}); },
    processQueue: processQueue, state: S,
    sign: signPaths, signOne: signOne, listFor: listFor, uploadFile: uploadFile,
  };
})();
