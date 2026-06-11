// Headless unit test for format.js — escapeHtml + getLocationCode, extracted
// from app.js in the P3-1 strangler split (seam #2). Run: node tools/test_format.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

// format.js ends with `window.escapeHtml = ...`, so it needs a `window` global.
const ctx = vm.createContext({ console });
ctx.window = ctx;
new vm.Script(fs.readFileSync(path.resolve(__dirname, "..", "format.js"), "utf8"), { filename: "format.js" })
  .runInContext(ctx);
const { escapeHtml, getLocationCode } = ctx;

console.log("=== format.js unit ===\n");

ok("escapeHtml + getLocationCode are functions",
   typeof escapeHtml === "function" && typeof getLocationCode === "function");
ok("published on window (same refs)",
   ctx.window.escapeHtml === escapeHtml && ctx.window.getLocationCode === getLocationCode);

// escapeHtml
ok("escapes all five HTML-sensitive chars",
   escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#039;");
ok("escapes a real XSS payload",
   escapeHtml('<img src=x onerror="alert(1)">') ===
   "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
ok("null/undefined → empty string", escapeHtml(null) === "" && escapeHtml(undefined) === "");
ok("coerces non-strings", escapeHtml(42) === "42" && escapeHtml(0) === "0");
ok("leaves safe text untouched", escapeHtml("Plain text 123") === "Plain text 123");

// getLocationCode
ok("extracts leading word token", getLocationCode("W40 Millbrae Station") === "W40");
ok("returns input when no separator", getLocationCode("W40") === "W40");
ok("empty/falsy → empty string", getLocationCode("") === "" && getLocationCode(null) === "");

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
