-- ============================================================================
-- PRESENTATION DEMO TEARDOWN — removes ONLY demo-seeded rows.
-- ----------------------------------------------------------------------------
-- Safety model: the demo seed recorded every inserted row's (table, pk) in the
-- demo_seed_log manifest. This teardown deletes strictly those pks. Because real
-- rows were never recorded in the manifest, they cannot be matched or deleted.
--
-- Run this when you say "scrap the presentation data". Order matters: children
-- (p6_activity_map, p6_activities) before parent (p6_import_batches).
-- Idempotent — safe to run more than once.
-- ============================================================================

begin;

-- child maps first
delete from p6_activity_map
where id::text in (select record_id from demo_seed_log where table_name = 'p6_activity_map');

-- demo "current" activities
delete from p6_activities
where id::text in (select record_id from demo_seed_log where table_name = 'p6_activities');

-- demo schedule batch (parent)
delete from p6_import_batches
where id::text in (select record_id from demo_seed_log where table_name = 'p6_import_batches');

-- software configs
delete from software_configs
where id::text in (select record_id from demo_seed_log where table_name = 'software_configs');

-- punch items
delete from punch_items
where id in (select record_id from demo_seed_log where table_name = 'punch_items');

-- clear the manifest
delete from demo_seed_log;

commit;

-- Optional: drop the manifest table entirely once you're done with demos.
-- drop table if exists demo_seed_log;
