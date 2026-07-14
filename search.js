// ==========================================================================
// search.js — Global search / command palette (⌘K)
// ==========================================================================
// A keyboard-first overlay that searches across every record type already in
// memory (test cases, assets, punch items, RMAs, tasks, documents) plus the
// navigation itself. Loaded as a classic script AFTER app.js, so it references
// app.js globals (TI, ASSETS, showPage, openPunchDetail, …) by name at call
// time. Zero DOM/network work happens at load — the overlay is built lazily on
// first open — so the headless smoke loader can require it safely.
(function () {
  'use strict';

  var overlay = null, input = null, resultsEl = null;
  var INDEX = [], results = [], activeIdx = 0, query = '';

  // ── helpers ──────────────────────────────────────────────────────────────
  function _esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function _ic(name) { return (typeof icon === 'function') ? icon(name) : ''; }
  function _norm(s) { return String(s == null ? '' : s).toLowerCase(); }

  // Reference an app.js global array by name without throwing if it isn't
  // declared yet (let-bindings from another script aren't on `window`).
  function _arr(name) {
    var v = null;
    try {
      switch (name) {
        case 'TI':        v = (typeof TI        !== 'undefined') ? TI        : null; break;
        case 'ASSETS':    v = (typeof ASSETS    !== 'undefined') ? ASSETS    : null; break;
        case 'PUNCH_DB':  v = (typeof PUNCH_DB  !== 'undefined') ? PUNCH_DB  : null; break;
        case 'RMAS':      v = (typeof RMAS      !== 'undefined') ? RMAS      : null; break;
        case 'TASKS':     v = (typeof TASKS     !== 'undefined') ? TASKS     : null; break;
        case 'DOCUMENTS': v = (typeof DOCUMENTS !== 'undefined') ? DOCUMENTS : null; break;
      }
    } catch (_) { v = null; }
    return Array.isArray(v) ? v : [];
  }

  // ── build the searchable index from current in-memory data ────────────────
  function buildIndex() {
    var idx = [];

    // Pages — scraped from the live nav so it always mirrors what this user can
    // actually reach (permission-hidden links are skipped) and never drifts.
    try {
      var seen = {};
      document.querySelectorAll('.nav-link[data-page]').forEach(function (a) {
        if (a.style && a.style.display === 'none') return;
        var page = a.getAttribute('data-page');
        var label = (a.textContent || '').trim();
        if (!page || !label || seen[page]) return;
        seen[page] = 1;
        idx.push({ kind: 'Page', icon: 'window', label: label, sub: 'Go to page', page: page });
      });
    } catch (_) {}

    _arr('TI').forEach(function (t) {
      if (t.ParentTestId) return; // child asset rows are noise
      idx.push({
        kind: 'Test', icon: 'clipboard',
        label: t.TestName || t.TestCaseCode || ('Test ' + t.TestID),
        sub: [t.TestCaseCode, t.Location, t.Subsystem, t.Status].filter(Boolean).join(' · '),
        page: 'test-register',
      });
    });

    _arr('ASSETS').forEach(function (a) {
      idx.push({
        kind: 'Asset', icon: 'package',
        label: a.name || 'Asset',
        sub: [a.device_type, a.location || a.location_prefix, a.subsystem].filter(Boolean).join(' · '),
        page: 'admin-assets',
      });
    });

    _arr('PUNCH_DB').forEach(function (p) {
      idx.push({
        kind: 'Punch', icon: 'flag',
        label: (p.number != null ? '#' + p.number + ' ' : '') + (p.title || 'Punch item'),
        sub: [p.status, p.priority].filter(Boolean).join(' · '),
        page: 'punch-workflow',
        opener: (p.id != null) ? function () { if (typeof openPunchDetail === 'function') openPunchDetail(p.id); } : null,
      });
    });

    _arr('RMAS').forEach(function (r) {
      idx.push({
        kind: 'RMA', icon: 'refresh',
        label: r.rma_number || 'RMA',
        sub: [r.material_description, r.manufacturer, r.serial_number, r.status].filter(Boolean).join(' · '),
        page: 'rma',
        opener: (r.id != null) ? function () { if (typeof openRMAModal === 'function') openRMAModal(r.id); } : null,
      });
    });

    _arr('TASKS').forEach(function (t) {
      idx.push({
        kind: 'Task', icon: 'target',
        label: t.title || t.name || 'Task',
        sub: [t.status, t.assignee, t.due_date].filter(Boolean).join(' · '),
        page: 'tasks',
      });
    });

    _arr('DOCUMENTS').forEach(function (d) {
      idx.push({
        kind: 'Doc', icon: 'file',
        label: d.name || d.title || d.filename || 'Document',
        sub: [d.category, d.folder, d.discipline].filter(Boolean).join(' · '),
        page: 'documents',
      });
    });

    return idx;
  }

  // ── scoring: exact > prefix > substring > sub-field > multi-word ──────────
  function score(item, q) {
    if (!q) return item.kind === 'Page' ? 5 : -1; // empty query = quick nav
    var label = _norm(item.label), sub = _norm(item.sub);
    if (label === q) return 100;
    var i = label.indexOf(q);
    if (i === 0) return 80 - Math.min(label.length, 40) * 0.1;
    if (i > 0)   return 55 - Math.min(i, 40) * 0.1;
    var si = sub.indexOf(q);
    if (si >= 0) return 30 - Math.min(si, 40) * 0.05;
    var words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every(function (w) { return label.indexOf(w) >= 0 || sub.indexOf(w) >= 0; })) return 20;
    return -1;
  }

  function runSearch() {
    var q = _norm(query.trim());
    var scored = [];
    for (var k = 0; k < INDEX.length; k++) {
      var s = score(INDEX[k], q);
      if (s > -1) scored.push([s, k, INDEX[k]]);
    }
    // score desc, stable by original index
    scored.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
    results = scored.slice(0, 40).map(function (x) { return x[2]; });
    activeIdx = 0;
    renderResults();
  }

  function renderResults() {
    if (!resultsEl) return;
    if (!results.length) {
      resultsEl.innerHTML = '<div class="cxs-empty">' +
        (query.trim() ? 'No matches for “' + _esc(query.trim()) + '”'
                      : 'Search test cases, assets, punch items, RMAs, tasks…') +
        '</div>';
      return;
    }
    resultsEl.innerHTML = results.map(function (r, i) {
      return '<div class="cxs-item" role="option" aria-selected="' + (i === activeIdx ? 'true' : 'false') + '" data-i="' + i + '">' +
        '<span class="cxs-item-icon">' + _ic(r.icon || 'file') + '</span>' +
        '<span class="cxs-item-body">' +
          '<span class="cxs-item-label">' + _esc(r.label) + '</span>' +
          (r.sub ? '<span class="cxs-item-sub">' + _esc(r.sub) + '</span>' : '') +
        '</span>' +
        '<span class="cxs-item-kind">' + _esc(r.kind) + '</span>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(resultsEl.querySelectorAll('.cxs-item'), function (el) {
      el.addEventListener('click', function () { activeIdx = parseInt(el.getAttribute('data-i'), 10) || 0; go(); });
      el.addEventListener('mousemove', function () {
        var n = parseInt(el.getAttribute('data-i'), 10) || 0;
        if (n !== activeIdx) { activeIdx = n; paintSelection(); }
      });
    });
    scrollActiveIntoView();
  }

  // Repaint selection without rebuilding the list (keeps keyboard/mouse snappy).
  function paintSelection() {
    if (!resultsEl) return;
    Array.prototype.forEach.call(resultsEl.querySelectorAll('.cxs-item'), function (el) {
      el.setAttribute('aria-selected', (parseInt(el.getAttribute('data-i'), 10) === activeIdx) ? 'true' : 'false');
    });
    scrollActiveIntoView();
  }
  function scrollActiveIntoView() {
    var el = resultsEl && resultsEl.querySelector('.cxs-item[aria-selected="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!results.length) return;
    activeIdx = (activeIdx + delta + results.length) % results.length;
    paintSelection();
  }

  function go() {
    var r = results[activeIdx];
    if (!r) return;
    close();
    if (r.page && typeof showPage === 'function') showPage(r.page);
    if (r.opener) setTimeout(r.opener, 200);
  }

  // ── overlay lifecycle ─────────────────────────────────────────────────────
  function ensureDOM() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'cxs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Global search');
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="cxs-panel">' +
        '<div class="cxs-input-row">' +
          '<span class="cxs-lead-icon">' + _ic('search') + '</span>' +
          '<input class="cxs-input" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search tests, assets, punch items, RMAs, pages…" aria-label="Search">' +
          '<kbd class="cxs-kbd">Esc</kbd>' +
        '</div>' +
        '<div class="cxs-results" role="listbox" aria-label="Search results"></div>' +
        '<div class="cxs-footer"><span><kbd class="cxs-kbd">↑</kbd> <kbd class="cxs-kbd">↓</kbd> navigate</span>' +
          '<span><kbd class="cxs-kbd">↵</kbd> open</span><span><kbd class="cxs-kbd">⌘K</kbd> toggle</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('.cxs-input');
    resultsEl = overlay.querySelector('.cxs-results');

    input.addEventListener('input', function () { query = input.value; runSearch(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    // Click on the backdrop (outside the panel) closes.
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  }

  function open() {
    ensureDOM();
    INDEX = buildIndex();
    query = '';
    if (input) input.value = '';
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    runSearch();
    setTimeout(function () { if (input) input.focus(); }, 30);
  }
  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }
  function toggle() { (overlay && !overlay.hidden) ? close() : open(); }

  // ⌘K / Ctrl+K anywhere. Recorded but never fired under the headless loader.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toggle();
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.CXSearch = { open: open, close: close, toggle: toggle };
  }
})();
