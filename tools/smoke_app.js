// Headless boot/smoke test for app.js.
//
// app.js is a ~39k-line classic browser script. It does almost nothing at load
// time except define functions and a defensive (try/caught) Supabase client;
// all real work is deferred to a DOMContentLoaded handler. This test evaluates
// the ENTIRE file in a Node vm under a permissive DOM/globals shim and asserts
// it runs top-to-bottom without throwing — i.e. that a refactor didn't break
// parse/define order. It does NOT fire DOMContentLoaded (no live init/network).
//
// This is the browser-level safety net that makes the planned ES-module split
// verifiable: extract a module, re-run this, and a load-time regression surfaces.
//
// Run:  node tools/smoke_app.js   (no external deps; dayjs is shimmed if absent)
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

// ── Universal mock: a callable/constructable Proxy that answers ANY property
// access with another universal mock. Lets arbitrary browser-API chains
// (document.x().y.z, new Chart(...), supabase.createClient().from()...) resolve
// without throwing, so loading the file never dies on a missing global.
function universal() {
  const fn = function () { return universal(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined;          // not a thenable
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      return universal();
    },
    apply() { return universal(); },
    construct() { return universal(); },
    has() { return true; },
  });
}

// document mock: universal for everything, but records addEventListener so we
// can assert the DOMContentLoaded bootstrap registered (without firing it).
const domEvents = {};
const winEvents = {};
function makeDocument() {
  const real = {
    addEventListener: (type, fn) => { (domEvents[type] = domEvents[type] || []).push(fn); },
    removeEventListener: () => {},
  };
  return new Proxy(real, {
    get(t, prop) { return prop in t ? t[prop] : universal(); },
    has() { return true; },
  });
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  };
}

// dayjs: use the real one if installed, else a tiny shim (app.js only touches
// it inside functions, but provide it so any top-level use is safe).
let dayjs;
try { dayjs = require("dayjs"); }
catch { dayjs = (i) => { const d = i ? new Date(i) : new Date();
  const w = { format: () => d.toISOString().slice(0, 10), diff: () => 0,
    add: () => w, subtract: () => w, day: () => d.getUTCDay(),
    month: () => d.getUTCMonth(), year: () => d.getUTCFullYear(),
    date: () => d.getUTCDate(), isValid: () => true, toDate: () => d }; return w; };
  dayjs.extend = () => {}; }

// Build the sandbox. `window` and `globalThis` are the context itself so that
// top-level `window.foo = foo` and bare `foo` share one global object.
const sandbox = {
  console,
  setTimeout: () => 0,        // swallow deferred init (e.g. _checkDbStatus)
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  queueMicrotask: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  fetch: async () => ({ ok: true, status: 200, json: async () => [], text: async () => "" }),
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  document: makeDocument(),
  navigator: { userAgent: "node-smoke", onLine: true, clipboard: universal(), serviceWorker: universal() },
  location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "", hash: "", reload: () => {} },
  history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
  URL, URLSearchParams, TextEncoder, TextDecoder,
  Blob: class {}, File: class {}, FormData: class {}, Headers: class {},
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000", getRandomValues: (a) => a },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  alert: () => {}, confirm: () => true, prompt: () => null,
  // window-level event API (window === sandbox, so bare addEventListener works too)
  addEventListener: (type, fn) => { (winEvents[type] = winEvents[type] || []).push(fn); },
  removeEventListener: () => {},
  dispatchEvent: () => true,
  getComputedStyle: () => universal(),
  scrollTo: () => {}, scroll: () => {},
  dayjs,
  // CDN libs that app.js expects as globals. universal() is callable AND
  // constructable AND answers any property access/assignment, so top-level
  // touches like `Chart.defaults.font.family = ...` or `new TomSelect(...)` work.
  supabase: { createClient: () => universal() },
  Chart: universal(),
  Alpine: universal(),
  flatpickr: universal(),
  TomSelect: universal(),
  Fuse: universal(),
  XLSX: universal(),
  pdfjsLib: universal(),
  PDFLib: universal(),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.top = sandbox;
sandbox.parent = sandbox;

const ctx = vm.createContext(sandbox);

console.log("=== app.js headless boot/smoke ===\n");

const ROOT = path.resolve(__dirname, "..");

// Load the page's classic scripts in the SAME order as index.html, into one
// shared context. Append future extracted modules here as the split proceeds.
const SCRIPTS = ["data.js", "icons.js", "format.js", "cx-state.js", "app.js"];
let loadErr = null, loadErrFile = null;
for (const f of SCRIPTS) {
  try {
    new vm.Script(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f })
      .runInContext(ctx, { timeout: 20000 });
  } catch (e) { loadErr = e; loadErrFile = f; break; }
}
ok(`page scripts evaluate top-to-bottom without throwing (${SCRIPTS.join(" → ")})`,
   !loadErr, loadErr && (loadErrFile + ": " + loadErr.message +
     (loadErr.stack ? "\n    " + loadErr.stack.split("\n")[1] : "")));

ok("data.js set window.PORTAL_DATA",
   sandbox.window.PORTAL_DATA && typeof sandbox.window.PORTAL_DATA === "object");
ok("icon() global provided by icons.js",
   typeof sandbox.icon === "function" && typeof sandbox.window.icon === "function");
ok("escapeHtml() global provided by format.js",
   typeof sandbox.escapeHtml === "function" && typeof sandbox.window.escapeHtml === "function");
ok("cx* state helpers provided by cx-state.js",
   typeof sandbox.cxSkeleton === "function" && typeof sandbox.cxEmpty === "function" &&
   typeof sandbox.cxError === "function");

// Bootstrap wiring: the DOMContentLoaded handler must have been registered
// (proves execution reached the bootstrap) — but NOT fired (no live init/network).
ok("DOMContentLoaded bootstrap registered",
   Array.isArray(domEvents.DOMContentLoaded) && domEvents.DOMContentLoaded.length > 0,
   `handlers: ${(domEvents.DOMContentLoaded || []).length}`);

// Top-level (non-hoisted) side effect near the start: the Supabase client init.
ok("Supabase client initialized (_sb set at top level)", sandbox._sb !== undefined && sandbox._sb !== null);

// Representative app.js helpers still defined (smoke — hoisted, mainly a parse guard).
for (const sym of ["escapeHtml", "cxSkeleton", "cxEmpty", "cxError"]) {
  ok(`function \`${sym}\` defined`, typeof sandbox[sym] === "function");
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
