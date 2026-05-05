# HITACHI Rail T&C Portal — Prototype v2

Comprehensive project portal for the BART CBTC Project covering testing status, punch list workflow, team org, and field intake — with role-based access for Admin, Field Engineer, Punch Manager, Technician, and Client.

## What's New in v2

### Role-Based Access Control
5 roles with tailored UI and permissions:
- **Admin** — Full access. Template management, deployment, audit log.
- **Field** — Test matrix, 3-step intake, punch creation.
- **Punch Manager** — Punch assignment, approval workflow.
- **Technician** — Assigned punches only, photo upload, closure.
- **Client** — View only items pending their approval.

### Admin Portal — Template Engine
Create reusable test case templates with code, name, procedure, duration. Deploy a single template to multiple locations simultaneously, toggling which test cases apply at each site.

### Test Matrix View (Live Scratchpad)
Per-location, per-subsystem grid of all applicable test cases. Field team toggles statuses (Pass/Fail/Block/In Progress) directly. Admins can mark test cases N/A with a reason. Last-updated tracking shows who changed what and when.

### 3-Step Field Intake
- **Step 1** — Review test cases toggled today
- **Step 2** — Add manually any items missed
- **Step 3** — Submit daily log with auto-counted statistics, delay reporting, and next-day plan

### Punch List Workflow (Kanban)
Full lifecycle: Open → In Progress → Ready for Sign-off → Client Approval → Closed. Photos before/after, audit trail, role-based actions.

### Photo Upload
Before/after photos for punch items with thumbnail grid. Click to view full size.

### Audit Log
Every action logged with user, role, timestamp, target, and notes. Exportable to CSV.

## Demo Sign-In Credentials

| Role | Name | PIN |
|---|---|---|
| Admin | Alex Khoury | 1234 |
| Admin | Christopher Burford | 9999 |
| Field | John Sterrett | 1111 |
| Field | Viktor Hryshko | 2222 |
| Field | Trevor Abeldt | 3333 |
| Punch Manager | Mustafa Isik | 5555 |
| Technician | Davinder Nagra | 6666 |
| Technician | Alpin Saglambilek | 7777 |
| Client | BART Inspector | 0000 |

The portal auto-routes each role to their primary page on login.

## File Structure

| File | Purpose |
|------|---------|
| `index.html` | Main page structure |
| `styles.css` | Hitachi-branded styling, all role/feature UI |
| `app.js` | Read-only views + all v2 features |
| `data.js` | Production data + mock prototype data |
| `chart.umd.js` | Chart.js library |
| `update_data.py` | Data refresh script |
| `POWER_AUTOMATE_SETUP.md` | Future SharePoint integration guide |

## Deploy to GitHub Pages

1. Create new public repo on GitHub
2. Drag and drop ALL files into the repo
3. Settings → Pages → Source: Deploy from a branch (main)
4. Site live at `https://YOURUSERNAME.github.io/REPO-NAME/`

## Prototype Notes

This is a demo prototype — submissions and changes happen in browser memory only and don't persist. All workflows, role views, and interactions are fully functional for demo purposes. Wire up to SharePoint or a real backend after demo approval.

---

Built for the Hitachi Rail STS USA — BART CBTC Project T&C team.
