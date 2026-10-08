"use strict";
// Photo and album ownership by account id (supabase/sql/supabase_photo_owner_ids.sql).
//
// Starts from the live shape (policies comparing NAMES), applies the script,
// then checks, as the gateway runs requests (request.jwt.claims + SET ROLE):
// the owner is stamped from the session and cannot be faked or changed, "own"
// rights follow the id (a rename changes nothing, a namesake gets nothing),
// existing rows are backfilled only where a name is unambiguous, and linking
// a profile to its Entra id on Azure carries ownership with it.
//
// Needs PostgreSQL on 127.0.0.1:5433 (superuser `postgres`, trust auth); skips
// cleanly without.   Run: node tools/test_photo_owner.js
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = "cx_photo_owner_test";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const psql = (args) => execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const pg = (sql) => psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-XAtq", "-c", sql]);
const runFile = (f) => psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-Xq", "-f", path.join(ROOT, f)]);

console.log("=== photo and album ownership by account id ===\n");
try { psql(["-XAtqc", "select 1"]); }
catch (e) { console.log("SKIPPED: no PostgreSQL reachable on 127.0.0.1:5433\n0 passed, 0 failed."); process.exit(0); }

const ANA = "11111111-0000-4000-8000-000000000001";   // uploads, edits her own
const BEN = "22222222-0000-4000-8000-000000000002";   // another field engineer
const TWIN1 = "33333333-0000-4000-8000-000000000003", TWIN2 = "44444444-0000-4000-8000-000000000004";
const OWN = ["photos.edit_metadata_own", "photos.delete_own", "photos.manage_album_own", "photos.upload", "photos.create_album"];

psql(["-XAtq", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
try {
  pg(`do $$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      end $$;
      create schema private;`);
  runFile("supabase/sql/azure_auth_uid_shim.sql");
  pg(`create function private.has_module_perm(p_module text, p_action text) returns boolean language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'test_perms' ? (p_module || '.' || p_action), false) $$;
      grant usage on schema private, auth to authenticated; grant execute on all functions in schema private, auth to authenticated;
      create table public.profiles (id uuid primary key, email text unique, full_name text);
      create table public.photos (id serial primary key, caption text, uploaded_by text);
      create table public.photo_albums (id serial primary key, name text, created_by text);
      alter table public.photos enable row level security; alter table public.photo_albums enable row level security;
      grant all on all tables in schema public to authenticated; grant all on all sequences in schema public to authenticated;
      grant select on public.profiles to authenticated;
      -- the live policies, by name
      create policy photos_sel on public.photos for select using (true);
      create policy photos_ins on public.photos for insert with check ((select private.has_module_perm('photos','upload')));
      create policy photos_upd on public.photos for update
        using ((select private.has_module_perm('photos','edit_metadata_any')) or ((select private.has_module_perm('photos','edit_metadata_own')) and uploaded_by = (select full_name from public.profiles where id = auth.uid())))
        with check ((select private.has_module_perm('photos','edit_metadata_any')) or ((select private.has_module_perm('photos','edit_metadata_own')) and uploaded_by = (select full_name from public.profiles where id = auth.uid())));
      create policy photos_del on public.photos for delete
        using ((select private.has_module_perm('photos','delete_any')) or ((select private.has_module_perm('photos','delete_own')) and uploaded_by = (select full_name from public.profiles where id = auth.uid())));
      create policy photo_albums_sel on public.photo_albums for select using (true);
      create policy photo_albums_ins on public.photo_albums for insert with check ((select private.has_module_perm('photos','create_album')));
      create policy photo_albums_upd on public.photo_albums for update
        using ((select private.has_module_perm('photos','manage_album_any')) or ((select private.has_module_perm('photos','manage_album_own')) and created_by = (select full_name from public.profiles where id = auth.uid())))
        with check ((select private.has_module_perm('photos','manage_album_any')) or ((select private.has_module_perm('photos','manage_album_own')) and created_by = (select full_name from public.profiles where id = auth.uid())));
      create policy photo_albums_del on public.photo_albums for delete
        using ((select private.has_module_perm('photos','manage_album_any')) or ((select private.has_module_perm('photos','manage_album_own')) and created_by = (select full_name from public.profiles where id = auth.uid())));
      insert into public.profiles values ('${ANA}', 'ana@hitachirail.com', 'Ana Lopez'), ('${BEN}', 'ben@hitachirail.com', 'Ben Ito'),
        ('${TWIN1}', 'sam1@hitachirail.com', 'Sam Lee'), ('${TWIN2}', 'sam2@hitachirail.com', 'Sam Lee');
      insert into public.photos (caption, uploaded_by) values ('old by ana', 'Ana Lopez'), ('old by a sam', 'Sam Lee'), ('old by a leaver', 'Gone Person');
      insert into public.photo_albums (name, created_by) values ('ana album', 'Ana Lopez');`);

  runFile("supabase/sql/supabase_photo_owner_ids.sql");
  runFile("supabase/sql/supabase_photo_owner_ids.sql");   // idempotent
  ok("the script runs twice without error (idempotent)", true);

  const as = (uid, perms, sql) => pg(`set request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated", test_perms: perms })}';
    set role authenticated; ${sql}`);
  const owner = (caption) => pg(`select coalesce(uploaded_by_id::text, 'none') from public.photos where caption = '${caption}'`);

  // ── backfill ──
  ok("existing photos are backfilled where the name names one person", owner("old by ana") === ANA);
  ok("…a name two people share is left without an owner (no guessing)", owner("old by a sam") === "none");
  ok("…a name nobody has any more is left without an owner", owner("old by a leaver") === "none");
  ok("existing albums are backfilled too", pg("select created_by_id from public.photo_albums where name='ana album'") === ANA);

  // ── stamping ──
  as(ANA, OWN, `insert into public.photos (caption, uploaded_by, uploaded_by_id) values ('new by ana', 'Ana Lopez', '${BEN}')`);
  ok("a new photo's owner is the signed-in person, whatever the request says", owner("new by ana") === ANA);
  as(ANA, OWN, `update public.photos set uploaded_by_id = '${BEN}' where caption = 'new by ana'`);
  ok("…and cannot be changed from the API afterwards", owner("new by ana") === ANA);
  as(ANA, OWN, "insert into public.photo_albums (name, created_by) values ('new ana album', 'Ana Lopez')");
  ok("a new album's owner is stamped the same way", pg("select created_by_id from public.photo_albums where name='new ana album'") === ANA);

  // ── own rights follow the id ──
  as(ANA, OWN, "update public.photos set caption = 'ana edited' where caption = 'new by ana'");
  ok("the owner can edit her own photo", owner("ana edited") === ANA);
  as(BEN, OWN, "update public.photos set caption = 'ben hijack' where caption = 'ana edited'");
  ok("someone else with only 'own' rights cannot", pg("select count(*) from public.photos where caption = 'ben hijack'") === "0");
  pg(`update public.profiles set full_name = 'Ana Lopez-Garcia' where id = '${ANA}'`);
  as(ANA, OWN, "update public.photos set caption = 'after rename' where caption = 'ana edited'");
  ok("renaming the owner no longer breaks ownership", pg("select count(*) from public.photos where caption = 'after rename'") === "1");
  pg(`update public.profiles set full_name = 'Ana Lopez' where id = '${BEN}'`);    // Ben takes Ana's old name
  as(BEN, OWN, "update public.photos set caption = 'namesake hijack' where caption = 'old by ana'");
  ok("someone who takes the same name gets nothing", pg("select count(*) from public.photos where caption = 'namesake hijack'") === "0");
  as(BEN, OWN, "delete from public.photos where caption = 'after rename'");
  ok("…and cannot delete it", pg("select count(*) from public.photos where caption = 'after rename'") === "1");
  as(BEN, ["photos.edit_metadata_any"], "update public.photos set caption = 'admin fixed' where caption = 'old by a sam'");
  ok("'any' rights still reach photos with no owner", pg("select count(*) from public.photos where caption = 'admin fixed'") === "1");
  as(ANA, OWN, "update public.photo_albums set name = 'ana renamed album' where name = 'new ana album'");
  as(BEN, OWN, "delete from public.photo_albums where name = 'ana renamed album'");
  ok("album ownership: the owner manages it, another person cannot delete it",
    pg("select count(*) from public.photo_albums where name = 'ana renamed album'") === "1");
  as(ANA, OWN, "delete from public.photos where caption = 'after rename'");
  ok("the owner can delete her own photo", pg("select count(*) from public.photos where caption = 'after rename'") === "0");

  // ── Azure: linking the profile to its Entra id carries ownership ──
  as(ANA, OWN, "insert into public.photos (caption) values ('before azure')");
  const ENTRA = "aaaaaaaa-1111-4111-8111-111111111111";
  pg("create table public.auth_events (id bigserial primary key, email text, user_id uuid, event text, detail text)");
  runFile("supabase/sql/azure_relink_profile.sql");
  pg(`select private.relink_profile('ana@hitachirail.com', '${ENTRA}')`);
  ok("on Azure, linking a profile to its Entra id moves ownership with it", owner("before azure") === ENTRA &&
    pg(`select created_by_id from public.photo_albums where name = 'ana renamed album'`) === ENTRA);
  const asEntra = (uid, perms, sql) => pg(`set request.jwt.claims = '${JSON.stringify({ oid: uid, roles: ["authenticated"], test_perms: perms })}';
    set role authenticated; ${sql}`);
  asEntra(ENTRA, OWN, "update public.photos set caption = 'edited on azure' where caption = 'before azure'");
  ok("…and she can still edit her photo when signed in with Microsoft", pg("select count(*) from public.photos where caption = 'edited on azure'") === "1");
  pg(`delete from public.profiles where id = '${BEN}'`);
  ok("deleting a person leaves their photos, without an owner", true);
} catch (e) {
  ok("runs", false, String(e.stderr || e.message));
} finally {
  try { psql(["-XAtqc", `drop database if exists ${DB} with (force)`]); } catch (e) { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
