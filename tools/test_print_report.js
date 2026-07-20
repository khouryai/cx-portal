// Unit + integration test for the shared branded print template (print-report.js)
// and its adoption by every module export. Run: node tools/test_print_report.js
"use strict";

const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load failed in", loadErrorFile, "\n", loadError.message); process.exit(1); }

console.log("=== print-report.js shared branded template ===\n");

// ── The shell itself ─────────────────────────────────────────────────────────
const shell = sandbox.cxReportShell;
ok("cxReportShell is exposed", typeof shell === "function");
const doc = shell({ docType: "Field Report", title: "Daily Test Log", refNo: "Jul 9, 2026", bodyHtml: "<p>hi</p>" });
ok("produces a full HTML document", /^<!DOCTYPE html>/.test(doc) && doc.includes("</html>"));
ok("includes the HITACHI letterhead", doc.includes(">HITACHI<"));
ok("includes the standard project block", doc.includes("Contract 49GH-110") && doc.includes("BART CBTC System"));
ok("renders the doc type eyebrow + title", doc.includes("Field Report") && doc.includes("Daily Test Log"));
ok("renders the ref chip", doc.includes("cxr-ref-chip") && doc.includes("Jul 9, 2026"));
ok("includes a running footer with generated timestamp", doc.includes("cxr-foot") && doc.includes("Generated"));
ok("embeds the shared CSS (no unresolved var() tokens)", doc.includes(".cxr-kv") && !/var\(--/.test(doc));
ok("uses concrete Hitachi red hex, not a token", doc.includes("#E60012"));
ok("auto-print script present by default", doc.includes("window.print()"));
ok("autoPrint:false omits the print script", !shell({ bodyHtml: "x", autoPrint: false }).includes("window.print()"));
ok("landscape option sets landscape @page", shell({ bodyHtml: "x", landscape: true }).includes("A4 landscape"));
ok("body is HTML-injected verbatim (caller pre-escapes)", shell({ bodyHtml: "<table class='cxr-table'></table>" }).includes("cxr-table"));

// cxPill
ok("cxPill colors a Pass green", /#0D7A4F/.test(sandbox.cxPill("Pass")));
ok("cxPill colors a Fail red", /#C01017/.test(sandbox.cxPill("Fail")));
ok("cxPill empty for blank status", sandbox.cxPill("") === "");

// ── Every module export routes through the shell ─────────────────────────────
// Drive each real builder with a captured cxPrintOpen/cxPrintFrame and seeded
// globals, then assert the generated document carries the shared branding.
let captured = null;
vm.runInContext(
  "cxPrintOpen = function(html){ globalThis.__cap = html; return true; };" +
  "cxPrintFrame = function(html){ globalThis.__cap = html; return true; };" +
  "toast = function(){};", ctx);
const grab = () => vm.runInContext("globalThis.__cap", ctx);
const isBranded = h => typeof h === "string" && h.includes(">HITACHI<") && h.includes("Contract 49GH-110") && h.includes("cxr-foot") && !/var\(--/.test(h);

// Daily Log
vm.runInContext("DAILY_LOGS = [{ id:'l1', log_date:'2026-07-09', location:'HTT', subsystem:'ATS', submitted_by:'A. Khoury', number_of_testers:2, idle_hours:7, total_tests_logged:1, total_passed:0, total_failed:1, total_blocked:0, total_partial:0, delay_occurred:'Yes', delay_category:'BART Support', delay_duration:2, delay_notes:'No EIC', overall_notes:'Good', next_day_plan:'Same test' }];", ctx);
vm.runInContext("_dlPrintLog('l1')", ctx);
ok("Daily Log export is branded", isBranded(grab()));
ok("Daily Log body uses shared metric tiles + callout", grab().includes("cxr-metric") && grab().includes("cxr-callout"));

// RMA
vm.runInContext("RMAS = [{ id:'r1', rma_number:'RMA-004', status:'Shipped', material_description:'Speed sensor', manufacturer:'Hitachi', serial_number:'SN1', created_at:'2026-07-01' }];", ctx);
vm.runInContext("_rmaPrintPDF('r1')", ctx);
ok("RMA export is branded", isBranded(grab()));
ok("RMA body uses the shared key/value table", grab().includes("cxr-kv") && grab().includes("RMA-004"));

// Cancellation report
vm.runInContext(
  "_cancelRptBuildRows = function(){ return [{ _id:'1', _type:'cancellation', date:'2026-07-09', title:'X', location:'W40', subsystem:'ATS', reason:'Access', party:'BART', source:'Log', loggedBy:'A' }]; };" +
  "_cancelRptApplyFilters = function(x){ return x; }; _cancelRptSel = new Set(); _cancelRpt = { type:'all' };", ctx);
vm.runInContext("_cancelRptExportPDF()", ctx);
ok("Cancellation report is branded", isBranded(grab()));
ok("Cancellation report uses shared data table + landscape", grab().includes("cxr-table") && grab().includes("A4 landscape"));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
