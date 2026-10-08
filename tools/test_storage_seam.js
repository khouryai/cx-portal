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

  // ── Azure: signatures match Microsoft's SDK byte for byte ──
  // Vectors generated with @azure/storage-blob 12.34.0
  // generateBlobSASQueryParameters(..., userDelegationKey, 'stcxtest'),
  // version 2022-11-02, https only, st 01:00Z, se 01:10Z.
  const KEY = { oid: "11111111-2222-3333-4444-555555555555", tid: "66666666-7777-8888-9999-000000000000",
    start: "2026-10-08T00:00:00Z", expiry: "2026-10-08T02:00:00Z", service: "b", version: "2022-11-02",
    value: "Y3gtcG9ydGFsLXRlc3QtZGVsZWdhdGlvbi1rZXktMzJi" };
  const SDK = [
    ["drawings", "set-42/rev B.pdf", "rw", "tomjQ2Ly4%2B2h4oOhDTMQiBstrreBiB08pb93wvNijV4%3D"],
    ["photos", "2026/10/ü-photo #1.jpg", "r", "rUDTdgAKKhPok%2FfiDXKEYi8nbIJLAdTn2A6UD8ay59s%3D"],
    ["documents", "v1/spec.pdf", "d", "aItLImS%2ButEwKYrqs4JZkHqiXXNJDzPii4CELmIDUcY%3D"],
  ];
  window.CX_CONFIG = { STORAGE: "azure", BLOB_ORIGIN: "https://stcxtest.blob.core.windows.net" };
  for (const [c, p, perm, sig] of SDK) {
    const url = await CXStorage._azure.signBlob(KEY, "stcxtest", c, p, perm,
      Date.parse("2026-10-08T01:00:00Z"), Date.parse("2026-10-08T01:10:00Z"));
    const expected = "sv=2022-11-02&spr=https&st=2026-10-08T01%3A00%3A00Z&se=2026-10-08T01%3A10%3A00Z" +
      "&skoid=" + KEY.oid + "&sktid=" + KEY.tid + "&skt=2026-10-08T00%3A00%3A00Z&ske=2026-10-08T02%3A00%3A00Z" +
      "&sks=b&skv=2022-11-02&sr=b&sp=" + perm + "&sig=" + sig;
    ok(`SAS for ${c}/${p} (${perm}) is identical to the Azure SDK's`, url.split("?")[1] === expected, url);
  }

  // ── Azure: the flow, over a fake network ──
  const tokenScopes = [];
  window.CXIdentity = { tokenFor: async (scope) => { tokenScopes.push(scope); return "ms-token"; } };
  const keyXml = (now) => `<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>${KEY.oid}</SignedOid>` +
    `<SignedTid>${KEY.tid}</SignedTid><SignedStart>${new Date(now - 300000).toISOString()}</SignedStart>` +
    `<SignedExpiry>${new Date(now + 7200000).toISOString()}</SignedExpiry><SignedService>b</SignedService>` +
    `<SignedVersion>2022-11-02</SignedVersion><Value>${KEY.value}</Value></UserDelegationKey>`;
  const azureNet = (opts = {}) => (call) => {
    if (call.url.includes("comp=userdelegationkey")) return new Response(keyXml(Date.now()), { status: 200 });
    if (call.method === "DELETE" && opts.gone) return new Response("", { status: 404 });
    return new Response("blobdata", { status: 200 });
  };
  const az = CXStorage._withProvider("azure");
  const keyCalls = () => calls.filter((c) => c.url.includes("comp=userdelegationkey"));

  CXStorage._azure.resetKey(); reset(azureNet());
  const ab = await az.download("forms", "f.pdf");
  ok("azure fetches a user delegation key with the user's Microsoft storage token",
    keyCalls().length === 1 && keyCalls()[0].method === "POST" &&
    keyCalls()[0].headers.Authorization === "Bearer ms-token" &&
    tokenScopes[0] === "https://storage.azure.com/user_impersonation");
  const get = calls.find((c) => c.method === "GET");
  ok("azure download GETs a signed blob URL, read-only, with no bearer token",
    get && get.url.startsWith("https://stcxtest.blob.core.windows.net/forms/f.pdf?") &&
    /[?&]sp=r(&|$)/.test(get.url) && !get.headers.Authorization && (await ab.text()) === "blobdata");

  reset(azureNet());
  await az.upload("drawings", "set/1.pdf", new Blob(["x"]), "application/pdf");
  const put = calls.find((c) => c.method === "PUT");
  ok("azure upload PUTs a block blob to a write-only SAS",
    put && put.headers["x-ms-blob-type"] === "BlockBlob" && /[?&]sp=w(&|$)/.test(put.url));
  ok("the delegation key is cached, not fetched per file", keyCalls().length === 0);

  reset(azureNet({ gone: true }));
  ok("azure removeStrict treats an already-missing blob as done", !(await rejects(az.removeStrict("documents", ["x.pdf"]))));
  ok("azure delete uses a delete-only SAS", /[?&]sp=d(&|$)/.test(calls.find((c) => c.method === "DELETE").url));

  reset(azureNet());
  await az.copy("forms", "a.pdf", "b.pdf");
  ok("azure copy reads the source and writes the destination",
    calls.filter((c) => c.method === "GET").length === 1 &&
    calls.find((c) => c.method === "PUT").url.includes("/forms/b.pdf?"));

  reset(azureNet());
  const urls = await az.signMany("photos", ["a.jpg", "b.jpg"], 99999);
  const se = (u) => Date.parse(decodeURIComponent(/[?&]se=([^&]+)/.exec(u)[1]));
  ok("read links are clamped to an hour", Object.keys(urls).length === 2 && se(urls["a.jpg"]) - Date.now() <= 3600 * 1000 + 2000);
  ok("the delegation key outlives every link signed with it",
    Date.parse(decodeURIComponent(/[?&]ske=([^&]+)/.exec(urls["a.jpg"])[1])) > se(urls["a.jpg"]));

  ok("an unknown container is refused", !!(await rejects(az.upload("secrets", "x", new Blob(["x"])))));
  ok("a path that climbs out of its folder is refused", !!(await rejects(az.download("forms", "../photos/x.jpg"))));

  window.CX_CONFIG = { STORAGE: "azure" };
  CXStorage._azure.resetKey(); reset();
  ok("azure without BLOB_ORIGIN fails loudly", !!(await rejects(az.download("forms", "x.pdf"))) && calls.length === 0);

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
