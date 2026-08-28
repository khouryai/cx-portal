// Dynamic Testing — weekend / line-closure access block (cx-closure-window.js).
//
// A planned closure is ONE continuous possession (Fri 21:00 → Mon 04:00), not a
// stack of 00:00–23:59 per-day shifts. This suite pins the behaviour the
// planner actually relies on, through the REAL loaded module + app.js:
//  • block geometry — span days, total minutes, the week-long edge case
//  • generateShiftRows — ONE row per weekend, spanning the whole block, with a
//    stable shift_date so the edit reconcile updates instead of duplicating
//  • coexistence — closure rows AND per-day rows in the same campaign
//  • productive-hours cap — what the allocator packs against vs. the possession
//  • coveredDayKeys / spanLabel — the block reads correctly on the Access Plan
//  • _dynCampShiftSummary — the `closure` key is never read as a weekday
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }
function eq(a, b, msg) { assert(a === b, msg + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);
const json = expr => JSON.parse(run(`JSON.stringify(${expr})`) || "null");

assert(run("typeof CXClosure") === "object", "CXClosure is exposed as a global");

// ── block geometry ───────────────────────────────────────────────────────────
const FRI_MON = { startDow: 5, startTime: "21:00", endDow: 1, endTime: "04:00" };
const W = JSON.stringify(FRI_MON);
eq(run(`CXClosure.spanDays(${W})`), 3, "Fri→Mon spans 3 whole days");
eq(run(`CXClosure.blockMinutes(${W})`), 55 * 60, "Fri 21:00 → Mon 04:00 is 55 h");
eq(run(`CXClosure.windowLabel(${W})`), "Fri 21:00 → Mon 04:00", "human label reads as the possession");

// Same day-of-week wrapping past its own start time = a FULL week possession,
// not a zero-length one.
eq(run(`CXClosure.blockMinutes({startDow:5,startTime:"21:00",endDow:5,endTime:"04:00"})`),
  7 * 1440 - 21 * 60 + 4 * 60, "Fri 21:00 → Fri 04:00 is a week-long block");
// A same-day block that genuinely ends later the same day stays sub-24 h.
eq(run(`CXClosure.blockMinutes({startDow:6,startTime:"01:00",endDow:6,endTime:"05:00"})`),
  240, "Sat 01:00 → Sat 05:00 is 4 h");

// ── validation ───────────────────────────────────────────────────────────────
assert(run(`CXClosure.validate(${W}) === null`), "a sane block validates");
assert(!!run(`CXClosure.validate({startDow:5,startTime:"21:00",endDow:1,endTime:"04:00",productiveHours:99})`),
  "productive hours beyond the possession are rejected");

// ── shift generation ─────────────────────────────────────────────────────────
// Aug 2026: Fridays fall on the 7th, 14th, 21st, 28th.
const camp = {
  id: "camp-closure",
  campaign_kind: "closure",
  zone_codes: ["W40", "Y10"],
  start_date: "2026-08-01",
  end_date: "2026-08-23",
  days_of_week: [],
  day_schedule: { closure: FRI_MON },
  allowed_modes: ["CBTC"],
  trains_requested: 2,
};
const rows = json(`CXClosure.generateShiftRows(${JSON.stringify(camp)})`);
eq(rows.length, 3, "one block per Friday inside the range (7th, 14th, 21st)");
eq(rows.map(r => r.shift_date).join(","), "2026-08-07,2026-08-14,2026-08-21", "blocks anchor on their start date");
assert(rows.every(r => r.campaign_id === "camp-closure"), "rows carry the campaign id");
assert(rows.every(r => r.status === "planned"), "generated blocks start planned");
eq(rows[0].control_zone_code, "W40", "primary zone is the block's first zone");
eq(rows[0].access_zones.join(","), "W40,Y10", "the block grants every campaign zone");

// The row is ONE continuous window, not a day fragment.
const durH = (new Date(rows[0].end_at) - new Date(rows[0].start_at)) / 3600000;
eq(durH, 55, "the generated row spans the full 55 h possession");
eq(new Date(rows[0].start_at).getDay(), 5, "the block opens on a Friday");
eq(new Date(rows[0].end_at).getDay(), 1, "the block reopens on a Monday");

// A campaign whose range holds no Friday yields nothing (rather than a bogus block).
eq(json(`CXClosure.generateShiftRows(${JSON.stringify({ ...camp, start_date: "2026-08-08", end_date: "2026-08-13" })})`).length,
  0, "no start-day occurrence in range = no block");

// ── coexistence: closure block + per-day rows in ONE campaign ────────────────
const mixed = {
  ...camp,
  id: "camp-mixed",
  days_of_week: [2],
  day_schedule: { 2: { start: "01:00", end: "03:00", zones: ["W40"] }, closure: FRI_MON },
  shift_start: "01:00", shift_end: "03:00",
};
const allRows = json(`_dynGenerateShiftRows(${JSON.stringify(mixed)})`);
const blocks = allRows.filter(r => (new Date(r.end_at) - new Date(r.start_at)) > 24 * 3600000);
const daily = allRows.filter(r => (new Date(r.end_at) - new Date(r.start_at)) <= 24 * 3600000);
eq(blocks.length, 3, "_dynGenerateShiftRows emits the weekend blocks");
eq(daily.length, 3, "_dynGenerateShiftRows still emits the Tuesday shifts (4th, 11th, 18th)");
assert(daily.every(r => new Date(r.start_at).getDay() === 2), "the per-day rows are Tuesdays");

// A standard campaign is untouched by any of this.
const std = { ...mixed, id: "camp-std", campaign_kind: "standard" };
eq(json(`_dynGenerateShiftRows(${JSON.stringify(std)})`).length, 3,
  "a standard campaign generates only its per-day shifts");

// ── reconcile key stays stable, so an edit updates the block ─────────────────
const keys = allRows.map(r => run(`_dynReconcileShiftKey(${JSON.stringify(r)})`));
eq(new Set(keys).size, keys.length, "every generated row has a distinct reconcile key");

// ── productive-hours cap ─────────────────────────────────────────────────────
// Register the campaign so the window→campaign lookup resolves, as it does live.
const capped = { ...camp, id: "camp-capped", day_schedule: { closure: { ...FRI_MON, productiveHours: 24 } } };
run(`_dynPage.campaigns = ${JSON.stringify([camp, capped])};`);
const block = json(`CXClosure.generateShiftRows(${JSON.stringify(camp)})`)[0];
const cappedBlock = json(`CXClosure.generateShiftRows(${JSON.stringify(capped)})`)[0];

assert(run(`CXClosure.isClosureWindow(${JSON.stringify(block)})`), "a generated block is recognised as one");
eq(run(`_dynWinMinutes(${JSON.stringify(block)})`), 55 * 60, "no cap = the whole possession is testable");
eq(run(`_dynWinMinutes(${JSON.stringify(cappedBlock)})`), 24 * 60, "the productive-hours cap governs allocator capacity");
eq(run(`_dynShiftMinutes(${JSON.stringify(cappedBlock)})`), 24 * 60, "the shift builder honours the same cap");

// A plain daily window is never mistaken for a block.
const dailyWin = daily[0];
assert(!run(`CXClosure.isClosureWindow(${JSON.stringify(dailyWin)})`), "a per-day shift is not a closure block");
eq(run(`_dynWinMinutes(${JSON.stringify(dailyWin)})`), 120, "a 2 h per-day window is unaffected");

// Capacity: a 55 h possession must not be clamped to the 8-test cap sized for
// a 2 h window, but a normal window still is.
assert(run(`_dynWindowCapacity(${JSON.stringify(block)})`) > 8, "a closure block carries more than 8 tests");
assert(run(`_dynWindowCapacity(${JSON.stringify(dailyWin)})`) <= 8, "a per-day window keeps the 8-test clamp");

// ── Access Plan rendering ────────────────────────────────────────────────────
const covered = json(`CXClosure.coveredDayKeys(${JSON.stringify(block)})`);
eq(covered.join(","), "2026-08-07,2026-08-08,2026-08-09,2026-08-10",
  "the block paints Fri, Sat, Sun and Mon on the grid");
eq(json(`CXClosure.coveredDayKeys(${JSON.stringify(dailyWin)})`).length, 1, "a per-day shift covers one day");
eq(run(`CXClosure.spanLabel(${JSON.stringify(block)})`), "Fri 21:00 → Mon 04:00",
  "the chip spells out the span instead of a misleading 21:00–04:00");
eq(run(`CXClosure.spanLabel(${JSON.stringify(dailyWin)})`), "", "a same-day shift keeps its plain time label");

// ── campaign card summary ────────────────────────────────────────────────────
// `closure` must never be read as a day-of-week key (it used to render as
// "undefined-undefined" through Object.keys(day_schedule)).
const sum = run(`_dynCampShiftSummary(${JSON.stringify(mixed)})`);
assert(!/undefined/.test(sum), "the summary never leaks undefined from the closure key: " + sum);
assert(/Fri 21:00 → Mon 04:00/.test(sum), "the summary names the closure block: " + sum);
assert(/01:00–03:00/.test(sum), "the summary still names the per-day window: " + sum);
const cSum = run(`_dynCampShiftSummary(${JSON.stringify(camp)})`);
eq(cSum, "Fri 21:00 → Mon 04:00 · 55 h closure", "a closure-only campaign summarises as the block");
const capSum = run(`_dynCampShiftSummary(${JSON.stringify(capped)})`);
assert(/24 h testable/.test(capSum), "a capped block shows its testable hours: " + capSum);

// ── the blanket default round-trips through localStorage ─────────────────────
run(`CXClosure.saveSettings({startDow:4,startTime:"22:00",endDow:1,endTime:"05:00",productiveHours:30})`);
const back = json(`CXClosure.settings()`);
eq(back.startDow, 4, "saved default start day round-trips");
eq(back.startTime, "22:00", "saved default start time round-trips");
eq(back.productiveHours, 30, "saved productive-hours cap round-trips");
const junk = json(`CXClosure.normalize({startDow:99,startTime:"nope",productiveHours:-4})`);
eq(junk.startDow, 5, "a bad stored day falls back to the Friday default");
eq(junk.startTime, "21:00", "a bad stored time falls back to the default");
eq(junk.productiveHours, null, "a non-positive cap means no cap");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
