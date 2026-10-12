# cx Portal on Azure — Information Asset Register

**What this is:** every kind of information the cx Portal holds or handles,
where it is kept, who can reach it, how long it is kept and how it is
recovered or disposed of. **Scope:** the portal as it will run in Hitachi's
Azure tenant. **Status:** taken from the live database on 2026-10-12 (59
tables). **Companion documents:** *cx Portal on Azure — Architecture for
Review* and *cx Portal on Azure — IT Handover*.

---

## 1. At a glance

| | |
|---|---|
| **Contents today** | Test data only. No real project records yet, nothing confidential. |
| **Classification in production** | Confidential (project information); every Azure resource is tagged `dataClassification: Confidential`. To be confirmed against Hitachi's own scheme. |
| **Personal information** | Business contact details only: staff and BART guests' names, work email addresses and company, and the name or email recorded against the records they create or change. Browser type in error reports. No special-category, financial, health or customer personal data. |
| **Where it lives** | One US Azure region: the PostgreSQL database and the storage account. Nothing is kept on any other service. Sign-in identities stay in Hitachi's Microsoft Entra ID. |
| **Who can see what** | Decided inside the database on every request, per module and per action, by each person's permission template (17 modules). Only members of the *CX Portal Users* group can sign in at all. |
| **Retention** | No automatic deletion. Records are kept for the life of the project unless deleted in the portal; a retention period can be set if policy requires one (see 4). |
| **Backup** | Database: point-in-time restore for 35 days (geo-redundant in production). Files: 30-day soft delete. |

---

## 2. Information held by the portal

Owner for every row: the BART CBTC testing and commissioning project
(business owner, to be named); Hitachi IT as custodian of the hosting. Stored
in the PostgreSQL database unless the row says otherwise. "Signed-in users"
means members of *CX Portal Users*; "per permission" means the module rights in
the person's permission template.

| # | Asset | What it contains | Personal information | Who can read / change | Retention |
|---|---|---|---|---|---|
| IA-01 | **People directory** (`profiles`, `user_column_prefs`) | Each user's name, work email, company, subsystem, active flag, permission template; personal table-column preferences | Name, work email, company | All signed-in users read the directory; Directory administrators add, change, deactivate and remove people. Column preferences: the person only | While the person uses the portal; removed or deactivated by an administrator |
| IA-02 | **Permissions** (`permission_templates`, `template_module_perms`, `user_module_overrides`, `perm_modules`) | Named permission templates, their rights per module, per-person overrides, the module catalogue | Which person has which override | Templates and module catalogue: all signed-in users can read. Per-person overrides: the person and administrators. Change: Admin module only | Life of the project |
| IA-03 | **Test register** (`test_items`, `test_procedures`, `test_item_prerequisites`, `test_item_status_history`, `activity_records`, `templates`) | Test cases, procedures, prerequisites, status history, activity records and activity templates | Name of who completed or changed an item | Per permission (Test Register, Templates) | Life of the project |
| IA-04 | **Weights and progress** (`activity_weights`, `test_case_weights`) | Weightings used for progress reporting | None | Read: all signed-in users. Change: per permission (Weights) | Life of the project |
| IA-05 | **Test reporting** (`test_results`, `test_reports`, `delay_log`) | Test results, test reports, delay entries | Name of who submitted or completed | Per permission (Test Reports) | Life of the project |
| IA-06 | **Dynamic testing and track access** (`dynamic_instances`, `train_requests`, `zone_access_windows`, `zone_adjacency`, `access_campaigns`) | Dynamic test runs, train requests, track zone access windows and layout | Name of who created an entry | Per permission (Dynamic Testing) | Life of the project |
| IA-07 | **Punch list** (`punch_items`, `punch_templates`, `punch_custom_fields`) | Defects and actions, templates, custom fields | Names of who raised, is assigned, and closed | Per permission (Punch List) | Life of the project |
| IA-08 | **RMA** (`rmas`) | Return-material authorisations | Name and work email of who raised it | Per permission (RMA) | Life of the project |
| IA-09 | **Forms** (`forms`, `form_template_links`, `form_test_item_links`, `fieldset_config`) + files in the `forms` storage container | Completed forms and their links to tests; form field settings; form PDFs | Name of who created or changed | Per permission (Forms) | Life of the project |
| IA-10 | **Photos** (`photos`, `photo_albums`, `photo_album_items`) + files in the `photos` container | Site photos with caption, location and subsystem; albums | Uploader's name and account id; album creator | Per permission (Photos); "own" rights follow the uploader's account id | Life of the project |
| IA-11 | **Drawings and documents** (`drawing_sets`, `drawing_sheets`, `drawing_markups`, `documents`, `document_folders`, `document_versions`) + files in the `drawings` and `documents` containers | Drawing sets and sheets, markups, controlled documents and versions | Name of uploader or markup author | Per permission (Drawings) | Life of the project |
| IA-12 | **Vehicle and equipment records** (`vehicles`, `vehicle_events`, `vehicle_equipment`, `vehicle_equipment_templates`, `vehicle_checklist_items`, `vehicle_checklist_tpl_items`, `vehicle_workflow_items`, `vehicle_workflow_templates`, `vehicle_files`, `form_vehicle_item_links`, `sw_equipment`, `sw_deployments`, `software_configs`) + files in the `vehicle-files` container | Vehicle status, events, checklists, workflows, installed equipment and software versions | Name of who completed or recorded | Per permission (Vehicle Management, Configuration) | Life of the project |
| IA-13 | **Locations** (`locations`) | Sites, phases and locations used across modules | None | Read: all signed-in users. Change: per permission (Locations) | Life of the project |
| IA-14 | **Change log** (`db_change_log`) | Every change to the main records: table, record, who, when, which columns changed, old and new values | Name and work email of who made each change | Read: Audit module only. Written only by the database; nobody can edit it from the portal | Kept indefinitely; about 21 MB today |
| IA-15 | **Sign-in and privilege trail** (`auth_events`, `access_review_log`) | Privilege changes (role, template, active), account links to Microsoft, periodic access reviews | Work email of the person concerned and the reviewer | Read: Audit module only. Written only by the database | Kept indefinitely |
| IA-16 | **Activity log** (`audit_log`) | User actions recorded by the portal (create, update, delete, status change) | User name | Read: Audit module only | Kept indefinitely |
| IA-17 | **Error reports** (`client_errors`) | Script errors the portal reports from the browser, to diagnose faults | Work email and browser type of the person who hit the error | Write: the signed-in person, for their own errors. Read and delete: Audit module only | Kept indefinitely; a 90-day limit is recommended |
| IA-18 | **Demo tooling** (`demo_seed_log`) | Bookkeeping for demonstration data (empty) | None | Global administrators only | Empty; can be dropped |

---

## 3. Supporting information

| # | Asset | What it contains | Where it lives | Protection | Retention / disposal |
|---|---|---|---|---|---|
| SA-01 | **Identities** | Accounts of staff and BART guests, MFA, group membership | Microsoft Entra ID (Hitachi's tenant), not in the portal | Hitachi's identity controls: Conditional Access, assignment required | Hitachi's identity lifecycle. The portal never stores a password |
| SA-02 | **Source code and configuration** | The application code, infrastructure template, database scripts, documents | The repository (Git) | No secrets, keys or personal data in it. The website's settings (addresses and ids) are public by nature | Kept with the repository |
| SA-03 | **Website package** | The built website deployed to Static Web Apps | Azure Static Web Apps | Static files only; no secrets | Replaced at each update |
| SA-04 | **Secrets** | Database administrator password; gateway connection string with its password; Static Web Apps deployment token | Azure Key Vault; a Container Apps secret; a pipeline secret if a pipeline is used | Not readable with Reader access; held by IT only. No client secret, storage key or API key exists | Rotated by IT as policy requires |
| SA-05 | **Sign-in signing keys** | Microsoft's public keys, used to check sign-in tokens | The database (refreshed every 6 hours) | Public keys, not secret | Replaced automatically |
| SA-06 | **Operational logs** | Gateway request and error logs | Azure Log Analytics | Azure role-based access | 400 days (production) |
| SA-07 | **Backups** | Database point-in-time backups; soft-deleted files | Azure (managed by the database and storage services) | Encrypted at rest by Azure | 35 days (database); 30 days (files) |
| SA-08 | **Migration backup file** | The one-off export of the old database used to set up Azure (`cxportal.sql`) | Handed from the developer to IT once | Test data only today; sent through Hitachi's usual file sharing | Deleted by both sides once the restore is checked |
| SA-09 | **Data held on devices** | Sign-in tokens (expire within about an hour, renewed silently); the cached website; files a person opened, kept for offline use | The person's browser (laptop, field tablet) | Tokens expire; files only from what the person could already see | Tokens: until sign-out or expiry. Offline files stay after sign-out unless cleared (open decision on shared tablets) |

---

## 4. Handling and open points

- **Access** is granted only by membership of *CX Portal Users* in Entra and
  by the person's permission template in the portal; both are changed from the
  portal's Directory screen and recorded in the audit trails (IA-14, IA-15) and
  in Entra's audit log.
- **Encryption:** HTTPS for everything in transit; database requires TLS 1.2
  or later; database, backups and files encrypted at rest by Azure.
- **Residency:** one US region; geo-redundant backups stay in the paired US
  region.
- **Disposal:** records deleted in the portal are gone from the database at
  once and from backups within 35 days; files after the 30-day soft delete.
  Decommissioning the portal means deleting its Azure resource group.
- **Open points for the review:**
  1. a retention period for the audit trails and error reports (IA-14 to IA-17),
     if Hitachi policy sets one;
  2. whether offline files are cleared at sign-out on shared tablets (SA-09);
  3. the named business owner for the information assets.
