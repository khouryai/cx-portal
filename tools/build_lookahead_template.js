// Generate Lookahead.template.xlsx that matches the importer's parsing rules.
// Run: node tools/build_lookahead_template.js
//
// Layout (must match _lookaheadParseFile in app.js):
//   Sheet name: "Look-Ahead"
//   Row 2:  Main column headers in cols B–G + Week number labels from H onward
//   Row 3:  Week label  (importer ignores; informational)
//   Row 4:  Month name  (importer reads this; merged across the month's days)
//   Row 5:  Day number  (importer reads this)
//   Row 6:  Weekday short (informational)
//   Row 7+: Data rows
//
// Color codes for date cells:
//   FFFFEB3B  Yellow → Day shift   (default 07:00–15:00, overridden by Work Hours)
//   FF2196F3  Blue   → Night shift (default 20:00–07:00, overridden by Work Hours)
//   FF000000  Black  → Blanket shift (all-day)
//   FFF44336  Red    → Cancellation (admin must add reason after import)

const ExcelJS = require('exceljs');
const path    = require('path');
const fs      = require('fs');

(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CX Portal';
  wb.created = new Date();

  // ── Look-Ahead sheet ────────────────────────────────────────
  const ws = wb.addWorksheet('Look-Ahead', {
    views: [{ state: 'frozen', xSplit: 7, ySplit: 6 }],
  });

  // 14-day window starting on the upcoming Monday
  const today = new Date();
  const dow   = today.getDay();
  const daysToMon = (8 - dow) % 7 || 7;     // next Monday
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMon);

  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const WEEKDAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // ── Row 1: optional title (importer skips) ──────────────────
  ws.getCell(1, 1).value = 'BART CBTC — Weekly Look-Ahead';
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF111827' } };
  ws.mergeCells(1, 1, 1, 7);

  // ── Row 2: Main headers (B–G) + week number across date cols ─
  const mainHeaders = ['', 'Activity ID', 'Description of Work Activity', 'Location', 'SSWP#', 'Resource', 'Work Hours'];
  mainHeaders.forEach((h, idx) => {
    const c = ws.getCell(2, idx + 1);
    c.value = h;
    c.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
    c.alignment = { vertical: 'middle', horizontal: 'left' };
  });

  // Week number runs across H onward. Compute weeks based on Monday's ISO week.
  const isoWeek = (d) => {
    const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  };
  let weekRanges = [];
  let curWeek = isoWeek(days[0]), startCol = 8;
  for (let i = 0; i < days.length; i++) {
    const wk = isoWeek(days[i]);
    if (wk !== curWeek) { weekRanges.push({ wk: curWeek, startCol, endCol: 7 + i }); curWeek = wk; startCol = 8 + i; }
  }
  weekRanges.push({ wk: curWeek, startCol, endCol: 7 + days.length });
  weekRanges.forEach(r => {
    const c = ws.getCell(2, r.startCol);
    c.value = `Week ${r.wk}`;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
    c.alignment = { horizontal: 'center' };
    if (r.endCol > r.startCol) ws.mergeCells(2, r.startCol, 2, r.endCol);
  });

  // ── Row 3: Week label (e.g. "Apr 27 – May 3") ───────────────
  weekRanges.forEach(r => {
    const first = days[r.startCol - 8];
    const last  = days[r.endCol - 8];
    const c = ws.getCell(3, r.startCol);
    c.value = `${MONTHS[first.getMonth()]} ${first.getDate()} – ${MONTHS[last.getMonth()]} ${last.getDate()}`;
    c.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
    c.alignment = { horizontal: 'center' };
    if (r.endCol > r.startCol) ws.mergeCells(3, r.startCol, 3, r.endCol);
  });

  // ── Row 4: Month name (importer reads) merged per month span ─
  let monthRanges = [];
  let curMonth = days[0].getMonth(), mStart = 8;
  for (let i = 0; i < days.length; i++) {
    if (days[i].getMonth() !== curMonth) { monthRanges.push({ m: curMonth, startCol: mStart, endCol: 7 + i }); curMonth = days[i].getMonth(); mStart = 8 + i; }
  }
  monthRanges.push({ m: curMonth, startCol: mStart, endCol: 7 + days.length });
  monthRanges.forEach(r => {
    const c = ws.getCell(4, r.startCol);
    c.value = MONTHS[r.m];
    c.font = { bold: true, color: { argb: 'FF111827' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    c.alignment = { horizontal: 'center' };
    if (r.endCol > r.startCol) ws.mergeCells(4, r.startCol, 4, r.endCol);
  });

  // ── Row 5: Day number (importer reads) ──────────────────────
  days.forEach((d, i) => {
    const c = ws.getCell(5, 8 + i);
    c.value = d.getDate();
    c.font = { bold: true, color: { argb: 'FF111827' } };
    c.alignment = { horizontal: 'center' };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });

  // ── Row 6: Weekday short (importer ignores) ─────────────────
  days.forEach((d, i) => {
    const c = ws.getCell(6, 8 + i);
    c.value = WEEKDAYS_SHORT[d.getDay()];
    c.font = { size: 10, color: { argb: d.getDay() === 0 || d.getDay() === 6 ? 'FFDC2626' : 'FF6B7280' } };
    c.alignment = { horizontal: 'center' };
  });

  // ── Style A column header for activity row labels ───────────
  ws.getCell(2, 1).value = '#';
  ws.getColumn(1).width  = 4;
  ws.getColumn(2).width  = 14;   // Activity ID
  ws.getColumn(3).width  = 42;   // Description
  ws.getColumn(4).width  = 18;   // Location
  ws.getColumn(5).width  = 10;   // SSWP#
  ws.getColumn(6).width  = 14;   // Resource
  ws.getColumn(7).width  = 14;   // Work Hours
  for (let c = 8; c < 8 + days.length; c++) ws.getColumn(c).width = 6;

  // ── Data rows (7+) — sample activities demonstrating each color ──
  const COLOR = {
    day:   'FFFFEB3B',
    night: 'FF2196F3',
    blank: 'FF000000',
    cancel:'FFF44336',
  };
  const dayIdx = (offset) => 8 + offset;   // column for day offset 0..13

  const samples = [
    {
      row: 7,
      values: ['1', 'AT-LM-001', 'CBTC Onboard Equipment Functional Test',  'LMA Yard',     'SSWP-014', 'AK, JS',  '0700-1500'],
      cells:  [ [dayIdx(0), 'day'], [dayIdx(1), 'day'] ],
    },
    {
      row: 8,
      values: ['2', 'AT-LM-002', 'Wayside Radio Coverage Verification',      'Embarcadero',  'SSWP-021', 'JS, RM',  '2000-0700'],
      cells:  [ [dayIdx(2), 'night'], [dayIdx(3), 'night'] ],
    },
    {
      row: 9,
      values: ['3', 'AT-LM-003', 'Track Circuit Continuity Sweep',           'Powell',       'SSWP-018', 'AK',      ''],
      cells:  [ [dayIdx(4), 'blank'] ],     // blanket → all-day
    },
    {
      row: 10,
      values: ['4', 'AT-LM-004', 'ATP Brake Curve Validation (CANCELLED)',   'Daly City',    'SSWP-009', 'RM, JS',  '0700-1500'],
      cells:  [ [dayIdx(5), 'cancel'] ],    // red → cancelled, admin enters reason after import
    },
    {
      row: 11,
      values: ['5', 'AT-LM-005', 'Interlocking Logic Acceptance',            'Bay Fair',     'SSWP-007', 'AK, RM',  '0700-1500'],
      cells:  [ [dayIdx(7), 'day'], [dayIdx(8), 'day'], [dayIdx(9), 'day'] ],
    },
    {
      row: 12,
      values: ['6', 'AT-LM-006', 'Penalty Brake Application Test',           '24th Street',  'SSWP-011', 'JS',      '0800-1600'],
      cells:  [ [dayIdx(10), 'day'] ],
    },
    {
      row: 13,
      values: ['7', 'AT-LM-007', 'Cab Signal Receiver Verification',         'Coliseum',     'SSWP-022', 'AK, JS',  '2100-0500'],
      cells:  [ [dayIdx(11), 'night'], [dayIdx(12), 'night'] ],
    },
    {
      row: 14,
      values: ['8', 'AT-LM-008', 'Subsystem Integration Smoke Test',         'OAK Wye',      'SSWP-025', '',        ''],
      cells:  [ [dayIdx(13), 'blank'] ],
    },
  ];

  samples.forEach(s => {
    s.values.forEach((v, i) => {
      const c = ws.getCell(s.row, i + 1);
      c.value = v;
      c.alignment = { vertical: 'middle', wrapText: i === 2 };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
    });
    s.cells.forEach(([col, kind]) => {
      const c = ws.getCell(s.row, col);
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR[kind] } };
      c.border = { top: { style: 'thin', color: { argb: 'FFE5E7EB' } }, bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
    });
    ws.getRow(s.row).height = 22;
  });

  // Add a few blank rows so the user can fill more activities
  for (let r = 15; r < 30; r++) {
    ws.getCell(r, 1).value = r - 6;
    ws.getRow(r).height = 20;
    for (let c = 1; c <= 7 + days.length; c++) {
      ws.getCell(r, c).border = { bottom: { style: 'hair', color: { argb: 'FFF3F4F6' } } };
    }
  }

  // Light header row borders
  for (let r = 2; r <= 6; r++) {
    for (let c = 1; c <= 7 + days.length; c++) {
      const cell = ws.getCell(r, c);
      if (!cell.border) cell.border = {};
      cell.border.bottom = { style: r === 6 ? 'medium' : 'thin', color: { argb: 'FF111827' } };
    }
  }

  // ── Instructions sheet ──────────────────────────────────────
  const info = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FF111827' } } });
  info.columns = [{ width: 4 }, { width: 24 }, { width: 80 }];

  const writeRow = (row, label, value, opts = {}) => {
    info.getCell(row, 2).value = label;
    info.getCell(row, 2).font = { bold: true, color: { argb: 'FF111827' } };
    info.getCell(row, 2).alignment = { vertical: 'top' };
    info.getCell(row, 3).value = value;
    info.getCell(row, 3).alignment = { vertical: 'top', wrapText: true };
    if (opts.fill) {
      info.getCell(row, 3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    }
    if (opts.color) info.getCell(row, 3).font = { color: { argb: opts.color } };
    info.getRow(row).height = opts.h || 22;
  };

  info.getCell(1, 2).value = 'Lookahead Import Template';
  info.getCell(1, 2).font = { bold: true, size: 16, color: { argb: 'FF111827' } };
  info.mergeCells(1, 2, 1, 3);
  info.getRow(1).height = 28;

  writeRow(3, 'Sheet name',          'Must be exactly "Look-Ahead" (case-insensitive substring match).');
  writeRow(4, 'Main header row',     'Row 2: Activity ID (B), Description of Work Activity (C), Location (D), SSWP# (E), Resource (F, comma-separated initials), Work Hours (G).');
  writeRow(5, 'Date header rows',    'Rows 2–6 hold week #, week label, month, day number, weekday. The importer reads Month (row 4) and Day (row 5).');
  writeRow(6, 'Data rows',           'Start at row 7. Empty rows are skipped automatically.');
  writeRow(7, 'Hidden columns',      'Historical columns can be hidden — the importer ignores them.');
  writeRow(8, 'Resource initials',   'Use a comma, slash, or semicolon separator (AK, JS or AK/JS). Unknown initials land in the admin Review Queue after import.');
  writeRow(9, 'Work hours format',   'Accepts 0700-1500, 0700 - 1500, 2000-0700 (overnight), 7:00-15:00, 8am-4pm. If the cell is blank, the shift color picks the default time band.');

  writeRow(11, 'Cell color coding',  'Fill the day cell for each scheduled activity with one of these colors:', { color: 'FF111827' });
  writeRow(12, '  Yellow',           'Day shift — default 07:00–15:00 (overridden by Work Hours when present)', { fill: 'FFFFEB3B', color: 'FF1F2937', h: 26 });
  writeRow(13, '  Blue',             'Night shift — default 20:00–07:00 (overridden by Work Hours when present)', { fill: 'FF2196F3', color: 'FFFFFFFF', h: 26 });
  writeRow(14, '  Black',            'Blanket shift — all-day, no specific time window', { fill: 'FF000000', color: 'FFFFFFFF', h: 26 });
  writeRow(15, '  Red',              'Cancelled — event is recorded as cancelled. Admin must add a cancellation reason from the Review Queue after import.', { fill: 'FFF44336', color: 'FFFFFFFF', h: 26 });

  writeRow(17, 'Matching engine',    'Each row is matched to a portal activity in priority order: (1) exact Activity ID against test_items.TestCaseCode/TestID, (2) P6 activity → p6_activity_map → test case code, (3) normalized description, (4) Fuse.js fuzzy match on description + location. Unmatched rows still import — admin can link them later from the Review Queue.');
  writeRow(18, 'Supersede behavior', 'On confirm, the new file replaces any future-dated events from the previous batch. Events marked Locked from the Event Detail Modal are preserved across imports.');
  writeRow(19, 'Tips',                '• Tolerate slight color shade variation — the importer matches by RGB distance.\n• You can hide any prior-week columns; they will be ignored.\n• Sample data on the Look-Ahead sheet demonstrates each color and work-hour pattern.', { h: 70 });

  // Save
  const outPath = path.resolve(__dirname, '..', 'Lookahead.template.xlsx');
  await wb.xlsx.writeFile(outPath);
  console.log(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
})();
