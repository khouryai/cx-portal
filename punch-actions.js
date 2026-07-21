// ==========================================
// HITACHI Rail T&C Portal — Punch module delegated actions (punch-actions.js)
// First slice of the punch-list module extraction (Tier 3 ADR 0001, Stage B/C).
// Holds the punch handlers that can't be a mechanical data-action drop-in
// because the inline version did more than call a global with data args —
// proxy-clicking a hidden file input, or a guarded module method call. They are
// registered as named CXActions so the markup can use data-action without any
// inline on* handler. Loaded after cx-actions.js; safe if app.js isn't ready yet
// (handlers resolve at event time).
// ==========================================
(function () {
  if (typeof window === 'undefined' || !window.CXActions) return;

  // Trigger the hidden per-comment file input (was: getElementById(...).click()).
  window.CXActions.register('_punchAttachComment', function (id) {
    var el = document.getElementById('punch-comment-file-' + id);
    if (el) el.click();
  });

  // Trigger the hidden new-photo file input.
  window.CXActions.register('_punchClickNewPhotoFile', function () {
    var el = document.getElementById('punch-newphoto-file');
    if (el) el.click();
  });

  // Open the photo capture/gallery for the current punch context (guarded — the
  // Photos module loads lazily).
  window.CXActions.register('_punchCaptureCtxPhoto', function () {
    if (window.PhotosModule) window.PhotosModule.captureFor(window._pmPunchCtx);
  });
})();
