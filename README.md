# HITACHI Rail T&C Portal

Real-time dashboard for the BART CBTC Project — Testing & Commissioning status, line items, punch list, locations, team organization, and **field team logging**.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | Main page structure |
| `styles.css` | Hitachi-branded styling (premium, Apple-inspired) |
| `app.js` | All interactivity, charts, filters, sorting, CSV export, field logging |
| `data.js` | Your CSV data + TestItems + field user list (PINs) + webhook URL |
| `chart.umd.js` | Chart.js library (bundled offline) |
| `update_data.py` | Script to refresh `data.js` when CSV files change |
| `POWER_AUTOMATE_SETUP.md` | Step-by-step guide to wire up the submission webhook |

## Pages

### Read-only (everyone)
1. **Dashboard** — KPIs, phase progress, charts, "needs attention"
2. **SAT Activities** — filterable/sortable Action Plans table
3. **Line Items** — all 1,181+ test line items
4. **Punch List** — 600+ punch items with priority
5. **Locations** — per-site stats and progress
6. **Team** — Org chart with initials avatars
7. **Documents** — placeholder for CDRLs

### Field-only (login required)
8. **Field Log** — PIN-protected form for field team to:
   - Log test results (Pass/Fail/Partial/Blocked) → updates TestItems status
   - Submit Daily Delay Logs with auto-counted submissions
   - View their own submission queue (works offline)

## Field Logging — How it works

1. Field team taps "Field Log" → enters their PIN
2. Cascading dropdowns: Phase → Location → Subsystem → Activity → Test Case (data sourced from your TestItems master list in `TestPlan_Master.xlsm`)
3. Submits Pass/Fail/Partial/Blocked + notes
4. Submission posts to a Power Automate webhook
5. Power Automate writes the row to `TestResults` sheet AND updates `TestItems` Status column
6. End of day: field team submits Daily Delay Log with auto-counted test results

**Status mapping when result submitted:**
- Pass → TestItems Status becomes `Complete`
- Fail → `Failed`
- Partial → `Partial`
- Blocked → `Blocked`

## Setup Steps (one-time)

### 1. Deploy the website
1. Create free GitHub account at github.com
2. Create new public repository (e.g. `cx-portal`)
3. Drag and drop ALL files from this folder into GitHub
4. Settings → Pages → enable on `main` branch
5. Site live at `https://YOURUSERNAME.github.io/cx-portal/` in ~60 sec

### 2. Set up the Power Automate webhook
**See `POWER_AUTOMATE_SETUP.md`** for step-by-step instructions.

Summary:
- Format your `TestPlan_Master.xlsm` sheets as Excel Tables
- Create a Power Automate flow with "When HTTP request received" trigger
- Add Switch action with cases for `TestResult` and `DelayLog`
- Each case writes to the appropriate Excel table
- Copy the webhook URL → paste into `data.js` → re-upload

### 3. Add field users
Edit `data.js` (or `update_data.py` for permanent changes), find:
```js
fieldUsers: [
  {"name": "Alex Khoury", "pin": "1234", "role": "tester"},
],
```
Add more users as needed. PIN is just numeric.

## Default credentials

- **Name:** Alex Khoury
- **PIN:** 1234

(Change these in `data.js` before deploying!)

## Status mappings (project conventions)

- **Line Item** Status: `Closed` → `Passed`, `Delayed` → `Failed`
- **Action Plan** Status: `Pending Test Report Acceptance` → `Closed`
- **Action Plans** are labeled as "SAT Activities" throughout the UI
- Line item Due Dates are **not** displayed (they're completion dates)

## Updating the data

When CSVs or `TestPlan_Master.xlsm` change:

### Option A: Manual
1. Update files locally
2. Run `python3 update_data.py`
3. Upload new `data.js` to GitHub

### Option B: Power Automate (recommended)
Set up a second flow that:
1. Triggers when files change in OneDrive
2. Pushes regenerated `data.js` to GitHub via the GitHub connector

---

Built for the Hitachi Rail STS USA — BART CBTC Project T&C team.

