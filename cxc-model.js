// ==========================================
// Construction Planner — production model + schedule packer (cxc-model.js)
//
// THIS IS THE FILE TO START ON. It is the whole domain: how long work takes,
// how much a shift window actually buys you, and how the two get matched.
//
// Rules this file lives by (they are why it will merge into cx-portal cleanly):
//   1. PURE. No DOM, no fetch, no localStorage, no Date.now(). Every function
//      takes data in and returns data out. That makes it testable headlessly
//      (tools/test_cxc_model.js) and reusable by any UI, now or after merge.
//   2. NOTHING HARD-CODED. Every rate, duration, crew size, mobilization
//      allowance and shift length lives in an `assumptions` object that the
//      caller owns and the UI edits. DEFAULT_ASSUMPTIONS below is a SEED, not
//      a source of truth — the app must be usable with all of it replaced.
//   3. Namespaced `CXC` (classic <script>, window global) so it can be dropped
//      into cx-portal's index.html next to app.js without colliding.
//
// Mirrors the shape of cx-portal's dynamic-testing allocator (_dynCascadeAllocate
// in app.js): duration-aware greedy packing into time windows, with changeover
// costs and an explicit "why didn't this get placed" answer for every item.
// ==========================================
(function () {
  'use strict';

  // ── Units ────────────────────────────────────────────────────────────────
  // A unit is just a label plus how quantities are counted. Add your own.
  var UNITS = {
    ea: { label: 'each', plural: 'each' },
    lf: { label: 'linear foot', plural: 'linear feet' },
    ft: { label: 'foot', plural: 'feet' },
    pull: { label: 'pull', plural: 'pulls' },
    term: { label: 'termination', plural: 'terminations' },
    splice: { label: 'splice', plural: 'splices' }
  };

  // ── Seed assumptions ─────────────────────────────────────────────────────
  // Every number here is a placeholder for the estimator to overwrite. Ship the
  // UI so a user can edit, add and delete all of it, and export/import the whole
  // object as JSON — that IS the "manipulate the assumptions" feature.
  var DEFAULT_ASSUMPTIONS = {
    version: 1,

    // Global dials applied on top of every task.
    globals: {
      // Blanket productivity multiplier. 1.0 = the book rates below are right.
      // Drop to 0.8 to model a bad stretch, raise to model a proven team.
      productivityFactor: 1.0,
      // Paid non-productive time inside a window (breaks, safety brief).
      breakMinPerShift: 30,
      // Percentage of each window deliberately left unplanned as buffer.
      contingencyPct: 10,
      // How crew size converts to speed. 1 = perfectly linear (2x crew = 2x
      // fast), 0 = adding people does nothing. Real trades sit ~0.75–0.9.
      crewScalingExponent: 0.85,
      // Cost of a crew relocating to a different work location mid-shift.
      relocationMin: 15
    },

    // Shift windows. `kind` is free-form and only used for labelling/filtering.
    // Duration is EITHER explicit durationMin, OR derived from start/end
    // (endsNextDay handles a window that crosses midnight).
    shiftPatterns: [
      {
        id: 'sgl-8',
        name: 'Single track — 8 hr night',
        kind: 'single-track',
        startTime: '22:00', endTime: '06:00', endsNextDay: true,
        // Mobilization: getting on and off the work site inside the window.
        // This is the time the window is granted but no work happens.
        mobilizeInMin: 60,   // protection set up, roll to location
        mobilizeOutMin: 45,  // clear up, roll back, release the track
        daysOfWeek: [1, 2, 3, 4, 5],   // 0=Sun … 6=Sat
        maxCrews: 2
      },
      {
        id: 'sgl-2',
        name: 'Short window — 2 hr',
        kind: 'single-track',
        startTime: '01:00', endTime: '03:00', endsNextDay: false,
        mobilizeInMin: 35,
        mobilizeOutMin: 25,
        daysOfWeek: [1, 2, 3, 4, 5],
        maxCrews: 1
      },
      {
        id: 'wknd-shutdown',
        name: 'Weekend shutdown',
        kind: 'shutdown',
        // Explicit duration wins over start/end — a 52 hr shutdown is easier
        // to state directly than as a clock range.
        durationMin: 52 * 60,
        startTime: '22:00', endTime: '02:00', endsNextDay: true,
        mobilizeInMin: 90,
        mobilizeOutMin: 90,
        daysOfWeek: [5],
        maxCrews: 6
      }
    ],

    // Activity catalog: duration per quantity, by installation type.
    // minutesPerUnit is measured AT refCrewSize with productivityFactor 1.
    // setupMin is per task instance (rig the reel, stage material, set ladders).
    // divisible — how the work may be split across windows:
    //   'continuous' cut anywhere (200 lf tonight, 340 lf tomorrow)
    //   'unit'       whole units only (2 balises tonight, 3 tomorrow — you do
    //                not leave half a device installed at track release)
    //   'none'       must complete inside ONE window (a cutover, a pour)
    activityTypes: [
      { id: 'cond-emt-2', name: 'Conduit — 2" EMT', discipline: 'Electrical', unit: 'lf', minutesPerUnit: 3.0, refCrewSize: 2, setupMin: 30, divisible: 'continuous' },
      { id: 'cond-rgs-4', name: 'Conduit — 4" RGS', discipline: 'Electrical', unit: 'lf', minutesPerUnit: 5.5, refCrewSize: 3, setupMin: 45, divisible: 'continuous' },
      { id: 'dev-axle', name: 'Device — axle counter', discipline: 'Signals', unit: 'ea', minutesPerUnit: 180, refCrewSize: 2, setupMin: 30, divisible: 'unit' },
      { id: 'dev-balise', name: 'Device — balise', discipline: 'Signals', unit: 'ea', minutesPerUnit: 90, refCrewSize: 2, setupMin: 20, divisible: 'unit' },
      { id: 'dev-wayside-radio', name: 'Device — wayside radio', discipline: 'Comms', unit: 'ea', minutesPerUnit: 240, refCrewSize: 2, setupMin: 45, divisible: 'unit' },
      { id: 'fiber-pull', name: 'Fiber — pull', discipline: 'Comms', unit: 'lf', minutesPerUnit: 1.2, refCrewSize: 4, setupMin: 60, divisible: 'continuous' },
      { id: 'fiber-splice', name: 'Fiber — splice', discipline: 'Comms', unit: 'splice', minutesPerUnit: 25, refCrewSize: 1, setupMin: 40, divisible: 'unit' },
      { id: 'pwr-cable', name: 'Power cable — pull', discipline: 'Electrical', unit: 'lf', minutesPerUnit: 2.2, refCrewSize: 4, setupMin: 60, divisible: 'continuous' },
      { id: 'pwr-term', name: 'Power — termination', discipline: 'Electrical', unit: 'term', minutesPerUnit: 35, refCrewSize: 2, setupMin: 20, divisible: 'unit' }
    ],

    // Crews. `skills` are activityType ids this crew may perform (empty = all).
    // `efficiency` is this crew's own multiplier on top of productivityFactor.
    crews: [
      { id: 'crew-a', name: 'Crew A — electrical', size: 4, efficiency: 1.0, skills: [], shiftPatternIds: ['sgl-8', 'wknd-shutdown'] },
      { id: 'crew-b', name: 'Crew B — comms', size: 3, efficiency: 0.9, skills: ['fiber-pull', 'fiber-splice', 'dev-wayside-radio'], shiftPatternIds: ['sgl-8', 'sgl-2', 'wknd-shutdown'] }
    ],

    // Dates with no access at all (holidays, revenue events, embargo).
    blackoutDates: []
  };

  // ── Small helpers ────────────────────────────────────────────────────────
  function byId(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }
  /** "HH:MM" → minutes past midnight. Invalid → 0. */
  function clockMin(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
  }
  /** "YYYY-MM-DD" → 0=Sun…6=Sat, date-only so it never shifts by timezone. */
  function dowOf(isoDate) {
    var p = String(isoDate || '').split('-');
    return new Date(Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1)).getUTCDay();
  }
  function addDays(isoDate, n) {
    var p = String(isoDate).split('-');
    var d = new Date(Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // ── Window duration ──────────────────────────────────────────────────────
  /**
   * Gross minutes a pattern is granted, before mobilization or breaks.
   * @param {object} pattern
   * @returns {number}
   */
  function grossWindowMinutes(pattern) {
    if (!pattern) return 0;
    var explicit = num(pattern.durationMin, NaN);
    if (isFinite(explicit) && explicit > 0) return explicit;
    var s = clockMin(pattern.startTime), e = clockMin(pattern.endTime);
    var span = e - s;
    if (pattern.endsNextDay || span <= 0) span += 24 * 60;
    return Math.max(0, span);
  }

  /**
   * Minutes a crew can actually turn wrenches in one window: gross, less
   * mobilization in/out, less breaks, less the contingency reserve. This is the
   * number that makes a 2 hr window nearly worthless and a shutdown valuable.
   * A window may carry its own `overrides` (same keys as the pattern) so ONE
   * night can differ without editing the pattern.
   * @param {object} win     {date, patternId, overrides?}
   * @param {object} assumptions
   * @returns {{gross:number, mobilize:number, breaks:number, contingency:number, productive:number}}
   */
  function windowBudget(win, assumptions) {
    var a = assumptions || DEFAULT_ASSUMPTIONS;
    var g = a.globals || {};
    var pattern = byId(a.shiftPatterns, win && win.patternId) || {};
    var eff = Object.assign({}, pattern, (win && win.overrides) || {});

    var gross = grossWindowMinutes(eff);
    var mobilize = num(eff.mobilizeInMin, 0) + num(eff.mobilizeOutMin, 0);
    var breaks = num(eff.breakMinPerShift, num(g.breakMinPerShift, 0));
    var afterFixed = Math.max(0, gross - mobilize - breaks);
    var contingency = afterFixed * (num(g.contingencyPct, 0) / 100);

    return {
      gross: gross,
      mobilize: mobilize,
      breaks: breaks,
      contingency: Math.round(contingency),
      productive: Math.max(0, Math.round(afterFixed - contingency))
    };
  }

  // ── Task duration ────────────────────────────────────────────────────────
  /**
   * Speed multiplier for running an activity with a crew of a size other than
   * the rate's reference crew. exponent 1 = linear, 0 = no benefit.
   * @param {number} crewSize
   * @param {number} refSize
   * @param {number} exponent
   * @returns {number} multiplier on duration (<1 = faster)
   */
  function crewFactor(crewSize, refSize, exponent) {
    var c = Math.max(1, num(crewSize, 1));
    var r = Math.max(1, num(refSize, 1));
    var e = num(exponent, 1);
    return Math.pow(r / c, e);
  }

  /**
   * How long a quantity of one activity takes a given crew, in minutes.
   * Pass `qty` explicitly to price a PARTIAL placement (a split across windows).
   * @param {object} item  {activityTypeId, qty, ...}
   * @param {object} crew
   * @param {object} assumptions
   * @param {number} [qty] override quantity (defaults to item.qty)
   * @returns {{minutes:number, work:number, setup:number, type:object|null}}
   */
  function taskMinutes(item, crew, assumptions, qty) {
    var a = assumptions || DEFAULT_ASSUMPTIONS;
    var g = a.globals || {};
    var type = byId(a.activityTypes, item && item.activityTypeId);
    if (!type) return { minutes: 0, work: 0, setup: 0, type: null };

    var q = num(qty, num(item && item.qty, 0));
    var factor = crewFactor(crew && crew.size, type.refCrewSize, g.crewScalingExponent);
    var eff = Math.max(0.01, num(crew && crew.efficiency, 1) * num(g.productivityFactor, 1));

    var work = (q * num(type.minutesPerUnit, 0) * factor) / eff;
    // Setup is rigging, not production — crew efficiency helps, crew size does not.
    var setup = num(type.setupMin, 0) / eff;

    return {
      minutes: Math.round(work + setup),
      work: Math.round(work),
      setup: Math.round(setup),
      type: type
    };
  }

  /**
   * How an activity may be split across windows. Defaults to 'continuous', and
   * accepts the older `splittable: false` flag as 'none'.
   * @param {object} type
   * @returns {'continuous'|'unit'|'none'}
   */
  function divisibility(type) {
    if (!type) return 'none';
    if (type.divisible === 'unit' || type.divisible === 'none' || type.divisible === 'continuous') return type.divisible;
    if (type.splittable === false) return 'none';
    return 'continuous';
  }

  /** Can this crew perform this activity? Empty `skills` = qualified for all. */
  function crewCanDo(crew, activityTypeId) {
    if (!crew) return false;
    var s = crew.skills || [];
    return s.length === 0 || s.indexOf(activityTypeId) !== -1;
  }

  // ── Window generation ────────────────────────────────────────────────────
  /**
   * Expand shift patterns into dated windows across a date range. This is the
   * "map to a schedule" step: patterns describe the access agreement, windows
   * are the actual nights on the calendar.
   * @param {string} fromDate "YYYY-MM-DD" inclusive
   * @param {string} toDate   "YYYY-MM-DD" inclusive
   * @param {object} assumptions
   * @param {string[]} [patternIds] restrict to these patterns (default: all)
   * @returns {Array<{id:string, date:string, patternId:string, name:string, kind:string}>}
   */
  function generateWindows(fromDate, toDate, assumptions, patternIds) {
    var a = assumptions || DEFAULT_ASSUMPTIONS;
    var blackout = {};
    (a.blackoutDates || []).forEach(function (d) { blackout[d] = true; });
    var pats = (a.shiftPatterns || []).filter(function (p) {
      return !patternIds || patternIds.indexOf(p.id) !== -1;
    });

    var out = [];
    var guard = 0;
    for (var d = fromDate; d <= toDate && guard < 4000; d = addDays(d, 1), guard++) {
      if (blackout[d]) continue;
      var dow = dowOf(d);
      for (var i = 0; i < pats.length; i++) {
        var p = pats[i];
        var days = p.daysOfWeek || [];
        if (days.length && days.indexOf(dow) === -1) continue;
        out.push({ id: p.id + '@' + d, date: d, patternId: p.id, name: p.name, kind: p.kind || '' });
      }
    }
    return out;
  }

  // ── Schedule packer ──────────────────────────────────────────────────────
  /**
   * Greedily pack work items into windows, chronologically, per crew.
   *
   * Behaviour worth knowing before you extend it:
   *  • Each crew gets its OWN budget within a window (crews work in parallel),
   *    capped by the pattern's maxCrews.
   *  • Work is placed partially when the remaining budget can't hold all of it,
   *    honouring the activity's `divisible` setting: 'continuous' cuts
   *    anywhere, 'unit' cuts at whole devices, 'none' must fit one window
   *    entirely. The remainder rolls to the next window.
   *  • An item is only a PREREQUISITE-satisfier once fully complete.
   *  • Moving a crew to a different `location` inside a window costs
   *    globals.relocationMin.
   *  • Anything left over comes back in `unplaced` WITH A REASON. Never drop an
   *    item silently — the reason column is the most useful thing in the app.
   *
   * @param {object} input
   * @param {Array} input.items    [{id, location, activityTypeId, qty, prereqIds?, crewId?}]
   * @param {Array} input.windows  from generateWindows() (or hand-built)
   * @param {object} input.assumptions
   * @returns {{assignments:Array, unplaced:Array, windows:Array, summary:object}}
   */
  function packSchedule(input) {
    input = input || {};
    var a = input.assumptions || DEFAULT_ASSUMPTIONS;
    var g = a.globals || {};
    var crews = a.crews || [];
    var windows = (input.windows || []).slice().sort(function (x, y) {
      return String(x.date).localeCompare(String(y.date)) || String(x.patternId).localeCompare(String(y.patternId));
    });

    // Remaining quantity per item; an item is done at 0.
    var remaining = {};
    var items = (input.items || []).filter(function (it) { return it && it.id; });
    items.forEach(function (it) { remaining[it.id] = num(it.qty, 0); });

    var assignments = [];
    var windowRows = [];

    for (var w = 0; w < windows.length; w++) {
      var win = windows[w];
      var pattern = byId(a.shiftPatterns, win.patternId) || {};
      var budget = windowBudget(win, a);

      // Which crews are cleared for this pattern, capped by maxCrews.
      var winCrews = crews.filter(function (c) {
        var ids = c.shiftPatternIds || [];
        return ids.length === 0 || ids.indexOf(win.patternId) !== -1;
      });
      var maxCrews = num(pattern.maxCrews, winCrews.length);
      winCrews = winCrews.slice(0, Math.max(0, maxCrews));

      var winUsed = 0;
      for (var ci = 0; ci < winCrews.length; ci++) {
        var crew = winCrews[ci];
        var left = budget.productive;
        var atLocation = null;

        for (;;) {
          if (left <= 0) break;

          // Eligible = work remaining, crew qualified, not pinned to another
          // crew, and every prerequisite fully complete.
          var best = null, bestCost = null;
          for (var ii = 0; ii < items.length; ii++) {
            var it = items[ii];
            if (remaining[it.id] <= 0) continue;
            if (it.crewId && it.crewId !== crew.id) continue;
            if (!crewCanDo(crew, it.activityTypeId)) continue;
            if (!prereqsDone(it, remaining)) continue;

            var type = byId(a.activityTypes, it.activityTypeId);
            if (!type) continue;

            var move = (atLocation !== null && it.location !== atLocation) ? num(g.relocationMin, 0) : 0;
            var full = taskMinutes(it, crew, a, remaining[it.id]).minutes + move;

            var cost;
            if (full <= left) cost = full;
            else if (divisibility(type) === 'none') continue; // must fit one window
            else cost = left;                                 // partial fill

            // Prefer staying put, then the item that consumes the most window.
            if (!best || (move === 0 && bestCost && bestCost.move > 0) || cost > bestCost.cost) {
              best = it; bestCost = { cost: cost, move: move, type: type, full: full };
            }
          }
          if (!best) break;

          var avail = left - bestCost.move;
          if (avail <= 0) break;

          var placedQty, usedMin;
          if (bestCost.full <= left) {
            placedQty = remaining[best.id];
            usedMin = bestCost.full;
          } else {
            // Partial: subtract setup once, then convert the rest to quantity.
            var probe = taskMinutes(best, crew, a, remaining[best.id]);
            var perUnit = probe.work / Math.max(1e-9, remaining[best.id]);
            var qty = (avail - probe.setup) / Math.max(1e-9, perUnit);
            // 'unit' work only breaks at whole devices; 'continuous' rounds to a
            // sane precision so a plan never reads "137.4183 lf".
            qty = divisibility(bestCost.type) === 'unit'
              ? Math.floor(qty)
              : Math.floor(qty * 10) / 10;
            if (qty <= 0) break;               // not even one unit fits — end crew's shift
            placedQty = Math.min(qty, remaining[best.id]);
            usedMin = taskMinutes(best, crew, a, placedQty).minutes + bestCost.move;
          }

          assignments.push({
            windowId: win.id,
            date: win.date,
            patternId: win.patternId,
            crewId: crew.id,
            crewName: crew.name,
            itemId: best.id,
            location: best.location || '',
            activityTypeId: best.activityTypeId,
            activityName: bestCost.type.name,
            qty: placedQty,
            unit: bestCost.type.unit,
            minutes: usedMin,
            relocationMin: bestCost.move,
            partial: placedQty < remaining[best.id]
          });

          remaining[best.id] -= placedQty;
          left -= usedMin;
          winUsed += usedMin;
          atLocation = best.location;
        }
      }

      windowRows.push({
        id: win.id, date: win.date, patternId: win.patternId, name: win.name,
        gross: budget.gross, mobilize: budget.mobilize, productive: budget.productive,
        crewCount: winCrews.length,
        capacity: budget.productive * winCrews.length,
        used: winUsed,
        utilization: budget.productive * winCrews.length > 0
          ? Math.round((winUsed / (budget.productive * winCrews.length)) * 100) : 0
      });
    }

    // Everything still carrying quantity, with the reason it never landed.
    var unplaced = items.filter(function (it) { return remaining[it.id] > 0; }).map(function (it) {
      return {
        itemId: it.id,
        location: it.location || '',
        activityTypeId: it.activityTypeId,
        remainingQty: remaining[it.id],
        reason: unplacedReason(it, remaining, a, windows)
      };
    });

    var totalMin = assignments.reduce(function (s, x) { return s + x.minutes; }, 0);
    return {
      assignments: assignments,
      unplaced: unplaced,
      windows: windowRows,
      summary: {
        itemCount: items.length,
        completeCount: items.length - unplaced.length,
        windowCount: windowRows.length,
        scheduledMinutes: totalMin,
        capacityMinutes: windowRows.reduce(function (s, x) { return s + x.capacity; }, 0),
        firstDate: windowRows.length ? windowRows[0].date : null,
        lastWorkedDate: assignments.length ? assignments[assignments.length - 1].date : null
      }
    };
  }

  /** Every prerequisite complete (remaining 0)? Unknown ids are ignored. */
  function prereqsDone(item, remaining) {
    var ps = item.prereqIds || [];
    for (var i = 0; i < ps.length; i++) {
      if (Object.prototype.hasOwnProperty.call(remaining, ps[i]) && remaining[ps[i]] > 0) return false;
    }
    return true;
  }

  /** Human-readable cause for an item that never fully placed. */
  function unplacedReason(item, remaining, a, windows) {
    var type = byId(a.activityTypes, item.activityTypeId);
    if (!type) return 'unknown activity type "' + item.activityTypeId + '"';
    if (!prereqsDone(item, remaining)) return 'prerequisite not complete';

    var qualified = (a.crews || []).filter(function (c) {
      return crewCanDo(c, item.activityTypeId) && (!item.crewId || item.crewId === c.id);
    });
    if (!qualified.length) return 'no crew qualified for ' + type.name;

    // The smallest indivisible chunk this activity can be placed in: the whole
    // scope for 'none', one unit for 'unit'. If even that never fits a window,
    // no amount of extra dates helps — the WINDOW is too short.
    var div = divisibility(type);
    if (div !== 'continuous') {
      var chunkQty = div === 'none' ? item.qty : 1;
      var fits = windows.some(function (win) {
        var b = windowBudget(win, a);
        return qualified.some(function (c) {
          return taskMinutes(item, c, a, chunkQty).minutes <= b.productive;
        });
      });
      if (!fits) {
        var need = taskMinutes(item, qualified[0], a, chunkQty).minutes;
        return 'no window long enough — ' + (div === 'none' ? 'this activity must finish in one window and' : 'a single ' + type.unit) +
          ' needs ' + need + ' min of productive time';
      }
    }
    return 'ran out of window capacity in the date range';
  }

  // ── Exports ──────────────────────────────────────────────────────────────
  var CXC = {
    UNITS: UNITS,
    DEFAULT_ASSUMPTIONS: DEFAULT_ASSUMPTIONS,
    grossWindowMinutes: grossWindowMinutes,
    windowBudget: windowBudget,
    crewFactor: crewFactor,
    taskMinutes: taskMinutes,
    crewCanDo: crewCanDo,
    generateWindows: generateWindows,
    packSchedule: packSchedule,
    // exposed for tests / UI helpers
    _byId: byId,
    _clockMin: clockMin,
    _dowOf: dowOf,
    _addDays: addDays
  };

  if (typeof window !== 'undefined') window.CXC = CXC;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXC;
})();
