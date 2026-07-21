"use strict";
// Inline-handler ratchet (Tier 3 #11, Stage B). Inline on*= handlers force every
// handler onto the global scope and block a strict CSP + ES modules. They are
// being retired in favour of data-action (cx-actions.js). This gate makes the
// migration monotonic: the total inline-handler count across the tracked files
// may only go DOWN. It fails if the count rises (i.e. someone added a new inline
// handler instead of using data-action), and nudges you to tighten the cap once
// you have converted some.
// Run: node tools/test_inline_handler_ratchet.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const baseline = require("./size_baseline.json").inlineHandlers;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// Count inline event-handler attributes: whitespace + on<name>=. CRLF/LF-safe.
const RE = /\son[a-z]+=/g;
function countHandlers(text) {
  const m = text.match(RE);
  return m ? m.length : 0;
}

console.log("=== inline-handler ratchet (Tier 3 #11 Stage B) ===\n");

let total = 0;
for (const file of baseline.files) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, file), "utf8"); }
  catch (e) { ok(`${file} is readable`, false); continue; }
  const n = countHandlers(text);
  total += n;
  console.log(`  · ${file}: ${n} inline handlers`);
}

const cap = baseline.cap;
const within = total <= cap;
ok(`total inline handlers ${total} ≤ cap ${cap}`, within);

if (!within) {
  console.log(
    `      ✗ inline handlers rose to ${total} (cap ${cap}).\n` +
    `        New interactive markup must use data-action="fn" (routed by\n` +
    `        cx-actions.js) — e.g. \`<button \${act('fn', arg)}>\` — not\n` +
    `        onclick="fn(arg)". Convert, don't add.`
  );
} else if (total < cap) {
  console.log(
    `      ℹ ${cap - total} handlers below cap — tighten it: set\n` +
    `        tools/size_baseline.json inlineHandlers.cap to ${total}.`
  );
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
