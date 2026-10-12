// Browser smoke test: builds nothing itself; it expects `vite preview` (or `vite`) at the URL in SMOKE_URL
// (default http://localhost:4173) and walks the main screens at phone and desktop width, failing on any
// console error or uncaught page error. Run: npm run build && npm run preview & node tests/smoke.mjs
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

// Playwright from this project when it is installed here, else from the global npm root.
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
  await page.goto(`${base}/#/welcome`, { waitUntil: "networkidle" });
  await check("welcome renders", async () => {
    await page.getByRole("heading", { name: /planned from your syllabus/i }).waitFor({ timeout: 10000 });
  });
  await check("set up by hand lands on Today", async () => {
    await page.getByRole("button", { name: /set up by hand/i }).click();
    await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 10000 });
  });
  await check("add a class by hand", async () => {
    await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /add a class by hand/i }).click();
    await page.getByLabel("Class name").fill("Principles of Finance");
    await page.getByRole("checkbox", { name: "Monday" }).click();
    await page.getByRole("checkbox", { name: "Wednesday" }).click();
    await page.getByLabel("Class start time").fill("10:00");
    await page.getByLabel("Class end time").fill("11:15");
    await page.getByRole("button", { name: "Add the class" }).click();
    await page.getByText("Principles of Finance").first().waitFor({ timeout: 10000 });
  });
  await check("add a task from the add button", async () => {
    await page.getByRole("button", { name: /add a task, event or exam/i }).first().click();
    await page.getByLabel("Task name").fill("Problem Set 1");
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    await page.goto(`${base}/#/tasks`, { waitUntil: "networkidle" });
    await page.getByText("Problem Set 1").first().waitFor({ timeout: 10000 });
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
  await check("study, settings and syllabus screens render", async () => {
    await page.goto(`${base}/#/study`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Study", exact: true }).waitFor({ timeout: 10000 });
    await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10000 });
    await page.goto(`${base}/#/syllabus`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Add your syllabus" }).waitFor({ timeout: 10000 });
  });
  await check("the built-in reader imports a pasted syllabus", async () => {
    await page.getByLabel("Syllabus text").fill(["CHEM 101: General Chemistry", "Classes meet TTh 9:30-10:45 am", "Classes begin January 12, 2027", "Last day of class: April 30, 2027", "Feb 3, 2027 Quiz 1", "Feb 24, 2027 Midterm Exam", "March 17, 2027 Problem Set 3 due", "April 28, 2027 Final Exam"].join("\n"));
    await page.getByRole("button", { name: "Read the syllabus" }).click();
    await page.getByRole("heading", { name: "Check your class" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: /^Continue/ }).click();
    await page.getByRole("heading", { name: "Check the dates" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: /^Plan \d+ item/ }).click();
    await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 30000 });
    await page.getByText(/semester is planned|planned/i).first().waitFor({ timeout: 10000 });
  });
  await check("the plan survives a reload", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
    await page.getByText(/General Chemistry/).first().waitFor({ timeout: 10000 });
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
