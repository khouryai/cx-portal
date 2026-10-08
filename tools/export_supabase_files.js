#!/usr/bin/env node
"use strict";
// ==========================================
// Download every stored file (photos, forms, drawings, documents, vehicle
// files) out of Supabase into a local folder — as a backup, and as the hand-off
// IT uploads into Azure Blob Storage (docs/AZURE_HOSTING.md, step 5).
//
//   SUPABASE_URL=https://<project>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
//   node tools/export_supabase_files.js [out-folder]      (default: cxportal-files)
//
// The service role key is in the Supabase dashboard: Project Settings → API.
// It can read everything, so paste it into the command only, never into a file.
//
// The folder layout is <bucket>/<path>, exactly the paths the database rows
// refer to, so `az storage blob upload-batch` per bucket puts every file back
// where the app expects it. Requires only Node.js 18+.
// ==========================================
const fs = require("fs");
const path = require("path");

const BUCKETS = ["photos", "forms", "drawings", "documents", "vehicle-files"];

function headers(key, extra) {
  return Object.assign({ apikey: key, Authorization: "Bearer " + key }, extra || {});
}

async function listAll(base, key, bucket, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: headers(key, { "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (res.status === 400 || res.status === 404) return out;   // bucket does not exist
    if (!res.ok) throw new Error(`list ${bucket}/${prefix}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    for (const item of page) {
      const full = prefix ? prefix + "/" + item.name : item.name;
      // Supabase lists folders as entries with no id.
      if (item.id === null || item.id === undefined) out.push(...await listAll(base, key, bucket, full));
      else out.push({ path: full, size: (item.metadata && item.metadata.size) || 0 });
    }
    if (page.length < 1000) return out;
  }
}

function safeJoin(root, rel) {
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error("unsafe path: " + rel);
  return path.join(root, ...rel.split("/"));
}

async function exportFiles({ base, key, out, log = console.log }) {
  base = base.replace(/\/+$/, "");
  const summary = {};
  for (const bucket of BUCKETS) {
    const files = await listAll(base, key, bucket, "");
    let bytes = 0;
    for (const f of files) {
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${f.path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: headers(key) });
      if (!res.ok) throw new Error(`download ${bucket}/${f.path}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = safeJoin(path.join(out, bucket), f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      bytes += buf.length;
    }
    summary[bucket] = { files: files.length, bytes };
    log(`  ${bucket.padEnd(14)} ${String(files.length).padStart(5)} files  ${(bytes / 1048576).toFixed(1)} MB`);
  }
  return summary;
}

if (require.main === module) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const out = path.resolve(process.argv[2] || "cxportal-files");
  if (!base || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the top of this file).");
    process.exit(1);
  }
  console.log("exporting to " + out);
  exportFiles({ base, key, out })
    .then((s) => {
      const total = Object.values(s).reduce((a, b) => a + b.files, 0);
      console.log(`done: ${total} files. Hand this folder to IT (docs/AZURE_HOSTING.md, step 5).`);
    })
    .catch((e) => { console.error("export failed: " + e.message); process.exit(1); });
}

module.exports = { exportFiles, BUCKETS };
