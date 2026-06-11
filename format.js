// ==========================================
// HITACHI Rail T&C Portal — Format / string utilities
// Extracted from app.js (P3-1 strangler split, seam #2). Classic <script>
// loaded before app.js so these are shared globals (also on window.*).
// ==========================================

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[c]);
}

function getLocationCode(loc) {
  if (!loc) return '';
  const m = loc.match(/^(\w+)/);
  return m ? m[1] : loc;
}
window.escapeHtml = escapeHtml;
window.getLocationCode = getLocationCode;
