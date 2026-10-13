# What the server needs before the web app can sign in

The live API (`https://api.trajectoryapp.org`) refuses every browser today: a CORS preflight from any web origin,
`www.trajectoryapp.org` included, gets `403` (checked 13 October 2026). Until the two changes below are made, the web
app cannot sign in, so it cannot read a syllabus, load the saved plan or use any AI feature, wherever it is hosted.

Both changes are in the mobile repo's server (`Elijah-Haskell/trajectory-app`), which this project does not edit.

## 1. Let the website's address call the API (setting only, no code)

DigitalOcean → Apps → trajectory-api → Settings → api → Environment Variables. Add:

```
ALLOWED_ORIGINS=https://app.trajectoryapp.org
```

Use the exact address the web app is served from (scheme and host, no path, no trailing slash). Several are
comma-separated. The server reads it in `server/_core/http.ts` (`getAllowedOrigins`); the iPhone app sends no
`Origin` header and is unaffected.

## 2. Accept a web Sign in with Apple (one line of code plus a setting)

Apple puts the **Services ID** in a web sign-in's identity token, where the iPhone puts the bundle id. The server
checks the bundle id only, so it answers "Apple could not verify this sign-in" to every web sign-in.

**Apple Developer** → Certificates, Identifiers & Profiles → Identifiers → **+** → Services IDs. Create one (for
example `org.trajectoryapp.web`), enable Sign in with Apple, choose the app's primary App ID, and add the web app's
domain (`app.trajectoryapp.org`) and Return URL (`https://app.trajectoryapp.org/`). Grouping it under the app's
primary App ID gives the same Apple user id (`sub`) as the iPhone, so the same Trajectory account opens on both.

**Server code**, `server/routers.ts`, in `auth.apple`:

```diff
           const verified = await jwtVerify(input.identityToken, appleJwks, {
             issuer: "https://appleid.apple.com",
-            audience: APPLE_BUNDLE_ID,
+            audience: [APPLE_BUNDLE_ID, process.env.APPLE_WEB_SERVICES_ID].filter((id): id is string => Boolean(id)),
           });
```

**Server setting**: `APPLE_WEB_SERVICES_ID=org.trajectoryapp.web` (the Services ID above).

**Web app build setting**: `VITE_APPLE_CLIENT_ID=org.trajectoryapp.web`.

One known gap, not needed for testing: after a web sign-in the server tries to swap Apple's one-time code for a
refresh token with the bundle id (`rememberAppleSignIn` in `server/apple-signin.ts`). Apple refuses that for a web
code, the server logs a warning, and the sign-in still succeeds. An account first made on the web would then not have
its Apple link revoked when it is deleted. Fixing it means passing the token's `aud` through to that exchange and to
the revoke call.

## 3. Pro for testing (no code)

The server checks Pro with RevenueCat under the account's id. To test Pro without paying, grant your own account a
promotional entitlement in the RevenueCat dashboard: Customers → find the customer → Entitlements → Grant
"Trajectory Pro". The iPhone app and the web app both see it. A test build can also hold Pro in the browser with
`VITE_TEST_PRO=1`, but the server still refuses Pro-only calls for an account without the entitlement.

## 4. Selling Pro on the web (later)

RevenueCat → the same project → add a Web Billing app, attach the Pro products to the "Trajectory Pro"
entitlement and the current offering, and build with `VITE_REVENUECAT_WEB_KEY=rcb_...`. See README.md.
