/* Headless test harness for markup.js — runs the real engine against a mocked
   canvas/DOM to verify mount + tool actions + multi-select/resize/keyboard.
   Run: node tools/markup_test.js   (also gated in .github/workflows/deploy.yml) */
"use strict";

function makeCtx() {
  const noop = () => {};
  const ctx = {
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, fillRect: noop, clearRect: noop,
    strokeRect: noop, rect: noop, ellipse: noop, arc: noop, arcTo: noop,
    translate: noop, scale: noop, setTransform: noop, setLineDash: noop,
    drawImage: noop, fillText: noop,
    measureText: (s) => ({ width: (s ? String(s).length : 0) * 8 }),
  };
  return ctx;
}

function makeCanvas(w, h) {
  const handlers = {};
  const style = {};
  const cv = {
    _isCanvas: true, width: w || 0, height: h || 0, style, className: "",
    tabIndex: 0, parentNode: null, _handlers: handlers, _ctx: null,
    getContext() { return cv._ctx || (cv._ctx = makeCtx()); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: parseFloat(style.width) || (w || 600), height: parseFloat(style.height) || (h || 800) }),
    addEventListener: (t, fn) => { handlers[t] = fn; },
    removeEventListener: (t) => { delete handlers[t]; },
    setPointerCapture: () => {}, releasePointerCapture: () => {}, focus: () => {},
    remove() { if (cv.parentNode) cv.parentNode._children = cv.parentNode._children.filter(c => c !== cv); },
    get clientWidth() { return parseFloat(style.width) || (w || 600); },
    get clientHeight() { return parseFloat(style.height) || (h || 800); },
  };
  return cv;
}

function makeWrap() {
  const wrap = {
    _children: [], style: { position: "relative" }, clientWidth: 600, clientHeight: 800,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }),
    appendChild: (c) => { c.parentNode = wrap; wrap._children.push(c); return c; },
    removeChild: (c) => { wrap._children = wrap._children.filter(x => x !== c); },
    querySelectorAll: (sel) => wrap._children.filter(c => (c.className || "").includes(sel.replace(".", ""))),
  };
  return wrap;
}

globalThis.devicePixelRatio = 2;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.getComputedStyle = () => ({ position: "relative" });
globalThis.document = {
  createElement: (tag) => (tag === "canvas" ? makeCanvas() : { style: {}, set textContent(v) { this._t = v; }, appendChild: () => {} }),
  getElementById: () => null, head: { appendChild: () => {} }, body: { appendChild: () => {} },
};
const fakeWindow = { devicePixelRatio: 2, icon: () => "" };
globalThis.window = fakeWindow;

require("../markup.js");
const CXMarkup = fakeWindow.CXMarkup;
if (!CXMarkup) { console.error("FAIL: CXMarkup not exported"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error("  ✗ " + m)); };

const wrap = makeWrap();
const host = makeCanvas(1200, 1600);
host.style.width = "600px"; host.style.height = "800px";
wrap.appendChild(host);

let eng;
try { eng = CXMarkup.attach(host, { pageW: 600, pageH: 800, engineer: "A. Khoury", onChange: () => {} }); }
catch (e) { console.error("FAIL: attach threw:", (e && e.stack) || e); process.exit(1); }

// Regression guards for the two bugs that shipped before:
ok(typeof eng.resize === "function", "resize() is still a method (not shadowed by drag state)");
ok(Array.isArray(eng.selected), "selected is an array (multi-select)");
ok(eng.cv.style.width === "600px" && Math.abs(eng.scale - 1) < 1e-9, "overlay sized to host, scale=1");

const H = eng.cv._handlers;
const _pt = (o) => o.touch ? "touch" : "mouse";
const down = (x, y, o = {}) => H.pointerdown({ clientX: x, clientY: y, pointerId: 1, pointerType: _pt(o), shiftKey: !!o.shift });
const move = (x, y, o = {}) => H.pointermove({ clientX: x, clientY: y, pointerId: 1, pointerType: _pt(o), shiftKey: !!o.shift });
const up   = (o = {}) => H.pointerup({ pointerId: 1, pointerType: _pt(o), shiftKey: !!o.shift });
const key  = (k, o = {}) => H.keydown({ key: k, ctrlKey: !!o.mod, metaKey: false, shiftKey: !!o.shift, preventDefault() {} });

// ---- place a stamp, a box, an arrow ----
eng.setTool("stamp"); eng.setStampKind("WITNESSED"); down(120, 120); up();
const stamp = eng.annotations[eng.annotations.length - 1];
ok(eng.annotations.length === 1 && stamp.type === "stamp" && stamp.kind === "WITNESSED", "stamp placed");

eng.setTool("rect"); down(50, 50); move(200, 160); up();
const box = eng.annotations[eng.annotations.length - 1];
ok(eng.annotations.length === 2 && box.type === "rect", "box placed");

eng.setTool("arrow"); down(300, 300); move(420, 360); up();
const arrow = eng.annotations[eng.annotations.length - 1];
ok(eng.annotations.length === 3 && arrow.type === "arrow", "arrow placed");

// ---- single select + move ----
eng.setTool("select");
down(120, 100); ok(eng.selected.length === 1 && eng.selected[0] === box, "single-select picked the box");
move(140, 120); up();
ok(Math.abs(box.x - 70) < 2, "box moved by drag (x=" + box.x.toFixed(0) + ")");

// ---- resize via SE handle (single) ----
down(120, 100);                                   // reselect box
let b = eng._bounds(box);
down(b.x + b.w, b.y + b.h);                        // grab SE handle
ok(!!eng.rsz, "resize started on SE handle");
move(b.x + b.w + 60, b.y + b.h + 40); up();
ok(eng._bounds(box).w > b.w + 50, "box widened by resize");

// ---- shift-click multi-select + group move (tap centers, away from handles) ----
const center = (a) => { const b = eng._bounds(a); return [b.x + b.w / 2, b.y + b.h / 2]; };
eng.setTool("select"); key("Escape");
let cb = center(box); down(cb[0], cb[1]); up();
ok(eng.selected.length === 1 && eng.selected[0] === box, "selected the box (center tap)");
let ca = center(arrow); down(ca[0], ca[1], { shift: true }); up();    // arrow doesn't overlap the box
ok(eng.selected.length === 2, "shift-click added a second selection (" + eng.selected.length + ")");
const bx0 = box.x, ax0 = arrow.x;
cb = center(box); down(cb[0], cb[1]); move(cb[0] + 20, cb[1]); up();   // drag the group +20x
ok(Math.abs(box.x - (bx0 + 20)) < 2 && Math.abs(arrow.x - (ax0 + 20)) < 2, "group move shifted both items");

// ---- marquee select ----
eng.setTool("select");
down(0, 0); move(600, 800); up();                  // drag a big marquee over everything
ok(eng.selected.length === 3, "marquee selected all 3 (" + eng.selected.length + ")");

// ---- duplicate (Cmd/Ctrl+D) ----
key("d", { mod: true });
ok(eng.annotations.length === 6, "duplicate added copies (total " + eng.annotations.length + ")");
ok(eng.selected.length === 3, "selection switched to the copies");

// ---- nudge with arrow key ----
const dupBox = eng.selected.find(a => a.type === "rect");
const nx0 = dupBox.x; key("ArrowRight");
ok(Math.abs(dupBox.x - (nx0 + 1)) < 0.001, "ArrowRight nudged selection by 1");
key("ArrowRight", { shift: true });
ok(Math.abs(dupBox.x - (nx0 + 11)) < 0.001, "Shift+ArrowRight nudged by 10");

// ---- select all + group delete ----
key("a", { mod: true });
ok(eng.selected.length === 6, "Ctrl/Cmd+A selected all (" + eng.selected.length + ")");
key("Delete");
ok(eng.annotations.length === 0 && eng.selected.length === 0, "Delete removed all selected");

// ---- shift-constrain: line snaps to horizontal ----
eng.setTool("line"); down(100, 100); move(200, 112, { shift: true }); up();
const line = eng.annotations[eng.annotations.length - 1];
ok(line.type === "line" && Math.abs(line.y2 - 100) < 0.001, "Shift constrained line to horizontal (y2=" + line.y2.toFixed(1) + ")");

// ---- shift-constrain: box becomes square ----
eng.setTool("rect"); down(50, 50); move(150, 90, { shift: true }); up();
const sq = eng.annotations[eng.annotations.length - 1];
ok(Math.abs((sq.x2 - sq.x) - (sq.y2 - sq.y)) < 0.001, "Shift constrained box to a square");

// ---- undo brings back deleted set; flatten APIs present ----
const beforeUndo = eng.annotations.length;
eng.undo();
ok(eng.annotations.length !== beforeUndo, "undo changed the model");
ok(typeof eng.exportFlattened === "function" && typeof CXMarkup.flattenIntoPdfPage === "function", "flatten APIs present");

// ---- touch ergonomics: select mode scrolls (pan-y, no marquee); tools capture ----
eng.setTool("select");
ok(eng.cv.style.touchAction === "pan-y", "select tool sets touch-action pan-y (page scrolls)");
eng.setTool("rect");
ok(eng.cv.style.touchAction === "none", "drawing tool sets touch-action none (captures)");
eng.setTool("select"); key("Escape");
down(5, 5, { touch: true });           // empty-space touch
ok(!eng.marquee, "touch on empty space does NOT start a marquee (lets the page scroll)");
up({ touch: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
