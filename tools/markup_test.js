/* Headless test harness for markup.js — runs the real engine against a mocked
   canvas/DOM to verify mount + tool actions add annotations. Run: node tools/markup_test.js */
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
    canvas: null,
  };
  return ctx;
}

function makeCanvas(w, h) {
  const handlers = {};
  const style = {};
  const cv = {
    _isCanvas: true,
    width: w || 0, height: h || 0,
    style,
    className: "",
    tabIndex: 0,
    parentNode: null,
    _handlers: handlers,
    getContext: () => cv._ctx || (cv._ctx = makeCtx()),
    getBoundingClientRect: () => ({
      left: 0, top: 0,
      width: parseFloat(style.width) || cv._cssW || (w || 600),
      height: parseFloat(style.height) || cv._cssH || (h || 800),
    }),
    addEventListener: (t, fn) => { handlers[t] = fn; },
    removeEventListener: (t) => { delete handlers[t]; },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    focus: () => {},
    remove: () => { if (cv.parentNode) cv.parentNode._children = (cv.parentNode._children || []).filter(c => c !== cv); },
    get clientWidth() { return parseFloat(style.width) || cv._cssW || (w || 600); },
    get clientHeight() { return parseFloat(style.height) || cv._cssH || (h || 800); },
  };
  return cv;
}

function makeWrap() {
  const wrap = {
    _children: [],
    style: { position: "relative" },
    clientWidth: 600, clientHeight: 800,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }),
    appendChild: (c) => { c.parentNode = wrap; wrap._children.push(c); return c; },
    removeChild: (c) => { wrap._children = wrap._children.filter(x => x !== c); },
    querySelector: (sel) => wrap._children.find(c => (c.className || "").includes(sel.replace(".", ""))) || null,
    querySelectorAll: (sel) => {
      const cls = sel.replace(".", "");
      const found = wrap._children.filter(c => (c.className || "").includes(cls));
      found.forEach = Array.prototype.forEach.bind(found);
      return found;
    },
  };
  return wrap;
}

// ---- global DOM mocks ----
globalThis.devicePixelRatio = 2;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.getComputedStyle = () => ({ position: "relative" });
globalThis.document = {
  createElement: (tag) => (tag === "canvas" ? makeCanvas() : { style: {}, set textContent(v) { this._t = v; }, appendChild: () => {} }),
  getElementById: () => null,
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
};
const fakeWindow = { devicePixelRatio: 2, icon: () => "" };
globalThis.window = fakeWindow;

// ---- load the engine ----
require("../markup.js");
const CXMarkup = fakeWindow.CXMarkup || globalThis.CXMarkup;
if (!CXMarkup) { console.error("FAIL: CXMarkup not exported"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error("  ✗ " + m); } };

// ---- build a host canvas in a wrap ----
const wrap = makeWrap();
const host = makeCanvas(1200, 1600);       // backing store (dpr 2 of 600x800)
host.style.width = "600px"; host.style.height = "800px";
wrap.appendChild(host);

let lastState = null;
let eng;
try {
  eng = CXMarkup.attach(host, { pageW: 600, pageH: 800, engineer: "A. Khoury", onChange: (s) => { lastState = s; } });
} catch (e) {
  console.error("FAIL: attach threw:", e && e.stack || e); process.exit(1);
}
ok(!!eng, "attach returned an engine");
ok(eng && eng.cv && eng.cv.style.width === "600px", "overlay sized to host (css width=" + (eng && eng.cv.style.width) + ")");
ok(eng && Math.abs(eng.scale - 1) < 1e-9, "scale computed = 1 (got " + (eng && eng.scale) + ")");

const overlay = eng.cv;
const down = (x, y) => overlay._handlers.pointerdown && overlay._handlers.pointerdown({ clientX: x, clientY: y, pointerId: 1, pointerType: "touch" });
const move = (x, y) => overlay._handlers.pointermove && overlay._handlers.pointermove({ clientX: x, clientY: y, pointerId: 1, pointerType: "touch" });
const up   = () => overlay._handlers.pointerup && overlay._handlers.pointerup({ pointerId: 1, pointerType: "touch" });

// ---- STAMP ----
eng.setTool("stamp"); eng.setStampKind("WITNESSED");
down(120, 120); up();
ok(eng.annotations.length === 1, "stamp added 1 annotation (got " + eng.annotations.length + ")");
ok(eng.annotations[0] && eng.annotations[0].type === "stamp" && eng.annotations[0].kind === "WITNESSED", "stamp is WITNESSED");

// ---- BOX ----
eng.setTool("rect");
down(50, 50); move(200, 160); up();
ok(eng.annotations.length === 2, "box added (total " + eng.annotations.length + ")");
const box = eng.annotations[1];
ok(box && box.type === "rect" && Math.abs(box.x2 - 200) < 1 && Math.abs(box.y2 - 160) < 1, "box has expected geometry");

// ---- ARROW ----
eng.setTool("arrow");
down(300, 300); move(400, 380); up();
ok(eng.annotations.length === 3, "arrow added (total " + eng.annotations.length + ")");

// ---- SELECT + MOVE the box ----
eng.setTool("select");
down(120, 100);                       // inside the box bounds
ok(eng.selected === box, "select picked the box");
move(140, 120); up();                 // dragged +20,+20
ok(Math.abs(box.x - 70) < 2, "box moved with drag (x=" + box.x + ")");

// ---- RESIZE the box via SE handle ----
eng.setTool("select");
down(120, 100);                       // reselect box
const b = eng._bounds(box);
down(b.x + b.w, b.y + b.h);           // grab SE handle
ok(!!eng.resize, "resize started on SE handle");
move(b.x + b.w + 50, b.y + b.h + 40); up();
const b2 = eng._bounds(box);
ok(b2.w > b.w + 40, "box widened by resize (" + b.w.toFixed(0) + " -> " + b2.w.toFixed(0) + ")");

// ---- flatten model exists ----
ok(typeof eng.exportFlattened === "function", "exportFlattened present");
ok(typeof CXMarkup.flattenIntoPdfPage === "function", "flattenIntoPdfPage present");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
