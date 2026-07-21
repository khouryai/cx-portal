// ==========================================
// HITACHI Rail T&C Portal — Event-delegation dispatcher (cx-actions.js)
// Foundation for retiring the ~1,000 inline `on*="fn(...)"` handlers (Tier 3
// #11). Inline handlers force every handler onto the global scope and make a
// strict Content-Security-Policy impossible (they need 'unsafe-inline'). This
// installs ONE delegated listener per supported event type that routes an event
// on a `[data-<evt>]` element to a named handler, so markup can move from:
//     <button onclick="openPunchDetail('123')">…
//     <input  onchange="_setFilter('sub', this.value)">
// to:
//     <button data-action="openPunchDetail" data-args='["123"]'>…
//     <input  data-change="_setFilter" data-args='["sub","$cx.value"]'>
//
// Supported events → attribute: click→data-action, change→data-change,
// input→data-input. Purely additive: until an element carries one of these,
// the listeners do nothing, so it is safe to ship ahead of any conversion.
//
// Resolution for data-<evt>="name":
//   1. an action registered via CXActions.register('name', fn)
//   2. the global window.name  (bridges existing app.js globals unchanged)
// Call convention (chosen so an on*→data-<evt> port is a precise drop-in):
//   • a GLOBAL handler is called exactly like the inline handler did —
//     fn(...args), no appended context, this = global — no arity/`this` surprises.
//   • a REGISTERED action opts into context: fn(...args, { el, event }) with
//     this = the element — for new code that wants the event/element.
//
// SENTINELS: inline handlers often read live element state (`this.value`,
// `this.checked`, `this`, `event`). Those are encoded in data-args as the
// strings "$cx.value" / "$cx.checked" / "$cx.el" / "$cx.event" and substituted
// with the real values at event time — so `onchange="fn('x', this.value)"`
// becomes `data-change="fn" data-args='["x","$cx.value"]'` and still calls
// fn('x', el.value). A normal string arg is never one of these sentinels.
//
// Args come from `data-args` (a JSON array) or `data-arg` (a single string).
// Emit them in template literals with cxAct()/cxOn(); see docs/adr/0001.
// ==========================================
(function () {
  var registry = Object.create(null);

  function parseArgs(el) {
    var raw = el.getAttribute('data-args');
    if (raw == null || raw === '') {
      var one = el.getAttribute('data-arg');
      return one == null ? [] : [one];
    }
    try {
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];
    } catch (e) {
      return [raw]; // malformed JSON → treat the literal string as one arg
    }
  }

  // Replace live-state sentinels with the real element/event values.
  function substSentinels(args, el, event) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a === '$cx.value') args[i] = el ? el.value : undefined;
      else if (a === '$cx.checked') args[i] = el ? el.checked : undefined;
      else if (a === '$cx.el') args[i] = el;
      else if (a === '$cx.event') args[i] = event;
    }
    return args;
  }

  function resolve(name) {
    if (typeof registry[name] === 'function') return registry[name];
    if (typeof window !== 'undefined' && typeof window[name] === 'function') return window[name];
    return null;
  }

  /**
   * Run the handler bound to `el` for a given attribute. Returns true if a
   * handler was found and run. Exposed so tests (and programmatic callers) can
   * dispatch without a real DOM.
   * @param {{ getAttribute: (name: string) => (string | null) } | null} el
   * @param {Event | {} } event
   * @param {string} [attr]  the data attribute to read (default "data-action")
   * @returns {boolean}
   */
  function dispatch(el, event, attr) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    attr = attr || 'data-action';
    var name = el.getAttribute(attr);
    if (!name) return false;
    var fromRegistry = typeof registry[name] === 'function';
    var fn = fromRegistry ? registry[name]
      : (typeof window !== 'undefined' && typeof window[name] === 'function') ? window[name] : null;
    if (!fn) {
      if (typeof window !== 'undefined' && window._logSwallowed) {
        window._logSwallowed('cx-actions: unresolved action "' + name + '"', new Error('no handler'));
      }
      return false;
    }
    var args = substSentinels(parseArgs(el), el, event);
    if (fromRegistry) {
      // Registered actions opt into element + event context: fn(...args, {el,event}).
      fn.apply(el, args.concat([{ el: el, event: event }]));
    } else {
      // Legacy global handler: call EXACTLY like the inline handler did — same
      // args, no appended context, this = global scope — so the port is a precise
      // drop-in with no arity or `this` surprises.
      fn.apply(typeof window !== 'undefined' ? window : undefined, args);
    }
    return true;
  }

  // One delegated listener per event type, keyed to its data attribute.
  var EVENTS = { click: 'data-action', change: 'data-change', input: 'data-input' };
  function makeListener(attr) {
    return function (event) {
      var t = event && event.target;
      var el = t && typeof t.closest === 'function' ? t.closest('[' + attr + ']') : null;
      if (el) dispatch(el, event, attr);
    };
  }

  // HTML-escape for building attribute values safely from template literals.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }

  // Emit delegation attributes for a template literal. `attr` is the data suffix
  // (action/change/input). Extra args are JSON-encoded + HTML-escaped.
  function emit(attr, name, args) {
    var out = 'data-' + attr + '="' + esc(name) + '"';
    if (args.length) out += " data-args='" + esc(JSON.stringify(args)) + "'";
    return out;
  }

  /**
   * Emit click delegation attributes: `<button ${cxAct('fn', id)}>`.
   * @param {string} name
   * @returns {string} e.g. `data-action="fn" data-args='[…]'`
   */
  function act(name) { return emit('action', name, Array.prototype.slice.call(arguments, 1)); }

  /**
   * Emit delegation attributes for an arbitrary supported event.
   * `<input ${cxOn('change', 'fn', 'sub', '$cx.value')}>`.
   * @param {string} evt   action | change | input
   * @param {string} name
   * @returns {string}
   */
  function cxOn(evt, name) { return emit(evt, name, Array.prototype.slice.call(arguments, 2)); }

  var CXActions = {
    // Register a named action. Registered actions win over globals of the same
    // name, so a module can claim its handlers as it is extracted.
    register: function (name, fn) { registry[name] = fn; return CXActions; },
    unregister: function (name) { delete registry[name]; return CXActions; },
    // True if data-<evt>="name" would resolve to something callable.
    has: function (name) { return resolve(name) != null; },
    dispatch: dispatch,
    act: act,
    on: cxOn,
    _registry: registry,
  };

  if (typeof document !== 'undefined' && document.addEventListener) {
    for (var ev in EVENTS) document.addEventListener(ev, makeListener(EVENTS[ev]));
  }
  if (typeof window !== 'undefined') { window.CXActions = CXActions; window.cxAct = act; window.cxOn = cxOn; }
  if (typeof module !== 'undefined' && module.exports) module.exports = CXActions;
})();
