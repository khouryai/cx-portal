// ==========================================
// HITACHI Rail T&C Portal - App Logic
// ==========================================

const DATA = window.PORTAL_DATA;
const AP = DATA.actionPlans;
const LI = DATA.lineItems;
const PL = DATA.punchList;
const ORG = DATA.org;

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
document.addEventListener('DOMContentLoaded', () => {
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

const TI = DATA.testItems || [];
const FIELD_USERS = DATA.fieldUsers || [];

// SharePoint config
const SP_SITE = 'https://hitachigroupeur.sharepoint.com/sites/BARTCBTCCommissioningTeam';
const SP_RESULTS_LIST = 'PortalTestResults';
const SP_DELAY_LIST = 'PortalDelayLog';

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

function sendSubmission(payload, messageId, onSuccess) {
  // Add to local queue first (offline safety net)
  const queue = loadQueue();
  const queueEntry = {
    id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  queue.push(queueEntry);
  saveQueue(queue);

  showMessage(messageId, 'queued', 'Submitting...');

  // Build SharePoint list item from payload
  const isResult = payload.type === 'TestResult';
  const listName = isResult ? SP_RESULTS_LIST : SP_DELAY_LIST;
  const r = payload.record;
  const su = payload.statusUpdate || {};

  const spItem = isResult ? {
    ResultID: r.ResultID || '',
    TestID: r.TestID || '',
    TestName: r.TestName || '',
    AttemptNumber: r.AttemptNumber || 1,
    Phase: r.Phase || '',
    Location: r.Location || '',
    Subsystem: r.Subsystem || '',
    Activity: r.Activity || '',
    TestCaseCode: r.TestCaseCode || '',
    TestProcedure: r.TestProcedure || '',
    Result: r.Result || '',
    Team: r.Team || '',
    CompletedBy: r.CompletedBy || '',
    DateTested: r.DateTested || '',
    NumberOfTesters: r.NumberOfTesters || 1,
    TestHours: r.TestHours || 0,
    FailedReason: r.FailedReason || '',
    BlockedReason: r.BlockedReason || '',
    Notes: r.Notes || '',
    NewStatus: su.NewStatus || '',
    CompletedDate: su.CompletedDate || '',
    Title: r.ResultID || 'Result',
  } : {
    LogID: r.LogID || '',
    LogDate: r.LogDate || '',
    Location: r.Location || '',
    Subsystem: r.Subsystem || '',
    SubmittedBy: r.SubmittedBy || '',
    NumberOfTesters: r.NumberOfTesters || 1,
    IdleHours: r.IdleHours || 0,
    TotalTestsLogged: r.TotalTestsLogged || 0,
    TotalPassed: r.TotalPassed || 0,
    TotalFailed: r.TotalFailed || 0,
    TotalPartial: r.TotalPartial || 0,
    TotalBlocked: r.TotalBlocked || 0,
    DelayOccurred: r.DelayOccurred || 'No',
    DelayCategory: r.DelayCategory || '',
    DelayDuration: r.DelayDuration || 0,
    DelayNotes: r.DelayNotes || '',
    OverallNotes: r.OverallNotes || '',
    NextDayPlan: r.NextDayPlan || '',
    Title: r.LogID || 'Log',
  };

  const endpoint = `${SP_SITE}/_api/web/lists/getbytitle('${listName}')/items`;

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=nometadata',
      'X-RequestDigest': 'needed',
    },
    credentials: 'include',
    body: JSON.stringify(spItem),
  })
  .then(async res => {
    // SharePoint REST needs a request digest for POST
    // If we get 403, fetch the digest first then retry
    if (res.status === 403) {
      return getDigestAndRetry(endpoint, spItem, listName);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  })
  .then(() => {
    queueEntry.status = 'sent';
    queueEntry.sentAt = new Date().toISOString();
    saveQueue(loadQueue().map(q => q.id === queueEntry.id ? queueEntry : q));
    showMessage(messageId, 'success', '✓ Submitted to SharePoint successfully!');
    if (onSuccess) onSuccess();
  })
  .catch(err => {
    queueEntry.status = 'failed';
    queueEntry.error = err.message;
    saveQueue(loadQueue().map(q => q.id === queueEntry.id ? queueEntry : q));
    showMessage(messageId, 'queued',
      `⚠ Saved locally — not yet synced. ${err.message.includes('digest') || err.message.includes('403')
        ? 'Make sure you are signed into SharePoint in this browser.'
        : 'Check your network connection.'} View in My Submissions.`);
    if (onSuccess) onSuccess();
  });
}

async function getDigestAndRetry(endpoint, spItem, listName) {
  // Fetch the SharePoint request digest (required for POST)
  const digestRes = await fetch(`${SP_SITE}/_api/contextinfo`, {
    method: 'POST',
    headers: { 'Accept': 'application/json;odata=nometadata' },
    credentials: 'include',
  });
  if (!digestRes.ok) throw new Error('Could not get SharePoint digest. Are you signed into SharePoint?');
  const digestData = await digestRes.json();
  const digest = digestData.FormDigestValue;

  const retryRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json;odata=nometadata',
      'Content-Type': 'application/json;odata=nometadata',
      'X-RequestDigest': digest,
    },
    credentials: 'include',
    body: JSON.stringify(spItem),
  });

  if (!retryRes.ok) {
    const text = await retryRes.text();
    throw new Error(`SharePoint error ${retryRes.status}: ${text.slice(0, 300)}`);
  }
  return retryRes.json();
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
  initField();
});
