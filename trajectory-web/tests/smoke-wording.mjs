// Browser test of what a web visitor reads: every screen, signed out and signed in, at phone and desktop width, must
// not talk like the iPhone app ("this iPhone", "tap", iOS Settings). The words visible on the page and the labels a
// screen reader announces are both checked. A few sentences are about the iPhone app on purpose (where a purchase
// made there is managed, which calendars only the iPhone app reads); they are listed in ALLOWED. The privacy policy
// is left out: it describes both apps on purpose. Expects a build made with VITE_TEST_SIGN_IN=1 and VITE_TEST_PRO=1
// against tests/mock-server.mjs (MOCK_PRO=1), served at SMOKE_URL.
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

/** Phrases that only make sense in the iPhone app. */
const IPHONE_ONLY = /\b(this|each|an|your) iPhone\b|\biOS\b|\bKeychain\b|\b[Tt]ap(?:s|ped|ping)?\b|\bswipe\b|\blong[- ]press\b/;
/** Sentences that are about the iPhone app on purpose. */
const ALLOWED = [
  /Your iPhone's calendars are read in the iPhone app\./,
  /a subscription bought on your iPhone is (?:cancelled|managed) in iOS Settings/,
  /A subscription bought on your iPhone is managed in iOS Settings/,
];
const ROUTES = [
  "today", "week", "tasks", "study", "classes", "activities", "settings", "syllabus", "imports", "ai",
  "study-guides", "practice", "test-review", "exam-prep", "course-feeds", "calendars", "reminders", "paywall",
  "delete-account",
];

const browser = await chromium.launch({ executablePath }).catch(() => chromium.launch());
let failures = 0;
const found = new Map();

function sentencesOf(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}
async function scan(page, where) {
  const texts = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("[aria-label],[title],[placeholder]")).flatMap((el) =>
      ["aria-label", "title", "placeholder"].map((name) => el.getAttribute(name) ?? "").filter(Boolean),
    );
    return [document.body.innerText, ...labels];
  });
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      if (!IPHONE_ONLY.test(sentence) || ALLOWED.some((ok) => ok.test(sentence))) continue;
      if (!found.has(sentence)) found.set(sentence, new Set());
      found.get(sentence).add(where);
    }
  }
}

for (const size of [{ width: 390, height: 844, name: "phone" }, { width: 1280, height: 860, name: "desktop" }]) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Test sign-in" }).waitFor({ timeout: 15000 });
  await scan(page, `${size.name} sign-in screen`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForFunction(() => !window.location.hash.startsWith("#/welcome") && window.location.hash !== "", null, { timeout: 20000 });
  for (const route of ROUTES) {
    await page.goto(`${base}/#/${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await scan(page, `${size.name} ${route}`);
  }
  // The account sheet in Settings (sign out, delete account).
  await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
  const account = page.getByText("Signed in with Apple").first();
  if (await account.count()) {
    await account.click();
    await page.waitForTimeout(400);
    await scan(page, `${size.name} settings account sheet`);
  }
  await context.close();
}
await browser.close();

if (found.size === 0) {
  console.log("  ok   no iPhone-only wording on any screen (phone and desktop)");
} else {
  failures = found.size;
  for (const [sentence, places] of found) console.log(`  FAIL "${sentence}" (${[...places].slice(0, 3).join(", ")}${places.size > 3 ? ", …" : ""})`);
}
process.exit(failures > 0 ? 1 : 0);
