#!/usr/bin/env node
// ============================================================
// sync_testplan.js
// Reads TestPlan_Master.xlsm → upserts into Supabase test_items
//
// Usage:
//   node sync_testplan.js
//
// First-time setup:
//   npm install xlsx @supabase/supabase-js
// ============================================================

const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ── CONFIG — paste your Supabase values here ────────────────
const SUPABASE_URL      = 'https://uqtwiucxktljhukmgmxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdHdpdWN4a3Rsamh1a21nbXhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NDMxMDcsImV4cCI6MjA5MzUxOTEwN30.nJuQOOyvGpGphSqiNxrO2_p1oYroev8mVdNn9unxmdI';
const EXCEL_FILE        = path.join(__dirname, 'TestPlan_Master.xlsm');
const SHEET_NAME        = 'TestItems';
const BATCH_SIZE        = 200; // rows per upsert call
// ────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  // Excel serial date number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (!d) return null;
    return new Date(d.y, d.m - 1, d.d).toISOString();
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function mapRow(row) {
  return {
    test_id:                row['TestID']               ?? null,
    phase:                  row['Phase']                 ?? null,
    location:               row['Location']              ?? null,
    subsystem:              row['Subsystem']             ?? null,
    activity:               row['Activity']              ?? null,
    test_category:          row['TestCategory']          ?? null,
    test_case_code:         String(row['TestCaseCode'] ?? ''),
    test_name:              row['TestName']              ?? null,
    test_procedure:         row['TestProcedure']         ?? null,
    test_phase:             row['TestPhase']             ?? null,
    // status intentionally excluded — owned by portal/CSV import, not Excel sync
    activity_id:            row['ActivityID']            ?? null,
    planned_date:           parseDate(row['PlannedDate']),
    p6_start_date:          parseDate(row['P6StartDate']),
    p6_finish_date:         parseDate(row['P6FinishDate']),
    p6_start_date_current:  parseDate(row['P6StartDateCurrent']),
    p6_finish_date_current: parseDate(row['P6FinishDateCurrent']),
    weight:                 row['Weight']                ?? null,
    actual_start_date:      parseDate(row['ActualStartDate']),
    actual_finish_date:     parseDate(row['ActualFinishDate']),
    completed_date:         parseDate(row['CompletedDate']),
    completed_by:           row['CompletedBy']           ?? null,
    blocked_reason:         row['BlockedReason']         ?? null,
    notes:                  row['Notes']                 ?? null,
    power_apps_id:          row['__PowerAppsId__']       ?? null,
    synced_at:              new Date().toISOString(),
  };
}

async function sync() {
  console.log(`Reading ${EXCEL_FILE} …`);

  const workbook = XLSX.readFile(EXCEL_FILE, { cellDates: true });

  if (!workbook.SheetNames.includes(SHEET_NAME)) {
    console.error(`Sheet "${SHEET_NAME}" not found. Available: ${workbook.SheetNames.join(', ')}`);
    process.exit(1);
  }

  const sheet = workbook.Sheets[SHEET_NAME];
  const rows  = XLSX.utils.sheet_to_json(sheet, { defval: null });

  console.log(`Found ${rows.length} rows in ${SHEET_NAME}`);

  // Filter out rows with no TestID
  const records = rows
    .map(mapRow)
    .filter(r => r.test_id && r.test_id.toString().trim() !== '');

  console.log(`${records.length} valid records to upsert`);

  let inserted = 0;
  let failed   = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('test_items')
      .upsert(batch, { onConflict: 'test_id' });

    if (error) {
      console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, error.message);
      failed += batch.length;
    } else {
      inserted += batch.length;
      process.stdout.write(`\r  Upserted ${inserted} / ${records.length} …`);
    }
  }

  console.log(`\nDone. ${inserted} upserted, ${failed} failed.`);
}

sync().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
