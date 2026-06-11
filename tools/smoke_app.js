// Headless boot/smoke test for the cx-portal bundle.
//
// Loads data.js → icons.js → format.js → cx-state.js → app.js into a Node vm
// under a permissive DOM/lib shim (see tools/_load_app.js) and asserts the whole
// thing evaluates top-to-bottom without throwing, that each extracted module
// provides its global, and that the DOMContentLoaded bootstrap registered (but
// is NOT fired — no live init/network). This is the load-time safety net for the
// strangler module split: extract a leaf, re-run, a load regression surfaces.
//
// Run:  node tools/smoke_app.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

console.log("=== app.js headless boot/smoke ===\n");

const { sandbox, domEvents, loadError, loadErrorFile, scripts } = loadApp();

ok(`page scripts evaluate top-to-bottom without throwing (${scripts.join(" → ")})`,
   !loadError, loadError && (loadErrorFile + ": " + loadError.message +
     (loadError.stack ? "\n    " + loadError.stack.split("\n")[1] : "")));

ok("data.js set window.PORTAL_DATA",
   sandbox.window.PORTAL_DATA && typeof sandbox.window.PORTAL_DATA === "object");
ok("icon() global provided by icons.js",
   typeof sandbox.icon === "function" && typeof sandbox.window.icon === "function");
ok("escapeHtml() global provided by format.js",
   typeof sandbox.escapeHtml === "function" && typeof sandbox.window.escapeHtml === "function");
ok("cx* state helpers provided by cx-state.js",
   typeof sandbox.cxSkeleton === "function" && typeof sandbox.cxEmpty === "function" &&
   typeof sandbox.cxError === "function");
ok("compute core provided by compute.js",
   ["getStatusBadge", "getPriorityPill", "_wgtStat", "_amComputeStatus", "_amComputeCompletion",
    "_p6WeightedCompletion", "_trpStatusCounts", "_tcWeightFor", "_actWeightFor"]
     .every((f) => typeof sandbox[f] === "function"));

// Bootstrap wiring: the DOMContentLoaded handler must have been registered
// (proves execution reached the bootstrap) — but NOT fired (no live init/network).
ok("DOMContentLoaded bootstrap registered",
   Array.isArray(domEvents.DOMContentLoaded) && domEvents.DOMContentLoaded.length > 0,
   `handlers: ${(domEvents.DOMContentLoaded || []).length}`);

// Top-level (non-hoisted) side effect near the start: the Supabase client init.
ok("Supabase client initialized (_sb set at top level)",
   sandbox._sb !== undefined && sandbox._sb !== null);

// Representative app.js helpers still defined (smoke — hoisted, mainly a parse guard).
for (const sym of ["escapeHtml", "cxSkeleton", "cxEmpty", "cxError"]) {
  ok(`function \`${sym}\` defined`, typeof sandbox[sym] === "function");
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
