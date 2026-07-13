/* ============================================================================
   Mobile Module — field-first interactions for the phone/PWA experience.

   Loaded as a classic <script> after app.js/photos.js so it shares the global
   lexical scope and reuses the app's primitives (showPage, uiCan, toast,
   PhotosModule, PUNCH_DB, openNewPunchModal, openTaskModal, ...).

   Capabilities (all inert on desktop — gated by the same media query the
   mobile chrome uses):
     - Quick-action FAB   — one context-aware primary action per page
                            (new punch, camera capture, new task, log result).
     - Pull-to-refresh    — drag down from the top of a page to re-run its
                            renderer (reuses showPage's per-page refresh map).
     - Punch row swipe    — swipe a punch item left to reveal View + Camera
                            (camera opens pre-linked to that punch item).

   Public surface: window._mobileFabSync (called by _syncMobileTabs).
   ============================================================================ */
(function () {
  'use strict';

  // Same trigger set as the mobile chrome in styles.css.
  var MQ = '(max-width: 720px), (orientation: landscape) and (max-height: 540px), (pointer: coarse)';
  function isMobile() {
    try { return window.matchMedia(MQ).matches; } catch (e) { return false; }
  }
  function can(mod, act) {
    try { return typeof uiCan !== 'function' || uiCan(mod, act); } catch (e) { return true; }
  }

  /* ── Quick-action FAB ────────────────────────────────────────────────── */

  // page -> primary action. `when` gates visibility (fail-open like the rest
  // of the UI — RLS enforces server-side), `run` performs it.
  var FAB_ACTIONS = {
    'punch-workflow': {
      label: 'New punch item',
      icon: 'plus',
      when: function () { return can('punch_list', 'create') && typeof openNewPunchModal === 'function'; },
      run: function () { openNewPunchModal(); },
    },
    'photos': {
      label: 'Take photo',
      icon: 'camera',
      when: function () { return !!(window.PhotosModule && PhotosModule.captureFor); },
      run: function () { PhotosModule.captureFor({ camera: true }); },
    },
    'tasks': {
      label: 'New task',
      icon: 'plus',
      when: function () { return can('tasks', 'create') && typeof openTaskModal === 'function'; },
      run: function () { openTaskModal(null); },
    },
    'test-register': {
      label: 'Log test result',
      icon: 'edit',
      when: function () {
        var link = document.querySelector('#sidenav-links .nav-link[data-page="field-intake"]');
        return typeof _mobLinkAvailable === 'function' ? _mobLinkAvailable(link) : false;
      },
      run: function () { showPage('field-intake'); },
    },
  };

  function fabEl() {
    var b = document.getElementById('m-fab');
    if (!b) {
      b = document.createElement('button');
      b.id = 'm-fab';
      b.className = 'm-fab';
      b.hidden = true;
      (document.body || document.documentElement).appendChild(b);
    }
    return b;
  }

  var _fabRun = null;
  function fabSync(page) {
    var b = fabEl();
    var a = FAB_ACTIONS[page];
    var signedIn = typeof currentRoleUser !== 'undefined' && !!currentRoleUser;
    if (!a || !signedIn || !isMobile() || !a.when()) { b.hidden = true; _fabRun = null; return; }
    var glyph = (typeof icon === 'function') ? icon(a.icon) : '';
    b.innerHTML = glyph + '<span>' + a.label + '</span>';
    b.setAttribute('aria-label', a.label);
    b.hidden = false;
    _fabRun = a.run;
  }
  window._mobileFabSync = fabSync;

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#m-fab');
    if (b && _fabRun) _fabRun();
  });

  /* ── Pull-to-refresh ─────────────────────────────────────────────────── */

  var PTR_TRIGGER = 78;   // px of pull needed to arm a refresh
  var _ptr = { active: false, startY: 0, dy: 0, armed: false };

  function ptrEl() {
    var el = document.getElementById('m-ptr');
    if (!el) {
      el = document.createElement('div');
      el.id = 'm-ptr';
      el.className = 'm-ptr';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<span class="m-ptr-spinner"></span><span class="m-ptr-text"></span>';
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  // The gesture must not hijack scrolls that belong to an inner scrollable
  // region (tables, sheets, modals) — only body-level pulls count.
  function ptrEligible(target) {
    if (!isMobile() || window.scrollY > 0) return false;
    var sheet = document.getElementById('m-sheet');
    if (sheet && !sheet.hidden) return false;
    var overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.style.display && overlay.style.display !== 'none') return false;
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1) {
        var oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return false;
      }
    }
    return true;
  }

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    if (!ptrEligible(e.target)) { _ptr.active = false; return; }
    _ptr.active = true;
    _ptr.startY = e.touches[0].clientY;
    _ptr.startX = e.touches[0].clientX;
    _ptr.dy = 0;
    _ptr.armed = false;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!_ptr.active) return;
    var dy = e.touches[0].clientY - _ptr.startY;
    var dx = Math.abs(e.touches[0].clientX - _ptr.startX);
    if (dy <= 0 || dx > Math.abs(dy)) { if (!_ptr.armed && dy < -8) _ptr.active = false; return; }
    if (window.scrollY > 0) { _ptr.active = false; ptrEl().className = 'm-ptr'; return; }
    _ptr.dy = dy;
    _ptr.armed = dy >= PTR_TRIGGER;
    var el = ptrEl();
    el.className = 'm-ptr show' + (_ptr.armed ? ' armed' : '');
    el.querySelector('.m-ptr-text').textContent = _ptr.armed ? 'Release to refresh' : 'Pull to refresh';
    el.style.transform = 'translate(-50%,' + Math.min(dy * 0.45, 64) + 'px)';
  }, { passive: true });

  document.addEventListener('touchend', function () {
    if (!_ptr.active) return;
    var el = ptrEl();
    if (_ptr.armed && typeof _refreshActivePage === 'function') {
      el.className = 'm-ptr show refreshing';
      el.querySelector('.m-ptr-text').textContent = 'Refreshing…';
      el.style.transform = 'translate(-50%, 34px)';
      try { _refreshActivePage(); } catch (e) { /* refresh is best-effort */ }
      setTimeout(function () { el.className = 'm-ptr'; el.style.transform = ''; }, 650);
    } else {
      el.className = 'm-ptr';
      el.style.transform = '';
    }
    _ptr.active = false;
    _ptr.armed = false;
  }, { passive: true });

  /* ── Punch row swipe (View + Camera) ─────────────────────────────────── */

  var SWIPE_W = 148;      // px revealed behind the row
  var _sw = { row: null, startX: 0, startY: 0, dx: 0, dragging: false };
  var _swOpenRow = null;

  function swClose() {
    if (!_swOpenRow) return;
    _swOpenRow.classList.remove('m-swiped');
    var inner = _swOpenRow.querySelector('.punch-row');
    if (inner) inner.style.transform = '';
    _swOpenRow = null;
  }

  function swActions(row) {
    var acts = row.querySelector('.m-swipe-actions');
    if (acts) return acts;
    acts = document.createElement('div');
    acts.className = 'm-swipe-actions';
    var pid = row.dataset.pid;
    var camOk = window.PhotosModule && PhotosModule.captureFor;
    acts.innerHTML =
      '<button class="m-swipe-btn m-swipe-view" aria-label="View punch item">' +
        ((typeof icon === 'function') ? icon('eye') : '') + '<span>View</span></button>' +
      (camOk ? '<button class="m-swipe-btn m-swipe-cam" aria-label="Add photo to punch item">' +
        ((typeof icon === 'function') ? icon('camera') : '') + '<span>Photo</span></button>' : '');
    acts.addEventListener('click', function (e) {
      e.stopPropagation();
      var view = e.target.closest('.m-swipe-view');
      var cam  = e.target.closest('.m-swipe-cam');
      swClose();
      if (view && typeof openPunchDetail === 'function') openPunchDetail(pid);
      if (cam) {
        var p = (typeof PUNCH_DB !== 'undefined' && PUNCH_DB || []).find(function (x) { return String(x.id) === String(pid); });
        PhotosModule.captureFor({
          camera: true, source_type: 'punch',
          source_id: pid,
          source_label: p && p.number != null ? ('#' + p.number) : null,
          phase: p && p.phase || '', location: p && p.location || '',
          subsystem: p && p.subsystem || '',
        });
      }
    });
    row.appendChild(acts);
    return acts;
  }

  document.addEventListener('touchstart', function (e) {
    if (!isMobile() || e.touches.length !== 1) return;
    var row = e.target.closest && e.target.closest('#page-punch-workflow .v2-list-row[data-pid]');
    if (_swOpenRow && row !== _swOpenRow) swClose();
    if (!row) return;
    _sw.row = row;
    _sw.startX = e.touches[0].clientX;
    _sw.startY = e.touches[0].clientY;
    _sw.dx = 0;
    _sw.dragging = false;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!_sw.row) return;
    var dx = e.touches[0].clientX - _sw.startX;
    var dy = e.touches[0].clientY - _sw.startY;
    if (!_sw.dragging) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { _sw.row = null; return; }
      if (Math.abs(dx) < 14) return;
      _sw.dragging = true;
      swActions(_sw.row);
    }
    var open = _sw.row === _swOpenRow;
    var base = open ? -SWIPE_W : 0;
    var t = Math.max(-SWIPE_W, Math.min(0, base + dx));
    _sw.dx = dx;
    _sw.row.classList.add('m-swiping');
    var inner = _sw.row.querySelector('.punch-row');
    if (inner) inner.style.transform = 'translateX(' + t + 'px)';
  }, { passive: true });

  document.addEventListener('touchend', function () {
    var row = _sw.row;
    if (!row) return;
    _sw.row = null;
    row.classList.remove('m-swiping');
    if (!_sw.dragging) return;
    var wasOpen = row === _swOpenRow;
    var pos = (wasOpen ? -SWIPE_W : 0) + _sw.dx;
    var inner = row.querySelector('.punch-row');
    if (pos < -SWIPE_W / 2) {
      row.classList.add('m-swiped');
      if (inner) inner.style.transform = 'translateX(' + (-SWIPE_W) + 'px)';
      _swOpenRow = row;
    } else {
      row.classList.remove('m-swiped');
      if (inner) inner.style.transform = '';
      if (wasOpen) _swOpenRow = null;
    }
  }, { passive: true });

  // A swiped-open row must not fire its row-level onclick (openPunchDetail).
  document.addEventListener('click', function (e) {
    if (!_swOpenRow) return;
    var row = e.target.closest && e.target.closest('.v2-list-row[data-pid]');
    if (row === _swOpenRow && !e.target.closest('.m-swipe-actions')) {
      e.stopPropagation();
      e.preventDefault();
      swClose();
    } else if (!e.target.closest('.m-swipe-actions')) {
      swClose();
    }
  }, true);
})();
