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
    layers: [],             // [{type:'group'|'label', id?, name, depth, els?, visible?}]
    layersOpen: false,      // is the Layers panel showing?
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
        groups.forEach(function (l) { state[l.name] = layerIsVisible(l); });
        all[ent.id] = state;
      }
      localStorage.setItem(LAYERS_KEY, JSON.stringify(all));
    } catch (e) { /* quota / private mode — non-fatal */ }
  }
  function applySavedLayerState() {
    var ent = activeEntry(); if (!ent) return;
    var saved = loadSavedLayerState(ent.id); if (!saved) return;
    S.layers.forEach(function (l) {
      if (l.type === "group" && Object.prototype.hasOwnProperty.call(saved, l.name)) {
        setLayerVisible(l, !!saved[l.name]);
      }
    });
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
            "</div>" +
          "</div>" +
          // Overlays — siblings of the scrolling body so they stay pinned to the
          // viewport (not the zoomed content), and the body's wheel-zoom handler
          // never sees scrolls that happen over the layers panel.
          '<div class="tp-status" id="tp-status">Loading…</div>' +
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

    bindDrag();
    bindResize();
    bindKeys();
    bindWheelZoom();
    bindPan();
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
    S.ocConfig = null; S.layers = []; S.layersOpen = false;
    detachSvg();
    S.docKind = entryFormat(entry);
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
    } else if (reset) {
      body.scrollLeft = 0;
      body.scrollTop = 0;
    } else {
      body.scrollLeft = clamp(body.scrollLeft, 0, maxL);
      body.scrollTop = clamp(body.scrollTop, 0, maxT);
    }
    S._lastScale = S.scale;
    updatePanCursor();
    updateToolbar();
    paint();
  }

  function paint() { if (S.docKind === "svg") sizeSvg(); else renderSlice(); }

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
    var body = el("tp-body"), canvas = el("tp-canvas");
    if (!body || !canvas || !S.page) return;
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
    if (!S.page) return;
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

  function renderLayerPanel() {
    var panel = el("tp-layers"), list = el("tp-layers-list");
    if (!panel || !list) return;
    if (!S.layersOpen) { panel.hidden = true; return; }
    panel.hidden = false;
    list.innerHTML = S.layers.map(function (l) {
      var pad = "padding-left:" + (8 + l.depth * 14) + "px;";
      if (l.type === "label") return '<div class="tp-layer-label" style="' + pad + '">' + esc(l.name) + "</div>";
      var on = layerIsVisible(l);
      return '<label class="tp-layer-row" style="' + pad + '">' +
               '<input type="checkbox" ' + (on ? "checked" : "") +
               ' onchange="tpSetLayer(\'' + esc(l.id).replace(/'/g, "\\'") + "', this.checked)\">" +
               "<span>" + esc(l.name) + "</span>" +
             "</label>";
    }).join("");
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

  function tpSetLayer(id, visible) {
    var l = findLayer(id);
    if (!l) return;
    setLayerVisible(l, visible);
    saveLayerState();
    if (S.docKind !== "svg") renderSlice();   // SVG toggles the DOM directly — instant
  }

  function tpAllLayers(visible) {
    S.layers.forEach(function (l) { if (l.type === "group") setLayerVisible(l, visible); });
    saveLayerState();
    renderLayerPanel();
    if (S.docKind !== "svg") renderSlice();
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
      if (e.button !== 0 || !body.classList.contains("tp-pannable")) return;
      startPan(e.clientX, e.clientY);
      window.addEventListener("mousemove", mm, true);
      window.addEventListener("mouseup", mu, true);
      e.preventDefault();
    });
    body.addEventListener("dblclick", function (e) {
      if (!hasDoc()) return;
      zoomBy(1.6, { cx: e.clientX, cy: e.clientY });
    });

    // touch: pinch-zoom + one-finger pan
    var pinch = null;
    function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
    body.addEventListener("touchstart", function (e) {
      if (!hasDoc()) return;
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
  window.tpLayerInfo = tpLayerInfo;
  window.tpAddMap = tpAddMap;
  window.tpRenameCurrent = tpRenameCurrent;
  window.tpDeleteCurrent = tpDeleteCurrent;
})();
