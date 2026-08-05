"use strict";
// Delegation-argument escaping guard.
//
// cxAct/cxOn/cxSeq HTML-escape their own args on the way into data-args, and
// the browser un-escapes them on the way out. Escaping a value a SECOND time
// before handing it over ("safe" out of habit) survives the round-trip as
// literal entity text: escapeHtml("PS&TP") → "PS&amp;TP" is what the handler
// receives, so any lookup against the real value silently misses. That is how
// every PS&TP activity in the Test Register came back "Activity not found" —
// the row buttons carried Phase||W40||PS&amp;TP||… while the register keyed on
// Phase||W40||PS&TP||….
//
// Escaping is still right for a value interpolated straight into markup
// (`value="${escapeHtml(x)}"`, `title="${escapeHtml(x)}"`, display text) — the
// rule is narrow: NOT inside a cxAct/cxOn/cxSeq argument list.
// Run: node tools/test_action_args.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILES = fs.readdirSync(ROOT).filter(f => f.endsWith(".js") && f !== "chart.umd.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "\n" + extra : ""}`); }
}

// Walk a cx*(...) call from its opening paren to its matching close, tracking
// nesting so we only read that one argument list.
function callArgs(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return "";
}

console.log("=== delegation arg escaping (no escapeHtml inside cxAct/cxOn/cxSeq args) ===\n");

const offenders = [];
const RE = /\bcx(?:Act|On|Seq)\s*\(/g;
let scanned = 0;
for (const file of FILES) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    scanned++;
    const args = callArgs(text, m.index + m[0].length - 1);
    if (/\bescapeHtml\s*\(/.test(args)) {
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      offenders.push(`${file}:${line}  ${m[0].slice(0, -1)}(${args.slice(0, 90)}…`);
    }
  }
}

ok(`scanned ${scanned} delegation call sites across ${FILES.length} files`, scanned > 0);
ok("no escapeHtml() inside a delegation argument list", offenders.length === 0,
  offenders.map(o => "      " + o).join("\n") +
  "\n      → pass the RAW value; cxAct/cxOn/cxSeq escape it for the attribute.");

// The Test Register row is the site this guard was written for — pin it so a
// future refactor can't quietly reintroduce the escape.
const appjs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
ok("Test Register activity rows pass the raw activity key",
  /const rowKey = a\.key;/.test(appjs) && !/const safeKey = escapeHtml\(a\.key\);[\s\S]{0,600}_amOpenDrilldown/.test(appjs));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
