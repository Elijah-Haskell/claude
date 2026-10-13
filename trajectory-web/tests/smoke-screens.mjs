// Browser test of the ported settings screens against the mock API (tests/mock-server.mjs): the privacy policy renders
// signed out; after "Test sign-in", the Course site link, Calendars, Reminders and Semester calendar screens render at
// phone and desktop width with no console error; the Reminders switch asks for permission (and only then); the
// Course site link refuses a bad link with its sentence. With MOCK_GCAL=1 on the mock, the Google Calendar section of
// Calendars (a connection made before) is exercised too: Sync now, then Disconnect.
//
// Expects a build made with VITE_API_BASE_URL=http://127.0.0.1:4194 VITE_TEST_SIGN_IN=1 served at SMOKE_URL (default
// http://127.0.0.1:4184), and `MOCK_PORT=4194 MOCK_GCAL=1 node tests/mock-server.mjs`.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const root = process.env.NODE_PATH ?? execSync("npm root -g").toString().trim();
    return require(`${root}/playwright`);
  }
}
const { chromium } = loadPlaywright();

const base = process.env.SMOKE_URL ?? "http://127.0.0.1:4184";
const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const gcalConnected = process.env.SMOKE_GCAL !== "0";
const widths = [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }];

const browser = await chromium.launch({ executablePath }).catch(() => chromium.launch());
let failures = 0;

/**
 * A fresh browser context: notifications granted to the site (so the real prompt resolves "granted" without a dialog),
 * but reported as "default" to the page until the page itself asks, and every ask counted. That way the test sees
 * whether the Reminders switch asks, and that nothing else does.
 */
async function openContext(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.grantPermissions(["notifications"], { origin: base });
  await context.addInitScript(() => {
    let asked = false;
    const realRequest = Notification.requestPermission.bind(Notification);
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => (asked ? "granted" : "default") });
    Notification.requestPermission = (...args) => {
      asked = true;
      window.__notificationAsks = (window.__notificationAsks ?? 0) + 1;
      return realRequest(...args);
    };
  });
  const problems = [];
  const attach = (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    return page;
  };
  return { context, problems, attach };
}

const APP_STATE_KEY = "trajectory_app_state_v1";

for (const size of widths) {
  const { context, problems, attach } = await openContext({ width: size.width, height: size.height });
  let page = attach(await context.newPage());
  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`  ok   ${label}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${label}: ${error.message}`);
    }
  };
  const asks = () => page.evaluate(() => window.__notificationAsks ?? 0);

  console.log(`${size.name} (${size.width}x${size.height})`);

  await check("the privacy policy renders signed out, with the AI processing card", async () => {
    await page.goto(`${base}/#/privacy-policy`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Privacy policy" }).waitFor({ timeout: 10000 });
    await page.getByText("AI Processing Preference").waitFor({ timeout: 10000 });
    await page.getByText("Your plan is kept in this browser and saved to your account on our server").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Open the web version of this policy, in a new tab" }).waitFor({ timeout: 10000 });
    if (await page.getByRole("button", { name: "Test sign-in" }).count()) throw new Error("the sign-in screen took over the policy");
  });

  await check("test sign-in", async () => {
    await page.goto(`${base}/#/welcome`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Test sign-in" }).click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/syllabus") || window.location.hash.startsWith("#/today"), null, { timeout: 30000 });
  });

  await check("course site link renders and refuses a bad link with its sentence", async () => {
    await page.goto(`${base}/#/course-feeds`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Course site link" }).waitFor({ timeout: 10000 });
    await page.getByText("Paste the link first").waitFor({ timeout: 10000 });
    await page.getByLabel("Calendar link from your course site").fill("not a link");
    await page.getByRole("button", { name: "Add link" }).click();
    await page.getByRole("alert").filter({ hasText: "Could not add this link. Paste the full feed link (it starts with https:// or webcal://)." }).waitFor({ timeout: 10000 });
    // Where to find it: the four course sites, one opened.
    await page.getByRole("button", { name: "Canvas: where to find the link" }).click();
    await page.getByText("Calendar, then Calendar Feed (bottom of the right sidebar). Copy the link.").waitFor({ timeout: 5000 });
    await page.getByText("It stays in this browser and is fetched straight from your school").waitFor({ timeout: 5000 });
  });

  await check("calendars renders: the browser note, the calendar file, the import sheet", async () => {
    await page.goto(`${base}/#/calendars`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Calendars" }).waitFor({ timeout: 10000 });
    await page.getByText("Your iPhone's calendars are read in the iPhone app.").waitFor({ timeout: 10000 });
    const download = page.waitForEvent("download", { timeout: 10000 });
    await page.getByRole("button", { name: "Download the plan as a calendar file" }).click();
    const file = await download;
    if (!/^trajectory-\d{4}-\d{2}-\d{2}\.ics$/.test(file.suggestedFilename())) throw new Error(`unexpected file name ${file.suggestedFilename()}`);
    await page.getByText("Your plan was saved as a calendar file.").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: /^Import from a calendar link\./ }).click();
    await page.getByRole("dialog", { name: "Import from a calendar link" }).waitFor({ timeout: 10000 });
    await page.getByText("Paste the calendar link to import it").waitFor({ timeout: 5000 });
    const importButton = page.getByRole("button", { name: /^Import events/ });
    if (!(await importButton.isDisabled())) throw new Error("Import events is enabled without a link");
    await page.getByRole("textbox", { name: "Calendar link", exact: true }).fill("calendar.google.com/ical/basic.ics");
    await page.getByText("The link has to start with https:// or webcal:// and have no spaces").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("dialog", { name: "Import from a calendar link" }).waitFor({ state: "detached", timeout: 5000 });
  });

  await check("reminders: the switch asks for permission (nothing else does), then the heads-ups", async () => {
    await page.goto(`${base}/#/reminders`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Reminders" }).waitFor({ timeout: 10000 });
    if ((await asks()) !== 0) throw new Error("permission was asked before the switch was touched");
    const master = page.getByRole("switch", { name: /^Study reminders/ });
    if ((await master.getAttribute("aria-checked")) !== "false") throw new Error("reminders are on for a new account");
    await master.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label^="Study reminders"]')?.getAttribute("aria-checked") === "true", null, { timeout: 10000 });
    if ((await asks()) !== 1) throw new Error(`permission was asked ${await asks()} times by the switch`);
    await page.getByText("When a session starts").waitFor({ timeout: 5000 });
    await page.getByText("1 day before", { exact: true }).waitFor({ timeout: 5000 });
    await page.getByText("Reminders come from this browser while a Trajectory tab is open.").waitFor({ timeout: 5000 });
    // Add a heads-up: the sheet opens on "1 hour", and the new heads-up joins the list.
    await page.getByRole("button", { name: "Add a heads-up before a session" }).click();
    await page.getByRole("dialog", { name: "Add a heads-up" }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Add the heads-up 1 hour before" }).click();
    await page.getByText("1 hour before", { exact: true }).waitFor({ timeout: 5000 });
    // The same one again is refused, in words.
    await page.getByRole("button", { name: "Add a heads-up before a session" }).click();
    await page.getByText("You already have this heads-up").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Remove the heads-up 1 hour before" }).click();
    await page.getByText("1 hour before", { exact: true }).waitFor({ state: "detached", timeout: 5000 });
    // Off again: the sections fold away, and the browser was not asked a second time.
    await master.click();
    await page.getByText("When a session starts").waitFor({ state: "detached", timeout: 5000 });
    if ((await asks()) !== 1) throw new Error("turning reminders off asked for permission");
  });

  await check("semester calendar opens Week on its month", async () => {
    await page.goto(`${base}/#/semester-calendar`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/week?view=month", null, { timeout: 10000 });
    await page.getByRole("grid", { name: "Month" }).waitFor({ timeout: 10000 });
  });

  await check("the privacy policy renders signed in too", async () => {
    await page.goto(`${base}/#/privacy-policy`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Privacy policy" }).waitFor({ timeout: 10000 });
    await page.getByText("AI data sharing is currently off.").waitFor({ timeout: 10000 });
  });

  await check("no horizontal page scroll", async () => {
    for (const route of ["course-feeds", "calendars", "reminders", "privacy-policy"]) {
      await page.goto(`${base}/#/${route}`, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`${route} is ${overflow}px wider than the viewport`);
    }
  });

  if (gcalConnected) {
    await check("a Google Calendar connection made before: sync now, then disconnect", async () => {
      // A connection made before is known from the plan. The app writes its plan to localStorage when it changes and
      // again when its page unloads, so the flag is written from a page that does not run the app (the icon), after
      // the app's own page is gone, and the app is then opened afresh on Calendars.
      await page.goto(`${base}/#/today`, { waitUntil: "networkidle" });
      await page.waitForFunction((key) => localStorage.getItem(key) !== null, APP_STATE_KEY, { timeout: 15000 });
      await page.close();
      const plain = await context.newPage();
      await plain.goto(`${base}/favicon.svg`, { waitUntil: "load" });
      const patched = await plain.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return "no state";
        const state = JSON.parse(raw);
        if (typeof state !== "object" || state === null || !("googleCalendarConnected" in state)) return "unknown shape";
        state.googleCalendarConnected = true;
        localStorage.setItem(key, JSON.stringify(state));
        return "ok";
      }, APP_STATE_KEY);
      await plain.close();
      if (patched !== "ok") throw new Error(`could not mark the plan as connected: ${patched}`);
      page = attach(await context.newPage());
      await page.goto(`${base}/#/calendars`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Google Calendar" }).waitFor({ timeout: 15000 });
      await page.getByText("Connected", { exact: true }).waitFor({ timeout: 15000 });
      await page.getByText(/^Last synced: /).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Sync now" }).click();
      await page.getByText(/^Sync complete\. \d+ events? synced from Google Calendar\./).waitFor({ timeout: 15000 });
      await page.getByText(/^\d+ Google events? block/).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Disconnect Google Calendar" }).click();
      await page.getByText("Disconnect Google Calendar? This removes all synced events from Trajectory. Your Google Calendar is not affected.").waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Yes, disconnect Google Calendar" }).click();
      await page.getByRole("heading", { name: "Google Calendar" }).waitFor({ state: "detached", timeout: 10000 });
    });
  }

  if (problems.length > 0) {
    failures += problems.length;
    for (const problem of problems) console.log(`  FAIL ${problem}`);
  }
  await context.close();
}

await browser.close();
if (failures > 0) {
  console.log(`\n${failures} problem${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\nsettings screens: all good");
