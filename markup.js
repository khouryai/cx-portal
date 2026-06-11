/* =====================================================================
   CX MARKUP — universal PDF markup layer for cx-portal
   ---------------------------------------------------------------------
   A fully custom, dependency-free annotation engine that mounts as a
   transparent overlay on top of any pdf.js-rendered page <canvas>. The
   same engine powers BOTH modules that edit PDFs:

     • Forms / Test Data Sheets  (markup over filled AcroForm pages)
     • Drawings                  (markup over drawing sheets)

   It NEVER reads PDF bytes — the host module already rasterises pages
   with pdf.js (loaded in index.html). The engine owns: tools, the
   editable annotation model, history (undo/redo), serialise/reopen, and
   flatten-on-export (raster preview + vector replay into pdf-lib).

   Conventions (see CLAUDE.md):
     • Light UI only — semantic tokens (--surface/--text/--border …).
     • Icons via the global icon() helper; glyphs live in ICONS (icons.js).
     • No emoji-as-icons, no new fonts/CDN, no dark mode.

   Public surface (window.CXMarkup):
     CXMarkup.STAMPS                         -> [{k,c}]
     CXMarkup.attach(hostCanvas, opts)       -> engine   (single page)
     CXMarkup.buildToolbar(container, engine, opts) -> {el, destroy}
     CXMarkup.flattenIntoPdfPage(annos, page, opts) -> draws vector markup
     CXMarkup.CXMarkupEngine                 -> class (advanced use)
   ===================================================================== */
(function (global) {
"use strict";

/* ---- icon() fallback (engine must work even if app.js load order
   changes); prefers the real project helper when present) ------------- */
function ic(name, opts) {
  if (typeof global.icon === "function") return global.icon(name, opts);
  return "";
}

/* ---- TEMPORARY on-device diagnostic. Flip DEBUG to false to remove the
   on-screen readout once markup is verified working on iPad/iPhone. ---- */
let DEBUG = false;
const BUILD = "resize-3";
function _hud(msg) {
  if (!DEBUG) return;
  let el = document.getElementById("cx-markup-hud");
  if (!el) {
    el = document.createElement("div");
    el.id = "cx-markup-hud";
    el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:92vw;" +
      "background:rgba(15,23,42,.93);color:#fff;font:600 11px/1.45 ui-monospace,monospace;" +
      "padding:8px 10px;border-radius:8px;white-space:pre-wrap;pointer-events:none;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.4);";
    document.body.appendChild(el);
  }
  el.textContent = "CXMarkup " + BUILD + "\n" + msg;
}

const STAMPS = [
  { k: "PASS",       c: "#1f9d57" },
  { k: "FAIL",       c: "#dc2626" },
  { k: "N/A",        c: "#6b7280" },
  { k: "WITNESSED",  c: "#2563eb" },
  { k: "HOLD",       c: "#d97706" },
  { k: "AS-BUILT",   c: "#7c3aed" },
  { k: "SUPERSEDED", c: "#c2410c" }
];

const SCHEMA = "cx-markup/v1";
const HISTORY_CAP = 80;            // bound undo memory growth
const STAMP_FONT  = '"IBM Plex Mono", ui-monospace, monospace';
const TEXT_FONT   = '"IBM Plex Sans", system-ui, sans-serif';

/* Tool palette shared by every host toolbar. `icon` is a key in the
   project ICONS map (icons.js). */
const TOOLS = [
  { id: "select",  label: "Select",     icon: "cursor" },
  { id: "text",    label: "Text",       icon: "type" },
  { id: "pen",     label: "Pen",        icon: "edit" },
  { id: "high",    label: "Highlight",  icon: "highlighter" },
  { id: "redline", label: "Redline",    icon: "redline" },
  { id: "rect",    label: "Box",        icon: "square" },
  { id: "ellipse", label: "Oval",       icon: "circle" },
  { id: "arrow",   label: "Arrow",      icon: "arrow-ur" },
  { id: "line",    label: "Line",       icon: "line" },
  { id: "stamp",   label: "Stamp",      icon: "stamp" },
  { id: "erase",   label: "Delete",     icon: "eraser" }
];

/* =====================================================================
   ENGINE
   ===================================================================== */
class CXMarkupEngine {
  /**
   * @param {HTMLCanvasElement} overlay transparent canvas, on top of host
   * @param {object} opts
   *   host        host pdf.js <canvas> (for flatten compositing) — optional
   *   pageW,pageH intrinsic page size (pdf.js scale-1 viewport) in CSS px
   *   engineer    initials/name baked into stamps
   *   onChange    (state) => void  {count,canUndo,canRedo,dirty}
   *   readOnly    boolean
   */
  constructor(overlay, opts = {}) {
    this.cv  = overlay;
    this.ctx = overlay.getContext("2d");
    this.wrap = overlay.parentNode;        // must be position:relative
    this.host = opts.host || null;

    this.engineer = opts.engineer || "Engineer";
    this.onChange = opts.onChange || (() => {});
    this.readOnly = !!opts.readOnly;

    this.pageW = opts.pageW || (this.host ? this.host.clientWidth : 850) || 850;
    this.pageH = opts.pageH || (this.host ? this.host.clientHeight : 1100) || 1100;
    this.scale = 1;

    this.tool  = "select";
    this.color = "#dc2626";
    this.width = 3;
    this.stampKind = "PASS";

    this.annotations = [];
    this.selected = null;
    this.draft = null;
    this.dragOff = null;
    this.rsz = null;            // active resize-drag state (NOT the resize() method)
    this.history = [];
    this.hp = -1;
    this._savedSnapshot = "[]";

    this._bind();
    this.resize();
    this._commit(true);
  }

  /* ---------- sizing — match the host canvas's displayed size --------- */
  resize() {
    let dispW = (this.host ? this.host.clientWidth : this.wrap.clientWidth);
    if (!dispW && this.host) dispW = this.host.getBoundingClientRect().width;
    if (!dispW) dispW = (this.wrap && this.wrap.getBoundingClientRect().width) || this.pageW;
    this.scale = (dispW / this.pageW) || 1;
    const dispH = this.pageH * this.scale;
    const dpr = global.devicePixelRatio || 1;
    this.cv.width  = Math.round(this.pageW * this.scale * dpr);
    this.cv.height = Math.round(this.pageH * this.scale * dpr);
    this.cv.style.width  = (this.pageW * this.scale) + "px";
    this.cv.style.height = dispH + "px";
    this.ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, 0, 0);
    this.redraw();
  }
  setPageSize(w, h) { this.pageW = w; this.pageH = h; this.resize(); }

  /* ---------- tool / style ---------- */
  setTool(id) { this.tool = id; if (id !== "select") this.selected = null; this.cv.style.cursor = id === "select" ? "default" : "crosshair"; this.redraw(); }
  setColor(c) { this.color = c; this._applyToSelected(); }
  setWidth(w) { this.width = +w || 3; this._applyToSelected(); }
  setStampKind(k) { this.stampKind = k; }
  static stamps() { return STAMPS.slice(); }

  /* ---------- editable model ---------- */
  getAnnotations()   { return JSON.parse(JSON.stringify(this.annotations)); }
  loadAnnotations(a) { this.annotations = Array.isArray(a) ? a : []; this.selected = null; this._commit(true); }
  isEmpty()          { return this.annotations.length === 0; }
  isDirty()          { return JSON.stringify(this.annotations) !== this._savedSnapshot; }
  markSaved()        { this._savedSnapshot = JSON.stringify(this.annotations); this._emit(); }

  toJSON() {
    return {
      schema: SCHEMA,
      engineer: this.engineer,
      savedAt: new Date().toISOString(),
      page: { w: this.pageW, h: this.pageH },
      annotations: this.getAnnotations()
    };
  }
  fromJSON(obj) {
    const a = (obj && obj.annotations) || (Array.isArray(obj) ? obj : []);
    this.loadAnnotations(a);
    this.markSaved();
  }

  /* ---------- flatten: raster preview (page + markups) --------------- */
  // Returns a PNG dataURL at the host canvas's native resolution. Host
  // hands this to print or to pdf-lib as an embedded image. For vector
  // output prefer CXMarkup.flattenIntoPdfPage().
  exportFlattened() {
    this.selected = null; this.draft = null;
    const rw = this.host ? this.host.width  : Math.round(this.pageW);
    const rh = this.host ? this.host.height : Math.round(this.pageH);
    const off = document.createElement("canvas");
    off.width = rw; off.height = rh;
    const o = off.getContext("2d");
    if (this.host) o.drawImage(this.host, 0, 0, rw, rh);
    else { o.fillStyle = "#fff"; o.fillRect(0, 0, rw, rh); }
    // Draw markups scaled from intrinsic page units to the raster size.
    const k = rw / this.pageW;
    const real = this.ctx;
    this.ctx = o;
    o.save(); o.setTransform(k, 0, 0, k, 0, 0);
    for (const a of this.annotations) this._drawAnno(a);
    o.restore();
    this.ctx = real;
    this.redraw();
    return off.toDataURL("image/png");
  }

  /* ---------- history ---------- */
  undo() { if (this.hp > 0) { this.hp--; this.annotations = JSON.parse(this.history[this.hp]); this.selected = null; this.redraw(); this._emit(); } }
  redo() { if (this.hp < this.history.length - 1) { this.hp++; this.annotations = JSON.parse(this.history[this.hp]); this.redraw(); this._emit(); } }
  canUndo() { return this.hp > 0; }
  canRedo() { return this.hp < this.history.length - 1; }

  _commit(silentClean) {
    this.history = this.history.slice(0, this.hp + 1);
    this.history.push(JSON.stringify(this.annotations));
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.hp = this.history.length - 1;
    if (silentClean) this._savedSnapshot = this.history[this.hp];
    this.redraw(); this._emit();
  }
  _emit() {
    if (DEBUG) _hud("items=" + this.annotations.length + "  tool=" + this.tool +
                    "  scale=" + this.scale.toFixed(2) + "  size=" + this.cv.style.width + " x " + this.cv.style.height);
    // A host onChange callback must NEVER be able to break the engine — e.g. a
    // callback that references a not-yet-initialized variable would otherwise
    // throw out of the constructor and abort the whole mount. Swallow its errors.
    try {
      this.onChange({
        count: this.annotations.length,
        canUndo: this.canUndo(),
        canRedo: this.canRedo(),
        dirty: this.isDirty()
      });
    } catch (e) {
      console.warn("[CXMarkup onChange]", e && e.message);
    }
  }

  /* ===================== RENDER ===================== */
  redraw() {
    const ctx = this.ctx;
    // Overlay is transparent — the host canvas shows the page beneath.
    ctx.clearRect(0, 0, this.pageW, this.pageH);
    for (const a of this.annotations) this._drawAnno(a);
    if (this.draft) this._drawAnno(this.draft);
    if (this.selected && !this.readOnly) this._drawSelection(this.selected);
  }

  _drawAnno(a) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = a.color; ctx.fillStyle = a.color; ctx.lineWidth = a.width || 3;
    switch (a.type) {
      case "pen":
        ctx.beginPath(); a.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); break;
      case "high":
        ctx.globalAlpha = .32;
        ctx.fillRect(Math.min(a.x, a.x2), Math.min(a.y, a.y2) - 2,
          Math.abs(a.x2 - a.x), Math.max(14, Math.abs(a.y2 - a.y))); break;
      case "rect":
        ctx.strokeRect(a.x, a.y, a.x2 - a.x, a.y2 - a.y); break;
      case "ellipse": {
        const cx = (a.x + a.x2) / 2, cy = (a.y + a.y2) / 2,
              rx = Math.abs(a.x2 - a.x) / 2, ry = Math.abs(a.y2 - a.y) / 2;
        ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke(); break; }
      case "line":
      case "arrow": {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        if (a.type === "arrow") {
          const ang = Math.atan2(a.y2 - a.y, a.x2 - a.x), h = 10 + (a.width || 3) * 1.5;
          ctx.beginPath(); ctx.moveTo(a.x2, a.y2);
          ctx.lineTo(a.x2 - h * Math.cos(ang - .4), a.y2 - h * Math.sin(ang - .4));
          ctx.moveTo(a.x2, a.y2);
          ctx.lineTo(a.x2 - h * Math.cos(ang + .4), a.y2 - h * Math.sin(ang + .4)); ctx.stroke();
        } break; }
      case "redline":
        ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x2, a.y); ctx.stroke();
        if (a.text) { ctx.fillStyle = "#dc2626"; ctx.font = '600 13px ' + TEXT_FONT; ctx.fillText(a.text, a.x, a.y - 7); }
        break;
      case "text":
        ctx.fillStyle = a.color; ctx.font = `500 ${a.size || 16}px ${TEXT_FONT}`;
        a.text.split("\n").forEach((ln, i) => ctx.fillText(ln, a.x, a.y + (a.size || 16) + i * (a.size || 16) * 1.25));
        break;
      case "stamp": this._drawStamp(a); break;
    }
    ctx.restore();
  }

  _stampMetrics(a) {
    const ctx = this.ctx;
    const s = a.scale || 1;
    ctx.save(); ctx.font = '700 20px ' + STAMP_FONT;
    const w = Math.max(96, ctx.measureText(a.kind).width + 28), h = 46;
    ctx.restore();
    return { w: w * s, h: h * s };
  }
  _drawStamp(a) {
    const ctx = this.ctx;
    const def = STAMPS.find(s => s.k === a.kind) || STAMPS[0];
    const sc = a.scale || 1;
    const m = this._stampMetrics(a);
    ctx.save();
    ctx.translate(a.x, a.y);            // NO rotation — flat / horizontal
    ctx.strokeStyle = def.c; ctx.lineWidth = 3 * sc; ctx.globalAlpha = .92;
    this._roundRect(-m.w / 2, -m.h / 2, m.w, m.h, 8 * sc); ctx.stroke();
    ctx.fillStyle = def.c; ctx.textAlign = "center";
    ctx.font = '700 ' + (20 * sc) + 'px ' + STAMP_FONT;
    ctx.fillText(a.kind, 0, -2 * sc);
    ctx.font = '500 ' + (9 * sc) + 'px ' + STAMP_FONT;
    ctx.fillText((a.who || "") + "  " + (a.ts || ""), 0, 15 * sc);
    ctx.restore();
  }
  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  _bounds(a) {
    if (a.type === "pen") { const xs = a.pts.map(p => p.x), ys = a.pts.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
    if (a.type === "text") { const lines = a.text.split("\n"); const w = Math.max(...lines.map(l => l.length)) * (a.size || 16) * .55;
      return { x: a.x, y: a.y, w: Math.max(40, w), h: lines.length * (a.size || 16) * 1.3 }; }
    if (a.type === "stamp") { const m = this._stampMetrics(a); return { x: a.x - m.w / 2, y: a.y - m.h / 2, w: m.w, h: m.h }; }
    if (a.type === "redline") return { x: Math.min(a.x, a.x2), y: a.y - 22, w: Math.abs(a.x2 - a.x), h: 30 };
    return { x: Math.min(a.x, a.x2), y: Math.min(a.y, a.y2), w: Math.abs(a.x2 - a.x), h: Math.abs(a.y2 - a.y) };
  }
  // Resize handles in intrinsic coords: endpoints for line/arrow, else corners.
  _handles(a) {
    if (a.type === "line" || a.type === "arrow")
      return [{ id: "p1", x: a.x, y: a.y }, { id: "p2", x: a.x2, y: a.y2 }];
    const b = this._bounds(a);
    return [
      { id: "nw", x: b.x,        y: b.y },
      { id: "ne", x: b.x + b.w,  y: b.y },
      { id: "sw", x: b.x,        y: b.y + b.h },
      { id: "se", x: b.x + b.w,  y: b.y + b.h }
    ];
  }
  _hitHandle(a, x, y) {
    if (!a) return null;
    const tol = 18 / this.scale;   // generous for touch
    return this._handles(a).find(h => Math.abs(x - h.x) <= tol && Math.abs(y - h.y) <= tol) || null;
  }
  _drawSelection(a) {
    const ctx = this.ctx, b = this._bounds(a), k = this.scale || 1;
    ctx.save();
    ctx.strokeStyle = "#2563eb"; ctx.fillStyle = "#fff";
    ctx.lineWidth = 1.5 / k; ctx.setLineDash([5 / k, 4 / k]);
    ctx.strokeRect(b.x - 6 / k, b.y - 6 / k, b.w + 12 / k, b.h + 12 / k);
    ctx.setLineDash([]);
    const hs = 6 / k;              // handle half-size, ~12px on screen
    ctx.lineWidth = 1.5 / k;
    for (const h of this._handles(a)) {
      ctx.beginPath(); ctx.rect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  _hit(x, y) {
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const b = this._bounds(this.annotations[i]);
      if (x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8) return this.annotations[i];
    } return null;
  }

  /* ===================== POINTER ===================== */
  _pt(e) { const r = this.cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale }; }
  _bind() {
    this._onDown = (e) => {
      if (this.readOnly) return;
      const p = this._pt(e), T = this.tool;
      if (DEBUG) {
        const r = this.cv.getBoundingClientRect();
        _hud("DOWN ok @ " + Math.round(p.x) + "," + Math.round(p.y) + "  tool=" + T +
             "\nscale=" + this.scale.toFixed(2) + "  css=" + this.cv.style.width + " x " + this.cv.style.height +
             "\nrect=" + Math.round(r.width) + " x " + Math.round(r.height) + "  ptr=" + e.pointerType +
             "  id=" + (this._dbgId || "?"));
        const c = this.ctx; c.save(); c.fillStyle = "rgba(220,38,38,.95)";
        c.beginPath(); c.arc(p.x, p.y, 7, 0, Math.PI * 2); c.fill(); c.restore();
      }
      // setPointerCapture throws on iOS Safari for touch pointers in some
      // contexts; never let it abort the draw handler.
      try { this.cv.setPointerCapture(e.pointerId); } catch (_) {}
      if (T === "select") {
        // If something is already selected, a tap on one of its handles starts a resize.
        if (this.selected) {
          const hnd = this._hitHandle(this.selected, p.x, p.y);
          if (hnd) {
            this.rsz = { handle: hnd.id, before: JSON.parse(JSON.stringify(this.selected)), ob: this._bounds(this.selected) };
            return;
          }
        }
        const h = this._hit(p.x, p.y); this.selected = h;
        if (h) { const b = this._bounds(h); this.dragOff = { dx: p.x - b.x, dy: p.y - b.y }; }
        this.redraw(); return;
      }
      if (T === "erase") { const h = this._hit(p.x, p.y); if (h) { this.annotations.splice(this.annotations.indexOf(h), 1); this._commit(); } return; }
      if (T === "text") { this._openText(p.x, p.y); return; }
      if (T === "stamp") {
        const now = new Date();
        this.annotations.push({ type: "stamp", kind: this.stampKind, x: p.x, y: p.y, who: this.engineer,
          ts: now.toLocaleDateString() + " " + now.toTimeString().slice(0, 5) });
        this._commit(); return;
      }
      if (T === "pen") { this.draft = { type: "pen", color: this.color, width: this.width, pts: [p] }; return; }
      const map = { high: "high", rect: "rect", ellipse: "ellipse", arrow: "arrow", line: "line", redline: "redline" };
      this.draft = { type: map[T] || "rect", color: this.color, width: this.width, x: p.x, y: p.y, x2: p.x, y2: p.y };
    };
    this._onMove = (e) => {
      if (this.readOnly) return;
      const p = this._pt(e);
      if (this.tool === "select" && this.rsz && this.selected) { this._applyResize(p.x, p.y); this.redraw(); return; }
      if (this.tool === "select" && this.dragOff && this.selected) { this._moveTo(this.selected, p.x - this.dragOff.dx, p.y - this.dragOff.dy); this.redraw(); return; }
      if (!this.draft) return;
      if (this.draft.type === "pen") this.draft.pts.push(p);
      else { this.draft.x2 = p.x; this.draft.y2 = p.y; }
      this.redraw();
    };
    this._onUp = () => {
      if (this.readOnly) return;
      if (this.tool === "select") {
        if (this.rsz) { this.rsz = null; this._commit(); return; }
        if (this.dragOff) this._commit();
        this.dragOff = null; return;
      }
      if (this.draft) {
        const d = this.draft;
        const tiny = d.type !== "pen" && Math.abs(d.x2 - d.x) < 4 && Math.abs(d.y2 - d.y) < 4;
        const few = d.type === "pen" && d.pts.length < 2;
        if (!tiny && !few) {
          this.annotations.push(d);
          if (d.type === "redline") { this.draft = null; this._openRedlineNote(d); return; }
          this._commit();
        }
        this.draft = null; this.redraw();
      }
    };
    this._onDbl = (e) => {
      if (this.readOnly) return;
      const p = this._pt(e), h = this._hit(p.x, p.y);
      if (h && h.type === "text") { this.annotations.splice(this.annotations.indexOf(h), 1); this._openText(h.x, h.y, h); }
    };
    this._onKey = (e) => {
      if (this.readOnly) return;
      if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
        this.annotations.splice(this.annotations.indexOf(this.selected), 1); this.selected = null; this._commit(); e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey) this.redo(); else this.undo(); e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { this.redo(); e.preventDefault(); }
    };
    this.cv.addEventListener("pointerdown", this._onDown);
    this.cv.addEventListener("pointermove", this._onMove);
    this.cv.addEventListener("pointerup", this._onUp);
    this.cv.addEventListener("dblclick", this._onDbl);
    this.cv.tabIndex = 0;
    this.cv.addEventListener("keydown", this._onKey);
  }

  _moveTo(a, nx, ny) {
    const b = this._bounds(a), dx = nx - b.x, dy = ny - b.y;
    if (a.type === "pen") a.pts.forEach(p => { p.x += dx; p.y += dy; });
    else if (a.type === "redline") { a.x += dx; a.x2 += dx; a.y += dy; }
    else if (a.type === "text" || a.type === "stamp") { a.x += dx; a.y += dy; }
    else { a.x += dx; a.y += dy; a.x2 += dx; a.y2 += dy; }
  }
  // Drag a handle to (nx,ny). Endpoints for line/arrow; corner-driven box
  // for everything else (geometry remapped from the pre-drag snapshot).
  _applyResize(nx, ny) {
    const a = this.selected, r = this.rsz;
    if (a.type === "line" || a.type === "arrow") {
      if (r.handle === "p1") { a.x = nx; a.y = ny; } else { a.x2 = nx; a.y2 = ny; }
      return;
    }
    const b = r.ob, min = 6 / this.scale;
    let left = b.x, top = b.y, right = b.x + b.w, bottom = b.y + b.h;
    if (r.handle.includes("w")) left = nx;
    if (r.handle.includes("e")) right = nx;
    if (r.handle.includes("n")) top = ny;
    if (r.handle.includes("s")) bottom = ny;
    const nb = {
      x: Math.min(left, right), y: Math.min(top, bottom),
      w: Math.max(min, Math.abs(right - left)), h: Math.max(min, Math.abs(bottom - top))
    };
    this._applyBounds(a, r.before, b, nb);
  }
  _applyBounds(a, before, ob, nb) {
    const sx = nb.w / (ob.w || 1), sy = nb.h / (ob.h || 1);
    switch (a.type) {
      case "rect": case "high": case "ellipse":
        a.x = nb.x; a.y = nb.y; a.x2 = nb.x + nb.w; a.y2 = nb.y + nb.h; break;
      case "pen":
        a.pts = (before.pts || []).map(p => ({ x: nb.x + (p.x - ob.x) * sx, y: nb.y + (p.y - ob.y) * sy })); break;
      case "text":
        a.x = nb.x; a.y = nb.y; a.size = Math.max(6, (before.size || 16) * sy); break;
      case "stamp":
        a.scale = Math.max(0.4, (before.scale || 1) * ((sx + sy) / 2));
        a.x = nb.x + nb.w / 2; a.y = nb.y + nb.h / 2; break;
      case "redline":
        a.x = nb.x; a.x2 = nb.x + nb.w; break;   // horizontal rule: width only
    }
  }
  _applyToSelected() { if (this.selected) { this.selected.color = this.color; this.selected.width = this.width; this._commit(); } }

  _floatInput(x, y, multiline, value, color) {
    const el = document.createElement(multiline ? "textarea" : "input");
    el.style.cssText = `position:absolute;z-index:40;left:${x * this.scale}px;top:${y * this.scale}px;
      border:1.5px dashed #dc2626;background:rgba(255,255,255,.96);font-family:${TEXT_FONT};
      padding:4px 6px;resize:none;outline:none;color:${color || "var(--text, #16191e)"};border-radius:3px;
      box-shadow:0 6px 18px rgba(0,0,0,.25);min-width:140px;font-size:16px;`;
    if (color) el.style.fontWeight = "600";
    el.value = value || "";
    this.wrap.appendChild(el); el.focus();
    return el;
  }
  _openText(x, y, existing) {
    const el = this._floatInput(x, y, true, existing ? existing.text : "");
    const done = () => {
      const v = el.value.trim(); el.remove();
      if (existing) { if (v) existing.text = v; else this.annotations.splice(this.annotations.indexOf(existing), 1); this._commit(); }
      else if (v) { this.annotations.push({ type: "text", x, y, text: v, color: this.color, size: 16 }); this._commit(); }
      this.setTool("select");
    };
    el.addEventListener("blur", done);
    el.addEventListener("keydown", ev => { if (ev.key === "Escape") { el.value = existing ? existing.text : ""; el.blur(); } });
  }
  _openRedlineNote(rl) {
    const el = this._floatInput(rl.x, rl.y - 26, false, "", "#dc2626");
    el.placeholder = "correction…";
    const done = () => { rl.text = el.value.trim(); el.remove(); this._commit(); this.setTool("select"); };
    el.addEventListener("blur", done);
    el.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === "Escape") el.blur(); });
  }

  destroy() {
    this.cv.removeEventListener("pointerdown", this._onDown);
    this.cv.removeEventListener("pointermove", this._onMove);
    this.cv.removeEventListener("pointerup", this._onUp);
    this.cv.removeEventListener("dblclick", this._onDbl);
    this.cv.removeEventListener("keydown", this._onKey);
    if (this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
  }
}

/* =====================================================================
   MOUNTING — overlay a transparent markup canvas on a host page canvas
   ===================================================================== */
function attach(hostCanvas, opts = {}) {
  if (!hostCanvas) throw new Error("CXMarkup.attach: hostCanvas required");
  const wrap = hostCanvas.parentNode;
  // Host wrappers in both modules are position:relative; enforce it anyway.
  if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
  // Remove any stale markup overlays so a previous failed/duplicate mount can't
  // stack on top and intercept taps.
  try { Array.prototype.forEach.call(wrap.querySelectorAll(".cx-markup-overlay"), c => c.remove()); } catch (_) {}
  const overlay = document.createElement("canvas");
  overlay.className = "cx-markup-overlay";
  overlay.style.cssText = "position:absolute;top:0;left:0;touch-action:none;z-index:20;" +
    (DEBUG ? "background:rgba(37,99,235,.06);outline:2px dashed rgba(37,99,235,.6);outline-offset:-2px;" : "");
  wrap.appendChild(overlay);
  let eng;
  try {
    eng = new CXMarkupEngine(overlay, {
      host: hostCanvas,
      pageW: opts.pageW || hostCanvas.clientWidth,
      pageH: opts.pageH || hostCanvas.clientHeight,
      engineer: opts.engineer,
      onChange: opts.onChange,
      readOnly: opts.readOnly
    });
  } catch (err) {
    // Never leave an orphan canvas behind if construction fails.
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    console.error("[CXMarkup.attach]", err);
    throw err;
  }
  // iOS can report a 0/incorrect width on first paint; re-fit once layout settles.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => eng.resize());
  setTimeout(() => eng.resize(), 300);
  if (DEBUG) {
    const r = overlay.getBoundingClientRect();
    _hud("mounted ✓  page " + eng.pageW + "x" + eng.pageH +
         "\ncss=" + overlay.style.width + " x " + overlay.style.height +
         "\nrect=" + Math.round(r.width) + " x " + Math.round(r.height) +
         "\nnow tap the page…");
  }
  return eng;
}

/* =====================================================================
   TOOLBAR — light-themed dock built from the project icon() system
   ===================================================================== */
const COLORS = ["#dc2626", "#16191e", "#2563eb", "#1f9d57", "#d97706", "#ffffff"];
const WIDTHS = [2, 3, 5, 8];

function injectStyles() {
  if (document.getElementById("cx-markup-styles")) return;
  const css = `
  .cx-mk-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;
    background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);
    border-radius:10px;padding:6px;box-shadow:0 2px 8px rgba(0,0,0,.06);}
  .cx-mk-tool{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    min-width:44px;height:44px;padding:0 8px;border:1px solid transparent;border-radius:8px;
    background:transparent;color:var(--text-muted,#64748b);cursor:pointer;font:600 8px/1 ${TEXT_FONT};
    letter-spacing:.03em;transition:.12s;}
  .cx-mk-tool .icon-svg{width:18px;height:18px;}
  .cx-mk-tool:hover{background:var(--surface-2,#f1f5f9);color:var(--text,#0f172a);}
  .cx-mk-tool.active{background:var(--brand,#dc2626);border-color:var(--brand,#dc2626);color:#fff;}
  .cx-mk-sep{width:1px;align-self:stretch;background:var(--border,#e2e8f0);margin:4px 2px;}
  .cx-mk-sw{width:22px;height:22px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:.1s;}
  .cx-mk-sw.active{border-color:var(--text,#0f172a);transform:scale(1.12);}
  .cx-mk-wp{min-width:30px;height:30px;border:1px solid var(--border,#e2e8f0);border-radius:7px;
    background:var(--surface,#fff);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;}
  .cx-mk-wp.active{border-color:var(--brand,#dc2626);background:var(--surface-2,#f1f5f9);}
  .cx-mk-wp i{display:block;background:var(--text,#0f172a);border-radius:9px;}
  .cx-mk-stamps{display:flex;flex-wrap:wrap;gap:5px;}
  .cx-mk-chip{padding:6px 9px;border-radius:7px;font:700 11px/1 ${STAMP_FONT};letter-spacing:.05em;color:#fff;
    cursor:pointer;border:1px solid rgba(0,0,0,.08);}
  .cx-mk-chip.active{outline:2px solid var(--text,#0f172a);outline-offset:1px;}
  `;
  const s = document.createElement("style");
  s.id = "cx-markup-styles"; s.textContent = css;
  document.head.appendChild(s);
}

/**
 * Build a toolbar into `container` wired to `engine`.
 * opts: { stamps:true, undo:true, onSave, onFlatten, extra:[{label,icon,fn}] }
 * Returns { el, destroy, refresh }.
 */
function buildToolbar(container, engine, opts = {}) {
  injectStyles();
  const bar = document.createElement("div");
  bar.className = "cx-mk-bar";

  const toolBtns = {};
  TOOLS.forEach((t, i) => {
    if (t.id === "rect") { const sep = document.createElement("div"); sep.className = "cx-mk-sep"; bar.appendChild(sep); }
    const b = document.createElement("button");
    b.type = "button"; b.className = "cx-mk-tool" + (t.id === "select" ? " active" : "");
    b.setAttribute("aria-label", t.label);
    b.innerHTML = ic(t.icon) + `<span>${t.label}</span>`;
    b.onclick = () => {
      engine.setTool(t.id);
      Object.values(toolBtns).forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      stampWrap.style.display = (t.id === "stamp") ? "flex" : "none";
    };
    toolBtns[t.id] = b; bar.appendChild(b);
  });

  bar.appendChild(_sep());

  // colors
  const swWrap = document.createElement("div"); swWrap.className = "cx-mk-stamps";
  COLORS.forEach(c => {
    const d = document.createElement("button");
    d.type = "button"; d.className = "cx-mk-sw" + (c === engine.color ? " active" : "");
    d.style.background = c; d.setAttribute("aria-label", "Color " + c);
    if (c === "#ffffff") d.style.border = "2px solid var(--border,#cbd5e1)";
    d.onclick = () => { engine.setColor(c); swWrap.querySelectorAll(".cx-mk-sw").forEach(x => x.classList.remove("active")); d.classList.add("active"); };
    swWrap.appendChild(d);
  });
  bar.appendChild(swWrap);

  // widths
  const wWrap = document.createElement("div"); wWrap.className = "cx-mk-stamps";
  WIDTHS.forEach(w => {
    const d = document.createElement("button");
    d.type = "button"; d.className = "cx-mk-wp" + (w === engine.width ? " active" : "");
    d.setAttribute("aria-label", "Width " + w);
    d.innerHTML = `<i style="width:${w * 2}px;height:${w * 2}px"></i>`;
    d.onclick = () => { engine.setWidth(w); wWrap.querySelectorAll(".cx-mk-wp").forEach(x => x.classList.remove("active")); d.classList.add("active"); };
    wWrap.appendChild(d);
  });
  bar.appendChild(wWrap);

  // stamp chips (hidden until Stamp tool active)
  const stampWrap = document.createElement("div");
  stampWrap.className = "cx-mk-stamps"; stampWrap.style.display = "none";
  STAMPS.forEach(s => {
    const c = document.createElement("button");
    c.type = "button"; c.className = "cx-mk-chip"; c.textContent = s.k; c.style.background = s.c;
    c.onclick = () => { engine.setStampKind(s.k); stampWrap.querySelectorAll(".cx-mk-chip").forEach(x => x.classList.remove("active")); c.classList.add("active"); };
    stampWrap.appendChild(c);
  });
  bar.appendChild(stampWrap);

  bar.appendChild(_sep());

  // undo / redo
  let undoBtn, redoBtn;
  if (opts.undo !== false) {
    undoBtn = _btn("undo", "Undo", () => engine.undo());
    redoBtn = _btn("redo", "Redo", () => engine.redo());
    bar.appendChild(undoBtn); bar.appendChild(redoBtn);
  }

  // host extras (Save / Flatten / Publish …)
  (opts.extra || []).forEach(x => bar.appendChild(_btn(x.icon, x.label, x.fn)));

  const refresh = (st) => {
    if (undoBtn) undoBtn.disabled = !st.canUndo;
    if (redoBtn) redoBtn.disabled = !st.canRedo;
  };
  // chain refresh into engine.onChange without clobbering host's callback
  const hostOnChange = engine.onChange;
  engine.onChange = (st) => { refresh(st); hostOnChange(st); };
  refresh({ canUndo: engine.canUndo(), canRedo: engine.canRedo() });

  container.appendChild(bar);
  return { el: bar, destroy: () => bar.remove(), refresh };

  function _sep() { const s = document.createElement("div"); s.className = "cx-mk-sep"; return s; }
  function _btn(iconName, label, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "cx-mk-tool"; b.setAttribute("aria-label", label);
    b.innerHTML = ic(iconName) + `<span>${label}</span>`;
    b.onclick = fn; return b;
  }
}

/* =====================================================================
   VECTOR FLATTEN — replay the model into a pdf-lib page (crisp output)
   Maps intrinsic top-left page units onto pdf-lib bottom-left points.
   `annos` = engine.getAnnotations(); `page` = PDFLib page; opts.pageW/pageH
   = the engine's intrinsic page size (defaults to the page's own size).
   Requires window.PDFLib (already loaded in index.html).
   ===================================================================== */
function flattenIntoPdfPage(annos, page, opts = {}) {
  const PDFLib = global.PDFLib;
  if (!PDFLib) throw new Error("pdf-lib not loaded");
  const { rgb } = PDFLib;
  const pw = page.getWidth(), ph = page.getHeight();
  const srcW = opts.pageW || pw, srcH = opts.pageH || ph;
  const sx = pw / srcW, sy = ph / srcH;
  const X = x => x * sx;
  const Y = y => ph - y * sy;                 // flip vertical axis
  const col = (hex) => {
    const h = (hex || "#000000").replace("#", "");
    const n = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    return rgb(parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255);
  };
  const font = opts.font || null;             // host may pass an embedded font

  for (const a of annos) {
    const c = col(a.color);
    const lw = (a.width || 3) * sx;
    switch (a.type) {
      case "pen":
        for (let i = 1; i < a.pts.length; i++)
          page.drawLine({ start: { x: X(a.pts[i - 1].x), y: Y(a.pts[i - 1].y) }, end: { x: X(a.pts[i].x), y: Y(a.pts[i].y) }, thickness: lw, color: c });
        break;
      case "line":
      case "arrow":
        page.drawLine({ start: { x: X(a.x), y: Y(a.y) }, end: { x: X(a.x2), y: Y(a.y2) }, thickness: lw, color: c });
        if (a.type === "arrow") {
          const ang = Math.atan2(a.y2 - a.y, a.x2 - a.x), h = (10 + (a.width || 3) * 1.5);
          page.drawLine({ start: { x: X(a.x2), y: Y(a.y2) }, end: { x: X(a.x2 - h * Math.cos(ang - .4)), y: Y(a.y2 - h * Math.sin(ang - .4)) }, thickness: lw, color: c });
          page.drawLine({ start: { x: X(a.x2), y: Y(a.y2) }, end: { x: X(a.x2 - h * Math.cos(ang + .4)), y: Y(a.y2 - h * Math.sin(ang + .4)) }, thickness: lw, color: c });
        }
        break;
      case "rect":
        page.drawRectangle({ x: X(Math.min(a.x, a.x2)), y: Y(Math.max(a.y, a.y2)), width: Math.abs(a.x2 - a.x) * sx, height: Math.abs(a.y2 - a.y) * sy, borderColor: c, borderWidth: lw });
        break;
      case "ellipse":
        page.drawEllipse({ x: X((a.x + a.x2) / 2), y: Y((a.y + a.y2) / 2), xScale: Math.abs(a.x2 - a.x) / 2 * sx, yScale: Math.abs(a.y2 - a.y) / 2 * sy, borderColor: c, borderWidth: lw });
        break;
      case "high":
        page.drawRectangle({ x: X(Math.min(a.x, a.x2)), y: Y(Math.max(a.y, a.y2) + 2), width: Math.abs(a.x2 - a.x) * sx, height: Math.max(14, Math.abs(a.y2 - a.y)) * sy, color: c, opacity: .32 });
        break;
      case "redline":
        page.drawLine({ start: { x: X(Math.min(a.x, a.x2)), y: Y(a.y) }, end: { x: X(Math.max(a.x, a.x2)), y: Y(a.y) }, thickness: 2 * sx, color: col("#dc2626") });
        if (a.text && font) page.drawText(a.text, { x: X(a.x), y: Y(a.y - 7), size: 13 * sy, font, color: col("#dc2626") });
        break;
      case "text":
        if (font) a.text.split("\n").forEach((ln, i) =>
          page.drawText(ln, { x: X(a.x), y: Y(a.y + (a.size || 16) + i * (a.size || 16) * 1.25), size: (a.size || 16) * sy, font, color: c }));
        break;
      case "stamp": {
        const def = STAMPS.find(s => s.k === a.kind) || STAMPS[0];
        const sc = col(def.c);
        const w = Math.max(96, (a.kind.length * 13) + 28), h = 46;
        page.drawRectangle({ x: X(a.x - w / 2), y: Y(a.y + h / 2), width: w * sx, height: h * sy, borderColor: sc, borderWidth: 3 * sx, opacity: 0, borderOpacity: .92 });
        if (font) {
          page.drawText(a.kind, { x: X(a.x - (a.kind.length * 6)), y: Y(a.y - 2), size: 20 * sy, font, color: sc });
          const sub = (a.who || "") + "  " + (a.ts || "");
          page.drawText(sub, { x: X(a.x - (sub.length * 2.7)), y: Y(a.y + 15), size: 9 * sy, font, color: sc });
        }
        break;
      }
    }
  }
}

/* =====================================================================
   EXPORT
   ===================================================================== */
const CXMarkup = {
  STAMPS,
  TOOLS,
  CXMarkupEngine,
  attach,
  buildToolbar,
  injectStyles,
  flattenIntoPdfPage,
  _hud,
  get DEBUG() { return DEBUG; },
  set DEBUG(v) { DEBUG = v; }
};
global.CXMarkup = CXMarkup;

})(typeof window !== "undefined" ? window : this);
