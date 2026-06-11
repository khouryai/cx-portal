// ==========================================
// HITACHI Rail T&C Portal — Compute core (status + weighted-progress math)
// Extracted from app.js (P3-1 strangler split). Classic <script> loaded before
// app.js. Pure functions; the weight-lookup BUILDERS stay in app.js (they read
// app state) and are resolved dynamically when default lookups are needed.
// Behavior is pinned by tools/test_wgtstat.js, test_activity_compute.js,
// test_status_compute.js — run tools/run_tests.js after any change here.
// ==========================================

function getStatusBadge(status) {
  if (!status) return '<span class="badge badge-notstarted">—</span>';
  const s = status.toString();
  const map = {
    'Pass': 'badge-passed',
    'Passed': 'badge-passed',
    'Closed': 'badge-closed',
    'Fail': 'badge-failed',
    'Failed': 'badge-failed',
    'Blocked': 'badge-warn',
    'Not Started': 'badge-notstarted',
    'Not Applicable': 'badge-notstarted',
    'Future Test': 'badge-futuretest',
    'In Progress': 'badge-inprog',
    'Open': 'badge-open',
    'Activity Not Started': 'badge-notstarted',
    'Pending Test Report Acceptance': 'badge-pending',
    'Work Required': 'badge-work',
    'Ready To Close': 'badge-ready',
    'Ready For Review': 'badge-ready',
    'Initiated': 'badge-initiated',
    'Draft': 'badge-draft',
    'Work Not Accepted': 'badge-failed',
    'Not Accepted By Creator': 'badge-failed',
  };
  const cls = map[s] || 'badge-notstarted';
  return `<span class="badge ${cls}">${s}</span>`;
}

function getPriorityPill(priority) {
  if (!priority) return '<span class="priority-pill priority-low">—</span>';
  const p = priority.toString().toLowerCase();
  return `<span class="priority-pill priority-${p}">${p}</span>`;
}

// Resolve weight for a single TI row using shared lookups (TestCaseCode+TestName).
// Returns 1 if not yet weighted.
function _tcWeightFor(r, tcLookup) {
  const m = tcLookup || _buildTestCaseWeightLookup();
  return m.get(`${r.TestCaseCode || ''}||${r.TestName || ''}`) ?? 1;
}

// Resolve activity weight for a TI row using shared lookups (Subsystem+Activity).
function _actWeightFor(r, actLookup) {
  const m = actLookup || _buildActivityWeightLookup();
  return m.get(`${r.Subsystem || ''}||${r.Activity || ''}`) ?? 1;
}

function _amComputeStatus(act) {
  // Exclude parent rows (their status is derived) and child rows count instead
  const items = act.items.filter(r => !r.IsParent);
  if (!items.length) return 'Open';

  const isDone   = r => ['Pass','Passed','Complete','Not Applicable'].includes(r.Status);
  const isFuture = r => r.Status === 'Future Test';

  if (items.every(isFuture)) return 'Future Test';
  if (items.every(isDone))   return 'Closed';

  // Some done + the rest are all Future Test (none Open/In Progress/Failed/Blocked)
  if (items.every(r => isDone(r) || isFuture(r)) && items.some(isDone) && items.some(isFuture)) {
    return 'Partial Completion';
  }

  return 'Open';
}

// Pass a shared `tcw` map when calling in a loop to avoid rebuilding it per activity.
function _amComputeCompletion(act, tcw) {
  // Include Future Test in the denominator so activities show e.g. "0/4" not "0/0"
  const eligible = act.items.filter(r => !r.IsParent);
  const doneStatuses = new Set(['Pass','Not Applicable','Complete','Passed']);
  const done  = eligible.filter(r => doneStatuses.has(r.Status)).length;
  const total = eligible.length;
  // Weighted completion via shared test_case_weights (Layer 2 only here — activity
  // weight is constant across this activity so it cancels in the percentage).
  const _tcw   = tcw || _buildTestCaseWeightLookup();
  const w      = r => _tcWeightFor(r, _tcw);
  const doneW  = eligible.filter(r => doneStatuses.has(r.Status)).reduce((s,r)=>s+w(r), 0);
  const totalW = eligible.reduce((s,r)=>s+w(r), 0);
  const pct    = totalW > 0 ? Math.round((doneW / totalW) * 100) : 0;
  return { done, total, doneW, totalW, pct };
}

// Weighted completion (Layer 2 only) — used for P6 progress display.
// Pass a shared `tcw` map when calling in a loop. Activity weight cancels in a
// per-activity percentage, so we only need TC weights.
const _P6_DONE_STATUSES = new Set(['Pass','Passed','Complete','Not Applicable']);
function _p6WeightedCompletion(act, tcw) {
  const eligible = act.items.filter(r => !r.IsParent && r.Status !== 'Future Test');
  const _tcw     = tcw || _buildTestCaseWeightLookup();
  const w        = r => _tcWeightFor(r, _tcw);
  const totalW   = eligible.reduce((s, r) => s + w(r), 0);
  const doneW    = eligible.filter(r => _P6_DONE_STATUSES.has(r.Status)).reduce((s, r) => s + w(r), 0);
  const pct = totalW > 0 ? Math.round((doneW / totalW) * 100) : 0;
  return { doneW, totalW, pct };
}

function _trpStatusCounts(items) {
  const counts = { total: items.length, passed: 0, failed: 0, blocked: 0, inProgress: 0, notStarted: 0, future: 0 };
  items.forEach(r => {
    const s = String(r.Status || '').toLowerCase();
    if (['pass', 'passed', 'complete', 'completed'].includes(s)) counts.passed++;
    else if (['fail', 'failed'].includes(s)) counts.failed++;
    else if (s === 'blocked') counts.blocked++;
    else if (s === 'in progress') counts.inProgress++;
    else if (s === 'future test' || s === 'future') counts.future++;
    else counts.notStarted++;
  });
  return counts;
}

// Compute weighted status totals for an array of test items.
// Effective weight = activity_weight (Subsystem+ActivityName) × test_case_weight (Code+TestName).
// Both weights are now SHARED — one row in the weights tables drives every instance.
// Pass pre-built `aw` and/or `tcw` maps to avoid rebuilding them in hot loops.
function _wgtStat(items, awLookup, tcwLookup) {
  const aw  = awLookup  || _buildActivityWeightLookup();
  const tcw = tcwLookup || _buildTestCaseWeightLookup();
  const w = r => {
    const tcKey = `${r.TestCaseCode || ''}||${r.TestName || ''}`;
    const aKey  = `${r.Subsystem    || ''}||${r.Activity || ''}`;
    const tcW   = tcw.get(tcKey) ?? 1;
    const actW  = aw.get(aKey)   ?? 1;
    return tcW * actW;
  };
  const sum = (arr) => arr.reduce((s, r) => s + w(r), 0);
  const totalW    = sum(items);
  const passW     = sum(items.filter(r => ['Pass','Passed','Complete'].includes(r.Status)));
  const naW       = sum(items.filter(r => r.Status === 'Not Applicable'));
  const failW     = sum(items.filter(r => ['Fail','Failed'].includes(r.Status)));
  const blockedW  = sum(items.filter(r => r.Status === 'Blocked'));
  const inprogW   = sum(items.filter(r => r.Status === 'In Progress'));
  const futureW   = sum(items.filter(r => r.Status === 'Future Test'));
  const notStartW = sum(items.filter(r => !r.Status || ['Not Started','Future'].includes(r.Status)));
  return {
    totalW, passW, naW, failW, blockedW, inprogW, futureW, notStartW,
    completeW: passW + naW,
    testedW:   passW + failW + blockedW,
  };
}
