#!/usr/bin/env node
"use strict";
// Vendor the last external CDN dependency — see MIGRATION.md §4.1.
//
// xlsx 0.20.3 is the ONE script the app still loads from a third-party origin
// (cdn.sheetjs.com). SheetJS stopped publishing to the npm registry at 0.18.x,
// so it cannot simply be npm-installed, and MIGRATION.md is explicit that
// downgrading is not the answer.
//
// This fetches that exact file, verifies it against the SHA-384 integrity hash
// already pinned in index.html — so a substituted file is rejected, which is
// the whole point of vendoring it for a Confidential-classified system — and
// installs it, rewriting the script tag and removing the CDN from the CSP.
//
// RUN IT FROM A NETWORK THAT CAN REACH cdn.sheetjs.com, or hand it a local copy
// obtained from an approved artifact store:
//     node tools/vendor_xlsx.js
//     node tools/vendor_xlsx.js --from /path/to/xlsx.full.min.js
//
// The hash is NOT a parameter: it is read from index.html, so this can only
// ever install the exact build the app was already pinned to.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const DEST_REL = "vendor/js/xlsx.full.min.js";
const DEST = path.join(ROOT, DEST_REL);

const html = fs.readFileSync(INDEX, "utf8");
const tag = html.match(
  /<script src="(https:\/\/cdn\.sheetjs\.com\/[^"]+)"\s*\r?\n?\s*integrity="sha384-([^"]+)"\s*\r?\n?\s*crossorigin="anonymous"><\/script>/
);
if (!tag) {
  if (html.includes(DEST_REL)) {
    console.log("Already vendored — index.html points at " + DEST_REL + ". Nothing to do.");
    process.exit(0);
  }
  console.error("Could not find the pinned cdn.sheetjs.com script tag in index.html.");
  process.exit(1);
}
const [, url, expectedB64] = tag;
console.log("source : " + url);
console.log("sha384 : " + expectedB64 + "  (pinned in index.html)");

function fromFile(p) {
  return Promise.resolve(fs.readFileSync(p));
}
function fromNetwork(u) {
  return new Promise((resolve, reject) => {
    https.get(u, (res) => {
      if (res.statusCode !== 200) { reject(new Error("HTTP " + res.statusCode)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

const fromArg = process.argv.indexOf("--from");
const source = fromArg !== -1 ? fromFile(process.argv[fromArg + 1]) : fromNetwork(url);

source.then((buf) => {
  const actual = crypto.createHash("sha384").update(buf).digest("base64");
  if (actual !== expectedB64) {
    console.error("\nINTEGRITY MISMATCH — refusing to install.");
    console.error("  expected sha384-" + expectedB64);
    console.error("  actual   sha384-" + actual);
    console.error("\nThis is the check working: the bytes are not the build this app was pinned to.");
    process.exit(1);
  }
  console.log("verified: " + buf.length + " bytes match the pinned hash\n");

  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, buf);
  console.log("wrote   : " + DEST_REL);

  // Rewrite the script tag. Same-origin files in this repo carry no SRI (see
  // the comment above the vendor block in index.html) — the file is in the
  // repo and reviewed like any other source.
  let out = html.replace(tag[0], '<script src="' + DEST_REL + '"></script>');
  out = out.replace(
    /<!-- xlsx 0\.20\.3 is distributed only via cdn\.sheetjs\.com[\s\S]*?-->/,
    "<!-- xlsx 0.20.3 — vendored by tools/vendor_xlsx.js and verified against the\n" +
    "     SHA-384 it was previously pinned to. SheetJS does not publish 0.20.x to\n" +
    "     the npm registry; re-run that tool to refresh it. -->"
  );
  // Drop the CDN from the Content-Security-Policy: nothing loads from it now.
  out = out.replace(" https://cdn.sheetjs.com", "");
  fs.writeFileSync(INDEX, out);
  console.log("updated : index.html (script tag + CSP)");

  // Keep the PWA shell in step or the file will not be cached offline.
  const swPath = path.join(ROOT, "sw.js");
  let sw = fs.readFileSync(swPath, "utf8");
  if (!sw.includes(DEST_REL)) {
    sw = sw.replace("  './cx-storage.js',\n", "  './cx-storage.js',\n  './" + DEST_REL + "',\n");
    fs.writeFileSync(swPath, sw);
    console.log("updated : sw.js (added to SHELL_ASSETS)");
  }

  console.log("\nDone. Run `node tools/run_tests.js` — test_csp.js will now assert the CDN is gone.");
}).catch((e) => {
  console.error("\nCould not obtain the file: " + e.message);
  console.error("\nIf this network blocks cdn.sheetjs.com (corporate egress usually does),");
  console.error("fetch xlsx-0.20.3/package/dist/xlsx.full.min.js from an approved artifact");
  console.error("store and re-run with:  node tools/vendor_xlsx.js --from <path>");
  console.error("The SHA-384 check above will confirm you got the right build.");
  process.exit(1);
});
