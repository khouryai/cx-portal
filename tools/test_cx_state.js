// Headless unit test for cx-state.js — cxSkeleton / cxEmpty / cxError, extracted
// from app.js in the P3-1 strangler split (seam #3). These depend on the global
// icon() (icons.js) and escapeHtml() (format.js) at runtime, so we load those
// modules into the same context first. Run: node tools/test_cx_state.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const ROOT = path.resolve(__dirname, "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
// Load runtime deps in the same index.html order, then the unit under test.
for (const f of ["format.js", "icons.js", "cx-state.js"]) {
  new vm.Script(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f }).runInContext(ctx);
}
const { cxSkeleton, cxEmpty, cxError } = ctx;

console.log("=== cx-state.js unit ===\n");

ok("all three are functions",
   [cxSkeleton, cxEmpty, cxError].every((f) => typeof f === "function"));
ok("published on window", ctx.window.cxSkeleton === cxSkeleton && ctx.window.cxError === cxError);

// cxSkeleton
ok("cxSkeleton default = 3 skeleton lines",
   (cxSkeleton().match(/cx-skel-line/g) || []).length === 3);
ok("cxSkeleton(n) honors row count", (cxSkeleton(5).match(/cx-skel-line/g) || []).length === 5);
ok("cxSkeleton is aria-hidden + aria-busy",
   cxSkeleton().includes('aria-hidden="true"') && cxSkeleton().includes('aria-busy="true"'));

// cxEmpty
const empty = cxEmpty({ icon: "inbox", title: "Nothing here", message: "No <b>items</b>" });
ok("cxEmpty renders docs-empty container", empty.includes('class="docs-empty"'));
ok("cxEmpty renders an icon via icon()", empty.includes('docs-empty-icon') && empty.includes("<svg"));
ok("cxEmpty escapes user text (XSS-safe)",
   empty.includes("No &lt;b&gt;items&lt;/b&gt;") && !empty.includes("<b>items</b>"));
ok("cxEmpty with no opts still returns container", cxEmpty().includes("docs-empty"));

// cxError
const err = cxError({ message: "Boom <script>", retry: "doRetry()" });
ok("cxError has role=alert", err.includes('role="alert"'));
ok("cxError escapes the message", err.includes("Boom &lt;script&gt;"));
ok("cxError renders a retry button when retry given", err.includes("cx-error-retry"));
ok("cxError default message when none given",
   cxError().includes("Something went wrong while loading this."));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
