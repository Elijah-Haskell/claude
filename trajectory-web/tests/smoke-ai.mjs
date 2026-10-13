// Browser test of Trajectory AI against the mock API (tests/mock-server.mjs, started with MOCK_PRO=1 so
// ai.conversationalChat answers a "chat" reply): sign in, add a class so Today has a plan, press Ask AI, send a
// message, agree to the AI consent sheet the API client raises, see the mock reply with its "AI-generated" line, open
// and close the Report sheet, and find Ask AI on Week too. Expects a build made with
//   VITE_API_BASE_URL=http://127.0.0.1:4192 VITE_TEST_SIGN_IN=1 VITE_TEST_PRO=1
// served at SMOKE_URL (default http://127.0.0.1:4182). VITE_TEST_PRO=1 is what makes the browser hold Pro: the web app
// only learns Pro from RevenueCat, which a test build has no key for.
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

const base = process.env.SMOKE_URL ?? "http://127.0.0.1:4182";
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

console.log("Trajectory AI (phone)");
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await check("sign in with the test sign-in", async () => {
  await page.getByRole("button", { name: "Test sign-in" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Test sign-in" }).click();
  // A fresh mock opens the syllabus import (empty plan); a mock that already holds this account's plan opens Today.
  await page.waitForFunction(() => /^#\/(syllabus|today)/.test(window.location.hash), null, { timeout: 30000 });
});
await check("a class gives Today a plan (the start card hides Ask AI until then, as on the phone)", async () => {
  await page.goto(`${base}/#/classes`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /add a class by hand/i }).click();
  await page.getByLabel("Class name").fill("Principles of Finance");
  await page.getByRole("checkbox", { name: "Monday" }).click();
  await page.getByLabel("Class start time").fill("10:00");
  await page.getByLabel("Class end time").fill("11:15");
  await page.getByRole("button", { name: "Add the class" }).click();
  await page.getByText("Principles of Finance").first().waitFor({ timeout: 10000 });
});
await check("Today shows Ask AI and it opens Trajectory AI", async () => {
  await page.goto(`${base}/#/today`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /^Ask AI\./ }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/ai"), null, { timeout: 10000 });
  await page.getByRole("heading", { name: "Trajectory AI" }).waitFor({ timeout: 10000 });
  await page.getByRole("heading", { name: "Try saying" }).waitFor({ timeout: 10000 });
  await page.getByText("Tell Trajectory what changed. You review every change before it's applied.").waitFor({ timeout: 10000 });
});
await check("the page is Pro here: no PRO tag, and an example fills the box", async () => {
  if (await page.getByText("Trajectory AI is part of Trajectory Pro", { exact: false }).count()) throw new Error("the free page is showing: the build lacks VITE_TEST_PRO=1");
  await page.getByRole("button", { name: /^Use the example: I picked up a Friday shift$/ }).click();
  const value = await page.getByLabel("Say what changed").inputValue();
  if (value !== "I picked up a Friday shift") throw new Error(`the box holds "${value}"`);
});
await check("sending asks for AI consent once, then the mock reply arrives with its AI line", async () => {
  await page.getByLabel("Say what changed").fill("What is due this week?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("heading", { name: "Before you use AI" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Agree and Continue" }).click();
  await page.getByText("Mock reply to: What is due this week?").waitFor({ timeout: 20000 });
  await page.getByText("What is due this week?", { exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /Report this chat reply/ }).first().waitFor({ timeout: 5000 });
  const box = await page.getByLabel("Say what changed").inputValue();
  if (box !== "") throw new Error(`the box was not cleared: "${box}"`);
});
await check("the Report sheet opens with its reasons and closes without sending", async () => {
  await page.getByRole("button", { name: /Report this chat reply/ }).first().click();
  await page.getByRole("heading", { name: "What's wrong with it?" }).waitFor({ timeout: 10000 });
  await page.getByRole("radio", { name: "Wrong dates or times" }).click();
  await page.getByRole("button", { name: "Write report e-mail" }).isEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "What's wrong with it?" }).waitFor({ state: "detached", timeout: 10000 });
});
await check("a second message is sent without asking for consent again", async () => {
  await page.getByLabel("Say what changed").fill("Thanks");
  await page.getByLabel("Say what changed").press("Enter");
  await page.getByText("Mock reply to: Thanks").waitFor({ timeout: 20000 });
  if (await page.getByRole("heading", { name: "Before you use AI" }).count()) throw new Error("the consent sheet came back");
});
await check("new work comes back as a list to check: a found task opens for editing", async () => {
  await page.getByLabel("Say what changed").fill("Add Problem Set 2");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("heading", { name: "To add" }).waitFor({ timeout: 20000 });
  await page.getByText("Study time is planned before each due date. Nothing is added until you say so.").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /^Problem Set 2\. Click to edit$/ }).click();
  await page.getByLabel("Task name").waitFor({ timeout: 5000 });
  await page.getByRole("radio", { name: /^Difficulty 4/ }).click();
  await page.getByRole("button", { name: /^Problem Set 2\. Close$/ }).click();
  await page.getByRole("button", { name: /Report this parsed tasks/ }).waitFor({ timeout: 5000 });
});
await check("Add previews exactly what moves, Apply confirms with its own Undo, and the app-wide snackbar stays hidden here", async () => {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("heading", { name: "Review the changes" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /Report this plan change/ }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Apply changes" }).click();
  // The automatic planner may rebuild the plan while the preview is open (the class added above is planned 1.2 s
  // later, and this test is quick): the preview is then recomputed and shown again instead of applied, as on the
  // phone (src/state/use-replan-flow.ts), and Apply is pressed once more.
  for (let attempt = 0; attempt < 4; attempt++) {
    const confirmed = await page.getByText(/^1 task added\.$/).waitFor({ timeout: 2500 }).then(() => true, () => false);
    if (confirmed) break;
    if (!(await page.getByRole("heading", { name: "Review the changes" }).count())) throw new Error("neither the confirmation nor the preview is shown after Apply");
    await page.getByRole("button", { name: "Apply changes" }).click();
  }
  await page.getByText(/^1 task added\.$/).waitFor({ timeout: 5000 });
  await page.getByText("You can undo it here.").waitFor({ timeout: 5000 });
  if (await page.getByRole("heading", { name: "To add" }).count()) throw new Error("the To add panel is still shown after Apply");
  if (await page.locator(".snack-wrap").isVisible().catch(() => false)) throw new Error("the app-wide undo snackbar is showing on the AI page");
  await page.getByRole("button", { name: "Undo Add 1 task" }).click();
  await page.getByRole("button", { name: "Undo Add 1 task" }).waitFor({ state: "detached", timeout: 10000 });
  await page.goto(`${base}/#/tasks`, { waitUntil: "networkidle" });
  if (await page.getByText("Problem Set 2").count()) throw new Error("the undone task is still in Tasks");
  await page.goto(`${base}/#/ai`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Trajectory AI" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Say what changed").fill("Thanks");
  await page.getByLabel("Say what changed").press("Enter");
  await page.getByText("Mock reply to: Thanks").waitFor({ timeout: 20000 });
});
await check("Clear starts the conversation over", async () => {
  await page.getByRole("button", { name: "Clear the conversation" }).click();
  await page.getByRole("heading", { name: "Try saying" }).waitFor({ timeout: 10000 });
  if (await page.getByText("Mock reply to: Thanks").count()) throw new Error("the old reply is still shown");
});
await check("Week has Ask AI as well, and Close returns to Today", async () => {
  await page.goto(`${base}/#/week`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Ask AI\./ }).click();
  await page.getByRole("heading", { name: "Trajectory AI" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Close Trajectory AI" }).click();
  await page.waitForFunction(() => /#\/(today|week)/.test(window.location.hash), null, { timeout: 10000 });
});
await check("no horizontal page scroll", async () => {
  await page.goto(`${base}/#/ai`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Trajectory AI" }).waitFor({ timeout: 10000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`page is ${overflow}px wider than the viewport`);
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
console.log("\nTrajectory AI: all good");
