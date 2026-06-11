// Headless unit test for icons.js — the SVG icon system extracted from app.js
// in the P3-1 strangler split. Verifies icon() renders correctly from its new
// home and stays a shared global. Run: node tools/test_icons.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

// icons.js is a classic browser script that ends with `window.icon = icon`,
// so it needs a `window` global. Load it into a vm context with window === ctx.
const ctx = vm.createContext({ console });
ctx.window = ctx;
new vm.Script(fs.readFileSync(path.resolve(__dirname, "..", "icons.js"), "utf8"), { filename: "icons.js" })
  .runInContext(ctx);
const icon = ctx.icon;

console.log("=== icons.js unit ===\n");

ok("icon is a function", typeof icon === "function");
ok("published as window.icon (same ref)", ctx.window.icon === icon);

const search = icon("search");
ok("known glyph renders an <svg>", /^<svg\b/.test(search) && /<\/svg>$/.test(search.trim()));
ok("uses currentColor (themeable)", search.includes('stroke="currentColor"'));
ok("aria-hidden + focusable=false (decorative)",
   search.includes('aria-hidden="true"') && search.includes('focusable="false"'));
ok("embeds the glyph body", search.includes('cx="11"') && search.includes("m21 21-4.35-4.35"));

ok("unknown glyph returns empty string", icon("nope") === "");
ok("default size is 1em", icon("x").includes('width="1em"') && icon("x").includes('height="1em"'));

const styled = icon("trash", { cls: "danger", size: "2em" });
ok("opts.cls appends to class", styled.includes('class="icon-svg danger"'));
ok("opts.size sets width/height", styled.includes('width="2em"') && styled.includes('height="2em"'));

// Spot-check a representative spread of glyphs all render (catches a truncated map).
const someGlyphs = ["search", "link", "camera", "trash", "save", "undo", "redo", "calendar", "user", "settings"];
ok(`representative glyphs (${someGlyphs.length}) all render`,
   someGlyphs.every((g) => /^<svg\b/.test(icon(g))),
   someGlyphs.find((g) => !/^<svg\b/.test(icon(g))));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
