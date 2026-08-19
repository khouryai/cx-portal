// ==========================================
// Construction Planner — plan & forecast view (cxc-ui-plan.js)
//
// The report side: what the current scope costs in crew-hours, how many access
// windows of each type it needs and when, what material it draws, and what did
// not fit. Reads the packed result; never computes schedule maths itself —
// that all lives in cxc-model.js.
// ==========================================
(function () {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function hrs(min) { return (min / 60).toFixed(1); }
  function monthKey(date) { return String(date).slice(0, 7); }
  function monthLabel(key) {
    var p = key.split('-');
    return MONTHS[(+p[1]) - 1] + ' ' + p[0];
  }

  function kpi(val, label, raw) {
    return '<div class="cxc-kpi"><div class="cxc-kpi-val">' + (raw ? val : escapeHtml(val)) +
      '</div><div class="cxc-kpi-lbl">' + escapeHtml(label) + '</div></div>';
  }

  function render(data, result) {
    if (!result) return '<div class="cxc-empty">Nothing scheduled yet.</div>';
    var s = result.summary;
    var worked = result.windows.filter(function (w) { return w.used > 0; });

    // ── Plan range + which windows are on the table ────────────────────────
    var plan = data.plan || {};
    var chosen = plan.patternIds;
    var patternPicker = (data.shiftPatterns || []).map(function (p) {
      var on = !chosen || chosen.indexOf(p.id) !== -1;
      return '<label class="cxc-field" style="flex-direction:row;align-items:center;gap:6px">' +
        '<input type="checkbox" ' + (on ? 'checked' : '') + ' ' +
        cxOn('change', 'cxcTogglePattern', p.id, '$cx.checked') + '>' +
        '<span style="color:var(--text)">' + escapeHtml(p.name) + '</span></label>';
    }).join('');

    var controls =
      '<div class="cxc-card"><div class="cxc-card-head"><div>' +
        '<h3>Plan window</h3><p class="cxc-hint">The date range the planner may schedule into, and ' +
        'which access agreements are available. Turn one off to see what the plan costs without it.</p>' +
      '</div></div><div class="cxc-controls">' +
        '<label class="cxc-field"><span>From</span><input type="date" class="cxc-inp" value="' +
          escapeHtml(plan.from || '') + '" ' + cxOn('change', 'cxcPlanRange', 'from', '$cx.value') + '></label>' +
        '<label class="cxc-field"><span>To</span><input type="date" class="cxc-inp" value="' +
          escapeHtml(plan.to || '') + '" ' + cxOn('change', 'cxcPlanRange', 'to', '$cx.value') + '></label>' +
        '<div class="cxc-field"><span>Available windows</span><div class="cxc-controls">' + patternPicker + '</div></div>' +
      '</div></div>';

    // ── KPIs ───────────────────────────────────────────────────────────────
    var byKind = {};
    worked.forEach(function (w) {
      var p = CXC.byId(data.shiftPatterns, w.patternId);
      var k = (p && p.name) || w.patternId;
      byKind[k] = (byKind[k] || 0) + 1;
    });
    var kindList = Object.keys(byKind).map(function (k) {
      return escapeHtml(byKind[k] + ' × ' + k);
    }).join('<br>') || '—';

    var usedCap = worked.reduce(function (t, w) { return t + w.capacity; }, 0);
    var shortfalls = result.materials.filter(function (m) { return m.shortfall > 0; });

    var kpis = '<div class="cxc-kpis">' +
      kpi(hrs(s.scheduledMinutes), 'Crew-hours of work') +
      kpi(s.windowsUsed, 'Access windows needed') +
      kpi('<div class="cxc-kpi-list">' + kindList + '</div>', 'By window type', true) +
      kpi(s.lastWorkedDate || '—', 'Forecast finish') +
      kpi(s.completeCount + ' <small>/ ' + s.itemCount + '</small>', 'Scope complete', true) +
      kpi(usedCap ? Math.round((s.scheduledMinutes / usedCap) * 100) + '%' : '0%', 'Utilization of worked windows') +
      '</div>';

    // ── Access forecast by month ───────────────────────────────────────────
    var patterns = (data.shiftPatterns || []);
    var months = {};
    worked.forEach(function (w) {
      var m = monthKey(w.date);
      var row = months[m] || (months[m] = { total: 0, hours: 0 });
      row[w.patternId] = (row[w.patternId] || 0) + 1;
      row.total++;
      row.hours += w.used / 60;
    });
    var monthKeys = Object.keys(months).sort();

    var forecast = '<div class="cxc-card"><div class="cxc-card-head"><div>' +
      '<h3>Access forecast</h3><p class="cxc-hint">Windows this scope needs, by month and type. ' +
      'This is the number to take into an access negotiation.</p></div></div>' +
      (monthKeys.length
        ? '<div class="cxc-scroll"><table class="cxc-table"><thead><tr><th>Month</th>' +
          patterns.map(function (p) { return '<th class="cxc-num">' + escapeHtml(p.name) + '</th>'; }).join('') +
          '<th class="cxc-num">Total</th><th class="cxc-num">Crew-hours</th></tr></thead><tbody>' +
          monthKeys.map(function (m) {
            var row = months[m];
            return '<tr><td><b>' + escapeHtml(monthLabel(m)) + '</b></td>' +
              patterns.map(function (p) {
                return '<td class="cxc-num">' + (row[p.id] || '<span style="color:var(--text-subtle)">—</span>') + '</td>';
              }).join('') +
              '<td class="cxc-num"><b>' + row.total + '</b></td>' +
              '<td class="cxc-num">' + row.hours.toFixed(1) + '</td></tr>';
          }).join('') +
          '<tr><td><b>Total</b></td>' +
          patterns.map(function (p) {
            var t = monthKeys.reduce(function (sum, m) { return sum + (months[m][p.id] || 0); }, 0);
            return '<td class="cxc-num"><b>' + (t || '—') + '</b></td>';
          }).join('') +
          '<td class="cxc-num"><b>' + s.windowsUsed + '</b></td>' +
          '<td class="cxc-num"><b>' + hrs(s.scheduledMinutes) + '</b></td></tr>' +
          '</tbody></table></div>'
        : '<div class="cxc-empty">No windows were used — check the date range and the scope.</div>') +
      '</div>';

    // ── Material take-off ──────────────────────────────────────────────────
    var drawn = result.materials.filter(function (m) { return m.required > 0; });
    var materials = '<div class="cxc-card"><div class="cxc-card-head"><div>' +
      '<h3>Material take-off</h3><p class="cxc-hint">What this plan consumes, against what the ' +
      'material list says is on hand. A shortfall means the schedule above assumes material you ' +
      'do not have.</p></div></div>' +
      (drawn.length
        ? '<div class="cxc-scroll"><table class="cxc-table"><thead><tr><th>Code</th><th>Material</th>' +
          '<th class="cxc-num">Required</th><th class="cxc-num">On hand</th><th>On site from</th>' +
          '<th>Status</th></tr></thead><tbody>' +
          drawn.map(function (m) {
            var status = m.shortfall > 0
              ? '<span class="cxc-tag cxc-bad">short ' + m.shortfall + ' ' + escapeHtml(m.unit || '') + '</span>'
              : (m.onHand > 0
                  ? '<span class="cxc-tag cxc-ok">covered</span>'
                  : '<span class="cxc-tag cxc-mute">not tracked</span>');
            return '<tr><td class="cxc-mono">' + escapeHtml(m.code || '') + '</td>' +
              '<td>' + escapeHtml(m.name) + '</td>' +
              '<td class="cxc-num">' + m.required + ' ' + escapeHtml(m.unit || '') + '</td>' +
              '<td class="cxc-num">' + (m.onHand || '—') + '</td>' +
              '<td>' + escapeHtml(m.availableFrom || '—') + '</td>' +
              '<td>' + status + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="cxc-empty">No activity in the plan draws material yet.</div>') +
      '</div>';

    // ── Window utilization ─────────────────────────────────────────────────
    var util = '<div class="cxc-card"><div class="cxc-card-head"><div>' +
      '<h3>Window utilization</h3><p class="cxc-hint">Gross window time is not work time: ' +
      'mobilization in/out, breaks and contingency come off the top before anything gets installed.' +
      '</p></div></div>' +
      (worked.length
        ? '<div class="cxc-scroll" style="max-height:420px"><table class="cxc-table"><thead><tr>' +
          '<th>Date</th><th>Window</th><th class="cxc-num">Gross h</th><th class="cxc-num">Mob h</th>' +
          '<th class="cxc-num">Productive h</th><th class="cxc-num">Crews</th><th class="cxc-num">Used h</th>' +
          '<th>Utilization</th><th class="cxc-num">%</th></tr></thead><tbody>' +
          worked.map(function (w) {
            var pct = w.utilization;
            return '<tr><td>' + escapeHtml(w.date) + '</td><td>' + escapeHtml(w.name) + '</td>' +
              '<td class="cxc-num">' + hrs(w.gross) + '</td>' +
              '<td class="cxc-num">' + hrs(w.mobilize) + '</td>' +
              '<td class="cxc-num">' + hrs(w.productive) + '</td>' +
              '<td class="cxc-num">' + w.crewCount + '</td>' +
              '<td class="cxc-num">' + hrs(w.used) + '</td>' +
              '<td><div class="cxc-bar' + (pct < 60 ? ' cxc-low' : '') + '" role="img" aria-label="' +
                pct + ' percent utilized"><span style="width:' + Math.min(100, pct) + '%"></span></div></td>' +
              '<td class="cxc-num">' + pct + '%</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="cxc-empty">No windows were worked.</div>') +
      '</div>';

    // ── Not scheduled ──────────────────────────────────────────────────────
    var unplaced = '<div class="cxc-card"><div class="cxc-card-head"><div>' +
      '<h3>Not scheduled</h3><p class="cxc-hint">Every item that did not fit, and why. ' +
      'Work is never dropped silently.</p></div></div>' +
      (result.unplaced.length
        ? '<div class="cxc-scroll"><table class="cxc-table"><thead><tr><th>Item</th><th>Location</th>' +
          '<th>Activity</th><th class="cxc-num">Qty left</th><th>Reason</th></tr></thead><tbody>' +
          result.unplaced.map(function (u) {
            return '<tr><td class="cxc-mono">' + escapeHtml(u.itemId) + '</td>' +
              '<td>' + escapeHtml(CXCData.labelFor(data, 'locations', u.locationId)) + '</td>' +
              '<td>' + escapeHtml(CXCData.labelFor(data, 'activityTypes', u.activityTypeId)) + '</td>' +
              '<td class="cxc-num">' + u.remainingQty + '</td>' +
              '<td><span class="cxc-tag cxc-bad">' + escapeHtml(u.reason) + '</span></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="cxc-empty"><strong>Everything fits.</strong>' +
          'The whole scope lands inside the plan window.</div>') +
      '</div>';

    var warn = shortfalls.length
      ? '<div class="cxc-card"><div class="cxc-problems">' + shortfalls.map(function (m) {
          return '<div class="cxc-problem">' + icon('alert') + '<code>' + escapeHtml(m.code || m.materialId) +
            '</code><span>plan needs ' + m.required + ' ' + escapeHtml(m.unit || '') + ' but only ' +
            m.onHand + ' is on hand — short ' + m.shortfall + '</span></div>';
        }).join('') + '</div></div>'
      : '';

    return controls + kpis + warn + forecast + materials + util + unplaced;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function setRange(which, value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return;
    CXCApp.data().plan[which] = value;
    CXCApp.save();
  }

  function togglePattern(patternId, on) {
    var d = CXCApp.data();
    var all = (d.shiftPatterns || []).map(function (p) { return p.id; });
    var cur = d.plan.patternIds || all.slice();
    var i = cur.indexOf(patternId);
    if (on && i === -1) cur.push(patternId);
    if (!on && i !== -1) cur.splice(i, 1);
    d.plan.patternIds = cur.length === all.length ? null : cur;
    CXCApp.save();
  }

  function install() {
    CXCApp.registerView('plan', {
      title: 'Plan & forecast',
      subtitle: 'Crew-hours, access windows needed, material take-off',
      icon: 'target',
      group: 'Plan',
      render: render
    });
    CXActions
      .register('cxcPlanRange', setRange)
      .register('cxcTogglePattern', togglePattern);
  }

  if (typeof window !== 'undefined') window.CXCPlan = { install: install };
})();
