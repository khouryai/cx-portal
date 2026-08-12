// Unit test for _vmReadiness — the Vehicle Management car-status rollup.
//
// Focus: a car's overall status can reach "ready" on workflow completion ALONE,
// with no equipment tied to the car. Equipment is optional; when it IS tied, its
// software compliance is still enforced. Exercises the REAL app.js function.
//
// Run: node tools/test_vm_readiness.js
const vm = require("vm");
const { loadApp } = require("./_load_app.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error("  FAIL: " + msg); } }

const { ctx, loadError, loadErrorFile } = loadApp();
if (loadError) { console.error("load failed in " + loadErrorFile + ": " + loadError); process.exit(1); }
const run = expr => vm.runInContext(expr, ctx);

// Helper: set the car + workflow + equipment globals, then read _vmReadiness.
function readiness(workflow, equip) {
  run(`VEHICLES = [{ id: 'car1', car_number: '101', car_type: 'D' }];`);
  run(`VEH_WORKFLOW = ${JSON.stringify(workflow)};`);
  run(`VEH_EQUIP = ${JSON.stringify(equip || [])};`);
  run(`PUNCH_DB = [];`);
  return run(`(function(){ const r = _vmReadiness('car1'); return { status: r.status, wfComplete: r.wfComplete, wfTotal: r.wfTotal, eqTotal: r.eqTotal }; })()`);
}
const wf = (seq, status, extra) => Object.assign({ id: 'w' + seq, vehicle_id: 'car1', seq, title: 'Act ' + seq, status }, extra || {});

console.log("=== _vmReadiness — vehicle car-status rollup ===\n");

// 1) All required workflows Complete, NO equipment → READY (the fix).
let r = readiness([wf(1, 'Complete'), wf(2, 'Complete')], []);
assert(r.status === 'ready', `all workflows complete + no equipment → ready (got '${r.status}', wf ${r.wfComplete}/${r.wfTotal}, eq ${r.eqTotal})`);

// 2) 'N/A' counts as done, still no equipment → READY.
r = readiness([wf(1, 'Complete'), wf(2, 'N/A')], []);
assert(r.status === 'ready', `Complete + N/A + no equipment → ready (got '${r.status}')`);

// 3) A workflow still In Progress → not all done → IN PROGRESS.
r = readiness([wf(1, 'Complete'), wf(2, 'In Progress')], []);
assert(r.status === 'inprogress', `an incomplete workflow keeps status in-progress (got '${r.status}')`);

// 4) A Failed workflow → BLOCKED (takes priority over completion).
r = readiness([wf(1, 'Complete'), wf(2, 'Failed')], []);
assert(r.status === 'blocked', `a failed workflow blocks (got '${r.status}')`);

// 5) No required workflow items at all → NOT ready (in progress).
r = readiness([wf(1, 'Complete', { required: false })], []);
assert(r.status === 'inprogress' && r.wfTotal === 0, `a car with no REQUIRED workflow items is not ready (got '${r.status}', total ${r.wfTotal})`);

// 6) Equipment IS tied but unresolved (no VDD target) → compliance still enforced,
//    so completion alone does NOT make it ready.
r = readiness([wf(1, 'Complete'), wf(2, 'Complete')], [{ id: 'e1', vehicle_id: 'car1', equipment_name: 'ATP-Zzz', loaded_version: '' }]);
assert(r.status === 'inprogress' && r.eqTotal === 1, `tied equipment with unresolved compliance keeps it in-progress (got '${r.status}', eq ${r.eqTotal})`);

console.log(`\n_vmReadiness: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
