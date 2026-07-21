// ==========================================
// HITACHI Rail T&C Portal — Event-delegation dispatcher (cx-actions.js)
// Foundation for retiring the ~1,000 inline `onclick="fn(...)"` handlers
// (Tier 3 #11). Inline handlers force every handler onto the global scope and
// make a strict Content-Security-Policy impossible (they need
// 'unsafe-inline'). This installs ONE delegated click listener that routes a
// click on any `[data-action]` element to a named handler, so markup can move
// from:
//     <button onclick="openPunchDetail('123')">…
// to:
//     <button data-action="openPunchDetail" data-args='["123"]'>…
// and the global function eventually becomes a registered action.
//
// Purely additive: until an element carries data-action, this listener does
// nothing, so it is safe to ship ahead of any conversion. Loaded before app.js;
// handlers resolve at CLICK time so load order vs app.js is irrelevant.
//
// Resolution for data-action="name":
//   1. an action registered via CXActions.register('name', fn)
//   2. the global window.name  (bridges existing app.js globals unchanged)
// The handler is called as fn(...args, { el, event }); the trailing context
// object is ignored by handlers that only read positional args (the common
// case), which is what makes a mechanical onclick→data-action port safe.
//
// Args come from `data-args` (a JSON array) or `data-arg` (a single string).
// See docs/adr/0001 for the conversion playbook.
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

  function resolve(name) {
    if (typeof registry[name] === 'function') return registry[name];
    if (typeof window !== 'undefined' && typeof window[name] === 'function') return window[name];
    return null;
  }

  // Run the handler bound to `el`. Returns true if a handler was found and run.
  // Exposed so tests (and programmatic callers) can dispatch without a real DOM.
  function dispatch(el, event) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    var name = el.getAttribute('data-action');
    if (!name) return false;
    var fn = resolve(name);
    if (!fn) {
      if (typeof window !== 'undefined' && window._logSwallowed) {
        window._logSwallowed('cx-actions: unresolved action "' + name + '"', new Error('no handler'));
      }
      return false;
    }
    var args = parseArgs(el);
    fn.apply(el, args.concat([{ el: el, event: event }]));
    return true;
  }

  function onClick(event) {
    var t = event && event.target;
    var el = t && typeof t.closest === 'function' ? t.closest('[data-action]') : null;
    if (el) dispatch(el, event);
  }

  // HTML-escape for building attribute values safely from template literals.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }

  // Emit the delegation attributes for a template literal, replacing an inline
  // onclick. Usage inside HTML template strings:
  //     `<button ${act('openPunchDetail', id)}>Open</button>`
  //   → `<button data-action="openPunchDetail" data-args='["…"]'>Open</button>`
  // Args are JSON-encoded and HTML-escaped, so quotes/apostrophes in values are
  // safe (the inline-onclick equivalent had to hand-escape). No args → just the
  // data-action attribute.
  function act(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var out = 'data-action="' + esc(name) + '"';
    if (args.length) out += " data-args='" + esc(JSON.stringify(args)) + "'";
    return out;
  }

  var CXActions = {
    // Register a named action. Registered actions win over globals of the same
    // name, so a module can claim its handlers as it is extracted.
    register: function (name, fn) { registry[name] = fn; return CXActions; },
    unregister: function (name) { delete registry[name]; return CXActions; },
    // True if data-action="name" would resolve to something callable.
    has: function (name) { return resolve(name) != null; },
    dispatch: dispatch,
    act: act,
    _registry: registry,
  };

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', onClick);
  }
  if (typeof window !== 'undefined') { window.CXActions = CXActions; window.cxAct = act; }
  if (typeof module !== 'undefined' && module.exports) module.exports = CXActions;
})();
