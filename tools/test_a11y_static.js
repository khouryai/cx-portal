// Static a11y guard (P4-2). Headless invariants that don't need a browser:
//  1. No icon/glyph-only <button> without an accessible name in any HTML the
//     app ships or generates (index.html + the template literals in the JS).
//  2. index.html document structure: lang, skip link, <main> landmark wrapping
//     every page section, labelled primary nav.
//  3. Token contrast: --text-muted / --text-subtle clear WCAG AA (4.5:1) on
//     --surface and --surface-2 — values parsed live from the canonical sheet.
//  4. icon() SVGs are aria-hidden; global prefers-reduced-motion rule exists.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  FAIL: " + msg); }
}
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");

// ---- 1. unnamed icon/glyph-only buttons ------------------------------------
const HTML_SOURCES = ["index.html", "app.js", "photos.js", "markup.js", "perms-admin.js", "team.js", "readiness.js"];
function unnamedButtons(src) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1], inner = m[2];
    if (/aria-label|aria-labelledby|title\s*=/.test(attrs)) continue;
    const noSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, "");
    // a non-icon() ${expr} may render text — give it the benefit of the doubt
    if (/\$\{(?!icon\()/.test(noSvg)) continue;
    const text = noSvg
      .replace(/<[^>]+>/g, " ")
      .replace(/\$\{icon\([^)]*\)\}/g, "")
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      .replace(/[\s ]+/g, " ")
      .trim();
    const glyphOnly = text.length <= 2 && /^[✓✗×←→↻⌫+–\-…]*$/.test(text);
    if (text === "" || glyphOnly) out.push(src.slice(0, m.index).split("\n").length);
  }
  return out;
}
for (const f of HTML_SOURCES) {
  if (!fs.existsSync(path.join(__dirname, "..", f))) continue;
  const hits = unnamedButtons(read(f));
  assert(hits.length === 0,
    `${f}: ${hits.length} button(s) with no accessible name (lines ${hits.join(", ")}) — add aria-label`);
}

// ---- 2. document structure --------------------------------------------------
const html = read("index.html");
assert(/<html lang="en">/.test(html), "html has lang attribute");
assert(html.includes('<a class="skip-link" href="#main-content">'), "skip link present");
const mainOpen = html.indexOf('<main id="main-content">');
const mainClose = html.indexOf("</main>");
assert(mainOpen > -1 && mainClose > mainOpen, "<main id=\"main-content\"> landmark present");
let outside = 0;
const secRe = /<section class="page/g;
let sm;
while ((sm = secRe.exec(html))) if (sm.index < mainOpen || sm.index > mainClose) outside++;
assert(outside === 0, outside + " page section(s) outside <main>");
assert(/<nav id="sidenav" aria-label=/.test(html), "primary nav is labelled");

// ---- 2b. static form controls have an accessible name ------------------------
// every visible input/select/textarea must have aria-label, title, a label[for]
// pointing at it, or be one of the known label-WRAPPED controls (sign-in card).
const WRAPPED = new Set(["auth-email", "auth-password", "cp-new-password", "cp-confirm-password"]);
const ctrlRe = /<(input|select|textarea)\b[^>]*>/g;
let cm2, unlabeled = [];
while ((cm2 = ctrlRe.exec(html))) {
  const tag = cm2[0];
  if (/type="(hidden|checkbox)"/.test(tag)) continue;
  if (/aria-label|aria-labelledby|title\s*=/.test(tag)) continue;
  const idm = tag.match(/\bid="([^"]+)"/);
  if (!idm) { unlabeled.push("(no id) " + tag.slice(0, 60)); continue; }
  if (WRAPPED.has(idm[1])) continue;
  if (!html.includes(`for="${idm[1]}"`)) unlabeled.push(idm[1]);
}
assert(unlabeled.length === 0,
  "index.html controls with no accessible name: " + unlabeled.join(", "));

// ---- 2c. heading grammar: one hero pattern on every page ---------------------
// every static .page-hero either carries the canonical eyebrow+title pair or a
// *-hero-content container that renderPageHero() fills at runtime.
const sections = html.split(/<section class="page[^"]*" id="page-/).slice(1);
const badHeroes = [];
for (const sec of sections) {
  const pid = sec.slice(0, sec.indexOf('"'));
  const heroIdx = sec.indexOf('class="page-hero"');
  if (heroIdx === -1) continue; // pages without a static hero (login, dashboard landing)
  const head = sec.slice(heroIdx, heroIdx + 900);
  const canonical = head.includes('class="page-eyebrow"') && head.includes('class="page-title"');
  const dynamic = /<div id="[a-z0-9-]*hero[a-z0-9-]*-content"/.test(head);
  if (!canonical && !dynamic) badHeroes.push(pid);
}
assert(badHeroes.length === 0,
  "page heroes missing the canonical eyebrow+title grammar: " + badHeroes.join(", "));
// role pills are retired from heroes (they were the per-page inconsistency)
assert(!/class="role-badge/.test(html), "no role-badge pills left in static heroes");
const appSrc = read("app.js");
assert(appSrc.includes('class="page-eyebrow"') && appSrc.includes('<h1 class="page-title">'),
  "renderPageHero emits the canonical page-eyebrow/page-title classes");
assert(!/renderPageHero\(\{[^}]*role:\s*\{/.test(appSrc.replace(/\n/g, " ")),
  "no renderPageHero caller passes a role pill");
assert(read("photos.js").includes('class="page-title">Photos'),
  "photos page has its hero heading");

// ---- 3. text-token contrast (recomputed from the live sheet) ----------------
const css = read("styles.css");
const sheet = css.match(/:root\s*\{([\s\S]*?)\n\}/);
assert(!!sheet, "canonical :root sheet found");
const tok = name => (sheet[1].match(new RegExp(name + ":\\s*(#[0-9a-fA-F]{6})")) || [])[1];
function lum(hex) {
  const c = hex.slice(1);
  const [r, g, b] = [0, 2, 4].map(i => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const surfaces = [["--surface", tok("--surface")], ["--surface-2", tok("--surface-2")]];
for (const tname of ["--text", "--text-muted", "--text-subtle"]) {
  const v = tok(tname);
  assert(!!v, tname + " resolvable from sheet");
  if (!v) continue;
  for (const [sname, sv] of surfaces) {
    const r = ratio(v, sv);
    assert(r >= 4.5, `${tname} ${v} on ${sname} ${sv} = ${r.toFixed(2)} (< 4.5 AA)`);
  }
}

// ---- 4. icons + motion -------------------------------------------------------
assert(read("icons.js").includes('aria-hidden="true"'), "icon() SVGs are aria-hidden");
assert(css.includes("prefers-reduced-motion: reduce") &&
       /prefers-reduced-motion[\s\S]*animation-duration: 0\.01ms !important/.test(css),
  "global prefers-reduced-motion rule present");
assert(css.includes(".skip-link:focus"), "skip-link focus style present");
assert(css.includes("outline: var(--focus-ring);"), ":focus-visible consumes --focus-ring");

console.log(`test_a11y_static: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
