// Sanity-check: parse the generated template the same way app.js does,
// to confirm header rows + sample-row dates + cell colors are detected.
const ExcelJS = require('exceljs');
const path    = require('path');

const SHIFT_TARGETS = {
  day_shift:     { r: 0xFF, g: 0xEB, b: 0x3B },
  night_shift:   { r: 0x21, g: 0x96, b: 0xF3 },
  blanket_shift: { r: 0x00, g: 0x00, b: 0x00 },
  cancelled:     { r: 0xF4, g: 0x43, b: 0x36 },
};
const THRESHOLD = 160;

function shiftFromColor(argb) {
  if (!argb) return null;
  const hex = argb.replace(/^#/, '').padStart(8, '0');
  const r = parseInt(hex.slice(2,4),16), g = parseInt(hex.slice(4,6),16), b = parseInt(hex.slice(6,8),16);
  if (r>240 && g>240 && b>240) return null;
  let best=null, bestD=Infinity;
  for (const [k,c] of Object.entries(SHIFT_TARGETS)) {
    const d = Math.sqrt((r-c.r)**2+(g-c.g)**2+(b-c.b)**2);
    if (d<bestD){bestD=d;best=k;}
  }
  return bestD<THRESHOLD?best:null;
}

function cellFillHex(cell) {
  const f = cell?.fill;
  if (!f) return null;
  if (f.fgColor?.argb) return f.fgColor.argb;
  if (f.bgColor?.argb) return f.bgColor.argb;
  return null;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(__dirname, '..', 'Lookahead.template.xlsx'));
  const ws = wb.worksheets.find(w => /look[\s-]*ahead/i.test(w.name));
  console.log(`Sheet: "${ws.name}"`);

  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const dateCols = [];
  for (let c = 8; c < 100; c++) {
    const colDef = ws.getColumn(c);
    if (colDef.hidden) continue;
    let monthVal = ws.getCell(4, c).value;
    if (!monthVal) for (let cc = c - 1; cc >= 8; cc--) { const v = ws.getCell(4, cc).value; if (v) { monthVal = v; break; } }
    const dayVal = ws.getCell(5, c).value;
    if (!dayVal) continue;
    const monthStr = String(monthVal || '').trim();
    const m = MONTHS.findIndex(mn => monthStr.toLowerCase().startsWith(mn));
    if (m < 0) continue;
    const day = parseInt(dayVal);
    const year = new Date().getFullYear();
    const d = new Date(Date.UTC(year, m, day));
    dateCols.push({ col: c, dateISO: d.toISOString().slice(0,10) });
  }
  console.log(`Detected ${dateCols.length} date columns: ${dateCols[0]?.dateISO} → ${dateCols[dateCols.length-1]?.dateISO}`);

  let rowCount = 0, eventCount = 0;
  const byShift = { day_shift:0, night_shift:0, blanket_shift:0, cancelled:0 };
  for (let r = 7; r <= 30; r++) {
    const idText = String(ws.getCell(r, 2).value || '').trim();
    const desc   = String(ws.getCell(r, 3).value || '').trim();
    const res    = String(ws.getCell(r, 6).value || '').trim();
    if (!idText && !desc && !res) continue;
    rowCount++;
    let rowEvents = 0;
    for (const dc of dateCols) {
      const cell = ws.getCell(r, dc.col);
      const shift = shiftFromColor(cellFillHex(cell));
      if (shift) { byShift[shift]++; eventCount++; rowEvents++; }
    }
    console.log(`Row ${r}: ${idText.padEnd(12)} | ${desc.slice(0,40).padEnd(40)} | events=${rowEvents}`);
  }
  console.log(`\nTotal: ${rowCount} rows, ${eventCount} events`);
  console.log(`By shift: ${JSON.stringify(byShift)}`);
})();
