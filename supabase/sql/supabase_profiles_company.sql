-- ============================================================
-- profiles.company — user's organization (Hitachi Rail vs BART)
--
-- Ties a company to each portal user so it propagates to their
-- planning_resources roster row and the Lookahead "assign resources" picker
-- can filter by company (Hitachi / BART).
--
-- Applied live as migration: profiles_add_company. Idempotent.
-- ============================================================
alter table profiles add column if not exists company text;

comment on column profiles.company is
  'Organization the user belongs to (e.g. "Hitachi Rail" or "BART"). Propagates to the user''s planning_resources row so the Lookahead resource picker can filter by company.';

-- Backfill: existing portal users are Hitachi Rail staff.
update profiles set company = 'Hitachi Rail' where company is null;

-- Sync existing person-linked resources to their profile's company.
update planning_resources r
   set company = p.company
  from profiles p
 where r.user_id = p.id
   and (r.company is null or r.company = '');
