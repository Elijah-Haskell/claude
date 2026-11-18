# Importing from Clio Manage

Settings > Import from Clio brings a firm's records over from Clio Manage in two ways:

1. **Files.** Export CSV files from Clio (or fill in Clio's migration templates) and upload them one at a
   time: contacts, then matters, then tasks, calendar, time entries and expense entries. Each upload shows
   how the columns were matched, lets you change any of them, checks every row, offers a trial run that
   saves nothing, and then imports.
2. **The Clio API.** With a one-time set-up (below), Lawdesk reads people, contacts, matters, tasks,
   calendar entries and activities (time and expenses) straight from Clio, page by page, keeping to Clio's
   request limit. It can be paused, and it carries on where it stopped after an interruption.

Either way, every imported record is remembered in `clio_import_map` (Clio ID or, for files without IDs, a
name/number key → Lawdesk ID), so **importing again updates records instead of adding copies**. Records the
firm already typed into Lawdesk are matched too (same contact name, same matter number).

After each import there is a **reconciliation report**: added / updated / unchanged / skipped per type, the
hours and amounts of unbilled, non-billable and already-billed time and expenses, Clio's own stated totals,
people/clients/practice areas that had to be added, and every skipped row with the reason (downloadable as
CSV). The page also shows running totals of everything that has come over, to check against Clio's reports.

## What goes where

| Clio | Lawdesk |
| --- | --- |
| Contact (person / company) | `contacts` (name, kind, email, phone). Title, job title, employer, other email/phone and address go into the contact's notes, in a "From Clio" block that is replaced on re-import; the firm's own notes are kept. |
| Matter | `matters`. Clio's *description* is the matter name; *display/custom number* is the number. Open and Pending → open (Pending noted in the description); Closed → closed with the close date. Location, client reference and notes go into the description. Practice area matched by name (added if missing). Responsible attorney → the matter's `attorney` role; originating attorney → `originating attorney` role. **Automatic steps do not run** for imported matters (they would add new-matter checklists to old files). |
| Task | `tasks` through the task engine. Complete → done with Clio's completion date. Clio's "in progress"/"in review" are noted in the task details (Lawdesk has no such status). |
| Calendar entry | `cal_events` (kind "other", source `clio_import`). Times are read as the firm's time zone (America/Chicago). |
| Unbilled time / expense | `billing_time_entries` / `billing_expenses`, ready to bill, with Clio's rate, billable flag and codes. |
| Billed time / expense | `clio_import_billed` — **history only**. Lawdesk has no invoice to attach them to, and putting them in the billing tables would let them be billed a second time. If Clio bills an entry after it was imported, re-importing moves it to history (unless it is already on a Lawdesk invoice, which is never touched). Entries on a Clio *draft* bill are imported as unbilled, with a note. |
| Trust balances | **Report only** (`clio_import_trust_balances`). Nothing is posted to trust: opening trust balances must be reconciled and signed off by the firm's accountant and then entered in the trust module. |

People named in Clio (responsible attorney, timekeeper, assignee) who are not in Lawdesk are added under
Settings > People and listed in the report (this can be turned off per import via `createMissingPeople: false`).

Rows that are skipped, with the reason shown: no name, a date or time that isn't real, an unknown status,
a matter that isn't in Lawdesk yet, a negative amount (credit/refund — enter by hand), time over 24 hours on
one entry (Lawdesk's billing limit), a matter number already used by a different matter.

## How it is built

- `src/clio_import/csv.ts` — RFC 4180 reader (quotes, doubled quotes, embedded line breaks, BOM, CRLF/LF/CR,
  blank rows), no dependencies.
- `fields.ts` — the Lawdesk fields for each kind of file and the headings that select them automatically.
- `normalize.ts`, `values.ts` — CSV row → import record; dates (MM/DD/YYYY or day-first, ISO), times
  (H:MM:SS AM/PM), money to integer cents without floating point, hours to minutes.
- `api.ts` — OAuth 2 client, encrypted token storage, rate-limit pacer, retries. `api_map.ts` — API JSON →
  import records and the field list per resource. `api_job.ts` — the resumable job.
- `importer.ts` — writes records: one transaction per batch (default 250 rows), a savepoint per row so one bad
  row is skipped without losing its batch; a trial run does the same work inside a transaction and rolls it
  back. `report.ts` — the report and the running reconciliation.
- Tests: `tests/clio_import/` against fictional fixture files in Clio's layouts and a fake Clio server
  (`fake_clio.ts`) that mimics the documented OAuth, paging and rate-limit behaviour.

## Setting up the API connection

1. In Clio's developer portal, create an application (Clio: "Create a Developer Application",
   https://docs.developers.clio.com/api-docs/clio-manage/applications/). Set its redirect URI to
   `http://localhost:3000/api/clio-import/oauth/callback` (or wherever Lawdesk runs), and give it read access
   to contacts, matters, tasks, calendars, activities and users.
2. Start Lawdesk with:
   - `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET` — from the application.
   - `CLIO_TOKEN_KEY` — any long random secret; the Clio tokens are stored encrypted with it (AES-256-GCM).
     Without it they are stored unencrypted and the screen warns. Clio says refresh tokens don't expire and
     must be stored securely, so set this.
   - `CLIO_REGION` — `us` (default), `eu`, `ca` or `au`, matching the firm's Clio account.
   - `CLIO_REDIRECT_URI` — only if it differs from the default above.
3. Settings > Import from Clio > Connect to Clio, sign in as a Clio administrator, then Start import.

## Sources (what Clio documents) and what could not be verified

All pages were read on 2026-11-18.

**Exports from Clio**

- Bulk export page with "Excel ready CSV" per type — calendar entries, communications, contact notes, contact
  related matters, contacts, expense entries, matter notes, matters, tasks, time entries; administrators
  only; outstanding balances from the Accounts Receivable report as CSV; trust balances from the trust
  report. https://help.clio.com/hc/en-us/articles/50633368921243
- Contacts list export: CSV with "every column from the contacts table or only the columns currently
  displayed"; includes custom fields; billing preferences excluded.
  https://help.clio.com/hc/articles/9290532034843
- Matters list export: CSV with all or only visible columns. https://help.clio.com/hc/articles/55326718151195
- Step-by-step exports used by other vendors' migration guides (unbilled time and expenses filtered by
  Invoice Status = Unbilled; trust balances from the "Client Account Management"/trust report with columns
  "Client, Matter, Client account balance"; unpaid bills): https://support.smokeball.com/hc/en-gb/articles/23226770714647-Exporting-data-from-Clio
  and https://support.casefox.com/support/solutions/articles/17000128331-how-to-export-data-from-clio
- Documents are downloaded from Clio's Documents screen (select, Download), or through the API:
  `GET /api/v4/documents/{id}/download.json` answers 303 to the file
  (https://www.withone.ai/knowledge/clio/conn_mod_def%3A%3AGLeonZN0EnA%3A%3AODK4gN_MRJitg7NEywKXKw/md, a
  mirror of Clio's API reference). **Document import is not built** (see gaps).

**Column names — verified (Clio's migration templates)**

https://help.clio.com/hc/en-au/articles/9228623050139-Migration-Templates-for-Importing-Into-Clio,
https://help.clio.com/hc/articles/50600879151003 (contacts),
https://help.clio.com/hc/en-us/articles/50631241830683/ (matters):

- Contacts: `Title, job_title, first_name, last_name, Company, business_street, business_city,
  business_state, business_postal_code, email_address, primary_phone` (company contact when first/last are blank).
- Matters: `status` (Open, Closed, Pending), `location, client_reference, description, open_date, close_date,
  pending_date, custom_number, note, client_first_name, client_last_name, client_company_name,
  responsible_attorney, practice_area`. Dates MM/DD/YYYY.
- Tasks: `subject, due_date, complete` (1/0), `description, matter`.
- Activities (time and expenses in one file): `matter, date, activity_description, note, price, quantity`
  (decimal hours), `type` (TimeEntry / ExpenseEntry), `activity_user, non_billable, utbms_activity_code,
  utbms_task_code, utbms_expense_code`, plus for expenses `expense_type` (SoftCostEntry / HardCostEntry),
  `vendor_name, reference`.
- Calendar: `start_date, end_date, start_time, end_time` (H:MM:SS AM/PM), `subject, matter, location,
  description`; all-day entries still carry times (12:00 PM suggested for both), which is why an entry whose
  start and end times are the same is imported as all-day.

**Column names — NOT verified.** Clio does not publish the column list of its "Excel ready CSV" exports or
of its list-screen exports (the export lets the user choose columns). The export-style headings Lawdesk
recognises ("Display Number", "Responsible Attorney", "Bill Number", "Trust balance"...) are guesses based on
Clio's screen labels and API field names. That is why every column can be matched by hand on the mapping
step; an unrecognised heading is never an error. Please check the mapping step on the firm's real files the
first time and tell the developers which headings needed fixing, so they can be added to `fields.ts`.

**Clio Manage API v4**

- OAuth 2 authorization-code flow: `GET https://app.clio.com/oauth/authorize` (`response_type=code,
  client_id, redirect_uri, state`); code valid 10 minutes; `POST /oauth/token` form-encoded with
  `grant_type=authorization_code` or `refresh_token`; response `token_type, access_token, expires_in`
  (example 2592000 = 30 days), `refresh_token`; refresh tokens do not expire; `POST /oauth/deauthorize`.
  https://docs.developers.clio.com/api-docs/clio-manage/authorization/ and
  https://developers.support.clio.com/hc/en-us/articles/360005466673-How-long-is-a-refresh-token-valid-for
- Regions: `https://app.clio.com/api/v4`, `https://eu.app.clio.com/api/v4`, `https://ca.app.clio.com/api/v4`,
  `https://au.app.clio.com/api/v4`; tokens only work in their own region.
  https://docs.developers.clio.com/handbook/getting-started/regions/
- Rate limits: per access token; "a default rate limit of 50 requests per minute during peak usage hours";
  headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix time the 60-second window
  ends); `429` with `Retry-After` seconds; limits may change without notice.
  https://docs.developers.clio.com/api-docs/clio-manage/rate-limits/ — Lawdesk assumes 50/min until Clio's
  headers say otherwise, spreads the remaining requests over the window, keeps 2 in hand for people using
  Clio at the same time, and waits out any 429.
- Paging: at most 200 per request; cursor paging needs `order=id(asc)` and no `offset`, has no record
  limit, and is followed through `meta.paging.next` until it is absent (offset paging stops at 10,000).
  https://docs.developers.clio.com/api-docs/clio-manage/paging/
- Fields: only `id` and `etag` come back unless `fields=` lists them; nested resources use
  `matter{id,description}`; one level of nesting; an invalid field gives 400.
  https://docs.developers.clio.com/api-docs/clio-manage/fields/
- Activities: `type` TimeEntry, ExpenseEntry, HardCostEntry, SoftCostEntry, FixedFee; `quantity` is in
  **seconds from API version 4.0.4** (hours before), `quantity_in_hours` also returned; `price` (hourly rate,
  or the expense amount), `total`, `billed`, `non_billable`, `no_charge`, `note`, `matter`, `user`,
  `activity_description`. Matters: `display_number, description, status, open_date, close_date,
  pending_date, location, client_reference`. Users: `name, email, enabled, subscription_type`. Contact:
  `type, name, first_name, last_name, primary_email_address, primary_phone_number, ...`.
  https://docs.developers.clio.com/clio-manage/api-reference/
- Tasks: `name, description, due_at, status` (pending, in_progress, in_review, complete, draft),
  `priority` (High, Normal, Low), `assignee {id, type User|Contact}`, `matter`, `completed_at`
  (https://www.withone.ai/knowledge/clio/conn_mod_def%3A%3AGLeoscpSSsg%3A%3AwjoaG_lUTq-dxkdkBZEuow/md, mirror).
  Contact `email_addresses / phone_numbers / addresses` sub-fields `name, street, city, province, postal_code,
  country` (https://www.withone.ai/knowledge/clio/conn_mod_def%3A%3AGLeolG8yCeg%3A%3A8Q7UVjGWSRGGL0qpmMQMZw/md, mirror).
  Calendar entries `summary, start_at, end_at, all_day, location, description, matter`
  (https://cdn.cdata.com/help/FAM/api/clio/pg_clioviews-calendarentries.htm, a third-party driver's column list).

**API details NOT verified** (could only be read from mirrors or inferred; the field lists are in
`API_RESOURCES` in `src/clio_import/api_map.ts` and can be edited if Clio answers 400):

- `responsible_attorney{id,name}` / `originating_attorney{id,name}` / `practice_area{id,name}` / `client{...}`
  as nested fields on matters (the migration template and screens use these names).
- `addresses{...}` as a nested field on contacts in list responses.
- Whether `GET /calendar_entries.json` needs a calendar filter to return every calendar, and whether an
  all-day entry's `end_at` is the midnight after its last day (Lawdesk assumes so, as in iCalendar).
- Whether `/activities.json` lists billed activities by default (if not, add `status` filtering).
- Behaviour of the real Clio could not be tested from here: the API importer is tested only against the fake
  server in `tests/clio_import/fake_clio.ts`, built from the documentation above.

## Gaps (not built yet)

- **Documents** are not imported (neither from a download nor through the API).
- Notes, communications, contact relationships, custom fields, bills/invoices and payments are not
  imported. Unpaid Clio bills should be brought over as opening receivables by the billing module once the
  accountant has agreed the balances.
- Contact-to-contact relationships ("Contact related matters") and matter parties are not imported.
- Rates per timekeeper are not set from Clio; each imported entry keeps the rate Clio recorded.
- No undo of a whole import. Use the trial run first; re-importing a corrected file updates in place.
