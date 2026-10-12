// Browser smoke test of the main screens, signed in against the mock API (tests/mock-server.mjs; run through
// tests/run-smoke.mjs, or build with VITE_API_BASE_URL + VITE_TEST_SIGN_IN=1 and set SMOKE_URL yourself). Walks Today,
// Week, Tasks, Study, Classes and Settings at phone and desktop width, failing on any console error or page error.
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

const base = process.env.SMOKE_URL ?? "http://localhost:4173";
const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const widths = [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }];

const browser = await chromium.launch({ executablePath }).catch(() => chromium.launch());
let failures = 0;

for (const size of widths) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`  ok   ${label}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${label}: ${error.message}`);
    }
  };

  console.log(`${size.name} (${size.width}x${size.height})`);
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await check("the sign-in screen renders", async () => {
    await page.getByRole("heading", { name: /planned from your syllabus/i }).waitFor({ timeout: 10000 });
  });
  await check("signing in opens the app", async () => {
    await page.getByRole("button", { name: "Test sign-in" }).click();
    // A new account with no plan goes to the syllabus import; one with a plan (the desktop pass) to Today.
    await page.waitForFunction(() => /^#\/(syllabus|today)/.test(window.location.hash), null, { timeout: 30000 });
    await page.goto(`${base}/#/today`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 10000 });
  });
  await check("add a class by hand", async () => {
    await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
    if ((await page.getByText(`Principles of Finance ${size.name}`).count()) > 0) return;
    // An empty Classes tab offers "Add a class by hand" directly; one with classes asks how first.
    const byHand = page.getByRole("button", { name: /add a class by hand/i });
    if ((await byHand.count()) > 0) await byHand.click();
    else {
      await page.getByRole("button", { name: /^Add a class/ }).click();
      await page.getByRole("button", { name: /^By hand/ }).click();
    }
    await page.getByLabel("Class name").fill(`Principles of Finance ${size.name}`);
    await page.getByRole("checkbox", { name: "Monday" }).click();
    await page.getByRole("checkbox", { name: "Wednesday" }).click();
    await page.getByLabel("Class start time").fill("10:00");
    await page.getByLabel("Class end time").fill("11:15");
    await page.getByRole("button", { name: "Add the class" }).click();
    await page.getByText(`Principles of Finance ${size.name}`).first().waitFor({ timeout: 10000 });
  });
  await check("add a task from the add button", async () => {
    await page.getByRole("button", { name: /add a task, event or exam/i }).first().click();
    await page.getByLabel("Task name").fill(`Problem Set ${size.name}`);
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    await page.goto(`${base}/#/tasks`, { waitUntil: "networkidle" });
    await page.getByText(`Problem Set ${size.name}`).first().waitFor({ timeout: 10000 });
  });
  await check("week grid renders", async () => {
    await page.goto(`${base}/#/week`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /3 days|week|month/i }).first().waitFor({ timeout: 10000 });
    await page.getByRole("tab", { name: /month/i }).click();
    await page.getByRole("grid", { name: "Month" }).waitFor({ timeout: 10000 });
  });
  await check("today shows the plan and the replan sheet opens", async () => {
    await page.goto(`${base}/#/today`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /^Replan today/ }).click();
    await page.getByRole("button", { name: "Preview changes" }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Close Replan" }).click();
  });
  await check("study, settings and the import screens render", async () => {
    await page.goto(`${base}/#/study`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Study", exact: true }).waitFor({ timeout: 10000 });
    await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10000 });
    await page.getByText("Signed in with Apple").first().waitFor({ timeout: 10000 });
    await page.goto(`${base}/#/imports`, { waitUntil: "networkidle" });
    await page.getByRole("heading").first().waitFor({ timeout: 10000 });
  });
  await check("the plan survives a reload and is saved to the account", async () => {
    await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
    await page.getByText(/Saved to your account · /).first().waitFor({ timeout: 30000 });
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
    await page.getByText(`Principles of Finance ${size.name}`).first().waitFor({ timeout: 10000 });
  });
  await check("no horizontal page scroll", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`page is ${overflow}px wider than the viewport`);
  });

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
console.log("\nall good");
