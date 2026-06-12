// Dev tool: full-page screenshot of the UI gallery (or any served path) for
// visual QA of styles.css changes without signing in.
//
//   npx http-server -p 8123 .        # serve the repo root
//   node tools/shot_gallery.js /tmp/gallery.png
//   node tools/shot_gallery.js /tmp/login.png /index.html
//
// Needs playwright (global install works: require resolves via NODE_PATH or
// the absolute path fallback below).
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

(async () => {
  const out = process.argv[2] || '/tmp/gallery.png';
  const path = process.argv[3] || '/tools/ui_gallery.html';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8123' + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600); // let webfonts settle
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log('saved', out);
})();
