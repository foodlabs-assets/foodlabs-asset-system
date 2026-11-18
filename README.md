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

## First-time setup

1. Create the Google Sheet on the owner account; open Extensions > Apps Script; paste `backend/Code.gs`.
2. Run `setup` once and approve the permissions. It stores the OAuth client ID and makes the owner the bootstrap admin.
3. Deploy > New deployment > Web app; execute as Me; access Anyone. Copy the `/exec` URL into `app/config.js` (`backendUrl`).
4. Push. The Pages workflow publishes `app/` and renders the PNG icons.

## Moving to a dedicated account later

Transfer the sheet (with its bound script) to the new owner, redeploy the web app from that account, update `backendUrl`, re-run `setup` if needed. Labels hold only the asset code, so printed labels keep working.

## Tests

- `node test/backend.test.js` runs `Code.gs` against in-memory mocks of the Apps Script services.
- `python3 test/ui_test.py` runs the front end in headless Chrome against a local mock backend that executes the real `Code.gs`.

## Phases

1. Foundation: sheet schema, backend, Google sign-in, roles, admin page. Done.
2. Initial count and labels: label stock and printing, count-team registration, matching against the old register.
3. Operations: scan and search, maintenance, transfers, fast stock count, notifications.
4. Accounting: depreciation, Xero journals, disposals.
5. Dashboard.
