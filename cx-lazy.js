// ==========================================
// HITACHI Rail T&C Portal — load heavy libraries on demand (cx-lazy.js)
//
// pdf.js (~370 KB) and pdf-lib (~510 KB) used to load on every page view,
// although only Forms, Drawings, Documents and the Track Plan viewer use them.
// They now load the first time one of those needs them:
//
//     const pdfjs  = await CXLazy.pdfjs();    // window.pdfjsLib, worker set
//     const PDFLib = await CXLazy.pdflib();   // window.PDFLib
//
// Each resolves to the library, or to null if it could not be loaded (the
// caller shows its own "could not load" message). Each loads at most once;
// concurrent callers share the same load.
//
// CXLazy.warm() starts both loads in the background — app.js calls it when a
// PDF-using page opens, so the libraries are usually ready before a PDF is.
// The files stay in the service worker's shell cache, so this works offline.
//
// Loaded before app.js. Same-origin scripts only (vendor/), so the CSP needs
// no change.
// ==========================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var WORKER = 'vendor/js/pdf.worker.min.js';
  var loads = {};

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (loads[src]) return loads[src];
    loads[src] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(window[globalName] || null); };
      s.onerror = function () {
        delete loads[src];               // allow a retry (e.g. back online)
        try { console.warn('[lazy] could not load ' + src); } catch (e) {}
        resolve(null);
      };
      (document.head || document.documentElement).appendChild(s);
    });
    return loads[src];
  }

  function pdfjs() {
    return loadScript('vendor/js/pdf.min.js', 'pdfjsLib').then(function (lib) {
      if (lib && lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = WORKER;
      }
      return lib;
    });
  }

  function pdflib() {
    return loadScript('vendor/js/pdf-lib.min.js', 'PDFLib');
  }

  function warm() {
    pdfjs();
    pdflib();
  }

  window.CXLazy = { pdfjs: pdfjs, pdflib: pdflib, warm: warm };
})();
