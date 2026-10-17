# Draft: legal and support wording for the web app (not published)

Status: a draft for Elijah to approve. Nothing here is live. The privacy policy, terms and support page exist in two
places, and both describe Trajectory as "an iPhone app":

- the website (Wix): https://www.trajectoryapp.org/privacy.html, /terms.html, /support.html (the web app's Terms
  link and the iPhone app's links point here);
- the API's own pages: https://api.trajectoryapp.org/privacy, /terms, /support (`server/legal-pages.ts` in
  trajectory-app; changing them is the trajectory-app session's work, with Elijah's OK).

The web app's in-app privacy policy (Settings > Help and privacy) already says "this browser" where the iPhone app
says "this iPhone". Keep the three in step.

Every statement below was checked against the web app's code on 14 October 2026: it stores the plan, the sign-in
session and preferences in the browser's local storage; it sets no cookies of its own and has no analytics or
advertising code; its fonts ship with the page; it is a static site on DigitalOcean; signing in loads Apple's Sign in
with Apple script from Apple; it never reads device calendars; it does not sell Pro yet.

## Privacy policy

Replace "Trajectory ("we", "us") is an iPhone app for college students." with:

> Trajectory ("we", "us") is a study planner for college students. It is available as an iPhone app and on the web at
> app.trajectoryapp.org. This policy covers both.

Add a section:

> **On the web.** The web app keeps a copy of your plan, your sign-in session and your preferences in your browser's
> local storage, so it works between visits. Signing out or deleting your account removes them from that browser. The
> web app sets no cookies of its own and uses no analytics or advertising. It is hosted by DigitalOcean. When you sign
> in, your browser loads Apple's Sign in with Apple script from Apple, and Apple handles the sign-in. The web app
> never reads your device's calendars.

Change "Purchases records stay with Apple and RevenueCat; cancel a subscription in your App Store settings." to:

> Purchase records stay with Apple and RevenueCat. Cancel a subscription bought in the iPhone app in your App Store
> settings.

(When Pro goes on sale on the web, add: "A subscription bought on the web is managed from Settings → Trajectory Pro,
through RevenueCat's billing page.")

## Terms

After the paragraph about Apple's Standard EULA, add:

> If you use Trajectory on the web, these terms apply on their own; Apple's Standard EULA covers only the app
> downloaded from the App Store.

Change "Manage or cancel subscriptions in your App Store account settings." to:

> Manage or cancel a subscription bought in the iPhone app in your App Store account settings.

## Support page

Add a question:

> **Can I use Trajectory on a computer?** Yes, at app.trajectoryapp.org. Sign in with the same Apple Account and your
> plan and Trajectory Pro are there.

Change "Include in your email: Your iPhone model and iOS version, and the Trajectory version" to:

> Include in your email: your iPhone model and iOS version (or, on the web, your browser), and the Trajectory version
> shown at the bottom of Settings.

Change the Restore Purchases answer to start with "In the iPhone app," so it is not read as web instructions.

## When Google and email sign-in are switched on

Add to the privacy policy's sign-in section:

> You can also sign in with Google or with a code sent to your email address. With Google, Google tells us your
> Google account's ID, name and email address. With an email code, we keep your email address and send the code
> through our email provider, Resend; the code expires after 10 minutes and is stored only as a one-way hash until
> then.

(Name the provider actually chosen if it is not Resend.)
