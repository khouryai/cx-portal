// photo-sharepoint-sync — mirrors portal photos into the corporate SharePoint
// document library via Microsoft Graph (one-way, portal → SharePoint).
// See INTEGRATION_SHAREPOINT.md for the full design + the IT provisioning brief.
//
// Until IT provisions the Entra app registration this function is deployed but
// UNCONFIGURED: it responds 200 { configured: false } so the in-app button can
// show a friendly state. To enable, set the secrets:
//   SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_DRIVE_ID  (required)
//   SP_BATCH_SIZE (optional, default 25)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected.
//
// Caller must be an authenticated GLOBAL ADMIN (profiles.role = 'admin').
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const GRAPH = "https://graph.microsoft.com/v1.0";
const ROOT_FOLDER = "CX-Portal Photos";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // Graph simple PUT cap
const CHUNK = 5 * 1024 * 1024; // upload-session chunk (multiple of 320 KiB)

function folderFor(p: {
  source_type?: string | null;
  source_label?: string | null;
  taken_at?: string | null;
  created_at?: string | null;
}): string {
  const safe = (s: string) =>
    s.replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Unlabelled";
  const ym = (p.taken_at || p.created_at || new Date().toISOString()).slice(0, 7);
  if (p.source_type === "punch") return `Punch List/${safe(p.source_label || "Unlabelled")}`;
  if (p.source_type === "daily_log") return `Daily Logs/${ym}/${safe(p.source_label || "Unlabelled")}`;
  return `General/${ym}`;
}

async function graphToken(tenant: string, client: string, secret: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Graph token: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

async function uploadToGraph(
  token: string,
  driveId: string,
  path: string,
  bytes: Uint8Array,
): Promise<{ id: string; webUrl: string }> {
  const encPath = path.split("/").map(encodeURIComponent).join("/");
  if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
    const res = await fetch(
      `${GRAPH}/drives/${driveId}/root:/${encPath}:/content?@microsoft.graph.conflictBehavior=replace`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: bytes },
    );
    const item = await res.json();
    if (!res.ok) throw new Error(`Graph upload ${res.status}: ${item.error?.message || "unknown"}`);
    return { id: item.id, webUrl: item.webUrl };
  }
  // large file: upload session
  const sess = await fetch(`${GRAPH}/drives/${driveId}/root:/${encPath}:/createUploadSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
  });
  const sessData = await sess.json();
  if (!sess.ok || !sessData.uploadUrl) {
    throw new Error(`Graph session ${sess.status}: ${sessData.error?.message || "unknown"}`);
  }
  let item: { id?: string; webUrl?: string } = {};
  for (let off = 0; off < bytes.byteLength; off += CHUNK) {
    const end = Math.min(off + CHUNK, bytes.byteLength);
    const res = await fetch(sessData.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(end - off),
        "Content-Range": `bytes ${off}-${end - 1}/${bytes.byteLength}`,
      },
      body: bytes.slice(off, end),
    });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Graph chunk ${res.status}: ${err.error?.message || "unknown"}`);
    }
    if (res.status === 200 || res.status === 201) item = await res.json();
  }
  if (!item.id) throw new Error("Graph session finished without an item");
  return { id: item.id, webUrl: item.webUrl! };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const tenant = Deno.env.get("SP_TENANT_ID") ?? "";
  const clientId = Deno.env.get("SP_CLIENT_ID") ?? "";
  const secret = Deno.env.get("SP_CLIENT_SECRET") ?? "";
  const driveId = Deno.env.get("SP_DRIVE_ID") ?? "";
  const batchSize = Math.min(Number(Deno.env.get("SP_BATCH_SIZE") || 25), 100);

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  try {
    // ── caller must be a signed-in global admin ──────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const asCaller = createClient(supaUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "not signed in" }, 401);

    const svc = createClient(supaUrl, serviceKey);
    const { data: prof } = await svc
      .from("profiles")
      .select("role, is_active")
      .eq("id", userData.user.id)
      .single();
    if (!prof || prof.is_active === false || prof.role !== "admin") {
      return json({ error: "admin only" }, 403);
    }

    // ── not configured yet → friendly state, no error ───────────────────────
    if (!tenant || !clientId || !secret || !driveId) {
      return json({
        configured: false,
        message:
          "SharePoint sync is not configured yet (pending IT provisioning — see INTEGRATION_SHAREPOINT.md).",
      });
    }

    // ── sync a batch ─────────────────────────────────────────────────────────
    const token = await graphToken(tenant, clientId, secret);
    const { data: rows, error: selErr } = await svc
      .from("photos")
      .select("id, storage_path, source_type, source_label, taken_at, created_at")
      .in("sp_sync_status", ["pending", "error"])
      .not("storage_path", "is", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);
    if (selErr) throw new Error("select photos: " + selErr.message);

    let synced = 0;
    const errors: { id: string; error: string }[] = [];
    for (const p of rows ?? []) {
      try {
        const { data: blob, error: dlErr } = await svc.storage
          .from("photos")
          .download(p.storage_path);
        if (dlErr || !blob) throw new Error("storage download: " + (dlErr?.message || "empty"));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const name = p.storage_path.split("/").pop()!;
        const dest = `${ROOT_FOLDER}/${folderFor(p)}/${name}`;
        const item = await uploadToGraph(token, driveId, dest, bytes);
        await svc.from("photos").update({
          sp_sync_status: "synced",
          sp_drive_id: driveId,
          sp_item_id: item.id,
          sp_web_url: item.webUrl,
          sp_synced_at: new Date().toISOString(),
          sp_error: null,
        }).eq("id", p.id);
        synced++;
      } catch (e) {
        const msg = String(e).slice(0, 500);
        errors.push({ id: p.id, error: msg });
        await svc.from("photos").update({ sp_sync_status: "error", sp_error: msg }).eq("id", p.id);
      }
    }

    const { count: remaining } = await svc
      .from("photos")
      .select("id", { count: "exact", head: true })
      .in("sp_sync_status", ["pending", "error"]);

    return json({
      configured: true,
      processed: (rows ?? []).length,
      synced,
      failed: errors.length,
      remaining: remaining ?? 0,
      errors,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
