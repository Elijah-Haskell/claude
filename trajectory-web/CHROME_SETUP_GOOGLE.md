# Sign in with Google: steps for Claude in Chrome

Paste everything below the line into Claude in Chrome. Part A can be done now. Part B waits until Elijah has said
"merge it" for the server branch `google-sign-in` and the server chat has merged it.

---

You are helping Elijah set up Sign in with Google for the Trajectory web app (https://app.trajectoryapp.org). Work
in the browser where Elijah is signed in. Ask before any step that says **ask first**. Never copy, paste or show
an OAuth **client secret**; it is not needed. The **client ID** is not secret.

## Part A: a Google Cloud project for sign-in only (do now)

1. Open https://console.cloud.google.com/. In the project picker choose **New project**, name it
   `Trajectory Sign-in`, and create it. **Do not use the existing Calendar project**: it is in Testing mode and
   must stay separate. Make sure the new project is the selected one before going on.
2. Open **APIs & Services → OAuth consent screen**. Newer consoles call it **Google Auth Platform**, with
   Branding, Audience and Data access pages. Fill it in:
   - User type / Audience: **External**.
   - App name: `Trajectory`. User support email: Elijah's address.
   - App home page: `https://trajectoryapp.org`.
   - Privacy policy: `https://api.trajectoryapp.org/privacy`. Terms of service: `https://api.trajectoryapp.org/terms`.
   - Authorized domain: `trajectoryapp.org`. Developer contact: Elijah's address.
   - Leave the logo empty: an uploaded logo makes Google review the app.
3. **Data access / Scopes:** add only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. Add
   nothing else.
4. **Audience / Publishing status:** **ask first**, then choose **Publish app** so it is **In production**. With
   only those three scopes and no logo, Google should not ask for verification. If it does ask, stop and report
   what it says.
5. Open **Clients**. Older consoles call it **Credentials → Create credentials → OAuth client ID**. Then:
   - Application type: **Web application**. Name: `Trajectory web`.
   - Authorized JavaScript origins: `https://app.trajectoryapp.org` (exactly that; no path, no trailing slash).
   - Authorized redirect URIs: none.
   - Create it.
6. Copy the **Client ID**. It looks like `123456789012-abc….apps.googleusercontent.com`. Report it back. Close the
   dialog without copying the secret.

Report: the project name, the publishing status, the scopes listed, the JavaScript origin, and the client ID.

## Part B: turn it on (only after the server branch is merged and deployed)

The server must have Sign in with Google before the website shows the button, so the API comes first.

1. DigitalOcean → Apps → the **API** app → Settings → the API component → Environment Variables. **Ask first**,
   then add `GOOGLE_SIGNIN_CLIENT_ID` = the client ID (not encrypted; it is not a secret). Save and let it
   redeploy. When the deploy is live, open Runtime Logs and report any line that starts with `[env] warning`
   and mentions GOOGLE.
2. DigitalOcean → Apps → **trajectory-web** (the static site) → Settings → Environment Variables. **Ask first**,
   then add `VITE_GOOGLE_CLIENT_ID` = the same client ID, as a build-time variable. Save and let it rebuild.
3. Open https://app.trajectoryapp.org in a private window. Report whether a Google button shows under Sign in with
   Apple. Then ask Elijah to try it with his own Google account. Do not sign in with his account yourself.
