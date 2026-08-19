// ==========================================
// Construction Planner — management screens (cxc-ui-manage.js)
//
// ONE generic editor renders every entity — locations, phases, activities,
// materials, crews, vehicles, shift windows and scope — straight from the
// schema in cxc-data.js. Add a field there and the column, the input, the
// validation and the persistence all appear here for free.
//
// Editing is inline and immediate: change a cell, it saves and the schedule
// re-runs. No save button to forget, no modal round-trip for a number.
// The two shapes that genuinely need more room (multi-select lists, an
// activity's material lines) open the shared modal.
// ==========================================
(function () {
  'use strict';

  var DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ── Cell renderers ───────────────────────────────────────────────────────
  function optionsFor(field, data) {
    if (field.ref) {
      return (data[field.ref] || []).map(function (r) {
        return { value: r.id, label: CXCData.rowLabel(data, field.ref, r) };
      });
    }
    return (field.options || []).map(function (o) { return { value: o, label: o }; });
  }

  function cell(entityKey, row, field, data) {
    var v = row[field.key];
    var missing = field.required && (v === '' || v === null || v === undefined);
    var cls = 'cxc-cell' + (missing ? ' cxc-missing' : '');
    // Identifies this cell across a re-render so the shell can put the cursor
    // back where the user left it (see restoreFocus in cxc-ui-shell.js).
    var fk = ' data-focus-key="' + escapeHtml(entityKey + '|' + row.id + '|' + field.key) + '" ';

    switch (field.type) {
      case 'number':
        return '<input type="number" class="' + cls + ' cxc-num" step="' + (field.step || 1) + '" ' +
          'value="' + escapeHtml(v === '' || v === null || v === undefined ? '' : v) + '" ' +
          'aria-label="' + escapeHtml(field.label) + '"' + fk +
          cxOn('change', 'cxcEdit', entityKey, row.id, field.key, '$cx.value') + '>';

      case 'date':
      case 'time':
        return '<input type="' + field.type + '" class="' + cls + '" value="' + escapeHtml(v || '') + '" ' +
          'aria-label="' + escapeHtml(field.label) + '"' + fk +
          cxOn('change', 'cxcEdit', entityKey, row.id, field.key, '$cx.value') + '>';

      case 'checkbox':
        return '<input type="checkbox" ' + (v ? 'checked' : '') + ' ' +
          'aria-label="' + escapeHtml(field.label) + '"' + fk +
          cxOn('change', 'cxcEdit', entityKey, row.id, field.key, '$cx.checked') + '>';

      case 'select':
        var opts = optionsFor(field, data);
        var html = '<select class="' + cls + '" aria-label="' + escapeHtml(field.label) + '"' + fk +
          cxOn('change', 'cxcEdit', entityKey, row.id, field.key, '$cx.value') + '>';
        if (!field.required) html += '<option value="">—</option>';
        opts.forEach(function (o) {
          html += '<option value="' + escapeHtml(o.value) + '"' + (o.value === v ? ' selected' : '') + '>' +
            escapeHtml(o.label) + '</option>';
        });
        return html + '</select>';

      case 'multiselect':
        return chipCell(
          (v || []).map(function (id) { return CXCData.labelFor(data, field.ref, id); }),
          'Any',
          cxAct('cxcPickList', entityKey, row.id, field.key)
        );

      case 'materials':
        return chipCell(
          (v || []).map(function (line) {
            var m = CXC.byId(data.materials, line.materialId);
            return (m ? (m.code || m.name) : '?') + ' ×' + line.qtyPerUnit;
          }),
          'None',
          cxAct('cxcPickMaterials', row.id)
        );

      case 'dow':
        var days = v || [];
        var d = '<div class="cxc-dow">';
        for (var i = 0; i < 7; i++) {
          d += '<button type="button" class="' + (days.indexOf(i) !== -1 ? 'cxc-on' : '') + '" ' +
            'aria-label="' + DOW_FULL[i] + '" aria-pressed="' + (days.indexOf(i) !== -1) + '" ' +
            cxAct('cxcToggleDow', entityKey, row.id, field.key, i) + '>' + DOW[i] + '</button>';
        }
        return d + '</div>';

      default:
        return '<input type="text" class="' + cls + '" value="' + escapeHtml(v || '') + '" ' +
          'aria-label="' + escapeHtml(field.label) + '"' + fk +
          cxOn('change', 'cxcEdit', entityKey, row.id, field.key, '$cx.value') + '>';
    }
  }

  /** A cell that shows a list as chips and opens a picker when clicked. */
  function chipCell(labels, placeholder, actionAttrs) {
    var shown = labels.slice(0, 3);
    var extra = labels.length - shown.length;
    var inner = labels.length
      ? shown.map(function (l) { return '<span class="cxc-chip">' + escapeHtml(l) + '</span>'; }).join('') +
        (extra > 0 ? '<span class="cxc-chip-more">+' + extra + '</span>' : '')
      : '<span class="cxc-placeholder">' + escapeHtml(placeholder) + '</span>';
    return '<button type="button" class="cxc-chipcell" ' + actionAttrs + '>' + inner + '</button>';
  }

  // ── Entity table ─────────────────────────────────────────────────────────
  function renderEntity(entityKey, data) {
    var spec = CXCData.ENTITIES[entityKey];
    var rows = data[entityKey] || [];

    var head = '<tr><th style="width:78px">ID</th>';
    spec.fields.forEach(function (f) {
      head += '<th' + (f.width ? ' style="min-width:' + f.width + 'px"' : '') + '>' +
        escapeHtml(f.label) +
        (f.help ? ' <span class="cxc-help" title="' + escapeHtml(f.help) + '" aria-hidden="true">?</span>' : '') +
        '</th>';
    });
    head += '<th class="cxc-actcol" style="width:76px"><span class="cxc-rowid">Actions</span></th></tr>';

    var body = rows.map(function (row) {
      var tds = '<td class="cxc-rowid cxc-mono">' + escapeHtml(row.id) + '</td>';
      spec.fields.forEach(function (f) { tds += '<td>' + cell(entityKey, row, f, data) + '</td>'; });
      tds += '<td class="cxc-rowacts">' +
        '<button type="button" class="cxc-iconbtn" aria-label="Duplicate ' + escapeHtml(row.id) + '" ' +
          'title="Duplicate" ' + cxAct('cxcDuplicate', entityKey, row.id) + '>' + icon('copy') + '</button>' +
        '<button type="button" class="cxc-iconbtn cxc-danger" aria-label="Delete ' + escapeHtml(row.id) + '" ' +
          'title="Delete" ' + cxAct('cxcDelete', entityKey, row.id) + '>' + icon('trash') + '</button>' +
        '</td>';
      return '<tr>' + tds + '</tr>';
    }).join('');

    var problems = CXCData.validate(data).filter(function (p) { return p.entity === entityKey; });

    return '' +
      (problems.length ? problemCard(problems) : '') +
      '<div class="cxc-card">' +
        '<div class="cxc-card-head">' +
          '<div><h3>' + escapeHtml(spec.label) + '</h3>' +
          '<p class="cxc-hint">' + escapeHtml(spec.help || '') + '</p></div>' +
          '<div class="cxc-spacer"></div>' +
          '<button type="button" class="cxc-btn" ' + cxAct('cxcAdd', entityKey) + '>' +
            icon('plus') + 'Add ' + escapeHtml(spec.singular.toLowerCase()) + '</button>' +
        '</div>' +
        (rows.length
          ? '<div class="cxc-scroll"><table class="cxc-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
          : '<div class="cxc-empty"><strong>No ' + escapeHtml(spec.label.toLowerCase()) + ' yet.</strong>' +
            'Add the first one to start building the plan.</div>') +
      '</div>';
  }

  function problemCard(problems) {
    return '<div class="cxc-card"><div class="cxc-card-head"><div>' +
      '<h3>Needs attention</h3><p class="cxc-hint">These will distort the schedule until they are fixed.</p>' +
      '</div></div><div class="cxc-problems">' +
      problems.map(function (p) {
        return '<div class="cxc-problem">' + icon('alert') +
          '<code>' + escapeHtml(p.id) + '</code><span>' + escapeHtml(p.message) + '</span></div>';
      }).join('') + '</div></div>';
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function coerce(entityKey, fieldKey, value) {
    var spec = CXCData.ENTITIES[entityKey];
    var f = (spec.fields || []).find(function (x) { return x.key === fieldKey; });
    if (!f) return value;
    if (f.type === 'number') {
      var n = parseFloat(value);
      return isFinite(n) ? n : 0;
    }
    if (f.type === 'checkbox') return !!value;
    return value;
  }

  function edit(entityKey, id, fieldKey, value) {
    CXCData.updateRow(CXCApp.data(), entityKey, id, fieldKey, coerce(entityKey, fieldKey, value));
    CXCApp.save();
  }

  function add(entityKey) {
    var row = CXCData.addRow(CXCApp.data(), entityKey);
    CXCApp.save();
    CXCApp.toast(CXCData.ENTITIES[entityKey].singular + ' ' + row.id + ' added');
  }

  function duplicate(entityKey, id) {
    var copy = CXCData.duplicateRow(CXCApp.data(), entityKey, id);
    CXCApp.save();
    if (copy) CXCApp.toast('Duplicated as ' + copy.id);
  }

  function del(entityKey, id) {
    var data = CXCApp.data();
    var spec = CXCData.ENTITIES[entityKey];
    var refs = CXCData.referencesTo(data, entityKey, id);
    var label = CXCData.labelFor(data, entityKey, id);

    var body = '<p class="cxc-hint">Delete <b>' + escapeHtml(label) + '</b>?</p>';
    if (refs.length) {
      body += '<p class="cxc-hint">It is still used by ' + refs.length + ' record' +
        (refs.length === 1 ? '' : 's') + ', which will be left pointing at nothing:</p>' +
        '<div class="cxc-problems">' + refs.slice(0, 8).map(function (r) {
          return '<div class="cxc-problem">' + icon('alert') + '<code>' + escapeHtml(r.id) + '</code>' +
            '<span>' + escapeHtml(r.label) + '</span></div>';
        }).join('') +
        (refs.length > 8 ? '<div class="cxc-problem">' + icon('alert') + '<span>…and ' + (refs.length - 8) + ' more</span></div>' : '') +
        '</div>';
    }

    CXCApp.openModal({
      title: 'Delete ' + spec.singular.toLowerCase(),
      body: body,
      saveLabel: 'Delete',
      onSave: function () {
        CXCData.removeRow(CXCApp.data(), entityKey, id);
        CXCApp.save();
        CXCApp.toast(label + ' deleted');
      }
    });
  }

  function toggleDow(entityKey, id, fieldKey, dayIndex) {
    var row = CXC.byId(CXCApp.data()[entityKey], id);
    if (!row) return;
    var days = (row[fieldKey] || []).slice();
    var i = days.indexOf(dayIndex);
    if (i === -1) days.push(dayIndex); else days.splice(i, 1);
    days.sort();
    row[fieldKey] = days;
    CXCApp.save();
  }

  // ── Multi-select picker ──────────────────────────────────────────────────
  function pickList(entityKey, id, fieldKey) {
    var data = CXCApp.data();
    var spec = CXCData.ENTITIES[entityKey];
    var field = spec.fields.find(function (f) { return f.key === fieldKey; });
    var row = CXC.byId(data[entityKey], id);
    if (!field || !row) return;

    var current = row[fieldKey] || [];
    var options = (data[field.ref] || []).filter(function (o) {
      return !(field.ref === entityKey && o.id === id);      // never depend on yourself
    });

    var body = '<p class="cxc-hint">' + escapeHtml(field.help || pickHint(entityKey, fieldKey)) + '</p>' +
      (options.length
        ? '<div class="cxc-checklist" id="cxc-pick">' + options.map(function (o) {
            return '<label><input type="checkbox" value="' + escapeHtml(o.id) + '"' +
              (current.indexOf(o.id) !== -1 ? ' checked' : '') + '>' +
              '<span>' + escapeHtml(CXCData.rowLabel(data, field.ref, o)) + '</span></label>';
          }).join('') + '</div>'
        : '<div class="cxc-empty">Nothing to choose from yet — add some ' +
          escapeHtml(CXCData.ENTITIES[field.ref].label.toLowerCase()) + ' first.</div>');

    CXCApp.openModal({
      title: field.label + ' · ' + CXCData.labelFor(data, entityKey, id),
      body: body,
      saveLabel: 'Apply',
      onSave: function () {
        var picked = Array.prototype.slice
          .call(document.querySelectorAll('#cxc-pick input:checked'))
          .map(function (el) { return el.value; });
        CXCData.updateRow(CXCApp.data(), entityKey, id, fieldKey, picked);
        CXCApp.save();
      }
    });
  }

  function pickHint(entityKey, fieldKey) {
    if (entityKey === 'crews' && fieldKey === 'skills') return 'Activities this crew is qualified for. Select none to mean "qualified for everything".';
    if (entityKey === 'crews' && fieldKey === 'vehicleIds') return 'Vehicles this crew needs. A vehicle serves one crew per window, so sharing one limits parallel work.';
    if (entityKey === 'crews' && fieldKey === 'shiftPatternIds') return 'Shift windows this crew may work. Select none to allow all of them.';
    if (entityKey === 'scope' && fieldKey === 'prereqIds') return 'This work cannot start until the selected scope items are fully complete.';
    return 'Select all that apply.';
  }

  // ── Material lines editor ────────────────────────────────────────────────
  function pickMaterials(activityId) {
    var data = CXCApp.data();
    var act = CXC.byId(data.activityTypes, activityId);
    if (!act) return;

    var body = '<p class="cxc-hint">Material consumed per <b>' + escapeHtml(act.unit || 'unit') +
      '</b> of ' + escapeHtml(act.name) + '. The plan cannot schedule this activity before every ' +
      'material below is on site, and will stop when a tracked stock runs out.</p>' +
      '<div id="cxc-matlines">' +
      (act.materials || []).map(function (line) { return matLineHtml(data, line); }).join('') +
      '</div>' +
      '<button type="button" class="cxc-btn cxc-secondary cxc-sm" ' + cxAct('cxcMatAdd') + '>' +
      icon('plus') + 'Add material</button>';

    CXCApp.openModal({
      title: 'Materials · ' + act.name,
      body: body,
      saveLabel: 'Apply',
      onSave: function () {
        var lines = Array.prototype.slice.call(document.querySelectorAll('#cxc-matlines .cxc-matline'))
          .map(function (el) {
            return {
              materialId: el.querySelector('select').value,
              qtyPerUnit: parseFloat(el.querySelector('input').value) || 0
            };
          })
          .filter(function (l) { return l.materialId; });
        CXCData.updateRow(CXCApp.data(), 'activityTypes', activityId, 'materials', lines);
        CXCApp.save();
      }
    });
  }

  function matLineHtml(data, line) {
    line = line || { materialId: '', qtyPerUnit: 1 };
    var opts = (data.materials || []).map(function (m) {
      return '<option value="' + escapeHtml(m.id) + '"' + (m.id === line.materialId ? ' selected' : '') + '>' +
        escapeHtml((m.code ? m.code + ' — ' : '') + m.name + ' (' + (m.unit || '') + ')') + '</option>';
    }).join('');
    return '<div class="cxc-matline">' +
      '<select class="cxc-inp" aria-label="Material"><option value="">— choose —</option>' + opts + '</select>' +
      '<input type="number" class="cxc-inp" step="0.1" min="0" aria-label="Quantity per unit" ' +
        'value="' + escapeHtml(line.qtyPerUnit) + '">' +
      '<button type="button" class="cxc-iconbtn cxc-danger" aria-label="Remove material line" ' +
        cxAct('cxcMatRemove') + '>' + icon('x') + '</button>' +
      '</div>';
  }

  function matAdd() {
    var host = document.getElementById('cxc-matlines');
    if (!host) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = matLineHtml(CXCApp.data(), null);
    host.appendChild(tmp.firstChild);
  }

  function matRemove(ctx) {
    var line = ctx && ctx.el && ctx.el.closest('.cxc-matline');
    if (line) line.remove();
  }

  // ── Assumptions view ─────────────────────────────────────────────────────
  function renderAssumptions(data) {
    var g = data.globals || {};
    var fields = CXCData.GLOBAL_FIELDS.map(function (f) {
      var input = f.type === 'checkbox'
        ? '<input type="checkbox" ' + (g[f.key] ? 'checked' : '') + ' ' +
          cxOn('change', 'cxcGlobal', f.key, '$cx.checked') + '>'
        : '<input type="number" class="cxc-inp" step="' + (f.step || 1) + '" value="' + escapeHtml(g[f.key]) + '" ' +
          cxOn('change', 'cxcGlobal', f.key, '$cx.value') + '>';
      return '<label class="cxc-field"><span>' + escapeHtml(f.label) + '</span>' + input +
        '<small>' + escapeHtml(f.help || '') + '</small></label>';
    }).join('');

    var blackout = (data.blackoutDates || []).slice().sort();

    return '' +
      '<div class="cxc-card">' +
        '<div class="cxc-card-head"><div><h3>Planning assumptions</h3>' +
        '<p class="cxc-hint">The dials that apply to every activity and every window. ' +
        'Change one and the whole forecast re-runs immediately.</p></div></div>' +
        '<div class="cxc-grid-fields">' + fields + '</div>' +
      '</div>' +

      '<div class="cxc-card">' +
        '<div class="cxc-card-head"><div><h3>Blackout dates</h3>' +
        '<p class="cxc-hint">Days with no track access at all — holidays, special events, embargoes. ' +
        'No window is generated on these dates.</p></div><div class="cxc-spacer"></div>' +
        '<label class="cxc-field"><span>Add a date</span>' +
        '<input type="date" class="cxc-inp" ' + cxOn('change', 'cxcAddBlackout', '$cx.value') + '></label>' +
        '</div>' +
        (blackout.length
          ? '<div class="cxc-tl-milelist">' + blackout.map(function (d) {
              return '<span class="cxc-tag cxc-mute">' + escapeHtml(d) +
                ' <button type="button" class="cxc-iconbtn" style="width:16px;height:16px" ' +
                'aria-label="Remove blackout ' + escapeHtml(d) + '" ' + cxAct('cxcDelBlackout', d) + '>' +
                icon('x') + '</button></span>';
            }).join('') + '</div>'
          : '<div class="cxc-empty">No blackout dates.</div>') +
      '</div>' +

      '<div class="cxc-card">' +
        '<div class="cxc-card-head"><div><h3>Your data</h3>' +
        '<p class="cxc-hint">Everything lives in this browser only. There is no server and no backup — ' +
        '<b>export after every working session</b> and keep the file. That export is also how you hand ' +
        'the plan to someone else, and how it will be loaded into the portal at merge time.</p></div></div>' +
        '<div class="cxc-controls">' +
          '<button type="button" class="cxc-btn cxc-secondary" ' + cxAct('cxcExport') + '>' + icon('download') + 'Export JSON</button>' +
          '<button type="button" class="cxc-btn cxc-secondary" ' + cxAct('cxcImport') + '>' + icon('upload') + 'Import JSON</button>' +
          '<button type="button" class="cxc-btn cxc-danger" ' + cxAct('cxcReset') + '>' + icon('refresh') + 'Reset to sample</button>' +
        '</div>' +
      '</div>';
  }

  function setGlobal(key, value) {
    var f = CXCData.GLOBAL_FIELDS.find(function (x) { return x.key === key; });
    var v = f && f.type === 'checkbox' ? !!value : (parseFloat(value) || 0);
    CXCApp.data().globals[key] = v;
    CXCApp.save();
  }

  function addBlackout(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    var list = CXCApp.data().blackoutDates;
    if (list.indexOf(date) === -1) list.push(date);
    CXCApp.save();
  }

  function delBlackout(date) {
    var d = CXCApp.data();
    d.blackoutDates = d.blackoutDates.filter(function (x) { return x !== date; });
    CXCApp.save();
  }

  // ── Register views + actions ─────────────────────────────────────────────
  function install() {
    CXCData.ENTITY_ORDER.forEach(function (key) {
      var spec = CXCData.ENTITIES[key];
      CXCApp.registerView(key, {
        title: spec.label,
        subtitle: spec.help,
        icon: spec.icon,
        group: key === 'scope' ? 'Plan' : 'Setup',
        count: function (data) { return (data[key] || []).length; },
        render: function (data) { return renderEntity(key, data); }
      });
    });

    CXCApp.registerView('assumptions', {
      title: 'Assumptions',
      subtitle: 'Global dials, blackout dates, and your import/export',
      icon: 'sliders',
      group: 'Setup',
      render: renderAssumptions
    });

    CXActions
      .register('cxcEdit', edit)
      .register('cxcAdd', add)
      .register('cxcDelete', del)
      .register('cxcDuplicate', duplicate)
      .register('cxcToggleDow', toggleDow)
      .register('cxcPickList', pickList)
      .register('cxcPickMaterials', pickMaterials)
      .register('cxcMatAdd', matAdd)
      .register('cxcMatRemove', function (ctx) { matRemove(ctx); })
      .register('cxcGlobal', setGlobal)
      .register('cxcAddBlackout', addBlackout)
      .register('cxcDelBlackout', delBlackout);
  }

  if (typeof window !== 'undefined') window.CXCManage = { install: install, renderEntity: renderEntity };
})();
