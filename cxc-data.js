// ==========================================
// Construction Planner — dataset, schema and CRUD (cxc-data.js)
//
// One place that answers "what is a Location / Phase / Activity / Material /
// Crew / Vehicle / Shift window / Scope item, and what fields does it have."
//
// ENTITIES is a SCHEMA, and the management screens are generated from it
// (cxc-ui-manage.js). Adding a field to an entity is a one-line change here —
// the editor, the table column and the persistence all follow automatically.
// Resist the urge to hand-write a form per entity; that is how a 50k-line
// monolith starts.
//
// Pure: no DOM, no storage. CRUD helpers mutate the passed dataset in place and
// the caller saves it (cxc-store-local.js) — deliberate, so the UI never has to
// reconcile two copies of the truth.
// ==========================================
(function () {
  'use strict';

  // The engine's shared helpers (byId/num). Resolved up front so load order is
  // explicit: cxc-model.js must come before this file.
  var CXC = (typeof window !== 'undefined' && window.CXC) ||
            (typeof require !== 'undefined' ? require('./cxc-model.js') : null);

  // ── Field types the generic editor understands ───────────────────────────
  //   text · textarea · number · date · time · select · multiselect ·
  //   dow (day-of-week picker) · materials (activity → material lines)
  // `ref` names another entity whose rows become the options.

  var ENTITIES = {
    locations: {
      label: 'Locations', singular: 'Location', icon: 'pin',
      help: 'Where work happens. Anything a crew mobilizes to: a track segment, an interlocking, a room.',
      fields: [
        { key: 'code', label: 'Code', type: 'text', width: 110, required: true },
        { key: 'name', label: 'Name', type: 'text', width: 240, required: true },
        { key: 'kind', label: 'Type', type: 'select', width: 140, options: ['Track', 'Interlocking', 'Station', 'Facility', 'TPSS', 'Other'] },
        { key: 'milepost', label: 'Milepost', type: 'text', width: 110 },
        { key: 'notes', label: 'Notes', type: 'text', width: 220 }
      ]
    },

    phases: {
      label: 'Phases', singular: 'Phase', icon: 'layers',
      help: 'Stages of installation, in order. With "enforce phase order" on, a phase cannot start at a location until every earlier phase there is complete.',
      fields: [
        { key: 'seq', label: 'Seq', type: 'number', width: 70, step: 1, required: true },
        { key: 'name', label: 'Name', type: 'text', width: 220, required: true },
        { key: 'color', label: 'Color', type: 'select', width: 130, options: ['blue', 'green', 'amber', 'red', 'purple', 'slate'] },
        { key: 'notes', label: 'Notes', type: 'text', width: 260 }
      ]
    },

    activityTypes: {
      label: 'Activities', singular: 'Activity', icon: 'activity',
      help: 'The production rate library. minutesPerUnit is measured AT the reference crew size — the engine scales it for any other crew.',
      fields: [
        { key: 'name', label: 'Name', type: 'text', width: 210, required: true },
        { key: 'discipline', label: 'Discipline', type: 'select', width: 130, options: ['Electrical', 'Signals', 'Comms', 'Civil', 'Track', 'Other'] },
        { key: 'phaseId', label: 'Phase', type: 'select', ref: 'phases', width: 150 },
        { key: 'unit', label: 'Unit', type: 'select', width: 100, options: ['ea', 'lf', 'ft', 'pull', 'term', 'splice', 'hr'] },
        { key: 'minutesPerUnit', label: 'Min / unit', type: 'number', width: 100, step: 0.1, required: true },
        { key: 'refCrewSize', label: 'Ref crew', type: 'number', width: 90, step: 1 },
        { key: 'setupMin', label: 'Setup min', type: 'number', width: 95, step: 5 },
        { key: 'divisible', label: 'Splits', type: 'select', width: 130, options: ['continuous', 'unit', 'none'],
          help: 'continuous = cut anywhere · unit = whole units only · none = must finish in one window' },
        { key: 'materials', label: 'Materials', type: 'materials', width: 200 }
      ]
    },

    materials: {
      label: 'Materials', singular: 'Material', icon: 'package',
      help: 'The material list. "On site from" gates when work can start; "On hand" caps how much the plan may install (leave 0 to leave it untracked).',
      fields: [
        { key: 'code', label: 'Code', type: 'text', width: 120 },
        { key: 'name', label: 'Name', type: 'text', width: 240, required: true },
        { key: 'unit', label: 'Unit', type: 'select', width: 95, options: ['ea', 'lf', 'ft', 'roll', 'box', 'pallet'] },
        { key: 'onHand', label: 'On hand', type: 'number', width: 100, step: 1 },
        { key: 'availableFrom', label: 'On site from', type: 'date', width: 150 },
        { key: 'leadTimeDays', label: 'Lead days', type: 'number', width: 100, step: 1 },
        { key: 'supplier', label: 'Supplier', type: 'text', width: 160 }
      ]
    },

    crews: {
      label: 'Crews', singular: 'Crew', icon: 'users',
      help: 'Who does the work. Leave Skills empty to mean "qualified for everything". A crew with no vehicle assigned is never blocked by the fleet.',
      fields: [
        { key: 'name', label: 'Name', type: 'text', width: 200, required: true },
        { key: 'size', label: 'Size', type: 'number', width: 80, step: 1, required: true },
        { key: 'efficiency', label: 'Efficiency', type: 'number', width: 105, step: 0.05,
          help: 'Multiplier on this crew\'s output. 1.0 = the book rate.' },
        { key: 'skills', label: 'Skills', type: 'multiselect', ref: 'activityTypes', width: 200 },
        { key: 'vehicleIds', label: 'Vehicles', type: 'multiselect', ref: 'vehicles', width: 180 },
        { key: 'shiftPatternIds', label: 'Shifts', type: 'multiselect', ref: 'shiftPatterns', width: 180 }
      ]
    },

    vehicles: {
      label: 'Work vehicles', singular: 'Vehicle', icon: 'truck',
      help: 'Hi-rail, boom trucks, work trains. A vehicle serves ONE crew per window, so a shared truck limits how many crews can work the same night.',
      fields: [
        { key: 'code', label: 'Unit #', type: 'text', width: 110 },
        { key: 'name', label: 'Name', type: 'text', width: 210, required: true },
        { key: 'kind', label: 'Type', type: 'select', width: 150, options: ['Hi-rail truck', 'Boom truck', 'Work train', 'Man-lift', 'Trailer', 'Other'] },
        { key: 'status', label: 'Status', type: 'select', width: 120, options: ['active', 'out of service'] },
        { key: 'availableFrom', label: 'Available from', type: 'date', width: 150 },
        { key: 'availableTo', label: 'Available to', type: 'date', width: 150 },
        { key: 'notes', label: 'Notes', type: 'text', width: 200 }
      ]
    },

    shiftPatterns: {
      label: 'Shift windows', singular: 'Shift window', icon: 'calendar',
      help: 'The access agreement. Mobilization in/out is time the window is granted but no work happens — it is what makes a 2 hr window nearly worthless.',
      fields: [
        { key: 'name', label: 'Name', type: 'text', width: 210, required: true },
        { key: 'kind', label: 'Type', type: 'select', width: 140, options: ['single-track', 'double-track', 'shutdown', 'work-train', 'other'] },
        { key: 'startTime', label: 'Start', type: 'time', width: 100 },
        { key: 'endTime', label: 'End', type: 'time', width: 100 },
        { key: 'endsNextDay', label: 'Overnight', type: 'checkbox', width: 90 },
        { key: 'durationMin', label: 'Duration min', type: 'number', width: 115, step: 30,
          help: 'Set this to state a long shutdown directly. It overrides start/end.' },
        { key: 'mobilizeInMin', label: 'Mob in', type: 'number', width: 90, step: 5 },
        { key: 'mobilizeOutMin', label: 'Mob out', type: 'number', width: 95, step: 5 },
        { key: 'daysOfWeek', label: 'Days', type: 'dow', width: 190 },
        { key: 'maxCrews', label: 'Max crews', type: 'number', width: 105, step: 1 }
      ]
    },

    scope: {
      label: 'Scope', singular: 'Scope item', icon: 'clipboard',
      help: 'The work itself: what, where, how much. Quantity times the activity rate is the duration the planner schedules.',
      fields: [
        { key: 'locationId', label: 'Location', type: 'select', ref: 'locations', width: 190, required: true },
        { key: 'phaseId', label: 'Phase', type: 'select', ref: 'phases', width: 160 },
        { key: 'activityTypeId', label: 'Activity', type: 'select', ref: 'activityTypes', width: 210, required: true },
        { key: 'qty', label: 'Qty', type: 'number', width: 95, step: 1, required: true },
        { key: 'crewId', label: 'Pin to crew', type: 'select', ref: 'crews', width: 165 },
        { key: 'prereqIds', label: 'Starts after', type: 'multiselect', ref: 'scope', width: 190 },
        { key: 'notes', label: 'Notes', type: 'text', width: 200 }
      ]
    }
  };

  // Order the management screens appear in.
  var ENTITY_ORDER = ['scope', 'locations', 'phases', 'activityTypes', 'materials', 'crews', 'vehicles', 'shiftPatterns'];

  // ── Ids ──────────────────────────────────────────────────────────────────
  var PREFIX = {
    locations: 'loc', phases: 'ph', activityTypes: 'act', materials: 'mat',
    crews: 'crew', vehicles: 'veh', shiftPatterns: 'shift', scope: 'S'
  };

  /**
   * Next free id for an entity, stable and readable (loc-3, S-011).
   * @param {object} data
   * @param {string} entityKey
   * @returns {string}
   */
  function nextId(data, entityKey) {
    var pre = PREFIX[entityKey] || entityKey;
    var rows = data[entityKey] || [];
    var max = 0;
    rows.forEach(function (r) {
      var m = new RegExp('^' + pre + '-(\\d+)$').exec(String(r.id || ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var n = String(max + 1);
    if (entityKey === 'scope') while (n.length < 3) n = '0' + n;
    return pre + '-' + n;
  }

  /** A new blank row with sensible defaults for its field types. */
  function emptyRow(data, entityKey) {
    var spec = ENTITIES[entityKey];
    var row = { id: nextId(data, entityKey) };
    (spec.fields || []).forEach(function (f) {
      if (f.type === 'multiselect' || f.type === 'dow' || f.type === 'materials') row[f.key] = [];
      else if (f.type === 'number') row[f.key] = 0;
      else if (f.type === 'checkbox') row[f.key] = false;
      else row[f.key] = '';
    });
    // A few defaults that make a brand-new row immediately usable.
    if (entityKey === 'activityTypes') { row.unit = 'ea'; row.refCrewSize = 2; row.divisible = 'continuous'; row.minutesPerUnit = 60; }
    if (entityKey === 'crews') { row.size = 2; row.efficiency = 1; }
    if (entityKey === 'vehicles') { row.status = 'active'; }
    if (entityKey === 'shiftPatterns') { row.startTime = '22:00'; row.endTime = '06:00'; row.endsNextDay = true; row.daysOfWeek = [1, 2, 3, 4, 5]; row.maxCrews = 2; row.mobilizeInMin = 60; row.mobilizeOutMin = 45; }
    if (entityKey === 'phases') { row.seq = ((data.phases || []).length + 1); row.color = 'slate'; }
    if (entityKey === 'materials') { row.unit = 'ea'; }
    return row;
  }

  /** Append a new row and return it. */
  function addRow(data, entityKey) {
    var row = emptyRow(data, entityKey);
    (data[entityKey] = data[entityKey] || []).push(row);
    return row;
  }

  /** Patch one field on one row. Returns the row, or null if not found. */
  function updateRow(data, entityKey, id, key, value) {
    var row = CXC.byId(data[entityKey], id);
    if (!row) return null;
    row[key] = value;
    return row;
  }

  /** Remove a row. Returns true if something was removed. */
  function removeRow(data, entityKey, id) {
    var rows = data[entityKey] || [];
    var i = rows.findIndex(function (r) { return r.id === id; });
    if (i === -1) return false;
    rows.splice(i, 1);
    return true;
  }

  /** Copy a row (new id, name suffixed) directly below the original. */
  function duplicateRow(data, entityKey, id) {
    var rows = data[entityKey] || [];
    var i = rows.findIndex(function (r) { return r.id === id; });
    if (i === -1) return null;
    var copy = JSON.parse(JSON.stringify(rows[i]));
    copy.id = nextId(data, entityKey);
    if (copy.name) copy.name = copy.name + ' (copy)';
    rows.splice(i + 1, 0, copy);
    return copy;
  }

  /**
   * Everything that points at a row, so deleting it can warn instead of
   * quietly leaving dangling references.
   * @returns {Array<{entity:string, id:string, label:string}>}
   */
  function referencesTo(data, entityKey, id) {
    var hits = [];
    Object.keys(ENTITIES).forEach(function (ek) {
      var spec = ENTITIES[ek];
      (data[ek] || []).forEach(function (row) {
        (spec.fields || []).forEach(function (f) {
          if (f.ref !== entityKey) return;
          var v = row[f.key];
          var match = f.type === 'multiselect' ? (v || []).indexOf(id) !== -1 : v === id;
          if (match) hits.push({ entity: ek, id: row.id, label: rowLabel(data, ek, row) });
        });
        // Activity → material lines are a nested shape, not a plain ref field.
        if (ek === 'activityTypes' && entityKey === 'materials') {
          if ((row.materials || []).some(function (l) { return l.materialId === id; })) {
            hits.push({ entity: ek, id: row.id, label: rowLabel(data, ek, row) });
          }
        }
      });
    });
    return hits;
  }

  /** Human label for a row, used in dropdowns and reference warnings. */
  function rowLabel(data, entityKey, row) {
    if (!row) return '';
    if (entityKey === 'locations') return (row.code ? row.code + ' — ' : '') + (row.name || row.id);
    if (entityKey === 'phases') return (row.seq ? row.seq + '. ' : '') + (row.name || row.id);
    if (entityKey === 'vehicles') return (row.code ? row.code + ' ' : '') + (row.name || row.id);
    if (entityKey === 'scope') {
      var act = CXC.byId(data.activityTypes, row.activityTypeId);
      var loc = CXC.byId(data.locations, row.locationId);
      return row.id + ' · ' + (act ? act.name : '?') + (loc ? ' @ ' + (loc.code || loc.name) : '');
    }
    return row.name || row.id;
  }

  /** Label for an id in an entity (falls back to the raw id). */
  function labelFor(data, entityKey, id) {
    var row = CXC.byId(data[entityKey], id);
    return row ? rowLabel(data, entityKey, row) : (id || '');
  }

  // ── Integrity ────────────────────────────────────────────────────────────
  /**
   * Dangling references and obviously-wrong values, so the app can show a
   * problem list instead of silently producing a wrong schedule.
   * @returns {Array<{entity:string, id:string, message:string}>}
   */
  function validate(data) {
    var out = [];
    Object.keys(ENTITIES).forEach(function (ek) {
      var spec = ENTITIES[ek];
      (data[ek] || []).forEach(function (row) {
        spec.fields.forEach(function (f) {
          var v = row[f.key];
          if (f.required && (v === '' || v === null || v === undefined)) {
            out.push({ entity: ek, id: row.id, message: f.label + ' is required' });
          }
          if (!f.ref) return;
          var ids = f.type === 'multiselect' ? (v || []) : (v ? [v] : []);
          ids.forEach(function (id) {
            if (id && !CXC.byId(data[f.ref], id)) {
              out.push({ entity: ek, id: row.id, message: f.label + ' points at a missing ' + (ENTITIES[f.ref].singular || f.ref) + ' (' + id + ')' });
            }
          });
        });
        if (ek === 'activityTypes') {
          (row.materials || []).forEach(function (l) {
            if (!CXC.byId(data.materials, l.materialId)) {
              out.push({ entity: ek, id: row.id, message: 'material line points at a missing material (' + l.materialId + ')' });
            }
          });
        }
      });
    });
    (data.scope || []).forEach(function (it) {
      if (CXC.num(it.qty, 0) <= 0) out.push({ entity: 'scope', id: it.id, message: 'quantity is zero' });
    });
    return out;
  }

  /**
   * Fill in anything a hand-edited or imported dataset is missing, so the app
   * never crashes on a partial file.
   */
  function normalize(data) {
    data = data || {};
    Object.keys(ENTITIES).forEach(function (ek) {
      if (!Array.isArray(data[ek])) data[ek] = [];
    });
    if (!Array.isArray(data.blackoutDates)) data.blackoutDates = [];
    data.globals = Object.assign({}, DEFAULT_GLOBALS, data.globals || {});
    if (!data.plan) data.plan = { from: '2026-09-07', to: '2026-12-31', patternIds: null };
    return data;
  }

  var DEFAULT_GLOBALS = {
    productivityFactor: 1.0,
    breakMinPerShift: 30,
    contingencyPct: 10,
    crewScalingExponent: 0.85,
    relocationMin: 15,
    enforcePhaseOrder: true
  };

  // Editable metadata for the Assumptions screen.
  var GLOBAL_FIELDS = [
    { key: 'productivityFactor', label: 'Productivity factor', type: 'number', step: 0.05,
      help: 'Blanket multiplier on output. 1.0 = the activity rates are right; 0.8 models a bad stretch.' },
    { key: 'crewScalingExponent', label: 'Crew scaling exponent', type: 'number', step: 0.05,
      help: '1 = doubling a crew halves the duration. 0 = extra people add nothing. Real trades sit 0.75–0.9.' },
    { key: 'breakMinPerShift', label: 'Breaks per shift (min)', type: 'number', step: 5,
      help: 'Paid non-productive time inside every window: safety brief, breaks.' },
    { key: 'contingencyPct', label: 'Contingency (%)', type: 'number', step: 5,
      help: 'Share of each window deliberately left unplanned as buffer.' },
    { key: 'relocationMin', label: 'Relocation (min)', type: 'number', step: 5,
      help: 'Cost of a crew moving to a different location inside one window.' },
    { key: 'enforcePhaseOrder', label: 'Enforce phase order', type: 'checkbox',
      help: 'Block a phase at a location until every earlier phase there is complete.' }
  ];

  // ── Seed dataset ─────────────────────────────────────────────────────────
  // A worked example so the app is not an empty grid on first run. EVERY value
  // is a placeholder for the estimator to overwrite — especially the rates.
  function seed() {
    return normalize({
      globals: Object.assign({}, DEFAULT_GLOBALS),
      plan: { from: '2026-09-07', to: '2026-12-31', patternIds: null },

      locations: [
        { id: 'loc-1', code: 'MP 1.0–1.5', name: 'Mainline north', kind: 'Track', milepost: '1.0', notes: '' },
        { id: 'loc-2', code: 'MP 2.0–2.4', name: 'Mainline south', kind: 'Track', milepost: '2.0', notes: '' },
        { id: 'loc-3', code: 'CIL 12', name: 'Interlocking 12', kind: 'Interlocking', milepost: '1.6', notes: '' },
        { id: 'loc-4', code: 'CIL 14', name: 'Interlocking 14', kind: 'Interlocking', milepost: '2.5', notes: '' },
        { id: 'loc-5', code: 'TPSS 3', name: 'Traction power substation 3', kind: 'TPSS', milepost: '1.9', notes: '' }
      ],

      phases: [
        { id: 'ph-1', seq: 1, name: 'Rough-in', color: 'slate', notes: 'Conduit, hangers, boxes' },
        { id: 'ph-2', seq: 2, name: 'Cable pull', color: 'blue', notes: 'Fiber and power' },
        { id: 'ph-3', seq: 3, name: 'Device install', color: 'purple', notes: 'Wayside equipment' },
        { id: 'ph-4', seq: 4, name: 'Termination & test', color: 'green', notes: 'Landing and ring-out' }
      ],

      materials: [
        { id: 'mat-1', code: 'RGS-4', name: 'Rigid galvanized conduit 4"', unit: 'lf', onHand: 6000, availableFrom: '2026-09-07', leadTimeDays: 45, supplier: '' },
        { id: 'mat-2', code: 'EMT-2', name: 'EMT conduit 2"', unit: 'lf', onHand: 4000, availableFrom: '2026-09-07', leadTimeDays: 30, supplier: '' },
        { id: 'mat-3', code: 'FO-48', name: 'Fiber optic cable 48ct', unit: 'lf', onHand: 0, availableFrom: '2026-09-21', leadTimeDays: 90, supplier: '' },
        { id: 'mat-4', code: 'PWR-2C', name: 'Power cable 2/C #6', unit: 'lf', onHand: 0, availableFrom: '2026-09-14', leadTimeDays: 60, supplier: '' },
        { id: 'mat-5', code: 'AXC', name: 'Axle counter head', unit: 'ea', onHand: 8, availableFrom: '2026-10-05', leadTimeDays: 120, supplier: '' },
        { id: 'mat-6', code: 'BAL', name: 'Balise', unit: 'ea', onHand: 20, availableFrom: '2026-10-05', leadTimeDays: 120, supplier: '' },
        { id: 'mat-7', code: 'RAD-W', name: 'Wayside radio', unit: 'ea', onHand: 6, availableFrom: '2026-10-19', leadTimeDays: 150, supplier: '' },
        { id: 'mat-8', code: 'SPL-KIT', name: 'Fiber splice kit', unit: 'ea', onHand: 40, availableFrom: '2026-09-21', leadTimeDays: 30, supplier: '' }
      ],

      activityTypes: [
        { id: 'act-1', name: 'Conduit — 4" RGS', discipline: 'Electrical', phaseId: 'ph-1', unit: 'lf', minutesPerUnit: 5.5, refCrewSize: 3, setupMin: 45, divisible: 'continuous', materials: [{ materialId: 'mat-1', qtyPerUnit: 1 }] },
        { id: 'act-2', name: 'Conduit — 2" EMT', discipline: 'Electrical', phaseId: 'ph-1', unit: 'lf', minutesPerUnit: 3.0, refCrewSize: 2, setupMin: 30, divisible: 'continuous', materials: [{ materialId: 'mat-2', qtyPerUnit: 1 }] },
        { id: 'act-3', name: 'Fiber — pull', discipline: 'Comms', phaseId: 'ph-2', unit: 'lf', minutesPerUnit: 1.2, refCrewSize: 4, setupMin: 60, divisible: 'continuous', materials: [{ materialId: 'mat-3', qtyPerUnit: 1 }] },
        { id: 'act-4', name: 'Power cable — pull', discipline: 'Electrical', phaseId: 'ph-2', unit: 'lf', minutesPerUnit: 2.2, refCrewSize: 4, setupMin: 60, divisible: 'continuous', materials: [{ materialId: 'mat-4', qtyPerUnit: 1 }] },
        { id: 'act-5', name: 'Device — axle counter', discipline: 'Signals', phaseId: 'ph-3', unit: 'ea', minutesPerUnit: 180, refCrewSize: 2, setupMin: 30, divisible: 'unit', materials: [{ materialId: 'mat-5', qtyPerUnit: 1 }] },
        { id: 'act-6', name: 'Device — balise', discipline: 'Signals', phaseId: 'ph-3', unit: 'ea', minutesPerUnit: 90, refCrewSize: 2, setupMin: 20, divisible: 'unit', materials: [{ materialId: 'mat-6', qtyPerUnit: 1 }] },
        { id: 'act-7', name: 'Device — wayside radio', discipline: 'Comms', phaseId: 'ph-3', unit: 'ea', minutesPerUnit: 240, refCrewSize: 2, setupMin: 45, divisible: 'unit', materials: [{ materialId: 'mat-7', qtyPerUnit: 1 }] },
        { id: 'act-8', name: 'Fiber — splice', discipline: 'Comms', phaseId: 'ph-4', unit: 'splice', minutesPerUnit: 25, refCrewSize: 1, setupMin: 40, divisible: 'unit', materials: [{ materialId: 'mat-8', qtyPerUnit: 1 }] },
        { id: 'act-9', name: 'Power — termination', discipline: 'Electrical', phaseId: 'ph-4', unit: 'term', minutesPerUnit: 35, refCrewSize: 2, setupMin: 20, divisible: 'unit', materials: [] }
      ],

      vehicles: [
        { id: 'veh-1', code: 'HR-101', name: 'Hi-rail bucket truck', kind: 'Hi-rail truck', status: 'active', availableFrom: '', availableTo: '', notes: '' },
        { id: 'veh-2', code: 'HR-102', name: 'Hi-rail crew truck', kind: 'Hi-rail truck', status: 'active', availableFrom: '', availableTo: '', notes: '' },
        { id: 'veh-3', code: 'BT-201', name: 'Boom truck', kind: 'Boom truck', status: 'active', availableFrom: '', availableTo: '', notes: '' },
        { id: 'veh-4', code: 'WT-1', name: 'Work train consist', kind: 'Work train', status: 'active', availableFrom: '', availableTo: '', notes: 'Shutdowns only' }
      ],

      crews: [
        { id: 'crew-1', name: 'Crew A — electrical', size: 4, efficiency: 1.0, skills: ['act-1', 'act-2', 'act-4', 'act-9'], vehicleIds: ['veh-1'], shiftPatternIds: ['shift-1', 'shift-3'] },
        { id: 'crew-2', name: 'Crew B — comms', size: 3, efficiency: 0.9, skills: ['act-3', 'act-7', 'act-8'], vehicleIds: ['veh-2'], shiftPatternIds: ['shift-1', 'shift-2', 'shift-3'] },
        { id: 'crew-3', name: 'Crew C — signals', size: 3, efficiency: 1.0, skills: ['act-5', 'act-6'], vehicleIds: ['veh-3'], shiftPatternIds: ['shift-1', 'shift-3'] }
      ],

      shiftPatterns: [
        { id: 'shift-1', name: 'Single track — 8 hr night', kind: 'single-track', startTime: '22:00', endTime: '06:00', endsNextDay: true, durationMin: 0, mobilizeInMin: 60, mobilizeOutMin: 45, daysOfWeek: [1, 2, 3, 4, 5], maxCrews: 2 },
        { id: 'shift-2', name: 'Short window — 2 hr', kind: 'single-track', startTime: '01:00', endTime: '03:00', endsNextDay: false, durationMin: 0, mobilizeInMin: 35, mobilizeOutMin: 25, daysOfWeek: [1, 2, 3, 4, 5], maxCrews: 1 },
        { id: 'shift-3', name: 'Weekend shutdown', kind: 'shutdown', startTime: '22:00', endTime: '02:00', endsNextDay: true, durationMin: 3120, mobilizeInMin: 90, mobilizeOutMin: 90, daysOfWeek: [5], maxCrews: 3 }
      ],

      scope: [
        { id: 'S-001', locationId: 'loc-1', phaseId: 'ph-1', activityTypeId: 'act-1', qty: 2600, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-002', locationId: 'loc-1', phaseId: 'ph-2', activityTypeId: 'act-4', qty: 2600, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-003', locationId: 'loc-1', phaseId: 'ph-2', activityTypeId: 'act-3', qty: 2600, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-004', locationId: 'loc-1', phaseId: 'ph-4', activityTypeId: 'act-9', qty: 24, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-005', locationId: 'loc-1', phaseId: 'ph-4', activityTypeId: 'act-8', qty: 18, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-006', locationId: 'loc-2', phaseId: 'ph-1', activityTypeId: 'act-2', qty: 1900, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-007', locationId: 'loc-2', phaseId: 'ph-2', activityTypeId: 'act-3', qty: 1900, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-008', locationId: 'loc-2', phaseId: 'ph-4', activityTypeId: 'act-8', qty: 12, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-009', locationId: 'loc-3', phaseId: 'ph-3', activityTypeId: 'act-5', qty: 6, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-010', locationId: 'loc-3', phaseId: 'ph-3', activityTypeId: 'act-6', qty: 14, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-011', locationId: 'loc-4', phaseId: 'ph-3', activityTypeId: 'act-7', qty: 4, crewId: '', prereqIds: [], notes: '' },
        { id: 'S-012', locationId: 'loc-5', phaseId: 'ph-1', activityTypeId: 'act-1', qty: 800, crewId: '', prereqIds: [], notes: '' }
      ],

      blackoutDates: []
    });
  }

  var CXCData = {
    ENTITIES: ENTITIES,
    ENTITY_ORDER: ENTITY_ORDER,
    GLOBAL_FIELDS: GLOBAL_FIELDS,
    DEFAULT_GLOBALS: DEFAULT_GLOBALS,
    seed: seed,
    normalize: normalize,
    nextId: nextId,
    emptyRow: emptyRow,
    addRow: addRow,
    updateRow: updateRow,
    removeRow: removeRow,
    duplicateRow: duplicateRow,
    referencesTo: referencesTo,
    rowLabel: rowLabel,
    labelFor: labelFor,
    validate: validate
  };

  if (typeof window !== 'undefined') window.CXCData = CXCData;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXCData;
})();
