// ==========================================
// Construction Planner — starter UI (cxc-ui-demo.js)
//
// A deliberately thin render layer over CXC (the engine) and CXCStore
// (persistence). It exists so there is something to LOOK at on day one and so
// the three-layer split is demonstrated rather than described. Expect to
// replace it: real UI belongs in focused cxc-ui-*.js modules (scope editor,
// activity catalog, crew editor, shift-window editor, schedule board).
//
// Note what this file does NOT do: no scheduling math (that is cxc-model.js)
// and no localStorage calls (that is cxc-store-local.js). Keep it that way.
// Handlers are wired with addEventListener — no inline `onclick=` — matching
// cx-portal's delegation direction (ADR 0001 Stage B).
// ==========================================
(function () {
  'use strict';

  var esc = function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  };
  var $ = function (id) { return document.getElementById(id); };
  var hrs = function (min) { return (min / 60).toFixed(1); };

  // ── Demo scope ───────────────────────────────────────────────────────────
  // Stand-in for the scope table the user will actually import/edit. Shape is
  // the contract: id, location, activityTypeId, qty, optional prereqIds/crewId.
  var DEMO_SCOPE = [
    { id: 'S-001', location: 'MP 1.0 — 1.5', activityTypeId: 'cond-rgs-4', qty: 2600 },
    { id: 'S-002', location: 'MP 1.0 — 1.5', activityTypeId: 'pwr-cable', qty: 2600, prereqIds: ['S-001'] },
    { id: 'S-003', location: 'MP 1.0 — 1.5', activityTypeId: 'pwr-term', qty: 24, prereqIds: ['S-002'] },
    { id: 'S-004', location: 'MP 1.0 — 1.5', activityTypeId: 'fiber-pull', qty: 2600, prereqIds: ['S-001'] },
    { id: 'S-005', location: 'MP 1.0 — 1.5', activityTypeId: 'fiber-splice', qty: 18, prereqIds: ['S-004'] },
    { id: 'S-006', location: 'CIL 12', activityTypeId: 'dev-axle', qty: 6 },
    { id: 'S-007', location: 'CIL 12', activityTypeId: 'dev-balise', qty: 14 },
    { id: 'S-008', location: 'CIL 14', activityTypeId: 'dev-wayside-radio', qty: 4 },
    { id: 'S-009', location: 'MP 2.0 — 2.4', activityTypeId: 'cond-emt-2', qty: 1900 },
    { id: 'S-010', location: 'MP 2.0 — 2.4', activityTypeId: 'fiber-pull', qty: 1900, prereqIds: ['S-009'] }
  ];

  // Assumptions come from storage when the user has edited them, else the seed.
  function currentAssumptions() {
    var saved = CXCStore.load('assumptions', null);
    return saved || JSON.parse(JSON.stringify(CXC.DEFAULT_ASSUMPTIONS));
  }
  function currentScope() {
    return CXCStore.load('scope', null) || DEMO_SCOPE;
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function renderKpis(result, assumptions, scope) {
    var s = result.summary;
    var byKind = {};
    result.windows.forEach(function (w) {
      if (!w.used) return;
      var p = CXC._byId(assumptions.shiftPatterns, w.patternId);
      var k = (p && p.name) || w.patternId;
      byKind[k] = (byKind[k] || 0) + 1;
    });
    var kindText = Object.keys(byKind).map(function (k) {
      return byKind[k] + ' × ' + k;
    }).join('<br>') || '&mdash;';

    var usedWins = result.windows.filter(function (w) { return w.used > 0; });
    // Utilization is measured over the windows actually WORKED — not every
    // window in the date range, which would just report how far out you asked
    // the planner to look.
    var usedCap = usedWins.reduce(function (t, w) { return t + w.capacity; }, 0);

    $('cxc-kpis').innerHTML = [
      kpi(hrs(s.scheduledMinutes), 'Crew-hours of work'),
      kpi(usedWins.length, 'Windows needed'),
      kpi(kindText, 'By window type', true),
      kpi(s.lastWorkedDate || '&mdash;', 'Finish date', true),
      kpi(s.completeCount + ' / ' + s.itemCount, 'Scope items complete'),
      kpi(usedCap ? Math.round((s.scheduledMinutes / usedCap) * 100) + '%' : '0%',
        'Utilization of worked windows')
    ].join('');
  }
  function kpi(val, label, raw) {
    return '<div class="cxc-kpi"><div class="cxc-kpi-val">' + (raw ? val : esc(val)) +
      '</div><div class="cxc-kpi-lbl">' + esc(label) + '</div></div>';
  }

  function renderScope(scope, assumptions) {
    var crew = (assumptions.crews || [])[0];
    var rows = scope.map(function (it) {
      var t = CXC._byId(assumptions.activityTypes, it.activityTypeId);
      var qualified = (assumptions.crews || []).filter(function (c) {
        return CXC.crewCanDo(c, it.activityTypeId);
      });
      var c = qualified[0] || crew;
      var d = CXC.taskMinutes(it, c, assumptions);
      return '<tr>' +
        '<td>' + esc(it.id) + '</td>' +
        '<td>' + esc(it.location) + '</td>' +
        '<td>' + esc(t ? t.name : it.activityTypeId) + '</td>' +
        '<td class="cxc-num">' + esc(it.qty) + '</td>' +
        '<td>' + esc(t ? t.unit : '') + '</td>' +
        '<td class="cxc-num">' + esc(t ? t.minutesPerUnit : '') + '</td>' +
        '<td>' + esc(c ? c.name : '&mdash;') + '</td>' +
        '<td class="cxc-num">' + esc(hrs(d.minutes)) + '</td>' +
        '<td>' + (it.prereqIds && it.prereqIds.length
          ? '<span class="cxc-tag cxc-info">' + esc(it.prereqIds.join(', ')) + '</span>' : '') + '</td>' +
        '</tr>';
    }).join('');

    $('cxc-scope').innerHTML =
      '<thead><tr><th>Item</th><th>Location</th><th>Activity</th><th class="cxc-num">Qty</th>' +
      '<th>Unit</th><th class="cxc-num">Min / unit</th><th>Crew</th>' +
      '<th class="cxc-num">Hours</th><th>After</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="cxc-empty">No scope items.</td></tr>') + '</tbody>';
  }

  function renderWindows(result) {
    var worked = result.windows.filter(function (w) { return w.used > 0; });
    var rows = worked.map(function (w) {
      var pct = w.utilization;
      return '<tr>' +
        '<td>' + esc(w.date) + '</td>' +
        '<td>' + esc(w.name) + '</td>' +
        '<td class="cxc-num">' + esc(hrs(w.gross)) + '</td>' +
        '<td class="cxc-num">' + esc(hrs(w.mobilize)) + '</td>' +
        '<td class="cxc-num">' + esc(hrs(w.productive)) + '</td>' +
        '<td class="cxc-num">' + esc(w.crewCount) + '</td>' +
        '<td class="cxc-num">' + esc(hrs(w.used)) + '</td>' +
        '<td><div class="cxc-bar' + (pct < 60 ? ' cxc-low' : '') + '" role="img" aria-label="' +
          esc(pct + '% utilized') + '"><span style="width:' + Math.min(100, pct) + '%"></span></div></td>' +
        '<td class="cxc-num">' + esc(pct) + '%</td>' +
        '</tr>';
    }).join('');

    $('cxc-windows').innerHTML =
      '<thead><tr><th>Date</th><th>Window</th><th class="cxc-num">Gross h</th>' +
      '<th class="cxc-num">Mob h</th><th class="cxc-num">Productive h</th><th class="cxc-num">Crews</th>' +
      '<th class="cxc-num">Used h</th><th>Utilization</th><th class="cxc-num">%</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="cxc-empty">No windows were used.</td></tr>') + '</tbody>';
  }

  function renderUnplaced(result, assumptions) {
    var rows = result.unplaced.map(function (u) {
      var t = CXC._byId(assumptions.activityTypes, u.activityTypeId);
      return '<tr>' +
        '<td>' + esc(u.itemId) + '</td>' +
        '<td>' + esc(u.location) + '</td>' +
        '<td>' + esc(t ? t.name : u.activityTypeId) + '</td>' +
        '<td class="cxc-num">' + esc(u.remainingQty) + '</td>' +
        '<td><span class="cxc-tag cxc-bad">' + esc(u.reason) + '</span></td>' +
        '</tr>';
    }).join('');

    $('cxc-unplaced').innerHTML =
      '<thead><tr><th>Item</th><th>Location</th><th>Activity</th>' +
      '<th class="cxc-num">Qty left</th><th>Reason</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="cxc-empty">Everything fits in the date range.</td></tr>') + '</tbody>';
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function readControlsInto(assumptions) {
    var g = assumptions.globals;
    g.productivityFactor = parseFloat($('cxc-prod').value) || 1;
    g.contingencyPct = parseFloat($('cxc-cont').value) || 0;
    g.crewScalingExponent = parseFloat($('cxc-exp').value);
    if (!isFinite(g.crewScalingExponent)) g.crewScalingExponent = 0.85;
    g.relocationMin = parseFloat($('cxc-reloc').value) || 0;
    return assumptions;
  }

  function selectedPatternIds() {
    return Array.prototype.slice.call($('cxc-patterns').selectedOptions)
      .map(function (o) { return o.value; });
  }

  function recalc() {
    var assumptions = readControlsInto(currentAssumptions());
    var scope = currentScope();
    CXCStore.save('assumptions', assumptions);

    var windows = CXC.generateWindows(
      $('cxc-from').value, $('cxc-to').value, assumptions, selectedPatternIds());
    var result = CXC.packSchedule({ items: scope, windows: windows, assumptions: assumptions });
    CXCStore.save('schedule', { generatedAt: new Date().toISOString(), summary: result.summary });

    renderKpis(result, assumptions, scope);
    renderScope(scope, assumptions);
    renderWindows(result);
    renderUnplaced(result, assumptions);
  }

  function init() {
    var assumptions = currentAssumptions();
    var g = assumptions.globals || {};
    $('cxc-prod').value = g.productivityFactor;
    $('cxc-cont').value = g.contingencyPct;
    $('cxc-exp').value = g.crewScalingExponent;
    $('cxc-reloc').value = g.relocationMin;

    $('cxc-patterns').innerHTML = (assumptions.shiftPatterns || []).map(function (p) {
      return '<option value="' + esc(p.id) + '" selected>' + esc(p.name) + '</option>';
    }).join('');

    $('cxc-run').addEventListener('click', recalc);
    $('cxc-export').addEventListener('click', function () {
      var blob = new Blob([CXCStore.exportJson()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'cxc-planner-export.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    recalc();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
