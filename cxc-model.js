// ==========================================
// Construction Planner — production model + schedule packer (cxc-model.js)
//
// THE DOMAIN ENGINE. How long work takes, how much a shift window actually
// buys you, what blocks a crew, and how the two get matched onto dates.
//
// Rules this file lives by (they are why it will merge into cx-portal cleanly):
//   1. PURE. No DOM, no fetch, no localStorage, no Date.now(). Every function
//      takes data in and returns data out. That makes it testable headlessly
//      (tools/test_cxc_model.js) and reusable by any UI, now or after merge.
//   2. NOTHING HARD-CODED. Every rate, duration, crew size, mobilization
//      allowance and shift length lives in the `data` object that the caller
//      owns and the UI edits. cxc-data.js holds the seed and the CRUD helpers.
//   3. Namespaced `CXC` (classic <script>, window global) so it can be dropped
//      into cx-portal's index.html next to app.js without colliding.
//
// The dataset the whole app shares (see cxc-data.js for the shape and seed):
//   globals · locations · phases · activityTypes · materials · crews ·
//   vehicles · shiftPatterns · blackoutDates · scope
//
// Mirrors the shape of cx-portal's dynamic-testing allocator (_dynCascadeAllocate
// in app.js): duration-aware greedy packing into time windows, with changeover
// costs and an explicit "why didn't this get placed" answer for every item.
// ==========================================
(function () {
  'use strict';

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
  /** Whole days between two ISO dates (b - a). */
  function daysBetween(a, b) {
    var pa = String(a).split('-'), pb = String(b).split('-');
    var da = Date.UTC(+pa[0], (+pa[1] || 1) - 1, +pa[2] || 1);
    var db = Date.UTC(+pb[0], (+pb[1] || 1) - 1, +pb[2] || 1);
    return Math.round((db - da) / 86400000);
  }
  /** ISO date string, or '' — used so blank availability means "no limit". */
  function dateOr(v, fallback) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback;
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
   * @param {object} win  {date, patternId, overrides?}
   * @param {object} data
   * @returns {{gross:number, mobilize:number, breaks:number, contingency:number, productive:number}}
   */
  function windowBudget(win, data) {
    var d = data || {};
    var g = d.globals || {};
    var pattern = byId(d.shiftPatterns, win && win.patternId) || {};
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
   * @param {object} data
   * @param {number} [qty] override quantity (defaults to item.qty)
   * @returns {{minutes:number, work:number, setup:number, type:object|null}}
   */
  function taskMinutes(item, crew, data, qty) {
    var d = data || {};
    var g = d.globals || {};
    var type = byId(d.activityTypes, item && item.activityTypeId);
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

  // ── Materials ────────────────────────────────────────────────────────────
  /**
   * Material lines an activity consumes, resolved against the material list.
   * @param {object} type activity type
   * @param {object} data
   * @returns {Array<{material:object, qtyPerUnit:number}>}
   */
  function activityMaterials(type, data) {
    var out = [];
    var lines = (type && type.materials) || [];
    for (var i = 0; i < lines.length; i++) {
      var m = byId((data || {}).materials, lines[i] && lines[i].materialId);
      if (m) out.push({ material: m, qtyPerUnit: num(lines[i].qtyPerUnit, 0) });
    }
    return out;
  }

  /**
   * Earliest date every material for an activity is on site. '' = no constraint.
   * A crew cannot install what has not been delivered.
   * @param {object} type
   * @param {object} data
   * @returns {string} ISO date or ''
   */
  function materialReadyDate(type, data) {
    var ready = '';
    activityMaterials(type, data).forEach(function (line) {
      var from = dateOr(line.material.availableFrom, '');
      if (from && from > ready) ready = from;
    });
    return ready;
  }

  /**
   * Largest quantity of an item the remaining material stock allows.
   * A material with a blank/zero `onHand` is treated as unlimited (not yet
   * being tracked), so the constraint is opt-in per material.
   * @param {object} type
   * @param {object} data
   * @param {object} consumed  materialId → qty already committed
   * @returns {number} Infinity when nothing limits it
   */
  function materialQtyCap(type, data, consumed) {
    var cap = Infinity;
    activityMaterials(type, data).forEach(function (line) {
      var onHand = num(line.material.onHand, 0);
      if (!onHand || onHand <= 0) return;              // untracked = unlimited
      if (line.qtyPerUnit <= 0) return;
      var left = onHand - num(consumed[line.material.id], 0);
      cap = Math.min(cap, left / line.qtyPerUnit);
    });
    return cap;
  }

  // ── Vehicles ─────────────────────────────────────────────────────────────
  /** Is this vehicle in service on the given date? Blank dates = always. */
  function vehicleAvailableOn(vehicle, isoDate) {
    if (!vehicle) return false;
    if (vehicle.status && vehicle.status !== 'active') return false;
    var from = dateOr(vehicle.availableFrom, '');
    var to = dateOr(vehicle.availableTo, '');
    if (from && isoDate < from) return false;
    if (to && isoDate > to) return false;
    return true;
  }

  /**
   * Can this crew field its vehicles in this window? A vehicle serves ONE crew
   * per window, so two crews sharing a hi-rail cannot both work that night.
   * @param {object} crew
   * @param {object} data
   * @param {string} isoDate
   * @param {object} takenIds  vehicleId → true, already claimed this window
   * @returns {{ok:boolean, reason:string, vehicleIds:string[]}}
   */
  function crewVehiclesFor(crew, data, isoDate, takenIds) {
    var ids = (crew && crew.vehicleIds) || [];
    if (!ids.length) return { ok: true, reason: '', vehicleIds: [] };
    for (var i = 0; i < ids.length; i++) {
      var v = byId((data || {}).vehicles, ids[i]);
      if (!v) return { ok: false, reason: 'vehicle missing from the fleet', vehicleIds: [] };
      if (!vehicleAvailableOn(v, isoDate)) return { ok: false, reason: v.name + ' is not in service', vehicleIds: [] };
      if (takenIds[v.id]) return { ok: false, reason: v.name + ' is already committed this window', vehicleIds: [] };
    }
    return { ok: true, reason: '', vehicleIds: ids.slice() };
  }

  // ── Phases ───────────────────────────────────────────────────────────────
  /** Sequence number of an item's phase (unsequenced sorts last). */
  function phaseSeq(item, data) {
    var p = byId((data || {}).phases, item && item.phaseId);
    return p ? num(p.seq, 0) : 0;
  }

  /**
   * With `globals.enforcePhaseOrder`, work at a location cannot start until
   * every earlier phase AT THAT LOCATION is complete — the rule a superintendent
   * applies without thinking, and the reason a plan is not just a sorted list.
   */
  function phaseBlocked(item, data, items, remaining) {
    if (!(data.globals || {}).enforcePhaseOrder) return false;
    var seq = phaseSeq(item, data);
    for (var i = 0; i < items.length; i++) {
      var other = items[i];
      if (other.id === item.id) continue;
      if (remaining[other.id] <= 0) continue;
      if (other.locationId !== item.locationId) continue;
      if (phaseSeq(other, data) < seq) return true;
    }
    return false;
  }

  // ── Window generation ────────────────────────────────────────────────────
  /**
   * Expand shift patterns into dated windows across a date range. This is the
   * "map to a schedule" step: patterns describe the access agreement, windows
   * are the actual nights on the calendar.
   * @param {string} fromDate "YYYY-MM-DD" inclusive
   * @param {string} toDate   "YYYY-MM-DD" inclusive
   * @param {object} data
   * @param {string[]} [patternIds] restrict to these patterns (default: all)
   * @returns {Array<{id:string, date:string, patternId:string, name:string, kind:string}>}
   */
  function generateWindows(fromDate, toDate, data, patternIds) {
    var d = data || {};
    var blackout = {};
    (d.blackoutDates || []).forEach(function (x) { blackout[x] = true; });
    var pats = (d.shiftPatterns || []).filter(function (p) {
      return !patternIds || patternIds.indexOf(p.id) !== -1;
    });

    var out = [];
    var guard = 0;
    for (var day = fromDate; day <= toDate && guard < 4000; day = addDays(day, 1), guard++) {
      if (blackout[day]) continue;
      var dow = dowOf(day);
      for (var i = 0; i < pats.length; i++) {
        var p = pats[i];
        var days = p.daysOfWeek || [];
        if (days.length && days.indexOf(dow) === -1) continue;
        out.push({ id: p.id + '@' + day, date: day, patternId: p.id, name: p.name, kind: p.kind || '' });
      }
    }
    return out;
  }

  // ── Schedule packer ──────────────────────────────────────────────────────
  /**
   * Greedily pack work items into windows, chronologically, per crew.
   *
   * What gates a placement, in the order a superintendent would ask:
   *  • Is the crew qualified (`skills`) and free of a pin to another crew?
   *  • Can the crew field its VEHICLES that night (in service, not already
   *    committed to another crew in the same window)?
   *  • Are the MATERIALS on site by that date, and is there stock left?
   *  • Are the item's explicit prerequisites complete?
   *  • Is an earlier PHASE still open at the same location?
   *  • Does any of it fit in the productive minutes that remain?
   *
   * Each crew gets its own budget within a window (crews work in parallel),
   * capped by the pattern's maxCrews and by vehicle contention. Work is placed
   * partially per the activity's `divisible` setting; moving a crew to another
   * location inside a window costs `globals.relocationMin`. Anything left over
   * comes back in `unplaced` WITH A REASON — never drop an item silently.
   *
   * @param {object} input
   * @param {Array} input.items   scope items (defaults to data.scope)
   * @param {Array} input.windows from generateWindows()
   * @param {object} input.data
   * @returns {{assignments:Array, unplaced:Array, windows:Array, materials:Array, summary:object}}
   */
  function packSchedule(input) {
    input = input || {};
    var data = input.data || {};
    var g = data.globals || {};
    var crews = data.crews || [];
    var windows = (input.windows || []).slice().sort(function (x, y) {
      return String(x.date).localeCompare(String(y.date)) ||
             String(x.patternId).localeCompare(String(y.patternId));
    });

    var items = (input.items || data.scope || []).filter(function (it) { return it && it.id; });
    var remaining = {};
    items.forEach(function (it) { remaining[it.id] = num(it.qty, 0); });

    var consumed = {};        // materialId → qty committed by the plan
    var assignments = [];
    var windowRows = [];
    var blockNote = {};       // itemId → most recent hard block, for the reason column

    for (var w = 0; w < windows.length; w++) {
      var win = windows[w];
      var pattern = byId(data.shiftPatterns, win.patternId) || {};
      var budget = windowBudget(win, data);

      // Crews cleared for this pattern, capped by the pattern's crew limit.
      var winCrews = crews.filter(function (c) {
        var ids = c.shiftPatternIds || [];
        return ids.length === 0 || ids.indexOf(win.patternId) !== -1;
      });
      var maxCrews = num(pattern.maxCrews, winCrews.length);
      winCrews = winCrews.slice(0, Math.max(0, maxCrews));

      var takenVehicles = {};
      var winUsed = 0;
      var workingCrews = 0;

      for (var ci = 0; ci < winCrews.length; ci++) {
        var crew = winCrews[ci];

        // Vehicles first: no truck, no crew.
        var veh = crewVehiclesFor(crew, data, win.date, takenVehicles);
        if (!veh.ok) continue;
        veh.vehicleIds.forEach(function (id) { takenVehicles[id] = true; });
        workingCrews++;

        var left = budget.productive;
        var atLocation = null;

        for (;;) {
          if (left <= 0) break;

          var best = null, bestCost = null;
          for (var ii = 0; ii < items.length; ii++) {
            var it = items[ii];
            if (remaining[it.id] <= 0) continue;
            if (it.crewId && it.crewId !== crew.id) continue;
            if (!crewCanDo(crew, it.activityTypeId)) continue;

            var type = byId(data.activityTypes, it.activityTypeId);
            if (!type) continue;

            // Materials on site by this date?
            var ready = materialReadyDate(type, data);
            if (ready && win.date < ready) { blockNote[it.id] = 'material not on site until ' + ready; continue; }

            // Stock left to draw against?
            var matCap = materialQtyCap(type, data, consumed);
            if (matCap <= 0) { blockNote[it.id] = 'material stock exhausted'; continue; }

            if (!prereqsDone(it, remaining)) continue;
            if (phaseBlocked(it, data, items, remaining)) continue;

            var move = (atLocation !== null && it.locationId !== atLocation) ? num(g.relocationMin, 0) : 0;
            var wantQty = Math.min(remaining[it.id], matCap === Infinity ? remaining[it.id] : matCap);
            if (wantQty <= 0) continue;
            var full = taskMinutes(it, crew, data, wantQty).minutes + move;

            var cost;
            if (full <= left) cost = full;
            else if (divisibility(type) === 'none') continue;  // must fit one window
            else cost = left;                                  // partial fill

            // Prefer staying put, then the item that consumes the most window.
            if (!best || (move === 0 && bestCost && bestCost.move > 0) || cost > bestCost.cost) {
              best = it;
              bestCost = { cost: cost, move: move, type: type, full: full, wantQty: wantQty, matCap: matCap };
            }
          }
          if (!best) break;

          var avail = left - bestCost.move;
          if (avail <= 0) break;

          var placedQty, usedMin;
          if (bestCost.full <= left) {
            placedQty = bestCost.wantQty;
            usedMin = bestCost.full;
          } else {
            // Partial: subtract setup once, then convert the rest to quantity.
            var probe = taskMinutes(best, crew, data, bestCost.wantQty);
            var perUnit = probe.work / Math.max(1e-9, bestCost.wantQty);
            var qty = (avail - probe.setup) / Math.max(1e-9, perUnit);
            // 'unit' work only breaks at whole devices; 'continuous' rounds to a
            // sane precision so a plan never reads "137.4183 lf".
            qty = divisibility(bestCost.type) === 'unit'
              ? Math.floor(qty)
              : Math.floor(qty * 10) / 10;
            qty = Math.min(qty, bestCost.wantQty);
            if (qty <= 0) break;             // not even one unit fits — end crew's shift
            placedQty = qty;
            usedMin = taskMinutes(best, crew, data, placedQty).minutes + bestCost.move;
          }

          // Draw the materials this placement consumes.
          activityMaterials(bestCost.type, data).forEach(function (line) {
            consumed[line.material.id] = num(consumed[line.material.id], 0) + placedQty * line.qtyPerUnit;
          });

          assignments.push({
            windowId: win.id,
            date: win.date,
            patternId: win.patternId,
            windowName: win.name,
            crewId: crew.id,
            crewName: crew.name,
            vehicleIds: veh.vehicleIds,
            itemId: best.id,
            locationId: best.locationId || '',
            phaseId: best.phaseId || '',
            activityTypeId: best.activityTypeId,
            activityName: bestCost.type.name,
            qty: placedQty,
            unit: bestCost.type.unit,
            minutes: usedMin,
            relocationMin: bestCost.move,
            partial: placedQty < remaining[best.id]
          });

          remaining[best.id] -= placedQty;
          if (remaining[best.id] < 0.05) remaining[best.id] = 0;   // float dust
          left -= usedMin;
          winUsed += usedMin;
          atLocation = best.locationId;
        }
      }

      var capacity = budget.productive * workingCrews;
      windowRows.push({
        id: win.id, date: win.date, patternId: win.patternId, name: win.name,
        gross: budget.gross, mobilize: budget.mobilize, productive: budget.productive,
        crewCount: workingCrews,
        capacity: capacity,
        used: winUsed,
        utilization: capacity > 0 ? Math.round((winUsed / capacity) * 100) : 0
      });
    }

    // Everything still carrying quantity, with the reason it never landed.
    var unplaced = items.filter(function (it) { return remaining[it.id] > 0; }).map(function (it) {
      return {
        itemId: it.id,
        locationId: it.locationId || '',
        phaseId: it.phaseId || '',
        activityTypeId: it.activityTypeId,
        remainingQty: remaining[it.id],
        reason: unplacedReason(it, remaining, data, windows, items, blockNote)
      };
    });

    // Material take-off: what the plan actually draws, against what is on hand.
    var materials = (data.materials || []).map(function (m) {
      var need = num(consumed[m.id], 0);
      var onHand = num(m.onHand, 0);
      return {
        materialId: m.id, code: m.code, name: m.name, unit: m.unit,
        required: Math.round(need * 100) / 100,
        onHand: onHand,
        shortfall: onHand > 0 ? Math.max(0, Math.round((need - onHand) * 100) / 100) : 0,
        availableFrom: m.availableFrom || ''
      };
    });

    var totalMin = assignments.reduce(function (s, x) { return s + x.minutes; }, 0);
    return {
      assignments: assignments,
      unplaced: unplaced,
      windows: windowRows,
      materials: materials,
      summary: {
        itemCount: items.length,
        completeCount: items.length - unplaced.length,
        windowCount: windowRows.length,
        windowsUsed: windowRows.filter(function (x) { return x.used > 0; }).length,
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
  function unplacedReason(item, remaining, data, windows, items, blockNote) {
    var type = byId(data.activityTypes, item.activityTypeId);
    if (!type) return 'unknown activity type "' + item.activityTypeId + '"';
    if (!prereqsDone(item, remaining)) return 'prerequisite not complete';
    if (phaseBlocked(item, data, items, remaining)) return 'an earlier phase is still open at this location';

    var qualified = (data.crews || []).filter(function (c) {
      return crewCanDo(c, item.activityTypeId) && (!item.crewId || item.crewId === c.id);
    });
    if (!qualified.length) return 'no crew qualified for ' + type.name;

    if (blockNote[item.id]) return blockNote[item.id];

    // The smallest indivisible chunk this activity can be placed in: the whole
    // scope for 'none', one unit for 'unit'. If even that never fits a window,
    // no amount of extra dates helps — the WINDOW is too short.
    var div = divisibility(type);
    if (div !== 'continuous') {
      var chunkQty = div === 'none' ? item.qty : 1;
      var fits = windows.some(function (win) {
        var b = windowBudget(win, data);
        return qualified.some(function (c) {
          return taskMinutes(item, c, data, chunkQty).minutes <= b.productive;
        });
      });
      if (!fits) {
        var need = taskMinutes(item, qualified[0], data, chunkQty).minutes;
        return 'no window long enough — ' +
          (div === 'none' ? 'this activity must finish in one window and' : 'a single ' + type.unit) +
          ' needs ' + need + ' min of productive time';
      }
    }
    return 'ran out of window capacity in the date range';
  }

  // ── Exports ──────────────────────────────────────────────────────────────
  var CXC = {
    grossWindowMinutes: grossWindowMinutes,
    windowBudget: windowBudget,
    crewFactor: crewFactor,
    taskMinutes: taskMinutes,
    divisibility: divisibility,
    crewCanDo: crewCanDo,
    activityMaterials: activityMaterials,
    materialReadyDate: materialReadyDate,
    materialQtyCap: materialQtyCap,
    vehicleAvailableOn: vehicleAvailableOn,
    crewVehiclesFor: crewVehiclesFor,
    phaseSeq: phaseSeq,
    generateWindows: generateWindows,
    packSchedule: packSchedule,
    // shared helpers the UI and sibling modules reuse
    byId: byId,
    num: num,
    clockMin: clockMin,
    dowOf: dowOf,
    addDays: addDays,
    daysBetween: daysBetween
  };

  if (typeof window !== 'undefined') window.CXC = CXC;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXC;
})();
