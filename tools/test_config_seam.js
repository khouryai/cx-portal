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
// The generator is EXECUTED, not pattern-matched: a heredoc that stops
// producing REST_PATH, or a shell variable that stops being substituted, has to
// fail here rather than on the deployed site. Both identity modes are built,
// because the script branches on IDENTITY and only one of them is ever the one
// you are looking at when something breaks.
const { execFileSync } = require('child_process');
const os = require('os');

const deploy = read('azure/deploy-frontend.sh');
const gen = deploy.match(/\{\ncat <<CFG\n[\s\S]*?\n\} > "\$STAGE\/config\.js"/);
ok('the config generator is still a self-contained block in deploy-frontend.sh', !!gen);

function generate(identity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxcfg-'));
  const script = [
    'set -eu',
    `STAGE=${JSON.stringify(dir)}`,
    `IDENTITY=${JSON.stringify(identity)}`,
    'TENANT=e62c5154-d15d-4c22-a489-aa656aff64a4',
    'APPID=a1301867-e12c-43c7-85e2-80cc5bd9d325',
    'HOST=example.azurestaticapps.net',
    'API=ca-postgrest-dev.example.azurecontainerapps.io',
    gen[0],
  ].join('\n');
  const file = path.join(dir, 'gen.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', [file], { stdio: 'pipe' });
  return fs.readFileSync(path.join(dir, 'config.js'), 'utf8');
}

if (gen) {
  for (const identity of ['postgrest', 'entra']) {
    const src = generate(identity);
    ok(`${identity}: the generated config has no unsubstituted shell variables`,
      !/\$[A-Z_]+/.test(src), (src.match(/\$[A-Z_]+/) || [])[0]);
    ok(`${identity}: it assigns ONLY window.CX_CONFIG`,
      (src.match(/^\s*window\.([A-Za-z0-9_$]+)\s*=/gm) || []).length === 1);

    const w = derive(src);
    ok(`${identity}: REST_BASE is defined at all`,
      typeof w.REST_BASE === 'string' && w.REST_BASE.length > 0,
      'this is the exact failure that read as SYSTEM OFFLINE');
    ok(`${identity}: REST_BASE has NO /rest/v1 prefix (bare PostgREST serves at root)`,
      w.REST_BASE === 'https://ca-postgrest-dev.example.azurecontainerapps.io', w.REST_BASE);
    ok(`${identity}: the apikey header is ABSENT, not empty`,
      !!w.API_KEY_HEADER && !('apikey' in w.API_KEY_HEADER));
    ok(`${identity}: IDENTITY is set to it`, w.CX_CONFIG.IDENTITY === identity, w.CX_CONFIG.IDENTITY);
  }

  // Entra needs its app-registration values; a password build must not carry
  // them, or a stale client id outlives the decision to stop using Entra.
  const entra = derive(generate('entra')).CX_CONFIG;
  const local = derive(generate('postgrest')).CX_CONFIG;
  ok('entra: the app registration values are present',
    !!entra.ENTRA_TENANT_ID && !!entra.ENTRA_CLIENT_ID && !!entra.ENTRA_REDIRECT_URI);
  ok('postgrest: no Entra values are emitted',
    !local.ENTRA_TENANT_ID && !local.ENTRA_CLIENT_ID);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
