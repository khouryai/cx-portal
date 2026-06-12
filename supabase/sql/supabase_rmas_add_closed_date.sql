-- ============================================================================
-- RMA closed-date — enables accurate cycle time + historical-import overrides.
-- ----------------------------------------------------------------------------
-- Applied to production via MCP migration `rmas_add_closed_date`.
-- Before this, the RMA "cycle" pill counted now() - created_at and never froze,
-- so Closed (and imported) RMAs showed an ever-growing number with no way to
-- record when they were actually closed. This column lets the editor set/override
-- the real closure date; cycle time is then closed_date - issued_date.
-- ============================================================================

alter table rmas add column if not exists closed_date date;
comment on column rmas.closed_date is 'Actual date the RMA was closed/completed; drives cycle-time. Settable for historical imports.';
