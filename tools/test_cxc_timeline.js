#!/usr/bin/env node
"use strict";
/*
 * Unit suite for cxc-timeline.js — the Gantt geometry.
 *
 * The renderer is dumb on purpose; everything that can be wrong (bars merging
 * across the wrong gap, two bars overlapping in one sub-row, an axis that does
 * not cover the span) is decided here, where it can be checked without a
 * browser.
 */
const path = require("path");
const CXC = require(path.resolve(__dirname, "..", "cxc-model.js"));
global.CXC = CXC;
const D = require(path.resolve(__dirname, "..", "cxc-data.js"));
global.CXCData = D;
const T = require(path.resolve(__dirname, "..", "cxc-timeline.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
}

// ── Sub-lane packing ───────────────────────────────────────────────────────
console.log("\n── sub-lane packing ──");
const bar = (startIndex, days) => ({ startIndex, days });

eq("non-overlapping bars share one sub-row",
  T.packSublanes([bar(0, 2), bar(3, 2), bar(6, 1)]).length, 1);
eq("overlapping bars are pushed to a second sub-row",
  T.packSublanes([bar(0, 5), bar(2, 3)]).length, 2);
eq("three mutually overlapping bars need three sub-rows",
  T.packSublanes([bar(0, 5), bar(1, 5), bar(2, 5)]).length, 3);
eq("a bar touching the next day's start still shares a row",
  T.packSublanes([bar(0, 2), bar(2, 2)]).length, 1);

const packed = T.packSublanes([bar(0, 5), bar(1, 2), bar(6, 2)]);
eq("the third bar rejoins the first row once it is free", packed[0].length, 2);
ok("no two bars in a sub-row overlap", packed.every((row) =>
  row.every((b, i) => i === 0 || row[i - 1].startIndex + row[i - 1].days <= b.startIndex)));

// ── Axis ───────────────────────────────────────────────────────────────────
console.log("\n── axis ──");
const months = T.axisBuckets("2026-09-07", 53, "month");
eq("a 53-day span from September spans two months", months.length, 2);
eq("the first bucket runs to the end of September", months[0].days, 24);
eq("buckets are contiguous from zero", months[0].startIndex, 0);
eq("the second bucket starts where the first ended", months[1].startIndex, 24);
eq("buckets cover exactly the span",
  months.reduce((s, m) => s + m.days, 0), 53);

const weeks = T.axisBuckets("2026-09-07", 21, "week");
eq("weeks cover exactly the span", weeks.reduce((s, w) => s + w.days, 0), 21);
ok("no week bucket is longer than 7 days", weeks.every(w => w.days <= 7));
// 2026-09-07 is a Monday, so the first partial week runs Mon–Sat = 6 days.
eq("the first week runs to the end of that calendar week", weeks[0].days, 6);

// ── build ──────────────────────────────────────────────────────────────────
console.log("\n── build ──");
eq("no assignments gives an empty timeline",
  T.build({ assignments: [], materials: [] }, D.seed(), {}).empty, true);

const data = D.seed();
const windows = CXC.generateWindows(data.plan.from, data.plan.to, data);
const result = CXC.packSchedule({ windows, data });
const tl = T.build(result, data, { groupBy: "location" });

ok("the span starts at the first worked date",
  tl.from === result.assignments[0].date, tl.from);
eq("total days matches the span", tl.totalDays, CXC.daysBetween(tl.from, tl.to) + 1);
ok("every lane has at least one bar", tl.lanes.every(l => l.barCount > 0));
ok("lanes are sorted by label",
  tl.lanes.map(l => l.label).join("|") === tl.lanes.map(l => l.label).sort().join("|"));

const allBars = tl.lanes.flatMap(l => l.sublanes.flat());
ok("every bar sits inside the span",
  allBars.every(b => b.startIndex >= 0 && b.startIndex + b.days <= tl.totalDays));
ok("every bar carries its scope item and activity",
  allBars.every(b => b.itemId && b.activityName));
ok("every bar carries a phase color the stylesheet knows",
  allBars.every(b => ["slate", "blue", "green", "amber", "red", "purple"].includes(b.color)),
  JSON.stringify([...new Set(allBars.map(b => b.color))]));
eq("the bars account for every assignment",
  allBars.reduce((s, b) => s + b.nights, 0), result.assignments.length);

// Grouping changes the lanes but never the work.
["crew", "phase", "activity"].forEach((g) => {
  const t = T.build(result, data, { groupBy: g });
  eq("grouping by " + g + " keeps every assignment",
    t.lanes.flatMap(l => l.sublanes.flat()).reduce((s, b) => s + b.nights, 0),
    result.assignments.length);
});
eq("an unknown grouping falls back to location",
  T.build(result, data, { groupBy: "nonsense" }).groupBy, "location");

// ── Bar merging ────────────────────────────────────────────────────────────
console.log("\n── bar merging ──");
function fakeResult(dates) {
  return {
    assignments: dates.map((d) => ({
      date: d, itemId: "S-001", locationId: "loc-1", phaseId: "ph-1",
      activityTypeId: "act-1", activityName: "Conduit", crewName: "Crew A",
      qty: 10, unit: "lf", minutes: 60
    })),
    materials: []
  };
}
const merged = T.build(fakeResult(["2026-09-07", "2026-09-08", "2026-09-09"]), data, { gapDays: 7 });
eq("consecutive nights on one item merge into a single bar",
  merged.lanes[0].sublanes.flat().length, 1);
eq("the merged bar spans start to end", merged.lanes[0].sublanes.flat()[0].days, 3);
eq("and counts the nights worked", merged.lanes[0].sublanes.flat()[0].nights, 3);
eq("and sums the quantity", merged.lanes[0].sublanes.flat()[0].qty, 30);

const split = T.build(fakeResult(["2026-09-07", "2026-10-20"]), data, { gapDays: 7 });
eq("a long gap starts a new bar instead of one false span",
  split.lanes[0].sublanes.flat().length, 2);
const nogap = T.build(fakeResult(["2026-09-07", "2026-09-14"]), data, { gapDays: 7 });
eq("a gap inside the tolerance still merges", nogap.lanes[0].sublanes.flat().length, 1);

// ── Milestones ─────────────────────────────────────────────────────────────
console.log("\n── milestones ──");
ok("material deliveries appear as events",
  tl.milestones.some(m => m.kind === "material"), JSON.stringify(tl.milestones.slice(0, 3)));
ok("phase completions appear as events", tl.milestones.some(m => m.kind === "phase"));
ok("milestones are inside the span",
  tl.milestones.every(m => m.date >= tl.from && m.date <= tl.to));
ok("milestone indices match their dates",
  tl.milestones.every(m => m.index === CXC.daysBetween(tl.from, m.date)));
ok("milestones are date-ordered",
  tl.milestones.map(m => m.date).join("|") === tl.milestones.map(m => m.date).sort().join("|"));

const unusedMat = D.seed();
unusedMat.materials.push({ id: "mat-99", code: "UNUSED", name: "Never used", unit: "ea", onHand: 5, availableFrom: unusedMat.plan.from });
const tl2 = T.build(result, unusedMat, {});
ok("a material the plan never draws gets no marker",
  !tl2.milestones.some(m => /UNUSED/.test(m.label)));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
