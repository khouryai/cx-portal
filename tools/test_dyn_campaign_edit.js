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

// ── ONE window per access DAY (a 2-location day = one row granting both) ──────
const orig = {
  id: "c1", zone_codes: ["W40", "Y10"], days_of_week: [1, 6],
  shift_start: "01:00", shift_end: "03:00",
  day_schedule: {
    1: { start: "01:00", end: "03:00", zones: ["W40"] },
    6: { start: "01:00", end: "04:00", zones: ["W40", "Y10"] },  // two-location day
  },
  start_date: "2026-06-01", end_date: "2026-06-07",  // Mon 6/1 .. Sun 6/7
  allowed_modes: ["CBTC"], trains_requested: 1,
};
const origRows = run(`_dynGenerateShiftRows(${JSON.stringify(orig)})`);
assert(origRows.length === 2, "one window per access day — Mon + Sat = 2 (not one-per-zone), got " + origRows.length);
const satRow = origRows.find(r => r.shift_date === "2026-06-06");
assert(satRow && JSON.stringify(satRow.access_zones) === JSON.stringify(["W40", "Y10"]),
  "the two-location Sat day is ONE row granting both zones");
assert(satRow.control_zone_code === "W40", "control zone is the day's primary zone");

// ── reconcile is DATE-based (one window/day) ──────────────────────────────────
// Edit: add Tue, drop Y10 from Sat. Expect 1 added (Tue), 2 updated (Mon, Sat),
// 0 removed (no whole day dropped) — Sat updates in place to drop a zone.
const edited = JSON.parse(JSON.stringify(orig));
edited.days_of_week = [1, 2, 6];
edited.day_schedule[2] = { start: "01:00", end: "03:00", zones: ["W40"] };
edited.day_schedule[6] = { start: "01:00", end: "04:00", zones: ["W40"] };

const dkey = s => run(`_dynReconcileShiftKey(${JSON.stringify({ shift_date: s.shift_date })})`);
function classify(existing, expected) {
  const byDate = new Map();
  for (const s of existing) { const k = dkey(s); (byDate.get(k) || byDate.set(k, []).get(k)).push(s); }
  const expDates = new Set(expected.map(dkey));
  let add = 0, upd = 0, rem = 0;
  for (const ex of expected) {
    const pool = byDate.get(dkey(ex)) || [];
    if (pool.length) { upd++; rem += pool.length - 1; } else add++;
  }
  for (const s of existing) if (!expDates.has(dkey(s))) rem++;
  return { add, upd, rem };
}
const existing1 = origRows.map(r => ({ id: "w-" + r.shift_date, shift_date: r.shift_date }));
const expected1 = run(`_dynGenerateShiftRows(${JSON.stringify(edited)})`);
const c1 = classify(existing1, expected1);
assert(c1.add === 1 && c1.upd === 2 && c1.rem === 0, `add/upd/rem = 1/2/0 (got ${c1.add}/${c1.upd}/${c1.rem})`);

// ── legacy collapse: 2 existing windows on the SAME date → 1 update + 1 remove ─
const legacy = [
  { id: "old-a", shift_date: "2026-06-06" },
  { id: "old-b", shift_date: "2026-06-06" },  // duplicate from old one-per-zone gen
  { id: "old-mon", shift_date: "2026-06-01" },
];
const expected2 = origRows; // one per day (Mon + Sat)
const c2 = classify(legacy, expected2);
assert(c2.upd === 2 && c2.rem === 1 && c2.add === 0, `legacy collapse: 2 upd, 1 rem, 0 add (got ${c2.upd}/${c2.rem}/${c2.add})`);

console.log(`test_dyn_campaign_edit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
