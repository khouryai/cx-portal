"use strict";
// Build packaging guard (tools/build.js).
//
// dist/ is the one artifact every environment deploys — GitHub Pages, an Azure
// Static Web App, or a zip handed to IT. This pins that it holds what the page
// needs and nothing internal, and that the per-environment rewrites are right.
//   Run: node tools/test_build.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build, rewriteCsp } = require("./build.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

console.log("=== build packaging (dist/) ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxbuild-"));
try {
  // ── Default build: the repo's own config ──
  const r = build({ out: path.join(tmp, "site"), version: "cxp-abc123" });
  const has = (p) => fs.existsSync(path.join(r.out, p));
  ok("index.html, app.js, sw.js and config.js are in the build",
    ["index.html", "app.js", "sw.js", "config.js", "cx-storage.js", "manifest.webmanifest"].every(has));
  ok("vendor/ and assets/ are in the build", has("vendor/js/pdf.min.js") && has("assets"));
  const internal = ["tools", "supabase", "azure", "infra", "docs", ".github", ".claude",
    "README.md", "SECURITY.md", "MIGRATION.md", "CLAUDE.md", "sync_testplan.js", ".mcp.json", ".gitignore"];
  const leaked = internal.filter(has);
  ok("nothing internal ships (tests, SQL, infra, docs, dotfiles)", leaked.length === 0, leaked.join(", "));
  ok("no markdown file ships", !fs.readdirSync(r.out).some((f) => f.endsWith(".md")));
  ok("the service worker cache version is stamped",
    /const CACHE_VERSION = 'cxp-abc123'/.test(fs.readFileSync(path.join(r.out, "sw.js"), "utf8")));
  ok("the repo itself is untouched by a build",
    !/cxp-abc123/.test(fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8")));

  // ── Environment build: a different config replaces config.js ──
  const cfgFile = path.join(tmp, "env.config.js");
  fs.writeFileSync(cfgFile, "window.CX_CONFIG = { API_URL: 'https://api.example.test', REST_PATH: '' };\n");
  const r2 = build({ out: path.join(tmp, "site2"), config: cfgFile, version: "cxp-1" });
  ok("--config replaces config.js verbatim",
    fs.readFileSync(path.join(r2.out, "config.js"), "utf8") === fs.readFileSync(cfgFile, "utf8"));
  const html2 = fs.readFileSync(path.join(r2.out, "index.html"), "utf8");
  ok("the environment's API origin is allowed by the CSP", html2.includes("connect-src") && html2.includes("https://api.example.test"));
  ok("the old Supabase origin is gone from that environment's CSP", !/supabase\.co/.test(html2.match(/Content-Security-Policy" content="([^"]+)"/)[1]));

  ok("a Supabase build keeps supabase-js", has("vendor/js/supabase.js") &&
    fs.readFileSync(path.join(r.out, "index.html"), "utf8").includes('<script src="vendor/js/supabase.js">'));

  // ── Azure build: Microsoft sign-in, so no supabase-js at all ──
  const azCfg = path.join(tmp, "azure.config.js");
  fs.writeFileSync(azCfg, "window.CX_CONFIG = { API_URL: 'https://api.az.test', REST_PATH: '', IDENTITY: 'entra',\n" +
    "  ENTRA_CLIENT_ID: 'x', ENTRA_TENANT_ID: 'y', STORAGE: 'azure', BLOB_ORIGIN: 'https://acct.blob.core.windows.net' };\n");
  const r3 = build({ out: path.join(tmp, "site3"), config: azCfg, version: "cxp-2" });
  const html3 = fs.readFileSync(path.join(r3.out, "index.html"), "utf8");
  const sw3 = fs.readFileSync(path.join(r3.out, "sw.js"), "utf8");
  ok("azure: supabase-js is not in the page", !/supabase\.js/.test(html3));
  ok("azure: supabase-js files are not in the build",
    !fs.existsSync(path.join(r3.out, "vendor/js/supabase.js")) && !fs.existsSync(path.join(r3.out, "vendor/js/591.supabase.js")));
  ok("azure: the service worker does not try to cache them", !/supabase\.js/.test(sw3));
  ok("azure: the service worker still parses", !throws(() => new (require("vm").Script)(sw3)));
  ok("azure: cx-db.js is loaded before app.js",
    html3.includes('<script src="cx-db.js">') && html3.indexOf("cx-db.js") < html3.indexOf('<script src="app.js'));

  ok("building into the repo root is refused", !!throws(() => build({ out: path.join(__dirname, "..") })));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── CSP rewrite rules ──
const base = "default-src 'self'; img-src 'self' https://old.supabase.co; media-src 'self'; " +
  "frame-src 'self'; connect-src 'self' https://old.supabase.co wss://old.supabase.co";
const committed = { SUPABASE_URL: "https://old.supabase.co" };
const az = rewriteCsp(base, committed, {
  API_URL: "https://api.az.test", STORAGE: "azure", IDENTITY: "entra",
  BLOB_ORIGIN: "https://acct.blob.core.windows.net",
});
const dir = (csp, n) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(n + " ")) || "");
ok("azure: the blob host is allowed to connect", dir(az, "connect-src").includes("https://acct.blob.core.windows.net"));
ok("azure: the old Supabase origin is gone", !/old\.supabase\.co/.test(az));
ok("azure: photos may load from the blob host", dir(az, "img-src").includes("https://acct.blob.core.windows.net"));
ok("azure: default-src is left alone", dir(az, "default-src") === "default-src 'self'");
ok("azure storage without BLOB_ORIGIN fails the build",
  !!throws(() => rewriteCsp(base, committed, { API_URL: "https://a.test", STORAGE: "azure", IDENTITY: "entra" })));
ok("azure storage without Entra sign-in fails the build",
  !!throws(() => rewriteCsp(base, committed, { API_URL: "https://a.test", STORAGE: "azure", BLOB_ORIGIN: "https://acct.blob.core.windows.net" })));
ok("a config with no valid API URL fails the build", !!throws(() => rewriteCsp(base, committed, { API_URL: "" })));
const same = rewriteCsp(base, committed, committed);
ok("building with the committed config leaves the API origins as they were",
  dir(same, "connect-src") === "connect-src 'self' https://old.supabase.co wss://old.supabase.co");

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
