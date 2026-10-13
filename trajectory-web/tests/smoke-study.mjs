// Browser test of the Pro study tools against the mock API (tests/mock-server.mjs, MOCK_PRO=1): sign in, open Study,
// make a study guide from pasted text, open it, make a practice exam and answer a question, open Test review and review
// a page, and open an exam prep whose material the server writes. Expects a build made with
// VITE_API_BASE_URL=http://127.0.0.1:4193 VITE_TEST_SIGN_IN=1 served at SMOKE_URL (default http://127.0.0.1:4183).
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

const base = process.env.SMOKE_URL ?? "http://127.0.0.1:4183";
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

/** A 1x1 PNG, enough for the upload checks (type by the file's name and type, size well under the cap). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const SYLLABUS = [
  "BIOL 101 Introduction to Biology. Fall term.",
  "Week 1: Cell structure. Organelles, membranes and transport. Read chapter 1.",
  "Week 2: Genetics. Mendel, alleles, genotype and phenotype. Read chapter 2.",
  "Week 3: Lab safety and the scientific method. Read the lab manual.",
  "Midterm exam covers weeks 1 to 3.",
].join("\n");

console.log("study tools (phone)");
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await check("signing in opens the app", async () => {
  await page.getByRole("button", { name: "Test sign-in" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForFunction(() => /^#\/(syllabus|today)/.test(window.location.hash), null, { timeout: 30000 });
});

await check("the Study tab lists the four study tools", async () => {
  await page.goto(`${base}/#/study`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Study", exact: true }).waitFor({ timeout: 10000 });
  for (const tool of ["Exam prep", "Study guide", "Practice exam", "Test review"]) await page.getByRole("button", { name: new RegExp(`^${tool}\\. `) }).waitFor({ timeout: 10000 });
});

await check("Study guide opens its list", async () => {
  await page.getByRole("button", { name: /^Study guide\. / }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/study-guides"), null, { timeout: 10000 });
  await page.getByRole("heading", { name: "Study guide" }).waitFor({ timeout: 10000 });
  await page.getByText("No study guides yet").waitFor({ timeout: 10000 });
});

await check("a study guide is built from pasted text (after the AI consent) and opens", async () => {
  await page.getByRole("button", { name: "New study guide" }).click();
  await page.getByRole("dialog", { name: "New study guide" }).waitFor({ timeout: 10000 });
  // No syllabus imported: only the paste box, and the way to the import.
  await page.getByText("No syllabus imported yet").waitFor({ timeout: 5000 });
  await page.getByLabel("Syllabus text").fill(SYLLABUS);
  await page.getByLabel("Course name, optional").fill("Biology 101");
  await page.getByRole("button", { name: "Build study guide" }).click();
  // The first AI request asks for consent.
  await page.getByRole("button", { name: "Agree and Continue" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Agree and Continue" }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/study-guide/"), null, { timeout: 30000 });
  await page.getByRole("heading", { name: "Biology 101" }).waitFor({ timeout: 10000 });
  await page.getByText("Built from text you pasted.").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /^Cell structure, High importance/ }).waitFor({ timeout: 5000 });
  await page.getByText("AI-generated · may be inaccurate").first().waitFor({ timeout: 5000 });
});

await check("a topic opens in place to its key terms", async () => {
  await page.getByRole("button", { name: /^Cell structure, High importance/ }).click();
  await page.getByText("nucleus", { exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("tab", { name: "High importance, 1 topic" }).click();
  await page.getByRole("button", { name: /^Genetics, Medium importance/ }).waitFor({ state: "detached", timeout: 5000 });
  await page.getByRole("tab", { name: "All 3 topics" }).click();
});

await check("a practice exam is made from the guide and opens on its first question", async () => {
  await page.getByRole("button", { name: "Make a practice exam" }).click();
  await page.waitForFunction(() => window.location.hash.startsWith("#/practice-exam/"), null, { timeout: 30000 });
  await page.getByText("Question 1 of 15").waitFor({ timeout: 10000 });
  await page.getByRole("heading", { name: /Which organelle holds the cell's DNA/ }).waitFor({ timeout: 5000 });
});

await check("a multiple-choice answer is submitted and graded, then the next question comes", async () => {
  const submit = page.getByRole("button", { name: "Submit" });
  if (!(await submit.isDisabled())) throw new Error("Submit is on before an answer is chosen");
  await page.getByText("Choose an answer").waitFor({ timeout: 5000 });
  await page.getByRole("radio", { name: /^Option B: Nucleus/ }).click();
  await submit.click();
  await page.getByRole("alert").filter({ hasText: "Correct" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByText("Question 2 of 15").waitFor({ timeout: 5000 });
  await page.getByRole("radio", { name: /^False/ }).click();
  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByText("Incorrect · the answer is True").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Previous question" }).click();
  await page.getByText("Question 1 of 15").waitFor({ timeout: 5000 });
});

await check("the practice list shows the exam, and the guide's button now takes it", async () => {
  await page.goto(`${base}/#/practice`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Practice exam" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /^Biology 101\. Practice exam · 15 questions/ }).waitFor({ timeout: 10000 });
  await page.goto(`${base}/#/study-guides`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Study guide: Biology 101\. 3 topics · practice exam/ }).click();
  await page.getByRole("button", { name: "Take the practice exam" }).waitFor({ timeout: 10000 });
});

await check("Test review opens, waits for a page, uploads one and reviews it", async () => {
  await page.goto(`${base}/#/test-review`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Test review" }).waitFor({ timeout: 10000 });
  await page.getByText("Add at least one page").waitFor({ timeout: 5000 });
  const review = page.getByRole("button", { name: "Review my test" });
  if (!(await review.isDisabled())) throw new Error("Review my test is on with no page");
  await page.getByRole("button", { name: /^Choose photos\. Up to 6 more pages/ }).waitFor({ timeout: 5000 });
  await page.locator('input[type="file"]').setInputFiles({ name: "page1.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("img", { name: "Test page 1" }).waitFor({ timeout: 10000 });
  await page.getByText("1 of 6").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Review my test" }).waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Review my test"]')?.hasAttribute("disabled"), null, { timeout: 10000 });
  await page.getByRole("button", { name: /^Class, optional/ }).click();
  await page.getByRole("dialog", { name: "Class" }).waitFor({ timeout: 5000 });
  await page.getByLabel("Class, optional").fill("Principles of Finance");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Review my test" }).click();
  await page.getByRole("heading", { name: "2 mistakes to learn from" }).waitFor({ timeout: 30000 });
  await page.getByText("Score on the test: 78 of 100").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Question 4: DuPont identity" }).click();
  await page.getByText("ROE = net income / equity").waitFor({ timeout: 5000 });
});

await check("'Review another test' asks first, then starts clean", async () => {
  await page.getByRole("button", { name: "Review another test" }).first().click();
  await page.getByText("Start a new review?").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Start a new review" }).click();
  await page.getByText("0 of 6").waitFor({ timeout: 5000 });
});

await check("an exam prep's material is written by the server and labelled as AI content", async () => {
  await page.goto(`${base}/#/exam-prep`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New exam prep" }).click();
  await page.getByRole("dialog", { name: "New exam prep" }).waitFor({ timeout: 10000 });
  const examDay = new Date(Date.now() + 10 * 86_400_000);
  const key = `${examDay.getFullYear()}-${String(examDay.getMonth() + 1).padStart(2, "0")}-${String(examDay.getDate()).padStart(2, "0")}`;
  await page.getByLabel("Exam date").fill(key);
  await page.getByLabel("Exam topics, one per line").fill("GAAP vs Non-GAAP\nRevenue recognition");
  await page.getByRole("button", { name: "Build exam prep" }).click();
  await page.waitForFunction(() => /^#\/exam-prep\/.+/.test(window.location.hash), null, { timeout: 10000 });
  await page.getByRole("button", { name: "Flashcards, 4" }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Quiz, 2 questions" }).waitFor({ timeout: 5000 });
  await page.getByRole("tab", { name: "Study guide" }).click();
  await page.getByText("AI-generated · may be inaccurate").first().waitFor({ timeout: 5000 });
  await page.getByText("This exam ties together GAAP vs Non-GAAP, Revenue recognition.").waitFor({ timeout: 5000 });
});

await check("the Practice list opens an exam prep's quiz straight away", async () => {
  await page.goto(`${base}/#/practice`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Exam quiz · 2 questions/ }).click();
  await page.waitForFunction(() => /^#\/exam-prep\/.+\?tab=quiz/.test(window.location.hash), null, { timeout: 10000 });
  await page.getByRole("dialog", { name: "Question 1 of 2" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Close the quiz" }).click();
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
console.log("\nstudy tools: all good");
