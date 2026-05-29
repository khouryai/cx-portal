# Presentation Demo Data

Reversible demo data for showing the portal's flow & KPIs before all real data
is loaded. Applied to the production Supabase project via MCP migration
`demo_seed_presentation` on 2026-05-29.

## What was seeded
| Module | Rows | Notes |
|---|---|---|
| Punch List | 13 | Spans every status (draft → closed), mixed priority; some overdue/high to populate the dashboard punch KPI and Kanban. |
| Software Configs | 8 | Per-subsystem versions incl. one `superseded` record. |
| Schedule | 1 batch + 10 activities + 10 maps | A demo **"current"** P6 batch (the project previously had only baselines) with slipped finish dates, mapped to portal activities so **planned-vs-actual variance** renders. |

Total: **42 rows**, every one recorded in the `demo_seed_log` manifest.

## Safety model
- Each seeded row's `(table_name, record_id)` is recorded in `demo_seed_log`.
- Demo rows are also marked (`punch_items.created_by='DEMO_SEED'`,
  `software_configs.created_by='DEMO_SEED'`, `p6_*` via `'DEMO_SEED'` fields,
  `[DEMO]` text in labels/notes).
- **Teardown deletes only the pks in the manifest** — real rows were never
  recorded, so they cannot be matched. See `supabase_demo_teardown.sql`.

## To remove ("scrap the presentation data")
Run `supabase_demo_teardown.sql` against the project (or ask Claude to run the
`demo_teardown` migration). It deletes the manifest's rows in FK-safe order and
empties the manifest. Idempotent.

## Real-data footprint before seeding (for reference)
punch_items: 2 · software_configs: 0 · p6 current batches: 0 · p6_activity_map: 51
