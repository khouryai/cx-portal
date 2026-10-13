// ==========================================
// HITACHI Rail T&C Portal — Drawings: title-block reader (drw-parse.js)
//
// Reads each page of an uploaded drawing set and finds its sheet (drawing)
// number, title, revision and page number. Pure logic, no DOM: the upload
// flow (drw-upload.js) hands it pdf.js text items + the page viewport.
//
// How a page is read:
//   1. Text items are placed in the page as the user SEES it (pdf.js viewport
//      transform), so pages saved with a /Rotate and text written sideways are
//      handled, and calibrated boxes line up with what was drawn.
//   2. Items are joined into phrases (CAD output often writes one character
//      or word per item), duplicate "bold" overprints are dropped.
//   3. Title-block labels (SHEET NO., REV, TITLE, SCALE, DRAWN BY…) are found,
//      and every value is owned by its nearest label, so the sheet number is
//      never read from the CONTRACT NO. or TEAMCENTER DWG NO. cell.
//   4. Candidates are scored (label, pattern, font size, position).
//   5. Across the set: text on (nearly) every page is template boilerplate,
//      and where confident pages found their values teaches the rest — where
//      the sheet number sits, its shape (E11004-W30-###), the title's cell.
//   6. PDF bookmarks / page labels fill gaps (scanned pages have no text).
// Every value comes back with a confidence and the box it was read from.
//
// Calibrated regions (drawn per location in the upload modal) still win:
// a field with a region is read from that box first.
// ==========================================
(function (root) {
  'use strict';

  var FIELDS = ['sheetNumber', 'sheetTitle', 'revision', 'pageNumber'];

  // ── Text normalisation ──────────────────────────────────────────────────
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function up(s) { return clean(s).toUpperCase(); }

  // Sheet-number token: upper case, "E - 101" → "E-101", no stray punctuation.
  function normSheet(s) {
    return up(s)
      .replace(/\s*-\s*/g, '-')
      .replace(/\s*\.\s*(?=\d)/g, '.')
      .replace(/^[#(\[]+/, '')
      .replace(/[,;:)\]]+$/, '')
      .replace(/\.$/, '');
  }

  // ── Sheet-number patterns (most specific first; weight = trust) ─────────
  var SN_PATTERNS = [
    [/^[A-Z]{1,4}\d{2,}-[A-Z0-9]+-\d+[A-Z]?$/, 3],        // E11004-W30-001
    [/^[A-Z]{1,4}\d{2,}-[A-Z0-9]+$/, 2.5],                // E11004-W30
    [/^[A-Z]{1,4}-?\d{1,4}\.\d{1,3}[A-Z]?$/, 2.5],        // E1.01, A-101.1
    [/^(?=.*\d)[A-Z]{1,6}(?:-[A-Z0-9]{1,8}){2,4}$/, 2.5], // TC-SIG-001, SIG-CBTC-0001, E-101-A
    [/^\d+[A-Z]+-\d+[A-Z]?$/, 2],                         // 496H-110
    [/^[A-Z]{1,4}-\d{1,5}[A-Z]?$/, 2],                    // E-1001, SIG-101
    [/^[A-Z]{1,3}\d{2,4}[A-Z]?$/, 1],                     // E101, M22A
  ];
  var MONTH_RE = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*[-.]?\d/;
  var NOT_SHEET_PREFIX = /^(REV|NO|PG|PAGE|SHEET|SHT|DWG|FIG|DET|DETAIL|SECTION|NOTE|ITEM|TYPE|QTY|STA|RFI|ECN|NCR|ZONE|GRID)\b/;

  function sheetWeight(tok) {
    var t = normSheet(tok);
    if (t.length < 3 || t.length > 32 || !/\d/.test(t) || !/[A-Z]/.test(t)) return 0;
    if (MONTH_RE.test(t) || NOT_SHEET_PREFIX.test(t)) return 0;
    for (var i = 0; i < SN_PATTERNS.length; i++) if (SN_PATTERNS[i][0].test(t)) return SN_PATTERNS[i][1];
    return 0;
  }
  // A value under an explicit DRAWING NO. label that matches no known shape
  // (e.g. a plain number "1234567") is still accepted, with less trust.
  function relaxedSheetOk(tok) {
    var t = normSheet(tok);
    return t.length >= 3 && t.length <= 32 && /\d/.test(t) && !/\s/.test(t)
      && !/^\d{1,2}$/.test(t) && !isDate(t) && !MONTH_RE.test(t);
  }
  function shapeOf(t) { return normSheet(t).replace(/[A-Z]/g, 'A').replace(/\d/g, '9'); }

  // ── Revision codes: 0, 12, A, AB, P01, 1A ───────────────────────────────
  var REV_RE = /^(?:[A-Z]{1,2}|\d{1,3}|[A-Z]\d{1,3}|\d{1,3}[A-Z])$/;
  var REV_STOP = /^(OF|NO|TO|BY|AT|IN|ON|AS|OR|IS|IT|AN|BE|DO|IF|SO|UP|US|WE|EA|LF|SF|FT|NA|NTS|REV|I|O)$/;
  function isRevCode(s) { var t = up(s).replace(/[.:]$/, ''); return REV_RE.test(t) && !REV_STOP.test(t); }
  function revRank(s) {
    var t = up(s), m;
    if (/^\d+$/.test(t)) return 1e6 + parseInt(t, 10);
    if (/^[A-Z]{1,2}$/.test(t)) return t.length === 1 ? t.charCodeAt(0) - 64 : 26 * (t.charCodeAt(0) - 64) + (t.charCodeAt(1) - 64);
    if ((m = t.match(/^[A-Z](\d+)$/)) || (m = t.match(/^(\d+)[A-Z]$/))) return 5e5 + parseInt(m[1], 10) * 30 + (t.replace(/\d/g, '').charCodeAt(0) - 64);
    return 0;
  }

  // ── Things that are never a title ──────────────────────────────────────
  var DATE_WORD_RE = /^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
  function isDate(s) {
    var t = clean(s);
    return DATE_WORD_RE.test(t)
      || /^\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}$/.test(t)
      || /^\d{1,2}[\/.-]?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[\/.-]?\d{2,4}$/i.test(t);
  }
  var STATUS_RE = /^(?:(?:issued|released|submitted)\s+for\b.*|not\s+for\s+construction|for\s+(?:review|construction|information|approval|bid|permit|reference)(?:\s+only)?|preliminary|draft|void|superseded|as[\s-]?built|record\s+drawing|confidential|field\s+office\s+master\s+copy|master\s+copy|approved)$/i;
  var SCALE_RE = /^(?:scale\s*:?.*|n\.?\s*t\.?\s*s\.?|not\s+to\s+scale|as\s+(?:shown|noted)|full\s+size|\d+(?:\/\d+)?\s*["”]?\s*=\s*\d.*|1\s*:\s*\d+)$/i;

  // Project-banner text that appears on every sheet — never a title.
  // Keyword match so spelling variants and line splits don't matter.
  var BANNER_PATTERNS = [
    /design[\s-]+build/i,
    /\bCBTC\b/,
    /communications?\s+based\s+train\s+control/i,
    /train\s+control\s+\(?CBTC/i,
    /\bBART\b/i,
    /\bBAY\s+AREA\b/i,
    /rapid\s+transit/i,
    /transit\s+district/i,
    /transit\s+authority/i,
    /\bHITACHI\b/i,
    /inspire\s+the\s+next/i,
    /field\s+office\s+master/i,
  ];
  function isBanner(s) { for (var i = 0; i < BANNER_PATTERNS.length; i++) if (BANNER_PATTERNS[i].test(s)) return true; return false; }

  // Junk that looks like a title cell: no-space hyphenated ids ("W37-275-375LB24-D"),
  // file names, URLs, sheet-of-sheet counters.
  function isJunkTitle(s) {
    var t = clean(s);
    if (DATE_WORD_RE.test(t)) return true;
    if (!/\s/.test(t) && /[-_]/.test(t)) return true;
    if (/\.(dgn|dwg|dxf|pdf|rvt|xref)\b/i.test(t)) return true;
    if (/(@|www\.|https?:|\.com\b)/i.test(t)) return true;
    if (/^(sheet|sht|page|pg)\.?\s*\d+\s*(of|\/)\s*\d+$/i.test(t) || /^\d+\s*of\s*\d+$/i.test(t)) return true;
    if (/^(copyright|©|\(c\))/i.test(t)) return true;
    return false;
  }

  // ── Title-block labels ──────────────────────────────────────────────────
  // field: what the label introduces. w: how strongly. loose: the value may
  // follow on the same text item without a ':' ("REV B", "DWG NO E-101").
  var LABEL_DEFS = [
    { f: 'sheetNumber', w: 7, loose: true, b: 'contract\\s*(?:sheet|dwg\\.?|drawing)\\s*(?:no\\.?|num(?:ber)?\\.?|#)' },
    { f: 'sheetNumber', w: 6, loose: true, b: '(?:sheet|sht\\.?|dwg\\.?|drawing|drg\\.?|document|doc\\.?)\\s*(?:no\\.?|num(?:ber)?\\.?|#|id)' },
    { f: 'sheetNumber', w: 5, loose: true, b: '(?:drawing|dwg\\.?)\\s*(?:code|ref(?:erence)?)' },
    { f: 'pageNumber', w: 6, loose: true, b: '(?:page|pg\\.?)\\s*(?:no\\.?|num(?:ber)?\\.?|#)?' },
    { f: 'revision', w: 6, loose: true, b: 'rev(?:ision)?s?\\.?\\s*(?:no\\.?|#|level)?' },
    { f: 'sheetTitle', w: 6, loose: false, b: '(?:drawing|dwg\\.?|sheet)?\\s*title' },
    { f: 'sheetNumber', w: 2, loose: false, b: 'sheet' },
    // Labels whose values are none of ours — they still claim their values.
    { f: 'other', w: 0, b: 'contract\\s*(?:no\\.?|num(?:ber)?|#)?' },
    { f: 'other', w: 0, b: '(?:project|proj\\.?|job|wbs)\\s*(?:no\\.?|num(?:ber)?|#|id|name|bs)?' },
    { f: 'other', w: 0, b: 'teamcenter(?:\\s+(?:dwg|drawing|doc))?\\s*(?:no\\.?|num(?:ber)?|#)?' },
    { f: 'other', w: 0, b: '[a-z][a-z ]*?\\s(?:dwg|drawing|doc)\\.?\\s*(?:no\\.?|num(?:ber)?|#)' },
    { f: 'other', w: 0, b: 'cdrl\\s*(?:dwg|drawing)?\\.?\\s*(?:no\\.?|num(?:ber)?)?' },
    { f: 'other', w: 0, b: '(?:cadd?\\s*)?(?:file\\s*name|filename|file)' },
    { f: 'other', w: 0, b: '(?:sheet\\s*|paper\\s*)?size|scale|n\\.?t\\.?s\\.?' },
    { f: 'other', w: 0, b: '(?:plot\\s*|issue\\s*|revision\\s*)?date' },
    { f: 'other', w: 0, b: '(?:drawn|designed|checked|approved|reviewed|submitted|prepared|issued)(?:\\s*by)?' },
    { f: 'other', w: 0, b: "(?:dwn|drn|dsgn|des|chk|chkd|ckd|app|app'd|appd|appr|eng|engr|by)\\.?" },
    { f: 'other', w: 0, b: 'cont\\.?\\s*on|field\\s*office|master\\s*copy|description|remarks|notes?|legend|key\\s*plan|of' },
    { f: 'other', w: 0, b: 'ref(?:erence)?\\.?\\s*(?:dwg|drawings?|dwgs)\\.?' },
    { f: 'other', w: 0, b: 'project|bart|hitachi|inspire\\s*the\\s*next' },
  ];
  LABEL_DEFS.forEach(function (d) {
    d.full = new RegExp('^(?:' + d.b + ')\\s*[:.#]*$', 'i');
    d.inl = d.loose
      ? new RegExp('^(?:' + d.b + ')[\\s:#.]+(\\S.*)$', 'i')
      : new RegExp('^(?:' + d.b + ')\\s*[:#]\\s*(\\S.*)$', 'i');
  });

  function inlineValueOk(f, rest) {
    var first = rest.split(' ')[0];
    if (f === 'sheetNumber') return sheetWeight(first) > 0 || relaxedSheetOk(first);
    if (f === 'revision') return isRevCode(first);
    if (f === 'pageNumber') return /^\d{1,4}$/.test(first.replace(/[.,]$/, ''));
    return rest.length > 0;
  }

  // → null | { f, w, rest } (rest '' = the phrase is only a label)
  function classifyLabel(str) {
    var s = clean(str);
    if (!s || s.length > 60) return null;
    var i, d, m;
    for (i = 0; i < LABEL_DEFS.length; i++) {
      d = LABEL_DEFS[i];
      if (d.full.test(s)) return { f: d.f, w: d.w, rest: '' };
    }
    for (i = 0; i < LABEL_DEFS.length; i++) {
      d = LABEL_DEFS[i];
      m = d.inl.exec(s);
      if (m && inlineValueOk(d.f, clean(m[1]))) return { f: d.f, w: d.w, rest: clean(m[1]) };
    }
    return null;
  }
  function isLabelOnly(str) { var l = classifyLabel(str); return !!(l && !l.rest); }

  // ── Geometry ────────────────────────────────────────────────────────────
  function mul(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  // Rotate the displayed page by k quarter-turns so text of orientation k
  // reads left→right. Frame dims: k even → W×H, k odd → H×W.
  function toFrame(k, x, y, W, H) {
    if (k === 1) return [y, W - x];
    if (k === 2) return [W - x, H - y];
    if (k === 3) return [H - y, x];
    return [x, y];
  }
  function boxToFrame(k, d, W, H) {
    var a = toFrame(k, d[0], d[1], W, H), b = toFrame(k, d[2], d[3], W, H);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
  function frameDims(k, W, H) { return (k % 2) ? [H, W] : [W, H]; }
  function union(a, b) { return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice(); }
  function toFrac(d, W, H) { return d ? { x: d[0] / W, y: d[1] / H, w: (d[2] - d[0]) / W, h: (d[3] - d[1]) / H } : null; }

  // pdf.js text items → runs in displayed-page coordinates (points, y down).
  function toRuns(items, viewport) {
    var W = viewport.width, H = viewport.height;
    var vt = viewport.transform || [1, 0, 0, -1, 0, H];
    var scale = viewport.scale || 1;
    var runs = [], seen = Object.create(null);
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      if (!it || !it.transform || typeof it.str !== 'string' || !it.str.trim()) continue;
      var t = mul(vt, it.transform);
      var fs = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
      var sx = Math.hypot(t[0], t[1]) || fs;
      if (!(fs > 0.5)) continue;
      var deg = Math.atan2(t[1], t[0]) * 180 / Math.PI;
      var q90 = Math.round(deg / 90);
      if (Math.abs(deg - q90 * 90) > 8) continue;  // skewed annotation text — never a title block
      var k = ((q90 % 4) + 4) % 4;
      var dir = [t[0] / sx, t[1] / sx], upv = [t[2] / fs, t[3] / fs];
      var str = it.str.replace(/[\u2010-\u2015\u2212]/g, '-');
      var len = (it.width || 0) * scale;
      if (!(len > 0)) len = str.length * fs * 0.55;
      var ox = t[4], oy = t[5];
      var xs = [ox - upv[0] * 0.2 * fs, ox + dir[0] * len - upv[0] * 0.2 * fs, ox + upv[0] * 0.85 * fs, ox + dir[0] * len + upv[0] * 0.85 * fs];
      var ys = [oy - upv[1] * 0.2 * fs, oy + dir[1] * len - upv[1] * 0.2 * fs, oy + upv[1] * 0.85 * fs, oy + dir[1] * len + upv[1] * 0.85 * fs];
      var d = [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
      // CAD "bold" is often the same text drawn 2–4 times a hair apart.
      var qd = Math.max(1, fs * 0.3);
      var key = k + '|' + str.trim() + '|' + Math.round(d[0] / qd) + '|' + Math.round(d[1] / qd);
      if (seen[key]) continue;
      seen[key] = 1;
      runs.push({ str: str, k: k, fs: fs, idx: i, d: d });
    }
    return runs;
  }

  // Runs → phrases: same orientation, same baseline, small gaps.
  function buildPhrases(runs, W, H) {
    var byK = [[], [], [], []], out = [];
    runs.forEach(function (r) { r.f = boxToFrame(r.k, r.d, W, H); r.bl = r.f[3] - 0.2 * r.fs; byK[r.k].push(r); });
    for (var k = 0; k < 4; k++) {
      var rs = byK[k];
      if (!rs.length) continue;
      rs.sort(function (a, b) { return a.bl - b.bl || a.f[0] - b.f[0]; });
      var lines = [], open = [];
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        open = open.filter(function (L) { return r.bl - L.bl <= 0.45 * Math.max(L.fs, r.fs); });
        var best = null, bd = Infinity;
        for (var j = 0; j < open.length; j++) {
          var L = open[j], dd = Math.abs(r.bl - L.bl), ratio = r.fs / L.fs;
          if (dd <= 0.4 * Math.max(r.fs, L.fs) && ratio > 0.55 && ratio < 1.8 && dd < bd) { best = L; bd = dd; }
        }
        if (best) best.runs.push(r);
        else { var nl = { bl: r.bl, fs: r.fs, runs: [r] }; lines.push(nl); open.push(nl); }
      }
      lines.forEach(function (Ln) {
        Ln.runs.sort(function (a, b) { return a.f[0] - b.f[0]; });
        var cur = null;
        Ln.runs.forEach(function (r) {
          if (cur) {
            var gap = r.f[0] - cur.f[2], fsMax = Math.max(cur.lastFs, r.fs), ratio = r.fs / cur.lastFs;
            if (gap < 0.8 * fsMax && ratio > 0.7 && ratio < 1.43) {
              if (gap > 0.15 * fsMax && !/\s$/.test(cur.raw) && !/^\s/.test(r.str)) cur.raw += ' ';
              cur.raw += r.str;
              cur.f = union(cur.f, r.f); cur.d = union(cur.d, r.d);
              cur.fs = Math.max(cur.fs, r.fs); cur.lastFs = r.fs;
              cur.idx = Math.min(cur.idx, r.idx);
              return;
            }
            out.push(cur); cur = null;
          }
          cur = { raw: r.str, k: k, fs: r.fs, lastFs: r.fs, f: r.f.slice(), d: r.d.slice(), idx: r.idx };
        });
        if (cur) out.push(cur);
      });
    }
    return out.map(function (p) {
      return { str: clean(p.raw), k: p.k, fs: p.fs, f: p.f, d: p.d, idx: p.idx };
    }).filter(function (p) { return p.str; });
  }

  // ── Label → value ownership ─────────────────────────────────────────────
  // Cost of reading phrase v as the value of label L (same orientation).
  // Values sit to the right on the same line, or below (left-aligned or
  // centred in the cell); rarely above. Infinity = not related.
  function ownCost(L, v) {
    if (L.k !== v.k) return Infinity;
    var fsRef = Math.max(L.fs, Math.min(v.fs, L.fs * 3) * 0.6, 1);
    var lcy = (L.f[1] + L.f[3]) / 2, vcy = (v.f[1] + v.f[3]) / 2;
    var dyc = vcy - lcy, maxFs = Math.max(L.fs, v.fs);
    if (Math.abs(dyc) < 0.6 * maxFs && v.f[0] >= L.f[2] - 0.5 * fsRef) {
      var gx = Math.max(0, v.f[0] - L.f[2]) / fsRef;
      return gx <= 30 ? 0.3 + gx * 0.6 : Infinity;
    }
    // Horizontal offset: values may be centred well right of a cell's corner
    // label, but hardly ever sit to its left.
    var left = v.f[2] < L.f[0] - fsRef, mis = left ? (L.f[0] - v.f[2]) : (v.f[0] > L.f[2] + fsRef) ? (v.f[0] - L.f[2]) : 0;
    mis /= fsRef;
    if (mis > (left ? 3 : 15)) return Infinity;
    var lim = L.lab && L.lab.f === 'sheetTitle' ? 14 : 8;
    if (dyc > 0) {
      var gap = (v.f[1] - L.f[3]) / fsRef;
      if (gap < -0.6 || gap > lim) return Infinity;
      return 0.5 + Math.max(0, gap) + mis * 0.4;
    }
    var gapUp = (L.f[1] - v.f[3]) / fsRef;
    if (gapUp < -0.6 || gapUp > 4) return Infinity;
    return 3 + Math.max(0, gapUp) + mis * 0.4;
  }

  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ── Page analysis (pass 0) ──────────────────────────────────────────────
  // regions: { sheetNumber: {fx,fy,fw,fh}, ... } fractions of the displayed page.
  function analyzePage(items, viewport, opts) {
    opts = opts || {};
    var W = viewport.width, H = viewport.height;
    var runs = toRuns(items, viewport);
    var chars = 0;
    runs.forEach(function (r) { chars += r.str.trim().length; });
    var model = { W: W, H: H, noText: chars < 4, runCount: runs.length };
    var phrases = buildPhrases(runs, W, H);
    phrases.forEach(function (p) { p.lab = classifyLabel(p.str); });

    // Reading orientation of the title block: where the labels are, else
    // where most of the text is.
    var labCount = [0, 0, 0, 0], charCount = [0, 0, 0, 0];
    phrases.forEach(function (p) { charCount[p.k] += p.str.length; if (p.lab && p.lab.f !== 'other') labCount[p.k] += 2; else if (p.lab) labCount[p.k]++; });
    var k0 = 0;
    for (var k = 1; k < 4; k++) {
      if (labCount[k] > labCount[k0] || (labCount[k] === labCount[k0] && charCount[k] > charCount[k0])) k0 = k;
    }
    var dims = frameDims(k0, W, H);
    model.k0 = k0;
    phrases.forEach(function (p) {
      var fb = boxToFrame(k0, p.d, W, H);
      p.pos = [((fb[0] + fb[2]) / 2) / dims[0], ((fb[1] + fb[3]) / 2) / dims[1]];
    });

    // Title-block zone: bottom strip ∪ right strip (as seen in k0).
    var zone = phrases.filter(function (p) { return p.pos[1] >= 0.58 || p.pos[0] >= 0.68; });
    var labels = zone.filter(function (p) { return p.lab && !p.lab.rest; });
    zone.forEach(function (p) {
      if (p.lab && !p.lab.rest) return;
      var best = null, bc = Infinity;
      labels.forEach(function (L) {
        L.lab = L.lab || classifyLabel(L.str);
        var c = ownCost(L, p);
        if (c < bc) { bc = c; best = L; }
      });
      p.owner = best ? { f: best.lab.f, w: best.lab.w, cost: bc, L: best } : null;
    });
    model.zone = zone;
    model.labels = labels;
    model.medFs = median(zone.filter(function (p) { return !(p.lab && !p.lab.rest); }).map(function (p) { return p.fs; })) || 10;
    model.keys = Object.create(null);
    zone.forEach(function (p) { var key = up(p.str); if (key.length >= 3) model.keys[key] = 1; });

    model.bannerTitle = bannerTitle(phrases, W, H);

    // Calibrated regions: read each from the runs inside its box.
    model.region = {};
    var regions = opts.regions || {};
    FIELDS.forEach(function (f) {
      var r = regions[f];
      if (!r || !(r.fw > 0.005) || !(r.fh > 0.005)) return;
      var v = readRegion(runs, W, H, r, f);
      if (v) model.region[f] = v;
    });
    return model;
  }

  // CBTC template anchor: the CAD software writes the per-sheet title into the
  // content stream BEFORE the "DESIGN-BUILD OF A … (CBTC) SYSTEM" banner, and
  // it sits below the banner in the left part of the strip.
  function bannerTitle(phrases, W, H) {
    var banner = null;
    phrases.forEach(function (p) { if (/design[\s-]+build/i.test(p.str) && (!banner || p.idx < banner.idx)) banner = p; });
    if (!banner || banner.idx <= 0) return null;
    var dims = frameDims(banner.k, W, H), bbl = banner.f[3] - 0.2 * banner.fs;
    var lines = phrases.filter(function (p) {
      var s = p.str, bl = p.f[3] - 0.2 * p.fs;
      return p.k === banner.k && p.idx < banner.idx && s.length >= 3
        && bl > bbl && bl < bbl + dims[1] * 0.25 && p.f[0] < dims[0] * 0.65
        && !isLabelOnly(s) && !isBanner(s) && !sheetWeight(s) && !/^\d{1,4}$/.test(s) && !isJunkTitle(s);
    });
    if (!lines.length) return null;
    lines.sort(function (a, b) { return (a.f[3] - b.f[3]) || (a.f[0] - b.f[0]); });
    var d = null;
    lines.forEach(function (p) { d = union(d, p.d); });
    return { text: lines.map(function (p) { return p.str; }).join(' '), d: d };
  }

  // ── Calibrated region → value ───────────────────────────────────────────
  function runsInRegion(runs, W, H, r) {
    var rx0 = r.fx * W, ry0 = r.fy * H, rx1 = (r.fx + r.fw) * W, ry1 = (r.fy + r.fh) * H;
    return runs.filter(function (q) {
      var a = Math.max(1e-6, (q.d[2] - q.d[0]) * (q.d[3] - q.d[1]));
      var iw = Math.min(q.d[2], rx1) - Math.max(q.d[0], rx0), ih = Math.min(q.d[3], ry1) - Math.max(q.d[1], ry0);
      return iw > 0 && ih > 0 && (iw * ih) / a >= 0.5;
    });
  }
  function readingOrder(ps) {
    return ps.slice().sort(function (a, b) {
      var la = a.f[3] - 0.2 * a.fs, lb = b.f[3] - 0.2 * b.fs;
      return Math.abs(la - lb) < 0.4 * Math.max(a.fs, b.fs) ? a.f[0] - b.f[0] : la - lb;
    });
  }
  function readRegion(runs, W, H, r, field) {
    var inside = runsInRegion(runs, W, H, r).map(function (q) { return { str: q.str, k: q.k, fs: q.fs, idx: q.idx, d: q.d.slice() }; });
    if (!inside.length) return null;
    var ps = readingOrder(buildPhrases(inside, W, H));
    var vals = [];
    ps.forEach(function (p) {
      var l = classifyLabel(p.str);
      if (l && !l.rest) return;                       // the label printed in the box
      if (field === 'sheetTitle' && l && l.f === 'other') return;   // "SCALE: NTS" caught in a title box
      vals.push({ str: l && l.rest && l.f === field ? l.rest : p.str, p: p });
    });
    var lines = ps.map(function (p) { return p.str; });
    if (!vals.length) return { value: null, conf: null, d: null, lines: lines };
    var best = null, conf = 'high';
    if (field === 'sheetNumber') {
      vals.forEach(function (v) {
        v.str.split(' ').concat([v.str]).forEach(function (tok) {
          var w = sheetWeight(tok) || (relaxedSheetOk(tok) ? 0.4 : 0);
          var s = w * 10 + v.p.fs / 100;
          if (w && (!best || s > best.s)) best = { s: s, value: normSheet(tok), p: v.p, w: w };
        });
      });
      if (best && best.w < 1) conf = 'medium';
    } else if (field === 'revision') {
      var codes = [];
      vals.forEach(function (v) {
        var m = up(v.str).match(/(?:^|\s)REV(?:ISION)?\.?\s*(?:NO\.?\s*)?[:#]?\s*([A-Z0-9]{1,3})(?=\s|$)/);
        if (m && isRevCode(m[1])) codes.push({ value: m[1], p: v.p, inline: true });
        else if (isRevCode(v.str)) codes.push({ value: up(v.str).replace(/[.:]$/, ''), p: v.p });
      });
      if (codes.length) {
        var inl = codes.filter(function (c) { return c.inline; });
        if (inl.length) best = inl[0];
        else if (codes.length === 1) best = codes[0];
        else { best = codes.reduce(function (a, b) { return revRank(b.value) > revRank(a.value) ? b : a; }); conf = 'medium'; }
      }
    } else if (field === 'pageNumber') {
      vals.forEach(function (v) {
        if (best) return;
        var m = up(v.str).match(/(?:^|\s)(\d{1,4})\s*(?:OF|\/)\s*\d{1,4}$/) || up(v.str).match(/^(?:PAGE|PG\.?|SHEET|SHT\.?)?\s*(\d{1,4})$/);
        if (m) best = { value: m[1], p: v.p };
      });
    } else {
      var keep = vals.filter(function (v) { return !isBanner(v.str); });
      if (!keep.length) keep = vals;
      var d = null;
      keep.forEach(function (v) { d = union(d, v.p.d); });
      return { value: keep.map(function (v) { return v.str; }).join(' '), conf: 'high', d: d, lines: lines };
    }
    if (!best) {
      // Something is in the box but it isn't the expected shape: hand it over,
      // flagged, rather than silently dropping what the user pointed at.
      var first = vals[0];
      return { value: field === 'sheetNumber' ? normSheet(first.str) : clean(first.str), conf: 'low', d: first.p.d, lines: lines };
    }
    return { value: best.value, conf: conf, d: best.p.d, lines: lines };
  }

  // ── Field extraction for one page (passes 1 and 2) ──────────────────────
  function frac(model, d) { return toFrac(d, model.W, model.H); }

  function pickSheet(model, ctx) {
    var cands = [];
    model.zone.forEach(function (p) {
      var lab = p.lab;
      if ((lab && !lab.rest) || !/\d/.test(p.str)) return;      // every sheet number has a digit
      var text = lab && lab.rest ? lab.rest : p.str;
      var inl = lab && lab.rest ? lab : null;
      var owner = p.owner && p.owner.cost < 12 ? p.owner : null;
      var whole = normSheet(text), list = [];
      var fileLike = /\.(dgn|dwg|dxf|pdf|rvt)\b/i.test(text);
      var ww = sheetWeight(whole);
      if (ww > 0) list.push({ t: whole, w: ww, whole: true });
      else {
        text.split(' ').forEach(function (tok, i, arr) {
          var tt = fileLike ? tok.replace(/\.(dgn|dwg|dxf|pdf|rvt)$/i, '') : tok;
          var w = sheetWeight(tt);
          if (w > 0) list.push({ t: normSheet(tt), w: w, whole: arr.length === 1, file: fileLike, before: classifyLabel(arr.slice(0, i).join(' ')) });
        });
      }
      var labelW = inl && inl.f === 'sheetNumber' ? inl.w : owner && owner.f === 'sheetNumber' ? owner.w : 0;
      if (!list.length && labelW >= 5 && relaxedSheetOk(whole)) list.push({ t: whole, w: 0.5, whole: true, relaxed: true });
      list.forEach(function (c) {
        var s = c.w + (c.whole ? 1 : -1), viaLabel = false;
        if (c.before && !c.before.rest && c.before.f === 'sheetNumber' && c.before.w >= 5) { s += c.before.w; viaLabel = true; }
        else if (c.before && !c.before.rest) s -= c.before.f === 'other' ? 6 : 4;
        else if (inl && inl.f === 'sheetNumber') { s += inl.w; viaLabel = true; }
        else if (inl) s -= 6;
        else if (owner) {
          if (owner.f === 'sheetNumber') { s += owner.w - Math.min(owner.cost, 10) * 0.2; viaLabel = owner.w >= 5; }
          else if (owner.cost < 6 && owner.f === 'other' && !c.file) s -= 6;
          else if (owner.cost < 6 && owner.f !== 'other') s -= 4;
        }
        if (c.file) s = Math.min(s, 3.2);           // CADD file name: a fallback only
        s += Math.max(0, Math.min(2.5, p.fs / model.medFs - 1));
        s += 1.5 * (0.5 * p.pos[0] + 0.5 * p.pos[1]);
        if (/\b(SEE|REF|REFER|REFERENCE|TYP|SIM|DETAIL|SECTION|CONT(?:INUED)?)\b/i.test(p.str)) s -= 3;
        // Text on most pages is template, not a sheet number — unless a
        // DRAWING NO. label vouches for it (one number can span several pages).
        if (ctx.bp && ctx.bp[up(p.str)] && !viaLabel) s -= 8;
        var learnedHit = false;
        if (ctx.learned && ctx.learned.sheetPos) {
          var lp = ctx.learned.sheetPos;
          if (Math.hypot(p.pos[0] - lp[0], p.pos[1] - lp[1]) < 0.04) { s += 4; learnedHit = true; }
        }
        if (ctx.learned && ctx.learned.shape) s += shapeOf(c.t) === ctx.learned.shape ? 2 : -1;
        cands.push({ t: c.t, s: s, p: p, viaLabel: viaLabel, relaxed: !!c.relaxed, w: c.w, learned: learnedHit, file: !!c.file });
      });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.s - a.s; });
    var best = cands[0];
    if (best.s < 3) return null;
    var runner = null;
    for (var i = 1; i < cands.length; i++) if (cands[i].t !== best.t) { runner = cands[i]; break; }
    var margin = runner ? best.s - runner.s : 99;
    var conf, via;
    if (best.viaLabel && !best.relaxed && margin >= 1.5) { conf = 'high'; via = 'label'; }
    else if (best.viaLabel) { conf = 'medium'; via = 'label'; }
    else if (best.learned && best.w >= 1 && margin >= 2) { conf = ctx.learned.weakSheet ? 'medium' : 'high'; via = 'learned'; }
    else if (best.file) { conf = 'low'; via = 'file'; }
    else if (best.s >= 6 && margin >= 1.5) { conf = 'medium'; via = 'pattern'; }
    else { conf = 'low'; via = 'pattern'; }
    return { value: best.t, conf: conf, via: via, d: best.p.d, p: best.p, score: best.s };
  }

  function pickRevision(model, ctx, sheet) {
    var cands = [];
    var sheetC = sheet && sheet.p ? [(sheet.p.f[0] + sheet.p.f[2]) / 2, (sheet.p.f[1] + sheet.p.f[3]) / 2] : null;
    function near(p) {
      if (!sheetC || !sheet.p || sheet.p.k !== p.k) return 0;
      var c = [(p.f[0] + p.f[2]) / 2, (p.f[1] + p.f[3]) / 2];
      return Math.hypot(c[0] - sheetC[0], c[1] - sheetC[1]) < 30 * Math.max(p.fs, sheet.p.fs) ? 1.5 : 0;
    }
    model.zone.forEach(function (p) {
      if (p.lab && !p.lab.rest) return;
      var text = up(p.str);
      if (p.lab && p.lab.rest && p.lab.f === 'revision') {
        cands.push({ v: p.lab.rest.split(' ')[0].replace(/[.:]$/, '').toUpperCase(), s: 6.5 + near(p), p: p, conf: 'high' });
        return;
      }
      var m = text.indexOf('REV') >= 0 && text.match(/(?:^|\s)REV(?:ISION)?\.?\s*(?:NO\.?\s*)?[:#]?\s*([A-Z0-9]{1,3})(?=\s|$)/);
      if (m && isRevCode(m[1]) && !(p.owner && p.owner.f === 'other' && p.owner.cost < 3)) cands.push({ v: m[1], s: 6 + near(p), p: p, conf: 'high' });
    });
    // REV labels: a single value under it is the title-block box; a column of
    // codes is the revision history table — its latest entry counts.
    model.labels.forEach(function (L) {
      if (L.lab.f !== 'revision') return;
      var col = model.zone.filter(function (p) {
        if (p.k !== L.k || !isRevCode(p.str)) return false;
        var cx = (p.f[0] + p.f[2]) / 2;
        return cx > L.f[0] - 1.5 * L.fs && cx < L.f[2] + 1.5 * L.fs;
      });
      function walk(dirDown) {
        var list = col.filter(function (p) { return dirDown ? p.f[1] >= L.f[3] - 0.5 * L.fs : p.f[3] <= L.f[1] + 0.5 * L.fs; });
        list.sort(function (a, b) { return dirDown ? a.f[1] - b.f[1] : b.f[3] - a.f[3]; });
        var out = [], edge = dirDown ? L.f[3] : L.f[1];
        for (var i = 0; i < list.length; i++) {
          var p = list[i], gap = dirDown ? p.f[1] - edge : edge - p.f[3];
          if (gap > 3.5 * Math.max(p.fs, L.fs)) break;
          if (p.owner && p.owner.L !== L && p.owner.cost < ownCost(L, p) - 0.5) break;
          out.push(p);
          edge = dirDown ? p.f[3] : p.f[1];
        }
        return out;
      }
      var stack = walk(true);
      if (!stack.length) stack = walk(false);
      if (!stack.length) {
        // centred in a wide cell to the right of / below the label
        var own = model.zone.filter(function (p) { return p.owner && p.owner.L === L && isRevCode(p.str); });
        own.sort(function (a, b) { return a.owner.cost - b.owner.cost; });
        if (own.length) cands.push({ v: up(own[0].str).replace(/[.:]$/, ''), s: 6.5 - Math.min(own[0].owner.cost, 8) * 0.2 + near(own[0]), p: own[0], conf: 'high' });
        return;
      }
      if (stack.length === 1) {
        cands.push({ v: up(stack[0].str).replace(/[.:]$/, ''), s: 6.5 + near(stack[0]), p: stack[0], conf: 'high' });
      } else {
        var latest = stack.reduce(function (a, b) { return revRank(b.str) > revRank(a.str) ? b : a; });
        cands.push({ v: up(latest.str).replace(/[.:]$/, ''), s: 4.5 + near(latest), p: latest, conf: 'medium' });
      }
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.s - a.s; });
    var b = cands[0];
    return { value: b.v, conf: b.conf, via: 'label', d: b.p.d };
  }

  function pickPage(model) {
    var cands = [];
    model.zone.forEach(function (p) {
      var lab = p.lab;
      if ((lab && !lab.rest) || !/\d/.test(p.str)) return;
      var text = up(lab && lab.rest ? lab.rest : p.str);
      var owner = p.owner && p.owner.cost < 10 ? p.owner : null;
      var m;
      if (lab && lab.rest && lab.f === 'pageNumber') {
        m = text.match(/^(\d{1,4})/);
        if (m) cands.push({ v: m[1], s: 6.5, p: p, conf: 'high' });
        return;
      }
      if ((m = up(p.str).match(/^(?:(PAGE|PG\.?|SHEET|SHT\.?)\s*(?:NO\.?)?\s*)?(\d{1,4})\s*(?:OF|\/)\s*(\d{1,4})$/))) {
        if (parseInt(m[2], 10) > parseInt(m[3], 10) || m[2] === '0') return;
        var pre = m[1] || '';
        var s = /^P/.test(pre) ? 6 : pre ? 4.5 : (owner && (owner.f === 'pageNumber' || owner.f === 'sheetNumber') ? 5 : 3);
        cands.push({ v: m[2], s: s, p: p, conf: s >= 6 ? 'high' : s >= 4.5 ? 'medium' : 'low' });
        return;
      }
      if (owner && owner.f === 'pageNumber' && /^\d{1,4}$/.test(text)) cands.push({ v: text, s: 6.5 - Math.min(owner.cost, 8) * 0.2, p: p, conf: 'high' });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.s - a.s; });
    var b = cands[0];
    if (b.s < 3) return null;
    return { value: b.v, conf: b.conf, via: 'label', d: b.p.d };
  }

  function titleish(p, model, ctx, sheetVal) {
    var s = p.str;
    if (s.length < 3 || (s.match(/[A-Za-z]/g) || []).length < 3) return false;
    if (p.lab) return false;
    if (isBanner(s) || isDate(s) || isJunkTitle(s) || STATUS_RE.test(s) || SCALE_RE.test(s)) return false;
    if (sheetWeight(s) || (sheetVal && up(s).indexOf(sheetVal) >= 0 && s.length < sheetVal.length + 6)) return false;
    if (!/\s/.test(s) && s.replace(/[^A-Za-z]/g, '').length < 4) return false;
    if (p.owner && p.owner.cost < 6 && p.owner.f !== 'sheetTitle') return false;
    return true;
  }

  function joinLines(ps) {
    var o = readingOrder(ps), d = null;
    o.forEach(function (p) { d = union(d, p.d); });
    return { text: o.map(function (p) { return p.str; }).join(' ').replace(/\s+/g, ' ').trim(), d: d };
  }

  function pickTitle(model, ctx, sheetVal) {
    // 1. CBTC banner anchor
    if (model.bannerTitle) return { value: model.bannerTitle.text, conf: 'high', via: 'template', d: model.bannerTitle.d };
    // 2. TITLE / DRAWING TITLE label
    var titleLabels = model.labels.filter(function (L) { return L.lab.f === 'sheetTitle'; });
    for (var i = 0; i < titleLabels.length; i++) {
      var L = titleLabels[i];
      var owned = model.zone.filter(function (p) {
        return p.owner && p.owner.L === L && titleish(p, model, ctx, sheetVal);
      });
      if (owned.length) { var j = joinLines(owned); return { value: j.text, conf: 'high', via: 'label', d: j.d }; }
    }
    var inl = model.zone.filter(function (p) { return p.lab && p.lab.rest && p.lab.f === 'sheetTitle'; });
    if (inl.length) return { value: inl[0].lab.rest, conf: 'high', via: 'label', d: inl[0].d };

    var pool = model.zone.filter(function (p) { return titleish(p, model, ctx, sheetVal); });
    // 3. Where confident pages of this set had their title
    if (ctx.learned && ctx.learned.titleBox) {
      var tb = ctx.learned.titleBox;
      var inBox = pool.filter(function (p) { return p.pos[0] >= tb[0] && p.pos[0] <= tb[2] && p.pos[1] >= tb[1] && p.pos[1] <= tb[3]; });
      if (inBox.length) { var jb = joinLines(inBox); return { value: jb.text, conf: 'medium', via: 'learned', d: jb.d }; }
    }
    // 4. The most prominent block of words that changes from sheet to sheet.
    var fresh = pool.filter(function (p) { return !(ctx.bp && ctx.bp[up(p.str)]); });
    if (!fresh.length) return null;
    var blocks = [], open = [];
    fresh.sort(function (a, b) { return a.f[1] - b.f[1]; });
    fresh.forEach(function (p) {
      var home = null;
      // only blocks whose last line ends just above this phrase can take it
      open = open.filter(function (B) { return p.f[1] - B.f[3] <= 1.0 * Math.max(p.fs, B.fs); });
      for (var b = 0; b < open.length && !home; b++) {
        var B = open[b];
        if (B.k !== p.k) continue;
        var ratio = p.fs / B.fs;
        if (ratio < 0.74 || ratio > 1.35) continue;
        var vgap = p.f[1] - B.f[3];
        if (vgap > 1.0 * Math.max(p.fs, B.fs) || vgap < -0.5 * p.fs) continue;
        var overlap = Math.min(p.f[2], B.f[2]) - Math.max(p.f[0], B.f[0]);
        var cdiff = Math.abs((p.f[0] + p.f[2]) / 2 - (B.f[0] + B.f[2]) / 2);
        if (overlap > 0 || Math.abs(p.f[0] - B.f[0]) < p.fs || cdiff < 2 * p.fs) home = B;
      }
      if (home) { home.ps.push(p); home.f = union(home.f, p.f); home.fs = Math.max(home.fs, p.fs); }
      else { var nb = { k: p.k, fs: p.fs, f: p.f.slice(), ps: [p] }; blocks.push(nb); open.push(nb); }
    });
    blocks.forEach(function (B) {
      var words = B.ps.reduce(function (n, p) { return n + p.str.split(' ').length; }, 0);
      B.score = 3 * (B.fs / model.medFs) + Math.min(B.ps.length, 4) * 0.5 + Math.min(words, 8) * 0.2;
    });
    blocks.sort(function (a, b) { return b.score - a.score; });
    var top = blocks[0];
    if (!top) return null;
    var jt = joinLines(top.ps);
    var second = blocks[1];
    var strong = top.fs >= 1.25 * model.medFs && (!second || top.score - second.score >= 1);
    return { value: jt.text, conf: strong ? 'medium' : 'low', via: 'layout', d: jt.d };
  }

  function extractPage(model, ctx) {
    var out = { value: {}, conf: {}, via: {}, d: {}, p: {} };
    function set(f, r) {
      if (!r || !r.value) return;
      out.value[f] = r.value; out.conf[f] = r.conf; out.via[f] = r.via; out.d[f] = r.d || null; if (r.p) out.p[f] = r.p;
    }
    // A calibrated box wins — unless what it holds on this page doesn't look
    // like the field (boxes are remembered per location, and a later set can
    // use another template) while automatic reading is sure.
    function pick(f, auto) {
      var r = model.region[f];
      if (!r || !r.value) return auto();
      if (r.conf !== 'low') return Object.assign({ via: 'region' }, r);
      var a = auto();
      return a && a.conf === 'high' ? a : Object.assign({ via: 'region' }, r);
    }
    if (model.noText) return out;
    var sheet = pick('sheetNumber', function () { return pickSheet(model, ctx); });
    set('sheetNumber', sheet);
    set('revision', pick('revision', function () { return pickRevision(model, ctx, sheet && sheet.p ? sheet : null); }));
    set('pageNumber', pick('pageNumber', function () { return pickPage(model); }));
    set('sheetTitle', pick('sheetTitle', function () { return pickTitle(model, ctx, out.value.sheetNumber); }));
    return out;
  }

  // ── Set-level learning ──────────────────────────────────────────────────
  function boilerplate(models) {
    var withText = models.filter(function (m) { return !m.noText; });
    if (withText.length < 3) return null;
    var counts = Object.create(null);
    withText.forEach(function (m) { for (var k in m.keys) counts[k] = (counts[k] || 0) + 1; });
    var need = Math.max(3, Math.ceil(withText.length * 0.6)), bp = Object.create(null), any = false;
    for (var key in counts) if (counts[key] >= need) { bp[key] = 1; any = true; }
    return any ? bp : null;
  }

  function cluster(points, tol) {
    // Largest group of points within tol of the group's median.
    if (!points.length) return null;
    var mx = median(points.map(function (p) { return p[0]; })), my = median(points.map(function (p) { return p[1]; }));
    var inG = points.filter(function (p) { return Math.hypot(p[0] - mx, p[1] - my) < tol; });
    return { center: [mx, my], members: inG, share: inG.length / points.length };
  }

  // Where (and in what shape) the set's sheet numbers and titles sit. Learned
  // from confident pages; failing that, from every page when they all agree
  // (an unlabelled template) — that consensus is trusted less ("weak").
  function learn(models, res) {
    var learned = {}, any = false;
    var withText = res.filter(function (r, i) { return !models[i].noText; }).length;
    function sheetTier(accept) {
      var pts = [], shapes = Object.create(null), n = 0;
      res.forEach(function (r) {
        if (!r.p.sheetNumber || r.via.sheetNumber === 'region' || !accept(r.conf.sheetNumber)) return;
        pts.push(r.p.sheetNumber.pos);
        var sh = shapeOf(r.value.sheetNumber);
        shapes[sh] = (shapes[sh] || 0) + 1; n++;
      });
      return { pts: pts, shapes: shapes, n: n };
    }
    var t = sheetTier(function (c) { return c === 'high'; }), need = 0.6, weak = false;
    if (t.n < 2 && withText >= 3) { t = sheetTier(function (c) { return !!c; }); need = 0.8; weak = true; if (t.n < Math.max(3, withText * 0.8)) t = { n: 0 }; }
    if (t.n >= 2) {
      var c = cluster(t.pts, 0.04);
      if (c && c.share >= need) { learned.sheetPos = c.center; any = true; }
      for (var sh in t.shapes) if (t.shapes[sh] / t.n >= need) { learned.shape = sh; any = true; }
      if (any && weak) learned.weakSheet = true;
    }
    function titleBoxes(accept) {
      var boxes = [];
      res.forEach(function (r, i) {
        if (!r.d.sheetTitle || r.via.sheetTitle === 'region' || r.via.sheetTitle === 'learned' || r.via.sheetTitle === 'bookmark') return;
        if (!accept(r.conf.sheetTitle)) return;
        var m = models[i], dims = frameDims(m.k0, m.W, m.H), fb = boxToFrame(m.k0, r.d.sheetTitle, m.W, m.H);
        boxes.push([fb[0] / dims[0], fb[1] / dims[1], fb[2] / dims[0], fb[3] / dims[1]]);
      });
      return boxes;
    }
    var boxes = titleBoxes(function (c) { return c === 'high' || c === 'medium'; }), tNeed = 0.6;
    if (boxes.length < 2 && withText >= 3) { boxes = titleBoxes(function (c) { return !!c; }); tNeed = 0.8; if (boxes.length < Math.max(3, withText * 0.8)) boxes = []; }
    if (boxes.length >= 2) {
      var tc = cluster(boxes.map(function (b) { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }), 0.06);
      if (tc && tc.share >= tNeed && tc.members.length >= 2) {
        var u = null;
        boxes.forEach(function (b) {
          var cc = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
          if (Math.hypot(cc[0] - tc.center[0], cc[1] - tc.center[1]) < 0.06) u = union(u, b);
        });
        learned.titleBox = [u[0] - 0.01, u[1] - 0.01, u[2] + 0.01, u[3] + 0.01];
        any = true;
      }
    }
    return any ? learned : null;
  }

  // ── Bookmarks / page labels ─────────────────────────────────────────────
  // "E-101 - FIRST FLOOR POWER PLAN" → { sheetNumber: 'E-101', title: 'FIRST FLOOR POWER PLAN' }
  function parseBookmark(str) {
    var s = clean(str);
    if (!s) return null;
    var m = s.match(/^([A-Za-z0-9][A-Za-z0-9.\-]*\d[A-Za-z0-9.\-]*)(?:\s*[-–—:|]\s*|\s+)(.+)$/);
    if (m && sheetWeight(m[1]) > 0) return { sheetNumber: normSheet(m[1]), title: clean(m[2]) };
    if (sheetWeight(s) > 0) return { sheetNumber: normSheet(s), title: null };
    if (/^(page|sheet|pg)\s*\d+$/i.test(s) || /^\d+$/.test(s) || /\.(pdf|dwg|dgn)$/i.test(s) || s.length < 4) return null;
    return { sheetNumber: null, title: s };
  }

  // ── Whole set ───────────────────────────────────────────────────────────
  // models: analyzePage() per PDF page, in order. opts.hints[i]: { bookmark, pageLabel }.
  function extractSet(models, opts) {
    opts = opts || {};
    var hints = opts.hints || [];
    var bp = boilerplate(models);
    var res = models.map(function (m) { return extractPage(m, { bp: bp }); });
    var learned = learn(models, res);
    if (learned) res = models.map(function (m) { return extractPage(m, { bp: bp, learned: learned }); });

    var out = res.map(function (r, i) {
      var m = models[i];
      var page = {
        pageIndex: i,
        sheetNumber: r.value.sheetNumber || null,
        sheetTitle: r.value.sheetTitle || null,
        revision: r.value.revision || null,
        pageNumber: r.value.pageNumber || null,
        confidence: {}, via: {}, sources: {}, issues: [], noText: !!m.noText,
      };
      FIELDS.forEach(function (f) {
        page.confidence[f] = r.conf[f] || null;
        page.via[f] = r.via[f] || null;
        page.sources[f] = r.d[f] ? frac(m, r.d[f]) : null;
      });
      // Bookmarks and page labels
      var h = hints[i] || {};
      var bm = h.bookmark ? parseBookmark(h.bookmark) : null;
      var pl = h.pageLabel && sheetWeight(h.pageLabel) > 0 ? normSheet(h.pageLabel) : null;
      var hintSheet = (bm && bm.sheetNumber) || pl;
      if (hintSheet) {
        if (page.sheetNumber && normSheet(page.sheetNumber) === hintSheet) page.confidence.sheetNumber = 'high';
        else if (!page.sheetNumber || page.confidence.sheetNumber === 'low') {
          page.sheetNumber = hintSheet; page.confidence.sheetNumber = 'medium'; page.via.sheetNumber = bm && bm.sheetNumber ? 'bookmark' : 'pagelabel'; page.sources.sheetNumber = null;
        }
      }
      if (bm && bm.title && (!page.sheetTitle || page.confidence.sheetTitle === 'low')) {
        page.sheetTitle = bm.title; page.confidence.sheetTitle = 'medium'; page.via.sheetTitle = 'bookmark'; page.sources.sheetTitle = null;
      }
      if (m.noText) page.issues.push('No selectable text on this page (scanned?) — enter its details by hand.');
      return page;
    });

    // Page numbers run in sequence: fill a single gap between two neighbours.
    for (var i = 1; i < out.length - 1; i++) {
      var a = out[i - 1].pageNumber, b = out[i + 1].pageNumber;
      if (!out[i].pageNumber && /^\d+$/.test(a || '') && /^\d+$/.test(b || '') && parseInt(b, 10) - parseInt(a, 10) === 2) {
        out[i].pageNumber = String(parseInt(a, 10) + 1); out[i].confidence.pageNumber = 'medium'; out[i].via.pageNumber = 'sequence';
      }
    }

    // The same sheet number on two pages is almost always a misread.
    var byNum = Object.create(null);
    out.forEach(function (p) { if (p.sheetNumber) (byNum[normSheet(p.sheetNumber)] = byNum[normSheet(p.sheetNumber)] || []).push(p); });
    for (var n in byNum) {
      var grp = byNum[n];
      if (grp.length < 2) continue;
      var pages = grp.map(function (p) { return p.pageNumber || ''; });
      if (pages.every(function (v) { return v; }) && new Set(pages).size === pages.length) continue;  // one drawing over several pages
      grp.forEach(function (p) {
        var others = grp.filter(function (q) { return q !== p; }).map(function (q) { return q.pageIndex + 1; });
        p.issues.push('Sheet number ' + p.sheetNumber + ' is also on page ' + others.join(', ') + '.');
        p.duplicate = true;
      });
    }

    out.forEach(function (p) {
      p.discipline = discipline(p.sheetNumber);
      p.needsReview = !p.sheetNumber || !p.sheetTitle || !!p.duplicate
        || p.confidence.sheetNumber === 'low' || p.confidence.sheetTitle === 'low';
      if (p.sheetNumber && p.confidence.sheetNumber === 'low') p.issues.push('Sheet number is a guess — check it.');
      if (p.sheetTitle && p.confidence.sheetTitle === 'low') p.issues.push('Title is a guess — check it.');
    });
    out.learned = learned;
    return out;
  }

  function parsePage(items, viewport, regions, hint) {
    return extractSet([analyzePage(items, viewport, { regions: regions })], { hints: [hint || {}] })[0];
  }

  // What a calibrated box reads on one page (calibration preview).
  function regionPreview(items, viewport, field, region) {
    var runs = toRuns(items, viewport);
    var r = readRegion(runs, viewport.width, viewport.height, region, field);
    return r || { value: null, conf: null, lines: [] };
  }

  // Every phrase on the page with its box (fractions) — for click-to-fill.
  function pagePhrases(items, viewport) {
    var W = viewport.width, H = viewport.height;
    return buildPhrases(toRuns(items, viewport), W, H).map(function (p) {
      var b = toFrac(p.d, W, H);
      return { str: p.str, x: b.x, y: b.y, w: b.w, h: b.h, k: p.k };
    });
  }

  // ── Discipline from the sheet-number prefix ─────────────────────────────
  var DISC = {
    C: 'Civil', E: 'Electrical', G: 'General', IN: 'Index', I: 'Index',
    TC: 'Train Control', T: 'Train Control', M: 'Mechanical',
    S: 'Structural', A: 'Architectural', L: 'Landscape',
    FP: 'Fire Protection', FS: 'Fire & Safety',
    P: 'Plumbing', FA: 'Fire Alarm', SIG: 'Signal', COM: 'Communications', COMM: 'Communications',
    TP: 'Traction Power', TPS: 'Traction Power', OCS: 'Overhead Contact System',
    CBTC: 'Train Control', ATC: 'Train Control',
  };
  function discipline(sheetNum) {
    if (!sheetNum) return 'General';
    var prefix = ((String(sheetNum).match(/^([A-Z]+)/i) || [])[1] || '').toUpperCase();
    if (DISC[prefix]) return DISC[prefix];
    // National CAD Standard two-letter designators: EP, EL → Electrical, AD → Architectural…
    if (prefix.length === 2 && 'AEMP'.indexOf(prefix[0]) >= 0) return DISC[prefix[0]];
    return prefix || 'General';
  }

  var api = {
    analyzePage: analyzePage,
    extractSet: extractSet,
    parsePage: parsePage,
    regionPreview: regionPreview,
    pagePhrases: pagePhrases,
    parseBookmark: parseBookmark,
    discipline: discipline,
    sheetWeight: sheetWeight,
    isRevCode: isRevCode,
    revRank: revRank,
    classifyLabel: classifyLabel,
    normSheet: normSheet,
    FIELDS: FIELDS,
  };
  root.DrwParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
