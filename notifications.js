// ==========================================================================
// notifications.js — Activity feed / notification center
// ==========================================================================
// A lightweight cross-user "what changed recently" feed, sourced from tables
// every role can already read (punch_items, rmas, delay_log, tasks) — no new
// schema, no realtime. A bell in the sidenav + mobile topbar shows an unread
// count; opening the panel marks everything seen (tracked per user in
// localStorage). Loaded as a classic script AFTER app.js; all DOM/network work
// is deferred so the headless smoke loader can require it safely.
(function () {
  'use strict';

  var NOTIF = [];
  var overlay = null, listEl = null;
  var _initLoaded = false, _loading = false;

  function _ic(name) { return (typeof icon === 'function') ? icon(name) : ''; }
  function _esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function _ago(iso) { return (typeof dateAgo === 'function') ? dateAgo(iso) : ''; }
  function me() {
    try { return (typeof currentRoleUser !== 'undefined' && currentRoleUser && currentRoleUser.name) || ''; }
    catch (_) { return ''; }
  }
  function _fetch(q) {
    if (typeof _fetchAnon !== 'function') return Promise.resolve([]);
    return _fetchAnon(q).catch(function () { return []; });
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function load() {
    if (_loading) return Promise.resolve();
    _loading = true;
    return Promise.all([
      _fetch('punch_items?select=id,number,title,status,created_at,created_by&is_deleted=eq.false&order=created_at.desc&limit=15'),
      _fetch('rmas?select=id,rma_number,status,created_at&order=created_at.desc&limit=10'),
      _fetch('delay_log?select=id,log_date,location,subsystem,submitted_by,submitted_at&order=submitted_at.desc&limit=10'),
      _fetch('tasks?select=id,task_name,status,created_at,assignee&order=created_at.desc&limit=10'),
    ]).then(function (res) {
      var punch = res[0] || [], rmas = res[1] || [], logs = res[2] || [], tasks = res[3] || [];
      var out = [];
      punch.forEach(function (p) {
        out.push({
          ts: p.created_at, actor: p.created_by || '', icon: 'flag', kind: 'Punch',
          text: 'Punch #' + (p.number != null ? p.number : '') + ' — ' + (p.title || ''),
          meta: (p.status || '') + (p.created_by ? ' · ' + p.created_by : ''),
          page: 'punch-workflow',
          opener: (p.id != null) ? function () { if (typeof openPunchDetail === 'function') openPunchDetail(p.id); } : null,
        });
      });
      rmas.forEach(function (r) {
        out.push({
          ts: r.created_at, actor: '', icon: 'refresh', kind: 'RMA',
          text: 'RMA ' + (r.rma_number || ''), meta: r.status || '',
          page: 'rma',
          opener: (r.id != null) ? function () { if (typeof openRMAModal === 'function') openRMAModal(r.id); } : null,
        });
      });
      logs.forEach(function (l) {
        out.push({
          ts: l.submitted_at, actor: l.submitted_by || '', icon: 'calendar', kind: 'Daily Log',
          text: 'Daily log — ' + [l.location, l.subsystem].filter(Boolean).join(' '),
          meta: l.submitted_by ? 'by ' + l.submitted_by : '',
          page: 'daily-log-history',
        });
      });
      tasks.forEach(function (t) {
        out.push({
          ts: t.created_at, actor: t.assignee || '', icon: 'target', kind: 'Task',
          text: t.task_name || 'Task', meta: (t.status || '') + (t.assignee ? ' · ' + t.assignee : ''),
          page: 'tasks',
        });
      });
      NOTIF = out.filter(function (n) { return n.ts; })
                 .sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); })
                 .slice(0, 40);
      _initLoaded = true;
      updateBadge();
      if (overlay && !overlay.hidden) renderList();
    })['catch'](function (e) { try { console.warn('[notif] load failed:', e.message); } catch (_) {} })
      .then(function () { _loading = false; });
  }

  // ── unread tracking (per user, localStorage) ──────────────────────────────
  function seenKey() { return 'cx-notif-seen-' + (me() || 'anon'); }
  function lastSeen() { try { return localStorage.getItem(seenKey()) || ''; } catch (_) { return ''; } }
  function isUnread(n) {
    var ls = lastSeen();
    return (!ls || new Date(n.ts) > new Date(ls)) && n.actor !== me();
  }
  function unreadCount() { return NOTIF.filter(isUnread).length; }
  function markSeen() {
    try { localStorage.setItem(seenKey(), NOTIF.length ? NOTIF[0].ts : new Date().toISOString()); } catch (_) {}
    updateBadge();
  }
  function updateBadge() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var c = unreadCount();
    Array.prototype.forEach.call(document.querySelectorAll('.cxn-badge'), function (b) {
      if (c > 0) { b.textContent = c > 99 ? '99+' : String(c); b.hidden = false; }
      else { b.hidden = true; }
    });
  }

  // ── styles (injected once, token-based) ───────────────────────────────────
  function injectStyle() {
    if (document.getElementById('cxn-style')) return;
    var css =
      '.cxn-badge{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--primary);color:var(--white);font-size:11px;font-weight:700;line-height:18px;text-align:center;display:inline-block;}' +
      '.cxn-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);}' +
      '.cxn-title{font-size:15px;font-weight:700;color:var(--text);flex:1;}' +
      '.cxn-list{overflow-y:auto;padding:6px;}' +
      '.cxn-item{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border-radius:8px;cursor:pointer;}' +
      '.cxn-item:hover{background:var(--info-light);}' +
      '.cxn-item.cxn-unread{background:var(--info-light);}' +
      '.cxn-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:11px;background:var(--primary);}' +
      '.cxn-dot.cxn-read{background:transparent;}' +
      '.cxn-icon{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--surface);color:var(--text-muted);flex:none;}' +
      '.cxn-icon svg{width:16px;height:16px;}' +
      '.cxn-body{min-width:0;flex:1;}' +
      '.cxn-text{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.cxn-meta{font-size:11px;color:var(--text-muted);margin-top:2px;}' +
      '.cxn-kind{font-size:11px;color:var(--text-muted);border:1px solid var(--border);border-radius:20px;padding:1px 8px;flex:none;}' +
      '.cxn-empty{padding:32px;text-align:center;color:var(--text-muted);font-size:14px;}';
    var st = document.createElement('style');
    st.id = 'cxn-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── overlay ───────────────────────────────────────────────────────────────
  function ensureDOM() {
    if (overlay) return;
    injectStyle();
    overlay = document.createElement('div');
    overlay.className = 'cxs-overlay'; // reuse the search overlay shell
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Recent activity');
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="cxs-panel">' +
        '<div class="cxn-head"><span class="cxn-title">Activity</span><kbd class="cxs-kbd">Esc</kbd></div>' +
        '<div class="cxn-list" role="list"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    listEl = overlay.querySelector('.cxn-list');
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && !overlay.hidden) { e.preventDefault(); close(); }
    });
  }

  function renderList() {
    if (!listEl) return;
    if (!NOTIF.length) {
      listEl.innerHTML = '<div class="cxn-empty">No recent activity yet.</div>';
      return;
    }
    listEl.innerHTML = NOTIF.map(function (n, i) {
      var unread = isUnread(n);
      return '<div class="cxn-item' + (unread ? ' cxn-unread' : '') + '" role="listitem" data-i="' + i + '">' +
        '<span class="cxn-dot' + (unread ? '' : ' cxn-read') + '"></span>' +
        '<span class="cxn-icon">' + _ic(n.icon || 'file') + '</span>' +
        '<span class="cxn-body">' +
          '<span class="cxn-text">' + _esc(n.text) + '</span>' +
          '<span class="cxn-meta">' + _esc([n.meta, _ago(n.ts)].filter(Boolean).join(' · ')) + '</span>' +
        '</span>' +
        '<span class="cxn-kind">' + _esc(n.kind) + '</span>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(listEl.querySelectorAll('.cxn-item'), function (el) {
      el.addEventListener('click', function () {
        var n = NOTIF[parseInt(el.getAttribute('data-i'), 10) || 0];
        if (!n) return;
        close();
        if (n.page && typeof showPage === 'function') showPage(n.page);
        if (n.opener) setTimeout(n.opener, 200);
      });
    });
  }

  function open() {
    ensureDOM();
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    renderList();          // show what we have immediately
    load();                // refresh in the background
    markSeen();            // opening clears the unread badge
  }
  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }
  function toggle() { (overlay && !overlay.hidden) ? close() : open(); }
  function refresh() { return load(); }

  // ── gentle self-init: populate the badge shortly after login, then poll ────
  function maybeInit() {
    if (typeof currentRoleUser === 'undefined' || !currentRoleUser) return;
    if (!_initLoaded && !_loading) load();
  }
  if (typeof setTimeout === 'function') { try { setTimeout(maybeInit, 4000); } catch (_) {} }
  if (typeof setInterval === 'function') {
    try {
      setInterval(function () {
        if (typeof document !== 'undefined' && document.hidden) return; // pause when tab hidden
        if (!_initLoaded) { maybeInit(); return; }
        load();
      }, 90000);
    } catch (_) {}
  }

  if (typeof window !== 'undefined') {
    window.CXNotify = { open: open, close: close, toggle: toggle, refresh: refresh };
  }
})();
