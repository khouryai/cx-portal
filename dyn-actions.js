// ==========================================
// HITACHI Rail T&C Portal — Dynamic-testing delegated actions (dyn-actions.js)
// First slice of the dynamic-testing module extraction (Tier 3 ADR 0001). New
// dynamic-testing behaviour lands here as registered CXActions rather than in
// the app.js monolith. References app.js globals (_dynPage, _dbDelete,
// _dynLoadAll, _dynRenderInstances/_Board, uiCan, cxConfirm, toast, cxAlert) by
// name — they resolve at event time, so load order vs app.js is irrelevant.
// Loaded after cx-actions.js.
// ==========================================
(function () {
  if (typeof window === 'undefined' || !window.CXActions) return;

  // Bulk-delete the currently selected dynamic-testing instances (the tray's
  // "Delete" action). Mirrors the single-row _dynDeleteInstance: same permission
  // gate, a confirm sized to the selection, chunked deletes through the audited
  // _dbDelete helper, then reload + re-render the active tab.
  window.CXActions.register('_dynInstBulkDelete', async function () {
    if (typeof uiCan === 'function' && !uiCan('dynamic_testing', 'delete_instance')) {
      toast('You do not have permission to delete instances', 'error');
      return;
    }
    if (typeof _dynPage === 'undefined' || !_dynPage.selInstances) return;
    const ids = [..._dynPage.selInstances];
    if (!ids.length) { toast('No instances selected', 'info'); return; }
    const n = ids.length;
    if (!await cxConfirm(`Delete ${n} selected instance${n === 1 ? '' : 's'}?\n\nThis permanently removes the run${n === 1 ? '' : 's'} and cannot be undone.`)) return;
    try {
      // Chunked parallel deletes, reusing the audited _dbDelete (auth refresh,
      // 15s timeout, 401 handling) instead of a bespoke request.
      for (let i = 0; i < ids.length; i += 50) {
        await Promise.all(ids.slice(i, i + 50).map(function (id) { return _dbDelete('dynamic_instances', { id }); }));
      }
      _dynPage.selInstances.clear();
      if (typeof toast === 'function') toast(`Deleted ${n} instance${n === 1 ? '' : 's'}.`, 'success');
      _dynPage.loaded = false;
      await _dynLoadAll();
      if (_dynPage.tab === 'instances') _dynRenderInstances(); else _dynRenderBoard();
    } catch (e) {
      if (typeof cxAlert === 'function') cxAlert(`Bulk delete failed: ${e.message}`);
      else toast('Bulk delete failed: ' + (e && e.message || e), 'error');
    }
  });
})();
