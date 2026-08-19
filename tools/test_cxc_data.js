#!/usr/bin/env node
"use strict";
/*
 * Unit suite for cxc-data.js — the schema, the seed and the CRUD helpers.
 *
 * The management screens are GENERATED from ENTITIES, so a broken schema is a
 * broken app: these tests guard the invariants the generic editor relies on
 * (every ref points at a real entity, every entity can produce a usable blank
 * row, deleting something reports what still points at it).
 */
const path = require("path");
const CXC = require(path.resolve(__dirname, "..", "cxc-model.js"));
global.CXC = CXC;
const D = require(path.resolve(__dirname, "..", "cxc-data.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected));
}

// ── Schema integrity ───────────────────────────────────────────────────────
console.log("\n── schema ──");
const KEYS = Object.keys(D.ENTITIES);

ok("every entity in ENTITY_ORDER exists in ENTITIES",
  D.ENTITY_ORDER.every(k => !!D.ENTITIES[k]), D.ENTITY_ORDER.join(","));
ok("every entity is reachable from the sidebar order",
  KEYS.every(k => D.ENTITY_ORDER.includes(k)),
  KEYS.filter(k => !D.ENTITY_ORDER.includes(k)).join(","));

KEYS.forEach((k) => {
  const spec = D.ENTITIES[k];
  ok(k + " declares a label, singular and icon", !!(spec.label && spec.singular && spec.icon));
  ok(k + " has at least one field", (spec.fields || []).length > 0);
});

const VALID_TYPES = ["text", "textarea", "number", "date", "time", "select", "multiselect", "checkbox", "dow", "materials"];
let badType = null, badRef = null, badOpts = null;
KEYS.forEach((k) => {
  (D.ENTITIES[k].fields || []).forEach((f) => {
    if (!VALID_TYPES.includes(f.type)) badType = k + "." + f.key + " = " + f.type;
    if (f.ref && !D.ENTITIES[f.ref]) badRef = k + "." + f.key + " → " + f.ref;
    if ((f.type === "select" || f.type === "multiselect") && !f.ref && !(f.options || []).length) {
      badOpts = k + "." + f.key;
    }
  });
});
ok("every field uses a type the editor can render", !badType, badType);
ok("every ref points at a real entity", !badRef, badRef);
ok("every select has options or a ref to draw them from", !badOpts, badOpts);

// ── Seed ───────────────────────────────────────────────────────────────────
console.log("\n── seed ──");
const seed = D.seed();
eq("the seed validates clean", D.validate(seed).length, 0);
KEYS.forEach((k) => ok("seed populates " + k, (seed[k] || []).length > 0, "0 rows"));
ok("seed ids are unique per entity", KEYS.every((k) => {
  const ids = (seed[k] || []).map(r => r.id);
  return new Set(ids).size === ids.length;
}));
ok("every scope item names a real activity",
  seed.scope.every(s => !!CXC.byId(seed.activityTypes, s.activityTypeId)));
ok("every scope item names a real location",
  seed.scope.every(s => !!CXC.byId(seed.locations, s.locationId)));

// ── normalize ──────────────────────────────────────────────────────────────
console.log("\n── normalize ──");
const bare = D.normalize({});
ok("normalize fills every entity array", KEYS.every(k => Array.isArray(bare[k])));
eq("normalize supplies the default globals", bare.globals.crewScalingExponent, D.DEFAULT_GLOBALS.crewScalingExponent);
ok("normalize supplies a plan range", !!(bare.plan && bare.plan.from && bare.plan.to));
const partial = D.normalize({ globals: { productivityFactor: 0.5 } });
eq("a partial globals object keeps the value given", partial.globals.productivityFactor, 0.5);
eq("and still gets the missing defaults", partial.globals.breakMinPerShift, D.DEFAULT_GLOBALS.breakMinPerShift);

// ── ids + CRUD ─────────────────────────────────────────────────────────────
console.log("\n── crud ──");
const d = D.seed();
eq("nextId continues the existing series", D.nextId(d, "locations"), "loc-6");
eq("scope ids stay zero-padded", D.nextId(d, "scope"), "S-013");

const added = D.addRow(d, "locations");
eq("addRow appends", d.locations.length, 6);
eq("addRow returns the new row with its id", added.id, "loc-6");

const blank = D.emptyRow(d, "crews");
ok("a blank row gives arrays for list fields", Array.isArray(blank.skills) && Array.isArray(blank.vehicleIds));
eq("and usable numeric defaults", blank.size, 2);
const blankAct = D.emptyRow(d, "activityTypes");
eq("a new activity defaults to a splittable unit rate", blankAct.divisible, "continuous");
ok("a new shift window defaults to weekdays", D.emptyRow(d, "shiftPatterns").daysOfWeek.length === 5);

D.updateRow(d, "locations", "loc-6", "name", "New yard");
eq("updateRow patches one field", CXC.byId(d.locations, "loc-6").name, "New yard");
eq("updateRow on a missing row returns null", D.updateRow(d, "locations", "nope", "name", "x"), null);

const dup = D.duplicateRow(d, "crews", "crew-1");
eq("duplicateRow makes a new id", dup.id, "crew-4");
eq("and marks the copy", dup.name, "Crew A — electrical (copy)");
eq("and inserts it right after the original", d.crews[1].id, "crew-4");
ok("the copy is deep, not shared", dup.skills !== CXC.byId(d.crews, "crew-1").skills);

eq("removeRow deletes", D.removeRow(d, "crews", "crew-4"), true);
eq("removeRow on a missing id is false", D.removeRow(d, "crews", "nope"), false);

// ── references ─────────────────────────────────────────────────────────────
console.log("\n── references ──");
const d2 = D.seed();
const vehRefs = D.referencesTo(d2, "vehicles", "veh-1");
ok("a vehicle reports the crew that needs it",
  vehRefs.some(r => r.entity === "crews" && r.id === "crew-1"), JSON.stringify(vehRefs));

const actRefs = D.referencesTo(d2, "activityTypes", "act-1");
ok("an activity reports the scope that uses it", actRefs.some(r => r.entity === "scope"));
ok("and the crew qualified for it", actRefs.some(r => r.entity === "crews"));

const matRefs = D.referencesTo(d2, "materials", "mat-1");
ok("a material reports the activity whose bill of materials lists it",
  matRefs.some(r => r.entity === "activityTypes" && r.id === "act-1"), JSON.stringify(matRefs));

eq("an unreferenced row reports nothing", D.referencesTo(d2, "locations", "nope").length, 0);

// ── validate ───────────────────────────────────────────────────────────────
console.log("\n── validate ──");
const d3 = D.seed();
D.removeRow(d3, "locations", "loc-1");
ok("deleting a location surfaces the orphaned scope",
  D.validate(d3).some(p => p.entity === "scope" && /missing Location/.test(p.message)),
  JSON.stringify(D.validate(d3).slice(0, 3)));

const d4 = D.seed();
D.updateRow(d4, "scope", "S-001", "qty", 0);
ok("a zero quantity is reported",
  D.validate(d4).some(p => p.id === "S-001" && /quantity is zero/.test(p.message)));

const d5 = D.seed();
D.updateRow(d5, "locations", "loc-1", "name", "");
ok("a blank required field is reported",
  D.validate(d5).some(p => p.id === "loc-1" && /Name is required/.test(p.message)));

const d6 = D.seed();
D.updateRow(d6, "activityTypes", "act-1", "materials", [{ materialId: "gone", qtyPerUnit: 1 }]);
ok("a dangling material line is reported",
  D.validate(d6).some(p => p.id === "act-1" && /missing material/.test(p.message)));

// ── labels ─────────────────────────────────────────────────────────────────
console.log("\n── labels ──");
const d7 = D.seed();
eq("a location reads code then name", D.labelFor(d7, "locations", "loc-3"), "CIL 12 — Interlocking 12");
eq("a phase leads with its sequence", D.labelFor(d7, "phases", "ph-2"), "2. Cable pull");
ok("a scope item names its activity and place",
  /S-001 · Conduit — 4" RGS @ MP 1.0–1.5/.test(D.labelFor(d7, "scope", "S-001")),
  D.labelFor(d7, "scope", "S-001"));
eq("an unknown id falls back to the id", D.labelFor(d7, "crews", "nope"), "nope");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
