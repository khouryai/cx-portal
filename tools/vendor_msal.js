#!/usr/bin/env node
"use strict";
// Vendor @azure/msal-browser — the Entra ID sign-in library.
//
// Unlike xlsx (see vendor_xlsx.js), MSAL IS on the npm registry, so this needs
// no CDN and works from behind corporate egress. It is a script rather than a
// build step because this repo has no build step: `npm pack`, take the one UMD
// file, drop it in vendor/js/, record the hash.
//
//     node tools/vendor_msal.js            # refresh at the pinned version
//     node tools/vendor_msal.js 5.22.0     # move to a new version
//
// The UMD bundle defines a global `msal`. cx-auth-provider.js loads it lazily —
// only when CX_CONFIG.IDENTITY === 'entra' — so a Supabase-backed deployment
// never pays the ~275 KB.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const os = require("os");

const VERSION = process.argv[2] || require("./msal_version.json").version;
const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "vendor/js/msal-browser.min.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msal-"));
console.log("npm pack @azure/msal-browser@" + VERSION + " …");
execFileSync("npm", ["pack", "@azure/msal-browser@" + VERSION], { cwd: tmp, stdio: "inherit" });
execFileSync("tar", ["-xzf", "azure-msal-browser-" + VERSION + ".tgz"], { cwd: tmp });

const src = path.join(tmp, "package/lib/msal-browser.min.js");
const buf = fs.readFileSync(src);
const sha = crypto.createHash("sha384").update(buf).digest("base64");

// A UMD bundle or nothing: the app loads this with a plain <script> tag.
if (!/typeof exports|typeof define/.test(buf.slice(0, 400).toString())) {
  console.error("Not a UMD bundle — refusing to install.");
  process.exit(1);
}

fs.writeFileSync(DEST, buf);
fs.writeFileSync(path.join(__dirname, "msal_version.json"),
  JSON.stringify({ version: VERSION, sha384: sha, bytes: buf.length }, null, 2) + "\n");
console.log("wrote   : vendor/js/msal-browser.min.js (" + buf.length + " bytes)");
console.log("sha384  : " + sha);
console.log("recorded: tools/msal_version.json");
