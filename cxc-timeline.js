// ==========================================
// Construction Planner — timeline layout (cxc-timeline.js)
//
// Turns a packed schedule into the geometry a Gantt needs: lanes, bars, the
// sub-rows that keep overlapping bars from colliding, a date axis, and the
// milestone markers (material deliveries, phase completions) that explain WHY
// a bar starts when it does.
//
// Pure — no DOM. The renderer (cxc-ui-timeline.js) only turns this into HTML,
// which is what lets the awkward part (bar packing, date arithmetic) be tested
// headlessly in tools/test_cxc_timeline.js.
// ==========================================
(function () {
  'use strict';

  var CXC = (typeof window !== 'undefined' && window.CXC) ||
            (typeof require !== 'undefined' ? require('./cxc-model.js') : null);
  var CXCData = (typeof window !== 'undefined' && window.CXCData) ||
                (typeof require !== 'undefined' ? require('./cxc-data.js') : null);

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** How a lane is chosen. Each returns {id, label} for one assignment. */
  var GROUPINGS = {
    location: {
      label: 'Location',
      of: function (asg, data) {
        return { id: asg.locationId || '_none', label: CXCData.labelFor(data, 'locations', asg.locationId) || 'No location' };
      }
    },
    crew: {
      label: 'Crew',
      of: function (asg) { return { id: asg.crewId || '_none', label: asg.crewName || 'Unassigned' }; }
    },
    phase: {
      label: 'Phase',
      of: function (asg, data) {
        return { id: asg.phaseId || '_none', label: CXCData.labelFor(data, 'phases', asg.phaseId) || 'No phase' };
      }
    },
    activity: {
      label: 'Activity',
      of: function (asg) { return { id: asg.activityTypeId || '_none', label: asg.activityName || 'Unknown' }; }
    }
  };

  /**
   * Build the timeline model.
   *
   * Consecutive nights of work on the SAME scope item collapse into one bar —
   * a planner wants "conduit at MP 1.0, Sep 7 → Sep 15", not eight one-night
   * slivers. A gap longer than `gapDays` starts a new bar instead, so a job
   * that stops for a month does not render as one continuous span.
   *
   * @param {object} result   from CXC.packSchedule()
   * @param {object} data     the dataset
   * @param {object} [opts]   {groupBy:'location'|'crew'|'phase'|'activity', gapDays:number}
   * @returns {object} timeline model
   */
  function build(result, data, opts) {
    opts = opts || {};
    var groupBy = GROUPINGS[opts.groupBy] ? opts.groupBy : 'location';
    var gapDays = CXC.num(opts.gapDays, 7);
    var asgs = (result && result.assignments) || [];

    if (!asgs.length) {
      return { from: '', to: '', totalDays: 0, months: [], weeks: [], lanes: [], milestones: [], groupBy: groupBy, empty: true };
    }

    // Date span, padded so edge bars are not flush against the frame.
    var dates = asgs.map(function (a) { return a.date; }).sort();
    var from = dates[0];
    var to = dates[dates.length - 1];
    var totalDays = CXC.daysBetween(from, to) + 1;

    // ── Bars ───────────────────────────────────────────────────────────────
    // Group by lane, then by scope item, then split on gaps.
    var laneMap = {};   // laneId → {id, label, byItem:{itemId:[asg]}}
    asgs.forEach(function (a) {
      var lane = GROUPINGS[groupBy].of(a, data);
      var L = laneMap[lane.id] || (laneMap[lane.id] = { id: lane.id, label: lane.label, byItem: {} });
      (L.byItem[a.itemId] = L.byItem[a.itemId] || []).push(a);
    });

    var lanes = Object.keys(laneMap).map(function (laneId) {
      var L = laneMap[laneId];
      var bars = [];

      Object.keys(L.byItem).forEach(function (itemId) {
        var runs = L.byItem[itemId].slice().sort(function (x, y) { return x.date.localeCompare(y.date); });
        var cur = null;
        runs.forEach(function (a) {
          if (cur && CXC.daysBetween(cur.to, a.date) <= gapDays) {
            cur.to = a.date;
            cur.qty += a.qty;
            cur.minutes += a.minutes;
            cur.nights++;
            if (cur.crewNames.indexOf(a.crewName) === -1) cur.crewNames.push(a.crewName);
          } else {
            cur = newBar(a, data);
            bars.push(cur);
          }
        });
      });

      bars.forEach(function (b) {
        b.startIndex = CXC.daysBetween(from, b.from);
        b.days = CXC.daysBetween(b.from, b.to) + 1;
        b.qty = Math.round(b.qty * 100) / 100;
      });
      bars.sort(function (x, y) { return x.startIndex - y.startIndex || x.days - y.days; });

      return { id: L.id, label: L.label, sublanes: packSublanes(bars), barCount: bars.length };
    });

    lanes.sort(function (x, y) { return String(x.label).localeCompare(String(y.label)); });

    return {
      from: from, to: to, totalDays: totalDays,
      months: axisBuckets(from, totalDays, 'month'),
      weeks: axisBuckets(from, totalDays, 'week'),
      lanes: lanes,
      milestones: milestones(result, data, from, to),
      groupBy: groupBy,
      empty: false
    };
  }

  function newBar(a, data) {
    var phase = CXC.byId(data.phases, a.phaseId);
    return {
      itemId: a.itemId,
      from: a.date, to: a.date,
      qty: a.qty, unit: a.unit, minutes: a.minutes, nights: 1,
      activityName: a.activityName,
      activityTypeId: a.activityTypeId,
      phaseId: a.phaseId,
      phaseName: phase ? phase.name : '',
      color: (phase && phase.color) || 'slate',
      locationLabel: CXCData.labelFor(data, 'locations', a.locationId),
      crewNames: [a.crewName]
    };
  }

  /**
   * Greedy interval packing: put each bar in the first sub-row where it does
   * not overlap. Bars must already be sorted by start.
   * @param {Array} bars
   * @returns {Array<Array>} sub-rows
   */
  function packSublanes(bars) {
    var rows = [];
    bars.forEach(function (b) {
      var end = b.startIndex + b.days - 1;
      for (var i = 0; i < rows.length; i++) {
        var last = rows[i][rows[i].length - 1];
        if (last.startIndex + last.days - 1 < b.startIndex) { rows[i].push(b); b._row = i; return; }
      }
      b._row = rows.length;
      rows.push([b]);
      void end;
    });
    return rows.length ? rows : [[]];
  }

  /**
   * Axis buckets (month or ISO-ish week) covering the span, each with the
   * column index it starts at and how many days it covers.
   * @param {string} from
   * @param {number} totalDays
   * @param {'month'|'week'} unit
   */
  function axisBuckets(from, totalDays, unit) {
    var out = [];
    var i = 0;
    while (i < totalDays) {
      var date = CXC.addDays(from, i);
      var parts = date.split('-');
      var label, span;
      if (unit === 'month') {
        var y = +parts[0], m = +parts[1];
        label = MONTHS[m - 1] + ' ' + y;
        var daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
        span = daysInMonth - (+parts[2]) + 1;
      } else {
        label = MONTHS[+parts[1] - 1] + ' ' + (+parts[2]);
        span = 7 - CXC.dowOf(date);            // run to the end of that week
      }
      span = Math.min(span, totalDays - i);
      out.push({ label: label, startIndex: i, days: span });
      i += span;
    }
    return out;
  }

  /**
   * Dated events worth a marker on the axis: when each material lands on site,
   * and when the last work of a phase finishes. These are the answers to "why
   * does nothing start until October".
   */
  function milestones(result, data, from, to) {
    var out = [];

    (data.materials || []).forEach(function (m) {
      var d = m.availableFrom;
      if (!d || d < from || d > to) return;
      // Only worth showing if the plan actually consumes it.
      var line = (result.materials || []).find(function (x) { return x.materialId === m.id; });
      if (!line || line.required <= 0) return;
      out.push({
        date: d, index: CXC.daysBetween(from, d), kind: 'material',
        label: (m.code || m.name) + ' on site'
      });
    });

    var lastByPhase = {};
    (result.assignments || []).forEach(function (a) {
      if (!a.phaseId) return;
      if (!lastByPhase[a.phaseId] || a.date > lastByPhase[a.phaseId]) lastByPhase[a.phaseId] = a.date;
    });
    Object.keys(lastByPhase).forEach(function (phaseId) {
      var p = CXC.byId(data.phases, phaseId);
      var d = lastByPhase[phaseId];
      if (d < from || d > to) return;
      out.push({
        date: d, index: CXC.daysBetween(from, d), kind: 'phase',
        label: (p ? p.name : phaseId) + ' complete'
      });
    });

    return out.sort(function (x, y) { return x.date.localeCompare(y.date) || x.label.localeCompare(y.label); });
  }

  var CXCTimeline = {
    GROUPINGS: GROUPINGS,
    build: build,
    packSublanes: packSublanes,
    axisBuckets: axisBuckets
  };

  if (typeof window !== 'undefined') window.CXCTimeline = CXCTimeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXCTimeline;
})();
