"use strict";
// Unit test for cx-actions.js — the event-delegation dispatcher (Tier 3 #11).
// Runs headless: fakes elements with getAttribute and exercises dispatch()
// directly (no real DOM), covering the registry path, the window.* global
// fallback, arg parsing, and the unresolved-action path.
// Run: node tools/test_cx_actions.js

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// A minimal element stand-in: only getAttribute is used by dispatch().
function el(attrs) {
  return { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
}

const CXActions = require("../cx-actions.js");

console.log("=== cx-actions event-delegation dispatcher ===\n");

ok("dispatch is a function", typeof CXActions.dispatch === "function");
ok("register is a function", typeof CXActions.register === "function");

// 1) Registered action is invoked with parsed args + trailing context object.
let got = null;
CXActions.register("doThing", function (a, b, ctx) { got = { a, b, ctx, self: this }; });
const e1 = el({ "data-action": "doThing", "data-args": '["x", 7]' });
const ran1 = CXActions.dispatch(e1, { type: "click" });
ok("dispatch returns true when handled", ran1 === true);
ok("registered handler received JSON args", got && got.a === "x" && got.b === 7);
ok("handler received { el, event } context last", got && got.ctx && got.ctx.el === e1 && got.ctx.event.type === "click");
ok("handler `this` is the element", got && got.self === e1);

// 2) data-arg (single string) form.
let single = null;
CXActions.register("single", function (v) { single = v; });
CXActions.dispatch(el({ "data-action": "single", "data-arg": "hello" }), {});
ok("data-arg passes a single string arg", single === "hello");

// 3) No args → handler still called (context only).
let calledNoArgs = false;
CXActions.register("noArgs", function (ctx) { calledNoArgs = ctx && ctx.el != null; });
CXActions.dispatch(el({ "data-action": "noArgs" }), {});
ok("no-arg action is invoked with just context", calledNoArgs === true);

// 4) has() reflects registration.
ok("has() true for registered action", CXActions.has("doThing") === true);
ok("has() false for unknown action", CXActions.has("ghost") === false);

// 5) registered action wins over a same-named global.
global.window = { winOnly: function () { return "GLOBAL"; }, sharedName: function () { return "GLOBAL"; } };
let sharedFrom = null;
CXActions.register("sharedName", function () { sharedFrom = "REGISTRY"; });
CXActions.dispatch(el({ "data-action": "sharedName" }), {});
ok("registered handler wins over window.* of same name", sharedFrom === "REGISTRY");

// 6) global window.* fallback when nothing registered.
let winCalled = false;
global.window.winOnly = function () { winCalled = true; };
ok("has() sees window.* fallback", CXActions.has("winOnly") === true);
CXActions.dispatch(el({ "data-action": "winOnly" }), {});
ok("falls back to window.<name> when unregistered", winCalled === true);

// 7) unresolved action → returns false, does not throw.
delete global.window;
let threw = false, resUnres = null;
try { resUnres = CXActions.dispatch(el({ "data-action": "definitelyMissing" }), {}); }
catch (_) { threw = true; }
ok("unresolved action does not throw", threw === false);
ok("unresolved action returns false", resUnres === false);

// 8) element without data-action → no-op false.
ok("element without data-action returns false", CXActions.dispatch(el({}), {}) === false);
ok("null element returns false", CXActions.dispatch(null, {}) === false);

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
