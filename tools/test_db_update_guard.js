// Behavioral test for the _dbUpdate optimistic-concurrency guard (Tier 1 #3).
// Loads the real app.js via the headless harness, swaps in a controllable fetch
// mock, and exercises _dbUpdate with and without the { expect } guard.
// Run: node tools/test_db_update_guard.js
"use strict";

const { loadApp } = require("./_load_app.js");

let pass = 0, fail = 0;
function ok(name, cond, details) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${details ? " — " + details : ""}`); }
}

const { sandbox, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("FATAL: load failed in", loadErrorFile, "\n", loadError.message); process.exit(1); }

// Controllable fetch: record the URL, return whatever `nextRows` is set to.
let lastUrl = "", nextRows = [];
sandbox.fetch = async function (url) {
  lastUrl = String(url);
  return { ok: true, status: 200, json: async () => nextRows, text: async () => "" };
};

async function main() {
  const dbUpdate = sandbox._dbUpdate;
  ok("_dbUpdate is a function", typeof dbUpdate === "function");
  if (typeof dbUpdate !== "function") return;

  // 1) No guard + zero rows matched → resolves (legacy last-write-wins).
  nextRows = [];
  let threw = false;
  try { await dbUpdate("delay_log", { overall_notes: "x" }, { id: "1" }); }
  catch (_) { threw = true; }
  ok("no guard + 0 rows → does not throw (legacy behavior preserved)", threw === false);
  ok("no guard → WHERE has only the match column", /id=eq\.1/.test(lastUrl) && !/updated_at/.test(lastUrl), lastUrl);

  // 2) Guard + zero rows matched → throws a CONFLICT (row moved under us).
  nextRows = [];
  let code = null;
  try { await dbUpdate("delay_log", { overall_notes: "x" }, { id: "1" }, { expect: { updated_at: "2026-07-14T00:00:00Z" } }); }
  catch (e) { code = e.code; }
  ok("guard + 0 rows → throws", code != null);
  ok("conflict error carries code === 'CONFLICT'", code === "CONFLICT");
  ok("guard column folded into WHERE clause", /updated_at=eq\./.test(lastUrl) && /id=eq\.1/.test(lastUrl), lastUrl);

  // 3) Guard + a matching row → resolves with the returned rows (success path).
  nextRows = [{ id: "1", overall_notes: "x" }];
  let res = null, threw2 = false;
  try { res = await dbUpdate("delay_log", { overall_notes: "x" }, { id: "1" }, { expect: { updated_at: "2026-07-14T00:00:00Z" } }); }
  catch (_) { threw2 = true; }
  ok("guard + matching row → resolves with rows", threw2 === false && Array.isArray(res) && res.length === 1);

  // ── Conflict-surfacing helpers (Tier 1 #4) ──────────────────────────────────
  const isConflict = sandbox._isConflict;
  const handle = sandbox._handleWriteConflict;
  ok("_isConflict is a function", typeof isConflict === "function");
  ok("_handleWriteConflict is a function", typeof handle === "function");

  ok("_isConflict true for CONFLICT error", isConflict({ code: "CONFLICT" }) === true);
  ok("_isConflict false for generic error", isConflict(new Error("boom")) === false);
  ok("_isConflict false for null", isConflict(null) === false);

  // Stub toast to capture what the user would see, and a reload spy.
  let toasted = null, reloaded = 0;
  sandbox.toast = (msg, type) => { toasted = { msg, type }; };

  // A CONFLICT is handled: returns true, toasts an error, invokes reload.
  toasted = null; reloaded = 0;
  const conflictErr = Object.assign(new Error("changed"), { code: "CONFLICT" });
  const handledConflict = handle(conflictErr, { what: "Punch #7", reload: () => { reloaded++; } });
  ok("_handleWriteConflict returns true on CONFLICT", handledConflict === true);
  ok("conflict shows an error toast", toasted && toasted.type === "error");
  ok("conflict toast names the record", toasted && /Punch #7/.test(toasted.msg));
  await Promise.resolve();  // reload is scheduled on a microtask
  ok("conflict triggers reload()", reloaded === 1);

  // A generic error is NOT handled: returns false, no toast, no reload.
  toasted = null; reloaded = 0;
  const handledGeneric = handle(new Error("network down"), { what: "Punch #7", reload: () => { reloaded++; } });
  ok("_handleWriteConflict returns false on generic error", handledGeneric === false);
  ok("generic error does not toast here (caller handles it)", toasted === null);
  ok("generic error does not reload", reloaded === 0);
}

console.log("=== _dbUpdate optimistic-concurrency guard ===\n");
main()
  .then(() => { console.log(`\n${pass} passed, ${fail} failed.\n`); process.exit(fail === 0 ? 0 : 1); })
  .catch((e) => { console.error("test crashed:", e); process.exit(1); });
