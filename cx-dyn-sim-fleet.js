// ── Dynamic Testing simulator: fleet model (trains + car-lengths) ────────────
// The schedule simulator packs runs onto synthetic access shifts. A run can also
// need MORE THAN ONE train (trains_needed) and specific car-lengths (consist
// sizes), and the cascade allocator already refuses a shift that can't supply
// them (_dynConsistFit). Historically the sim's shifts declared no fleet at all,
// so every shift defaulted to ONE train / "Any" car-length and any multi-train
// run came back "no capacity within 120 weeks". These helpers give a scenario a
// fleet: how many trains a shift can field and which car-lengths are available.
//
// Pure functions, no state. They reference app.js globals (_dynSimScopePool,
// _dynConsistSizes, cxOn, _dynSimActive, _dynSimPatch, _dynRenderSimulator) only
// at call time, so load order relative to app.js does not matter.

// Trains any single run in scope needs (max trains_needed) — the smallest fleet
// that leaves nothing structurally blocked by train count. Floor of 1.
function _dynSimScopeMaxTrains(sc) {
  let n = 1;
  for (const i of _dynSimScopePool(sc)) n = Math.max(n, _dynConsistSizes(i).length);
  return n;
}

// Trains a simulated shift can field: the scenario's trainsPerShift when set to a
// valid number, else auto-sized to the work so the default plan is feasible.
function _dynSimTrainsPerShift(sc) {
  const v = parseInt(sc && sc.trainsPerShift, 10);
  return (Number.isFinite(v) && v >= 1) ? v : _dynSimScopeMaxTrains(sc);
}

// Car-lengths (consist sizes) available on the property, from sc.availConsists
// (array, or free text like "4, 10"). Empty = every length available ("Any").
function _dynSimAvailCarLengths(sc) {
  const raw = sc && sc.availConsists;
  const arr = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[^0-9]+/);
  return [...new Set(arr.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

// Does the fleet offer every car-length this run needs? "Any" (empty) always ok;
// a null per-train size ("Any" on the instance) matches any available length.
function _dynSimCarLengthsOk(inst, sc) {
  const avail = _dynSimAvailCarLengths(sc);
  if (!avail.length) return true;
  return _dynConsistSizes(inst).every(sz => sz == null || avail.includes(sz));
}

// Whole fleet fit: enough trains AND every required car-length available.
function _dynSimFleetOk(sc, inst) {
  return _dynConsistSizes(inst).length <= _dynSimTrainsPerShift(sc) && _dynSimCarLengthsOk(inst, sc);
}

// Why a run can't be fielded by the fleet, for the "Why?" table. '' = it fits.
function _dynSimFleetReason(sc, inst) {
  const need = _dynConsistSizes(inst);
  const tps = _dynSimTrainsPerShift(sc);
  if (need.length > tps) return `needs ${need.length} trains — shift offers ${tps}`;
  const avail = _dynSimAvailCarLengths(sc);
  if (avail.length) { const miss = need.find(sz => sz != null && !avail.includes(sz)); if (miss != null) return `no ${miss}-car train available`; }
  return '';
}

// Scenario-editor controls: trains per shift (blank = auto) + car-lengths avail.
function _dynSimFleetControlsHtml(sc) {
  const auto = !(sc && Number.isFinite(parseInt(sc.trainsPerShift, 10)));
  const maxT = _dynSimScopeMaxTrains(sc);
  const avail = _dynSimAvailCarLengths(sc);
  return `<label class="simx-field" title="Trains each simulated shift can field. Blank = sized to the work (needs ${maxT}). Lower it to model a fleet shortage.">Trains / shift
      <input type="number" min="1" max="12" value="${auto ? '' : _dynSimTrainsPerShift(sc)}" placeholder="${maxT}" class="simx-inp wide" ${cxOn('change', '_dynSimField', 'trainsPerShift', '$cx.value')}></label>
    <label class="simx-field" title="Car-lengths (consist sizes) available on the property, comma-separated, e.g. 4, 10. Blank = any length.">Car-lengths
      <input type="text" value="${avail.join(', ')}" placeholder="any" class="simx-inp wide mono" ${cxOn('change', '_dynSimSetCarLengths', '$cx.value')}></label>`;
}

// Store the parsed car-length set on the active scenario and re-render.
function _dynSimSetCarLengths(val) {
  const sc = (typeof _dynSimActive === 'function') ? _dynSimActive() : null;
  if (!sc) return;
  const sizes = [...new Set(String(val || '').split(/[^0-9]+/).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  _dynSimPatch(sc.id, { availConsists: sizes });
  _dynRenderSimulator();
}
