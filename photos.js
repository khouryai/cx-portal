/* ============================================================================
   Photos Module — self-contained, self-bootstrapping.

   Loaded as a classic <script> right after app.js, so it shares the global
   scope and reuses the app's existing helpers rather than reinventing them:
     • _sb.storage.from('photos')      — upload / signed URLs (as Forms module does)
     • _dbInsert / _dbUpdate           — native-fetch DB writes (reliable on resume)
     • _fetchAnon(path)                — REST reads (returns parsed JSON)
     • modal({...}) / closeModal()     — shared dialog chrome
     • currentRoleUser                 — { name, role }
     • showPage(name)                  — page chrome switch

   It injects its own nav link and #page-photos section so no deep edits to the
   1.7 MB app.js are required. Public surface: window.PhotosModule.
   ============================================================================ */
(function () {
  'use strict';

  var BUCKET = 'photos';
  var SIGN_TTL = 3600; // seconds
  var UPLOAD_ROLES = ['admin', 'field_engineer', 'technician', 'punch_manager'];
  var SOURCE_LABELS = { punch: 'Punch List', daily_log: 'Daily Logs', standalone: 'General' };

  var S = {
    view: 'timeline',          // 'timeline' | 'albums' | 'album'
    loaded: false,
    loading: false,
    photos: [],
    albums: [],
    albumItems: [],            // { album_id, photo_id }
    activeAlbum: null,
    filters: { source: 'all', location: 'all', subsystem: 'all', q: '' },
    signed: new Map(),         // storage_path -> { url, exp }
    lb: { list: [], i: 0 },
  };

  // ── small utils ─────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function role() { try { return (window.currentRoleUser && currentRoleUser.role) || null; } catch (e) { return null; } }
  function userName() { try { return (window.currentRoleUser && currentRoleUser.name) || 'unknown'; } catch (e) { return 'unknown'; } }
  function canUpload() { return UPLOAD_ROLES.indexOf(role()) !== -1; }
  function canDeletePhoto(p) { return role() === 'admin' || (p && p.uploaded_by === userName()); }
  function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  function toast(msg) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg);
      if (typeof window.toast === 'function' && window.toast.length) return window.toast(msg);
    } catch (e) {}
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

  // ── data access ───────────────────────────────────────────────────────────
  async function loadData(force) {
    if (S.loading) return;
    if (S.loaded && !force) return;
    S.loading = true;
    try {
      var photos = await _fetchAnon('photos?is_deleted=eq.false&order=taken_at.desc');
      var albums = await _fetchAnon('photo_albums?is_deleted=eq.false&order=kind.asc,name.asc');
      var items = await _fetchAnon('photo_album_items?select=album_id,photo_id');
      S.photos = Array.isArray(photos) ? photos : [];
      S.albums = Array.isArray(albums) ? albums : [];
      S.albumItems = Array.isArray(items) ? items : [];
      S.loaded = true;
    } catch (e) {
      console.error('[photos] load failed:', e && e.message);
      toast('Could not load photos: ' + (e && e.message ? e.message : 'unknown error'));
    } finally {
      S.loading = false;
    }
  }

  async function signedUrl(path) {
    if (!path) return '';
    var now = Date.now();
    var hit = S.signed.get(path);
    if (hit && hit.exp > now + 30000) return hit.url;
    try {
      var res = await _sb.storage.from(BUCKET).createSignedUrl(path, SIGN_TTL);
      if (res && res.data && res.data.signedUrl) {
        S.signed.set(path, { url: res.data.signedUrl, exp: now + SIGN_TTL * 1000 });
        return res.data.signedUrl;
      }
    } catch (e) { console.warn('[photos] sign failed for', path, e && e.message); }
    return '';
  }

  // Resolve signed URLs for a set of <img data-path> nodes lazily.
  async function hydrateImages(container) {
    var imgs = Array.prototype.slice.call(container.querySelectorAll('img[data-path]:not([data-done])'));
    for (var i = 0; i < imgs.length; i++) {
      var node = imgs[i];
      node.setAttribute('data-done', '1');
      // eslint-disable-next-line no-loop-func
      (function (n) { signedUrl(n.getAttribute('data-path')).then(function (u) { if (u) n.src = u; }); })(node);
    }
  }

  // ── filtering ───────────────────────────────────────────────────────────
  function distinct(field) {
    var set = {};
    S.photos.forEach(function (p) { if (p[field]) set[p[field]] = true; });
    return Object.keys(set).sort();
  }
  function applyFilters(list) {
    var f = S.filters;
    var q = (f.q || '').trim().toLowerCase();
    return list.filter(function (p) {
      if (f.source !== 'all' && p.source_type !== f.source) return false;
      if (f.location !== 'all' && p.location !== f.location) return false;
      if (f.subsystem !== 'all' && p.subsystem !== f.subsystem) return false;
      if (q) {
        var hay = [p.caption, p.source_label, p.uploaded_by, p.location, p.subsystem].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // ── DOM bootstrap ─────────────────────────────────────────────────────────
  function navIcon() {
    return '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>' +
      '<circle cx="8.5" cy="8.5" r="1.5"></circle>' +
      '<path d="M21 15l-5-5L5 21"></path></svg>';
  }

  function injectNav() {
    if (document.querySelector('.nav-link[data-page="photos"]')) return;
    // Insert next to an existing nav link so it lands in the same container.
    var anchorAfter = document.querySelector('.nav-link[data-page="drawings"]')
      || document.querySelector('.nav-link[data-page="punch-workflow"]')
      || document.querySelector('.nav-link[data-page]');
    if (!anchorAfter) return false;
    var link = el('<a class="nav-link" data-page="photos" href="#" onclick="return false;">' + navIcon() + '<span>Photos</span></a>');
    anchorAfter.parentNode.insertBefore(link, anchorAfter.nextSibling);
    link.addEventListener('click', function (e) { e.preventDefault(); goto(); });
    return true;
  }

  function injectPage() {
    if (document.getElementById('page-photos')) return;
    var anchor = document.getElementById('page-punch-workflow')
      || document.querySelector('.page');
    if (!anchor) return false;
    var page = el(
      '<section class="page" id="page-photos">' +
        '<div class="container"><div id="pm-root" class="pm-wrap"></div></div>' +
      '</section>'
    );
    anchor.parentNode.appendChild(page);
    return true;
  }

  function ensureLightbox() {
    if (document.getElementById('pm-lightbox')) return;
    var lb = el(
      '<div class="pm-lightbox" id="pm-lightbox">' +
        '<div class="pm-lb-top"><div class="pm-lb-title" id="pm-lb-title"></div>' +
          '<button class="pm-lb-close" id="pm-lb-close" aria-label="Close">&times;</button></div>' +
        '<div class="pm-lb-stage">' +
          '<button class="pm-lb-nav pm-lb-prev" id="pm-lb-prev" aria-label="Previous">&#8249;</button>' +
          '<img id="pm-lb-img" alt="" />' +
          '<button class="pm-lb-nav pm-lb-next" id="pm-lb-next" aria-label="Next">&#8250;</button>' +
        '</div>' +
        '<div class="pm-lb-info" id="pm-lb-info"></div>' +
      '</div>'
    );
    document.body.appendChild(lb);
    lb.querySelector('#pm-lb-close').addEventListener('click', closeLightbox);
    lb.querySelector('#pm-lb-prev').addEventListener('click', function () { stepLightbox(-1); });
    lb.querySelector('#pm-lb-next').addEventListener('click', function () { stepLightbox(1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    });
  }

  // ── navigation into the module ─────────────────────────────────────────────
  function goto() {
    try { showPage('photos'); } catch (e) { /* showPage may not be global yet */ }
    render();
  }

  // ── rendering ───────────────────────────────────────────────────────────
  function root() { return document.getElementById('pm-root'); }

  function render() {
    var r = root();
    if (!r) { injectPage(); r = root(); if (!r) return; }
    if (!S.loaded) {
      r.innerHTML = '<div class="pm-empty"><div class="pm-empty-icon">&#128247;</div><div class="pm-empty-title">Loading photos…</div></div>';
      loadData().then(paint);
    } else {
      paint();
    }
  }

  function toolbarHTML() {
    var up = canUpload()
      ? '<button class="pm-btn pm-btn-primary" id="pm-upload-btn">&#43; Add photos</button>'
      : '';
    var newAlbum = canUpload()
      ? '<button class="pm-btn" id="pm-newalbum-btn">&#43; New album</button>'
      : '';
    var sp = '<button class="pm-btn" disabled title="Configured after IT provisions SharePoint access">&#8645; Sync to SharePoint</button>';
    return '' +
      '<div class="pm-toolbar">' +
        '<div class="pm-toggle">' +
          '<button data-view="timeline" class="' + (S.view !== 'albums' && S.view !== 'album' ? 'active' : '') + '">Timeline</button>' +
          '<button data-view="albums" class="' + (S.view === 'albums' || S.view === 'album' ? 'active' : '') + '">Albums</button>' +
        '</div>' +
        '<div class="pm-spacer"></div>' +
        newAlbum + sp + up +
      '</div>';
  }

  function filtersHTML() {
    var f = S.filters;
    var srcChip = function (val, label) {
      return '<button class="pm-chip ' + (f.source === val ? 'active' : '') + '" data-src="' + val + '">' + esc(label) + '</button>';
    };
    var opts = function (vals, cur) {
      return vals.map(function (v) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
    };
    return '' +
      '<div class="pm-filters">' +
        srcChip('all', 'All') + srcChip('punch', 'Punch List') + srcChip('daily_log', 'Daily Logs') + srcChip('standalone', 'General') +
        '<select class="pm-select" id="pm-f-loc"><option value="all">All locations</option>' + opts(distinct('location'), f.location) + '</select>' +
        '<select class="pm-select" id="pm-f-sub"><option value="all">All subsystems</option>' + opts(distinct('subsystem'), f.subsystem) + '</select>' +
        '<input class="pm-input" id="pm-f-q" type="search" placeholder="Search caption, person…" value="' + esc(f.q) + '" />' +
      '</div>';
  }

  function tileHTML(p) {
    var label = p.caption || p.source_label || '';
    return '' +
      '<div class="pm-tile" data-id="' + esc(p.id) + '">' +
        '<span class="pm-tile-badge ' + esc(p.source_type) + '">' + esc(SOURCE_LABELS[p.source_type] || p.source_type) + '</span>' +
        '<img data-path="' + esc(p.storage_path) + '" alt="' + esc(label) + '" loading="lazy" />' +
        (label ? '<div class="pm-tile-meta">' + esc(label) + '</div>' : '') +
      '</div>';
  }

  function paint() {
    var r = root();
    if (!r) return;
    if (S.view === 'album' && S.activeAlbum) return paintAlbumDetail();
    if (S.view === 'albums') return paintAlbums();
    return paintTimeline();
  }

  function paintTimeline() {
    var r = root();
    var list = applyFilters(S.photos);
    var body;
    if (!list.length) {
      body = emptyState('No photos yet', canUpload() ? 'Use “Add photos” to capture your first one.' : 'Photos will appear here once captured.');
    } else {
      // group by day
      var groups = {}; var order = [];
      list.forEach(function (p) {
        var k = dayKey(p.taken_at || p.uploaded_at);
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(p);
      });
      order.sort().reverse();
      body = order.map(function (k) {
        var ps = groups[k];
        return '<div class="pm-day">' +
          '<div class="pm-day-head"><span>' + esc(fmtDayHeader(ps[0].taken_at || ps[0].uploaded_at)) + '</span><span class="pm-day-count">' + ps.length + ' photo' + (ps.length > 1 ? 's' : '') + '</span></div>' +
          '<div class="pm-grid">' + ps.map(tileHTML).join('') + '</div></div>';
      }).join('');
    }
    r.innerHTML = toolbarHTML() + filtersHTML() + '<div id="pm-body">' + body + '</div>';
    wireChrome();
    bindTiles(list);
    hydrateImages(r);
  }

  function paintAlbums() {
    var r = root();
    var cards = S.albums.map(function (a) {
      var count = albumCount(a);
      var cover = albumCover(a);
      var coverHTML = cover
        ? '<img data-path="' + esc(cover) + '" alt="" />'
        : '&#128247;';
      return '<div class="pm-album" data-album="' + esc(a.id) + '">' +
        '<div class="pm-album-cover">' + coverHTML + '</div>' +
        '<div class="pm-album-body">' +
          '<div class="pm-album-name">' + esc(a.name) + '</div>' +
          '<div class="pm-album-sub">' + count + ' photo' + (count === 1 ? '' : 's') + '</div>' +
          '<span class="pm-album-kind">' + (a.kind === 'auto' ? 'Auto' : 'Album') + '</span>' +
        '</div></div>';
    }).join('');
    r.innerHTML = toolbarHTML() + '<div class="pm-albums">' + (cards || emptyState('No albums', '')) + '</div>';
    wireChrome();
    Array.prototype.forEach.call(r.querySelectorAll('.pm-album'), function (node) {
      node.addEventListener('click', function () { openAlbum(node.getAttribute('data-album')); });
    });
    hydrateImages(r);
  }

  function paintAlbumDetail() {
    var r = root();
    var a = S.activeAlbum;
    var list = photosInAlbum(a);
    var grid = list.length ? '<div class="pm-grid">' + list.map(tileHTML).join('') + '</div>'
      : emptyState('This album is empty', '');
    r.innerHTML = toolbarHTML() +
      '<div class="pm-toolbar"><button class="pm-btn" id="pm-album-back">&#8249; All albums</button>' +
        '<div class="pm-spacer"></div>' +
        '<strong style="font-size:16px">' + esc(a.name) + '</strong></div>' +
      grid;
    wireChrome();
    var back = document.getElementById('pm-album-back');
    if (back) back.addEventListener('click', function () { S.view = 'albums'; S.activeAlbum = null; paint(); });
    bindTiles(list);
    hydrateImages(r);
  }

  function emptyState(title, sub) {
    return '<div class="pm-empty"><div class="pm-empty-icon">&#128247;</div>' +
      '<div class="pm-empty-title">' + esc(title) + '</div>' +
      (sub ? '<div>' + esc(sub) + '</div>' : '') + '</div>';
  }

  // ── album helpers ─────────────────────────────────────────────────────────
  function albumCount(a) {
    if (a.kind === 'auto') return S.photos.filter(function (p) { return p.source_type === a.auto_source_type; }).length;
    var ids = {}; S.albumItems.forEach(function (it) { if (it.album_id === a.id) ids[it.photo_id] = true; });
    return S.photos.filter(function (p) { return ids[p.id]; }).length;
  }
  function albumCover(a) {
    if (a.cover_photo_id) {
      var c = S.photos.find(function (p) { return p.id === a.cover_photo_id; });
      if (c) return c.storage_path;
    }
    var list = photosInAlbum(a);
    return list.length ? list[0].storage_path : '';
  }
  function photosInAlbum(a) {
    if (a.kind === 'auto') return S.photos.filter(function (p) { return p.source_type === a.auto_source_type; });
    var ids = {}; S.albumItems.forEach(function (it) { if (it.album_id === a.id) ids[it.photo_id] = true; });
    return S.photos.filter(function (p) { return ids[p.id]; });
  }
  function openAlbum(id) {
    var a = S.albums.find(function (x) { return x.id === id; });
    if (!a) return;
    S.activeAlbum = a; S.view = 'album'; paint();
  }

  // ── chrome wiring ─────────────────────────────────────────────────────────
  function wireChrome() {
    var r = root();
    Array.prototype.forEach.call(r.querySelectorAll('.pm-toggle button'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-view');
        S.view = v; S.activeAlbum = null; paint();
      });
    });
    var up = document.getElementById('pm-upload-btn');
    if (up) up.addEventListener('click', function () { openUpload(); });
    var na = document.getElementById('pm-newalbum-btn');
    if (na) na.addEventListener('click', function () { openNewAlbum(); });
    // filters
    Array.prototype.forEach.call(r.querySelectorAll('.pm-chip[data-src]'), function (c) {
      c.addEventListener('click', function () { S.filters.source = c.getAttribute('data-src'); paint(); });
    });
    var loc = document.getElementById('pm-f-loc');
    if (loc) loc.addEventListener('change', function () { S.filters.location = loc.value; paint(); });
    var sub = document.getElementById('pm-f-sub');
    if (sub) sub.addEventListener('change', function () { S.filters.subsystem = sub.value; paint(); });
    var q = document.getElementById('pm-f-q');
    if (q) {
      var t;
      q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { S.filters.q = q.value; var pos = q.value.length; paint(); var nq = document.getElementById('pm-f-q'); if (nq) { nq.focus(); try { nq.setSelectionRange(pos, pos); } catch (e) {} } }, 250); });
    }
  }

  function bindTiles(list) {
    var r = root();
    Array.prototype.forEach.call(r.querySelectorAll('.pm-tile'), function (node) {
      node.addEventListener('click', function () {
        var id = node.getAttribute('data-id');
        var idx = list.findIndex(function (p) { return p.id === id; });
        openLightbox(list, idx < 0 ? 0 : idx);
      });
    });
  }

  // ── lightbox ───────────────────────────────────────────────────────────
  function openLightbox(list, i) {
    ensureLightbox();
    S.lb.list = list; S.lb.i = i;
    var lb = document.getElementById('pm-lightbox');
    lb.classList.add('open');
    showLightbox();
  }
  function closeLightbox() {
    var lb = document.getElementById('pm-lightbox');
    if (lb) lb.classList.remove('open');
  }
  function stepLightbox(d) {
    if (!S.lb.list.length) return;
    S.lb.i = (S.lb.i + d + S.lb.list.length) % S.lb.list.length;
    showLightbox();
  }
  function showLightbox() {
    var p = S.lb.list[S.lb.i];
    if (!p) return;
    var img = document.getElementById('pm-lb-img');
    var title = document.getElementById('pm-lb-title');
    var info = document.getElementById('pm-lb-info');
    img.src = '';
    signedUrl(p.storage_path).then(function (u) { if (u) img.src = u; });
    title.textContent = (S.lb.i + 1) + ' / ' + S.lb.list.length;
    var when = p.taken_at || p.uploaded_at;
    var rows = [
      ['Source', SOURCE_LABELS[p.source_type] || p.source_type],
      ['Reference', p.source_label || '—'],
      ['Caption', p.caption || '—'],
      ['Location', p.location || '—'],
      ['Subsystem', p.subsystem || '—'],
      ['Phase', p.phase || '—'],
      ['Taken', when ? new Date(when).toLocaleString() : '—'],
      ['Uploaded by', p.uploaded_by || '—'],
    ];
    var del = canDeletePhoto(p)
      ? '<button class="pm-btn" id="pm-lb-del" style="margin-top:14px">Delete photo</button>'
      : '';
    var add = canUpload()
      ? '<button class="pm-btn" id="pm-lb-add" style="margin-top:14px;margin-left:8px">Add to album…</button>'
      : '';
    info.innerHTML = '<dl>' + rows.map(function (kv) {
      return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>';
    }).join('') + '</dl>' + del + add;
    var delBtn = document.getElementById('pm-lb-del');
    if (delBtn) delBtn.addEventListener('click', function () { deletePhoto(p); });
    var addBtn = document.getElementById('pm-lb-add');
    if (addBtn) addBtn.addEventListener('click', function () { openAddToAlbum(p); });
  }

  // ── upload ───────────────────────────────────────────────────────────
  function openUpload(preset) {
    if (!canUpload()) { toast('Your role cannot upload photos.'); return; }
    preset = preset || {};
    var manualAlbums = S.albums.filter(function (a) { return a.kind === 'manual'; });
    var albumOpts = manualAlbums.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('');
    var body =
      '<div class="pm-drop" id="pm-drop">Click to choose photos, or drop them here' +
        '<input type="file" id="pm-file" accept="image/*" multiple style="display:none" /></div>' +
      '<div class="pm-preview-row" id="pm-previews"></div>' +
      '<div class="pm-field" style="margin-top:14px"><label>Source</label>' +
        '<select id="pm-src">' +
          '<option value="standalone"' + (preset.source_type === 'standalone' || !preset.source_type ? ' selected' : '') + '>General (standalone)</option>' +
          '<option value="punch"' + (preset.source_type === 'punch' ? ' selected' : '') + '>Punch List item</option>' +
          '<option value="daily_log"' + (preset.source_type === 'daily_log' ? ' selected' : '') + '>Daily Log</option>' +
        '</select></div>' +
      '<div class="pm-field"><label>Reference / label (e.g. punch # or log date)</label><input id="pm-ref" value="' + esc(preset.source_label || '') + '" /></div>' +
      '<div class="pm-field"><label>Caption</label><input id="pm-cap" placeholder="Optional description" /></div>' +
      '<div class="pm-field"><label>Location</label><input id="pm-loc" value="' + esc(preset.location || '') + '" /></div>' +
      '<div class="pm-field"><label>Subsystem</label><input id="pm-sub" value="' + esc(preset.subsystem || '') + '" /></div>' +
      '<div class="pm-field"><label>Phase</label><input id="pm-pha" value="' + esc(preset.phase || '') + '" /></div>' +
      (albumOpts ? '<div class="pm-field"><label>Also add to album (optional)</label><select id="pm-alb"><option value="">— none —</option>' + albumOpts + '</select></div>' : '') +
      '<div id="pm-up-status" style="font-size:12px;color:#71717a"></div>';
    var footer = '<button class="pm-btn" onclick="closeModal()">Cancel</button>' +
      '<button class="pm-btn pm-btn-primary" id="pm-do-upload">Upload</button>';
    modal({ title: 'Add photos', sub: 'Images are stored in Supabase Storage and appear in the timeline + matching album.', body: body, footer: footer, size: 'large' });

    var chosen = [];
    var fileInput = document.getElementById('pm-file');
    var drop = document.getElementById('pm-drop');
    var previews = document.getElementById('pm-previews');
    function addFiles(files) {
      Array.prototype.forEach.call(files, function (f) { if (f.type.indexOf('image/') === 0) chosen.push(f); });
      previews.innerHTML = chosen.map(function (f) { return '<img class="pm-preview" src="' + URL.createObjectURL(f) + '" />'; }).join('');
    }
    drop.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { addFiles(fileInput.files); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('drag'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('drag'); addFiles(e.dataTransfer.files); });

    document.getElementById('pm-do-upload').addEventListener('click', function () {
      if (!chosen.length) { toast('Choose at least one photo.'); return; }
      var meta = {
        source_type: document.getElementById('pm-src').value,
        source_label: document.getElementById('pm-ref').value.trim() || null,
        caption: document.getElementById('pm-cap').value.trim() || null,
        location: document.getElementById('pm-loc').value.trim() || null,
        subsystem: document.getElementById('pm-sub').value.trim() || null,
        phase: document.getElementById('pm-pha').value.trim() || null,
        album_id: (document.getElementById('pm-alb') || {}).value || null,
      };
      uploadFiles(chosen, meta);
    });
  }

  function imageDims(file) {
    return new Promise(function (resolve) {
      try {
        var url = URL.createObjectURL(file);
        var im = new Image();
        im.onload = function () { resolve({ w: im.naturalWidth, h: im.naturalHeight }); URL.revokeObjectURL(url); };
        im.onerror = function () { resolve({ w: null, h: null }); };
        im.src = url;
      } catch (e) { resolve({ w: null, h: null }); }
    });
  }

  async function uploadFiles(files, meta) {
    var btn = document.getElementById('pm-do-upload');
    var status = document.getElementById('pm-up-status');
    if (btn) btn.disabled = true;
    var ok = 0, fail = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (status) status.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '…';
      try {
        var dims = await imageDims(file);
        var ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
        var uid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2));
        var path = meta.source_type + '/' + uid + '.' + ext;
        var up = await _sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
        if (up && up.error) throw up.error;
        var row = {
          storage_path: path,
          file_name: file.name,
          mime_type: file.type || null,
          file_size: file.size || null,
          width: dims.w, height: dims.h,
          caption: meta.caption,
          source_type: meta.source_type,
          source_id: meta.source_id || null,
          source_label: meta.source_label,
          location: meta.location, subsystem: meta.subsystem, phase: meta.phase,
          taken_at: new Date(file.lastModified || Date.now()).toISOString(),
          uploaded_by: userName(),
        };
        var inserted = await _dbInsert('photos', [row]);
        var newId = inserted && inserted[0] && inserted[0].id;
        if (newId && meta.album_id) {
          try { await _dbInsert('photo_album_items', [{ album_id: meta.album_id, photo_id: newId, added_by: userName() }]); } catch (e) {}
        }
        ok++;
      } catch (e) {
        console.error('[photos] upload failed:', e && e.message);
        fail++;
      }
    }
    if (btn) btn.disabled = false;
    closeModal();
    toast(ok + ' photo' + (ok === 1 ? '' : 's') + ' uploaded' + (fail ? ', ' + fail + ' failed' : ''));
    await loadData(true);
    render();
  }

  // Public capture helper — let other flows (punch list, daily logs) open the
  // uploader pre-scoped to their record so the photo lands in the right album.
  function captureFor(opts) { openUpload(opts || {}); }

  // ── manual albums ─────────────────────────────────────────────────────────
  function openNewAlbum() {
    if (!canUpload()) return;
    var body =
      '<div class="pm-field"><label>Album name</label><input id="pm-na-name" placeholder="e.g. Station A — Progress" /></div>' +
      '<div class="pm-field"><label>Description</label><textarea id="pm-na-desc" rows="3"></textarea></div>';
    var footer = '<button class="pm-btn" onclick="closeModal()">Cancel</button>' +
      '<button class="pm-btn pm-btn-primary" id="pm-na-save">Create album</button>';
    modal({ title: 'New album', sub: 'A custom album you fill by adding photos to it.', body: body, footer: footer });
    document.getElementById('pm-na-save').addEventListener('click', async function () {
      var name = document.getElementById('pm-na-name').value.trim();
      if (!name) { toast('Album needs a name.'); return; }
      var slug = slugify(name) + '-' + Math.random().toString(16).slice(2, 6);
      try {
        await _dbInsert('photo_albums', [{
          name: name,
          slug: slug,
          kind: 'manual',
          description: document.getElementById('pm-na-desc').value.trim() || null,
          created_by: userName(),
        }]);
        closeModal();
        toast('Album created.');
        await loadData(true);
        S.view = 'albums'; paint();
      } catch (e) { toast('Could not create album: ' + (e && e.message)); }
    });
  }

  function openAddToAlbum(p) {
    var manual = S.albums.filter(function (a) { return a.kind === 'manual'; });
    if (!manual.length) {
      modal({ title: 'No albums yet', body: '<p>Create an album first (Albums tab → “New album”).</p>', footer: '<button class="pm-btn pm-btn-primary" onclick="closeModal()">OK</button>' });
      return;
    }
    var opts = manual.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('');
    modal({
      title: 'Add to album',
      body: '<div class="pm-field"><label>Album</label><select id="pm-ata">' + opts + '</select></div>',
      footer: '<button class="pm-btn" onclick="closeModal()">Cancel</button><button class="pm-btn pm-btn-primary" id="pm-ata-save">Add</button>',
    });
    document.getElementById('pm-ata-save').addEventListener('click', async function () {
      var albumId = document.getElementById('pm-ata').value;
      try {
        await _dbInsert('photo_album_items', [{ album_id: albumId, photo_id: p.id, added_by: userName() }]);
        closeModal();
        toast('Added to album.');
        await loadData(true);
      } catch (e) {
        if (String(e && e.message).indexOf('duplicate') !== -1) { closeModal(); toast('Already in that album.'); }
        else toast('Could not add: ' + (e && e.message));
      }
    });
  }

  // ── delete (soft) ─────────────────────────────────────────────────────────
  async function deletePhoto(p) {
    if (!canDeletePhoto(p)) return;
    if (!window.confirm('Delete this photo? It will be removed from the timeline and albums.')) return;
    try {
      await _dbUpdate('photos', { is_deleted: true }, { id: p.id });
      closeLightbox();
      toast('Photo deleted.');
      await loadData(true);
      render();
    } catch (e) { toast('Could not delete: ' + (e && e.message)); }
  }

  // ── boot ───────────────────────────────────────────────────────────
  function boot() {
    injectNav();
    injectPage();
    ensureLightbox();
    // Re-render when navigating back/forward to the photos hash.
    window.addEventListener('popstate', function () {
      if ((location.hash || '').slice(1) === 'photos') render();
    });
    // If the app deep-links straight to #photos on load.
    if ((location.hash || '').slice(1) === 'photos') setTimeout(goto, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.PhotosModule = {
    render: render,
    loadData: loadData,
    goto: goto,
    openUpload: openUpload,
    captureFor: captureFor,   // captureFor({source_type:'punch', source_id, source_label, location, subsystem})
    state: S,
  };
})();
