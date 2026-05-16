// Headless test for _planningTestActivityStats — the core math that drives
// per-cell badges and row-level progress chips for the new Lookahead↔Test
// Register Activity link.
// Run from cx-portal directory:  node tools/test_activity_stats.js

let passed = 0, failed = 0;
function ok(name, cond, details = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${details ? ' — ' + details : ''}`); }
}

// Re-implement the helper exactly as it lives in app.js so we can exercise it
// without booting the browser.
let TI = [];
let PLANNING_TEST_RESULTS = [];

function _planningTestActivityStats(activityName, date = null) {
  if (!activityName) return null;
  const tiInActivity = TI.filter(t => (t.Activity || '').trim() === activityName.trim());
  const totalInActivity = tiInActivity.length;
  const completeInActivity = tiInActivity.filter(t => t.Status === 'Complete' || t.Status === 'Pass' || t.Status === 'Passed').length;
  if (!date) {
    return { totalInActivity, completeInActivity, executedToday: 0, passed: 0, failed: 0, blocked: 0 };
  }
  const dayResults = (PLANNING_TEST_RESULTS || []).filter(r =>
    (r.activity || '').trim() === activityName.trim() && r.date_tested === date
  );
  const uniqueTests = new Set(dayResults.map(r => r.test_id));
  return {
    totalInActivity,
    completeInActivity,
    executedToday: uniqueTests.size,
    passed:  dayResults.filter(r => r.result === 'Pass').length,
    failed:  dayResults.filter(r => r.result === 'Fail').length,
    blocked: dayResults.filter(r => r.result === 'Blocked').length,
  };
}

function resetFixtures() {
  TI = [
    { TestID: 't1',  Activity: 'CBTC Wayside Verification', Status: 'Complete' },
    { TestID: 't2',  Activity: 'CBTC Wayside Verification', Status: 'Complete' },
    { TestID: 't3',  Activity: 'CBTC Wayside Verification', Status: 'Failed' },
    { TestID: 't4',  Activity: 'CBTC Wayside Verification', Status: 'Not Started' },
    { TestID: 't5',  Activity: 'CBTC Wayside Verification', Status: 'Not Started' },
    { TestID: 't6',  Activity: 'DCS SIT - Static',           Status: 'Complete' },
    { TestID: 't7',  Activity: 'DCS SIT - Static',           Status: 'Complete' },
    { TestID: 't8',  Activity: 'IXL Field - Sim Test',       Status: 'In Progress' },
  ];
  PLANNING_TEST_RESULTS = [
    { test_id: 't1', activity: 'CBTC Wayside Verification', date_tested: '2026-05-15', result: 'Pass' },
    { test_id: 't2', activity: 'CBTC Wayside Verification', date_tested: '2026-05-15', result: 'Pass' },
    { test_id: 't3', activity: 'CBTC Wayside Verification', date_tested: '2026-05-15', result: 'Fail' },
    { test_id: 't1', activity: 'CBTC Wayside Verification', date_tested: '2026-05-16', result: 'Pass' }, // retest
    { test_id: 't6', activity: 'DCS SIT - Static',          date_tested: '2026-05-15', result: 'Pass' },
    { test_id: 't8', activity: 'IXL Field - Sim Test',      date_tested: '2026-05-16', result: 'Blocked' },
  ];
}

console.log('\n=== Test 1: Row-level totals (no date) ===');
resetFixtures();
const r1 = _planningTestActivityStats('CBTC Wayside Verification');
ok('5 total test items',                 r1.totalInActivity === 5);
ok('2 complete (Status=Complete)',       r1.completeInActivity === 2);
ok('executedToday=0 for row total',      r1.executedToday === 0);

console.log('\n=== Test 2: Per-cell stats for a specific date ===');
resetFixtures();
const r2 = _planningTestActivityStats('CBTC Wayside Verification', '2026-05-15');
ok('3 unique tests executed',            r2.executedToday === 3, `got ${r2.executedToday}`);
ok('2 passed',                           r2.passed === 2);
ok('1 failed',                           r2.failed === 1);
ok('0 blocked',                          r2.blocked === 0);
ok('total still 5',                      r2.totalInActivity === 5);

console.log('\n=== Test 3: Date with no execution (planned but stale) ===');
resetFixtures();
const r3 = _planningTestActivityStats('CBTC Wayside Verification', '2026-05-20');
ok('0 executed',                         r3.executedToday === 0);
ok('Total still resolves',               r3.totalInActivity === 5);
ok('passed/failed/blocked = 0',          r3.passed === 0 && r3.failed === 0 && r3.blocked === 0);

console.log('\n=== Test 4: Retest counts once per test_id ===');
resetFixtures();
// t1 was tested on both 5/15 and 5/16. On 5/16 we should see 1 unique test, not double-count.
const r4 = _planningTestActivityStats('CBTC Wayside Verification', '2026-05-16');
ok('1 unique test (retest of t1)',       r4.executedToday === 1);
ok('1 pass result',                      r4.passed === 1);

console.log('\n=== Test 5: Different activity returns its own stats ===');
resetFixtures();
const r5 = _planningTestActivityStats('DCS SIT - Static', '2026-05-15');
ok('1 test executed',                    r5.executedToday === 1);
ok('Total = 2 for this activity',        r5.totalInActivity === 2);
ok('1 passed',                           r5.passed === 1);

console.log('\n=== Test 6: Blocked counted correctly ===');
resetFixtures();
const r6 = _planningTestActivityStats('IXL Field - Sim Test', '2026-05-16');
ok('1 blocked',                          r6.blocked === 1);
ok('0 passed',                           r6.passed === 0);

console.log('\n=== Test 7: Unlinked / empty activity returns null ===');
resetFixtures();
ok('null for empty name',                _planningTestActivityStats(null) === null);
ok('null for empty string',              _planningTestActivityStats('') === null);

console.log('\n=== Test 8: Unknown activity returns 0/0 stats ===');
resetFixtures();
const r8 = _planningTestActivityStats('Activity That Does Not Exist', '2026-05-15');
ok('totalInActivity = 0',                r8.totalInActivity === 0);
ok('executedToday = 0',                  r8.executedToday === 0);

console.log('\n=== Test 9: Whitespace-tolerant matching ===');
resetFixtures();
const r9 = _planningTestActivityStats('  CBTC Wayside Verification  ', '2026-05-15');
ok('Trims and matches',                  r9.executedToday === 3);

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
