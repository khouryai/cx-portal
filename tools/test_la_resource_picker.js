// Lookahead resource picker — company filter (Hitachi / BART).
// Exercises the REAL _laResourcePanelHTML() / _laResPanelCompanyMatch() from
// app.js with injected PLANNING_RESOURCES, pinning that the assign-resources
// picker filters by company (BART = company 'BART'; Hitachi = everything else).
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }

const RES = [
  { id: "r1", display_name: "Alex Khoury",  initials: "AK", resource_type: "admin",          is_active: true,  company: "Hitachi Rail" },
  { id: "r2", display_name: "Sam Field",    initials: "SF", resource_type: "field_engineer", is_active: true,  company: "Hitachi Rail" },
  { id: "r3", display_name: "Dana Tech",    initials: "DT", resource_type: "manual",         is_active: true,  company: "Hitachi Rail" },
  { id: "r4", display_name: "BART Flagger", initials: "BF", resource_type: "crew",           is_active: true,  company: "BART", kind: "role" },
  { id: "r5", display_name: "BART Witness", initials: "BW", resource_type: "client_witness", is_active: true,  company: "BART", kind: "role" },
  { id: "r6", display_name: "Retired Tech", initials: "RT", resource_type: "manual",         is_active: false, company: "Hitachi Rail" },
];
vm.runInContext(`PLANNING_RESOURCES = ${JSON.stringify(RES)}; _laSelectedResIds = new Set();`, ctx);

const cards = html => (html.match(/la-res-card/g) || []).length;
function panel(filter) {
  vm.runInContext(`_laResPanelCompany = ${JSON.stringify(filter)};`, ctx);
  return vm.runInContext("_laResourcePanelHTML()", ctx);
}

// match helper
const match = (r, f) => {
  vm.runInContext(`_laResPanelCompany = ${JSON.stringify(f)};`, ctx);
  return vm.runInContext(`_laResPanelCompanyMatch(${JSON.stringify(r)})`, ctx);
};
assert(match({ company: "BART" }, "BART") === true, "BART filter matches BART resource");
assert(match({ company: "Hitachi Rail" }, "BART") === false, "BART filter excludes Hitachi");
assert(match({ company: "Hitachi Rail" }, "Hitachi") === true, "Hitachi filter matches Hitachi");
assert(match({ company: "BART" }, "Hitachi") === false, "Hitachi filter excludes BART");
assert(match({ company: "BART" }, "all") === true, "all filter matches anything");
assert(match({ company: null }, "Hitachi") === true, "null company counts as Hitachi (not BART)");

// panel rendering (only is_active resources are shown — 5 of 6)
const all = panel("all");
assert(cards(all) === 5, "all shows 5 active cards (got " + cards(all) + ")");
assert(all.includes("la-res-comp-filter"), "company chip row rendered");
assert(/>All<[\s\S]*?la-res-comp-n">5</.test(all), "All chip count = 5");
assert(/>Hitachi<[\s\S]*?la-res-comp-n">3</.test(all), "Hitachi chip count = 3");
assert(/>BART<[\s\S]*?la-res-comp-n">2</.test(all), "BART chip count = 2");

const hit = panel("Hitachi");
assert(cards(hit) === 3, "Hitachi shows 3 cards (got " + cards(hit) + ")");
assert(hit.includes("Alex Khoury") && hit.includes("Dana Tech") && hit.includes("Sam Field"), "Hitachi includes the Hitachi people");
assert(!hit.includes("BART Flagger") && !hit.includes("BART Witness"), "Hitachi excludes BART resources");
assert(/la-res-comp-chip active[^>]*>Hitachi/.test(hit), "Hitachi chip marked active");

const bart = panel("BART");
assert(cards(bart) === 2, "BART shows 2 cards (got " + cards(bart) + ")");
assert(bart.includes("BART Flagger") && bart.includes("BART Witness"), "BART includes BART resources");
assert(!bart.includes("Alex Khoury"), "BART excludes Hitachi people");

// ── cell chip label: single-word BART role codes stay WHOLE (ROC, not R) ──────
const label = r => vm.runInContext(`_resChipLabel(${JSON.stringify(r)})`, ctx);
assert(label({ display_name: "ROC" }) === "ROC", "single-word 'ROC' kept whole (not 'R')");
assert(label({ display_name: "EIC" }) === "EIC", "single-word 'EIC' kept whole");
assert(label({ display_name: "TO" }) === "TO", "single-word 'TO' kept whole");
assert(label({ display_name: "Train Operator" }) === "TO", "multi-word folds to initials");
assert(label({ initials: "WIT", display_name: "Witness" }) === "WIT", "explicit initials win");
assert(label({ initials: "roc" }) === "ROC", "initials upper-cased");
assert(label({ display_name: "Rail Ops Center" }) === "ROC", "3-word folds to ROC");

console.log(`test_la_resource_picker: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
