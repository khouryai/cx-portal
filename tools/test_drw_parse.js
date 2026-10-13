"use strict";
// Drawings title-block reader (drw-parse.js).
// Part 1 builds drawing-set PDFs (tools/drw_fixtures.js) and reads them with the
// real pdf.js, exactly as the upload modal does. Part 2 pins individual rules
// with hand-made text items.
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DrwParse = require("../drw-parse.js");
const F = require("./drw_fixtures.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

// pdf.js warns about canvas/fonts it doesn't need for text extraction.
const _w = console.warn, _l = console.log; console.warn = () => {}; console.log = () => {};
const pdfjsLib = require(path.join(ROOT, "vendor/js/pdf.min.js"));
console.warn = _w; console.log = _l;
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(ROOT, "vendor/js/pdf.worker.min.js");

async function readPdf(bytes, opts = {}) {
  const pdf = await pdfjsLib.getDocument({ data: bytes, verbosity: 0, isEvalSupported: false }).promise;
  const models = [], pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ items: tc.items, vp });
    models.push(DrwParse.analyzePage(tc.items, vp, { regions: opts.regions }));
  }
  return { out: DrwParse.extractSet(models, { hints: opts.hints }), pages };
}
const row = (p) => [p.sheetNumber, p.sheetTitle, p.revision, p.pageNumber];

// Hand-made pdf.js-style items on an upright W×H page: y is the baseline from the TOP.
function items(list, H = 1728) {
  return list.map(([str, x, y, fs]) => ({ str, transform: [fs, 0, 0, fs, x, H - y], width: str.length * fs * 0.6, height: fs }));
}
const VP = (W = 2592, H = 1728) => ({ width: W, height: H, scale: 1, transform: [1, 0, 0, -1, 0, H] });

(async () => {
  console.log("=== drawings title-block reader ===\n");

  // ── Template A: CBTC bottom strip ──────────────────────────────────────
  const cbtcWant = F.CBTC_SET.map((p) => [`E11004-W30-00${p.n}`, p.title.join(" "), p.rev, String(p.n)]);
  for (const mode of ["plain", "rotate90", "sideways"]) {
    const { out } = await readPdf(await F.buildPdf(F.cbtcPages(), mode));
    eq(`CBTC template (${mode}): every sheet number, title, revision, page`, out.map(row), cbtcWant);
    ok(`CBTC template (${mode}): all high confidence, nothing flagged`, out.every((p) => !p.needsReview && p.confidence.sheetNumber === "high" && p.confidence.sheetTitle === "high"));
  }
  {
    const { out } = await readPdf(await F.buildPdf(F.cbtcPages()));
    ok("revision comes from the title-block REV box, not the revision table", out[2].revision === "1" && out[2].confidence.revision === "high");
    ok("never reads the CONTRACT NO., TEAMCENTER DWG NO. or a drawing-area tag", out.every((p) => !/15CQ|W37-275|SIG-101|E11004-W30-009/.test(p.sheetNumber)));
    ok("discipline from the sheet-number prefix", out.every((p) => p.discipline === "Electrical"));
    const s = out[0].sources.sheetNumber;
    ok("reports where the sheet number was read (box on the page)", s && s.x > 0.74 && s.x < 0.78 && s.y > 0.92 && s.y < 0.95, JSON.stringify(s));
  }

  // ── Template B: NCS right strip, one character per text item, bold overprint
  const ncsWant = F.NCS_SET.map((p) => [p.num, p.title.join(" "), p.rev[p.rev.length - 1], null]);
  for (const mode of ["plain", "rotate90", "sideways"]) {
    const { out } = await readPdf(await F.buildPdf(F.ncsPages(), mode));
    eq(`NCS right-strip template (${mode}): number, title, latest revision`, out.map(row), ncsWant);
  }
  {
    const { out } = await readPdf(await F.buildPdf(F.ncsPages()));
    ok("a revision read from a history table is medium confidence", out[0].confidence.revision === "medium");
    ok("a lone table row is high confidence", out[2].confidence.revision === "high");
    ok("CAD bold overprint is not doubled in the title", out[0].sheetTitle === "FIRST FLOOR POWER PLAN");
    const single = await readPdf(await F.buildPdf([F.ncsPages()[1]]));
    eq("a single-page PDF reads on its own (no set to learn from)", row(single.out[0]), ["E-102", "SECOND FLOOR POWER PLAN", "2", null]);
  }

  // ── Calibrated regions (fractions of the page as displayed) ────────────
  {
    // Boxes drawn generously — they include the printed labels.
    const regions = {
      sheetNumber: { fx: 1940 / 2592, fy: 1585 / 1728, fw: 330 / 2592, fh: 55 / 1728 },
      sheetTitle: { fx: 90 / 2592, fy: 1520 / 1728, fw: 700 / 2592, fh: 70 / 1728 },
      revision: { fx: 2290 / 2592, fy: 1585 / 1728, fw: 60 / 2592, fh: 55 / 1728 },
    };
    for (const mode of ["plain", "rotate90"]) {
      const { out } = await readPdf(await F.buildPdf(F.cbtcPages(), mode), { regions });
      eq(`calibrated regions (${mode}): labels inside the box are ignored`, out.map(row), cbtcWant);
      ok(`calibrated regions (${mode}): reported as read from the region`, out.every((p) => p.via.sheetNumber === "region" && p.via.sheetTitle === "region"));
    }
    const { pages } = await readPdf(await F.buildPdf(F.cbtcPages(), "rotate90"));
    const pv = DrwParse.regionPreview(pages[0].items, pages[0].vp, "sheetNumber", regions.sheetNumber);
    ok("calibration preview says what the box reads", pv.value === "E11004-W30-001" && pv.lines.includes("CONTRACT SHEET NO."), JSON.stringify(pv));
    // A box remembered from another template lands on the wrong cell (the SCALE value).
    const stale = { fx: 1440 / 2592, fy: 1610 / 1728, fw: 60 / 2592, fh: 25 / 1728 };
    const st = await readPdf(await F.buildPdf(F.cbtcPages()), { regions: { sheetNumber: stale } });
    ok("a stale box that holds no sheet number gives way to a sure automatic read", st.out.every((p) => /^E11004-W30-00\d$/.test(p.sheetNumber) && p.via.sheetNumber === "label"), JSON.stringify(st.out.map((p) => [p.sheetNumber, p.via.sheetNumber])));
    const empty = { fx: 0.4, fy: 0.1, fw: 0.05, fh: 0.05 };
    const e = await readPdf(await F.buildPdf(F.cbtcPages()), { regions: { sheetNumber: empty } });
    ok("an empty region falls back to automatic reading", e.out[0].sheetNumber === "E11004-W30-001" && e.out[0].via.sheetNumber === "label");
  }

  // ── Template C: no labels at all — learned from the set ───────────────
  {
    const C = (num, title) => [
      { s: "ACME RAIL SYSTEMS", x: 2300, y: 1450, size: 14 },
      { s: "CITY TRANSIT CENTER", x: 2300, y: 1480, size: 16 },
      { s: "ISSUED FOR CONSTRUCTION", x: 1700, y: 1690, size: 20 },
      { s: title, x: 1700, y: 1600, size: 18 },
      { s: num, x: 2350, y: 1650, size: 30 },
      { s: "TC-7", x: 900, y: 700, size: 10 },
    ];
    const set = [["TC-301", "SIGNAL EQUIPMENT ROOM LAYOUT"], ["TC-302", "RELAY RACK ELEVATIONS"], ["TC-303", "CABLE TRAY PLAN"], ["TC-304", "GROUNDING DETAILS"]];
    const { out } = await readPdf(await F.buildPdf(set.map(([n, t]) => C(n, t))));
    eq("unlabelled title block: sheet numbers and titles", out.map((p) => [p.sheetNumber, p.sheetTitle]), set);
    ok("unlabelled title block: stamp and project banner never become the title", out.every((p) => !/ISSUED|CITY TRANSIT|ACME/.test(p.sheetTitle)));
    ok("unlabelled title block: the set agreeing makes it medium, learned", out.every((p) => p.via.sheetNumber === "learned" && p.confidence.sheetNumber === "medium" && p.confidence.sheetTitle === "medium" && !p.needsReview));
    const lone = await readPdf(await F.buildPdf([C(...set[0])]));
    ok("unlabelled single page: still a guess, flagged for review", lone.out[0].sheetNumber === "TC-301" && lone.out[0].confidence.sheetNumber === "low" && lone.out[0].needsReview);
  }

  // ── Scanned pages + bookmarks ──────────────────────────────────────────
  {
    const { out } = await readPdf(await F.buildPdf([[], F.ncsPages()[0]]), {
      hints: [{ bookmark: "E-001 - COVER SHEET" }, { bookmark: "E-101 - First Floor Power Plan" }],
    });
    ok("scanned page is flagged", out[0].noText && out[0].issues.some((s) => /scanned/.test(s)));
    eq("scanned page takes number and title from its bookmark", [out[0].sheetNumber, out[0].sheetTitle, out[0].via.sheetNumber], ["E-001", "COVER SHEET", "bookmark"]);
    ok("a bookmark that agrees with the page keeps the page's own title", out[1].sheetNumber === "E-101" && out[1].sheetTitle === "FIRST FLOOR POWER PLAN");
  }

  // ── Rules on hand-made items ───────────────────────────────────────────
  const one = (list, hint) => DrwParse.parsePage(items(list), VP(), null, hint);
  {
    const p = one([["DWG NO: E-1.01", 2300, 1650, 14], ["TITLE: MAIN SWITCHBOARD", 2300, 1600, 12], ["REV B", 2300, 1690, 12], ["SHEET 3 OF 10", 2450, 1690, 10]]);
    eq("inline labels: DWG NO:, TITLE:, REV, SHEET n OF m", row(p), ["E-1.01", "MAIN SWITCHBOARD", "B", "3"]);
  }
  {
    const p = one([["CONTRACT NO.: 15CQ-110", 2000, 1650, 14], ["DATE", 2300, 1600, 7], ["JAN-2025", 2300, 1620, 14], ["DRAWING NO.", 2400, 1600, 7], ["SIG-4410", 2400, 1625, 14]]);
    eq("contract numbers and month dates are never the sheet number", p.sheetNumber, "SIG-4410");
    eq("SIG prefix → Signal discipline", p.discipline, "Signal");
  }
  {
    // The big number in the corner belongs to the CONTRACT NO. label; the
    // unlabelled one is the sheet number.
    const p = one([["CONTRACT NO.", 2350, 1640, 7], ["C-4410", 2350, 1680, 30], ["E-101", 2050, 1680, 24]]);
    eq("a value owned by another label (CONTRACT NO.) is not the sheet number", p.sheetNumber, "E-101");
  }
  {
    const p = one([["DRAWING NUMBER", 2300, 1600, 7], ["1234567", 2300, 1625, 16]]);
    ok("a plain number under DRAWING NUMBER is accepted, flagged medium", p.sheetNumber === "1234567" && p.confidence.sheetNumber === "medium");
  }
  {
    const p = one([["E-12", 900, 500, 10], ["SIG-101", 700, 300, 12]]);
    ok("tags in the drawing area are never read as the sheet number", p.sheetNumber === null && p.needsReview);
  }
  {
    // E 1 0 1 written one glyph per item, plus "S H E E T  N O." the same way
    // CAD glyph advance leaves a small gap between letters (and a wider one for the space)
    const glyphs = (s, x, y, fs) => [...s].map((ch, i) => [ch, x + i * fs * 0.68, y, fs]).filter((g) => g[0] !== " ");
    const p = one([...glyphs("SHEET NO.", 2300, 1600, 7), ...glyphs("E-101", 2300, 1630, 20)]);
    eq("one character per text item is joined back up", p.sheetNumber, "E-101");
  }
  {
    const vp = VP();
    const m = (n, pg) => DrwParse.analyzePage(items([["CONTRACT SHEET NO.", 2000, 1600, 7], [n, 2000, 1630, 16], ["PAGE NO.", 2300, 1600, 7], [pg, 2300, 1630, 16]]), vp);
    const multi = DrwParse.extractSet([m("E11004-W30", "1"), m("E11004-W30", "2"), m("E11004-W30", "3")]);
    ok("one drawing number over several pages is kept (label vouches) and not flagged", multi.every((p) => p.sheetNumber === "E11004-W30" && !p.duplicate), JSON.stringify(multi.map(row)));
    const dup = DrwParse.extractSet([m("E11004-W30-001", ""), m("E11004-W30-001", "")]);
    ok("the same sheet number twice (no page numbers) is flagged", dup.every((p) => p.duplicate && p.needsReview && p.issues.some((s) => /also on page/.test(s))));
    const gap = DrwParse.extractSet([m("E-1", "4"), m("E-2", ""), m("E-3", "6")]);
    ok("a missing page number between two neighbours is filled in", gap[1].pageNumber === "5" && gap[1].confidence.pageNumber === "medium", JSON.stringify(gap.map(row)));
  }

  // ── Small pure helpers ─────────────────────────────────────────────────
  eq("parseBookmark: number + title", DrwParse.parseBookmark("A-101.1 — Level 1 Plan"), { sheetNumber: "A-101.1", title: "Level 1 Plan" });
  eq("parseBookmark: title only", DrwParse.parseBookmark("Cover Sheet"), { sheetNumber: null, title: "Cover Sheet" });
  eq("parseBookmark: 'Page 3' says nothing", DrwParse.parseBookmark("Page 3"), null);
  const shapes = ["E11004-W30-001", "E11004-W30", "496H-110", "E-1001", "E101", "A-101.1", "E1.01", "TC-SIG-001", "E-101-A"];
  ok("sheet-number shapes recognised", shapes.every((s) => DrwParse.sheetWeight(s) > 0), shapes.filter((s) => !DrwParse.sheetWeight(s)).join(","));
  const notSheets = ["2025-01-31", "01-31-25", "JAN-2025", "REV-1", "NTS", "1-20", "15", "PAGE-3"];
  ok("dates, scales and labels are not sheet numbers", notSheets.every((s) => !DrwParse.sheetWeight(s)), notSheets.filter((s) => DrwParse.sheetWeight(s)).join(","));
  ok("revision codes", ["0", "1", "12", "A", "D", "AB", "P01", "1A"].every(DrwParse.isRevCode) && !["OF", "NO", "REV", "NTS", "ABC"].some(DrwParse.isRevCode));
  eq("disciplines", ["E-101", "EP-1", "SIG-1", "TC-1", "SG-1", "496H-110", null].map(DrwParse.discipline), ["Electrical", "Electrical", "Signal", "Train Control", "SG", "General", "General"]);

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
