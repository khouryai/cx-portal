#!/usr/bin/env node
// The backend seam: config.js holds VALUES, cx-config.js derives from them.
//
// This exists because the split was violated in the other direction and cost a
// day. window.REST_BASE was defined in config.js; azure/deploy-frontend.sh
// generates a config.js holding only window.CX_CONFIG; so on Azure REST_BASE
// did not exist, every data call threw ReferenceError before it built a URL,
// and _checkDbStatus() reported "SYSTEM OFFLINE" against a healthy API.
//
// The load-bearing test is the last one: it runs the config that the deploy
// script actually generates, rather than one written here to look like it.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); fail++; }
}

/** Run a config source plus cx-config.js in a bare window and return it. */
function derive(configSource) {
  const window = {};
  const ctx = vm.createContext({ window, console });
  ctx.globalThis = ctx;
  vm.runInContext(configSource, ctx, { filename: 'config.js' });
  vm.runInContext(read('cx-config.js'), ctx, { filename: 'cx-config.js' });
  return window;
}

console.log('=== backend config seam ===\n');

// ── 1. config.js must stay data-only ──────────────────────────────────────
// Any window.* assignment other than CX_CONFIG is logic that the next
// environment's generated config.js will silently delete.
const configSrc = read('config.js');
const assigned = (configSrc.match(/^\s*window\.([A-Za-z0-9_$]+)\s*=/gm) || [])
  .map((m) => m.replace(/^\s*window\./, '').replace(/\s*=$/, '').trim());
ok('config.js assigns only window.CX_CONFIG',
  assigned.length === 1 && assigned[0] === 'CX_CONFIG',
  'also assigns: ' + assigned.filter((a) => a !== 'CX_CONFIG').join(', '));

// ── 2. every bare config global app code reads is defined by cx-config.js ──
const DERIVED = ['REST_BASE', 'API_KEY_HEADER'];
const derivedSrc = read('cx-config.js');
DERIVED.forEach((name) => {
  ok('cx-config.js defines window.' + name,
    new RegExp('window\\.' + name + '\\s*=').test(derivedSrc));
});

// Consumers read these as BARE globals, so a file that uses one without
// cx-config.js having defined it is a ReferenceError at runtime, not a 404.
const CONSUMERS = ['app.js', 'photos.js', 'readiness.js'];
CONSUMERS.forEach((f) => {
  const src = read(f);
  DERIVED.forEach((name) => {
    if (!new RegExp('\\b' + name + '\\b').test(src)) return;
    ok(f + ' reads ' + name + ', and cx-config.js supplies it',
      new RegExp('window\\.' + name + '\\s*=').test(derivedSrc));
  });
});

// ── 3. the Supabase shape ─────────────────────────────────────────────────
const supa = derive(configSrc);
ok('supabase: REST_BASE keeps the /rest/v1 gateway prefix',
  /\/rest\/v1$/.test(supa.REST_BASE), 'got ' + supa.REST_BASE);
ok('supabase: the apikey header is present',
  !!(supa.API_KEY_HEADER && supa.API_KEY_HEADER.apikey));

// ── 4. THE ONE THAT MATTERS — the config the deploy script really writes ──
// Extract the heredoc body from azure/deploy-frontend.sh instead of retyping
// it, so drift in the script fails here rather than in production.
const deploy = read('azure/deploy-frontend.sh');
const m = deploy.match(/cat > "\$STAGE\/config\.js" <<CFG\n([\s\S]*?)\nCFG\n/);
ok('azure/deploy-frontend.sh still generates config.js from a heredoc', !!m);

if (m) {
  // Substitute the shell variables with representative values.
  const generated = m[1]
    .replace(/\$TENANT/g, 'e62c5154-d15d-4c22-a489-aa656aff64a4')
    .replace(/\$APPID/g, 'a1301867-e12c-43c7-85e2-80cc5bd9d325')
    .replace(/\$HOST/g, 'example.azurestaticapps.net')
    .replace(/\$API/g, 'ca-postgrest-dev.example.azurecontainerapps.io');
  ok('the generated config has no unsubstituted shell variables',
    !/\$[A-Z_]+/.test(generated));

  const azure = derive(generated);
  ok('azure: REST_BASE is defined at all',
    typeof azure.REST_BASE === 'string' && azure.REST_BASE.length > 0,
    'this is the exact failure that read as SYSTEM OFFLINE');
  ok('azure: REST_BASE has NO /rest/v1 prefix (bare PostgREST serves at root)',
    azure.REST_BASE === 'https://ca-postgrest-dev.example.azurecontainerapps.io',
    'got ' + azure.REST_BASE);
  ok('azure: API_KEY_HEADER is defined',
    !!azure.API_KEY_HEADER && typeof azure.API_KEY_HEADER === 'object');
  ok('azure: the apikey header is ABSENT, not empty',
    !('apikey' in azure.API_KEY_HEADER),
    'keys: ' + JSON.stringify(Object.keys(azure.API_KEY_HEADER)));
  ok('azure: the identity provider is entra',
    azure.CX_CONFIG && azure.CX_CONFIG.IDENTITY === 'entra');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
