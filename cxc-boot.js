// ==========================================
// Construction Planner — boot (cxc-boot.js)
//
// Last script in index.html. Installs each view with the shell (order here is
// the order they appear in the sidebar) and starts the app. Adding a screen
// means writing its module and adding one install() call — nothing else in the
// app needs to know it exists.
// ==========================================
(function () {
  'use strict';

  function start() {
    CXCPlan.install();          // Plan & forecast
    CXCTimelineView.install();  // Timeline
    CXCManage.install();        // Scope + every Setup screen + Assumptions
    CXCApp.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
