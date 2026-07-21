"use strict";
// Reusable headless loader for the cx-portal browser bundle.
//
// Loads the page's classic <script> files in index.html order
// (data.js → icons.js → format.js → cx-state.js → compute.js → app.js → perms-admin.js) into a single Node vm
// context under a permissive DOM/lib shim, and returns the shared global object
// (`sandbox`) so tests can call the REAL app.js functions headlessly.
//
// app.js defers all DOM/network work to a DOMContentLoaded handler that this
// loader registers but never fires — so loading has no live side effects. This
// is the foundation for both the boot/smoke test and characterization tests of
// the computational core (weights, status, progress, etc.).

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

// Classic-script order from index.html (extracted modules first, then app.js).
const SCRIPTS = ["config.js", "data.js", "icons.js", "format.js", "cx-state.js", "cx-store.js", "cx-actions.js", "compute.js", "trackplan.js", "print-report.js", "app.js", "perms-admin.js", "team.js", "readiness.js", "mobile.js", "search.js", "notifications.js", "punch-actions.js", "dyn-actions.js"];

// A callable/constructable Proxy that answers ANY property access with another
// universal mock, so arbitrary browser-API chains resolve without throwing.
function universal() {
  const fn = function () { return universal(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined;             // not a thenable
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

// document mock: universal for everything, but records addEventListener so a
// caller can assert the DOMContentLoaded bootstrap registered (without firing).
function makeDocument(domEvents) {
  const real = {
    addEventListener: (type, fn) => { (domEvents[type] = domEvents[type] || []).push(fn); },
    removeEventListener: () => {},
  };
  return new Proxy(real, {
    get(t, prop) { return prop in t ? t[prop] : universal(); },
    has() { return true; },
  });
}

function makeDayjs() {
  try { return require("dayjs"); }
  catch {
    const shim = (i) => { const d = i ? new Date(i) : new Date();
      const w = { format: () => d.toISOString().slice(0, 10), diff: () => 0,
        add: () => w, subtract: () => w, day: () => d.getUTCDay(),
        month: () => d.getUTCMonth(), year: () => d.getUTCFullYear(),
        date: () => d.getUTCDate(), isValid: () => true, toDate: () => d }; return w; };
    shim.extend = () => {};
    return shim;
  }
}

// Loads the bundle and returns { sandbox, ctx, domEvents, winEvents, loadError,
// loadErrorFile, scripts }. Pass { scripts: [...] } to override the file list.
function loadApp(opts = {}) {
  const domEvents = {};
  const winEvents = {};
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
    document: makeDocument(domEvents),
    navigator: { userAgent: "node-loader", onLine: true, clipboard: universal(), serviceWorker: universal() },
    location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "", hash: "", reload: () => {} },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
    URL, URLSearchParams, TextEncoder, TextDecoder,
    Blob: class {}, File: class {}, FormData: class {}, Headers: class {},
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000", getRandomValues: (a) => a },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    alert: () => {}, confirm: () => true, prompt: () => null,
    addEventListener: (type, fn) => { (winEvents[type] = winEvents[type] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    getComputedStyle: () => universal(),
    scrollTo: () => {}, scroll: () => {},
    dayjs: makeDayjs(),
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
  const scripts = opts.scripts || SCRIPTS;
  let loadError = null, loadErrorFile = null;
  for (const f of scripts) {
    try {
      new vm.Script(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f })
        .runInContext(ctx, { timeout: 20000 });
    } catch (e) { loadError = e; loadErrorFile = f; break; }
  }
  return { sandbox, ctx, domEvents, winEvents, loadError, loadErrorFile, scripts };
}

module.exports = { loadApp, universal, SCRIPTS, ROOT };
