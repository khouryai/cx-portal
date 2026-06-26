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
  var LAYERS_KEY = "cx_trackplan_layers_v1";   // per-map layer on/off, persisted
  var VIEW_KEY = "cx_trackplan_view_v1";       // per-map zoom/pan/rotation + last map
  var PRESETS_KEY = "cx_trackplan_presets_v1"; // per-map named layer presets
  var LISTHIDDEN_KEY = "cx_trackplan_listhidden_v1"; // per-map: layers hidden+locked from the list
  var MARKUP_KEY = "cx_trackplan_markup_v1";   // per-map annotations
  var SVGNS = "http://www.w3.org/2000/svg";
  var IDB_NAME = "cx-trackplan";
  var IDB_STORE = "pdfs";
  var PDF_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";

  // Built-in maps — committed placeholder PDFs (swap in the real track plans,
  // same filenames). `kind:'builtin'` entries load by URL; `kind:'upload'`
  // entries load their bytes from IndexedDB keyed by the entry id.
  var BUILTINS = [
    { id: "builtin-phase-2", label: "Phase 2 — Full Section", kind: "builtin",
      src: "assets/track-plans/phase-2.pdf", note: "Whole Phase 2 mainline + interlockings" },
    { id: "builtin-phase-2-layered", label: "Phase 2 — Layered demo", kind: "builtin",
      src: "assets/track-plans/phase-2-layered.pdf",
      note: "Demo of toggleable layers (Signals / Axle Counters / WABs) — like a layered Visio PDF" },
    { id: "builtin-phase-2-svg", label: "Phase 2 — SVG layers demo", kind: "builtin",
      src: "assets/track-plans/phase-2-layered.svg", format: "svg",
      note: "Vector SVG with toggleable layers (Signals / Axle Counters / WABs) — like a Visio SVG export" },
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
    // document
    docKind: "pdf",         // 'pdf' | 'svg'
    pdfDoc: null,
    pageNum: 1,
    numPages: 1,
    scale: 1,               // absolute render scale (page units → CSS px)
    mode: "fit-width",      // 'fit-width' | 'fit-page' | 'custom'
    rotation: 0,            // 0 | 90 | 180 | 270
    page: null,             // current PDFPageProxy (for re-fit on resize without refetch)
    ocConfig: null,         // pdf.js OptionalContentConfig for the loaded doc (PDF layers)
    // svg
    svgEl: null,            // the live inline <svg> element
    svgBaseW: 0,            // intrinsic svg width (user units)
    svgBaseH: 0,
    // layers (shared by PDF OCGs and SVG groups)
    layers: [],             // [{type:'group'|'label', id?, name, depth, els?, visible?, opacity?}]
    layersOpen: false,      // is the Layers panel showing?
    layerFilter: "",        // filter text in the layers panel
    opacityMode: false,     // show the per-layer opacity sliders (off = hidden)
    listManage: false,      // "manage list" mode (choose which layers appear)
    lockedNames: {},        // layer name -> true: hidden from the list + locked (pinned visibility)
    solo: { id: null, snapshot: null },  // temporary solo: id + pre-solo visibility
    search: { open: false, query: "", matches: [], idx: 0, index: null, curBBox: null },
    // markup (annotations drawn over the map, stored in unrotated page units)
    markupEl: null,
    markup: { on: false, visible: true, tool: "pen", color: "#e60012", shapes: [], _draw: null },
    renderToken: 0,
    renderTask: null,
    loadToken: 0,
    _lastScale: null,       // previous scale, for zoom-to-cursor anchoring
    _ro: null,              // ResizeObserver on the body
    _roRaf: 0,
    _scrollRaf: 0,
    _wheelRaf: 0,
  };

  // Only the visible slice is ever rasterised, so zoom can go very deep and stay
  // crisp without a giant backing canvas.
  var MIN_SCALE = 0.05, MAX_SCALE = 80;

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
    S.opacityMode = !!readStore(VIEW_KEY).opacityMode;
    if (!S.activeId) {
      var last = readStore(VIEW_KEY).lastActiveId;
      if (last && entries.some(function (e) { return e.id === last; })) S.activeId = last;
    }
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

  // Per-map layer visibility, keyed by layer NAME (survives reloads / re-exports
  // better than an internal id), persisted in localStorage.
  function loadSavedLayerState(entryId) {
    try { var all = JSON.parse(localStorage.getItem(LAYERS_KEY) || "{}"); return (all && all[entryId]) || null; }
    catch (e) { return null; }
  }
  function saveLayerState() {
    var ent = activeEntry(); if (!ent) return;
    var groups = S.layers.filter(function (l) { return l.type === "group"; });
    try {
      var all = JSON.parse(localStorage.getItem(LAYERS_KEY) || "{}");
      if (!all || typeof all !== "object") all = {};
      if (!groups.length) { delete all[ent.id]; }
      else {
        var state = {};
        groups.forEach(function (l) {
          // value is {v:visible[, o:opacity]}; legacy plain-boolean is still read.
          var rec = { v: layerIsVisible(l) };
          if (S.docKind === "svg" && l.opacity != null && l.opacity < 1) rec.o = l.opacity;
          state[l.name] = rec;
        });
        all[ent.id] = state;
      }
      localStorage.setItem(LAYERS_KEY, JSON.stringify(all));
    } catch (e) { /* quota / private mode — non-fatal */ }
  }
  function applySavedLayerState() {
    var ent = activeEntry(); if (!ent) return;
    var saved = loadSavedLayerState(ent.id); if (!saved) return;
    S.layers.forEach(function (l) {
      if (l.type !== "group" || !Object.prototype.hasOwnProperty.call(saved, l.name)) return;
      var rec = saved[l.name];
      var vis = (rec && typeof rec === "object") ? rec.v !== false : !!rec;   // legacy bool support
      setLayerVisible(l, vis);
      if (S.docKind === "svg" && rec && typeof rec === "object" && rec.o != null) setLayerOpacity(l, rec.o);
    });
  }

  // ── view persistence (zoom / pan / rotation + last-opened map) ──────────────
  function readStore(key) { try { var o = JSON.parse(localStorage.getItem(key) || "{}"); return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; } }
  function writeStore(key, o) { try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) {} }

  function loadSavedView(entryId) {
    var all = readStore(VIEW_KEY);
    return (all.views && all.views[entryId]) || null;
  }
  function saveViewNow() {
    var ent = activeEntry(); if (!ent || !hasDoc()) return;
    var body = el("tp-body");
    var all = readStore(VIEW_KEY);
    all.views = all.views || {};
    all.views[ent.id] = {
      scale: S.scale, mode: S.mode, rotation: S.rotation,
      sl: body ? body.scrollLeft : 0, st: body ? body.scrollTop : 0,
    };
    all.lastActiveId = ent.id;
    writeStore(VIEW_KEY, all);
  }
  function scheduleSaveView() {
    if (S._saveViewT) return;
    S._saveViewT = setTimeout(function () { S._saveViewT = 0; saveViewNow(); }, 350);
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
          '<button class="tp-tbtn" type="button" aria-label="Zoom out" title="Zoom out (− / scroll)" onclick="tpZoomOut()">' + ic("minimize") + "</button>" +
          '<span class="tp-tb-label" id="tp-zoomlabel" title="Current zoom">100%</span>' +
          '<button class="tp-tbtn" type="button" aria-label="Zoom in" title="Zoom in (+ / scroll)" onclick="tpZoomIn()">' + ic("plus") + "</button>" +
          '<span class="tp-tb-sep"></span>' +
          '<button class="tp-tbtn" id="tp-fitw" type="button" title="Fit width" onclick="tpFitWidth()">Width</button>' +
          '<button class="tp-tbtn" id="tp-fitp" type="button" title="Fit whole page" onclick="tpFitPage()">Page</button>' +
          '<button class="tp-tbtn" id="tp-actual" type="button" title="Actual size (100%)" onclick="tpActualSize()">1:1</button>' +
          '<button class="tp-tbtn" type="button" aria-label="Rotate 90°" title="Rotate 90°" onclick="tpRotate()">' + ic("rotate") + "</button>" +
          '<button class="tp-tbtn" id="tp-searchbtn" type="button" aria-label="Find on map" title="Find on map (/)" onclick="tpToggleSearch()" style="display:none;">' + ic("search") + "</button>" +
          '<button class="tp-tbtn" id="tp-markupbtn" type="button" aria-label="Annotate" title="Annotate the map" onclick="tpToggleMarkup()" style="display:none;">' + ic("edit") + "</button>" +
          '<button class="tp-tbtn" id="tp-layersbtn" type="button" title="Toggle map layers" onclick="tpToggleLayers()" style="display:none;">' + ic("layers") + " Layers</button>" +
          '<span class="tp-tb-spacer"></span>' +
          '<button class="tp-tbtn" type="button" title="Add a track plan PDF" onclick="tpAddMap()">' + ic("plus") + " Add</button>" +
          '<button class="tp-tbtn" type="button" aria-label="Rename this map" title="Rename this map" onclick="tpRenameCurrent()">' + ic("edit") + "</button>" +
          '<button class="tp-tbtn" type="button" aria-label="Remove this map" title="Remove this map" onclick="tpDeleteCurrent()">' + ic("trash") + "</button>" +
        "</div>" +
        '<div class="tp-viewport" id="tp-viewport">' +
          '<div class="tp-body" id="tp-body">' +
            '<div class="tp-stage" id="tp-stage">' +
              '<canvas class="tp-canvas" id="tp-canvas" style="display:none;"></canvas>' +
              '<svg class="tp-markup" id="tp-markup" xmlns="http://www.w3.org/2000/svg"></svg>' +
              '<div class="tp-search-hit" id="tp-search-hit" style="display:none;"></div>' +
            "</div>" +
          "</div>" +
          // Overlays — siblings of the scrolling body so they stay pinned to the
          // viewport (not the zoomed content), and the body's wheel-zoom handler
          // never sees scrolls that happen over the layers panel.
          '<div class="tp-status" id="tp-status">Loading…</div>' +
          '<div class="tp-search" id="tp-search" hidden>' +
            ic("search") +
            '<input type="text" id="tp-search-input" placeholder="Find on map…" autocomplete="off" ' +
              'oninput="tpSearchInput(this.value)" onkeydown="tpSearchKey(event)">' +
            '<span class="tp-search-count" id="tp-search-count"></span>' +
            '<button type="button" class="tp-search-btn" aria-label="Previous match" title="Previous (Shift+Enter)" onclick="tpSearchStep(-1)">' + ic("chevron-left") + "</button>" +
            '<button type="button" class="tp-search-btn" aria-label="Next match" title="Next (Enter)" onclick="tpSearchStep(1)">' + ic("chevron-right") + "</button>" +
            '<button type="button" class="tp-search-btn" aria-label="Close find" title="Close" onclick="tpToggleSearch()">' + ic("x") + "</button>" +
          "</div>" +
          '<div class="tp-markupbar" id="tp-markupbar" hidden>' +
            '<div class="tp-mk-tools">' +
              '<button type="button" class="tp-mk-tool" data-tool="pen" title="Pen" onclick="tpMkTool(\'pen\')">' + ic("edit") + "</button>" +
              '<button type="button" class="tp-mk-tool" data-tool="highlight" title="Highlighter" onclick="tpMkTool(\'highlight\')">' + ic("highlighter") + "</button>" +
              '<button type="button" class="tp-mk-tool" data-tool="arrow" title="Arrow" onclick="tpMkTool(\'arrow\')">' + ic("arrow-ur") + "</button>" +
              '<button type="button" class="tp-mk-tool" data-tool="rect" title="Rectangle" onclick="tpMkTool(\'rect\')">' + ic("square") + "</button>" +
              '<button type="button" class="tp-mk-tool" data-tool="text" title="Text note" onclick="tpMkTool(\'text\')">' + ic("type") + "</button>" +
            "</div>" +
            '<span class="tp-mk-sep"></span>' +
            '<div class="tp-mk-colors" id="tp-mk-colors"></div>' +
            '<span class="tp-mk-sep"></span>' +
            '<button type="button" class="tp-mk-btn" title="Undo" aria-label="Undo" onclick="tpMkUndo()">' + ic("undo") + "</button>" +
            '<button type="button" class="tp-mk-btn" title="Clear all annotations" aria-label="Clear" onclick="tpMkClear()">' + ic("trash") + "</button>" +
            '<button type="button" class="tp-mk-btn" id="tp-mk-vis" title="Show / hide annotations" aria-label="Show or hide" onclick="tpMkToggleVisible()">' + ic("eye") + "</button>" +
            '<button type="button" class="tp-mk-btn" title="Done" aria-label="Done" onclick="tpToggleMarkup()">' + ic("check") + "</button>" +
          "</div>" +
          '<div class="tp-layers" id="tp-layers" hidden>' +
            '<div class="tp-layers-head">' +
              "<span>Layers</span>" +
              '<span class="tp-layers-acts">' +
                '<button type="button" class="tp-layers-act" onclick="tpAllLayers(true)">All</button>' +
                '<button type="button" class="tp-layers-act" onclick="tpAllLayers(false)">None</button>' +
                '<button type="button" class="tp-layers-act" aria-label="Close layers" title="Close" onclick="tpToggleLayers()">' + ic("x") + "</button>" +
              "</span>" +
            "</div>" +
            '<div class="tp-layers-list" id="tp-layers-list"></div>' +
          "</div>" +
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

    S.markupEl = el("tp-markup");
    bindDrag();
    bindResize();
    bindKeys();
    bindWheelZoom();
    bindPan();
    bindMarkup();
    el("tp-body").addEventListener("scroll", onBodyScroll);

    // On viewport resize: re-fit (fit modes) and always repaint the slice for the
    // new viewport size. Custom zoom keeps its scale.
    if (typeof ResizeObserver !== "undefined") {
      S._ro = new ResizeObserver(function () {
        if (!S.open || S.minimized || !hasDoc()) return;
        if (S._roRaf) return;
        S._roRaf = requestAnimationFrame(function () { S._roRaf = 0; relayoutAndRender(null, false); });
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
      if (S.svgEl) S.svgEl.style.display = "none";
    } else {
      s.style.display = "none";
      s.classList.remove("tp-error");
      if (S.docKind === "svg") {
        if (c) c.style.display = "none";
        if (S.svgEl) S.svgEl.style.display = "block";
      } else if (c) {
        c.style.display = "block";
      }
    }
  }

  // ── PDF loading + rendering ─────────────────────────────────────────────────
  function ensureWorker() {
    if (typeof pdfjsLib === "undefined") return false;
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    return true;
  }

  function entryFormat(entry) {
    if (!entry) return "pdf";
    if (entry.format) return entry.format;
    if (/\.svg(\?|$)/i.test(entry.src || "") || /\.svg$/i.test(entry.fileName || "")) return "svg";
    return "pdf";
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

  function entryText(entry) {
    if (entry.kind === "upload") {
      return idbGet(entry.id).then(function (rec) {
        if (!rec || !rec.blob) throw new Error("This uploaded map is no longer stored on this device.");
        return rec.blob.text();
      });
    }
    return fetch(entry.src, { cache: "force-cache" }).then(function (r) {
      if (!r.ok) throw new Error("Could not load " + entry.src + " (" + r.status + ")");
      return r.text();
    });
  }

  function loadActive() {
    var entry = activeEntry();
    renderSectionSelect();
    if (!entry) { setStatus("No track plan selected.", false); return; }
    var myLoad = ++S.loadToken;
    // reset doc state
    S.pdfDoc = null; S.page = null; S.pageNum = 1; S.numPages = 1;
    S.mode = "fit-width"; S.rotation = 0; S.scale = 1; S._lastScale = null;
    S.ocConfig = null; S.layers = []; S.layersOpen = false; S.layerFilter = "";
    S.solo = { id: null, snapshot: null };
    S.listManage = false;
    S.lockedNames = (entry && readStore(LISTHIDDEN_KEY)[entry.id]) || {};
    S.search = { open: false, query: "", matches: [], idx: 0, index: null, curBBox: null };
    var sb = el("tp-search"); if (sb) sb.hidden = true;
    clearSearchHit();
    // markup: keep persisted shapes, but exit edit mode for the new map
    S.markup.on = false; S.markup.visible = true; S.markup._draw = null;
    var mbar = el("tp-markupbar"); if (mbar) mbar.hidden = true;
    loadMarkupForEntry();
    detachSvg();
    S.docKind = entryFormat(entry);
    // Restore the saved view (zoom/pan/rotation) for this map, if any.
    S._pendingScroll = null;
    var sv = loadSavedView(entry.id);
    if (sv) {
      if (sv.mode) S.mode = sv.mode;
      if (sv.scale) S.scale = sv.scale;
      if (sv.rotation) S.rotation = sv.rotation;
      S._pendingScroll = { sl: sv.sl || 0, st: sv.st || 0 };
    }
    setStatus("Loading " + entry.label + "…", false);
    updateToolbar();
    if (S.docKind === "svg") { loadSvg(entry, myLoad); return; }
    loadPdf(entry, myLoad);
  }

  function loadPdf(entry, myLoad) {
    if (!ensureWorker()) { setStatus("PDF viewer library not loaded.", true); return; }
    entryBytes(entry).then(function (bytes) {
      return pdfjsLib.getDocument({ data: bytes }).promise;
    }).then(function (doc) {
      if (myLoad !== S.loadToken) return;        // a newer load superseded this one
      S.pdfDoc = doc; S.numPages = doc.numPages; S.pageNum = 1;
      // Pull the PDF's optional-content (layer) config BEFORE first render so the
      // initial paint already honours layer visibility.
      return doc.getOptionalContentConfig().then(function (cfg) {
        if (myLoad !== S.loadToken) return;
        applyOptionalContent(cfg);
      }, function () { /* no OC info — fine */ });
    }).then(function () {
      if (myLoad !== S.loadToken) return;
      updateToolbar();
      return renderPage();
    }).catch(function (err) {
      if (myLoad !== S.loadToken) return;
      setStatus((err && err.message) || "Failed to load this track plan.", true);
    });
  }

  // ── SVG loading + layers ────────────────────────────────────────────────────
  function detachSvg() {
    if (S.svgEl && S.svgEl.parentNode) S.svgEl.parentNode.removeChild(S.svgEl);
    S.svgEl = null; S.svgBaseW = 0; S.svgBaseH = 0;
  }

  // Strip anything executable so an uploaded SVG can't run script in the app.
  function sanitizeSvg(svg) {
    var scripts = svg.querySelectorAll("script");
    for (var i = scripts.length - 1; i >= 0; i--) scripts[i].parentNode.removeChild(scripts[i]);
    var all = svg.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var attrs = all[j].attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        var n = attrs[k].name, v = attrs[k].value || "";
        if (/^on/i.test(n)) all[j].removeAttribute(n);
        else if (/^(href|xlink:href)$/i.test(n) && /^\s*javascript:/i.test(v)) all[j].removeAttribute(n);
      }
    }
    return svg;
  }

  function svgIntrinsicSize(svg) {
    var vb = svg.getAttribute("viewBox");
    if (vb) {
      var p = vb.split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
    }
    var w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
    if (w > 0 && h > 0) return { w: w, h: h };
    try { var b = svg.getBBox && svg.getBBox(); if (b && b.width) return { w: b.width, h: b.height }; } catch (e) {}
    return { w: 1000, h: 700 };
  }

  function loadSvg(entry, myLoad) {
    entryText(entry).then(function (txt) {
      if (myLoad !== S.loadToken) return;
      var doc = new DOMParser().parseFromString(txt, "image/svg+xml");
      var svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() === "parsererror" || svg.getElementsByTagName("parsererror").length) {
        throw new Error("This file isn't a readable SVG.");
      }
      sanitizeSvg(svg);
      var size = svgIntrinsicSize(svg);
      S.svgBaseW = size.w; S.svgBaseH = size.h;
      if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", "0 0 " + size.w + " " + size.h);
      svg.removeAttribute("style");
      svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
      svg.style.position = "absolute";
      svg.style.top = "0"; svg.style.left = "0";
      svg.style.transformOrigin = "0 0";
      // import into our document and mount inside the stage
      var imported = document.importNode(svg, true);
      var stage = el("tp-stage");
      if (!stage) throw new Error("Viewer not ready.");
      S.svgEl = imported;
      stage.appendChild(imported);
      detectSvgLayers(imported);
      applySavedLayerState();
      updateToolbar();
      renderLayerPanel();
      relayoutAndRender(null, true);
    }).catch(function (err) {
      if (myLoad !== S.loadToken) return;
      setStatus((err && err.message) || "Failed to load this SVG track plan.", true);
    });
  }

  var INK_NS = "http://www.inkscape.org/namespaces/inkscape";
  var VISIO_NS = "http://schemas.microsoft.com/visio/2003/SVGExtensions/";

  function attr(elm, qualified, ns, local) {
    return elm.getAttribute(qualified) || (ns && elm.getAttributeNS ? elm.getAttributeNS(ns, local) : null);
  }
  function groupName(g, i) {
    var t = g.querySelector ? g.querySelector(":scope > title, :scope > desc") : null;
    return attr(g, "inkscape:label", INK_NS, "label") || g.getAttribute("data-name") ||
           g.getAttribute("aria-label") || (t && t.textContent) || g.id || ("Layer " + (i + 1));
  }

  // Detect toggleable layers in an SVG, trying the common authoring conventions:
  // Inkscape layer groups → Visio v:layerMember membership → top-level <g> groups.
  function detectSvgLayers(svg) {
    S.layers = [];
    var gAll = Array.prototype.slice.call(svg.querySelectorAll("g"));

    // 1) Inkscape-style layers
    var ink = gAll.filter(function (g) { return attr(g, "inkscape:groupmode", INK_NS, "groupmode") === "layer"; });
    if (ink.length) { pushSvgLayers(ink.map(function (g, i) { return { name: groupName(g, i), els: [g] }; })); return; }

    // 2) Visio layer membership (v:layerMember on shapes)
    var membered = Array.prototype.slice.call(svg.querySelectorAll("*")).filter(function (e) {
      return e.getAttribute && (attr(e, "v:layerMember", VISIO_NS, "layerMember") != null);
    });
    if (membered.length) {
      var names = readVisioLayerNames(svg);
      var order = [], byLayer = {};
      membered.forEach(function (e) {
        var lm = attr(e, "v:layerMember", VISIO_NS, "layerMember") || "";
        lm.split(/[;,\s]+/).filter(Boolean).forEach(function (idx) {
          if (!byLayer[idx]) { byLayer[idx] = []; order.push(idx); }
          byLayer[idx].push(e);
        });
      });
      pushSvgLayers(order.map(function (idx) {
        return { name: (names && names[idx]) || ("Layer " + (Number(idx) + 1)), els: byLayer[idx] };
      }));
      return;
    }

    // 3) Top-level <g> groups (Illustrator / Affinity / generic)
    var top = Array.prototype.slice.call(svg.children).filter(isG);
    if (top.length === 1) {
      var inner = Array.prototype.slice.call(top[0].children).filter(isG);
      if (inner.length > 1) top = inner;
    }
    var named = top.filter(function (g) { return g.id || g.getAttribute("data-name") || g.getAttribute("aria-label") || (g.querySelector && g.querySelector(":scope > title")); });
    if (top.length > 1 && named.length >= 2) {
      pushSvgLayers(top.map(function (g, i) { return { name: groupName(g, i), els: [g] }; }));
    }
  }
  function isG(n) { return n.tagName && n.tagName.toLowerCase() === "g"; }

  // Best-effort: pull Visio layer display names if the export embedded a table.
  function readVisioLayerNames(svg) {
    var names = {};
    var defs = svg.querySelectorAll("*");
    for (var i = 0; i < defs.length; i++) {
      var e = defs[i];
      var nm = attr(e, "v:name", VISIO_NS, "name");
      var ix = attr(e, "v:index", VISIO_NS, "index");
      if (nm != null && ix != null) names[ix] = nm;
    }
    return Object.keys(names).length ? names : null;
  }

  function pushSvgLayers(list) {
    S.layers = list.map(function (l, i) {
      return { type: "group", id: "svg-" + i, name: l.name || ("Layer " + (i + 1)), depth: 0, els: l.els, visible: true };
    });
  }

  // Build the flattened layer list from the PDF's optional-content config.
  function applyOptionalContent(cfg) {
    S.ocConfig = cfg || null;
    S.layers = [];
    if (!cfg || typeof cfg.getGroups !== "function") return;
    var groups = cfg.getGroups();
    if (!groups || !Object.keys(groups).length) return;
    var order = (typeof cfg.getOrder === "function" && cfg.getOrder()) || Object.keys(groups);
    walkLayerOrder(order, 0, cfg, groups);
    // Fallback: if the order yielded no toggleable groups, list them flat.
    if (!S.layers.some(function (l) { return l.type === "group"; })) {
      S.layers = Object.keys(groups).map(function (id) {
        return { type: "group", id: id, name: groups[id].name || "Layer", depth: 0 };
      });
    }
    applySavedLayerState();
    renderLayerPanel();
  }

  function walkLayerOrder(items, depth, cfg, groups) {
    if (!Array.isArray(items)) return;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (Array.isArray(item)) {
        // A nested array may start with a label string, then its members.
        if (item.length && typeof item[0] === "string" && !groups[item[0]]) {
          S.layers.push({ type: "label", name: item[0], depth: depth });
          walkLayerOrder(item.slice(1), depth + 1, cfg, groups);
        } else {
          walkLayerOrder(item, depth + 1, cfg, groups);
        }
      } else if (typeof item === "string") {
        if (groups[item]) {
          S.layers.push({ type: "group", id: item, name: groups[item].name || "Layer", depth: depth });
        } else {
          S.layers.push({ type: "label", name: item, depth: depth });
        }
      }
    }
  }

  // Whether a document is currently loaded (PDF page or SVG element).
  function hasDoc() { return S.docKind === "svg" ? !!S.svgEl : !!S.page; }

  // Base page size in user units at scale 1, accounting for rotation.
  function baseSize() {
    var w, h;
    if (S.docKind === "svg") { w = S.svgBaseW; h = S.svgBaseH; }
    else { var vp = S.page.getViewport({ scale: 1, rotation: 0 }); w = vp.width; h = vp.height; }
    return (S.rotation % 180) ? { w: h, h: w } : { w: w, h: h };
  }

  // Scale that makes the page fit the viewport for the current fit mode.
  function fitScaleFor() {
    var body = el("tp-body");
    var availW = (body ? body.clientWidth : 480) - 4;
    var availH = (body ? body.clientHeight : 360) - 4;
    var b = baseSize();
    var sw = Math.max(MIN_SCALE, availW / b.w);
    if (S.mode === "fit-page") return Math.min(sw, Math.max(MIN_SCALE, availH / b.h));
    return sw;
  }

  // (Re)load the current page object, then lay out + render. Pass anchor {cx,cy}
  // to keep that point fixed across a scale change (zoom-to-cursor).
  function renderPage(anchor) {
    if (S.docKind === "svg") {
      if (!S.svgEl) return Promise.resolve();
      if (S._lastScale == null) S._lastScale = S.scale;
      relayoutAndRender(anchor, !anchor);
      return Promise.resolve();
    }
    if (!S.pdfDoc) return Promise.resolve();
    var myLoad = S.loadToken;
    return S.pdfDoc.getPage(S.pageNum).then(function (page) {
      if (myLoad !== S.loadToken) return;
      S.page = page;
      if (S._lastScale == null) S._lastScale = S.scale;
      relayoutAndRender(anchor, !anchor);
    }).catch(function (err) {
      setStatus((err && err.message) || "Failed to render this page.", true);
    });
  }

  // Size the scroll "stage" (a spacer the size of the page at the current scale)
  // and reposition the scroll, then paint. PDF paints the visible slice into a
  // viewport-sized canvas; SVG just resizes the vector element (crisp at any zoom).
  function relayoutAndRender(anchor, reset) {
    if (!hasDoc()) return;
    var body = el("tp-body"), stage = el("tp-stage");
    if (!body || !stage) return;
    var oldScale = S._lastScale || S.scale;
    if (S.mode !== "custom") S.scale = fitScaleFor();
    S.scale = clamp(S.scale, MIN_SCALE, MAX_SCALE);

    var b = baseSize();
    stage.style.width = Math.ceil(b.w * S.scale) + "px";
    stage.style.height = Math.ceil(b.h * S.scale) + "px";

    var maxL = Math.max(0, stage.offsetWidth - body.clientWidth);
    var maxT = Math.max(0, stage.offsetHeight - body.clientHeight);
    if (anchor) {
      var sc = pageToScroll(anchor, oldScale, S.scale);
      body.scrollLeft = clamp(sc.sl, 0, maxL);
      body.scrollTop = clamp(sc.st, 0, maxT);
    } else if (S._pendingScroll) {
      // first render after a load that restored a saved view
      body.scrollLeft = clamp(S._pendingScroll.sl, 0, maxL);
      body.scrollTop = clamp(S._pendingScroll.st, 0, maxT);
      S._pendingScroll = null;
    } else if (reset) {
      body.scrollLeft = 0;
      body.scrollTop = 0;
    } else {
      body.scrollLeft = clamp(body.scrollLeft, 0, maxL);
      body.scrollTop = clamp(body.scrollTop, 0, maxT);
    }
    S._lastScale = S.scale;
    if (S.search && S.search.curBBox) positionSearchHit(S.search.curBBox, false);
    scheduleSaveView();
    updatePanCursor();
    updateToolbar();
    paint();
  }

  function paint() { if (S.docKind === "svg") sizeSvg(); else renderSlice(); sizeMarkup(); }

  // Resize the inline SVG to the current scale + rotation. Vector stays crisp at
  // any zoom, so there's no slicing — the whole drawing is the stage.
  function sizeSvg() {
    if (!S.svgEl) return;
    var sw = S.svgBaseW * S.scale, sh = S.svgBaseH * S.scale;  // unrotated scaled size
    S.svgEl.setAttribute("width", sw);
    S.svgEl.setAttribute("height", sh);
    S.svgEl.style.width = sw + "px";
    S.svgEl.style.height = sh + "px";
    var t = "";
    if (S.rotation === 90) t = "translate(" + sh + "px,0) rotate(90deg)";
    else if (S.rotation === 180) t = "translate(" + sw + "px," + sh + "px) rotate(180deg)";
    else if (S.rotation === 270) t = "translate(0," + sw + "px) rotate(270deg)";
    S.svgEl.style.transform = t;
    setStatus("", false);
  }

  // Map a client-space anchor to the scroll offset that keeps the same page
  // point under it after a scale change. Page top-left sits at stage origin.
  function pageToScroll(anchor, oldScale, newScale) {
    var body = el("tp-body");
    var r = body.getBoundingClientRect();
    var cxLocal = anchor.cx - r.left, cyLocal = anchor.cy - r.top;
    var pageX = (body.scrollLeft + cxLocal) / oldScale;
    var pageY = (body.scrollTop + cyLocal) / oldScale;
    return { sl: pageX * newScale - cxLocal, st: pageY * newScale - cyLocal };
  }

  // Paint only the part of the page currently scrolled into view, at full
  // device resolution. Re-runs on zoom, pan and scroll.
  function renderSlice() {
    if (!S.page) return;
    var body = el("tp-body"), canvas = el("tp-canvas"), stage = el("tp-stage");
    if (!body || !canvas || !stage) return;
    var token = ++S.renderToken;
    if (S.renderTask) { try { S.renderTask.cancel(); } catch (e) {} S.renderTask = null; }

    var dpr = window.devicePixelRatio || 1;
    var vw = Math.max(1, body.clientWidth), vh = Math.max(1, body.clientHeight);
    var sl = body.scrollLeft, st = body.scrollTop;
    // Canvas covers the visible slice but never exceeds the page (stage) size, so
    // a page smaller than the viewport can't spawn phantom scrollbars.
    var cw = Math.max(1, Math.min(vw, stage.offsetWidth));
    var ch = Math.max(1, Math.min(vh, stage.offsetHeight));
    canvas.style.left = sl + "px";
    canvas.style.top = st + "px";
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
    canvas.style.display = "block";

    var vp = S.page.getViewport({ scale: S.scale, rotation: S.rotation });
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    setStatus("", false);
    // Draw the full page but shifted by -scroll, so only the visible slice lands
    // on the canvas (pdf.js clips the rest). optionalContentConfig applies the
    // current PDF-layer visibility.
    var params = { canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -sl, -st] };
    // NB: the render param is optionalContentConfigPromise (resolving to our
    // mutable config) — passing a bare config is silently ignored by pdf.js.
    if (S.ocConfig) params.optionalContentConfigPromise = Promise.resolve(S.ocConfig);
    S.renderTask = S.page.render(params);
    S.renderTask.promise.then(function () {
      if (token === S.renderToken) { S.renderTask = null; updateToolbar(); }
    }).catch(function (err) {
      if (err && err.name === "RenderingCancelledException") return;
      if (token === S.renderToken) setStatus((err && err.message) || "Render failed.", true);
    });
  }

  // Keep the canvas pinned during native scroll; re-render the slice next frame.
  function onBodyScroll() {
    if (hasDoc()) scheduleSaveView();
    var body = el("tp-body"), canvas = el("tp-canvas");
    if (!body || !canvas || !S.page) return;   // PDF only: SVG scrolls natively
    canvas.style.left = body.scrollLeft + "px";
    canvas.style.top = body.scrollTop + "px";
    if (S._scrollRaf) return;
    S._scrollRaf = requestAnimationFrame(function () { S._scrollRaf = 0; renderSlice(); });
  }

  // Toggle the grab cursor only when the page overflows the viewport.
  function updatePanCursor() {
    var body = el("tp-body"), stage = el("tp-stage");
    if (!body || !stage) return;
    var pan = stage.offsetWidth > body.clientWidth + 1 || stage.offsetHeight > body.clientHeight + 1;
    body.classList.toggle("tp-pannable", pan);
  }

  function centerAnchor() {
    var b = el("tp-body");
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  function zoomBy(factor, anchor) {
    if (!hasDoc()) return;
    S.mode = "custom";
    S.scale = clamp(S.scale * factor, MIN_SCALE, MAX_SCALE);
    relayoutAndRender(anchor || centerAnchor(), false);
  }

  function updateToolbar() {
    var pl = el("tp-pagelabel"), prev = el("tp-prev"), next = el("tp-next"), zl = el("tp-zoomlabel");
    if (pl) pl.textContent = "Page " + S.pageNum + " / " + S.numPages;
    if (prev) prev.disabled = !S.pdfDoc || S.pageNum <= 1;
    if (next) next.disabled = !S.pdfDoc || S.pageNum >= S.numPages;
    if (zl) zl.textContent = Math.round(S.scale * 100) + "%";
    var fw = el("tp-fitw"), fp = el("tp-fitp"), ac = el("tp-actual");
    if (fw) fw.classList.toggle("tp-primary", S.mode === "fit-width");
    if (fp) fp.classList.toggle("tp-primary", S.mode === "fit-page");
    if (ac) ac.classList.toggle("tp-primary", S.mode === "custom" && Math.abs(S.scale - 1) < 0.01);
    var lb = el("tp-layersbtn");
    if (lb) {
      var groupCount = S.layers.filter(function (l) { return l.type === "group"; }).length;
      // Always show the button once a map is loaded, but disable + explain when the
      // file has no layers — so an unlayered export is obvious, not invisible.
      lb.style.display = hasDoc() ? "inline-flex" : "none";
      lb.disabled = groupCount === 0;
      lb.classList.toggle("tp-primary", groupCount > 0 && S.layersOpen);
      lb.title = groupCount > 0
        ? "Toggle map layers (" + groupCount + " found)"
        : (S.docKind === "svg"
            ? "No layers found in this SVG — put each equipment type on its own Visio layer before exporting. Run tpLayerInfo() for details."
            : "No layers in this PDF — re-export preserving layers (SVG, or Acrobat PDFMaker), not “Print to PDF”. Run tpLayerInfo() for details.");
    }
    var sb = el("tp-searchbtn");
    if (sb) {
      sb.style.display = hasDoc() ? "inline-flex" : "none";
      sb.classList.toggle("tp-primary", !!(S.search && S.search.open));
    }
    var mb = el("tp-markupbtn");
    if (mb) {
      mb.style.display = hasDoc() ? "inline-flex" : "none";
      mb.classList.toggle("tp-primary", !!(S.markup && S.markup.on));
    }
  }

  // Console diagnostic: confirm whether the LOADED map actually carries layers
  // (PDF OCGs or SVG groups), using the user's own file in their own browser —
  // nothing is uploaded. Usage: open the map, then run tpLayerInfo() in DevTools.
  function tpLayerInfo() {
    if (!hasDoc()) { console.log("Track Plan: open a map first, then run tpLayerInfo()."); return Promise.resolve(null); }
    if (S.docKind === "svg") {
      var nms = S.layers.filter(function (l) { return l.type === "group"; }).map(function (l) { return l.name; });
      if (nms.length) console.log("✅ Track Plan (SVG) — " + nms.length + " layer(s): " + nms.join(", "));
      else console.log("❌ Track Plan (SVG) — no separate layers found. In Visio, put each equipment type on its own layer before exporting SVG (or check the SVG groups its shapes by layer).");
      return Promise.resolve(nms);
    }
    if (!S.pdfDoc) return Promise.resolve(null);
    return S.pdfDoc.getOptionalContentConfig().then(function (cfg) {
      var groups = (cfg && typeof cfg.getGroups === "function" && cfg.getGroups()) || null;
      var names = groups ? Object.keys(groups).map(function (id) { return groups[id].name; }) : [];
      if (names.length) {
        console.log("✅ Track Plan — this PDF has " + names.length + " layer(s): " + names.join(", "));
      } else {
        console.log("❌ Track Plan — this PDF has NO layers (no OCGs). Your Visio export flattened them. " +
          "Re-export preserving layers (e.g. SVG, or Acrobat PDFMaker), NOT “Microsoft Print to PDF” or plain Save as PDF.");
      }
      return names;
    }).catch(function (e) {
      console.log("Track Plan — could not read layer info: " + (e && e.message));
      return null;
    });
  }

  // ── Layers panel (PDF optional-content groups OR SVG groups) ────────────────
  function tpToggleLayers() {
    if (!S.layers.some(function (l) { return l.type === "group"; })) return;
    S.layersOpen = !S.layersOpen;
    renderLayerPanel();
    updateToolbar();
  }

  function layerIsVisible(l) {
    if (S.docKind === "svg") return l.visible !== false;
    if (!S.ocConfig) return true;
    if (typeof S.ocConfig.isVisible === "function") return !!S.ocConfig.isVisible(l.id);
    var g = S.ocConfig.getGroup(l.id);
    return g ? !!g.visible : true;
  }

  function idq(id) { return esc(id).replace(/'/g, "\\'"); }

  // Best-effort swatch colour for an SVG layer (first real fill/stroke found).
  function layerColor(l) {
    if (S.docKind !== "svg" || !l.els) return null;
    var seen = 0;
    for (var i = 0; i < l.els.length && seen < 40; i++) {
      var nodes = [l.els[i]];
      if (l.els[i].querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(l.els[i].querySelectorAll("*")));
      for (var j = 0; j < nodes.length && seen < 40; j++, seen++) {
        var n = nodes[j];
        if (!n.getAttribute) continue;
        var f = n.getAttribute("fill") || (n.style && n.style.fill);
        if (f && f !== "none" && !/^url\(/i.test(f) && !/^(currentcolor|inherit)$/i.test(f)) return f;
        var s = n.getAttribute("stroke") || (n.style && n.style.stroke);
        if (s && s !== "none" && !/^url\(/i.test(s) && !/^(currentcolor|inherit)$/i.test(s)) return s;
      }
    }
    return null;
  }

  function isLocked(l) { return !!S.lockedNames[l.name]; }

  // Group layers, sorted alphabetically; labels kept (rare, PDF only) ahead.
  function sortedLayers() {
    return S.layers.slice().sort(function (a, b) {
      if (a.type !== b.type) return a.type === "label" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function layerRowsHtml() {
    var f = (S.layerFilter || "").trim().toLowerCase();
    return sortedLayers().map(function (l) {
      if (l.type === "label") return f ? "" : '<div class="tp-layer-label">' + esc(l.name) + "</div>";
      var locked = isLocked(l);
      if (!S.listManage && locked) return "";                 // hidden from the list
      if (f && l.name.toLowerCase().indexOf(f) < 0) return "";
      var on = layerIsVisible(l);
      if (l._color === undefined) l._color = layerColor(l);
      var sw = l._color
        ? '<span class="tp-layer-sw" style="background:' + esc(l._color) + '"></span>'
        : '<span class="tp-layer-sw tp-layer-sw-none"></span>';
      var q = idq(l.id);
      if (S.listManage) {
        // manage mode: choose which layers appear in the list (hidden = locked)
        return '<div class="tp-layer-row' + (locked ? " tp-layer-locked" : "") + '">' +
                 '<label class="tp-layer-main">' +
                   '<input type="checkbox" ' + (on ? "checked" : "") + ' onchange="tpSetLayer(\'' + q + "', this.checked)\">" +
                   sw + '<span class="tp-layer-nm" title="' + esc(l.name) + '">' + esc(l.name) + "</span>" +
                 "</label>" +
                 '<button type="button" class="tp-layer-solo' + (locked ? "" : " active") +
                   '" title="' + (locked ? "Show in list" : "Hide from list and lock") + '" aria-label="Toggle in list" onclick="tpLayerListToggle(\'' + q + "')\">" + ic(locked ? "eye-off" : "eye") + "</button>" +
               "</div>";
      }
      var op = (S.docKind === "svg" && S.opacityMode)
        ? '<input type="range" class="tp-layer-op" min="10" max="100" value="' + Math.round((l.opacity == null ? 1 : l.opacity) * 100) +
          '" title="Layer opacity" oninput="tpSetLayerOpacity(\'' + q + "', this.value)\">"
        : "";
      return '<div class="tp-layer-row">' +
               '<label class="tp-layer-main">' +
                 '<input type="checkbox" ' + (on ? "checked" : "") + ' onchange="tpSetLayer(\'' + q + "', this.checked)\">" +
                 sw + '<span class="tp-layer-nm" title="' + esc(l.name) + '">' + esc(l.name) + "</span>" +
               "</label>" +
               '<button type="button" class="tp-layer-solo' + (S.solo.id === l.id ? " active" : "") +
                 '" title="Solo this layer (click again to restore)" aria-label="Solo this layer" onclick="tpSoloLayer(\'' + q + "')\">" + ic("eye") + "</button>" +
               op +
             "</div>";
    }).join("");
  }

  function renderLayerRows() { var list = el("tp-layers-list"); if (list) list.innerHTML = layerRowsHtml(); }

  function renderLayerPanel() {
    var panel = el("tp-layers");
    if (!panel) return;
    if (!S.layersOpen) { panel.hidden = true; return; }
    panel.hidden = false;
    var ent = activeEntry();
    var groups = S.layers.filter(function (l) { return l.type === "group"; });
    var presets = ent ? loadPresets(ent.id) : [];
    var hiddenCount = groups.filter(isLocked).length;
    var opacityBtn = (S.docKind === "svg" && groups.length)
      ? '<button type="button" class="tp-layers-act' + (S.opacityMode ? " active" : "") +
        '" title="Show per-layer opacity sliders" aria-label="Toggle opacity sliders" onclick="tpToggleOpacityMode()">' + ic("sliders") + "</button>"
      : "";
    var manageBtn = groups.length
      ? '<button type="button" class="tp-layers-act' + (S.listManage ? " active" : "") +
        '" title="' + (hiddenCount ? hiddenCount + " hidden — m" : "M") + 'anage which layers appear (hidden layers are locked)" aria-label="Manage list" onclick="tpToggleLayerManage()">' + ic("eye-off") + "</button>"
      : "";
    var head =
      '<div class="tp-layers-head"><span>' + (S.listManage ? "Manage list" : "Layers") + "</span>" +
      '<span class="tp-layers-acts">' +
        opacityBtn + manageBtn +
        (S.listManage ? "" :
          '<button type="button" class="tp-layers-act" title="Show all" onclick="tpAllLayers(true)">All</button>' +
          '<button type="button" class="tp-layers-act" title="Hide all" onclick="tpAllLayers(false)">None</button>') +
        '<button type="button" class="tp-layers-act" aria-label="Close layers" title="Close" onclick="tpToggleLayers()">' + ic("x") + "</button>" +
      "</span></div>";
    var presetRow = groups.length ?
      '<div class="tp-layers-presets">' +
        '<select id="tp-preset" class="tp-preset-sel" onchange="tpPresetApply(this.value)" title="Apply a saved layer preset">' +
          '<option value="">Preset…</option>' +
          presets.map(function (p) { return '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>"; }).join("") +
        "</select>" +
        '<button type="button" class="tp-layers-act" title="Save current layers as a preset" aria-label="Save preset" onclick="tpPresetSave()">' + ic("save") + "</button>" +
        (presets.length ? '<button type="button" class="tp-layers-act" title="Delete the selected preset" aria-label="Delete preset" onclick="tpPresetDelete()">' + ic("trash") + "</button>" : "") +
      "</div>" : "";
    var filterRow = groups.length > 6 ?
      '<div class="tp-layers-filter"><input type="text" id="tp-layer-filter" placeholder="Filter layers…" value="' + esc(S.layerFilter || "") + '" oninput="tpLayerFilter(this.value)"></div>' : "";
    panel.innerHTML = head + presetRow + filterRow +
      '<div class="tp-layers-list" id="tp-layers-list"></div>' +
      '<div class="tp-layers-resize" id="tp-layers-resize" title="Drag to resize"></div>';
    renderLayerRows();
    applyLayersPanelSize();
    bindLayersResize();
  }

  function applyLayersPanelSize() {
    var panel = el("tp-layers"); if (!panel) return;
    var all = readStore(VIEW_KEY);
    panel.style.width = (all.layersW ? all.layersW : 240) + "px";
    if (all.layersH) panel.style.height = all.layersH + "px";
  }

  function bindLayersResize() {
    var handle = el("tp-layers-resize"), panel = el("tp-layers");
    if (!handle || !panel) return;
    handle.onmousedown = function (e) {
      e.preventDefault(); e.stopPropagation();
      var sx = e.clientX, sy = e.clientY, sw = panel.offsetWidth, sh = panel.offsetHeight;
      var vp = el("tp-viewport");
      var maxW = (vp ? vp.clientWidth : 600) - 16, maxH = (vp ? vp.clientHeight : 600) - 16;
      function mm(ev) {
        // panel is anchored top-right, so dragging left widens it
        panel.style.width = clamp(sw + (sx - ev.clientX), 180, maxW) + "px";
        panel.style.height = clamp(sh + (ev.clientY - sy), 140, maxH) + "px";
      }
      function mu() {
        window.removeEventListener("mousemove", mm, true);
        window.removeEventListener("mouseup", mu, true);
        var all = readStore(VIEW_KEY);
        all.layersW = panel.offsetWidth; all.layersH = panel.offsetHeight;
        writeStore(VIEW_KEY, all);
      }
      window.addEventListener("mousemove", mm, true);
      window.addEventListener("mouseup", mu, true);
    };
  }

  function findLayer(id) {
    for (var i = 0; i < S.layers.length; i++) if (S.layers[i].id === id) return S.layers[i];
    return null;
  }

  function setLayerVisible(l, visible) {
    if (S.docKind === "svg") {
      l.visible = !!visible;
      (l.els || []).forEach(function (e) { e.style.display = visible ? "" : "none"; });
    } else if (S.ocConfig) {
      try { S.ocConfig.setVisibility(l.id, !!visible); } catch (e) {}
    }
  }

  function setLayerOpacity(l, o) {
    o = Math.max(0, Math.min(1, o));
    l.opacity = o;
    (l.els || []).forEach(function (e) { e.style.opacity = o >= 1 ? "" : String(o); });
  }

  function tpSetLayer(id, visible) {
    var l = findLayer(id);
    if (!l) return;
    clearSolo();                              // a manual change ends a temporary solo
    setLayerVisible(l, visible);
    saveLayerState();
    if (S.docKind !== "svg") renderSlice();   // SVG toggles the DOM directly — instant
  }

  function tpAllLayers(visible) {
    clearSolo();
    S.layers.forEach(function (l) { if (l.type === "group" && !isLocked(l)) setLayerVisible(l, visible); });
    saveLayerState();
    renderLayerPanel();
    if (S.docKind !== "svg") renderSlice();
  }

  function snapshotLayers() {
    var snap = {};
    S.layers.forEach(function (l) { if (l.type === "group") snap[l.id] = layerIsVisible(l); });
    return snap;
  }
  function applyLayerSnapshot(snap) {
    if (!snap) return;
    S.layers.forEach(function (l) {
      if (l.type === "group" && Object.prototype.hasOwnProperty.call(snap, l.id)) setLayerVisible(l, snap[l.id]);
    });
  }
  // Forget a solo without restoring (used when the user manually changes layers).
  function clearSolo() { S.solo = { id: null, snapshot: null }; }

  // Temporary solo: the eye shows only this layer; pressing it again (or another
  // eye) restores the visibility you had before. Solo never overwrites the saved
  // selection, so your real choices come back when you un-solo.
  function tpSoloLayer(id) {
    if (S.solo.id === id) {                    // un-solo → restore
      applyLayerSnapshot(S.solo.snapshot);
      clearSolo();
    } else {
      if (S.solo.id == null) S.solo.snapshot = snapshotLayers();
      else applyLayerSnapshot(S.solo.snapshot);   // switching solo: restore base first
      var snap = S.solo.snapshot;
      // locked (list-hidden) layers stay as they are — they're pinned
      S.layers.forEach(function (l) { if (l.type === "group" && !isLocked(l)) setLayerVisible(l, l.id === id); });
      S.solo = { id: id, snapshot: snap };
    }
    renderLayerRows();
    if (S.docKind !== "svg") renderSlice();
  }

  function tpSetLayerOpacity(id, val) {
    var l = findLayer(id);
    if (!l) return;
    setLayerOpacity(l, Number(val) / 100);
    saveLayerState();
  }

  function tpLayerFilter(v) { S.layerFilter = v || ""; renderLayerRows(); }

  // Master toggle for the per-layer opacity sliders (hidden by default so the
  // panel stays uncluttered). Preference is remembered.
  function tpToggleOpacityMode() {
    S.opacityMode = !S.opacityMode;
    var all = readStore(VIEW_KEY); all.opacityMode = S.opacityMode; writeStore(VIEW_KEY, all);
    renderLayerPanel();
  }

  // ── manage which layers appear in the list (hidden = locked/pinned) ─────────
  function tpToggleLayerManage() { S.listManage = !S.listManage; renderLayerPanel(); }

  function saveHiddenList() {
    var ent = activeEntry(); if (!ent) return;
    var all = readStore(LISTHIDDEN_KEY);
    if (Object.keys(S.lockedNames).length) all[ent.id] = S.lockedNames; else delete all[ent.id];
    writeStore(LISTHIDDEN_KEY, all);
  }

  // Hide a layer from the list (and lock it at its current visibility) or restore it.
  function tpLayerListToggle(id) {
    var l = findLayer(id); if (!l) return;
    if (S.lockedNames[l.name]) delete S.lockedNames[l.name];
    else { S.lockedNames[l.name] = true; if (S.solo.id) clearSolo(); }
    saveHiddenList();
    renderLayerPanel();
  }

  // ── named layer presets (per map) ───────────────────────────────────────────
  function loadPresets(entryId) { var all = readStore(PRESETS_KEY); return (all[entryId] && all[entryId].slice()) || []; }
  function savePresets(entryId, list) { var all = readStore(PRESETS_KEY); all[entryId] = list; writeStore(PRESETS_KEY, all); }

  function tpPresetSave() {
    var ent = activeEntry(); if (!ent) return;
    var groups = S.layers.filter(function (l) { return l.type === "group"; });
    if (!groups.length) return;
    var p = (typeof cxPrompt === "function")
      ? cxPrompt("Save the current layer visibility as a preset:", "", { title: "Save layer preset", ok: "Save" })
      : Promise.resolve(window.prompt("Preset name:"));
    p.then(function (name) {
      if (name == null) return;
      name = String(name).trim();
      if (!name) return;
      var list = loadPresets(ent.id).filter(function (x) { return x.name !== name; });
      var lay = {};
      groups.forEach(function (l) { lay[l.name] = layerIsVisible(l); });
      list.push({ name: name, layers: lay });
      savePresets(ent.id, list);
      renderLayerPanel();
      notify('Saved layer preset "' + name + '".');
    });
  }

  function tpPresetApply(name) {
    if (!name) return;
    var ent = activeEntry(); if (!ent) return;
    var preset = loadPresets(ent.id).filter(function (x) { return x.name === name; })[0];
    if (!preset) return;
    clearSolo();
    S.layers.forEach(function (l) {
      if (l.type === "group" && !isLocked(l) && Object.prototype.hasOwnProperty.call(preset.layers, l.name)) {
        setLayerVisible(l, !!preset.layers[l.name]);
      }
    });
    saveLayerState();
    renderLayerRows();
    if (S.docKind !== "svg") renderSlice();
  }

  function tpPresetDelete() {
    var ent = activeEntry(); if (!ent) return;
    var sel = el("tp-preset"); var name = sel && sel.value;
    if (!name) { notify("Pick a preset to delete.", "error"); return; }
    savePresets(ent.id, loadPresets(ent.id).filter(function (x) { return x.name !== name; }));
    renderLayerPanel();
    notify('Deleted preset "' + name + '".');
  }

  // ── find on map (text search) ───────────────────────────────────────────────
  function tpToggleSearch() {
    if (!hasDoc()) return;
    S.search.open = !S.search.open;
    var bar = el("tp-search");
    if (bar) bar.hidden = !S.search.open;
    updateToolbar();
    if (S.search.open) {
      ensureSearchIndex();
      var inp = el("tp-search-input");
      if (inp) { inp.value = S.search.query || ""; setTimeout(function () { inp.focus(); inp.select(); }, 30); }
    } else {
      clearSearchHit();
    }
  }

  function ensureSearchIndex() {
    if (S.search.index) return Promise.resolve(S.search.index);
    if (S.docKind === "svg") { S.search.index = buildSvgIndex(); return Promise.resolve(S.search.index); }
    return buildPdfIndex().then(function (ix) { S.search.index = ix; return ix; });
  }

  function buildSvgIndex() {
    var out = [];
    if (!S.svgEl) return out;
    var nodes = S.svgEl.querySelectorAll("text, tspan");
    for (var i = 0; i < nodes.length; i++) {
      var s = (nodes[i].textContent || "").trim();
      if (s) out.push({ text: s, el: nodes[i] });
    }
    return out;
  }

  function buildPdfIndex() {
    var out = [];
    if (!S.pdfDoc) return Promise.resolve(out);
    var chain = Promise.resolve();
    var _loop = function (p) {
      chain = chain.then(function () { return S.pdfDoc.getPage(p); }).then(function (page) {
        var vp = page.getViewport({ scale: 1, rotation: 0 });
        return page.getTextContent().then(function (tc) {
          tc.items.forEach(function (it) {
            if (!it.str || !it.str.trim()) return;
            var tr = it.transform, pt = vp.convertToViewportPoint(tr[4], tr[5]);
            var h = it.height || Math.abs(tr[3]) || 10, w = it.width || 0;
            out.push({ text: it.str, page: p, x: pt[0], y: pt[1] - h, w: w, h: h });
          });
        });
      });
    };
    for (var p = 1; p <= S.numPages; p++) _loop(p);
    return chain.then(function () { return out; });
  }

  function tpSearchInput(q) {
    S.search.query = q;
    ensureSearchIndex().then(function (ix) {
      var qq = (q || "").trim().toLowerCase();
      S.search.matches = qq ? ix.filter(function (it) { return it.text.toLowerCase().indexOf(qq) >= 0; }) : [];
      S.search.idx = 0;
      updateSearchCount();
      if (S.search.matches.length) tpSearchGoTo(0);
      else clearSearchHit();
    });
  }

  function tpSearchKey(e) {
    if (e.key === "Enter") { e.preventDefault(); tpSearchStep(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); tpToggleSearch(); }
  }

  function tpSearchStep(dir) {
    if (!S.search.matches.length) return;
    tpSearchGoTo(S.search.idx + dir);
  }

  function hitBBox(hit) {
    if (S.docKind === "svg") {
      try { var b = hit.el.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }
      catch (e) { return null; }
    }
    return { x: hit.x, y: hit.y, w: hit.w || hit.h, h: hit.h };
  }

  function tpSearchGoTo(i) {
    var m = S.search.matches;
    if (!m.length) return;
    S.search.idx = ((i % m.length) + m.length) % m.length;
    var hit = m[S.search.idx];
    var bbox = hitBBox(hit);
    updateSearchCount();
    if (!bbox) return;
    var body = el("tp-body");
    var vw = body.clientWidth, vh = body.clientHeight;
    // zoom in if the match would be too small to read at the current scale
    var sc = S.scale;
    if (bbox.h * sc < 26) sc = clamp((Math.min(vw, vh) / 7) / Math.max(bbox.h, 1), sc, MAX_SCALE);
    S.mode = "custom"; S.scale = clamp(sc, MIN_SCALE, MAX_SCALE);
    var cx = (bbox.x + bbox.w / 2) * S.scale, cy = (bbox.y + bbox.h / 2) * S.scale;
    S._pendingScroll = { sl: cx - vw / 2, st: cy - vh / 2 };
    S.search.curBBox = bbox;
    if (S.docKind !== "svg" && hit.page && hit.page !== S.pageNum) { S.pageNum = hit.page; renderPage(); }
    else relayoutAndRender(null, false);
    positionSearchHit(bbox);
  }

  function positionSearchHit(bbox, pulse) {
    var hit = el("tp-search-hit");
    if (!hit || !bbox) return;
    hit.style.display = "block";
    hit.style.left = (bbox.x * S.scale) + "px";
    hit.style.top = (bbox.y * S.scale) + "px";
    hit.style.width = Math.max(10, bbox.w * S.scale) + "px";
    hit.style.height = Math.max(10, bbox.h * S.scale) + "px";
    if (pulse !== false) { hit.classList.remove("tp-pulse"); void hit.offsetWidth; hit.classList.add("tp-pulse"); }
  }

  function clearSearchHit() {
    if (S.search) S.search.curBBox = null;
    var hit = el("tp-search-hit");
    if (hit) hit.style.display = "none";
  }

  function updateSearchCount() {
    var c = el("tp-search-count");
    if (!c) return;
    var m = S.search.matches;
    c.textContent = (S.search.query || "").trim()
      ? (m.length ? (S.search.idx + 1) + " / " + m.length : "0 / 0")
      : "";
  }

  // ── markup (annotations) ────────────────────────────────────────────────────
  var MK_COLORS = ["#e60012", "#f59e0b", "#0d7a4f", "#1d4eaf", "#111827", "#ffffff"];

  // Unrotated page size in user units (markup is stored unrotated and rotated
  // for display via the same transform the content uses).
  function baseSizeUnrot() {
    if (S.docKind === "svg") return { w: S.svgBaseW || 1, h: S.svgBaseH || 1 };
    if (S.page) { var vp = S.page.getViewport({ scale: 1, rotation: 0 }); return { w: vp.width, h: vp.height }; }
    return { w: 1, h: 1 };
  }
  function mkRotTransform(sw, sh) {
    if (S.rotation === 90) return "translate(" + sh + "px,0) rotate(90deg)";
    if (S.rotation === 180) return "translate(" + sw + "px," + sh + "px) rotate(180deg)";
    if (S.rotation === 270) return "translate(0," + sw + "px) rotate(270deg)";
    return "none";
  }

  // Size + place the markup overlay so it tracks the content at any zoom/pan/rotation.
  function sizeMarkup() {
    var mk = S.markupEl; if (!mk) return;
    var bu = baseSizeUnrot();
    var sw = bu.w * S.scale, sh = bu.h * S.scale;
    mk.setAttribute("viewBox", "0 0 " + bu.w + " " + bu.h);
    mk.setAttribute("width", sw); mk.setAttribute("height", sh);
    mk.style.width = sw + "px"; mk.style.height = sh + "px";
    mk.style.transformOrigin = "0 0";
    mk.style.transform = mkRotTransform(sw, sh);
    mk.style.display = (S.markup.visible && (S.markup.shapes.length || S.markup.on)) ? "block" : "none";
    mk.style.pointerEvents = "none";   // render-only; input is captured on the body
    var body = el("tp-body");
    if (body) {
      body.classList.toggle("tp-mk-draw", S.markup.on && S.markup.tool !== "text");
      body.classList.toggle("tp-mk-text", S.markup.on && S.markup.tool === "text");
    }
    if (S.markup._dirty) { renderMarkupShapes(); S.markup._dirty = false; }
  }

  function ptsToPath(pts) {
    if (!pts || !pts.length) return "";
    var d = "M " + pts[0][0] + " " + pts[0][1];
    for (var i = 1; i < pts.length; i++) d += " L " + pts[i][0] + " " + pts[i][1];
    return d;
  }
  function mkSet(e, attrs) { for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function mkNode(tag) { return document.createElementNS(SVGNS, tag); }

  function shapeToEl(s) {
    if (s.type === "pen" || s.type === "highlight") {
      return mkSet(mkNode("path"), {
        d: ptsToPath(s.points), fill: "none", stroke: s.color,
        "stroke-width": s.type === "highlight" ? 12 : 3,
        "stroke-linecap": "round", "stroke-linejoin": "round",
        "vector-effect": "non-scaling-stroke",
        "stroke-opacity": s.type === "highlight" ? 0.35 : 1,
      });
    }
    if (s.type === "rect") {
      return mkSet(mkNode("rect"), {
        x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2),
        width: Math.abs(s.x2 - s.x1), height: Math.abs(s.y2 - s.y1),
        fill: "none", stroke: s.color, "stroke-width": 3, "vector-effect": "non-scaling-stroke",
      });
    }
    if (s.type === "arrow") {
      var g = mkNode("g");
      g.appendChild(mkSet(mkNode("line"), { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: s.color, "stroke-width": 3, "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
      var ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      var bu = baseSizeUnrot(), hl = Math.max(bu.w, bu.h) * 0.018;
      var a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
      g.appendChild(mkSet(mkNode("path"), {
        d: "M " + s.x2 + " " + s.y2 + " L " + (s.x2 + hl * Math.cos(a1)) + " " + (s.y2 + hl * Math.sin(a1)) +
           " L " + (s.x2 + hl * Math.cos(a2)) + " " + (s.y2 + hl * Math.sin(a2)) + " Z",
        fill: s.color,
      }));
      return g;
    }
    if (s.type === "text") {
      var bu2 = baseSizeUnrot();
      var t = mkSet(mkNode("text"), {
        x: s.x, y: s.y, fill: s.color, "font-size": s.size || Math.max(bu2.w, bu2.h) * 0.022,
        "font-family": "Inter, sans-serif", "font-weight": "600", "paint-order": "stroke",
        stroke: "#fff", "stroke-width": (s.size || Math.max(bu2.w, bu2.h) * 0.022) * 0.12, "stroke-linejoin": "round",
      });
      t.textContent = s.text;
      return t;
    }
    return null;
  }

  function renderMarkupShapes() {
    var mk = S.markupEl; if (!mk) return;
    while (mk.firstChild) mk.removeChild(mk.firstChild);
    S.markup.shapes.forEach(function (s) { var e = shapeToEl(s); if (e) mk.appendChild(e); });
  }

  function clientToPage(cx, cy) {
    var mk = S.markupEl; if (!mk || !mk.getScreenCTM) return null;
    var m = mk.getScreenCTM(); if (!m) return null;
    try { var pt = new DOMPoint(cx, cy).matrixTransform(m.inverse()); return { x: pt.x, y: pt.y }; }
    catch (e) { return null; }
  }

  // Input is captured on the body (reliable hit-testing) and mapped into page
  // units via the overlay's CTM; the overlay itself is render-only.
  function bindMarkup() {
    var body = el("tp-body"); if (!body) return;
    function refreshPreview() {
      var mk = S.markupEl;
      if (S.markup._preview && S.markup._preview.parentNode) mk.removeChild(S.markup._preview);
      S.markup._preview = shapeToEl(S.markup._draw);
      if (S.markup._preview) mk.appendChild(S.markup._preview);
    }
    function move(e) {
      var s = S.markup._draw; if (!s) return;
      var pt = clientToPage(e.clientX, e.clientY); if (!pt) return;
      if (s.type === "pen" || s.type === "highlight") s.points.push([pt.x, pt.y]);
      else { s.x2 = pt.x; s.y2 = pt.y; }
      refreshPreview();
      e.preventDefault();
    }
    function up() {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      var s = S.markup._draw; if (!s) return;
      S.markup._draw = null;
      var mk = S.markupEl;
      if (S.markup._preview && S.markup._preview.parentNode) mk.removeChild(S.markup._preview);
      S.markup._preview = null;
      var ok = (s.type === "pen" || s.type === "highlight") ? s.points.length > 1 : (Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1)) > 2;
      if (ok) addShape(s);
    }
    body.addEventListener("pointerdown", function (e) {
      if (!S.markup.on || !S.markup.visible) return;
      if (e.button != null && e.button !== 0) return;
      var pt = clientToPage(e.clientX, e.clientY); if (!pt) return;
      var tool = S.markup.tool, color = S.markup.color;
      if (tool === "text") {
        var pr = (typeof cxPrompt === "function")
          ? cxPrompt("Note text:", "", { title: "Text annotation", ok: "Add" })
          : Promise.resolve(window.prompt("Note text:"));
        pr.then(function (txt) { if (txt == null) return; txt = String(txt).trim(); if (txt) addShape({ type: "text", x: pt.x, y: pt.y, text: txt, color: color }); });
        e.preventDefault(); return;
      }
      S.markup._draw = (tool === "pen" || tool === "highlight")
        ? { type: tool, color: color, points: [[pt.x, pt.y]] }
        : { type: tool, color: color, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      refreshPreview();
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      e.preventDefault();
    });
  }

  function addShape(s) { S.markup.shapes.push(s); renderMarkupShapes(); saveMarkup(); }

  function loadMarkupForEntry() {
    var ent = activeEntry();
    var all = readStore(MARKUP_KEY);
    S.markup.shapes = (ent && all[ent.id] && all[ent.id].slice()) || [];
    S.markup._dirty = true;
  }
  function saveMarkup() {
    var ent = activeEntry(); if (!ent) return;
    var all = readStore(MARKUP_KEY);
    if (S.markup.shapes.length) all[ent.id] = S.markup.shapes; else delete all[ent.id];
    writeStore(MARKUP_KEY, all);
  }

  function tpToggleMarkup() {
    if (!hasDoc()) return;
    S.markup.on = !S.markup.on;
    if (S.markup.on) { S.markup.visible = true; if (S.search.open) tpToggleSearch(); }
    var bar = el("tp-markupbar"); if (bar) bar.hidden = !S.markup.on;
    renderMkColors(); updateMkTools();
    sizeMarkup();
    updateToolbar();
  }
  function tpMkTool(t) { S.markup.tool = t; updateMkTools(); sizeMarkup(); }
  function tpMkColor(c) { S.markup.color = c; renderMkColors(); }
  function tpMkUndo() { if (S.markup.shapes.length) { S.markup.shapes.pop(); renderMarkupShapes(); saveMarkup(); } }
  function tpMkClear() {
    if (!S.markup.shapes.length) return;
    var ask = (typeof cxConfirm === "function")
      ? cxConfirm("Clear all annotations on this map?", { title: "Clear annotations", ok: "Clear", danger: true })
      : Promise.resolve(window.confirm("Clear all annotations on this map?"));
    ask.then(function (ok) { if (!ok) return; S.markup.shapes = []; renderMarkupShapes(); saveMarkup(); });
  }
  function tpMkToggleVisible() {
    S.markup.visible = !S.markup.visible;
    sizeMarkup();
    updateMkTools();
  }
  function renderMkColors() {
    var host = el("tp-mk-colors"); if (!host) return;
    host.innerHTML = MK_COLORS.map(function (c) {
      return '<button type="button" class="tp-mk-color' + (c === S.markup.color ? " active" : "") +
             '" style="background:' + c + '" aria-label="Colour ' + c + '" onclick="tpMkColor(\'' + c + "')\"></button>";
    }).join("");
  }
  function updateMkTools() {
    var bar = el("tp-markupbar"); if (!bar) return;
    bar.querySelectorAll(".tp-mk-tool").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tool") === S.markup.tool);
    });
    var vb = el("tp-mk-vis");
    if (vb) { vb.classList.toggle("tp-primary", !S.markup.visible); vb.title = S.markup.visible ? "Hide annotations" : "Show annotations"; }
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
    S.pdfDoc = null; S.page = null;
    detachSvg();
    S.layers = []; S.layersOpen = false;
    renderLayerPanel();
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
    var wasLoaded = hasDoc();
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
    // A bigger/smaller window changes the fit; re-fit/repaint for the new size
    // without losing the user's place (the ResizeObserver also covers this).
    if (hasDoc()) relayoutAndRender(null, false);
  }

  function tpSelectSection(id) {
    if (id === S.activeId) return;
    saveViewNow();            // remember where we were on the current map
    S.activeId = id;
    loadActive();
  }

  function tpPrevPage() { if (S.pdfDoc && S.pageNum > 1) { S.pageNum--; renderPage(); } }
  function tpNextPage() { if (S.pdfDoc && S.pageNum < S.numPages) { S.pageNum++; renderPage(); } }
  function tpZoomIn() { zoomBy(1.25); }
  function tpZoomOut() { zoomBy(1 / 1.25); }
  function tpFitWidth() { S.mode = "fit-width"; renderPage(); }
  function tpFitPage() { S.mode = "fit-page"; renderPage(); }
  function tpActualSize() { S.mode = "custom"; S.scale = 1; renderPage(centerAnchor()); }
  function tpRotate() { S.rotation = (S.rotation + 90) % 360; renderPage(); }

  // ── catalog management (user-managed) ───────────────────────────────────────
  function tpAddMap() {
    ensureMounted();
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/pdf,.pdf,image/svg+xml,.svg";
    inp.style.display = "none";
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (!file) return;
      var isSvg = /\.svg$/i.test(file.name) || file.type === "image/svg+xml";
      var isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      if (!isSvg && !isPdf) { notify("Please choose a PDF or SVG file.", "error"); return; }
      var id = "upload-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      var label = file.name.replace(/\.(pdf|svg)$/i, "");
      idbPut(id, file, file.name).then(function () {
        S.catalog.push({ id: id, label: label, kind: "upload", format: isSvg ? "svg" : "pdf",
                         fileName: file.name, note: isSvg ? "Uploaded SVG" : "Uploaded PDF" });
        S.activeId = id;
        persistCatalog();
        renderSectionSelect();
        if (!S.open) tpOpen(id); else loadActive();
        notify('Added "' + label + '" to the track plan list.');
      }).catch(function () { notify("Could not store this file on the device.", "error"); });
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
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // don't shadow app/browser shortcuts
      var tag = (e.target && e.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.key === "ArrowLeft") { tpPrevPage(); }
      else if (e.key === "ArrowRight") { tpNextPage(); }
      else if (e.key === "+" || e.key === "=") { tpZoomIn(); }
      else if (e.key === "-" || e.key === "_") { tpZoomOut(); }
      else if (e.key === "0") { tpFitWidth(); }
      else if (e.key === "1") { tpActualSize(); }
      else if (e.key === "9") { tpFitPage(); }
      else if (e.key === "r" || e.key === "R") { tpRotate(); }
      else if (e.key === "/" || ((e.key === "f" || e.key === "F") && !S.search.open)) { if (!S.search.open) tpToggleSearch(); }
      else return;
      e.preventDefault();
    });
  }

  // Scroll-wheel zooms toward the cursor (map-style). Coalesced to one render
  // per animation frame so a fast scroll stays smooth.
  function bindWheelZoom() {
    var body = el("tp-body");
    if (!body) return;
    var pendingAnchor = null;
    body.addEventListener("wheel", function (e) {
      if (!hasDoc()) return;
      e.preventDefault();
      var step = Math.exp(-e.deltaY * 0.0015);      // smooth, proportional to wheel delta
      S.mode = "custom";
      S.scale = clamp(S.scale * step, MIN_SCALE, MAX_SCALE);
      pendingAnchor = { cx: e.clientX, cy: e.clientY };
      updateToolbar();
      if (S._wheelRaf) return;
      S._wheelRaf = requestAnimationFrame(function () { S._wheelRaf = 0; relayoutAndRender(pendingAnchor, false); });
    }, { passive: false });
  }

  // Click-and-drag to pan while zoomed; double-click to zoom in at the point;
  // two-finger pinch to zoom and one-finger drag to pan on touch devices.
  function bindPan() {
    var body = el("tp-body");
    if (!body) return;
    var panning = false, sx = 0, sy = 0, sl = 0, st = 0;

    function startPan(x, y) {
      panning = true; sx = x; sy = y; sl = body.scrollLeft; st = body.scrollTop;
      body.classList.add("tp-panning");
    }
    function mm(e) {
      if (!panning) return;
      body.scrollLeft = sl - (e.clientX - sx);
      body.scrollTop = st - (e.clientY - sy);
    }
    function mu() {
      panning = false; body.classList.remove("tp-panning");
      window.removeEventListener("mousemove", mm, true);
      window.removeEventListener("mouseup", mu, true);
    }
    body.addEventListener("mousedown", function (e) {
      if (S.markup.on) return;          // in markup mode a drag draws, not pans
      if (e.button !== 0 || !body.classList.contains("tp-pannable")) return;
      startPan(e.clientX, e.clientY);
      window.addEventListener("mousemove", mm, true);
      window.addEventListener("mouseup", mu, true);
      e.preventDefault();
    });
    body.addEventListener("dblclick", function (e) {
      if (!hasDoc() || S.markup.on) return;
      zoomBy(1.6, { cx: e.clientX, cy: e.clientY });
    });

    // touch: pinch-zoom + one-finger pan
    var pinch = null;
    function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
    body.addEventListener("touchstart", function (e) {
      if (!hasDoc() || (S.markup.on && e.touches.length === 1)) return;   // single-finger draws in markup mode
      if (e.touches.length === 2) {
        pinch = { d: dist(e.touches), scale: S.scale,
                  cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                  cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
        e.preventDefault();
      } else if (e.touches.length === 1 && body.classList.contains("tp-pannable")) {
        startPan(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });
    body.addEventListener("touchmove", function (e) {
      if (pinch && e.touches.length === 2) {
        S.mode = "custom";
        S.scale = clamp(pinch.scale * (dist(e.touches) / pinch.d), MIN_SCALE, MAX_SCALE);
        updateToolbar();
        if (!S._wheelRaf) S._wheelRaf = requestAnimationFrame(function () { S._wheelRaf = 0; relayoutAndRender({ cx: pinch.cx, cy: pinch.cy }, false); });
        e.preventDefault();
      } else if (panning && e.touches.length === 1) {
        body.scrollLeft = sl - (e.touches[0].clientX - sx);
        body.scrollTop = st - (e.touches[0].clientY - sy);
        e.preventDefault();
      }
    }, { passive: false });
    body.addEventListener("touchend", function (e) {
      if (e.touches.length === 0) { panning = false; pinch = null; body.classList.remove("tp-panning"); }
      else if (e.touches.length === 1) { pinch = null; }
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
  window.tpFitWidth = tpFitWidth;
  window.tpFitPage = tpFitPage;
  window.tpActualSize = tpActualSize;
  window.tpRotate = tpRotate;
  window.tpToggleLayers = tpToggleLayers;
  window.tpSetLayer = tpSetLayer;
  window.tpAllLayers = tpAllLayers;
  window.tpSoloLayer = tpSoloLayer;
  window.tpSetLayerOpacity = tpSetLayerOpacity;
  window.tpToggleOpacityMode = tpToggleOpacityMode;
  window.tpToggleLayerManage = tpToggleLayerManage;
  window.tpLayerListToggle = tpLayerListToggle;
  window.tpLayerFilter = tpLayerFilter;
  window.tpPresetSave = tpPresetSave;
  window.tpPresetApply = tpPresetApply;
  window.tpPresetDelete = tpPresetDelete;
  window.tpToggleSearch = tpToggleSearch;
  window.tpSearchInput = tpSearchInput;
  window.tpSearchKey = tpSearchKey;
  window.tpSearchStep = tpSearchStep;
  window.tpToggleMarkup = tpToggleMarkup;
  window.tpMkTool = tpMkTool;
  window.tpMkColor = tpMkColor;
  window.tpMkUndo = tpMkUndo;
  window.tpMkClear = tpMkClear;
  window.tpMkToggleVisible = tpMkToggleVisible;
  window.tpLayerInfo = tpLayerInfo;
  window.tpAddMap = tpAddMap;
  window.tpRenameCurrent = tpRenameCurrent;
  window.tpDeleteCurrent = tpDeleteCurrent;
})();
