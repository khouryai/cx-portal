// ==========================================
// Construction Planner — app shell (cxc-ui-shell.js)
//
// Nav, state, the recompute loop, the modal and the toast. Views register
// themselves here (CXCApp.registerView) so this file never grows a switch
// statement listing every screen — adding a view touches only that view's file.
//
// State lives in CXStore under `cxc.*` keys (never a loose `let _foo`), and
// every handler is a registered CXAction routed by cx-actions.js delegation —
// no inline `onclick=` anywhere in this app.
// ==========================================
(function () {
  'use strict';

  var VIEWS = {};          // key → {title, subtitle, icon, render, group}
  var VIEW_ORDER = [];

  // ── State ────────────────────────────────────────────────────────────────
  function data() { return CXStore.get('cxc.data'); }
  function result() { return CXStore.get('cxc.result'); }
  function tab() { return CXStore.get('cxc.tab', 'plan'); }

  /**
   * Persist the dataset, re-run the schedule, re-render. Call after ANY edit.
   * One entry point means a data change can never leave the screen stale.
   */
  function save() {
    var d = data();
    if (!CXCStore.save('data', d)) {
      toast('Could not save to this browser — export your JSON', 'bad');
    }
    recompute();
    // Deferred on purpose. save() is almost always called from inside a change
    // or click handler on an element that lives in #cxc-view, and re-rendering
    // synchronously rips that element out of the DOM mid-dispatch — which
    // Chrome reports as "The node to be removed is no longer a child of this
    // node". Letting the event finish first also means focus restoration below
    // sees the real activeElement.
    scheduleRender();
  }

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; render(); }, 0);
  }

  /** Re-run window generation + packing for the current plan range. */
  function recompute() {
    var d = data();
    var plan = d.plan || {};
    var windows = CXC.generateWindows(plan.from, plan.to, d, plan.patternIds || null);
    CXStore.set('cxc.windows', windows);
    CXStore.set('cxc.result', CXC.packSchedule({ windows: windows, data: d }));
  }

  // ── View registry ────────────────────────────────────────────────────────
  /**
   * @param {string} key
   * @param {{title:string, subtitle?:string, icon?:string, group?:string,
   *          count?:function, render:function}} spec
   */
  function registerView(key, spec) {
    VIEWS[key] = spec;
    if (VIEW_ORDER.indexOf(key) === -1) VIEW_ORDER.push(key);
  }

  function setTab(key) {
    if (!VIEWS[key]) return;
    CXStore.set('cxc.tab', key);
    render();
    var main = document.querySelector('.cxc-main');
    if (main) main.scrollTop = 0;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    var key = tab();
    var view = VIEWS[key] || VIEWS.plan;
    var d = data();

    // Sidebar
    var groups = {};
    VIEW_ORDER.forEach(function (k) {
      var g = VIEWS[k].group || '';
      (groups[g] = groups[g] || []).push(k);
    });
    var navHtml = '';
    Object.keys(groups).forEach(function (g) {
      if (g) navHtml += '<div class="cxc-nav-label">' + escapeHtml(g) + '</div>';
      groups[g].forEach(function (k) {
        var v = VIEWS[k];
        var n = typeof v.count === 'function' ? v.count(d) : null;
        navHtml += '<button type="button" class="' + (k === key ? 'cxc-on' : '') + '" ' +
          cxAct('cxcTab', k) + '>' +
          (v.icon ? icon(v.icon) : '') +
          '<span>' + escapeHtml(v.title) + '</span>' +
          (n === null ? '' : '<span class="cxc-count">' + n + '</span>') +
          '</button>';
      });
    });
    document.getElementById('cxc-nav').innerHTML = navHtml;

    // Header + body
    document.getElementById('cxc-title').textContent = view.title;
    document.getElementById('cxc-subtitle').textContent =
      typeof view.subtitle === 'function' ? view.subtitle(d) : (view.subtitle || '');

    var host = document.getElementById('cxc-view');
    // Editing is inline, so a re-render must not steal the cursor: remember
    // which cell was focused (and where the caret sat) and put it back after.
    var active = document.activeElement;
    var focusKey = (active && host.contains(active)) ? active.getAttribute('data-focus-key') : null;
    var selStart = null, selEnd = null;
    if (focusKey) {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e2) { /* not a text input */ }
    }

    try {
      host.innerHTML = view.render(d, result());
      if (focusKey) restoreFocus(host, focusKey, selStart, selEnd);
    } catch (e) {
      host.innerHTML = '<div class="cxc-card"><div class="cxc-empty"><strong>This screen failed to render.</strong>' +
        escapeHtml(e && e.message ? e.message : String(e)) + '</div></div>';
      if (window.console) console.error(e);
    }
  }

  /** Re-focus the cell that was being edited before a re-render replaced it. */
  function restoreFocus(host, key, selStart, selEnd) {
    var candidates = host.querySelectorAll('[data-focus-key]');
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].getAttribute('data-focus-key') !== key) continue;
      var el = candidates[i];
      el.focus();
      if (selStart !== null && selEnd !== null) {
        try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* number/date inputs refuse */ }
      }
      return;
    }
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  var modalSave = null;

  /**
   * @param {{title:string, body:string, saveLabel?:string, onSave?:function}} o
   */
  function openModal(o) {
    document.getElementById('cxc-modal-title').textContent = o.title || '';
    document.getElementById('cxc-modal-body').innerHTML = o.body || '';
    var btn = document.getElementById('cxc-modal-save');
    btn.textContent = o.saveLabel || 'Done';
    btn.hidden = !o.onSave;
    modalSave = o.onSave || null;
    document.getElementById('cxc-modal-back').hidden = false;
  }
  function closeModal() {
    document.getElementById('cxc-modal-back').hidden = true;
    modalSave = null;
  }
  function commitModal() {
    var fn = modalSave;
    closeModal();
    if (fn) fn();
  }

  // ── Toast ────────────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg, kind) {
    var el = document.getElementById('cxc-toast');
    el.textContent = msg;
    el.className = 'cxc-toast' + (kind === 'bad' ? ' cxc-bad-toast' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  // ── Import / export / reset ──────────────────────────────────────────────
  function exportJson() {
    var blob = new Blob([CXCStore.exportJson()], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'construction-plan-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Exported. Keep this file — it is your save.');
  }

  function importJson() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var res = CXCStore.importJson(String(reader.result));
        if (!res.ok) { toast(res.error, 'bad'); return; }
        CXStore.set('cxc.data', CXCData.normalize(CXCStore.load('data', CXCData.seed())));
        recompute(); render();
        toast('Imported ' + res.loaded.join(', '));
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function resetData() {
    openModal({
      title: 'Reset to the sample project?',
      body: '<p class="cxc-hint">This replaces everything currently in the browser — locations, ' +
        'phases, activities, materials, crews, vehicles, shift windows and scope — with the ' +
        'built-in sample. Export first if you want to keep what you have.</p>',
      saveLabel: 'Reset everything',
      onSave: function () {
        CXStore.set('cxc.data', CXCData.seed());
        CXCStore.save('data', data());
        recompute(); render();
        toast('Reset to the sample project');
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    var saved = CXCStore.load('data', null);
    CXStore.set('cxc.data', CXCData.normalize(saved || CXCData.seed()));
    if (!saved) CXCStore.save('data', data());

    CXActions
      .register('cxcTab', setTab)
      .register('cxcExport', exportJson)
      .register('cxcImport', importJson)
      .register('cxcReset', resetData)
      .register('cxcModalClose', closeModal)
      .register('cxcModalSave', commitModal);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.getElementById('cxc-modal-back').hidden) closeModal();
    });

    recompute();
    render();
  }

  var CXCApp = {
    init: init,
    data: data,
    result: result,
    save: save,
    recompute: recompute,
    render: render,
    registerView: registerView,
    setTab: setTab,
    openModal: openModal,
    closeModal: closeModal,
    toast: toast,
    views: VIEWS
  };

  if (typeof window !== 'undefined') window.CXCApp = CXCApp;
})();
