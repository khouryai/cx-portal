-- ============================================================================
-- Change log trigger (public.audit_db_change) — who changed what, compactly.
-- ----------------------------------------------------------------------------
-- The trigger on test_items, punch_items, forms, photos, … writes one
-- db_change_log row per change. Two problems with the original (2026-10):
--
-- 1. WHO. It took the actor from token claims only Supabase carries (`email`,
--    `role`). A Microsoft Entra access token has no `role` claim and carries
--    `email` only if IT adds it, so on Azure every change would be logged with
--    no actor and the Audit Log screen would show "Database" throughout. Now
--    the person is found from the token's user id (Entra `oid`, Supabase
--    `sub`) in profiles, falling back to what the token carries. Email stays
--    first, so new rows read like the existing ones; on Supabase the actor
--    output is identical to before.
--
-- 2. SIZE. Every UPDATE stored the whole old row and the whole new row. Most
--    updates touch one column (10,000 were weight recalculations), so the log
--    had grown to 38 MB of a 60 MB database. Now an UPDATE stores only the
--    columns that changed, plus a few that say WHICH record it was (test code,
--    name, phase, location, subsystem, activity, status and its reasons) — the
--    fields the daily-log rebuild in app.js reads. An update that changed
--    nothing but updated_at is not logged at all. INSERT and DELETE still keep
--    the full row: what was created, and what was lost.
--
-- Run on Supabase (supabase_change_log_compact.sql also shrinks the existing
-- rows) and by azure_after_restore.sql. Idempotent.
-- Pinned by tools/test_change_log.js against a real PostgreSQL.
-- ============================================================================

create or replace function public.audit_db_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  -- Kept on every UPDATE row so it says which record it was.
  context_cols constant text[] := array[
    'id', 'test_id', 'test_case_code', 'test_name', 'title', 'name',
    'phase', 'location', 'subsystem', 'activity',
    'status', 'failed_reason', 'blocked_reason'];
  old_data     jsonb;
  new_data     jsonb;
  claims       jsonb;
  changed_cols text[];
  rec_id       text;
  v_uid        uuid;
  v_name       text;
  v_email      text;
begin
  claims := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );

  if tg_op = 'DELETE' then
    old_data := to_jsonb(old);
    new_data := null;
    rec_id := coalesce(old_data->>'id', old_data->>'test_id', old_data->>'result_id', old_data->>'log_id');
  elsif tg_op = 'INSERT' then
    old_data := null;
    new_data := to_jsonb(new);
    rec_id := coalesce(new_data->>'id', new_data->>'test_id', new_data->>'result_id', new_data->>'log_id');
  else
    old_data := to_jsonb(old);
    new_data := to_jsonb(new);
    rec_id := coalesce(new_data->>'id', new_data->>'test_id', new_data->>'result_id', new_data->>'log_id');
    select array_agg(key order by key)
    into changed_cols
    from jsonb_each(new_data) n
    where (old_data->n.key) is distinct from n.value;

    -- Nothing but bookkeeping changed: not a change.
    if changed_cols is null or changed_cols <@ array['updated_at'] then
      return new;
    end if;

    -- Only what changed, plus what identifies the record.
    select jsonb_object_agg(k, old_data->k), jsonb_object_agg(k, new_data->k)
    into old_data, new_data
    from (select distinct unnest(changed_cols || context_cols) as k) keys
    where new_data ? k;
  end if;

  -- Who: the profile behind the token, whichever provider issued it.
  begin
    v_uid := nullif(coalesce(claims->>'oid', claims->>'sub'), '')::uuid;
  exception when others then
    v_uid := null;
  end;
  if v_uid is not null then
    select p.full_name, p.email into v_name, v_email from public.profiles p where p.id = v_uid;
  end if;

  insert into db_change_log (
    table_name, record_id, operation,
    changed_by, actor_email, actor_role,
    changed_columns, old_row, new_row
  ) values (
    tg_table_name, rec_id, tg_op,
    coalesce(nullif(v_email, ''), nullif(claims->>'email', ''), nullif(claims->>'preferred_username', ''),
             nullif(claims->>'name', ''), nullif(v_name, '')),
    coalesce(nullif(v_email, ''), nullif(claims->>'email', ''), nullif(claims->>'preferred_username', '')),
    -- Entra tokens carry no `role` claim; the gateway has already switched the
    -- database role to the one the token grants, so read that instead.
    coalesce(nullif(claims->>'role', ''), case when v_uid is not null then current_setting('role', true) end),
    changed_cols, old_data, new_data
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;
