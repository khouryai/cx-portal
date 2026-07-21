// ==========================================
// HITACHI Rail T&C Portal — Minimal observable store (cx-store.js)
// The designated future home for app.js's ~300 loose underscore-prefixed
// globals (Tier 3 #12). Rendering today is "mutate a global, then re-innerHTML
// a whole section"; the migration target is "mutate ONE store key, and only the
// views subscribed to that key re-render." This file is the seam that makes that
// migration incremental: move hot state (current page, active filters, the
// loaded record collections) into CXStore one slice at a time, subscribing the
// affected render fn, without touching the rest.
//
// Deliberately tiny and dependency-free (classic <script>, loaded before app.js,
// exposed as window.CXStore). No framework, no proxies — just get/set/update +
// keyed subscriptions with synchronous notify. See docs/adr/0001.
// ==========================================
(function () {
  var state = Object.create(null);
  var subs  = Object.create(null); // key -> [fn]

  function notify(key, value) {
    var list = subs[key];
    if (!list) return;
    // Iterate a copy so a subscriber that unsubscribes mid-notify is safe.
    list.slice().forEach(function (fn) {
      try { fn(value, key); }
      catch (e) { if (typeof window !== 'undefined' && window._logSwallowed) window._logSwallowed('CXStore subscriber(' + key + ')', e); }
    });
  }

  var CXStore = {
    // Read a key (optionally with a default when unset).
    get: function (key, fallback) {
      return key in state ? state[key] : fallback;
    },
    // Write a key and synchronously notify its subscribers. Returns the value.
    set: function (key, value) {
      state[key] = value;
      notify(key, value);
      return value;
    },
    // Functional update: set(key, fn(currentValue)).
    update: function (key, fn) {
      return this.set(key, fn(state[key]));
    },
    // Subscribe to a key. Returns an unsubscribe fn. `immediate` fires now.
    subscribe: function (key, fn, immediate) {
      (subs[key] = subs[key] || []).push(fn);
      if (immediate) { try { fn(state[key], key); } catch (e) { if (typeof window !== 'undefined' && window._logSwallowed) window._logSwallowed('CXStore immediate(' + key + ')', e); } }
      return function unsubscribe() {
        var list = subs[key];
        if (!list) return;
        var i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      };
    },
    has: function (key) { return key in state; },
    keys: function () { return Object.keys(state); },
    // Escape hatch for debugging only — do not mutate the returned object.
    _state: state,
    _subs: subs,
  };

  if (typeof window !== 'undefined') window.CXStore = CXStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXStore;
})();
