"use strict";
// Dead-CSS audit (Tier 3 #13) — REPORT ONLY, never a build gate.
// The app ships ~15.5k lines of CSS across four global stylesheets with no
// scoping, so dead rules accumulate silently. This tool lists class selectors
// whose class name is never referenced anywhere in the JS/HTML source, to guide
// (not perform) cleanup.
//
// Heuristic + conservative by design: a class is reported ONLY when its literal
// name appears nowhere in the source. Classes built dynamically (e.g.
// 'badge-' + status) can therefore show up as false positives — this is a
// starting worklist for a human, not an automatic deleter. Nothing is modified.
//
// Run: node tools/audit_css_unused.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CSS_FILES = ["styles.css", "photos.css", "trackplan.css", "search.css"];
const SRC_FILES = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f))
  .concat(["ui_gallery.html"].map((f) => path.join("tools", f)));

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

// Strip /* comments */ then take only the selector text (everything before each
// `{`), so we extract class names from selectors, not from property values.
function definedClasses(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = new Map(); // class -> occurrence count
  // Walk block by block: selector list is the text between `}` (or start) and `{`.
  const re = /(^|})([^{}]*)\{/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    const selector = m[2];
    const cre = /\.(-?[_a-zA-Z][\w-]*)/g;
    let c;
    while ((c = cre.exec(selector)) !== null) {
      classes.set(c[1], (classes.get(c[1]) || 0) + 1);
    }
  }
  return classes;
}

// One big lowercased blob of all source; substring test = "referenced anywhere".
const sourceBlob = SRC_FILES.map(read).join("\n");

console.log("=== dead-CSS audit (Tier 3 #13) — report only ===\n");
console.log(`Source scanned: ${SRC_FILES.length} JS/HTML files (${sourceBlob.length} chars)\n`);

let totalDefined = 0;
const deadByFile = {};
let deadTotal = 0;

for (const file of CSS_FILES) {
  const css = read(file);
  if (!css) continue;
  const classes = definedClasses(css);
  totalDefined += classes.size;
  const dead = [];
  for (const cls of classes.keys()) {
    if (!sourceBlob.includes(cls)) dead.push(cls);
  }
  dead.sort();
  deadByFile[file] = dead;
  deadTotal += dead.length;
  console.log(`${file}: ${classes.size} class selectors, ${dead.length} never referenced in source`);
}

console.log(`\nTotal: ${totalDefined} class selectors defined, ${deadTotal} with no literal reference.\n`);

for (const file of CSS_FILES) {
  const dead = deadByFile[file] || [];
  if (!dead.length) continue;
  console.log(`── ${file} — likely-dead classes (first 40 of ${dead.length}) ──`);
  console.log("  " + dead.slice(0, 40).map((c) => "." + c).join("  "));
  console.log("");
}

console.log(
  "NOTE: false positives are expected for classes assembled at runtime\n" +
  "(e.g. `'status-' + s`). Verify each before removing. This tool never edits."
);
// Report-only: always exit 0 so it can run informationally without gating CI.
process.exit(0);
