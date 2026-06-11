// Characterization tests for the test-report key normalization in app.js
// (real functions via tools/_load_app.js):
//   _trpCleanReportValue(v) — whitespace collapse + trim
//   _trpReportKey(v)        — canonical report key (CDRL prefix stripped, uppercased)
//   _trpInferCdrlNumber(v)  — does a raw value look like a CDRL number?
//   _trpRecordKeys(r)       — deduped keys for a report record
//   _trpFindRecordByText(v) — record lookup (module state injected via context)
//
// These drive the Test Report ↔ Test Register linking; mismatched keys mean
// orphaned report rows. Run: node tools/test_trp_keys.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}
function eq(name, got, want) { ok(`${name} (=${JSON.stringify(want)})`, got === want, `got ${JSON.stringify(got)}`); }

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load —", loadErrorFile, loadError.message); process.exit(1); }
const { _trpCleanReportValue, _trpReportKey, _trpInferCdrlNumber, _trpRecordKeys, _trpFindRecordByText } = sandbox;
for (const [n, f] of Object.entries({ _trpCleanReportValue, _trpReportKey, _trpInferCdrlNumber, _trpRecordKeys, _trpFindRecordByText })) {
  if (typeof f !== "function") { console.error(`FATAL: ${n} not found`); process.exit(1); }
}

console.log("=== test-report key normalization characterization ===\n");

// ── _trpCleanReportValue ──
console.log("_trpCleanReportValue:");
eq("  null/undefined → ''", _trpCleanReportValue(null), "");
eq("  collapses internal whitespace", _trpCleanReportValue("a   b\t c"), "a b c");
eq("  trims ends", _trpCleanReportValue("  x  "), "x");
eq("  coerces non-strings", _trpCleanReportValue(42), "42");

// ── _trpReportKey ──
console.log("\n_trpReportKey:");
eq("  empty → ''", _trpReportKey(""), "");
eq("  plain value uppercased", _trpReportKey("Report a"), "REPORT A");
eq("  strips 'CDRL ' prefix", _trpReportKey("CDRL 9.05.821"), "9.05.821");
eq("  strips 'cdrl#' (case-insensitive + symbol)", _trpReportKey("cdrl#9.05.821"), "9.05.821");
eq("  strips 'CDRL: '", _trpReportKey("CDRL: 9.05.821"), "9.05.821");
eq("  strips 'CDRL-'", _trpReportKey("CDRL-9.05.821"), "9.05.821");
eq("  bare 'CDRL' → ''", _trpReportKey("CDRL"), "");
eq("  no word boundary: 'CDRLABC' → 'ABC' (prefix strip is literal)", _trpReportKey("CDRLABC"), "ABC");
eq("  same key from cdrl-prefixed and bare forms",
   _trpReportKey("CDRL 9.05.821"), _trpReportKey("9.05.821"));

// ── _trpInferCdrlNumber ──
console.log("\n_trpInferCdrlNumber:");
eq("  empty → null", _trpInferCdrlNumber(""), null);
eq("  'CDRL …' counts (returns cleaned value)", _trpInferCdrlNumber(" CDRL  9.05.821 "), "CDRL 9.05.821");
eq("  dotted number counts", _trpInferCdrlNumber("9.05.821 System Test"), "9.05.821 System Test");
eq("  plain title → null", _trpInferCdrlNumber("Some Report"), null);
eq("  bare integer (no dots) → null", _trpInferCdrlNumber("42"), null);

// ── _trpRecordKeys ──
console.log("\n_trpRecordKeys:");
eq("  cdrl_number + title that normalize identically dedupe to one key",
   JSON.stringify(_trpRecordKeys({ cdrl_number: "CDRL 9.05.821", title: "9.05.821" })),
   JSON.stringify(["9.05.821"]));
eq("  distinct fields → two keys",
   JSON.stringify(_trpRecordKeys({ cdrl_number: "9.05.821", title: "Power SAT Report" })),
   JSON.stringify(["9.05.821", "POWER SAT REPORT"]));
eq("  missing fields filtered out", JSON.stringify(_trpRecordKeys({})), JSON.stringify([]));
eq("  null record → no keys", JSON.stringify(_trpRecordKeys(null)), JSON.stringify([]));

// ── _trpFindRecordByText (module state via shared context) ──
console.log("\n_trpFindRecordByText:");
vm.runInContext(`_testReports = ${JSON.stringify([
  { id: 1, cdrl_number: "CDRL 9.05.821", title: "Power SAT Report" },
  { id: 2, cdrl_number: null, title: "Comms FAT" },
])};`, ctx);
eq("  matches via cdrl (prefix-insensitive)", _trpFindRecordByText("9.05.821")?.id, 1);
eq("  matches via title (case-insensitive)", _trpFindRecordByText("comms fat")?.id, 2);
eq("  no match → null", _trpFindRecordByText("does not exist"), null);
eq("  empty text → null", _trpFindRecordByText(""), null);

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
