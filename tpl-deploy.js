// ==========================================
// HITACHI Rail T&C Portal — Activity Template deploy: row planning
// (tpl-deploy.js)
//
// confirmDeploy() used to build one test_items row per SELECTED CODE:
//
//     for (const tcCode of s.tcCodes)
//       rows.push({ test_id: `${depId}-${s.locId}-${tcCode}`, ... })
//
// which assumes a template's test-case codes are unique. They are not. In
// "IXL Wayside SAT - LAB TESTING" three different cases share code 4.2, three
// share 4.3 and two share 4.4 — the same-code/different-name shape the Test
// Register already handles elsewhere (the "4.5 bug"). Deploying it produced
// eight rows collapsed onto three test_ids, so Postgres rejected the whole
// insert with 23505 duplicate key ... test_items_pkey and the deploy failed
// with nothing written. Worse, `tpl.testCases.find(t => t.code === tcCode)`
// returned the FIRST case with that code, so even without the PK clash the
// second and third cases would have deployed under the first one's name,
// procedure and section — silent data loss.
//
// The planner below iterates the template's cases by POSITION and keeps the
// selection as a code set, so every occurrence deploys with its own content
// and its own id. Ids only change shape where they have to: a code that is
// unique in the template still produces `${depId}-${locId}-${code}`, so
// previously deployed ids and anything derived from them are untouched.
//
// Loaded AFTER app.js (called from confirmDeploy).
// ==========================================

// Codes that appear more than once in this template — the ones that need a
// disambiguating suffix. Computed per template, not per row.
function _deployDupCodes(tpl) {
  const seen = new Set(), dup = new Set();
  (tpl?.testCases || []).forEach(tc => {
    const code = String(tc?.code ?? '');
    if (seen.has(code)) dup.add(code); else seen.add(code);
  });
  return dup;
}

// `~` is URL-unreserved, so a suffixed id stays safe everywhere a test_id is
// used in a link, a DOM id or an encodeURIComponent round-trip.
function _deployTestId(depId, locId, code, idx, dupCodes) {
  const base = `${depId}-${locId}-${code}`;
  return dupCodes.has(String(code)) ? `${base}~${idx}` : base;
}

// One entry per selected test case OCCURRENCE:
//   { row, tc, sel }  — the test_items row, the template case it came from,
//                       and the location selection it belongs to.
// Callers that need to reach back to the template case after the insert (the
// child test case step, the form clone) use tc/sel instead of re-deriving an id
// from the code, which is exactly what could not be done unambiguously before.
function _deployPlanRows(tpl, sel, depId, now) {
  const chosen = new Set(sel?.tcCodes || []);
  const dupCodes = _deployDupCodes(tpl);
  const plan = [];
  (tpl?.testCases || []).forEach((tc, idx) => {
    const code = String(tc?.code ?? '');
    if (!chosen.has(tc?.code)) return;
    plan.push({
      tc, sel,
      row: {
        test_id:        _deployTestId(depId, sel.locId, code, idx, dupCodes),
        phase:          sel.phaseName,
        location:       sel.locName,
        subsystem:      tpl.subsystem,
        activity:       tpl.name,
        test_category:  null,
        test_case_code: code,
        test_name:      tc?.name || code,
        test_procedure: tc?.procedure || '',
        test_section:   tc?.section   || '',
        scope_type:     (tc?.scopeType || tc?.scope_type || 'static') === 'dynamic' ? 'dynamic' : 'static',
        status:         'Not Started',
        weight:         1, // legacy per-row column; real weight lives in test_case_weights
        is_parent:      _deployChildNames(tc).length > 0,
        synced_at:      now,
      },
    });
  });
  return plan;
}

// Guard the whole deploy: if a template ever produces two rows with the same
// test_id, say so up front instead of letting Postgres reject the batch with a
// 23505 the user cannot act on.
function _deployDuplicateIds(plan) {
  const seen = new Set(), dup = [];
  (plan || []).forEach(p => {
    const id = p?.row?.test_id;
    if (seen.has(id)) dup.push(id); else seen.add(id);
  });
  return dup;
}

// The child test case names a template case defines ("Child test cases" in the
// template builder — a comma-separated list, one child per device). Templates
// saved before the 2026-10 child test case migration carry it under `assets`.
function _deployChildNames(tc) {
  const raw = tc?.children ?? tc?.assets ?? '';
  const seen = new Set(), out = [];
  String(raw).split(',').map(s => s.trim()).filter(Boolean).forEach(n => {
    const k = n.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(n); }
  });
  return out;
}

// One child test_items row per child name of every planned parent, built by
// _childDbRow (tr-children.js) so a deployed child is identical to one added
// from the Test Register. The parent is brand new, so a positional `~cN`
// suffix on its id cannot collide with anything.
function _deployPlanChildRows(plan) {
  const out = [];
  (plan || []).forEach(p => {
    _deployChildNames(p?.tc).forEach((name, i) => {
      out.push(_childDbRow(p.row, name, `${p.row.test_id}~c${i + 1}`));
    });
  });
  return out;
}
