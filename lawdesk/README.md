# Lawdesk

Practice management for a single Kansas law firm, built to replace Clio piece by piece.
The task and workflow engine comes first because it is the firm's main complaint about Clio,
and it can run alongside Clio while the rest is built.

**Not ready for real client data.** There is no sign-in yet and no hosting setup. Use made-up data only.

## Running

Needs Node 22.18 or newer and nothing else: TypeScript runs directly on Node, and the database is
Node's built-in SQLite. There are no npm dependencies, on purpose.

```
npm test        # all tests
npm start       # web app on http://localhost:3000 (once src/server.ts exists)
```

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
