-- ============================================================================
-- PRESENTATION DEMO TEARDOWN — removes ONLY demo-seeded rows.
-- ----------------------------------------------------------------------------
-- Safety model: the demo seed recorded every inserted row's (table, pk) in the
-- demo_seed_log manifest. This teardown deletes strictly those pks. Because real
-- rows were never recorded in the manifest, they cannot be matched or deleted.
--
-- Run this when you say "scrap the presentation data".
-- Idempotent — safe to run more than once.
-- ============================================================================

begin;

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
