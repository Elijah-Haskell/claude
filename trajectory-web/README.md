# Trajectory for the web

The Trajectory student planner in the browser: the same app as the iPhone app, on the same server. Sign in with
Apple, your plan saved to your account (and shared with the iPhone app), Trajectory Pro, the AI syllabus reading,
Ask AI, exam prep, study guides, practice exams, test review, course site links and reminders, with the planning
engine the iPhone runs, ported file for file.

This is a separate project from the mobile app: nothing here changes the iPhone app or its server.

## What is here

- **Today**, **Week** (three days, seven days or a month), **Tasks**, **Study** and **Classes**, with the one
  **Replan** sheet (today, this week or the semester, always previewed first, always undoable).
- **Sign in with Apple** on the first screen. A Trajectory account is required (the owner's decision of 5 October
  2026): the plan is saved to the account and comes back on any device, and Trajectory Pro is tied to it.
- **The plan saved to the account**: the app works from its copy in this browser and saves a snapshot to the account
  when the plan has changed; when this browser and the account each hold a plan the other has not seen, the student
  chooses. The rules and the engine are the mobile app's, with their tests.
- **Trajectory Pro** through RevenueCat Web Billing: Monthly, the School Year pass (one payment, 12 months, never
  renews) and the Degree Pass, with the same paywall, the same "Compare Free and Pro", the same Settings row. A
  purchase made in the iPhone app counts here (the server checks the account's entitlement), and the reverse.
- **Syllabus import** against the server: upload a PDF, photos or a .docx, or paste text; the reading runs in the
  background with a live list of the deadlines as they are found; one free syllabus per account, then Pro.
- **Ask AI** (Pro): say what changed or what to add; proposals are previewed and applied with an Undo.
- **Exam prep, study guides, practice exams and test review** (Pro), with the AI content label and report link.
- **Course site link** (Canvas, Moodle, Blackboard, Brightspace): deadlines follow the course site. **Reminders**
  through the browser's notifications while a Trajectory tab is open. **Calendar file** export. The Google Calendar
  section for a connection made before connecting was retired.
- **Settings**: sleep hours, work and activities, study load, course site link, calendar file, backup and restore,
  the account (sign out, delete account), reminders, appearance, Trajectory Pro, help and privacy.

## Run it

```bash
npm install
cp .env.example .env     # then fill in the keys below
npm run dev              # http://localhost:5173
```

```bash
npm run check            # type-check
npm test                 # the engine's test suite + the web tests (vitest)
npm run build            # production build into dist/
npm run smoke            # browser tests against the mock API (Playwright + Chromium; see tests/run-smoke.mjs)
```

`dist/` is a static site: host it anywhere. For a sub-path, build with `VITE_BASE=/trajectory/ npm run build`.

## Configuration (build time, `.env`)

| Variable | What it is |
| --- | --- |
| `VITE_API_BASE_URL` | The Trajectory API. Default `https://api.trajectoryapp.org`, the same server the iPhone app uses. |
| `VITE_APPLE_CLIENT_ID` | Sign in with Apple JS needs a **Services ID** registered for this website's domain (Apple Developer → Identifiers → Services IDs → Sign in with Apple, with the domain and the Return URL). Without it the sign-in screen says sign-in is not set up. |
| `VITE_APPLE_REDIRECT_URI` | The Return URL registered with that Services ID. Default: the page's own origin and path. |
| `VITE_REVENUECAT_WEB_KEY` | RevenueCat Web Billing public key (`rcb_…`). Without it the paywall shows no prices and cannot sell; Pro bought on the iPhone still works. |
| `VITE_ACCOUNT_REQUIRED` | `false` builds the browser preview the mobile repo also has: no account, the plan stays in this browser (screenshots, demos). |
| `VITE_TEST_SIGN_IN` | `1` adds a "Test sign-in" button for the mock API (`tests/mock-server.mjs`). Test builds only. |
| `VITE_TEST_PRO` | `1` makes the browser hold Trajectory Pro without RevenueCat, for the mock's `MOCK_PRO=1` accounts. Test builds only; compiled out of every other build. |

## What the server and the dashboards need

The web app calls the production server unchanged, with three things to set up outside this repository:

1. **Sign in with Apple's audience.** Apple puts the *Services ID* in the identity token's audience for a web
   sign-in, where an iPhone sign-in carries the *bundle id*. The server verifies the token against the bundle id
   only (`server/routers.ts`, `auth.apple`, `jwtVerify(..., { audience: APPLE_BUNDLE_ID })`). For web sign-ins to be
   accepted that one check has to accept the Services ID as well, for example
   `audience: [APPLE_BUNDLE_ID, APPLE_WEB_CLIENT_ID]` with a new `APPLE_WEB_CLIENT_ID` environment variable. That is
   the only server change the web app depends on; everything else it calls works today.
2. **CORS.** Add the website's origin to the server's `ALLOWED_ORIGINS` (comma-separated; `server/_core/http.ts`).
3. **RevenueCat Web Billing.** Create a Web Billing app in the same RevenueCat project, attach the products to the
   "Trajectory Pro" entitlement and the current offering. The web app finds the plans by the App Store product ids
   (`trajectory_pro_monthly`, `trajectory_school_year`, `trajectory_lifetime_college`) and, failing that, by
   package type (`$rc_monthly`, `$rc_annual`, `$rc_lifetime`). The server already checks Pro by the account's
   RevenueCat id, so a web purchase unlocks Pro on the iPhone too.

## How it is built

- `src/engine/` — the mobile app's pure TypeScript (`lib/*.ts`), ported file for file with its test suite
  (`tests/engine/`). `src/shared/` — the mobile `shared/*`.
- `src/lib/api.ts` — the server: tRPC procedures over HTTP with the superjson transformer, one call per request,
  typed from `server/routers.ts`. An UNAUTHORIZED answer ends the session the way the iPhone does (asked once more
  first); a Pro refusal opens the paywall (and re-sends the call once when this browser holds Pro and the server
  agrees after a re-check). `ai.*` calls ask for AI processing consent first.
- `src/lib/session.ts`, `session-store.ts`, `session-refresh.ts`, `start-route.ts`, `sign-out-flow.ts` — the account
  rules, ported with their tests. `src/lib/apple-signin.ts` — Sign in with Apple JS.
- `src/lib/plan-sync*.ts`, `plan-snapshot.ts` — the plan saved to the account, ported with its tests (gzip through
  fflate, the same snapshot envelope as the iPhone writes).
- `src/lib/subscription-plans.ts`, `pro-identity.ts`, `revenuecat-web.ts`, `src/state/subscription-context.tsx` —
  Trajectory Pro, with RevenueCat's web SDK adapted to the ported plan rules.
- `src/screens/`, `src/components/` — the screens, rebuilt in plain React on the mobile design system
  (`src/styles.css`, `src/ui/`). `src/app.tsx` — the frame, the hash routes and the account gate.
- `tests/mock-server.mjs` — a stand-in for the API for the browser tests: the real tRPC server library with the
  production transformer and the real procedure names; `tests/run-smoke.mjs` builds against it (a free build and a
  Pro build) and runs every suite, each against a freshly started mock.

## Where things differ from the iPhone

- The browser has no Keychain, no camera, no iPhone calendars, no Apple Calendar and no push notifications:
  files come from a file picker, reminders come through the browser's notifications while a tab is open, and the
  plan is exported as a calendar file instead of mirrored into Apple Calendar.
- A course site that does not let web pages read its calendar feed cannot be fetched from the browser; the error
  says so, and the iPhone app reads it instead.
- Purchases go through RevenueCat's checkout instead of the App Store; a web subscription is managed from the
  Settings row, which opens RevenueCat's page.
- A pasted or typed syllabus is read as a background job like a file (the iPhone reads text in one call), so a
  reload picks the reading back up. A picked file does not outlive a reload: if that reading fails, the student
  chooses the file again.
- Browser notifications have no Snooze or Skip buttons; clicking one opens Today. The browser only asks for
  permission from the Reminders switch, never after the first plan.
- The syllabus screen itself tells a free account whose one syllabus is used (the iPhone tells it at the entry
  points); the server's own refusal leads to the same card.
