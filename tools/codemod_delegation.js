"use strict";
// AST-guided inline-handler codemod (Tier 3 Stage B).
// Converts safe inline onclick/onchange/oninput handlers to the delegated form
//   onclick → `${cxAct('fn', args)}`   onchange/oninput → `${cxOn('change'|'input', 'fn', args)}`
// (routed by cx-actions.js) — WITHOUT regenerating the file. It uses acorn ONLY
// to classify the *string context* of each handler (template literal vs single/
// double-quoted concat vs comment); because a handler's raw source is
// contiguous, the rewrite itself is a surgical text replacement, so formatting,
// CRLF, and everything else are byte-preserved.
//
// It is deliberately CONSERVATIVE — it transforms only handlers it can prove are
// behaviour-preserving and skips the rest, reporting why. A handler is converted
// only when ALL hold:
//   • it sits directly in a TEMPLATE-LITERAL quasi (so `${…}` is real interp
//     and `"` reliably delimits the attribute),
//   • it is a single call `IDENT(args)` — no `;`, no chaining, plain-identifier
//     callee,
//   • every arg is one of: a lone QUOTED `'${EXPR}'` (→ String(EXPR)), a pure
//     static string literal, a number / true / false / null, or a live-state
//     token this.value / this.checked / this / event (encoded as a $cx.* sentinel
//     the dispatcher substitutes at event time).
// UNQUOTED `${EXPR}` (renders as click-time code, e.g. a function reference),
// mixed args, call/`.find()` args, method-chain callees, and non-template
// context are all left exactly as-is.
//
//   node tools/codemod_delegation.js            # dry run: report only
//   node tools/codemod_delegation.js --apply    # write app.js
//   node tools/codemod_delegation.js --apply --limit N  # convert at most N (staged)
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "app.js");
const APPLY = process.argv.includes("--apply");
const SAMPLE = process.argv.includes("--sample");
const limIdx = process.argv.indexOf("--limit");
const LIMIT = limIdx !== -1 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;

const src = fs.readFileSync(FILE, "utf8");
const comments = [];
const ast = acorn.parse(src, { ecmaVersion: "latest", onComment: comments });

// ── context classification via a range index ────────────────────────────────
// Collect the smallest string-ish node covering an offset: TemplateElement
// (quasi text) → "template"; string Literal → "sq"/"dq". Comments → "comment".
const segs = [];
(function walk(node) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "TemplateElement") segs.push({ s: node.start, e: node.end, ctx: "template" });
  else if (node.type === "Literal" && typeof node.value === "string")
    segs.push({ s: node.start, e: node.end, ctx: src[node.start] === "'" ? "sq" : "dq" });
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v.type === "string") walk(v);
  }
})(ast);
for (const c of comments) segs.push({ s: c.start, e: c.end, ctx: "comment" });

function ctxAt(off) {
  let best = null;
  for (const seg of segs) {
    if (off >= seg.s && off < seg.e) {
      if (!best || (seg.e - seg.s) < (best.e - best.s)) best = seg;
    }
  }
  return best ? best.ctx : "code";
}

// ── handler scanning helpers ─────────────────────────────────────────────────
// Find the closing `"` of an attribute value, skipping `${…}` interpolations
// (which may legally contain `"`). Returns the index of the closing quote.
function findAttrEnd(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return i;
    if (c === "$" && s[i + 1] === "{") { i = skipInterp(s, i + 2); continue; }
    i++;
  }
  return -1;
}
// Given index just past `${`, return index just past the matching `}`,
// accounting for nested braces, strings, and nested template literals.
function skipInterp(s, i) {
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "'" || c === '"') { i = skipString(s, i + 1, c); continue; }
    else if (c === "`") { i = skipTemplate(s, i + 1); continue; }
    i++;
  }
  return i;
}
function skipString(s, i, q) {
  while (i < s.length) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) return i + 1; i++; }
  return i;
}
function skipTemplate(s, i) {
  while (i < s.length) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === "`") return i + 1;
    if (s[i] === "$" && s[i + 1] === "{") { i = skipInterp(s, i + 2); continue; }
    i++;
  }
  return i;
}

// Split an argument list on top-level commas (respecting strings, brackets,
// and `${…}` interpolations).
function splitArgs(s) {
  const out = []; let depth = 0, cur = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { const j = skipString(s, i + 1, c); cur += s.slice(i, j); i = j; continue; }
    if (c === "$" && s[i + 1] === "{") { const j = skipInterp(s, i + 2); cur += s.slice(i, j); i = j; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; cur += c; i++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; cur += c; i++; continue; }
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

// Classify one arg → the JS source to pass to cxAct(), or null if unsafe.
// Behaviour-preserving rules only:
//   • number / true / false / null literal → as-is (same value + type).
//   • pure static single-quoted string → as-is (same string).
//   • QUOTED lone interpolation '${EXPR}' → String(EXPR): the original inline
//     handler received the *string* produced by template interpolation, which is
//     exactly String(EXPR); wrapping preserves that even if EXPR is a number.
//   • UNQUOTED interpolation ${EXPR} is REJECTED: it renders EXPR's text raw into
//     the handler, so it is click-time *code* (e.g. a bare function reference),
//     NOT data — not equivalent to passing a value. Also reject bare identifiers.
function argToJs(arg) {
  const a = arg.trim();
  if (a === "") return null;
  // Live-state sentinels: encode this.value/this.checked/this/event so the
  // dispatcher substitutes the real values at event time (see cx-actions.js).
  if (a === "this.value") return "'$cx.value'";
  if (a === "this.checked") return "'$cx.checked'";
  if (a === "this") return "'$cx.el'";
  if (a === "event") return "'$cx.event'";
  if (/^-?\d+(\.\d+)?$/.test(a) || a === "true" || a === "false" || a === "null") return a;
  if (/^'[^'\\$]*'$/.test(a)) return a; // pure static single-quoted string
  const quoted = (a[0] === "'" && a[a.length - 1] === "'") || (a[0] === '"' && a[a.length - 1] === '"');
  if (!quoted) return null; // unquoted ${…} or bare identifier → click-time code
  const unq = a.slice(1, -1).trim();
  if (!(unq.startsWith("${") && unq.endsWith("}") && skipInterp(unq, 2) === unq.length)) return null; // not a lone interp
  const inner = unq.slice(2, -1).trim();
  if (inner === "" || /[()]|=>|\bevent\b|\bthis\b/.test(inner)) return null; // complex / side-effecting
  return "String(" + inner + ")";
}

// ── scan + build edits ───────────────────────────────────────────────────────
const edits = [];
const skip = {};
let converted = 0, seen = 0;
const samples = [];
const re = /on(click|change|input)="/g;
let m;
while ((m = re.exec(src)) !== null) {
  seen++;
  const ev = m[1];
  const openAt = m.index;
  const valStart = m.index + m[0].length;
  const ctx = ctxAt(openAt);
  if (ctx !== "template") { skip["context:" + ctx] = (skip["context:" + ctx] || 0) + 1; continue; }
  const end = findAttrEnd(src, valStart);
  if (end === -1) { skip["no-close"] = (skip["no-close"] || 0) + 1; continue; }
  const body = src.slice(valStart, end).trim();
  if (/;/.test(body)) { skip["chained(;)"] = (skip["chained(;)"] || 0) + 1; continue; }
  const call = body.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/s);
  if (!call) { skip["not-simple-call"] = (skip["not-simple-call"] || 0) + 1; continue; }
  const name = call[1];
  const argStr = call[2].trim();
  const args = argStr === "" ? [] : splitArgs(argStr);
  const jsArgs = args.map(argToJs);
  if (jsArgs.some((x) => x == null)) { skip["complex-arg"] = (skip["complex-arg"] || 0) + 1; continue; }
  // click → cxAct('fn', …);  change/input → cxOn('change'|'input', 'fn', …)
  const call2 = ev === "click"
    ? "cxAct(" + ["'" + name + "'"].concat(jsArgs).join(", ") + ")"
    : "cxOn('" + ev + "', " + ["'" + name + "'"].concat(jsArgs).join(", ") + ")";
  const replacement = "${" + call2 + "}";
  // validate the emitted expression parses
  try { acorn.parseExpressionAt(call2, 0, { ecmaVersion: "latest" }); }
  catch (e) { skip["emit-parse-fail"] = (skip["emit-parse-fail"] || 0) + 1; continue; }
  if (converted < LIMIT) {
    edits.push({ start: openAt, end: end + 1, text: replacement });
    if (samples.length < 8) samples.push({ from: src.slice(openAt, end + 1), to: replacement });
    converted++;
  }
}

console.log("=== delegation codemod (Tier 3 Stage B) ===\n");
console.log(`handlers seen (click/change/input): ${seen}`);
console.log(`convertible (template-context, safe): ${converted}`);
console.log("skipped:");
for (const [k, v] of Object.entries(skip).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

if (SAMPLE || !APPLY) {
  console.log("\nsample transforms:");
  for (const s of samples) console.log(`  - ${s.from}\n    → ${s.to}`);
}

if (APPLY && edits.length) {
  edits.sort((a, b) => b.start - a.start); // apply high→low so offsets stay valid
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // final safety: the whole file must still parse
  try { acorn.parse(out, { ecmaVersion: "latest" }); }
  catch (e) { console.error("\nABORT: transformed file does not parse:", e.message); process.exit(1); }
  fs.writeFileSync(FILE, out);
  console.log(`\nAPPLIED ${edits.length} conversion(s) to app.js.`);
} else {
  console.log(`\n(dry run — pass --apply to write; ${edits.length} edit(s) staged)`);
}
