# cx Portal on Azure — Information Asset Register

**What this is:** every kind of information the cx Portal holds or handles,
where it is kept, how access to it is controlled, how long it is kept and how
it is recovered or disposed of. **Scope:** the portal as it will run in
Hitachi's Azure tenant. **Status:** taken from the live database on 2026-10-12.
**Information asset owner:** Alex Khoury, cx Portal application owner, BART
CBTC testing and commissioning (proposed). **Custodian of the hosting:**
Hitachi IT. **Companion documents:** *cx Portal on Azure — Architecture for
Review* and *cx Portal on Azure — IT Handover*.

---

## 1. At a glance

| | |
|---|---|
| **Contents today** | Test data only. No real project records yet, nothing confidential. |
| **Classification in production** | Confidential (project information); every Azure resource is tagged `dataClassification: Confidential`. To be confirmed against Hitachi's own scheme. |
| **Personal information** | Business contact details only: staff and BART guests' names, work email addresses and company, and the name recorded against the records they create or change. Browser type in error reports. No special-category, financial, health or customer personal data. |
| **Where it lives** | One US Azure region: the PostgreSQL database and the storage account. Sign-in identities stay in Hitachi's Microsoft Entra ID. |
| **How access is controlled** | By the portal's permission model, enforced inside the database on every request (section 2). Only members of the *CX Portal Users* group can sign in at all. |
| **Retention** | No automatic deletion. Records are kept for the life of the project unless deleted in the portal; a retention period can be set if policy requires one (section 5). |
| **Backup** | Database: point-in-time restore for 35 days (geo-redundant in production). Files: 30-day soft delete. |

---

## 2. How access is controlled

Every area of the portal is a **module** (Test Register, Punch List, Photos,
Directory, Audit and so on, 17 in all). Each module has its own permissions:
an access level (none, read-only, standard, admin) plus specific actions such
as create, edit, close, delete or export.

Portal administrators decide who gets what, in the portal, through
**permission templates** (for example "Field Engineer" or "BART Reviewer"),
with optional overrides for one person. The database enforces those
permissions on every request, so going around the website gains nothing.
Someone with no permission on a module sees none of its information.

The templates for each type of user are still being finalised. This register
therefore names **which module's permissions govern each asset**, not who
holds them today.

**Shared reference data.** A small amount of information is visible to every
signed-in user because all modules use it: people's **names and roles** (for
"assigned to" and similar fields; not their email or company), the list of
locations, progress weights, form field settings and track layout, and the permission template
definitions (so each person's own rights can be worked out).

---

## 3. Information held by the portal

All in the PostgreSQL database; files in the storage account where noted.

| # | Asset | What it contains | Personal information | Access governed by | Retention |
|---|---|---|---|---|---|
| IA-01 | **People and permissions** | The directory of users (name, work email, company, role, status); permission templates and per-person overrides; each person's display preferences | Name, work email, company | **Directory** and **Admin** module permissions. Each person can see their own profile and preferences | While the person uses the portal; removed or deactivated by an administrator |
| IA-02 | **Testing records** | Test register (test cases, procedures, prerequisites, status history, activity records and templates), weights, test results and reports, delay log, dynamic testing (test runs, train requests, track access windows and campaigns) | Name of who completed, submitted or changed an item | **Test Register**, **Test Reports**, **Dynamic Testing**, **Weights** and **Templates** module permissions | Life of the project |
| IA-03 | **Field records** | Punch list (items, templates, custom fields), RMAs, completed forms and their links; form PDFs in the `forms` file container | Names of who raised, is assigned and closed; RMA author's work email | **Punch List**, **RMA** and **Forms** module permissions | Life of the project |
| IA-04 | **Photos, drawings and documents** | Photos and albums; drawing sets, sheets and markups; controlled documents, folders and versions; the files in the `photos`, `drawings` and `documents` containers | Uploader's or author's name | **Photos** and **Drawings** module permissions. "Own" rights follow the uploader's account | Life of the project |
| IA-05 | **Vehicle and equipment records** | Vehicles, events, checklists, workflows, installed equipment and software versions; files in the `vehicle-files` container | Name of who completed or recorded | **Vehicle Management** and **Configuration** module permissions | Life of the project |
| IA-06 | **Audit trails** | Change log (who changed which record, when, old and new values), sign-in and privilege trail (role, template and status changes, account links), activity log, access reviews, browser error reports | Names and work emails of the people concerned; browser type in error reports | **Audit** module permissions. Written only by the database; nobody can edit them from the portal | Kept indefinitely (change log about 21 MB today) |

---

## 4. Supporting information

| # | Asset | What it contains | Where it lives | Protection | Retention / disposal |
|---|---|---|---|---|---|
| SA-01 | **Identities** | Accounts of staff and BART guests, MFA, group membership | Microsoft Entra ID (Hitachi's tenant), not in the portal | Hitachi's identity controls: Conditional Access, assignment required. Portal administrators add and remove people from the portal, within the one group they own | Hitachi's identity lifecycle. The portal never stores a password |
| SA-02 | **Code, website and configuration** | Application code, infrastructure template, database scripts; the built website | The repository; Azure Static Web Apps | No secrets, keys or personal data. The website's settings (addresses and ids) are public by nature | Kept with the repository; website replaced at each update |
| SA-03 | **Secrets** | Database administrator password; the gateway's database connection; the website deployment token | Azure Key Vault; a Container Apps secret | Not readable with Reader access; held by IT only. No client secret, storage key or API key exists | Rotated by IT as policy requires |
| SA-04 | **Logs and backups** | Gateway request and error logs; database point-in-time backups; soft-deleted files | Azure Log Analytics; the database and storage services | Azure role-based access; encrypted at rest | Logs 400 days; database backups 35 days; files 30 days |
| SA-05 | **Migration file** | The one-off export of the old database used to set up Azure | Handed from the developer to IT once | Test data only today; sent through Hitachi's usual file sharing | Deleted by both sides once the restore is checked |
| SA-06 | **Data held on devices** | Sign-in tokens (expire within about an hour); the cached website; files a person opened, kept for offline use | The person's browser (laptop, field tablet) | Tokens expire; offline files only from what the person could already see | Tokens until sign-out or expiry. Offline files stay after sign-out unless cleared |

---

## 5. Handling and open points

- **Access** is granted only by membership of *CX Portal Users* in Entra and by
  the person's permission template in the portal; both are managed from the
  portal's Directory screen and recorded in the audit trails (IA-06) and in
  Entra's audit log.
- **Encryption:** HTTPS for everything in transit; the database requires TLS
  1.2 or later; database, backups and files encrypted at rest by Azure.
- **Residency:** one US region; geo-redundant backups stay in the paired US
  region.
- **Disposal:** records deleted in the portal leave the database at once and
  its backups within 35 days; files after the 30-day soft delete.
  Decommissioning the portal means deleting its Azure resource group.
- **Open points for the review:**
  1. the permission templates for each type of user (being finalised);
  2. a retention period for the audit trails and error reports (IA-06), if
     Hitachi policy sets one;
  3. whether offline files are cleared at sign-out on shared field tablets
     (SA-06);
  4. confirmation of the information asset owner.
