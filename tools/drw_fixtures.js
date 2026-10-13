"use strict";
// Synthetic drawing-set PDFs for the title-block reader tests (drw-parse.js).
// Built with the vendored pdf-lib and read back with the vendored pdf.js, so
// the tests exercise the same text items the browser gets.
//
// A layout is a list of text pieces in DISPLAY coordinates (points, origin
// top-left, y = baseline), written to the content stream in list order:
//   { s, x, y, size, chars?: true (one item per character, as CAD plots do),
//     bold?: true (drawn twice a hair apart, as CAD "bold" does) }
// Modes place the same layout on the page three ways:
//   plain     — landscape page, upright text
//   rotate90  — portrait MediaBox with /Rotate 90 (viewers show it landscape)
//   sideways  — portrait page, no /Rotate: the plot reads bottom-to-top
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PDFLib = require(path.join(ROOT, "vendor/js/pdf-lib.min.js"));

const W = 2592, H = 1728; // ARCH D, 36" × 24"

function place(page, font, piece, mode) {
  const parts = piece.chars
    ? [...piece.s].map((ch, i) => ({ s: ch, dx: font.widthOfTextAtSize(piece.s.slice(0, i), piece.size) }))
    : [{ s: piece.s, dx: 0 }];
  const passes = piece.bold ? [0, 0.35] : [0];
  for (const off of passes) {
    for (const part of parts) {
      if (part.s === " ") continue;
      const X = piece.x + part.dx + off, Y = piece.y;
      if (mode === "plain") page.drawText(part.s, { x: X, y: H - Y, size: piece.size, font });
      else page.drawText(part.s, { x: Y, y: X, size: piece.size, font, rotate: PDFLib.degrees(90) });
    }
  }
}

async function buildPdf(pages, mode = "plain") {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const layout of pages) {
    const page = mode === "plain" ? doc.addPage([W, H]) : doc.addPage([H, W]);
    if (mode === "rotate90") page.setRotation(PDFLib.degrees(90));
    for (const piece of layout) place(page, font, piece, mode);
  }
  return doc.save();
}

// ── Template A: BART/CBTC bottom-strip title block ─────────────────────────
function cbtcPage(n, title, rev) {
  const num = `E11004-W30-00${n}`;
  return [
    // drawing-area noise
    { s: "SIG-101", x: 500, y: 400, size: 10 },
    { s: "E-12", x: 900, y: 600, size: 10 },
    { s: "TC-4", x: 1300, y: 700, size: 10 },
    { s: "SEE E11004-W30-009", x: 2000, y: 900, size: 10 },
    // per-sheet title — written BEFORE the banner (the template's quirk)
    ...title.map((t, i) => ({ s: t, x: 100, y: 1545 + i * 30, size: 22 })),
    { s: "SAN FRANCISCO BAY AREA RAPID TRANSIT DISTRICT", x: 100, y: 1470, size: 12 },
    { s: "DESIGN-BUILD OF A COMMUNICATIONS BASED TRAIN CONTROL (CBTC) SYSTEM", x: 100, y: 1500, size: 14 },
    { s: "HITACHI", x: 2300, y: 1480, size: 16 },
    { s: "Inspire the Next", x: 2300, y: 1500, size: 9 },
    // revision history table (header at the bottom, rows growing upward)
    { s: "A", x: 1005, y: 1550, size: 8 }, { s: "01/01/2025", x: 1050, y: 1550, size: 8 }, { s: "PRELIMINARY", x: 1150, y: 1550, size: 8 },
    { s: "B", x: 1005, y: 1565, size: 8 }, { s: "02/01/2025", x: 1050, y: 1565, size: 8 }, { s: "ISSUED FOR REVIEW", x: 1150, y: 1565, size: 8 },
    { s: "0", x: 1005, y: 1580, size: 8 }, { s: "05/01/2025", x: 1050, y: 1580, size: 8 }, { s: "ISSUED FOR CONSTRUCTION", x: 1150, y: 1580, size: 8 },
    { s: "REV", x: 1000, y: 1600, size: 7 }, { s: "DATE", x: 1050, y: 1600, size: 7 }, { s: "DESCRIPTION", x: 1150, y: 1600, size: 7 },
    // title-block cells
    { s: "SCALE", x: 1450, y: 1600, size: 7 }, { s: "NTS", x: 1460, y: 1625, size: 12 },
    { s: "DRAWN BY", x: 1450, y: 1650, size: 7 }, { s: "J. SMITH", x: 1460, y: 1670, size: 9 },
    { s: "DATE", x: 1550, y: 1650, size: 7 }, { s: "January 31, 2025", x: 1550, y: 1670, size: 9 },
    { s: "CONTRACT NO.", x: 1700, y: 1600, size: 7 }, { s: "15CQ-110", x: 1700, y: 1625, size: 12 },
    { s: "CONTRACT SHEET NO.", x: 1950, y: 1600, size: 7 }, { s: num, x: 1960, y: 1632, size: 18 },
    { s: "REV", x: 2300, y: 1600, size: 7 }, { s: rev, x: 2310, y: 1632, size: 18 },
    { s: "PAGE NO.", x: 2400, y: 1600, size: 7 }, { s: String(n), x: 2410, y: 1632, size: 18 },
    { s: "TEAMCENTER DWG NO.", x: 1700, y: 1660, size: 7 }, { s: "W37-275-375LB24-D", x: 1830, y: 1660, size: 9 },
    { s: "CADD FILENAME:", x: 1950, y: 1680, size: 7 }, { s: `${num}.dgn`, x: 2040, y: 1680, size: 7 },
  ];
}
const CBTC_SET = [
  { n: 1, title: ["SIGNAL PLAN", "WEST OAKLAND STATION"], rev: "0" },
  { n: 2, title: ["SIGNAL PLAN", "12TH STREET STATION"], rev: "0" },
  { n: 3, title: ["CABLE ROUTING", "LAKE MERRITT STATION"], rev: "1" },
  { n: 4, title: ["TRACK CIRCUIT LAYOUT"], rev: "0" },
];

// ── Template B: NCS-style right-hand title strip ───────────────────────────
function ncsPage(num, title, revRows) {
  return [
    { s: "SEE DETAIL 3/E-501", x: 1200, y: 800, size: 10 },
    { s: "EP-1A", x: 700, y: 500, size: 10 },
    { s: "LP-2", x: 1600, y: 1100, size: 10 },
    { s: "ACME ENGINEERING, INC.", x: 2310, y: 100, size: 14 },
    { s: "CITY TRANSIT CENTER", x: 2310, y: 300, size: 16 },
    { s: "PROJECT NO.", x: 2310, y: 400, size: 6 }, { s: "2023-045", x: 2310, y: 418, size: 10 },
    { s: "DATE: 03/15/2024", x: 2310, y: 450, size: 8 },
    { s: "SCALE: AS NOTED", x: 2310, y: 470, size: 8 },
    { s: "DRAWN: JD", x: 2310, y: 490, size: 8 }, { s: "CHECKED: MK", x: 2440, y: 490, size: 8 },
    { s: "REV", x: 2310, y: 560, size: 6 }, { s: "DATE", x: 2340, y: 560, size: 6 }, { s: "DESCRIPTION", x: 2400, y: 560, size: 6 },
    ...revRows.flatMap((r, i) => [
      { s: r, x: 2312, y: 578 + i * 15, size: 7 },
      { s: `0${i + 2}/01/2024`, x: 2340, y: 578 + i * 15, size: 7 },
      { s: i ? `BULLETIN ${i + 1}` : "ADDENDUM 1", x: 2400, y: 578 + i * 15, size: 7 },
    ]),
    { s: "SHEET TITLE", x: 2310, y: 1300, size: 6 },
    ...title.map((t, i) => ({ s: t, x: 2310, y: 1330 + i * 22, size: 14, bold: true })),
    { s: "SHEET NUMBER", x: 2310, y: 1550, size: 6 },
    { s: num, x: 2330, y: 1620, size: 36, chars: true },
  ];
}
const NCS_SET = [
  { num: "E-101", title: ["FIRST FLOOR", "POWER PLAN"], rev: ["1", "2"] },
  { num: "E-102", title: ["SECOND FLOOR", "POWER PLAN"], rev: ["1", "2"] },
  { num: "E-201", title: ["FIRST FLOOR", "LIGHTING PLAN"], rev: ["1"] },
  { num: "E-501", title: ["ELECTRICAL DETAILS"], rev: ["1", "2"] },
];

module.exports = {
  W, H, buildPdf,
  cbtcPages: () => CBTC_SET.map((p) => cbtcPage(p.n, p.title, p.rev)),
  ncsPages: () => NCS_SET.map((p) => ncsPage(p.num, p.title, p.rev)),
  CBTC_SET, NCS_SET,
};
