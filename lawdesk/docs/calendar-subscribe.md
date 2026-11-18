# Subscribing to the Lawdesk calendar from Outlook, Google and Apple

The Calendar screen's **Subscribe in Outlook, Google or Apple** panel makes a private feed link
(`/api/calendar/feed/<token>.ics`, see `src/calendar/routes.ts`). The token is shown once; only its
SHA-256 is stored. A link shows either the events the person attends or the whole firm's calendar, and
can be turned off in the same panel. Calendar apps only read the feed: changes are made in Lawdesk.

**Hosting caveat.** Outlook on the web and Google Calendar fetch the link from their own servers, so they
can only use it once Lawdesk is reachable from the internet over HTTPS. While Lawdesk runs on
`127.0.0.1` (the default), only an app on the same computer (Apple Calendar, classic Outlook) can read it.
The panel says so when it is opened on localhost.

The steps shown in the panel (`APPS` in `public/js/views/calendar.js`) were checked against these
vendor help pages in November 2026. Recheck them when a vendor changes its menus.

| App | Steps (as the vendor words them) | Source |
|---|---|---|
| Outlook on the web / Outlook.com | Calendar, **Add calendar**, **Subscribe from web**, paste the URL, **Import**. Microsoft says updates "should happen approximately every 3 hours" and can "sometimes take more than 24 hours". | [Import or subscribe to a calendar in Outlook.com or Outlook on the web](https://support.microsoft.com/en-us/office/import-or-subscribe-to-a-calendar-in-outlook-com-or-outlook-on-the-web-cff1429c-5af6-41ec-a5b4-74f2c278e98c) |
| New Outlook for Windows | Calendar, **Add Calendar**, **Subscribe from web**, add the path, **Import**. | [You can't add an Internet calendar in Outlook (Microsoft Learn)](https://learn.microsoft.com/en-us/troubleshoot/outlook/calendaring/cannot-add-an-internet-calendar) |
| Classic Outlook (2016, 2019, Microsoft 365) | Calendar module, **Manage Calendars** group, **Open Calendar**, **From Internet**, add the path, **OK**. The same page says this can fail silently for some servers and suggests adding the calendar in Outlook on the web instead. | same page |
| Google Calendar | On a computer: next to **Other calendars**, **Add other calendars**, **From URL**, enter the URL, **Add calendar**. Google says subscribing must be done in a computer web browser, not the Android or iOS app. | [Subscribe to someone's Google Calendar](https://support.google.com/calendar/answer/37100) |
| Apple Calendar (Mac) | **File > New Calendar Subscription**, enter the address, **Subscribe**; name and colour; **Location** (iCloud for all devices, or On My Mac); **Auto-refresh**; **OK**. | [Subscribe to calendars on Mac](https://support.apple.com/en-au/guide/calendar/icl1022/16.0/mac/26) |
| iPhone / iPad | Calendar app, **Calendars**, **Add Calendar**, **Add Subscription Calendar**, enter the .ics URL, **Subscribe**. (Read from the iOS 15 edition of the guide; the current edition's text could not be loaded.) | [iPhone User Guide: set up multiple calendars](https://support.apple.com/en-kg/guide/iphone/use-multiple-calendars-iph3d1110d4/15.0/ios) |

Not covered: Outlook for Mac, and Google Workspace admin settings that can block outside calendars.
