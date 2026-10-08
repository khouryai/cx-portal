// ==========================================
// HITACHI Rail T&C Portal — PostgREST query builder (cx-db.js)
//
// THE AZURE BUILD DOES NOT SHIP supabase-js. On Supabase the app keeps using
// supabase-js (it also carries Supabase's sign-in client). Off Supabase —
// Microsoft Entra or local passwords against a plain PostgREST — the only part
// of supabase-js the app used was its query builder, ~57 call sites of the
// form
//
//     const { data, error } = await _sb.from('profiles').select('*').eq('id', x).single();
//
// This file implements exactly that subset, with supabase-js's request shapes
// and result shapes, so those call sites run unchanged:
//
//   from(table) . select(cols?) . insert(rows) . update(patch) . upsert(rows, {onConflict})
//               . delete() . eq(col, v) . ilike(col, pattern) . order(col, {ascending})
//               . limit(n) . single()                → thenable of { data, error, status }
//
// tools/build.js drops supabase-js from any non-Supabase build, and app.js
// falls back to CXDb.client() when window.supabase is absent.
// tools/test_cx_db.js runs every call shape the app uses through both this and
// the real supabase-js against a real PostgREST and requires identical results.
//
// Requests carry CXIdentity's token, exactly like the app's own _db* helpers.
// ==========================================
(function () {
  'use strict';

  function cfg() { return (typeof window !== 'undefined' && window.CX_CONFIG) || {}; }
  function restBase() { return (typeof window !== 'undefined' && window.REST_BASE) || ''; }

  function headers(extra) {
    var h = { Accept: 'application/json' };
    var key = cfg().SUPABASE_ANON_KEY;
    if (key) h.apikey = key;
    var id = typeof window !== 'undefined' && window.CXIdentity;
    var auth = id && typeof id.authHeader === 'function' ? id.authHeader() : '';
    if (auth) h.Authorization = auth;
    for (var k in extra) h[k] = extra[k];
    return h;
  }

  function Query(table) {
    this.table = table;
    this.method = 'GET';
    this.params = [];          // [name, value] in call order
    this.body = undefined;
    this.prefer = [];
    this.returnRows = false;   // .select() after a write
    this.isSingle = false;
  }

  Query.prototype._param = function (k, v) { this.params.push([k, v]); return this; };

  // ── reads / projection ──
  Query.prototype.select = function (columns) {
    var cols = (columns === undefined ? '*' : String(columns)).replace(/\s+/g, '');
    if (this.method === 'GET') this._param('select', cols);
    else { this.returnRows = true; this._param('select', cols); }
    return this;
  };

  // ── writes ──
  // Arrays get a `columns` list (the union of keys), as supabase-js sends: a
  // row missing a key then stores NULL instead of failing the whole batch.
  function columnsOf(rows) {
    if (!Array.isArray(rows)) return null;
    var seen = {}, cols = [];
    rows.forEach(function (r) { Object.keys(r || {}).forEach(function (k) { if (!seen[k]) { seen[k] = 1; cols.push('"' + k + '"'); } }); });
    return cols.join(',');
  }
  Query.prototype.insert = function (rows) {
    this.method = 'POST'; this.body = rows;
    var c = columnsOf(rows); if (c) this._param('columns', c);
    return this;
  };
  Query.prototype.upsert = function (rows, opts) {
    this.method = 'POST'; this.body = rows;
    this.prefer.push('resolution=merge-duplicates');
    if (opts && opts.onConflict) this._param('on_conflict', opts.onConflict);
    var c = columnsOf(rows); if (c) this._param('columns', c);
    return this;
  };
  Query.prototype.update = function (patch) { this.method = 'PATCH'; this.body = patch; return this; };
  Query.prototype['delete'] = function () { this.method = 'DELETE'; return this; };

  // ── filters / modifiers ──
  Query.prototype.eq = function (col, v) { return this._param(col, 'eq.' + v); };
  Query.prototype.ilike = function (col, pattern) { return this._param(col, 'ilike.' + pattern); };
  Query.prototype.order = function (col, opts) {
    var dir = col + '.' + (opts && opts.ascending === false ? 'desc' : 'asc');
    for (var i = 0; i < this.params.length; i++) {
      if (this.params[i][0] === 'order') { this.params[i][1] += ',' + dir; return this; }
    }
    return this._param('order', dir);
  };
  Query.prototype.limit = function (n) { return this._param('limit', String(n)); };
  Query.prototype.single = function () { this.isSingle = true; return this; };

  // ── execution: a thenable, like supabase-js (never rejects) ──
  Query.prototype.then = function (onOk, onErr) { return this._run().then(onOk, onErr); };

  Query.prototype._run = function () {
    var self = this;
    var qs = this.params.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
    var url = restBase() + '/' + encodeURIComponent(this.table) + (qs ? '?' + qs : '');
    var prefer = this.prefer.slice();
    if (this.method !== 'GET') prefer.push(this.returnRows ? 'return=representation' : 'return=minimal');
    var extra = {};
    if (prefer.length) extra.Prefer = prefer.join(',');
    if (this.body !== undefined) extra['Content-Type'] = 'application/json';
    if (this.isSingle) extra.Accept = 'application/vnd.pgrst.object+json';
    var init = { method: this.method, headers: headers(extra) };
    if (this.body !== undefined) init.body = JSON.stringify(this.body);

    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var parsed = null;
        if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = text; } }
        if (!res.ok) {
          var err = (parsed && typeof parsed === 'object') ? parsed : { message: String(parsed || res.statusText) };
          return { data: null, error: err, status: res.status, statusText: res.statusText };
        }
        var data = parsed;
        if (self.method !== 'GET' && !self.returnRows) data = null;
        return { data: data, error: null, status: res.status, statusText: res.statusText };
      });
    }, function (e) {
      return { data: null, error: { message: (e && e.name ? e.name + ': ' : '') + (e && e.message), details: '', hint: '', code: '' }, status: 0 };
    });
  };

  function client() {
    return {
      from: function (table) { return new Query(table); },
      // Present so the shape matches; the identity providers never use it off Supabase.
      auth: null,
    };
  }

  var CXDb = { client: client };
  if (typeof window !== 'undefined') window.CXDb = CXDb;
  if (typeof module !== 'undefined' && module.exports) module.exports = CXDb;
})();
