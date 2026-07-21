"use strict";
// Unit test for cx-store.js — the minimal observable store (Tier 3 #12).
// Run: node tools/test_cx_store.js
const CXStore = require("../cx-store.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("=== cx-store observable store ===\n");

ok("get returns fallback when unset", CXStore.get("page", "home") === "home");
CXStore.set("page", "dashboard");
ok("set then get", CXStore.get("page") === "dashboard");
ok("has true after set", CXStore.has("page") === true);
ok("has false for unset key", CXStore.has("never") === false);

CXStore.set("n", 1);
CXStore.update("n", (v) => v + 1);
ok("update applies fn to current value", CXStore.get("n") === 2);

let seen = [];
const unsub = CXStore.subscribe("filter", (v) => seen.push(v));
CXStore.set("filter", "open");
CXStore.set("filter", "closed");
ok("subscriber notified on each set", seen.length === 2 && seen[1] === "closed");

let imm = null;
CXStore.set("imm", "X");
CXStore.subscribe("imm", (v) => { imm = v; }, true);
ok("immediate:true fires with current value", imm === "X");

unsub();
CXStore.set("filter", "reopened");
ok("unsubscribe stops further notifications", seen.length === 2);

let after = false;
CXStore.subscribe("boom", () => { throw new Error("kaboom"); });
CXStore.subscribe("boom", () => { after = true; });
CXStore.set("boom", 1);
ok("a throwing subscriber is isolated (others still run)", after === true);

ok("keys() lists set keys", CXStore.keys().includes("page"));

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
