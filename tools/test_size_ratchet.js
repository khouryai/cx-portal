"use strict";
// Monolith line-count ratchet (Tier 3 #11). The 50k-line app.js grew ~30%
// DURING the last modularization effort because new features kept landing in it.
// This gate reverses the incentive: a tracked file may never exceed its recorded
// cap, so new code must go in a new file and every extraction can only tighten
// the cap. Caps live in tools/size_baseline.json.
// Run: node tools/test_size_ratchet.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const baseline = require("./size_baseline.json");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// Count newlines the same way `wc -l` does, so caps match a familiar number
// regardless of CRLF vs LF.
function lineCount(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

console.log("=== monolith line-count ratchet (Tier 3 #11) ===\n");

for (const [file, cap] of Object.entries(baseline.files)) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, file), "utf8"); }
  catch (e) { ok(`${file} is readable`, false); continue; }

  const lines = lineCount(text);
  const within = lines <= cap;
  ok(`${file}: ${lines} ≤ cap ${cap}`, within);

  if (!within) {
    console.log(
      `      ✗ ${file} is ${lines} lines, ${lines - cap} over the ${cap} cap.\n` +
      `        The monolith may only SHRINK. Options:\n` +
      `          • land new code in a NEW file (wire it into index.html, sw.js,\n` +
      `            and tools/_load_app.js), or\n` +
      `          • extract something out of ${file} and LOWER its cap in\n` +
      `            tools/size_baseline.json in the same commit.\n` +
      `        Do NOT raise the cap to make this pass.`
    );
  } else if (lines < cap) {
    console.log(
      `      ℹ ${file} is ${cap - lines} under its cap — tighten it: set\n` +
      `        tools/size_baseline.json "${file}" to ${lines}.`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
