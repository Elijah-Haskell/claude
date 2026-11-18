# Lawdesk

Practice management for a single Kansas law firm, built to replace Clio piece by piece.
The task and workflow engine comes first because it is the firm's main complaint about Clio,
and it can run alongside Clio while the rest is built.

**Not ready for real client data.** There is no sign-in yet and no hosting setup. Use made-up data only.

## Running

Needs Node 22.18 or newer and nothing else: TypeScript runs directly on Node, and the database is
Node's built-in SQLite. There are no npm dependencies, on purpose.

```
npm test                 # all tests (no dependencies)
npm run seed             # load fictional demo data into lawdesk.db (-- --reset to wipe it first)
npm start                # web app on http://localhost:3000
npm run test:browser     # headless click-through + screenshots (needs Playwright + Chromium installed globally)
```

Settings: `PORT` (default 3000), `LAWDESK_DB` (default `lawdesk.db`), `HOST` (default `127.0.0.1`;
there is no sign-in, so keep it on the local machine). The app's "Working as" picker sends the chosen
person in an `X-Lawdesk-User` header so the activity log can name them; that is attribution, not security.

Email is off by default: messages are saved as `.eml` files in `mail-out/` until a mail server is set
in Settings > Email. See `src/email/README.md` for the settings, environment variables and OAuth setup.

Documents: files are stored by content hash under `LAWDESK_FILES` (default `./files`); the largest
file accepted is `LAWDESK_MAX_UPLOAD_BYTES` (default 25 MiB). Files travel as bytes: upload with
`POST /api/matters/:id/documents/upload?name=<file name>` (raw body, or multipart/form-data), download
with `GET /api/documents/:id/file` (attachment; `?inline=1` shows PDFs and images; `?version=n`).
A route marked `raw: true` in `src/http.ts` gets the unread request stream as `ctx.req`.
Importing from Clio (Settings > Import from Clio): CSV files work with no set-up; reading straight from the
Clio API needs `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, `CLIO_TOKEN_KEY` and optionally `CLIO_REGION`.
See `docs/clio-import.md`.

In the app, press `?` for keyboard shortcuts. Quick-add understands dates (`fri`, `tomorrow`, `11/20`,
`in 3 days`, `+5bd`), `@person`, `#matter-number` and `!high`.

Billing (the Billing menu) covers time by week with a timer that keeps running across pages,
expenses, invoices (draft, write down, discount, finalize, print or save as PDF, void), payments
spread over several invoices with any remainder kept as client credit, client statements and
billing settings. The matter page has a Billing card, and a task's ⋯ menu has "Log time".
The screens live in `public/js/billing/` with their styles in `public/css/billing.css`.

The demo data (`src/seed.ts`) is made up: every client is marked "(demo)", and its checklists are
office workflow steps, not statements of law.

## Layout and rules for contributors

- `src/db.ts` core schema (users, contacts, matters, tasks, checklists, automations, activity log).
- `src/engine.ts` the task and workflow engine. All changes to tasks and matters go through it.
- `src/dates.ts` date helpers. Dates are `YYYY-MM-DD` strings; "today" is in America/Chicago.
- `src/http.ts` the route contract every module uses.
- A module lives in `src/<module>/`: `schema.ts` exports `SCHEMA` (SQL, `CREATE TABLE IF NOT EXISTS`,
  table names prefixed with the module name where they could clash), logic in its own files,
  `routes.ts` exports `routes: Route[]`. Tests go in `tests/<module>/`.
- Money is integer cents. Never floats.
- Every change that matters to a lawyer is written to the `activity` table with who and when.
- Never commit real client data.
- Any statement of law (a statute, a court rule, a bar rule) in code or docs cites its source.

## Intake (leads, web forms, consultation booking)

`src/intake/` tracks people who contact the firm before they are clients: a pipeline (New, Contacted,
Consultation scheduled, Engagement sent, Hired, Not hired), an automatic conflict check on the lead and
any other parties, follow-up reminders (ordinary tasks for the lead's owner), an engagement letter made
from a document template, and "Convert to client" (contact + matter + linked conflict check + history).

Public pages, no sign-in: `/intake/form.html?f=<form link>` and `/intake/book.html?b=<booking link>`
(add `&lead=<lead link>` for a lead's own booking link). Spam protection is a hidden field, a signed
"form opened at" stamp (a form sent within 3 seconds is refused) and a per-address limit
(5 per 10 minutes, 20 a day). The limit reads the socket address; behind a proxy it needs the
forwarded address instead.

Emails are not sent by intake. They wait in `intake_email_queue`; the email module sends rows from
`dueEmails()` and records the result with `markEmailSent()` (both in `src/intake/leads.ts`). The
e-signature module can set `intakeHooks.sendForSignature` to take over sending engagement letters.
