"use strict";
// Storage seam guard (cx-storage.js) — Azure migration.
//
// Moving files from Supabase Storage to Azure Blob is meant to be ONE value in
// config.js (STORAGE: 'azure'). That only holds while cx-storage.js is the sole
// file that talks to a storage service. This pins it, and pins what each
// provider actually sends over the wire, with a fake fetch.
//   Run: node tools/test_storage_seam.js
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

console.log("=== storage seam (Azure migration) ===\n");

// ── 1. Nobody else talks to a storage service ───────────────────────────────
const served = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") &&
  !["cx-storage.js", "chart.umd.js", "sync_testplan.js"].includes(f));
const offenders = [];
for (const f of served) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (/\/storage\/v1\b/.test(src)) offenders.push(f + ": /storage/v1");
  if (/\.storage\s*\.\s*from\s*\(/.test(src)) offenders.push(f + ": supabase-js .storage.from()");
  if (/blob\.core\.windows\.net/.test(src)) offenders.push(f + ": a Blob Storage host");
}
ok("only cx-storage.js talks to a storage service", offenders.length === 0, offenders.join("; "));

// ── 2. Providers, over a fake network ───────────────────────────────────────
global.window = { CX_CONFIG: {} };
const CXStorage = require(path.join(ROOT, "cx-storage.js"));

let calls = [];
let responder = () => new Response("", { status: 200 });
global.fetch = async (url, init) => {
  const call = { url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {}, body: init && init.body };
  calls.push(call);
  return responder(call);
};
function reset(fn) { calls = []; responder = fn || (() => new Response("", { status: 200 })); }

// A minimal Cache Storage, enough for the offline path.
const cacheStore = new Map();
global.caches = {
  async open() {
    return {
      async put(k, res) { cacheStore.set(String(k), await res.blob()); },
      async match(k) { const b = cacheStore.get(String(k)); return b ? new Response(b) : undefined; },
      async delete(k) { return cacheStore.delete(String(k)); },
    };
  },
};

async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

(async () => {
  // ── Supabase ──
  window.CX_CONFIG = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon" };
  const sb = CXStorage._withProvider("supabase");

  reset();
  await sb.upload("forms", "a b/c.pdf", new Blob(["x"]), "application/pdf");
  ok("supabase upload POSTs to the encoded object path with upsert",
    calls[0].method === "POST" && calls[0].url === "https://sb.test/storage/v1/object/forms/a%20b/c.pdf" &&
    calls[0].headers["x-upsert"] === "true");

  reset(() => new Response("hello", { status: 200 }));
  const blob = await sb.download("documents", "d.pdf");
  ok("supabase download GETs the object and returns a Blob",
    calls[0].method === "GET" && calls[0].url.startsWith("https://sb.test/storage/v1/object/documents/d.pdf?t=") &&
    (await blob.text()) === "hello");

  reset(() => new Response("missing", { status: 404 }));
  const e404 = await rejects(sb.download("forms", "nope.json"));
  ok("a missing object rejects with .status 404", e404 && e404.status === 404);

  reset();
  await sb.copy("forms", "src.pdf", "dst.pdf");
  ok("supabase copy uses the copy endpoint",
    calls[0].url === "https://sb.test/storage/v1/object/copy" &&
    JSON.parse(calls[0].body).sourceKey === "src.pdf" && JSON.parse(calls[0].body).destinationKey === "dst.pdf");

  reset(() => new Response("boom", { status: 500 }));
  ok("removeStrict rejects on a server error", !!(await rejects(sb.removeStrict("drawings", ["x.pdf"]))));
  ok("remove (best-effort) does not reject on a server error", !(await rejects(sb.remove("photos", ["x.jpg"]))));

  reset(() => new Response(JSON.stringify([{ path: "p.jpg", signedURL: "/object/sign/photos/p.jpg?token=t" }]), { status: 200 }));
  const one = await sb.signedUrl("photos", "p.jpg");
  ok("supabase signedUrl returns an absolute URL", one === "https://sb.test/storage/v1/object/sign/photos/p.jpg?token=t");

  // ── Azure ──
  window.CX_CONFIG = { SUPABASE_URL: "https://api.test", SAS_ENDPOINT: "https://fn.test/api/sas" };
  const az = CXStorage._withProvider("azure");
  const sasResponder = (perm) => (call) => {
    if (call.url === "https://fn.test/api/sas") {
      const b = JSON.parse(call.body);
      const urls = {}; b.paths.forEach((p) => { urls[p] = `https://acct.blob.test/${b.container}/${p}?sp=${b.permissions}`; });
      return new Response(JSON.stringify({ urls }), { status: 200 });
    }
    if (call.method === "DELETE" && perm === "gone") return new Response("", { status: 404 });
    return new Response("blobdata", { status: 200 });
  };

  reset(sasResponder());
  await az.upload("drawings", "set/1.pdf", new Blob(["x"]), "application/pdf");
  ok("azure upload signs 'w' then PUTs a block blob",
    JSON.parse(calls[0].body).permissions === "w" &&
    calls[1].method === "PUT" && calls[1].headers["x-ms-blob-type"] === "BlockBlob" &&
    calls[1].url.startsWith("https://acct.blob.test/drawings/set/1.pdf"));

  reset(sasResponder());
  const ab = await az.download("forms", "f.pdf");
  ok("azure download signs 'r' then GETs with no bearer token",
    JSON.parse(calls[0].body).permissions === "r" && calls[1].method === "GET" &&
    !calls[1].headers.Authorization && (await ab.text()) === "blobdata");

  reset(sasResponder("gone"));
  ok("azure removeStrict treats an already-missing blob as done", !(await rejects(az.removeStrict("documents", ["x.pdf"]))));
  ok("azure delete signs 'd'", JSON.parse(calls[0].body).permissions === "d" && calls[1].method === "DELETE");

  reset(sasResponder());
  await az.copy("forms", "a.pdf", "b.pdf");
  ok("azure copy reads the source and writes the destination",
    calls.filter((c) => c.method === "GET").length === 1 && calls.filter((c) => c.method === "PUT").length === 1 &&
    calls.find((c) => c.method === "PUT").url.includes("/forms/b.pdf"));

  window.CX_CONFIG = {};
  reset();
  ok("azure without SAS_ENDPOINT fails loudly", !!(await rejects(az.download("forms", "x.pdf"))) && calls.length === 0);

  // ── Offline file cache: same key whichever provider wrote it ──
  window.CX_CONFIG = { SUPABASE_URL: "https://sb.test" };
  cacheStore.clear();
  reset(() => new Response("v1", { status: 200 }));
  await sb.makeOffline("documents", "spec.pdf");
  reset(() => { throw new TypeError("Failed to fetch"); });
  const offline = await az.download("documents", "spec.pdf", { offline: true });
  ok("an offline download is served from the device cache with no network", (await offline.text()) === "v1");
  reset(() => { throw new TypeError("Failed to fetch"); });
  ok("a non-offline download does not touch the cache", !!(await rejects(sb.download("documents", "spec.pdf"))));

  reset();
  await sb.removeStrict("documents", ["spec.pdf"]);
  ok("deleting an object drops it from the offline cache", cacheStore.size === 0);

  // ── sw.js no longer caches storage, and keeps the file cache on deploy ──
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  ok("sw.js has no storage-URL caching", !/storage\/v1/.test(sw));
  ok("sw.js keeps the cx-files cache when clearing old caches", /startsWith\('cx-files'\)/.test(sw) &&
    CXStorage.FILE_CACHE.startsWith("cx-files"));

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
