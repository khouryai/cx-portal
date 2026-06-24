// ==========================================================================
// HITACHI Rail T&C Portal — Track Plan reference window (Dynamic Testing)
// ==========================================================================
// A floating, draggable, resizable, maximise/minimise PDF viewer so a tester
// can keep a track-plan map on screen while completing dynamic test instances.
// It is NON-MODAL: no backdrop, and the root is pointer-events:none, so the app
// behind stays fully clickable (complete instances, change statuses) with the
// map still visible. Minimising collapses it to a small chat-style bubble.
//
// The catalog of sections (Phase 2, W-4, Route 1, …) is user-managed in the
// UI: built-in maps ship as committed PDFs under assets/track-plans/, and the
// user can add their own (stored in IndexedDB), rename, or remove any entry.
// The catalog is persisted in localStorage so it survives reloads.
//
// Loaded as a classic <script> BEFORE app.js, so icon()/toast()/cxPrompt()/etc.
// are resolved at call time (not load time). Public entry points are exposed on
// window for inline onclick handlers: tpOpen, tpClose, tpMinimize, tpRestore,
// tpToggleMax, tpSelectSection, tpAddMap, tpRenameCurrent, tpDeleteCurrent,
// tpPrevPage, tpNextPage, tpZoomIn, tpZoomOut, tpZoomFit.
// ==========================================================================

(function () {
  "use strict";

  var CATALOG_KEY = "cx_trackplan_catalog_v1";
  var IDB_NAME = "cx-trackplan";
  var IDB_STORE = "pdfs";
  var PDF_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";

  // Built-in maps — committed placeholder PDFs (swap in the real track plans,
  // same filenames). `kind:'builtin'` entries load by URL; `kind:'upload'`
  // entries load their bytes from IndexedDB keyed by the entry id.
  var BUILTINS = [
    { id: "builtin-phase-2", label: "Phase 2 — Full Section", kind: "builtin",
      src: "assets/track-plans/phase-2.pdf", note: "Whole Phase 2 mainline + interlockings" },
    { id: "builtin-w-4", label: "W-4 Interlocking (zoom)", kind: "builtin",
      src: "assets/track-plans/w-4.pdf", note: "Zoomed to the W-4 interlocking" },
    { id: "builtin-route-1", label: "Route 1 — S8 → SB", kind: "builtin",
      src: "assets/track-plans/route-1.pdf", note: "Dynamic test route overlay" },
  ];

  var S = {
    mounted: false,
    catalog: [],
    hiddenBuiltins: {},     // id -> true for removed built-ins (persisted)
    activeId: null,
    open: false,
    minimized: false,
    maximized: false,
    // floating geometry (px)
    geom: { x: 0, y: 0, w: 540, h: 480 },
    preMax: null,           // geometry saved before maximise
    // pdf
    pdfDoc: null,
    pageNum: 1,
    numPages: 1,
    userZoom: 1,            // multiplier relative to fit (1 = fit-to-width)
    fitScale: 1,
    renderToken: 0,
    renderTask: null,
    loadToken: 0,
    _ro: null,              // ResizeObserver on the body
    _roRaf: 0,
  };

  // ── persistence ──────────────────────────────────────────────────────────
  function loadCatalog() {
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(CATALOG_KEY) || "null"); } catch (e) { stored = null; }
    var hidden = (stored && stored.hiddenBuiltins) || {};
    var entries = (stored && Array.isArray(stored.entries)) ? stored.entries.slice()
                                                            : BUILTINS.map(function (b) { return Object.assign({}, b); });
    // Re-add any built-in that isn't present and wasn't explicitly removed, so
    // newly shipped maps appear without wiping the user's edits.
    var have = {};
    entries.forEach(function (e) { have[e.id] = true; });
    BUILTINS.forEach(function (b) {
      if (!have[b.id] && !hidden[b.id]) entries.push(Object.assign({}, b));
    });
    S.catalog = entries;
    S.hiddenBuiltins = hidden;
    if (!S.activeId && entries.length) S.activeId = entries[0].id;
  }

  function persistCatalog() {
    try {
      localStorage.setItem(CATALOG_KEY, JSON.stringify({
        version: 1, entries: S.catalog, hiddenBuiltins: S.hiddenBuiltins,
      }));
    } catch (e) { /* quota / private mode — non-fatal */ }
  }

  function activeEntry() {
    for (var i = 0; i < S.catalog.length; i++) if (S.catalog[i].id === S.activeId) return S.catalog[i];
    return S.catalog[0] || null;
  }

  // ── IndexedDB (uploaded PDF blobs) ─────────────────────────────────────────
  function idb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE, { keyPath: "id" });
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idbPut(id, blob, name) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put({ id: id, blob: blob, name: name });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(id) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var rq = tx.objectStore(IDB_STORE).get(id);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }
  function idbDel(id) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  // ── small helpers ──────────────────────────────────────────────────────────
  function ic(name) { return (typeof icon === "function") ? icon(name) : ""; }
  function esc(s) { return (typeof escapeHtml === "function") ? escapeHtml(s) : String(s == null ? "" : s); }
  function notify(msg, type) { if (typeof toast === "function") toast(msg, type || "success"); }
  function el(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── mount ──────────────────────────────────────────────────────────────────
  function ensureMounted() {
    if (S.mounted) return;
    loadCatalog();
    var root = document.createElement("div");
    root.id = "tp-root";
    root.innerHTML =
      '<div class="tp-window" id="tp-window" role="dialog" aria-label="Track plan reference" style="display:none;">' +
        '<div class="tp-titlebar" id="tp-titlebar">' +
          '<span class="tp-grip" aria-hidden="true">' + ic("map") + "</span>" +
          '<span class="tp-title">Track Plan</span>' +
          '<select class="tp-section" id="tp-section" aria-label="Track plan section" ' +
            'onchange="tpSelectSection(this.value)" onmousedown="event.stopPropagation()"></select>' +
          '<div class="tp-winbtns">' +
            '<button class="tp-winbtn" type="button" aria-label="Minimise" title="Minimise" onclick="tpMinimize()">' + ic("minimize") + "</button>" +
            '<button class="tp-winbtn" id="tp-maxbtn" type="button" aria-label="Maximise" title="Maximise" onclick="tpToggleMax()">' + ic("maximize") + "</button>" +
            '<button class="tp-winbtn tp-close" type="button" aria-label="Close" title="Close" onclick="tpClose()">' + ic("x") + "</button>" +
          "</div>" +
        "</div>" +
        '<div class="tp-toolbar">' +
          '<button class="tp-tbtn" id="tp-prev" type="button" aria-label="Previous page" title="Previous page" onclick="tpPrevPage()">' + ic("chevron-left") + "</button>" +
          '<span class="tp-tb-label" id="tp-pagelabel">Page 1 / 1</span>' +
          '<button class="tp-tbtn" id="tp-next" type="button" aria-label="Next page" title="Next page" onclick="tpNextPage()">' + ic("chevron-right") + "</button>" +
          '<span class="tp-tb-sep"></span>' +
          '<button class="tp-tbtn" type="button" aria-label="Zoom out" title="Zoom out" onclick="tpZoomOut()">' + ic("minimize") + "</button>" +
          '<button class="tp-tbtn" id="tp-zoomlabel" type="button" title="Fit to width" onclick="tpZoomFit()">Fit</button>' +
          '<button class="tp-tbtn" type="button" aria-label="Zoom in" title="Zoom in" onclick="tpZoomIn()">' + ic("plus") + "</button>" +
          '<span class="tp-tb-spacer"></span>' +
          '<button class="tp-tbtn" type="button" title="Add a track plan PDF" onclick="tpAddMap()">' + ic("plus") + " Add</button>" +
          '<button class="tp-tbtn" type="button" aria-label="Rename this map" title="Rename this map" onclick="tpRenameCurrent()">' + ic("edit") + "</button>" +
          '<button class="tp-tbtn" type="button" aria-label="Remove this map" title="Remove this map" onclick="tpDeleteCurrent()">' + ic("trash") + "</button>" +
        "</div>" +
        '<div class="tp-body" id="tp-body">' +
          '<canvas class="tp-canvas" id="tp-canvas" style="display:none;"></canvas>' +
          '<div class="tp-status" id="tp-status">Loading…</div>' +
        "</div>" +
        '<div class="tp-resize" id="tp-resize" aria-hidden="true"></div>' +
      "</div>" +
      '<button class="tp-bubble" id="tp-bubble" type="button" title="Open track plan" onclick="tpRestore()" style="display:none;">' +
        '<span class="tp-bubble-ic" aria-hidden="true">' + ic("map") + "</span><span>Track Plan</span>" +
        '<span class="tp-bubble-dot"></span>' +
      "</button>";
    document.body.appendChild(root);
    S.mounted = true;

    // default geometry: docked bottom-right
    var vw = window.innerWidth, vh = window.innerHeight;
    S.geom.w = Math.min(560, vw - 32);
    S.geom.h = Math.min(520, vh - 120);
    S.geom.x = Math.max(16, vw - S.geom.w - 24);
    S.geom.y = Math.max(72, vh - S.geom.h - 24);

    bindDrag();
    bindResize();
    bindKeys();

    // Re-fit the page when the window is resized (only while at fit zoom).
    if (typeof ResizeObserver !== "undefined") {
      S._ro = new ResizeObserver(function () {
        if (!S.open || S.minimized || S.userZoom !== 1) return;
        if (S._roRaf) return;
        S._roRaf = requestAnimationFrame(function () { S._roRaf = 0; renderPage(); });
      });
      S._ro.observe(el("tp-body"));
    }
    window.addEventListener("resize", function () { if (S.open && !S.minimized) clampIntoView(); });
  }

  // ── window geometry / chrome ────────────────────────────────────────────────
  function applyGeom() {
    var w = el("tp-window");
    if (!w) return;
    if (S.maximized) {
      w.classList.add("tp-maximized");
      w.style.left = "0px"; w.style.top = "0px";
      w.style.width = "100vw"; w.style.height = "100vh";
    } else {
      w.classList.remove("tp-maximized");
      w.style.left = S.geom.x + "px"; w.style.top = S.geom.y + "px";
      w.style.width = S.geom.w + "px"; w.style.height = S.geom.h + "px";
    }
    var mb = el("tp-maxbtn");
    if (mb) {
      mb.innerHTML = S.maximized ? ic("restore") : ic("maximize");
      mb.setAttribute("aria-label", S.maximized ? "Restore" : "Maximise");
      mb.title = S.maximized ? "Restore" : "Maximise";
    }
  }

  function clampIntoView() {
    var vw = window.innerWidth, vh = window.innerHeight;
    S.geom.w = clamp(S.geom.w, 320, vw);
    S.geom.h = clamp(S.geom.h, 240, vh);
    S.geom.x = clamp(S.geom.x, 0, Math.max(0, vw - 120));
    S.geom.y = clamp(S.geom.y, 0, Math.max(0, vh - 60));
    if (!S.maximized) applyGeom();
  }

  function refreshChrome() {
    var w = el("tp-window"), b = el("tp-bubble");
    if (!w || !b) return;
    if (S.open && !S.minimized) {
      w.style.display = "flex"; b.style.display = "none";
      applyGeom();
    } else if (S.open && S.minimized) {
      w.style.display = "none"; b.style.display = "inline-flex";
    } else {
      w.style.display = "none"; b.style.display = "none";
    }
  }

  function renderSectionSelect() {
    var sel = el("tp-section");
    if (!sel) return;
    sel.innerHTML = S.catalog.map(function (e) {
      return '<option value="' + esc(e.id) + '"' + (e.id === S.activeId ? " selected" : "") + ">" + esc(e.label) + "</option>";
    }).join("");
    var title = el("tp-window") && el("tp-window").querySelector(".tp-title");
    var ent = activeEntry();
    if (title && ent) title.textContent = ent.label;
  }

  function setStatus(msg, isError) {
    var s = el("tp-status"), c = el("tp-canvas");
    if (!s) return;
    if (msg) {
      s.textContent = msg;
      s.style.display = "flex";
      s.classList.toggle("tp-error", !!isError);
      if (c) c.style.display = "none";
    } else {
      s.style.display = "none";
      s.classList.remove("tp-error");
      if (c) c.style.display = "block";
    }
  }

  // ── PDF loading + rendering ─────────────────────────────────────────────────
  function ensureWorker() {
    if (typeof pdfjsLib === "undefined") return false;
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    return true;
  }

  function entryBytes(entry) {
    if (entry.kind === "upload") {
      return idbGet(entry.id).then(function (rec) {
        if (!rec || !rec.blob) throw new Error("This uploaded map is no longer stored on this device.");
        return rec.blob.arrayBuffer();
      }).then(function (ab) { return new Uint8Array(ab); });
    }
    return fetch(entry.src, { cache: "force-cache" }).then(function (r) {
      if (!r.ok) throw new Error("Could not load " + entry.src + " (" + r.status + ")");
      return r.arrayBuffer();
    }).then(function (ab) { return new Uint8Array(ab); });
  }

  function loadActive() {
    var entry = activeEntry();
    renderSectionSelect();
    if (!entry) { setStatus("No track plan selected.", false); return; }
    if (!ensureWorker()) { setStatus("PDF viewer library not loaded.", true); return; }
    var myLoad = ++S.loadToken;
    S.pdfDoc = null; S.pageNum = 1; S.numPages = 1; S.userZoom = 1;
    setStatus("Loading " + entry.label + "…", false);
    updateToolbar();
    entryBytes(entry).then(function (bytes) {
      return pdfjsLib.getDocument({ data: bytes }).promise;
    }).then(function (doc) {
      if (myLoad !== S.loadToken) return;        // a newer load superseded this one
      S.pdfDoc = doc; S.numPages = doc.numPages; S.pageNum = 1;
      updateToolbar();
      return renderPage();
    }).catch(function (err) {
      if (myLoad !== S.loadToken) return;
      setStatus((err && err.message) || "Failed to load this track plan.", true);
    });
  }

  function computeFitScale(page) {
    var body = el("tp-body");
    var avail = (body ? body.clientWidth : 480) - 24;   // minus body padding
    var base = page.getViewport({ scale: 1 });
    return Math.max(0.1, avail / base.width);
  }

  function renderPage() {
    if (!S.pdfDoc) return Promise.resolve();
    var token = ++S.renderToken;
    if (S.renderTask) { try { S.renderTask.cancel(); } catch (e) {} S.renderTask = null; }
    return S.pdfDoc.getPage(S.pageNum).then(function (page) {
      if (token !== S.renderToken) return;
      S.fitScale = computeFitScale(page);
      var scale = S.fitScale * S.userZoom;
      var dpr = window.devicePixelRatio || 1;
      var viewport = page.getViewport({ scale: scale });
      var canvas = el("tp-canvas");
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + "px";
      canvas.style.height = Math.floor(viewport.height) + "px";
      var ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      setStatus("", false);
      S.renderTask = page.render({ canvasContext: ctx, viewport: viewport });
      return S.renderTask.promise.then(function () {
        if (token === S.renderToken) { S.renderTask = null; updateToolbar(); }
      }).catch(function (err) {
        if (err && err.name === "RenderingCancelledException") return;
        if (token === S.renderToken) setStatus((err && err.message) || "Render failed.", true);
      });
    });
  }

  function updateToolbar() {
    var pl = el("tp-pagelabel"), prev = el("tp-prev"), next = el("tp-next"), zl = el("tp-zoomlabel");
    if (pl) pl.textContent = "Page " + S.pageNum + " / " + S.numPages;
    if (prev) prev.disabled = !S.pdfDoc || S.pageNum <= 1;
    if (next) next.disabled = !S.pdfDoc || S.pageNum >= S.numPages;
    if (zl) zl.textContent = Math.abs(S.userZoom - 1) < 0.01 ? "Fit" : Math.round(S.userZoom * 100) + "%";
  }

  // ── public actions ──────────────────────────────────────────────────────────
  function tpOpen(id) {
    ensureMounted();
    if (id && typeof id === "string") S.activeId = id;
    if (!S.activeId && S.catalog.length) S.activeId = S.catalog[0].id;
    S.open = true; S.minimized = false;
    refreshChrome();
    renderSectionSelect();
    loadActive();
  }

  function tpClose() {
    S.open = false; S.minimized = false;
    if (S.renderTask) { try { S.renderTask.cancel(); } catch (e) {} S.renderTask = null; }
    S.pdfDoc = null;
    refreshChrome();
  }

  function tpMinimize() {
    if (!S.open) return;
    if (S.maximized) { S.maximized = false; S.geom = S.preMax || S.geom; }
    S.minimized = true;
    refreshChrome();
  }

  function tpRestore() {
    ensureMounted();
    var wasLoaded = !!S.pdfDoc;
    S.open = true; S.minimized = false;
    refreshChrome();
    renderSectionSelect();
    if (!wasLoaded) loadActive(); else renderPage();
  }

  function tpToggleMax() {
    if (!S.open) return;
    if (S.maximized) {
      S.maximized = false;
      if (S.preMax) S.geom = S.preMax;
    } else {
      S.preMax = Object.assign({}, S.geom);
      S.maximized = true;
    }
    applyGeom();
    if (S.userZoom === 1) renderPage();
  }

  function tpSelectSection(id) {
    if (id === S.activeId) return;
    S.activeId = id;
    loadActive();
  }

  function tpPrevPage() { if (S.pdfDoc && S.pageNum > 1) { S.pageNum--; renderPage(); } }
  function tpNextPage() { if (S.pdfDoc && S.pageNum < S.numPages) { S.pageNum++; renderPage(); } }
  function tpZoomIn() { S.userZoom = clamp(S.userZoom * 1.25, 0.25, 6); renderPage(); }
  function tpZoomOut() { S.userZoom = clamp(S.userZoom / 1.25, 0.25, 6); renderPage(); }
  function tpZoomFit() { S.userZoom = 1; renderPage(); }

  // ── catalog management (user-managed) ───────────────────────────────────────
  function tpAddMap() {
    ensureMounted();
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/pdf,.pdf";
    inp.style.display = "none";
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { notify("Please choose a PDF file.", "error"); return; }
      var id = "upload-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      var label = file.name.replace(/\.pdf$/i, "");
      idbPut(id, file, file.name).then(function () {
        S.catalog.push({ id: id, label: label, kind: "upload", note: "Uploaded PDF" });
        S.activeId = id;
        persistCatalog();
        renderSectionSelect();
        if (!S.open) tpOpen(id); else loadActive();
        notify('Added "' + label + '" to the track plan list.');
      }).catch(function () { notify("Could not store this PDF on the device.", "error"); });
    };
    document.body.appendChild(inp);
    inp.click();
  }

  function tpRenameCurrent() {
    var ent = activeEntry();
    if (!ent) return;
    var p = (typeof cxPrompt === "function")
      ? cxPrompt("Rename this track plan:", ent.label, { title: "Rename track plan", ok: "Save" })
      : Promise.resolve(window.prompt("Rename this track plan:", ent.label));
    p.then(function (name) {
      if (name == null) return;
      name = String(name).trim();
      if (!name) return;
      ent.label = name;
      persistCatalog();
      renderSectionSelect();
    });
  }

  function tpDeleteCurrent() {
    var ent = activeEntry();
    if (!ent) return;
    var ask = (typeof cxConfirm === "function")
      ? cxConfirm('Remove "' + ent.label + '" from the track plan list?', { title: "Remove track plan", ok: "Remove", danger: true })
      : Promise.resolve(window.confirm('Remove "' + ent.label + '" from the track plan list?'));
    ask.then(function (ok) {
      if (!ok) return;
      var idx = S.catalog.indexOf(ent);
      if (idx >= 0) S.catalog.splice(idx, 1);
      if (ent.kind === "builtin") S.hiddenBuiltins[ent.id] = true;
      else idbDel(ent.id);
      persistCatalog();
      S.activeId = S.catalog.length ? S.catalog[0].id : null;
      renderSectionSelect();
      if (S.catalog.length) loadActive();
      else { S.pdfDoc = null; setStatus("No track plans left. Use “Add” to load one.", false); updateToolbar(); }
      notify('Removed "' + ent.label + '".');
    });
  }

  // ── drag (title bar) ────────────────────────────────────────────────────────
  function bindDrag() {
    var bar = el("tp-titlebar"), win = el("tp-window");
    if (!bar || !win) return;
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    function down(e) {
      if (S.maximized) return;
      if (e.target.closest(".tp-winbtn") || e.target.closest(".tp-section")) return;
      dragging = true;
      win.classList.add("tp-dragging");
      var p = point(e);
      sx = p.x; sy = p.y; ox = S.geom.x; oy = S.geom.y;
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
      window.addEventListener("touchmove", move, { capture: true, passive: false });
      window.addEventListener("touchend", up, true);
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var p = point(e);
      var vw = window.innerWidth, vh = window.innerHeight;
      S.geom.x = clamp(ox + (p.x - sx), 0, Math.max(0, vw - 120));
      S.geom.y = clamp(oy + (p.y - sy), 0, Math.max(0, vh - 48));
      applyGeom();
      if (e.cancelable) e.preventDefault();
    }
    function up() {
      dragging = false;
      win.classList.remove("tp-dragging");
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("touchmove", move, true);
      window.removeEventListener("touchend", up, true);
    }
    bar.addEventListener("mousedown", down);
    bar.addEventListener("touchstart", down, { passive: false });
  }

  // ── resize (bottom-right handle) ────────────────────────────────────────────
  function bindResize() {
    var handle = el("tp-resize"), win = el("tp-window");
    if (!handle || !win) return;
    var sx = 0, sy = 0, ow = 0, oh = 0, resizing = false;
    function down(e) {
      if (S.maximized) return;
      resizing = true;
      win.classList.add("tp-resizing");
      var p = point(e);
      sx = p.x; sy = p.y; ow = S.geom.w; oh = S.geom.h;
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
      window.addEventListener("touchmove", move, { capture: true, passive: false });
      window.addEventListener("touchend", up, true);
      e.preventDefault(); e.stopPropagation();
    }
    function move(e) {
      if (!resizing) return;
      var p = point(e);
      var vw = window.innerWidth, vh = window.innerHeight;
      S.geom.w = clamp(ow + (p.x - sx), 320, vw - S.geom.x);
      S.geom.h = clamp(oh + (p.y - sy), 240, vh - S.geom.y);
      applyGeom();
      if (e.cancelable) e.preventDefault();
    }
    function up() {
      resizing = false;
      win.classList.remove("tp-resizing");
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("touchmove", move, true);
      window.removeEventListener("touchend", up, true);
    }
    handle.addEventListener("mousedown", down);
    handle.addEventListener("touchstart", down, { passive: false });
  }

  function point(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function bindKeys() {
    document.addEventListener("keydown", function (e) {
      if (!S.open || S.minimized) return;
      var tag = (e.target && e.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (e.key === "ArrowLeft") { tpPrevPage(); }
      else if (e.key === "ArrowRight") { tpNextPage(); }
      else if (e.key === "+" || e.key === "=") { tpZoomIn(); }
      else if (e.key === "-") { tpZoomOut(); }
    });
  }

  // ── expose ───────────────────────────────────────────────────────────────────
  window.tpOpen = tpOpen;
  window.tpClose = tpClose;
  window.tpMinimize = tpMinimize;
  window.tpRestore = tpRestore;
  window.tpToggleMax = tpToggleMax;
  window.tpSelectSection = tpSelectSection;
  window.tpPrevPage = tpPrevPage;
  window.tpNextPage = tpNextPage;
  window.tpZoomIn = tpZoomIn;
  window.tpZoomOut = tpZoomOut;
  window.tpZoomFit = tpZoomFit;
  window.tpAddMap = tpAddMap;
  window.tpRenameCurrent = tpRenameCurrent;
  window.tpDeleteCurrent = tpDeleteCurrent;
})();
