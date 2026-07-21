"use strict";
// JSDoc type-check (Tier 3 Stage D). Runs `tsc --checkJs --noEmit` over the
// typed modules in tools/tsconfig.check.json — no build, no emit, just type
// safety for the extracted core. Skipped automatically when typescript is not
// installed (run_tests.js gates this suite on needs:["typescript"]; CI installs
// it transiently, like dayjs). Modules join tsconfig.check.json as they are
// JSDoc-typed; eventually app.js in slices.
// Run: node tools/test_types.js   (needs: npm install --no-save typescript)
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let tsc;
try { tsc = require.resolve("typescript/bin/tsc", { paths: [ROOT] }); }
catch (e) {
  console.log("SKIPPED: typescript not installed (npm install --no-save typescript)");
  console.log("\n0 passed, 0 failed.");
  process.exit(0);
}

console.log("=== JSDoc type-check — tsc --checkJs (Tier 3 Stage D) ===\n");
try {
  execFileSync(
    process.execPath,
    [tsc, "-p", path.join(__dirname, "tsconfig.check.json"), "--noEmit", "--pretty", "false"],
    { stdio: "inherit" }
  );
  console.log("  ✓ tsc --checkJs is clean");
  console.log("\n1 passed, 0 failed.");
  process.exit(0);
} catch (e) {
  console.log("  ✗ tsc reported type error(s) above");
  console.log("\n0 passed, 1 failed.");
  process.exit(1);
}
