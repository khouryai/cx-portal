// ==========================================
// Construction Planner — local persistence (cxc-store-local.js)
//
// THE ONLY FILE IN THE APP THAT MAY TOUCH localStorage OR THE FILESYSTEM.
// Everything else calls this narrow interface. That is the whole point: when
// this app merges into cx-portal, the backend swap is ONE file — reimplement
// these five functions against Supabase (PostgREST + RLS, tables prefixed
// `cxc_`) and no UI or model code changes at all.
//
// Interface (keep it this small):
//   load(key, fallback)   read a saved slice
//   save(key, value)      write a slice
//   exportJson()          the entire dataset as a JSON string (a backup / a
//                         handoff to a coworker / an input to the merge)
//   importJson(text)      replace the entire dataset from that JSON string
//   clear()              wipe local data
//
// Keys are namespaced `cxc.` so this can share a browser origin with cx-portal
// after the merge without stepping on it.
// ==========================================
(function () {
  'use strict';

  var PREFIX = 'cxc.';
  var SLICES = ['assumptions', 'scope', 'schedule'];  // add new slices here

  function hasLS() {
    try { return typeof localStorage !== 'undefined' && localStorage !== null; }
    catch (e) { return false; }   // Safari private mode throws on access
  }

  // In-memory fallback so the app still works where localStorage is blocked.
  var memory = Object.create(null);

  /**
   * Read a slice. Corrupt JSON returns the fallback rather than throwing —
   * a bad save must never brick the app on next load.
   * @param {string} key  slice name, e.g. 'assumptions'
   * @param {*} [fallback]
   * @returns {*}
   */
  function load(key, fallback) {
    var raw;
    if (hasLS()) { try { raw = localStorage.getItem(PREFIX + key); } catch (e) { raw = null; } }
    if (raw == null) raw = memory[key];
    if (raw == null) return fallback;
    try { return JSON.parse(raw); }
    catch (e) { return fallback; }
  }

  /**
   * Write a slice. Returns false if it could not be persisted (quota, private
   * mode) — the caller can surface that instead of silently losing work.
   * @param {string} key
   * @param {*} value
   * @returns {boolean}
   */
  function save(key, value) {
    var raw;
    try { raw = JSON.stringify(value); }
    catch (e) { return false; }
    memory[key] = raw;
    if (!hasLS()) return false;
    try { localStorage.setItem(PREFIX + key, raw); return true; }
    catch (e) { return false; }
  }

  /**
   * Whole dataset as a formatted JSON string — the backup/handoff format, and
   * the thing you will hand over at merge time to seed the real database.
   * @returns {string}
   */
  function exportJson() {
    var out = { format: 'cxc-planner', version: 1, exportedAt: new Date().toISOString(), data: {} };
    SLICES.forEach(function (k) {
      var v = load(k, null);
      if (v !== null) out.data[k] = v;
    });
    return JSON.stringify(out, null, 2);
  }

  /**
   * Replace the dataset from an exportJson() string.
   * @param {string} text
   * @returns {{ok:boolean, error?:string, loaded?:string[]}}
   */
  function importJson(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, error: 'Not valid JSON.' }; }
    if (!parsed || parsed.format !== 'cxc-planner' || !parsed.data) {
      return { ok: false, error: 'Not a construction-planner export file.' };
    }
    var loaded = [];
    SLICES.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(parsed.data, k)) { save(k, parsed.data[k]); loaded.push(k); }
    });
    return { ok: true, loaded: loaded };
  }

  /** Wipe every slice this app owns. Leaves other origins' keys alone. */
  function clear() {
    SLICES.forEach(function (k) {
      delete memory[k];
      if (hasLS()) { try { localStorage.removeItem(PREFIX + k); } catch (e) { /* ignore */ } }
    });
  }

  var CXCStore = {
    load: load, save: save, exportJson: exportJson, importJson: importJson,
    clear: clear, SLICES: SLICES, PREFIX: PREFIX
  };

  if (typeof window !== 'undefined') window.CXCStore = CXCStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXCStore;
})();
