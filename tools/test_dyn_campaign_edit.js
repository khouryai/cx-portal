// Dynamic Testing — campaign edit + Non-Revenue Hours.
// Exercises the REAL app.js functions behind the edit flow:
//  • _dynCampLoadDays      — reconstruct the per-day editor state from a saved
//                            campaign (round-trips what _dynSaveCampaign wrote)
//  • _dynNonRevHours / _dynCampApplyNonRevHours — configurable non-revenue windows
//  • _dynGenerateShiftRows + _dynReconcileShiftKey — the (date|zone) keying the
//    edit reconcile uses to classify shifts as added / updated / removed
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);

// ── _dynCampLoadDays: saved campaign → per-day editor state ───────────────────
const camp = {
  id: "c1",
  zone_codes: ["W40", "Y10"],
  days_of_week: [1, 6],
  shift_start: "07:00", shift_end: "15:00",
  day_schedule: {
    1: { start: "01:00", end: "03:00", zones: ["W40"] },
    6: { start: "01:00", end: "04:00", zones: ["W40", "Y10"] },
  },
};
run(`_dynCampLoadDays(${JSON.stringify(camp)})`);
const days = run("JSON.parse(JSON.stringify(window._dynCampDays))");
assert(days[1].on === true && days[6].on === true, "scheduled days are ON");
assert(days[2].on === false && days[0].on === false, "unscheduled days are OFF");
assert(days[1].start === "01:00" && days[1].end === "03:00", "Mon times restored");
assert(JSON.stringify(days[1].zones) === JSON.stringify(["W40"]), "Mon zones restored (single zone)");
assert(JSON.stringify(days[6].zones) === JSON.stringify(["W40", "Y10"]), "Sat zones restored (two zones)");
assert(JSON.stringify(days[2].zones) === JSON.stringify(["W40", "Y10"]), "OFF day falls back to campaign zone palette");

// ── Non-Revenue Hours defaults + apply ────────────────────────────────────────
const nrh = run("JSON.parse(JSON.stringify(_dynNonRevHours()))");
assert(nrh.wk[0] === "01:00" && nrh.wk[1] === "03:00", "default weekday window 01:00–03:00 (2h)");
assert(nrh.sat[1] === "04:00", "default Saturday window ends 04:00 (3h)");
assert(nrh.sun[1] === "05:00", "default Sunday window ends 05:00 (4h)");

run("_dynCampInitDays(); _dynCampApplyNonRevHours();");
const ad = run("JSON.parse(JSON.stringify(window._dynCampDays))");
assert(ad[3].start === "01:00" && ad[3].end === "03:00", "apply sets weekday to wk window");
assert(ad[6].end === "04:00", "apply sets Saturday to sat window");
assert(ad[0].end === "05:00", "apply sets Sunday to sun window");
// settings panel HTML renders the three rows + gear actions
const sh = run("_dynNrhSettingsHtml()");
assert(/nrh-wk-start/.test(sh) && /nrh-sat-end/.test(sh) && /nrh-sun-start/.test(sh), "settings panel has wk/sat/sun inputs");
assert(/_dynNrhSaveSettings\(\)/.test(sh), "settings panel wires Save & apply");

// ── reconcile keying: _dynGenerateShiftRows + _dynReconcileShiftKey ───────────
// Original: W40 Mon+Sat, Y10 Sat  → 3 windows. Edit drops Y10 from Sat and adds
// a Tue W40 → expect 1 removed (Sat|Y10), 1 added (Tue|W40), rest updated.
const orig = {
  id: "c1", zone_codes: ["W40", "Y10"], days_of_week: [1, 6],
  shift_start: "01:00", shift_end: "03:00",
  day_schedule: {
    1: { start: "01:00", end: "03:00", zones: ["W40"] },
    6: { start: "01:00", end: "04:00", zones: ["W40", "Y10"] },
  },
  start_date: "2026-06-01", end_date: "2026-06-07",  // Mon 6/1 .. Sun 6/7
  allowed_modes: ["CBTC"], trains_requested: 1,
};
const edited = JSON.parse(JSON.stringify(orig));
edited.days_of_week = [1, 2, 6];
edited.day_schedule[2] = { start: "01:00", end: "03:00", zones: ["W40"] };
edited.day_schedule[6] = { start: "01:00", end: "04:00", zones: ["W40"] }; // drop Y10 on Sat
edited.zone_codes = ["W40", "Y10"];

const key = s => run(`_dynReconcileShiftKey(${JSON.stringify({ shift_date: s.shift_date, control_zone_code: s.control_zone_code })})`);
const origRows = run(`_dynGenerateShiftRows(${JSON.stringify(orig)})`).map(r => ({ shift_date: r.shift_date, control_zone_code: r.control_zone_code }));
const newRows  = run(`_dynGenerateShiftRows(${JSON.stringify(edited)})`).map(r => ({ shift_date: r.shift_date, control_zone_code: r.control_zone_code }));

const origKeys = new Set(origRows.map(key));
const newKeys = new Set(newRows.map(key));
assert(origRows.length === 3, "original generates 3 windows (W40 Mon, W40+Y10 Sat) got " + origRows.length);
const added = newRows.filter(r => !origKeys.has(key(r)));
const removed = origRows.filter(r => !newKeys.has(key(r)));
const updated = newRows.filter(r => origKeys.has(key(r)));
assert(added.length === 1 && added[0].control_zone_code === "W40" && added[0].shift_date === "2026-06-02", "added = Tue W40");
assert(removed.length === 1 && removed[0].control_zone_code === "Y10", "removed = Sat Y10");
assert(updated.length === 2, "updated = Mon W40 + Sat W40 (got " + updated.length + ")");

console.log(`test_dyn_campaign_edit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
