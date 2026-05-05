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
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector(`[data-page="${name}"]`)?.classList.add('active');
  window.scrollTo(0, 0);
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const page = link.dataset.page;
    showPage(page);
  });
});

// ==========================================
// HELPERS
// ==========================================
function getStatusBadge(status) {
  if (!status) return '<span class="badge badge-notstarted">—</span>';
  const s = status.toString();
  const map = {
    'Passed': 'badge-passed',
    'Closed': 'badge-closed',
    'Failed': 'badge-failed',
    'Open': 'badge-open',
    'In Progress': 'badge-inprog',
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

  ['ap-search','ap-status-filter','ap-subsys-filter','ap-phase-filter','ap-location-filter'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderAPTable);
  });

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
// LINE ITEMS PAGE
// ==========================================
let liSort = { col: null, asc: false };

function initLineItems() {
  document.getElementById('li-summary').textContent = `${LI.length.toLocaleString()} test line items across all SAT activities`;

  document.getElementById('li-passed').textContent = LI.filter(r => r.Status === 'Passed').length;
  document.getElementById('li-failed').textContent = LI.filter(r => r.Status === 'Failed').length;
  document.getElementById('li-inprog').textContent = LI.filter(r => r.Status === 'In Progress').length;
  document.getElementById('li-open').textContent = LI.filter(r => r.Status === 'Open').length;

  const statuses = [...new Set(LI.map(r => r.Status).filter(Boolean))].sort();
  const subsys = [...new Set(LI.map(r => r['Plan Commissioning: SubSystem-']).filter(Boolean))].sort();
  const locs = [...new Set(LI.map(r => r.Location).filter(Boolean))].sort();

  populateSelect('li-status-filter', 'All statuses', statuses);
  populateSelect('li-subsys-filter', 'All subsystems', subsys);
  populateSelect('li-location-filter', 'All locations', locs);

  ['li-search','li-status-filter','li-subsys-filter','li-location-filter'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderLITable);
  });

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

function clearLIFilters() {
  ['li-search','li-status-filter','li-subsys-filter','li-location-filter'].forEach(id => document.getElementById(id).value = '');
  renderLITable();
}

function renderLITable() {
  const search = document.getElementById('li-search').value.toLowerCase();
  const statusF = document.getElementById('li-status-filter').value;
  const subsysF = document.getElementById('li-subsys-filter').value;
  const locF = document.getElementById('li-location-filter').value;

  let data = LI.filter(r =>
    (!search || (r.Title && r.Title.toLowerCase().includes(search)) || (r['Plan Name'] && r['Plan Name'].toLowerCase().includes(search))) &&
    (!statusF || r.Status === statusF) &&
    (!subsysF || r['Plan Commissioning: SubSystem-'] === subsysF) &&
    (!locF || r.Location === locF)
  );

  if (liSort.col) {
    data = [...data].sort((a, b) => {
      const av = a[liSort.col] || '';
      const bv = b[liSort.col] || '';
      const cmp = av.toString().localeCompare(bv.toString(), undefined, { numeric: true });
      return liSort.asc ? cmp : -cmp;
    });
  }

  // Render only first 500 rows to keep page snappy with very large datasets
  const renderRows = data.slice(0, 500);

  const tbody = document.getElementById('li-body');
  tbody.innerHTML = renderRows.map(r => `
    <tr>
      <td><span class="cell-name">${escapeHtml(r.Title)}</span></td>
      <td>${escapeHtml(r['Section Title'] || '—')}</td>
      <td><span class="tag">${escapeHtml(r['Plan Commissioning: SubSystem-'] || '—')}</span></td>
      <td>${escapeHtml(r.Location || '—')}</td>
      <td><span class="cell-sub" style="font-size:12px">${escapeHtml(r['Plan Name'] || '—')}</span></td>
      <td>${getStatusBadge(r.Status)}</td>
    </tr>
  `).join('');

  const truncated = data.length > 500 ? ` (showing first 500 — refine filters for more)` : '';
  document.getElementById('li-count').textContent = `Showing ${renderRows.length.toLocaleString()} of ${LI.length.toLocaleString()} line items${truncated}`;

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

  document.getElementById('pl-high').textContent = PL.filter(r => r.Priority === 'high').length;
  document.getElementById('pl-work').textContent = PL.filter(r => r.Status === 'Work Required').length;
  document.getElementById('pl-ready').textContent = PL.filter(r => r.Status === 'Ready To Close').length;
  document.getElementById('pl-closed').textContent = PL.filter(r => r.Status === 'Closed').length;

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

  const truncated = data.length > 500 ? ` (showing first 500 — refine filters for more)` : '';
  document.getElementById('pl-count').textContent = `Showing ${renderRows.length.toLocaleString()} of ${PL.length.toLocaleString()} punch items${truncated}`;

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
    { key: 'Title', label: 'Title' },
    { key: 'Section Title', label: 'Section' },
    { key: 'Plan Commissioning: SubSystem-', label: 'Subsystem' },
    { key: 'Location', label: 'Location' },
    { key: 'Plan Name', label: 'Activity' },
    { key: 'Status', label: 'Status' },
  ];
  downloadCSV(toCSV(LI, cols), 'line_items.csv');
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
  await loadTestItems();
  initDashboard();
  initActivities();
  initLineItems();
  initPunchList();
  initLocations();
  initOrg();
});

// ==========================================
// FIELD LOGGING - Login + Forms
// ==========================================

let TI = DATA.testItems || []; // populated from Supabase on init; falls back to data.js
const FIELD_USERS = DATA.fieldUsers || [];

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
        Notes:         r.notes,
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
const DEPLOYMENTS = DATA.deployments || [];
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

// ==========================================================================
// LOGIN V2 — supports all 5 roles
// ==========================================================================
function initLoginV2() {
  // Replace the login dropdown with the V2 user list (all roles)
  const sel = document.getElementById('login-name');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select your name</option>' +
    USERS_V2.map(u => `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)} — ${ROLE_TITLES[u.role]}</option>`).join('');

  // Restore session
  const saved = sessionStorage.getItem('hitachi_role_user');
  if (saved) {
    try {
      currentRoleUser = JSON.parse(saved);
      onLoggedIn();
    } catch {}
  }

  // Hijack the existing login button
  const btn = document.getElementById('login-btn');
  if (btn) {
    btn.replaceWith(btn.cloneNode(true)); // remove old listeners
    document.getElementById('login-btn').addEventListener('click', tryLoginV2);
  }
  document.getElementById('login-pin')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') tryLoginV2();
  });
}

function tryLoginV2() {
  const name = document.getElementById('login-name').value;
  const pin = document.getElementById('login-pin').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Please select your name'; return; }
  if (!pin || pin.length !== 4) { errEl.textContent = 'Please enter your 4-digit PIN'; return; }

  const user = USERS_V2.find(u => u.name === name && u.pin === pin);
  if (!user) {
    errEl.textContent = 'Invalid name or PIN. Please try again.';
    document.getElementById('login-pin').value = '';
    return;
  }

  currentRoleUser = { name: user.name, role: user.role, title: user.title };
  sessionStorage.setItem('hitachi_role_user', JSON.stringify(currentRoleUser));
  onLoggedIn();

  // Auto-route to the most relevant page for the role
  const homePage = {
    admin: 'admin',
    field: 'field-intake',
    punch_manager: 'punch-workflow',
    technician: 'punch-workflow',
    client: 'punch-workflow',
  }[user.role] || 'dashboard';
  showPage(homePage);
}

function onLoggedIn() {
  // Show role-specific nav links
  document.querySelectorAll('.nav-role').forEach(link => {
    const allowed = (link.dataset.role || '').split(' ');
    link.style.display = allowed.includes(currentRoleUser.role) ? '' : 'none';
  });

  // Replace Sign In nav with user pill
  const navLogin = document.getElementById('nav-login');
  if (navLogin) navLogin.style.display = 'none';

  // Add user pill in nav (or update existing)
  let pill = document.getElementById('nav-user-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'nav-user-pill';
    pill.className = 'user-bar-pill';
    document.querySelector('.nav-right')?.prepend(pill);
  }
  const initials = currentRoleUser.name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0]).join('').toUpperCase();
  pill.innerHTML = `
    <div class="user-avatar" style="width:28px;height:28px;font-size:11px;">${initials}</div>
    <div style="font-size:12px;font-weight:500;color:var(--black);">${escapeHtml(currentRoleUser.name)}</div>
    <button class="logout-mini" onclick="logoutV2()">Sign out</button>
  `;

  // Render any open page
  renderAdminPortal();
  renderFieldIntake();
  renderTestMatrix();
  renderPunchWorkflow();
  renderAuditLog();
}

function logoutV2() {
  currentRoleUser = null;
  sessionStorage.removeItem('hitachi_role_user');
  document.querySelectorAll('.nav-role').forEach(link => link.style.display = 'none');
  document.getElementById('nav-user-pill')?.remove();
  document.getElementById('nav-login').style.display = '';
  showPage('dashboard');
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

  const nDeployments = DEPLOYMENTS.length;
  const nTemplates = TEMPLATES.length;
  const nInstances = TEST_INSTANCES.length;
  const nApplicable = TEST_INSTANCES.filter(t => t.applicable).length;

  root.innerHTML = `
    <div class="kpi-grid kpi-grid-mini">
      <div class="kpi-card kpi-mini"><div class="kpi-label">Templates</div><div class="kpi-value">${nTemplates}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Active Deployments</div><div class="kpi-value">${nDeployments}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Test Cases (Total)</div><div class="kpi-value">${nInstances}</div></div>
      <div class="kpi-card kpi-mini"><div class="kpi-label">Applicable</div><div class="kpi-value good">${nApplicable}</div></div>
    </div>

    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Test Case Templates</div>
          <p class="section-sub">Create reusable templates that can be deployed across multiple locations</p>
        </div>
        <button class="admin-action-btn" onclick="openNewTemplateModal()">+ New Template</button>
      </div>
      <div class="template-grid">
        ${TEMPLATES.map(tpl => `
          <div class="template-card" onclick="openDeployModal('${tpl.id}')">
            <div class="template-card-head">
              <span class="template-tag">${escapeHtml(tpl.subsystem)}</span>
            </div>
            <div class="template-card-name">${escapeHtml(tpl.name)}</div>
            <div class="template-card-sub">${escapeHtml(tpl.description)}</div>
            <div class="template-card-stats">
              <span><b>${tpl.testCases.length}</b> test cases</span>
              <span><b>${DEPLOYMENTS.filter(d => d.templateId === tpl.id).length}</b> deployments</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="admin-section">
      <div class="admin-section-head">
        <div>
          <div class="admin-section-title">Recent Deployments</div>
          <p class="section-sub">Templates deployed to locations with applicability matrices</p>
        </div>
      </div>
      <div class="data-card">
        <table class="data-table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Locations</th>
              <th>Test Cases</th>
              <th>Deployed By</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            ${DEPLOYMENTS.map(d => {
              const totalTC = d.locations.reduce((sum, l) => sum + l.applicable.length, 0);
              return `
                <tr>
                  <td><span class="cell-name">${escapeHtml(d.templateName)}</span></td>
                  <td>${d.locations.map(l => `<span class="tag" style="margin-right:4px">${escapeHtml(l.code)}</span>`).join('')}</td>
                  <td><b>${totalTC}</b> applicable across ${d.locations.length} locations</td>
                  <td>${escapeHtml(d.deployedBy)}</td>
                  <td>${dateAgo(d.deployedAt)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function openDeployModal(templateId) {
  const tpl = TEMPLATES.find(t => t.id === templateId);
  if (!tpl) return;

  // Initialize state — all locations off, all TCs on by default if location is on
  const state = {};
  LOCATIONS.forEach(loc => {
    state[loc.code] = { enabled: false, applicable: tpl.testCases.map(tc => tc.code) };
  });

  modal({
    title: `Deploy: ${tpl.name}`,
    sub: `Toggle locations and pick which test cases apply at each one`,
    size: 'large',
    body: `
      <div style="margin-bottom: 16px;">
        <p style="font-size: 13px; color: var(--gray-700);">
          Select which locations this template applies to, then refine which test cases apply at each location.
        </p>
      </div>
      <div id="deploy-locs">
        ${LOCATIONS.map(loc => `
          <div class="deploy-loc-row" id="dep-row-${loc.code}">
            <div class="deploy-loc-head">
              <div class="deploy-loc-toggle" data-code="${loc.code}" onclick="toggleDeployLoc('${loc.code}')"></div>
              <div class="deploy-loc-name">${escapeHtml(loc.name)}</div>
              <div class="deploy-loc-count" id="dep-count-${loc.code}">0 of ${tpl.testCases.length} test cases</div>
            </div>
            <div class="deploy-tc-list">
              ${tpl.testCases.map(tc => `
                <label class="deploy-tc-item">
                  <input type="checkbox" data-loc="${loc.code}" data-tc="${tc.code}" checked onchange="updateDeployCount('${loc.code}', ${tpl.testCases.length})">
                  <span>${escapeHtml(tc.code)} · ${escapeHtml(tc.name)}</span>
                </label>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `,
    footer: `
      <button class="admin-action-btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="admin-action-btn" onclick="confirmDeploy('${templateId}')">Deploy to Selected Locations</button>
    `,
  });

  // Set initial state
  setTimeout(() => {
    LOCATIONS.forEach(loc => updateDeployCount(loc.code, tpl.testCases.length));
  }, 50);
}

function toggleDeployLoc(code) {
  const toggle = document.querySelector(`.deploy-loc-toggle[data-code="${code}"]`);
  const row = document.getElementById(`dep-row-${code}`);
  toggle.classList.toggle('on');
  row.classList.toggle('disabled', !toggle.classList.contains('on'));
}

function updateDeployCount(code, total) {
  const checked = document.querySelectorAll(`input[data-loc="${code}"]:checked`).length;
  const el = document.getElementById(`dep-count-${code}`);
  if (el) el.textContent = `${checked} of ${total} test cases`;
}

function confirmDeploy(templateId) {
  const tpl = TEMPLATES.find(t => t.id === templateId);
  const enabledLocs = [];

  LOCATIONS.forEach(loc => {
    const toggle = document.querySelector(`.deploy-loc-toggle[data-code="${loc.code}"]`);
    if (!toggle.classList.contains('on')) return;
    const applicable = [];
    document.querySelectorAll(`input[data-loc="${loc.code}"]:checked`).forEach(cb => {
      applicable.push(cb.dataset.tc);
    });
    if (applicable.length > 0) enabledLocs.push({ code: loc.code, applicable, notes: '' });
  });

  if (enabledLocs.length === 0) {
    toast('Please select at least one location with test cases', 'warn');
    return;
  }

  // Add deployment
  const newDep = {
    id: 'dep-' + Date.now(),
    templateId,
    templateName: tpl.name,
    deployedBy: currentRoleUser.name,
    deployedAt: new Date().toISOString(),
    locations: enabledLocs,
  };
  DEPLOYMENTS.unshift(newDep);

  // Generate test instances
  enabledLocs.forEach(loc => {
    loc.applicable.forEach(tcCode => {
      const tc = tpl.testCases.find(t => t.code === tcCode);
      TEST_INSTANCES.push({
        id: `ti-${newDep.id}-${loc.code}-${tcCode}`,
        deploymentId: newDep.id,
        templateName: tpl.name,
        subsystem: tpl.subsystem,
        location: loc.code,
        testCode: tcCode,
        testName: tc.name,
        procedure: tc.procedure,
        duration: tc.duration,
        status: 'not_started',
        applicable: true,
        lastUpdatedBy: null,
        lastUpdatedAt: null,
        notes: '',
      });
    });
  });

  logAudit('Deployed Template',
    `${tpl.name} to ${enabledLocs.map(l => l.code).join(', ')}`,
    `${enabledLocs.reduce((s, l) => s + l.applicable.length, 0)} test cases created`);

  closeModal();
  toast(`Deployed ${tpl.name} to ${enabledLocs.length} location${enabledLocs.length > 1 ? 's' : ''}`, 'success');
  renderAdminPortal();
  renderTestMatrix();
}

function openNewTemplateModal() {
  modal({
    title: 'Create Template',
    sub: 'Define a reusable test case template',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full">
          <label>Template Name</label>
          <input type="text" id="ntpl-name" class="form-input" placeholder="e.g. CBTC Wayside SAT">
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
          <textarea id="ntpl-desc" class="form-input" rows="2" placeholder="What does this template cover?"></textarea>
        </div>
        <div class="form-field form-field-full">
          <label>Test Cases (one per line, format: CODE | Name | Procedure)</label>
          <textarea id="ntpl-cases" class="form-input" rows="8" placeholder="DCS-SAT-01 | Network Test | CDRL 9.04.53"></textarea>
        </div>
      </div>
    `,
    footer: `
      <button class="admin-action-btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="admin-action-btn" onclick="saveNewTemplate()">Create Template</button>
    `,
  });
}

function saveNewTemplate() {
  const name = document.getElementById('ntpl-name').value.trim();
  const subsystem = document.getElementById('ntpl-subsystem').value;
  const desc = document.getElementById('ntpl-desc').value.trim();
  const casesText = document.getElementById('ntpl-cases').value.trim();
  if (!name || !casesText) {
    toast('Name and test cases required', 'error');
    return;
  }
  const testCases = casesText.split('\n').map(line => {
    const parts = line.split('|').map(p => p.trim());
    return { code: parts[0] || '', name: parts[1] || '', procedure: parts[2] || '', duration: 1 };
  }).filter(tc => tc.code && tc.name);

  const newTpl = {
    id: 'tpl-' + Date.now(),
    name, subsystem, description: desc,
    createdBy: currentRoleUser.name,
    createdAt: new Date().toISOString(),
    testCases,
  };
  TEMPLATES.push(newTpl);
  logAudit('Created Template', name, `${testCases.length} test cases`);
  closeModal();
  toast(`Created template: ${name}`, 'success');
  renderAdminPortal();
}

// ==========================================================================
// TEST MATRIX VIEW — Live status toggle scratchpad
// ==========================================================================
let matrixFilter = { location: '', subsystem: '', applicable: 'all' };

function renderTestMatrix() {
  const root = document.getElementById('test-matrix-content');
  if (!root || !currentRoleUser) return;

  // Stats
  const filtered = TEST_INSTANCES.filter(t =>
    (!matrixFilter.location || t.location === matrixFilter.location) &&
    (!matrixFilter.subsystem || t.subsystem === matrixFilter.subsystem) &&
    (matrixFilter.applicable === 'all' ||
      (matrixFilter.applicable === 'yes' && t.applicable) ||
      (matrixFilter.applicable === 'no' && !t.applicable))
  );

  const totals = {
    passed: filtered.filter(t => t.applicable && t.status === 'passed').length,
    failed: filtered.filter(t => t.applicable && t.status === 'failed').length,
    blocked: filtered.filter(t => t.applicable && t.status === 'blocked').length,
    inProgress: filtered.filter(t => t.applicable && t.status === 'in_progress').length,
    notStarted: filtered.filter(t => t.applicable && t.status === 'not_started').length,
  };

  // Group by location > subsystem > template
  const groups = {};
  filtered.forEach(t => {
    const key = `${t.location} · ${t.subsystem} · ${t.templateName}`;
    if (!groups[key]) groups[key] = { location: t.location, subsystem: t.subsystem, template: t.templateName, items: [] };
    groups[key].items.push(t);
  });

  const isAdmin = currentRoleUser.role === 'admin';

  root.innerHTML = `
    <div class="matrix-summary">
      <div class="matrix-stat"><div class="matrix-stat-label">Passed</div><div class="matrix-stat-value good">${totals.passed}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Failed</div><div class="matrix-stat-value bad">${totals.failed}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Blocked</div><div class="matrix-stat-value warn">${totals.blocked}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">In Progress</div><div class="matrix-stat-value info">${totals.inProgress}</div></div>
      <div class="matrix-stat"><div class="matrix-stat-label">Not Started</div><div class="matrix-stat-value">${totals.notStarted}</div></div>
    </div>

    <div class="matrix-filter-bar">
      <select class="filter-select" id="mx-loc" onchange="updateMatrixFilter()">
        <option value="">All Locations</option>
        ${LOCATIONS.map(l => `<option value="${l.code}" ${matrixFilter.location === l.code ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
      </select>
      <select class="filter-select" id="mx-sub" onchange="updateMatrixFilter()">
        <option value="">All Subsystems</option>
        ${[...new Set(TEST_INSTANCES.map(t => t.subsystem))].sort().map(s => `<option value="${s}" ${matrixFilter.subsystem === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select class="filter-select" id="mx-app" onchange="updateMatrixFilter()">
        <option value="all" ${matrixFilter.applicable === 'all' ? 'selected' : ''}>All test cases</option>
        <option value="yes" ${matrixFilter.applicable === 'yes' ? 'selected' : ''}>Applicable only</option>
        <option value="no" ${matrixFilter.applicable === 'no' ? 'selected' : ''}>Not applicable only</option>
      </select>
    </div>

    ${Object.keys(groups).length === 0 ? `
      <div class="docs-empty">
        <h3>No test cases match your filters</h3>
        <p>Try clearing filters or selecting a different location.</p>
      </div>
    ` : Object.values(groups).map(g => `
      <div class="matrix-section">
        <div class="matrix-section-head">
          <div>
            <div class="matrix-section-title">${escapeHtml(g.location)} — ${escapeHtml(g.subsystem)}</div>
            <div class="matrix-section-meta">${escapeHtml(g.template)} · ${g.items.length} test cases</div>
          </div>
          <div class="matrix-section-meta">
            ${g.items.filter(t => t.applicable && t.status === 'passed').length} / ${g.items.filter(t => t.applicable).length} passed
          </div>
        </div>
        ${g.items.map(t => renderMatrixRow(t, isAdmin)).join('')}
      </div>
    `).join('')}
  `;
}

function renderMatrixRow(t, isAdmin) {
  const statuses = ['passed', 'failed', 'blocked', 'in_progress'];
  const labels = { passed: 'Pass', failed: 'Fail', blocked: 'Block', in_progress: 'In Progress' };
  return `
    <div class="matrix-tc-row ${!t.applicable ? 'not-applicable' : ''}">
      <div class="matrix-tc-code">${escapeHtml(t.testCode)}</div>
      <div>
        <div class="matrix-tc-name">${escapeHtml(t.testName)}</div>
        <div class="matrix-tc-meta">
          ${escapeHtml(t.procedure)}
          ${t.lastUpdatedBy ? `· last updated by <b>${escapeHtml(t.lastUpdatedBy)}</b> ${dateAgo(t.lastUpdatedAt)}` : ''}
          ${!t.applicable && t.naReason ? `· <span style="color:var(--bad)">${escapeHtml(t.naReason)}</span>` : ''}
        </div>
      </div>
      <div class="matrix-tc-status-buttons">
        ${statuses.map(s => `
          <button class="tc-status-btn ${t.status === s ? 'active ' + s : ''}"
            onclick="setTestStatus('${t.id}', '${s}')"
            ${!t.applicable ? 'disabled' : ''}>${labels[s]}</button>
        `).join('')}
      </div>
      ${isAdmin ? `
        <button class="tc-na-toggle" onclick="toggleNA('${t.id}')">
          ${t.applicable ? 'Mark N/A' : 'N/A — restore'}
        </button>
      ` : ''}
    </div>
  `;
}

function updateMatrixFilter() {
  matrixFilter.location = document.getElementById('mx-loc').value;
  matrixFilter.subsystem = document.getElementById('mx-sub').value;
  matrixFilter.applicable = document.getElementById('mx-app').value;
  renderTestMatrix();
}

function setTestStatus(id, status) {
  const t = TEST_INSTANCES.find(x => x.id === id);
  if (!t) return;
  t.status = status;
  t.lastUpdatedBy = currentRoleUser.name;
  t.lastUpdatedAt = new Date().toISOString();
  logAudit('Test Status Update', `${t.testCode} @ ${t.location}`, `→ ${status}`);
  renderTestMatrix();
  toast(`${t.testCode} marked ${status}`, 'success');
}

function toggleNA(id) {
  const t = TEST_INSTANCES.find(x => x.id === id);
  if (!t) return;
  t.applicable = !t.applicable;
  if (!t.applicable) {
    const reason = prompt('Reason for marking N/A?');
    if (reason === null) { t.applicable = true; return; }
    t.naReason = reason;
    logAudit('Toggled N/A', `${t.testCode} @ ${t.location}`, 'Marked Not Applicable', reason);
  } else {
    t.naReason = '';
    logAudit('Toggled N/A', `${t.testCode} @ ${t.location}`, 'Restored as Applicable');
  }
  renderTestMatrix();
  toast(`${t.testCode} ${t.applicable ? 'restored as applicable' : 'marked N/A'}`, 'success');
}

// ==========================================================================
// FIELD INTAKE — 3 step workflow
// ==========================================================================
let intakeStep = 1;
let intakeAdditions = [];

function renderFieldIntake() {
  const root = document.getElementById('field-intake-content');
  if (!root || !currentRoleUser) return;
  if (!['field', 'admin'].includes(currentRoleUser.role)) {
    root.innerHTML = `<div class="docs-empty"><h3>Field & Admin only</h3></div>`;
    return;
  }

  // Get test cases the field user has toggled today
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayUpdates = TEST_INSTANCES.filter(t =>
    t.lastUpdatedBy === currentRoleUser.name &&
    t.lastUpdatedAt &&
    new Date(t.lastUpdatedAt) >= todayStart &&
    ['passed', 'failed', 'blocked', 'in_progress'].includes(t.status)
  );

  const allItems = [...todayUpdates, ...intakeAdditions];

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
    ${intakeStep === 1 ? renderIntakeStep1(allItems) :
      intakeStep === 2 ? renderIntakeStep2() :
      renderIntakeStep3(allItems)}
  `;
}

function renderIntakeStep1(items) {
  if (items.length === 0) {
    return `
      <div class="form-card">
        <h3 class="form-card-title">Step 1: Review Today's Tests</h3>
        <p class="form-card-sub">These are the test cases you toggled in the Test Matrix today.</p>
        <div class="intake-summary-empty">
          <h3 style="font-size: 16px; margin-bottom: 8px;">No tests logged today</h3>
          <p style="font-size: 13px;">Open the Test Matrix and toggle statuses on test cases as you work, or skip to Step 2 to add items manually.</p>
        </div>
        <div class="form-actions">
          <button class="form-secondary" onclick="showPage('test-matrix')">Open Test Matrix</button>
          <button class="form-submit" onclick="setIntakeStep(2)">Continue to Step 2 →</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="form-card">
      <h3 class="form-card-title">Step 1: Review Today's Tests</h3>
      <p class="form-card-sub">${items.length} test case${items.length > 1 ? 's' : ''} toggled today. Verify these are correct before submitting.</p>
      <div class="intake-summary-list">
        ${items.map(t => {
          const statusBg = t.status === 'passed' ? 'badge-passed' :
                           t.status === 'failed' ? 'badge-failed' :
                           t.status === 'blocked' ? 'badge-pending' : 'badge-progress';
          return `
            <div class="intake-summary-row">
              <span class="badge ${statusBg}">${t.status}</span>
              <div>
                <div style="font-weight: 600; font-size: 13px;">${escapeHtml(t.testCode)} · ${escapeHtml(t.testName)}</div>
                <div style="font-size: 11px; color: var(--gray-700); margin-top: 2px;">${escapeHtml(t.location)} · ${escapeHtml(t.subsystem)} · ${escapeHtml(t.templateName)}</div>
              </div>
              <div style="font-size: 11px; color: var(--gray-700);">${dateAgo(t.lastUpdatedAt)}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="form-actions">
        <button class="form-secondary" onclick="showPage('test-matrix')">↺ Edit in Test Matrix</button>
        <button class="form-submit" onclick="setIntakeStep(2)">Continue to Step 2 →</button>
      </div>
    </div>
  `;
}

function renderIntakeStep2() {
  return `
    <div class="form-card">
      <h3 class="form-card-title">Step 2: Add Missing Items</h3>
      <p class="form-card-sub">Add any test cases you completed today that aren't already in your list.</p>

      <div id="intake-additions" style="margin-bottom:16px;">
        ${intakeAdditions.length === 0 ?
          '<div class="form-hint">No additional items yet</div>' :
          intakeAdditions.map((a, i) => `
            <div class="intake-summary-row" style="background: var(--gray-50); border-radius: 8px; margin-bottom: 6px;">
              <span class="badge badge-${a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : a.status === 'blocked' ? 'pending' : 'progress'}">${a.status}</span>
              <div>
                <div style="font-weight: 600; font-size: 13px;">${escapeHtml(a.testCode)} · ${escapeHtml(a.testName)}</div>
                <div style="font-size: 11px; color: var(--gray-700); margin-top: 2px;">${escapeHtml(a.location)} · ${escapeHtml(a.subsystem)}</div>
              </div>
              <button class="logout-mini" onclick="removeIntakeAddition(${i})">Remove</button>
            </div>
          `).join('')
        }
      </div>

      <div class="form-grid">
        <div class="form-field">
          <label>Location</label>
          <select id="ai-location" class="form-input" onchange="filterAddTestcases()">
            <option value="">Select location...</option>
            ${[...new Set(TI.map(t => t.Location))].filter(Boolean).sort().map(l => `<option value="${l}">${l}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Test Case</label>
          <select id="ai-testid" class="form-input"></select>
        </div>
        <div class="form-field form-field-full">
          <label>Status</label>
          <div class="result-buttons">
            <button type="button" class="result-btn result-pass" data-value="passed" onclick="selectAddStatus(this, 'passed')">Pass</button>
            <button type="button" class="result-btn result-fail" data-value="failed" onclick="selectAddStatus(this, 'failed')">Fail</button>
            <button type="button" class="result-btn result-partial" data-value="blocked" onclick="selectAddStatus(this, 'blocked')">Blocked</button>
            <button type="button" class="result-btn result-blocked" data-value="in_progress" onclick="selectAddStatus(this, 'in_progress')">In Progress</button>
          </div>
        </div>
        <div class="form-field form-field-full" id="ai-blocked-block" style="display:none;">
          <label>Blocking Reason</label>
          <textarea id="ai-blocked-reason" class="form-input" rows="2" placeholder="Why is this blocked? Who can resolve?"></textarea>
        </div>
        <div class="form-field form-field-full" id="ai-failed-block" style="display:none;">
          <label>Failure Reason</label>
          <textarea id="ai-failed-reason" class="form-input" rows="2" placeholder="What went wrong?"></textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="form-secondary" onclick="setIntakeStep(1)">← Back</button>
        <button class="form-secondary" onclick="addIntakeAddition()">+ Add to Queue</button>
        <button class="form-submit" onclick="setIntakeStep(3)">Continue to Step 3 →</button>
      </div>
    </div>
  `;
}

function renderIntakeStep3(items) {
  return `
    <div class="form-card">
      <h3 class="form-card-title">Step 3: Submit Daily Log</h3>
      <p class="form-card-sub">Review the day's summary and submit. Punch list manager and project leadership will receive the daily report email.</p>

      <div class="form-grid">
        <div class="form-field form-field-full">
          <div class="counts-grid">
            <div class="count-tile good"><div class="count-label">Total</div><div class="count-value">${items.length}</div></div>
            <div class="count-tile good"><div class="count-label">Passed</div><div class="count-value">${items.filter(i => i.status === 'passed').length}</div></div>
            <div class="count-tile bad"><div class="count-label">Failed</div><div class="count-value">${items.filter(i => i.status === 'failed').length}</div></div>
            <div class="count-tile warn"><div class="count-label">Blocked</div><div class="count-value">${items.filter(i => i.status === 'blocked').length}</div></div>
            <div class="count-tile"><div class="count-label">In Progress</div><div class="count-value">${items.filter(i => i.status === 'in_progress').length}</div></div>
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
          <input type="number" id="i3-idle" class="form-input" value="0" min="0" step="0.5">
        </div>
        <div class="form-field">
          <label>Was there a delay?</label>
          <div class="delay-toggle">
            <button type="button" class="toggle-btn active" data-val="No" onclick="toggleDelayI3(this, false)">No</button>
            <button type="button" class="toggle-btn" data-val="Yes" onclick="toggleDelayI3(this, true)">Yes</button>
          </div>
        </div>

        <div class="form-field form-field-full">
          <label>Overall Day Notes</label>
          <textarea id="i3-notes" class="form-input" rows="3" placeholder="Summary of the day's work..."></textarea>
        </div>
        <div class="form-field form-field-full">
          <label>Plan for Next Day</label>
          <textarea id="i3-next" class="form-input" rows="2" placeholder="What's planned tomorrow?"></textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="form-secondary" onclick="setIntakeStep(2)">← Back</button>
        <button class="form-submit" onclick="submitIntakeFinal(${items.length})">Submit Daily Log + Send Report</button>
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

function addIntakeAddition() {
  const loc = document.getElementById('ai-location').value;
  const tid = document.getElementById('ai-testid').value;
  const status = document.querySelector('.result-btn.selected')?.dataset.value;
  if (!loc || !tid || !status) {
    toast('Please fill in location, test case, and status', 'warn');
    return;
  }
  const t = TI.find(x => x.TestID === tid);
  if (!t) return;
  intakeAdditions.push({
    id: t.TestID,
    testCode: t.TestCaseCode,
    testName: t.TestName,
    location: t.Location,
    subsystem: t.Subsystem,
    phase: t.Phase,
    activity: t.Activity,
    testProcedure: t.TestProcedure,
    templateName: t.Activity || '',
    applicable: true,
    _isRealItem: true,
    status,
    blockedReason: document.getElementById('ai-blocked-reason').value,
    failedReason: document.getElementById('ai-failed-reason').value,
  });
  toast('Added to queue', 'success');
  renderFieldIntake();
}

function removeIntakeAddition(i) {
  intakeAdditions.splice(i, 1);
  renderFieldIntake();
}

function toggleDelayI3(btn, isYes) {
  document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function submitIntakeFinal(count) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayUpdates = TEST_INSTANCES.filter(t =>
    t.lastUpdatedBy === currentRoleUser.name &&
    t.lastUpdatedAt && new Date(t.lastUpdatedAt) >= todayStart &&
    ['passed', 'failed', 'blocked', 'in_progress'].includes(t.status)
  );
  const allItems = [...todayUpdates, ...intakeAdditions];

  const dateVal       = document.getElementById('i3-date')?.value || new Date().toISOString().split('T')[0];
  const testers       = parseInt(document.getElementById('i3-testers')?.value) || 1;
  const idleHours     = parseFloat(document.getElementById('i3-idle')?.value) || 0;
  const delayOccurred = document.querySelector('.toggle-btn.active')?.dataset.val || 'No';
  const overallNotes  = document.getElementById('i3-notes')?.value || '';
  const nextDayPlan   = document.getElementById('i3-next')?.value || '';

  const resultMap = { passed: 'Pass', failed: 'Fail', blocked: 'Blocked', in_progress: 'Partial' };

  const resultRows = allItems.map((item, idx) => ({
    result_id:         'R-' + Date.now() + '-' + idx,
    test_id:           item._isRealItem ? item.id : null,
    test_name:         item.testName || null,
    phase:             item.phase || null,
    location:          item.location || null,
    subsystem:         item.subsystem || null,
    activity:          item.activity || null,
    test_case_code:    item.testCode || null,
    test_procedure:    item.testProcedure || item.procedure || null,
    result:            resultMap[item.status] || 'Partial',
    completed_by:      currentRoleUser.name,
    date_tested:       dateVal,
    submitted_by:      currentRoleUser.name,
    number_of_testers: testers,
    failed_reason:     item.failedReason || null,
    blocked_reason:    item.blockedReason || null,
    notes:             item.notes || null,
    new_status:        item.status,
  }));

  const logRow = {
    log_id:             'DL-' + Date.now(),
    log_date:           dateVal,
    location:           allItems[0]?.location || null,
    subsystem:          allItems[0]?.subsystem || null,
    submitted_by:       currentRoleUser.name,
    number_of_testers:  testers,
    idle_hours:         idleHours,
    total_tests_logged: allItems.length,
    total_passed:       allItems.filter(i => i.status === 'passed').length,
    total_failed:       allItems.filter(i => i.status === 'failed').length,
    total_partial:      allItems.filter(i => i.status === 'in_progress').length,
    total_blocked:      allItems.filter(i => i.status === 'blocked').length,
    delay_occurred:     delayOccurred,
    overall_notes:      overallNotes,
    next_day_plan:      nextDayPlan,
  };

  try {
    if (resultRows.length > 0) {
      const { error: rErr } = await _sb.from('test_results').insert(resultRows);
      if (rErr) throw rErr;
    }
    const { error: lErr } = await _sb.from('delay_log').insert([logRow]);
    if (lErr) throw lErr;

    intakeAdditions.forEach(a => {
      const t = TEST_INSTANCES.find(x => x.id === a.id);
      if (t) { t.status = a.status; t.blockedReason = a.blockedReason; t.failedReason = a.failedReason; t.lastUpdatedBy = currentRoleUser.name; t.lastUpdatedAt = new Date().toISOString(); }
    });
    logAudit('Field Intake Submitted', `${count} test cases logged`, 'Daily report generated');
    intakeAdditions = [];
    intakeStep = 1;
    toast(`Daily log submitted! ${count} tests logged.`, 'success');
  } catch (err) {
    console.error('Supabase submit error:', err);
    toast(`Submit failed: ${err.message}`, 'error');
  }
  renderFieldIntake();
  renderTestMatrix();
}

// ==========================================================================
// PUNCH WORKFLOW — Kanban + Detail
// ==========================================================================
function renderPunchWorkflow() {
  const root = document.getElementById('punch-workflow-content');
  if (!root || !currentRoleUser) return;

  // Filter punches by role
  let visible = PUNCH_ITEMS;
  if (currentRoleUser.role === 'technician') {
    visible = PUNCH_ITEMS.filter(p => p.assignedToTechnician === currentRoleUser.name || p.status === 'open');
  } else if (currentRoleUser.role === 'client') {
    visible = PUNCH_ITEMS.filter(p => p.status === 'client_approval_pending' || (p.status === 'closed' && p.client_approved));
  }

  // Update title/subtitle by role
  document.getElementById('pw-title').textContent =
    currentRoleUser.role === 'client' ? 'Punch List — Client Approvals' :
    currentRoleUser.role === 'technician' ? 'My Assigned Punch Items' :
    'Punch List Management';

  // Group by status
  const cols = {
    open: visible.filter(p => p.status === 'open' || (p.status === 'in_progress' && currentRoleUser.role === 'punch_manager')),
    in_progress: visible.filter(p => p.status === 'in_progress'),
    ready_for_signoff: visible.filter(p => p.status === 'ready_for_signoff'),
    client_approval_pending: visible.filter(p => p.status === 'client_approval_pending'),
    closed: visible.filter(p => p.status === 'closed').slice(0, 5),
  };

  const showCreateBtn = ['admin', 'field', 'punch_manager'].includes(currentRoleUser.role);

  root.innerHTML = `
    ${showCreateBtn ? `
      <div class="admin-section-head" style="margin-bottom:16px;">
        <div></div>
        <button class="admin-action-btn" onclick="openNewPunchModal()">+ Create Punch Item</button>
      </div>
    ` : ''}

    <div class="punch-board">
      ${[
        ['Open / Assignable', 'open'],
        ['In Progress', 'in_progress'],
        ['Ready for Sign-off', 'ready_for_signoff'],
        ['Client Approval', 'client_approval_pending'],
      ].map(([title, key]) => `
        <div class="punch-column">
          <div class="punch-column-head">
            <div class="punch-column-title">${title}</div>
            <div class="punch-column-count">${cols[key].length}</div>
          </div>
          ${cols[key].length === 0 ?
            '<div style="font-size:12px;color:var(--gray-500);text-align:center;padding:20px 0;">No items</div>' :
            cols[key].map(p => renderPunchCard(p)).join('')
          }
        </div>
      `).join('')}
    </div>

    ${cols.closed.length > 0 ? `
      <div class="admin-section" style="margin-top: 32px;">
        <div class="admin-section-title" style="margin-bottom: 12px;">Recently Closed</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
          ${cols.closed.map(p => renderPunchCard(p)).join('')}
        </div>
      </div>
    ` : ''}
  `;
}

function renderPunchCard(p) {
  const sub = p.assignedToTechnician ? `→ ${p.assignedToTechnician}` : 'unassigned';
  return `
    <div class="punch-card priority-${p.priority}" onclick="openPunchDetail('${p.id}')">
      <div class="punch-card-num">#${p.number} · ${escapeHtml(p.subsystem)}</div>
      <div class="punch-card-title">${escapeHtml(p.title)}</div>
      <div class="punch-card-meta">
        <span>${escapeHtml(p.location)}</span>
        <span>· ${sub}</span>
      </div>
    </div>
  `;
}

function openPunchDetail(id) {
  const p = PUNCH_ITEMS.find(x => x.id === id);
  if (!p) return;

  const role = currentRoleUser.role;
  const canAssignTech = role === 'punch_manager' || role === 'admin';
  const canMarkInProgress = (role === 'technician' && p.assignedToTechnician === currentRoleUser.name);
  const canSubmitSignoff = canMarkInProgress && p.status === 'in_progress';
  const canApprovePM = (role === 'punch_manager' || role === 'admin') && p.status === 'ready_for_signoff';
  const canApproveClient = role === 'client' && p.status === 'client_approval_pending';

  modal({
    title: `Punch #${p.number} · ${escapeHtml(p.title)}`,
    sub: `${escapeHtml(p.location)} · ${escapeHtml(p.subsystem)} · ${escapeHtml(p.priority)} priority`,
    size: 'large',
    body: `
      <div class="punch-detail-section">
        <h4>Description</h4>
        <p style="font-size: 14px; color: var(--gray-800); line-height: 1.6;">${escapeHtml(p.description)}</p>
      </div>

      <div class="punch-detail-section">
        <h4>Details</h4>
        <div class="punch-detail-meta">
          <div class="punch-detail-meta-item">
            <div class="label">Status</div>
            <div class="value">${getStatusBadge(p.status.replace(/_/g, ' '))}</div>
          </div>
          <div class="punch-detail-meta-item">
            <div class="label">Created By</div>
            <div class="value">${escapeHtml(p.createdBy)}</div>
          </div>
          <div class="punch-detail-meta-item">
            <div class="label">Assigned To (Tech)</div>
            <div class="value">${p.assignedToTechnician ? escapeHtml(p.assignedToTechnician) : '<span style="color:var(--gray-500)">Unassigned</span>'}</div>
          </div>
          <div class="punch-detail-meta-item">
            <div class="label">Type</div>
            <div class="value">${escapeHtml(p.type)} · ${escapeHtml(p.trade)}</div>
          </div>
        </div>
      </div>

      <div class="punch-detail-section">
        <h4>Photos — Before</h4>
        <div class="photo-grid">
          ${p.photos_before.length === 0 ?
            '<div class="photo-thumb placeholder">No before photos</div>' :
            p.photos_before.map(ph => `<div class="photo-thumb"><img src="${ph}" onclick="viewPhoto('${ph}')"></div>`).join('')
          }
          ${canMarkInProgress ? `
            <label class="photo-upload-btn">
              <span class="plus">+</span>
              <span>Add Before</span>
              <input type="file" accept="image/*" multiple style="display:none" onchange="addPhoto(event, '${p.id}', 'before')">
            </label>
          ` : ''}
        </div>
      </div>

      <div class="punch-detail-section">
        <h4>Photos — After</h4>
        <div class="photo-grid">
          ${p.photos_after.length === 0 ?
            '<div class="photo-thumb placeholder">No after photos</div>' :
            p.photos_after.map(ph => `<div class="photo-thumb"><img src="${ph}" onclick="viewPhoto('${ph}')"></div>`).join('')
          }
          ${canMarkInProgress ? `
            <label class="photo-upload-btn">
              <span class="plus">+</span>
              <span>Add After</span>
              <input type="file" accept="image/*" multiple style="display:none" onchange="addPhoto(event, '${p.id}', 'after')">
            </label>
          ` : ''}
        </div>
      </div>

      ${p.closure_notes || canSubmitSignoff ? `
        <div class="punch-detail-section">
          <h4>Closure Notes</h4>
          ${canSubmitSignoff ? `
            <textarea id="punch-closure-notes" class="form-input" rows="3" placeholder="Describe the work completed...">${escapeHtml(p.closure_notes)}</textarea>
          ` : `
            <p style="font-size: 14px; color: var(--gray-800); line-height: 1.6;">${escapeHtml(p.closure_notes || '—')}</p>
          `}
        </div>
      ` : ''}

      ${canApproveClient ? `
        <div class="punch-detail-section">
          <h4>Closure Submitted by Technician</h4>
          <p style="font-size: 14px; color: var(--gray-800); line-height: 1.6; padding: 12px; background: var(--gray-50); border-radius: 8px;">${escapeHtml(p.closure_notes)}</p>
          <h4 style="margin-top: 16px;">Your Approval Notes (Optional)</h4>
          <textarea id="client-approval-notes" class="form-input" rows="2" placeholder="Any observations..."></textarea>
        </div>
      ` : ''}

      <div class="punch-detail-section">
        <h4>History</h4>
        <div class="history-timeline">
          ${p.history.map(h => `
            <div class="history-item">
              <div class="history-action">${escapeHtml(h.action)}</div>
              <div class="history-meta">${escapeHtml(h.by)} · ${dateAgo(h.at)}</div>
              ${h.note ? `<div class="history-note">"${escapeHtml(h.note)}"</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `,
    footer: `
      <button class="admin-action-btn-secondary" onclick="closeModal()">Close</button>
      ${canAssignTech && !p.assignedToTechnician ? `<button class="admin-action-btn" onclick="assignTechnician('${p.id}')">Assign Technician</button>` : ''}
      ${canMarkInProgress && p.status === 'open' ? `<button class="admin-action-btn" onclick="punchAction('${p.id}', 'start')">Start Work</button>` : ''}
      ${canSubmitSignoff ? `<button class="admin-action-btn" onclick="punchAction('${p.id}', 'submit_signoff')">Submit for Sign-off</button>` : ''}
      ${canApprovePM ? `<button class="admin-action-btn" onclick="punchAction('${p.id}', 'pm_approve')">Approve & Send to Client</button>` : ''}
      ${canApproveClient ? `<button class="admin-action-btn" onclick="punchAction('${p.id}', 'client_approve')">Approve & Close</button>` : ''}
    `,
  });
}

function assignTechnician(id) {
  const techs = USERS_V2.filter(u => u.role === 'technician');
  const choices = techs.map((t, i) => `${i+1}. ${t.name}`).join('\n');
  const which = prompt(`Assign to which technician?\n\n${choices}\n\nEnter number:`);
  const tech = techs[parseInt(which) - 1];
  if (!tech) return;
  const p = PUNCH_ITEMS.find(x => x.id === id);
  p.assignedToTechnician = tech.name;
  p.history.push({
    action: 'Assigned to Technician',
    by: currentRoleUser.name,
    at: new Date().toISOString(),
    note: '',
  });
  logAudit('Punch Assigned', `Punch #${p.number}`, `→ ${tech.name}`);
  closeModal();
  renderPunchWorkflow();
  toast(`Assigned to ${tech.name}`, 'success');
}

function punchAction(id, action) {
  const p = PUNCH_ITEMS.find(x => x.id === id);
  if (!p) return;
  const now = new Date().toISOString();
  if (action === 'start') {
    p.status = 'in_progress';
    p.history.push({ action: 'Status: In Progress', by: currentRoleUser.name, at: now, note: '' });
  } else if (action === 'submit_signoff') {
    const notes = document.getElementById('punch-closure-notes')?.value || '';
    if (!notes.trim()) { toast('Please add closure notes', 'warn'); return; }
    p.status = 'ready_for_signoff';
    p.closure_notes = notes;
    p.history.push({ action: 'Status: Ready for Sign-off', by: currentRoleUser.name, at: now, note: 'Awaiting punch manager review' });
  } else if (action === 'pm_approve') {
    p.status = 'client_approval_pending';
    p.history.push({ action: 'Approved by Punch Manager', by: currentRoleUser.name, at: now, note: '' });
    p.history.push({ action: 'Sent to Client for Approval', by: currentRoleUser.name, at: now, note: '' });
  } else if (action === 'client_approve') {
    const notes = document.getElementById('client-approval-notes')?.value || '';
    p.status = 'closed';
    p.client_approved = true;
    p.client_approval_notes = notes;
    p.history.push({ action: 'Approved by Client', by: currentRoleUser.name, at: now, note: notes });
    p.history.push({ action: 'Closed', by: 'System', at: now, note: '' });
  }
  logAudit('Punch ' + action, `Punch #${p.number}`, `Status → ${p.status}`);
  closeModal();
  renderPunchWorkflow();
  toast(`Punch #${p.number} updated`, 'success');
}

function addPhoto(event, punchId, type) {
  const p = PUNCH_ITEMS.find(x => x.id === punchId);
  const files = event.target.files;
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = e => {
      if (type === 'before') p.photos_before.push(e.target.result);
      else p.photos_after.push(e.target.result);
      logAudit('Photo Uploaded', `Punch #${p.number}`, `${type} photo added`);
      // Refresh modal
      closeModal();
      openPunchDetail(punchId);
    };
    reader.readAsDataURL(file);
  }
  toast(`${files.length} photo${files.length > 1 ? 's' : ''} added`, 'success');
}

function viewPhoto(src) {
  modal({
    title: 'Photo',
    body: `<img src="${src}" style="width:100%;border-radius:8px;">`,
    footer: `<button class="admin-action-btn" onclick="closeModal()">Close</button>`,
  });
}

function openNewPunchModal() {
  modal({
    title: 'New Punch List Item',
    sub: 'Create a new issue, defect, or work item',
    body: `
      <div class="form-grid">
        <div class="form-field form-field-full">
          <label>Title</label>
          <input type="text" id="np-title" class="form-input" placeholder="Short description of the issue">
        </div>
        <div class="form-field">
          <label>Subsystem</label>
          <select id="np-subsystem" class="form-input">
            <option>DCS</option><option>ATS</option><option>IXL</option>
            <option>CORE CBTC</option><option>PS&TP</option><option>IAMS</option>
            <option>SCADA</option><option>CYBER</option><option>TCH</option><option>OTHER</option>
          </select>
        </div>
        <div class="form-field">
          <label>Location</label>
          <select id="np-location" class="form-input">
            ${LOCATIONS.map(l => `<option value="${l.name}">${escapeHtml(l.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Priority</label>
          <select id="np-priority" class="form-input">
            <option value="high">High</option>
            <option value="medium" selected>Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div class="form-field">
          <label>Type</label>
          <select id="np-type" class="form-input">
            <option>SAT</option><option>FAT</option><option>SW FAT</option>
            <option>PICO</option><option>Construction</option><option>Other</option>
          </select>
        </div>
        <div class="form-field form-field-full">
          <label>Description</label>
          <textarea id="np-desc" class="form-input" rows="4" placeholder="Detailed description of the issue..."></textarea>
        </div>
      </div>
    `,
    footer: `
      <button class="admin-action-btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="admin-action-btn" onclick="saveNewPunch()">Create Punch Item</button>
    `,
  });
}

function saveNewPunch() {
  const title = document.getElementById('np-title').value.trim();
  const desc = document.getElementById('np-desc').value.trim();
  if (!title) { toast('Title is required', 'warn'); return; }

  const number = Math.max(0, ...PUNCH_ITEMS.map(p => p.number)) + 1;
  const newPunch = {
    id: 'punch-' + Date.now(),
    number,
    title,
    description: desc,
    subsystem: document.getElementById('np-subsystem').value,
    location: document.getElementById('np-location').value,
    priority: document.getElementById('np-priority').value,
    type: document.getElementById('np-type').value,
    trade: document.getElementById('np-subsystem').value,
    createdBy: currentRoleUser.name,
    createdAt: new Date().toISOString(),
    assignedTo: 'Mustafa Isik',
    assignedToTechnician: null,
    status: 'open',
    photos_before: [],
    photos_after: [],
    closure_notes: '',
    client_approved: false,
    client_approval_notes: '',
    history: [
      { action: 'Created', by: currentRoleUser.name, at: new Date().toISOString(), note: '' },
      { action: 'Assigned to Punch Manager', by: 'System', at: new Date().toISOString(), note: 'Auto-routed to Mustafa Isik' },
    ],
  };
  PUNCH_ITEMS.unshift(newPunch);
  logAudit('Punch Created', `Punch #${number}`, escapeHtml(title));
  closeModal();
  renderPunchWorkflow();
  toast(`Punch #${number} created and assigned to Mustafa Isik`, 'success');
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
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
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

// ==========================================================================
// INIT V2
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // V2 login replaces V1
  setTimeout(() => initLoginV2(), 100);
});
