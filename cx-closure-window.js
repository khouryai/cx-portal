// ==========================================
// HITACHI Rail T&C Portal — Weekend / line-closure access block
// (cx-closure-window.js)
//
// A planned closure is ONE CONTINUOUS POSSESSION — e.g. Friday 21:00 straight
// through to Monday 04:00 — not a stack of per-day shifts a planner has to
// re-enter as 00:00–23:59 on each calendar day. This module gives the access
// campaign a first-class closure block:
//
//   • a BLANKET default (like Non-Revenue Hours) — start day + time, end day +
//     time, optional productive-test-hours cap — persisted per planner in
//     localStorage, editable from the campaign modal's gear;
//   • a PER-CAMPAIGN override stored on the campaign under
//     `day_schedule.closure` (a non-numeric key the 0–6 per-day readers ignore,
//     so this ships with NO schema migration);
//   • ONE zone_access_windows row per weekend spanning the whole block, so the
//     Access Plan, the allocator and the Lookahead all see a single continuous
//     window instead of N daily fragments.
//
// The closure block COEXISTS with the per-day rows: a campaign can run Tue/Wed
// non-revenue shifts AND a Fri→Mon closure each week. Selecting the "Weekend /
// line closure" access type parks the per-day rows (restoring them if the
// planner switches back) so the clean block is what you get by default.
//
// CAPACITY. A 55 h possession is 55 h of ACCESS but rarely 55 h of testing —
// crews work shifts. `productiveHours` caps what the allocator packs against
// while the calendar keeps the honest possession length. Blank = full block.
//
// References app.js globals (_dynPage, _dynDayKey, _dynAddDays, _dynParseDate,
// _dynCampZonePalette, _dynCampRerenderDays, currentRoleUser, icon, escapeHtml,
// cxAlert, toast) by name — they resolve at call time, so load order vs app.js
// does not matter. Loaded after app.js alongside the other cx-dyn-* modules.
// ==========================================
(function () {
  'use strict';

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var STORE_KEY = 'dynClosureWindow';

  // Fri 21:00 → Mon 04:00, whole block productive unless the planner caps it.
  var DEFAULTS = {
    startDow: 5, startTime: '21:00',
    endDow: 1, endTime: '04:00',
    productiveHours: null,     // null = the full possession is testable
    zones: [],                 // empty = every zone on the campaign
  };

  // ── small helpers (self-contained so the module is testable headless) ──────
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isTime(t) { return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t); }
  function isDow(d) { return Number.isInteger(d) && d >= 0 && d <= 6; }
  function minsOf(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function dayKey(d) {
    if (typeof d === 'string') return d.slice(0, 10);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function parseDate(s) {
    if (s instanceof Date) return new Date(s.getTime());
    var p = String(s).slice(0, 10).split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }
  // Local wall-clock Date for "YYYY-MM-DD" + "HH:MM" (never UTC — a possession
  // is defined in the railway's local time, and DST must shift with it).
  function at(dateStr, hhmm) {
    var d = parseDate(dateStr), p = String(hhmm).split(':');
    d.setHours(+p[0], +p[1], 0, 0);
    return d;
  }

  // ── the stored blanket default ────────────────────────────────────────────
  function normalize(w) {
    var d = clone(DEFAULTS);
    if (!w || typeof w !== 'object') return d;
    if (isDow(w.startDow)) d.startDow = w.startDow;
    if (isDow(w.endDow)) d.endDow = w.endDow;
    if (isTime(w.startTime)) d.startTime = w.startTime;
    if (isTime(w.endTime)) d.endTime = w.endTime;
    var ph = parseFloat(w.productiveHours);
    d.productiveHours = (Number.isFinite(ph) && ph > 0) ? ph : null;
    d.zones = Array.isArray(w.zones) ? w.zones.slice() : [];
    return d;
  }
  function settings() {
    try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
    catch (e) { return clone(DEFAULTS); }
  }
  function saveSettings(w) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(normalize(w))); } catch (e) {}
  }

  // ── block geometry ────────────────────────────────────────────────────────
  // Whole days from the block's start day to its end day. Same day-of-week with
  // an end time at or before the start time means a FULL week-long possession.
  function spanDays(w) {
    w = normalize(w);
    var n = (w.endDow - w.startDow + 7) % 7;
    if (n === 0 && minsOf(w.endTime) <= minsOf(w.startTime)) n = 7;
    return n;
  }
  function blockMinutes(w) {
    w = normalize(w);
    return spanDays(w) * 1440 - minsOf(w.startTime) + minsOf(w.endTime);
  }
  function blockHours(w) { return blockMinutes(w) / 60; }
  // Minutes the allocator may pack into the block (the productive-hours cap,
  // never more than the possession itself).
  function productiveBlockMinutes(w) {
    w = normalize(w);
    var full = blockMinutes(w);
    return w.productiveHours ? Math.min(full, Math.round(w.productiveHours * 60)) : full;
  }
  function fmtHours(m) {
    var h = m / 60;
    return (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') + ' h';
  }
  // "Fri 21:00 → Mon 04:00" — the label a planner recognises at a glance.
  function windowLabel(w) {
    w = normalize(w);
    return DOW[w.startDow] + ' ' + w.startTime + ' → ' + DOW[w.endDow] + ' ' + w.endTime;
  }

  function validate(w) {
    w = normalize(w);
    var m = blockMinutes(w);
    if (m <= 0) return 'Weekend closure: the block must end after it starts.';
    if (m > 14 * 1440) return 'Weekend closure: a block longer than 14 days is almost certainly a mistake.';
    if (w.productiveHours != null && w.productiveHours * 60 > m) {
      return 'Weekend closure: productive hours (' + w.productiveHours + ' h) exceed the ' + fmtHours(m) + ' block.';
    }
    return null;
  }

  // ── campaign plumbing ─────────────────────────────────────────────────────
  function isClosure(camp) {
    return !!(camp && camp.campaign_kind === 'closure' && campWindow(camp));
  }
  // The closure block stored on a campaign, or null. Lives under the
  // non-numeric `closure` key of day_schedule so every 0–6 per-day reader
  // ignores it and no column had to be added.
  function campWindow(camp) {
    var sched = (camp && camp.day_schedule) || {};
    var w = sched.closure || sched.Closure;
    return w ? normalize(w) : null;
  }
  function summaryLabel(camp) {
    var w = campWindow(camp);
    if (!w) return '';
    var full = blockMinutes(w), prod = productiveBlockMinutes(w);
    return windowLabel(w) + ' · ' + fmtHours(full) + ' closure'
      + (prod < full ? ' (' + fmtHours(prod) + ' testable)' : '');
  }

  // ── shift generation ──────────────────────────────────────────────────────
  // ONE row per occurrence of the block's start day inside the campaign's date
  // range. shift_date is the START date, so the reconcile key stays unique per
  // weekend and an edited campaign updates the block instead of duplicating it.
  function generateShiftRows(campaign) {
    var w = campWindow(campaign);
    if (!campaign || !w || validate(w)) return [];
    var start = parseDate(campaign.start_date);
    var end = parseDate(campaign.end_date);
    if (!(start <= end)) return [];
    var zones = (w.zones && w.zones.length) ? w.zones.slice() : (campaign.zone_codes || []).slice();
    if (!zones.length) return [];
    var by = (typeof currentRoleUser !== 'undefined' && currentRoleUser)
      ? (currentRoleUser.email || currentRoleUser.id || null) : null;
    var rows = [];
    for (var d = new Date(start.getTime()); d <= end; d = addDays(d, 1)) {
      if (d.getDay() !== w.startDow) continue;
      var dateStr = dayKey(d);
      var startAt = at(dateStr, w.startTime);
      var endAt = at(dayKey(addDays(d, spanDays(w))), w.endTime);
      rows.push({
        control_zone_code: zones[0],
        access_zones: zones,
        shift_date: dateStr,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        allowed_modes: campaign.allowed_modes || ['CBTC', 'VATC'],
        max_trains: campaign.trains_requested || 1,
        consist_size: campaign.consist_size || null,
        available_consists: { sizes: (campaign.required_consists && campaign.required_consists.sizes) || [] },
        subsystem: campaign.subsystem || null,
        campaign_id: campaign.id,
        status: 'planned',
        created_by: by,
      });
    }
    return rows;
  }

  // ── recognising a generated block again ───────────────────────────────────
  function campaignOf(w) {
    if (!w || !w.campaign_id) return null;
    var page = (typeof _dynPage !== 'undefined' && _dynPage) ? _dynPage : null;
    if (!page || !page.campaigns) return null;
    for (var i = 0; i < page.campaigns.length; i++) {
      if (String(page.campaigns[i].id) === String(w.campaign_id)) return page.campaigns[i];
    }
    return null;
  }
  // A window IS the campaign's closure block when it starts on the block's day
  // at the block's time and runs the block's length. Structural, so it needs no
  // marker column on zone_access_windows.
  function isClosureWindow(win, camp) {
    if (!win || !win.start_at || !win.end_at) return false;
    var c = camp || campaignOf(win);
    var w = c ? campWindow(c) : null;
    if (!c || !w || c.campaign_kind !== 'closure') return false;
    var s = new Date(win.start_at);
    if (s.getDay() !== w.startDow) return false;
    if (pad2(s.getHours()) + ':' + pad2(s.getMinutes()) !== w.startTime) return false;
    var mins = (new Date(win.end_at) - s) / 60000;
    return Math.abs(mins - blockMinutes(w)) < 1;
  }
  // Capacity the allocator sees for a window: the productive-hours cap on a
  // closure block, the raw possession everywhere else.
  function productiveMinutes(win, rawMinutes) {
    if (!isClosureWindow(win)) return rawMinutes;
    var w = campWindow(campaignOf(win));
    return w && w.productiveHours ? Math.min(rawMinutes, Math.round(w.productiveHours * 60)) : rawMinutes;
  }
  // Every calendar day a window touches — so a continuous block paints across
  // the whole weekend on the Access Plan instead of hiding in its start cell.
  function coveredDayKeys(win) {
    var first = win && win.shift_date ? dayKey(win.shift_date) : null;
    if (!first) return [];
    if (!win.start_at || !win.end_at) return [first];
    var s = new Date(win.start_at), e = new Date(win.end_at);
    if (!(e > s)) return [first];
    var keys = [], cur = parseDate(dayKey(s)), last = dayKey(e);
    // An end exactly at midnight belongs to the previous day, not the next one.
    if (e.getHours() === 0 && e.getMinutes() === 0) last = dayKey(addDays(e, -1));
    for (var guard = 0; guard < 16; guard++) {
      keys.push(dayKey(cur));
      if (dayKey(cur) === last) break;
      cur = addDays(cur, 1);
    }
    return keys.length ? keys : [first];
  }
  // Chip label for a block that crosses midnight: the plain HH:MM–HH:MM a
  // one-day shift shows would read as a 7-hour window, not a 55-hour one.
  function spanLabel(win) {
    if (!win || !win.start_at || !win.end_at) return '';
    var s = new Date(win.start_at), e = new Date(win.end_at);
    if (dayKey(s) === dayKey(e)) return '';
    var t = function (d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
    return DOW[s.getDay()] + ' ' + t(s) + ' → ' + DOW[e.getDay()] + ' ' + t(e);
  }

  // ── campaign-modal editor ─────────────────────────────────────────────────
  // Live edit state for the open modal (mirrors window._dynCampDays).
  function current() {
    if (!window._dynCampClosure) window._dynCampClosure = settings();
    return window._dynCampClosure;
  }
  function setCurrent(w) { window._dynCampClosure = normalize(w); return window._dynCampClosure; }
  // Seed the editor when an existing campaign is opened: its own block if it has
  // one, otherwise the planner's blanket default.
  // Also clears the parked per-day rows, so a stale "switch back to standard"
  // from a previous (possibly cancelled) modal can't restore into this one.
  function loadFromCampaign(camp) {
    window._dynCampDaysBeforeClosure = null;
    setCurrent(campWindow(camp) || settings());
  }

  function kindIsClosure() {
    var el = document.getElementById('camp-kind');
    return !!(el && el.value === 'closure');
  }
  function palette() {
    return (typeof _dynCampZonePalette === 'function') ? _dynCampZonePalette() : [];
  }
  function esc(s) {
    return (typeof escapeHtml === 'function') ? escapeHtml(String(s))
      : String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function ico(name) { return (typeof icon === 'function') ? icon(name) : ''; }

  function editorHtml() {
    if (!kindIsClosure()) return '';
    var w = current();
    var pal = palette();
    var sel = (w.zones && w.zones.length) ? w.zones : pal;
    var selSet = {};
    sel.forEach(function (z) { selSet[z] = true; });
    var full = blockMinutes(w), prod = productiveBlockMinutes(w);
    var err = validate(w);
    var inp = 'padding:5px 6px;border:1px solid var(--border);border-radius:5px;font-size:12px;width:100%;min-width:0;box-sizing:border-box;';
    var grid = 'display:grid;grid-template-columns:74px minmax(0,1fr) minmax(0,1fr);align-items:center;gap:8px;';
    var dowOpts = function (v) {
      return DOW.map(function (n, i) {
        return '<option value="' + i + '"' + (i === v ? ' selected' : '') + '>' + n + '</option>';
      }).join('');
    };
    var zoneCtl = pal.length
      ? pal.map(function (z) {
        return '<label style="font-size:11px;margin-right:8px;white-space:nowrap;">'
          + '<input type="checkbox" class="camp-closure-zone" value="' + esc(z) + '"'
          + (selSet[z] ? ' checked' : '') + ' ' + cxon('change', '_dynClosureZoneToggle') + '>' + esc(z) + '</label>';
      }).join('')
      : '<span style="font-size:11px;color:var(--text-muted);">choose campaign zones above ↑</span>';

    return '<div id="dyn-closure-block" style="margin-top:8px;padding:12px 14px;background:var(--surface-2);'
      + 'border:1px solid var(--border);border-left:3px solid var(--accent-purple);border-radius:8px;">'
      + '<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;">'
      + ico('moon') + '<span>Weekend closure block — one continuous possession, not one shift per day</span></div>'
      + '<div style="' + grid + 'margin-bottom:3px;font-size:10px;color:var(--text-muted);">'
      + '<span></span><span>Day</span><span>Time</span></div>'
      + '<div style="' + grid + 'margin-bottom:6px;"><span style="font-size:12px;color:var(--text);">Opens</span>'
      + '<select id="closure-start-dow" style="' + inp + '" ' + cxon('change', '_dynClosureSet', 'startDow', '$cx.value') + '>' + dowOpts(w.startDow) + '</select>'
      + '<input type="time" id="closure-start-time" value="' + esc(w.startTime) + '" style="' + inp + '" ' + cxon('change', '_dynClosureSet', 'startTime', '$cx.value') + '></div>'
      + '<div style="' + grid + 'margin-bottom:6px;"><span style="font-size:12px;color:var(--text);">Reopens</span>'
      + '<select id="closure-end-dow" style="' + inp + '" ' + cxon('change', '_dynClosureSet', 'endDow', '$cx.value') + '>' + dowOpts(w.endDow) + '</select>'
      + '<input type="time" id="closure-end-time" value="' + esc(w.endTime) + '" style="' + inp + '" ' + cxon('change', '_dynClosureSet', 'endTime', '$cx.value') + '></div>'
      + '<div style="' + grid + 'margin-bottom:6px;"><span style="font-size:12px;color:var(--text);">Testable</span>'
      + '<input type="number" id="closure-prod-hours" min="0.5" step="0.5" placeholder="all ' + fmtHours(full) + '"'
      + ' value="' + (w.productiveHours == null ? '' : esc(w.productiveHours)) + '" style="' + inp + '" '
      + cxon('change', '_dynClosureSet', 'productiveHours', '$cx.value') + '>'
      + '<span style="font-size:10.5px;color:var(--text-muted);">hours the allocator may fill — blank = the whole block</span></div>'
      + '<div style="font-size:11px;color:var(--text-muted);margin:8px 0 6px;">Zones in the block</div>'
      + '<div style="margin-bottom:8px;">' + zoneCtl + '</div>'
      + '<div id="closure-readout" style="font-size:11.5px;font-weight:600;color:' + (err ? 'var(--bad)' : 'var(--accent-purple)') + ';">'
      + (err ? esc(err) : esc(windowLabel(w) + ' · ' + fmtHours(full) + ' continuous'
        + (prod < full ? ' · ' + fmtHours(prod) + ' testable' : '')))
      + '</div>'
      + '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">'
      + '<button type="button" class="dyn-btn" style="font-size:11px;padding:4px 12px;" data-action="_dynClosureSaveDefault">Save as my default</button>'
      + '<button type="button" class="dyn-btn" style="font-size:11px;padding:4px 12px;margin-left:auto;" data-action="_dynClosureResetDefault">Reset to default</button>'
      + '</div></div>';
  }

  function cxon(evt, name) {
    if (typeof cxOn === 'function') return cxOn.apply(null, arguments);
    return 'data-' + evt + '="' + name + '"';
  }

  function rerender() {
    var el = document.getElementById('camp-closure-wrap');
    if (el) el.innerHTML = editorHtml();
  }
  // Editing a field must NOT blow the panel away: a `change` fires as the input
  // blurs, and replacing the subtree mid-blur both throws in the browser and
  // steals focus from the planner mid-edit. Repaint only the derived bits.
  function refreshReadout() {
    var out = document.getElementById('closure-readout');
    if (!out) return;
    var w = current(), err = validate(w);
    var full = blockMinutes(w), prod = productiveBlockMinutes(w);
    out.style.color = err ? 'var(--bad)' : 'var(--accent-purple)';
    out.textContent = err || (windowLabel(w) + ' \u00b7 ' + fmtHours(full) + ' continuous'
      + (prod < full ? ' \u00b7 ' + fmtHours(prod) + ' testable' : ''));
    var ph = document.getElementById('closure-prod-hours');
    if (ph) ph.placeholder = 'all ' + fmtHours(full);
  }
  // Keep the block's zone set inside the campaign's zone palette as it changes.
  function syncZones() {
    var pal = palette();
    if (!pal.length) return;
    var w = current();
    var kept = (w.zones || []).filter(function (z) { return pal.indexOf(z) >= 0; });
    w.zones = kept.length ? kept : pal.slice();
  }

  // ── save path ─────────────────────────────────────────────────────────────
  // Fold the block into the campaign being saved: validates, writes
  // day_schedule.closure and contributes its zones to the campaign's zone set.
  // Returns false (after alerting) when the block is invalid.
  function applyToSave(daySchedule, zoneUnion, zonePalette) {
    if (!kindIsClosure()) return true;
    syncZones();
    var w = normalize(current());
    var err = validate(w);
    if (err) { if (typeof cxAlert === 'function') cxAlert(err); return false; }
    var zones = (w.zones && w.zones.length) ? w.zones : (zonePalette || []);
    if (!zones.length) {
      if (typeof cxAlert === 'function') cxAlert('Weekend closure: pick at least one zone for the block.');
      return false;
    }
    w.zones = zones.slice();
    daySchedule.closure = w;
    zones.forEach(function (z) { zoneUnion.add(z); });
    return true;
  }

  // ── delegated handlers (globals; resolved by cx-actions at event time) ─────
  // Switching access type parks / restores the per-day rows so a closure
  // campaign starts as the clean continuous block the planner asked for.
  window._dynCampKindChange = function (val) {
    var days = window._dynCampDays || {};
    if (val === 'closure') {
      if (!window._dynCampDaysBeforeClosure) {
        window._dynCampDaysBeforeClosure = clone(days);
        Object.keys(days).forEach(function (d) { days[d].on = false; });
      }
      syncZones();
    } else if (window._dynCampDaysBeforeClosure) {
      window._dynCampDays = window._dynCampDaysBeforeClosure;
      window._dynCampDaysBeforeClosure = null;
    }
    if (typeof _dynCampRerenderDays === 'function') _dynCampRerenderDays();
    rerender();
  };
  window._dynClosureSet = function (field, val) {
    var w = current();
    if (field === 'startDow' || field === 'endDow') w[field] = parseInt(val, 10) || 0;
    else if (field === 'productiveHours') {
      var n = parseFloat(val);
      w.productiveHours = (Number.isFinite(n) && n > 0) ? n : null;
    } else w[field] = val;
    refreshReadout();
  };
  window._dynClosureZoneToggle = function () {
    var boxes = document.querySelectorAll('.camp-closure-zone:checked');
    current().zones = Array.prototype.map.call(boxes, function (b) { return b.value; });
    refreshReadout();
  };
  window._dynClosureSaveDefault = function () {
    var err = validate(current());
    if (err) { if (typeof cxAlert === 'function') cxAlert(err); return; }
    saveSettings(current());
    if (typeof toast === 'function') toast('Weekend closure default saved', 'success');
  };
  window._dynClosureResetDefault = function () {
    setCurrent(settings());
    syncZones();
    rerender();
  };

  window.CXClosure = {
    DEFAULTS: DEFAULTS,
    settings: settings, saveSettings: saveSettings, normalize: normalize, validate: validate,
    spanDays: spanDays, blockMinutes: blockMinutes, blockHours: blockHours,
    productiveBlockMinutes: productiveBlockMinutes, windowLabel: windowLabel, summaryLabel: summaryLabel,
    isClosure: isClosure, campWindow: campWindow,
    generateShiftRows: generateShiftRows,
    isClosureWindow: isClosureWindow, productiveMinutes: productiveMinutes,
    coveredDayKeys: coveredDayKeys, spanLabel: spanLabel,
    current: current, setCurrent: setCurrent, loadFromCampaign: loadFromCampaign,
    editorHtml: editorHtml, rerender: rerender, refreshReadout: refreshReadout, applyToSave: applyToSave,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = window.CXClosure;
})();
