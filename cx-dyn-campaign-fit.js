// ── Access-campaign "Test Case scope" fit panel ──────────────────────────────
// While creating/editing an access campaign, show — live, as the access/train
// constraints are edited — which dynamic test cases actually fit the shifts this
// campaign will generate, plus decision metrics so the planner can pick the best
// scope before hitting Create.
//
// Fit is computed with the SAME primitive the board schedules with
// (_dynWindowGrantsRun: access zones ⊆ shift, mode allowed, consist/trains fit),
// plus a duration check, so what's shown here is exactly what will be schedulable.
//
// Pure-ish: reads the live modal DOM + _dynPage.instances, calls app.js globals
// (_dynGenerateShiftRows, _dynWindowGrantsRun, _dynConsistFit, _dynConsistSizes,
// _dynShiftAvailConsists, _dynWinMinutes, _dynReadConsistSizes, _dynCampScopeItems).

const _DYN_CAMPFIT_RUN_MIN = 30;   // default run length when an instance has none

// Assemble a DRAFT campaign object from the open modal's current field values —
// mirrors _dynSaveCampaign's reads (minus validation) so the prospective shifts
// match what Create would actually generate. Returns null if the modal isn't up.
function _dynCampDraftFromForm() {
  const g = id => document.getElementById(id);
  if (!g('camp-start')) return null;
  const zonePalette = g('camp-zones') ? Array.from(g('camp-zones').selectedOptions).map(o => o.value) : [];
  const days = window._dynCampDays || {};
  const dow = Object.keys(days).map(Number).filter(d => days[d] && days[d].on).sort((a, b) => a - b);
  const daySchedule = {};
  for (const d of dow) {
    const sd = days[d];
    if (!sd || !sd.start || !sd.end || sd.end <= sd.start) continue;
    const dz = (sd.zones && sd.zones.length) ? sd.zones : zonePalette;
    if (!dz.length) continue;
    daySchedule[d] = { start: sd.start, end: sd.end, zones: dz };
  }
  const zones = [...new Set(Object.values(daySchedule).flatMap(s => s.zones))];
  const modes = Array.from(document.querySelectorAll('.camp-mode:checked')).map(c => c.value);
  const trains = parseInt(g('camp-trains') ? g('camp-trains').value : '', 10) || 1;
  const consistSizes = (typeof _dynReadConsistSizes === 'function')
    ? _dynReadConsistSizes('camp-consist-', trains) : Array(trains).fill(null);
  const base = dow.length && daySchedule[dow[0]] ? daySchedule[dow[0]] : null;
  return {
    id: '__draft__', zone_codes: zones,
    start_date: g('camp-start').value, end_date: g('camp-end').value,
    days_of_week: dow, day_schedule: daySchedule,
    shift_start: base ? base.start : '07:00', shift_end: base ? base.end : '15:00',
    allowed_modes: modes.length ? modes : ['CBTC', 'VATC'],
    trains_requested: trains, consist_size: consistSizes.find(x => x != null) ?? null,
    required_consists: { sizes: consistSizes },
  };
}

// Prospective shifts → { profiles, totalMin, shiftCount }. Profiles dedupe shifts
// by their granting signature (zones + modes + consists), keeping the LONGEST
// window per profile (for the duration check) and its zone count (for footprint),
// so a long date range with 1–3 day-types costs 1–3 fit checks per test case.
function _dynCampBuildFitCtx(shifts) {
  let totalMin = 0;
  const seen = new Map();
  for (const s of (shifts || [])) {
    const min = _dynWinMinutes(s); totalMin += min;
    const zones = (s.access_zones || []).slice().sort();
    const sig = JSON.stringify([zones, (s.allowed_modes || []).slice().sort(),
      (s.available_consists && s.available_consists.sizes) || [], s.max_trains || 1]);
    const cur = seen.get(sig);
    if (!cur) seen.set(sig, Object.assign({}, s, { _minutes: min, _zoneN: zones.length }));
    else if (min > cur._minutes) cur._minutes = min;
  }
  return { profiles: [...seen.values()], totalMin, shiftCount: (shifts || []).length };
}

// The open runs of a test case (instances still needing a pass; done/NA excluded).
function _dynCampCaseInstances(testId) {
  return (_dynPage.instances || []).filter(i =>
    i.test_id === testId && !['Pass', 'Not Applicable'].includes(i.status));
}

// Per-test-case fit + metrics against the prospective shift profiles.
function _dynCampFitForCase(testId, ctx) {
  const insts = _dynCampCaseInstances(testId);
  const profiles = ctx.profiles || [];
  const out = { total: insts.length, fit: 0, fitMin: 0, footSum: 0, util: 0, coverage: 0, footprint: 0,
    reasons: { zone: 0, mode: 0, trains: 0, dur: 0 }, missZones: new Set() };
  for (const i of insts) {
    const req = [...new Set((i.track_section_access_req || []).filter(Boolean))];
    const runMin = i.expected_duration_minutes || _DYN_CAMPFIT_RUN_MIN;
    let zoneOk = false, modeOk = false, consistOk = false, granted = false, bestZoneN = Infinity;
    for (const p of profiles) {
      const pz = p.access_zones || [];
      const aOk = req.every(z => pz.includes(z));
      if (!aOk) continue;
      zoneOk = true;
      const mOk = !i.required_mode || (p.allowed_modes || []).includes(i.required_mode);
      if (!mOk) continue;
      modeOk = true;
      const cOk = _dynConsistFit(_dynConsistSizes(i), _dynShiftAvailConsists(p)).ok;
      if (!cOk) continue;
      consistOk = true;
      if (runMin <= p._minutes) { granted = true; bestZoneN = Math.min(bestZoneN, p._zoneN); }
    }
    if (granted) {
      out.fit++; out.fitMin += runMin;
      out.footSum += Math.min(1, Math.max(1, req.length) / Math.max(1, bestZoneN));
    } else if (!zoneOk) { out.reasons.zone++; req.forEach(z => { if (!profiles.some(p => (p.access_zones || []).includes(z))) out.missZones.add(z); }); }
    else if (!modeOk) out.reasons.mode++;
    else if (!consistOk) out.reasons.trains++;
    else out.reasons.dur++;
  }
  out.coverage = out.total ? out.fit / out.total : 0;
  out.footprint = out.fit ? out.footSum / out.fit : 0;
  out.util = ctx.totalMin ? out.fitMin / ctx.totalMin : 0;
  return out;
}

// A short "why some runs don't fit" string + a fuller tooltip.
function _dynCampFitReason(m) {
  const parts = [];
  if (m.reasons.zone) parts.push(`${m.reasons.zone} need other zones${m.missZones.size ? ' (' + [...m.missZones].join(', ') + ')' : ''}`);
  if (m.reasons.mode) parts.push(`${m.reasons.mode} wrong mode`);
  if (m.reasons.trains) parts.push(`${m.reasons.trains} trains/consist`);
  if (m.reasons.dur) parts.push(`${m.reasons.dur} too long for window`);
  return parts.join(' · ');
}

function _dynCampMiniBar(pct, color) {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  return `<span style="display:inline-block;width:46px;height:5px;border-radius:3px;background:var(--gray-200);vertical-align:middle;overflow:hidden;"><span style="display:block;width:${w}%;height:100%;background:${color};"></span></span>`;
}

// The scope table: checkbox + test case + Fit + Utilization + Effectiveness.
// `q` filters by code/name. Sorted best-fit first so strong picks bubble up.
function _dynCampScopeTableHtml(q) {
  const items = (typeof _dynCampScopeItems === 'function') ? _dynCampScopeItems() : [];
  const sel = window._dynCampScope || new Set();
  const ql = (q || '').toLowerCase();
  let filtered = ql ? items.filter(i => (i.code + ' ' + i.name).toLowerCase().includes(ql)) : items;
  if (!filtered.length) return '<div style="padding:14px;text-align:center;color:var(--gray-500);font-size:12px;">No matching dynamic test cases.</div>';
  const ctx = window._dynCampFitCtx || { profiles: [], totalMin: 0, shiftCount: 0 };
  const noShifts = !ctx.shiftCount;
  const rows = filtered.map(i => ({ i, m: _dynCampFitForCase(i.id, ctx) }));
  // Best fit first: fully-fitting, then partial, then none; then coverage, footprint.
  const rank = r => (r.m.total === 0 ? 3 : r.m.fit === r.m.total ? 0 : r.m.fit > 0 ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b)
    || (b.m.coverage - a.m.coverage) || (b.m.footprint - a.m.footprint)
    || String(a.i.code).localeCompare(String(b.i.code), undefined, { numeric: true }));
  const capped = rows.slice(0, 300);
  const th = 'position:sticky;top:0;background:var(--surface,#fff);z-index:1;padding:5px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:var(--gray-500);border-bottom:1px solid var(--gray-200);';
  const head = `<thead><tr>
    <th style="${th}width:28px;"></th><th style="${th}">Test case</th>
    <th style="${th}white-space:nowrap;">Fit</th>
    <th style="${th}white-space:nowrap;" title="Share of the campaign's total shift-minutes this test case's fitting runs would consume">Utilization</th>
    <th style="${th}white-space:nowrap;" title="Coverage = runs that become schedulable; Footprint = how tightly runs match your shift size">Effectiveness</th>
  </tr></thead>`;
  const body = capped.map(({ i, m }) => {
    const tone = m.total === 0 ? 'var(--gray-400)' : m.fit === m.total ? 'var(--good)' : m.fit > 0 ? 'var(--warn)' : 'var(--bad)';
    const bg = sel.has(i.id) ? 'background:var(--info-light);' : '';
    const fitCell = m.total === 0
      ? '<span style="color:var(--gray-400);">no runs</span>'
      : `<span style="font-weight:700;color:${tone};">${m.fit}/${m.total}</span>` +
        (m.fit < m.total ? `<div style="font-size:10px;color:var(--gray-500);" title="${escapeHtml(_dynCampFitReason(m))}">${escapeHtml((_dynCampFitReason(m) || '').slice(0, 42))}</div>` : '');
    const utilPct = Math.round(m.util * 100);
    const utilCell = noShifts ? '<span style="color:var(--gray-400);">—</span>'
      : (m.fit ? `${_dynCampMiniBar(m.util * 100, 'var(--hitachi-red)')} <span style="font-size:11px;">${utilPct < 1 && m.fitMin ? '<1' : utilPct}%</span>` : '<span style="color:var(--gray-400);">0%</span>');
    const effCell = (noShifts || m.total === 0) ? '<span style="color:var(--gray-400);">—</span>'
      : `<div style="font-size:10.5px;line-height:1.5;">
          <div>${_dynCampMiniBar(m.coverage * 100, 'var(--good)')} cov ${Math.round(m.coverage * 100)}%</div>
          <div>${_dynCampMiniBar(m.footprint * 100, 'var(--info)')} ftpt ${m.fit ? Math.round(m.footprint * 100) + '%' : '—'}</div>
        </div>`;
    return `<tr style="border-bottom:1px solid var(--gray-100);${bg}">
      <td style="padding:5px 8px;vertical-align:top;"><input type="checkbox" ${sel.has(i.id) ? 'checked' : ''} onchange="_dynCampScopeToggle('${escapeHtml(i.id)}',this.checked)"></td>
      <td style="padding:5px 8px;vertical-align:top;"><div style="font-family:monospace;font-size:11px;color:var(--gray-500);">${escapeHtml(i.code)}</div><div style="font-size:12px;">${escapeHtml(String(i.name).slice(0, 52))}</div></td>
      <td style="padding:5px 8px;vertical-align:top;">${fitCell}</td>
      <td style="padding:5px 8px;vertical-align:top;white-space:nowrap;">${utilCell}</td>
      <td style="padding:5px 8px;vertical-align:top;">${effCell}</td>
    </tr>`;
  }).join('');
  const hint = noShifts ? '<div style="padding:6px 8px;font-size:11px;color:var(--warn);background:var(--warn-light);">Set access days, times &amp; zones above to see which test cases fit.</div>' : '';
  return hint + `<table style="width:100%;font-size:12px;border-collapse:collapse;">${head}<tbody>${body}</tbody></table>` +
    (rows.length > capped.length ? `<div style="padding:6px 8px;font-size:11px;color:var(--gray-500);">+${rows.length - capped.length} more — search to narrow.</div>` : '');
}

// Selected-scope rollup line: how much of the access the picked tests fill, so
// the planner can judge over/under-subscription before generating shifts.
function _dynCampScopeSummaryRefresh() {
  const el = document.getElementById('camp-scope-summary');
  if (!el) return;
  const sel = window._dynCampScope || new Set();
  const ctx = window._dynCampFitCtx || { profiles: [], totalMin: 0, shiftCount: 0 };
  if (!sel.size) { el.innerHTML = '0 selected — <b>all in-zone tests</b> will be in scope for this campaign.'; return; }
  let runs = 0, fitRuns = 0, min = 0;
  for (const id of sel) { const m = _dynCampFitForCase(id, ctx); runs += m.total; fitRuns += m.fit; min += m.fitMin; }
  const fillPct = ctx.totalMin ? Math.round(min / ctx.totalMin * 100) : null;
  const hrs = (min / 60).toFixed(1);
  let fill = '';
  if (fillPct != null) {
    const over = fillPct > 100;
    fill = ` · fills <b style="color:${over ? 'var(--bad)' : fillPct < 40 ? 'var(--warn)' : 'var(--good)'};">${fillPct}%</b> of available access`;
    if (over) fill += ` <span style="color:var(--bad);">(over-subscribed — add days/shifts or trim scope)</span>`;
    else if (fillPct < 40) fill += ` <span style="color:var(--warn);">(access under-used)</span>`;
  }
  const miss = fitRuns < runs ? ` · <span style="color:var(--warn);">${runs - fitRuns} run${runs - fitRuns === 1 ? '' : 's'} won't fit these constraints</span>` : '';
  el.innerHTML = `<b>${sel.size}</b> test case${sel.size === 1 ? '' : 's'} · <b>${fitRuns}</b> run${fitRuns === 1 ? '' : 's'} fit (${hrs} h)${fill}${miss}`;
}

// Recompute prospective shifts from the form and repaint the scope list + rollup.
function _dynCampScopeRefresh() {
  const list = document.getElementById('camp-scope-list');
  if (!list) return;
  const draft = _dynCampDraftFromForm();
  const shifts = (draft && typeof _dynGenerateShiftRows === 'function') ? _dynGenerateShiftRows(draft) : [];
  window._dynCampFitCtx = _dynCampBuildFitCtx(shifts);
  const search = document.getElementById('camp-scope-search');
  list.innerHTML = _dynCampScopeTableHtml(search ? search.value : '');
  _dynCampScopeSummaryRefresh();
}

// Bind ONE change/input listener on the modal body so any constraint edit
// (zones, days, times, trains, consist, modes, dates) refreshes the panel.
// Events from the scope list itself (selection) and the scope search are handled
// separately so clicking a checkbox doesn't re-sort the list under the cursor.
function _dynCampScopeInit() {
  const box = document.getElementById('camp-form-body');
  if (!box || box._fitBound) { _dynCampScopeRefresh(); return; }
  box._fitBound = true;
  const h = e => {
    const t = e.target;
    if (!t) return;
    if (t.closest && (t.closest('#camp-scope-list') || t.id === 'camp-scope-search')) return;
    // Everything commits on `change` (date/time/select/checkbox); only the trains
    // stepper is worth recomputing live per keystroke — skip `input` elsewhere so
    // typing name/notes doesn't rebuild the list.
    if (e.type === 'input' && t.id !== 'camp-trains') return;
    _dynCampScopeRefresh();
  };
  box.addEventListener('change', h);
  box.addEventListener('input', h);
  _dynCampScopeRefresh();
}
