-- ============================================================================
-- Change log: record WHO made each change under any sign-in provider.
-- ----------------------------------------------------------------------------
-- public.audit_db_change() (trigger on test_items, punch_items, forms, photos,
-- …) writes db_change_log. It took the actor from token claims Supabase
-- happens to carry: `email` and `role`. A Microsoft Entra access token has no
-- `role` claim and carries `email` only if IT adds it as an optional claim —
-- so on Azure every change would be logged with no actor, and the Audit Log
-- screen would show "Database" for everything a person did.
--
-- This version finds the person from the token's user id (Entra `oid`,
-- Supabase `sub`) in profiles, and falls back to whatever the token carries.
-- Email stays first so new rows read like the existing ones; on Supabase the
-- output is identical to before.
--
-- Run by azure_after_restore.sql. Safe on Supabase too. Idempotent.
-- Pinned by tools/test_audit_actor.js against a real PostgreSQL.
-- ============================================================================

create or replace function public.audit_db_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
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

  -- Who: the profile behind the token, whichever provider issued it.
  begin
    v_uid := nullif(coalesce(claims->>'oid', claims->>'sub'), '')::uuid;
  exception when others then
    v_uid := null;
  end;
  if v_uid is not null then
    select p.full_name, p.email into v_name, v_email from public.profiles p where p.id = v_uid;
  end if;

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
