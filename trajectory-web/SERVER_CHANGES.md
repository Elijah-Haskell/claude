# Getting the web app signed in against the real server

The live API (`https://api.trajectoryapp.org`) refuses every browser today: a CORS pre-flight from any web origin,
`www.trajectoryapp.org` included, got `403` on 13 October 2026. It also checked Sign in with Apple against the iPhone
app's bundle id only. Until the steps below are done, the web app cannot sign in, so it cannot read a syllabus, load
the saved plan or use any AI feature, wherever it is hosted.

## 1. The server change (done, waiting to be merged)

Branch `web-sign-in` of `Elijah-Haskell/trajectory-app` (commit `de2480c`, from `main` at `9c802b5`), agreed with the
trajectory-app session first. Nothing is merged or deployed: every push to `main` redeploys production, so the
trajectory-app session merges it when Elijah says "merge it". With the new setting unset it behaves exactly as today.

- `auth.apple` also accepts identity tokens for the web's **Services ID** (new optional setting
  `APPLE_WEB_SERVICES_ID`). A web token must carry SHA-256 of the raw nonce the browser sends with it.
- Apple's one-time code from a web sign-in is exchanged, and the token later revoked on account deletion, under the
  Services ID. The account ledger keeps that client id next to the encrypted token.
- The start-up check warns when `APPLE_WEB_SERVICES_ID` is set without `ALLOWED_ORIGINS`.
- `scripts/smoke/checks.mjs --allowed-origin=https://app.trajectoryapp.org` checks the web app's CORS pre-flight.

Checked before pushing: `pnpm check`, the full test suite (3,291 tests; the known-flaky p95 timing test passed when
re-run alone), and `scripts/smoke/local.mjs` against MySQL 8.4.10 (33 checks, including the new pre-flight).

## 2. Apple Developer (Elijah)

Certificates, Identifiers & Profiles > Identifiers > **+** > Services IDs. Create one (for example
`org.trajectoryapp.web`) in the same team as the app, enable Sign in with Apple, choose the app's primary App ID, and
add the domain `app.trajectoryapp.org` and the Return URL `https://app.trajectoryapp.org/`. Grouping it with the
app's App ID gives the same Apple user id, so the same Trajectory account opens on the iPhone and on the web.

## 3. DigitalOcean settings for the API (Elijah, after the merge)

Apps > trajectory-api > Settings > api > Environment Variables:

```
ALLOWED_ORIGINS=https://app.trajectoryapp.org
APPLE_WEB_SERVICES_ID=org.trajectoryapp.web
APPLE_WEB_REDIRECT_URI=https://app.trajectoryapp.org/
```

The third one was added in review on the branch (commit `75cee99`): Apple wants the web sign-in's redirect URI again
when the server exchanges its code. It must match the web app's `VITE_APPLE_REDIRECT_URI` character for character.

Only that one origin: not `www.trajectoryapp.org` (a Wix site running third-party scripts) and not a github.io
address. Then check it: `node scripts/smoke/checks.mjs https://api.trajectoryapp.org --allowed-origin=https://app.trajectoryapp.org`.

## 4. Hosting the web app at app.trajectoryapp.org (Elijah)

`deploy/digitalocean-static-site.yaml` is an App Platform spec for a free static site built from this branch. Create
the app from it, set `VITE_APPLE_CLIENT_ID` to the Services ID, then add the CNAME App Platform shows for
`app.trajectoryapp.org` at Wix (host `app`). Leave the Google mail records and the `api` record as they are.

The address is not linked from anywhere, but anyone who has it can open the page. Every visitor must still sign in
with Apple, and only the server decides what an account may do.

## 5. Pro for testing (no code)

The server checks Pro with RevenueCat under the account's id. Grant your own account a promotional "Trajectory Pro"
entitlement in the RevenueCat dashboard (Customers > the customer > Entitlements). The iPhone app and the web app
both see it.

## Before the web app is public

- The privacy policy and terms on the API say "iPhone app". They must cover the web first, and publishing to the
  website needs Elijah's OK each time.
- Selling Pro on the web needs a RevenueCat Web Billing app and `VITE_REVENUECAT_WEB_KEY` (see README.md).
