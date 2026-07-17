// ==========================================================================
// search.js — Global search / command palette (⌘K)
// ==========================================================================
// A keyboard-first, two-pane "super search": ranked results grouped by record
// type on the left, a live preview of the highlighted record on the right —
// enough context (status, people, dates, notes) to understand a result without
// opening it. Searches everything already in memory (test cases, assets, punch
// items, RMAs, tasks, documents, daily logs) plus the navigation itself.
//
// Loaded as a classic script AFTER app.js, so it references app.js globals
// (TI, ASSETS, showPage, openPunchDetail, …) by name at call time. Zero
// DOM/network work happens at load — the overlay is built lazily on first
// open — so the headless smoke loader can require it safely.
(function () {
  'use strict';

  var overlay = null, input = null, resultsEl = null, previewEl = null, chipsEl = null;
  var INDEX = [], results = [], activeIdx = 0, query = '';
  var KINDS = ['All', 'Page', 'Test', 'Asset', 'Punch', 'RMA', 'Task', 'Doc', 'Log'];
  var kindFilter = 'All';
  var kindCounts = {};

  // ── helpers ──────────────────────────────────────────────────────────────
  function _esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function _ic(name) { return (typeof icon === 'function') ? icon(name) : ''; }
  function _norm(s) { return String(s == null ? '' : s).toLowerCase(); }
  function _ago(iso) { return (typeof dateAgo === 'function' && iso) ? dateAgo(iso) : ''; }
  function _fdate(d) { return (typeof _fmtDate === 'function' && d) ? _fmtDate(d) : (d || ''); }
  function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Escape + wrap query-word matches in <mark> so the eye lands on WHY a row matched.
  function _hl(raw) {
    var s = String(raw == null ? '' : raw);
    var words = query.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return _esc(s);
    var re;
    try { re = new RegExp('(' + words.map(_escRe).join('|') + ')', 'ig'); }
    catch (_) { return _esc(s); }
    return s.split(re).map(function (part, i) {
      return (i % 2) ? '<mark class="cxs-hl">' + _esc(part) + '</mark>' : _esc(part);
    }).join('');
  }

  // Generic status → semantic token color for the pill.
  function _statusColor(s) {
    s = _norm(s);
    if (!s) return '';
    if (/pass|closed|complete|done|resolved|approved|verified/.test(s)) return 'var(--good)';
    if (/fail|reject|overdue|cancel/.test(s)) return 'var(--bad)';
    if (/block|hold|await|delay/.test(s)) return 'var(--warn)';
    if (/progress|open|pending|ship|active|review|new/.test(s)) return 'var(--info)';
    return 'var(--text-muted)';
  }
  function _pill(status) {
    if (!status) return '';
    return '<span class="cxs-pill" style="color:' + _statusColor(status) + ';">' + _esc(status) + '</span>';
  }

  // Reference an app.js global array by name without throwing if it isn't
  // declared yet (let-bindings from another script aren't on `window`).
  function _arr(name) {
    var v = null;
    try {
      switch (name) {
        case 'TI':          v = (typeof TI          !== 'undefined') ? TI          : null; break;
        case 'ASSETS':      v = (typeof ASSETS      !== 'undefined') ? ASSETS      : null; break;
        case 'ASSET_LINKS': v = (typeof ASSET_LINKS !== 'undefined') ? ASSET_LINKS : null; break;
        case 'PUNCH_DB':    v = (typeof PUNCH_DB    !== 'undefined') ? PUNCH_DB    : null; break;
        case 'RMAS':        v = (typeof RMAS        !== 'undefined') ? RMAS        : null; break;
        case 'TASKS':       v = (typeof TASKS       !== 'undefined') ? TASKS       : null; break;
        case 'DOCUMENTS':   v = (typeof DOCUMENTS   !== 'undefined') ? DOCUMENTS   : null; break;
        case 'DAILY_LOGS':  v = (typeof DAILY_LOGS  !== 'undefined') ? DAILY_LOGS  : null; break;
      }
    } catch (_) { v = null; }
    return Array.isArray(v) ? v : [];
  }

  // ── build the searchable index from current in-memory data ────────────────
  // Every entry carries: kind, icon, label, sub (one-line context), status
  // (pill), fields ([[label, value], …] for the preview pane), desc (longer
  // free text), page (+ optional opener) for deep-linking.
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
        idx.push({ kind: 'Page', icon: 'window', label: label, sub: 'Go to page', page: page,
                   fields: [['Type', 'Navigation'], ['Destination', label]] });
      });
    } catch (_) {}

    // Per-asset pass/total, precomputed in one TI pass (avoids O(assets×tests)).
    var tiRows = _arr('TI');
    var passByAsset = {}, totByAsset = {};
    tiRows.forEach(function (r) {
      if (!r.AssetId) return;
      totByAsset[r.AssetId] = (totByAsset[r.AssetId] || 0) + 1;
      if (r.Status === 'Pass') passByAsset[r.AssetId] = (passByAsset[r.AssetId] || 0) + 1;
    });
    var linksByAsset = {};
    _arr('ASSET_LINKS').forEach(function (l) {
      linksByAsset[l.asset_id] = (linksByAsset[l.asset_id] || 0) + 1;
    });

    tiRows.forEach(function (t) {
      if (t.ParentTestId) return; // child asset rows are noise
      idx.push({
        kind: 'Test', icon: 'clipboard',
        label: t.TestName || t.TestCaseCode || ('Test ' + t.TestID),
        sub: [t.TestCaseCode, t.Location, t.Subsystem].filter(Boolean).join(' · '),
        status: t.Status || '',
        fields: [
          ['Code', t.TestCaseCode], ['Status', t.Status],
          ['Location', t.Location], ['Subsystem', t.Subsystem],
          ['Activity', t.Activity], ['Phase', t.Phase],
          ['Completed', t.CompletedDate ? _fdate(t.CompletedDate) : ''],
          ['Completed by', t.CompletedBy],
        ],
        page: 'test-register',
      });
    });

    _arr('ASSETS').forEach(function (a) {
      var tot = totByAsset[a.id] || 0, pas = passByAsset[a.id] || 0;
      idx.push({
        kind: 'Asset', icon: 'package',
        label: a.name || 'Asset',
        sub: [a.device_type, a.location || a.location_prefix, a.subsystem].filter(Boolean).join(' · '),
        status: tot ? (pas + '/' + tot + ' pass') : '',
        fields: [
          ['Device type', a.device_type],
          ['Location', a.location || a.location_prefix], ['Subsystem', a.subsystem],
          ['Linked test cases', String(linksByAsset[a.id] || 0)],
          ['Test progress', tot ? pas + ' of ' + tot + ' passed' : 'No linked tests'],
        ],
        page: 'admin-assets',
        opener: function () {
          try { _assetFilter.search = a.name || ''; renderAdminAssets(); } catch (_) {}
        },
      });
    });

    _arr('PUNCH_DB').forEach(function (p) {
      idx.push({
        kind: 'Punch', icon: 'flag',
        label: (p.number != null ? '#' + p.number + ' ' : '') + (p.title || 'Punch item'),
        sub: [p.status, p.priority, p.assignee].filter(Boolean).join(' · '),
        status: p.status || '',
        desc: p.description || '',
        fields: [
          ['Status', p.status], ['Priority', p.priority],
          ['Assignee', p.assignee], ['Raised by', p.created_by],
          ['Location', p.location], ['Phase', p.phase],
          ['Due', p.due_date ? _fdate(p.due_date) : ''],
          ['Created', p.created_at ? _ago(p.created_at) : ''],
        ],
        page: 'punch-workflow',
        opener: (p.id != null) ? function () { if (typeof openPunchDetail === 'function') openPunchDetail(p.id); } : null,
      });
    });

    _arr('RMAS').forEach(function (r) {
      idx.push({
        kind: 'RMA', icon: 'refresh',
        label: (r.rma_number || 'RMA') + (r.material_description ? ' — ' + r.material_description : ''),
        sub: [r.manufacturer, r.serial_number, r.location].filter(Boolean).join(' · '),
        status: r.status || '',
        fields: [
          ['Status', r.status], ['Material', r.material_description],
          ['Manufacturer', r.manufacturer], ['Part number', r.manufacturer_pn],
          ['Serial number', r.serial_number], ['Location', r.location],
          ['Opened', r.created_at ? _fdate(r.created_at) : ''],
          ['Closed', r.closed_date ? _fdate(r.closed_date) : ''],
        ],
        page: 'rma',
        opener: (r.id != null) ? function () { if (typeof openRMAModal === 'function') openRMAModal(r.id); } : null,
      });
    });

    _arr('TASKS').forEach(function (t) {
      idx.push({
        kind: 'Task', icon: 'target',
        label: t.task_name || t.title || t.name || 'Task',
        sub: [t.assignee, t.due_date ? 'due ' + _fdate(t.due_date) : ''].filter(Boolean).join(' · '),
        status: t.status || '',
        desc: t.description || '',
        fields: [
          ['Status', t.status], ['Assignee', t.assignee],
          ['Due', t.due_date ? _fdate(t.due_date) : ''],
          ['Created', t.created_at ? _ago(t.created_at) : ''],
        ],
        page: 'tasks',
      });
    });

    _arr('DOCUMENTS').forEach(function (d) {
      idx.push({
        kind: 'Doc', icon: 'file',
        label: d.title || d.name || d.filename || 'Document',
        sub: [d.category, d.folder, d.discipline].filter(Boolean).join(' · '),
        fields: [
          ['Category', d.category], ['Folder', d.folder], ['Discipline', d.discipline],
          ['Added', d.created_at ? _fdate(d.created_at) : ''],
        ],
        page: 'documents',
      });
    });

    _arr('DAILY_LOGS').forEach(function (l) {
      var delayYes = _norm(l.delay_occurred) === 'yes';
      idx.push({
        kind: 'Log', icon: 'calendar',
        label: 'Daily log — ' + _fdate(l.log_date) + (l.location ? ' · ' + l.location : ''),
        sub: [l.subsystem, l.submitted_by].filter(Boolean).join(' · '),
        status: delayYes ? (l.delay_category || 'Delay') : '',
        desc: l.overall_notes || '',
        fields: [
          ['Date', _fdate(l.log_date)], ['Location', l.location], ['Subsystem', l.subsystem],
          ['Submitted by', l.submitted_by],
          ['Tests logged', String(parseInt(l.total_tests_logged, 10) || 0)],
          ['Passed / Failed', (parseInt(l.total_passed, 10) || 0) + ' / ' + (parseInt(l.total_failed, 10) || 0)],
          ['Delay', delayYes ? (l.delay_category || 'Yes') : 'No'],
        ],
        page: 'daily-log-history',
      });
    });

    return idx;
  }

  // ── scoring: exact > prefix > substring > sub-field > multi-word ──────────
  function score(item, q) {
    if (!q) {
      // Empty query: quick page nav on "All"; browse mode on a specific kind.
      if (kindFilter === 'All') return item.kind === 'Page' ? 5 : -1;
      return item.kind === kindFilter ? 5 : -1;
    }
    var label = _norm(item.label), sub = _norm(item.sub), status = _norm(item.status);
    if (label === q) return 100;
    var i = label.indexOf(q);
    if (i === 0) return 80 - Math.min(label.length, 40) * 0.1;
    if (i > 0)   return 55 - Math.min(i, 40) * 0.1;
    var si = sub.indexOf(q);
    if (si >= 0) return 30 - Math.min(si, 40) * 0.05;
    if (status && status.indexOf(q) >= 0) return 25;
    var words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every(function (w) {
      return label.indexOf(w) >= 0 || sub.indexOf(w) >= 0 || status.indexOf(w) >= 0;
    })) return 20;
    return -1;
  }

  function runSearch() {
    var q = _norm(query.trim());

    // Score every item once (ignoring the kind filter) so chips show real counts.
    var matched = [];
    kindCounts = {};
    for (var k = 0; k < INDEX.length; k++) {
      var it = INDEX[k];
      var s = q ? score(it, q) : -2; // -2 = defer empty-query decision below
      if (q) {
        if (s > -1) { matched.push([s, k, it]); kindCounts[it.kind] = (kindCounts[it.kind] || 0) + 1; }
      } else {
        kindCounts[it.kind] = (kindCounts[it.kind] || 0) + 1; // browsable totals
        var es = score(it, '');
        if (es > -1) matched.push([es, k, it]);
      }
    }

    // Apply the kind filter, then group: kinds ordered by their best hit,
    // items score-ordered within each kind (keeps arrow-key order intuitive).
    var pool = (kindFilter === 'All') ? matched : matched.filter(function (m) { return m[2].kind === kindFilter; });
    pool.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });

    var byKind = {}, kindOrder = [];
    pool.forEach(function (m) {
      if (!byKind[m[2].kind]) { byKind[m[2].kind] = []; kindOrder.push(m[2].kind); }
      byKind[m[2].kind].push(m[2]);
    });
    var perKindCap = (kindFilter === 'All') ? 10 : 60;
    results = [];
    kindOrder.forEach(function (kind) {
      byKind[kind].slice(0, perKindCap).forEach(function (it) { if (results.length < 60) results.push(it); });
    });

    activeIdx = 0;
    renderChips();
    renderResults();
    renderPreview();
  }

  // ── kind filter chips ──────────────────────────────────────────────────────
  function renderChips() {
    if (!chipsEl) return;
    var total = 0;
    KINDS.forEach(function (kd) { if (kd !== 'All') total += (kindCounts[kd] || 0); });
    chipsEl.innerHTML = KINDS.map(function (kd) {
      var n = kd === 'All' ? total : (kindCounts[kd] || 0);
      if (kd !== 'All' && !n) return '';
      var on = kindFilter === kd;
      return '<button class="cxs-chip' + (on ? ' cxs-chip-on' : '') + '" data-kind="' + kd + '">' +
        _esc(kd) + '<span class="cxs-chip-n">' + n + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(chipsEl.querySelectorAll('.cxs-chip'), function (el) {
      el.addEventListener('click', function () {
        kindFilter = el.getAttribute('data-kind') || 'All';
        runSearch();
        if (input) input.focus();
      });
    });
  }

  function cycleKind(dir) {
    var avail = KINDS.filter(function (kd) { return kd === 'All' || (kindCounts[kd] || 0) > 0; });
    var i = avail.indexOf(kindFilter);
    if (i < 0) i = 0;
    kindFilter = avail[(i + dir + avail.length) % avail.length];
    runSearch();
  }

  // ── results list (left pane) ───────────────────────────────────────────────
  function renderResults() {
    if (!resultsEl) return;
    if (!results.length) {
      resultsEl.innerHTML = '<div class="cxs-empty">' +
        (query.trim() ? 'No matches for “' + _esc(query.trim()) + '”' +
          (kindFilter !== 'All' ? ' in ' + _esc(kindFilter) : '')
          : 'Search test cases, assets, punch items, RMAs, tasks…') +
        '</div>';
      return;
    }
    var html = '', prevKind = null;
    results.forEach(function (r, i) {
      if (r.kind !== prevKind) {
        var n = results.filter(function (x) { return x.kind === r.kind; }).length;
        var totalOfKind = kindCounts[r.kind] || n;
        html += '<div class="cxs-group">' + _esc(r.kind) +
          '<span class="cxs-group-n">' + (totalOfKind > n ? n + ' of ' + totalOfKind : n) + '</span></div>';
        prevKind = r.kind;
      }
      html += '<div class="cxs-item" role="option" aria-selected="' + (i === activeIdx ? 'true' : 'false') + '" data-i="' + i + '">' +
        '<span class="cxs-item-icon">' + _ic(r.icon || 'file') + '</span>' +
        '<span class="cxs-item-body">' +
          '<span class="cxs-item-label">' + _hl(r.label) + '</span>' +
          (r.sub ? '<span class="cxs-item-sub">' + _hl(r.sub) + '</span>' : '') +
        '</span>' +
        (r.status ? _pill(r.status) : '') +
      '</div>';
    });
    resultsEl.innerHTML = html;
    Array.prototype.forEach.call(resultsEl.querySelectorAll('.cxs-item'), function (el) {
      el.addEventListener('click', function () { activeIdx = parseInt(el.getAttribute('data-i'), 10) || 0; go(); });
      el.addEventListener('mousemove', function () {
        var n = parseInt(el.getAttribute('data-i'), 10) || 0;
        if (n !== activeIdx) { activeIdx = n; paintSelection(); }
      });
    });
    scrollActiveIntoView();
  }

  // ── preview pane (right) — the "see it without clicking" part ─────────────
  function renderPreview() {
    if (!previewEl) return;
    var r = results[activeIdx];
    if (!r) { previewEl.innerHTML = '<div class="cxs-empty">Nothing selected.</div>'; return; }
    var fields = (r.fields || []).filter(function (f) { return f && f[1] != null && String(f[1]).trim() !== ''; });
    previewEl.innerHTML =
      '<div class="cxs-pv-head">' +
        '<span class="cxs-item-icon cxs-pv-icon">' + _ic(r.icon || 'file') + '</span>' +
        '<div class="cxs-pv-title-wrap">' +
          '<div class="cxs-pv-kind">' + _esc(r.kind) + '</div>' +
          '<div class="cxs-pv-title">' + _hl(r.label) + '</div>' +
        '</div>' +
        (r.status ? _pill(r.status) : '') +
      '</div>' +
      (fields.length ? '<dl class="cxs-pv-fields">' + fields.map(function (f) {
        return '<div class="cxs-pv-row"><dt>' + _esc(f[0]) + '</dt><dd>' + _hl(f[1]) + '</dd></div>';
      }).join('') + '</dl>' : '') +
      (r.desc ? '<div class="cxs-pv-desc-label">Notes</div><div class="cxs-pv-desc">' + _hl(r.desc) + '</div>' : '') +
      '<button class="cxs-pv-open">' + 'Open' + (r.opener ? ' detail' : '') + ' <kbd class="cxs-kbd">↵</kbd></button>';
    var btn = previewEl.querySelector('.cxs-pv-open');
    if (btn) btn.addEventListener('click', go);
  }

  // Repaint selection without rebuilding the list (keeps keyboard/mouse snappy).
  function paintSelection() {
    if (!resultsEl) return;
    Array.prototype.forEach.call(resultsEl.querySelectorAll('.cxs-item'), function (el) {
      el.setAttribute('aria-selected', (parseInt(el.getAttribute('data-i'), 10) === activeIdx) ? 'true' : 'false');
    });
    scrollActiveIntoView();
    renderPreview();
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
      '<div class="cxs-panel cxs-panel-wide">' +
        '<div class="cxs-input-row">' +
          '<span class="cxs-lead-icon">' + _ic('search') + '</span>' +
          '<input class="cxs-input" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search tests, assets, punch items, RMAs, pages…" aria-label="Search">' +
          '<kbd class="cxs-kbd">Esc</kbd>' +
        '</div>' +
        '<div class="cxs-chips" role="tablist" aria-label="Filter by type"></div>' +
        '<div class="cxs-main">' +
          '<div class="cxs-results" role="listbox" aria-label="Search results"></div>' +
          '<div class="cxs-preview" aria-label="Result preview"></div>' +
        '</div>' +
        '<div class="cxs-footer"><span><kbd class="cxs-kbd">↑</kbd> <kbd class="cxs-kbd">↓</kbd> navigate</span>' +
          '<span><kbd class="cxs-kbd">Tab</kbd> type filter</span>' +
          '<span><kbd class="cxs-kbd">↵</kbd> open</span><span><kbd class="cxs-kbd">⌘K</kbd> toggle</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('.cxs-input');
    resultsEl = overlay.querySelector('.cxs-results');
    previewEl = overlay.querySelector('.cxs-preview');
    chipsEl = overlay.querySelector('.cxs-chips');

    input.addEventListener('input', function () { query = input.value; runSearch(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Tab') { e.preventDefault(); cycleKind(e.shiftKey ? -1 : 1); }
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
    kindFilter = 'All';
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
