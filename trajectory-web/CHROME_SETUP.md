# Setup instructions for Claude in Chrome

Paste everything below the line into Claude in Chrome. It covers Apple Developer, RevenueCat, DigitalOcean and Wix,
in the order that works. Part E is held back until the server change is merged and deployed.

---

You are helping me (Elijah) set up the web version of my app, Trajectory, so it runs at https://app.trajectoryapp.org
against my existing server at https://api.trajectoryapp.org. I am signed in to each site in this browser. Work through
parts A to F in order.

## Rules for the whole task

- Do only what is listed here. Do not delete, rename or change anything that already exists in any account, apart from
  the exact settings named below.
- Never enter payment details or accept a paid plan. Every step here is free. If a page asks for money, stop and ask me.
- Stop and ask me before clicking anything that cannot be undone, and whenever a page looks different from what is
  described here and the right choice is not obvious.
- Do not copy secrets (keys, tokens, passwords) into the chat. The values in this task are not secret.
- If a step fails or a site asks you to sign in, stop and tell me exactly what you see.
- At the end, give me the report described in part F.

## A. Apple Developer: create the web Services ID

1. Open https://developer.apple.com/account/resources/identifiers/list/serviceId (Certificates, Identifiers &
   Profiles > Identifiers, filtered to Services IDs). If there is a team picker, choose the team that owns the
   Trajectory iPhone app.
2. If a Services ID with the identifier `org.trajectoryapp.web` already exists, do not create another. Open it and go
   to step 5.
3. Click the **+** button, choose **Services IDs**, and click **Continue**.
4. Description: `Trajectory Web`. Identifier: `org.trajectoryapp.web`. Click **Continue**, then **Register**. If Apple
   says the identifier is taken, use `org.trajectoryapp.webapp` instead, and use that value everywhere this task says
   `org.trajectoryapp.web`.
5. Open the Services ID. Tick **Sign In with Apple** and click **Configure** next to it.
6. Primary App ID: choose the Trajectory iPhone app, whose bundle id is
   `space.manus.trajectory.planner.t20260223211820`. This grouping makes the same Apple account open the same
   Trajectory account on the iPhone and on the web.
7. Domains and Subdomains: `app.trajectoryapp.org`. Return URLs: `https://app.trajectoryapp.org/` (with the final
   slash). Click **Next**, then **Done**, then **Continue**, then **Save**.
8. If Apple asks to verify the domain by downloading a file, do not continue that part. Tell me, because the file has
   to be published on the website first.
9. Note the exact Services ID identifier you ended up with.

## B. RevenueCat: give my own account Trajectory Pro for testing

1. Open https://app.revenuecat.com and the Trajectory project. Go to **Customers**.
2. Find my customer. My app user id starts with `apple_` (the server turns my Trajectory account id `apple:<my Apple
   id>` into `apple_<my Apple id>`). If there is more than one `apple_` customer and you cannot tell which is mine
   from the purchase history or attributes, list them for me and ask. Do not guess.
3. On my customer's page, find **Entitlements** and choose **Grant** (it may be called "Grant entitlement" or
   "Grant promotional entitlement").
4. Entitlement: **Trajectory Pro** (exactly that name). Duration: **Lifetime**. Confirm.
5. Check that the customer page now lists Trajectory Pro as active. This can be revoked later from the same place.

## C. DigitalOcean: host the web app as a free static site

1. Open https://cloud.digitalocean.com/apps and click **Create App**.
2. Source: **GitHub**. Repository: `Elijah-Haskell/claude`. Branch: `claude/nice-pasteur-tkgeqi`. Source directory:
   `trajectory-web`. Keep "Autodeploy" on. If DigitalOcean's GitHub access does not include the `claude` repository,
   it may ask to change its GitHub permissions: allow access to that one repository only, then come back.
3. DigitalOcean detects the resources. There must be exactly one, and it must be a **Static Site**. If it detected a
   Web Service, edit it and change the type to Static Site. If anything else is detected, delete only that extra
   detected item from this new app (never from another app).
4. Edit the static site:
   - Build command: `npm ci && npm run build`
   - Output directory: `dist`
   - Name: `web`
5. Environment variables for this static site, all with scope **Build time**:
   - `VITE_API_BASE_URL` = `https://api.trajectoryapp.org`
   - `VITE_APPLE_CLIENT_ID` = the Services ID from part A (`org.trajectoryapp.web`)
   - `VITE_APPLE_REDIRECT_URI` = `https://app.trajectoryapp.org/`
6. Plan: the free static site plan (DigitalOcean hosts up to three static-site apps for free). If the only choices
   cost money, stop and ask me.
7. App name: `trajectory-web`. Region: the same as the existing API app if offered. Click **Create Resources**.
8. Wait until the first deploy succeeds. If the build fails, copy the last 40 lines of the build log into your
   report and stop.
9. In the new app, open **Settings > Domains > Add Domain**. Domain: `app.trajectoryapp.org`. Choose the option where
   I manage the domain myself (not DigitalOcean DNS). DigitalOcean then shows a CNAME target ending in
   `.ondigitalocean.app`. Note it exactly.

## D. Wix: point app.trajectoryapp.org at the new site

1. Open https://manage.wix.com and go to **Domains**, then `trajectoryapp.org`, then **Manage DNS records**.
2. Change nothing that is already there. The MX and TXT records carry my e-mail, the `api` record carries the
   server, and the root and `www` records carry the website.
3. In the CNAME section, add one record: Host name `app`, Value the CNAME target from part C step 9, TTL as
   suggested. Save.
4. If Wix already has a record for `app`, do not change it. Stop and tell me what it is.
5. Back in DigitalOcean (the trajectory-web app, Settings > Domains), wait until `app.trajectoryapp.org` shows as
   Active. That can take up to an hour. You can do part F's first check in the meantime.

## E. DigitalOcean: two settings for the API (only after I say the server change is live)

Before this part, ask me: "Is the web-sign-in server change merged and deployed?" Continue only when I say yes. This
part changes the live API, which restarts it.

1. In https://cloud.digitalocean.com/apps open the existing API app, the one whose domain is `api.trajectoryapp.org`.
   Check that no deployment is in progress. If one is, wait for it to finish.
2. Open **Settings**, then the **api** component, then **Environment Variables**, then **Edit**.
3. Add three variables. Leave every existing variable exactly as it is. None of them is secret, so plain is fine.
   - `ALLOWED_ORIGINS` = `https://app.trajectoryapp.org` (only this one address; no `www`, no other site)
   - `APPLE_WEB_SERVICES_ID` = the Services ID from part A (`org.trajectoryapp.web`)
   - `APPLE_WEB_REDIRECT_URI` = `https://app.trajectoryapp.org/` (with the final slash, exactly as in part A)
4. Save. This redeploys the API. Wait until the deploy succeeds.
5. Open the API app's **Runtime Logs** and look at the lines from the new start. There must be no line containing
   `[env] ERROR`, and no `[env] warning` that mentions `ALLOWED_ORIGINS`, `APPLE_WEB_SERVICES_ID` or
   `APPLE_WEB_REDIRECT_URI`. Report any
   `[env]` lines you see.
6. Open https://api.trajectoryapp.org/api/health. It must answer with a success response.

## F. Check it and report back

1. Open https://app.trajectoryapp.org. The Trajectory sign-in screen must appear, with a Sign in with Apple button.
   If the page does not load yet, say so; DNS may still be spreading.
2. After part E: click **Sign in with Apple**, and stop at Apple's sign-in window so that I can finish signing in
   myself. Then check that Settings shows "Trajectory Pro, Active on your account".
3. Report to me:
   - the Services ID identifier, and whether Apple asked for domain verification
   - which RevenueCat customer you granted Pro to, and that it shows as active
   - the trajectory-web app's status, its `.ondigitalocean.app` address, and the CNAME target
   - the Wix record you added
   - whether part E was done, the `[env]` log lines, and the health check result
   - anything you skipped or that looked different from these instructions
