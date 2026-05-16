// Headless test for the lookahead copy/paste logic.
// Stubs the DB layer so we can exercise the pure logic functions without a browser.
// Run from the cx-portal directory:  node tools/test_copy_paste.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ─── Tiny shims so app.js can load in Node ───────────────────────────────
const fakeWindow = {};
const fakeDoc = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { add: () => {}, remove: () => {} } },
  createElement: () => ({ classList: { add: () => {}, remove: () => {}, contains: () => false }, appendChild: () => {} }),
};

global.window = fakeWindow;
global.document = fakeDoc;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.sessionStorage = global.localStorage;
global.alert = () => {};
global.confirm = () => true;
global.fetch = async () => ({ ok: true, json: async () => [], text: async () => '' });
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

// Day.js for the date math
global.dayjs = require('dayjs') || null;
if (!global.dayjs) {
  // Lightweight inline shim if dayjs not installed in node_modules
  global.dayjs = (input) => {
    const d = input ? new Date(input + 'T00:00:00Z') : new Date();
    return {
      format(fmt) {
        if (fmt === 'YYYY-MM-DD') return d.toISOString().slice(0, 10);
        return d.toISOString();
      },
      diff(other, unit) {
        const ms = d.getTime() - new Date(other.format('YYYY-MM-DD') + 'T00:00:00Z').getTime();
        if (unit === 'day') return Math.round(ms / 86400000);
        return ms;
      },
      add(n, unit) {
        const d2 = new Date(d);
        if (unit === 'day') d2.setUTCDate(d2.getUTCDate() + n);
        return global.dayjs(d2.toISOString().slice(0, 10));
      },
      day() { return d.getUTCDay(); },
      month() { return d.getUTCMonth(); },
      year() { return d.getUTCFullYear(); },
      date() { return d.getUTCDate(); },
    };
  };
}

// ─── Stand up a fake module that mirrors the relevant parts of app.js ────
// Instead of loading the whole 17K-line app.js (which depends on browser APIs
// at module load), we re-implement just the pure logic of the paste pipeline,
// matching the exact code path from _laPasteAtTarget → _laExecutePaste.

let PLANNING_EVENTS = [];
let PLANNING_EVENT_RES = [];
let PLANNING_RESOURCES = [];
let PTO_REQUESTS = [];
let CURRENT_USER_ID = 'test-admin-uuid';

const dbCalls = [];
function _dbInsert(table, rows) {
  dbCalls.push({ op: 'insert', table, rows });
  // simulate returned UUID
  return Promise.resolve(rows.map(r => ({ ...r, id: 'new-' + Math.random().toString(36).slice(2, 9) })));
}
function _dbDelete(table, match) {
  dbCalls.push({ op: 'delete', table, match });
  if (table === 'planning_events') {
    PLANNING_EVENTS = PLANNING_EVENTS.filter(e => e.id !== match.id);
  } else if (table === 'planning_event_resources') {
    // Delete rows matching ALL keys in `match` (keep non-matching)
    PLANNING_EVENT_RES = PLANNING_EVENT_RES.filter(er =>
      !Object.entries(match).every(([k, v]) => er[k] === v)
    );
  }
  return Promise.resolve();
}

// Inline the paste logic (mirror of _laExecutePaste + collision/PTO detection)
async function paste(clipboard, target, opts = {}) {
  const { items, anchorDate } = clipboard;
  const dayShift = global.dayjs(target.date).diff(global.dayjs(anchorDate), 'day');
  const ops = items.map(it => {
    const newDate = global.dayjs(it.event.event_date).add(dayShift, 'day').format('YYYY-MM-DD');
    const newActId = it.sameActivityAsAnchor ? target.activityId : it.event.planning_activity_id;
    return { src: it, newDate, newActId };
  });

  const collisions = [], lockedSkips = [], ptoConflicts = [];
  ops.forEach(op => {
    const existing = PLANNING_EVENTS.find(e =>
      e.planning_activity_id === op.newActId &&
      e.event_date === op.newDate &&
      e.status !== 'cancelled'
    );
    if (existing) {
      if (existing.is_locked) lockedSkips.push({ op, existing });
      else collisions.push({ op, existing });
    }
    op.src.resources.forEach(er => {
      const onPTO = PTO_REQUESTS.some(p =>
        p.status === 'approved' &&
        p.resource_id === er.resource_id &&
        op.newDate >= p.start_date &&
        op.newDate <= p.end_date
      );
      if (onPTO) {
        const r = PLANNING_RESOURCES.find(x => x.id === er.resource_id);
        ptoConflicts.push({ name: r?.display_name || '?', date: op.newDate });
      }
    });
  });

  let inserted = 0, overwritten = 0, skipped = 0;
  const collisionAction = opts.collisionAction || 'overwrite';
  for (const op of ops) {
    const existing = PLANNING_EVENTS.find(e =>
      e.planning_activity_id === op.newActId &&
      e.event_date === op.newDate &&
      e.status !== 'cancelled'
    );
    if (existing && existing.is_locked) { skipped++; continue; }
    if (existing) {
      if (collisionAction === 'skip') { skipped++; continue; }
      await _dbDelete('planning_event_resources', { event_id: existing.id });
      await _dbDelete('planning_events', { id: existing.id });
      overwritten++;
    }
    const src = op.src.event;
    const newRows = await _dbInsert('planning_events', [{
      planning_activity_id: op.newActId,
      title: src.title,
      event_date: op.newDate,
      start_time: src.start_time,
      end_time: src.end_time,
      all_day: src.all_day,
      location: src.location,
      shift_type: src.shift_type,
      source: 'manual',
      status: src.status === 'cancelled' ? 'scheduled' : (src.status || 'scheduled'),
      is_locked: false,
      created_by: CURRENT_USER_ID,
    }]);
    inserted++;
    const newId = newRows[0].id;
    PLANNING_EVENTS.push({ ...newRows[0], id: newId });
    if (op.src.resources.length > 0) {
      const resRows = op.src.resources.map(er => ({
        event_id: newId, resource_id: er.resource_id, assigned_by: CURRENT_USER_ID,
      }));
      await _dbInsert('planning_event_resources', resRows);
      resRows.forEach(r => PLANNING_EVENT_RES.push(r));
    }
  }

  if (clipboard.mode === 'cut') {
    for (const it of clipboard.items) {
      if (it.event.is_locked) continue;
      await _dbDelete('planning_event_resources', { event_id: it.event.id });
      await _dbDelete('planning_events', { id: it.event.id });
    }
  }

  return { inserted, overwritten, skipped, collisions, lockedSkips, ptoConflicts };
}

function buildClipboard(eventIds, mode = 'copy') {
  const events = PLANNING_EVENTS.filter(e => eventIds.includes(e.id));
  const sorted = [...events].sort((a, b) =>
    a.event_date.localeCompare(b.event_date) ||
    String(a.planning_activity_id||'').localeCompare(String(b.planning_activity_id||''))
  );
  const anchorActId = sorted[0].planning_activity_id;
  const anchorDate = sorted[0].event_date;
  const items = events.map(e => ({
    event: e,
    resources: PLANNING_EVENT_RES.filter(er => er.event_id === e.id),
    dayOffset: global.dayjs(e.event_date).diff(global.dayjs(anchorDate), 'day'),
    sameActivityAsAnchor: e.planning_activity_id === anchorActId,
  }));
  return { mode, items, anchorActId, anchorDate };
}

// ─── TEST CASES ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(name, cond, details = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${details ? ' — ' + details : ''}`); }
}

function resetFixtures() {
  dbCalls.length = 0;
  PLANNING_RESOURCES = [
    { id: 'res-john', display_name: 'John Smith' },
    { id: 'res-jane', display_name: 'Jane Doe' },
  ];
  PTO_REQUESTS = [
    { id: 'pto-1', resource_id: 'res-john', status: 'approved', start_date: '2026-06-05', end_date: '2026-06-07' },
  ];
  PLANNING_EVENTS = [
    { id: 'ev-1', planning_activity_id: 'act-A', title: 'Test 1', event_date: '2026-06-01', shift_type: 'day_shift', start_time: '07:00', end_time: '15:00', all_day: false, status: 'scheduled', is_locked: false, source: 'lookahead' },
    { id: 'ev-2', planning_activity_id: 'act-A', title: 'Test 1', event_date: '2026-06-02', shift_type: 'night_shift', start_time: '20:00', end_time: '07:00', all_day: false, status: 'scheduled', is_locked: false, source: 'lookahead' },
    { id: 'ev-3', planning_activity_id: 'act-B', title: 'Test 2', event_date: '2026-06-03', shift_type: 'blanket_shift', all_day: true, status: 'scheduled', is_locked: false, source: 'lookahead' },
    { id: 'ev-4', planning_activity_id: 'act-A', title: 'Test 1', event_date: '2026-06-10', shift_type: 'day_shift', start_time: '07:00', end_time: '15:00', all_day: false, status: 'scheduled', is_locked: true, source: 'manual' },
  ];
  PLANNING_EVENT_RES = [
    { event_id: 'ev-1', resource_id: 'res-john' },
    { event_id: 'ev-1', resource_id: 'res-jane' },
    { event_id: 'ev-2', resource_id: 'res-john' },
  ];
}

(async () => {
  console.log('\n=== Test 1: Single-cell copy → paste to empty cell ===');
  resetFixtures();
  const clip1 = buildClipboard(['ev-1']);
  ok('Clipboard has 1 item',          clip1.items.length === 1);
  ok('Anchor activity is act-A',      clip1.anchorActId === 'act-A');
  ok('Anchor date is 2026-06-01',     clip1.anchorDate === '2026-06-01');
  ok('Day offset is 0',               clip1.items[0].dayOffset === 0);
  ok('Resources captured',            clip1.items[0].resources.length === 2);
  const r1 = await paste(clip1, { activityId: 'act-A', date: '2026-06-15' });
  ok('1 event inserted',              r1.inserted === 1);
  ok('No collisions',                 r1.collisions.length === 0);
  const newEv = PLANNING_EVENTS.find(e => e.event_date === '2026-06-15' && e.planning_activity_id === 'act-A');
  ok('New event on target date',      !!newEv);
  ok('Shift type preserved',          newEv.shift_type === 'day_shift');
  ok('Title preserved',               newEv.title === 'Test 1');
  ok('Source flagged manual',         newEv.source === 'manual');
  ok('Not locked',                    newEv.is_locked === false);
  const newResRows = PLANNING_EVENT_RES.filter(er => er.event_id === newEv.id);
  ok('2 resources cloned',            newResRows.length === 2);

  console.log('\n=== Test 2: Multi-cell sequential paste (3 days → shift to new week) ===');
  resetFixtures();
  // Add a 3rd day for the multi-day pattern
  PLANNING_EVENTS.push({ id: 'ev-2b', planning_activity_id: 'act-A', title: 'Test 1', event_date: '2026-06-03', shift_type: 'day_shift', start_time: '07:00', end_time: '15:00', all_day: false, status: 'scheduled', is_locked: false, source: 'lookahead' });
  const clip2 = buildClipboard(['ev-1', 'ev-2', 'ev-2b']);
  ok('3 items in clipboard',          clip2.items.length === 3);
  ok('All from anchor activity',      clip2.items.every(i => i.sameActivityAsAnchor));
  ok('Day offsets: 0, 1, 2',          JSON.stringify(clip2.items.map(i => i.dayOffset).sort()) === '[0,1,2]');
  const r2 = await paste(clip2, { activityId: 'act-A', date: '2026-06-20' });
  ok('3 events inserted',             r2.inserted === 3);
  const targetDates = PLANNING_EVENTS
    .filter(e => ['2026-06-20','2026-06-21','2026-06-22'].includes(e.event_date) && e.planning_activity_id === 'act-A')
    .map(e => e.event_date).sort();
  ok('Lands on Sat/Sun/Mon (seq)',    JSON.stringify(targetDates) === '["2026-06-20","2026-06-21","2026-06-22"]');

  console.log('\n=== Test 3: Cross-row copy (act-A + act-B) preserves source rows ===');
  resetFixtures();
  const clip3 = buildClipboard(['ev-1', 'ev-3']);
  ok('Mixed anchor membership',       clip3.items.find(i => i.event.id === 'ev-3').sameActivityAsAnchor === false);
  const r3 = await paste(clip3, { activityId: 'act-A', date: '2026-06-15' });
  ok('Both events inserted',          r3.inserted === 2);
  // ev-1 (sameActivity=true) → act-A on 2026-06-15
  // ev-3 (sameActivity=false) → act-B on 2026-06-17 (date shift +14 from anchor 06-01)
  const ev3Target = PLANNING_EVENTS.find(e => e.planning_activity_id === 'act-B' && e.event_date === '2026-06-17');
  ok('Cross-row event keeps act-B',   !!ev3Target);

  console.log('\n=== Test 4: Collision detection — paste onto existing event ===');
  resetFixtures();
  const clip4 = buildClipboard(['ev-1']);
  const r4skip = await paste(clip4, { activityId: 'act-A', date: '2026-06-02' }, { collisionAction: 'skip' });
  ok('Collision detected',            r4skip.collisions.length === 1);
  ok('Skipped on skip action',        r4skip.inserted === 0 && r4skip.skipped === 1);
  ok('Existing event survived',       !!PLANNING_EVENTS.find(e => e.id === 'ev-2'));

  resetFixtures();
  const clip4b = buildClipboard(['ev-1']);
  const r4over = await paste(clip4b, { activityId: 'act-A', date: '2026-06-02' }, { collisionAction: 'overwrite' });
  ok('Overwrote existing',            r4over.overwritten === 1 && r4over.inserted === 1);
  ok('Old ev-2 gone',                 !PLANNING_EVENTS.find(e => e.id === 'ev-2'));

  console.log('\n=== Test 5: Locked target ALWAYS skipped (even on overwrite) ===');
  resetFixtures();
  const clip5 = buildClipboard(['ev-1']);
  const r5 = await paste(clip5, { activityId: 'act-A', date: '2026-06-10' }, { collisionAction: 'overwrite' });
  ok('Locked target detected',        r5.lockedSkips.length === 1);
  ok('Skipped (not overwritten)',     r5.skipped === 1 && r5.overwritten === 0);
  ok('Locked event ev-4 preserved',   !!PLANNING_EVENTS.find(e => e.id === 'ev-4'));

  console.log('\n=== Test 6: PTO warning on paste target ===');
  resetFixtures();
  const clip6 = buildClipboard(['ev-1']);
  // ev-1 has John (PTO 6/5-6/7) → pasting to 6/6 should flag PTO
  const r6 = await paste(clip6, { activityId: 'act-A', date: '2026-06-06' }, { collisionAction: 'overwrite' });
  ok('PTO conflict detected',         r6.ptoConflicts.length === 1);
  ok('PTO conflict for John',         r6.ptoConflicts[0].name === 'John Smith');
  ok('Paste still proceeds',          r6.inserted === 1, 'user warned, not blocked');

  console.log('\n=== Test 7: Cut + paste removes source ===');
  resetFixtures();
  const clip7 = buildClipboard(['ev-1'], 'cut');
  const r7 = await paste(clip7, { activityId: 'act-A', date: '2026-06-15' });
  ok('New event inserted',            r7.inserted === 1);
  ok('Source ev-1 deleted',           !PLANNING_EVENTS.find(e => e.id === 'ev-1'));
  ok('Source resources cleared',      PLANNING_EVENT_RES.filter(er => er.event_id === 'ev-1').length === 0);

  console.log('\n=== Test 8: Cut a locked source — source survives ===');
  resetFixtures();
  PLANNING_EVENTS.find(e => e.id === 'ev-1').is_locked = true;
  const clip8 = buildClipboard(['ev-1'], 'cut');
  const r8 = await paste(clip8, { activityId: 'act-A', date: '2026-06-15' });
  ok('Clone still made',              r8.inserted === 1);
  ok('Locked source preserved',       !!PLANNING_EVENTS.find(e => e.id === 'ev-1'));

  console.log('\n=== Test 9: Cancelled events become scheduled on paste ===');
  resetFixtures();
  PLANNING_EVENTS.find(e => e.id === 'ev-1').status = 'cancelled';
  const clip9 = buildClipboard(['ev-1']);
  const r9 = await paste(clip9, { activityId: 'act-A', date: '2026-06-15' });
  ok('Cloned',                        r9.inserted === 1);
  const newEv9 = PLANNING_EVENTS.find(e => e.event_date === '2026-06-15' && e.planning_activity_id === 'act-A');
  ok('Status reset to scheduled',     newEv9.status === 'scheduled', `got: ${newEv9.status}`);

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
