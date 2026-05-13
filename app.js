// ==========================================
// HITACHI Rail T&C Portal - App Logic
// ==========================================

const DATA = window.PORTAL_DATA;
const AP = DATA.actionPlans;
const LI = DATA.lineItems;
const PL = DATA.punchList;
const ORG = DATA.org;

// ── Supabase config ─────────────────────────────────────────
const SUPABASE_URL      = 'https://uqtwiucxktljhukmgmxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdHdpdWN4a3Rsamh1a21nbXhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NDMxMDcsImV4cCI6MjA5MzUxOTEwN30.nJuQOOyvGpGphSqiNxrO2_p1oYroev8mVdNn9unxmdI';
let _sb = null;
try {
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window._sb = _sb;
  console.log('[Supabase] Client initialized OK');
} catch(e) {
  console.error('[Supabase] FAILED to init:', e.message);
}
// Kick off DB connectivity check as soon as possible (non-blocking)
setTimeout(() => { if (typeof _checkDbStatus === 'function') _checkDbStatus(); }, 0);

// Direct REST-API insert that bypasses supabase-js — workaround for cases where
// the client's insert() hangs (we've seen this with bulk inserts to test_results).
// Uses native fetch with a 15s AbortController timeout so it can never get stuck.
// ── _dbInsert / _dbUpdate — native fetch helpers ─────────────────────────────
// These bypass the supabase-js client entirely. The JS client caches its auth
// header internally and does NOT reliably re-read the JWT after a browser tab
// resumes from a background/throttled state. Native fetch re-reads the session
// fresh on every call, which is why daily-log submits switched to this approach.
// _mxSaveStatus (test matrix status writes) now also uses _dbUpdate for the
// same reason: tab-switch + status change was silently dropping DB writes.
// ─────────────────────────────────────────────────────────────────────────────

// Read the JWT directly from localStorage — completely bypasses supabase-js auth client
// which hangs indefinitely after signInWithPassword on this environment.
// Supabase-js v2 stores the session under key: sb-{project_ref}-auth-token
function _getSessionFromStorage() {
  try {
    const ref = SUPABASE_URL.replace('https://', '').split('.')[0]; // e.g. "uqtwiucxktljhukmgmxg"
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Synchronous — no await needed. Reads token from localStorage directly.
function _getAuthHeader() {
  const session = _getSessionFromStorage();
  if (session?.access_token) {
    const expiresAt = (session.expires_at || 0) * 1000;
    const minsLeft  = ((expiresAt - Date.now()) / 60000).toFixed(1);
    const expired   = Date.now() > expiresAt;
    console.log(`[auth] token ${expired ? '⛔ EXPIRED' : '✓ valid'} | expires in ${minsLeft} min`);
    return 'Bearer ' + session.access_token;
  }
  console.warn('[auth] ⚠ no session in localStorage — falling back to anon key');
  return 'Bearer ' + SUPABASE_ANON_KEY;
}

async function _dbInsert(table, rows) {
  const authHeader = _getAuthHeader();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        apikey:        SUPABASE_ANON_KEY,
        Authorization: authHeader,
        'Content-Type':'application/json',
        Prefer:        'return=representation',
      },
      body: JSON.stringify(rows),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${table} insert failed (${res.status}): ${errBody}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`${table} insert timed out after 15s`);
    throw e;
  }
}

// PATCH a single row; `match` is an object of { col: value } equality filters.
// Returns the array of updated rows (Prefer: return=representation).
async function _dbUpdate(table, patch, match) {
  const authHeader = _getAuthHeader();
  const qs = Object.entries(match)
    .map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${qs}`;
  console.log(`[_dbUpdate] PATCH ${table} WHERE ${JSON.stringify(match)} patch=${JSON.stringify(patch)}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      signal: ctrl.signal,
      headers: {
        apikey:        SUPABASE_ANON_KEY,
        Authorization: authHeader,
        'Content-Type':'application/json',
        Prefer:        'return=representation',
      },
      body: JSON.stringify(patch),
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[_dbUpdate] ✗ HTTP ${res.status} after ${ms}ms:`, errBody);
      throw new Error(`${table} update failed (${res.status}): ${errBody}`);
    }
    const rows = await res.json();
    console.log(`[_dbUpdate] ✓ HTTP 200 in ${ms}ms — ${rows.length} row(s) updated`);
    return rows;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`${table} update timed out after 15s`);
    throw e;
  }
}

async function _dbDelete(table, match) {
  const authHeader = _getAuthHeader();
  const qs = Object.entries(match)
    .map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
      method: 'DELETE',
      signal: ctrl.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: authHeader,
        Prefer: 'return=representation',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${table} delete failed (${res.status}): ${await res.text()}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`${table} delete timed out after 15s`);
    throw e;
  }
}
// SELECT rows from a table; `match` is an object of { col: value } equality filters.
// Returns the array of matching rows. Uses native fetch with 15s timeout to bypass
// supabase-js client state issues (same reason as _dbInsert / _dbUpdate).
async function _dbSelect(table, match = {}, select = '*') {
  const authHeader = _getAuthHeader();
  const qs = Object.entries(match)
    .map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${qs ? qs + '&' : ''}select=${encodeURIComponent(select)}`;
  console.log(`[_dbSelect] GET ${table} WHERE ${JSON.stringify(match)}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        apikey:        SUPABASE_ANON_KEY,
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[_dbSelect] ✗ HTTP ${res.status} after ${ms}ms:`, errBody);
      throw new Error(`${table} select failed (${res.status}): ${errBody}`);
    }
    const rows = await res.json();
    console.log(`[_dbSelect] ✓ HTTP 200 in ${ms}ms — ${rows.length} row(s)`);
    return rows;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`${table} select timed out after 15s`);
    throw e;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── BUILT-IN DIAGNOSTICS ──────────────────────────────────────────────────────
// Call window.runDiagnostics() in the browser console at any time to get a
// full health report: session validity, TI count, a live write probe to
// test_items, and the current tab-visibility state.
// ─────────────────────────────────────────────────────────────────────────────
window.runDiagnostics = async function() {
  console.group('%c[DIAGNOSTICS] CX Portal Health Check', 'color:#e60012;font-size:14px;font-weight:bold');

  // 1. Auth / session (read directly from localStorage — bypasses supabase-js hang)
  console.group('1. Auth Session');
  try {
    const session = _getSessionFromStorage();
    if (!session) { console.warn('⚠ NO active session in localStorage — user not logged in'); }
    else {
      const exp = new Date(session.expires_at * 1000);
      const minsLeft = ((session.expires_at * 1000 - Date.now()) / 60000).toFixed(1);
      const isExp = Date.now() > session.expires_at * 1000;
      console.log('User:', session.user?.email);
      console.log('Token status:', isExp ? '⛔ EXPIRED' : `✓ valid for ${minsLeft} more minutes`);
      console.log('Expires at:', exp.toLocaleString());
      console.log('Token (first 30):', session.access_token?.slice(0, 30) + '…');
    }
  } catch(e) { console.error('session read threw:', e.message); }
  console.groupEnd();

  // 2. App state
  console.group('2. App State');
  console.log('currentRoleUser:', currentRoleUser ? `${currentRoleUser.name} (${currentRoleUser.role})` : '⚠ null');
  console.log('TI loaded:', TI.length, 'test items');
  console.log('_mxSavePending:', _mxSavePending);
  console.log('_lastHiddenAt:', _lastHiddenAt ? new Date(_lastHiddenAt).toLocaleString() : 'never hidden');
  const awayMs = _lastHiddenAt ? Date.now() - _lastHiddenAt : 0;
  console.log('Away for (if currently visible):', (awayMs / 1000).toFixed(0) + 's');
  console.groupEnd();

  // 3. Live write probe — PATCH the first test item with its own current status (no visible change)
  console.group('3. Live Write Probe (test_items PATCH)');
  const probe = TI[0];
  if (!probe) { console.warn('No test items loaded — cannot probe'); }
  else {
    console.log('Probing test_id:', probe.TestID, '| current status:', probe.Status);
    try {
      const rows = await _dbUpdate('test_items', { status: probe.Status }, { test_id: probe.TestID });
      console.log('✓ PATCH succeeded — DB is reachable and writable');
      console.log('Returned row status:', rows[0]?.status);
    } catch(e) {
      console.error('✗ PATCH failed:', e.message);
    }
  }
  console.groupEnd();

  // 4. Token health from localStorage
  console.group('4. Token Health');
  const s = _getSessionFromStorage();
  if (s) {
    const nowMs = Date.now();
    const expMs = (s.expires_at || 0) * 1000;
    const expired = nowMs > expMs;
    console.log('expires_at:', new Date(expMs).toLocaleString());
    console.log('status:', expired ? '⛔ EXPIRED' : `✓ valid for ${((expMs - nowMs) / 60000).toFixed(1)} min`);
    console.log('user:', s.user?.email);
  } else {
    console.warn('No session in localStorage');
  }
  console.groupEnd();

  // 5. Verdict
  console.group('5. Verdict');
  console.log('Native fetch PATCH (section 3) is the sole write path — supabase-js data client not used.');
  console.log('If PATCH ✓: DB writes are working correctly.');
  console.log('If PATCH 401: Token expired — sign out and sign back in.');
  console.log('If PATCH 403: RLS policy blocking — check Supabase test_items RLS rules.');
  console.groupEnd();

  console.groupEnd(); // top-level DIAGNOSTICS group
  return '✓ Diagnostics complete — check the groups above';
};

// Color palette (matches CSS)
const COLORS = {
  red: '#e60012',
  redLight: '#ff4d5b',
  black: '#1a1a1a',
  good: '#00875a',
  warn: '#d97706',
  bad: '#dc2626',
  info: '#1e40af',
  pending: '#6d28d9',
  gray: '#7a7a7a',
  grayLight: '#d8d8d8',
};

// Hitachi-themed Chart.js defaults
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.color = '#5e5e5e';
Chart.defaults.borderColor = '#ebebeb';

// ==========================================
// ROUTING
// ==========================================
const _adminPages = new Set(['admin-templates','admin-locations','admin-fieldconfig','admin-directory','audit','admin-p6']);
let _adminModeOn = false;

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name)?.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector(`.nav-link[data-page="${name}"]`)?.classList.add('active');
  // Auto-switch to admin mode when navigating to an admin page
  if (_adminPages.has(name) && !_adminModeOn) _sidenavAdminOpen();
  // Re-render pages that need fresh state on each visit
  if (name === 'field-intake')     renderFieldIntake();
  if (name === 'test-register')    renderTestRegister();
  if (name === 'tcv')              renderTCV();
  if (name === 'test-reporting')   renderTestReporting();
  if (name === 'admin-templates')  renderAdminTemplates();
  if (name === 'admin-locations')  renderAdminLocations();
  if (name === 'admin-fieldconfig') renderAdminFieldConfig();
  if (name === 'admin-directory')  renderAdminDirectory();
  if (name === 'admin-p6')         renderAdminP6();
  if (name === 'schedule')         renderSchedulePage();
  window.scrollTo(0, 0);
}

// ── Sidebar collapse ─────────────────────────────────────────────────────────
function _sidenavCollapse() {
  document.body.classList.toggle('sb-collapsed');
}

// ── Admin mode — full nav swap ────────────────────────────────────────────────
function _sidenavAdminToggle() {
  _adminModeOn = !_adminModeOn;
  _applySidenavAdminMode();
}
function _sidenavAdminOpen() {
  _adminModeOn = true;
  _applySidenavAdminMode();
}
function _applySidenavAdminMode() {
  const regular = document.getElementById('nav-regular-items');
  const admin   = document.getElementById('nav-admin-items');
  const btn     = document.getElementById('nav-admin-toggle');
  if (regular) regular.style.display = _adminModeOn ? 'none' : '';
  if (admin)   admin.style.display   = _adminModeOn ? '' : 'none';
  btn?.classList.toggle('active', _adminModeOn);
}

// ── TAB VISIBILITY & SESSION RECOVERY ──────────────────────────────────────
// Root causes of "app breaks after switching tabs":
//   1. visibilitychange handler was removed (it was clobbering in-flight saves)
//      → fixed by guarding TI reload behind _mxSavePending flag
//   2. No refreshApp() — data only fetched once on DOMContentLoaded
//   3. TOKEN_REFRESHED fired _loadCurrentProfile → double-applied subsystem filter
//      → fixed by skipping profile reload when user is already authenticated
//   4. No session re-check on tab resume — stale/expired session went undetected
//
// Strategy:
//   · Track tab-hidden timestamp; on return, refresh only if >30s elapsed
//   · _mxSavePending flag prevents TI reload during an in-flight status save
//   · Debounce to consolidate rapid visibility events into a single refresh
//   · Singleton Supabase client (already the case — created once at file top)
// ────────────────────────────────────────────────────────────────────────────
let _lastHiddenAt  = 0;
let _refreshTimer  = null;
let _mxSavePending = false; // true while _mxSaveStatus is awaiting Supabase

async function refreshApp() {
  if (!currentRoleUser || !_sb) return;
  console.log('[refreshApp] rehydrating after tab resume…');

  // 1. Re-verify session — sign out cleanly if it has expired
  const session = _getSessionFromStorage();
  if (!session) { console.warn('[refreshApp] session lost — signing out'); _onSignedOut(); return; }

  // 2. Reload punch items (always safe — not mid-edit)
  try { await loadPunchDB(); } catch(e) { console.warn('[refreshApp] punch reload failed:', e.message); }
  try { await loadP6Data(); }  catch(e) { console.warn('[refreshApp] P6 reload failed:',  e.message); }

  // 3. Reload test items only when no status save is in flight
  if (!_mxSavePending) {
    try {
      await loadTestItems();
      // Re-apply subsystem filter — loadTestItems() fetches all items unfiltered
      if (currentRoleUser.subsystem) {
        TI = TI.filter(t => (t.Subsystem||'').toLowerCase() === currentRoleUser.subsystem.toLowerCase());
      }
    } catch(e) { console.warn('[refreshApp] TI reload failed:', e.message); }
  } else {
    console.log('[refreshApp] TI reload skipped — status save in progress');
  }

  // 4. Re-render live-data views; skip Daily Log mid-form to preserve user input
  renderTestRegister();
  renderPunchWorkflow();
  if (intakeStep === 1) renderFieldIntake();
  console.log('[refreshApp] done');
}

function _onTabBecameVisible() {
  if (!currentRoleUser) return;
  const awayMs = Date.now() - _lastHiddenAt;
  if (_lastHiddenAt === 0 || awayMs < 30_000) return; // ignore brief alt-tabs (<30s)
  console.log(`[tab] returned after ${(awayMs / 1000).toFixed(0)}s — scheduling refresh`);
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => refreshApp(), 1500); // 1.5s debounce
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _lastHiddenAt = Date.now();
  } else {
    _onTabBecameVisible();
  }
});

window.addEventListener('focus', () => {
  // Secondary trigger: window.focus fires on alt-tab back even without
  // a full visibility change (e.g. child dialog closes back to app)
  if (!document.hidden) _onTabBecameVisible();
});

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const page = link.dataset.page;
    if (page) showPage(page);
  });
});


// ==========================================
// HELPERS
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

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[c]);
}

function getLocationCode(loc) {
  if (!loc) return '';
  const m = loc.match(/^(\w+)/);
  return m ? m[1] : loc;
}

// ==========================================
// DASHBOARD
// ==========================================
function initDashboard() {
  // Hero update timestamp
  const dt = new Date(DATA.meta.generated);
  document.getElementById('hero-update').textContent = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Compute key KPIs
  const liPassed = LI.filter(r => r.Status === 'Passed').length;
  const liFailed = LI.filter(r => r.Status === 'Failed').length;
  const liInProg = LI.filter(r => r.Status === 'In Progress').length;
  const liOpen = LI.filter(r => r.Status === 'Open').length;
  const liTotal = LI.length;
  const liComplete = liPassed + liFailed;
  const overallPct = Math.round((liPassed / liTotal) * 100);
  const passRate = liComplete > 0 ? Math.round((liPassed / liComplete) * 100) : 0;

  const apClosed = AP.filter(r => r.Status === 'Closed').length;
  const apInProg = AP.filter(r => r.Status === 'In Progress').length;
  const apNotStarted = AP.filter(r => r.Status === 'Activity Not Started').length;

  const plOpen = PL.filter(r => r.Status && !['Closed','Ready To Close'].includes(r.Status)).length;
  const plClosed = PL.filter(r => r.Status === 'Closed').length;
  const plReady = PL.filter(r => r.Status === 'Ready To Close').length;
  const plHigh = PL.filter(r => r.Priority === 'high').length;
  const plMed = PL.filter(r => r.Priority === 'medium').length;
  const plLow = PL.filter(r => r.Priority === 'low').length;
  const plOverdue = PL.filter(r => r.Overdue === 'Yes').length;
  const plWork = PL.filter(r => r.Status === 'Work Required').length;

  // Top KPIs
  document.getElementById('kpi-progress').textContent = overallPct + '%';
  document.getElementById('kpi-progress-meta').innerHTML = `<b>${liPassed.toLocaleString()}</b> of ${liTotal.toLocaleString()} line items passed`;
  setTimeout(() => { document.getElementById('kpi-progress-bar').style.width = overallPct + '%'; }, 100);

  document.getElementById('kpi-passrate').textContent = passRate + '%';
  document.getElementById('kpi-passrate-meta').innerHTML = `<b>${liPassed}</b> passed / <b>${liFailed}</b> failed`;

  document.getElementById('kpi-activities').textContent = AP.length;
  document.getElementById('kpi-activities-meta').innerHTML = `<b class="good-text">${apClosed}</b> closed · <b>${apInProg}</b> in progress`;

  document.getElementById('kpi-punch').textContent = plOpen;
  document.getElementById('kpi-punch-meta').innerHTML = `<b>${plHigh}</b> high priority · ${plOverdue} overdue`;

  // Secondary metric tiles
  const metricRow = document.getElementById('metric-row');
  metricRow.innerHTML = `
    <div class="metric-tile">
      <div class="metric-tile-label"><span class="metric-tile-icon" style="background:${COLORS.good}"></span>Tests Passed</div>
      <div class="metric-tile-value good">${liPassed.toLocaleString()}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label"><span class="metric-tile-icon" style="background:${COLORS.bad}"></span>Tests Failed</div>
      <div class="metric-tile-value bad">${liFailed}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label"><span class="metric-tile-icon" style="background:${COLORS.info}"></span>In Progress</div>
      <div class="metric-tile-value">${liInProg}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label"><span class="metric-tile-icon" style="background:${COLORS.gray}"></span>Open</div>
      <div class="metric-tile-value">${liOpen}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label"><span class="metric-tile-icon" style="background:${COLORS.warn}"></span>Punch Open</div>
      <div class="metric-tile-value warn">${plWork}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label"><span class="metric-tile-icon" style="background:${COLORS.bad}"></span>Punch Overdue</div>
      <div class="metric-tile-value bad">${plOverdue}</div>
    </div>
  `;

  // Phase Grid
  renderPhaseGrid();

  // Charts
  renderLIStatusChart();
  renderSubsysRateChart();
  renderPunchTradeChart();
  renderLocationChart();

  // Attention lists
  renderFailedList();
  renderHighPunchList();
}

function renderPhaseGrid() {
  const phaseTitles = {
    '0': 'Test Track',
    '1': 'Pilot Section',
    '2': 'Mainline Deployment',
  };

  const phases = ['0', '1', '2'];
  const grid = document.getElementById('phase-grid');
  let html = '';

  phases.forEach(phase => {
    const items = AP.filter(r => String(r.Phase).trim() === phase);
    const closed = items.filter(r => r.Status === 'Closed').length;
    const inProg = items.filter(r => r.Status === 'In Progress').length;
    const notStarted = items.filter(r => r.Status === 'Activity Not Started').length;
    const total = items.length;
    const pct = total > 0 ? Math.round((closed / total) * 100) : 0;

    html += `
      <div class="phase-card">
        <div class="phase-card-num">Phase ${phase}</div>
        <div class="phase-card-title">${phaseTitles[phase]}</div>
        <div class="phase-progress-display">
          <div class="phase-progress-pct">${pct}%</div>
          <div class="phase-progress-meta"><b>${closed}</b> of ${total} activities closed</div>
        </div>
        <div class="phase-bar"><div class="phase-bar-fill" style="width:0%" data-target="${pct}%"></div></div>
        <div class="phase-stats">
          <div class="phase-stat-item">
            <div class="phase-stat-label">Closed</div>
            <div class="phase-stat-value good">${closed}</div>
          </div>
          <div class="phase-stat-item">
            <div class="phase-stat-label">Active</div>
            <div class="phase-stat-value">${inProg}</div>
          </div>
          <div class="phase-stat-item">
            <div class="phase-stat-label">Pending</div>
            <div class="phase-stat-value">${notStarted}</div>
          </div>
        </div>
      </div>
    `;
  });

  grid.innerHTML = html;
  // Animate bars after render
  setTimeout(() => {
    document.querySelectorAll('.phase-bar-fill[data-target]').forEach(el => {
      el.style.width = el.dataset.target;
    });
  }, 200);
}

function renderLIStatusChart() {
  const ctx = document.getElementById('chart-li-status');
  const passed = LI.filter(r => r.Status === 'Passed').length;
  const failed = LI.filter(r => r.Status === 'Failed').length;
  const inprog = LI.filter(r => r.Status === 'In Progress').length;
  const open = LI.filter(r => r.Status === 'Open').length;

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Passed', 'In Progress', 'Open', 'Failed'],
      datasets: [{
        data: [passed, inprog, open, failed],
        backgroundColor: [COLORS.good, COLORS.info, COLORS.gray, COLORS.bad],
        borderWidth: 0,
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth: 10, boxHeight: 10, padding: 16, font: { size: 12 }, usePointStyle: true, pointStyle: 'circle' }
        },
        tooltip: {
          backgroundColor: COLORS.black,
          padding: 12,
          titleFont: { size: 12, weight: '600' },
          bodyFont: { size: 12 },
          callbacks: {
            label: ctx => {
              const tot = ctx.dataset.data.reduce((a,b)=>a+b,0);
              const pct = ((ctx.parsed/tot)*100).toFixed(1);
              return ` ${ctx.parsed.toLocaleString()} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function renderSubsysRateChart() {
  const ctx = document.getElementById('chart-subsys-rate');
  const subsysGroups = {};
  LI.forEach(r => {
    const sub = r['Plan Commissioning: SubSystem-'];
    if (!sub) return;
    if (!subsysGroups[sub]) subsysGroups[sub] = { passed: 0, failed: 0, total: 0 };
    if (r.Status === 'Passed') subsysGroups[sub].passed++;
    if (r.Status === 'Failed') subsysGroups[sub].failed++;
    subsysGroups[sub].total++;
  });

  const sorted = Object.entries(subsysGroups)
    .filter(([_, v]) => v.total >= 5)
    .sort((a,b) => b[1].total - a[1].total);

  const labels = sorted.map(s => s[0]);
  const passedData = sorted.map(s => s[1].passed);
  const failedData = sorted.map(s => s[1].failed);
  const otherData = sorted.map(s => s[1].total - s[1].passed - s[1].failed);

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Passed', data: passedData, backgroundColor: COLORS.good, stack: 'st' },
        { label: 'Failed', data: failedData, backgroundColor: COLORS.bad, stack: 'st' },
        { label: 'Pending', data: otherData, backgroundColor: COLORS.grayLight, stack: 'st' },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { stacked: true, grid: { color: '#f4f4f4' } },
        y: { stacked: true, grid: { display: false } }
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, pointStyle: 'rect' } },
        tooltip: { backgroundColor: COLORS.black, padding: 12 }
      }
    }
  });
}

function renderPunchTradeChart() {
  const ctx = document.getElementById('chart-punch-trade');
  const counts = {};
  PL.forEach(r => {
    let t = r.Trade;
    if (!t) return;
    t = t.toString().trim();
    counts[t] = (counts[t] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 10);
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(x => x[0]),
      datasets: [{
        label: 'Items',
        data: sorted.map(x => x[1]),
        backgroundColor: COLORS.red,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: '#f4f4f4' }, beginAtZero: true }
      },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: COLORS.black, padding: 12 }
      }
    }
  });
}

function renderLocationChart() {
  const ctx = document.getElementById('chart-loc');
  const counts = {};
  AP.forEach(r => {
    let l = r.Location;
    if (!l || l === 'Entire Phase>2') return;
    counts[l] = (counts[l] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(x => x[0].split(' ').slice(0, 2).join(' ')),
      datasets: [{
        label: 'SAT Activities',
        data: sorted.map(x => x[1]),
        backgroundColor: COLORS.black,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { grid: { color: '#f4f4f4' }, beginAtZero: true },
        y: { grid: { display: false } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: COLORS.black, padding: 12 }
      }
    }
  });
}

function renderFailedList() {
  const failed = LI.filter(r => r.Status === 'Failed').slice(0, 5);
  const list = document.getElementById('failed-list');
  list.innerHTML = failed.map(r => `
    <div class="mini-list-item">
      <div class="mini-list-dot dot-bad"></div>
      <div class="mini-list-content">
        <div class="mini-list-title">${escapeHtml(r.Title)}</div>
        <div class="mini-list-meta"><b>${escapeHtml(r['Plan Commissioning: SubSystem-'] || '—')}</b> · ${escapeHtml(r.Location)} · ${escapeHtml(r['Plan Name'])}</div>
      </div>
    </div>
  `).join('');
}

function renderHighPunchList() {
  const high = PL.filter(r =>
    r.Priority === 'high' &&
    r.Status &&
    !['Closed', 'Ready To Close'].includes(r.Status)
  ).slice(0, 5);
  const list = document.getElementById('high-punch-list');
  list.innerHTML = high.map(r => `
    <div class="mini-list-item">
      <div class="mini-list-dot dot-bad"></div>
      <div class="mini-list-content">
        <div class="mini-list-title">${escapeHtml(r.Title)}</div>
        <div class="mini-list-meta"><b>${escapeHtml(r.Trade || '—')}</b> · ${escapeHtml(r.Type || '—')} · ${escapeHtml(r.Location)}${r.Overdue === 'Yes' ? ' · <span style="color:var(--bad);font-weight:600">overdue</span>' : ''}</div>
      </div>
    </div>
  `).join('');
}

// ==========================================
// SAT ACTIVITIES PAGE
// ==========================================
let apSort = { col: null, asc: false };

function initActivities() {
  document.getElementById('ap-summary').textContent = `${AP.length} SAT activities across ${new Set(AP.map(r => r.Location).filter(Boolean)).size} locations`;

  // Build filter options
  const statuses = [...new Set(AP.map(r => r.Status).filter(Boolean))].sort();
  const subsys = [...new Set(AP.map(r => r['SubSystem-']).filter(Boolean))].sort();
  const phases = [...new Set(AP.map(r => String(r.Phase)).filter(p => p && p !== 'undefined'))].sort();
  const locs = [...new Set(AP.map(r => r.Location).filter(Boolean))].sort();

  populateSelect('ap-status-filter', 'All statuses', statuses);
  populateSelect('ap-subsys-filter', 'All subsystems', subsys);
  populateSelect('ap-phase-filter', 'All phases', phases.map(p => `Phase ${p}`));
  populateSelect('ap-location-filter', 'All locations', locs);

  ['ap-search','ap-status-filter','ap-subsys-filter'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderAPTable);
  });
  document.getElementById('ap-phase-filter').addEventListener('input', () => { _apCascadeLocation(); renderAPTable(); });
  document.getElementById('ap-location-filter').addEventListener('input', renderAPTable);

  // Sort handlers
  document.querySelectorAll('#ap-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (apSort.col === col) apSort.asc = !apSort.asc;
      else { apSort.col = col; apSort.asc = true; }
      renderAPTable();
    });
  });

  renderAPTable();
}

function _apCascadeLocation() {
  const subsysF = document.getElementById('ap-subsys-filter').value;
  const phaseF  = document.getElementById('ap-phase-filter').value.replace('Phase ', '');
  const avail   = AP.filter(r => (!subsysF || r['SubSystem-'] === subsysF) && (!phaseF || String(r.Phase).trim() === phaseF));
  const locs    = [...new Set(avail.map(r => r.Location).filter(Boolean))].sort();
  const cur     = document.getElementById('ap-location-filter').value;
  populateSelect('ap-location-filter', 'All locations', locs);
  if (!locs.includes(cur)) document.getElementById('ap-location-filter').value = '';
}

function clearAPFilters() {
  ['ap-search','ap-status-filter','ap-subsys-filter','ap-phase-filter','ap-location-filter'].forEach(id => document.getElementById(id).value = '');
  renderAPTable();
}

function populateSelect(id, allLabel, options) {
  const el = document.getElementById(id);
  el.innerHTML = `<option value="">${allLabel}</option>` + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
}

function renderAPTable() {
  const search = document.getElementById('ap-search').value.toLowerCase();
  const statusF = document.getElementById('ap-status-filter').value;
  const subsysF = document.getElementById('ap-subsys-filter').value;
  const phaseF = document.getElementById('ap-phase-filter').value.replace('Phase ', '');
  const locF = document.getElementById('ap-location-filter').value;

  let data = AP.filter(r =>
    (!search || (r.Name && r.Name.toLowerCase().includes(search)) || (r.Description && r.Description.toLowerCase().includes(search))) &&
    (!statusF || r.Status === statusF) &&
    (!subsysF || r['SubSystem-'] === subsysF) &&
    (!phaseF || String(r.Phase).trim() === phaseF) &&
    (!locF || r.Location === locF)
  );

  // Sort
  if (apSort.col) {
    data = [...data].sort((a, b) => {
      const av = a[apSort.col] || '';
      const bv = b[apSort.col] || '';
      const cmp = av.toString().localeCompare(bv.toString(), undefined, { numeric: true });
      return apSort.asc ? cmp : -cmp;
    });
  }

  const tbody = document.getElementById('ap-body');
  tbody.innerHTML = data.map(r => `
    <tr>
      <td>
        <span class="cell-name">${escapeHtml(r.Name)}</span>
        ${r['Test Report CDRL'] ? `<span class="cell-sub">CDRL ${escapeHtml(r['Test Report CDRL'])}</span>` : ''}
      </td>
      <td><span class="tag">${escapeHtml(r['SubSystem-'] || '—')}</span></td>
      <td class="cell-mono">Phase ${escapeHtml(String(r.Phase || '—').trim())}</td>
      <td>${escapeHtml(r['Test Level'] || '—')}</td>
      <td>${escapeHtml(r.Location || '—')}</td>
      <td class="cell-mono">${escapeHtml(r.Progress || '—')}</td>
      <td>${getStatusBadge(r.Status)}</td>
    </tr>
  `).join('');

  document.getElementById('ap-count').textContent = `Showing ${data.length} of ${AP.length} activities`;

  // Update sort indicator
  document.querySelectorAll('#ap-table th').forEach(th => th.classList.remove('sorted','sorted-asc'));
  if (apSort.col) {
    const th = document.querySelector(`#ap-table th[data-sort="${apSort.col}"]`);
    if (th) th.classList.add('sorted', apSort.asc ? 'sorted-asc' : '');
  }
}

// ==========================================
// TEST CASES PAGE  (sourced from TI / test_items)
// ==========================================
let liSort = { col: null, asc: false };

function initLineItems() {
  // TI is already subsystem-filtered at login for non-admin users
  const base = TI;
  const userSubsys = currentRoleUser?.subsystem || null;
  const isAdmin = currentRoleUser?.role === 'admin';

  document.getElementById('li-summary').textContent =
    `${base.length.toLocaleString()} test cases${userSubsys && !isAdmin ? ` · ${userSubsys}` : ' across all subsystems'}`;

  // Populate filter dropdowns from the (already-scoped) TI data
  const subsystems = [...new Set(base.map(r => r.Subsystem).filter(Boolean))].sort();
  const phases     = [...new Set(base.map(r => String(r.Phase || '')).filter(Boolean))].sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
  const locs       = [...new Set(base.map(r => r.Location).filter(Boolean))].sort();
  const activities = [...new Set(base.map(r => r.Activity).filter(Boolean))].sort();
  const statuses   = [...new Set(base.map(r => r.Status).filter(Boolean))].sort();

  populateSelect('li-subsys-filter',   'All subsystems', subsystems);
  populateSelect('li-phase-filter',    'All phases',     phases);
  populateSelect('li-location-filter', 'All locations',  locs);
  populateSelect('li-activity-filter', 'All activities', activities);
  populateSelect('li-status-filter',   'All statuses',   statuses);

  // For non-admin with a subsystem, pre-select their subsystem and hide the filter
  const subsysEl = document.getElementById('li-subsys-filter');
  if (userSubsys && !isAdmin) {
    subsysEl.value = userSubsys;
    subsysEl.style.display = 'none';
  } else {
    subsysEl.style.display = '';
  }

  document.getElementById('li-subsys-filter')?.addEventListener('input', () => { _liCascade(0); renderLITable(); });
  document.getElementById('li-phase-filter')?.addEventListener('input',  () => { _liCascade(1); renderLITable(); });
  document.getElementById('li-location-filter')?.addEventListener('input',() => { _liCascade(2); renderLITable(); });
  document.getElementById('li-activity-filter')?.addEventListener('input', renderLITable);
  document.getElementById('li-status-filter')?.addEventListener('input',   renderLITable);
  document.getElementById('li-search')?.addEventListener('input',           renderLITable);

  document.querySelectorAll('#li-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (liSort.col === col) liSort.asc = !liSort.asc;
      else { liSort.col = col; liSort.asc = true; }
      renderLITable();
    });
  });

  renderLITable();
}

function _liCascade(level) {
  const subsysF = document.getElementById('li-subsys-filter').value;
  const phaseF  = document.getElementById('li-phase-filter').value;
  const locF    = document.getElementById('li-location-filter').value;

  if (level <= 0) {
    const phases = [...new Set(TI.filter(r => !subsysF || r.Subsystem === subsysF).map(r => r.Phase).filter(Boolean))].sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
    const cur = document.getElementById('li-phase-filter').value;
    populateSelect('li-phase-filter', 'All phases', phases);
    if (!phases.includes(cur)) document.getElementById('li-phase-filter').value = '';
  }

  if (level <= 1) {
    const ph = document.getElementById('li-phase-filter').value;
    const locs = [...new Set(TI.filter(r => (!subsysF || r.Subsystem === subsysF) && (!ph || r.Phase === ph)).map(r => r.Location).filter(Boolean))].sort();
    const cur = document.getElementById('li-location-filter').value;
    populateSelect('li-location-filter', 'All locations', locs);
    if (!locs.includes(cur)) document.getElementById('li-location-filter').value = '';
  }

  const ph2 = document.getElementById('li-phase-filter').value;
  const loc2 = document.getElementById('li-location-filter').value;
  const acts = [...new Set(TI.filter(r => (!subsysF || r.Subsystem === subsysF) && (!ph2 || r.Phase === ph2) && (!loc2 || r.Location === loc2)).map(r => r.Activity).filter(Boolean))].sort();
  const curAct = document.getElementById('li-activity-filter').value;
  populateSelect('li-activity-filter', 'All activities', acts);
  if (!acts.includes(curAct)) document.getElementById('li-activity-filter').value = '';
}

function clearLIFilters() {
  ['li-search','li-phase-filter','li-location-filter','li-activity-filter','li-status-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Only reset subsystem filter for admins (non-admin has it locked)
  if (currentRoleUser?.role === 'admin') {
    const el = document.getElementById('li-subsys-filter');
    if (el) el.value = '';
  }
  renderLITable();
}

function renderLITable() {
  const search  = document.getElementById('li-search').value.toLowerCase();
  const subsysF = document.getElementById('li-subsys-filter').value;
  const phaseF  = document.getElementById('li-phase-filter').value;
  const locF    = document.getElementById('li-location-filter').value;
  const actF    = document.getElementById('li-activity-filter').value;
  const statusF = document.getElementById('li-status-filter').value;

  let data = TI.filter(r =>
    (!search  || (r.TestName     && r.TestName.toLowerCase().includes(search))
              || (r.TestCaseCode && r.TestCaseCode.toLowerCase().includes(search))
              || (r.Activity     && r.Activity.toLowerCase().includes(search))) &&
    (!subsysF || r.Subsystem === subsysF) &&
    (!phaseF  || r.Phase === phaseF) &&
    (!locF    || r.Location === locF) &&
    (!actF    || r.Activity === actF) &&
    (!statusF || r.Status === statusF)
  );

  // Update KPI mini cards with filtered counts
  document.getElementById('li-passed').textContent = data.filter(r => r.Status === 'Pass').length.toLocaleString();
  document.getElementById('li-inprog').textContent = data.filter(r => r.Status === 'In Progress').length.toLocaleString();
  document.getElementById('li-failed').textContent = data.filter(r => r.Status === 'Fail' || r.Status === 'Blocked').length.toLocaleString();
  document.getElementById('li-open').textContent   = data.filter(r => !r.Status || r.Status === 'Not Started').length.toLocaleString();

  if (liSort.col) {
    data = [...data].sort((a, b) => {
      const av = a[liSort.col] ?? '';
      const bv = b[liSort.col] ?? '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return liSort.asc ? cmp : -cmp;
    });
  }

  const renderRows = data.slice(0, 500);
  const truncated  = data.length > 500 ? ` (showing first 500 — refine filters for more)` : '';

  document.getElementById('li-body').innerHTML = renderRows.map(r => `
    <tr>
      <td class="cell-mono">${escapeHtml(r.TestCaseCode || '—')}</td>
      <td><span class="cell-name">${escapeHtml(r.TestName || '—')}</span></td>
      <td><span class="tag">${escapeHtml(r.Subsystem || '—')}</span></td>
      <td class="cell-mono">${escapeHtml(String(r.Phase || '—').trim())}</td>
      <td>${escapeHtml(r.Location || '—')}</td>
      <td><span class="cell-sub" style="font-size:12px">${escapeHtml(r.Activity || '—')}</span></td>
      <td>${getStatusBadge(r.Status)}</td>
    </tr>
  `).join('');

  document.getElementById('li-count').textContent =
    `Showing ${renderRows.length.toLocaleString()} of ${data.length.toLocaleString()} test cases${truncated}`;

  document.querySelectorAll('#li-table th').forEach(th => th.classList.remove('sorted','sorted-asc'));
  if (liSort.col) {
    const th = document.querySelector(`#li-table th[data-sort="${liSort.col}"]`);
    if (th) th.classList.add('sorted', liSort.asc ? 'sorted-asc' : '');
  }
}

// ==========================================
// PUNCH LIST PAGE
// ==========================================
let plSort = { col: null, asc: false };

function initPunchList() {
  document.getElementById('pl-summary').textContent = `${PL.length.toLocaleString()} punch items across all trades and locations`;

  const statuses = [...new Set(PL.map(r => r.Status).filter(Boolean))].sort();
  const priorities = ['high', 'medium', 'low'];
  const trades = [...new Set(PL.map(r => r.Trade && r.Trade.trim()).filter(Boolean))].sort();
  const types = [...new Set(PL.map(r => r.Type && r.Type.trim()).filter(Boolean))].sort();
  const locs = [...new Set(PL.map(r => r.Location).filter(Boolean))].sort();

  populateSelect('pl-status-filter', 'All statuses', statuses);
  populateSelect('pl-priority-filter', 'All priorities', priorities);
  populateSelect('pl-trade-filter', 'All trades', trades);
  populateSelect('pl-type-filter', 'All types', types);
  populateSelect('pl-location-filter', 'All locations', locs);

  ['pl-search','pl-status-filter','pl-priority-filter','pl-trade-filter','pl-type-filter','pl-location-filter'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderPLTable);
  });

  document.querySelectorAll('#pl-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (plSort.col === col) plSort.asc = !plSort.asc;
      else { plSort.col = col; plSort.asc = true; }
      renderPLTable();
    });
  });

  renderPLTable();
}

function clearPLFilters() {
  ['pl-search','pl-status-filter','pl-priority-filter','pl-trade-filter','pl-type-filter','pl-location-filter'].forEach(id => document.getElementById(id).value = '');
  renderPLTable();
}

function renderPLTable() {
  const search = document.getElementById('pl-search').value.toLowerCase();
  const statusF = document.getElementById('pl-status-filter').value;
  const priorityF = document.getElementById('pl-priority-filter').value;
  const tradeF = document.getElementById('pl-trade-filter').value;
  const typeF = document.getElementById('pl-type-filter').value;
  const locF = document.getElementById('pl-location-filter').value;

  let data = PL.filter(r =>
    (!search ||
      (r.Title && r.Title.toLowerCase().includes(search)) ||
      (r.Description && r.Description.toLowerCase().includes(search)) ||
      String(r.Number || '').includes(search)) &&
    (!statusF || r.Status === statusF) &&
    (!priorityF || r.Priority === priorityF) &&
    (!tradeF || (r.Trade && r.Trade.trim() === tradeF)) &&
    (!typeF || (r.Type && r.Type.trim() === typeF)) &&
    (!locF || r.Location === locF)
  );

  if (plSort.col) {
    data = [...data].sort((a, b) => {
      const av = a[plSort.col] || '';
      const bv = b[plSort.col] || '';
      const cmp = av.toString().localeCompare(bv.toString(), undefined, { numeric: true });
      return plSort.asc ? cmp : -cmp;
    });
  }

  const renderRows = data.slice(0, 500);

  const tbody = document.getElementById('pl-body');
  tbody.innerHTML = renderRows.map(r => `
    <tr>
      <td class="cell-mono">#${escapeHtml(String(r.Number || '—'))}</td>
      <td>
        <span class="cell-name">${escapeHtml(r.Title || '—')}</span>
        ${r.Overdue === 'Yes' ? '<span class="cell-sub" style="color:var(--bad);font-weight:600">⚠ overdue</span>' : ''}
      </td>
      <td><span class="tag">${escapeHtml(r.Trade ? r.Trade.trim() : '—')}</span></td>
      <td>${getPriorityPill(r.Priority)}</td>
      <td>${escapeHtml(r.Type ? r.Type.trim() : '—')}</td>
      <td>${escapeHtml(r.Location || '—')}</td>
      <td>${getStatusBadge(r.Status)}</td>
    </tr>
  `).join('');

  // Update KPI cards with filtered counts
  document.getElementById('pl-high').textContent   = data.filter(r => r.Priority === 'high').length.toLocaleString();
  document.getElementById('pl-work').textContent   = data.filter(r => r.Status === 'Work Required').length.toLocaleString();
  document.getElementById('pl-ready').textContent  = data.filter(r => r.Status === 'Ready To Close').length.toLocaleString();
  document.getElementById('pl-closed').textContent = data.filter(r => r.Status === 'Closed').length.toLocaleString();

  const truncated = data.length > 500 ? ` (showing first 500 — refine filters for more)` : '';
  document.getElementById('pl-count').textContent = `Showing ${renderRows.length.toLocaleString()} of ${data.length.toLocaleString()} punch items${truncated}`;

  document.querySelectorAll('#pl-table th').forEach(th => th.classList.remove('sorted','sorted-asc'));
  if (plSort.col) {
    const th = document.querySelector(`#pl-table th[data-sort="${plSort.col}"]`);
    if (th) th.classList.add('sorted', plSort.asc ? 'sorted-asc' : '');
  }
}

// ==========================================
// LOCATIONS PAGE
// ==========================================
function initLocations() {
  // Group all locations
  const locs = {};
  AP.forEach(r => {
    if (!r.Location || r.Location === 'Entire Phase>2') return;
    if (!locs[r.Location]) locs[r.Location] = { activities: 0, closed: 0, inprog: 0, notstarted: 0 };
    locs[r.Location].activities++;
    if (r.Status === 'Closed') locs[r.Location].closed++;
    else if (r.Status === 'In Progress') locs[r.Location].inprog++;
    else locs[r.Location].notstarted++;
  });

  // Add line item & punch counts per location
  Object.keys(locs).forEach(loc => {
    locs[loc].liTotal = LI.filter(r => r.Location === loc).length;
    locs[loc].liPassed = LI.filter(r => r.Location === loc && r.Status === 'Passed').length;
    locs[loc].liFailed = LI.filter(r => r.Location === loc && r.Status === 'Failed').length;
    locs[loc].punchOpen = PL.filter(r => r.Location === loc && !['Closed','Ready To Close'].includes(r.Status)).length;
  });

  const grid = document.getElementById('locations-grid');
  grid.innerHTML = Object.entries(locs)
    .sort((a,b) => b[1].activities - a[1].activities)
    .map(([loc, s]) => {
      const code = getLocationCode(loc);
      const pct = s.liTotal > 0 ? Math.round((s.liPassed / s.liTotal) * 100) : 0;
      return `
        <div class="location-card">
          <div class="location-code">${escapeHtml(code)}</div>
          <div class="location-name">${escapeHtml(loc)}</div>
          <div class="location-progress">
            <div class="location-progress-meta">
              <span>Test progress</span>
              <span><b>${pct}%</b></span>
            </div>
            <div class="location-progress-bar"><div class="location-progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="location-stats">
            <div class="location-stat">
              <div class="location-stat-value">${s.activities}</div>
              <div class="location-stat-label">SAT Activities</div>
            </div>
            <div class="location-stat">
              <div class="location-stat-value good">${s.liPassed}</div>
              <div class="location-stat-label">Tests Passed</div>
            </div>
            <div class="location-stat">
              <div class="location-stat-value ${s.punchOpen > 0 ? 'bad' : ''}">${s.punchOpen}</div>
              <div class="location-stat-label">Open Punch</div>
            </div>
          </div>
        </div>
      `;
    }).join('');
}

// ==========================================
// ORG TREE
// ==========================================
function initOrg() {
  const tree = document.getElementById('org-tree');
  // Group by level
  const byLevel = {};
  ORG.forEach(p => {
    if (!byLevel[p.level]) byLevel[p.level] = [];
    byLevel[p.level].push(p);
  });

  let html = '';
  Object.keys(byLevel).sort((a,b) => Number(a) - Number(b)).forEach(level => {
    html += `<div class="org-row">${byLevel[level].map(p => orgCard(p, level === '0')).join('')}</div>`;
  });
  tree.innerHTML = html;
}

function orgCard(p, isLead) {
  const initials = p.name === 'TBD'
    ? '?'
    : p.name.split(/[\s\/]+/).filter(s => s.length > 0).slice(0, 2).map(n => n[0]).join('').toUpperCase();
  return `
    <div class="org-card ${isLead ? 'org-lead' : ''}">
      <div class="org-avatar">${initials}</div>
      <div class="org-info">
        <div class="org-title">${escapeHtml(p.title)}</div>
        <div class="org-name">${escapeHtml(p.name)}</div>
      </div>
    </div>
  `;
}

// ==========================================
// CSV EXPORT
// ==========================================
function toCSV(rows, columns) {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const body = rows.map(r => columns.map(c => {
    const v = r[c.key];
    if (v === null || v === undefined) return '""';
    return `"${String(v).replace(/"/g, '""')}"`;
  }).join(',')).join('\n');
  return header + '\n' + body;
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportAP() {
  // Get currently filtered set by reading the visible rows? Easier: just export all
  const cols = [
    { key: 'Name', label: 'Activity Name' },
    { key: 'SubSystem-', label: 'Subsystem' },
    { key: 'Phase', label: 'Phase' },
    { key: 'Test Level', label: 'Test Level' },
    { key: 'Location', label: 'Location' },
    { key: 'Progress', label: 'Progress' },
    { key: 'Status', label: 'Status' },
    { key: 'Test Report CDRL', label: 'CDRL' },
  ];
  downloadCSV(toCSV(AP, cols), 'sat_activities.csv');
}

function exportLI() {
  const cols = [
    { key: 'TestCaseCode', label: 'Code' },
    { key: 'TestName',     label: 'Test Name' },
    { key: 'Subsystem',    label: 'Subsystem' },
    { key: 'Phase',        label: 'Phase' },
    { key: 'Location',     label: 'Location' },
    { key: 'Activity',     label: 'Activity' },
    { key: 'TestCategory', label: 'Category' },
    { key: 'Status',       label: 'Status' },
    { key: 'Weight',       label: 'Weight' },
    { key: 'Notes',        label: 'Notes' },
  ];
  downloadCSV(toCSV(TI, cols), 'test_cases.csv');
}

function exportPL() {
  const cols = [
    { key: 'Number', label: 'Number' },
    { key: 'Title', label: 'Title' },
    { key: 'Trade', label: 'Trade' },
    { key: 'Priority', label: 'Priority' },
    { key: 'Type', label: 'Type' },
    { key: 'Status', label: 'Status' },
    { key: 'Location', label: 'Location' },
    { key: 'Overdue', label: 'Overdue' },
    { key: 'Description', label: 'Description' },
  ];
  downloadCSV(toCSV(PL, cols), 'punch_list.csv');
}

// ==========================================
// INIT
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadTestItems(), loadTemplates(), loadLocations(), loadPunchDB(), loadFieldsetConfig(), _loadProfileUsers(), loadTestReports(), loadActivityRecords(), loadP6Data()]);
  initDashboard();
  initActivities();
  initLineItems();
  initPunchList();
  initLocations();
  initOrg();
  initAuth();
});

// ==========================================
// FIELD LOGGING - Login + Forms
// ==========================================

let TI = DATA.testItems || []; // populated from Supabase on init; falls back to data.js
const FIELD_USERS = DATA.fieldUsers || [];

// Lightweight anon-key fetch for startup data loads (no auth needed / no getSession call).
// Uses a 15s AbortController timeout so it can never hang the DOMContentLoaded bootstrap.
async function _fetchAnon(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      signal: ctrl.signal,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('request timed out after 15s');
    throw e;
  }
}

async function _fetchCurrentAuth(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      signal: ctrl.signal,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: _getAuthHeader(), Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('request timed out after 15s');
    throw e;
  }
}

async function loadTemplates() {
  try {
    const data = await _fetchAnon('templates?select=*&order=created_at.asc');
    if (data && data.length > 0) {
      TEMPLATES.length = 0;
      data.forEach(r => TEMPLATES.push({
        id:          r.id,
        name:        r.name,
        subsystem:   r.subsystem,
        description: r.description,
        createdBy:   r.created_by,
        createdAt:   r.created_at,
        testCases:   r.test_cases || [],
      }));
      console.log(`Loaded ${TEMPLATES.length} templates from Supabase`);
    }
  } catch (err) {
    console.warn('Supabase templates load failed, using data.js fallback:', err.message);
  }
}

async function loadLocations() {
  try {
    const data = await _fetchAnon('locations?select=*&order=level.asc,sort_order.asc');
    LOCS = (data || []).map(r => ({
      id:        r.id,
      name:      r.name,
      parent_id: r.parent_id || null,
      level:     r.level,
      sort_order: r.sort_order || 0,
    }));
    console.log(`Loaded ${LOCS.length} locations from Supabase`);
  } catch (err) {
    console.warn('Supabase locations load failed:', err.message);
  }
}

async function loadFieldsetConfig() {
  try {
    const data = await _fetchAnon('fieldset_config?select=*');
    FIELDSET_CONFIG = {};
    (data || []).forEach(row => { FIELDSET_CONFIG[row.field_key] = row.options || []; });
  } catch (err) { console.warn('Fieldset config load failed:', err.message); }
}

async function _loadProfileUsers() {
  try {
    const data = await _fetchAnon('profiles?select=full_name,role&is_active=eq.true');
    PROFILE_USERS = (data || []).filter(u => u.full_name).sort((a,b) => a.full_name.localeCompare(b.full_name));
  } catch (err) { console.warn('Profile users load failed:', err.message); }
}

async function loadTestItems() {
  try {
    const data = await _fetchAnon('test_items?select=*&order=test_id.asc');
    if (data && data.length > 0) {
      TI = data.map(r => ({
        TestID:        r.test_id,
        Phase:         r.phase,
        Location:      r.location,
        Subsystem:     r.subsystem,
        Activity:      r.activity,
        TestCategory:  r.test_category,
        TestCaseCode:  r.test_case_code,
        TestName:      r.test_name,
        TestProcedure: r.test_procedure,
        TestPhase:     r.test_phase,
        Status:        r.status,
        ActivityID:    r.activity_id,
        Weight:        r.weight,
        CompletedBy:   r.completed_by,
        CompletedDate: r.completed_date,
        BlockedReason: r.blocked_reason,
        FailedReason:  r.failed_reason || null,
        Notes:         r.notes,
        TestReport:    r.test_report || null,
        TestReportID:  r.test_report_id || null,
      }));
      console.log(`Loaded ${TI.length} test items from Supabase`);
    }
  } catch (err) {
    console.warn('Supabase test_items load failed, using data.js fallback:', err.message);
  }
}

let currentUser = null;
let selectedResult = null;
let selectedDelayOccurred = 'No';

// LocalStorage keys
const LS_USER = 'hitachi_field_user';
const LS_QUEUE = 'hitachi_field_queue';

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(LS_QUEUE) || '[]'); }
  catch { return []; }
}
function saveQueue(q) { localStorage.setItem(LS_QUEUE, JSON.stringify(q)); }

function initField() {
  // Populate user dropdown
  const sel = document.getElementById('login-name');
  sel.innerHTML = '<option value="">Select your name</option>' +
    FIELD_USERS.map(u => `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`).join('');

  // Restore session
  const saved = sessionStorage.getItem(LS_USER);
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      enterFieldApp();
    } catch {}
  }

  document.getElementById('login-btn').addEventListener('click', tryLogin);
  document.getElementById('login-pin').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryLogin();
  });

  // Tab switching
  document.querySelectorAll('.form-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.form-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.form-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('form-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'queue') renderQueue();
      if (tab.dataset.tab === 'delay') recountToday();
    });
  });

  // Result buttons
  document.querySelectorAll('.result-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedResult = btn.dataset.value;
      document.getElementById('r-result').value = selectedResult;
      // Show/hide conditional fields
      document.getElementById('r-fail-block').style.display = selectedResult === 'Fail' ? '' : 'none';
      document.getElementById('r-blocked-block').style.display = selectedResult === 'Blocked' ? '' : 'none';
    });
  });

  // Delay toggle
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDelayOccurred = btn.dataset.delay;
      document.getElementById('d-delay-occurred').value = selectedDelayOccurred;
      document.querySelectorAll('.delay-field').forEach(f => {
        f.style.display = selectedDelayOccurred === 'Yes' ? '' : 'none';
      });
    });
  });

  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  if (document.getElementById('r-date')) document.getElementById('r-date').value = today;
  if (document.getElementById('d-date')) document.getElementById('d-date').value = today;
}

function tryLogin() {
  const name = document.getElementById('login-name').value;
  const pin = document.getElementById('login-pin').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Please select your name'; return; }
  if (!pin || pin.length !== 4) { errEl.textContent = 'Please enter your 4-digit PIN'; return; }

  const user = FIELD_USERS.find(u => u.name === name && u.pin === pin);
  if (!user) {
    errEl.textContent = 'Invalid name or PIN. Please try again.';
    document.getElementById('login-pin').value = '';
    return;
  }

  currentUser = { name: user.name, role: user.role };
  sessionStorage.setItem(LS_USER, JSON.stringify(currentUser));
  enterFieldApp();
}

function logout() {
  currentUser = null;
  sessionStorage.removeItem(LS_USER);
  document.getElementById('field-app').style.display = 'none';
  document.getElementById('field-login').style.display = '';
  document.getElementById('login-pin').value = '';
}

function enterFieldApp() {
  document.getElementById('field-login').style.display = 'none';
  document.getElementById('field-app').style.display = '';
  document.getElementById('user-name').textContent = currentUser.name;
  const initials = currentUser.name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0]).join('').toUpperCase();
  document.getElementById('user-avatar').textContent = initials;

  populateDropdownsResult();
  populateDropdownsDelay();
  recountToday();
}

// Cascading dropdowns - Test Result form
function populateDropdownsResult() {
  const phases = [...new Set(TI.map(t => t.Phase).filter(Boolean))].sort();
  fillSelect('r-phase', phases, 'All Phases');

  ['r-phase', 'r-location', 'r-subsystem', 'r-activity'].forEach(id => {
    document.getElementById(id).addEventListener('change', cascadeResult);
  });
  document.getElementById('r-testid').addEventListener('change', updateTestInfo);

  cascadeResult();
}

function cascadeResult() {
  const phase = document.getElementById('r-phase').value;
  const loc = document.getElementById('r-location').value;
  const sub = document.getElementById('r-subsystem').value;
  const act = document.getElementById('r-activity').value;

  let f = TI.filter(t => !phase || t.Phase === phase);
  fillSelect('r-location', [...new Set(f.map(t => t.Location).filter(Boolean))].sort(), 'All Locations', loc);

  f = f.filter(t => !loc || t.Location === loc);
  fillSelect('r-subsystem', [...new Set(f.map(t => t.Subsystem).filter(Boolean))].sort(), 'All Subsystems', sub);

  f = f.filter(t => !sub || t.Subsystem === sub);
  fillSelect('r-activity', [...new Set(f.map(t => t.Activity).filter(Boolean))].sort(), 'All Activities', act);

  f = f.filter(t => !act || t.Activity === act);
  // Sort with non-Complete first so they're easier to find
  f.sort((a,b) => {
    if (a.Status === 'Complete' && b.Status !== 'Complete') return 1;
    if (b.Status === 'Complete' && a.Status !== 'Complete') return -1;
    return (a.TestName || '').localeCompare(b.TestName || '');
  });
  const tests = f.map(t => ({
    val: t.TestID,
    label: `${t.TestCaseCode || '—'} · ${t.TestName} ${t.Status === 'Complete' ? '✓' : ''}`
  }));
  const sel = document.getElementById('r-testid');
  sel.innerHTML = '<option value="">Select a test case...</option>' +
    tests.map(t => `<option value="${escapeHtml(t.val)}">${escapeHtml(t.label)}</option>`).join('');

  updateTestInfo();
}

function updateTestInfo() {
  const id = document.getElementById('r-testid').value;
  const info = document.getElementById('r-test-info');
  if (!id) { info.textContent = ''; return; }
  const t = TI.find(x => x.TestID === id);
  if (!t) return;
  const statusBadge = t.Status === 'Complete' ? `<span style="color:var(--good);font-weight:600">already Complete</span>` :
                     t.Status === 'Failed' ? `<span style="color:var(--bad);font-weight:600">currently Failed</span>` :
                     `<span style="color:var(--gray-700)">status: ${escapeHtml(t.Status || 'Future')}</span>`;
  info.innerHTML = `Procedure: ${escapeHtml(t.TestProcedure || '—')} · ${statusBadge}`;
}

function fillSelect(id, options, allLabel, current = '') {
  const sel = document.getElementById(id);
  const prev = current || sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    options.map(o => `<option value="${escapeHtml(o)}" ${o === prev ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
}

// Delay form dropdowns
function populateDropdownsDelay() {
  const locs = [...new Set(TI.map(t => t.Location).filter(Boolean))].sort();
  const subs = [...new Set(TI.map(t => t.Subsystem).filter(Boolean))].sort();
  fillSelect('d-location', locs, 'Select location...');
  fillSelect('d-subsystem', subs, 'Select subsystem...');
}

// ==========================================
// SUBMISSIONS
// ==========================================
function submitTestResult() {
  const testid = document.getElementById('r-testid').value;
  const result = selectedResult;
  if (!testid) { showMessage('r-message', 'error', 'Please select a test case'); return; }
  if (!result) { showMessage('r-message', 'error', 'Please select a result (Pass / Fail / Partial / Blocked)'); return; }

  const t = TI.find(x => x.TestID === testid);
  const ts = new Date();
  const resultID = `RES-${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;

  // Map result -> TestItems status update
  const statusMap = { 'Pass': 'Complete', 'Fail': 'Failed', 'Partial': 'Partial', 'Blocked': 'Blocked' };
  const newItemStatus = statusMap[result];

  const payload = {
    type: 'TestResult',
    submittedBy: currentUser.name,
    submittedAt: ts.toISOString(),
    record: {
      ResultID: resultID,
      TestID: testid,
      TestName: t.TestName,
      AttemptNumber: parseInt(document.getElementById('r-attempt').value) || 1,
      Phase: t.Phase,
      Location: t.Location,
      Subsystem: t.Subsystem,
      Activity: t.Activity,
      TestCaseCode: t.TestCaseCode,
      TestProcedure: t.TestProcedure,
      Result: result,
      Team: document.getElementById('r-team').value,
      CompletedBy: currentUser.name,
      DateTested: document.getElementById('r-date').value,
      SubmittedAt: ts.toISOString(),
      NumberOfTesters: parseInt(document.getElementById('r-testers').value) || 1,
      TestHours: parseFloat(document.getElementById('r-hours').value) || 0,
      FailedReason: document.getElementById('r-fail-reason').value,
      BlockedReason: document.getElementById('r-blocked-reason').value,
      Notes: document.getElementById('r-notes').value,
    },
    statusUpdate: {
      TestID: testid,
      NewStatus: newItemStatus,
      CompletedBy: currentUser.name,
      CompletedDate: document.getElementById('r-date').value,
    }
  };

  sendSubmission(payload, 'r-message', () => {
    // Locally update the in-memory test item
    if (t) {
      t.Status = newItemStatus;
      t.CompletedBy = currentUser.name;
      t.CompletedDate = document.getElementById('r-date').value;
    }
    resetResultForm();
    cascadeResult(); // refresh dropdown to show updated status
  });
}

function submitDelayLog() {
  const date = document.getElementById('d-date').value;
  const loc = document.getElementById('d-location').value;
  const sub = document.getElementById('d-subsystem').value;
  if (!date || !loc || !sub) {
    showMessage('d-message', 'error', 'Please fill in date, location and subsystem');
    return;
  }

  const ts = new Date();
  const dateClean = date.replace(/-/g, '');
  const seq = String((loadQueue().filter(q => q.payload?.type === 'DelayLog' && q.payload?.record?.LogDate === date).length + 1)).padStart(3, '0');
  const logID = `DL-${date}-${seq}`;

  const payload = {
    type: 'DelayLog',
    submittedBy: currentUser.name,
    submittedAt: ts.toISOString(),
    record: {
      LogID: logID,
      LogDate: date,
      Location: loc,
      Subsystem: sub,
      SubmittedBy: currentUser.name,
      SubmittedAt: ts.toISOString(),
      NumberOfTesters: parseInt(document.getElementById('d-testers').value) || 1,
      IdleHours: parseFloat(document.getElementById('d-idle').value) || 0,
      TotalTestsLogged: parseInt(document.getElementById('d-total-logged').textContent) || 0,
      TotalPassed: parseInt(document.getElementById('d-total-passed').textContent) || 0,
      TotalFailed: parseInt(document.getElementById('d-total-failed').textContent) || 0,
      TotalPartial: parseInt(document.getElementById('d-total-partial').textContent) || 0,
      TotalBlocked: parseInt(document.getElementById('d-total-blocked').textContent) || 0,
      DelayOccurred: selectedDelayOccurred,
      DelayCategory: selectedDelayOccurred === 'Yes' ? document.getElementById('d-delay-category').value : '',
      DelayDuration: selectedDelayOccurred === 'Yes' ? parseFloat(document.getElementById('d-delay-duration').value) || 0 : 0,
      DelayNotes: selectedDelayOccurred === 'Yes' ? document.getElementById('d-delay-notes').value : '',
      OverallNotes: document.getElementById('d-overall-notes').value,
      NextDayPlan: document.getElementById('d-next-plan').value,
    }
  };

  sendSubmission(payload, 'd-message', () => {
    resetDelayForm();
  });
}

async function sendSubmission(payload, messageId, onSuccess) {
  const queue = loadQueue();
  const queueEntry = {
    id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  queue.push(queueEntry);
  saveQueue(queue);

  showMessage(messageId, 'queued', 'Submitting…');

  const isResult = payload.type === 'TestResult';
  const r = payload.record;
  const su = payload.statusUpdate || {};

  const dbRow = isResult ? {
    result_id:         r.ResultID,
    test_id:           r.TestID,
    test_name:         r.TestName,
    attempt_number:    r.AttemptNumber,
    phase:             r.Phase,
    location:          r.Location,
    subsystem:         r.Subsystem,
    activity:          r.Activity,
    test_case_code:    r.TestCaseCode,
    test_procedure:    r.TestProcedure,
    result:            r.Result,
    team:              r.Team,
    completed_by:      r.CompletedBy,
    date_tested:       r.DateTested || null,
    submitted_by:      r.CompletedBy,
    number_of_testers: r.NumberOfTesters,
    test_hours:        r.TestHours,
    failed_reason:     r.FailedReason,
    blocked_reason:    r.BlockedReason,
    notes:             r.Notes,
    new_status:        su.NewStatus,
  } : {
    log_id:             r.LogID,
    log_date:           r.LogDate || null,
    location:           r.Location,
    subsystem:          r.Subsystem,
    submitted_by:       r.SubmittedBy,
    number_of_testers:  r.NumberOfTesters,
    idle_hours:         r.IdleHours,
    total_tests_logged: r.TotalTestsLogged,
    total_passed:       r.TotalPassed,
    total_failed:       r.TotalFailed,
    total_partial:      r.TotalPartial,
    total_blocked:      r.TotalBlocked,
    delay_occurred:     r.DelayOccurred,
    delay_category:     r.DelayCategory,
    delay_duration:     r.DelayDuration,
    delay_notes:        r.DelayNotes,
    overall_notes:      r.OverallNotes,
    next_day_plan:      r.NextDayPlan,
  };

  const table = isResult ? 'test_results' : 'delay_log';

  try {
    const { error } = await _sb.from(table).insert([dbRow]);
    if (error) throw error;
    queueEntry.status = 'sent';
    queueEntry.sentAt = new Date().toISOString();
    saveQueue(loadQueue().map(q => q.id === queueEntry.id ? queueEntry : q));
    showMessage(messageId, 'success', '✓ Submitted successfully!');
    if (onSuccess) onSuccess();
  } catch (err) {
    queueEntry.status = 'failed';
    queueEntry.error = err.message;
    saveQueue(loadQueue().map(q => q.id === queueEntry.id ? queueEntry : q));
    showMessage(messageId, 'queued', '⚠ Saved locally — will sync when connection is restored. View in My Submissions.');
    if (onSuccess) onSuccess();
  }
}

function showMessage(id, type, text) {
  const el = document.getElementById(id);
  el.className = 'form-message ' + type;
  el.textContent = text;
  if (type === 'success') {
    setTimeout(() => { el.className = 'form-message'; }, 5000);
  }
}

function resetResultForm() {
  document.getElementById('r-testid').value = '';
  document.getElementById('r-team').value = '';
  document.getElementById('r-attempt').value = '1';
  document.getElementById('r-testers').value = '1';
  document.getElementById('r-hours').value = '';
  document.getElementById('r-fail-reason').value = '';
  document.getElementById('r-blocked-reason').value = '';
  document.getElementById('r-notes').value = '';
  document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
  selectedResult = null;
  document.getElementById('r-result').value = '';
  document.getElementById('r-fail-block').style.display = 'none';
  document.getElementById('r-blocked-block').style.display = 'none';
  document.getElementById('r-test-info').textContent = '';
}

function resetDelayForm() {
  document.getElementById('d-testers').value = '1';
  document.getElementById('d-idle').value = '0';
  document.getElementById('d-delay-category').value = '';
  document.getElementById('d-delay-duration').value = '';
  document.getElementById('d-delay-notes').value = '';
  document.getElementById('d-overall-notes').value = '';
  document.getElementById('d-next-plan').value = '';
  document.querySelectorAll('.toggle-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  selectedDelayOccurred = 'No';
  document.getElementById('d-delay-occurred').value = 'No';
  document.querySelectorAll('.delay-field').forEach(f => f.style.display = 'none');
}

function recountToday() {
  if (!currentUser) return;
  const today = document.getElementById('d-date').value || new Date().toISOString().split('T')[0];
  const queue = loadQueue();
  const todays = queue.filter(q =>
    q.payload?.type === 'TestResult' &&
    q.payload?.submittedBy === currentUser.name &&
    q.payload?.record?.DateTested === today
  );
  const counts = { Pass: 0, Fail: 0, Partial: 0, Blocked: 0 };
  todays.forEach(q => {
    const r = q.payload.record.Result;
    if (counts[r] !== undefined) counts[r]++;
  });
  const total = counts.Pass + counts.Fail + counts.Partial + counts.Blocked;
  document.getElementById('d-total-logged').textContent = total;
  document.getElementById('d-total-passed').textContent = counts.Pass;
  document.getElementById('d-total-failed').textContent = counts.Fail;
  document.getElementById('d-total-partial').textContent = counts.Partial;
  document.getElementById('d-total-blocked').textContent = counts.Blocked;
}

function renderQueue() {
  const queue = loadQueue().slice().reverse();
  const list = document.getElementById('queue-list');
  if (queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">No submissions yet. When you log a test or daily report, it will appear here.</div>';
    return;
  }
  list.innerHTML = queue.map(q => {
    const p = q.payload;
    const isResult = p.type === 'TestResult';
    const title = isResult
      ? `${p.record.Result} — ${p.record.TestName || p.record.TestID}`
      : `Daily Log — ${p.record.LogDate} (${p.record.Location} / ${p.record.Subsystem})`;
    const meta = isResult
      ? `${p.record.Phase} · ${p.record.Location} · ${p.record.Subsystem}`
      : `${p.record.TotalTestsLogged} tests logged`;
    const status = q.status === 'sent' ? 'Sent' : q.status === 'failed' ? 'Failed' : 'Pending';
    return `
      <div class="queue-item">
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(title)}</div>
          <div class="queue-item-meta">${escapeHtml(meta)} · ${new Date(q.createdAt).toLocaleString()}</div>
          ${q.error && q.status !== 'sent' ? `<div class="queue-item-meta" style="color:var(--bad);margin-top:4px">⚠ ${escapeHtml(q.error)}</div>` : ''}
        </div>
        <span class="queue-status ${q.status}">${status}</span>
      </div>
    `;
  }).join('');
}

// Hook into init
const _origInit = document.addEventListener;
document.addEventListener('DOMContentLoaded', () => {
  // V1 initField disabled - V2 initLoginV2 below handles login for all roles
  // initField();
});

// ==========================================================================
// PROTOTYPE V2 — Role-based features
// ==========================================================================

const USERS_V2 = DATA.users_v2 || [];
const TEMPLATES = DATA.templates || [];
const LOCATIONS = DATA.locations || [];
let LOCS = []; // hierarchical locations loaded from Supabase
let FIELDSET_CONFIG = {}; // { punch_type:[], priority:[], ... } loaded from Supabase
let PROFILE_USERS = []; // { full_name, role } for typeahead
const DEPLOYMENTS = DATA.deployments || [];
let _adminTab = 'templates';
let TEST_INSTANCES = DATA.testInstances || [];
let PUNCH_ITEMS = DATA.punchItems || [];
let AUDIT_LOG = DATA.auditLog || [];
let DB_AUDIT_EVENTS = [];
let _testReports = [];        // loaded from Supabase test_reports
let _activityRecords = [];    // loaded from Supabase activity_records (future_test_reason store)

// ── P6 Schedule globals ───────────────────────────────────────────────────────
let P6_BATCHES     = [];   // p6_import_batches
let P6_ACTS        = [];   // p6_activities
let P6_MAP         = [];   // p6_activity_map
let P6_PATTERNS    = [];   // p6_learn_patterns
let P6_DISMISSALS  = [];   // p6_activity_dismissals

// ── Health tab filter state ───────────────────────────────────────────────────
let _p6HealthFilter     = { search: '', dateMode: 'all', dateFrom: '', dateTo: '' };
let _p6HealthLinkOpen   = new Set(); // p6 activity IDs with link-panel expanded
let _p6HShowingSnoozed  = false;     // toggle snoozed section visibility
let _trpFilters = { search:'', status:'', subsystem:'', phase:'', location:'' };
let _trpExpanded = new Set();
let _trpSyncInFlight = false;
let _trpAutoSyncAttempted = new Set();
let _trpSearchTimer = null;

const ROLE_LABELS = {
  admin: 'Admin',
  field: 'Field',
  punch_manager: 'Punch Mgr',
  technician: 'Tech',
  client: 'Client',
};
const ROLE_TITLES = {
  admin: 'Administrator',
  field: 'Field Engineer',
  punch_manager: 'Punch List Manager',
  technician: 'Technician',
  client: 'Client / Inspector',
};

let currentRoleUser = null;
let currentProfile  = null;

// ==========================================================================
// SUPABASE AUTH — email + password, session persisted by Supabase
// ==========================================================================
function initAuth() {
  // onAuthStateChange handles SIGN_IN and SIGNED_OUT events.
  // We skip INITIAL_SESSION here — it's handled manually below via localStorage
  // because supabase-js GoTrueClient can hang during its internal init, which
  // would prevent INITIAL_SESSION from ever firing.
  _sb.auth.onAuthStateChange(async (event, session) => {
    console.log('[auth] event:', event);
    if (event === 'INITIAL_SESSION') return; // handled manually below
    if (event === 'TOKEN_REFRESHED') {
      console.log('[auth] token refreshed silently — no profile reload needed');
      return;
    }
    if (event === 'SIGNED_IN' && session?.user) {
      if (currentRoleUser) {
        // Already authenticated — this is the supabase-js GoTrueClient finishing its
        // delayed internal init. Ignore: we already restored from localStorage and
        // the user is on their current page. Re-running would navigate them away.
        console.log('[auth] SIGNED_IN — already authenticated, ignoring delayed event');
        return;
      }
      await _loadCurrentProfile(session.user, session.access_token);
    } else if (event === 'SIGNED_OUT' || !session) {
      _onSignedOut();
    }
  });

  // Restore existing session directly from localStorage — no supabase-js call needed.
  // This covers hard refresh and returning users without waiting for GoTrueClient init.
  const stored = _getSessionFromStorage();
  if (stored?.user && stored?.access_token) {
    console.log('[auth] restoring session from localStorage for:', stored.user.email);
    _loadCurrentProfile(stored.user, stored.access_token);
  } else {
    _onSignedOut();
  }
}

async function _loadCurrentProfile(user, accessToken) {
  // Reset sign-in button if it's stuck (in case we're called from onAuthStateChange
  // after a previous sign-in attempt that timed out mid-way).
  const btn = document.getElementById('auth-btn');
  if (btn) { btn.textContent = 'Signing in…'; btn.disabled = true; }

  try {
    // Use the access token passed in directly from onAuthStateChange — avoids calling
    // _sb.auth.getSession() which can hang while supabase-js is still settling.
    // Falls back to _getAuthHeader() for cases like session restore on page load.
    const authHeader = accessToken ? `Bearer ${accessToken}` : _getAuthHeader();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`,
      { signal: ctrl.signal, headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader, Accept: 'application/json' } }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`profiles fetch failed (${res.status}): ${await res.text()}`);
    const rows = await res.json();
    console.log(`[_loadCurrentProfile] ✓ got ${rows.length} profile row(s)`);
    const data = rows?.[0];

    if (!data) {
      await _sb.auth.signOut();
      showAuthError('Your account is not set up yet — contact your admin.');
      if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
      return;
    }
    if (!data.is_active) {
      await _sb.auth.signOut();
      showAuthError('Your account has been deactivated — contact your admin.');
      if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
      return;
    }
    currentProfile  = data;
    currentRoleUser = {
      name:      data.full_name,
      role:      data.role,
      title:     { admin:'Administrator', field_engineer:'Field Engineer', readonly:'Read Only', client:'Client' }[data.role] || data.role,
      subsystem: data.subsystem || null,
    };
    // Apply subsystem filter to test items if set
    if (currentRoleUser.subsystem) {
      TI = TI.filter(t => (t.Subsystem || '').toLowerCase() === currentRoleUser.subsystem.toLowerCase());
    }
    document.getElementById('login-overlay').classList.add('hidden');
    onLoggedIn();
  } catch(err) {
    console.error('Profile load failed:', err);
    showAuthError('Failed to load profile — try refreshing.');
    if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
  }
}

function _onSignedOut() {
  currentRoleUser = null;
  currentProfile  = null;
  // Always reset the auth button so it never stays stuck on "Signing in…"
  const authBtn = document.getElementById('auth-btn');
  if (authBtn) { authBtn.textContent = 'Sign In'; authBtn.disabled = false; }
  document.getElementById('auth-error')?.textContent && (document.getElementById('auth-error').textContent = '');
  document.getElementById('login-overlay').classList.remove('hidden');
  _checkDbStatus(); // refresh connectivity indicator each time sign-in page appears
  document.querySelectorAll('.nav-role').forEach(l => l.style.display = 'none');
  // Reset admin mode
  _adminModeOn = false;
  const adminItems = document.getElementById('nav-admin-items');
  if (adminItems) adminItems.style.display = 'none';
  const regularItems = document.getElementById('nav-regular-items');
  if (regularItems) regularItems.style.display = '';
  document.getElementById('nav-admin-toggle')?.classList.remove('active');
  const pill = document.getElementById('nav-user-pill');
  if (pill) { pill.style.display = 'none'; pill.innerHTML = ''; }
  const navLogin = document.getElementById('nav-login');
  if (navLogin) navLogin.style.display = '';
}

async function signIn() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const btn      = document.getElementById('auth-btn');
  showAuthError('');
  if (!email || !password) { showAuthError('Enter your email and password.'); return; }
  btn.textContent = 'Signing in…'; btn.disabled = true;
  const { error } = await _sb.auth.signInWithPassword({ email, password });
  if (error) {
    showAuthError(error.message);
    btn.textContent = 'Sign In'; btn.disabled = false;
  }
  // onAuthStateChange handles the rest on success
}

async function signOut() {
  await _sb.auth.signOut();
  _sessionLog     = [];
  intakeAdditions = [];
  intakeStep      = 1;
  showPage('dashboard');
}

// ── Forgot Password modal ─────────────────────────────────────────────────
function openForgotPassword() {
  // Pre-fill with whatever is already typed in the sign-in email field
  const prefill = document.getElementById('auth-email')?.value.trim() || '';
  const inp = document.getElementById('fp-email');
  if (inp && prefill) inp.value = prefill;
  const msg = document.getElementById('fp-msg');
  if (msg) { msg.textContent = ''; msg.style.color = ''; }
  const btn = document.getElementById('fp-btn');
  if (btn) { btn.textContent = 'Send Reset Link'; btn.disabled = false; }
  const m = document.getElementById('forgot-password-modal');
  if (m) { m.style.display = 'flex'; }
  setTimeout(() => { if (!prefill) document.getElementById('fp-email')?.focus(); }, 50);
}

function closeForgotPassword() {
  const m = document.getElementById('forgot-password-modal');
  if (m) m.style.display = 'none';
}

async function submitPasswordReset() {
  const email = document.getElementById('fp-email')?.value.trim();
  const msg   = document.getElementById('fp-msg');
  const btn   = document.getElementById('fp-btn');
  if (!email) {
    if (msg) { msg.textContent = 'Please enter your email address.'; msg.style.color = '#dc2626'; }
    return;
  }
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  if (msg) { msg.textContent = ''; }
  const { error } = await _sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) {
    if (msg) { msg.textContent = error.message; msg.style.color = '#dc2626'; }
    if (btn) { btn.textContent = 'Send Reset Link'; btn.disabled = false; }
  } else {
    if (msg) { msg.textContent = '✓ Reset link sent — check your inbox.'; msg.style.color = '#16a34a'; }
    if (btn) { btn.textContent = 'Link Sent'; btn.disabled = true; }
    setTimeout(closeForgotPassword, 3000);
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg;
}

// ── DB connectivity indicator on sign-in page ─────────────────────────────
async function _checkDbStatus() {
  const dot   = document.getElementById('login-db-dot');
  const label = document.getElementById('login-db-label');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { apikey: SUPABASE_ANON_KEY }
    });
    clearTimeout(timer);
    if (res.ok || res.status === 406) {
      // 406 = "not acceptable" (format mismatch) but server responded → online
      if (dot)   { dot.classList.add('online'); dot.classList.remove('offline'); }
      if (label) label.textContent = 'SYSTEM ONLINE';
    } else {
      if (dot)   { dot.classList.add('offline'); dot.classList.remove('online'); }
      if (label) label.textContent = 'SYSTEM DEGRADED';
    }
  } catch {
    if (dot)   { dot.classList.add('offline'); dot.classList.remove('online'); }
    if (label) label.textContent = 'SYSTEM OFFLINE';
  }
}

// ── Request Access modal ──────────────────────────────────────────────────
const _RA_EMAIL = 'Alexander.Khoury@hitachirail.com';

function openRequestAccess() {
  const m = document.getElementById('request-access-modal');
  if (m) { m.style.display = 'flex'; }
}
function closeRequestAccess() {
  const m = document.getElementById('request-access-modal');
  if (m) { m.style.display = 'none'; }
}
function _rayCopyEmail() {
  navigator.clipboard.writeText(_RA_EMAIL).then(() => {
    const btn = event.target;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy Email'; }, 2000);
  }).catch(() => { prompt('Copy this email:', _RA_EMAIL); });
}
function _rayOpenEmail() {
  window.open(`mailto:${_RA_EMAIL}?subject=Portal%20Access%20Request&body=Hello%2C%0A%0AI%20would%20like%20to%20request%20access%20to%20the%20BART%20CBTC%20T%26C%20Portal.%0A%0AName%3A%20%0ACompany%20%2F%20Role%3A%20%0A`, '_blank');
}
// Close modals on backdrop click
document.addEventListener('click', e => {
  const ra = document.getElementById('request-access-modal');
  if (ra && e.target === ra) closeRequestAccess();
  const fp = document.getElementById('forgot-password-modal');
  if (fp && e.target === fp) closeForgotPassword();
});

function onLoggedIn() {
  document.querySelectorAll('.nav-role').forEach(link => {
    const allowed = (link.dataset.role || '').split(' ');
    link.style.display = allowed.includes(currentRoleUser.role) ? '' : 'none';
  });
  // Filter individual items inside the Tools dropdown
  document.querySelectorAll('.nav-dd-role').forEach(item => {
    const allowed = (item.dataset.role || '').split(' ');
    item.style.display = allowed.includes(currentRoleUser.role) ? '' : 'none';
  });
  const navLogin = document.getElementById('nav-login');
  if (navLogin) navLogin.style.display = 'none';

  // Populate sidebar user card
  const pill = document.getElementById('nav-user-pill');
  if (pill) {
    pill.style.display = 'flex';
    const initials = currentRoleUser.name.split(' ').filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase();
    const roleLabel = { admin:'Administrator', field_engineer:'Field Engineer', readonly:'Read Only', client:'Client' }[currentRoleUser.role] || currentRoleUser.role;
    const subNote = currentRoleUser.subsystem ? ` · ${currentRoleUser.subsystem}` : '';
    pill.innerHTML = `
      <div class="user-avatar" style="width:32px;height:32px;font-size:12px;flex-shrink:0;">${initials}</div>
      <div class="sidenav-user-info">
        <div class="sidenav-user-name">${escapeHtml(currentRoleUser.name)}</div>
        <div class="sidenav-user-role">${roleLabel}${subNote}</div>
      </div>
      <button class="sidenav-signout" onclick="signOut()" title="Sign out">
        <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 100-2H4V5h7a1 1 0 100-2H3zm10.293 4.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L14.586 11H9a1 1 0 110-2h5.586l-1.293-1.293a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </button>
    `;
  }

  const homePage = { admin:'test-register', field_engineer:'field-intake', readonly:'dashboard', client:'dashboard' }[currentRoleUser.role] || 'dashboard';
  showPage(homePage);
  // Re-init views that are subsystem-scoped after login applies TI filter
  initLineItems();
  renderAdminPortal(); renderAdminTemplates(); renderTestRegister(); renderFieldIntake(); renderPunchWorkflow(); renderAuditLog(); renderTestReporting();
  refreshAuditLog().catch(err => console.warn('[audit] refresh failed:', err.message));
  loadTestReports().then(renderTestReporting).catch(err => console.warn('[loadTestReports after login] failed:', err.message));
}

// ==========================================================================
// TOAST NOTIFICATIONS
// ==========================================================================
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icon = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warn' ? '⚠' : 'ℹ';
  el.innerHTML = `<div class="icon">${icon}</div><div>${escapeHtml(msg)}</div>`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(20px)'; el.style.transition = 'all 0.3s'; }, 3500);
  setTimeout(() => el.remove(), 4000);
}

function logAudit(action, target, details, notes = '') {
  if (!currentRoleUser) return;
  const entry = {
    id: 'a-' + Date.now(),
    user: currentRoleUser.name,
    role: currentRoleUser.role,
    action, target, details,
    timestamp: new Date().toISOString(),
    notes,
  };
  AUDIT_LOG.unshift(entry);
  _dbInsert('audit_log', [{
    id: entry.id,
    user_name: entry.user,
    role: entry.role,
    action: entry.action,
    target: entry.target,
    details: entry.details,
    timestamp: entry.timestamp,
    notes: entry.notes,
    table_name: 'audit_log',
    record_id: entry.id,
    source: 'Portal Audit',
  }]).catch(err => console.warn('[audit] persist skipped:', err.message));
  renderAuditLog();
}

function dateAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff/86400) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ==========================================================================
// ADMIN PAGE RENDERS — one per nav section (replaces monolithic tab bar)
// ==========================================================================
function renderAdminAM() {
  const root = document.getElementById('admin-am-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') { root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`; return; }
  root.innerHTML = _adminActivityManagerHTML();
}

function renderAdminTemplates() {
  const root = document.getElementById('admin-templates-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') { root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`; return; }
  root.innerHTML = _adminTemplatesHTML();
}

function renderAdminLocations() {
  const root = document.getElementById('admin-locations-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') { root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`; return; }
  root.innerHTML = _adminLocationsHTML();
}

function renderAdminFieldConfig() {
  const root = document.getElementById('admin-fieldconfig-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') { root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`; return; }
  root.innerHTML = _adminFieldConfigHTML();
}

function renderAdminDirectory() {
  const root = document.getElementById('admin-directory-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') { root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`; return; }
  root.innerHTML = _adminDirectoryHTML();
  _loadDirectoryUsers();
}

function renderAdminOverview() {
  const root = document.getElementById('admin-overview-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') { root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`; return; }
  root.innerHTML = _adminOverviewHTML();
}

// ==========================================================================
// ADMIN PORTAL — Template Management & Deployment
// ==========================================================================
function renderAdminPortal() {
  const root = document.getElementById('admin-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') {
    root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3><p>This area is restricted to Admin role.</p></div>`;
    return;
  }
  const tabs = [
    { id: 'templates',       label: 'Activity Templates' },
    { id: 'testcases',       label: 'Test Items' },
    { id: 'locations',       label: 'Locations' },
    { id: 'directory',       label: 'Directory' },
    { id: 'fieldconfig',     label: 'Field Config' },
    { id: 'activitymanager', label: 'Activity Manager' },
    { id: 'overview',        label: 'Overview' },
  ];
  root.innerHTML = `
    <div class="admin-tabs">
      ${tabs.map(t => `<button class="admin-tab${_adminTab === t.id ? ' active' : ''}" onclick="setAdminTab('${t.id}')">${t.label}</button>`).join('')}
    </div>
    <div id="admin-tab-body"></div>
  `;
  renderAdminTabBody();
  // Also refresh standalone admin pages
  renderAdminTemplates();
  renderAdminOverview();
}

function setAdminTab(tab) {
  _adminTab = tab;
  const labelMap = { templates:'Activity Templates', testcases:'Test Items', locations:'Locations', directory:'Directory', fieldconfig:'Field Config', activitymanager:'Activity Manager', overview:'Overview' };
  document.querySelectorAll('.admin-tab').forEach(el => {
    el.classList.toggle('active', el.textContent.trim() === labelMap[tab]);
  });
  renderAdminTabBody();
}

function renderAdminTabBody() {
  const body = document.getElementById('admin-tab-body');
  if (!body) return;
  if (_adminTab === 'templates')           body.innerHTML = _adminTemplatesHTML();
  else if (_adminTab === 'testcases')      body.innerHTML = _adminTestItemsHTML();
  else if (_adminTab === 'locations')      body.innerHTML = _adminLocationsHTML();
  else if (_adminTab === 'directory')      { body.innerHTML = _adminDirectoryHTML(); _loadDirectoryUsers(); }
  else if (_adminTab === 'fieldconfig')    body.innerHTML = _adminFieldConfigHTML();
  else if (_adminTab === 'activitymanager') { body.innerHTML = _adminActivityManagerHTML(); }
  else body.innerHTML = _adminOverviewHTML();
}

function _adminOverviewHTML() {
  const nDeployments = DEPLOYMENTS.length;
  const nTemplates = TEMPLATES.length;
  const nItems = TI.length;
  const nLocs = LOCS.length;
  return `
    <div class="kpi-grid kpi-grid-mini" style="margin-bottom:28px;">
      <div class="kpi-card kpi-mini"><div class="kpi-label">Activity Templates</div><div class="kpi-value">${nTemplates}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Active Deployments</div><div class="kpi-value">${nDeployments}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Test Items</div><div class="kpi-value">${nItems}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Locations</div><div class="kpi-value">${nLocs}</div></div>
    </div>
    <div class="admin-section">
      <div class="admin-section-head">
        <div><div class="admin-section-title">Recent Deployments</div></div>
      </div>
      <div class="data-card">
        <table class="data-table">
          <thead><tr><th>Template</th><th>Locations</th><th>Test Cases</th><th>Deployed By</th><th>When</th></tr></thead>
          <tbody>
            ${DEPLOYMENTS.length ? DEPLOYMENTS.map(d => {
              const totalTC = d.locations.reduce((sum, l) => sum + l.applicable.length, 0);
              return `<tr>
                <td><span class="cell-name">${escapeHtml(d.templateName)}</span></td>
                <td>${d.locations.map(l => `<span class="tag" style="margin-right:4px">${escapeHtml(l.code)}</span>`).join('')}</td>
                <td><b>${totalTC}</b> applicable across ${d.locations.length} locations</td>
                <td>${escapeHtml(d.deployedBy)}</td>
                <td>${dateAgo(d.deployedAt)}</td>
              </tr>`;
            }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--gray-500);padding:24px;">No deployments yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function _adminTemplatesHTML() {
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Activity Templates</div>
          <p class="section-sub">Create reusable templates that can be deployed across multiple locations</p>
        </div>
        <button class="admin-action-btn" onclick="openNewTemplateModal()">+ New Template</button>
      </div>
      ${TEMPLATES.length ? `<div class="template-grid">
        ${TEMPLATES.map(tpl => `
          <div class="template-card">
            <div class="template-card-head" style="display:flex;align-items:center;justify-content:space-between;">
              <span class="template-tag">${escapeHtml(tpl.subsystem)}</span>
              <div style="display:flex;gap:6px;">
                <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="editTemplate('${tpl.id}')">Edit</button>
                <button class="admin-action-btn" style="font-size:11px;padding:3px 8px;" onclick="openDeployModal('${tpl.id}')">Deploy</button>
                <button class="form-secondary" style="font-size:11px;padding:3px 8px;color:var(--red-600);" onclick="deleteTemplate('${tpl.id}')">Delete</button>
              </div>
            </div>
            <div class="template-card-name" style="cursor:pointer;" onclick="openDeployModal('${tpl.id}')">${escapeHtml(tpl.name)}</div>
            <div class="template-card-sub">${escapeHtml(tpl.description || '')}</div>
            <div class="template-card-stats">
              <span><b>${tpl.testCases.length}</b> test cases</span>
              <span><b>${DEPLOYMENTS.filter(d => d.templateId === tpl.id).length}</b> deployments</span>
            </div>
          </div>
        `).join('')}
      </div>` : `<div class="data-card" style="padding:32px;text-align:center;color:var(--gray-500);">No templates yet — click + New Template to create one.</div>`}
    </div>
  `;
}

function _adminTestItemsHTML() {
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Import Test Items</div>
          <p class="section-sub">Upload a CSV to add new test cases or update existing ones — status is fully controlled by your file.</p>
        </div>
        <button class="admin-action-btn" onclick="downloadImportTemplate()">↓ Download Template</button>
      </div>
      <div class="data-card" style="padding:24px;text-align:center;">
        <p style="font-size:13px;color:var(--gray-700);margin-bottom:16px;">
          Fill in the template CSV, then upload it here. You'll see a full review before anything is saved.
        </p>
        <label style="cursor:pointer;">
          <input type="file" accept=".csv" onchange="handleImportFile(this)" style="display:none">
          <div class="admin-action-btn" style="display:inline-block;cursor:pointer;">📂 Choose CSV to Import</div>
        </label>
        <p style="font-size:11px;color:var(--gray-500);margin-top:12px;">
          Valid Status values: Future · Not Started · In Progress · Pass · Fail · Partial · Blocked
        </p>
      </div>
      <div style="margin-top:20px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--gray-700);">${TI.length} test items loaded</div>
      </div>
    </div>
  `;
}

function _adminLocationsHTML() {
  const tree = _buildLocTree(LOCS);
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Location Hierarchy</div>
          <p class="section-sub">Define phases and stations — used across field intake, templates, and reporting</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="form-secondary" id="loc-delete-btn" style="display:none;font-size:12px;padding:6px 12px;color:var(--red-600);" onclick="bulkDeleteLocations()">Delete Selected</button>
          <label style="cursor:pointer;">
            <input type="file" accept=".csv" onchange="handleLocationImport(this)" style="display:none">
            <div class="admin-action-btn-secondary" style="display:inline-block;cursor:pointer;padding:9px 16px;font-size:13px;font-weight:600;border:1px solid var(--gray-300);border-radius:var(--radius-sm);">↑ Import CSV</div>
          </label>
          <button class="admin-action-btn-secondary" onclick="downloadLocationTemplate()">↓ CSV Template</button>
          <button class="admin-action-btn" onclick="openAddLocationModal(null, 1)">+ Add Phase</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gray-600);cursor:pointer;">
          <input type="checkbox" id="loc-select-all" onchange="locToggleSelectAll(this.checked)"> Select all
        </label>
        <span id="loc-selected-count" style="font-size:12px;color:var(--gray-500);"></span>
      </div>
      <div class="loc-tree">
        ${tree.length ? tree.map(n => _renderLocNode(n, 0)).join('') : `<div class="data-card" style="padding:32px;text-align:center;color:var(--gray-500);">No locations yet — click + Add Phase to start, or import a CSV.</div>`}
      </div>
    </div>
  `;
}

function _buildLocTree(locs) {
  const map = {};
  locs.forEach(l => { map[l.id] = { ...l, children: [] }; });
  const roots = [];
  locs.forEach(l => {
    if (l.parent_id && map[l.parent_id]) map[l.parent_id].children.push(map[l.id]);
    else roots.push(map[l.id]);
  });
  return roots;
}

function _renderLocNode(node, depth) {
  const indent = depth * 28;
  const levelClass = `loc-level-${Math.min(node.level, 3)}`;
  return `
    <div class="${levelClass}" style="margin-left:${indent}px;">
      <div class="loc-node-row">
        <div class="loc-node-name">
          <input type="checkbox" class="loc-cb" data-id="${node.id}" onchange="locUpdateSelection()" style="margin-right:6px;">
          ${depth > 0 ? '<span class="loc-indent">└─</span>' : ''}
          <span class="loc-level-badge">L${node.level}</span>
          ${escapeHtml(node.name)}
        </div>
        <div class="loc-node-actions">
          <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="openAddLocationModal('${node.id}', ${node.level + 1})">+ Sub-level</button>
          <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="openEditLocationModal('${node.id}')">Edit</button>
          <button class="form-secondary" style="font-size:11px;padding:3px 8px;color:var(--red-600);" onclick="deleteLocation('${node.id}')">Delete</button>
        </div>
      </div>
    </div>
    ${node.children.map(c => _renderLocNode(c, depth + 1)).join('')}
  `;
}

function locToggleSelectAll(checked) {
  document.querySelectorAll('.loc-cb').forEach(cb => { cb.checked = checked; });
  locUpdateSelection();
}

function locUpdateSelection() {
  const checked = document.querySelectorAll('.loc-cb:checked');
  const btn = document.getElementById('loc-delete-btn');
  const count = document.getElementById('loc-selected-count');
  if (btn) btn.style.display = checked.length ? 'inline-block' : 'none';
  if (count) count.textContent = checked.length ? `${checked.length} selected` : '';
}

async function bulkDeleteLocations() {
  const checked = [...document.querySelectorAll('.loc-cb:checked')];
  if (!checked.length) return;
  const ids = checked.map(cb => cb.dataset.id);
  // Warn if any selected node still has children not also selected
  const unselectedChildren = LOCS.filter(l => l.parent_id && ids.includes(l.parent_id) && !ids.includes(l.id));
  if (unselectedChildren.length) {
    toast(`Some selected locations have sub-locations not selected. Select all children too, or delete them first.`, 'error');
    return;
  }
  if (!confirm(`Delete ${ids.length} location${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;

  // Delete children-first order (deepest level first)
  const ordered = ids.slice().sort((a, b) => {
    const la = LOCS.find(l => l.id === a)?.level || 0;
    const lb = LOCS.find(l => l.id === b)?.level || 0;
    return lb - la;
  });

  let failed = 0;
  for (const id of ordered) {
    const { error } = await _sb.from('locations').delete().eq('id', id);
    if (error) { console.error('Delete failed for', id, error.message); failed++; }
    else { const i = LOCS.findIndex(l => l.id === id); if (i !== -1) LOCS.splice(i, 1); }
  }

  if (failed) toast(`Deleted ${ids.length - failed}, failed ${failed}`, 'warn');
  else toast(`Deleted ${ids.length} location${ids.length > 1 ? 's' : ''}`, 'success');
  renderAdminTabBody();
}

// ==========================================================================
// LOCATION MANAGEMENT
// ==========================================================================
function openAddLocationModal(parentId, level) {
  const parentName = parentId ? (LOCS.find(l => l.id === parentId)?.name || '') : null;
  modal({
    title: parentId ? `Add Sub-level under "${parentName}"` : 'Add Phase (Level 1)',
    size: 'small',
    body: `
      <div class="form-field">
        <label>Name</label>
        <input type="text" id="loc-name" class="form-input" placeholder="${level === 1 ? 'e.g. Phase 0' : 'e.g. W40 Millbrae'}">
      </div>
      <div class="form-field" style="margin-top:12px;">
        <label>Sort Order <span style="font-weight:400;color:var(--gray-500);">(optional, lower = first)</span></label>
        <input type="number" id="loc-sort" class="form-input" value="0" min="0">
      </div>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="saveNewLocation('${parentId || ''}', ${level})">Add</button>
    `,
  });
  setTimeout(() => document.getElementById('loc-name')?.focus(), 50);
}

async function saveNewLocation(parentId, level) {
  const name = document.getElementById('loc-name').value.trim();
  const sort  = parseInt(document.getElementById('loc-sort').value) || 0;
  if (!name) { toast('Name is required', 'error'); return; }
  const id = 'loc-' + Date.now();
  const { error } = await _sb.from('locations').insert({
    id, name, parent_id: parentId || null, level, sort_order: sort,
  });
  if (error) { toast('Save failed: ' + error.message, 'error'); return; }
  LOCS.push({ id, name, parent_id: parentId || null, level, sort_order: sort });
  closeModal();
  toast(`Added: ${name}`, 'success');
  renderAdminTabBody();
}

function openEditLocationModal(id) {
  const loc = LOCS.find(l => l.id === id);
  if (!loc) return;
  modal({
    title: 'Edit Location',
    size: 'small',
    body: `
      <div class="form-field">
        <label>Name</label>
        <input type="text" id="eloc-name" class="form-input" value="${escapeHtml(loc.name)}">
      </div>
      <div class="form-field" style="margin-top:12px;">
        <label>Sort Order</label>
        <input type="number" id="eloc-sort" class="form-input" value="${loc.sort_order || 0}" min="0">
      </div>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="saveEditLocation('${id}')">Save</button>
    `,
  });
  setTimeout(() => document.getElementById('eloc-name')?.focus(), 50);
}

async function saveEditLocation(id) {
  const loc  = LOCS.find(l => l.id === id);
  if (!loc) return;
  const name = document.getElementById('eloc-name').value.trim();
  const sort = parseInt(document.getElementById('eloc-sort').value) || 0;
  if (!name) { toast('Name is required', 'error'); return; }
  const { error } = await _sb.from('locations').update({ name, sort_order: sort }).eq('id', id);
  if (error) { toast('Save failed: ' + error.message, 'error'); return; }
  loc.name = name; loc.sort_order = sort;
  closeModal();
  toast(`Saved: ${name}`, 'success');
  renderAdminTabBody();
}

async function deleteLocation(id) {
  const loc = LOCS.find(l => l.id === id);
  if (!loc) return;
  const children = LOCS.filter(l => l.parent_id === id);
  if (children.length) {
    toast(`Remove the ${children.length} sub-location(s) under "${loc.name}" first`, 'error');
    return;
  }
  if (!confirm(`Delete "${loc.name}"? This cannot be undone.`)) return;
  const { error } = await _sb.from('locations').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return; }
  LOCS.splice(LOCS.indexOf(loc), 1);
  toast(`Deleted: ${loc.name}`, 'success');
  renderAdminTabBody();
}

function downloadLocationTemplate() {
  const csv = 'Level,Name,ParentName\n1,Phase 0,\n1,Phase 1,\n1,Phase 2,\n2,W40 Millbrae,Phase 0\n2,M10,Phase 2';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  a.download = 'Locations_Template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

let _locImportRows = [];

function handleLocationImport(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  file.text().then(text => {
    const rows = parseCSVGeneric(text);
    _locImportRows = rows.filter(r => r.Level && r.Name).map(r => ({
      level:      parseInt(r.Level) || 1,
      name:       r.Name.trim(),
      parentName: (r.ParentName || '').trim(),
    }));
    if (!_locImportRows.length) { toast('No valid rows found — need Level, Name, ParentName columns', 'error'); return; }
    modal({
      title: 'Review Location Import',
      size: 'medium',
      body: `
        <p style="font-size:13px;color:var(--gray-700);margin-bottom:16px;">${_locImportRows.length} locations will be imported. Existing locations with the same name + level are skipped.</p>
        <div class="data-card" style="padding:0;max-height:300px;overflow-y:auto;">
          <table class="data-table">
            <thead><tr><th>Level</th><th>Name</th><th>Parent</th></tr></thead>
            <tbody>
              ${_locImportRows.map(r => `<tr>
                <td><span class="loc-level-badge">L${r.level}</span></td>
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.parentName) || '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `,
      footer: `
        <button class="form-secondary" onclick="closeModal()">Cancel</button>
        <button class="form-submit" onclick="executeLocationImport()">Import ${_locImportRows.length} Locations</button>
      `,
    });
  });
}

async function executeLocationImport() {
  // Build in-order: parents first (sort by level ascending)
  const sorted = [..._locImportRows].sort((a, b) => a.level - b.level);
  const nameToId = {};
  // Seed from existing LOCS
  LOCS.forEach(l => { nameToId[`${l.level}:${l.name}`] = l.id; });

  let added = 0;
  for (const row of sorted) {
    const key = `${row.level}:${row.name}`;
    if (nameToId[key]) continue; // already exists
    const parentKey = row.parentName ? `${row.level - 1}:${row.parentName}` : null;
    const parentId  = parentKey ? (nameToId[parentKey] || null) : null;
    const id = 'loc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const { error } = await _sb.from('locations').insert({ id, name: row.name, parent_id: parentId, level: row.level, sort_order: 0 });
    if (error) { toast('Import error on "' + row.name + '": ' + error.message, 'error'); continue; }
    LOCS.push({ id, name: row.name, parent_id: parentId, level: row.level, sort_order: 0 });
    nameToId[key] = id;
    added++;
  }
  closeModal();
  toast(`Imported ${added} location(s)`, 'success');
  renderAdminTabBody();
}

// ==========================================================================
// TEST ITEM CSV IMPORT
// ==========================================================================
let _importPendingRows = [];

function downloadImportTemplate() {
  const headers = ['TestID','Phase','Location','Subsystem','Activity','TestCategory','TestCaseCode','TestName','TestProcedure','TestPhase','Status','ActivityID','PlannedDate','Weight','Notes','TestReport'];
  const example = ['P2-W40-ATS-EXAMPLE','Phase 2','W40','ATS','ATS SAT','Hardware SAT','HW-SAT-XX','Example Test Name','1. Do step one. 2. Verify result.','SAT','Future','ACT-001','2025-06-01','1','Optional notes','https://docs.example.com/report'];
  const csv = headers.join(',') + '\n' + example.map(v => `"${v}"`).join(',');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'TestItems_Import_Template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function splitCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

function parseCSVGeneric(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.trim().replace(/^"|"$/g,''));
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim().replace(/^"|"$/g,''); });
    return obj;
  });
}

function parseCSV(text) {
  return parseCSVGeneric(text).filter(r => r.TestID && r.TestID.trim() !== '');
}

function parseImportDate(val) {
  if (!val || !val.trim()) return null;
  const d = new Date(val.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function importStatusBadge(status) {
  const s = (status || '').toLowerCase().trim();
  if (s === 'pass' || s === 'passed') return 'passed';
  if (s === 'fail' || s === 'failed') return 'failed';
  if (s === 'blocked') return 'pending';
  if (s === 'in progress' || s === 'in_progress' || s === 'partial') return 'progress';
  return 'neutral';
}

// Returns { exact: bool, name: string } or null if no match at all
function _matchLoc(value, level, parentId) {
  if (!value || !LOCS.length) return null;
  const v = value.toLowerCase().trim();
  const pool = LOCS.filter(l => l.level === level && (parentId == null || l.parent_id === parentId));
  const exact = pool.find(l => l.name.toLowerCase() === v);
  if (exact) return { exact: true, name: exact.name, id: exact.id };
  // partial: input is contained in a known name or vice-versa
  const partial = pool.find(l => l.name.toLowerCase().includes(v) || v.includes(l.name.toLowerCase()));
  if (partial) return { exact: false, name: partial.name, id: partial.id };
  return null;
}

async function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  let text;
  try { text = await file.text(); } catch(e) { toast('Could not read file', 'error'); return; }

  const rows = parseCSV(text);
  if (rows.length === 0) {
    toast('No valid rows found — make sure the TestID column is filled in.', 'warn');
    return;
  }

  const existingMap = {};
  TI.forEach(t => { existingMap[t.TestID] = t; });

  // Location validation (only if master list is loaded)
  const locWarnings = [];
  if (LOCS.length > 0) {
    rows.forEach(r => {
      const phaseMatch = _matchLoc(r.Phase || '', 1, null);
      const locMatch   = phaseMatch ? _matchLoc(r.Location || '', 2, phaseMatch.id) : null;

      if (r.Phase && !phaseMatch) {
        locWarnings.push({ id: r.TestID, field: 'Phase', value: r.Phase, suggestion: null });
      } else if (r.Phase && phaseMatch && !phaseMatch.exact) {
        locWarnings.push({ id: r.TestID, field: 'Phase', value: r.Phase, suggestion: phaseMatch.name });
      }
      if (r.Location && phaseMatch && !locMatch) {
        locWarnings.push({ id: r.TestID, field: 'Location', value: r.Location, suggestion: null });
      } else if (r.Location && locMatch && !locMatch.exact) {
        locWarnings.push({ id: r.TestID, field: 'Location', value: r.Location, suggestion: locMatch.name });
      }
    });
  }

  const conflicts = rows.filter(r => existingMap[r.TestID]);
  const newItems  = rows.filter(r => !existingMap[r.TestID]);
  _importPendingRows = rows;

  const warnHTML = locWarnings.length > 0 ? `
    <div style="margin-bottom:16px;padding:14px;border:1px solid #d97706;border-radius:8px;background:rgba(217,119,6,0.05);">
      <div style="font-weight:600;font-size:13px;color:#d97706;margin-bottom:10px;">⚠ ${locWarnings.length} location name${locWarnings.length > 1 ? 's' : ''} don't match the master list</div>
      <div style="max-height:140px;overflow-y:auto;">
        <table class="data-table">
          <thead><tr><th>Test ID</th><th>Field</th><th>In CSV</th><th>Master List Says</th></tr></thead>
          <tbody>
            ${locWarnings.map(w => `<tr>
              <td style="font-size:11px;font-weight:600;">${escapeHtml(w.id)}</td>
              <td style="font-size:11px;">${escapeHtml(w.field)}</td>
              <td style="font-size:11px;color:#dc2626;">${escapeHtml(w.value)}</td>
              <td style="font-size:11px;color:#16a34a;">${w.suggestion ? escapeHtml(w.suggestion) : '<em style="color:var(--gray-400)">no match found</em>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p style="font-size:11px;color:var(--gray-600);margin-top:8px;">You can still import — mismatched names will be stored as-is. Fix the CSV or update the master locations list.</p>
    </div>` : '';

  const conflictHTML = conflicts.length > 0 ? `
    <div style="margin-bottom:16px;padding:16px;border:1px solid var(--warn);border-radius:8px;background:rgba(217,119,6,0.05);">
      <div style="font-weight:600;font-size:14px;color:var(--warn);margin-bottom:12px;">
        ⚠ ${conflicts.length} existing test case${conflicts.length > 1 ? 's' : ''} will be overwritten
      </div>
      <div style="max-height:200px;overflow-y:auto;margin-bottom:14px;">
        <table class="data-table">
          <thead><tr><th>Test ID</th><th>Test Name</th><th>Current Status</th><th></th><th>New Status</th></tr></thead>
          <tbody>
            ${conflicts.map(r => {
              const old = existingMap[r.TestID];
              const oldSt = old?.Status || '—';
              const newSt = r.Status || 'Future';
              return `<tr>
                <td style="font-size:12px;font-weight:600;">${escapeHtml(r.TestID)}</td>
                <td style="font-size:12px;">${escapeHtml(r.TestName || '')}</td>
                <td><span class="badge badge-${importStatusBadge(oldSt)}">${escapeHtml(oldSt)}</span></td>
                <td style="color:var(--gray-500);font-size:11px;text-align:center;">→</td>
                <td><span class="badge badge-${importStatusBadge(newSt)}" style="${oldSt !== newSt ? 'font-weight:700;' : ''}">${escapeHtml(newSt)}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;user-select:none;">
        <input type="checkbox" id="import-cb" style="width:16px;height:16px;" onchange="document.getElementById('do-import-btn').disabled=!this.checked">
        I confirm I want to overwrite these ${conflicts.length} existing test case${conflicts.length > 1 ? 's' : ''}
      </label>
    </div>` : '';

  const newHTML = newItems.length > 0 ? `
    <div style="padding:16px;border:1px solid var(--good);border-radius:8px;background:rgba(0,135,90,0.05);">
      <div style="font-weight:600;font-size:14px;color:var(--good);margin-bottom:12px;">
        ✓ ${newItems.length} new test case${newItems.length > 1 ? 's' : ''} to add
      </div>
      <div style="max-height:200px;overflow-y:auto;">
        <table class="data-table">
          <thead><tr><th>Test ID</th><th>Test Name</th><th>Phase</th><th>Location</th><th>Status</th></tr></thead>
          <tbody>
            ${newItems.map(r => `<tr>
              <td style="font-size:12px;font-weight:600;">${escapeHtml(r.TestID)}</td>
              <td style="font-size:12px;">${escapeHtml(r.TestName || '')}</td>
              <td style="font-size:12px;">${escapeHtml(r.Phase || '')}</td>
              <td style="font-size:12px;">${escapeHtml(r.Location || '')}</td>
              <td><span class="badge badge-${importStatusBadge(r.Status||'Future')}">${escapeHtml(r.Status||'Future')}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '';

  modal({
    title: 'Review Import',
    sub: `${rows.length} rows — ${newItems.length} new · ${conflicts.length} will overwrite existing`,
    size: 'large',
    body: warnHTML + conflictHTML + newHTML,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" id="do-import-btn" ${conflicts.length > 0 ? 'disabled' : ''} onclick="executeImport()">
        Import ${rows.length} test case${rows.length !== 1 ? 's' : ''}
      </button>`,
  });
}

async function executeImport() {
  if (!_importPendingRows.length || !_sb) return;
  const btn = document.getElementById('do-import-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  const dbRows = _importPendingRows.map(r => ({
    test_id:        r.TestID.trim(),
    phase:          r.Phase         || null,
    location:       r.Location      || null,
    subsystem:      r.Subsystem     || null,
    activity:       r.Activity      || null,
    test_category:  r.TestCategory  || null,
    test_case_code: r.TestCaseCode  || '',
    test_name:      r.TestName      || null,
    test_procedure: r.TestProcedure || null,
    test_phase:     r.TestPhase     || null,
    status:         r.Status        || 'Future',
    activity_id:    r.ActivityID    || null,
    planned_date:   parseImportDate(r.PlannedDate),
    weight:         r.Weight ? parseFloat(r.Weight) : null,
    notes:          r.Notes         || null,
    synced_at:      new Date().toISOString(),
  }));

  try {
    const { error } = await _sb.from('test_items').upsert(dbRows, { onConflict: 'test_id' });
    if (error) throw error;
    await loadTestItems();
    closeModal();
    _importPendingRows = [];
    toast(`Imported ${dbRows.length} test case${dbRows.length !== 1 ? 's' : ''} successfully!`, 'success');
    renderAdminPortal();
    renderAdminTemplates();
  } catch (err) {
    console.error('Import failed:', err);
    toast(`Import failed: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = `Import ${dbRows.length} test cases`; }
  }
}

let _deploySelections = []; // [{ locId, locName, phase, location, tcCodes:[] }]
let _deployTplId = null;

function openDeployModal(templateId) {
  const tpl = TEMPLATES.find(t => t.id === templateId);
  if (!tpl) return;
  _deployTplId = templateId;
  _deploySelections = [];

  const phases = LOCS.filter(l => l.level === 1).sort((a,b) => a.sort_order - b.sort_order);
  const noLocs = phases.length === 0;

  modal({
    title: `Deploy: ${tpl.name}`,
    sub: `${tpl.subsystem} · ${tpl.testCases.length} test cases`,
    size: 'large',
    body: `
      ${noLocs ? `<div style="padding:12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;font-size:13px;margin-bottom:16px;">
        No locations in master list yet — go to Admin → Locations to add them first.
      </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:flex-end;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--gray-200);">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--gray-500);display:block;margin-bottom:4px;">PHASE</label>
          <select id="dep-phase" class="form-input" onchange="deployFilterLocations()" ${noLocs ? 'disabled' : ''}>
            <option value="">Select phase…</option>
            ${phases.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--gray-500);display:block;margin-bottom:4px;">LOCATION</label>
          <select id="dep-location" class="form-input" ${noLocs ? 'disabled' : ''}>
            <option value="">Select phase first…</option>
          </select>
        </div>
        <button class="admin-action-btn" onclick="deployAddLocation('${templateId}')" style="white-space:nowrap;" ${noLocs ? 'disabled' : ''}>+ Add</button>
      </div>
      <div id="deploy-selections">
        <div style="text-align:center;color:var(--gray-400);font-size:13px;padding:20px 0;">No locations added yet</div>
      </div>
    `,
    footer: `
      <button class="admin-action-btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="admin-action-btn" id="dep-confirm-btn" onclick="confirmDeploy('${templateId}')">Deploy</button>
    `,
  });
}

function deployFilterLocations() {
  const phaseId = document.getElementById('dep-phase').value;
  const locSel  = document.getElementById('dep-location');
  if (!phaseId) { locSel.innerHTML = '<option value="">Select phase first…</option>'; return; }
  const children = LOCS.filter(l => l.parent_id === phaseId).sort((a,b) => a.sort_order - b.sort_order);
  locSel.innerHTML = children.length
    ? '<option value="">Select location…</option>' + children.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')
    : '<option value="">No locations under this phase</option>';
}

function deployAddLocation(templateId) {
  const tpl      = TEMPLATES.find(t => t.id === templateId);
  const phaseEl  = document.getElementById('dep-phase');
  const locEl    = document.getElementById('dep-location');
  const phaseId  = phaseEl.value;
  const locId    = locEl.value;
  if (!phaseId) { toast('Select a phase first', 'warn'); return; }
  if (!locId)   { toast('Select a location', 'warn'); return; }
  if (_deploySelections.find(s => s.locId === locId)) { toast('Location already added', 'warn'); return; }

  const phase = LOCS.find(l => l.id === phaseId);
  const loc   = LOCS.find(l => l.id === locId);
  _deploySelections.push({
    locId, locName: loc.name, phaseName: phase.name,
    tcCodes: tpl.testCases.map(tc => tc.code),
  });
  _renderDeploySelections(tpl);
  // Reset dropdowns
  locEl.value = '';
}

function deployRemoveLocation(locId) {
  _deploySelections = _deploySelections.filter(s => s.locId !== locId);
  const tpl = TEMPLATES.find(t => t.id === _deployTplId);
  _renderDeploySelections(tpl);
}

function _renderDeploySelections(tpl) {
  const el = document.getElementById('deploy-selections');
  if (!el) return;
  if (!_deploySelections.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--gray-400);font-size:13px;padding:20px 0;">No locations added yet</div>';
    return;
  }
  el.innerHTML = _deploySelections.map((s, si) => `
    <div style="border:1px solid var(--gray-200);border-radius:8px;margin-bottom:10px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--gray-50);border-bottom:1px solid var(--gray-200);">
        <div style="font-weight:600;font-size:13px;">
          <span style="color:var(--gray-500);font-weight:400;">${escapeHtml(s.phaseName)} /</span> ${escapeHtml(s.locName)}
          <span style="font-size:11px;color:var(--gray-500);font-weight:400;margin-left:8px;" id="dep-count-${s.locId}">${s.tcCodes.length} of ${tpl.testCases.length} test cases</span>
        </div>
        <button onclick="deployRemoveLocation('${s.locId}')" style="font-size:11px;color:var(--red-600);background:none;border:none;cursor:pointer;padding:2px 6px;">✕ Remove</button>
      </div>
      <div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px;">
        ${tpl.testCases.map(tc => `
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;background:var(--white);border:1px solid var(--gray-200);border-radius:4px;padding:4px 8px;cursor:pointer;">
            <input type="checkbox" data-si="${si}" data-tc="${tc.code}" ${s.tcCodes.includes(tc.code) ? 'checked' : ''}
              onchange="_deployToggleTc(${si},'${tc.code}',this.checked)">
            <span>${escapeHtml(tc.code)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function _deployToggleTc(si, tcCode, checked) {
  if (checked) { if (!_deploySelections[si].tcCodes.includes(tcCode)) _deploySelections[si].tcCodes.push(tcCode); }
  else { _deploySelections[si].tcCodes = _deploySelections[si].tcCodes.filter(c => c !== tcCode); }
  const tpl = TEMPLATES.find(t => t.id === _deployTplId);
  const s = _deploySelections[si];
  const el = document.getElementById(`dep-count-${s.locId}`);
  if (el) el.textContent = `${s.tcCodes.length} of ${tpl.testCases.length} test cases`;
}

function confirmDeploy(templateId) {
  const tpl = TEMPLATES.find(t => t.id === templateId);
  if (!_deploySelections.length) { toast('Add at least one location', 'warn'); return; }
  const empty = _deploySelections.filter(s => !s.tcCodes.length);
  if (empty.length) { toast(`"${empty[0].locName}" has no test cases selected`, 'warn'); return; }

  const enabledLocs = _deploySelections.map(s => ({ code: s.locId, name: s.locName, phase: s.phaseName, applicable: s.tcCodes }));

  const newDep = {
    id: 'dep-' + Date.now(),
    templateId,
    templateName: tpl.name,
    deployedBy: currentRoleUser.name,
    deployedAt: new Date().toISOString(),
    locations: enabledLocs,
  };
  DEPLOYMENTS.unshift(newDep);

  enabledLocs.forEach(loc => {
    loc.applicable.forEach(tcCode => {
      const tc = tpl.testCases.find(t => t.code === tcCode);
      TEST_INSTANCES.push({
        id: `ti-${newDep.id}-${loc.code}-${tcCode}`,
        deploymentId: newDep.id,
        templateName: tpl.name,
        subsystem: tpl.subsystem,
        location: loc.code,
        phase: loc.phase,
        testCode: tcCode,
        testName: tc?.name || tcCode,
        procedure: tc?.procedure || '',
        duration: tc?.duration || 1,
        status: 'not_started',
        applicable: true,
        lastUpdatedBy: null,
        lastUpdatedAt: null,
        notes: '',
      });
    });
  });

  logAudit('Deployed Template',
    `${tpl.name} → ${enabledLocs.map(l => l.name).join(', ')}`,
    `${enabledLocs.reduce((s, l) => s + l.applicable.length, 0)} test cases created`);

  closeModal();
  _deploySelections = [];
  toast(`Deployed ${tpl.name} to ${enabledLocs.length} location${enabledLocs.length > 1 ? 's' : ''}`, 'success');
  renderAdminPortal();
  renderAdminTemplates();
  renderTestRegister();
}

// ==========================================================================
// TEMPLATE CREATION — Activity-based with inline test case builder
// ==========================================================================
let _templateCases = [];

function _tcRowsHTML() {
  return _templateCases.map((tc, i) => `
    <div style="display:grid;grid-template-columns:140px 1fr 130px 32px 32px;gap:6px;align-items:center;margin-bottom:6px;">
      <input type="text" class="form-input" style="font-size:12px;padding:6px 8px;" placeholder="Code e.g. DCS-01"
        value="${escapeHtml(tc.code)}" oninput="_templateCases[${i}].code=this.value">
      <input type="text" class="form-input" style="font-size:12px;padding:6px 8px;" placeholder="Test Case Name"
        value="${escapeHtml(tc.name)}" oninput="_templateCases[${i}].name=this.value">
      <input type="text" class="form-input" style="font-size:12px;padding:6px 8px;" placeholder="Category"
        value="${escapeHtml(tc.category)}" oninput="_templateCases[${i}].category=this.value">
      <button class="form-secondary" style="padding:4px;font-size:13px;min-width:32px;" title="Duplicate" onclick="duplicateTemplateCase(${i})">⧉</button>
      <button class="form-secondary" style="padding:4px;font-size:13px;min-width:32px;color:var(--bad);" title="Remove" onclick="removeTemplateCase(${i})" ${_templateCases.length === 1 ? 'disabled' : ''}>×</button>
    </div>
  `).join('');
}

function addTemplateCase() {
  _templateCases.push({ code:'', name:'', category:'' });
  document.getElementById('tc-rows').innerHTML = _tcRowsHTML();
}

function duplicateTemplateCase(i) {
  _templateCases.splice(i + 1, 0, { ..._templateCases[i] });
  document.getElementById('tc-rows').innerHTML = _tcRowsHTML();
}

function removeTemplateCase(i) {
  if (_templateCases.length === 1) return;
  _templateCases.splice(i, 1);
  document.getElementById('tc-rows').innerHTML = _tcRowsHTML();
}

function downloadTemplateCaseCSV() {
  const csv = 'Code,Name,Category\n"DCS-SAT-01","Network Connectivity Test","Hardware SAT"';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  a.download = 'TestCases_Template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function handleTemplateCaseImport(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  file.text().then(text => {
    const rows = parseCSVGeneric(text);
    const imported = rows.map(r => ({
      code:     r.Code     || r.TestCaseCode || r['Test Case Code'] || '',
      name:     r.Name     || r.TestName     || r['Test Case Name'] || '',
      category: r.Category || r.TestCategory || r['Test Category']  || '',
    })).filter(r => r.code || r.name);
    if (!imported.length) { toast('Could not find Code/Name/Category columns', 'warn'); return; }
    _templateCases = imported;
    document.getElementById('tc-rows').innerHTML = _tcRowsHTML();
    toast(`Loaded ${imported.length} test cases from CSV`, 'success');
  });
}

function openNewTemplateModal() {
  _templateCases = [{ code:'', name:'', category:'' }];
  modal({
    title: 'Create Activity Template',
    sub: 'Define a reusable set of test cases for an activity',
    size: 'large',
    body: `
      <div class="form-grid" style="margin-bottom:20px;">
        <div class="form-field form-field-full">
          <label>Activity Name</label>
          <input type="text" id="ntpl-name" class="form-input" placeholder="e.g. ATS LATS Hardware SAT">
        </div>
        <div class="form-field">
          <label>Subsystem</label>
          <select id="ntpl-subsystem" class="form-input">
            <option>DCS</option><option>ATS</option><option>IXL</option>
            <option>CORE CBTC</option><option>PS&TP</option><option>IAMS</option>
            <option>SCADA</option><option>CYBER</option><option>TCH</option>
          </select>
        </div>
        <div class="form-field form-field-full">
          <label>Description</label>
          <textarea id="ntpl-desc" class="form-input" rows="2" placeholder="What does this activity cover?"></textarea>
        </div>
        <div class="form-field form-field-full">
          <label>Test Procedure <span style="font-weight:400;color:var(--gray-500);">(applies to all test cases in this template)</span></label>
          <textarea id="ntpl-procedure" class="form-input" rows="3" placeholder="e.g. Refer to CDRL 9.04.53 Section 4. Power on system, verify comms, run test sequence..."></textarea>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-weight:600;font-size:13px;">Test Cases</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="form-secondary" style="font-size:12px;padding:5px 10px;" onclick="downloadTemplateCaseCSV()">↓ CSV Template</button>
          <label style="cursor:pointer;">
            <input type="file" accept=".csv" onchange="handleTemplateCaseImport(this)" style="display:none">
            <div class="form-secondary" style="font-size:12px;padding:5px 10px;cursor:pointer;display:inline-block;">📂 Import CSV</div>
          </label>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:140px 1fr 130px 32px 32px;gap:6px;margin-bottom:6px;padding:0 2px;">
        <div style="font-size:11px;color:var(--gray-500);font-weight:600;">CODE</div>
        <div style="font-size:11px;color:var(--gray-500);font-weight:600;">TEST CASE NAME</div>
        <div style="font-size:11px;color:var(--gray-500);font-weight:600;">CATEGORY</div>
        <div></div><div></div>
      </div>
      <div id="tc-rows">${_tcRowsHTML()}</div>
      <button class="form-secondary" style="width:100%;margin-top:8px;font-size:13px;" onclick="addTemplateCase()">+ Add Test Case</button>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="saveNewTemplate()">Create Activity Template</button>
    `,
  });
}

async function saveNewTemplate() {
  const name      = document.getElementById('ntpl-name').value.trim();
  const subsystem = document.getElementById('ntpl-subsystem').value;
  const desc      = document.getElementById('ntpl-desc').value.trim();
  const procedure = document.getElementById('ntpl-procedure').value.trim();

  if (!name) { toast('Activity Name is required', 'error'); return; }

  const testCases = _templateCases
    .filter(tc => tc.code.trim() || tc.name.trim())
    .map(tc => ({ code: tc.code.trim(), name: tc.name.trim(), category: tc.category.trim(), procedure, duration: 1 }));

  if (!testCases.length) { toast('Add at least one test case', 'error'); return; }

  const newTpl = {
    id: 'tpl-' + Date.now(),
    name, subsystem, description: desc,
    createdBy: currentRoleUser.name,
    createdAt: new Date().toISOString(),
    testCases,
  };
  const { error } = await _sb.from('templates').insert({
    id: newTpl.id, name: newTpl.name, subsystem: newTpl.subsystem,
    description: newTpl.description, created_by: newTpl.createdBy,
    created_at: newTpl.createdAt, test_cases: newTpl.testCases,
  });
  if (error) { toast('Save failed: ' + error.message, 'error'); return; }
  TEMPLATES.push(newTpl);
  logAudit('Created Activity Template', name, `${testCases.length} test cases`);
  closeModal();
  toast(`Created activity: ${name}`, 'success');
  renderAdminPortal();
  renderAdminTemplates();
}

function editTemplate(id) {
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return;
  _templateCases = tpl.testCases.map(tc => ({ code: tc.code, name: tc.name, category: tc.category }));
  modal({
    title: 'Edit Activity Template',
    sub: tpl.name,
    size: 'large',
    body: `
      <div class="form-grid" style="margin-bottom:20px;">
        <div class="form-field form-field-full">
          <label>Activity Name</label>
          <input type="text" id="etpl-name" class="form-input" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="form-field">
          <label>Subsystem</label>
          <select id="etpl-subsystem" class="form-input">
            ${['DCS','ATS','IXL','CORE CBTC','PS&TP','IAMS','SCADA','CYBER','TCH'].map(s =>
              `<option${s === tpl.subsystem ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-field form-field-full">
          <label>Description</label>
          <textarea id="etpl-desc" class="form-input" rows="2">${escapeHtml(tpl.description || '')}</textarea>
        </div>
        <div class="form-field form-field-full">
          <label>Test Procedure <span style="font-weight:400;color:var(--gray-500);">(applies to all test cases)</span></label>
          <textarea id="etpl-procedure" class="form-input" rows="3">${escapeHtml(tpl.testCases[0]?.procedure || '')}</textarea>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-weight:600;font-size:13px;">Test Cases</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="form-secondary" style="font-size:12px;padding:5px 10px;" onclick="downloadTemplateCaseCSV()">↓ CSV Template</button>
          <label style="cursor:pointer;">
            <input type="file" accept=".csv" onchange="handleTemplateCaseImport(this)" style="display:none">
            <div class="form-secondary" style="font-size:12px;padding:5px 10px;cursor:pointer;display:inline-block;">📂 Import CSV</div>
          </label>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:140px 1fr 130px 32px 32px;gap:6px;margin-bottom:6px;padding:0 2px;">
        <div style="font-size:11px;color:var(--gray-500);font-weight:600;">CODE</div>
        <div style="font-size:11px;color:var(--gray-500);font-weight:600;">TEST CASE NAME</div>
        <div style="font-size:11px;color:var(--gray-500);font-weight:600;">CATEGORY</div>
        <div></div><div></div>
      </div>
      <div id="tc-rows">${_tcRowsHTML()}</div>
      <button class="form-secondary" style="width:100%;margin-top:8px;font-size:13px;" onclick="addTemplateCase()">+ Add Test Case</button>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="saveEditTemplate('${id}')">Save Changes</button>
    `,
  });
}

async function saveEditTemplate(id) {
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return;
  const name      = document.getElementById('etpl-name').value.trim();
  const subsystem = document.getElementById('etpl-subsystem').value;
  const desc      = document.getElementById('etpl-desc').value.trim();
  const procedure = document.getElementById('etpl-procedure').value.trim();
  if (!name) { toast('Activity Name is required', 'error'); return; }
  const testCases = _templateCases
    .filter(tc => tc.code.trim() || tc.name.trim())
    .map(tc => ({ code: tc.code.trim(), name: tc.name.trim(), category: tc.category.trim(), procedure, duration: 1 }));
  if (!testCases.length) { toast('Add at least one test case', 'error'); return; }
  const { error } = await _sb.from('templates').update({
    name, subsystem, description: desc, test_cases: testCases,
  }).eq('id', id);
  if (error) { toast('Save failed: ' + error.message, 'error'); return; }
  tpl.name = name; tpl.subsystem = subsystem; tpl.description = desc; tpl.testCases = testCases;
  logAudit('Edited Activity Template', name, `${testCases.length} test cases`);
  closeModal();
  toast(`Saved: ${name}`, 'success');
  renderAdminPortal();
  renderAdminTemplates();
}

async function deleteTemplate(id) {
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return;
  const deployCount = DEPLOYMENTS.filter(d => d.templateId === id).length;
  const warn = deployCount > 0 ? ` This template has ${deployCount} active deployment(s).` : '';
  if (!confirm(`Delete template "${tpl.name}"?${warn}\n\nThis cannot be undone.`)) return;
  const { error } = await _sb.from('templates').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return; }
  const idx = TEMPLATES.indexOf(tpl);
  TEMPLATES.splice(idx, 1);
  logAudit('Deleted Activity Template', tpl.name);
  toast(`Deleted: ${tpl.name}`, 'success');
  renderAdminPortal();
  renderAdminTemplates();
}

// ==========================================================================
// ADMIN FIELD CONFIG — Configurable dropdown options for Punch List
// ==========================================================================
const SUBSYSTEMS_LIST = ['DCS','ATS','IXL','CORE CBTC','PS&TP','IAMS','SCADA','CYBER','TCH'];

const FIELDCONFIG_DEFS = [
  { key: 'punch_type',          label: 'Punch Item Type' },
  { key: 'priority',            label: 'Priority' },
  { key: 'category_of_failure', label: 'Category of Failure' },
  { key: 'type_of_failure',     label: 'Type of Failure' },
  { key: 'schedule_impact',     label: 'Schedule Impact' },
  { key: 'punch_subsystem',     label: 'Subsystem' },
  { key: 'delay_category',      label: 'Delay Category' },
];

function _fsCfg(key) { return FIELDSET_CONFIG[key] || []; }

function _adminFieldConfigHTML() {
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Configurable Field Options</div>
          <p class="section-sub">Manage the dropdown options available in the Punch List form</p>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;">
        ${FIELDCONFIG_DEFS.map(def => `
          <div class="data-card" style="padding:20px;">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px;color:var(--gray-800);">${def.label}</div>
            <div id="fsc-list-${def.key}" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
              ${_fsCfg(def.key).map((opt,i) => `
                <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--gray-50);border-radius:6px;font-size:13px;">
                  <span style="flex:1;">${escapeHtml(opt)}</span>
                  <button class="form-secondary" style="padding:2px 8px;font-size:11px;color:var(--bad);"
                    onclick="fscRemoveOption('${def.key}',${i})">Remove</button>
                </div>`).join('') || '<div style="font-size:12px;color:var(--gray-400);">No options yet</div>'}
            </div>
            <div style="display:flex;gap:6px;">
              <input type="text" id="fsc-new-${def.key}" class="form-input" style="font-size:13px;"
                placeholder="Add new option…" onkeydown="if(event.key==='Enter')fscAddOption('${def.key}')">
              <button class="admin-action-btn" style="white-space:nowrap;" onclick="fscAddOption('${def.key}')">Add</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
  `;
}

async function fscAddOption(key) {
  const input = document.getElementById(`fsc-new-${key}`);
  const val = input?.value.trim();
  if (!val) return;
  const cur = [..._fsCfg(key)];
  if (cur.includes(val)) { toast('Option already exists', 'error'); return; }
  cur.push(val);
  await _fscSave(key, cur);
  input.value = '';
}

async function fscRemoveOption(key, idx) {
  const cur = [..._fsCfg(key)];
  cur.splice(idx, 1);
  await _fscSave(key, cur);
}

async function _fscSave(key, options) {
  const def = FIELDCONFIG_DEFS.find(d => d.key === key);
  const { error } = await _sb.from('fieldset_config')
    .upsert({ field_key: key, label: def?.label || key, options, updated_at: new Date().toISOString() }, { onConflict: 'field_key' });
  if (error) { toast('Save failed: ' + error.message, 'error'); return; }
  FIELDSET_CONFIG[key] = options;
  toast('Saved', 'success');
  renderAdminTabBody();
}

// ==========================================================================
// ADMIN DIRECTORY — User management
// ==========================================================================

function _adminDirectoryHTML() {
  return `
    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">User Directory</div>
          <p class="section-sub">Manage portal access, roles, and subsystem visibility</p>
        </div>
        <button class="admin-action-btn" onclick="openInviteUserModal()">+ Invite User</button>
      </div>
      <div class="data-card" id="dir-table-wrap" style="padding:0;">
        <div style="padding:24px;text-align:center;color:var(--gray-400);font-size:13px;">Loading users…</div>
      </div>
    </div>
  `;
}

async function _loadDirectoryUsers() {
  const wrap = document.getElementById('dir-table-wrap');
  if (!wrap) return;
  try {
    const { data, error } = await _sb.from('profiles').select('*').order('created_at');
    if (error) throw error;
    if (!data || !data.length) {
      wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--gray-400);font-size:13px;">No users yet — click + Invite User to add one.</div>`;
      return;
    }
  const roleLabel = { admin:'Administrator', field_engineer:'Field Engineer', readonly:'Read Only', client:'Client' };
  wrap.innerHTML = `
    <table class="dir-table">
      <thead>
        <tr>
          <th style="width:40px;"></th>
          <th>Name</th>
          <th>Email</th>
          <th>Role</th>
          <th>Subsystem</th>
          <th>Status</th>
          <th style="width:80px;"></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(u => {
          const name = u.full_name || u.email || '?';
          const initials = name.split(' ').filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase() || '?';
          return `<tr>
            <td><div class="user-avatar-sm">${escapeHtml(initials)}</div></td>
            <td style="font-weight:500;">${escapeHtml(name)}</td>
            <td style="color:var(--gray-600);font-size:12px;">${escapeHtml(u.email||'')}</td>
            <td>
              <select class="form-input" style="font-size:12px;padding:4px 8px;min-width:140px;"
                onchange="updateProfileRole('${u.id}',this.value)">
                <option value="readonly"      ${u.role==='readonly'      ?'selected':''}>Read Only</option>
                <option value="field_engineer" ${u.role==='field_engineer'?'selected':''}>Field Engineer</option>
                <option value="admin"          ${u.role==='admin'         ?'selected':''}>Administrator</option>
                <option value="client"         ${u.role==='client'        ?'selected':''}>Client</option>
              </select>
            </td>
            <td>
              <select class="form-input" style="font-size:12px;padding:4px 8px;min-width:130px;"
                onchange="updateProfileSubsystem('${u.id}',this.value)">
                <option value="" ${!u.subsystem?'selected':''}>All subsystems</option>
                ${SUBSYSTEMS_LIST.map(s=>`<option value="${s}" ${u.subsystem===s?'selected':''}>${s}</option>`).join('')}
              </select>
            </td>
            <td>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;">
                <input type="checkbox" ${u.is_active?'checked':''} onchange="updateProfileActive('${u.id}',this.checked)">
                <span style="color:${u.is_active?'var(--good)':'var(--gray-500)'};">${u.is_active?'Active':'Inactive'}</span>
              </label>
            </td>
            <td>
              <button class="form-secondary" style="font-size:11px;padding:3px 8px;color:var(--red-600);"
                onclick="deleteUserConfirm('${u.id}','${escapeHtml(u.full_name).replace(/'/g,'')}')">Remove</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  } catch (err) {
    console.error('_loadDirectoryUsers error:', err);
    wrap.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px;">Error loading users: ${escapeHtml(err.message)}</div>`;
  }
}

async function updateProfileRole(id, role) {
  const { error } = await _sb.from('profiles').update({ role }).eq('id', id);
  if (error) toast('Update failed: ' + error.message, 'error');
  else toast('Role updated', 'success');
}

async function updateProfileSubsystem(id, subsystem) {
  const { error } = await _sb.from('profiles').update({ subsystem: subsystem || null }).eq('id', id);
  if (error) toast('Update failed: ' + error.message, 'error');
  else toast('Subsystem updated', 'success');
}

async function updateProfileActive(id, is_active) {
  const { error } = await _sb.from('profiles').update({ is_active }).eq('id', id);
  if (error) toast('Update failed: ' + error.message, 'error');
  else toast(is_active ? 'User activated' : 'User deactivated', 'success');
}

async function deleteUserConfirm(id, name) {
  if (!confirm(`Remove "${name}" from the portal?\n\nThis removes their profile and access. Their Supabase auth account is preserved.`)) return;
  const { error } = await _sb.from('profiles').delete().eq('id', id);
  if (error) { toast('Remove failed: ' + error.message, 'error'); return; }
  toast(`Removed ${name}`, 'success');
  _loadDirectoryUsers();
}

function openInviteUserModal() {
  modal({
    title: 'Invite User',
    sub: 'Create a new portal account',
    size: 'medium',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full">
          <label>Full Name</label>
          <input type="text" id="inv-name" class="form-input" placeholder="Jane Smith">
        </div>
        <div class="form-field form-field-full">
          <label>Email</label>
          <input type="email" id="inv-email" class="form-input" placeholder="jane@example.com">
        </div>
        <div class="form-field form-field-full">
          <label>Temporary Password <span style="font-weight:400;color:var(--gray-500);">(share this securely — user can change later)</span></label>
          <input type="text" id="inv-password" class="form-input" placeholder="At least 6 characters">
        </div>
        <div class="form-field">
          <label>Role</label>
          <select id="inv-role" class="form-input">
            <option value="readonly">Read Only — Dashboards only</option>
            <option value="field_engineer">Field Engineer — Field intake + Test Matrix</option>
            <option value="admin">Administrator — Full access</option>
            <option value="client">Client — Dashboard + Punch List view</option>
          </select>
        </div>
        <div class="form-field">
          <label>Subsystem <span style="font-weight:400;color:var(--gray-500);">(optional — blank = all)</span></label>
          <select id="inv-subsystem" class="form-input">
            <option value="">All subsystems</option>
            ${SUBSYSTEMS_LIST.map(s=>`<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <p style="font-size:12px;color:var(--gray-500);margin-top:14px;line-height:1.5;">
        The user will receive a confirmation email from Supabase. Once confirmed, they log in with the temporary password above.
        If email confirmation is disabled in Supabase Auth settings, they can log in immediately.
      </p>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="inviteUser()">Create Account</button>
    `,
  });
}

async function inviteUser() {
  const name      = document.getElementById('inv-name').value.trim();
  const email     = document.getElementById('inv-email').value.trim();
  const password  = document.getElementById('inv-password').value;
  const role      = document.getElementById('inv-role').value;
  const subsystem = document.getElementById('inv-subsystem').value;

  if (!name || !email || !password) { toast('Name, email, and password are all required', 'error'); return; }
  if (password.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }

  const { data, error } = await _sb.auth.signUp({
    email, password,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      data: { full_name: name },
    },
  });
  if (error) { toast('Account creation failed: ' + error.message, 'error'); return; }
  if (!data.user) { toast('Unexpected error — no user returned', 'error'); return; }

  const { error: profErr } = await _sb.from('profiles').insert({
    id: data.user.id, email, full_name: name,
    role, subsystem: subsystem || null, is_active: true,
  });
  if (profErr) { toast('Profile save failed: ' + profErr.message, 'error'); return; }

  closeModal();
  toast(`Account created for ${name}. Share the temp password securely.`, 'success');
  _loadDirectoryUsers();
}

// ==========================================================================
// TEST MATRIX VIEW — Live status toggle scratchpad
// ==========================================================================
let matrixFilter = { phase: '', location: '', subsystem: '', activity: '', applicable: 'all' };

function renderTestMatrix() {
  const root = document.getElementById('test-matrix-content');
  if (!root || !currentRoleUser) return;

  const isAdmin  = currentRoleUser.role === 'admin';

  // Cascaded option pools from TI
  const subsystems = [...new Set(TI.map(r => r.Subsystem).filter(Boolean))].sort();
  const phasePool  = [...new Set(TI.filter(r => !matrixFilter.subsystem || r.Subsystem === matrixFilter.subsystem).map(r => r.Phase).filter(Boolean))].sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
  const locPool    = [...new Set(TI.filter(r =>
    (!matrixFilter.subsystem || r.Subsystem === matrixFilter.subsystem) &&
    (!matrixFilter.phase || r.Phase === matrixFilter.phase)
  ).map(r => r.Location).filter(Boolean))].sort();
  const actPool    = [...new Set(TI.filter(r =>
    (!matrixFilter.subsystem || r.Subsystem === matrixFilter.subsystem) &&
    (!matrixFilter.phase || r.Phase === matrixFilter.phase) &&
    (!matrixFilter.location || r.Location === matrixFilter.location)
  ).map(r => r.Activity).filter(Boolean))].sort();

  // Apply all filters
  let filtered = TI.filter(r =>
    (!matrixFilter.subsystem || r.Subsystem === matrixFilter.subsystem) &&
    (!matrixFilter.phase     || r.Phase === matrixFilter.phase) &&
    (!matrixFilter.location  || r.Location === matrixFilter.location) &&
    (!matrixFilter.activity  || r.Activity === matrixFilter.activity) &&
    (matrixFilter.applicable === 'all' ||
     (matrixFilter.applicable === 'yes' && r.Status && r.Status !== 'Not Started') ||
     (matrixFilter.applicable === 'no'  && (!r.Status || r.Status === 'Not Started')))
  );

  // 'Complete'/'Passed'/'Future' are legacy DB values — treat them with current names
  const isPass = s => s === 'Pass' || s === 'Complete' || s === 'Passed';
  const isFail = s => s === 'Fail' || s === 'Failed';
  const isNotStarted = s => !s || s === 'Not Started' || s === 'Future';
  const complete    = filtered.filter(r => isPass(r.Status)).length;
  const failed      = filtered.filter(r => isFail(r.Status)).length;
  const inprog      = filtered.filter(r => r.Status === 'In Progress').length;
  const blocked     = filtered.filter(r => r.Status === 'Blocked').length;
  const futureTest  = filtered.filter(r => r.Status === 'Future Test').length;
  const notStarted  = filtered.filter(r => isNotStarted(r.Status)).length;

  // Group by Phase + Location + Subsystem + Activity
  const groups = {};
  filtered.forEach(r => {
    const key = `${r.Phase||''}||${r.Location||''}||${r.Subsystem||''}||${r.Activity||''}`;
    if (!groups[key]) groups[key] = { phase: r.Phase||'—', location: r.Location||'—', subsystem: r.Subsystem||'—', activity: r.Activity||'—', testReport: r.TestReport||'', items: [] };
    groups[key].items.push(r);
  });

  const hasFilter = matrixFilter.phase || matrixFilter.location || matrixFilter.subsystem || matrixFilter.activity;

  root.innerHTML = `
    <div class="matrix-summary">
      <div class="matrix-stat"><div class="matrix-stat-label">Pass</div><div class="matrix-stat-value good" id="mx-stat-pass">${complete}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Fail</div><div class="matrix-stat-value bad" id="mx-stat-fail">${failed}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">In Progress</div><div class="matrix-stat-value info" id="mx-stat-inprog">${inprog}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Blocked</div><div class="matrix-stat-value warn" id="mx-stat-blocked">${blocked}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Not Started</div><div class="matrix-stat-value" id="mx-stat-notstarted">${notStarted}</div></div>
      ${futureTest ? `<div class="matrix-stat"><div class="matrix-stat-label">Future Test</div><div class="matrix-stat-value" style="color:#5b21b6;" id="mx-stat-futuretest">${futureTest}</div></div>` : ''}
      <div class="matrix-stat"><div class="matrix-stat-label">Total</div><div class="matrix-stat-value">${filtered.length}</div></div>
    </div>

    <div class="matrix-filter-bar">
      ${isAdmin ? `<select class="filter-select" onchange="_mxSetFilter('subsystem',this.value)">
        <option value="">All Subsystems</option>
        ${subsystems.map(s=>`<option value="${escapeHtml(s)}" ${matrixFilter.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
      </select>` : ''}
      <select class="filter-select" onchange="_mxPhaseChange(this.value)">
        <option value="">All Phases</option>
        ${phasePool.map(p=>`<option value="${escapeHtml(p)}" ${matrixFilter.phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="_mxLocChange(this.value)">
        <option value="">All Locations</option>
        ${locPool.map(l=>`<option value="${escapeHtml(l)}" ${matrixFilter.location===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="_mxSetFilter('activity',this.value)">
        <option value="">All Activities</option>
        ${actPool.map(a=>`<option value="${escapeHtml(a)}" ${matrixFilter.activity===a?'selected':''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="_mxSetFilter('applicable',this.value)">
        <option value="all" ${matrixFilter.applicable==='all'?'selected':''}>All test cases</option>
        <option value="yes" ${matrixFilter.applicable==='yes'?'selected':''}>With status only</option>
        <option value="no"  ${matrixFilter.applicable==='no'?'selected':''}>Not started only</option>
      </select>
      ${hasFilter ? `<button class="filter-clear" onclick="_mxClearFilters()">Reset</button>` : ''}
    </div>

    ${(() => {
      // Store groups globally so onclick handlers can access by index — avoids all JSON/quote escaping issues
      window._mxGroups = Object.values(groups);
      if (!window._mxGroups.length) return `<div class="docs-empty"><h3>No test cases match your filters</h3><p>Try clearing filters or selecting a different location.</p></div>`;
      return window._mxGroups.map((g, idx) => {
        const done = g.items.filter(r => isPass(r.Status)).length;
        return `
        <div class="matrix-section" data-mx-group="${idx}">
          <div class="matrix-section-head">
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <div class="matrix-section-title">${escapeHtml(g.activity)}</div>
                ${g.testReport ? `<span style="font-size:12px;color:var(--gray-600);font-weight:500;">📄 Test Report CDRL: ${escapeHtml(g.testReport)}</span>` : ''}
              </div>
              <div class="matrix-section-meta">${escapeHtml(g.phase)} · ${escapeHtml(g.location)} · ${escapeHtml(g.subsystem)}</div>
            </div>
            <div class="matrix-section-meta" id="mx-grp-count-${idx}">${done} / ${g.items.length} passed</div>
          </div>
          ${(() => {
            // Sub-group items by TestProcedure
            const tpMap = {};
            g.items.forEach(r => {
              const tp = r.TestProcedure || '(No Procedure)';
              if (!tpMap[tp]) tpMap[tp] = [];
              tpMap[tp].push(r);
            });
            return Object.entries(tpMap).map(([tp, tpItems]) => `
              <div class="matrix-tp-section">
                <div class="matrix-tp-header">${escapeHtml(tp)}</div>
                ${tpItems.map(r => _renderTIMatrixRow(r, isAdmin)).join('')}
              </div>
            `).join('');
          })()}
        </div>`;
      }).join('');
    })()}
  `;
}

let _sessionLog = []; // tracks status changes made this session for Daily Log step 1

function _renderTIMatrixRow(r, isAdmin) {
  // 'Future' is the DB default — treat as Not Started in the UI
  const legacyMap = { 'Future':'Not Started', 'Passed':'Pass', 'Failed':'Fail', 'Complete':'Pass' };
  const current   = legacyMap[r.Status] || r.Status || 'Not Started';
  const statuses  = ['Not Started','In Progress','Pass','Fail','Blocked','Not Applicable','Future Test'];
  const showReason = current === 'Fail' || current === 'Blocked';
  const reasonVal  = current === 'Fail' ? (r.FailedReason||'') : (r.BlockedReason||'');
  const tid = escapeHtml(String(r.TestID));
  const domId = encodeURIComponent(String(r.TestID));
  const notesVal = r.Notes || '';
  return `
    <div class="matrix-tc-row" style="flex-wrap:wrap;">
      <div class="matrix-tc-code">${escapeHtml(r.TestCaseCode||'—')}</div>
      <div style="flex:1;min-width:0;">
        <div class="matrix-tc-name">${escapeHtml(r.TestName||'—')}</div>
        ${r.CompletedBy ? `<div class="matrix-tc-meta">Completed by <b>${escapeHtml(r.CompletedBy)}</b></div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;min-width:200px;">
        <select class="form-input mx-status-select" onchange="_mxStatusChange('${tid}',this.value,this)">
          ${statuses.map(s=>`<option value="${s}" ${current===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <div id="mx-reason-${domId}" class="mx-reason-wrap" style="${showReason?'':'display:none;'}">
          <input type="text" id="mx-ri-${domId}" class="form-input mx-reason-input" style="font-size:12px;padding:5px 8px;"
            placeholder="${current==='Fail'?'Failure reason...':'Blocked reason...'}"
            value="${escapeHtml(reasonVal)}"
            oninput="_mxSaveReason('${tid}',this.value)">
        </div>
      </div>
      <div style="width:100%;padding:4px 0 0 0;">
        <input type="text" class="form-input" style="font-size:11px;padding:4px 8px;color:var(--gray-600);"
          placeholder="Notes…"
          value="${escapeHtml(notesVal)}"
          onblur="_mxSaveNotes('${tid}',this.value)">
      </div>
    </div>
  `;
}

function _mxPhaseChange(v) { matrixFilter.phase=v; matrixFilter.location=''; matrixFilter.activity=''; renderTestMatrix(); }
function _mxLocChange(v)   { matrixFilter.location=v; matrixFilter.activity=''; renderTestMatrix(); }
function _mxSetFilter(k,v) { matrixFilter[k]=v; renderTestMatrix(); }
function _mxClearFilters() {
  const sub = currentRoleUser?.role!=='admin' ? (currentRoleUser?.subsystem||'') : '';
  matrixFilter = { phase:'', location:'', subsystem:sub, activity:'', applicable:'all' };
  renderTestMatrix();
}

function _mxStatusChange(testId, status, el = null) {
  const r = TI.find(t => String(t.TestID) === String(testId));
  if (!r) return;
  _mxApplyStatusChange(testId, status, status === 'Fail' ? r.FailedReason : status === 'Blocked' ? r.BlockedReason : '', el);
}

async function _logTestItemStatusHistory(r, oldStatus, newStatus, opts = {}) {
  if (!r || oldStatus === newStatus) return;
  try {
    await _dbInsert('test_item_status_history', [{
      test_id:        r.TestID,
      test_case_code: r.TestCaseCode || null,
      test_name:      r.TestName || null,
      phase:          r.Phase || null,
      location:       r.Location || null,
      subsystem:      r.Subsystem || null,
      activity:       r.Activity || null,
      old_status:     oldStatus || null,
      new_status:     newStatus || null,
      changed_by:     opts.changedBy || currentRoleUser?.name || currentProfile?.full_name || null,
      changed_role:   currentRoleUser?.role || currentProfile?.role || null,
      source:         opts.source || null,
      reason:         opts.reason || null,
      notes:          opts.notes || null,
    }]);
  } catch (err) {
    console.warn('[statusHistory] insert skipped:', err.message);
  }
}

async function _updateTestItemStatus(testId, status, opts = {}) {
  const r = opts.row || TI.find(t => String(t.TestID) === String(testId));
  if (!r) return null;
  const reason = opts.reason || '';
  const oldStatus = r.Status || null;
  const patch = { status };
  if (status === 'Pass') {
    patch.completed_by = opts.completedBy || currentRoleUser?.name || currentProfile?.full_name || null;
    patch.completed_date = opts.completedDate || new Date().toISOString();
  } else if (status !== 'Not Applicable') {
    patch.completed_by = null;
    patch.completed_date = null;
  }
  patch.failed_reason = status === 'Fail' ? reason : null;
  patch.blocked_reason = status === 'Blocked' ? reason : null;
  if (Object.prototype.hasOwnProperty.call(opts, 'notes')) patch.notes = opts.notes || null;

  r.Status = status;
  r.FailedReason = patch.failed_reason;
  r.BlockedReason = patch.blocked_reason;
  if (Object.prototype.hasOwnProperty.call(patch, 'completed_by')) r.CompletedBy = patch.completed_by;
  if (Object.prototype.hasOwnProperty.call(patch, 'completed_date')) r.CompletedDate = patch.completed_date;
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) r.Notes = patch.notes;

  const rows = await _dbUpdate('test_items', patch, { test_id: r.TestID });
  if (!rows || rows.length === 0) throw new Error(`No test_items row matched test_id "${r.TestID}"`);
  await _logTestItemStatusHistory(r, oldStatus, status, opts);
  return rows;
}

function _mxApplyStatusChange(testId, status, reason = '', el = null) {
  const r = TI.find(t => String(t.TestID) === String(testId));
  if (!r) return;

  const rawId = r.TestID;
  const existing = _sessionLog.find(e => String(e.testId) === String(rawId));
  if (existing) {
    existing.newStatus     = status;
    existing.changedAt     = new Date().toISOString();
    existing.failedReason  = status === 'Fail'    ? reason : '';
    existing.blockedReason = status === 'Blocked' ? reason : '';
  } else {
    _sessionLog.push({
      testId: rawId, testCode: r.TestCaseCode, testName: r.TestName,
      phase: r.Phase, location: r.Location, subsystem: r.Subsystem, activity: r.Activity,
      prevStatus: r.Status || 'Not Started', newStatus: status,
      changedAt: new Date().toISOString(),
      failedReason:  status === 'Fail'    ? reason : '',
      blockedReason: status === 'Blocked' ? reason : '',
      hours: 0
    });
  }

  r.Status = status;
  r.FailedReason = status === 'Fail' ? reason : null;
  r.BlockedReason = status === 'Blocked' ? reason : null;
  if (status === 'Pass') {
    r.CompletedBy = currentRoleUser?.name || null;
    r.CompletedDate = new Date().toISOString();
  } else if (status !== 'Not Applicable') {
    r.CompletedBy = null;
    r.CompletedDate = null;
  }

  const rowEl = el?.closest?.('.matrix-tc-row');
  const domId = encodeURIComponent(String(testId));
  const reasonEl = rowEl?.querySelector?.('.mx-reason-wrap') || document.getElementById(`mx-reason-${domId}`);
  const reasonInput = rowEl?.querySelector?.('.mx-reason-input') || document.getElementById(`mx-ri-${domId}`);
  if (reasonEl) {
    const needReason = status === 'Fail' || status === 'Blocked';
    reasonEl.style.display = needReason ? '' : 'none';
    if (reasonInput) {
      reasonInput.placeholder = status === 'Fail' ? 'Failure reason...' : 'Blocked reason...';
      reasonInput.value = reason || '';
      if (needReason) setTimeout(() => reasonInput.focus(), 0);
    }
  }

  _mxRefreshCounts();
  _mxSaveStatus(status, r, reason);
}

// Recompute the matrix summary tiles + per-activity tallies from current TI state
function _mxRefreshCounts() {
  const isPass = s => s === 'Pass' || s === 'Complete' || s === 'Passed';
  const isFail = s => s === 'Fail' || s === 'Failed';
  const isNotStarted = s => !s || s === 'Not Started' || s === 'Future';

  // Determine which rows are currently in the visible filter
  const filtered = TI.filter(r =>
    (!matrixFilter.subsystem || r.Subsystem === matrixFilter.subsystem) &&
    (!matrixFilter.phase     || r.Phase === matrixFilter.phase) &&
    (!matrixFilter.location  || r.Location === matrixFilter.location) &&
    (!matrixFilter.activity  || r.Activity === matrixFilter.activity)
  );

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('mx-stat-pass',       filtered.filter(r => isPass(r.Status)).length);
  set('mx-stat-fail',       filtered.filter(r => isFail(r.Status)).length);
  set('mx-stat-inprog',     filtered.filter(r => r.Status === 'In Progress').length);
  set('mx-stat-blocked',    filtered.filter(r => r.Status === 'Blocked').length);
  set('mx-stat-notstarted', filtered.filter(r => isNotStarted(r.Status)).length);
  set('mx-stat-futuretest', filtered.filter(r => r.Status === 'Future Test').length);

  // Update each per-activity tally
  (window._mxGroups || []).forEach((g, idx) => {
    const done = g.items.filter(r => isPass(r.Status)).length;
    set(`mx-grp-count-${idx}`, `${done} / ${g.items.length} passed`);
  });
}

async function _mxSaveStatus(status, r, reason = '') {
  // Uses _dbUpdate (native fetch) instead of the supabase-js client.
  // Reason: supabase-js caches its JWT internally and does not reliably
  // re-read it after a browser tab resumes — causing silent write failures
  // after tab switches. _dbUpdate calls _getAuthHeader() which reads the JWT
  // directly from localStorage on every invocation, guaranteeing a valid token.
  _mxSavePending = true;
  console.log(`[mxSaveStatus] → test_items test_id="${r.TestID}" status="${status}"`);
  try {
    const rows = await _updateTestItemStatus(r.TestID, status, { row: r, reason, source: 'Test Matrix' });
    console.log(`[mxSaveStatus] ✓ updated ${rows.length} row(s)`);
    toast(`${r.TestCaseCode} → ${status}`, 'success');
    logAudit('Test Status Update', `${r.TestCaseCode} @ ${r.Location}`, `→ ${status}`);
  } catch(e) {
    console.error('[mxSaveStatus] ✗ failed:', e.message);
    toast('Save failed: ' + (e.message || 'unknown error'), 'error');
  } finally {
    _mxSavePending = false;
  }
}

function _mxSaveReason(testId, reason) {
  const r = TI.find(t => String(t.TestID) === String(testId));
  if (!r) return;
  const isFail = r.Status === 'Fail';
  const isBlocked = r.Status === 'Blocked';
  if (!isFail && !isBlocked) return;
  if (isFail) r.FailedReason = reason; else r.BlockedReason = reason;
  const logEntry = _sessionLog.find(e => String(e.testId) === String(r.TestID));
  if (logEntry) { if (isFail) logEntry.failedReason = reason; else logEntry.blockedReason = reason; }
  const patch = isFail ? { failed_reason: reason } : { blocked_reason: reason };
  // Use _dbUpdate (native fetch) for the same reason as _mxSaveStatus:
  // supabase-js JWT caching causes silent failures after tab switches.
  _dbUpdate('test_items', patch, { test_id: r.TestID }).catch(err => {
    console.error('[mxSaveReason] failed:', err.message);
    toast('Reason save failed: ' + err.message, 'error');
  });
}

function _mxSaveNotes(testId, notes) {
  const r = TI.find(t => String(t.TestID) === String(testId));
  if (!r) return;
  r.Notes = notes || null;
  _dbUpdate('test_items', { notes: notes || null }, { test_id: r.TestID }).catch(err => {
    console.error('[mxSaveNotes] failed:', err.message);
    toast('Notes save failed: ' + err.message, 'error');
  });
}

// Legacy wrappers
function setTestStatusTI(testId, status) { _mxStatusChange(testId, status); }
function setTestStatus(id, status) { _mxStatusChange(id, status); }

let _pendingActivityEdit = null;

function openEditActivityModal(idx) {
  const data = (window._mxGroups || [])[idx];
  if (!data) { toast('Could not load activity data', 'error'); return; }
  _pendingActivityEdit = data;
  const selectedReport = _trpFindRecordForActivity(data);
  const customReport = selectedReport ? '' : (data.testReport || '');
  modal({
    title: 'Edit Activity',
    size: 'medium',
    body: `
      <div class="form-field">
        <label>Activity Name</label>
        <input type="text" id="ea-name" class="form-input" value="${escapeHtml(data.activity||'')}">
      </div>
      <div class="form-field" style="margin-top:12px;">
        <label>Test Report</label>
        ${_trpReportSelectHTML(selectedReport?.id || '', customReport)}
      </div>
      <p style="font-size:12px;color:var(--gray-500);margin-top:12px;">Changes apply to all test cases under this activity: <b>${escapeHtml(data.phase)} · ${escapeHtml(data.location)} · ${escapeHtml(data.subsystem)}</b></p>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="admin-action-btn" onclick="saveActivityEdit()">Save Changes</button>
    `
  });
}

async function saveActivityEdit() {
  const data = _pendingActivityEdit;
  if (!data) { toast('No activity selected','error'); return; }

  const name   = document.getElementById('ea-name').value.trim();
  const beforeLink = _trpCurrentActivityReportLink(data);
  let afterLink = _trpReportLinkFromModal();
  if (!name) { toast('Activity name required','error'); return; }

  const rows = TI.filter(r => r.Activity===data.activity && r.Location===data.location && r.Phase===data.phase && r.Subsystem===data.subsystem);
  if (!rows.length) { toast('No matching test cases found','error'); return; }

  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    afterLink = await _trpResolveReportLink(afterLink, { phase: data.phase, location: data.location, subsystem: data.subsystem, activity: name });
    const patch = { activity: name, ..._trpReportLinkPatch(afterLink) };
    await Promise.all(rows.map(r => _dbUpdate('test_items', patch, { test_id: r.TestID })));
    rows.forEach(r => { r.Activity = name; });
    _trpApplyReportLinkToItems(rows, afterLink);
    const reportDetails = _trpReportLinkAuditDetails(beforeLink, afterLink, rows.length);
    logAudit('Activity Edited', name, [reportDetails, `Phase: ${data.phase} · Location: ${data.location}`].filter(Boolean).join(' · '));
    _trpLogActivityReportLinkChange(name, beforeLink, afterLink, rows.length, `Phase: ${data.phase} · Location: ${data.location}`);
    toast(`Updated ${rows.length} test cases`, 'success');
    _pendingActivityEdit = null;
    closeModal();
    renderTestRegister();
    initLineItems();
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

// ==========================================================================
// FIELD INTAKE — 3 step workflow
// ==========================================================================
let intakeStep = 1;
let intakeAdditions = [];
let _s2Phase = '', _s2Loc = '', _s2Act = '';

function _updateSessionHours(idx, val) {
  if (_sessionLog[idx]) _sessionLog[idx].hours = parseFloat(val) || 0;
}

function _s2SetPhase(v) { _s2Phase=v; _s2Loc=''; _s2Act=''; renderFieldIntake(); }
function _s2SetLoc(v)   { _s2Loc=v; _s2Act=''; renderFieldIntake(); }
function _s2SetAct(v)   { _s2Act=v; renderFieldIntake(); }

function ai_toggleReasonFields() {
  const s = document.getElementById('ai-status')?.value;
  // Fail → show failed block; Blocked → show blocked block
  document.getElementById('ai-failed-block').style.display = s==='Fail'  ? '' : 'none';
  document.getElementById('ai-blocked-block').style.display = s==='Blocked' ? '' : 'none';
}

function renderFieldIntake() {
  const root = document.getElementById('field-intake-content');
  if (!root || !currentRoleUser) return;
  if (!['field_engineer', 'admin'].includes(currentRoleUser.role)) {
    root.innerHTML = `<div class="docs-empty"><h3>Field & Admin only</h3></div>`;
    return;
  }

  const allItems = [..._sessionLog.map(e => ({...e, _fromLog:true})), ...intakeAdditions];

  root.innerHTML = `
    <div class="intake-stepper">
      <div class="intake-step ${intakeStep >= 1 ? 'active' : ''} ${intakeStep > 1 ? 'completed' : ''}">
        <span class="intake-step-num">1</span>Review Today's Tests
      </div>
      <div class="intake-step ${intakeStep === 2 ? 'active' : intakeStep > 2 ? 'completed' : ''}">
        <span class="intake-step-num">2</span>Add Missing Items
      </div>
      <div class="intake-step ${intakeStep === 3 ? 'active' : ''}">
        <span class="intake-step-num">3</span>Submit Daily Log
      </div>
    </div>
    ${intakeStep === 1 ? renderIntakeStep1() :
      intakeStep === 2 ? renderIntakeStep2() :
      renderIntakeStep3(allItems)}
  `;
}

function renderIntakeStep1() {
  const log = _sessionLog;
  if (!log.length && !intakeAdditions.length) {
    return `
      <div class="form-card">
        <h3 class="form-card-title">Step 1: Review Today's Tests</h3>
        <p class="form-card-sub">No status changes recorded yet this session. Update statuses in the Test Matrix to see them here.</p>
        <div class="intake-summary-empty">
          <h3 style="font-size:16px;margin-bottom:8px;">No tests logged yet</h3>
          <p style="font-size:13px;">Open the Test Register, update test case statuses as you work, then return here to complete the Daily Log.</p>
        </div>
        <div class="form-actions">
          <button class="form-secondary" onclick="showPage('test-register')">Open Test Register</button>
          <button class="form-submit" onclick="setIntakeStep(2)">Skip to Step 2 →</button>
        </div>
      </div>
    `;
  }

  const allEntries = [
    ...log.map((e,i) => ({...e, _idx:i, _fromLog:true})),
    ...intakeAdditions.map((a,i) => ({...a, _idx:i, _fromAdditions:true}))
  ];
  const statusColor = s => ({'Pass':'#059669','In Progress':'#1d4ed8','Fail':'#dc2626','Blocked':'#d97706','Not Started':'#6b7280','Not Applicable':'#9ca3af','Future Test':'#5b21b6'}[s]||'#6b7280');

  return `
    <div class="form-card">
      <h3 class="form-card-title">Step 1: Review Today's Tests</h3>
      <p class="form-card-sub">${allEntries.length} test case${allEntries.length!==1?'s':''} recorded this session. Add hours spent and verify transitions.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
        ${allEntries.map(e => {
          const isFailed  = e.newStatus==='Failed'  || e.status==='Failed';
          const isBlocked = e.newStatus==='Blocked' || e.status==='Blocked';
          const ns = e._fromLog ? e.newStatus : e.status;
          const ps = e._fromLog ? e.prevStatus : null;
          const reason = (ns === 'Fail' ? e.failedReason : ns === 'Blocked' ? e.blockedReason : '') || '';
          return `
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;display:flex;gap:16px;align-items:center;">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:13px;margin-bottom:3px;">${escapeHtml(e.testCode)} · ${escapeHtml(e.testName)}</div>
                <div style="font-size:11px;color:var(--gray-500);margin-bottom:5px;">${escapeHtml(e.phase||'—')} · ${escapeHtml(e.location||'—')} · ${escapeHtml(e.activity||'—')}</div>
                <div style="font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  ${ps ? `<span style="background:#e5e7eb;color:#374151;padding:2px 8px;border-radius:10px;">${escapeHtml(ps)}</span><span style="color:var(--gray-400);">→</span>` : ''}
                  <span style="background:${statusColor(ns)}20;color:${statusColor(ns)};padding:2px 8px;border-radius:10px;font-weight:600;">${escapeHtml(ns)}</span>
                  ${reason ? `<span style="font-size:11px;color:#dc2626;">✗ ${escapeHtml(reason)}</span>` : ''}
                </div>
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;width:110px;">
                <label style="font-size:11px;color:var(--gray-500);white-space:nowrap;">Hours Spent</label>
                <input type="number" min="0" step="0.25" class="form-input"
                  style="width:100%;text-align:center;"
                  value="${e.hours||0}"
                  ${e._fromLog ? `onchange="_updateSessionHours(${e._idx},this.value)"` : `onchange="_updateAdditionHours(${e._idx},this.value)"`}>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="form-actions">
        <button class="form-secondary" onclick="showPage('test-register')">↺ Back to Test Register</button>
        <button class="form-submit" onclick="setIntakeStep(2)">Continue to Step 2 →</button>
      </div>
    </div>
  `;
}

function renderIntakeStep2() {
  const phases = [...new Set(TI.map(r=>r.Phase).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const locs   = [...new Set(TI.filter(r=>!_s2Phase||r.Phase===_s2Phase).map(r=>r.Location).filter(Boolean))].sort();
  const acts   = [...new Set(TI.filter(r=>(!_s2Phase||r.Phase===_s2Phase)&&(!_s2Loc||r.Location===_s2Loc)).map(r=>r.Activity).filter(Boolean))].sort();
  const tests  = TI.filter(r=>(!_s2Phase||r.Phase===_s2Phase)&&(!_s2Loc||r.Location===_s2Loc)&&(!_s2Act||r.Activity===_s2Act));

  return `
    <div class="form-card">
      <h3 class="form-card-title">Step 2: Add Missing Items</h3>
      <p class="form-card-sub">Add test cases completed today that weren't updated via the Test Matrix.</p>
      <div style="margin-bottom:16px;">
        ${intakeAdditions.length === 0 ?
          '<div style="font-size:13px;color:var(--gray-400);padding:8px 0;">No manually-added items yet</div>' :
          intakeAdditions.map((a,i) => `
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;display:flex;gap:12px;align-items:center;margin-bottom:6px;">
              <div style="flex:1;">
                <div style="font-weight:600;font-size:13px;">${escapeHtml(a.testCode||'—')} · ${escapeHtml(a.testName||'—')}</div>
                <div style="font-size:11px;color:var(--gray-500);">${escapeHtml(a.phase||'—')} · ${escapeHtml(a.location||'—')} · ${escapeHtml(a.activity||'—')}</div>
                <div style="font-size:11px;margin-top:2px;">Status: <b>${escapeHtml(a.status||'—')}</b>${a.hours?` · ${a.hours}h`:''}${a.failedReason?` · ${escapeHtml(a.failedReason)}`:''}${a.blockedReason?` · ${escapeHtml(a.blockedReason)}`:''}</div>
              </div>
              <button class="logout-mini" onclick="removeIntakeAddition(${i})" style="color:#dc2626;">Remove</button>
            </div>`).join('')}
      </div>

      <div class="form-grid">
        <div class="form-field">
          <label>Phase</label>
          <select class="form-input" onchange="_s2SetPhase(this.value)">
            <option value="">All Phases</option>
            ${phases.map(p=>`<option value="${escapeHtml(p)}" ${_s2Phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Location</label>
          <select class="form-input" onchange="_s2SetLoc(this.value)">
            <option value="">Select location…</option>
            ${locs.map(l=>`<option value="${escapeHtml(l)}" ${_s2Loc===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Activity</label>
          <select class="form-input" onchange="_s2SetAct(this.value)">
            <option value="">All Activities</option>
            ${acts.map(a=>`<option value="${escapeHtml(a)}" ${_s2Act===a?'selected':''}>${escapeHtml(a)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Test Case</label>
          <select id="ai-testid" class="form-input">
            <option value="">Select test case…</option>
            ${tests.map(t=>`<option value="${escapeHtml(t.TestID)}">${escapeHtml(t.TestCaseCode)} · ${escapeHtml(t.TestName)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Status</label>
          <select id="ai-status" class="form-input" onchange="ai_toggleReasonFields()">
            <option value="">Select status…</option>
            ${['Not Started','In Progress','Pass','Fail','Blocked','Not Applicable'].map(s=>`<option>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Hours Spent</label>
          <input type="number" id="ai-hours" class="form-input" min="0" step="0.25" placeholder="0.0">
        </div>
        <div class="form-field form-field-full" id="ai-failed-block" style="display:none;">
          <label>Failure Reason</label>
          <textarea id="ai-failed-reason" class="form-input" rows="2" placeholder="What failed and why?"></textarea>
        </div>
        <div class="form-field form-field-full" id="ai-blocked-block" style="display:none;">
          <label>Blocked Reason</label>
          <textarea id="ai-blocked-reason" class="form-input" rows="2" placeholder="Why is this blocked? Who can resolve?"></textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="form-secondary" onclick="setIntakeStep(1)">← Back</button>
        <button class="form-secondary" onclick="addIntakeAddition()">+ Add to List</button>
        <button class="form-submit" onclick="continueIntakeStep3()">Continue to Step 3 →</button>
      </div>
    </div>
  `;
}

function renderIntakeStep3(items) {
  const allItems = [..._sessionLog, ...intakeAdditions];
  const complete  = allItems.filter(i=>(i.newStatus||i.status)==='Pass').length;
  const failed    = allItems.filter(i=>(i.newStatus||i.status)==='Fail').length;
  const blocked   = allItems.filter(i=>(i.newStatus||i.status)==='Blocked').length;
  const inprog    = allItems.filter(i=>(i.newStatus||i.status)==='In Progress').length;
  const totalHrs  = allItems.reduce((s,i)=>s+(i.hours||0),0).toFixed(1);
  const delayCats = _fsCfg('delay_category');

  return `
    <div class="form-card">
      <h3 class="form-card-title">Step 3: Submit Daily Log</h3>
      <p class="form-card-sub">Review and submit the day's testing record.</p>

      <div class="form-grid">
        <div class="form-field form-field-full">
          <div class="counts-grid">
            <div class="count-tile"><div class="count-label">Total</div><div class="count-value">${allItems.length}</div></div>
            <div class="count-tile good"><div class="count-label">Complete</div><div class="count-value">${complete}</div></div>
            <div class="count-tile bad"><div class="count-label">Failed</div><div class="count-value">${failed}</div></div>
            <div class="count-tile warn"><div class="count-label">Blocked</div><div class="count-value">${blocked}</div></div>
            <div class="count-tile"><div class="count-label">In Progress</div><div class="count-value">${inprog}</div></div>
            <div class="count-tile info"><div class="count-label">Total Hours</div><div class="count-value">${totalHrs}</div></div>
          </div>
        </div>
        <div class="form-field">
          <label>Date</label>
          <input type="date" id="i3-date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div class="form-field">
          <label>Number of Testers</label>
          <input type="number" id="i3-testers" class="form-input" value="2" min="1">
        </div>
        <div class="form-field">
          <label>Idle Hours</label>
          <input type="number" id="i3-idle" class="form-input" value="${Math.max(0, 8 - parseFloat(totalHrs)).toFixed(1)}" min="0" step="0.5">
        </div>
        <div class="form-field">
          <label>Delay Occurred?</label>
          <div class="delay-toggle">
            <button type="button" class="toggle-btn active" data-val="No" onclick="toggleDelayI3(this,false)">No</button>
            <button type="button" class="toggle-btn" data-val="Yes" onclick="toggleDelayI3(this,true)">Yes</button>
          </div>
        </div>
        <div class="form-field" id="i3-delay-cat-wrap" style="display:none;">
          <label>Delay Category</label>
          <select id="i3-delay-cat" class="form-input">
            <option value="">Select category…</option>
            ${delayCats.map(c=>`<option>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field" id="i3-delay-hrs-wrap" style="display:none;">
          <label>Delay Hours</label>
          <input type="number" id="i3-delay-hrs" class="form-input" value="0" min="0" step="0.5">
        </div>
        <div class="form-field form-field-full" id="i3-delay-notes-wrap" style="display:none;">
          <label>Delay Notes</label>
          <textarea id="i3-delay-notes" class="form-input" rows="2" placeholder="Describe the delay…"></textarea>
        </div>
        <div class="form-field form-field-full">
          <label>Overall Day Notes</label>
          <textarea id="i3-notes" class="form-input" rows="3" placeholder="Summary of the day's work…"></textarea>
        </div>
        <div class="form-field form-field-full">
          <label>Plan for Next Day</label>
          <textarea id="i3-next" class="form-input" rows="2" placeholder="What's planned tomorrow?"></textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="form-secondary" onclick="setIntakeStep(2)">← Back</button>
        <button class="form-submit" onclick="submitIntakeFinal()">Submit Daily Log</button>
      </div>
    </div>
  `;
}

function setIntakeStep(s) { intakeStep = s; renderFieldIntake(); }

function selectAddStatus(btn, status) {
  document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('ai-blocked-block').style.display = status === 'blocked' ? '' : 'none';
  document.getElementById('ai-failed-block').style.display = status === 'failed' ? '' : 'none';
}

function filterAddTestcases() {
  const loc = document.getElementById('ai-location').value;
  const sel = document.getElementById('ai-testid');
  if (!loc) { sel.innerHTML = '<option value="">Select test case...</option>'; return; }
  const items = TI.filter(t => t.Location === loc);
  sel.innerHTML = '<option value="">Select test case...</option>' +
    items.map(t => `<option value="${t.TestID}">${escapeHtml(t.TestCaseCode)} · ${escapeHtml(t.TestName)}</option>`).join('');
}

function _updateAdditionHours(idx, val) {
  if (intakeAdditions[idx]) intakeAdditions[idx].hours = parseFloat(val) || 0;
}

function addIntakeAddition() {
  const tid    = document.getElementById('ai-testid').value;
  const status = document.getElementById('ai-status').value;
  if (!tid || !status) {
    toast('Please select a test case and status', 'warn');
    return;
  }
  const t = TI.find(x => String(x.TestID) === String(tid));
  if (!t) return;
  const row = {
    testId:       t.TestID,
    testCode:     t.TestCaseCode,
    testName:     t.TestName,
    location:     t.Location,
    subsystem:    t.Subsystem,
    phase:        t.Phase,
    activity:     t.Activity,
    testProcedure: t.TestProcedure,
    _isRealItem:  true,
    status,
    hours:        parseFloat(document.getElementById('ai-hours')?.value) || 0,
    blockedReason: document.getElementById('ai-blocked-reason')?.value || '',
    failedReason:  document.getElementById('ai-failed-reason')?.value  || '',
  };
  const existingIdx = intakeAdditions.findIndex(a => String(a.testId) === String(tid));
  if (existingIdx >= 0) intakeAdditions[existingIdx] = row;
  else intakeAdditions.push(row);
  toast('Added to list', 'success');
  renderFieldIntake();
}

function continueIntakeStep3() {
  const tid = document.getElementById('ai-testid')?.value;
  const status = document.getElementById('ai-status')?.value;
  const hours = document.getElementById('ai-hours')?.value;
  const failedReason = document.getElementById('ai-failed-reason')?.value;
  const blockedReason = document.getElementById('ai-blocked-reason')?.value;
  if (tid || status || hours || failedReason || blockedReason) {
    if (!tid || !status) {
      toast('Please select a test case and status before continuing', 'warn');
      return;
    }
    addIntakeAddition();
  }
  intakeStep = 3;
  renderFieldIntake();
}

function removeIntakeAddition(i) {
  intakeAdditions.splice(i, 1);
  renderFieldIntake();
}

function toggleDelayI3(btn, isYes) {
  document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const show = isYes ? '' : 'none';
  const catWrap   = document.getElementById('i3-delay-cat-wrap');
  const hrsWrap   = document.getElementById('i3-delay-hrs-wrap');
  const notesWrap = document.getElementById('i3-delay-notes-wrap');
  if (catWrap)   catWrap.style.display   = show;
  if (hrsWrap)   hrsWrap.style.display   = show;
  if (notesWrap) notesWrap.style.display = show;
}

async function submitIntakeFinal() {
  console.log('[submitIntakeFinal] click received');
  const btn = event?.target?.closest?.('button');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  const restoreBtn = () => { if (btn) { btn.disabled = false; btn.textContent = 'Submit Daily Log'; } };

  try {
    if (!_sb)             { alert('Supabase client not initialized.'); restoreBtn(); return; }
    if (!currentRoleUser) { alert('Not logged in — please sign in first.'); restoreBtn(); return; }

    const allItems = [
      ..._sessionLog.map(e => ({ ...e, status: e.newStatus })),
      ...intakeAdditions,
    ];

    const dateVal       = document.getElementById('i3-date')?.value || new Date().toISOString().split('T')[0];
    const testers       = parseInt(document.getElementById('i3-testers')?.value) || 1;
    const idleHours     = parseFloat(document.getElementById('i3-idle')?.value) || 0;
    const activeToggle  = document.getElementById('field-intake-content')?.querySelector('.toggle-btn.active');
    const delayOccurred = activeToggle?.dataset.val || 'No';
    const delayCat      = delayOccurred === 'Yes' ? (document.getElementById('i3-delay-cat')?.value || null) : null;
    const delayHrs      = delayOccurred === 'Yes' ? (parseFloat(document.getElementById('i3-delay-hrs')?.value) || 0) : 0;
    const delayNotes    = delayOccurred === 'Yes' ? (document.getElementById('i3-delay-notes')?.value || null) : null;
    const overallNotes  = document.getElementById('i3-notes')?.value || '';
    const nextDayPlan   = document.getElementById('i3-next')?.value  || '';
    const submitter     = currentRoleUser.name;

    // test_results.result CHECK constraint: only Pass | Fail | Partial | Blocked allowed
    const toResult = s => ({ 'Pass':'Pass', 'Fail':'Fail', 'Blocked':'Blocked', 'In Progress':'Partial' }[s] || null);

    // Shared timestamp for all IDs generated in this submit batch
    const _batchTs = Date.now();
    const _dateKey = dateVal.replace(/-/g, '');
    const _userKey = submitter.replace(/\s+/g, '').toUpperCase().slice(0, 4);

    // Only insert rows that have a DB-valid result (skip Not Started / Not Applicable)
    const resultRows = allItems
      .filter(item => toResult(item.status) !== null && (item.testId || item.id))
      .map((item, i) => ({
        result_id:         `RES-${_dateKey}-${_userKey}-${_batchTs}-${String(i + 1).padStart(3, '0')}`,
        test_id:           item.testId || item.id,
        test_name:         item.testName        || null,
        phase:             item.phase           || null,
        location:          item.location        || null,
        subsystem:         item.subsystem       || null,
        activity:          item.activity        || null,
        test_case_code:    item.testCode        || null,
        test_procedure:    item.testProcedure   || null,
        result:            toResult(item.status),
        new_status:        item.status          || null,
        completed_by:      submitter,
        date_tested:       dateVal,
        submitted_by:      submitter,
        number_of_testers: testers,
        failed_reason:     item.failedReason    || null,
        blocked_reason:    item.blockedReason   || null,
        test_hours:        item.hours           || 0,
        notes:             item.notes           || null,
      }));

    const logRow = {
      log_id:             `LOG-${_dateKey}-${_userKey}-${_batchTs}`,
      log_date:           dateVal,
      location:           allItems[0]?.location  || null,
      subsystem:          allItems[0]?.subsystem  || null,
      submitted_by:       submitter,
      number_of_testers:  testers,
      idle_hours:         idleHours,
      total_tests_logged: allItems.length,
      total_passed:       allItems.filter(i => i.status === 'Pass').length,
      total_failed:       allItems.filter(i => i.status === 'Fail').length,
      total_partial:      allItems.filter(i => i.status === 'In Progress').length,
      total_blocked:      allItems.filter(i => i.status === 'Blocked').length,
      delay_occurred:     delayOccurred,
      delay_category:     delayCat,
      delay_duration:     delayHrs,
      delay_notes:        delayNotes,
      overall_notes:      overallNotes,
      next_day_plan:      nextDayPlan,
    };

    console.log('[submitIntakeFinal] inserting', resultRows.length, 'test_results +', 1, 'delay_log');

    if (resultRows.length > 0) {
      console.log('[submitIntakeFinal] → test_results.insert (direct fetch)');
      const rData = await _dbInsert('test_results', resultRows);
      console.log('[submitIntakeFinal] ← test_results returned:', rData?.length ?? 0, 'rows');
    }

    console.log('[submitIntakeFinal] → delay_log.insert (direct fetch)');
    const lData = await _dbInsert('delay_log', [logRow]);
    console.log('[submitIntakeFinal] ← delay_log returned:', lData?.length ?? 0, 'rows');

    logAudit('Daily Log Submitted', `${allItems.length} test cases logged`, 'Daily report generated');
    _sessionLog     = [];
    intakeAdditions = [];
    intakeStep      = 1;
    alert(`✓ Daily log submitted!\n\n${resultRows.length > 0 ? `${resultRows.length} test result(s) saved\n` : 'No test results logged (delay-only day)\n'}1 daily log row saved`);
    renderFieldIntake();

  } catch (err) {
    console.error('[submitIntakeFinal] error:', err);
    alert('Submit failed: ' + (err?.message || JSON.stringify(err)));
    restoreBtn();
  }
}

// ==========================================================================
// TYPEAHEAD HELPERS — for multi-select people fields
// ==========================================================================
function _taUsers(adminOnly) {
  return PROFILE_USERS
    .filter(u => !adminOnly ? u.role !== 'readonly' : u.role === 'admin')
    .map(u => u.full_name);
}

function _taUsersByFilter(filter) {
  if (filter === 'admin')        return PROFILE_USERS.filter(u => u.role === 'admin').map(u => u.full_name);
  if (filter === 'admin_client') return PROFILE_USERS.filter(u => u.role === 'admin' || u.role === 'client').map(u => u.full_name);
  return PROFILE_USERS.filter(u => u.role !== 'readonly').map(u => u.full_name);
}

// Single-select typeahead (for PIM, Final Approver)
function _taHTMLSingle(id, filter) {
  return `
    <div class="ta-wrap">
      <div class="ta-tags" id="${id}-tags"></div>
      <input type="text" id="${id}-search" class="ta-search form-input" placeholder="Type to search…"
        autocomplete="off" oninput="_taFilterSingle('${id}','${filter}')"
        onblur="setTimeout(()=>{ const d=document.getElementById('${id}-drop'); if(d)d.classList.add('hidden'); },150)">
      <div class="ta-drop hidden" id="${id}-drop"></div>
    </div>
    <input type="hidden" id="${id}" value="">
  `;
}

function _taFilterSingle(id, filter) {
  const q = (document.getElementById(id + '-search')?.value || '').toLowerCase();
  const drop = document.getElementById(id + '-drop');
  if (!drop) return;
  if (!q) { drop.classList.add('hidden'); return; }
  const pool = _taUsersByFilter(filter).filter(u => u.toLowerCase().includes(q));
  if (!pool.length) { drop.classList.add('hidden'); return; }
  drop.classList.remove('hidden');
  drop.innerHTML = pool.slice(0, 8).map(u =>
    `<div class="ta-option" onmousedown="event.preventDefault();_taSelectSingle('${id}','${u.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">${escapeHtml(u)}</div>`
  ).join('');
}

function _taSelectSingle(id, val) {
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = val;
  _taRenderTagsSingle(id, val);
  const search = document.getElementById(id + '-search');
  if (search) search.value = '';
  const drop = document.getElementById(id + '-drop');
  if (drop) drop.classList.add('hidden');
}

function _taRenderTagsSingle(id, val) {
  const el = document.getElementById(id + '-tags');
  if (!el) return;
  el.innerHTML = val
    ? `<span class="ta-tag">${escapeHtml(val)}<button type="button" class="ta-remove" onmousedown="event.preventDefault();_taClearSingle('${id}')">×</button></span>`
    : '';
}

function _taClearSingle(id) {
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = '';
  _taRenderTagsSingle(id, '');
}

function _taInitSingle(id, val) {
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = val || '';
  _taRenderTagsSingle(id, val || '');
}

function _taGetVals(id) {
  const v = document.getElementById(id)?.value || '';
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function _taRenderTags(id, vals) {
  const el = document.getElementById(id + '-tags');
  if (!el) return;
  el.innerHTML = vals.map(v =>
    `<span class="ta-tag">${escapeHtml(v)}<button type="button" class="ta-remove" onmousedown="event.preventDefault();_taRemove('${id}','${v.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">×</button></span>`
  ).join('');
}

function _taFilter(id, adminOnly) {
  const q = (document.getElementById(id + '-search')?.value || '').toLowerCase();
  const drop = document.getElementById(id + '-drop');
  if (!drop) return;
  if (!q) { drop.classList.add('hidden'); return; }
  const cur = _taGetVals(id);
  const pool = _taUsers(adminOnly).filter(u => u.toLowerCase().includes(q) && !cur.includes(u));
  if (!pool.length) { drop.classList.add('hidden'); return; }
  drop.classList.remove('hidden');
  drop.innerHTML = pool.slice(0, 8).map(u =>
    `<div class="ta-option" onmousedown="event.preventDefault();_taSelect('${id}','${u.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}',${adminOnly})">${escapeHtml(u)}</div>`
  ).join('');
}

function _taSelect(id, val, adminOnly) {
  const cur = _taGetVals(id);
  if (!cur.includes(val)) cur.push(val);
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = cur.join(',');
  _taRenderTags(id, cur);
  const search = document.getElementById(id + '-search');
  if (search) search.value = '';
  const drop = document.getElementById(id + '-drop');
  if (drop) drop.classList.add('hidden');
}

function _taRemove(id, val) {
  const cur = _taGetVals(id).filter(v => v !== val);
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = cur.join(',');
  _taRenderTags(id, cur);
}

function _taInitField(id, vals, adminOnly) {
  const hidden = document.getElementById(id);
  if (hidden) hidden.value = vals.join(',');
  _taRenderTags(id, vals);
}

function _taHTML(id, adminOnly) {
  return `
    <div class="ta-wrap">
      <div class="ta-tags" id="${id}-tags"></div>
      <input type="text" id="${id}-search" class="ta-search form-input" placeholder="Type to search users…"
        autocomplete="off" oninput="_taFilter('${id}',${adminOnly})"
        onblur="setTimeout(()=>{ const d=document.getElementById('${id}-drop'); if(d)d.classList.add('hidden'); },150)">
      <div class="ta-drop hidden" id="${id}-drop"></div>
    </div>
    <input type="hidden" id="${id}" value="">
  `;
}

// ==========================================================================
// PUNCH LIST — Supabase-backed list view with create/edit/detail
// ==========================================================================
let PUNCH_DB = [];
let _plTab = 'all', _plPage = 1, _plSearch = '';
let _plStatusFilter = '', _plPhaseFilter = '', _plLocFilter = '';
let _plSubFilter = '', _plPriorityFilter = '', _plActivityFilter = '';
let _plSelected = new Set(); // IDs of punch items checked for PDF export

function _punchDeriveActivity(code) {
  if (!code) return null;
  return TI.find(r => r.TestCaseCode === code)?.Activity || null;
}
const PL_PAGE_SIZE = 25;

async function loadPunchDB() {
  try {
    const data = await _fetchAnon('punch_items?select=*&order=number.desc');
    PUNCH_DB = data || [];
    console.log(`Loaded ${PUNCH_DB.length} punch items`);
  } catch(err) { console.warn('Punch items load failed:', err.message); PUNCH_DB = []; }
}

function _isMyPunchItem(p) {
  if (!currentRoleUser) return false;
  const n = currentRoleUser.name;
  return p.created_by === n || p.punch_item_manager === n || p.final_approver === n ||
    (p.assignees||[]).includes(n) || (p.distribution_list||[]).includes(n);
}

const PL_STATUS_LABELS = {
  draft:             'Draft',
  initiated:         'Initiated',
  in_dispute:        'In Dispute',
  work_required:     'Work Required',
  work_not_accepted: 'Work Not Accepted',
  ready_for_review:  'Ready for Review',
  ready_to_close:    'Ready to Close',
  not_accepted:      'Not Accepted',
  closed:            'Closed',
};

function _plStatusBadge(status) {
  const map = {
    draft:             ['Draft',             '#6b7280','#f3f4f6'],
    initiated:         ['Initiated',         '#1d4ed8','#dbeafe'],
    in_dispute:        ['In Dispute',        '#ea580c','#ffedd5'],
    work_required:     ['Work Required',     '#d97706','#fef3c7'],
    work_not_accepted: ['Work Not Accepted', '#dc2626','#fee2e2'],
    ready_for_review:  ['Ready for Review',  '#7c3aed','#ede9fe'],
    ready_to_close:    ['Ready to Close',    '#0369a1','#e0f2fe'],
    not_accepted:      ['Not Accepted',      '#9f1239','#ffe4e6'],
    closed:            ['Closed',            '#059669','#d1fae5'],
  };
  const [label,color,bg] = map[status] || [status||'Unknown','#6b7280','#f3f4f6'];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:12px;font-size:11px;font-weight:600;background:${bg};color:${color};white-space:nowrap;">${label}</span>`;
}

function _plPriorityBadge(priority) {
  const map = { Low:'#059669,#d1fae5', Medium:'#d97706,#fef3c7', High:'#dc2626,#fee2e2', Critical:'#7c3aed,#ede9fe' };
  const [color,bg] = (map[priority]||'#6b7280,#f3f4f6').split(',');
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${bg};color:${color};">${escapeHtml(priority||'—')}</span>`;
}

function _plBallInCourt(p) {
  switch (p.status) {
    case 'closed':            return '—';
    case 'draft':             return p.created_by || 'Creator';
    case 'initiated':         return p.punch_item_manager || 'PIM';
    case 'in_dispute':        return p.punch_item_manager || 'PIM';
    case 'work_required':
    case 'work_not_accepted': { const a = p.assignees||[]; return a.length ? a.join(', ') : 'Assignees'; }
    case 'ready_for_review':  return p.punch_item_manager || 'PIM';
    case 'ready_to_close':    return p.final_approver || 'Final Approver';
    case 'not_accepted':      return p.punch_item_manager || 'PIM';
    default: return '—';
  }
}

function _plLocName(id) { return id ? (LOCS.find(l => l.id === id)?.name || id) : '—'; }

function renderPunchWorkflow() {
  const root = document.getElementById('punch-workflow-content');
  if (!root || !currentRoleUser) return;

  const all  = PUNCH_DB.filter(p => !p.is_deleted);
  const bin  = PUNCH_DB.filter(p => p.is_deleted);
  const my   = all.filter(p => _isMyPunchItem(p));

  let items = _plTab === 'bin' ? bin : _plTab === 'my' ? my : all;
  if (_plSearch)       items = items.filter(p => (p.title||'').toLowerCase().includes(_plSearch.toLowerCase()) || String(p.number).includes(_plSearch));
  if (_plStatusFilter) items = items.filter(p => p.status === _plStatusFilter);
  if (_plPhaseFilter)  items = items.filter(p => p.phase === _plPhaseFilter);
  if (_plLocFilter)    items = items.filter(p => p.location === _plLocFilter);
  if (_plSubFilter)    items = items.filter(p => p.subsystem === _plSubFilter);
  if (_plPriorityFilter) items = items.filter(p => p.priority === _plPriorityFilter);
  if (_plActivityFilter) {
    const actCodes = new Set(TI.filter(r => r.Activity === _plActivityFilter).map(r => r.TestCaseCode));
    items = items.filter(p => actCodes.has(p.test_case_code));
  }

  // Build activity options from all punch items (via TI lookup)
  const plActivities = [...new Set(all.map(p => _punchDeriveActivity(p.test_case_code)).filter(Boolean))].sort();

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PL_PAGE_SIZE));
  if (_plPage > pages) _plPage = pages;
  const paged = items.slice((_plPage-1)*PL_PAGE_SIZE, _plPage*PL_PAGE_SIZE);

  const openItems = all.filter(p => p.status !== 'closed');
  const overdue   = openItems.filter(p => p.due_date && new Date(p.due_date) < new Date());

  // Dynamic cascade Phase → Location → Subsystem from current tab's base items
  const baseItems   = _plTab === 'bin' ? bin : _plTab === 'my' ? my : all;
  const phaseIds    = new Set(baseItems.map(p => p.phase).filter(Boolean));
  const phases      = LOCS.filter(l => l.level === 1 && phaseIds.has(l.id)).sort((a,b) => a.sort_order - b.sort_order);
  const afterPhase  = _plPhaseFilter ? baseItems.filter(p => p.phase === _plPhaseFilter) : baseItems;
  const locIds      = new Set(afterPhase.map(p => p.location).filter(Boolean));
  const locPool     = LOCS.filter(l => l.level === 2 && locIds.has(l.id));
  const afterLoc    = _plLocFilter ? afterPhase.filter(p => p.location === _plLocFilter) : afterPhase;
  const subPool     = [...new Set(afterLoc.map(p => p.subsystem).filter(Boolean))].sort();

  const hasFilter = _plSearch || _plStatusFilter || _plPhaseFilter || _plLocFilter || _plSubFilter || _plPriorityFilter || _plActivityFilter;

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;border-bottom:2px solid var(--gray-200);padding-bottom:0;">
      <div style="display:flex;gap:0;">
        ${[['my',`My Items (${my.length})`],['all',`All Items (${all.length})`],['bin',`Recycle Bin (${bin.length})`]].map(([id,label])=>`
          <button class="admin-tab${_plTab===id?' active':''}" onclick="_plSetTab('${id}')">${label}</button>`).join('')}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="form-secondary" onclick="openPunchImportModal()" style="font-size:13px;">⬆ Import CSV</button>
        <button class="admin-action-btn" onclick="openNewPunchModal()">+ Create New</button>
      </div>
    </div>

    <div class="kpi-grid kpi-grid-mini" style="margin-bottom:20px;">
      <div class="kpi-card kpi-mini"><div class="kpi-label">Total Open</div><div class="kpi-value">${openItems.length}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Work Required</div><div class="kpi-value" style="color:var(--warn);">${all.filter(p=>p.status==='work_required'||p.status==='work_not_accepted').length}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Ready to Close</div><div class="kpi-value" style="color:#0369a1;">${all.filter(p=>p.status==='ready_to_close').length}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Overdue</div><div class="kpi-value" style="color:var(--bad);">${overdue.length}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Closed</div><div class="kpi-value good">${all.filter(p=>p.status==='closed').length}</div></div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px;">
      <div style="position:relative;flex:1;min-width:200px;">
        <input type="text" class="form-input" placeholder="Search title or #…" value="${escapeHtml(_plSearch)}"
          oninput="_plSetSearch(this.value)" style="padding-left:32px;font-size:13px;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--gray-400);font-size:16px;">⌕</span>
      </div>
      <select class="form-input" style="width:160px;font-size:13px;" onchange="_plSetFilter('status',this.value)">
        <option value="">All Statuses</option>
        ${Object.entries(PL_STATUS_LABELS).map(([v,l])=>`<option value="${v}" ${_plStatusFilter===v?'selected':''}>${l}</option>`).join('')}
      </select>
      <select class="form-input" style="width:140px;font-size:13px;" onchange="_plPhaseChange(this.value)">
        <option value="">All Phases</option>
        ${phases.map(p=>`<option value="${p.id}" ${_plPhaseFilter===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}
      </select>
      <select class="form-input" style="width:160px;font-size:13px;" onchange="_plSetFilter('loc',this.value)">
        <option value="">All Locations</option>
        ${locPool.map(l=>`<option value="${l.id}" ${_plLocFilter===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('')}
      </select>
      <select class="form-input" style="width:130px;font-size:13px;" onchange="_plSetFilter('sub',this.value)">
        <option value="">All Subsystems</option>
        ${subPool.map(s=>`<option value="${escapeHtml(s)}" ${_plSubFilter===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select class="form-input" style="width:120px;font-size:13px;" onchange="_plSetFilter('priority',this.value)">
        <option value="">All Priorities</option>
        ${['Low','Medium','High','Critical'].map(p=>`<option value="${p}" ${_plPriorityFilter===p?'selected':''}>${p}</option>`).join('')}
      </select>
      ${plActivities.length ? `<select class="form-input" style="width:160px;font-size:13px;" onchange="_plSetFilter('activity',this.value)">
        <option value="">All Activities</option>
        ${plActivities.map(a=>`<option value="${escapeHtml(a)}" ${_plActivityFilter===a?'selected':''}>${escapeHtml(a)}</option>`).join('')}
      </select>` : ''}
      ${hasFilter ? `<button class="form-secondary" style="white-space:nowrap;font-size:12px;" onclick="_plClearFilters()">✕ Clear All</button>` : ''}
    </div>

    ${_plSelected.size > 0 ? `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;margin-bottom:12px;">
        <span style="font-size:13px;font-weight:600;color:#1d4ed8;">${_plSelected.size} item${_plSelected.size===1?'':'s'} selected</span>
        <button class="form-submit" style="font-size:12px;padding:5px 14px;" onclick="exportPunchPDF([..._plSelected])">⬇ Export ${_plSelected.size} as PDF</button>
        <button class="form-secondary" style="font-size:12px;padding:5px 12px;" onclick="_plClearSelection()">✕ Clear</button>
      </div>` : ''}

    <div class="data-card" style="padding:0;overflow:hidden;">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:36px;text-align:center;"></th>
            <th style="width:50px;">#</th>
            <th>Title</th>
            <th>Status</th>
            <th>Ball In Court</th>
            <th>Subsystem</th>
            <th>Phase / Location</th>
            <th>Priority</th>
            <th>Due Date</th>
            <th style="min-width:110px;">PIM</th>
            <th style="width:60px;"></th>
          </tr>
        </thead>
        <tbody>
          ${paged.length ? paged.map(p => {
            const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== 'closed' && p.status !== 'voided';
            const dueStr = p.due_date ? new Date(p.due_date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
            return `<tr onclick="openPunchDetail('${p.id}')" style="cursor:pointer;">
              <td onclick="event.stopPropagation()" style="text-align:center;">
                <input type="checkbox" ${_plSelected.has(p.id)?'checked':''} onchange="_plToggleSelect('${p.id}',this.checked)" style="width:15px;height:15px;cursor:pointer;">
              </td>
              <td style="font-weight:600;color:var(--gray-600);">${p.number||'—'}</td>
              <td style="max-width:220px;">
                <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.title)}</div>
                <div style="font-size:11px;color:var(--gray-500);">${escapeHtml(p.type||'')}</div>
              </td>
              <td>${_plStatusBadge(p.status)}</td>
              <td style="font-size:12px;color:var(--gray-700);">${escapeHtml(_plBallInCourt(p))}</td>
              <td style="font-size:12px;">${escapeHtml(p.subsystem||'—')}</td>
              <td style="font-size:12px;color:var(--gray-700);">${escapeHtml(_plLocName(p.phase))} / ${escapeHtml(_plLocName(p.location))}</td>
              <td>${_plPriorityBadge(p.priority)}</td>
              <td style="font-size:12px;${isOverdue?'color:#dc2626;font-weight:600;':''}">${dueStr}${isOverdue?' ⚠':''}</td>
              <td style="font-size:12px;white-space:nowrap;">${escapeHtml(p.punch_item_manager||'—')}</td>
              <td onclick="event.stopPropagation()">
                <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="openPunchDetail('${p.id}')">View</button>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="11" style="text-align:center;padding:32px;color:var(--gray-400);">${_plTab==='bin'?'Recycle bin is empty':'No punch items match your filters'}</td></tr>`}
        </tbody>
      </table>
    </div>

    ${pages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;font-size:13px;color:var(--gray-600);">
        <span>Showing ${(_plPage-1)*PL_PAGE_SIZE+1}–${Math.min(_plPage*PL_PAGE_SIZE,total)} of ${total}</span>
        <div style="display:flex;gap:6px;">
          <button class="form-secondary" ${_plPage<=1?'disabled':''} onclick="_plSetPage(${_plPage-1})">← Prev</button>
          <span style="padding:6px 12px;font-weight:600;">${_plPage} / ${pages}</span>
          <button class="form-secondary" ${_plPage>=pages?'disabled':''} onclick="_plSetPage(${_plPage+1})">Next →</button>
        </div>
      </div>` : ''}
  `;
}

function _plSetTab(t)    { _plTab=t; _plPage=1; renderPunchWorkflow(); }
function _plSetSearch(v) { _plSearch=v; _plPage=1; renderPunchWorkflow(); }
function _plSetPage(n)   { _plPage=n; renderPunchWorkflow(); }
function _plSetFilter(k,v) {
  if (k==='status')   _plStatusFilter=v;
  else if (k==='loc') { _plLocFilter=v; _plSubFilter=''; }  // cascade: loc change resets sub
  else if (k==='sub') _plSubFilter=v;
  else if (k==='priority') _plPriorityFilter=v;
  else if (k==='activity') _plActivityFilter=v;
  _plPage=1; renderPunchWorkflow();
}
function _plPhaseChange(id) { _plPhaseFilter=id; _plLocFilter=''; _plSubFilter=''; _plPage=1; renderPunchWorkflow(); }
function _plClearFilters()  { _plSearch=''; _plStatusFilter=''; _plPhaseFilter=''; _plLocFilter=''; _plSubFilter=''; _plPriorityFilter=''; _plActivityFilter=''; _plPage=1; renderPunchWorkflow(); }

function _plToggleSelect(id, checked) {
  if (checked) _plSelected.add(id);
  else _plSelected.delete(id);
  renderPunchWorkflow();
}
function _plClearSelection() { _plSelected = new Set(); renderPunchWorkflow(); }

function exportPunchPDF(ids) {
  const items = ids.map(id => PUNCH_DB.find(x => x.id === id)).filter(Boolean);
  if (!items.length) { toast('No items found', 'warn'); return; }

  // PL_STATUS_LABELS is a const in the same scope — do NOT use window.PL_STATUS_LABELS
  // (const/let top-level vars are NOT added to window in non-module scripts)
  const statusLabels = PL_STATUS_LABELS || {};
  const fmtDate = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  const esc = s => (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const pagesHtml = items.map((item, pi) => {
    const phaseName = _plLocName(item.phase);
    const locName   = _plLocName(item.location);

    // Merged chronological timeline
    const merged = [
      ...(item.comments||[]).map(c => ({ ...c, _type: 'comment' })),
      ...(item.history||[]).map(h => ({ ...h, _type: 'history' })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    const timelineHtml = merged.length ? merged.map(entry => {
      const ts = new Date(entry.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
      if (entry._type === 'comment') {
        const roleLabel = {admin:'Admin',field_engineer:'Field Eng.',client:'Client',readonly:'Read Only'}[entry.by_role] || entry.by_role || '';
        return `<div class="tl-item tl-comment">
          <div class="tl-badge tl-badge-comment">Comment</div>
          <div class="tl-meta">${esc(entry.by)} · ${esc(roleLabel)} · ${ts}</div>
          <div class="tl-body">${esc(entry.text)}</div>
        </div>`;
      } else {
        const changeItems = (entry.changes||[]).map(ch => `<li>${esc(ch)}</li>`).join('');
        return `<div class="tl-item tl-action">
          <div class="tl-badge tl-badge-action">Action</div>
          <div class="tl-meta"><strong>${esc(entry.action)}</strong> · ${esc(entry.by||'')} · ${ts}</div>
          ${changeItems ? `<ul style="margin:4px 0 0 12px;padding:0;">${changeItems}</ul>` : ''}
          ${entry.note ? `<div style="color:#555;margin-top:2px;">Note: ${esc(entry.note)}</div>` : ''}
        </div>`;
      }
    }).join('') : '<div style="color:#999;font-size:12px;padding:8px 0;">No activity recorded</div>';

    const fields = [
      ['Punch #',             item.number],
      ['Status',              statusLabels[item.status] || item.status],
      ['Priority',            item.priority],
      ['Type',                item.type],
      ['Subsystem',           item.subsystem],
      ['Schedule Impact',     item.schedule_impact],
      ['Phase',               phaseName],
      ['Location',            locName],
      ['Due Date',            fmtDate(item.due_date)],
      ['Punch Item Manager',  item.punch_item_manager],
      ['Final Approver',      item.final_approver],
      ['Created By',          item.created_by],
      ['Assignees',           (item.assignees||[]).join(', ')],
      ['Category of Failure', item.category_of_failure],
      ['Type of Failure',     item.type_of_failure],
      ['Ball In Court',       _plBallInCourt(item)],
      ['RTC / Work Item',     item.rtc_work_item_id],
      ['Created',             item.created_at ? new Date(item.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'],
    ];

    return `<div class="punch-page${pi > 0 ? ' page-break' : ''}">
      <div class="ph">
        <div>
          <div class="org">BART CBTC — Testing &amp; Commissioning Portal</div>
          <div class="exp-lbl">Punch List Export · ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
        </div>
        <div class="pnum">#${esc(String(item.number||'—'))}</div>
      </div>
      <h1 class="ptitle">${esc(item.title)}</h1>
      ${item.description ? `<div class="pdesc">${esc(item.description)}</div>` : ''}
      <div class="fgrid">${fields.map(([l,v])=>`<div class="fd"><div class="fl">${l}</div><div class="fv">${esc(v||'—')}</div></div>`).join('')}</div>
      <div class="stitle">Activity &amp; Comments</div>
      <div class="timeline">${timelineHtml}</div>
    </div>`;
  }).join('');

  const css = `
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a1a;background:#fff;}
    .punch-page{padding:32px 40px;max-width:860px;margin:0 auto;}
    .page-break{page-break-before:always;padding-top:32px;}
    .ph{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:12px;border-bottom:2px solid #e60012;}
    .org{font-size:11px;font-weight:700;color:#e60012;text-transform:uppercase;letter-spacing:.06em;}
    .exp-lbl{font-size:10px;color:#777;margin-top:3px;}
    .pnum{font-size:28px;font-weight:700;color:#e60012;}
    .ptitle{font-size:18px;font-weight:700;color:#111;margin-bottom:12px;line-height:1.4;}
    .pdesc{font-size:12px;color:#444;line-height:1.6;background:#f7f7f7;padding:10px 14px;border-radius:6px;margin-bottom:16px;white-space:pre-wrap;}
    .fgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-bottom:20px;padding:14px;background:#f9f9f9;border-radius:6px;}
    .fl{font-size:9px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;}
    .fv{font-size:12px;color:#222;word-break:break-word;}
    .stitle{font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;padding-top:12px;border-top:1px solid #eee;}
    .timeline{border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;}
    .tl-item{padding:8px 12px;border-bottom:1px solid #f0f0f0;display:flex;flex-direction:column;gap:3px;}
    .tl-item:last-child{border-bottom:none;}
    .tl-comment{background:#fff;}
    .tl-action{background:#f9fafb;}
    .tl-badge{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em;width:fit-content;}
    .tl-badge-comment{background:#fef3e0;color:#d97706;}
    .tl-badge-action{background:#e5e7eb;color:#555;}
    .tl-meta{font-size:11px;color:#444;}
    .tl-body{font-size:12px;color:#222;white-space:pre-wrap;margin-top:2px;}
    @media print{
      body{padding:0;}
      @page{margin:16mm 14mm;size:A4;}
      .page-break{page-break-before:always;}
    }
  `;

  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Punch Export</title><style>${css}</style></head><body>${pagesHtml}<script>window.onload=function(){window.print();}<\/script></body></html>`;

  // ── Strategy: Blob URL → hidden iframe → contentWindow.print() ─────────────
  // This avoids popup blockers entirely (no window.open needed).
  // The iframe loads the blob, fires onload, then we call print() on its window.
  try {
    const blob   = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);

    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;border:none;opacity:0;';
    document.body.appendChild(frame);

    frame.onload = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch(printErr) {
        console.error('[PDF] iframe print failed, falling back:', printErr);
        // Fallback: open blob URL in a new tab so user can Ctrl+P manually
        window.open(blobUrl, '_blank');
      }
      // Clean up after print dialog closes (or after 60s timeout)
      const cleanup = () => {
        if (document.body.contains(frame)) document.body.removeChild(frame);
        URL.revokeObjectURL(blobUrl);
      };
      frame.contentWindow.onafterprint = cleanup;
      setTimeout(cleanup, 60000);
    };

    frame.src = blobUrl;
    toast(`Preparing PDF for ${items.length} item${items.length===1?'':'s'}…`, 'success');
  } catch(e) {
    console.error('[PDF] export failed:', e);
    toast('PDF export failed: ' + e.message, 'error');
  }
}

function _punchWorkflowActions(p) {
  const role    = currentRoleUser?.role;
  const name    = currentRoleUser?.name;
  const isAdmin = role === 'admin';
  const isPIM   = p.punch_item_manager === name;
  const isFinal = p.final_approver === name;
  const isCreator  = p.created_by === name;
  const isAssignee = (p.assignees||[]).includes(name);
  const btn = (label, status, style='secondary') =>
    `<button class="form-${style}" style="font-size:12px;" onclick="advancePunchStatus('${p.id}','${status}')">${label}</button>`;

  if (p.status === 'closed') return '';
  const actions = [];
  switch (p.status) {
    case 'draft':
      if (isCreator||isAdmin) { actions.push(btn('Send to PIM','initiated','submit')); actions.push(btn('Close','closed')); }
      break;
    case 'initiated':
      if (isPIM||isAdmin) { actions.push(btn('Send to Assignees','work_required','submit')); actions.push(btn('Dispute','in_dispute')); }
      if (isAdmin) actions.push(btn('Close','closed'));
      break;
    case 'in_dispute':
      if (isPIM||isAdmin) actions.push(btn('Send to Assignees','work_required','submit'));
      if (isCreator||isAdmin) actions.push(btn('Close','closed'));
      break;
    case 'work_required':
      if (isAssignee||role==='field_engineer'||isAdmin) actions.push(btn('Mark Ready for Review','ready_for_review','submit'));
      if (isPIM||isAdmin) actions.push(btn('Work Not Accepted','work_not_accepted'));
      break;
    case 'work_not_accepted':
      if (isAssignee||role==='field_engineer'||isAdmin) actions.push(btn('Mark Ready for Review','ready_for_review','submit'));
      if (isPIM||isAdmin) actions.push(btn('Mark Ready to Close','ready_to_close','submit'));
      break;
    case 'ready_for_review':
      if (isPIM||isAdmin) { actions.push(btn('Mark Ready to Close','ready_to_close','submit')); actions.push(btn('Work Not Accepted','work_not_accepted')); }
      break;
    case 'ready_to_close':
      if (isFinal||isAdmin) { actions.push(btn('Close Item','closed','submit')); actions.push(btn('Not Accepted','not_accepted')); }
      break;
    case 'not_accepted':
      if (isPIM||isAdmin) actions.push(btn('Send Back to Assignees','work_required','submit'));
      if (isAdmin) actions.push(btn('Close','closed'));
      break;
  }
  return actions.join('');
}

function openPunchDetail(id) {
  const p = PUNCH_DB.find(x => x.id === id);
  if (!p) return;
  const phaseName = _plLocName(p.phase), locName = _plLocName(p.location);
  const canComment = currentRoleUser?.role === 'admin' || currentRoleUser?.role === 'field_engineer' || currentRoleUser?.role === 'client';
  const comments = (p.comments||[]).slice().reverse();
  const history  = (p.history||[]).slice().reverse();

  modal({
    title: `Punch #${p.number}`,
    sub: escapeHtml(p.title),
    size: 'large',
    body: `
      <!-- Status bar -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 16px;background:var(--gray-50);border-radius:8px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;gap:12px;">
          ${_plStatusBadge(p.status)}
          ${_plPriorityBadge(p.priority)}
          <span style="font-size:12px;color:var(--gray-600);">Ball in court: <strong>${escapeHtml(_plBallInCourt(p))}</strong></span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">${_punchWorkflowActions(p)}</div>
      </div>

      <!-- Metadata grid -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;padding:14px;background:var(--gray-50);border-radius:8px;">
        ${[
          ['Type', p.type], ['Subsystem', p.subsystem], ['Schedule Impact', p.schedule_impact],
          ['Phase', phaseName], ['Location', locName], ['Due Date', p.due_date ? new Date(p.due_date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : null],
          ['Punch Item Manager', p.punch_item_manager], ['Final Approver', p.final_approver], ['Created By', p.created_by],
          ['Assignees', (p.assignees||[]).join(', ')], ['Category of Failure', p.category_of_failure], ['Type of Failure', p.type_of_failure],
          ['RTC / Work Item ID', p.rtc_work_item_id], ['Private', p.is_private ? 'Yes' : 'No'], ['Created', p.created_at ? dateAgo(p.created_at) : null],
        ].map(([label,val])=>`
          <div>
            <div style="font-size:10px;font-weight:600;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">${label}</div>
            <div style="font-size:12px;color:var(--gray-800);">${escapeHtml(val||'—')}</div>
          </div>`).join('')}
      </div>

      ${p.description ? `
        <div style="margin-bottom:18px;">
          <div style="font-size:11px;font-weight:600;color:var(--gray-500);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">Description</div>
          <div style="font-size:13px;color:var(--gray-800);line-height:1.6;white-space:pre-wrap;padding:10px 14px;background:var(--gray-50);border-radius:8px;">${escapeHtml(p.description)}</div>
        </div>` : ''}

      <!-- Combined Activity & Comments Timeline -->
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px;">
          Activity &amp; Comments
        </div>
        <div style="display:flex;flex-direction:column;gap:0;max-height:340px;overflow-y:auto;border:1px solid var(--gray-200);border-radius:8px;padding:4px 0;" id="punch-timeline-${id}">
          ${(() => {
            const merged = [
              ...(p.comments||[]).map(c => ({ ...c, _type: 'comment' })),
              ...(p.history||[]).map(h => ({ ...h, _type: 'history' })),
            ].sort((a, b) => new Date(a.at) - new Date(b.at));

            if (!merged.length) return '<div style="font-size:12px;color:var(--gray-400);padding:14px 16px;">No activity yet</div>';

            return merged.map(entry => {
              if (entry._type === 'comment') {
                const initials = (entry.by||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
                const roleLabel = {admin:'Admin',field_engineer:'Field Engineer',client:'Client',readonly:'Read Only'}[entry.by_role]||entry.by_role||'';
                return `
                  <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-bottom:1px solid var(--gray-100);">
                    <div style="width:30px;height:30px;border-radius:50%;background:var(--hitachi-red);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${initials}</div>
                    <div style="flex:1;min-width:0;">
                      <div style="font-size:12px;font-weight:600;color:var(--gray-800);">${escapeHtml(entry.by)} <span style="font-weight:400;color:var(--gray-500);">· ${roleLabel} · ${dateAgo(entry.at)}</span></div>
                      <div style="font-size:13px;color:var(--gray-700);margin-top:3px;white-space:pre-wrap;">${escapeHtml(entry.text)}</div>
                    </div>
                    <span style="font-size:10px;background:#fef3e0;color:var(--warn);padding:2px 6px;border-radius:8px;flex-shrink:0;font-weight:600;">Comment</span>
                  </div>`;
              } else {
                return `
                  <div style="display:flex;gap:10px;align-items:flex-start;padding:9px 14px;border-bottom:1px solid var(--gray-100);background:var(--gray-50);">
                    <div style="width:8px;height:8px;border-radius:50%;background:var(--hitachi-red);margin-top:4px;flex-shrink:0;"></div>
                    <div style="flex:1;min-width:0;font-size:12px;">
                      <span style="font-weight:600;color:var(--gray-800);">${escapeHtml(entry.action)}</span>
                      <span style="color:var(--gray-500);"> · ${escapeHtml(entry.by||'')} · ${dateAgo(entry.at)}</span>
                      ${(entry.changes||[]).length ? `<ul style="margin:4px 0 0 0;padding-left:14px;color:var(--gray-600);">${entry.changes.map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
                      ${entry.note ? `<div style="color:var(--gray-600);margin-top:2px;">Note: ${escapeHtml(entry.note)}</div>` : ''}
                    </div>
                    <span style="font-size:10px;background:var(--gray-200);color:var(--gray-700);padding:2px 6px;border-radius:8px;flex-shrink:0;font-weight:600;">Action</span>
                  </div>`;
              }
            }).join('');
          })()}
        </div>

        ${canComment ? `
          <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;">
            <textarea id="punch-comment-input-${id}" class="form-input" rows="2" placeholder="Write a comment…" style="flex:1;font-size:13px;resize:none;"></textarea>
            <button class="form-submit" style="white-space:nowrap;height:fit-content;" onclick="addPunchComment('${id}')">Post</button>
          </div>` : ''}
      </div>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Close</button>
      <button class="form-secondary" onclick="exportPunchPDF(['${p.id}'])">⬇ Export PDF</button>
      ${p.is_deleted
        ? `<button class="form-secondary" onclick="restorePunch('${p.id}')">Restore from Bin</button>`
        : `<button class="form-secondary" style="color:var(--bad);" onclick="softDeletePunch('${p.id}')">Move to Bin</button>`}
      ${p.status !== 'closed' ? `<button class="form-submit" onclick="closeModal();openEditPunchModal('${p.id}')">Edit</button>` : ''}
    `,
  });
}

async function advancePunchStatus(id, newStatus) {
  const p = PUNCH_DB.find(x => x.id === id);
  if (!p) return;
  const oldLabel = PL_STATUS_LABELS[p.status] || p.status;
  const newLabel = PL_STATUS_LABELS[newStatus] || newStatus;
  const histEntry = {
    action: `Status: ${oldLabel} → ${newLabel}`,
    by: currentRoleUser.name,
    at: new Date().toISOString(),
  };
  const updates = {
    status: newStatus,
    history: [...(p.history||[]), histEntry],
    updated_at: new Date().toISOString(),
  };
  if (newStatus === 'closed') {
    updates.closed_at = new Date().toISOString();
    updates.closed_by = currentRoleUser.name;
  }
  const { error } = await _sb.from('punch_items').update(updates).eq('id', id);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  Object.assign(p, updates);
  toast(`${newLabel}`, 'success');
  closeModal();
  openPunchDetail(id);
  renderPunchWorkflow();
}

async function addPunchComment(id) {
  const input = document.getElementById(`punch-comment-input-${id}`);
  const text = input?.value.trim();
  if (!text) { toast('Comment cannot be empty', 'error'); return; }
  const p = PUNCH_DB.find(x => x.id === id);
  if (!p) return;
  const comment = {
    id: crypto.randomUUID(),
    text,
    by: currentRoleUser.name,
    by_role: currentRoleUser.role,
    at: new Date().toISOString(),
  };
  const comments = [...(p.comments||[]), comment];
  const { error } = await _sb.from('punch_items').update({ comments }).eq('id', id);
  if (error) { toast('Comment failed: ' + error.message, 'error'); return; }
  p.comments = comments;
  toast('Comment posted', 'success');
  closeModal();
  openPunchDetail(id);
}

async function softDeletePunch(id) {
  if (!confirm('Move to Recycle Bin?')) return;
  const { error } = await _sb.from('punch_items').update({ is_deleted: true }).eq('id', id);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  const p = PUNCH_DB.find(x => x.id === id); if (p) p.is_deleted = true;
  closeModal(); toast('Moved to Recycle Bin', 'success'); renderPunchWorkflow();
}

async function restorePunch(id) {
  const { error } = await _sb.from('punch_items').update({ is_deleted: false }).eq('id', id);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  const p = PUNCH_DB.find(x => x.id === id); if (p) p.is_deleted = false;
  closeModal(); toast('Restored', 'success'); renderPunchWorkflow();
}

function _punchFormHTML(p) {
  const phases  = LOCS.filter(l => l.level === 1).sort((a,b) => a.sort_order - b.sort_order);
  const locs    = p?.phase ? LOCS.filter(l => l.level === 2 && l.parent_id === p.phase) : [];
  const v   = (id) => p ? escapeHtml(p[id]||'') : '';
  const sel = (id, val) => p?.[id] === val ? 'selected' : '';
  const fOpts = (key, selVal) => (_fsCfg(key).length ? _fsCfg(key) : []).map(o => `<option ${o===selVal?'selected':''}>${escapeHtml(o)}</option>`).join('');
  return `
    <div class="form-grid">
      <div class="form-field form-field-full">
        <label>Title *</label>
        <input type="text" id="np-title" class="form-input" placeholder="Describe the punch item" value="${v('title')}">
      </div>
      <div class="form-field">
        <label>Type *</label>
        <select id="np-type" class="form-input">
          <option value="">Select…</option>
          ${fOpts('punch_type', p?.type)||['Defect','Issue','NCR','Observation','RFI'].map(t=>`<option ${sel('type',t)}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Priority *</label>
        <select id="np-priority" class="form-input">
          ${((_fsCfg('priority').length ? _fsCfg('priority') : ['Low','Medium','High','Critical'])
            .map(t=>`<option ${sel('priority',t)||(!p&&t==='Medium'?'selected':'')}>${t}</option>`)).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Punch Item Manager * <span style="font-weight:400;color:var(--gray-500);font-size:11px;">(Admin users)</span></label>
        ${_taHTMLSingle('np-pim','admin')}
      </div>
      <div class="form-field">
        <label>Final Approver <span style="font-weight:400;color:var(--gray-500);font-size:11px;">(Admin / Client)</span></label>
        ${_taHTMLSingle('np-approver','admin_client')}
      </div>
      <div class="form-field form-field-full">
        <label>Assignees</label>
        ${_taHTML('np-assignees', false)}
      </div>
      <div class="form-field form-field-full">
        <label>Distribution List</label>
        ${_taHTML('np-distlist', false)}
      </div>
      <div class="form-field">
        <label>Phase</label>
        <select id="np-phase" class="form-input" onchange="npFilterLoc()">
          <option value="">Select phase…</option>
          ${phases.map(ph=>`<option value="${ph.id}" ${p?.phase===ph.id?'selected':''}>${escapeHtml(ph.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Location</label>
        <select id="np-location" class="form-input">
          ${locs.length ? '<option value="">Select location…</option>'+locs.map(l=>`<option value="${l.id}" ${p?.location===l.id?'selected':''}>${escapeHtml(l.name)}</option>`).join('')
            : '<option value="">Select phase first…</option>'}
        </select>
      </div>
      <div class="form-field">
        <label>Subsystem</label>
        <select id="np-subsystem" class="form-input">
          <option value="">Select…</option>
          ${(_fsCfg('punch_subsystem').length ? _fsCfg('punch_subsystem') : SUBSYSTEMS_LIST).map(s=>`<option ${sel('subsystem',s)}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Schedule Impact</label>
        <select id="np-schedule" class="form-input">
          <option value="">None</option>
          ${(_fsCfg('schedule_impact').length ? _fsCfg('schedule_impact') : ['Minor','Moderate','Major','Critical']).map(s=>`<option ${sel('schedule_impact',s)}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Due Date</label>
        <input type="date" id="np-due" class="form-input" value="${v('due_date')}">
      </div>
      <div class="form-field form-field-full">
        <label>Description</label>
        <textarea id="np-desc" class="form-input" rows="4" placeholder="Describe the issue in detail…">${v('description')}</textarea>
      </div>
      <div class="form-field">
        <label>Category of Failure</label>
        <select id="np-cat" class="form-input">
          <option value="">Select…</option>
          ${(_fsCfg('category_of_failure').length ? _fsCfg('category_of_failure') : ['Hardware Failure','Software Defect','Procedure Issue','Documentation Error','Integration Issue','Environmental','Design Issue','Other']).map(s=>`<option ${sel('category_of_failure',s)}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Type of Failure</label>
        <select id="np-failtype" class="form-input">
          <option value="">Select…</option>
          ${(_fsCfg('type_of_failure').length ? _fsCfg('type_of_failure') : ['First Occurrence','Repeat Failure','Systematic Issue']).map(s=>`<option ${sel('type_of_failure',s)}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>RTC / Work Item ID</label>
        <input type="text" id="np-rtc" class="form-input" placeholder="e.g. RTC-12345" value="${v('rtc_work_item_id')}">
      </div>
      <div class="form-field" style="display:flex;align-items:center;gap:8px;padding-top:24px;">
        <input type="checkbox" id="np-private" style="width:16px;height:16px;" ${p?.is_private?'checked':''}>
        <label for="np-private" style="cursor:pointer;font-size:13px;">Private — visible to assignees and managers only</label>
      </div>
    </div>
  `;
}

function npFilterLoc() {
  const phaseId = document.getElementById('np-phase')?.value;
  const locSel  = document.getElementById('np-location');
  if (!locSel) return;
  const children = phaseId ? LOCS.filter(l => l.parent_id === phaseId).sort((a,b)=>a.sort_order-b.sort_order) : [];
  locSel.innerHTML = children.length
    ? '<option value="">Select location…</option>' + children.map(l=>`<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')
    : '<option value="">Select phase first…</option>';
}

function openNewPunchModal() {
  modal({
    title: 'New Punch List Item',
    size: 'large',
    body: _punchFormHTML(null),
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-secondary" onclick="saveNewPunchItem(true)">Save &amp; Create New</button>
      <button class="form-submit" onclick="saveNewPunchItem(false)">Save</button>
    `,
  });
  setTimeout(() => {
    _taInitField('np-assignees', [], false);
    _taInitField('np-distlist', [], false);
    _taInitSingle('np-pim', currentRoleUser?.name || '');
    _taInitSingle('np-approver', '');
  }, 30);
}

function openEditPunchModal(id) {
  const p = PUNCH_DB.find(x => x.id === id);
  if (!p) return;
  modal({
    title: `Edit Punch #${p.number}`,
    size: 'large',
    body: _punchFormHTML(p),
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" onclick="saveEditPunchItem('${id}')">Save Changes</button>
    `,
  });
  setTimeout(() => {
    _taInitField('np-assignees', p.assignees || [], false);
    _taInitField('np-distlist', p.distribution_list || [], false);
    _taInitSingle('np-pim', p.punch_item_manager || '');
    _taInitSingle('np-approver', p.final_approver || '');
  }, 30);
}

function _readPunchForm() {
  return {
    title:              document.getElementById('np-title').value.trim(),
    type:               document.getElementById('np-type').value,
    priority:           document.getElementById('np-priority').value,
    punch_item_manager: document.getElementById('np-pim').value.trim(),
    final_approver:     document.getElementById('np-approver').value.trim(),
    assignees:          document.getElementById('np-assignees').value.split(',').map(s=>s.trim()).filter(Boolean),
    distribution_list:  document.getElementById('np-distlist').value.split(',').map(s=>s.trim()).filter(Boolean),
    phase:              document.getElementById('np-phase').value || null,
    location:           document.getElementById('np-location').value || null,
    subsystem:          document.getElementById('np-subsystem').value || null,
    schedule_impact:    document.getElementById('np-schedule').value || null,
    due_date:           document.getElementById('np-due').value || null,
    description:        document.getElementById('np-desc').value.trim(),
    category_of_failure:document.getElementById('np-cat').value || null,
    type_of_failure:    document.getElementById('np-failtype').value || null,
    rtc_work_item_id:   document.getElementById('np-rtc').value.trim() || null,
    is_private:         document.getElementById('np-private').checked,
  };
}

async function saveNewPunchItem(createAnother) {
  try {
    const form = _readPunchForm();
    if (!form.title)               { toast('Title is required', 'error'); return; }
    if (!form.type)                { toast('Type is required', 'error'); return; }
    if (!form.punch_item_manager)  { toast('Punch Item Manager is required', 'error'); return; }

    const nums = PUNCH_DB.map(p => p.number || 0);
    const nextNum = nums.length ? Math.max(...nums) + 1 : 1;
    // If creator IS the PIM, item starts as Initiated; otherwise Draft
    const initialStatus = form.punch_item_manager === currentRoleUser.name ? 'initiated' : 'draft';
    const row = {
      ...form, number: nextNum, status: initialStatus,
      ball_in_court: form.punch_item_manager || null,
      created_by: currentRoleUser.name,
      date_notified: new Date().toISOString(),
      is_deleted: false,
      comments: [],
      history: [{ action: 'Created', by: currentRoleUser.name, at: new Date().toISOString() }],
    };
    const { data, error } = await _sb.from('punch_items').insert(row).select().single();
    if (error) { toast('Save failed: ' + error.message, 'error'); return; }
    PUNCH_DB.unshift(data);
    logAudit('Punch Created', `#${nextNum} ${form.title}`);
    toast(`Punch #${nextNum} created`, 'success');
    if (createAnother) { closeModal(); openNewPunchModal(); }
    else { closeModal(); renderPunchWorkflow(); }
  } catch (err) {
    toast('Unexpected error: ' + err.message, 'error');
    console.error('saveNewPunchItem error:', err);
  }
}

function _punchFieldDiff(oldP, newForm) {
  const track = [
    ['title','Title'],['type','Type'],['priority','Priority'],
    ['punch_item_manager','Punch Item Manager'],['final_approver','Final Approver'],
    ['subsystem','Subsystem'],['schedule_impact','Schedule Impact'],
    ['due_date','Due Date'],['description','Description'],
    ['category_of_failure','Category of Failure'],['type_of_failure','Type of Failure'],
    ['rtc_work_item_id','RTC ID'],['is_private','Private'],
  ];
  const changes = [];
  for (const [key, label] of track) {
    const o = String(oldP[key] ?? ''), n = String(newForm[key] ?? '');
    if (o !== n) changes.push(`${label}: "${o||'—'}" → "${n||'—'}"`);
  }
  const oA = (oldP.assignees||[]).join(', '), nA = (newForm.assignees||[]).join(', ');
  if (oA !== nA) changes.push(`Assignees: "${oA||'—'}" → "${nA||'—'}"`);
  const oD = (oldP.distribution_list||[]).join(', '), nD = (newForm.distribution_list||[]).join(', ');
  if (oD !== nD) changes.push(`Distribution List: "${oD||'—'}" → "${nD||'—'}"`);
  return changes;
}

async function saveEditPunchItem(id) {
  try {
    const form = _readPunchForm();
    if (!form.title) { toast('Title is required', 'error'); return; }
    const p = PUNCH_DB.find(x => x.id === id);
    if (!p) return;
    const changes = _punchFieldDiff(p, form);
    const histEntry = {
      action: changes.length ? `Edited (${changes.length} change${changes.length>1?'s':''})` : 'Edited (no changes)',
      changes,
      by: currentRoleUser.name,
      at: new Date().toISOString(),
    };
    const updates = { ...form, updated_at: new Date().toISOString(),
      history: [...(p.history||[]), histEntry] };
    const { error } = await _sb.from('punch_items').update(updates).eq('id', id);
    if (error) { toast('Save failed: ' + error.message, 'error'); return; }
    Object.assign(p, updates);
    toast('Punch item updated', 'success');
    closeModal(); openPunchDetail(id);
  } catch (err) {
    toast('Unexpected error: ' + err.message, 'error');
    console.error('saveEditPunchItem error:', err);
  }
}

// ==========================================================================
// PUNCH LIST — CSV IMPORT
// ==========================================================================
function openPunchImportModal() {
  modal({
    title: 'Import Punch Items — CSV',
    size: 'large',
    body: `
      <div style="margin-bottom:16px;">
        <p style="font-size:13px;color:var(--gray-600);margin-bottom:12px;">
          Upload a CSV file to bulk-create punch items. Download the template to see required columns.
        </p>
        <button class="form-secondary" style="font-size:12px;" onclick="downloadPunchTemplate()">⬇ Download CSV Template</button>
      </div>
      <div class="form-field">
        <label>Select CSV File</label>
        <input type="file" id="punch-import-file" accept=".csv" class="form-input" onchange="previewPunchImport(this)">
      </div>
      <div id="punch-import-preview" style="margin-top:16px;"></div>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="form-submit" id="punch-import-btn" onclick="executePunchImport()" disabled>Import</button>
    `,
  });
}

function downloadPunchTemplate() {
  const cols = 'Title,Type,Priority,Phase,Location,Subsystem,Punch Item Manager,Final Approver,Assignees,Distribution List,Due Date,Description,Category of Failure,Type of Failure,Schedule Impact,RTC Work Item ID';
  const ex   = 'Example defect title,Defect,High,Phase 1,W40 Millbrae,DCS,John Smith,Jane Doe,"Alice, Bob","Charlie, Dave",2025-12-31,Detailed description here,Hardware Failure,First Occurrence,Minor,RTC-1234';
  downloadCSV(cols + '\n' + ex, 'punch_import_template.csv');
}

let _punchImportRows = [];

function previewPunchImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const rows = parseCSVGeneric(text);
    if (!rows.length) {
      document.getElementById('punch-import-preview').innerHTML =
        `<div style="color:#dc2626;font-size:13px;">No data rows found in file.</div>`;
      return;
    }
    // Validate and map rows
    _punchImportRows = [];
    const errors = [];
    rows.forEach((row, i) => {
      const title = (row['Title'] || '').trim();
      if (!title) { errors.push(`Row ${i+2}: Title is required`); return; }
      // Resolve phase/location IDs
      let phaseId = null, locId = null;
      const phaseName = (row['Phase'] || '').trim();
      const locName   = (row['Location'] || '').trim();
      if (phaseName) {
        const ph = LOCS.find(l => l.level === 1 && l.name.toLowerCase().includes(phaseName.toLowerCase()));
        if (ph) {
          phaseId = ph.id;
          if (locName) {
            const lo = LOCS.find(l => l.level === 2 && l.parent_id === ph.id && l.name.toLowerCase().includes(locName.toLowerCase()));
            if (lo) locId = lo.id;
            else errors.push(`Row ${i+2}: Location "${locName}" not found under "${ph.name}"`);
          }
        } else {
          errors.push(`Row ${i+2}: Phase "${phaseName}" not found in master list`);
        }
      }
      _punchImportRows.push({
        title, type: row['Type']||null, priority: row['Priority']||'Medium',
        phase: phaseId, location: locId,
        subsystem: row['Subsystem']||null,
        punch_item_manager: row['Punch Item Manager']||null,
        final_approver: row['Final Approver']||null,
        assignees: (row['Assignees']||'').split(',').map(s=>s.trim()).filter(Boolean),
        distribution_list: (row['Distribution List']||'').split(',').map(s=>s.trim()).filter(Boolean),
        due_date: row['Due Date']||null,
        description: row['Description']||null,
        category_of_failure: row['Category of Failure']||null,
        type_of_failure: row['Type of Failure']||null,
        schedule_impact: row['Schedule Impact']||null,
        rtc_work_item_id: row['RTC Work Item ID']||null,
      });
    });
    const preview = document.getElementById('punch-import-preview');
    const importBtn = document.getElementById('punch-import-btn');
    if (errors.length) {
      preview.innerHTML = `
        <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="font-weight:600;font-size:13px;color:#dc2626;margin-bottom:6px;">Validation Errors (${errors.length})</div>
          ${errors.map(e=>`<div style="font-size:12px;color:#b91c1c;">• ${escapeHtml(e)}</div>`).join('')}
        </div>
        ${_punchImportRows.length ? `<div style="font-size:13px;color:var(--gray-600);">${_punchImportRows.length} valid row(s) will be imported.</div>` : ''}
      `;
      importBtn.disabled = _punchImportRows.length === 0;
    } else {
      preview.innerHTML = `
        <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:12px;">
          <div style="font-weight:600;font-size:13px;color:#059669;">${_punchImportRows.length} item(s) ready to import</div>
        </div>
        <div class="data-card" style="padding:0;overflow:hidden;margin-top:12px;max-height:220px;overflow-y:auto;">
          <table class="data-table" style="font-size:12px;">
            <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Priority</th><th>Phase / Location</th></tr></thead>
            <tbody>
              ${_punchImportRows.map((r,i)=>`<tr>
                <td>${i+1}</td><td>${escapeHtml(r.title)}</td>
                <td>${escapeHtml(r.type||'—')}</td><td>${escapeHtml(r.priority)}</td>
                <td>${escapeHtml(_plLocName(r.phase))} / ${escapeHtml(_plLocName(r.location))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
      importBtn.disabled = false;
    }
  };
  reader.readAsText(file);
}

async function executePunchImport() {
  if (!_punchImportRows.length) return;
  const importBtn = document.getElementById('punch-import-btn');
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Importing…'; }
  try {
    const nums = PUNCH_DB.map(p => p.number || 0);
    let nextNum = nums.length ? Math.max(...nums) + 1 : 1;
    let ok = 0, fail = 0;
    for (const row of _punchImportRows) {
      const record = {
        ...row, number: nextNum++,
        status: 'work_required',
        is_deleted: false,
        created_by: currentRoleUser.name,
        date_notified: new Date().toISOString(),
        history: [{ action: 'Created via Import', by: currentRoleUser.name, at: new Date().toISOString() }],
      };
      try {
        const { data, error } = await _sb.from('punch_items').insert(record).select().single();
        if (error) { console.error('Import row failed:', error.message); fail++; }
        else { PUNCH_DB.unshift(data); ok++; }
      } catch (rowErr) {
        console.error('Import row exception:', rowErr.message); fail++;
      }
    }
    toast(`Imported ${ok} item(s)${fail ? `, ${fail} failed — check console` : ''}`, fail && !ok ? 'error' : 'success');
    logAudit('Punch Import', `${ok} items imported`);
    _punchImportRows = [];
    closeModal();
    renderPunchWorkflow();
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
    console.error('executePunchImport error:', err);
    if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'Import'; }
  }
}

// ==========================================================================
// AUDIT LOG
// ==========================================================================
function _auditNormalizeLocal(e) {
  return {
    id: e.id || `local-${e.timestamp || Date.now()}`,
    timestamp: e.timestamp || new Date().toISOString(),
    user: e.user || e.user_name || 'System',
    role: e.role || '',
    action: e.action || 'Audit Event',
    target: e.target || '',
    details: e.details || '',
    notes: e.notes || '',
    source: e.source || 'Portal Audit',
    table: e.table || 'audit_log',
  };
}

function _auditNormalizeStatusHistory(e) {
  return {
    id: `status-${e.id}`,
    timestamp: e.changed_at || new Date().toISOString(),
    user: e.changed_by || 'System',
    role: e.changed_role || '',
    action: 'Test Status Changed',
    target: e.test_case_code || e.test_id || '',
    details: `${e.old_status || '—'} → ${e.new_status || '—'}${e.test_name ? ` · ${e.test_name}` : ''}`,
    notes: [e.source, e.reason, e.notes].filter(Boolean).join(' · '),
    source: e.source || 'Status History',
    table: 'test_item_status_history',
    test_id: e.test_id || '',
    phase: e.phase || '',
    location: e.location || '',
    subsystem: e.subsystem || '',
    activity: e.activity || '',
  };
}

function _auditNormalizeDbChange(e) {
  const recordId = e.record_id || '';
  const changed = Array.isArray(e.changed_columns) && e.changed_columns.length
    ? `Changed: ${e.changed_columns.join(', ')}`
    : '';
  return {
    id: `db-${e.id}`,
    timestamp: e.changed_at || new Date().toISOString(),
    user: e.changed_by || e.actor_email || 'Database',
    role: e.actor_role || '',
    action: `DB ${e.operation || 'CHANGE'}`,
    target: `${e.table_name || ''}${recordId ? `:${recordId}` : ''}`,
    details: changed || e.operation || '',
    notes: e.source || '',
    source: 'DB Trigger',
    table: e.table_name || 'db_change_log',
    record_id: recordId,
    operation: e.operation || '',
  };
}

function _auditEvents() {
  const local = (AUDIT_LOG || []).map(_auditNormalizeLocal);
  return [...DB_AUDIT_EVENTS, ...local]
    .sort((a,b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

async function loadDbAuditEvents() {
  const events = [];
  try {
    const rows = await _dbSelect('audit_log', {}, '*');
    events.push(...(rows || []).map(r => _auditNormalizeLocal({
      id: r.id,
      user: r.user_name,
      role: r.role,
      action: r.action,
      target: r.target,
      details: r.details,
      timestamp: r.timestamp,
      notes: r.notes,
      source: 'DB Audit Log',
      table: 'audit_log',
    })));
  } catch (err) {
    console.warn('[audit] audit_log load skipped:', err.message);
  }
  try {
    const rows = await _dbSelect('test_item_status_history', {}, '*');
    events.push(...(rows || []).map(_auditNormalizeStatusHistory));
  } catch (err) {
    console.warn('[audit] status history load skipped:', err.message);
  }
  try {
    const rows = await _dbSelect('db_change_log', {}, '*');
    events.push(...(rows || []).map(_auditNormalizeDbChange));
  } catch (err) {
    console.warn('[audit] db change log load skipped:', err.message);
  }
  DB_AUDIT_EVENTS = events;
}

async function refreshAuditLog() {
  await loadDbAuditEvents();
  renderAuditLog();
}

function _auditClassName(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function _auditInitials(value) {
  const parts = String(value || 'System').split(/[\s@._-]+/).filter(Boolean);
  return (parts.length ? parts.slice(0, 2).map(p => p[0]).join('') : 'S').toUpperCase();
}

function renderAuditLog() {
  const root = document.getElementById('audit-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') {
    root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`;
    return;
  }
  const entries = _auditEvents();

  root.innerHTML = `
    <div class="data-card">
      <div class="data-card-head">
        <span class="data-count">${entries.length} entries</span>
        <div style="display:flex;gap:8px;">
          <button class="form-secondary" onclick="refreshAuditLog()">Refresh</button>
          <button class="export-btn" onclick="exportAudit()">Export CSV</button>
        </div>
      </div>
      <div class="table-wrap">
        ${entries.map(e => {
          const roleLabel = ROLE_LABELS[e.role] || '';
          const dbRole = roleLabel ? '' : e.role;
          const sourceLabel = e.source || e.table || 'Audit';
          return `
            <div class="audit-row role-${_auditClassName(e.role)} source-${_auditClassName(sourceLabel)}">
              <div class="audit-time">
                <div>${new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                <div class="audit-relative">${dateAgo(e.timestamp)}</div>
              </div>
              <div class="audit-user-card">
                <div class="audit-avatar">${escapeHtml(_auditInitials(e.user))}</div>
                <div class="audit-user-main">
                  <div class="audit-user-name">${escapeHtml(e.user)}</div>
                  <div class="audit-chip-row">
                    ${roleLabel ? `<span class="role-mini">${escapeHtml(roleLabel)}</span>` : ''}
                    ${dbRole ? `<span class="audit-db-role">${escapeHtml(dbRole)}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="audit-action-card">
                <div class="audit-action">${escapeHtml(e.action)}</div>
                <span class="audit-source-chip">${escapeHtml(sourceLabel)}</span>
              </div>
              <div class="audit-event-body">
                <div class="audit-target">${escapeHtml(e.target)}</div>
                <div class="audit-details">${escapeHtml(e.details)}${e.notes ? ` · "${escapeHtml(e.notes)}"` : ''}</div>
                <div class="audit-details audit-table-line">${escapeHtml(e.table || '')}</div>
              </div>
            </div>
          `;
        }).join('') || `<div class="docs-empty"><h3>No audit events found</h3></div>`}
      </div>
    </div>
  `;
}

function exportAudit() {
  const cols = [
    { key: 'timestamp', label: 'Timestamp' },
    { key: 'user', label: 'User' },
    { key: 'role', label: 'Role' },
    { key: 'action', label: 'Action' },
    { key: 'target', label: 'Target' },
    { key: 'details', label: 'Details' },
    { key: 'notes', label: 'Notes' },
  ];
  downloadCSV(toCSV(_auditEvents(), cols), 'audit_log.csv');
}

// ==========================================================================
// TEST REPORTS — loader & CRUD
// ==========================================================================
async function loadTestReports() {
  try {
    const data = await _fetchCurrentAuth('test_reports?select=*&order=created_at.asc');
    _testReports = data || [];
  } catch(e) { console.warn('[loadTestReports] failed:', e.message); }
}

async function loadActivityRecords() {
  try {
    const data = await _fetchAnon('activity_records?select=*');
    _activityRecords = data || [];
  } catch(e) { console.warn('[loadActivityRecords] failed:', e.message); }
}

// ── P6 data loader ────────────────────────────────────────────────────────────
async function loadP6Data() {
  try {
    const [batches, acts, map, patterns, dismissals] = await Promise.all([
      _fetchAnon('p6_import_batches?select=*&order=imported_at.desc'),
      _fetchAnon('p6_activities?select=*&order=p6_location_code.asc,p6_name.asc'),
      _fetchAnon('p6_activity_map?select=*'),
      _fetchAnon('p6_learn_patterns?select=*&order=confidence.desc'),
      _fetchAnon('p6_activity_dismissals?select=*'),
    ]);
    P6_BATCHES    = batches    || [];
    P6_ACTS       = acts       || [];
    P6_MAP        = map        || [];
    P6_PATTERNS   = patterns   || [];
    P6_DISMISSALS = dismissals || [];
  } catch(e) { console.warn('[loadP6Data] failed:', e.message); }
}

const TR_STATUSES = ['Not Started','In Review','Accepted','Accepted as Noted','Accepted as Noted Resubmit','Resubmit','Rejected'];

const TRP_SOURCE_LABELS = {
  'master-linked': 'Master + TI',
  'master-only': 'Master Only',
  derived: 'Referenced from Test Items',
};

function _trpCanManage() {
  return ['admin', 'field_engineer'].includes(currentRoleUser?.role);
}

function _trpCanView() {
  return ['admin', 'field_engineer', 'client', 'readonly'].includes(currentRoleUser?.role);
}

function _trpCleanReportValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function _trpReportKey(value) {
  const clean = _trpCleanReportValue(value);
  if (!clean) return '';
  return clean
    .replace(/^CDRL[\s#:.\-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function _trpInferCdrlNumber(value) {
  const clean = _trpCleanReportValue(value);
  if (!clean) return null;
  if (/^CDRL\b/i.test(clean) || /^\d+(\.\d+)+/.test(clean)) return clean;
  return null;
}

function _trpRecordKeys(r) {
  return [...new Set([r?.cdrl_number, r?.title].map(_trpReportKey).filter(Boolean))];
}

function _trpFindRecordByText(value) {
  const key = _trpReportKey(value);
  if (!key) return null;
  return _testReports.find(r => _trpRecordKeys(r).includes(key)) || null;
}

function _trpReportLabel(r) {
  return [r.cdrl_number, r.title, r.revision ? `Rev ${r.revision}` : ''].filter(Boolean).join(' · ');
}

function _trpFindRecordForActivity(act) {
  const id = act?.items?.find(t => t.TestReportID)?.TestReportID;
  if (id) {
    const byId = _testReports.find(r => String(r.id) === String(id));
    if (byId) return byId;
  }
  return _trpFindRecordByText(act?.testReport || '');
}

function _trpReportSelectHTML(selectedId, customValue) {
  const sorted = [..._testReports].sort((a, b) =>
    _trpReportLabel(a).localeCompare(_trpReportLabel(b), undefined, { numeric: true, sensitivity: 'base' })
  );
  return `
    <select id="am-edit-report-id" class="form-input" onchange="_amToggleCustomReport()">
      <option value="" ${!selectedId && !customValue ? 'selected' : ''}>— No Report —</option>
      <option value="__custom__" ${customValue ? 'selected' : ''}>— Enter Manually —</option>
      ${sorted.map(r => `<option value="${escapeHtml(r.id)}" ${String(selectedId || '') === String(r.id) ? 'selected' : ''}>${escapeHtml(_trpReportLabel(r))}</option>`).join('')}
    </select>
    <input type="text" id="am-edit-report" class="form-input" style="margin-top:8px;${customValue ? '' : 'display:none;'}" placeholder="e.g. CDRL 9.05.25" value="${escapeHtml(customValue || '')}">
  `;
}

function _amToggleCustomReport() {
  const mode = document.getElementById('am-edit-report-id')?.value || '';
  const input = document.getElementById('am-edit-report');
  if (!input) return;
  input.style.display = mode === '__custom__' ? '' : 'none';
  if (mode !== '__custom__') input.value = '';
}

function _trpReportLinkFromModal() {
  const selectedReportId = document.getElementById('am-edit-report-id')?.value || '';
  const selectedReport = selectedReportId && selectedReportId !== '__custom__'
    ? _testReports.find(r => String(r.id) === String(selectedReportId))
    : null;
  const customReport = document.getElementById('am-edit-report')?.value.trim() || null;
  const report = selectedReport
    ? (selectedReport.cdrl_number || selectedReport.title || null)
    : (selectedReportId === '__custom__' ? customReport : null);
  return {
    report,
    reportId: selectedReport?.id || null,
    record: selectedReport,
    mode: selectedReport ? 'record' : (selectedReportId === '__custom__' ? 'custom' : 'none'),
    label: selectedReport ? _trpReportLabel(selectedReport) : (report || 'No Report'),
  };
}

function _trpReportLinkFromRecord(report) {
  if (!report) return { report: null, reportId: null, record: null, mode: 'none', label: 'No Report' };
  return {
    report: report.cdrl_number || report.title || null,
    reportId: report.id || null,
    record: report,
    mode: 'record',
    label: _trpReportLabel(report),
  };
}

async function _trpResolveReportLink(link, context = {}) {
  if (!link?.report || link.mode !== 'custom') return link;
  const existing = _trpFindRecordByText(link.report);
  if (existing) return _trpReportLinkFromRecord(existing);
  const title = _trpCleanReportValue(link.report);
  if (!title) return { report: null, reportId: null, record: null, mode: 'none', label: 'No Report' };
  const payload = {
    title,
    cdrl_number: _trpInferCdrlNumber(title),
    revision: 'A',
    status: 'Not Started',
    phase: context.phase || null,
    location: context.location || null,
    subsystem: context.subsystem || null,
    notes: context.activity ? `Created from Activity Edit: ${context.activity}` : 'Created from Activity Edit',
    created_by: currentRoleUser?.name,
    updated_by: currentRoleUser?.name,
    updated_at: new Date().toISOString(),
  };
  const inserted = await _dbInsert('test_reports', [payload]);
  if (!inserted?.length) throw new Error('No report row was created. Check test_reports RLS INSERT policy.');
  _testReports.push(...inserted);
  logAudit('Test Report Created', title, `Manual report created from Activity Edit${context.activity ? ` · ${context.activity}` : ''}`);
  return _trpReportLinkFromRecord(inserted[0]);
}

function _trpCurrentActivityReportLink(act) {
  const selectedReport = _trpFindRecordForActivity(act);
  const itemReportId = act?.items?.find(t => t.TestReportID)?.TestReportID || null;
  const itemReport = act?.testReport || act?.items?.find(t => t.TestReport)?.TestReport || null;
  const report = selectedReport ? (selectedReport.cdrl_number || selectedReport.title || null) : itemReport;
  return {
    report,
    reportId: selectedReport?.id || itemReportId || null,
    record: selectedReport || null,
    mode: selectedReport ? 'record' : (itemReport ? 'custom' : 'none'),
    label: selectedReport ? _trpReportLabel(selectedReport) : (itemReport || 'No Report'),
  };
}

function _trpReportLinkPatch(link) {
  return {
    test_report: link?.report || null,
    test_report_id: link?.reportId || null,
  };
}

function _trpApplyReportLinkToItems(items, link) {
  (items || []).forEach(r => {
    r.TestReport = link?.report || null;
    r.TestReportID = link?.reportId || null;
  });
}

function _trpReportLinkChanged(before, after) {
  return String(before?.reportId || '') !== String(after?.reportId || '') ||
    _trpCleanReportValue(before?.report || '') !== _trpCleanReportValue(after?.report || '');
}

function _trpReportLinkAuditDetails(before, after, count) {
  if (!_trpReportLinkChanged(before, after)) return '';
  const itemText = `${count} test case${count===1?'':'s'}`;
  const beforeLabel = before?.label || 'No Report';
  const afterLabel = after?.label || 'No Report';
  if ((before?.mode || 'none') === 'none' && (after?.mode || 'none') !== 'none') return `Linked ${itemText} to ${afterLabel}${after?.mode === 'custom' ? ' (manual)' : ''}`;
  if ((before?.mode || 'none') !== 'none' && (after?.mode || 'none') === 'none') return `Unlinked ${itemText} from ${beforeLabel}`;
  return `Changed ${itemText}: ${beforeLabel} → ${afterLabel}${after?.mode === 'custom' ? ' (manual)' : ''}`;
}

function _trpReportLinkAuditAction(before, after) {
  if (!_trpReportLinkChanged(before, after)) return '';
  if ((before?.mode || 'none') === 'none' && (after?.mode || 'none') !== 'none') return 'Test Report Linked';
  if ((before?.mode || 'none') !== 'none' && (after?.mode || 'none') === 'none') return 'Test Report Unlinked';
  return 'Test Report Changed';
}

function _trpLogActivityReportLinkChange(activityName, before, after, count, context = '') {
  const action = _trpReportLinkAuditAction(before, after);
  if (!action) return;
  const details = [_trpReportLinkAuditDetails(before, after, count), context].filter(Boolean).join(' · ');
  logAudit(action, activityName, details);
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

function _trpBuildLinkMap() {
  const map = new Map();
  TI.forEach(r => {
    const byId = r.TestReportID ? _testReports.find(rep => String(rep.id) === String(r.TestReportID)) : null;
    const raw = _trpCleanReportValue(r.TestReport || byId?.cdrl_number || byId?.title);
    const key = byId ? `id:${byId.id}` : _trpReportKey(raw);
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        key,
        reportId: byId?.id || null,
        display: raw || byId?.cdrl_number || byId?.title || '',
        rawValues: new Map(),
        items: [],
        activityMap: new Map(),
        phases: new Set(),
        locations: new Set(),
        subsystems: new Set(),
      });
    }
    const link = map.get(key);
    link.items.push(r);
    link.rawValues.set(raw, (link.rawValues.get(raw) || 0) + 1);
    const phase = r.Phase || '-';
    const location = r.Location || '-';
    const subsystem = r.Subsystem || '-';
    const activity = r.Activity || '-';
    const activityKey = `${phase}||${location}||${subsystem}||${activity}`;
    if (!link.activityMap.has(activityKey)) {
      link.activityMap.set(activityKey, { key: activityKey, phase, location, subsystem, activity, items: [] });
    }
    link.activityMap.get(activityKey).items.push(r);
    if (phase && phase !== '-') link.phases.add(phase);
    if (location && location !== '-') link.locations.add(location);
    if (subsystem && subsystem !== '-') link.subsystems.add(subsystem);
  });

  map.forEach(link => {
    let bestValue = link.display;
    let bestCount = 0;
    link.rawValues.forEach((count, value) => {
      if (count > bestCount) { bestValue = value; bestCount = count; }
    });
    link.display = bestValue;
    link.activities = [...link.activityMap.values()].map(act => ({
      ...act,
      counts: _trpStatusCounts(act.items),
    })).sort((a, b) =>
      `${a.phase} ${a.location} ${a.subsystem} ${a.activity}`.localeCompare(
        `${b.phase} ${b.location} ${b.subsystem} ${b.activity}`,
        undefined,
        { numeric: true, sensitivity: 'base' }
      )
    );
    link.activityCount = link.activities.length;
    link.testCaseCount = link.items.length;
    link.counts = _trpStatusCounts(link.items);
    link.phases = [...link.phases].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    link.locations = [...link.locations].sort();
    link.subsystems = [...link.subsystems].sort();
  });
  return map;
}

function _trpEmptyLink(key, display) {
  return {
    key,
    display,
    items: [],
    activities: [],
    activityCount: 0,
    testCaseCount: 0,
    counts: _trpStatusCounts([]),
    phases: [],
    locations: [],
    subsystems: [],
  };
}

function _trpMergeLinksForKeys(keys, linkMap, display) {
  const matches = keys.map(k => linkMap.get(k)).filter(Boolean);
  if (!matches.length) return _trpEmptyLink(keys[0] || '', display || '');
  const itemMap = new Map();
  const activityMap = new Map();
  const phases = new Set();
  const locations = new Set();
  const subsystems = new Set();
  matches.forEach(link => {
    link.items.forEach(item => itemMap.set(String(item.TestID || `${item.TestCaseCode}-${item.TestName}`), item));
    link.activities.forEach(act => {
      if (!activityMap.has(act.key)) {
        activityMap.set(act.key, { key: act.key, phase: act.phase, location: act.location, subsystem: act.subsystem, activity: act.activity, items: [] });
      }
      const target = activityMap.get(act.key);
      const seen = new Set(target.items.map(item => String(item.TestID || `${item.TestCaseCode}-${item.TestName}`)));
      act.items.forEach(item => {
        const id = String(item.TestID || `${item.TestCaseCode}-${item.TestName}`);
        if (!seen.has(id)) {
          target.items.push(item);
          seen.add(id);
        }
      });
    });
    link.phases.forEach(v => phases.add(v));
    link.locations.forEach(v => locations.add(v));
    link.subsystems.forEach(v => subsystems.add(v));
  });
  const items = [...itemMap.values()];
  const activities = [...activityMap.values()].map(act => ({ ...act, counts: _trpStatusCounts(act.items) })).sort((a, b) =>
    `${a.phase} ${a.location} ${a.subsystem} ${a.activity}`.localeCompare(
      `${b.phase} ${b.location} ${b.subsystem} ${b.activity}`,
      undefined,
      { numeric: true, sensitivity: 'base' }
    )
  );
  return {
    key: keys[0] || matches[0].key,
    display: matches[0].display || display || '',
    items,
    activities,
    activityCount: activities.length,
    testCaseCount: items.length,
    counts: _trpStatusCounts(items),
    phases: [...phases].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    locations: [...locations].sort(),
    subsystems: [...subsystems].sort(),
  };
}

function _trpRowFromRecord(r, link) {
  const subsystems = [...new Set([r.subsystem, ...(link.subsystems || [])].filter(Boolean))].sort();
  const phases = [...new Set([r.phase, ...(link.phases || [])].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const locations = [...new Set([r.location, ...(link.locations || [])].filter(Boolean))].sort();
  return {
    uid: r.id,
    id: r.id,
    record: r,
    isDerived: false,
    source: link.testCaseCount ? 'master-linked' : 'master-only',
    sourceLabel: link.testCaseCount ? TRP_SOURCE_LABELS['master-linked'] : TRP_SOURCE_LABELS['master-only'],
    key: _trpRecordKeys(r)[0] || r.id,
    title: r.title || r.cdrl_number || 'Untitled Test Report',
    cdrl_number: r.cdrl_number || '',
    revision: r.revision || 'A',
    status: r.status || 'Not Started',
    phase: r.phase || _trpSummaryValue(link.phases),
    location: r.location || _trpSummaryValue(link.locations),
    subsystem: r.subsystem || '',
    subsystems,
    notes: r.notes || '',
    parent_id: r.parent_id || null,
    created_by: r.created_by || '',
    created_at: r.created_at || '',
    updated_by: r.updated_by || '',
    updated_at: r.updated_at || '',
    activities: link.activities || [],
    activityCount: link.activityCount || 0,
    testCaseCount: link.testCaseCount || 0,
    counts: link.counts || _trpStatusCounts([]),
    phases,
    locations,
  };
}

function _trpRowFromLink(link) {
  const title = link.display || 'Untitled Test Report';
  const cdrl = _trpInferCdrlNumber(title) || '';
  const subsystem = link.subsystems.length === 1 ? link.subsystems[0] : '';
  const phase = _trpSummaryValue(link.phases);
  const location = _trpSummaryValue(link.locations);
  return {
    uid: `derived:${link.key}`,
    id: null,
    record: null,
    isDerived: true,
    source: 'derived',
    sourceLabel: TRP_SOURCE_LABELS.derived,
    key: link.key,
    title,
    cdrl_number: cdrl,
    revision: 'A',
    status: 'Not Started',
    phase,
    location,
    subsystem,
    subsystems: link.subsystems || [],
    notes: 'Referenced from Test Items',
    parent_id: null,
    created_by: '',
    created_at: '',
    updated_by: '',
    updated_at: '',
    activities: link.activities || [],
    activityCount: link.activityCount || 0,
    testCaseCount: link.testCaseCount || 0,
    counts: link.counts || _trpStatusCounts([]),
    phases: link.phases || [],
    locations: link.locations || [],
  };
}

function _trpBuildReportRows() {
  const linkMap = _trpBuildLinkMap();
  const matchedLinkKeys = new Set();
  const rows = [];

  _testReports.forEach(r => {
    const keys = [`id:${r.id}`, ..._trpRecordKeys(r)];
    const link = _trpMergeLinksForKeys(keys, linkMap, r.title || r.cdrl_number || '');
    keys.forEach(k => { if (linkMap.has(k)) matchedLinkKeys.add(k); });
    rows.push(_trpRowFromRecord(r, link));
  });

  linkMap.forEach((link, key) => {
    if (!matchedLinkKeys.has(key)) rows.push(_trpRowFromLink(link));
  });

  return rows.sort((a, b) => {
    const nameCmp = (a.cdrl_number || a.title || '').localeCompare(b.cdrl_number || b.title || '', undefined, { numeric: true, sensitivity: 'base' });
    if (nameCmp) return nameCmp;
    const revCmp = String(a.revision || '').localeCompare(String(b.revision || ''), undefined, { numeric: true, sensitivity: 'base' });
    if (revCmp) return revCmp;
    return String(a.id || a.uid).localeCompare(String(b.id || b.uid));
  });
}

function _trpDecodeUid(uid) {
  try { return decodeURIComponent(uid); }
  catch { return uid; }
}

function _trpFindReportRow(uid) {
  const decoded = _trpDecodeUid(uid);
  return _trpBuildReportRows().find(r => r.uid === decoded || r.id === decoded);
}

function _trpRowMatches(row, filters) {
  const search = _trpCleanReportValue(filters.search).toLowerCase();
  if (search) {
    const haystack = [
      row.title, row.cdrl_number, row.revision, row.status, row.subsystem, row.notes,
      row.created_by, row.updated_by, row.sourceLabel,
      ...row.activities.flatMap(a => [a.activity, a.phase, a.location, a.subsystem]),
      ...row.activities.flatMap(a => a.items.map(t => `${t.TestCaseCode || ''} ${t.TestName || ''}`)),
    ].join(' ').toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  if (filters.status && row.status !== filters.status) return false;
  if (filters.subsystem && !row.subsystems.includes(filters.subsystem) && row.subsystem !== filters.subsystem) return false;
  if (filters.phase && !row.phases.includes(filters.phase)) return false;
  if (filters.location && !row.locations.includes(filters.location)) return false;
  return true;
}

function _trpFilteredRows(rows, ignoreKey = '') {
  const filters = { ..._trpFilters };
  if (ignoreKey) filters[ignoreKey] = '';
  return rows.filter(row => _trpRowMatches(row, filters));
}

function _trpFilterOptions(rows, key) {
  const values = new Set();
  _trpFilteredRows(rows, key).forEach(row => {
    if (key === 'status' && row.status) values.add(row.status);
    if (key === 'subsystem') [row.subsystem, ...row.subsystems].filter(Boolean).forEach(v => values.add(v));
    if (key === 'phase') row.phases.forEach(v => values.add(v));
    if (key === 'location') row.locations.forEach(v => values.add(v));
  });
  return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function _trpSetFilter(key, value) {
  _trpFilters[key] = value;
  // Cascade: phase change resets location; location change resets (non-locked) subsystem
  if (key === 'phase')    _trpFilters.location = '';
  if (key === 'location') _trpFilters.subsystem = currentRoleUser?.subsystem || '';
  renderTestReporting();
}

function _trpSetSearch(value) {
  _trpFilters.search = value;
  clearTimeout(_trpSearchTimer);
  _trpSearchTimer = setTimeout(renderTestReporting, 180);
}

function _trpClearFilters() {
  const userSub = currentRoleUser?.subsystem || '';
  _trpFilters = { search:'', status:'', subsystem: userSub, phase:'', location:'' };
  renderTestReporting();
}

function _trStatusBadge(s) {
  const map = {
    'Not Started':                'badge-notstarted',
    'In Review':                  'badge-review',
    'Accepted':                   'badge-accepted',
    'Accepted as Noted':          'badge-accepted',
    'Accepted as Noted Resubmit': 'badge-resubmit',
    'Resubmit':                   'badge-resubmit',
    'Rejected':                   'badge-rejected',
  };
  return `<span class="badge ${map[s]||'badge-notstarted'}">${escapeHtml(s||'Not Started')}</span>`;
}

function _trpStatusOptions(currentVal) {
  const current = _trpCleanReportValue(currentVal);
  const statuses = [...TR_STATUSES];
  if (current && !statuses.includes(current)) statuses.unshift(current);
  return statuses;
}

function _trpStatusSummaryHTML(counts) {
  return `
    <div class="trp-status-counts">
      <span class="trp-count trp-count-pass">P ${counts.passed}</span>
      <span class="trp-count trp-count-fail">F ${counts.failed}</span>
      <span class="trp-count trp-count-block">B ${counts.blocked}</span>
      <span class="trp-count trp-count-progress">IP ${counts.inProgress}</span>
    </div>
  `;
}

function _trpStatusSummaryFullHTML(counts) {
  return `
    <div class="trp-status-counts trp-status-counts-full">
      <span class="trp-count trp-count-pass">Passed: ${counts.passed}</span>
      <span class="trp-count trp-count-fail">Failed: ${counts.failed}</span>
      <span class="trp-count trp-count-block">Blocked: ${counts.blocked}</span>
      <span class="trp-count trp-count-progress">In Progress: ${counts.inProgress}</span>
      <span class="trp-count trp-count-future">Future Tests: ${counts.future}</span>
    </div>
  `;
}

function _trpSummaryValue(values, fallback = '') {
  const clean = [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
  if (!clean.length) return fallback || '';
  if (clean.length === 1) return clean[0];
  return `${clean.length} Multiple`;
}

function _trpFormatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function _trpSourceBadge(row) {
  const cls = row.source === 'derived' ? 'badge-review' : row.source === 'master-linked' ? 'badge-accepted' : 'badge-notstarted';
  return `<span class="badge ${cls}">${escapeHtml(row.sourceLabel)}</span>`;
}

function _trpStatusControlHTML(row, canManage) {
  if (!canManage) return _trStatusBadge(row.status);
  const uid = encodeURIComponent(row.uid);
  return `<select class="form-input trp-status-select" onchange="_trpUpdateStatus('${uid}',this)">
    ${_trpStatusOptions(row.status).map(s => `<option value="${escapeHtml(s)}" ${row.status===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
  </select>`;
}

function renderTestReporting() {
  const root = document.getElementById('test-reporting-content');
  if (!root) return;
  if (!currentRoleUser) { root.innerHTML = ''; return; }
  if (!_trpCanView()) {
    root.innerHTML = `<div class="docs-empty"><h3>Not available</h3><p>Your role does not have access to Test Reporting.</p></div>`;
    return;
  }

  // Subsystem lock: if the signed-in user has a subsystem assigned, pin the filter
  const trpUserSub = currentRoleUser?.subsystem || '';
  if (trpUserSub && _trpFilters.subsystem !== trpUserSub) _trpFilters.subsystem = trpUserSub;

  const canManage = _trpCanManage();
  const rows = _trpBuildReportRows();
  const filtered = _trpFilteredRows(rows);
  const derivedCount = rows.filter(r => r.isDerived).length;
  const linkedCount = rows.filter(r => r.testCaseCount > 0).length;
  const activityCount = rows.reduce((sum, r) => sum + r.activityCount, 0);
  const testCaseCount = rows.reduce((sum, r) => sum + r.testCaseCount, 0);
  const hasFilters = Object.values(_trpFilters).some(Boolean);
  const statusOptions = _trpFilterOptions(rows, 'status');
  const subsystemOptions = _trpFilterOptions(rows, 'subsystem');
  const phaseOptions = _trpFilterOptions(rows, 'phase');
  const locationOptions = _trpFilterOptions(rows, 'location');

  root.innerHTML = `
    <div class="admin-section trp-shell">
      <div class="tr-modern-header">
        <div class="tr-modern-header-main">
          <div class="role-badge role-field-badge">Reporting Register</div>
          <div class="admin-section-title">Test Reports</div>
          <div class="tr-header-stats">
            <span><b>${filtered.length}</b> shown</span>
            <span><b>${rows.length}</b> reports</span>
            <span><b>${linkedCount}</b> linked</span>
            <span><b>${activityCount}</b> activities</span>
            <span><b>${testCaseCount}</b> test cases</span>
            ${derivedCount ? `<span><b>${derivedCount}</b> from TI</span>` : ''}
          </div>
        </div>
        <div class="tr-modern-toolbar">
          ${canManage && derivedCount ? `<button class="form-secondary" onclick="_trpSyncMissingReports()" ${_trpSyncInFlight?'disabled':''}>${_trpSyncInFlight?'Syncing...':`Sync Missing (${derivedCount})`}</button>` : ''}
          ${canManage ? `<button class="admin-action-btn" onclick="openNewTestReportModal()">+ New Report</button>` : ''}
        </div>
      </div>

      <div class="am-filter-bar tr-filter-toolbar">
        <input class="filter-input" value="${escapeHtml(_trpFilters.search)}" placeholder="Search reports, CDRLs, activities, test cases..." oninput="_trpSetSearch(this.value)">
        <select class="filter-select" onchange="_trpSetFilter('status',this.value)">
          <option value="">All Report Statuses</option>
          ${statusOptions.map(s => `<option value="${escapeHtml(s)}" ${_trpFilters.status===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_trpSetFilter('phase',this.value)">
          <option value="">All Phases</option>
          ${phaseOptions.map(s => `<option value="${escapeHtml(s)}" ${_trpFilters.phase===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_trpSetFilter('location',this.value)">
          <option value="">All Locations</option>
          ${locationOptions.map(s => `<option value="${escapeHtml(s)}" ${_trpFilters.location===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        ${trpUserSub
          ? `<span class="filter-locked-tag" title="Auto-filtered to your assigned subsystem">📌 ${escapeHtml(trpUserSub)}</span>`
          : `<select class="filter-select" onchange="_trpSetFilter('subsystem',this.value)">
              <option value="">All Subsystems</option>
              ${subsystemOptions.map(s => `<option value="${escapeHtml(s)}" ${_trpFilters.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
            </select>`}
        ${hasFilters ? `<button class="filter-clear" onclick="_trpClearFilters()">Reset</button>` : ''}
        <span style="margin-left:auto;font-size:12px;color:var(--gray-500);">${filtered.length} of ${rows.length} shown</span>
      </div>

      ${rows.length ? _trpReportTableHTML(filtered, canManage) : `
        <div class="docs-empty"><h3>No reports found</h3><p>No Test Report values exist in Test Items and no master report records have been created.</p></div>
      `}
    </div>
  `;
  _trpQueueAutoSync(rows);
}

function _trpReportTableHTML(rows, canManage) {
  return `
    <div class="data-card trp-table-card">
      <div class="data-card-head">
        <span class="data-count">${rows.length} report${rows.length===1?'':'s'}</span>
        <span class="data-count">Expand Linked Activities to view test case status totals</span>
      </div>
      <div class="table-wrap">
        <table class="data-table trp-report-table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Status</th>
              <th>Phase</th>
              <th>Location</th>
              <th>Subsystem</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(r => _trpReportRowHTML(r, canManage)).join('') : `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--gray-500);">No reports match the current filters</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function _trpReportRowHTML(row, canManage) {
  const uid = encodeURIComponent(row.uid);
  const expanded = _trpExpanded.has(row.uid);
  const subsystemText = row.subsystems.length ? row.subsystems.map(s => `<span class="tag">${escapeHtml(s)}</span>`).join(' ') : '-';
  const phaseText = row.phases.length ? row.phases.map(s => `<span class="tag" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join(' ') : '-';
  const locationText = row.locations.length ? row.locations.map(s => `<span class="tag" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join(' ') : '-';
  const actions = [
    `<button class="form-secondary tr-mini-btn" onclick="_trpToggleLinks('${uid}')">${expanded?'Hide':'View'} Links</button>`,
    canManage ? `<button class="form-secondary tr-mini-btn" onclick="openEditTestReportModal('${uid}')">${row.isDerived?'Create/Edit':'Edit'}</button>` : '',
    canManage && row.isDerived ? `<button class="admin-action-btn tr-mini-btn" onclick="_trpCreateDerivedReport('${uid}')">Sync</button>` : '',
    canManage && !row.isDerived ? `<button class="form-secondary tr-mini-btn" onclick="openAddRevisionModal('${escapeHtml(row.id)}')">+ Rev</button>` : '',
    canManage && !row.isDerived ? `<button class="form-secondary tr-mini-btn tr-danger-btn" onclick="_trpDeleteReport('${uid}')">Delete</button>` : '',
  ].filter(Boolean).join('');
  const linkSummary = `${row.activityCount} Activit${row.activityCount===1?'y':'ies'} · ${row.testCaseCount} Test Case${row.testCaseCount===1?'':'s'} Linked`;

  return `
    <tr class="trp-main-row ${expanded ? 'is-expanded' : ''}">
      <td>
        <div class="tr-report-title trp-report-name" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</div>
        <div class="trp-report-meta-line">
          <span class="tag">Rev ${escapeHtml(row.revision || 'A')}</span>
          <span>${escapeHtml(linkSummary)}</span>
        </div>
        <div class="trp-report-meta-line trp-report-meta-muted">${escapeHtml(row.sourceLabel || '')}</div>
      </td>
      <td>${_trpStatusControlHTML(row, canManage)}</td>
      <td><div class="trp-tag-stack trp-phase-stack">${phaseText}</div></td>
      <td><div class="trp-tag-stack trp-location-stack">${locationText}</div></td>
      <td><div class="trp-tag-stack">${subsystemText}</div></td>
      <td><div class="trp-notes-cell">${escapeHtml(row.notes || '-')}</div></td>
      <td><div class="tr-report-actions">${actions}</div></td>
    </tr>
    ${expanded ? `<tr class="trp-details-row"><td colspan="7">${_trpLinkedActivitiesHTML(row)}</td></tr>` : ''}
  `;
}

function _trpLinkedActivitiesHTML(row) {
  if (!row.activities.length) {
    return `<div class="trp-linked-panel trp-linked-empty">No linked activities or test cases were found for this report.</div>`;
  }
  return `
    <div class="trp-linked-panel">
      <div class="trp-linked-head">
        <div>
          <div class="trp-linked-title">Linked Activities</div>
          <div class="section-sub">${row.activityCount} Activities · ${row.testCaseCount} Test Cases Linked</div>
        </div>
      </div>
      <div class="trp-linked-list">
        ${row.activities.map(act => {
          const st = _amComputeStatus(act);
          const { done, total } = _amComputeCompletion(act);
          const pct = total ? Math.round((done / total) * 100) : 0;
          return `
            <div class="trp-linked-item">
              <div class="trp-linked-main">
                <div class="trp-linked-name">${escapeHtml(act.activity)}</div>
                <div class="tr-report-meta">${escapeHtml(act.phase)} · ${escapeHtml(act.location)} · ${escapeHtml(act.subsystem)}</div>
              </div>
              <div class="trp-linked-side">
                ${_amStatusBadge(st)}
                <div class="am-progress-wrap">
                  <div class="am-progress-bar"><div class="am-progress-fill" style="width:${pct}%;${pct===100?'background:var(--good);':pct>0?'background:var(--info);':'background:var(--gray-300);'}"></div></div>
                  <span class="am-progress-label">${done}/${total}</span>
                </div>
                <span class="cell-sub">${act.items.length} test case${act.items.length===1?'':'s'}</span>
                ${_trpStatusSummaryFullHTML(act.counts)}
                ${_trpCanManage() ? `<button class="form-secondary tr-mini-btn tr-danger-btn" onclick="_trpUnlinkActivity('${encodeURIComponent(row.uid)}','${encodeURIComponent(act.key)}')">Unlink</button>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function _trStatusSelectHTML(currentVal, id) {
  return `<select id="${id}" class="form-input">
    ${_trpStatusOptions(currentVal).map(s => `<option value="${escapeHtml(s)}" ${currentVal===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
  </select>`;
}

function openNewTestReportModal() {
  if (!_trpCanManage()) { toast('You do not have permission to create reports', 'error'); return; }
  const subsystems = [...new Set(TI.map(r=>r.Subsystem).filter(Boolean))].sort();
  const phases = [...new Set(TI.map(r=>r.Phase).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const locations = [...new Set(TI.map(r=>r.Location).filter(Boolean))].sort();
  modal({
    title: 'New Test Report',
    size: 'medium',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full"><label>Title</label><input type="text" id="tr-title" class="form-input" placeholder="e.g. DCS SAT Test Report"></div>
        <div class="form-field"><label>CDRL Number</label><input type="text" id="tr-cdrl" class="form-input" placeholder="e.g. CDRL 9.05.25"></div>
        <div class="form-field"><label>Revision</label><input type="text" id="tr-rev" class="form-input" value="A" placeholder="A"></div>
        <div class="form-field"><label>Phase</label><select id="tr-phase" class="form-input"><option value="">— Select —</option>${phases.map(s=>`<option>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Location</label><select id="tr-location" class="form-input"><option value="">— Select —</option>${locations.map(s=>`<option>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Subsystem</label><select id="tr-subsystem" class="form-input"><option value="">— Select —</option>${subsystems.map(s=>`<option>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Status</label>${_trStatusSelectHTML('Not Started','tr-status')}</div>
        <div class="form-field form-field-full"><label>Notes</label><textarea id="tr-notes" class="form-input" rows="2" placeholder="Optional notes..."></textarea></div>
      </div>
    `,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button><button class="admin-action-btn" onclick="saveNewTestReport()">Create Report</button>`
  });
}

async function saveNewTestReport() {
  if (!_trpCanManage()) { toast('You do not have permission to save reports', 'error'); return; }
  const title = document.getElementById('tr-title')?.value.trim();
  if (!title) { toast('Title is required','error'); return; }
  const row = {
    title,
    cdrl_number: document.getElementById('tr-cdrl')?.value.trim() || null,
    revision:    document.getElementById('tr-rev')?.value.trim()  || 'A',
    phase:       document.getElementById('tr-phase')?.value       || null,
    location:    document.getElementById('tr-location')?.value    || null,
    status:      document.getElementById('tr-status')?.value      || 'Not Started',
    subsystem:   document.getElementById('tr-subsystem')?.value   || null,
    notes:       document.getElementById('tr-notes')?.value.trim() || null,
    created_by:  currentRoleUser?.name,
    updated_by:  currentRoleUser?.name,
  };
  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const inserted = await _dbInsert('test_reports', [row]);
    _testReports.push(...inserted);
    logAudit('Test Report Created', title, `CDRL: ${row.cdrl_number||'—'}`);
    toast('Test report created', 'success');
    closeModal();
    await _trpRefreshData();
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Create Report'; }
  }
}

function openEditTestReportModal(uid) {
  if (!_trpCanManage()) { toast('You do not have permission to edit reports', 'error'); return; }
  const row = _trpFindReportRow(uid);
  if (!row) { toast('Report not found','error'); return; }
  const safeUid = encodeURIComponent(row.uid);
  const subsystems = [...new Set([...TI.map(t=>t.Subsystem).filter(Boolean), ...row.subsystems])].sort();
  const phases = [...new Set([...TI.map(t=>t.Phase).filter(Boolean), ...row.phases])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const locations = [...new Set([...TI.map(t=>t.Location).filter(Boolean), ...row.locations])].sort();
  modal({
    title: row.isDerived ? 'Create Report Record' : 'Edit Test Report',
    size: 'medium',
    body: `
      ${row.isDerived ? `<div class="trp-derived-callout">This report is referenced by Test Items but is missing from the master test_reports table. Saving will create it with status "${escapeHtml(row.status)}".</div>` : ''}
      <div class="form-grid">
        <div class="form-field form-field-full"><label>Title</label><input type="text" id="tr-title" class="form-input" value="${escapeHtml(row.title)}"></div>
        <div class="form-field"><label>CDRL Number</label><input type="text" id="tr-cdrl" class="form-input" value="${escapeHtml(row.cdrl_number||'')}"></div>
        <div class="form-field"><label>Revision</label><input type="text" id="tr-rev" class="form-input" value="${escapeHtml(row.revision||'A')}"></div>
        <div class="form-field"><label>Phase</label><select id="tr-phase" class="form-input"><option value="">- Select -</option>${phases.map(s=>`<option ${row.phase===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Location</label><select id="tr-location" class="form-input"><option value="">- Select -</option>${locations.map(s=>`<option ${row.location===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Subsystem</label><select id="tr-subsystem" class="form-input"><option value="">- Select -</option>${subsystems.map(s=>`<option ${row.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Status</label>${_trStatusSelectHTML(row.status,'tr-status')}</div>
        <div class="form-field form-field-full"><label>Notes</label><textarea id="tr-notes" class="form-input" rows="2">${escapeHtml(row.notes||'')}</textarea></div>
      </div>
    `,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button><button class="admin-action-btn" onclick="saveTestReportEdit('${safeUid}')">${row.isDerived?'Create Record':'Save Changes'}</button>`
  });
}

async function saveTestReportEdit(uid) {
  if (!_trpCanManage()) { toast('You do not have permission to save reports', 'error'); return; }
  const row = _trpFindReportRow(uid);
  if (!row) return;
  const title = document.getElementById('tr-title')?.value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  const patch = {
    title,
    cdrl_number: document.getElementById('tr-cdrl')?.value.trim() || null,
    revision:    document.getElementById('tr-rev')?.value.trim() || 'A',
    phase:       document.getElementById('tr-phase')?.value || null,
    location:    document.getElementById('tr-location')?.value || null,
    subsystem:   document.getElementById('tr-subsystem')?.value || null,
    status:     document.getElementById('tr-status')?.value || row.status,
    notes:      document.getElementById('tr-notes')?.value.trim() || null,
    updated_by: currentRoleUser?.name,
    updated_at: new Date().toISOString(),
  };
  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    if (row.isDerived) {
      await _trpCreateReportRecord(row, patch);
      toast('Report record created', 'success');
    } else {
      const updated = await _dbUpdate('test_reports', patch, { id: row.id });
      if (!updated?.length) throw new Error('No report row was updated. Check test_reports RLS SELECT/UPDATE policies.');
      const target = _testReports.find(x => x.id === row.id);
      if (target) Object.assign(target, updated[0] || patch);
      toast('Report updated', 'success');
    }
    closeModal();
    await _trpRefreshData();
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

function openAddRevisionModal(parentId) {
  if (!_trpCanManage()) { toast('You do not have permission to add revisions', 'error'); return; }
  const parent = _testReports.find(r => r.id === parentId);
  if (!parent) return;
  // Suggest next revision letter
  const siblings = _testReports.filter(r => r.parent_id === parentId);
  const lastRev  = siblings.length ? siblings[siblings.length-1].revision : parent.revision;
  const nextRev  = lastRev ? String.fromCharCode(lastRev.charCodeAt(0)+1) : 'B';
  modal({
    title: `Add Revision — ${escapeHtml(parent.title)}`,
    size: 'medium',
    body: `
      <p style="font-size:13px;color:var(--gray-600);margin-bottom:16px;">A new revision will be created with fresh status (Not Started), linked to the original report.</p>
      <div class="form-grid">
        <div class="form-field"><label>Revision</label><input type="text" id="tr-rev" class="form-input" value="${escapeHtml(nextRev)}"></div>
        <div class="form-field"><label>Status</label>${_trStatusSelectHTML('Not Started','tr-status')}</div>
        <div class="form-field form-field-full"><label>Notes</label><textarea id="tr-notes" class="form-input" rows="2" placeholder="Notes for this revision..."></textarea></div>
      </div>
    `,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button><button class="admin-action-btn" onclick="saveNewRevision('${parentId}')">Add Revision</button>`
  });
}

async function saveNewRevision(parentId) {
  if (!_trpCanManage()) { toast('You do not have permission to add revisions', 'error'); return; }
  const parent = _testReports.find(r => r.id === parentId);
  if (!parent) return;
  const row = {
    title:       parent.title,
    cdrl_number: parent.cdrl_number,
    revision:    document.getElementById('tr-rev')?.value.trim() || 'B',
    status:      document.getElementById('tr-status')?.value || 'Not Started',
    phase:       parent.phase || null,
    location:    parent.location || null,
    subsystem:   parent.subsystem,
    notes:       document.getElementById('tr-notes')?.value.trim() || null,
    parent_id:   parentId,
    created_by:  currentRoleUser?.name,
    updated_by:  currentRoleUser?.name,
  };
  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const inserted = await _dbInsert('test_reports', [row]);
    _testReports.push(...inserted);
    logAudit('Test Report Revision Added', parent.title, `Rev ${row.revision}`);
    toast(`Revision ${row.revision} added`, 'success');
    closeModal();
    await _trpRefreshData();
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Revision'; }
  }
}

async function _trpCreateReportRecord(row, overrides = {}) {
  const payload = {
    title:       overrides.title ?? row.title ?? row.cdrl_number ?? 'Untitled Test Report',
    cdrl_number: overrides.cdrl_number !== undefined ? overrides.cdrl_number : (row.cdrl_number || _trpInferCdrlNumber(row.title)),
    revision:    overrides.revision ?? row.revision ?? 'A',
    status:      overrides.status ?? row.status ?? 'Not Started',
    phase:       overrides.phase !== undefined ? overrides.phase : (row.phase || (row.phases?.length === 1 ? row.phases[0] : null)),
    location:    overrides.location !== undefined ? overrides.location : (row.location || (row.locations?.length === 1 ? row.locations[0] : null)),
    subsystem:   overrides.subsystem !== undefined ? overrides.subsystem : (row.subsystem || (row.subsystems?.length === 1 ? row.subsystems[0] : null)),
    notes:       overrides.notes !== undefined ? overrides.notes : (row.notes || 'Referenced from Test Items'),
    parent_id:   overrides.parent_id !== undefined ? overrides.parent_id : (row.parent_id || null),
    created_by:  currentRoleUser?.name,
    updated_by:  currentRoleUser?.name,
    updated_at:  new Date().toISOString(),
  };
  if (!payload.title) payload.title = payload.cdrl_number || 'Untitled Test Report';
  if (row.isDerived) {
    const existing = _testReports.find(r => _trpRecordKeys(r).includes(row.key));
    if (existing) {
      const patch = { ...payload };
      delete patch.created_by;
      const updated = await _dbUpdate('test_reports', patch, { id: existing.id });
      if (!updated?.length) throw new Error('No report row was updated. Check test_reports RLS SELECT/UPDATE policies.');
      Object.assign(existing, updated[0] || patch);
      return existing;
    }
  }
  const inserted = await _dbInsert('test_reports', [payload]);
  if (!inserted?.length) throw new Error('No report row was created. Check test_reports RLS INSERT policy.');
  _testReports.push(...inserted);
  await _trpLinkItemsToReport(row, inserted[0]);
  return inserted[0];
}

async function _trpLinkItemsToReport(row, report) {
  if (!row?.activities?.length || !report?.id) return;
  const ids = [...new Set(row.activities.flatMap(a => a.items || []).map(t => t.TestID).filter(Boolean))];
  const link = { report: report.cdrl_number || report.title || null, reportId: report.id, record: report, mode: 'record', label: _trpReportLabel(report) };
  await Promise.all(ids.map(testId => _dbUpdate('test_items', _trpReportLinkPatch(link), { test_id: testId })));
  _trpApplyReportLinkToItems(TI.filter(t => ids.some(id => String(id) === String(t.TestID))), link);
}

async function _trpCreateDerivedReport(uid) {
  if (!_trpCanManage()) { toast('You do not have permission to sync reports', 'error'); return; }
  const row = _trpFindReportRow(uid);
  if (!row) { toast('Report not found', 'error'); return; }
  if (!row.isDerived) { toast('Report already exists in the master table', 'warn'); return; }
  try {
    await _trpCreateReportRecord(row);
    toast('Report record created from Test Items', 'success');
    await _trpRefreshData();
  } catch(e) {
    toast('Report sync failed: ' + e.message, 'error');
  }
}

async function _trpSyncMissingReports(manual = true, uidList = null) {
  if (!_trpCanManage()) { toast('You do not have permission to sync reports', 'error'); return; }
  if (_trpSyncInFlight) return;
  let rows = _trpBuildReportRows().filter(r => r.isDerived);
  if (uidList) {
    const wanted = new Set(uidList.map(_trpDecodeUid));
    rows = rows.filter(r => wanted.has(r.uid));
  }
  if (!rows.length) {
    if (manual) toast('No missing report records to sync', 'success');
    return;
  }
  _trpSyncInFlight = true;
  try {
    for (const row of rows) await _trpCreateReportRecord(row);
    toast(`Synced ${rows.length} missing report record${rows.length===1?'':'s'}`, 'success');
    await _trpRefreshData();
  } catch(e) {
    toast('Report sync failed: ' + e.message, 'error');
  } finally {
    _trpSyncInFlight = false;
  }
}

function _trpQueueAutoSync(rows) {
  if (!_trpCanManage() || _trpSyncInFlight) return;
  if (!document.getElementById('page-test-reporting')?.classList.contains('active')) return;
  const missing = rows.filter(r => r.isDerived && !_trpAutoSyncAttempted.has(r.uid));
  if (!missing.length) return;
  missing.forEach(r => _trpAutoSyncAttempted.add(r.uid));
  setTimeout(() => _trpSyncMissingReports(false, missing.map(r => r.uid)), 0);
}

async function _trpRefreshData() {
  await Promise.all([loadTestReports(), loadTestItems()]);
  if (currentRoleUser?.subsystem) TI = TI.filter(t => (t.Subsystem||'').toLowerCase() === currentRoleUser.subsystem.toLowerCase());
  renderTestReporting();
}

function _trpReportFamilyIds(reportId) {
  const ids = new Set();
  const visit = id => {
    if (!id || ids.has(String(id))) return;
    ids.add(String(id));
    _testReports.filter(r => String(r.parent_id || '') === String(id)).forEach(r => visit(r.id));
  };
  visit(reportId);
  return [...ids];
}

function _trpLinkedItemsForRow(row, reportIds = []) {
  const items = new Map();
  (row?.activities || []).flatMap(a => a.items || []).forEach(t => {
    if (t?.TestID) items.set(String(t.TestID), t);
  });
  const idSet = new Set(reportIds.map(String));
  if (idSet.size) {
    TI.filter(t => t.TestReportID && idSet.has(String(t.TestReportID))).forEach(t => {
      if (t?.TestID) items.set(String(t.TestID), t);
    });
  }
  return [...items.values()];
}

async function _trpClearTestItemReportLinks(items) {
  const ids = [...new Set((items || []).map(t => t.TestID).filter(Boolean))];
  await Promise.all(ids.map(testId => _dbUpdate('test_items', { test_report: null, test_report_id: null }, { test_id: testId })));
  return ids.length;
}

async function _trpUnlinkActivity(uid, activityKey) {
  if (!_trpCanManage()) { toast('You do not have permission to unlink reports', 'error'); return; }
  const row = _trpFindReportRow(uid);
  if (!row) { toast('Report not found', 'error'); return; }
  const decodedKey = _trpDecodeUid(activityKey);
  const act = row.activities.find(a => a.key === decodedKey);
  if (!act) { toast('Linked activity not found', 'error'); return; }
  const count = act.items.length;
  if (!count) return;
  if (!confirm(`Unlink "${act.activity}" from "${row.title}"?\n\nThis clears Test Report links from ${count} test case${count===1?'':'s'}.`)) return;
  try {
    await _trpClearTestItemReportLinks(act.items);
    logAudit('Test Report Activity Unlinked', row.title, `${act.activity}: ${count} test case${count===1?'':'s'}`);
    toast(`Unlinked ${count} test case${count===1?'':'s'}`, 'success');
    await _trpRefreshData();
  } catch(e) {
    toast('Unlink failed: ' + e.message, 'error');
  }
}

async function _trpDeleteReport(uid) {
  if (!_trpCanManage()) { toast('You do not have permission to delete reports', 'error'); return; }
  const row = _trpFindReportRow(uid);
  if (!row || row.isDerived || !row.id) { toast('Report record not found', 'error'); return; }
  const familyIds = _trpReportFamilyIds(row.id);
  const childCount = familyIds.length - 1;
  const linkedItems = _trpLinkedItemsForRow(row, familyIds);
  const msg = [
    `Delete "${row.title}"?`,
    childCount ? `This will also delete ${childCount} revision${childCount===1?'':'s'}.` : '',
    linkedItems.length ? `This will clear related Test Report links from ${linkedItems.length} test case${linkedItems.length===1?'':'s'}.` : '',
    'This cannot be undone.',
  ].filter(Boolean).join('\n\n');
  if (!confirm(msg)) return;
  try {
    await _trpClearTestItemReportLinks(linkedItems);
    const childIds = familyIds.filter(id => String(id) !== String(row.id));
    for (const id of childIds) await _dbDelete('test_reports', { id });
    const deleted = await _dbDelete('test_reports', { id: row.id });
    if (!deleted?.length) throw new Error('No report row was deleted. Check test_reports RLS SELECT/DELETE policies.');
    familyIds.forEach(id => {
      const idx = _testReports.findIndex(r => String(r.id) === String(id));
      if (idx !== -1) _testReports.splice(idx, 1);
    });
    _trpExpanded.delete(row.uid);
    logAudit('Test Report Deleted', row.title, `${linkedItems.length} related test case link${linkedItems.length===1?'':'s'} cleared`);
    toast('Test report deleted', 'success');
    await _trpRefreshData();
  } catch(e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

function _trpToggleLinks(uid) {
  const decoded = _trpDecodeUid(uid);
  if (_trpExpanded.has(decoded)) _trpExpanded.delete(decoded);
  else _trpExpanded.add(decoded);
  renderTestReporting();
}

async function _trpUpdateStatus(uid, el) {
  if (!_trpCanManage()) { toast('You do not have permission to update report status', 'error'); return; }
  const row = _trpFindReportRow(uid);
  if (!row) { toast('Report not found', 'error'); return; }
  const newStatus = el?.value || 'Not Started';
  const oldStatus = row.status || 'Not Started';
  if (newStatus === oldStatus && !row.isDerived) return;
  if (el) el.disabled = true;
  try {
    if (row.isDerived) {
      await _trpCreateReportRecord(row, { status: newStatus, notes: row.notes });
      toast('Report record created and status saved', 'success');
    } else {
      const patch = { status: newStatus, updated_by: currentRoleUser?.name, updated_at: new Date().toISOString() };
      const updated = await _dbUpdate('test_reports', patch, { id: row.id });
      if (!updated?.length) throw new Error('No report row was updated. Check test_reports RLS SELECT/UPDATE policies.');
      const target = _testReports.find(r => r.id === row.id);
      if (target) Object.assign(target, updated[0] || patch);
      toast('Report status updated', 'success');
    }
    await _trpRefreshData();
  } catch(e) {
    if (el) el.value = oldStatus;
    toast('Status update failed: ' + e.message, 'error');
  } finally {
    if (el) el.disabled = false;
  }
}

// ==========================================================================
// ACTIVITY MANAGER / TEST REGISTER — shared state
// ==========================================================================
let _amFilters  = { phase:'', location:'', subsystem:'', status:'' };
let _amSelected = new Set(); // selected activity keys for bulk action
let _trEditMode = false;
let _trDraftItems = null;
let _trSelected = new Set();
let _trBulkMsg = '';
let _trBulkMode = false;
let _trEmptySections = [];
let _trDragId = null;

// ==========================================================================
// TEST REGISTER — unified Activity + Test Case view
// ==========================================================================
function renderTestRegister() {
  const root = document.getElementById('test-register-content');
  if (!root || !currentRoleUser) return;
  root.innerHTML = _testRegisterHTML();
}

function _testRegisterHTML() {
  if (_amDrilldownKey) return _amDrilldownHTML(_amDrilldownKey);

  const isAdmin = currentRoleUser?.role === 'admin';
  const all = _amGetActivities();

  // Subsystem lock: if the signed-in user has a subsystem assigned, pin the filter
  const userSub = currentRoleUser?.subsystem || '';
  if (userSub && _amFilters.subsystem !== userSub) _amFilters.subsystem = userSub;

  // Cascade Phase → Location → Subsystem (only options present in current data)
  const phases = [...new Set(all
    .filter(a => !_amFilters.subsystem || a.subsystem === _amFilters.subsystem)
    .map(a => a.phase).filter(Boolean)
  )].sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));

  const locations = [...new Set(all
    .filter(a =>
      (!_amFilters.subsystem || a.subsystem === _amFilters.subsystem) &&
      (!_amFilters.phase     || a.phase     === _amFilters.phase)
    ).map(a => a.location).filter(Boolean)
  )].sort();

  const subsystems = [...new Set(all
    .filter(a =>
      (!_amFilters.phase    || a.phase    === _amFilters.phase) &&
      (!_amFilters.location || a.location === _amFilters.location)
    ).map(a => a.subsystem).filter(Boolean)
  )].sort();

  const actStatuses = ['Open','Closed','Future Test'];

  const filtered = all.filter(a => {
    const st = _amComputeStatus(a);
    return (!_amFilters.phase     || a.phase     === _amFilters.phase)     &&
           (!_amFilters.location  || a.location  === _amFilters.location)  &&
           (!_amFilters.subsystem || a.subsystem === _amFilters.subsystem) &&
           (!_amFilters.status    || st          === _amFilters.status);
  });

  const hasFilters = _amFilters.phase || _amFilters.location || _amFilters.subsystem || _amFilters.status;
  const selCount   = _amSelected.size;

  const selectedActivities = all.filter(a => _amSelected.has(a.key));
  const hasFutureTest = selectedActivities.some(a => _amComputeStatus(a) === 'Future Test');
  const hasNonFuture  = selectedActivities.some(a => _amComputeStatus(a) !== 'Future Test');
  const closedCount = filtered.filter(a => _amComputeStatus(a) === 'Closed').length;
  const openCount = filtered.filter(a => _amComputeStatus(a) === 'Open').length;
  const futureCount = filtered.filter(a => _amComputeStatus(a) === 'Future Test').length;
  const overallPct = TI.length ? Math.round((TI.filter(r => ['Pass','Passed','Complete','Not Applicable'].includes(r.Status)).length / TI.length) * 100) : 0;

  // column count: [cb](admin) | Actions | Activity | Subsystem | Location | Phase | Status | Completion
  const colCount = isAdmin ? 8 : 7;

  const actRows = filtered.map(a => {
    const st = _amComputeStatus(a);
    const { done, total } = _amComputeCompletion(a);
    const pct = total > 0 ? Math.round((done/total)*100) : 0;
    const isSel = _amSelected.has(a.key);
    const safeKey = escapeHtml(a.key);

    const actRow = `
      <tr style="${isSel?'background:#f5f3ff;':''}" class="tr-activity-row">
        ${isAdmin ? `<td class="am-cb-col"><input type="checkbox" ${isSel?'checked':''} onchange="_amToggleRow('${safeKey}',this.checked)"></td>` : ''}
        <td>
          <div class="tr-row-actions">
            ${isAdmin ? `<button class="form-secondary tr-mini-btn" onclick="_amOpenEditModal('${safeKey}')">Edit</button>` : ''}
            <button class="admin-action-btn tr-mini-btn" onclick="_amOpenDrilldown('${safeKey}')">Open</button>
          </div>
        </td>
        <td>
          <div class="tr-activity-title">${escapeHtml(a.activity)}</div>
          ${a.futureTestReason ? `<div style="font-size:11px;color:#5b21b6;margin-top:2px;">↳ ${escapeHtml(a.futureTestReason)}</div>` : ''}
        </td>
        <td><span class="tag">${escapeHtml(a.subsystem)}</span></td>
        <td style="font-size:12px;">${escapeHtml(a.location)}</td>
        <td style="font-size:12px;">${escapeHtml(a.phase)}</td>
        <td>${_amStatusBadge(st)}</td>
        <td>
          <div class="am-progress-wrap">
            <div class="am-progress-bar"><div class="am-progress-fill" style="width:${pct}%;${pct===100?'background:var(--good);':pct>0?'background:var(--info);':'background:var(--gray-300);'}"></div></div>
            <span class="am-progress-label">${done}/${total}</span>
          </div>
        </td>
      </tr>`;
    return actRow;
  }).join('');

  return `
    <div class="admin-section tr-register-shell">
      <!-- Header + toolbar -->
      <div class="tr-modern-header">
        <div class="tr-modern-header-main">
          <div class="role-badge role-field-badge">Operations Register</div>
          <div class="admin-section-title">Test Register</div>
          <div class="tr-header-stats">
            <span><b>${filtered.length}</b> shown</span>
            <span><b>${openCount}</b> open</span>
            <span><b>${closedCount}</b> closed</span>
            ${futureCount ? `<span><b>${futureCount}</b> future</span>` : ''}
            <span><b>${overallPct}%</b> complete</span>
          </div>
          <p class="section-sub">${all.length} activities · ${TI.length} test cases across all phases and locations</p>
        </div>
        ${isAdmin ? `
        <div class="tr-modern-toolbar">
          <label style="cursor:pointer;">
            <input type="file" accept=".csv" onchange="handleImportFile(this)" style="display:none">
            <div class="admin-action-btn" style="display:inline-block;cursor:pointer;background:var(--gray-700);">📂 Import Test Items</div>
          </label>
          <button class="form-secondary" onclick="downloadImportTemplate()">↓ CSV Template</button>
        </div>` : ''}
      </div>

      <!-- Filters -->
      <div class="am-filter-bar tr-filter-toolbar">
        <select class="filter-select" onchange="_amSetFilter('phase',this.value)">
          <option value="">All Phases</option>
          ${phases.map(p=>`<option value="${escapeHtml(p)}" ${_amFilters.phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_amSetFilter('location',this.value)">
          <option value="">All Locations</option>
          ${locations.map(l=>`<option value="${escapeHtml(l)}" ${_amFilters.location===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
        </select>
        ${userSub
          ? `<span class="filter-locked-tag" title="Auto-filtered to your assigned subsystem">📌 ${escapeHtml(userSub)}</span>`
          : `<select class="filter-select" onchange="_amSetFilter('subsystem',this.value)">
              <option value="">All Subsystems</option>
              ${subsystems.map(s=>`<option value="${escapeHtml(s)}" ${_amFilters.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
            </select>`}
        <select class="filter-select" onchange="_amSetFilter('status',this.value)">
          <option value="">All Statuses</option>
          ${actStatuses.map(s=>`<option value="${s}" ${_amFilters.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        ${hasFilters ? `<button class="filter-clear" onclick="_amClearFilters()">Reset</button>` : ''}
        <span style="margin-left:auto;font-size:12px;color:var(--gray-500);">${filtered.length} of ${all.length} shown</span>
      </div>

      <!-- Bulk action bar (admin only) -->
      ${isAdmin && selCount > 0 ? `
        <div class="am-bulk-bar">
          <span><b>${selCount}</b> activit${selCount===1?'y':'ies'} selected</span>
          ${hasNonFuture  ? `<button class="admin-action-btn" style="background:#5b21b6;" onclick="_amOpenFutureTestModal()">Mark as Future Test</button>` : ''}
          ${hasFutureTest ? `<button class="admin-action-btn" style="background:#059669;" onclick="_amOpenDeployToFieldModal()">Deploy to Field</button>` : ''}
          <button class="form-secondary" style="font-size:12px;" onclick="_amClearSelection()">Clear selection</button>
        </div>` : ''}

      <!-- Main table -->
      <div class="data-card tr-register-table-card">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                ${isAdmin ? `<th class="am-cb-col"><input type="checkbox" id="am-cb-all" onchange="_amToggleAll(this.checked)" title="Select all"></th>` : ''}
                <th style="min-width:90px;white-space:nowrap;">Actions</th>
                <th>Activity Name</th>
                <th>Subsystem</th>
                <th>Location</th>
                <th>Phase</th>
                <th>Status</th>
                <th style="min-width:160px;">Completion</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.length ? actRows : `<tr><td colspan="${colCount}" style="text-align:center;padding:40px;color:var(--gray-500);">No activities match the current filters</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function _amGetActivities() {
  // Derive unique activities from TI
  const map = new Map();
  TI.forEach(r => {
    const key = `${r.Phase||''}||${r.Location||''}||${r.Subsystem||''}||${r.Activity||''}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        phase:         r.Phase    || '—',
        location:      r.Location || '—',
        subsystem:     r.Subsystem|| '—',
        activity:      r.Activity || '—',
        testProcedure: r.TestProcedure || '',
        testReport:    r.TestReport   || '',
        items: [],
      });
    }
    map.get(key).items.push(r);
  });
  // Attach future_test_reason from _activityRecords
  map.forEach(act => {
    const rec = _activityRecords.find(ar =>
      ar.phase === act.phase && ar.location === act.location &&
      ar.subsystem === act.subsystem && ar.activity_name === act.activity
    );
    act.futureTestReason = rec?.future_test_reason || '';
  });
  return [...map.values()];
}

function _amComputeStatus(act) {
  const items = act.items;
  if (!items.length) return 'Open';
  const allFuture = items.every(r => r.Status === 'Future Test');
  if (allFuture) return 'Future Test';
  const allDone = items.every(r => r.Status === 'Pass' || r.Status === 'Not Applicable' ||
    r.Status === 'Complete' || r.Status === 'Passed');
  if (allDone) return 'Closed';
  return 'Open';
}

function _amComputeCompletion(act) {
  // Exclude Future Test items from denominator
  const eligible = act.items.filter(r => r.Status !== 'Future Test');
  const done = eligible.filter(r => r.Status === 'Pass' || r.Status === 'Not Applicable' ||
    r.Status === 'Complete' || r.Status === 'Passed').length;
  return { done, total: eligible.length };
}

// Weighted completion using test_items.weight (Layer 2) — used for P6 progress display
const _P6_DONE_STATUSES = new Set(['Pass','Passed','Complete','Not Applicable']);
function _p6WeightedCompletion(act) {
  const eligible = act.items.filter(r => r.Status !== 'Future Test');
  const totalW   = eligible.reduce((s, r) => s + (parseFloat(r.weight) || 1), 0);
  const doneW    = eligible
    .filter(r => _P6_DONE_STATUSES.has(r.Status))
    .reduce((s, r) => s + (parseFloat(r.weight) || 1), 0);
  const pct = totalW > 0 ? Math.round((doneW / totalW) * 100) : 0;
  return { doneW, totalW, pct };
}

function _amStatusBadge(s) {
  if (s === 'Closed')      return `<span class="badge badge-passed">Closed</span>`;
  if (s === 'Future Test') return `<span class="badge badge-futuretest">Future Test</span>`;
  return `<span class="badge badge-open">Open</span>`;
}

let _amDrilldownKey = null; // currently open drill-down activity key

function _adminActivityManagerHTML() {
  if (_amDrilldownKey) return _amDrilldownHTML(_amDrilldownKey);

  const all = _amGetActivities();

  // Cascade Phase → Location → Subsystem (admin activity manager has no subsystem lock)
  const phases = [...new Set(all
    .filter(a => !_amFilters.subsystem || a.subsystem === _amFilters.subsystem)
    .map(a => a.phase).filter(Boolean)
  )].sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));

  const locations = [...new Set(all
    .filter(a =>
      (!_amFilters.subsystem || a.subsystem === _amFilters.subsystem) &&
      (!_amFilters.phase     || a.phase     === _amFilters.phase)
    ).map(a => a.location).filter(Boolean)
  )].sort();

  const subsystems = [...new Set(all
    .filter(a =>
      (!_amFilters.phase    || a.phase    === _amFilters.phase) &&
      (!_amFilters.location || a.location === _amFilters.location)
    ).map(a => a.subsystem).filter(Boolean)
  )].sort();

  const statuses = ['Open','Closed','Future Test'];

  let filtered = all.filter(a => {
    const st = _amComputeStatus(a);
    return (!_amFilters.phase     || a.phase     === _amFilters.phase)     &&
           (!_amFilters.location  || a.location  === _amFilters.location)  &&
           (!_amFilters.subsystem || a.subsystem === _amFilters.subsystem) &&
           (!_amFilters.status    || st          === _amFilters.status);
  });

  const hasFilters = _amFilters.phase || _amFilters.location || _amFilters.subsystem || _amFilters.status;
  const selCount   = _amSelected.size;

  const selectedActivities = all.filter(a => _amSelected.has(a.key));
  const hasFutureTest   = selectedActivities.some(a => _amComputeStatus(a) === 'Future Test');
  const hasNonFuture    = selectedActivities.some(a => _amComputeStatus(a) !== 'Future Test');

  return `
    <div class="admin-section">
      <div class="admin-section-head" style="flex-wrap:wrap;gap:8px;">
        <div>
          <div class="admin-section-title">Activity Manager</div>
          <p class="section-sub">${all.length} activities across all phases and locations</p>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <label style="cursor:pointer;">
            <input type="file" accept=".csv" onchange="handleImportFile(this)" style="display:none">
            <div class="admin-action-btn" style="display:inline-block;cursor:pointer;background:var(--gray-700);">📂 Import Test Items</div>
          </label>
          <button class="form-secondary" onclick="downloadImportTemplate()">↓ CSV Template</button>
        </div>
      </div>

      <!-- Filters -->
      <div class="am-filter-bar">
        <select class="filter-select" onchange="_amSetFilter('phase',this.value)">
          <option value="">All Phases</option>
          ${phases.map(p=>`<option value="${escapeHtml(p)}" ${_amFilters.phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_amSetFilter('location',this.value)">
          <option value="">All Locations</option>
          ${locations.map(l=>`<option value="${escapeHtml(l)}" ${_amFilters.location===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_amSetFilter('subsystem',this.value)">
          <option value="">All Subsystems</option>
          ${subsystems.map(s=>`<option value="${escapeHtml(s)}" ${_amFilters.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_amSetFilter('status',this.value)">
          <option value="">All Statuses</option>
          ${statuses.map(s=>`<option value="${s}" ${_amFilters.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        ${hasFilters ? `<button class="filter-clear" onclick="_amClearFilters()">Reset</button>` : ''}
        <span style="margin-left:auto;font-size:12px;color:var(--gray-500);">${filtered.length} of ${all.length} shown</span>
      </div>

      <!-- Bulk action bar (visible when selection > 0) -->
      ${selCount > 0 ? `
        <div class="am-bulk-bar">
          <span><b>${selCount}</b> activit${selCount===1?'y':'ies'} selected</span>
          ${hasNonFuture ? `<button class="admin-action-btn" style="background:#5b21b6;" onclick="_amOpenFutureTestModal()">Mark as Future Test</button>` : ''}
          ${hasFutureTest ? `<button class="admin-action-btn" style="background:#059669;" onclick="_amOpenDeployToFieldModal()">Deploy to Field</button>` : ''}
          <button class="form-secondary" style="font-size:12px;" onclick="_amClearSelection()">Clear selection</button>
        </div>
      ` : ''}

      <!-- Table -->
      <div class="data-card">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="am-cb-col"><input type="checkbox" id="am-cb-all" onchange="_amToggleAll(this.checked)" title="Select all"></th>
                <th>Activity Name</th>
                <th>Subsystem</th>
                <th>Test Procedure</th>
                <th>Test Report CDRL</th>
                <th>Location</th>
                <th>Phase</th>
                <th>Status</th>
                <th style="min-width:160px;">Completion</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.length ? filtered.map(a => {
                const st = _amComputeStatus(a);
                const { done, total } = _amComputeCompletion(a);
                const pct = total > 0 ? Math.round((done/total)*100) : 0;
                const isSel = _amSelected.has(a.key);
                const procFull = a.testProcedure || '';
                const procShort = procFull.length > 40 ? procFull.slice(0,40)+'…' : (procFull || '—');
                const safeKey = encodeURIComponent(a.key);
                return `
                  <tr style="${isSel?'background:#f5f3ff;':''}">
                    <td class="am-cb-col"><input type="checkbox" ${isSel?'checked':''} onchange="_amToggleRow('${escapeHtml(a.key)}',this.checked)"></td>
                    <td>
                      <div style="font-weight:600;font-size:13px;cursor:pointer;color:var(--info);" onclick="_amOpenDrilldown('${escapeHtml(a.key)}')" title="Click to view test items">${escapeHtml(a.activity)}</div>
                      ${a.futureTestReason ? `<div style="font-size:11px;color:#5b21b6;margin-top:2px;">↳ ${escapeHtml(a.futureTestReason)}</div>` : ''}
                    </td>
                    <td><span class="tag">${escapeHtml(a.subsystem)}</span></td>
                    <td style="font-size:12px;max-width:160px;" title="${escapeHtml(procFull)}">${escapeHtml(procShort)}</td>
                    <td style="font-size:12px;">${escapeHtml(a.testReport||'—')}</td>
                    <td style="font-size:12px;">${escapeHtml(a.location)}</td>
                    <td style="font-size:12px;">${escapeHtml(a.phase)}</td>
                    <td>${_amStatusBadge(st)}</td>
                    <td>
                      <div class="am-progress-wrap">
                        <div class="am-progress-bar"><div class="am-progress-fill" style="width:${pct}%;${pct===100?'background:var(--good);':pct>0?'background:var(--info);':'background:var(--gray-300);'}"></div></div>
                        <span class="am-progress-label">${done}/${total}</span>
                      </div>
                    </td>
                    <td>
                      <div style="display:flex;gap:4px;">
                        <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="_amOpenDrilldown('${escapeHtml(a.key)}')">View</button>
                        <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="_amOpenEditModal('${escapeHtml(a.key)}')">Edit</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('') : `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--gray-500);">No activities match the current filters</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function _amDrilldownHTML(key) {
  const act = _amGetActivities().find(a => a.key === key);
  if (!act) return `<div class="docs-empty"><h3>Activity not found</h3></div>`;
  const isAdmin = currentRoleUser?.role === 'admin';
  const st = _amComputeStatus(act);
  const { done, total } = _amComputeCompletion(act);
  const pct = total > 0 ? Math.round((done/total)*100) : 0;
  const statuses = ['Not Started','In Progress','Pass','Fail','Blocked','Not Applicable','Future Test'];
  const legacyMap = { 'Future':'Not Started', 'Passed':'Pass', 'Failed':'Fail', 'Complete':'Pass' };
  const viewItems = _trEditMode && _trDraftItems ? _trDraftItems : act.items;
  const selectedCount = _trSelected.size;
  const tpMap = {};
  viewItems.forEach(r => {
    const tp = r.TestProcedure || '(No Procedure)';
    if (!tpMap[tp]) tpMap[tp] = [];
    tpMap[tp].push(r);
  });
  if (_trEditMode) _trEmptySections.forEach(tp => { if (!tpMap[tp]) tpMap[tp] = []; });

  return `
    <div class="admin-section tr-drilldown-shell">
      ${_trEditMode ? `<div class="tr-edit-banner">Edit Mode Active</div>` : ''}
      <div class="tr-page-header">
        <div class="tr-page-header-grid">
          <div class="tr-page-header-main">
            <button class="form-secondary" style="font-size:12px;margin-bottom:12px;" onclick="_amCloseDrilldown()">← Back to Test Register</button>
            <div class="tr-drilldown-title">${escapeHtml(act.activity)}</div>
            <div style="font-size:13px;color:var(--gray-600);margin-top:6px;">
              ${escapeHtml(act.subsystem)} · ${escapeHtml(act.location)} · ${escapeHtml(act.phase)}
              ${act.testReport ? ` · Test Report CDRL: ${escapeHtml(act.testReport)}` : ''}
            </div>
            ${act.testReport ? `<div style="font-size:12px;color:var(--gray-600);margin-top:4px;">📄 Test Report CDRL: ${escapeHtml(act.testReport)}</div>` : ''}
            ${act.futureTestReason ? `<div style="font-size:12px;color:#5b21b6;margin-top:4px;">Future Test Reason: ${escapeHtml(act.futureTestReason)}</div>` : ''}
          </div>
          <div class="tr-page-actions">
            ${_amStatusBadge(st)}
            <div class="am-progress-wrap" style="min-width:180px;">
              <div class="am-progress-bar"><div class="am-progress-fill" style="width:${pct}%;background:${pct===100?'var(--good)':'var(--info)'}"></div></div>
              <span class="am-progress-label">${done}/${total}</span>
            </div>
            <button class="${_trBulkMode?'admin-action-btn':'form-secondary'}" style="font-size:12px;" onclick="_trToggleBulkEdit()">${_trBulkMode?'Bulk Edit On':'Bulk Edit'}</button>
            ${isAdmin ? (_trEditMode ? `<button class="form-secondary" style="font-size:12px;" onclick="_trAddSection()">+ Add Test Section</button><button class="form-secondary" style="font-size:12px;" onclick="_trCancelEdit()">Cancel</button><button class="admin-action-btn" style="font-size:12px;" onclick="_trSaveEdit('${escapeHtml(key)}')">Save</button>` : `<button class="admin-action-btn" style="font-size:12px;" onclick="_trStartEdit('${escapeHtml(key)}')">Edit</button>`) : ''}
          </div>
        </div>
      </div>

      ${Object.entries(tpMap).map(([tp, tpItems]) => `
        <div class="tr-procedure-card" ${_trEditMode && isAdmin ? `ondragover="event.preventDefault()" ondrop="_trDropCase('${escapeHtml(tp)}',null)"` : ''}>
          <div class="tr-procedure-head">
            <div style="display:flex;align-items:center;gap:10px;">
              ${_trBulkMode ? `<input type="checkbox" ${tpItems.length && tpItems.every(r => _trSelected.has(String(r.TestID))) ? 'checked' : ''} onchange="_trSelectSection('${escapeHtml(tp)}',this.checked)" title="Select All in Section">` : ''}
              <div class="tr-procedure-title">${_trEditMode && isAdmin ? `<input class="form-input" style="font-weight:700;min-width:320px;" value="${escapeHtml(tp)}" onchange="_trRenameProcedure('${escapeHtml(tp)}',this.value)">` : escapeHtml(tp)}</div>
            </div>
            <div class="section-sub">${tpItems.length} test case${tpItems.length===1?'':'s'}</div>
          </div>
          <div class="table-wrap" style="max-height:none;">
            <table class="data-table tr-case-table">
              <thead>
                <tr>
                  ${_trBulkMode ? `<th style="width:34px;"></th>` : ''}
                  ${_trEditMode && isAdmin ? `<th style="width:34px;"></th>` : ''}
                  <th style="min-width:140px;">Test Case Code</th>
                  <th>Test Name</th>
                  <th style="min-width:170px;">Status</th>
                  <th style="min-width:240px;">Notes</th>
                  ${_trEditMode && isAdmin ? `<th style="width:86px;">Actions</th>` : ''}
                </tr>
              </thead>
              <tbody>
                ${tpItems.map(r => {
                const cur = legacyMap[r.Status] || r.Status || 'Not Started';
                const showReason = cur === 'Fail' || cur === 'Blocked';
                const reasonVal = cur === 'Fail' ? (r.FailedReason||'') : (r.BlockedReason||'');
                const tid = escapeHtml(String(r.TestID));
                const domId = encodeURIComponent(String(r.TestID));
                return `
                  <tr ${_trEditMode && isAdmin ? `draggable="true" ondragstart="_trDragStart('${tid}')" ondragover="event.preventDefault()" ondrop="_trDropCase('${escapeHtml(tp)}','${tid}')"` : ''}>
                    ${_trBulkMode ? `<td><input type="checkbox" ${_trSelected.has(String(r.TestID))?'checked':''} onchange="_trToggleSelect('${tid}',this.checked)"></td>` : ''}
                    ${_trEditMode && isAdmin ? `<td style="cursor:grab;color:var(--gray-400);font-size:14px;">☰</td>` : ''}
                    <td style="font-size:11px;font-family:monospace;">${_trEditMode && isAdmin ? `<input class="form-input" value="${escapeHtml(r.TestCaseCode||'')}" onchange="_trDraftChange('${tid}','TestCaseCode',this.value)">` : escapeHtml(r.TestCaseCode||r.TestID||'—')}</td>
                    <td>
                      <div style="font-weight:500;font-size:13px;">${_trEditMode && isAdmin ? `<input class="form-input" value="${escapeHtml(r.TestName||'')}" onchange="_trDraftChange('${tid}','TestName',this.value)">` : escapeHtml(r.TestName||'—')}</div>
                      ${r.CompletedBy ? `<div style="font-size:11px;color:var(--gray-500);">By ${escapeHtml(r.CompletedBy)}</div>` : ''}
                    </td>
                    <td>
                      ${['admin','field_engineer'].includes(currentRoleUser?.role) ? `
                        <select class="form-input mx-status-select" style="font-size:12px;padding:4px 6px;" onchange="_mxStatusChange('${tid}',this.value,this)">
                          ${statuses.map(s=>`<option value="${s}" ${cur===s?'selected':''}>${s}</option>`).join('')}
                        </select>
                        <div id="mx-reason-${domId}" class="mx-reason-wrap" style="${showReason?'':'display:none;'}">
                          <input type="text" id="mx-ri-${domId}" class="form-input mx-reason-input" style="font-size:11px;padding:3px 6px;margin-top:4px;" placeholder="${cur==='Fail'?'Failure reason...':'Blocked reason...'}" value="${escapeHtml(reasonVal)}" oninput="_mxSaveReason('${tid}',this.value)">
                        </div>
                      ` : `<span class="badge ${({'Pass':'badge-passed','Fail':'badge-failed','Blocked':'badge-warn','Not Applicable':'badge-notstarted','In Progress':'badge-inprog','Future Test':'badge-futuretest'}[cur]||'badge-notstarted')}">${escapeHtml(cur)}</span>`}
                    </td>
                    <td>
                      <input type="text" class="form-input" style="font-size:12px;padding:4px 8px;" placeholder="Notes…" value="${escapeHtml(r.Notes||'')}" onblur="_mxSaveNotes('${tid}',this.value)">
                    </td>
                    ${_trEditMode && isAdmin ? `<td><button class="form-secondary" style="font-size:13px;padding:4px 7px;" onclick="_trCopyCase('${tid}')">⧉</button><button class="form-secondary" style="font-size:13px;padding:4px 7px;color:var(--bad);margin-left:4px;" onclick="_trDeleteCase('${tid}')">🗑</button></td>` : ''}
                  </tr>
                `;
              }).join('')}
              </tbody>
            </table>
          </div>
          ${_trEditMode && isAdmin ? `<div style="padding:12px 16px;border-top:1px solid var(--gray-100);"><button class="form-secondary" onclick="_trAddCase('${escapeHtml(tp)}')">+ Add Test Case</button></div>` : ''}
        </div>
      `).join('')}
      ${_trBulkMode ? _trBulkBarHTML(selectedCount) : ''}
    </div>
  `;
}

function _trNewId() {
  return `TC-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
}

function _trStartEdit(key) {
  const act = _amGetActivities().find(a => a.key === key);
  if (!act) return;
  _trEditMode = true;
  _trDraftItems = act.items.map(r => ({ ...r, _isNew:false, _dirty:false }));
  _trEmptySections = [];
  _reRenderTR();
}

function _trCancelEdit() {
  _trEditMode = false;
  _trDraftItems = null;
  _trSelected.clear();
  _trBulkMsg = '';
  _trBulkMode = false;
  _trEmptySections = [];
  _trDragId = null;
  _reRenderTR();
}

function _trDraftChange(testId, field, value) {
  const r = _trDraftItems?.find(x => String(x.TestID) === String(testId));
  if (!r) return;
  r[field] = value;
  r._dirty = true;
}

function _trRenameProcedure(oldTp, newTp) {
  if (!_trDraftItems || !newTp.trim()) return;
  _trDraftItems.forEach(r => {
    if ((r.TestProcedure || '(No Procedure)') === oldTp) {
      r.TestProcedure = newTp.trim();
      r._dirty = true;
    }
  });
  _trEmptySections = _trEmptySections.map(s => s === oldTp ? newTp.trim() : s);
  _reRenderTR();
}

function _trAddSection() {
  if (!_trEditMode) return;
  const name = prompt('Enter new Test Section name');
  if (!name || !name.trim()) return;
  const tp = name.trim();
  const exists = (_trDraftItems || []).some(r => (r.TestProcedure || '(No Procedure)') === tp) || _trEmptySections.includes(tp);
  if (exists) { toast('Test Section already exists', 'error'); return; }
  _trEmptySections.push(tp);
  _reRenderTR();
}

function _trAddCase(tp) {
  const act = _amGetActivities().find(a => a.key === _amDrilldownKey);
  if (!act || !_trDraftItems) return;
  _trDraftItems.push({
    TestID: _trNewId(),
    TestCaseCode: '',
    TestName: '',
    Status: 'Not Started',
    Notes: '',
    Activity: act.activity,
    TestProcedure: tp === '(No Procedure)' ? '' : tp,
    Phase: act.phase,
    Location: act.location,
    Subsystem: act.subsystem,
    TestReport: act.testReport || null,
    _isNew: true,
    _dirty: true,
  });
  _trEmptySections = _trEmptySections.filter(s => s !== tp);
  _reRenderTR();
}

function _trCopyCase(testId) {
  const idx = _trDraftItems?.findIndex(x => String(x.TestID) === String(testId));
  if (idx === undefined || idx < 0) return;
  const src = _trDraftItems[idx];
  _trDraftItems.splice(idx + 1, 0, {
    ...src,
    TestID: _trNewId(),
    TestCaseCode: src.TestCaseCode ? src.TestCaseCode + '-Copy' : '',
    TestName: (src.TestName || '') + '-Copy',
    Status: 'Not Started',
    CompletedBy: null,
    CompletedDate: null,
    FailedReason: null,
    BlockedReason: null,
    _isNew: true,
    _dirty: true,
  });
  _reRenderTR();
}

function _trDragStart(testId) {
  _trDragId = String(testId);
}

function _trDropCase(targetProcedure, beforeTestId) {
  if (!_trEditMode || !_trDraftItems || !_trDragId) return;
  const fromIdx = _trDraftItems.findIndex(r => String(r.TestID) === String(_trDragId));
  if (fromIdx < 0) return;
  const [item] = _trDraftItems.splice(fromIdx, 1);
  item.TestProcedure = targetProcedure === '(No Procedure)' ? '' : targetProcedure;
  item._dirty = true;
  let toIdx = beforeTestId ? _trDraftItems.findIndex(r => String(r.TestID) === String(beforeTestId)) : -1;
  if (toIdx < 0) toIdx = _trDraftItems.length;
  _trDraftItems.splice(toIdx, 0, item);
  _trEmptySections = _trEmptySections.filter(s => s !== targetProcedure);
  _trDragId = null;
  _reRenderTR();
}

async function _trSaveEdit(key) {
  if (!_trDraftItems) return;
  const btn = document.querySelector('.tr-page-header .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const rowPatch = r => ({
      test_id: r.TestID,
      test_case_code: r.TestCaseCode || null,
      test_name: r.TestName || null,
      status: r.Status || 'Not Started',
      notes: r.Notes || null,
      activity: r.Activity || null,
      test_procedure: r.TestProcedure || null,
      phase: r.Phase || null,
      location: r.Location || null,
      subsystem: r.Subsystem || null,
      test_report: r.TestReport || null,
    });
    const inserts = _trDraftItems.filter(r => r._isNew).map(r => _dbInsert('test_items', [rowPatch(r)]));
    const updates = _trDraftItems.filter(r => !r._isNew && r._dirty).map(r => _dbUpdate('test_items', rowPatch(r), { test_id: r.TestID }));
    await Promise.all([...inserts, ...updates]);
    await loadTestItems();
    if (currentRoleUser.subsystem) TI = TI.filter(t => (t.Subsystem||'').toLowerCase() === currentRoleUser.subsystem.toLowerCase());
    logAudit('Test Case Edit Save', 'Test Register', `${inserts.length} added · ${updates.length} updated`);
    toast('Test case changes saved', 'success');
    _trEditMode = false;
    _trDraftItems = null;
    _trSelected.clear();
    _trBulkMsg = '';
    _trBulkMode = false;
    _trEmptySections = [];
    _trDragId = null;
    _reRenderTR();
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function _trDeleteCase(testId) {
  const r = (_trDraftItems || []).find(x => String(x.TestID) === String(testId)) || TI.find(x => String(x.TestID) === String(testId));
  if (!r) return;
  if (!confirm(`Are you sure you want to permanently delete ${r.TestCaseCode || r.TestName || r.TestID}? This cannot be undone.`)) return;
  try {
    if (!r._isNew) {
      await _dbDelete('test_items', { test_id: r.TestID });
      logAudit('Test Case Deleted', r.TestID, r.TestName || '', `Deleted ${r.TestID} ${r.TestName || ''}`);
      const idx = TI.findIndex(x => String(x.TestID) === String(r.TestID));
      if (idx !== -1) TI.splice(idx, 1);
    }
    if (_trDraftItems) _trDraftItems = _trDraftItems.filter(x => String(x.TestID) !== String(testId));
    _trSelected.delete(String(testId));
    toast('Test case deleted', 'success');
    _reRenderTR();
  } catch(e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

function _trBulkBarHTML(count) {
  return `
    <div class="tr-bulk-bar">
      <span><b>${count}</b> selected</span>
      ${_trBulkMsg ? `<span style="color:#bbf7d0;font-size:12px;">${escapeHtml(_trBulkMsg)}</span>` : ''}
      <select id="tr-bulk-status" class="form-input"><option value="">Bulk Status</option>${['Not Started','In Progress','Pass','Fail','Blocked','Not Applicable','Future Test'].map(s=>`<option value="${s}">${s}</option>`).join('')}</select>
      <input id="tr-bulk-notes" class="form-input" placeholder="Bulk notes">
      <button class="admin-action-btn" onclick="_trApplyBulkField()">Apply</button>
      <button class="form-secondary" onclick="_trClearSelection()">Clear Selection</button>
    </div>
  `;
}

function _trToggleSelect(testId, checked) {
  if (checked) _trSelected.add(String(testId)); else _trSelected.delete(String(testId));
  _reRenderTR();
}

function _trSelectSection(tp, checked) {
  const act = _amGetActivities().find(a => a.key === _amDrilldownKey);
  if (!act) return;
  const rows = (_trEditMode && _trDraftItems ? _trDraftItems : act.items).filter(r => (r.TestProcedure || '(No Procedure)') === tp);
  rows.forEach(r => checked ? _trSelected.add(String(r.TestID)) : _trSelected.delete(String(r.TestID)));
  _reRenderTR();
}

function _trClearSelection() {
  _trSelected.clear();
  _trBulkMsg = '';
  _reRenderTR();
}

function _trToggleBulkEdit() {
  _trBulkMode = !_trBulkMode;
  _trSelected.clear();
  _trBulkMsg = '';
  _reRenderTR();
}

async function _trApplyBulkField() {
  const status = document.getElementById('tr-bulk-status')?.value;
  const notes = document.getElementById('tr-bulk-notes')?.value;
  if (!_trSelected.size) { toast('Select at least one test case', 'error'); return; }
  if (!status && !notes) { toast('Choose a status or enter notes', 'error'); return; }
  try {
    const completedDate = new Date().toISOString();
    const completedBy = currentRoleUser?.name || currentProfile?.full_name || null;
    for (const id of [..._trSelected]) {
      const r = TI.find(x => String(x.TestID) === String(id));
      if (!r) continue;
      if (status) await _updateTestItemStatus(r.TestID, status, { row: r, notes, completedBy, completedDate, source: 'Test Register Bulk Edit' });
      else if (notes) {
        r.Notes = notes;
        await _dbUpdate('test_items', { notes }, { test_id: r.TestID });
      }
    }
    _trBulkMsg = 'Bulk changes applied';
    toast('Bulk changes applied', 'success');
    _reRenderTR();
  } catch(e) {
    toast('Bulk apply failed: ' + e.message, 'error');
  }
}

async function _trBulkDelete() {
  const ids = [..._trSelected];
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} selected test case${ids.length===1?'':'s'}? This cannot be undone.`)) return;
  for (const id of ids) await _trDeleteCase(id);
  _trSelected.clear();
  _trBulkMsg = '';
  _reRenderTR();
}

function _amOpenDrilldown(key) {
  _amDrilldownKey = key;
  _reRenderTR();
}

function _amCloseDrilldown() {
  _amDrilldownKey = null;
  _trEditMode = false;
  _trDraftItems = null;
  _trSelected.clear();
  _trBulkMsg = '';
  _trBulkMode = false;
  _trEmptySections = [];
  _trDragId = null;
  _reRenderTR();
}

function _amOpenEditModal(key) {
  const act = _amGetActivities().find(a => a.key === key);
  if (!act) return;
  const selectedReport = _trpFindRecordForActivity(act);
  const customReport = selectedReport ? '' : (act.testReport || '');
  const phases     = [...new Set(TI.map(r=>r.Phase)   .filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const locations  = [...new Set(TI.map(r=>r.Location).filter(Boolean))].sort();
  const subsystems = [...new Set(TI.map(r=>r.Subsystem).filter(Boolean))].sort();
  const st = _amComputeStatus(act);
  modal({
    title: 'Edit Activity',
    size: 'large',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full">
          <label>Activity Name</label>
          <input type="text" id="am-edit-name" class="form-input" value="${escapeHtml(act.activity)}">
        </div>
        <div class="form-field">
          <label>Phase</label>
          <select id="am-edit-phase" class="form-input">
            ${phases.map(p=>`<option value="${escapeHtml(p)}" ${act.phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Location</label>
          <select id="am-edit-location" class="form-input">
            ${locations.map(l=>`<option value="${escapeHtml(l)}" ${act.location===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Subsystem</label>
          <select id="am-edit-subsystem" class="form-input">
            ${subsystems.map(s=>`<option value="${escapeHtml(s)}" ${act.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Test Report</label>
          ${_trpReportSelectHTML(selectedReport?.id || '', customReport)}
        </div>
        ${st === 'Future Test' ? `
        <div class="form-field form-field-full">
          <label>Future Test Reason</label>
          <textarea id="am-edit-ft-reason" class="form-input" rows="2">${escapeHtml(act.futureTestReason||'')}</textarea>
        </div>` : ''}
      </div>
      <p style="font-size:12px;color:var(--gray-500);margin-top:12px;">
        Changes to Activity Name, Phase, Location, or Subsystem update all child test items. Activity Status is auto-calculated from test item statuses.
      </p>
    `,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button>${st === 'Future Test' ? `<button class="admin-action-btn" style="background:#059669;" onclick="_amSaveEdit('${escapeHtml(key)}',true)">Deploy to Field</button>` : ''}<button class="admin-action-btn" onclick="_amSaveEdit('${escapeHtml(key)}')">Save Changes</button>`
  });
}

async function _amSaveEdit(key, deployToField = false) {
  const act = _amGetActivities().find(a => a.key === key);
  if (!act) return;

  const newName      = document.getElementById('am-edit-name')?.value.trim();
  const newPhase     = document.getElementById('am-edit-phase')?.value;
  const newLocation  = document.getElementById('am-edit-location')?.value;
  const newSubsystem = document.getElementById('am-edit-subsystem')?.value;
  const beforeLink = _trpCurrentActivityReportLink(act);
  let afterLink = _trpReportLinkFromModal();
  const newFTReason  = document.getElementById('am-edit-ft-reason')?.value.trim() || null;

  if (!newName) { toast('Activity name is required', 'error'); return; }

  const btn = event?.target?.closest?.('button') || document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = deployToField ? 'Deploying…' : 'Saving…'; }

  try {
    afterLink = await _trpResolveReportLink(afterLink, { phase: newPhase, location: newLocation, subsystem: newSubsystem, activity: newName });
    // Update all test items that belong to this activity
    const patch = {
      activity:       newName,
      phase:          newPhase,
      location:       newLocation,
      subsystem:      newSubsystem,
      ..._trpReportLinkPatch(afterLink),
    };
    const updates = act.items.map(r => _dbUpdate('test_items', patch, { test_id: r.TestID }));
    await Promise.all(updates);

    // Update in-memory TI
    act.items.forEach(r => {
      r.Activity      = newName;
      r.Phase         = newPhase;
      r.Location      = newLocation;
      r.Subsystem     = newSubsystem;
    });
    _trpApplyReportLinkToItems(act.items, afterLink);

    // Update future_test_reason if applicable
    if (newFTReason !== null) {
      const existing = _activityRecords.find(ar =>
        ar.phase === act.phase && ar.location === act.location &&
        ar.subsystem === act.subsystem && ar.activity_name === act.activity
      );
      if (existing) {
        await _dbUpdate('activity_records', { future_test_reason: newFTReason, updated_at: new Date().toISOString() }, { id: existing.id });
        existing.future_test_reason = newFTReason;
      }
    }

    if (deployToField) {
      await Promise.all(act.items.map(r => _updateTestItemStatus(r.TestID, 'Not Started', { row: r, source: 'Activity Edit Deploy to Field' })));
      const records = _activityRecords.filter(ar =>
        (ar.phase === act.phase && ar.location === act.location && ar.subsystem === act.subsystem && ar.activity_name === act.activity) ||
        (ar.phase === newPhase && ar.location === newLocation && ar.subsystem === newSubsystem && ar.activity_name === newName)
      );
      for (const rec of records) {
        await _dbUpdate('activity_records', { future_test_reason: null, updated_at: new Date().toISOString() }, { id: rec.id });
        rec.future_test_reason = null;
      }
      const reportDetails = _trpReportLinkAuditDetails(beforeLink, afterLink, act.items.length);
      logAudit('Deploy to Field', newName, [reportDetails, `${act.items.length} items → Not Started`].filter(Boolean).join(' · '));
      _trpLogActivityReportLinkChange(newName, beforeLink, afterLink, act.items.length, `Phase: ${newPhase} · Location: ${newLocation}`);
      toast(`${act.items.length} test items deployed to field`, 'success');
    } else {
      const reportDetails = _trpReportLinkAuditDetails(beforeLink, afterLink, act.items.length);
      logAudit('Activity Edited', newName, [reportDetails, `Phase: ${newPhase} · Location: ${newLocation}`].filter(Boolean).join(' · '));
      _trpLogActivityReportLinkChange(newName, beforeLink, afterLink, act.items.length, `Phase: ${newPhase} · Location: ${newLocation}`);
      toast(`Activity updated: ${newName}`, 'success');
    }
    closeModal();
    _amDrilldownKey = null;
    _reRenderTR();
  } catch(e) {
    toast((deployToField ? 'Deploy' : 'Save') + ' failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = deployToField ? 'Deploy to Field' : 'Save Changes'; }
  }
}

function _amOpenDeployToFieldModal() {
  const all = _amGetActivities();
  const selected = all.filter(a => _amSelected.has(a.key) && _amComputeStatus(a) === 'Future Test');
  if (!selected.length) { toast('No Future Test activities selected', 'error'); return; }
  const totalItems = selected.reduce((sum,a) => sum + a.items.length, 0);
  modal({
    title: 'Deploy Activities to Field',
    size: 'medium',
    body: `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-weight:600;color:#059669;margin-bottom:4px;">${selected.length} activit${selected.length===1?'y':'ies'} · ${totalItems} test items</div>
        <div style="font-size:12px;color:#047857;">All test items will be set to "Not Started" and Future Test Reason will be cleared.</div>
      </div>
      <div style="max-height:140px;overflow-y:auto;margin-bottom:8px;">
        ${selected.map(a=>`<div style="font-size:12px;padding:3px 0;border-bottom:1px solid #f3f4f6;">${escapeHtml(a.activity)} <span style="color:var(--gray-500);">· ${escapeHtml(a.location)} · ${escapeHtml(a.phase)}</span></div>`).join('')}
      </div>
    `,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button><button class="admin-action-btn" style="background:#059669;" onclick="_amConfirmDeployToField()">Confirm & Deploy</button>`
  });
}

async function _amConfirmDeployToField() {
  const all = _amGetActivities();
  const selected = all.filter(a => _amSelected.has(a.key) && _amComputeStatus(a) === 'Future Test');
  const allItems = selected.flatMap(a => a.items);

  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deploying…'; }

  try {
    // Set all test items to Not Started
    const updates = allItems.map(r => _updateTestItemStatus(r.TestID, 'Not Started', { row: r, source: 'Bulk Deploy to Field' }));
    await Promise.all(updates);

    // Clear future_test_reason in activity_records
    for (const act of selected) {
      const existing = _activityRecords.find(ar =>
        ar.phase === act.phase && ar.location === act.location &&
        ar.subsystem === act.subsystem && ar.activity_name === act.activity
      );
      if (existing) {
        await _dbUpdate('activity_records', { future_test_reason: null, updated_at: new Date().toISOString() }, { id: existing.id });
        existing.future_test_reason = null;
      }
    }

    logAudit('Deploy to Field', `${selected.length} activities`, `${allItems.length} items → Not Started`);
    toast(`${allItems.length} test items deployed to field`, 'success');
    _amSelected.clear();
    closeModal();
    _reRenderTR();
  } catch(e) {
    toast('Deploy failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Deploy'; }
  }
}

function _amSetFilter(k, v) {
  _amFilters[k] = v;
  // Cascade resets: phase change clears location + (non-locked) subsystem
  if (k === 'phase')    { _amFilters.location = ''; _amFilters.subsystem = currentRoleUser?.subsystem || ''; }
  if (k === 'location') { _amFilters.subsystem = currentRoleUser?.subsystem || ''; }
  _amSelected.clear();
  _reRenderTR();
}

function _amClearFilters() {
  const userSub = currentRoleUser?.subsystem || '';
  _amFilters = { phase:'', location:'', subsystem: userSub, status:'' };
  _amSelected.clear();
  _reRenderTR();
}

function _amToggleRow(key, checked) {
  if (checked) _amSelected.add(key); else _amSelected.delete(key);
  _reRenderTR();
}

function _amToggleAll(checked) {
  const all = _amGetActivities().filter(a => {
    const st = _amComputeStatus(a);
    return (!_amFilters.phase     || a.phase     === _amFilters.phase)    &&
           (!_amFilters.location  || a.location  === _amFilters.location) &&
           (!_amFilters.subsystem || a.subsystem === _amFilters.subsystem)&&
           (!_amFilters.status    || st          === _amFilters.status);
  });
  if (checked) all.forEach(a => _amSelected.add(a.key));
  else _amSelected.clear();
  _reRenderTR();
}

function _amClearSelection() {
  _amSelected.clear();
  _reRenderTR();
}

function _reRenderTR() {
  const root = document.getElementById('test-register-content');
  if (root) root.innerHTML = _testRegisterHTML();
  // Also update legacy admin tab body if activity manager tab is open
  const body = document.getElementById('admin-tab-body');
  if (body && _adminTab === 'activitymanager') body.innerHTML = _adminActivityManagerHTML();
}

function _amOpenFutureTestModal() {
  if (!_amSelected.size) return;
  const all = _amGetActivities();
  const selected = all.filter(a => _amSelected.has(a.key));
  const totalItems = selected.reduce((sum,a) => sum + a.items.length, 0);
  modal({
    title: 'Mark Activities as Future Test',
    size: 'medium',
    body: `
      <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-weight:600;color:#5b21b6;margin-bottom:4px;">${_amSelected.size} activit${_amSelected.size===1?'y':'ies'} selected · ${totalItems} test items affected</div>
        <div style="font-size:12px;color:#6d28d9;">All test items within these activities will be updated to "Future Test" status.</div>
      </div>
      <div style="margin-bottom:12px;max-height:120px;overflow-y:auto;">
        ${selected.map(a=>`<div style="font-size:12px;padding:3px 0;border-bottom:1px solid #f3f4f6;">${escapeHtml(a.activity)} <span style="color:var(--gray-500);">· ${escapeHtml(a.location)} · ${escapeHtml(a.phase)}</span></div>`).join('')}
      </div>
      <div class="form-field">
        <label>Future Test Reason <span style="color:var(--bad);">*</span></label>
        <textarea id="am-ft-reason" class="form-input" rows="3" placeholder="e.g. DCS SAT Testing - Future Test - Pending Wayside Installation"></textarea>
      </div>
    `,
    footer: `<button class="form-secondary" onclick="closeModal()">Cancel</button><button class="admin-action-btn" style="background:#5b21b6;" onclick="_amConfirmFutureTest()">Confirm & Update All</button>`
  });
}

async function _amConfirmFutureTest() {
  const reason = document.getElementById('am-ft-reason')?.value.trim();
  if (!reason) { toast('A Future Test Reason is required','error'); return; }

  const all      = _amGetActivities();
  const selected = all.filter(a => _amSelected.has(a.key));
  const allItems = selected.flatMap(a => a.items);

  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

  try {
    // 1. Cascade status to all test items in parallel
    const updates = allItems.map(r => _updateTestItemStatus(r.TestID, 'Future Test', { row: r, source: 'Mark Future Test', reason }));
    await Promise.all(updates);

    // 2. Store future_test_reason in activity_records
    for (const act of selected) {
      const existing = _activityRecords.find(ar =>
        ar.phase === act.phase && ar.location === act.location &&
        ar.subsystem === act.subsystem && ar.activity_name === act.activity
      );
      if (existing) {
        await _dbUpdate('activity_records', { future_test_reason: reason, updated_at: new Date().toISOString() }, { id: existing.id });
        existing.future_test_reason = reason;
      } else {
        const inserted = await _dbInsert('activity_records', [{
          phase: act.phase, location: act.location, subsystem: act.subsystem,
          activity_name: act.activity, future_test_reason: reason
        }]);
        _activityRecords.push(...inserted);
      }
    }

    logAudit('Bulk Future Test', `${selected.length} activities`, reason);
    toast(`${allItems.length} test items updated to Future Test`, 'success');
    _amSelected.clear();
    closeModal();
    _reRenderTR();
  } catch(e) {
    toast('Update failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Update All'; }
  }
}

// ==========================================================================
// MODAL HELPERS
// ==========================================================================
function modal({ title, sub, body, footer, size }) {
  let overlay = document.getElementById('modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    // Clicking outside does NOT close — user must use Cancel button
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal ${size === 'large' ? 'modal-large' : ''}">
      <div class="modal-head">
        <div>
          <div class="modal-title">${title}</div>
          ${sub ? `<div class="modal-sub">${sub}</div>` : ''}
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">${body || ''}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>
  `;
  overlay.classList.add('active');
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.remove('active');
}

// =============================================================================
// P6 SCHEDULE — ADMIN TOOL
// =============================================================================

let _p6Tab      = 'import';   // 'import' | 'mapping' | 'health' | 'weights'
let _p6MapTab   = 'activity'; // 'activity' | 'testcase'
let _p6MappingFilters = { phase:'', location:'', subsystem:'', linked:'' };
let _p6WeightFilter   = { phase:'', location:'', subsystem:'' };
let _p6ImportType     = 'baseline'; // 'baseline' | 'current'

function renderAdminP6() {
  const root = document.getElementById('p6-hero-content');
  const cont = document.getElementById('p6-admin-content');
  if (!root || !cont) return;
  root.innerHTML = `
    <div class="page-hero-inner">
      <div class="role-badge role-admin-badge">Admin Tool</div>
      <h1 class="page-hero-title">P6 Schedule</h1>
      <p class="page-hero-sub">Import P6 exports, map activities, manage weights and track schedule changes.</p>
    </div>`;
  cont.innerHTML = _p6AdminHTML();
}

function _p6AdminHTML() {
  const tabs = [
    { id:'import',  label:'📥 Import' },
    { id:'mapping', label:'🔗 Mapping' },
    { id:'health',  label:'🩺 Health' },
    { id:'weights', label:'⚖️ Weights' },
  ];
  return `
    <div class="admin-section p6-shell">
      <div class="admin-tabs" style="margin-bottom:24px;">
        ${tabs.map(t=>`<button class="admin-tab${_p6Tab===t.id?' active':''}" onclick="_p6SetTab('${t.id}')">${t.label}</button>`).join('')}
      </div>
      ${_p6Tab === 'import'  ? _p6ImportTabHTML()  : ''}
      ${_p6Tab === 'mapping' ? _p6MappingTabHTML() : ''}
      ${_p6Tab === 'health'  ? _p6HealthTabHTML()  : ''}
      ${_p6Tab === 'weights' ? _p6WeightsTabHTML() : ''}
    </div>`;
}

function _p6SetTab(t) { _p6Tab = t; renderAdminP6(); }

// ─── IMPORT TAB ───────────────────────────────────────────────────────────────
function _p6ImportTabHTML() {
  const baselineBatch  = P6_BATCHES.find(b => b.schedule_type === 'baseline' && b.is_current);
  const currentBatch   = P6_BATCHES.find(b => b.schedule_type === 'current'  && b.is_current);
  const isRebaseline   = _p6ImportType === 'baseline' && !!baselineBatch;

  const recentBatches  = [...P6_BATCHES].slice(0, 8);

  return `
    <div class="p6-import-layout">
      <!-- Upload card -->
      <div class="data-card" style="padding:24px;max-width:560px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:18px;">Upload P6 Schedule Export</div>

        <!-- Baseline / Current toggle -->
        <div style="margin-bottom:18px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;color:var(--gray-600);margin-bottom:8px;">SCHEDULE TYPE</div>
          <div style="display:flex;gap:0;border:1px solid var(--gray-200);border-radius:8px;overflow:hidden;">
            <button onclick="_p6SetImportType('baseline')" class="p6-type-btn${_p6ImportType==='baseline'?' active':''}" style="flex:1;">
              Baseline ${baselineBatch ? '<span class="badge badge-passed" style="font-size:10px;">Already set</span>' : ''}
            </button>
            <button onclick="_p6SetImportType('current')" class="p6-type-btn${_p6ImportType==='current'?' active':''}" style="flex:1;">
              Current ${currentBatch ? '<span class="badge badge-review" style="font-size:10px;">Rev loaded</span>' : ''}
            </button>
          </div>
          ${isRebaseline ? `
            <div style="margin-top:10px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:12px;color:#9a3412;">
              ⚠ A baseline already exists. Uploading again will mark this as a <strong>Re-baseline</strong>. You will be required to enter a reason.
            </div>` : ''}
        </div>

        <!-- Title -->
        <div class="form-field" style="margin-bottom:14px;">
          <label class="login-label">SCHEDULE TITLE</label>
          <input id="p6-import-title" class="form-input" placeholder="e.g. Rev 063 — Jan 2026" style="font-size:13px;">
        </div>

        ${isRebaseline ? `
        <div class="form-field" style="margin-bottom:14px;">
          <label class="login-label">RE-BASELINE REASON (required)</label>
          <textarea id="p6-rebaseline-note" class="form-input" rows="2" placeholder="Reason for re-baselining..." style="font-size:13px;"></textarea>
        </div>` : ''}

        <!-- Notes -->
        <div class="form-field" style="margin-bottom:18px;">
          <label class="login-label">NOTES (optional)</label>
          <textarea id="p6-import-notes" class="form-input" rows="2" placeholder="Schedule update notes, key changes..." style="font-size:13px;"></textarea>
        </div>

        <!-- File drop zone -->
        <div class="p6-dropzone" id="p6-dropzone" onclick="document.getElementById('p6-file-input').click()"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="_p6HandleDrop(event)">
          <svg width="32" height="32" viewBox="0 0 20 20" fill="currentColor" style="color:var(--gray-400);margin-bottom:10px;">
            <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
          </svg>
          <div style="font-size:13px;font-weight:600;color:var(--gray-600);">Drop Excel file here or click to browse</div>
          <div style="font-size:11px;color:var(--gray-400);margin-top:4px;">.xlsx files only</div>
          <input type="file" id="p6-file-input" accept=".xlsx" style="display:none" onchange="_p6HandleFileSelect(this)">
        </div>

        <div id="p6-import-preview" style="margin-top:16px;"></div>
      </div>

      <!-- Import history -->
      <div style="flex:1;min-width:280px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;color:var(--gray-700);">Import History</div>
        ${recentBatches.length ? `
          <div class="data-card" style="padding:0;overflow:hidden;">
            ${recentBatches.map(b => `
              <div style="padding:12px 16px;border-bottom:1px solid var(--gray-100);display:flex;align-items:flex-start;gap:12px;">
                <span class="badge ${b.schedule_type==='baseline'?'badge-passed':'badge-review'}" style="font-size:10px;flex-shrink:0;margin-top:2px;">
                  ${b.is_rebaseline ? 'Re-baseline' : b.schedule_type === 'baseline' ? 'Baseline' : 'Current'}
                </span>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(b.title)}</div>
                  <div style="font-size:11px;color:var(--gray-500);margin-top:2px;">
                    ${new Date(b.imported_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                    · ${b.row_count || 0} activities
                    · by ${escapeHtml(b.imported_by||'—')}
                  </div>
                  ${b.notes ? `<div style="font-size:11px;color:var(--gray-500);margin-top:2px;font-style:italic;">${escapeHtml(b.notes)}</div>` : ''}
                  ${b.rebaseline_note ? `<div style="font-size:11px;color:#9a3412;margin-top:2px;">↳ ${escapeHtml(b.rebaseline_note)}</div>` : ''}
                </div>
                ${b.is_current ? '<span style="font-size:10px;font-weight:700;color:var(--good);">CURRENT</span>' : ''}
              </div>`).join('')}
          </div>` : `<div class="docs-empty" style="padding:32px;"><h3>No imports yet</h3><p>Upload your first P6 schedule above.</p></div>`}
      </div>
    </div>`;
}

function _p6SetImportType(t) { _p6ImportType = t; renderAdminP6(); }

function _p6HandleDrop(e) {
  e.preventDefault();
  document.getElementById('p6-dropzone')?.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) _p6ParseFile(file);
}
function _p6HandleFileSelect(input) {
  const file = input.files?.[0];
  if (file) _p6ParseFile(file);
}

function _p6ParseFile(file) {
  if (!file.name.endsWith('.xlsx')) { toast('Please upload an .xlsx file', 'error'); return; }
  const preview = document.getElementById('p6-import-preview');
  if (preview) preview.innerHTML = `<div style="font-size:12px;color:var(--gray-500);">Parsing file…</div>`;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

      // Find header row (has "Activity ID" in col 0 or 1)
      let headerIdx = -1;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        if (rows[i].some(c => String(c||'').includes('Activity ID'))) { headerIdx = i; break; }
      }
      if (headerIdx < 0) { toast('Could not find Activity ID column in this file', 'error'); return; }

      const headers = rows[headerIdx].map(h => String(h||'').trim());
      const idCol   = headers.findIndex(h => h === 'Activity ID');
      const nameCol = headers.findIndex(h => h === 'Activity Name');
      const startCol= headers.findIndex(h => h === 'Start');
      const finCol  = headers.findIndex(h => h === 'Finish');
      const durCol  = headers.findIndex(h => h === 'Remaining Duration');
      const unitCol = headers.findIndex(h => h === 'Budgeted Units');

      // WBS/summary band names to exclude (project-level nodes, not real activities)
      const WBS_EXCLUDE = /^\[?project schedule\]?$/i;

      const activities = [];
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row    = rows[i];
        const p6id   = String(row[idCol]   || '').trim();
        const p6name = String(row[nameCol] || '').trim();
        if (!p6id)  continue;                            // blank ID row
        if (!p6name || WBS_EXCLUDE.test(p6name)) continue; // no name or WBS band
        if (!p6id.match(/^[0-9A-Z]/)) continue;         // skip non-activity IDs
        if (p6id.toLowerCase().includes('activity id')) continue;

        const rawStart  = String(row[startCol]  || '').trim();
        const rawFinish = String(row[finCol]     || '').trim();
        const isActual  = rawStart.endsWith(' A') || rawFinish.endsWith(' A');
        const startDate = _p6ParseDate(rawStart);
        const finDate   = _p6ParseDate(rawFinish);

        // Extract location code from P6 ID: 0-P2-TC-{LOC}-FA-...
        const locMatch  = p6id.match(/^[^-]+-[^-]+-[^-]+-([^-]+)-/);
        const locCode   = locMatch ? locMatch[1] : '';

        // Remaining duration: "54d" → 54
        const durStr    = String(row[durCol] || '').replace('d','').trim();
        const durDays   = parseInt(durStr) || 0;

        activities.push({
          p6_id: p6id,
          p6_name: p6name,
          p6_location_code: locCode,
          start_date: startDate,
          finish_date: finDate,
          remaining_duration_days: durDays,
          budgeted_units: parseFloat(row[unitCol]) || 0,
          is_actual: isActual,
        });
      }

      window._p6Parsed = activities;
      _p6ShowPreview(activities);
    } catch(err) {
      toast('Failed to parse file: ' + err.message, 'error');
      if (preview) preview.innerHTML = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

function _p6ParseDate(raw) {
  if (!raw) return null;
  // Remove " A" suffix (actual indicator)
  const cleaned = raw.replace(/ A$/, '').trim();
  // Format "14-Aug-25" → parse manually
  const m = cleaned.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const yr = parseInt(m[3]) < 100 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d  = new Date(yr, months[m[2]], parseInt(m[1]));
    return isNaN(d) ? null : d.toISOString().slice(0,10);
  }
  // ISO format
  const d = new Date(cleaned);
  return isNaN(d) ? null : d.toISOString().slice(0,10);
}

function _p6ShowPreview(activities) {
  const preview = document.getElementById('p6-import-preview');
  if (!preview) return;
  const locs = [...new Set(activities.map(a => a.p6_location_code).filter(Boolean))].sort();
  preview.innerHTML = `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;">
      <div style="font-size:13px;font-weight:700;color:#065f46;margin-bottom:10px;">✓ ${activities.length} activities parsed</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#047857;margin-bottom:12px;">
        <span><b>${locs.length}</b> locations: ${locs.join(', ')}</span>
        <span><b>${activities.filter(a=>a.is_actual).length}</b> actuals</span>
        <span><b>${activities.filter(a=>!a.is_actual).length}</b> planned</span>
      </div>
      <button class="admin-action-btn" onclick="_p6ConfirmImport()" style="width:100%;">
        Confirm Import
      </button>
    </div>`;
}

async function _p6ConfirmImport() {
  const title = document.getElementById('p6-import-title')?.value.trim();
  const notes = document.getElementById('p6-import-notes')?.value.trim();
  const rebaseNote = document.getElementById('p6-rebaseline-note')?.value.trim();

  if (!title) { toast('Please enter a schedule title', 'error'); return; }
  const baselineBatch = P6_BATCHES.find(b => b.schedule_type === 'baseline' && b.is_current);
  const isRebase      = _p6ImportType === 'baseline' && !!baselineBatch;
  if (isRebase && !rebaseNote) { toast('Please enter a re-baseline reason', 'error'); return; }

  const activities = window._p6Parsed;
  if (!activities?.length) { toast('No parsed activities to import', 'error'); return; }

  try {
    // 1. Mark previous batch of same type as not current
    const prevOfType = P6_BATCHES.filter(b => b.schedule_type === _p6ImportType && b.is_current);
    for (const b of prevOfType) {
      await _dbUpdate('p6_import_batches', { is_current: false }, { id: b.id });
    }

    // 2. Create new batch record
    const batchRow = {
      title,
      schedule_type: _p6ImportType,
      is_rebaseline: isRebase,
      rebaseline_note: rebaseNote || null,
      notes: notes || null,
      imported_by: currentRoleUser?.name || 'Admin',
      row_count: activities.length,
      is_current: true,
    };
    const [batch] = await _dbInsert('p6_import_batches', [batchRow]);
    if (!batch?.id) throw new Error('Batch insert did not return id');

    // 3. Insert activities in chunks of 50
    const withBatch = activities.map(a => ({ ...a, batch_id: batch.id }));
    for (let i = 0; i < withBatch.length; i += 50) {
      await _dbInsert('p6_activities', withBatch.slice(i, i + 50));
    }

    await loadP6Data();
    toast(`✓ Imported ${activities.length} activities (${_p6ImportType})`, 'success');
    window._p6Parsed = null;
    renderAdminP6();

    // Auto-switch to mapping tab after first import
    if (P6_BATCHES.length === 1) { _p6Tab = 'mapping'; renderAdminP6(); }
  } catch(err) {
    console.error('[P6 import]', err);
    toast('Import failed: ' + err.message, 'error');
  }
}

// ─── MAPPING TAB ──────────────────────────────────────────────────────────────

function _p6MappingTabHTML() {
  const activities = _amGetActivities(); // portal activities

  // Cascade filter options (same pattern as other tools)
  const phases     = [...new Set(activities.map(a=>a.phase).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const locations  = [...new Set(activities
    .filter(a => !_p6MappingFilters.phase || a.phase === _p6MappingFilters.phase)
    .map(a=>a.location).filter(Boolean))].sort();
  const subsystems = [...new Set(activities
    .filter(a =>
      (!_p6MappingFilters.phase     || a.phase     === _p6MappingFilters.phase) &&
      (!_p6MappingFilters.location  || a.location  === _p6MappingFilters.location))
    .map(a=>a.subsystem).filter(Boolean))].sort();

  let visibleActs = activities.filter(a =>
    (!_p6MappingFilters.phase     || a.phase     === _p6MappingFilters.phase)     &&
    (!_p6MappingFilters.location  || a.location  === _p6MappingFilters.location)  &&
    (!_p6MappingFilters.subsystem || a.subsystem === _p6MappingFilters.subsystem)
  );

  if (_p6MappingFilters.linked === 'unlinked') visibleActs = visibleActs.filter(a => !_p6IsActivityLinked(a));
  if (_p6MappingFilters.linked === 'linked')   visibleActs = visibleActs.filter(a =>  _p6IsActivityLinked(a));

  // Current P6 activities from latest batch (prefer current, fall back to baseline)
  const curBatch  = P6_BATCHES.find(b => b.schedule_type === 'current'  && b.is_current);
  const baseBatch = P6_BATCHES.find(b => b.schedule_type === 'baseline' && b.is_current);
  const useBatch  = curBatch || baseBatch;
  const p6List    = useBatch ? P6_ACTS.filter(a => a.batch_id === useBatch.id) : [];

  if (!p6List.length) return `
    <div class="docs-empty">
      <h3>No P6 schedule loaded</h3>
      <p>Import a P6 schedule on the Import tab first.</p>
    </div>`;

  return `
    <div class="p6-mapping-layout">
      <!-- LEFT: Portal activities -->
      <div class="p6-mapping-left">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px;">
          Portal Activities
          <span style="font-weight:400;color:var(--gray-500);margin-left:8px;">${visibleActs.length} shown</span>
        </div>

        <!-- Cascade filters -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
          <select class="filter-select" style="font-size:12px;" onchange="_p6MapFilter('phase',this.value)">
            <option value="">All Phases</option>
            ${phases.map(p=>`<option value="${escapeHtml(p)}" ${_p6MappingFilters.phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
          </select>
          <select class="filter-select" style="font-size:12px;" onchange="_p6MapFilter('location',this.value)">
            <option value="">All Locations</option>
            ${locations.map(l=>`<option value="${escapeHtml(l)}" ${_p6MappingFilters.location===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
          </select>
          <select class="filter-select" style="font-size:12px;" onchange="_p6MapFilter('subsystem',this.value)">
            <option value="">All Subsystems</option>
            ${subsystems.map(s=>`<option value="${escapeHtml(s)}" ${_p6MappingFilters.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
          </select>
          <select class="filter-select" style="font-size:12px;" onchange="_p6MapFilter('linked',this.value)">
            <option value="">All</option>
            <option value="unlinked" ${_p6MappingFilters.linked==='unlinked'?'selected':''}>🔴 Unlinked</option>
            <option value="linked"   ${_p6MappingFilters.linked==='linked'?'selected':''}>🟢 Linked</option>
          </select>
        </div>

        <!-- Activity list -->
        <div class="p6-activity-list">
          ${(()=>{
            // Reset act data store for this render
            window._p6ActData = {};
            return visibleActs.map(a => {
              const sid      = _p6Sid(a.key);
              window._p6ActData[sid] = a;
              const linked   = _p6GetActivityLinks(a);
              const isLinked = linked.length > 0;
              const expanded = window._p6ExpandedSid === sid;
              return `
                <div class="p6-act-row ${isLinked?'p6-act-linked':'p6-act-unlinked'}">
                  <div class="p6-act-row-header" onclick="_p6ToggleActExpand('${sid}')">
                    <div style="flex:1;min-width:0;">
                      <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.activity)}</div>
                      <div style="font-size:11px;color:var(--gray-500);">${escapeHtml(a.subsystem)} · ${escapeHtml(a.location)} · ${escapeHtml(a.phase)}</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                      ${isLinked
                        ? `<span class="badge badge-passed" style="font-size:10px;">🟢 ${linked.length} link${linked.length>1?'s':''}</span>`
                        : `<span class="badge badge-notstarted" style="font-size:10px;">🔴 Unlinked</span>`}
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" style="color:var(--gray-400);transform:rotate(${expanded?'90':'0'}deg);transition:transform 0.15s;">
                        <path fill-rule="evenodd" d="M7.293 4.707a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
                      </svg>
                    </div>
                  </div>
                  ${expanded ? _p6ActivityLinkDetail(a, p6List, sid) : ''}
                </div>`;
            }).join('');
          })()}
          ${!visibleActs.length ? `<div style="padding:32px;text-align:center;color:var(--gray-400);">No activities match filters</div>` : ''}
        </div>
      </div>

      <!-- RIGHT: P6 reference panel -->
      <div class="p6-mapping-right">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">
          P6 Reference Panel
          <span style="font-weight:400;color:var(--gray-500);margin-left:8px;">${p6List.length} activities</span>
        </div>
        <p style="font-size:11px;color:var(--gray-500);margin-bottom:10px;line-height:1.4;">
          All P6 activities from <b>${useBatch?.title||'—'}</b>.
          Green = already linked to a portal activity.
          Filter the left panel by location to narrow this list.
        </p>
        <input type="text" class="form-input" style="font-size:12px;margin-bottom:8px;" placeholder="🔍 Filter P6 list…"
          oninput="document.querySelectorAll('.p6-p6-row').forEach(r=>{r.style.display=this.value&&!r.textContent.toLowerCase().includes(this.value.toLowerCase())?'none':''})">
        <div class="p6-p6-list">
          ${(()=>{
            // If a location filter is active, prioritise matching location code activities at top
            const locCode = _p6MappingFilters.location ? _p6LocCode(_p6MappingFilters.location) : '';
            const sorted  = locCode
              ? [...p6List.filter(p=>p.p6_location_code===locCode), ...p6List.filter(p=>p.p6_location_code!==locCode)]
              : p6List;
            return sorted.map(p => {
              const mappedCount = P6_MAP.filter(m => m.p6_activity_id === p.id).length;
              return `
                <div class="p6-p6-row ${mappedCount?'p6-p6-mapped':''}">
                  <div style="font-size:10px;font-weight:700;color:var(--gray-400);font-family:monospace;">${escapeHtml(p.p6_id)}</div>
                  <div style="font-size:12px;font-weight:600;margin:2px 0;line-height:1.3;">${escapeHtml(p.p6_name)}</div>
                  <div style="font-size:11px;color:var(--gray-500);">
                    ${p.start_date ? _fmtDate(p.start_date) : '—'} → ${p.finish_date ? _fmtDate(p.finish_date) : '—'}
                    ${p.is_actual ? '<span style="color:#059669;font-weight:600;"> ✓ Actual</span>' : ''}
                  </div>
                  ${mappedCount ? `<div style="font-size:10px;color:var(--good);margin-top:3px;font-weight:600;">↔ ${mappedCount} portal link${mappedCount>1?'s':''}</div>` : ''}
                </div>`;
            }).join('');
          })()}
        </div>
      </div>
    </div>`;
}

function _p6IsActivityLinked(act) {
  return P6_MAP.some(m =>
    m.portal_phase     === act.phase    &&
    m.portal_location  === act.location &&
    m.portal_subsystem === act.subsystem&&
    m.portal_activity  === act.activity &&
    !m.portal_test_case_code
  );
}

function _p6GetActivityLinks(act) {
  return P6_MAP.filter(m =>
    m.portal_phase     === act.phase    &&
    m.portal_location  === act.location &&
    m.portal_subsystem === act.subsystem&&
    m.portal_activity  === act.activity
  );
}

// ── Stable DOM-safe ID from an activity key ──────────────────────────────────
function _p6Sid(key) {
  return 'pa_' + key.replace(/[^a-zA-Z0-9]/g, '_');
}

// ── Merged search-dropdown component ─────────────────────────────────────────
// Renders a single combined search+list control; value stored in hidden input.
function _p6SS(sid, p6List, placeholder) {
  const opts = p6List.map(p =>
    `<div class="p6-ss-opt" data-id="${escapeHtml(p.id)}" onmousedown="_p6SSPick('${sid}',this)">
       <span class="p6-ss-loc">[${escapeHtml(p.p6_location_code||'?')}]</span> ${escapeHtml(p.p6_name)}
     </div>`
  ).join('');
  return `
    <div class="p6-ss" id="p6-ss-${sid}">
      <input class="p6-ss-inp form-input" type="text" autocomplete="off"
        placeholder="${escapeHtml(placeholder||'Search P6 activities…')}"
        oninput="_p6SSFilter('${sid}')"
        onfocus="_p6SSOpen('${sid}')"
        onblur="_p6SSClose('${sid}')">
      <div class="p6-ss-drop" id="p6-ss-drop-${sid}">
        <div class="p6-ss-opts">${opts}</div>
        <div class="p6-ss-none" style="display:none;padding:8px 12px;font-size:12px;color:var(--gray-400);">No matches</div>
      </div>
      <input type="hidden" id="p6-ss-val-${sid}">
    </div>`;
}

function _p6SSFilter(sid) {
  const wrap = document.getElementById(`p6-ss-${sid}`);
  if (!wrap) return;
  const q    = wrap.querySelector('.p6-ss-inp').value.toLowerCase().trim();
  const drop = document.getElementById(`p6-ss-drop-${sid}`);
  drop.style.display = 'block';
  let any = false;
  drop.querySelectorAll('.p6-ss-opt').forEach(o => {
    const show = !q || o.textContent.toLowerCase().includes(q);
    o.style.display = show ? '' : 'none';
    if (show) any = true;
  });
  drop.querySelector('.p6-ss-none').style.display = any ? 'none' : '';
}

function _p6SSOpen(sid) {
  const drop = document.getElementById(`p6-ss-drop-${sid}`);
  if (drop) drop.style.display = 'block';
}

// Use setTimeout so onblur fires after onmousedown pick completes
function _p6SSClose(sid) {
  setTimeout(() => {
    const drop = document.getElementById(`p6-ss-drop-${sid}`);
    if (drop) drop.style.display = 'none';
  }, 200);
}

function _p6SSPick(sid, el) {
  const wrap = document.getElementById(`p6-ss-${sid}`);
  if (!wrap) return;
  const id   = el.dataset.id;
  const name = el.textContent.trim();
  wrap.querySelector('.p6-ss-inp').value = name;
  document.getElementById(`p6-ss-val-${sid}`).value = id;
  wrap.querySelectorAll('.p6-ss-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById(`p6-ss-drop-${sid}`).style.display = 'none';
}

function _p6SSVal(sid) {
  return document.getElementById(`p6-ss-val-${sid}`)?.value || '';
}

// ─────────────────────────────────────────────────────────────────────────────

// Accordion: only one activity open at a time
function _p6ToggleActExpand(sid) {
  window._p6ExpandedSid = (window._p6ExpandedSid === sid) ? null : sid;
  // Reset TC open state when switching activities
  window._p6TCOpen = new Set();
  renderAdminP6();
}

// Separate toggle for the TC links section within an expanded activity
function _p6ToggleTCSection(sid) {
  if (!window._p6TCOpen) window._p6TCOpen = new Set();
  window._p6TCOpen.has(sid) ? window._p6TCOpen.delete(sid) : window._p6TCOpen.add(sid);
  renderAdminP6();
}

// sid = _p6Sid(act.key) — safe alphanumeric DOM id suffix
function _p6ActivityLinkDetail(act, p6List, sid) {
  const links    = _p6GetActivityLinks(act);
  const actLink  = links.find(l => !l.portal_test_case_code);
  const tcLinks  = links.filter(l => !!l.portal_test_case_code);

  // Auto-suggest from learn patterns
  const suggestion = _p6AutoSuggest(act, p6List);

  return `
    <div class="p6-link-detail">
      <!-- ── ACTIVITY-LEVEL LINK ───────────────────────────── -->
      <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;color:var(--gray-500);margin-bottom:8px;">ACTIVITY-LEVEL LINK</div>
      ${actLink ? `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:10px;">
          <div style="flex:1;font-size:12px;">
            <div style="font-weight:600;">${escapeHtml(_p6ActName(actLink.p6_activity_id))}</div>
            <div style="color:var(--gray-500);font-size:11px;">${escapeHtml(_p6ActDates(actLink.p6_activity_id))}</div>
          </div>
          <button class="form-secondary tr-mini-btn" onclick="_p6UnlinkActivity('${escapeHtml(actLink.id)}')">Unlink</button>
        </div>` : `
        <div style="margin-bottom:10px;">
          ${suggestion ? `
            <div style="padding:8px 10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:8px;font-size:12px;">
              💡 Suggested: <b>${escapeHtml(suggestion.p6_name)}</b>
              <div style="display:flex;gap:6px;margin-top:6px;">
                <button class="admin-action-btn tr-mini-btn" onclick="_p6AcceptSuggestion('${sid}','${escapeHtml(suggestion.id)}')">Accept</button>
                <button class="form-secondary tr-mini-btn" onclick="_p6DismissSuggestion('${sid}')">Dismiss</button>
              </div>
            </div>` : ''}
          ${_p6SS(sid + '_act', p6List, 'Search P6 activities…')}
          <button class="admin-action-btn tr-mini-btn" style="margin-top:6px;width:100%;"
            onclick="_p6LinkActivity(_p6SSVal('${sid}_act'),'${sid}')">
            Link Activity
          </button>
        </div>`}

      <!-- ── TEST-CASE LEVEL LINKS (collapsed by default) ─── -->
      ${(()=>{
        const tcOpen = window._p6TCOpen?.has(sid);
        const tcLinkedCount = tcLinks.length;
        return `
          <div style="border-top:1px solid var(--gray-100);margin-top:10px;padding-top:8px;">
            <button class="form-secondary tr-mini-btn" style="width:100%;display:flex;align-items:center;justify-content:space-between;"
              onclick="_p6ToggleTCSection('${sid}')">
              <span style="font-size:11px;font-weight:700;letter-spacing:0.05em;color:var(--gray-600);">
                TEST-CASE OVERRIDES ${tcLinkedCount ? `<span style="color:var(--good);">(${tcLinkedCount} linked)</span>` : '(optional)'}
              </span>
              <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" style="color:var(--gray-400);transform:rotate(${tcOpen?'90':'0'}deg);transition:transform 0.15s;flex-shrink:0;">
                <path fill-rule="evenodd" d="M7.293 4.707a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </button>
            ${tcOpen ? `
              <div style="margin-top:8px;">
                <p style="font-size:11px;color:var(--gray-400);margin-bottom:8px;">Only needed if specific test cases map to a different P6 sub-activity than the activity-level link above.</p>
                <!-- Bulk link row -->
                <div style="display:flex;gap:6px;align-items:center;padding:6px 0 8px;border-bottom:1px solid var(--gray-200);margin-bottom:6px;flex-wrap:wrap;">
                  <span style="font-size:11px;color:var(--gray-600);white-space:nowrap;font-weight:600;">Bulk link all to:</span>
                  <div style="flex:1;min-width:180px;">${_p6SS(sid + '_bulk', p6List, 'Search…')}</div>
                  <button class="admin-action-btn tr-mini-btn"
                    onclick="_p6BulkLinkTCs(_p6SSVal('${sid}_bulk'),'${sid}')">Apply All</button>
                </div>
                ${act.items.map(item => {
                  const tcLink = tcLinks.find(l => l.portal_test_case_code === item.TestCaseCode);
                  const tcCode = escapeHtml(item.TestCaseCode || '');
                  const tcSid  = sid + '_tc_' + tcCode.replace(/[^a-zA-Z0-9]/g,'_');
                  return `
                    <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--gray-100);">
                      <div style="flex:1;min-width:0;">
                        <div style="font-size:11px;font-weight:600;color:var(--gray-800);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.TestCaseCode||'')}</div>
                        <div style="font-size:10px;color:var(--gray-500);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.TestName||'')}</div>
                      </div>
                      ${tcLink ? `
                        <span style="font-size:10px;color:var(--good);font-weight:600;white-space:nowrap;flex-shrink:0;">↔ ${escapeHtml(_p6ActName(tcLink.p6_activity_id))}</span>
                        <button class="form-secondary tr-mini-btn" onclick="_p6UnlinkActivity('${escapeHtml(tcLink.id)}')">✕</button>
                      ` : `
                        <div style="flex:2;min-width:120px;">${_p6SS(tcSid, p6List, '—')}</div>
                        <button class="admin-action-btn tr-mini-btn"
                          onclick="_p6LinkTestCase(_p6SSVal('${tcSid}'),'${tcCode}','${sid}')">Link</button>
                      `}
                    </div>`;
                }).join('')}
              </div>
            ` : ''}
          </div>`;
      })()}
    </div>`;
}

// Filter <select> options based on text search input (live search)
function _p6FilterOpts(input, selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const q = input.value.toLowerCase();
  Array.from(sel.options).forEach(opt => {
    opt.style.display = (!q || opt.text.toLowerCase().includes(q) || !opt.value) ? '' : 'none';
  });
  // If current selection is now hidden, reset it
  const cur = sel.options[sel.selectedIndex];
  if (cur && cur.style.display === 'none') sel.selectedIndex = 0;
}

async function _p6BulkLinkTCs(p6Id, sid) {
  if (!p6Id) { toast('Select a P6 activity first', 'error'); return; }
  const a = window._p6ActData?.[sid];
  if (!a) { toast('Activity data not found — please refresh', 'error'); return; }
  const { phase, location, subsystem, activity } = a;
  const all = _amGetActivities();
  const act = all.find(x => x.key === a.key);
  if (!act) return;

  // Confirm
  if (!confirm(`Link all ${act.items.length} test cases to "${_p6ActName(p6Id)}"?`)) return;

  let done = 0;
  for (const item of act.items) {
    // Skip already-linked
    const existing = P6_MAP.find(m =>
      m.portal_test_case_code === item.TestCaseCode &&
      m.portal_phase === phase && m.portal_location === location &&
      m.portal_subsystem === subsystem && m.portal_activity === activity);
    if (existing) {
      await _dbDelete('p6_activity_map', { id: existing.id }).catch(()=>{});
    }
    try {
      await _dbInsert('p6_activity_map', [{
        p6_activity_id: p6Id,
        portal_phase: phase, portal_location: location,
        portal_subsystem: subsystem, portal_activity: activity,
        portal_test_case_code: item.TestCaseCode || null,
      }]);
      done++;
    } catch(e) { console.warn('[bulkLinkTC]', e.message); }
  }
  await loadP6Data();
  toast(`Linked ${done} test cases`, 'success');
  renderAdminP6();
}

function _p6ActName(p6ActivityId) {
  const a = P6_ACTS.find(x => x.id === p6ActivityId);
  return a ? a.p6_name : '—';
}
function _p6ActDates(p6ActivityId) {
  const a = P6_ACTS.find(x => x.id === p6ActivityId);
  if (!a) return '';
  return `${a.start_date ? _fmtDate(a.start_date) : '—'} → ${a.finish_date ? _fmtDate(a.finish_date) : '—'}`;
}

function _p6AutoSuggest(act, p6List) {
  if (window._p6Dismissed?.has(act.key)) return null;
  // Check learn patterns first
  const pattern = P6_PATTERNS.find(p =>
    p.portal_activity_name === act.activity &&
    (!p.portal_subsystem || p.portal_subsystem === act.subsystem)
  );
  if (pattern) {
    // Find matching P6 activity at this location
    const match = p6List.find(p =>
      p.p6_name.includes(pattern.p6_name_pattern) &&
      p.p6_location_code === _p6LocCode(act.location)
    );
    if (match) return match;
  }
  return null;
}

function _p6LocCode(locationName) {
  // Extract location code from name: "W40 Millbrae Station" → "W40"
  const m = locationName.match(/^([A-Z][0-9]+)/);
  return m ? m[1] : '';
}

function _p6DismissSuggestion(key) {
  if (!window._p6Dismissed) window._p6Dismissed = new Set();
  window._p6Dismissed.add(key);
  renderAdminP6();
}

// Called from suggestion banner: sid = _p6Sid(act.key), p6Id = suggestion uuid
async function _p6AcceptSuggestion(sid, p6Id) {
  await _p6LinkActivity(p6Id, sid);
}

function _p6MapFilter(k, v) {
  _p6MappingFilters[k] = v;
  if (k === 'phase')    { _p6MappingFilters.location = ''; _p6MappingFilters.subsystem = ''; }
  if (k === 'location') { _p6MappingFilters.subsystem = ''; }
  renderAdminP6();
}

// sid resolves to the activity via window._p6ActData[sid]
async function _p6LinkActivity(p6Id, sid) {
  if (!p6Id) { toast('Select a P6 activity first', 'error'); return; }
  if (window._p6Linking) return; // double-click guard
  window._p6Linking = true;
  const a = window._p6ActData?.[sid];
  if (!a) { window._p6Linking = false; toast('Activity data not found — please refresh', 'error'); return; }
  const { phase, location, subsystem, activity } = a;
  try {
    // Upsert: delete any existing activity-level link for this portal activity first
    const existing = P6_MAP.filter(m =>
      m.portal_phase === phase && m.portal_location === location &&
      m.portal_subsystem === subsystem && m.portal_activity === activity &&
      !m.portal_test_case_code);
    for (const old of existing) {
      await _dbDelete('p6_activity_map', { id: old.id });
    }
    await _dbInsert('p6_activity_map', [{
      p6_activity_id: p6Id,
      portal_phase: phase, portal_location: location,
      portal_subsystem: subsystem, portal_activity: activity,
      portal_test_case_code: null,
      linked_by: currentRoleUser?.name || 'Admin',
    }]);
    const p6Act = P6_ACTS.find(x => x.id === p6Id);
    if (p6Act) await _p6StorePattern(p6Act.p6_name, activity, subsystem);
    await loadP6Data();
    await _p6PropagateActivityId(phase, location, subsystem, activity, p6Id, null);
    await _p6CheckBatchSuggestions(activity, subsystem, p6Act);
    renderAdminP6();
    toast('Activity linked ✓', 'success');
  } catch(e) { toast('Link failed: ' + e.message, 'error'); }
  finally { window._p6Linking = false; }
}

async function _p6LinkTestCase(p6Id, testCaseCode, sid) {
  if (!p6Id) { toast('Select a P6 activity first', 'error'); return; }
  const a = window._p6ActData?.[sid];
  if (!a) { toast('Activity data not found — please refresh', 'error'); return; }
  const { phase, location, subsystem, activity } = a;
  try {
    await _dbInsert('p6_activity_map', [{
      p6_activity_id: p6Id,
      portal_phase: phase, portal_location: location,
      portal_subsystem: subsystem, portal_activity: activity,
      portal_test_case_code: testCaseCode || null,
      linked_by: currentRoleUser?.name || 'Admin',
    }]);
    await _p6PropagateActivityId(phase, location, subsystem, activity, p6Id, testCaseCode);
    await loadP6Data();
    renderAdminP6();
    toast('Test case linked ✓', 'success');
  } catch(e) { toast('Link failed: ' + e.message, 'error'); }
}

async function _p6UnlinkActivity(mapId) {
  try {
    await _dbDelete('p6_activity_map', { id: mapId });
    await loadP6Data();
    renderAdminP6();
    toast('Unlinked', 'success');
  } catch(e) { toast('Unlink failed: ' + e.message, 'error'); }
}

async function _p6PropagateActivityId(phase, location, subsystem, activity, p6Id, testCaseCode) {
  // Write P6 ID into test_items.activity_id for direct lookups
  try {
    const p6Act = P6_ACTS.find(a => a.id === p6Id);
    if (!p6Act) return;
    const items = TI.filter(t =>
      t.Phase === phase && t.Location === location &&
      t.Subsystem === subsystem && t.Activity === activity &&
      (!testCaseCode || t.TestCaseCode === testCaseCode)
    );
    for (const item of items) {
      await _dbUpdate('test_items', { activity_id: p6Act.p6_id }, { test_id: item.TestID || item.test_id });
    }
    await loadTestItems();
  } catch(e) { console.warn('[p6Propagate]', e.message); }
}

async function _p6StorePattern(p6Name, portalActivity, subsystem) {
  // Extract the descriptive part from P6 name: "[T&C] W40 (Ph2) - IXL Sim Test" → "IXL Sim Test"
  const pattern = p6Name.replace(/^\[T&C\]\s+\w+\s+\(Ph\d+\)\s+-\s+/, '').trim();
  try {
    // Upsert: increment confidence if already exists
    const existing = P6_PATTERNS.find(p => p.p6_name_pattern === pattern && p.portal_activity_name === portalActivity);
    if (existing) {
      await _dbUpdate('p6_learn_patterns', {
        confidence: existing.confidence + 1,
        last_confirmed_at: new Date().toISOString(),
      }, { id: existing.id });
    } else {
      await _dbInsert('p6_learn_patterns', [{
        p6_name_pattern: pattern,
        portal_activity_name: portalActivity,
        portal_subsystem: subsystem || null,
        confidence: 1,
        last_confirmed_at: new Date().toISOString(),
      }]);
    }
  } catch(e) { console.warn('[p6Pattern]', e.message); }
}

async function _p6CheckBatchSuggestions(activityName, subsystem, p6Act) {
  // Find all OTHER portal activities with the same name that are unlinked
  const allPortal = _amGetActivities();
  const unlinked  = allPortal.filter(a =>
    a.activity === activityName &&
    a.subsystem === subsystem  &&
    !_p6IsActivityLinked(a)
  );
  if (!unlinked.length) return;

  // Find matching P6 activities at those locations
  const suggestions = unlinked.map(a => {
    const locCode = _p6LocCode(a.location);
    const match   = P6_ACTS.find(p =>
      p.p6_name.replace(/^\[T&C\]\s+\w+\s+\(Ph\d+\)\s+-\s+/, '').trim() ===
      p6Act.p6_name.replace(/^\[T&C\]\s+\w+\s+\(Ph\d+\)\s+-\s+/, '').trim() &&
      p.p6_location_code === locCode
    );
    return match ? { portalAct: a, p6Match: match } : null;
  }).filter(Boolean);

  if (!suggestions.length) return;

  // Show batch suggestion modal
  const rows = suggestions.map(s => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--gray-100);">
      <input type="checkbox" checked id="p6bs-${escapeHtml(s.portalAct.key)}" style="width:15px;height:15px;">
      <div style="flex:1;font-size:12px;">
        <div style="font-weight:600;">${escapeHtml(s.portalAct.activity)}</div>
        <div style="color:var(--gray-500);">${escapeHtml(s.portalAct.location)} · ${escapeHtml(s.portalAct.phase)}</div>
      </div>
      <div style="font-size:11px;color:var(--gray-500);text-align:right;">
        → ${escapeHtml(s.p6Match.p6_name)}<br>
        ${s.p6Match.start_date ? _fmtDate(s.p6Match.start_date) : '—'} → ${s.p6Match.finish_date ? _fmtDate(s.p6Match.finish_date) : '—'}
      </div>
    </div>`).join('');

  modal({
    title: `💡 ${suggestions.length} Similar Match${suggestions.length>1?'es':''} Found`,
    size: 'medium',
    body: `
      <p style="font-size:13px;color:var(--gray-600);margin-bottom:16px;">
        Based on your link for <b>${escapeHtml(activityName)}</b>, these other locations appear to have matching P6 activities. Accept the ones you want to auto-link:
      </p>
      <div>${rows}</div>`,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Skip</button>
      <button class="admin-action-btn" onclick="_p6AcceptBatchSuggestions(${JSON.stringify(suggestions.map(s=>({actKey:s.portalAct.key,p6Id:s.p6Match.id,phase:s.portalAct.phase,location:s.portalAct.location,subsystem:s.portalAct.subsystem,activity:s.portalAct.activity})))})">
        Accept Selected
      </button>`,
  });
}

async function _p6AcceptBatchSuggestions(suggestions) {
  closeModal();
  let count = 0;
  for (const s of suggestions) {
    const cb = document.getElementById(`p6bs-${s.actKey}`);
    if (cb && !cb.checked) continue;
    try {
      const row = {
        p6_activity_id: s.p6Id, portal_phase: s.phase,
        portal_location: s.location, portal_subsystem: s.subsystem,
        portal_activity: s.activity, portal_test_case_code: null,
        linked_by: currentRoleUser?.name || 'Admin',
        is_auto_suggested: true, was_confirmed: true,
      };
      await _dbInsert('p6_activity_map', [row]);
      await _p6PropagateActivityId(s.phase, s.location, s.subsystem, s.activity, s.p6Id, null);
      count++;
    } catch(e) { console.warn('[batch suggest]', e.message); }
  }
  if (count) {
    await loadP6Data();
    renderAdminP6();
    toast(`✓ ${count} activities auto-linked`, 'success');
  }
}

// ─── HEALTH TAB ───────────────────────────────────────────────────────────────
function _p6HealthTabHTML() {
  const allPortal  = _amGetActivities();
  const curBatch   = P6_BATCHES.find(b => b.schedule_type === 'current'  && b.is_current);
  const baseBatch  = P6_BATCHES.find(b => b.schedule_type === 'baseline' && b.is_current);

  // Use whichever batch exists — batch-agnostic unlinked detection
  const primaryBatch = curBatch || baseBatch;
  const allP6        = primaryBatch ? P6_ACTS.filter(a => a.batch_id === primaryBatch.id) : [];
  const p6Baseline   = baseBatch ? P6_ACTS.filter(a => a.batch_id === baseBatch.id) : [];
  const p6Current    = curBatch  ? P6_ACTS.filter(a => a.batch_id === curBatch.id)  : [];

  // Dismissed IDs (server-side, shared across all users)
  const dismissedIds = new Set(P6_DISMISSALS.map(d => d.p6_activity_id));

  let unlinkedP6 = allP6.filter(p =>
    !P6_MAP.some(m => m.p6_activity_id === p.id) &&
    !dismissedIds.has(p.id)
  );

  // ── Apply search filter ──
  const srch = (_p6HealthFilter.search || '').toLowerCase().trim();
  if (srch) unlinkedP6 = unlinkedP6.filter(p => (p.p6_name||'').toLowerCase().includes(srch) || (p.p6_id||'').toLowerCase().includes(srch));

  // ── Apply date filter ──
  const today = new Date(); today.setHours(0,0,0,0);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
  if (_p6HealthFilter.dateMode !== 'all') {
    let from = null, to = null;
    if (_p6HealthFilter.dateMode === '30d')   { to = addDays(today, 30); }
    if (_p6HealthFilter.dateMode === '6m')    { to = addDays(today, 182); }
    if (_p6HealthFilter.dateMode === '1y')    { to = addDays(today, 365); }
    if (_p6HealthFilter.dateMode === 'range') {
      from = _p6HealthFilter.dateFrom ? new Date(_p6HealthFilter.dateFrom) : null;
      to   = _p6HealthFilter.dateTo   ? new Date(_p6HealthFilter.dateTo)   : null;
    }
    unlinkedP6 = unlinkedP6.filter(p => {
      if (!p.start_date) return false;
      const sd = new Date(p.start_date);
      if (from && sd < from) return false;
      if (to   && sd > to)   return false;
      return true;
    });
  }

  const unlinkedPortal = allPortal.filter(a => !_p6IsActivityLinked(a));

  // Date changes: compare current vs baseline by P6 ID
  const dateChanges = p6Current.map(cur => {
    const base = p6Baseline.find(b => b.p6_id === cur.p6_id);
    if (!base) return null;
    const startDiff = base.start_date && cur.start_date
      ? Math.round((new Date(cur.start_date) - new Date(base.start_date)) / 86400000) : 0;
    const finDiff   = base.finish_date && cur.finish_date
      ? Math.round((new Date(cur.finish_date) - new Date(base.finish_date)) / 86400000) : 0;
    if (startDiff === 0 && finDiff === 0) return null;
    return { p6: cur, startDiff, finDiff };
  }).filter(Boolean);

  const batchLabel = primaryBatch
    ? `${primaryBatch.schedule_type === 'current' ? 'Current' : 'Baseline'} · imported ${primaryBatch.imported_at ? _fmtDate(primaryBatch.imported_at) : ''}`
    : '';

  // Portal activities checklist items (reused per-row link panel)
  const portalCheckItems = allPortal.map(a => {
    const safeKey = escapeHtml(a.key);
    const searchText = `${a.phase} ${a.location} ${a.subsystem} ${a.activity}`.toLowerCase();
    return `<label class="p6h-link-item" data-search="${escapeHtml(searchText)}"
      style="display:flex;align-items:flex-start;gap:8px;padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--gray-100);">
      <input type="checkbox" class="p6h-link-chk" value="${safeKey}" style="margin-top:2px;flex-shrink:0;">
      <div style="font-size:12px;line-height:1.4;">
        <div style="font-weight:500;">${escapeHtml(a.activity)}</div>
        <div style="color:var(--gray-500);font-size:11px;">${escapeHtml(a.phase)} · ${escapeHtml(a.location)} · ${escapeHtml(a.subsystem)}</div>
      </div>
    </label>`;
  }).join('');

  return `
    <div style="display:flex;flex-direction:column;gap:18px;">

      <!-- ── Unlinked P6 Activities ── -->
      <div class="data-card" style="padding:20px;">

        <!-- Header row -->
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
          <div>
            <span style="font-size:13px;font-weight:700;">🔴 Unlinked P6 Activities</span>
            <span class="badge badge-review" style="margin-left:8px;font-size:11px;">${unlinkedP6.length}</span>
            ${batchLabel ? `<span style="font-size:11px;color:var(--gray-500);margin-left:10px;">(${escapeHtml(batchLabel)})</span>` : ''}
            ${P6_DISMISSALS.length ? `<button class="form-secondary tr-mini-btn" style="margin-left:12px;${_p6HShowingSnoozed?'background:var(--hitachi-red);color:#fff;':''}" onclick="_p6HShowingSnoozed=!_p6HShowingSnoozed;renderAdminP6()">
              ${_p6HShowingSnoozed ? '▲ Hide snoozed' : `👁 Show ${P6_DISMISSALS.length} snoozed`}
            </button>` : ''}
          </div>
          ${unlinkedP6.length ? `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <label style="font-size:12px;display:flex;align-items:center;gap:5px;cursor:pointer;">
              <input type="checkbox" id="p6h-sel-all" onchange="_p6HSelectAll(this.checked)"> Select all
            </label>
            <button class="form-secondary tr-mini-btn" onclick="_p6HBulkRemindLater()">⏰ Snooze selected</button>
            <button class="form-secondary tr-mini-btn" style="color:#dc2626;" onclick="_p6HBulkRemove()">🗑 Remove selected</button>
          </div>` : ''}
        </div>

        <!-- Filters row -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center;">
          <input class="form-input" type="text" placeholder="🔍 Search P6 activity name…" style="flex:1;min-width:180px;max-width:320px;font-size:12px;"
            value="${escapeHtml(_p6HealthFilter.search)}"
            oninput="_p6HealthFilter.search=this.value;renderAdminP6()">
          <select class="filter-select" style="font-size:12px;" onchange="_p6HDateMode(this.value)">
            <option value="all"   ${_p6HealthFilter.dateMode==='all'  ?'selected':''}>All start dates</option>
            <option value="30d"   ${_p6HealthFilter.dateMode==='30d'  ?'selected':''}>Starting within 30 days</option>
            <option value="6m"    ${_p6HealthFilter.dateMode==='6m'   ?'selected':''}>Starting within 6 months</option>
            <option value="1y"    ${_p6HealthFilter.dateMode==='1y'   ?'selected':''}>Starting within 1 year</option>
            <option value="range" ${_p6HealthFilter.dateMode==='range'?'selected':''}>Custom date range</option>
          </select>
          ${_p6HealthFilter.dateMode === 'range' ? `
            <input type="date" class="form-input" style="font-size:12px;width:140px;" value="${_p6HealthFilter.dateFrom}"
              onchange="_p6HealthFilter.dateFrom=this.value;renderAdminP6()">
            <span style="font-size:12px;color:var(--gray-500);">to</span>
            <input type="date" class="form-input" style="font-size:12px;width:140px;" value="${_p6HealthFilter.dateTo}"
              onchange="_p6HealthFilter.dateTo=this.value;renderAdminP6()">
          ` : ''}
          ${srch || _p6HealthFilter.dateMode !== 'all' ? `
            <button class="form-secondary tr-mini-btn" onclick="_p6HealthFilter={search:'',dateMode:'all',dateFrom:'',dateTo:''};renderAdminP6()">✕ Clear filters</button>
          ` : ''}
        </div>

        <!-- Table -->
        ${unlinkedP6.length ? `
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;">
            <thead>
              <tr>
                <th style="width:32px;"></th>
                <th>P6 Activity Name</th>
                <th>P6 ID</th>
                <th>Start</th>
                <th>Finish</th>
                <th style="min-width:220px;text-align:center;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${unlinkedP6.map(p => {
                const linkOpen = _p6HealthLinkOpen.has(p.id);
                const escapedId = escapeHtml(p.id);
                return `
                <tr>
                  <td><input type="checkbox" class="p6h-chk" data-pid="${escapedId}" onchange="_p6HUpdateSelCount()"></td>
                  <td style="font-weight:500;">${escapeHtml(p.p6_name)}</td>
                  <td style="color:var(--gray-500);font-size:11px;">${escapeHtml(p.p6_id||'')}</td>
                  <td style="font-size:12px;">${p.start_date  ? _fmtDate(p.start_date)  : '—'}</td>
                  <td style="font-size:12px;">${p.finish_date ? _fmtDate(p.finish_date) : '—'}</td>
                  <td style="text-align:center;white-space:nowrap;">
                    <button class="form-secondary tr-mini-btn" onclick="_p6HToggleLink('${escapedId}')"
                      style="${linkOpen?'background:var(--hitachi-red);color:#fff;':''}" >
                      🔗 Link to Activity
                    </button>
                    <button class="form-secondary tr-mini-btn" title="Snooze — hide until restored" onclick="_p6HRemindLater('${escapedId}')">⏰</button>
                    <button class="form-secondary tr-mini-btn" style="color:#dc2626;" title="Remove from schedule" onclick="_p6HRemove('${escapedId}','${escapeHtml(p.p6_name).replace(/'/g,"\\'")}')">🗑</button>
                  </td>
                </tr>
                ${linkOpen ? `
                <tr>
                  <td colspan="6" style="padding:14px 16px;background:var(--gray-50);border-bottom:2px solid var(--hitachi-red);">
                    <div style="display:flex;flex-direction:column;gap:10px;max-width:620px;">
                      <div style="font-size:12px;font-weight:600;color:var(--gray-700);">
                        Link <em>${escapeHtml(p.p6_name)}</em> to portal activities:
                      </div>
                      <input type="text" class="form-input" placeholder="🔍 Search activities…"
                        style="font-size:12px;"
                        oninput="_p6HLinkFilter('${escapedId}',this.value)">
                      <div id="p6h-link-list-${escapedId}"
                        style="max-height:240px;overflow-y:auto;border:1px solid var(--gray-200);border-radius:6px;background:#fff;">
                        ${portalCheckItems}
                      </div>
                      <div style="display:flex;gap:8px;">
                        <button class="admin-action-btn" style="font-size:12px;padding:6px 14px;"
                          onclick="_p6HLinkSave('${escapedId}')">Save Links</button>
                        <button class="form-secondary" style="font-size:12px;padding:6px 14px;"
                          onclick="_p6HToggleLink('${escapedId}')">Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>` : ''}`;
              }).join('')}
            </tbody>
          </table>
        </div>`
        : `<div style="padding:12px 0;color:${srch||_p6HealthFilter.dateMode!=='all'?'var(--gray-500)':'var(--good)'};font-size:12px;">
            ${srch||_p6HealthFilter.dateMode!=='all' ? 'No activities match the current filters.' : '✓ All P6 activities are linked'}
           </div>`}
      </div>

      <!-- ── Snoozed activities (inline, toggled) ── -->
      ${_p6HShowingSnoozed ? (() => {
        const snoozed = P6_DISMISSALS.map(d => {
          const p = P6_ACTS.find(x => x.id === d.p6_activity_id);
          return { ...d, p6_name: p ? p.p6_name : `(ID: ${d.p6_activity_id})`, p6_id: p?.p6_id || '' };
        });
        return `
        <div class="data-card" style="padding:20px;border-left:3px solid var(--hitachi-red);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
            <span style="font-size:13px;font-weight:700;">⏰ Snoozed P6 Activities (${snoozed.length})</span>
            ${snoozed.length ? `<button class="admin-action-btn" style="font-size:12px;padding:5px 12px;" onclick="_p6HRestoreAll()">Unsnooze All</button>` : ''}
          </div>
          ${snoozed.length ? `
          <table class="data-table" style="width:100%;">
            <thead><tr>
              <th>P6 Activity Name</th>
              <th>P6 ID</th>
              <th>Snoozed By</th>
              <th>Snoozed On</th>
              <th style="width:100px;text-align:center;">Action</th>
            </tr></thead>
            <tbody>
              ${snoozed.map(d => `
              <tr>
                <td style="font-weight:500;">${escapeHtml(d.p6_name)}</td>
                <td style="font-size:11px;color:var(--gray-500);">${escapeHtml(d.p6_id)}</td>
                <td style="font-size:12px;">${escapeHtml(d.dismissed_by||'—')}</td>
                <td style="font-size:12px;">${_fmtDate(d.dismissed_at)}</td>
                <td style="text-align:center;">
                  <button class="admin-action-btn" style="font-size:11px;padding:4px 10px;"
                    onclick="_p6HRestoreOne('${escapeHtml(d.id)}')">Unsnooze</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>` : `<div style="font-size:12px;color:var(--gray-500);">Nothing currently snoozed.</div>`}
        </div>`;
      })() : ''}

      <!-- ── Lower 3-column grid ── -->
      <div class="p6-health-grid">

        <div class="data-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;display:flex;justify-content:space-between;">
            🟡 Unlinked Portal Activities <span>${unlinkedPortal.length}</span>
          </div>
          ${unlinkedPortal.length ? unlinkedPortal.map(a => {
            const sid = _p6Sid(a.key);
            return `
            <div style="padding:8px 0;border-bottom:1px solid var(--gray-100);font-size:12px;">
              <div style="font-weight:600;">${escapeHtml(a.activity)}</div>
              <div style="color:var(--gray-500);">${escapeHtml(a.subsystem)} · ${escapeHtml(a.location)} · ${escapeHtml(a.phase)}</div>
              <button class="form-secondary tr-mini-btn" style="margin-top:4px;"
                onclick="_p6SetTab('mapping');_p6MapFilter('location','${escapeHtml(a.location)}');_p6ToggleActExpand('${sid}')">
                Go to Mapping →
              </button>
            </div>`;
          }).join('')
          : `<div style="color:var(--good);font-size:12px;">✓ All portal activities are linked</div>`}
        </div>

        <div class="data-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;display:flex;justify-content:space-between;">
            📅 Schedule Changes (Current vs Baseline) <span>${dateChanges.length}</span>
          </div>
          ${!baseBatch || !curBatch
            ? `<div style="font-size:12px;color:var(--gray-500);">Import both a Baseline and Current schedule to see changes.</div>`
            : dateChanges.length ? dateChanges.map(c=>`
              <div style="padding:8px 0;border-bottom:1px solid var(--gray-100);font-size:12px;">
                <div style="font-weight:600;">${escapeHtml(c.p6.p6_name)}</div>
                <div style="margin-top:3px;display:flex;gap:12px;flex-wrap:wrap;">
                  ${c.startDiff !== 0 ? `<span style="color:${c.startDiff>0?'#dc2626':'#059669'};">Start: ${c.startDiff>0?'+':''}${c.startDiff}d</span>` : ''}
                  ${c.finDiff   !== 0 ? `<span style="color:${c.finDiff  >0?'#dc2626':'#059669'};">Finish: ${c.finDiff>0?'+':''}${c.finDiff}d</span>` : ''}
                </div>
              </div>`).join('')
            : `<div style="color:var(--good);font-size:12px;">✓ No schedule changes between baseline and current</div>`}
        </div>

        <div class="data-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">🧠 Auto-Learn Patterns</div>
          ${P6_PATTERNS.length ? P6_PATTERNS.slice(0,10).map(p=>`
            <div style="padding:6px 0;border-bottom:1px solid var(--gray-100);font-size:12px;display:flex;gap:8px;align-items:center;">
              <div style="flex:1;">
                <span style="color:var(--gray-500);">${escapeHtml(p.p6_name_pattern)}</span>
                <span style="color:var(--gray-400);margin:0 4px;">→</span>
                <span style="font-weight:600;">${escapeHtml(p.portal_activity_name)}</span>
              </div>
              <span class="badge badge-review" style="font-size:10px;">confidence: ${p.confidence}</span>
            </div>`).join('')
            : `<div style="font-size:12px;color:var(--gray-500);">No patterns learned yet. Start linking activities to build the pattern library.</div>`}
        </div>

      </div>
    </div>`;
}

// ── Health tab filter helpers ─────────────────────────────────────────────────
function _p6HDateMode(mode) {
  _p6HealthFilter.dateMode = mode;
  if (mode !== 'range') { _p6HealthFilter.dateFrom = ''; _p6HealthFilter.dateTo = ''; }
  renderAdminP6();
}

// ── Link toggle ───────────────────────────────────────────────────────────────
function _p6HToggleLink(pid) {
  _p6HealthLinkOpen.has(pid) ? _p6HealthLinkOpen.delete(pid) : _p6HealthLinkOpen.add(pid);
  renderAdminP6();
}

// Filter the link-panel checklist by search text
function _p6HLinkFilter(pid, query) {
  const q = query.toLowerCase().trim();
  const list = document.getElementById(`p6h-link-list-${pid}`);
  if (!list) return;
  list.querySelectorAll('.p6h-link-item').forEach(item => {
    const match = !q || (item.dataset.search || '').includes(q);
    item.style.display = match ? '' : 'none';
  });
}

// Save links from Health tab: one P6 activity → one or more portal activities
async function _p6HLinkSave(p6Id) {
  const list = document.getElementById(`p6h-link-list-${p6Id}`);
  if (!list) return;
  const keys = [...list.querySelectorAll('.p6h-link-chk:checked')].map(c => c.value);
  if (!keys.length) { toast('Select at least one portal activity', 'error'); return; }

  const allPortal = _amGetActivities();
  let linked = 0;
  for (const key of keys) {
    const a = allPortal.find(x => x.key === key);
    if (!a) continue;
    const { phase, location, subsystem, activity } = a;
    // Skip if already linked
    const alreadyLinked = P6_MAP.some(m =>
      m.p6_activity_id === p6Id &&
      m.portal_phase === phase && m.portal_location === location &&
      m.portal_subsystem === subsystem && m.portal_activity === activity &&
      !m.portal_test_case_code);
    if (alreadyLinked) continue;
    try {
      await _dbInsert('p6_activity_map', [{
        p6_activity_id: p6Id,
        portal_phase: phase, portal_location: location,
        portal_subsystem: subsystem, portal_activity: activity,
      }]);
      linked++;
    } catch(e) { console.warn('[_p6HLinkSave]', e.message); }
  }
  if (linked > 0) {
    toast(`Linked to ${linked} portal activit${linked===1?'y':'ies'}`, 'success');
    _p6HealthLinkOpen.delete(p6Id);
    await loadP6Data();
  } else {
    toast('All selected activities were already linked', 'info');
  }
}

// ── Snooze / Dismiss (server-side, shared across all users) ──────────────────
async function _p6HRemindLater(pid) {
  try {
    await _dbInsert('p6_activity_dismissals', [{ p6_activity_id: pid, dismissed_by: currentRoleUser?.name || 'admin' }]);
    toast('Snoozed — click "Show snoozed" to restore', 'success');
    await loadP6Data();
    renderAdminP6();
  } catch(e) { toast('Snooze failed: ' + e.message, 'error'); }
}

async function _p6HBulkRemindLater() {
  const sel = [...document.querySelectorAll('.p6h-chk:checked')].map(c => c.dataset.pid);
  if (!sel.length) { toast('Select at least one activity', 'error'); return; }
  try {
    for (const pid of sel) {
      await _dbInsert('p6_activity_dismissals', [{ p6_activity_id: pid, dismissed_by: currentRoleUser?.name || 'admin' }]);
    }
    toast(`${sel.length} activit${sel.length===1?'y':'ies'} snoozed`, 'success');
    await loadP6Data();
    renderAdminP6();
  } catch(e) { toast('Snooze failed: ' + e.message, 'error'); }
}

async function _p6HRestoreOne(dismissalId) {
  try {
    await _dbDelete('p6_activity_dismissals', { id: dismissalId });
    await loadP6Data();
    renderAdminP6();
    toast('Activity returned to unlinked list', 'success');
  } catch(e) { toast('Restore failed: ' + e.message, 'error'); }
}

async function _p6HRestoreAll() {
  try {
    for (const d of [...P6_DISMISSALS]) await _dbDelete('p6_activity_dismissals', { id: d.id });
    _p6HShowingSnoozed = false;
    await loadP6Data();
    renderAdminP6();
    toast('All snoozed activities returned to unlinked list', 'success');
  } catch(e) { toast('Restore failed: ' + e.message, 'error'); }
}

// ── Remove from schedule (deletes p6_activities row) ─────────────────────────
async function _p6HRemove(pid, name) {
  if (!confirm(`Remove "${name}" from the P6 schedule? This deletes the imported activity row.`)) return;
  try {
    await _dbDelete('p6_activities', { id: pid });
    toast('P6 activity removed', 'success');
    await loadP6Data();
  } catch(e) { toast('Remove failed: ' + e.message, 'error'); }
}

async function _p6HBulkRemove() {
  const sel = [...document.querySelectorAll('.p6h-chk:checked')].map(c => c.dataset.pid);
  if (!sel.length) { toast('Select at least one activity', 'error'); return; }
  if (!confirm(`Remove ${sel.length} P6 activit${sel.length===1?'y':'ies'} from the schedule?`)) return;
  try {
    for (const pid of sel) await _dbDelete('p6_activities', { id: pid });
    toast(`${sel.length} activit${sel.length===1?'y':'ies'} removed`, 'success');
    await loadP6Data();
  } catch(e) { toast('Bulk remove failed: ' + e.message, 'error'); }
}

// ── Select-all checkbox helpers ───────────────────────────────────────────────
function _p6HSelectAll(checked) {
  document.querySelectorAll('.p6h-chk').forEach(c => c.checked = checked);
}

function _p6HUpdateSelCount() {
  const all  = document.querySelectorAll('.p6h-chk');
  const chkd = document.querySelectorAll('.p6h-chk:checked');
  const selAll = document.getElementById('p6h-sel-all');
  if (selAll) selAll.indeterminate = chkd.length > 0 && chkd.length < all.length;
  if (selAll) selAll.checked = all.length > 0 && chkd.length === all.length;
}

// ─── WEIGHTS TAB ──────────────────────────────────────────────────────────────
function _p6WeightsTabHTML() {
  const allPortal = _amGetActivities();
  const phases    = [...new Set(allPortal.map(a=>a.phase).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const locations = [...new Set(allPortal
    .filter(a => !_p6WeightFilter.phase || a.phase === _p6WeightFilter.phase)
    .map(a=>a.location).filter(Boolean))].sort();
  const subsystems= [...new Set(allPortal
    .filter(a =>
      (!_p6WeightFilter.phase    || a.phase    === _p6WeightFilter.phase) &&
      (!_p6WeightFilter.location || a.location === _p6WeightFilter.location))
    .map(a=>a.subsystem).filter(Boolean))].sort();

  const visible = allPortal.filter(a =>
    (!_p6WeightFilter.phase     || a.phase     === _p6WeightFilter.phase)     &&
    (!_p6WeightFilter.location  || a.location  === _p6WeightFilter.location)  &&
    (!_p6WeightFilter.subsystem || a.subsystem === _p6WeightFilter.subsystem)
  );

  return `
    <div class="admin-section">
      <div class="admin-section-head" style="flex-wrap:wrap;gap:10px;margin-bottom:18px;">
        <div>
          <div class="admin-section-title">Activity & Test Case Weights</div>
          <p class="section-sub">Layer 1: activity weight (project importance) · Layer 2: test case weight within activity (default 1)</p>
        </div>
        <button class="form-secondary" onclick="_p6SaveAllWeights()">Save All Weights</button>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;">
        <select class="filter-select" onchange="_p6WeightFilterChange('phase',this.value)">
          <option value="">All Phases</option>
          ${phases.map(p=>`<option value="${escapeHtml(p)}" ${_p6WeightFilter.phase===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_p6WeightFilterChange('location',this.value)">
          <option value="">All Locations</option>
          ${locations.map(l=>`<option value="${escapeHtml(l)}" ${_p6WeightFilter.location===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="_p6WeightFilterChange('subsystem',this.value)">
          <option value="">All Subsystems</option>
          ${subsystems.map(s=>`<option value="${escapeHtml(s)}" ${_p6WeightFilter.subsystem===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      </div>

      <div class="data-card" style="padding:0;overflow:hidden;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Subsystem</th>
              <th>Location</th>
              <th>Phase</th>
              <th style="min-width:100px;text-align:center;">Activity Weight</th>
              <th style="min-width:80px;text-align:center;">Test Cases</th>
              <th style="text-align:center;">Planned Date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${visible.map(a => {
              const rec = _activityRecords.find(r =>
                r.phase === a.phase && r.location === a.location &&
                r.subsystem === a.subsystem && r.activity_name === a.activity);
              const actWeight   = rec?.activity_weight ?? 1;
              const plannedDate = rec?.planned_date || '';
              // Get current P6 start as suggestion
              const link = P6_MAP.find(m =>
                m.portal_phase === a.phase && m.portal_location === a.location &&
                m.portal_subsystem === a.subsystem && m.portal_activity === a.activity && !m.portal_test_case_code);
              const p6Act = link ? P6_ACTS.find(x => x.id === link.p6_activity_id) : null;
              const p6Start = p6Act?.start_date || '';
              const safeKey = escapeHtml(a.key);
              return `
                <tr>
                  <td style="font-size:12px;font-weight:500;">${escapeHtml(a.activity)}</td>
                  <td><span class="tag">${escapeHtml(a.subsystem)}</span></td>
                  <td style="font-size:12px;">${escapeHtml(a.location)}</td>
                  <td style="font-size:12px;">${escapeHtml(a.phase)}</td>
                  <td style="text-align:center;">
                    <input type="number" min="0" step="0.5" class="form-input" style="width:70px;text-align:center;font-size:12px;padding:4px;"
                      id="w-act-${safeKey}" value="${actWeight}">
                  </td>
                  <td style="text-align:center;">
                    <button class="form-secondary tr-mini-btn" onclick="_p6OpenTCWeights('${safeKey}')">
                      ${a.items.length} cases
                    </button>
                  </td>
                  <td style="text-align:center;">
                    <input type="date" class="form-input" style="font-size:12px;padding:4px;"
                      id="w-plan-${safeKey}" value="${plannedDate || p6Start}"
                      title="${p6Start ? 'Auto-filled from P6 current start: ' + p6Start : 'No P6 date linked'}">
                  </td>
                  <td>
                    <button class="admin-action-btn tr-mini-btn" onclick="_p6SaveActivityWeight('${safeKey}','${escapeHtml(a.phase)}','${escapeHtml(a.location)}','${escapeHtml(a.subsystem)}','${escapeHtml(a.activity)}')">Save</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function _p6WeightFilterChange(k, v) {
  _p6WeightFilter[k] = v;
  if (k === 'phase')    { _p6WeightFilter.location = ''; _p6WeightFilter.subsystem = ''; }
  if (k === 'location') { _p6WeightFilter.subsystem = ''; }
  renderAdminP6();
}

async function _p6SaveActivityWeight(actKey, phase, location, subsystem, activity) {
  const wVal   = parseFloat(document.getElementById(`w-act-${actKey}`)?.value) || 1;
  const pDate  = document.getElementById(`w-plan-${actKey}`)?.value || null;
  try {
    const rec = _activityRecords.find(r =>
      r.phase === phase && r.location === location &&
      r.subsystem === subsystem && r.activity_name === activity);
    if (rec) {
      await _dbUpdate('activity_records', { activity_weight: wVal, planned_date: pDate || null }, { id: rec.id });
    } else {
      await _dbInsert('activity_records', [{ phase, location, subsystem, activity_name: activity, activity_weight: wVal, planned_date: pDate || null }]);
    }
    await loadActivityRecords();
    toast('Saved', 'success');
  } catch(e) { toast('Save failed: ' + e.message, 'error'); }
}

async function _p6SaveAllWeights() {
  const all = _amGetActivities();
  let saved = 0;
  for (const a of all) {
    const safeKey = a.key.replace(/[^a-zA-Z0-9]/g, '_');
    const wEl = document.getElementById(`w-act-${a.key}`) || document.getElementById(`w-act-${safeKey}`);
    const pEl = document.getElementById(`w-plan-${a.key}`) || document.getElementById(`w-plan-${safeKey}`);
    if (!wEl && !pEl) continue;
    const wVal  = parseFloat(wEl?.value) || 1;
    const pDate = pEl?.value || null;
    try {
      const rec = _activityRecords.find(r =>
        r.phase === a.phase && r.location === a.location &&
        r.subsystem === a.subsystem && r.activity_name === a.activity);
      if (rec) {
        await _dbUpdate('activity_records', { activity_weight: wVal, planned_date: pDate || null }, { id: rec.id });
      } else {
        await _dbInsert('activity_records', [{ phase: a.phase, location: a.location, subsystem: a.subsystem, activity_name: a.activity, activity_weight: wVal, planned_date: pDate || null }]);
      }
      saved++;
    } catch(e) { console.warn('[saveAllWeights]', e.message); }
  }
  await loadActivityRecords();
  toast(`Saved ${saved} activities`, 'success');
}

function _p6OpenTCWeights(actKey) {
  const all = _amGetActivities();
  const act = all.find(a => a.key === actKey);
  if (!act) return;

  const safeKey = escapeHtml(actKey);

  const rows = act.items.map(item => {
    const tid = escapeHtml(item.TestID || item.test_id || '');
    return `
      <tr>
        <td style="text-align:center;padding:6px 8px;">
          <input type="checkbox" class="tcw-chk" data-tid="${tid}" checked
            style="width:15px;height:15px;cursor:pointer;"
            onchange="_p6TCWUpdateSelCount()">
        </td>
        <td style="font-size:12px;font-weight:600;white-space:nowrap;">${escapeHtml(item.TestCaseCode||'')}</td>
        <td style="font-size:12px;color:var(--gray-600);">${escapeHtml(item.TestName||'')}</td>
        <td style="text-align:center;white-space:nowrap;">
          <input type="number" min="0" step="0.5" class="form-input"
            style="width:70px;text-align:center;font-size:12px;padding:5px 4px;"
            id="tcw-${tid}" value="${item.Weight ?? 1}">
        </td>
      </tr>`;
  }).join('');

  modal({
    title: `Test Case Weights — ${act.activity}`,
    size: 'large',
    body: `
      <!-- Bulk apply bar -->
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;margin-bottom:14px;flex-wrap:wrap;">
        <span style="font-size:12px;font-weight:600;color:var(--gray-600);white-space:nowrap;">Set weight to:</span>
        <input type="number" id="tcw-bulk-val" min="0" step="0.5" value="1"
          class="form-input" style="width:76px;font-size:13px;padding:5px 8px;text-align:center;">
        <button class="admin-action-btn tr-mini-btn" onclick="_p6ApplyBulkWeight()">
          Apply to <span id="tcw-sel-count">${act.items.length}</span> selected
        </button>
        <div style="display:flex;gap:8px;margin-left:auto;align-items:center;">
          <button class="form-secondary tr-mini-btn" onclick="_p6TCWSelectAll(true)">Select all</button>
          <button class="form-secondary tr-mini-btn" onclick="_p6TCWSelectAll(false)">Deselect all</button>
          <span style="font-size:11px;color:var(--gray-400);">Default = 1 · Higher = more important</span>
        </div>
      </div>
      <!-- Table -->
      <div class="table-wrap" style="max-height:55vh;overflow-y:auto;">
        <table class="data-table" style="min-width:540px;">
          <thead><tr>
            <th style="width:36px;text-align:center;">
              <input type="checkbox" checked style="cursor:pointer;"
                onchange="_p6TCWSelectAll(this.checked)">
            </th>
            <th style="white-space:nowrap;">Test Case Code</th>
            <th>Test Name</th>
            <th style="text-align:center;white-space:nowrap;">Weight</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Cancel</button>
      <button class="admin-action-btn" onclick="_p6SaveTCWeights('${safeKey}')">Save All Weights</button>`,
  });
}

function _p6TCWUpdateSelCount() {
  const checked = document.querySelectorAll('.tcw-chk:checked').length;
  const el = document.getElementById('tcw-sel-count');
  if (el) el.textContent = checked;
}

function _p6TCWSelectAll(checked) {
  document.querySelectorAll('.tcw-chk').forEach(cb => { cb.checked = checked; });
  // sync header checkbox
  const hdr = document.querySelector('thead input[type="checkbox"]');
  if (hdr) hdr.checked = checked;
  _p6TCWUpdateSelCount();
}

// Apply bulk weight only to checked rows
function _p6ApplyBulkWeight() {
  const bulkVal = parseFloat(document.getElementById('tcw-bulk-val')?.value);
  if (isNaN(bulkVal) || bulkVal < 0) { toast('Enter a valid weight ≥ 0', 'error'); return; }
  document.querySelectorAll('.tcw-chk:checked').forEach(cb => {
    const tid = cb.dataset.tid;
    const el  = document.getElementById(`tcw-${tid}`);
    if (el) el.value = bulkVal;
  });
}

async function _p6SaveTCWeights(actKey) {
  const all = _amGetActivities();
  const act = all.find(a => a.key === actKey);
  if (!act) return;
  let saved = 0;
  for (const item of act.items) {
    const id  = item.TestID || item.test_id;
    const el  = document.getElementById(`tcw-${escapeHtml(id||'')}`);
    if (!el) continue;
    const wVal = parseFloat(el.value) || 1;
    try {
      await _dbUpdate('test_items', { weight: wVal }, { test_id: id });
      saved++;
    } catch(e) { console.warn('[tcWeight]', e.message); }
  }
  await loadTestItems();
  closeModal();
  toast(`Saved ${saved} test case weights`, 'success');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function _fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// =============================================================================
// SCHEDULE VIEW PAGE (all roles)
// =============================================================================
function renderSchedulePage() {
  const hero = document.getElementById('schedule-hero-content');
  const cont = document.getElementById('schedule-content');
  if (!hero || !cont) return;

  hero.innerHTML = `
    <div class="page-hero-inner">
      <div class="role-badge role-field-badge">Schedule</div>
      <h1 class="page-hero-title">Project Schedule</h1>
      <p class="page-hero-sub">P6-linked activity schedule, planned dates and progress tracking.</p>
    </div>`;

  const hasData = P6_BATCHES.length > 0;
  if (!hasData) {
    cont.innerHTML = `
      <div class="docs-empty">
        <h3>No schedule data yet</h3>
        <p>An admin needs to import a P6 schedule and map it to portal activities first.</p>
        ${currentRoleUser?.role === 'admin' ? `<button class="admin-action-btn" onclick="showPage('admin-p6')">Go to P6 Admin →</button>` : ''}
      </div>`;
    return;
  }

  const allPortal = _amGetActivities();
  const curBatch  = P6_BATCHES.find(b => b.schedule_type === 'current'  && b.is_current);
  const baseBatch = P6_BATCHES.find(b => b.schedule_type === 'baseline' && b.is_current);

  // Build schedule rows
  const rows = allPortal.map(a => {
    const rec     = _activityRecords.find(r =>
      r.phase === a.phase && r.location === a.location &&
      r.subsystem === a.subsystem && r.activity_name === a.activity);

    // Find the activity-level map link (most recently created = last in array)
    const mapLinks = P6_MAP.filter(m =>
      m.portal_phase === a.phase && m.portal_location === a.location &&
      m.portal_subsystem === a.subsystem && m.portal_activity === a.activity &&
      !m.portal_test_case_code);
    const mapLink = mapLinks[mapLinks.length - 1] || null; // use most recent link

    // Look up the linked P6 activity directly by UUID — batch-agnostic
    const p6Linked = mapLink ? P6_ACTS.find(x => x.id === mapLink.p6_activity_id) : null;
    const p6LinkedBatch = p6Linked ? P6_BATCHES.find(b => b.id === p6Linked.batch_id) : null;

    // If linked activity is from current batch, find baseline counterpart; vice versa
    const p6Cur  = p6Linked && p6LinkedBatch?.schedule_type === 'current'  ? p6Linked
                 : (curBatch  && p6Linked ? P6_ACTS.find(x => x.p6_id === p6Linked.p6_id && x.batch_id === curBatch.id)  : null);
    const p6Base = p6Linked && p6LinkedBatch?.schedule_type === 'baseline' ? p6Linked
                 : (baseBatch && p6Linked ? P6_ACTS.find(x => x.p6_id === p6Linked.p6_id && x.batch_id === baseBatch.id) : null);

    // Use current if available, else fall back to baseline for display
    const p6Show  = p6Cur || p6Base;
    const p6Label = !p6Cur && p6Base ? '(Baseline)' : '';

    const { pct, doneW, totalW } = _p6WeightedCompletion(a);
    const status = _amComputeStatus(a);

    const finDiff = p6Cur && p6Base && p6Cur.finish_date && p6Base.finish_date
      ? Math.round((new Date(p6Cur.finish_date) - new Date(p6Base.finish_date)) / 86400000) : null;

    return { a, rec, p6Show, p6Label, p6Cur, p6Base, pct, doneW, totalW, status, finDiff };
  });

  cont.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-head" style="margin-bottom:20px;">
        <div>
          <div class="admin-section-title">Activity Schedule</div>
          <p class="section-sub">
            ${curBatch  ? `Current: <b>${escapeHtml(curBatch.title)}</b>` : 'No current schedule'}
            ${baseBatch ? ` · Baseline: <b>${escapeHtml(baseBatch.title)}</b>` : ''}
          </p>
        </div>
      </div>

      <div class="data-card" style="padding:0;overflow:hidden;">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Subsystem</th>
                <th>Location</th>
                <th>Phase</th>
                <th>Planned Date</th>
                <th>P6 Start</th>
                <th>P6 Finish</th>
                <th>Variance vs Baseline</th>
                <th>Progress</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(({a, rec, p6Show, p6Label, finDiff, pct, doneW, totalW, status}) => `
                <tr>
                  <td style="font-size:12px;font-weight:500;">${escapeHtml(a.activity)}</td>
                  <td><span class="tag">${escapeHtml(a.subsystem)}</span></td>
                  <td style="font-size:12px;">${escapeHtml(a.location)}</td>
                  <td style="font-size:12px;">${escapeHtml(a.phase)}</td>
                  <td style="font-size:12px;">${rec?.planned_date ? _fmtDate(rec.planned_date) : '<span style="color:var(--gray-400);">—</span>'}</td>
                  <td style="font-size:12px;">
                    ${p6Show?.start_date ? `${_fmtDate(p6Show.start_date)}<span style="font-size:10px;color:var(--gray-400);margin-left:4px;">${p6Label}</span>` : '<span style="color:var(--gray-400);">Not linked</span>'}
                  </td>
                  <td style="font-size:12px;">
                    ${p6Show?.finish_date ? `${_fmtDate(p6Show.finish_date)}<span style="font-size:10px;color:var(--gray-400);margin-left:4px;">${p6Label}</span>` : '<span style="color:var(--gray-400);">—</span>'}
                  </td>
                  <td style="font-size:12px;font-weight:600;${finDiff===null?'':finDiff>0?'color:#dc2626;':finDiff<0?'color:#059669;':''}">
                    ${finDiff === null ? '<span style="color:var(--gray-400);">—</span>' : finDiff === 0 ? 'On time' : `${finDiff>0?'+':''}${finDiff}d`}
                  </td>
                  <td title="Weighted by test case weight: ${doneW.toFixed(1)} / ${totalW.toFixed(1)} pts">
                    <div class="am-progress-wrap">
                      <div class="am-progress-bar"><div class="am-progress-fill" style="width:${pct}%;background:${pct===100?'var(--good)':pct>0?'var(--info)':'var(--gray-300)'};"></div></div>
                      <span class="am-progress-label">${pct}%</span>
                    </div>
                  </td>
                  <td>${_amStatusBadge(status)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

