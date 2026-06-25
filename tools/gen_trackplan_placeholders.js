"use strict";
// Generates lightweight placeholder track-plan PDFs into assets/track-plans/.
// These are STAND-INS so the Dynamic Testing "Track Plan" window works
// end-to-end before the real BART CBTC track plans are dropped in. Each page
// draws a simple signalling strip (track line, interlocking turnouts, signal
// markers) with a title block, so it reads as a track plan at a glance.
//
// Re-run after editing:  node tools/gen_trackplan_placeholders.js
// Replace the output files with the real maps (same filenames) when available.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "assets", "track-plans");

// ── minimal PDF writer ────────────────────────────────────────────────────
// Builds a PDF from a list of content streams (one per page). Computes the
// xref byte offsets so the file is valid in pdf.js / any conformant reader.
function buildPdf(pageStreams, { width = 792, height = 612 } = {}) {
  const objects = [];                 // index 0 unused (objects are 1-based)
  const add = (body) => { objects.push(body); return objects.length; };

  const catalogId = 1;                // reserve ids in a stable order
  const pagesId   = 2;
  const fontId    = 3;
  const boldId    = 4;
  // page + content object ids are allocated after the fixed ones
  const pageIds = [];
  const contentIds = [];

  objects.length = 4;                 // placeholders for the four fixed objects

  for (const stream of pageStreams) {
    const cId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    contentIds.push(cId);
    const pId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> ` +
      `/Contents ${cId} 0 R >>`
    );
    pageIds.push(pId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1]   = `<< /Type /Pages /Kids [${pageIds.map(id => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`;
  objects[fontId - 1]    = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[boldId - 1]    = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 0; i < objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ── content-stream drawing helpers (PDF user space: origin bottom-left) ─────
const esc = (s) => String(s).replace(/([\\()])/g, "\\$1");
const text = (x, y, size, str, bold = false) =>
  `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${esc(str)}) Tj ET\n`;
const line = (x1, y1, x2, y2, w = 1.5) =>
  `${w} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
const rect = (x, y, w, h, fill = false) =>
  `${x} ${y} ${w} ${h} re ${fill ? "f" : "S"}\n`;
const gray = (g) => `${g} ${g} ${g} RG ${g} ${g} ${g} rg\n`;
const red  = () => `0.9 0.0 0.07 RG 0.9 0.0 0.07 rg\n`;
const black = () => `0 0 0 RG 0 0 0 rg\n`;

// One labelled signalling strip across the page width.
function strip(title, subtitle, signals, opts = {}) {
  const W = 792, H = 612;
  let c = "";
  // border + title block
  c += gray(0.6) + rect(24, 24, W - 48, H - 48) + black();
  c += red() + rect(24, H - 86, W - 48, 62, true) + black();
  c += "1 1 1 RG 1 1 1 rg\n" + text(40, H - 56, 20, title, true);
  c += text(40, H - 78, 11, subtitle) + black();
  // milepost ruler
  c += gray(0.5);
  for (let i = 0; i <= 10; i++) {
    const x = 60 + i * ((W - 120) / 10);
    c += line(x, 120, x, 128, 0.8);
    c += text(x - 8, 104, 8, "MP " + (opts.mpStart || 0 + i));
  }
  c += black();
  // mainline track (two rails)
  const yMid = 320;
  c += "2 w " + line(60, yMid + 4, W - 60, yMid + 4, 2.4);
  c += line(60, yMid - 4, W - 60, yMid - 4, 2.4);
  // sleepers
  c += gray(0.55);
  for (let x = 70; x < W - 60; x += 22) c += line(x, yMid - 7, x, yMid + 7, 0.6);
  c += black();
  // turnout (interlocking crossover) in the middle, if requested
  if (opts.crossover) {
    c += "1.8 w " + line(W / 2 - 60, yMid + 4, W / 2 - 10, yMid + 60, 1.8);
    c += line(W / 2 + 10, yMid + 60, W / 2 + 60, yMid + 4, 1.8);
    c += line(W / 2 - 60, yMid + 64, W / 2 + 60, yMid + 64, 2.2);
    c += text(W / 2 - 36, yMid + 74, 9, "CROSSOVER", true);
  }
  // signals + labels
  for (const s of signals) {
    const x = 60 + s.at * (W - 120);
    c += red() + rect(x - 3, yMid + 14, 6, 22, true) + black();
    c += line(x, yMid + 4, x, yMid + 14, 1.2);
    c += text(x - 10, yMid + 42, 9, s.label, true);
    if (s.note) c += gray(0.4) + text(x - 14, yMid - 26, 8, s.note) + black();
  }
  // footer
  c += gray(0.45) + text(40, 40, 9,
    "PLACEHOLDER — replace with the real track plan PDF (same filename). Generated by tools/gen_trackplan_placeholders.js");
  c += black();
  return c;
}

// ── layered (OCG) demo ──────────────────────────────────────────────────────
// A PDF whose Signals / Axle Counters / WABs sit on separate Optional Content
// Groups (PDF "layers"), exactly like a Visio "Save as PDF (include layers)"
// export. The viewer's Layers panel can then toggle each one. This stands in
// until a real layered Visio export is dropped in.
function assemble(objs) {            // objs is 1-indexed (objs[0] unused)
  const N = objs.length - 1;
  let pdf = "%PDF-1.5\n";
  const offsets = [];
  for (let i = 1; i <= N; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${N + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= N; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${N + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function layeredDemoContent() {
  const W = 792, H = 612, yMid = 320;
  let c = "";
  // base (always-on) track plan
  c += gray(0.6) + rect(24, 24, W - 48, H - 48) + black();
  c += red() + rect(24, H - 86, W - 48, 62, true) + black();
  c += "1 1 1 RG 1 1 1 rg\n" + text(40, H - 56, 20, "PHASE 2 — LAYERED DEMO", true);
  c += text(40, H - 78, 11, "BART CBTC · toggle Signals / Axle Counters / WABs in the Layers panel") + black();
  c += "2 w " + line(60, yMid + 4, W - 60, yMid + 4, 2.4) + line(60, yMid - 4, W - 60, yMid - 4, 2.4);
  c += gray(0.55);
  for (let x = 70; x < W - 60; x += 22) c += line(x, yMid - 7, x, yMid + 7, 0.6);
  c += black();
  const at = (f) => 60 + f * (W - 120);

  // Signals layer
  c += "/OC /L_sig BDC\n";
  [[0.08, "S8"], [0.30, "S12"], [0.55, "S16"], [0.80, "S20"], [0.95, "SB"]].forEach(([f, lbl]) => {
    const x = at(f);
    c += red() + rect(x - 3, yMid + 14, 6, 22, true) + black();
    c += line(x, yMid + 4, x, yMid + 14, 1.2) + text(x - 8, yMid + 42, 9, lbl, true);
  });
  c += "EMC\n";

  // Axle Counters layer
  c += "/OC /L_ac BDC\n";
  c += "0.0 0.45 0.8 RG 0.0 0.45 0.8 rg\n";
  [0.18, 0.42, 0.66, 0.88].forEach((f, i) => {
    const x = at(f);
    c += rect(x - 4, yMid - 24, 8, 8, true);
    c += line(x, yMid - 16, x, yMid - 4, 1) + text(x - 10, yMid - 36, 8, "AC" + (i + 1), true);
  });
  c += black() + "EMC\n";

  // WABs layer
  c += "/OC /L_wab BDC\n";
  c += "0.0 0.55 0.25 RG 0.0 0.55 0.25 rg\n";
  [0.25, 0.5, 0.74].forEach((f, i) => {
    const x = at(f);
    c += `${x - 6} ${yMid + 58} m ${x} ${yMid + 50} l ${x + 6} ${yMid + 58} l ${x} ${yMid + 66} l f\n`;
    c += text(x - 12, yMid + 72, 8, "WAB-" + (i + 1), true);
  });
  c += black() + "EMC\n";

  c += gray(0.45) + text(40, 40, 9, "LAYERED PLACEHOLDER — Signals / Axle Counters / WABs are separate PDF layers (OCGs).") + black();
  return c;
}

function buildLayeredDemo() {
  const W = 792, H = 612;
  const content = layeredDemoContent();
  const objs = [];
  const sig = 7, ac = 8, wab = 9;
  objs[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${sig} 0 R ${ac} 0 R ${wab} 0 R] ` +
            `/D << /Name (Default) /Order [${sig} 0 R ${ac} 0 R ${wab} 0 R] /ON [${sig} 0 R ${ac} 0 R ${wab} 0 R] /OFF [] >> >> >>`;
  objs[2] = `<< /Type /Pages /Kids [5 0 R] /Count 1 >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;
  objs[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
            `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /Properties << /L_sig ${sig} 0 R /L_ac ${ac} 0 R /L_wab ${wab} 0 R >> >> ` +
            `/Contents 6 0 R >>`;
  objs[6] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  objs[7] = `<< /Type /OCG /Name (Signals) >>`;
  objs[8] = `<< /Type /OCG /Name (Axle Counters) >>`;
  objs[9] = `<< /Type /OCG /Name (WABs) >>`;
  return assemble(objs);
}

// ── layered SVG demo ────────────────────────────────────────────────────────
// A vector SVG where Signals / Axle Counters / WABs are top-level <g> groups
// (named by id), which the viewer turns into toggleable layers. Stands in for a
// Visio "Save as SVG" export. SVG y-axis is top-down (unlike PDF), so this is
// authored separately from the PDF content above.
function buildLayeredSvg() {
  const W = 792, H = 612, yMid = 300;
  const at = (f) => 60 + f * (W - 120);
  const sig = [[0.08, "S8"], [0.30, "S12"], [0.55, "S16"], [0.80, "S20"], [0.95, "SB"]]
    .map(([f, l]) => { const x = at(f); return `<rect x="${x - 3}" y="${yMid - 36}" width="6" height="22" fill="#e10012"/>` +
      `<line x1="${x}" y1="${yMid - 4}" x2="${x}" y2="${yMid - 14}" stroke="#e10012" stroke-width="1.2"/>` +
      `<text x="${x}" y="${yMid - 42}" font-family="Helvetica" font-size="11" font-weight="bold" text-anchor="middle">${l}</text>`; }).join("");
  const ac = [0.18, 0.42, 0.66, 0.88].map((f, i) => { const x = at(f);
    return `<rect x="${x - 4}" y="${yMid + 16}" width="8" height="8" fill="#0073cc"/>` +
      `<line x1="${x}" y1="${yMid + 4}" x2="${x}" y2="${yMid + 16}" stroke="#0073cc" stroke-width="1"/>` +
      `<text x="${x}" y="${yMid + 40}" font-family="Helvetica" font-size="9" font-weight="bold" fill="#0073cc" text-anchor="middle">AC${i + 1}</text>`; }).join("");
  const wab = [0.25, 0.5, 0.74].map((f, i) => { const x = at(f);
    return `<path d="M ${x - 6} ${yMid + 60} L ${x} ${yMid + 52} L ${x + 6} ${yMid + 60} L ${x} ${yMid + 68} Z" fill="#0a8d40"/>` +
      `<text x="${x}" y="${yMid + 84} " font-family="Helvetica" font-size="9" font-weight="bold" fill="#0a8d40" text-anchor="middle">WAB-${i + 1}</text>`; }).join("");
  let sleepers = "";
  for (let x = 70; x < W - 60; x += 22) sleepers += `<line x1="${x}" y1="${yMid - 7}" x2="${x}" y2="${yMid + 7}" stroke="#8c8c8c" stroke-width="0.6"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <g id="Track base">
    <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#999"/>
    <rect x="24" y="24" width="${W - 48}" height="56" fill="#e10012"/>
    <text x="40" y="54" font-family="Helvetica" font-size="20" font-weight="bold" fill="#fff">PHASE 2 — SVG LAYERS DEMO</text>
    <text x="40" y="72" font-family="Helvetica" font-size="11" fill="#fff">Vector · toggle Signals / Axle Counters / WABs in the Layers panel</text>
    <line x1="60" y1="${yMid - 4}" x2="${W - 60}" y2="${yMid - 4}" stroke="#222" stroke-width="2.4"/>
    <line x1="60" y1="${yMid + 4}" x2="${W - 60}" y2="${yMid + 4}" stroke="#222" stroke-width="2.4"/>
    ${sleepers}
    <text x="40" y="${H - 32}" font-family="Helvetica" font-size="9" fill="#777">LAYERED SVG PLACEHOLDER — Signals / Axle Counters / WABs are separate SVG groups.</text>
  </g>
  <g id="Signals">${sig}</g>
  <g id="Axle Counters">${ac}</g>
  <g id="WABs">${wab}</g>
</svg>
`;
}

// ── catalog of placeholder maps ────────────────────────────────────────────
const FILES = {
  "phase-2-layered.pdf": buildLayeredDemo(),
  "phase-2-layered.svg": Buffer.from(buildLayeredSvg(), "utf8"),
  "phase-2.pdf": buildPdf([
    strip("PHASE 2 — OVERALL TRACK PLAN", "BART CBTC · Sheet 1 of 2 · Mainline + interlockings",
      [
        { at: 0.06, label: "S8", note: "route start" },
        { at: 0.28, label: "S12" },
        { at: 0.50, label: "W4", note: "interlocking" },
        { at: 0.72, label: "S20" },
        { at: 0.94, label: "SB", note: "route end" },
      ], { crossover: true }),
    strip("PHASE 2 — OVERALL TRACK PLAN", "BART CBTC · Sheet 2 of 2 · Continuation",
      [
        { at: 0.10, label: "SB" },
        { at: 0.40, label: "S24" },
        { at: 0.70, label: "S28" },
        { at: 0.92, label: "S30", note: "yard limit" },
      ], { mpStart: 10 }),
  ]),
  "w-4.pdf": buildPdf([
    strip("W-4 INTERLOCKING — ZOOMED", "BART CBTC · Interlocking detail · zoomed to W-4",
      [
        { at: 0.18, label: "8R", note: "approach" },
        { at: 0.42, label: "W4A" },
        { at: 0.58, label: "W4B" },
        { at: 0.84, label: "BR", note: "departure" },
      ], { crossover: true }),
  ]),
  "route-1.pdf": buildPdf([
    strip("ROUTE 1 — S8 → SB", "BART CBTC · Dynamic test route overlay",
      [
        { at: 0.06, label: "S8", note: "signal 8 (start)" },
        { at: 0.50, label: "W4", note: "via W-4" },
        { at: 0.94, label: "SB", note: "signal B (end)" },
      ], { crossover: true }),
  ]),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, buf] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(OUT_DIR, name), buf);
  console.log(`wrote assets/track-plans/${name} (${buf.length} bytes)`);
}
