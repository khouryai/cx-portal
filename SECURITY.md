# Security Overview — HITACHI Rail T&C Portal
*BART CBTC Testing & Commissioning · Internal Use Only*

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Static HTML/CSS/JS — hosted on GitHub Pages (HTTPS enforced) |
| Backend / Database | Supabase (PostgreSQL) — US-East region |
| Authentication | Supabase Auth — email + password, JWT sessions |
| Transport | TLS 1.2+ on all connections (GitHub Pages + Supabase) |

---

## Authentication

- **Email + password** via Supabase Auth. No shared passwords, no PINs, no plaintext credentials anywhere in the codebase or database.
- **Password reset** via Supabase email flow — users receive a secure reset link.
- **Session tokens** are JWT-signed by Supabase, stored in `localStorage`, and expire automatically (configurable; default 1 hour).
- **New user sign-ups are disabled** — only the administrator can create accounts via the admin portal.
- **Account deactivation** — admins can deactivate or remove any account immediately from the portal. Deactivated users cannot sign in.

---

## Authorization (Server-Side)

Row Level Security (RLS) is enabled on **all 45 database tables**.

| Policy | Tables |
|---|---|
| Authenticated users only — read + write | All 43 data tables (test items, planning, punch lists, assets, etc.) |
| Authenticated read-all; admin-only write | `profiles` (user directory) |
| Admin-only | `users` (legacy reference table) |
| Blocked entirely for unauthenticated callers | Every table — the anon key alone returns no data |

The database rejects unauthorized API calls at the server level — UI-level role checks are a secondary layer only.

---

## Credentials & Secrets

| Item | Status |
|---|---|
| Database passwords | Never in code — managed entirely by Supabase |
| Service role key | Never used client-side |
| Supabase anon key | Present in code (by design — this is Supabase's public API key). It grants zero data access without a valid authenticated session due to RLS. |
| User passwords / PINs | Removed from codebase and database. Previously stored as plaintext — migrated. |

---

## Supply Chain (CDN Integrity)

All 16 third-party CDN resources (scripts + stylesheets) are:
- **Pinned to specific versions** — no floating `@latest` tags
- **Protected with SHA-384 Subresource Integrity (SRI) hashes** — the browser refuses to execute any file whose content has changed since the hash was verified

Libraries used: Supabase JS, SheetJS, Alpine.js, Flatpickr, Tom Select, Fuse.js, Day.js, Tippy.js, Quill, ExcelJS, vis-timeline.

---

## Audit Logging

Every significant user action is recorded in the `audit_log` table:
- User name + role
- Action type (create, update, delete, status change)
- Target record
- Timestamp

Accessible to admins via the portal's Audit Log page.

---

## User Management

| Capability | Who |
|---|---|
| Create new accounts | Admin only (via Admin → Directory → Invite User) |
| Assign roles (Admin / Field Engineer / Read Only / Client) | Admin only |
| Restrict a user to a specific subsystem | Admin only |
| Deactivate / remove access | Admin only |
| Password reset | Self-service (email link) |

Roles enforced at both the UI layer (nav visibility) and the database layer (RLS policies).

---

## Data Residency

Supabase project region: **US East (Northern Virginia)**. Data does not leave US jurisdiction.

---

## Remaining Roadmap Items

| Item | Priority | Notes |
|---|---|---|
| Multi-factor authentication (TOTP) | Medium | Supabase supports it — enable in Auth settings + add enrollment UI |
| Content Security Policy headers | Low | Requires refactoring inline event handlers — planned |
| Penetration test | Low | Recommended before broad rollout |
