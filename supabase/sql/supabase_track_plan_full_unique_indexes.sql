-- ============================================================
-- HITACHI Rail T&C Portal — Track-plan importer ON CONFLICT fix
--
-- The dynamic-testing foundation migration originally created
-- partial unique indexes on (source_shape_id) for five tables.
-- PostgREST's upsert (Prefer: resolution=merge-duplicates +
-- ?on_conflict=source_shape_id) can't infer a partial index as
-- the conflict target, so every batch returned:
--
--     "there is no unique or exclusion constraint matching the
--      ON CONFLICT specification"
--
-- and silently dropped its rows — the browser importer reported
-- "Final counts → devices 0, mileposts 0, equations 0" because
-- the actual INSERT path never executed.
--
-- Switch to FULL unique indexes. Postgres treats NULLs as
-- distinct by default, so any number of shape-less rows still
-- coexist (matching the original intent of the partial index).
-- Idempotent.
-- ============================================================

drop index if exists public.track_mileposts_shape_idx;
drop index if exists public.track_equations_shape_idx;
drop index if exists public.train_control_locations_shape_idx;
drop index if exists public.track_devices_shape_idx;
drop index if exists public.track_sections_shape_idx;

create unique index if not exists track_mileposts_shape_idx          on public.track_mileposts          (source_shape_id);
create unique index if not exists track_equations_shape_idx          on public.track_equations          (source_shape_id);
create unique index if not exists train_control_locations_shape_idx  on public.train_control_locations  (source_shape_id);
create unique index if not exists track_devices_shape_idx            on public.track_devices            (source_shape_id);
create unique index if not exists track_sections_shape_idx           on public.track_sections           (source_shape_id);

notify pgrst, 'reload schema';
