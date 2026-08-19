// ==========================================
// Construction Planner — timeline view (cxc-ui-timeline.js)
//
// Renders the Gantt from the geometry cxc-timeline.js computed. Deliberately
// plain HTML + CSS — no charting library, so there is nothing to vendor, keep
// current, or fight for control of the DOM. A day is a fixed-width column; a
// bar is absolutely positioned across the columns it spans.
// ==========================================
(function () {
  'use strict';

  var ZOOMS = [
    { id: 'week', label: 'Fit quarter', day: 6 },
    { id: 'day', label: 'Comfortable', day: 15 },
    { id: 'wide', label: 'Detailed', day: 30 }
  ];

  function state() {
    return {
      groupBy: CXStore.get('cxc.tl.groupBy', 'location'),
      zoom: CXStore.get('cxc.tl.zoom', 'day')
    };
  }

  function render(data, result) {
    var st = state();
    var tl = CXCTimeline.build(result, data, { groupBy: st.groupBy });
    var dayW = (ZOOMS.find(function (z) { return z.id === st.zoom; }) || ZOOMS[1]).day;

    var controls = '<div class="cxc-card"><div class="cxc-controls">' +
      '<label class="cxc-field"><span>Group rows by</span><select class="cxc-inp" ' +
        cxOn('change', 'cxcTlGroup', '$cx.value') + '>' +
        Object.keys(CXCTimeline.GROUPINGS).map(function (k) {
          return '<option value="' + k + '"' + (k === st.groupBy ? ' selected' : '') + '>' +
            escapeHtml(CXCTimeline.GROUPINGS[k].label) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="cxc-field"><span>Zoom</span><select class="cxc-inp" ' +
        cxOn('change', 'cxcTlZoom', '$cx.value') + '>' +
        ZOOMS.map(function (z) {
          return '<option value="' + z.id + '"' + (z.id === st.zoom ? ' selected' : '') + '>' +
            escapeHtml(z.label) + '</option>';
        }).join('') + '</select></label>' +
      '<div class="cxc-field"><span>Span</span><div style="font-size:13px;color:var(--text);padding-top:5px">' +
        (tl.empty ? '—' : escapeHtml(tl.from + '  →  ' + tl.to + '   (' + tl.totalDays + ' days)')) +
      '</div></div>' +
      '</div></div>';

    if (tl.empty) {
      return controls + '<div class="cxc-card"><div class="cxc-empty">' +
        '<strong>Nothing to show on the timeline.</strong>' +
        'Nothing was scheduled — check the plan date range, the scope and the crews.</div></div>';
    }

    // ── Header: months, then weeks ─────────────────────────────────────────
    var head =
      '<div class="cxc-tl-row cxc-tl-head">' +
        '<div class="cxc-tl-lane"><b>' + escapeHtml(CXCTimeline.GROUPINGS[st.groupBy].label) + '</b>' +
        '<span>' + tl.lanes.length + ' row' + (tl.lanes.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="cxc-tl-track" style="width:' + (tl.totalDays * dayW) + 'px">' +
          '<div class="cxc-tl-months">' + tl.months.map(function (m) {
            return '<div style="width:' + (m.days * dayW) + 'px">' + escapeHtml(m.label) + '</div>';
          }).join('') + '</div>' +
          '<div class="cxc-tl-weeks">' + tl.weeks.map(function (w) {
            return '<div style="width:' + (w.days * dayW) + 'px">' +
              (w.days * dayW >= 34 ? escapeHtml(w.label) : '') + '</div>';
          }).join('') + '</div>' +
        '</div>' +
      '</div>';

    // Weekend shading, drawn once per row behind the bars.
    var grid = '<div class="cxc-tl-grid">';
    for (var i = 0; i < tl.totalDays; i++) {
      var dow = CXC.dowOf(CXC.addDays(tl.from, i));
      grid += '<i class="' + (dow === 0 || dow === 6 ? 'cxc-we' : '') + '"></i>';
    }
    grid += '</div>';

    // Milestone rules, drawn on every row so they read as vertical lines.
    var rules = tl.milestones.map(function (m) {
      return '<div class="cxc-tl-mile ' + (m.kind === 'phase' ? 'cxc-mile-phase' : '') + '" ' +
        'style="left:' + (m.index * dayW + dayW / 2) + 'px" title="' + escapeHtml(m.date + ' — ' + m.label) + '"></div>';
    }).join('');

    // ── Lanes ──────────────────────────────────────────────────────────────
    var rows = tl.lanes.map(function (lane) {
      var sublanes = lane.sublanes.map(function (bars) {
        return '<div class="cxc-tl-sub">' + bars.map(function (b) {
          var label = b.activityName + ' · ' + b.qty + ' ' + (b.unit || '');
          var tip = b.itemId + ' — ' + b.activityName + '\n' +
            b.locationLabel + '\n' +
            b.from + ' → ' + b.to + '  (' + b.nights + ' window' + (b.nights === 1 ? '' : 's') + ')\n' +
            b.qty + ' ' + (b.unit || '') + ' · ' + (b.minutes / 60).toFixed(1) + ' crew-hours\n' +
            b.crewNames.join(', ') + (b.phaseName ? '\nPhase: ' + b.phaseName : '');
          return '<div class="cxc-tl-bar cxc-bar-' + escapeHtml(b.color) + '" ' +
            'style="left:' + (b.startIndex * dayW) + 'px;width:' + Math.max(dayW - 2, b.days * dayW - 2) + 'px" ' +
            'title="' + escapeHtml(tip) + '">' +
            (b.days * dayW > 60 ? escapeHtml(label) : '') + '</div>';
        }).join('') + '</div>';
      }).join('');

      return '<div class="cxc-tl-row">' +
        '<div class="cxc-tl-lane"><b>' + escapeHtml(lane.label) + '</b>' +
          '<span>' + lane.barCount + ' run' + (lane.barCount === 1 ? '' : 's') + '</span></div>' +
        '<div class="cxc-tl-track" style="width:' + (tl.totalDays * dayW) + 'px">' +
          grid + rules + sublanes +
        '</div>' +
      '</div>';
    }).join('');

    // ── Legend + milestone list ────────────────────────────────────────────
    var usedPhases = {};
    tl.lanes.forEach(function (l) {
      l.sublanes.forEach(function (bars) {
        bars.forEach(function (b) { if (b.phaseName) usedPhases[b.phaseName] = b.color; });
      });
    });
    var legend = '<div class="cxc-legend">' +
      Object.keys(usedPhases).map(function (name) {
        return '<span><i style="background:var(--phase-' + escapeHtml(usedPhases[name]) + ')"></i>' +
          escapeHtml(name) + '</span>';
      }).join('') +
      '<span><i style="background:var(--surface-3);border:1px solid var(--border-strong)"></i>Weekend</span>' +
      '<span style="border-left:2px dashed var(--info);padding-left:6px">Material on site</span>' +
      '<span style="border-left:2px dashed var(--good);padding-left:6px">Phase complete</span>' +
      '</div>';

    var mileList = tl.milestones.length
      ? '<div class="cxc-card"><div class="cxc-card-head"><div><h3>Events</h3>' +
        '<p class="cxc-hint">Dated milestones behind the bars — when material lands, and when each ' +
        'phase finishes. These explain why a run starts when it does.</p></div></div>' +
        '<div class="cxc-tl-milelist">' + tl.milestones.map(function (m) {
          return '<span class="cxc-tag ' + (m.kind === 'phase' ? 'cxc-ok' : 'cxc-info') + '">' +
            escapeHtml(m.date) + ' · ' + escapeHtml(m.label) + '</span>';
        }).join('') + '</div></div>'
      : '';

    return controls +
      '<div class="cxc-card"><div class="cxc-tl" style="--cxc-day:' + dayW + 'px">' +
        '<div class="cxc-tl-scroll"><div class="cxc-tl-inner">' + head + rows + '</div></div>' +
        legend +
      '</div></div>' +
      mileList;
  }

  function install() {
    CXCApp.registerView('timeline', {
      title: 'Timeline',
      subtitle: 'When each run happens, and the events that gate it',
      icon: 'clock',
      group: 'Plan',
      render: render
    });
    CXActions
      .register('cxcTlGroup', function (v) { CXStore.set('cxc.tl.groupBy', v); CXCApp.render(); })
      .register('cxcTlZoom', function (v) { CXStore.set('cxc.tl.zoom', v); CXCApp.render(); });
  }

  if (typeof window !== 'undefined') window.CXCTimelineView = { install: install };
})();
