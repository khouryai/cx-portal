"use strict";
// Drawings: deleting a set/page restores the previous revision
// (_drwPickRestorations in drw-set-manage.js).
const { _drwPickRestorations, _drwFindOrphans } = require("../drw-set-manage.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };

const S = (id, set, num, cur, created, rev, loc = "L1") =>
  ({ id, set_id: set, sheet_number: num, is_current: cur, created_at: created, revision: rev, location: loc });

console.log("=== drawings revision restore ===\n");
// Rev 0 (set A) superseded by Rev 1 (set B) superseded by Rev 2 (set C).
const a1 = S("a1", "A", "SIG-101", false, "2026-01-01", "0");
const b1 = S("b1", "B", "sig-101 ", false, "2026-02-01", "1");
const c1 = S("c1", "C", "SIG-101", true, "2026-03-01", "2");
const c2 = S("c2", "C", "SIG-200", true, "2026-03-01", "2");   // only revision
const other = S("o1", "D", "SIG-101", true, "2026-03-05", "9", "L2"); // other location
const all = [a1, b1, c1, c2, other];

let p = _drwPickRestorations([c1, c2], all);
ok("deleting newest set restores the most recent remaining revision", p.length === 1 && p[0].id === "b1", JSON.stringify(p.map(x => x.id)));
ok("sheet number match is case/space-insensitive", p[0] && p[0].sheet_number === "sig-101 ");
ok("a drawing with no earlier revision restores nothing", !p.some(x => x.sheet_number === "SIG-200"));
ok("other locations are never touched", !p.some(x => x.location === "L2"));

p = _drwPickRestorations([a1], all);
ok("deleting a superseded set restores nothing", p.length === 0);

p = _drwPickRestorations([c1], [a1, b1, c1, S("b9", "B", "SIG-101", true, "2026-02-02", "1")]);
ok("no restore when another revision is already current", p.length === 0);

// Orphans: a drawing whose current revision was deleted earlier.
const o0 = S("o0", "A", "SIG-5", false, "2026-01-01", "0");
const o1 = S("o1x", "B", "SIG-5", false, "2026-02-01", "1");
const ok1 = S("k1", "B", "SIG-6", true, "2026-02-01", "1");
let orph = _drwFindOrphans([o0, o1, ok1, other], "L1");
ok("orphaned drawing found, newest remaining revision picked", orph.length === 1 && orph[0].id === "o1x", JSON.stringify(orph.map(x => x.id)));
ok("drawings that still have a current revision are not orphans", !orph.some(x => x.sheet_number === "SIG-6"));
ok("orphan scan is scoped to the location", _drwFindOrphans([o0, o1], "L2").length === 0);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
