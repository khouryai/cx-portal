# Power Automate Setup — Field Submissions Flow

This guide walks you through creating ONE Power Automate flow that:
1. Receives test result + daily log submissions from the web portal
2. Appends them to your `TestPlan_Master.xlsm` (TestResults / DelayLog sheets)
3. Updates the `TestItems` Status column when a result is logged

---

## What You'll Need

- Microsoft 365 account (you already have)
- Your `TestPlan_Master.xlsm` file in OneDrive (NOT on your local computer)
- About 30 minutes

---

## Step 1: Format the Excel Tables

Power Automate needs the sheets to be formal **Excel Tables** (not just data ranges).

1. Open `TestPlan_Master.xlsm` in Excel
2. Click anywhere in the **TestItems** sheet data
3. Press `Ctrl + T` → check "My table has headers" → OK
4. With table selected, go to **Table Design** tab → name it `tblTestItems`
5. Repeat for **TestResults** sheet → name `tblTestResults`
6. Repeat for **DelayLog** sheet → name `tblDelayLog`
7. Save and close the file

---

## Step 2: Create the Flow

1. Go to **make.powerautomate.com** → sign in
2. Click **Create** → **Instant cloud flow**
3. Name: `T&C Portal Field Submissions`
4. Trigger: **When an HTTP request is received**
5. Click **Create**

### Configure the trigger

In the trigger box, paste this JSON Schema:

```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string" },
    "submittedBy": { "type": "string" },
    "submittedAt": { "type": "string" },
    "record": { "type": "object" },
    "statusUpdate": { "type": "object" }
  }
}
```

Save the flow once — this generates your **HTTP POST URL**. **Copy this URL** — you'll paste it into the portal.

---

## Step 3: Add the Branching Logic

After the trigger, add a **Switch** action (Built-in → Control → Switch):

- **On**: `triggerBody()?['type']`
- Add cases for `TestResult` and `DelayLog`

### Case 1: `TestResult`

Inside this case, add 2 actions:

**Action A — Add row to TestResults**
- Connector: **Excel Online (Business)** → **Add a row into a table**
- Location: OneDrive for Business
- File: select `TestPlan_Master.xlsm`
- Table: `tblTestResults`
- Map fields (use Dynamic content):
  - ResultID = `triggerBody()?['record']?['ResultID']`
  - TestID = `triggerBody()?['record']?['TestID']`
  - TestName = `triggerBody()?['record']?['TestName']`
  - AttemptNumber = `triggerBody()?['record']?['AttemptNumber']`
  - Phase = `triggerBody()?['record']?['Phase']`
  - Location = `triggerBody()?['record']?['Location']`
  - Subsystem = `triggerBody()?['record']?['Subsystem']`
  - Activity = `triggerBody()?['record']?['Activity']`
  - TestCaseCode = `triggerBody()?['record']?['TestCaseCode']`
  - TestProcedure = `triggerBody()?['record']?['TestProcedure']`
  - Result = `triggerBody()?['record']?['Result']`
  - Team = `triggerBody()?['record']?['Team']`
  - CompletedBy = `triggerBody()?['record']?['CompletedBy']`
  - DateTested = `triggerBody()?['record']?['DateTested']`
  - SubmittedAt = `triggerBody()?['record']?['SubmittedAt']`
  - "#ofTesters" = `triggerBody()?['record']?['NumberOfTesters']`
  - TestHours = `triggerBody()?['record']?['TestHours']`
  - FailedReason = `triggerBody()?['record']?['FailedReason']`
  - BlockedReason = `triggerBody()?['record']?['BlockedReason']`
  - Notes = `triggerBody()?['record']?['Notes']`

**Action B — Update TestItems status**
- Connector: **Excel Online (Business)** → **Update a row**
- File: same xlsm
- Table: `tblTestItems`
- Key Column: `TestID`
- Key Value: `triggerBody()?['statusUpdate']?['TestID']`
- Map fields:
  - Status = `triggerBody()?['statusUpdate']?['NewStatus']`
  - CompletedBy = `triggerBody()?['statusUpdate']?['CompletedBy']`
  - CompletedDate = `triggerBody()?['statusUpdate']?['CompletedDate']`

### Case 2: `DelayLog`

Inside this case:

**Action — Add row to DelayLog**
- Connector: **Excel Online (Business)** → **Add a row into a table**
- File: same xlsm
- Table: `tblDelayLog`
- Map fields (use Dynamic content):
  - LogID = `triggerBody()?['record']?['LogID']`
  - LogDate = `triggerBody()?['record']?['LogDate']`
  - Location = `triggerBody()?['record']?['Location']`
  - Subsystem = `triggerBody()?['record']?['Subsystem']`
  - SubmittedBy = `triggerBody()?['record']?['SubmittedBy']`
  - SubmittedAt = `triggerBody()?['record']?['SubmittedAt']`
  - "#ofTesters" = `triggerBody()?['record']?['NumberOfTesters']`
  - IdleHours = `triggerBody()?['record']?['IdleHours']`
  - TotalTestsLogged = `triggerBody()?['record']?['TotalTestsLogged']`
  - TotalPassed = `triggerBody()?['record']?['TotalPassed']`
  - TotalFailed = `triggerBody()?['record']?['TotalFailed']`
  - TotalPartial = `triggerBody()?['record']?['TotalPartial']`
  - TotalBlocked = `triggerBody()?['record']?['TotalBlocked']`
  - DelayOccurred = `triggerBody()?['record']?['DelayOccurred']`
  - DelayCategory = `triggerBody()?['record']?['DelayCategory']`
  - DelayDuration = `triggerBody()?['record']?['DelayDuration']`
  - DelayNotes = `triggerBody()?['record']?['DelayNotes']`
  - OverallNotes = `triggerBody()?['record']?['OverallNotes']`
  - NextDayPlan = `triggerBody()?['record']?['NextDayPlan']`

---

## Step 4: Save & Copy the URL

1. Click **Save**
2. Click on the trigger box again
3. Copy the value in **HTTP POST URL**

---

## Step 5: Paste URL into the Portal

1. Open `data.js` in any text editor
2. Find the line:
   ```js
   webhookUrl: "",
   ```
3. Paste your URL between the quotes:
   ```js
   webhookUrl: "https://prod-XX.westus.logic.azure.com:443/workflows/...",
   ```
4. Save
5. Upload updated `data.js` to GitHub

---

## Step 6: Test It

1. Open the portal → Field Log → Sign in (Alex Khoury / 1234)
2. Submit a test result
3. Check Power Automate run history → should be green
4. Open `TestPlan_Master.xlsm` in OneDrive → verify:
   - New row in TestResults sheet
   - TestItems Status updated for that TestID

---

## Troubleshooting

**"CORS error" in browser console**
- Power Automate webhooks accept any origin by default — should work
- If you see CORS error, double-check the URL was copied correctly

**Excel "row not found" error**
- The TestID submitted doesn't exist in the table
- Check that TestItems table is named exactly `tblTestItems`

**Submissions go through but Excel doesn't update**
- Make sure the file is in OneDrive for Business, not personal OneDrive
- Make sure you formatted the sheets as Tables (Step 1)

---

Need help? Send screenshots of any errors and Claude can debug step-by-step.
