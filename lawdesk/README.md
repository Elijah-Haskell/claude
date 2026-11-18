# Lawdesk

Practice management for a single Kansas law firm, built to replace Clio piece by piece.
The task and workflow engine comes first because it is the firm's main complaint about Clio,
and it can run alongside Clio while the rest is built.

**Not ready for real client data.** Sign-in exists, but there is no hosting setup or backup yet. Use made-up data only.

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
keep it on the local machine until it sits behind https), `LAWDESK_SECURE_COOKIES=1` (mark the session
cookie Secure; use it whenever the app is served over https), `LAWDESK_TRUST_PROXY=1` (behind a reverse
proxy: read the caller's address from `X-Forwarded-For` and https from `X-Forwarded-Proto`).

## Signing in

The first time the app opens on an empty database it asks for the first administrator's name, email and
password. Alternatively: `npm run create-admin -- --email you@firm.com --name "Your Name"` (asks for the
password; `--reset` gives an existing account a temporary password and administrator access, and turns off
two-step sign-in, for when the only administrator is locked out). `npm run seed` creates demo accounts
for the four demo people and prints their shared, published demo password.

- Passwords: scrypt with a per-password salt (node:crypto); at least 12 characters.
- Sessions: a random 32-byte token in an HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored.
  Signed out after 8 hours idle or 24 hours after signing in. My account lists devices and can sign
  them out.
- Five wrong passwords lock the account for 15 minutes (an administrator can unlock it); twenty failures
  from one address in 15 minutes are refused.
- Optional two-step sign-in with an authenticator app (TOTP, RFC 6238) plus ten one-time recovery codes.
- Administrators set temporary passwords (the person must choose their own at next sign-in).
  `createResetToken(db, userId)` in `src/auth/accounts.ts` makes a one-time reset link
  (`/#/reset/<token>`, 24 hours) for the email module to send.
- Every POST/PATCH/PUT/DELETE must carry `X-Requested-With: lawdesk` (api.js sends it), so another site
  can't make changes with the firm's cookies.
- Sign-ins, failures, lockouts, password changes and resets, two-step changes, access-level changes and
  matter restrictions are written to the activity log (kinds starting `auth_`, and `matter_access_changed`).

### Permissions, for module authors

Every `/api` route needs a signed-in admin, attorney or staff account. The server checks this before the
handler runs (`src/auth/guard.ts`); `ctx.userId` and `ctx.role` are the signed-in person. On a route:

- `roles: ADMIN` (or `ATTORNEYS`, `STAFF`, `CLIENT_PORTAL` from `src/auth/access.ts`) limits who may call it.
  Firm settings (people, practice areas, stages, date fields, closed days, automations) are `ADMIN`.
- `public: true` opens it without signing in. Only for sign-in screens and URLs whose token is their own
  secret (the calendar `.ics` feed).
- `csrf: false` skips the header check; only for public webhooks that verify their own signature.
- The `client` role (future client portal) reaches only routes that list it in `roles`.

Matters can be restricted to named people (`PUT /api/matters/:id/access {userIds}`; an empty list lifts
it). Admins always see every matter. Anything that belongs to a matter must check before returning or
changing it:

```ts
import { assertCanSeeMatter, canSeeMatter, filterVisible } from "../auth/access.ts";
assertCanSeeMatter(ctx.db, ctx.userId, matterId);         // throws 404 "Matter not found"
const rows = filterVisible(ctx.db, ctx.userId, rows);      // drops rows whose matter_id is hidden
if (!canSeeMatter(ctx.db, ctx.userId, matterId)) { ... }   // plain yes/no
```

The tasks routes (matters, tasks, My tasks, Firm tasks, activity) already do this; billing, documents,
calendar, conflicts and the rest should adopt it.

Quick-add understands dates (`fri`, `tomorrow`, `11/20`,
`in 3 days`, `+5bd`), `@person`, `#matter-number` and `!high`.

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
