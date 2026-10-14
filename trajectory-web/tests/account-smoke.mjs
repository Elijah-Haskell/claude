// Browser test of the account flow against the mock API (tests/mock-server.mjs): sign in, the plan saved to the
// account, sign out (the browser's copy erased), sign in again (the plan comes back). Expects a build made with
// VITE_API_BASE_URL=http://127.0.0.1:4174 VITE_TEST_SIGN_IN=1 served at SMOKE_URL (default http://localhost:4173).
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

console.log("account flow (phone)");
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await check("a signed-out visit lands on the sign-in screen", async () => {
  await page.getByRole("heading", { name: /planned from your syllabus/i }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Test sign-in" }).waitFor({ timeout: 10000 });
});
await check("signing in with an empty plan opens the syllabus import", async () => {
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/syllabus"), null, { timeout: 20000 });
});
await check("a class added here is saved to the account", async () => {
  await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /add a class by hand/i }).click();
  await page.getByLabel("Class name").fill("Principles of Finance");
  await page.getByRole("checkbox", { name: "Monday" }).click();
  await page.getByLabel("Class start time").fill("10:00");
  await page.getByLabel("Class end time").fill("11:15");
  await page.getByRole("button", { name: "Add the class" }).click();
  await page.getByText("Principles of Finance").first().waitFor({ timeout: 10000 });
  await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
  await page.getByText("Signed in with Apple").first().waitFor({ timeout: 10000 });
  await page.getByText(/Saved to your account · /).first().waitFor({ timeout: 30000 });
});
await check("signing out erases this browser's copy", async () => {
  await page.getByRole("button", { name: /Signed in with Apple/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  // The question: "Sign out?" with "Sign out" / "Cancel".
  await page.getByRole("heading", { name: "Sign out?" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Sign out", exact: true }).last().click();
  await page.getByRole("button", { name: "Test sign-in" }).waitFor({ timeout: 20000 });
  const stored = await page.evaluate(() => localStorage.getItem("trajectory_app_state_v1"));
  if (stored !== null) throw new Error("the plan is still in localStorage after signing out");
});
await check("signing in again brings the plan back from the account", async () => {
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/today"), null, { timeout: 30000 });
  await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
  await page.getByText("Principles of Finance").first().waitFor({ timeout: 15000 });
});
await check("the paywall opens and says Pro is not sold on the web (or that it is active)", async () => {
  await page.goto(`${base}/#/paywall`, { waitUntil: "networkidle" });
  await page.getByText(/not just one/).waitFor({ timeout: 10000 });
  await page.getByText(/sold on the website yet|active on your account/).first().waitFor({ timeout: 10000 });
});
await check("without a RevenueCat web key, Pro comes from the server (the mock's MOCK_PRO=1 account)", async () => {
  await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
  await page.getByText("Active on your account").first().waitFor({ timeout: 10000 });
  if (await page.getByText("Free plan", { exact: true }).count()) throw new Error("Settings still says Free plan");
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
console.log("\naccount flow: all good");
