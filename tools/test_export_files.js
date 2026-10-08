"use strict";
// tools/export_supabase_files.js against a fake Supabase Storage API:
// nested folders, paging, a missing bucket, and the folder layout IT uploads.
//   Run: node tools/test_export_files.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { exportFiles } = require("./export_supabase_files.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
console.log("=== Supabase file export ===\n");

// bucket -> { "a/b.pdf": "bytes" }
const STORE = {
  photos: Object.fromEntries(Array.from({ length: 1205 }, (_, i) => [`2026/10/p${String(i).padStart(4, "0")}.jpg`, "img" + i])),
  drawings: { "set-1/rev A.pdf": "PDF-A", "set-1/rev B.pdf": "PDF-B" },
  forms: { "f1.pdf": "F1", "state/f1.json": "{}" },
};
const seenAuth = new Set();

const srv = http.createServer((req, res) => {
  seenAuth.add(req.headers.authorization);
  const u = decodeURIComponent(req.url);
  let m = u.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
  if (m && req.method === "POST") {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const store = STORE[m[1]];
      if (!store) { res.writeHead(400); return res.end('{"error":"Bucket not found"}'); }
      const { prefix, limit, offset } = JSON.parse(body);
      const pre = prefix ? prefix + "/" : "";
      const names = new Map();
      for (const p of Object.keys(store).sort()) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length), slash = rest.indexOf("/");
        if (slash === -1) names.set(rest, { name: rest, id: "id-" + p, metadata: { size: store[p].length } });
        else names.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, metadata: null });
      }
      const all = [...names.values()];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(all.slice(offset, offset + limit)));
    });
    return;
  }
  m = u.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (m && STORE[m[1]] && STORE[m[1]][m[2]] !== undefined) { res.writeHead(200); return res.end(STORE[m[1]][m[2]]); }
  res.writeHead(404); res.end();
});

srv.listen(0, "127.0.0.1", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cxexport-"));
  try {
    const s = await exportFiles({ base: `http://127.0.0.1:${srv.address().port}/`, key: "service-key", out, log: () => {} });
    ok("every file in every bucket is exported", s.photos.files === 1205 && s.drawings.files === 2 && s.forms.files === 2);
    ok("buckets that do not exist are skipped, not fatal", s.documents.files === 0 && s["vehicle-files"].files === 0);
    ok("listing pages past 1000 entries", fs.readdirSync(path.join(out, "photos/2026/10")).length === 1205);
    ok("nested folders and spaces keep their exact paths",
      fs.readFileSync(path.join(out, "drawings/set-1/rev B.pdf"), "utf8") === "PDF-B" &&
      fs.readFileSync(path.join(out, "forms/state/f1.json"), "utf8") === "{}");
    ok("uses the service role key", seenAuth.size === 1 && seenAuth.has("Bearer service-key"));
  } catch (e) {
    ok("export runs", false, e.message);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    srv.close();
  }
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
});
