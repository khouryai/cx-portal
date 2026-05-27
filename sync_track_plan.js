#!/usr/bin/env node
// ============================================================
// sync_track_plan.js
//
// Reads a Visio→Excel track plan extract and upserts it into the
// track-plan tables (track_plan_imports, track_zones,
// track_mileposts, track_equations, train_control_locations,
// track_devices, track_sections).
//
// Usage:
//   node sync_track_plan.js <path/to/track_plan.xlsx>
//
// First-time setup:
//   npm install xlsx @supabase/supabase-js
//
// What it does
//   1. Reads workbook metadata (Track layout info / revision)
//      and creates one track_plan_imports row.
//   2. Loads the allowlisted sheets, drops Visio render-only
//      columns, normalizes integer-0 sentinels to NULL.
//   3. Inserts mileposts, equations, TCLs.
//   4. Deduplicates zones by (zone_type, code) and inserts them
//      with the contributing Visio shape ids collected into
//      source_shape_ids[].
//   5. Maps every device sheet onto one polymorphic
//      track_devices row (device_type discriminator + JSONB
//      attributes for class-specific quirks).
//   6. Inserts track_sections (one row per Block).
//   7. Pass 2: resolves text refs (zone_code, interlocking_code,
//      parent_zone_code) to FK IDs by parsing the device/section
//      code prefix against the imported zone catalog.
//   8. Marks the import 'complete' and prints a summary.
// ============================================================

const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

// ── CONFIG ──────────────────────────────────────────────────
const SUPABASE_URL      = 'https://uqtwiucxktljhukmgmxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdHdpdWN4a3Rsamh1a21nbXhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NDMxMDcsImV4cCI6MjA5MzUxOTEwN30.nJuQOOyvGpGphSqiNxrO2_p1oYroev8mVdNn9unxmdI';
const BATCH_SIZE        = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── normalization helpers ───────────────────────────────────
const DROP_COLS = new Set([
  'mp_tag_dist', 'mp_tag_offset', 'name_position', 'master_ref', 'bop_style',
]);

function nullIfZero(v) {
  // The Visio export uses integer 0 as the null sentinel for text refs.
  if (v === 0 || v === '0') return null;
  return v == null || v === '' ? null : v;
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function asBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v === 'TRUE' || v === 'True' || v === 'true') return true;
  if (v === 'FALSE' || v === 'False' || v === 'false') return false;
  return null;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Strip-and-prefix-match for trailing-space and truncated sheet names.
function findSheet(wb, target) {
  const t = target.trim().toLowerCase();
  let hit = wb.SheetNames.find(n => n.trim().toLowerCase() === t);
  if (hit) return hit;
  return wb.SheetNames.find(n => n.trim().toLowerCase().startsWith(t));
}

function readSheet(wb, name) {
  const real = findSheet(wb, name);
  if (!real) return { rows: [], realName: null };
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[real], { defval: null });
  // Drop render-only columns from every row.
  const cleaned = rows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (!DROP_COLS.has(k)) out[k] = v;
    }
    return out;
  });
  return { rows: cleaned, realName: real };
}

// Status derivation from is_new / is_removed flags.
function deriveStatus(r) {
  if (asBool(r.is_removed)) return 'decommissioned';
  if (asBool(r.is_new))     return 'planned';
  return 'in_service';
}

// Batched upsert helper.
async function batchUpsert(table, rows, opts = {}) {
  if (!rows.length) return { count: 0, errors: 0 };
  let count = 0, errors = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(slice, opts);
    if (error) {
      console.error(`  ${table} batch ${i}: ${error.message}`);
      errors += slice.length;
    } else {
      count += slice.length;
    }
  }
  return { count, errors };
}

// ── 1. track_plan_imports row ───────────────────────────────
async function createImportRow(filePath, wb) {
  const { rows: infoRows } = readSheet(wb, 'Track layout info');
  const { rows: revRows  } = readSheet(wb, 'Track layout revision');
  const info = infoRows[0] || {};
  const latest = revRows
    .filter(r => r.release_date)
    .sort((a, b) => new Date(b.release_date) - new Date(a.release_date))[0] || {};

  const row = {
    source_file: path.basename(filePath),
    source_kind: 'visio_xlsx',
    doc_code: asText(info.doc_code),
    project_name: asText(info.project_name),
    layout_name: asText(info.name),
    view_name: asText(info.view),
    version_label: asText(info.version) ?? asText(latest.version),
    release_date: parseDate(info.release_date) ?? parseDate(latest.release_date),
    designer: asText(info.designer),
    verifier: asText(info.verifier),
    approver: asText(info.approver),
    mp_unit: asNumber(info.mp_unit),
    imported_by: 'sync_track_plan.js',
    status: 'processing',
    notes: asText(latest.description),
  };

  const { data, error } = await supabase
    .from('track_plan_imports')
    .insert(row).select().single();
  if (error) throw new Error(`track_plan_imports: ${error.message}`);
  return data.id;
}

// ── 2. mileposts ────────────────────────────────────────────
async function importMileposts(wb, importId) {
  const { rows } = readSheet(wb, 'Milepost');
  const records = rows
    .filter(r => r['Shape ID'] != null)
    .map(r => ({
      mp_value: asNumber(r.mp),
      track_name: null,
      source_shape_id: asNumber(r['Shape ID']),
      source_import_id: importId,
    }))
    .filter(r => r.mp_value != null);
  return batchUpsert('track_mileposts', records, { onConflict: 'source_shape_id' });
}

// ── 3. equations ────────────────────────────────────────────
async function importEquations(wb, importId) {
  const { rows } = readSheet(wb, 'Equation');
  const records = rows
    .filter(r => r['Shape ID'] != null)
    .map(r => ({
      mp_left:  asNumber(r.mp_left),
      mp_right: asNumber(r.mp_right),
      source_shape_id: asNumber(r['Shape ID']),
      source_import_id: importId,
    }))
    .filter(r => r.mp_left != null && r.mp_right != null);
  return batchUpsert('track_equations', records, { onConflict: 'source_shape_id' });
}

// ── 4. train_control_locations ──────────────────────────────
async function importTCLs(wb, importId) {
  const { rows } = readSheet(wb, 'Train Control Location');
  const records = rows
    .filter(r => asText(r.name))
    .map(r => ({
      code: asText(r.name),
      milepost: asNumber(r.mp),
      tcl_type: asText(r.type),
      uic_code: asText(nullIfZero(r.uic)),
      is_new: asBool(r.is_new) ?? false,
      is_removed: asBool(r.is_removed) ?? false,
      source_shape_id: asNumber(r['Shape ID']),
      source_import_id: importId,
    }));
  return batchUpsert('train_control_locations', records, { onConflict: 'code' });
}

// ── 5. zones (deduped by zone_type + code) ──────────────────
const ZONE_SHEETS = [
  ['ZC Area',              'zc_area',              r => ({ display_color: asText(r.color), attributes: dropEmpty({ position: asText(r.Position) }) })],
  ['Control Area',         'control_area',         r => ({ system_label: asText(r.system) })],
  ['Interlocking',         'interlocking',         r => ({ parent_zone_code: asText(nullIfZero(r.control_zone_name)) })],
  ['Control Zone',         'control_zone',         () => ({})],
  ['Adhesion zone',        'adhesion_zone',        r => ({ display_color: asText(r.color), start_milepost: asNumber(r.mp1), end_milepost: asNumber(r.mp2), attributes: dropEmpty({ position: asText(r.Position) }) })],
  ['CBTC Territory Limit', 'cbtc_territory_limit', r => ({}) ],
];

function dropEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

async function importZones(wb, importId) {
  // Group by (zone_type, code), accumulate shape IDs.
  const byKey = new Map();
  for (const [sheet, zoneType, extra] of ZONE_SHEETS) {
    const { rows } = readSheet(wb, sheet);
    for (const r of rows) {
      const shapeId = asNumber(r['Shape ID']);
      // Synthetic code for sheets with no name column (CBTC Territory Limit).
      const code = asText(r.name) || (zoneType === 'cbtc_territory_limit' && shapeId ? `CBTC-LIMIT-${shapeId}` : null);
      if (!code) continue;
      const key = `${zoneType}|${code}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          zone_type: zoneType,
          code,
          source_shape_ids: [],
          source_import_id: importId,
          attributes: {},
          ...extra(r),
        });
      }
      const row = byKey.get(key);
      if (shapeId != null && !row.source_shape_ids.includes(shapeId)) {
        row.source_shape_ids.push(shapeId);
      }
    }
  }
  const records = [...byKey.values()];
  return batchUpsert('track_zones', records, { onConflict: 'zone_type,code' });
}

// ── 6. devices ──────────────────────────────────────────────
// [sheetName, deviceType, subtype: string | (row)=>string, attrKeys[]]
const DEVICE_SHEETS = [
  ['Signal',                          'signal',           r => asText(r.type),         ['prohibit']],
  ['Virtual Signal',                  'virtual_signal',   null,                         ['prohibit']],
  ['Axle Counter Head',               'axle_counter',     r => asText(r.axle_install), ['axle_rail','train_passage_detection_only','is_surveyed','ref_obj','ref_obj_offset']],
  ['Wayside Access Point',            'wab',              r => asText(r.network),       ['text_side']],
  ['Right Hand Turnout',              'switch',           'RH',                         ['div_mp']],
  ['Right Hand Turnout - Rotated 1',  'switch',           'RH-rotated',                 ['div_mp']],
  ['Left Hand Turnout',               'switch',           'LH',                         ['div_mp']],
  ['Left Hand Turnout - Rotated 18',  'switch',           'LH-rotated',                 ['div_mp']],
  ['Symmetrical Turnout',             'switch',           'symmetrical',                ['point_mp_2']],
  ['Symmetrical Turnout - Rotated',   'switch',           'symmetrical-rotated',        ['point_mp_2','fp_mp_4']],
  ['Right Hand Crossover',            'switch',           'RH-crossover',               ['mp_1','fp_mp_1','fp_mp_2','point_mp_1','point_mp_2','name_2']],
  ['Left Hand Crossover',             'switch',           'LH-crossover',               ['mp_1','fp_mp_1','fp_mp_2','point_mp_1','point_mp_2','name_2']],
  ['Derailer',                        'derailer',         r => asText(r.type),         []],
  ['End of Track',                    'end_of_track',     null,                         ['side_eot','bumper']],
  ['Pushbutton',                      'pushbutton',       null,                         ['nb_buttons']],
  ['IVB Limit',                       'ivb_limit',        null,                         []],
  ['Transition point',                'transition_point', r => asText(r.mode),         []],
  ['Clearance',                       'clearance',        r => asText(r.type),         []],
  ['Overlap',                         'overlap',          null,                         []],
  ['Platform',                        'platform',         r => asText(r.type),         ['platform_1','platform_2','mid_mp','platform_mp1','platform_mp2','osp_mp']],
  ['Tunnel',                          'tunnel',           null,                         ['direction_tunnel']],
  ['Area',                            'area',             r => asText(r.type),         []],
];

function deviceFromRow(sheet, deviceType, subtype, attrKeys, r, importId) {
  const shapeId = asNumber(r['Shape ID']);
  if (shapeId == null) return null;

  // Code: most sheets use 'name'; IVB Limit's name is the literal 'IVB',
  // so synthesize a unique code from Shape ID.
  let code = asText(r.name);
  if (deviceType === 'ivb_limit') code = `IVB-${shapeId}`;
  // Crossovers use name_2 as the switch name (per modeling decision).
  if (deviceType === 'switch' && (subtype === 'RH-crossover' || subtype === 'LH-crossover')) {
    code = asText(r.name_2) || code;
  }

  // Primary milepost: most sheets use 'mp'; crossovers use mp_1; LH crossover sometimes uses 'mp'.
  const primaryMp = asNumber(r.mp) ?? asNumber(r.mp_1);
  // Secondary milepost: fp_mp on turnouts; mp_2 on crossovers; mp2 on platforms.
  const secondaryMp = asNumber(r.fp_mp) ?? asNumber(r.mp_2) ?? asNumber(r.mp2);

  // Platforms use mp1/mp2 instead of mp.
  const platformMp = deviceType === 'platform' ? asNumber(r.mp1) : null;

  // Build JSONB attributes from the per-class keys.
  const attributes = {};
  for (const k of attrKeys) {
    const v = r[k];
    if (v !== null && v !== undefined && v !== '') attributes[k] = v;
  }

  return {
    device_type: deviceType,
    device_subtype: typeof subtype === 'function' ? subtype(r) : subtype,
    code,
    uic_code: asText(nullIfZero(r.uic)),
    milepost: platformMp ?? primaryMp,
    milepost_secondary: secondaryMp,
    track_name: asText(nullIfZero(r.track_name)),
    track_type: asText(r.track_type),
    direction: asText(r.Direction),
    position: asText(r.Position),
    is_controlled: asBool(r.is_controlled),
    is_new: asBool(r.is_new) ?? false,
    is_removed: asBool(r.is_removed) ?? false,
    zone_code: null,        // resolved in pass 2
    interlocking_code: null, // resolved in pass 2
    train_control_location_code: null, // left null — Visio export emits 0
    attributes,
    status: deriveStatus(r),
    source_shape_id: shapeId,
    source_sheet: sheet,
    source_import_id: importId,
  };
}

async function importDevices(wb, importId) {
  const records = [];
  const perSheetCounts = {};
  for (const [sheet, deviceType, subtype, attrKeys] of DEVICE_SHEETS) {
    const { rows, realName } = readSheet(wb, sheet);
    if (!realName) continue;
    let kept = 0;
    for (const r of rows) {
      const rec = deviceFromRow(sheet, deviceType, subtype, attrKeys, r, importId);
      if (rec) { records.push(rec); kept++; }
    }
    perSheetCounts[realName] = kept;
  }
  console.log('  devices per sheet:', perSheetCounts);
  return batchUpsert('track_devices', records, { onConflict: 'source_shape_id' });
}

// ── 7. sections (Block sheet) ───────────────────────────────
async function importSections(wb, importId) {
  const { rows } = readSheet(wb, 'Block');
  const records = rows
    .filter(r => asText(r.name))
    .map(r => ({
      code: asText(r.name),
      zone_code: null, // resolved in pass 2
      source_shape_id: asNumber(r['Shape ID']),
      source_import_id: importId,
    }));
  return batchUpsert('track_sections', records, { onConflict: 'code' });
}

// ── 8. pass-2 reference resolution ──────────────────────────
//
// Inference rule (per planning decision; no TCL inference):
//   • Parse zone prefix from the code, splitting on first '-'.
//   • If the prefix matches an interlocking code "${prefix} IXL",
//     set interlocking_id and zone_id = interlocking.parent_zone_id.
//   • Else if the prefix matches a control_zone code, set
//     zone_id directly.
//   • Else leave both NULL (flagged as unresolved).
//
// Also resolves track_zones.parent_zone_id for interlockings
// using their parent_zone_code text.
async function resolveReferences(importId) {
  const { data: zones } = await supabase
    .from('track_zones')
    .select('id,zone_type,code,parent_zone_code');
  const ixlByCode = new Map();      // "W39 IXL" → row
  const ixlByPrefix = new Map();    // "W39" → row
  const ctrlByCode = new Map();     // "W40" → row
  for (const z of zones || []) {
    if (z.zone_type === 'interlocking') {
      ixlByCode.set(z.code, z);
      const prefix = z.code.replace(/\s*IXL$/i, '').trim();
      ixlByPrefix.set(prefix, z);
    }
    if (z.zone_type === 'control_zone') ctrlByCode.set(z.code, z);
  }

  // Resolve interlocking.parent_zone_id from parent_zone_code.
  const ixlPatches = [];
  for (const z of zones || []) {
    if (z.zone_type !== 'interlocking') continue;
    if (!z.parent_zone_code) continue;
    const parent = ctrlByCode.get(z.parent_zone_code);
    if (parent) ixlPatches.push({ id: z.id, parent_zone_id: parent.id });
  }
  for (const p of ixlPatches) {
    await supabase.from('track_zones').update({ parent_zone_id: p.parent_zone_id }).eq('id', p.id);
  }

  // Resolve devices for this import.
  const { data: devices } = await supabase
    .from('track_devices')
    .select('id,code')
    .eq('source_import_id', importId);

  const patches = [];
  let resolved = 0, unresolved = 0;
  for (const d of devices || []) {
    if (!d.code) { unresolved++; continue; }
    const prefix = d.code.split('-')[0].trim();
    const ixl = ixlByPrefix.get(prefix);
    if (ixl) {
      patches.push({
        id: d.id,
        interlocking_id: ixl.id,
        interlocking_code: ixl.code,
        zone_id: null, // will fall back to control zone via the ixl's parent
        zone_code: ixl.parent_zone_code,
      });
      const parent = ixl.parent_zone_code ? ctrlByCode.get(ixl.parent_zone_code) : null;
      if (parent) {
        patches[patches.length - 1].zone_id = parent.id;
        patches[patches.length - 1].zone_code = parent.code;
      }
      resolved++;
      continue;
    }
    const ctrl = ctrlByCode.get(prefix);
    if (ctrl) {
      patches.push({ id: d.id, zone_id: ctrl.id, zone_code: ctrl.code });
      resolved++;
      continue;
    }
    unresolved++;
  }
  for (let i = 0; i < patches.length; i += BATCH_SIZE) {
    const slice = patches.slice(i, i + BATCH_SIZE);
    for (const p of slice) {
      const { id, ...patch } = p;
      const { error } = await supabase.from('track_devices').update(patch).eq('id', id);
      if (error) console.error(`  device ${id}: ${error.message}`);
    }
  }

  // Resolve sections similarly (zone prefix only).
  const { data: sections } = await supabase
    .from('track_sections')
    .select('id,code')
    .eq('source_import_id', importId);
  let secResolved = 0, secUnresolved = 0;
  for (const s of sections || []) {
    const prefix = s.code.split('-')[0].trim();
    const ixl = ixlByPrefix.get(prefix);
    const ctrl = ctrlByCode.get(prefix);
    const zone = ixl
      ? (ixl.parent_zone_code ? ctrlByCode.get(ixl.parent_zone_code) : null)
      : ctrl;
    if (zone) {
      await supabase.from('track_sections')
        .update({ zone_id: zone.id, zone_code: zone.code })
        .eq('id', s.id);
      secResolved++;
    } else {
      secUnresolved++;
    }
  }

  return { devicesResolved: resolved, devicesUnresolved: unresolved,
           sectionsResolved: secResolved, sectionsUnresolved: secUnresolved };
}

// ── main ────────────────────────────────────────────────────
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node sync_track_plan.js <path/to/track_plan.xlsx>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Reading ${filePath} …`);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  console.log(`  ${wb.SheetNames.length} sheets in workbook`);

  const importId = await createImportRow(filePath, wb);
  console.log(`Created track_plan_imports row: ${importId}`);

  console.log('Mileposts …');         const mp   = await importMileposts(wb, importId);
  console.log('Equations …');         const eq   = await importEquations(wb, importId);
  console.log('Train Control Locs …');const tcl  = await importTCLs(wb, importId);
  console.log('Zones …');             const zns  = await importZones(wb, importId);
  console.log('Devices …');           const devs = await importDevices(wb, importId);
  console.log('Sections …');          const sec  = await importSections(wb, importId);

  console.log('Resolving references …');
  const r = await resolveReferences(importId);

  await supabase.from('track_plan_imports').update({
    status: 'complete',
    devices_count: devs.count,
    zones_count: zns.count,
    mileposts_count: mp.count,
  }).eq('id', importId);

  console.log('--- summary ---');
  console.log(`  mileposts:                ${mp.count}  (errors: ${mp.errors})`);
  console.log(`  equations:                ${eq.count}  (errors: ${eq.errors})`);
  console.log(`  train_control_locations:  ${tcl.count} (errors: ${tcl.errors})`);
  console.log(`  zones:                    ${zns.count} (errors: ${zns.errors})`);
  console.log(`  devices:                  ${devs.count} (errors: ${devs.errors})`);
  console.log(`  sections:                 ${sec.count} (errors: ${sec.errors})`);
  console.log(`  devices resolved:         ${r.devicesResolved}`);
  console.log(`  devices unresolved:       ${r.devicesUnresolved}`);
  console.log(`  sections resolved:        ${r.sectionsResolved}`);
  console.log(`  sections unresolved:      ${r.sectionsUnresolved}`);
  console.log('done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
