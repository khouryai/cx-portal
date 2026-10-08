#!/usr/bin/env node
"use strict";
// ==========================================
// Package the portal into a clean, self-contained folder of static files.
//
//     node tools/build.js                          -> dist/  (uses ./config.js)
//     node tools/build.js --config my-env.js       -> dist/  (that environment)
//     node tools/build.js --out out/ --version cxp-1234abcd
//
// There is NO compile step. This copies the files the browser needs, and only
// those, then applies the three per-environment changes in one place:
//
//   1. config.js         replaced by --config (backend, identity, storage)
//   2. the CSP           in index.html: backend + storage hosts taken from that
//                        config, so the browser may reach them and nothing else
//   3. sw.js             cache version stamped, so every deploy reaches clients
//
// The same dist/ is what GitHub Pages deploys, what an Azure Static Web App
// deploys, and what gets zipped and handed over if a pipeline is not allowed.
// It contains no tests, SQL, infrastructure scripts or internal docs.
// Requires only Node.js — no npm install.
// ==========================================
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// What the browser needs. Everything else in the repo stays out.
const ROOT_EXTS = new Set([".html", ".js", ".css", ".webmanifest", ".json"]);
const ROOT_EXCLUDE = new Set(["sync_testplan.js", "config.local.js", "package.json", "package-lock.json"]);
const DIRS = ["vendor", "assets"];

function parseArgs(argv) {
  const a = { out: path.join(ROOT, "dist"), config: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--out") { a.out = path.resolve(v); i++; }
    else if (k === "--config") { a.config = path.resolve(v); i++; }
    else if (k === "--version") { a.version = v; i++; }
    else if (k === "-h" || k === "--help") { a.help = true; }
    else throw new Error("unknown argument: " + k);
  }
  return a;
}

/** Evaluate a config.js and return its window.CX_CONFIG. */
function readConfig(file) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  if (!sandbox.window.CX_CONFIG) throw new Error(file + " does not set window.CX_CONFIG");
  return sandbox.window.CX_CONFIG;
}

/** The data API address. Named SUPABASE_URL before the Azure move; both accepted. */
function apiUrl(c) { return c.API_URL || c.SUPABASE_URL || ""; }

function origin(u) {
  try { return new URL(u).origin; } catch (e) { return null; }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Point the CSP at the configured backend and storage, and nothing else.
 * Exported for tools/test_build.js.
 * @param {string} csp            the current policy
 * @param {object} committedCfg   CX_CONFIG of the repo's config.js (what the CSP names today)
 * @param {object} cfg            CX_CONFIG of the target environment
 * @returns {string}
 */
function rewriteCsp(csp, committedCfg, cfg) {
  const oldApi = origin(apiUrl(committedCfg));
  const newApi = origin(apiUrl(cfg));
  if (!newApi) throw new Error("config: API_URL (the data API address) is not a valid URL");

  const dirs = csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const parts = d.split(/\s+/);
    return { name: parts[0], sources: parts.slice(1) };
  });
  const get = (name) => dirs.find((d) => d.name === name);
  const add = (name, src) => { const d = get(name); if (d && src && !d.sources.includes(src)) d.sources.push(src); };

  // Swap the committed API origin (and its websocket twin) for the target's.
  if (oldApi && oldApi !== newApi) {
    const swaps = { [oldApi]: newApi, [oldApi.replace(/^https:/, "wss:")]: newApi.replace(/^https:/, "wss:") };
    for (const d of dirs) d.sources = d.sources.map((s) => swaps[s] || s);
  }
  add("connect-src", newApi);

  if (cfg.STORAGE === "azure") {
    const blob = origin(cfg.BLOB_ORIGIN);
    if (!blob) throw new Error("config: STORAGE is 'azure' but BLOB_ORIGIN is missing — " +
      "set it to https://<account>.blob.core.windows.net so the browser may load files");
    // Files are signed with the user's own Microsoft sign-in (cx-storage.js).
    if (cfg.IDENTITY !== "entra") throw new Error("config: STORAGE 'azure' needs IDENTITY 'entra'");
    add("connect-src", blob);
    add("img-src", blob);
    add("media-src", blob);
  }
  if (cfg.IDENTITY === "entra") {
    const authority = origin(cfg.ENTRA_AUTHORITY || "https://login.microsoftonline.com");
    add("connect-src", authority);
    add("frame-src", authority);
  }
  return dirs.map((d) => [d.name, ...d.sources].join(" ")).join("; ");
}

/** Local files index.html and sw.js expect to exist. */
function referencedFiles(html, sw) {
  const out = new Set();
  const re = /\b(?:src|href)="([^"#?]+)[^"]*"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/^(https?:|data:|blob:|mailto:|javascript:|\/\/)/i.test(u)) continue;
    out.add(u.replace(/^\.\//, ""));
  }
  const shell = sw.match(/SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/);
  if (shell) for (const s of shell[1].match(/'([^']+)'/g) || []) {
    const u = s.slice(1, -1).replace(/^\.\//, "");
    if (u) out.add(u);
  }
  return [...out];
}

function build(opts) {
  const out = opts.out;
  if (path.resolve(out) === ROOT) throw new Error("refusing to build into the repo root");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // 1. Files.
  for (const f of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, f);
    if (!fs.statSync(p).isFile()) continue;
    if (ROOT_EXCLUDE.has(f) || f.startsWith(".") || !ROOT_EXTS.has(path.extname(f))) continue;
    fs.copyFileSync(p, path.join(out, f));
  }
  for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) copyDir(path.join(ROOT, d), path.join(out, d));

  // 2. config.js for this environment.
  const committedCfg = readConfig(path.join(ROOT, "config.js"));
  let cfg = committedCfg;
  if (opts.config) {
    cfg = readConfig(opts.config);
    fs.copyFileSync(opts.config, path.join(out, "config.js"));
  }

  // 3. CSP.
  const htmlPath = path.join(out, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  const cspRe = /(<meta http-equiv="Content-Security-Policy" content=")([^"]+)(")/;
  const m = html.match(cspRe);
  if (!m) throw new Error("index.html has no Content-Security-Policy meta tag");
  html = html.replace(cspRe, (_, a, csp, c) => a + rewriteCsp(csp, committedCfg, cfg) + c);
  fs.writeFileSync(htmlPath, html);

  // 4. Service worker cache version.
  let version = opts.version;
  if (!version) {
    try { version = "cxp-" + execSync("git rev-parse --short=8 HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
    catch (e) { version = "cxp-" + Date.now().toString(16); }
  }
  if (!/^cxp-[0-9A-Fa-f]+$/.test(version)) throw new Error("--version must look like cxp-<hex>");
  const swPath = path.join(out, "sw.js");
  const sw = fs.readFileSync(swPath, "utf8").replace(/cxp-v?[0-9A-Fa-f]+/g, version);
  fs.writeFileSync(swPath, sw);

  // 5. Nothing the page loads may be missing.
  const missing = referencedFiles(html, sw).filter((f) => f && !fs.existsSync(path.join(out, f)));
  if (missing.length) throw new Error("built site is missing files it references: " + missing.join(", "));

  let files = 0, bytes = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; }
    }
  })(out);
  return { out, files, bytes, version, cfg };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 23).join("\n").replace(/^\/\/ ?/gm, ""));
      process.exit(0);
    }
    const r = build(opts);
    console.log(`built ${path.relative(process.cwd(), r.out) || r.out}/  ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB`);
    console.log(`  data API : ${apiUrl(r.cfg)}`);
    console.log(`  sign-in  : ${r.cfg.IDENTITY || "supabase"}`);
    console.log(`  storage  : ${r.cfg.STORAGE || "supabase"}`);
    console.log(`  version  : ${r.version}`);
  } catch (e) {
    console.error("build failed: " + e.message);
    process.exit(1);
  }
}

module.exports = { build, rewriteCsp, readConfig, referencedFiles };
