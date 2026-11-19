# Foodlabs Asset System

Fixed asset management for Foodlabs: a mobile-first web app for scanning, maintenance, transfers and stock counts, a separate dashboard, and an accounting register with depreciation and Xero journals. Requirements live in the project doc "Foodlabs Asset Management System — Requirements".

## How it fits together

| Part | Where | Notes |
| --- | --- | --- |
| Front end | `app/`, served by GitHub Pages at https://foodlabs-assets.github.io/foodlabs-asset-system/ | Plain HTML/CSS/JS, no build step. Installable to the home screen. |
| Backend | `backend/Code.gs`, an Apps Script project bound to the data spreadsheet | Deployed as a web app: execute as owner, access Anyone. Every request is checked in code. |
| Data | Google Sheet owned by the Foodlabs account | A log only. Sheets carry a warning-only protection; nobody edits by hand. |
| Sign-in | Google Identity Services, OAuth client in Cloud project `foodlabs-asset-system` (audience Internal) | Only company Google accounts can sign in; only users listed in the Users sheet get in. |

## Security model

- No secrets in this repository. The OAuth client ID and backend URL are public by design.
- Each request carries a Google ID token. The backend checks it with Google (audience, issuer, expiry, verified email), caches the result until expiry, then looks the email up in `Users` and checks the role.
- Roles: Admin, Accounting, Management, Manager, Technician, CountTeam. Admin page: Admin and Accounting. Only an Admin can grant or change the Admin role; the last active Admin cannot remove themselves.
- Text written to the sheet is guarded against formula injection.
- Every create and field change is written to `AuditLog`.

## Data tables (phase 1)

`Users`, `Locations`, `Departments`, `Brands`, `Categories`, `Types`, `Settings`, `AuditLog`. Columns are defined once in `SCHEMA` in `Code.gs`; the admin page builds its forms from that definition, so a new column is added there only. `setup()` adds missing sheets and columns without touching data.

## Operations (phase 3)

- **Maintenance** (`Maintenance` sheet, MR-001…): a manager (own locations) or admin/accounting asks from the asset card. The request goes straight to the company technician (the active user with the Technician role). With no technician, it goes to the users marked "Gets maintenance requests when there is no technician" (area and operations managers), who can record the work or pass it on; with none of those either, admins are told. Open → In progress → Work done (technician: work notes and outcome) → Closed (accounting: cost, supplier, invoice number, invoice PDF or photo; an invoice is required when the cost is above 0). Admin and those backup users can reassign; admin or the requester can cancel while open. The asset is In maintenance while a request is open or in progress and back to Active after. Cost and invoices are visible to finance roles only.
- **Transfers** (`Transfers`, TR-001…): the sender asks; the asset stays at the sending location until someone at the receiving location (or admin) scans it and confirms receipt. Then location, department (if chosen) and brand change; the brand becomes the new location's, or none where it has none, and any cost-centre exception is cleared so depreciation follows the new location. A printable transfer form and custody form come from the asset card.
- **Stock counts** (`Counts`, CNT-001…): pick a location (managers: their own; count team and admin: any). The app loads that location's expected list, so each scan beeps at once; scans are saved in batches and kept in the browser until saved. Finishing reports found, missing, found elsewhere and unknown codes, stamps `LastCountAt` on found assets and tells admin and accounting about gaps. Active assets not scanned become **Missing** (not those in maintenance or under review); a missing asset is active again when scanned in any later count or when its location marks it found. Missing assets cannot be moved or sent to maintenance; the home page lists them. Depreciation is not affected: write-off is accounting's decision. Export to Excel from the report.
- **Notifications** (`Notifications`): in-app bell, refreshed every two minutes. Admin > E-mail alerts (`NotificationTypes`) switches e-mail on per alert; seeded on for a new maintenance request, a reassigned request, an asset waiting for receipt and a count with gaps. Mail goes from the owner account; after deploying, run `testEmail` once in the editor to grant the mail permission. A failed mail never blocks the action. Periodic maintenance, warranty alerts and count reminders need scheduled jobs; they come next.
- **Search**: by asset code, name, serial number or model; MR-/TR-/CNT- numbers open the record.

## First-time setup

1. Create the Google Sheet on the owner account; open Extensions > Apps Script; paste `backend/Code.gs`.
2. Run `setup` once and approve the permissions. It stores the OAuth client ID and makes the owner the bootstrap admin.
3. Deploy > New deployment > Web app; execute as Me; access Anyone. Copy the `/exec` URL into `app/config.js` (`backendUrl`).
4. Push. The Pages workflow publishes `app/` and renders the PNG icons.

## Moving to a dedicated account later

Transfer the sheet (with its bound script) to the new owner, redeploy the web app from that account, update `backendUrl`, re-run `setup` if needed. Labels hold only the asset code, so printed labels keep working.

## Tests

- `node test/backend.test.js` runs `Code.gs` against in-memory mocks of the Apps Script services.
- `node test/phase3.test.js` covers maintenance, transfers, counts, notifications and search.
- `python3 test/ui_test.py` and `python3 test/ui_phase3.py` run the front end in headless Chrome against a local mock backend that executes the real `Code.gs`.

## Phases

1. Foundation: sheet schema, backend, Google sign-in, roles, admin page. Done.
2. Initial count and labels: label stock and printing, count-team registration, matching against the old register. Done.
3. Operations: scan and search, maintenance, transfers, fast stock count, notifications. In-app part done; e-mail and scheduled jobs next.
4. Accounting: depreciation, Xero journals, disposals.
5. Dashboard.
