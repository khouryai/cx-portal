// ==========================================================================
// print-report.js — Shared branded print/PDF template for every module
// ==========================================================================
// Print windows are standalone documents that do NOT load styles.css, so
// var(--token) references silently fail there. This module gives every export
// ONE Hitachi-branded letterhead, footer and component CSS kit built from
// concrete hex, so Daily Log / RMA / Meeting / Punch / Cancellation / Lookahead
// PDFs all look identical. Builders assemble a body from the .cxr-* classes and
// wrap it with cxReportShell(); cxPrintOpen()/cxPrintFrame() do the printing.
//
// Loaded as a classic script; pure string builders, no load-time side effects.
(function () {
  'use strict';

  var BRAND = {
    red:    '#E60012',   // Hitachi red
    redDk:  '#B00010',
    ink:    '#1F2937',
    ink2:   '#374151',
    muted:  '#6B7280',
    subtle: '#9CA3AF',
    line:   '#E5E7EB',
    lineSoft: '#EEF0F2',
    surface:'#F9FAFB',
    surface2:'#F3F4F6',
    charcoal:'#1F2937',
    white:  '#FFFFFF',
    good:   '#0D7A4F',
    warn:   '#A8550A',
    bad:    '#C01017',
    warnBg: '#FEF6EC',
    badBg:  '#FDECEC',
    goodBg: '#E9F6EF',
  };

  function _esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function _now() {
    try { return new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }); }
    catch (_) { return new Date().toString(); }
  }

  // ── Base document + component CSS (concrete hex) ──────────────────────────
  function cxReportCSS(opts) {
    opts = opts || {};
    var B = BRAND;
    var landscape = opts.landscape ? ' landscape' : '';
    return [
      '*{box-sizing:border-box;margin:0;padding:0;}',
      '@page{size:A4' + landscape + ';margin:14mm 14mm 20mm;}',
      '@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px Arial,sans-serif;color:' + B.subtle + ';}}',
      'html,body{background:' + B.white + ';}',
      'body{font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:' + B.ink + ';padding:28px 30px 40px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}',
      // Letterhead
      '.cxr-topbar{height:4px;background:' + B.red + ';margin:-28px -30px 18px;}',
      '.cxr-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:12px;border-bottom:2.5px solid ' + B.red + ';margin-bottom:16px;}',
      '.cxr-logo{font-size:23px;font-weight:800;letter-spacing:.14em;color:' + B.red + ';line-height:1;}',
      '.cxr-brandsub{font-size:10.5px;color:' + B.muted + ';margin-top:4px;letter-spacing:.02em;}',
      '.cxr-proj{text-align:right;font-size:10.5px;color:' + B.muted + ';line-height:1.55;}',
      '.cxr-proj-name{font-size:12px;font-weight:700;color:' + B.ink + ';}',
      // Title block
      '.cxr-titleblock{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:20px;}',
      '.cxr-eyebrow{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:' + B.red + ';margin-bottom:3px;}',
      '.cxr-title{font-size:22px;font-weight:800;color:' + B.ink + ';line-height:1.15;}',
      '.cxr-titlesub{font-size:12px;color:' + B.muted + ';margin-top:4px;}',
      '.cxr-ref{flex:none;text-align:right;}',
      '.cxr-ref-chip{display:inline-block;font-size:13px;font-weight:700;color:' + B.redDk + ';background:' + B.badBg + ';border:1px solid #F3C6C9;border-radius:6px;padding:4px 12px;}',
      '.cxr-ref-meta{font-size:10.5px;color:' + B.muted + ';margin-top:5px;}',
      // Sections
      '.cxr-h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:' + B.red + ';margin:22px 0 9px;padding-top:12px;border-top:1px solid ' + B.line + ';}',
      '.cxr-h2:first-child{margin-top:0;padding-top:0;border-top:none;}',
      // Key/value table
      '.cxr-kv{width:100%;border-collapse:collapse;border:1px solid ' + B.line + ';border-radius:6px;overflow:hidden;}',
      '.cxr-kv tr{border-bottom:1px solid ' + B.lineSoft + ';}',
      '.cxr-kv tr:last-child{border-bottom:none;}',
      '.cxr-kv th{width:190px;text-align:left;vertical-align:top;font-size:11px;font-weight:600;color:' + B.muted + ';background:' + B.surface + ';padding:8px 14px;border-right:1px solid ' + B.line + ';}',
      '.cxr-kv td{vertical-align:top;font-size:12px;color:' + B.ink + ';padding:8px 14px;}',
      // Data table
      '.cxr-table{width:100%;border-collapse:collapse;font-size:11px;}',
      '.cxr-table thead th{background:' + B.charcoal + ';color:' + B.white + ';text-align:left;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:8px 9px;}',
      '.cxr-table tbody td{padding:7px 9px;border-bottom:1px solid ' + B.line + ';vertical-align:top;color:' + B.ink2 + ';}',
      '.cxr-table tbody tr:nth-child(even) td{background:' + B.surface + ';}',
      '.cxr-table tbody tr{page-break-inside:avoid;}',
      // Metric tiles
      '.cxr-metrics{display:flex;flex-wrap:wrap;gap:10px;margin:4px 0;}',
      '.cxr-metric{flex:1;min-width:88px;border:1px solid ' + B.line + ';border-radius:8px;padding:10px 14px;}',
      '.cxr-metric .num{font-size:22px;font-weight:800;color:' + B.ink + ';line-height:1;}',
      '.cxr-metric .lbl{font-size:10px;color:' + B.muted + ';margin-top:5px;text-transform:uppercase;letter-spacing:.04em;}',
      // Notes + callouts
      '.cxr-note{margin:8px 0;}',
      '.cxr-note-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:' + B.muted + ';margin-bottom:3px;}',
      '.cxr-note-body{font-size:12px;color:' + B.ink + ';white-space:pre-wrap;}',
      '.cxr-callout{margin:10px 0;padding:10px 14px;border-radius:6px;border:1px solid ' + B.line + ';border-left:4px solid ' + B.muted + ';background:' + B.surface + ';font-size:12px;}',
      '.cxr-callout.warn{border-left-color:' + B.warn + ';background:' + B.warnBg + ';}',
      '.cxr-callout.bad{border-left-color:' + B.bad + ';background:' + B.badBg + ';}',
      '.cxr-callout .cxr-callout-title{font-weight:700;color:' + B.ink + ';}',
      // Pills + chips
      '.cxr-pill{display:inline-block;font-size:10px;font-weight:700;border:1px solid currentColor;border-radius:20px;padding:1px 9px;}',
      '.cxr-chips{display:flex;flex-wrap:wrap;gap:5px;}',
      '.cxr-chip{font-size:11px;background:' + B.surface2 + ';border:1px solid ' + B.line + ';border-radius:20px;padding:2px 10px;color:' + B.ink2 + ';}',
      '.cxr-muted{color:' + B.muted + ';}',
      '.page-break{page-break-before:always;}',
      // Fixed running footer (repeats each page)
      '.cxr-foot{position:fixed;left:14mm;right:14mm;bottom:8mm;display:flex;justify-content:space-between;gap:16px;font-size:9px;color:' + B.subtle + ';border-top:1px solid ' + B.line + ';padding-top:5px;}',
    ].join('');
  }

  // Status → semantic color for pills (shared with the app's vocabulary).
  function cxStatusColor(s) {
    s = String(s || '').toLowerCase();
    if (/pass|closed|complete|done|resolved|approved|verified/.test(s)) return BRAND.good;
    if (/fail|reject|overdue|cancel/.test(s)) return BRAND.bad;
    if (/block|hold|await|delay|pending/.test(s)) return BRAND.warn;
    if (/progress|open|ship|active|review|new/.test(s)) return BRAND.redDk;
    return BRAND.muted;
  }
  function cxPill(status) {
    if (!status) return '';
    return '<span class="cxr-pill" style="color:' + cxStatusColor(status) + ';">' + _esc(status) + '</span>';
  }

  // ── Letterhead + title block ──────────────────────────────────────────────
  function cxReportHeader(o) {
    o = o || {};
    var refHtml = '';
    if (o.refNo || o.refMeta) {
      refHtml = '<div class="cxr-ref">' +
        (o.refNo ? '<div class="cxr-ref-chip">' + _esc(o.refNo) + '</div>' : '') +
        (o.refMeta ? '<div class="cxr-ref-meta">' + _esc(o.refMeta) + '</div>' : '') +
        '</div>';
    }
    return '' +
      '<div class="cxr-topbar"></div>' +
      '<header class="cxr-head">' +
        '<div class="cxr-brand"><div class="cxr-logo">HITACHI</div>' +
          '<div class="cxr-brandsub">Rail STS &middot; Testing &amp; Commissioning</div></div>' +
        '<div class="cxr-proj"><div class="cxr-proj-name">BART CBTC System</div>' +
          '<div>Contract 49GH-110</div>' +
          '<div>2150 Webster St, 2nd Floor &middot; Oakland, CA 94612</div></div>' +
      '</header>' +
      '<div class="cxr-titleblock"><div>' +
        (o.docType ? '<div class="cxr-eyebrow">' + _esc(o.docType) + '</div>' : '') +
        '<div class="cxr-title">' + _esc(o.title || o.docType || 'Report') + '</div>' +
        (o.subtitle ? '<div class="cxr-titlesub">' + _esc(o.subtitle) + '</div>' : '') +
      '</div>' + refHtml + '</div>';
  }

  function cxReportFooter() {
    return '<footer class="cxr-foot">' +
      '<span>Hitachi Rail STS &middot; BART CBTC (Contract 49GH-110)</span>' +
      '<span>Generated ' + _esc(_now()) + '</span></footer>';
  }

  // ── Full document ─────────────────────────────────────────────────────────
  // opts: { docType, title, subtitle, refNo, refMeta, bodyHtml, extraCss,
  //         landscape, autoPrint (default true) }
  function cxReportShell(opts) {
    opts = opts || {};
    var autoPrint = opts.autoPrint !== false;
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
      _esc(opts.title || opts.docType || 'Report') + '</title><style>' +
      cxReportCSS({ landscape: opts.landscape }) + (opts.extraCss || '') +
      '</style></head><body>' +
      cxReportHeader(opts) +
      '<main class="cxr-body">' + (opts.bodyHtml || '') + '</main>' +
      cxReportFooter() +
      (autoPrint ? '<' + 'script>window.onload=function(){setTimeout(function(){window.print();},60);}<' + '/script>' : '') +
      '</body></html>';
  }

  // ── Printing helpers ──────────────────────────────────────────────────────
  // Popup window (simple docs). Returns false if the pop-up was blocked.
  function cxPrintOpen(html, o) {
    o = o || {};
    var w = window.open('', '_blank', o.features || 'width=980,height=800');
    if (!w) {
      if (typeof toast === 'function') toast('Allow pop-ups to print / save as PDF', 'error');
      return false;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    return true;
  }

  // Hidden blob-iframe (avoids pop-up blockers; waits for images e.g. photos).
  // Pass autoPrint:false in the shell and let the iframe's onload trigger print.
  function cxPrintFrame(html, o) {
    o = o || {};
    try {
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;border:none;opacity:0;';
      document.body.appendChild(frame);
      frame.onload = function () {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); }
        catch (e) { window.open(url, '_blank'); }
        var cleanup = function () {
          if (document.body.contains(frame)) document.body.removeChild(frame);
          URL.revokeObjectURL(url);
        };
        try { frame.contentWindow.onafterprint = cleanup; } catch (_) {}
        setTimeout(cleanup, 60000);
      };
      frame.src = url;
      return true;
    } catch (e) {
      if (typeof toast === 'function') toast('Print failed: ' + e.message, 'error');
      return false;
    }
  }

  if (typeof window !== 'undefined') {
    window.cxReportShell = cxReportShell;
    window.cxReportHeader = cxReportHeader;
    window.cxReportFooter = cxReportFooter;
    window.cxReportCSS = cxReportCSS;
    window.cxReportBrand = BRAND;
    window.cxPill = cxPill;
    window.cxStatusColor = cxStatusColor;
    window.cxPrintOpen = cxPrintOpen;
    window.cxPrintFrame = cxPrintFrame;
  }
})();
