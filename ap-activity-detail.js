// ==========================================
// HITACHI Rail T&C Portal — Test Activities: activity drill-in
// (ap-activity-detail.js)
//
// "Test Activities" and "Test Cases" used to be two separate pages. They are
// now one module: the Activities page lists every SAT activity, and clicking a
// row drills into that activity — a header with its progress KPIs plus the
// test-case table (statuses, status KPI cards, search, status filter) scoped
// to just that activity's test cases.
//
// The test-case table is the existing Test Cases machinery (initLineItems /
// renderLITable and the li-* elements), which now lives inside
// #page-activities. This module only owns the drill state and the scoping:
// renderLITable/_liCascade consult _apDetailMatch(r) so every count, KPI card
// and option list reflects the open activity. Loaded AFTER app.js.
// ==========================================

const _APD_KEY = 'ap.detailKey';   // activity key (Phase||Location||Subsystem||Activity) or ''

function _apdKey() { return (typeof CXStore !== 'undefined' && CXStore.get(_APD_KEY)) || ''; }
function _apdSetKey(k) { if (typeof CXStore !== 'undefined') CXStore.set(_APD_KEY, k || ''); }

function _apdRowKey(r) {
  return `${r.Phase || ''}||${r.Location || ''}||${r.Subsystem || ''}||${r.Activity || ''}`;
}

// Row predicate used by renderLITable/_liCascade. With no activity open every
// row matches, so the table behaves exactly as the old standalone page.
function _apDetailMatch(r) {
  const key = _apdKey();
  return !key || _apdRowKey(r) === key;
}

function _apdFindActivity(key) {
  const all = (typeof _amGetActivities === 'function') ? _amGetActivities() : [];
  return all.find(a => a.key === key) || null;
}

function _apdShowViews(detail) {
  const list = document.getElementById('ap-list-view');
  const det = document.getElementById('ap-detail-view');
  if (list) list.hidden = !!detail;
  if (det) det.hidden = !detail;
}

function _apdKpi(label, value, tone) {
  return `<div class="kpi-card kpi-mini"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value ${tone || ''}">${escapeHtml(String(value))}</div></div>`;
}

function _apdRenderHead(act) {
  const head = document.getElementById('ap-detail-head');
  if (!head) return;
  const tcw = (typeof _buildTestCaseWeightLookup === 'function') ? _buildTestCaseWeightLookup() : null;
  const comp = _amComputeCompletion(act, tcw);
  const status = _amComputeStatus(act);
  const meta = [
    ['Subsystem', act.subsystem], ['Phase', act.phase], ['Location', act.location],
    act.testReport ? ['Test Report', act.testReport] : null,
    act.testProcedure ? ['Procedure', act.testProcedure] : null,
  ].filter(Boolean);
  head.innerHTML = `
    <div class="ap-detail-top">
      <button class="form-secondary" data-action="apCloseActivity">← All activities</button>
    </div>
    <div class="ap-detail-title-row">
      <h2 class="section-title">${escapeHtml(act.activity)}</h2>
      ${typeof _amStatusBadge === "function" ? _amStatusBadge(status) : getStatusBadge(status)}
    </div>
    <div class="v2-meta-line ap-detail-meta">
      ${meta.map(([k, v], i) => `${i ? '<span class="sep">·</span>' : ''}<span class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v || '—')}</span></span>`).join('')}
    </div>
    <div class="kpi-grid kpi-grid-mini">
      ${_apdKpi('Progress', comp.pct + '%', comp.pct >= 100 ? 'good' : 'info')}
      ${_apdKpi('Test Cases', act.items.length)}
      ${_apdKpi('Closed', `${comp.done} / ${comp.total}`, 'good')}
    </div>
    ${act.futureTestReason ? `<p class="section-sub">Future test: ${escapeHtml(act.futureTestReason)}</p>` : ''}
  `;
}

// Open an activity from the list. Resets the test-case filters so a stale
// search/status from a previous activity can't hide this one's rows.
function apOpenActivity(key) {
  const act = _apdFindActivity(key);
  if (!act) { toast('That activity is no longer in the register', 'error'); return; }
  _apdSetKey(key);
  _apdShowViews(true);
  _apdRenderHead(act);
  if (typeof clearLIFilters === 'function') clearLIFilters();
  else if (typeof renderLITable === 'function') renderLITable();
  window.scrollTo(0, 0);
}

function apCloseActivity() {
  _apdSetKey('');
  _apdShowViews(false);
  if (typeof clearLIFilters === 'function') clearLIFilters();
}

// Data reloads re-run initActivities/initLineItems; keep the open activity's
// header current, or fall back to the list if it disappeared.
function _apdRefresh() {
  const key = _apdKey();
  if (!key) return;
  const act = _apdFindActivity(key);
  if (!act) { apCloseActivity(); return; }
  _apdRenderHead(act);
}
