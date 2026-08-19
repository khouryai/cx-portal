#!/usr/bin/env node
"use strict";
/*
 * Headless unit suite for cxc-model.js — the pattern cx-portal uses everywhere
 * (see tools/run_tests.js there). No framework, no package.json, no install:
 *   node tools/test_cxc_model.js
 * Prints "N passed, M failed" and exits non-zero on failure so CI can gate it.
 *
 * Every test builds its OWN tiny assumptions object rather than leaning on
 * DEFAULT_ASSUMPTIONS — a test that breaks when someone edits a seed rate is a
 * test that will get deleted.
 */
const path = require("path");
const CXC = require(path.resolve(__dirname, "..", "cxc-model.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
}
function near(name, actual, expected, tol) {
  ok(name, Math.abs(actual - expected) <= (tol || 1), "got " + actual + ", want ~" + expected);
}

// ── Fixture ────────────────────────────────────────────────────────────────
function fixture(over) {
  return Object.assign({
    globals: {
      productivityFactor: 1, breakMinPerShift: 30, contingencyPct: 0,
      crewScalingExponent: 1, relocationMin: 0
    },
    shiftPatterns: [
      { id: "night", name: "8hr night", startTime: "22:00", endTime: "06:00", endsNextDay: true,
        mobilizeInMin: 60, mobilizeOutMin: 30, daysOfWeek: [1, 2, 3, 4, 5], maxCrews: 1 },
      { id: "short", name: "2hr", startTime: "01:00", endTime: "03:00",
        mobilizeInMin: 30, mobilizeOutMin: 30, daysOfWeek: [1, 2, 3, 4, 5], maxCrews: 1 },
      { id: "shutdown", name: "weekend", durationMin: 2880,
        mobilizeInMin: 60, mobilizeOutMin: 60, daysOfWeek: [6], maxCrews: 1 }
    ],
    activityTypes: [
      { id: "conduit", name: "Conduit", unit: "lf", minutesPerUnit: 2, refCrewSize: 2, setupMin: 0, divisible: "continuous" },
      { id: "device", name: "Device", unit: "ea", minutesPerUnit: 120, refCrewSize: 2, setupMin: 0, divisible: "unit" },
      { id: "cutover", name: "Cutover", unit: "ea", minutesPerUnit: 120, refCrewSize: 2, setupMin: 0, divisible: "none" }
    ],
    crews: [{ id: "c1", name: "Crew 1", size: 2, efficiency: 1, skills: [], shiftPatternIds: [], vehicleIds: [] }],
    locations: [], phases: [], materials: [], vehicles: [], scope: [],
    blackoutDates: []
  }, over || {});
}

// ── Window duration ────────────────────────────────────────────────────────
console.log("\n── window duration ──");
eq("overnight window spans midnight",
  CXC.grossWindowMinutes({ startTime: "22:00", endTime: "06:00", endsNextDay: true }), 480);
eq("same-day window", CXC.grossWindowMinutes({ startTime: "01:00", endTime: "03:00" }), 120);
eq("explicit durationMin wins over clock times",
  CXC.grossWindowMinutes({ durationMin: 2880, startTime: "22:00", endTime: "02:00" }), 2880);

const a = fixture();
const b8 = CXC.windowBudget({ date: "2026-09-07", patternId: "night" }, a);
eq("8hr night gross", b8.gross, 480);
eq("8hr night mobilization", b8.mobilize, 90);
eq("8hr night productive = 480 - 90 mob - 30 break", b8.productive, 360);

const b2 = CXC.windowBudget({ date: "2026-09-07", patternId: "short" }, a);
eq("2hr window productive = 120 - 60 mob - 30 break", b2.productive, 30);
ok("mobilization dominates a short window", b2.productive / b2.gross < 0.3);

const bCont = CXC.windowBudget({ date: "2026-09-07", patternId: "night" },
  fixture({ globals: Object.assign({}, a.globals, { contingencyPct: 10 }) }));
eq("10% contingency reserves 36 of 360 min", bCont.productive, 324);

const bOver = CXC.windowBudget(
  { date: "2026-09-07", patternId: "night", overrides: { mobilizeInMin: 120 } }, a);
eq("per-window override beats the pattern", bOver.productive, 300);

// ── Crew scaling ───────────────────────────────────────────────────────────
console.log("\n── crew scaling ──");
eq("linear: double the crew, half the time", CXC.crewFactor(4, 2, 1), 0.5);
eq("exponent 0 = extra people add nothing", CXC.crewFactor(4, 2, 0), 1);
near("exponent 0.85 gives diminishing returns", CXC.crewFactor(4, 2, 0.85), 0.554, 0.01);
ok("diminishing returns are slower than linear", CXC.crewFactor(4, 2, 0.85) > CXC.crewFactor(4, 2, 1));

// ── Task duration ──────────────────────────────────────────────────────────
console.log("\n── task duration ──");
const crew2 = a.crews[0];
eq("100 lf at 2 min/lf, reference crew", CXC.taskMinutes({ activityTypeId: "conduit", qty: 100 }, crew2, a).minutes, 200);

const a4 = fixture();
a4.crews = [{ id: "c4", name: "Crew 4", size: 4, efficiency: 1, skills: [], shiftPatternIds: [] }];
eq("same work with 4 crew (linear) halves it",
  CXC.taskMinutes({ activityTypeId: "conduit", qty: 100 }, a4.crews[0], a4).minutes, 100);

const aEff = fixture();
aEff.globals.productivityFactor = 0.8;
eq("productivityFactor 0.8 stretches 200 → 250",
  CXC.taskMinutes({ activityTypeId: "conduit", qty: 100 }, crew2, aEff).minutes, 250);

const aSetup = fixture();
aSetup.activityTypes[0].setupMin = 45;
const ts = CXC.taskMinutes({ activityTypeId: "conduit", qty: 100 }, crew2, aSetup);
eq("setup is added on top of production", ts.minutes, 245);
eq("setup is reported separately", ts.setup, 45);

eq("unknown activity type is 0, not a crash",
  CXC.taskMinutes({ activityTypeId: "nope", qty: 10 }, crew2, a).minutes, 0);

// ── Window generation ──────────────────────────────────────────────────────
console.log("\n── window generation ──");
// 2026-09-07 is a Monday.
const wins = CXC.generateWindows("2026-09-07", "2026-09-13", a, ["night"]);
eq("weekday pattern yields 5 windows in a week", wins.length, 5);
eq("first window is the Monday", wins[0].date, "2026-09-07");
ok("no weekend windows for a weekday pattern",
  wins.every(w => [1, 2, 3, 4, 5].includes(CXC.dowOf(w.date))));

const aBlack = fixture({ blackoutDates: ["2026-09-09"] });
eq("blackout date removes its window",
  CXC.generateWindows("2026-09-07", "2026-09-13", aBlack, ["night"]).length, 4);

eq("weekend pattern only lands on Saturday",
  CXC.generateWindows("2026-09-07", "2026-09-13", a, ["shutdown"]).length, 1);

// ── Packing ────────────────────────────────────────────────────────────────
console.log("\n── schedule packing ──");
// 360 productive min/night. 300 lf of conduit = 600 min → 2 nights.
let r = CXC.packSchedule({
  items: [{ id: "i1", locationId: "MP 1.0", activityTypeId: "conduit", qty: 300 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", a, ["night"]),
  data: a
});
eq("splittable work spans two windows", r.assignments.length, 2);
eq("first night is filled to the budget", r.assignments[0].minutes, 360);
eq("first placement is flagged partial", r.assignments[0].partial, true);
eq("total quantity placed equals the scope",
  r.assignments.reduce((s, x) => s + x.qty, 0), 300);
eq("nothing left unplaced", r.unplaced.length, 0);

// A 120-min device fits a night but never a 2hr window (30 productive min).
r = CXC.packSchedule({
  items: [{ id: "d1", locationId: "MP 2.0", activityTypeId: "device", qty: 1 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-11", a, ["short"]),
  data: a
});
eq("device does not fit a 2hr window", r.assignments.length, 0);
eq("and it is reported, not dropped", r.unplaced.length, 1);
ok("with a reason naming the window length", /no window long enough/.test(r.unplaced[0].reason), r.unplaced[0].reason);

// divisible:'unit' — 4 devices = 480 min, more than one 360-min night, so they
// split at WHOLE devices across two nights rather than blocking a crew.
r = CXC.packSchedule({
  items: [{ id: "d4", locationId: "MP 2.0", activityTypeId: "device", qty: 4 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-11", a, ["night"]),
  data: a
});
eq("4 devices split across two nights", r.assignments.length, 2);
eq("3 whole devices the first night (360 min budget)", r.assignments[0].qty, 3);
ok("every placement is a whole number of devices",
  r.assignments.every(x => Number.isInteger(x.qty)), JSON.stringify(r.assignments.map(x => x.qty)));
eq("all 4 devices land", r.assignments.reduce((s, x) => s + x.qty, 0), 4);

// divisible:'none' — must finish inside ONE window, so 4 x 120 min never fits.
r = CXC.packSchedule({
  items: [{ id: "co1", locationId: "MP 2.0", activityTypeId: "cutover", qty: 4 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", a, ["night"]),
  data: a
});
eq("indivisible work larger than a window never places", r.assignments.length, 0);
ok("and says it must finish in one window",
  /must finish in one window/.test(r.unplaced[0].reason), r.unplaced[0].reason);

// ... but the same indivisible work DOES fit a weekend shutdown.
r = CXC.packSchedule({
  items: [{ id: "co2", locationId: "MP 2.0", activityTypeId: "cutover", qty: 4 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", a, ["shutdown"]),
  data: a
});
eq("a shutdown window absorbs it whole", r.assignments.length, 1);
eq("in one placement, complete", r.unplaced.length, 0);

// Legacy `splittable: false` still reads as 'none'.
const aLegacy = fixture();
aLegacy.activityTypes = [{ id: "legacy", name: "Legacy", unit: "ea", minutesPerUnit: 120, refCrewSize: 2, setupMin: 0, splittable: false }];
r = CXC.packSchedule({
  items: [{ id: "l1", locationId: "MP 1.0", activityTypeId: "legacy", qty: 4 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", aLegacy, ["night"]),
  data: aLegacy
});
eq("splittable:false is honoured as divisible:'none'", r.assignments.length, 0);

// Prerequisites gate the successor until the predecessor completes.
r = CXC.packSchedule({
  items: [
    { id: "p1", locationId: "MP 1.0", activityTypeId: "conduit", qty: 300 },
    { id: "p2", locationId: "MP 1.0", activityTypeId: "device", qty: 1, prereqIds: ["p1"] }
  ],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", a, ["night"]),
  data: a
});
const firstDevice = r.assignments.find(x => x.itemId === "p2");
const lastConduit = r.assignments.filter(x => x.itemId === "p1").pop();
ok("successor never starts before its prerequisite completes",
  firstDevice && lastConduit && firstDevice.date >= lastConduit.date);

// Crew skills gate eligibility.
const aSkill = fixture();
aSkill.crews = [{ id: "cx", name: "Conduit only", size: 2, efficiency: 1, skills: ["conduit"], shiftPatternIds: [] }];
r = CXC.packSchedule({
  items: [{ id: "d2", locationId: "MP 3.0", activityTypeId: "device", qty: 1 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-11", aSkill, ["night"]),
  data: aSkill
});
ok("unqualified crew leaves the item unplaced with a skills reason",
  r.unplaced.length === 1 && /no crew qualified/.test(r.unplaced[0].reason), JSON.stringify(r.unplaced));

// Two crews double a window's capacity.
const aTwo = fixture();
aTwo.shiftPatterns[0].maxCrews = 2;
aTwo.crews = [
  { id: "c1", name: "Crew 1", size: 2, efficiency: 1, skills: [], shiftPatternIds: [] },
  { id: "c2", name: "Crew 2", size: 2, efficiency: 1, skills: [], shiftPatternIds: [] }
];
r = CXC.packSchedule({
  items: [
    { id: "m1", locationId: "MP 1.0", activityTypeId: "conduit", qty: 180 },
    { id: "m2", locationId: "MP 2.0", activityTypeId: "conduit", qty: 180 }
  ],
  windows: CXC.generateWindows("2026-09-07", "2026-09-07", aTwo, ["night"]),
  data: aTwo
});
eq("two crews clear both scopes in one night", r.unplaced.length, 0);
eq("and the window reports both crews", r.windows[0].crewCount, 2);

// Relocation cost is charged when a crew changes location mid-shift.
const aMove = fixture();
aMove.globals.relocationMin = 60;
r = CXC.packSchedule({
  items: [
    { id: "x1", locationId: "MP 1.0", activityTypeId: "conduit", qty: 60 },
    { id: "x2", locationId: "MP 9.0", activityTypeId: "conduit", qty: 60 }
  ],
  windows: CXC.generateWindows("2026-09-07", "2026-09-07", aMove, ["night"]),
  data: aMove
});
const moved = r.assignments.filter(x => x.relocationMin > 0);
eq("changing location inside a shift costs relocation once", moved.length, 1);
eq("and it is charged at the configured rate", moved[0].relocationMin, 60);

// Utilization reporting.
r = CXC.packSchedule({
  items: [{ id: "u1", locationId: "MP 1.0", activityTypeId: "conduit", qty: 180 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-07", a, ["night"]),
  data: a
});
eq("180 lf = 360 min = a full 8hr night", r.windows[0].utilization, 100);
eq("summary counts the completed item", r.summary.completeCount, 1);

// ── Vehicles ───────────────────────────────────────────────────────────────
console.log("\n── vehicles ──");
function fleetFixture() {
  const f = fixture();
  f.shiftPatterns[0].maxCrews = 2;
  f.vehicles = [
    { id: "v1", name: "Hi-rail 1", status: "active", availableFrom: "", availableTo: "" },
    { id: "v2", name: "Hi-rail 2", status: "out of service", availableFrom: "", availableTo: "" }
  ];
  f.crews = [
    { id: "c1", name: "Crew 1", size: 2, efficiency: 1, skills: [], shiftPatternIds: [], vehicleIds: ["v1"] },
    { id: "c2", name: "Crew 2", size: 2, efficiency: 1, skills: [], shiftPatternIds: [], vehicleIds: ["v1"] }
  ];
  return f;
}
eq("an active vehicle with no dates is always available",
  CXC.vehicleAvailableOn({ id: "v", status: "active" }, "2026-09-07"), true);
eq("an out-of-service vehicle never is",
  CXC.vehicleAvailableOn({ id: "v", status: "out of service" }, "2026-09-07"), false);
eq("a vehicle is unavailable before its start date",
  CXC.vehicleAvailableOn({ id: "v", status: "active", availableFrom: "2026-10-01" }, "2026-09-07"), false);
eq("and available on it",
  CXC.vehicleAvailableOn({ id: "v", status: "active", availableFrom: "2026-10-01" }, "2026-10-01"), true);

const aFleet = fleetFixture();
r = CXC.packSchedule({
  items: [
    { id: "f1", locationId: "L1", activityTypeId: "conduit", qty: 180 },
    { id: "f2", locationId: "L2", activityTypeId: "conduit", qty: 180 }
  ],
  windows: CXC.generateWindows("2026-09-07", "2026-09-07", aFleet, ["night"]),
  data: aFleet
});
eq("two crews sharing ONE truck means only one crew works", r.windows[0].crewCount, 1);
ok("so the second scope slips past the single night", r.unplaced.length === 1, JSON.stringify(r.unplaced));

const aFleet2 = fleetFixture();
aFleet2.vehicles[1].status = "active";
aFleet2.crews[1].vehicleIds = ["v2"];
r = CXC.packSchedule({
  items: [
    { id: "f1", locationId: "L1", activityTypeId: "conduit", qty: 180 },
    { id: "f2", locationId: "L2", activityTypeId: "conduit", qty: 180 }
  ],
  windows: CXC.generateWindows("2026-09-07", "2026-09-07", aFleet2, ["night"]),
  data: aFleet2
});
eq("give each crew its own truck and both work", r.windows[0].crewCount, 2);
eq("and the whole scope lands in one night", r.unplaced.length, 0);

// ── Materials ──────────────────────────────────────────────────────────────
console.log("\n── materials ──");
function matFixture(over) {
  const f = fixture();
  f.materials = [{ id: "m1", code: "C-1", name: "Conduit stock", unit: "lf", onHand: 0, availableFrom: "" }];
  f.activityTypes[0].materials = [{ materialId: "m1", qtyPerUnit: 1 }];
  Object.assign(f.materials[0], over || {});
  return f;
}
eq("no delivery date means no material constraint",
  CXC.materialReadyDate(matFixture().activityTypes[0], matFixture()), "");

const aLate = matFixture({ availableFrom: "2026-09-21" });
eq("the ready date is the latest material delivery",
  CXC.materialReadyDate(aLate.activityTypes[0], aLate), "2026-09-21");

r = CXC.packSchedule({
  items: [{ id: "m-1", locationId: "L1", activityTypeId: "conduit", qty: 180 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", aLate, ["night"]),
  data: aLate
});
ok("work cannot start before its material is on site",
  r.assignments.length > 0 && r.assignments[0].date >= "2026-09-21", r.assignments[0] && r.assignments[0].date);

const aShort = matFixture({ onHand: 100 });
r = CXC.packSchedule({
  items: [{ id: "m-2", locationId: "L1", activityTypeId: "conduit", qty: 300 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", aShort, ["night"]),
  data: aShort
});
eq("stock on hand caps how much gets installed",
  r.assignments.reduce((s, x) => s + x.qty, 0), 100);
ok("and the leftover says the stock ran out",
  /stock exhausted/.test(r.unplaced[0].reason), r.unplaced[0].reason);
eq("the take-off reports what the plan drew", r.materials[0].required, 100);

const aPlenty = matFixture({ onHand: 100 });
r = CXC.packSchedule({
  items: [{ id: "m-3", locationId: "L1", activityTypeId: "conduit", qty: 60 }],
  windows: CXC.generateWindows("2026-09-07", "2026-09-30", aPlenty, ["night"]),
  data: aPlenty
});
eq("no shortfall when stock covers the scope", r.materials[0].shortfall, 0);

// ── Phase order ────────────────────────────────────────────────────────────
console.log("\n── phase order ──");
// Two crews, each PINNED to one item, so the only thing that can stop crew 2
// starting on night 1 is the phase rule itself.
function phaseFixture(enforce) {
  const f = fixture();
  f.globals.enforcePhaseOrder = enforce;
  f.shiftPatterns[0].maxCrews = 2;
  f.phases = [
    { id: "p1", seq: 1, name: "Rough-in" },
    { id: "p2", seq: 2, name: "Cable pull" }
  ];
  f.crews = [
    { id: "c1", name: "Crew 1", size: 2, efficiency: 1, skills: [], shiftPatternIds: [], vehicleIds: [] },
    { id: "c2", name: "Crew 2", size: 2, efficiency: 1, skills: [], shiftPatternIds: [], vehicleIds: [] }
  ];
  return f;
}
// q1 is far too big to finish quickly; q2 is one night's work behind it.
function phaseItems(loc2) {
  return [
    { id: "q1", locationId: "L1", phaseId: "p1", activityTypeId: "conduit", qty: 1440, crewId: "c1" },
    { id: "q2", locationId: loc2, phaseId: "p2", activityTypeId: "conduit", qty: 90, crewId: "c2" }
  ];
}
const worksNight1 = (res, id) => res.assignments.some(x => x.itemId === id && x.date === "2026-09-07");

const aPhase = phaseFixture(true);
r = CXC.packSchedule({
  items: phaseItems("L1"),
  windows: CXC.generateWindows("2026-09-07", "2026-10-30", aPhase, ["night"]),
  data: aPhase
});
eq("phase 1 starts on night one", worksNight1(r, "q1"), true);
eq("phase 2 at the SAME location is held back", worksNight1(r, "q2"), false);
const lastP1 = r.assignments.filter(x => x.itemId === "q1").pop();
const firstP2 = r.assignments.find(x => x.itemId === "q2");
ok("and only starts once phase 1 there is complete",
  firstP2 && lastP1 && firstP2.date >= lastP1.date,
  JSON.stringify({ firstP2: firstP2 && firstP2.date, lastP1: lastP1 && lastP1.date }));

// A different location is NOT blocked by another location's open phase.
const aPhase2 = phaseFixture(true);
r = CXC.packSchedule({
  items: phaseItems("L2"),
  windows: CXC.generateWindows("2026-09-07", "2026-10-30", aPhase2, ["night"]),
  data: aPhase2
});
eq("phase order is per location, not project-wide", worksNight1(r, "q2"), true);

// Switch the rule off and the same-location successor is free to run.
const aFree = phaseFixture(false);
r = CXC.packSchedule({
  items: phaseItems("L1"),
  windows: CXC.generateWindows("2026-09-07", "2026-10-30", aFree, ["night"]),
  data: aFree
});
eq("turning phase order off releases it", worksNight1(r, "q2"), true);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
