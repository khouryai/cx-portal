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
// ────────────────────────────────────────────────────────────

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
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name)?.classList.add('active');
  document.querySelectorAll('.nav-link, .nav-dd-item').forEach(l => l.classList.remove('active'));
  document.querySelector(`.nav-link[data-page="${name}"]`)?.classList.add('active');
  document.querySelector(`.nav-dd-item[data-page="${name}"]`)?.classList.add('active');
  // Highlight parent dropdown toggle when a child page is active
  document.querySelectorAll('.nav-dd').forEach(dd => {
    const hasActive = !!dd.querySelector('.nav-dd-item.active');
    dd.querySelector('.nav-dd-toggle')?.classList.toggle('active-group', hasActive);
  });
  // Close all dropdowns on navigation
  document.querySelectorAll('.nav-dd').forEach(dd => dd.classList.remove('open'));
  // Re-render pages that need fresh state on each visit
  if (name === 'field-intake') renderFieldIntake();
  window.scrollTo(0, 0);
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const page = link.dataset.page;
    if (page) showPage(page);
  });
});

document.querySelectorAll('.nav-dd-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    const page = item.dataset.page;
    if (page) showPage(page);
  });
});

function _navDdToggle(id) {
  const dd = document.getElementById(id);
  const isOpen = dd.classList.contains('open');
  document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('open'));
  if (!isOpen) dd.classList.add('open');
}

// Close dropdowns on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.nav-dd')) {
    document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('open'));
  }
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
  await Promise.all([loadTestItems(), loadTemplates(), loadLocations(), loadPunchDB(), loadFieldsetConfig(), _loadProfileUsers()]);
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

async function loadTemplates() {
  try {
    const { data, error } = await _sb.from('templates').select('*').order('created_at');
    if (error) throw error;
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
    const { data, error } = await _sb.from('locations').select('*').order('level').order('sort_order');
    if (error) throw error;
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
    const { data, error } = await _sb.from('fieldset_config').select('*');
    if (error) throw error;
    FIELDSET_CONFIG = {};
    (data || []).forEach(row => { FIELDSET_CONFIG[row.field_key] = row.options || []; });
  } catch (err) { console.warn('Fieldset config load failed:', err.message); }
}

async function _loadProfileUsers() {
  try {
    const { data, error } = await _sb.from('profiles').select('full_name, role').eq('is_active', true);
    if (error) throw error;
    PROFILE_USERS = (data || []).filter(u => u.full_name).sort((a,b) => a.full_name.localeCompare(b.full_name));
  } catch (err) { console.warn('Profile users load failed:', err.message); }
}

async function loadTestItems() {
  try {
    const { data, error } = await _sb.from('test_items').select('*').order('test_id');
    if (error) throw error;
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
  _sb.auth.onAuthStateChange(async (event, session) => {
    if (session?.user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
      await _loadCurrentProfile(session.user);
    } else if (!session) {
      _onSignedOut();
    }
  });
  // Check for existing session on load
  _sb.auth.getSession().then(({ data: { session } }) => {
    if (!session) _onSignedOut();
  });
}

async function _loadCurrentProfile(user) {
  try {
    const { data, error } = await _sb.from('profiles').select('*').eq('id', user.id).single();
    if (error || !data) {
      await _sb.auth.signOut();
      showAuthError('Your account is not set up yet — contact your admin.');
      return;
    }
    if (!data.is_active) {
      await _sb.auth.signOut();
      showAuthError('Your account has been deactivated — contact your admin.');
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
  }
}

function _onSignedOut() {
  currentRoleUser = null;
  currentProfile  = null;
  document.getElementById('login-overlay').classList.remove('hidden');
  document.querySelectorAll('.nav-role').forEach(l => l.style.display = 'none');
  document.querySelectorAll('.nav-dd-role').forEach(l => l.style.display = '');
  document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('open'));
  document.getElementById('nav-user-pill')?.remove();
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

async function sendPasswordReset() {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { showAuthError('Enter your email address first.'); return; }
  const { error } = await _sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  showAuthError(error ? error.message : 'Reset link sent — check your email.');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg;
}

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

  let pill = document.getElementById('nav-user-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'nav-user-pill';
    pill.className = 'user-bar-pill';
    document.querySelector('.nav-right')?.prepend(pill);
  }
  const initials = currentRoleUser.name.split(' ').filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase();
  const subBadge = currentRoleUser.subsystem
    ? `<span style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:10px;margin-left:4px;">${escapeHtml(currentRoleUser.subsystem)}</span>` : '';
  pill.innerHTML = `
    <div class="user-avatar" style="width:28px;height:28px;font-size:11px;">${initials}</div>
    <div style="font-size:12px;font-weight:500;color:rgba(255,255,255,0.9);">${escapeHtml(currentRoleUser.name)}${subBadge}</div>
    <button class="logout-mini" onclick="signOut()">Sign out</button>
  `;

  const homePage = { admin:'admin', field_engineer:'field-intake', readonly:'dashboard', client:'dashboard' }[currentRoleUser.role] || 'dashboard';
  showPage(homePage);
  // Re-init views that are subsystem-scoped after login applies TI filter
  initLineItems();
  renderAdminPortal(); renderFieldIntake(); renderTestMatrix(); renderPunchWorkflow(); renderAuditLog();
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
    { id: 'templates',   label: 'Activity Templates' },
    { id: 'testcases',   label: 'Test Items' },
    { id: 'locations',   label: 'Locations' },
    { id: 'directory',   label: 'Directory' },
    { id: 'fieldconfig', label: 'Field Config' },
    { id: 'overview',    label: 'Overview' },
  ];
  root.innerHTML = `
    <div class="admin-tabs">
      ${tabs.map(t => `<button class="admin-tab${_adminTab === t.id ? ' active' : ''}" onclick="setAdminTab('${t.id}')">${t.label}</button>`).join('')}
    </div>
    <div id="admin-tab-body"></div>
  `;
  renderAdminTabBody();
}

function setAdminTab(tab) {
  _adminTab = tab;
  const labelMap = { templates:'Activity Templates', testcases:'Test Items', locations:'Locations', directory:'Directory', fieldconfig:'Field Config', overview:'Overview' };
  document.querySelectorAll('.admin-tab').forEach(el => {
    el.classList.toggle('active', el.textContent.trim() === labelMap[tab]);
  });
  renderAdminTabBody();
}

function renderAdminTabBody() {
  const body = document.getElementById('admin-tab-body');
  if (!body) return;
  if (_adminTab === 'templates') body.innerHTML = _adminTemplatesHTML();
  else if (_adminTab === 'testcases') body.innerHTML = _adminTestItemsHTML();
  else if (_adminTab === 'locations') body.innerHTML = _adminLocationsHTML();
  else if (_adminTab === 'directory') { body.innerHTML = _adminDirectoryHTML(); _loadDirectoryUsers(); }
  else if (_adminTab === 'fieldconfig') body.innerHTML = _adminFieldConfigHTML();
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
  renderTestMatrix();
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
    .upsert({ field_key: key, label: def?.label || key, options }, { onConflict: 'field_key' });
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

  const complete   = filtered.filter(r => r.Status === 'Complete').length;
  const inprog     = filtered.filter(r => r.Status === 'In Progress').length;
  const blocked    = filtered.filter(r => r.Status === 'Blocked').length;
  const notStarted = filtered.filter(r => !r.Status || r.Status === 'Not Started').length;

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
      <div class="matrix-stat"><div class="matrix-stat-label">Complete</div><div class="matrix-stat-value good">${complete}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">In Progress</div><div class="matrix-stat-value info">${inprog}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Blocked</div><div class="matrix-stat-value warn">${blocked}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Not Started</div><div class="matrix-stat-value">${notStarted}</div></div>
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
        const done = g.items.filter(r => r.Status === 'Complete').length;
        return `
        <div class="matrix-section">
          <div class="matrix-section-head">
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <div class="matrix-section-title">${escapeHtml(g.activity)}</div>
                ${g.testReport ? `<span style="font-size:12px;color:var(--gray-600);font-weight:500;">📄 CDRL: ${escapeHtml(g.testReport)}</span>` : ''}
                ${isAdmin ? `<button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="openEditActivityModal(${idx})">Edit</button>` : ''}
              </div>
              <div class="matrix-section-meta">${escapeHtml(g.phase)} · ${escapeHtml(g.location)} · ${escapeHtml(g.subsystem)}</div>
            </div>
            <div class="matrix-section-meta">${done} / ${g.items.length} complete</div>
          </div>
          ${g.items.map(r => _renderTIMatrixRow(r, isAdmin)).join('')}
        </div>`;
      }).join('');
    })()}
  `;
}

let _sessionLog = []; // tracks status changes made this session for Daily Log step 1

function _renderTIMatrixRow(r, isAdmin) {
  const current   = r.Status || 'Not Started';
  const statuses  = ['Not Started','In Progress','Pass','Fail','Blocked','Not Applicable'];
  const showReason = current === 'Fail' || current === 'Blocked';
  const reasonVal  = current === 'Fail' ? (r.FailedReason||'') : (r.BlockedReason||'');
  const tid = escapeHtml(String(r.TestID));
  return `
    <div class="matrix-tc-row">
      <div class="matrix-tc-code">${escapeHtml(r.TestCaseCode||'—')}</div>
      <div style="flex:1;min-width:0;">
        <div class="matrix-tc-name">${escapeHtml(r.TestName||'—')}</div>
        ${r.TestProcedure ? `<div class="matrix-tc-meta">${escapeHtml(r.TestProcedure)}</div>` : ''}
        ${r.CompletedBy ? `<div class="matrix-tc-meta">Completed by <b>${escapeHtml(r.CompletedBy)}</b></div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;min-width:200px;">
        <select class="form-input" style="font-size:12px;padding:5px 8px;" onchange="_mxStatusChange('${tid}',this.value)">
          ${statuses.map(s=>`<option value="${s}" ${current===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <div id="mx-reason-${tid}" style="${showReason?'':'display:none;'}">
          <input type="text" id="mx-ri-${tid}" class="form-input" style="font-size:12px;padding:5px 8px;"
            placeholder="${current==='Fail'?'Failure reason...':'Blocked reason...'}"
            value="${escapeHtml(reasonVal)}"
            onblur="_mxSaveReason('${tid}',this.value)">
        </div>
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

function _mxStatusChange(testId, status) {
  const r = TI.find(t => String(t.TestID) === String(testId));
  if (!r) return;

  // Track session log — store r.TestID (raw, unescaped) as the canonical id
  const rawId = r.TestID;
  const existing = _sessionLog.find(e => String(e.testId) === String(rawId));
  if (existing) {
    existing.newStatus = status;
    existing.changedAt = new Date().toISOString();
  } else {
    _sessionLog.push({
      testId: rawId, testCode: r.TestCaseCode, testName: r.TestName,
      phase: r.Phase, location: r.Location, subsystem: r.Subsystem, activity: r.Activity,
      prevStatus: r.Status || 'Not Started', newStatus: status,
      changedAt: new Date().toISOString(),
      failedReason: r.FailedReason||'', blockedReason: r.BlockedReason||'', hours: 0
    });
  }

  r.Status = status;
  if (status === 'Pass') { r.CompletedBy = currentRoleUser.name; r.CompletedDate = new Date().toISOString(); }

  // Toggle reason input without re-rendering the full matrix
  const reasonEl = document.getElementById(`mx-reason-${testId}`);
  const reasonInput = document.getElementById(`mx-ri-${testId}`);
  if (reasonEl) {
    const needReason = status === 'Fail' || status === 'Blocked';
    reasonEl.style.display = needReason ? '' : 'none';
    if (reasonInput) reasonInput.placeholder = status === 'Fail' ? 'Failure reason...' : 'Blocked reason...';
  }

  _mxSaveStatus(status, r);
}

async function _mxSaveStatus(status, r) {
  const upd = { status };
  if (status === 'Pass') { upd.completed_by = currentRoleUser?.name; upd.completed_date = new Date().toISOString(); }
  try {
    const { error, count } = await _sb.from('test_items').update(upd, { count: 'exact' }).eq('test_id', r.TestID);
    if (error) throw error;
    if (count === 0) {
      console.warn('[mxSaveStatus] 0 rows updated for test_id:', r.TestID, '— check if this ID exists in test_items');
      toast(`⚠ Status changed locally but not saved — test_id "${r.TestID}" not found in DB`, 'warn');
      return;
    }
    toast(`${r.TestCaseCode} → ${status}`, 'success');
    logAudit('Test Status Update', `${r.TestCaseCode} @ ${r.Location}`, `→ ${status}`);
  } catch(e) {
    console.error('[mxSaveStatus] error:', e);
    toast('Save failed: ' + e.message, 'error');
  }
}

function _mxSaveReason(testId, reason) {
  const r = TI.find(t => String(t.TestID) === String(testId));
  if (!r) return;
  const isFail = r.Status === 'Fail';
  if (isFail) r.FailedReason = reason; else r.BlockedReason = reason;
  const logEntry = _sessionLog.find(e => String(e.testId) === String(r.TestID));
  if (logEntry) { if (isFail) logEntry.failedReason = reason; else logEntry.blockedReason = reason; }
  const upd = isFail ? { failed_reason: reason } : { blocked_reason: reason };
  _sb.from('test_items').update(upd).eq('test_id', r.TestID).then(({error}) => {
    if (error) toast('Reason save failed: ' + error.message, 'error');
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
  modal({
    title: 'Edit Activity',
    size: 'medium',
    body: `
      <div class="form-field">
        <label>Activity Name</label>
        <input type="text" id="ea-name" class="form-input" value="${escapeHtml(data.activity||'')}">
      </div>
      <div class="form-field" style="margin-top:12px;">
        <label>CDRL Reference</label>
        <input type="text" id="ea-report" class="form-input" placeholder="e.g. CDRL-A001" value="${escapeHtml(data.testReport||'')}">
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
  const report = document.getElementById('ea-report').value.trim();
  if (!name) { toast('Activity name required','error'); return; }

  const rows = TI.filter(r => r.Activity===data.activity && r.Location===data.location && r.Phase===data.phase && r.Subsystem===data.subsystem);
  if (!rows.length) { toast('No matching test cases found','error'); return; }

  const btn = document.querySelector('.modal-footer .admin-action-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  rows.forEach(r => { r.Activity=name; r.TestReport=report; });
  try {
    const ids = rows.map(r => r.TestID);
    const { error } = await _sb.from('test_items').update({ activity: name, test_report: report }).in('test_id', ids);
    if (error) throw error;
    toast(`Updated ${rows.length} test cases`, 'success');
    _pendingActivityEdit = null;
    closeModal();
    renderTestMatrix();
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
          <p style="font-size:13px;">Open the Test Matrix, update test case statuses as you work, then return here to complete the Daily Log.</p>
        </div>
        <div class="form-actions">
          <button class="form-secondary" onclick="showPage('test-matrix')">Open Test Matrix</button>
          <button class="form-submit" onclick="setIntakeStep(2)">Skip to Step 2 →</button>
        </div>
      </div>
    `;
  }

  const allEntries = [
    ...log.map((e,i) => ({...e, _idx:i, _fromLog:true})),
    ...intakeAdditions.map((a,i) => ({...a, _idx:i, _fromAdditions:true}))
  ];
  const statusColor = s => ({'Pass':'#059669','In Progress':'#1d4ed8','Fail':'#dc2626','Blocked':'#d97706','Not Started':'#6b7280','Not Applicable':'#9ca3af'}[s]||'#6b7280');

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
          const reason = e.failedReason||e.blockedReason||'';
          return `
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;display:grid;grid-template-columns:1fr 120px;gap:12px;align-items:start;">
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px;">${escapeHtml(e.testCode)} · ${escapeHtml(e.testName)}</div>
                <div style="font-size:11px;color:var(--gray-500);">${escapeHtml(e.phase||'—')} · ${escapeHtml(e.location||'—')} · ${escapeHtml(e.activity||'—')}</div>
                <div style="margin-top:6px;font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  ${ps ? `<span style="background:#e5e7eb;color:#374151;padding:2px 8px;border-radius:10px;">${escapeHtml(ps)}</span><span style="color:var(--gray-400);">→</span>` : ''}
                  <span style="background:${statusColor(ns)}20;color:${statusColor(ns)};padding:2px 8px;border-radius:10px;font-weight:600;">${escapeHtml(ns)}</span>
                  ${reason ? `<span style="font-size:11px;color:#dc2626;">✗ ${escapeHtml(reason)}</span>` : ''}
                </div>
              </div>
              <div>
                <label style="font-size:11px;color:var(--gray-500);display:block;margin-bottom:4px;">Hours Spent</label>
                <input type="number" min="0" step="0.25" class="form-input" style="font-size:13px;padding:5px 8px;"
                  value="${e.hours||0}"
                  ${e._fromLog ? `onchange="_updateSessionHours(${e._idx},this.value)"` : `onchange="_updateAdditionHours(${e._idx},this.value)"`}>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="form-actions">
        <button class="form-secondary" onclick="showPage('test-matrix')">↺ Back to Test Matrix</button>
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
        <button class="form-submit" onclick="setIntakeStep(3)">Continue to Step 3 →</button>
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
  intakeAdditions.push({
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
  });
  toast('Added to list', 'success');
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
  const catWrap = document.getElementById('i3-delay-cat-wrap');
  const hrsWrap = document.getElementById('i3-delay-hrs-wrap');
  if (catWrap) catWrap.style.display = show;
  if (hrsWrap) hrsWrap.style.display = show;
}

async function submitIntakeFinal() {
  try {
    console.log('[submitIntakeFinal] called');

    if (!_sb) { alert('Supabase client not initialized — check your connection.'); return; }
    if (!currentRoleUser) { alert('Not logged in.'); return; }

    const allItems = [
      ..._sessionLog.map(e => ({ ...e, status: e.newStatus })),
      ...intakeAdditions,
    ];

    if (!allItems.length) {
      toast('No test cases to submit — update statuses in the Test Matrix first', 'warn');
      return;
    }

    const dateVal       = document.getElementById('i3-date')?.value || new Date().toISOString().split('T')[0];
    const testers       = parseInt(document.getElementById('i3-testers')?.value) || 1;
    const idleHours     = parseFloat(document.getElementById('i3-idle')?.value) || 0;
    // scope toggle query to step-3 card to avoid picking up other pages' toggles
    const activeToggle  = document.getElementById('field-intake-content')?.querySelector('.toggle-btn.active');
    const delayOccurred = activeToggle?.dataset.val || 'No';
    const delayCat      = delayOccurred === 'Yes' ? (document.getElementById('i3-delay-cat')?.value || null) : null;
    const delayHrs      = delayOccurred === 'Yes' ? (parseFloat(document.getElementById('i3-delay-hrs')?.value) || 0) : 0;
    const overallNotes  = document.getElementById('i3-notes')?.value || '';
    const nextDayPlan   = document.getElementById('i3-next')?.value  || '';
    const submitter     = currentRoleUser.name;

    const resultRows = allItems.map((item, idx) => ({
      result_id:         'R-' + Date.now() + '-' + idx,
      test_id:           item.testId || item.id  || null,
      test_name:         item.testName           || null,
      phase:             item.phase              || null,
      location:          item.location           || null,
      subsystem:         item.subsystem          || null,
      activity:          item.activity           || null,
      test_case_code:    item.testCode           || null,
      test_procedure:    item.testProcedure      || null,
      result:            item.status             || null,
      new_status:        item.status             || null,
      completed_by:      submitter,
      date_tested:       dateVal,
      submitted_by:      submitter,
      number_of_testers: testers,
      failed_reason:     item.failedReason       || null,
      blocked_reason:    item.blockedReason      || null,
      notes:             item.notes              || null,
    }));

    const logRow = {
      log_id:             'DL-' + Date.now(),
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
      delay_hours:        delayHrs,
      overall_notes:      overallNotes,
      next_day_plan:      nextDayPlan,
    };

    console.log('[submitIntakeFinal] resultRows:', resultRows.length, 'logRow:', logRow);

    const errors = [];

    if (resultRows.length > 0) {
      const { error: rErr } = await _sb.from('test_results').insert(resultRows);
      if (rErr) { console.error('[test_results] insert error:', rErr); errors.push('test_results: ' + rErr.message); }
    }

    const { error: lErr } = await _sb.from('delay_log').insert([logRow]);
    if (lErr) { console.error('[delay_log] insert error:', lErr); errors.push('delay_log: ' + lErr.message); }

    if (errors.length) {
      alert('Submit failed:\n\n' + errors.join('\n\n') + '\n\nSee browser console (F12) for details.');
      return;
    }

    logAudit('Daily Log Submitted', `${allItems.length} test cases logged`, 'Daily report generated');
    _sessionLog     = [];
    intakeAdditions = [];
    intakeStep      = 1;
    toast(`Daily log submitted! ${allItems.length} tests logged.`, 'success');
    renderFieldIntake();
    renderTestMatrix();

  } catch (err) {
    console.error('[submitIntakeFinal] unexpected error:', err);
    alert('Unexpected error: ' + err.message + '\n\nCheck browser console (F12) for full details.');
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

function _punchDeriveActivity(code) {
  if (!code) return null;
  return TI.find(r => r.TestCaseCode === code)?.Activity || null;
}
const PL_PAGE_SIZE = 25;

async function loadPunchDB() {
  try {
    const { data, error } = await _sb.from('punch_items').select('*').order('number', { ascending: false });
    if (error) throw error;
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
  const phases    = LOCS.filter(l => l.level === 1).sort((a,b) => a.sort_order - b.sort_order);
  const locPool   = _plPhaseFilter ? LOCS.filter(l => l.level === 2 && l.parent_id === _plPhaseFilter) : LOCS.filter(l => l.level === 2);
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
        ${SUBSYSTEMS_LIST.map(s=>`<option value="${s}" ${_plSubFilter===s?'selected':''}>${s}</option>`).join('')}
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

    <div class="data-card" style="padding:0;overflow:hidden;">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:50px;">#</th>
            <th>Title</th>
            <th>Status</th>
            <th>Ball In Court</th>
            <th>Subsystem</th>
            <th>Phase / Location</th>
            <th>Priority</th>
            <th>Due Date</th>
            <th>PIM</th>
            <th style="width:60px;"></th>
          </tr>
        </thead>
        <tbody>
          ${paged.length ? paged.map(p => {
            const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== 'closed' && p.status !== 'voided';
            const dueStr = p.due_date ? new Date(p.due_date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
            return `<tr onclick="openPunchDetail('${p.id}')" style="cursor:pointer;">
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
              <td style="font-size:12px;">${escapeHtml(p.punch_item_manager||'—')}</td>
              <td onclick="event.stopPropagation()">
                <button class="form-secondary" style="font-size:11px;padding:3px 8px;" onclick="openPunchDetail('${p.id}')">View</button>
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--gray-400);">${_plTab==='bin'?'Recycle bin is empty':'No punch items match your filters'}</td></tr>`}
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
  else if (k==='loc') _plLocFilter=v;
  else if (k==='sub') _plSubFilter=v;
  else if (k==='priority') _plPriorityFilter=v;
  else if (k==='activity') _plActivityFilter=v;
  _plPage=1; renderPunchWorkflow();
}
function _plPhaseChange(id) { _plPhaseFilter=id; _plLocFilter=''; _plPage=1; renderPunchWorkflow(); }
function _plClearFilters()  { _plSearch=''; _plStatusFilter=''; _plPhaseFilter=''; _plLocFilter=''; _plSubFilter=''; _plPriorityFilter=''; _plActivityFilter=''; _plPage=1; renderPunchWorkflow(); }

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

      <!-- Comments -->
      <div style="margin-bottom:18px;">
        <div style="font-size:11px;font-weight:600;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Comments (${(p.comments||[]).length})</div>
        <div style="display:flex;flex-direction:column;gap:10px;max-height:200px;overflow-y:auto;margin-bottom:10px;" id="punch-comments-${id}">
          ${comments.length ? comments.map(c => {
            const initials = (c.by||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
            const roleLabel = {admin:'Admin',field_engineer:'Field Engineer',client:'Client',readonly:'Read Only'}[c.by_role]||c.by_role||'';
            return `<div style="display:flex;gap:10px;align-items:flex-start;">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--hitachi-red);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${initials}</div>
              <div style="flex:1;background:var(--gray-50);border-radius:8px;padding:8px 12px;">
                <div style="font-size:12px;font-weight:600;color:var(--gray-800);">${escapeHtml(c.by)} <span style="font-weight:400;color:var(--gray-500);">· ${roleLabel} · ${dateAgo(c.at)}</span></div>
                <div style="font-size:13px;color:var(--gray-700);margin-top:4px;white-space:pre-wrap;">${escapeHtml(c.text)}</div>
              </div>
            </div>`;
          }).join('') : '<div style="font-size:12px;color:var(--gray-400);padding:8px 0;">No comments yet</div>'}
        </div>
        ${canComment ? `
          <div style="display:flex;gap:8px;align-items:flex-end;">
            <textarea id="punch-comment-input-${id}" class="form-input" rows="2" placeholder="Write a comment…" style="flex:1;font-size:13px;resize:none;"></textarea>
            <button class="form-submit" style="white-space:nowrap;height:fit-content;" onclick="addPunchComment('${id}')">Post</button>
          </div>` : ''}
      </div>

      <!-- History -->
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Activity History</div>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;">
          ${history.length ? history.map(h => `
            <div style="display:flex;gap:10px;align-items:flex-start;font-size:12px;">
              <div style="width:6px;height:6px;border-radius:50%;background:var(--hitachi-red);margin-top:5px;flex-shrink:0;"></div>
              <div style="flex:1;">
                <div><span style="font-weight:600;">${escapeHtml(h.action)}</span> <span style="color:var(--gray-500);">· ${escapeHtml(h.by||'')} · ${dateAgo(h.at)}</span></div>
                ${(h.changes||[]).length ? `<ul style="margin:4px 0 0 0;padding-left:16px;color:var(--gray-600);">${h.changes.map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
                ${h.note ? `<div style="color:var(--gray-600);margin-top:2px;">Note: ${escapeHtml(h.note)}</div>` : ''}
              </div>
            </div>`).join('') : '<div style="color:var(--gray-400);font-size:12px;">No history</div>'}
        </div>
      </div>
    `,
    footer: `
      <button class="form-secondary" onclick="closeModal()">Close</button>
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
function renderAuditLog() {
  const root = document.getElementById('audit-content');
  if (!root || !currentRoleUser) return;
  if (currentRoleUser.role !== 'admin') {
    root.innerHTML = `<div class="docs-empty"><h3>Admins only</h3></div>`;
    return;
  }

  root.innerHTML = `
    <div class="data-card">
      <div class="data-card-head">
        <span class="data-count">${AUDIT_LOG.length} entries</span>
        <button class="export-btn" onclick="exportAudit()">Export CSV</button>
      </div>
      <div class="table-wrap">
        ${AUDIT_LOG.map(e => `
          <div class="audit-row role-${e.role}">
            <div class="audit-time">${new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            <div class="audit-user-pill">
              <span>${escapeHtml(e.user)}</span>
              <span class="role-mini">${escapeHtml(ROLE_LABELS[e.role] || e.role)}</span>
            </div>
            <div class="audit-action">${escapeHtml(e.action)}</div>
            <div>
              <div class="audit-target">${escapeHtml(e.target)}</div>
              <div class="audit-details">${escapeHtml(e.details)} ${e.notes ? `· "${escapeHtml(e.notes)}"` : ''}</div>
            </div>
            <div class="audit-time">${dateAgo(e.timestamp)}</div>
          </div>
        `).join('')}
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
  downloadCSV(toCSV(AUDIT_LOG, cols), 'audit_log.csv');
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

