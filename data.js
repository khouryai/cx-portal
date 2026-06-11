// HITACHI Rail T&C Portal - Data
// Demo/mock data removed 2026-06-11. Every screen now sources from Supabase:
//   Test Register / Test Cases / Activities → test_items (+ activity_records)
//   Punch List → Supabase (PUNCH_DB); RMA, Dynamic Testing, Forms, Drawings,
//   Templates, Weights, Planning → their own tables; Team → team_members.
// This file is kept only as an empty baseline so the `window.PORTAL_DATA.<key>`
// contract still resolves (to [] ) before the authenticated data load runs.

window.PORTAL_DATA = {
  actionPlans:   [],
  lineItems:     [],
  punchList:     [],
  testItems:     [],
  org:           [],
  fieldUsers:    [],
  config:        {},
  users_v2:      [],
  templates:     [],
  locations:     [],
  deployments:   [],
  testInstances: [],
  punchItems:    [],
  auditLog:      [],
  meta: {
    generated: "2026-06-11",
    project:   "BART CBTC",
    client:    "Bay Area Rapid Transit",
    note:      "Demo data removed — all screens source from Supabase."
  }
};
