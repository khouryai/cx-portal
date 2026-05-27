-- ============================================================================
-- MIGRATION: form_template_links — scope template PDFs to a test-case line
-- ============================================================================
-- Run once. Safe to re-run.
--
-- Before this migration, a template-attached PDF was linked only to the
-- activity template, so deployment cloned it onto every selected test case.
-- The new nullable test_case_code column lets a PDF belong to one test case
-- line within the activity template.
-- ============================================================================

alter table if exists public.form_template_links
  add column if not exists test_case_code text null;

alter table if exists public.form_template_links
  drop constraint if exists form_template_links_form_id_template_id_key;

drop index if exists public.ftpl_unique_form_template_test_case;
create unique index if not exists ftpl_unique_form_template_test_case
  on public.form_template_links (form_id, template_id, coalesce(test_case_code, ''));

create index if not exists ftpl_template_test_case_idx
  on public.form_template_links (template_id, test_case_code);

notify pgrst, 'reload schema';
