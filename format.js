// ==========================================
// HITACHI Rail T&C Portal — Format / string utilities
// Extracted from app.js (P3-1 strangler split, seam #2). Classic <script>
// loaded before app.js so these are shared globals (also on window.*).
// ==========================================

/**
 * HTML-escape a value for safe interpolation into markup. null/undefined → ''.
 * @param {*} s
 * @returns {string}
 */
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  /** @type {Record<string,string>} */
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

/**
 * Leading token of a location string (e.g. "W40 Platform" → "W40").
 * @param {string} loc
 * @returns {string}
 */
function getLocationCode(loc) {
  if (!loc) return '';
  const m = loc.match(/^(\w+)/);
  return m ? m[1] : loc;
}
window.escapeHtml = escapeHtml;
window.getLocationCode = getLocationCode;
