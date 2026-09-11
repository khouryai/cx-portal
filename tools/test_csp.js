"use strict";
// Content-Security-Policy guard.
//
// The policy lives in index.html but names the backend origin, which is owned by
// config.js — the single file the Microsoft/IT cutover is supposed to change.
// If those two drift the app silently loses its backend under a policy that
// looks fine, so this suite pins them together, and pins the directives whose
// removal would quietly undo the hardening.
//   Run: node tools/test_csp.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

console.log("=== content-security-policy guard ===\n");

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const configJs = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");

const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i);
ok("index.html carries a Content-Security-Policy meta tag", !!m);

if (m) {
  const csp = m[1];
  const directive = (name) => {
    const d = csp.split(";").map((x) => x.trim()).find((x) => x === name || x.startsWith(name + " "));
    return d === undefined ? null : d.slice(name.length).trim();
  };

  // Directives that carry the actual hardening value.
  ok("default-src is locked to self", directive("default-src") === "'self'");
  ok("object-src is none (kills plugin-based injection)", directive("object-src") === "'none'");
  ok("base-uri is locked (stops <base> hijacking relative URLs)", directive("base-uri") === "'self'");
  ok("form-action is locked (stops form exfiltration)", directive("form-action") === "'self'");

  const scriptSrc = directive("script-src");
  ok("script-src is declared", typeof scriptSrc === "string");
  ok("script-src does not allow arbitrary hosts", scriptSrc && !/\*(?!\.)/.test(scriptSrc), scriptSrc);

  // The backend origin must match config.js exactly — the cutover changes both.
  const urlM = configJs.match(/SUPABASE_URL:\s*'([^']+)'/);
  ok("config.js declares SUPABASE_URL", !!urlM);
  if (urlM) {
    const origin = urlM[1].replace(/\/+$/, "");
    const wsOrigin = origin.replace(/^https:/, "wss:");
    const connect = directive("connect-src") || "";
    ok("connect-src allows the configured backend origin", connect.includes(origin),
      `csp connect-src="${connect}" config="${origin}"`);
    ok("connect-src allows the realtime websocket origin", connect.includes(wsOrigin),
      `csp connect-src="${connect}"`);
    ok("img-src allows the backend (signed storage URLs for photos/drawings)",
      (directive("img-src") || "").includes(origin));
  }

  // Entra ID sign-in origins. Present ahead of the cutover so a parallel run
  // across both issuers is possible; harmless while IDENTITY is 'supabase'.
  const ENTRA = "https://login.microsoftonline.com";
  ok("connect-src allows the Entra token endpoint", (directive("connect-src") || "").includes(ENTRA));
  ok("frame-src allows MSAL's silent-renewal iframe", (directive("frame-src") || "").includes(ENTRA));
  ok("form-action stays locked to self (MSAL redirects, it does not POST out)",
    directive("form-action") === "'self'");

  // The one external script the app still loads (see MIGRATION.md §4.1).
  const usesSheetJs = /cdn\.sheetjs\.com/.test(html.replace(m[0], ""));
  if (usesSheetJs) {
    ok("script-src allows the one remaining external CDN (cdn.sheetjs.com)",
      (scriptSrc || "").includes("https://cdn.sheetjs.com"));
  }

  // Blob URLs back the print/report path (print-report.js cxPrintFrame).
  ok("frame-src allows blob: (the hidden print iframe)", (directive("frame-src") || "").includes("blob:"));
  ok("worker-src allows blob: (pdf.js)", (directive("worker-src") || "").includes("blob:"));
}

// A reminder that the strict-CSP endgame is the inline-handler ratchet.
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "size_baseline.json"), "utf8"));
ok("the inline-handler ratchet is still in force (it is what unlocks a strict CSP)",
  baseline.inlineHandlers && typeof baseline.inlineHandlers.cap === "number");

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
