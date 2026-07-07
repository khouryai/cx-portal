-- Production hardening (2026-07) — applied as migration
-- `production_hardening_fn_grants_client_errors`.
-- Critical items from the production-readiness review.

-- 1) create_vehicle_patch was executable by anon (security advisor 0028).
--    The function body already gates on private.has_module_perm('vehicle_mgmt','edit'),
--    but a SECURITY DEFINER RPC should not be callable pre-auth at all.
revoke execute on function public.create_vehicle_patch(text, text, text, text, uuid, uuid, text, text, text, text, text) from public, anon;
grant execute on function public.create_vehicle_patch(text, text, text, text, uuid, uuid, text, text, text, text, text) to authenticated, service_role;

-- 2) client_errors: client-side error telemetry sink (see _reportClientError in
--    app.js). Signed-in users may insert their own rows; reads/deletes are
--    gated on the audit module (mirrors audit_log policies). The app inserts
--    with Prefer: return=minimal, so no SELECT is needed on insert.
create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid default auth.uid(),
  email       text,
  kind        text,
  message     text,
  stack       text,
  url         text,
  user_agent  text
);

alter table public.client_errors enable row level security;

create policy client_errors_ins on public.client_errors
  for insert to authenticated
  with check (user_id = auth.uid());

create policy client_errors_sel on public.client_errors
  for select to authenticated
  using ((select private.has_module_perm('audit'::text, 'view'::text)));

create policy client_errors_del on public.client_errors
  for delete to authenticated
  using ((select private.has_module_perm('audit'::text, 'delete'::text)));

grant select, insert, delete on public.client_errors to authenticated;
grant all on public.client_errors to service_role;
revoke all on public.client_errors from anon;
