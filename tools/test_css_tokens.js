// Design-token sheet guard (P3-4).
// styles.css historically accreted FOUR competing bare `:root {}` blocks that
// redefined the same custom properties (--good had three different values; the
// winner was whichever block came last). They were consolidated into ONE
// canonical sheet at the top of the file on 2026-06-12. This suite keeps it
// that way: one bare :root, no duplicate definitions inside it, the key token
// families present, and the file's CRLF convention intact.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  FAIL: " + msg); }
}

const cssPath = path.join(__dirname, "..", "styles.css");
const raw = fs.readFileSync(cssPath, "utf8");
assert(raw.includes("\r\n"), "styles.css keeps CRLF line endings");

const css = raw.replace(/\r\n/g, "\n");

// ---- collect every bare `:root {` block (attribute variants like
// :root[data-tr-*] are fine — they're conditional theming, not the sheet)
const blocks = [];
const re = /(^|\n):root\s*\{/g;
let m;
while ((m = re.exec(css))) {
  const open = m.index + m[0].length;
  let depth = 1, i = open;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  blocks.push(css.slice(open, i - 1));
}
assert(blocks.length === 1,
  "exactly ONE bare :root token sheet (found " + blocks.length + ") — add tokens to the canonical sheet at the top, don't open a new :root block");

const body = blocks[0] || "";
const defs = new Map();
const dupes = [];
const propRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
let p;
while ((p = propRe.exec(body))) {
  if (defs.has(p[1])) dupes.push(p[1]);
  defs.set(p[1], p[2].trim().replace(/\s+/g, " "));
}
assert(dupes.length === 0, "no duplicate token definitions in the sheet: " + dupes.join(", "));
assert(defs.size >= 100, "token sheet is the full catalog (" + defs.size + " >= 100 tokens)");

// ---- key tokens by family, with the values the app was consolidated onto
assert(defs.get("--hitachi-red") === "#e60012", "--hitachi-red is the Hitachi brand red");
assert(defs.get("--primary") === "#e60012", "--primary aliases the brand red");
assert(defs.has("--surface") && defs.has("--text") && defs.has("--text-muted") &&
       defs.has("--border") && defs.has("--border-strong"),
  "semantic surface/text/border tokens present");
assert(defs.get("--good") === "#0d7a4f" && defs.get("--bad") === "#c01017" &&
       defs.get("--warn") === "#a8550a" && defs.get("--info") === "#1d4eaf" &&
       defs.has("--pending"),
  "status tokens present at the production-visual-layer values (last-wins winners)");
assert(defs.has("--good-dot") && defs.has("--warn-dot") && defs.has("--bad-dot") &&
       defs.has("--info-dot") && defs.has("--pending-dot"),
  "status mid-dot tokens present");
["--gray-900", "--gray-700", "--gray-500", "--gray-300", "--gray-100", "--gray-50"]
  .forEach(n => assert(defs.has(n), n + " present (warm neutral scale)"));
assert(defs.has("--slate-900") && defs.has("--slate-50"), "slate scale present");
assert(defs.has("--f-ui") && defs.has("--f-display"), "typography tokens present");
assert(defs.has("--radius-sm") && defs.has("--radius-xl") && defs.has("--shadow-md") &&
       defs.has("--easing"),
  "shape/elevation/motion tokens present");
["--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6"]
  .forEach(n => assert(defs.has(n), n + " present (spacing scale)"));
assert(defs.has("--focus-ring") && defs.has("--focus-ring-offset"), "focus-ring tokens present");
assert(defs.has("--disc-tc") && defs.has("--disc-default-bg"), "lookahead discipline tokens present");

// ---- the global focus style consumes the token (a11y invariant for P4-2)
assert(css.includes("outline: var(--focus-ring);"),
  ":focus-visible rule uses var(--focus-ring)");

// ---- no canonical token redefined OUTSIDE the sheet (scoped element-level
// custom props are allowed; redefining sheet names at :root scope is not —
// this is what created the four-block sprawl)
const sheetEnd = css.indexOf(body) + body.length;
const tail = css.slice(sheetEnd);
const leaked = [];
for (const name of ["--good", "--bad", "--warn", "--info", "--gray-900", "--text-muted",
                    "--shadow-md", "--radius-md", "--hitachi-red"]) {
  // a definition of these names anywhere later in the file is sprawl returning
  const defRe = new RegExp("(^|[{;\\s])" + name.replace(/-/g, "\\-") + "\\s*:(?!\\s*var\\()", "m");
  if (defRe.test(tail.replace(/var\(--[\w-]+\)/g, ""))) {
    // allow var() references; only flag definitions (name followed by colon)
    const lines = tail.split("\n").filter(l => new RegExp("^\\s*" + name + "\\s*:").test(l));
    if (lines.length) leaked.push(name);
  }
}
assert(leaked.length === 0,
  "core tokens not redefined outside the canonical sheet: " + leaked.join(", "));

console.log(`test_css_tokens: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
