# Security Overview — HITACHI Rail T&C Portal
*BART CBTC Testing & Commissioning · Internal Use Only*

> This describes the **current** deployment (GitHub Pages + Supabase). The
> Azure target, with Microsoft Entra sign-in and its threat model, is described
> in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Static HTML/CSS/JS — hosted on GitHub Pages (HTTPS enforced) |
| Backend / Database | Supabase (PostgreSQL) — US West (Oregon) region |
| Authentication | Supabase Auth — email + password, JWT sessions |
| Transport | TLS 1.2+ on all connections (GitHub Pages + Supabase) |

---

## Authentication

- **Email + password** via Supabase Auth. No shared passwords, no PINs, no plaintext credentials anywhere in the codebase or database.
- **Multifactor authentication (TOTP)** is required. An account with no verified authenticator is sent to an enrolment card before it can enter; an enrolled account must clear a 6-digit challenge on every sign-in. Enforced server-side, not just in the UI — `private.has_module_perm()` refuses every governed table to a session that has not reached AAL2, so an AAL1 session sees an empty app rather than data. Exceptions are per-account and explicit (`profiles.mfa_enforced = false`).
- **Password policy** — at least 12 characters mixing 3 of {lower, upper, digit, symbol}, rejecting the user's own email name and common sequences.
- **Password rotation** — six-monthly, tracked in `profiles.password_changed_at`. An account whose password is older than 180 days (or has no recorded change date) must set a new one before entering.
- **Account lockout** — 5 failed attempts in 15 minutes locks the account for 15 minutes. Enforced in GoTrue itself via the `password_verification_attempt` auth hook, so it also covers callers that bypass the portal's own form; the sign-in screen additionally consults `auth_login_gate()` so the user is told what happened. Repeated MFA failures are locked the same way.
- **Password reset** via Supabase email flow — users receive a secure reset link.
- **Session tokens** are JWT-signed by Supabase, stored in `localStorage`, and expire automatically (configurable; default 1 hour).
- **New user sign-ups are disabled** — only the administrator can create accounts via the admin portal.
- **Account deactivation** — admins can deactivate or remove any account immediately from the portal. Deactivated users cannot sign in.

Implementation: `cx-auth-hardening.js` (browser) + `supabase/sql/supabase_auth_hardening.sql` (server). Verified by `tools/test_auth_hardening.js` and `tools/pw_auth_gates.js`, which proves in a real browser that each non-compliant session is actually stopped at the login overlay.

---

## Authorization (Server-Side)

Row Level Security (RLS) is enabled on **every database table** (59 after the
2026-10 cleanup), with about 230 policies.

| Rule | Where |
|---|---|
| Per-module, per-action permissions (17 modules; a permission template per person plus optional per-person overrides) | Every governed table, through `private.has_module_perm()` — see `PERMISSIONS_MODEL.md` |
| Everyone signed in may read the user directory; changes need Directory administration rights | `profiles` |
| Blocked entirely for unauthenticated callers | Every table — the anon key alone returns no data |

The database rejects unauthorized API calls at the server level — UI-level permission checks are a secondary layer only.

---

## Credentials & Secrets

| Item | Status |
|---|---|
| Database passwords | Never in code — managed entirely by Supabase |
| Service role key | Never used client-side |
| Supabase anon key | Present in code (by design — this is Supabase's public API key). It grants zero data access without a valid authenticated session due to RLS. |
| User passwords / PINs | Removed from codebase and database. Previously stored as plaintext — migrated. |

---

## Supply Chain

**No CDN.** Every third-party library is a pinned copy in `vendor/` (or the site
root), served from the portal's own origin, so the page loads no script from
anywhere else. `tools/test_csp.js` fails the build if a third-party script host
appears.

Libraries used: Alpine.js, Chart.js, Day.js, Flatpickr, Fuse.js, JSZip, MSAL
Browser (Microsoft sign-in), pdf.js, pdf-lib, Popper, Tippy.js, Tom Select, and
Supabase JS (left out of the Azure build).

A **Content-Security-Policy** (meta tag in `index.html`) restricts script, connection, image and frame origins to this site plus the configured Supabase project and Microsoft sign-in. It cannot yet drop `'unsafe-inline'` for scripts — about 290 inline `on*=` handlers remain, and retiring them to `data-action` is exactly what the ratchet in `tools/size_baseline.json` drives — and `'unsafe-eval'` is required by Alpine.js. `tools/test_csp.js` fails the build if the policy and `config.js` drift apart.

Adding that policy surfaced a **stale `@import` of Google Fonts** at the top of `styles.css` that survived the self-hosting pass in `MIGRATION.md` §6 — every page load was still calling `fonts.googleapis.com`. It has been removed and `--f-mono` now points at the self-hosted IBM Plex Mono.

---

## Audit Logging

Every significant user action is recorded in the `audit_log` table:
- User name + role
- Action type (create, update, delete, status change)
- Target record
- Timestamp

Accessible to admins via the portal's Audit Log page.

Authentication and privilege events are recorded separately in `auth_events`, because a failed sign-in has no session to attribute and must not be writable by ordinary users:
- Sign-in success, failure, and lockout — including repeated failures
- MFA enrolment and rejected authentication codes
- Password changes
- Privilege changes (role, permission template, activation), written by the `profiles` trigger itself so they cannot be missed

The table has **no insert/update/delete policy at all** — every write goes through a `SECURITY DEFINER` routine, so the trail cannot be edited from a session. Reads require `audit.view`. Rows are kept indefinitely: the weekly `pg_cron` purge (400 days) was removed in 2026-10 together with the scheduler, so the app needs no scheduled jobs. If a retention period is set, apply it with a manual delete. `audit_log` itself is never purged.

---

## User Management

| Capability | Who |
|---|---|
| Create new accounts | Admin only (Admin → Directory → Users → + Invite User) |
| Assign roles (Admin / Field Engineer / Read Only / Client) | Admin only |
| Restrict a user to a specific subsystem | Admin only |
| Deactivate / remove access | Admin only |
| Password reset | Self-service (email link) |

Roles enforced at both the UI layer (nav visibility) and the database layer (RLS policies).

---

## Data Residency

Supabase project region: **US West (Oregon), `us-west-2`** — verified against the project itself on 2026-09-11. Data does not leave US jurisdiction.

> This document previously said *US East (Northern Virginia)*. That was wrong, and the error had been repeated elsewhere. Corrected.

---

## Remaining Roadmap Items

| Item | Priority | Notes |
|---|---|---|
| ~~Multi-factor authentication (TOTP)~~ | — | **Built** — see Authentication above. Not yet *demanded*: see the roll-out note below |
| ~~Content Security Policy~~ | — | **Done** as a meta-tag policy; a *strict* one still needs the inline handlers retired |
| ~~Apply `supabase_auth_hardening.sql`~~ | — | **Applied 2026-09-11.** Columns, `auth_events`, RPCs, the RLS/MFA gate and privilege logging are live (the retention job was removed in 2026-10) |
| Enable TOTP enrolment in the dashboard | **High** | Authentication → Providers/MFA. **Must be confirmed working before `mfa_enforced` is turned on for anyone** — the portal blocks entry until a factor is verified, so an account that cannot enrol cannot get in |
| Enable the two auth hooks in the dashboard | **High** | Authentication → Hooks → `password_verification_attempt` and `mfa_verification_attempt`. Until these are on, lockout is client-side only |
| Enable leaked-password protection | Medium | Auth settings; flagged by the Supabase security advisor. Checks new passwords against HaveIBeenPwned |
| Turn on `mfa_enforced` per account | Medium | See `supabase/sql/supabase_auth_hardening_rollout.sql` for the order and the break-glass rule |
| Admin UI to reset a lost authenticator | Medium | Today an admin removes the factor from the Supabase dashboard |
| Penetration test | Medium | Recommended before broad rollout |

### MFA roll-out status

The mechanism is live; enforcement is staged. Every pre-existing account was set
`mfa_enforced = false` with the rotation clock started, so nobody is disrupted at
their next sign-in. The RLS gate is live but dormant — it only refuses a session
once that account has a **verified** factor, so it costs nothing until enrolment
begins. `supabase/sql/supabase_auth_hardening_rollout.sql` records why, and the
order to switch accounts on.

## Control summary

| Control | What was delivered |
|---|---|
| User authentication | TOTP multifactor, enforced in RLS |
| Console access | Not addressable in code — needs MFA enabled on the Supabase and GitHub consoles |
| Password management | Policy, six-monthly rotation, lockout |
| Account disposal | `access_review_due` view + `access_review_log` for the six-monthly review |
| Access logs | `auth_events`, privilege-change capture, kept indefinitely |
| Public-surface hardening | Content-Security-Policy; strict CSP still blocked on retiring inline handlers |
