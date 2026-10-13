// Browser test of the syllabus import against the mock API (tests/mock-server.mjs): sign in, paste a syllabus, the
// server reads it as a job while the live list fills in with the deadlines it has found so far, the class and the
// dates are checked, the plan is built, the items are on Today and Tasks, the import is on the imports screen with
// its undo, and a second syllabus runs into the free plan's limit (with the way to the plans). Expects a build made
// with VITE_API_BASE_URL=http://127.0.0.1:4191 VITE_TEST_SIGN_IN=1 served at SMOKE_URL (default http://127.0.0.1:4181),
// and `MOCK_PORT=4191 node tests/mock-server.mjs` running. Start the mock fresh for each run: its in-memory ledger
// counts the test student's one free syllabus, so a second run against the same mock process is refused.
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

const base = process.env.SMOKE_URL ?? "http://127.0.0.1:4181";
const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const problems = [];
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
let failures = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message}`);
  }
};

// Every line "Name - YYYY-MM-DD" becomes an item in the mock's reading; the dates are in the coming weeks.
const soon = (weeks) => {
  const day = new Date();
  day.setDate(day.getDate() + weeks * 7);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};
const ITEMS = ["Problem Set 1", "Quiz 1", "Midterm Exam", "Final Exam"];
const SYLLABUS = ["FINC 3100: Principles of Finance", "Schedule", ...ITEMS.map((name, index) => `${name} - ${soon(index + 2)}`)].join("\n");

console.log("syllabus import (phone)");
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await check("a signed-out visit lands on the sign-in screen", async () => {
  await page.getByRole("heading", { name: /planned from your syllabus/i }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Test sign-in" }).waitFor({ timeout: 10000 });
});
await check("signing in with an empty plan opens the syllabus import", async () => {
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/syllabus"), null, { timeout: 20000 });
  await page.getByRole("heading", { name: "Add your syllabus" }).waitFor({ timeout: 10000 });
});
await check("the ways in: a file, photos, pasted text, and where it is read", async () => {
  await page.getByRole("button", { name: "Choose a PDF or Word file" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Choose photos of the pages" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Paste the text instead" }).waitFor({ timeout: 5000 });
  await page.getByText("Your syllabus is read by AI on Trajectory's server.").waitFor({ timeout: 5000 });
  await page.getByRole("progressbar", { name: "Step 1 of 4" }).waitFor({ timeout: 5000 });
});
await check("pasting the text, agreeing to AI once, and reading it through the server shows the live list as items arrive", async () => {
  await page.getByRole("button", { name: "Paste the text instead" }).click();
  await page.getByRole("heading", { name: "Paste the text" }).waitFor({ timeout: 5000 });
  await page.getByLabel("Syllabus text").fill(SYLLABUS);
  await page.getByText(`${SYLLABUS.length.toLocaleString("en-US")} characters`).waitFor({ timeout: 5000 });
  await page.getByLabel("Course name, optional").fill("Principles of Finance");
  // The wait lasts about as long as the mock's job (1.5 s): the list's label is watched for before the click.
  const sawLabel = page.getByText(/found so far|Nothing found yet|The reading is starting/).first().waitFor({ timeout: 15000 });
  const sawRow = page.getByRole("listitem", { name: /^Quiz 1, quiz, / }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Read the pasted syllabus" }).click();
  // The first AI call asks for consent once (src/state/ai-consent.tsx); the answer is remembered in this browser.
  await page.getByRole("dialog", { name: "Before you use AI" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Agree and Continue" }).click();
  await page.getByRole("heading", { name: "Reading your syllabus" }).waitFor({ timeout: 10000 });
  await page.getByText("Pasted text").first().waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Cancel reading the syllabus" }).first().waitFor({ timeout: 5000 });
  await sawLabel;
  await sawRow;
  // The reading is remembered in this browser while it runs, so a reload would pick it up.
  const pending = await page.evaluate(() => localStorage.getItem("trajectory.syllabus.pendingExtraction.v1"));
  if (pending !== null && !pending.includes('"kind":"paste"')) throw new Error(`the pending reading is not the pasted one: ${pending}`);
  await page.getByRole("heading", { name: "Check your class" }).waitFor({ timeout: 20000 });
  const after = await page.evaluate(() => localStorage.getItem("trajectory.syllabus.pendingExtraction.v1"));
  if (after !== null) throw new Error("the finished reading is still remembered as pending");
});
await check("the class step is prefilled from the reading and asks for what the syllabus lacks", async () => {
  const name = await page.getByLabel("Class name").inputValue();
  if (name !== "Principles of Finance") throw new Error(`class name is "${name}"`);
  await page.getByRole("progressbar", { name: "Step 2 of 4" }).waitFor({ timeout: 5000 });
  // The mock gives no class times: the step says so, and an online class needs none.
  await page.getByRole("alert").filter({ hasText: /Choose the class days and times/ }).waitFor({ timeout: 5000 });
  await page.getByRole("switch", { name: "No set class time" }).click();
  await page.getByRole("button", { name: "Skip the term dates for now" }).click();
  await page.getByRole("button", { name: "Continue to the dates" }).click();
  await page.getByRole("heading", { name: "Check the dates" }).waitFor({ timeout: 10000 });
});
await check("the dates step lists every item the server found and builds the plan", async () => {
  for (const name of ITEMS) await page.getByText(name, { exact: true }).first().waitFor({ timeout: 5000 });
  await page.getByText(`Looks right · ${ITEMS.length}`).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: `Plan ${ITEMS.length} items` }).click();
  await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 30000 });
  await page.getByText(/Your semester is planned|Added to your plan/).first().waitFor({ timeout: 10000 });
});
await check("the imported items are on Tasks", async () => {
  await page.goto(`${base}/#/tasks`, { waitUntil: "networkidle" });
  for (const name of ITEMS) await page.getByText(name, { exact: true }).first().waitFor({ timeout: 10000 });
});
await check("the imports screen lists the import, what it added, and the way to undo it", async () => {
  await page.goto(`${base}/#/imports`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Imported syllabi" }).waitFor({ timeout: 10000 });
  await page.getByText(`${ITEMS.length} tasks`).first().waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /^Principles of Finance\. Added/ }).click();
  await page.getByText(`${ITEMS.length} tasks added`).waitFor({ timeout: 5000 });
  await page.getByText("Made a new class").waitFor({ timeout: 5000 });
  await page.getByText("Ask AI can read it").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /^Undo this import for Principles of Finance/ }).click();
  await page.getByText(/^Undo this import\?/).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Keep it" }).click();
  await page.getByRole("button", { name: /Remove from this list, keep the tasks/ }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Add another syllabus" }).waitFor({ timeout: 5000 }).catch(() => undefined);
  await page.getByRole("dialog", { name: "Imported syllabus" }).getByRole("button", { name: "Close" }).click();
});
await check("a second syllabus runs into the free plan's limit, with the way to the plans", async () => {
  await page.goto(`${base}/#/syllabus`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Add your syllabus" }).waitFor({ timeout: 10000 });
  await page.getByRole("alert").filter({ hasText: "Your free syllabus is used" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "See Trajectory Pro plans" }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/paywall"), null, { timeout: 10000 });
});
if (problems.length > 0) {
  failures += problems.length;
  for (const problem of problems) console.log(`  FAIL ${problem}`);
}
await context.close();
await browser.close();
if (failures > 0) {
  console.log(`\n${failures} problem${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\nsyllabus import: all good");
