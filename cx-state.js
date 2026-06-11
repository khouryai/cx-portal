// ==========================================
// HITACHI Rail T&C Portal — Reusable cx* state helpers
// Extracted from app.js (P3-1 strangler split, seam #3). Classic <script>
// loaded after icons.js + format.js (uses window.icon + escapeHtml at runtime)
// and before app.js. cxSkeleton / cxEmpty / cxError — loading/empty/error UI.
// ==========================================

// ── Reusable loading / empty / error state helpers ────────────────────────
// Token-based + icon()-driven so they theme automatically (light/dark).
function cxSkeleton(rows) {
  rows = rows || 3;
  var s = '<div class="cx-skeleton" aria-hidden="true" aria-busy="true">';
  for (var i = 0; i < rows; i++) s += '<div class="cx-skel-line" style="width:' + (72 + (i * 9) % 24) + '%"></div>';
  return s + '</div>';
}
function cxEmpty(o) {
  o = o || {};
  return '<div class="docs-empty">'
    + (o.icon && window.icon ? '<div class="docs-empty-icon">' + window.icon(o.icon) + '</div>' : '')
    + (o.title ? '<h3 class="docs-empty-title">' + escapeHtml(o.title) + '</h3>' : '')
    + (o.message ? '<p>' + escapeHtml(o.message) + '</p>' : '')
    + (o.actionLabel && o.onAction ? '<button class="form-secondary cx-empty-action" onclick="' + o.onAction + '">' + escapeHtml(o.actionLabel) + '</button>' : '')
    + '</div>';
}
function cxError(o) {
  o = o || {};
  return '<div class="cx-error" role="alert">'
    + (window.icon ? window.icon('alert') : '')
    + '<div class="cx-error-msg">' + escapeHtml(o.message || 'Something went wrong while loading this.') + '</div>'
    + (o.retry ? '<button class="form-secondary cx-error-retry" onclick="' + o.retry + '">' + (window.icon ? window.icon('refresh') : '') + ' Retry</button>' : '')
    + '</div>';
}
window.cxSkeleton = cxSkeleton; window.cxEmpty = cxEmpty; window.cxError = cxError;
