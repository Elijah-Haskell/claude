// Browser test of the other ways in: a code sent by email, and Google. Expects a build made with
// VITE_EMAIL_SIGN_IN=1 VITE_GOOGLE_CLIENT_ID=mock-google-client against tests/mock-server.mjs, served at SMOKE_URL, and
// the mock at SMOKE_MOCK_URL (its /__test/email-code hands over the code a student would read in the email). Google's
// own script cannot run here, so a stand-in for its button is put in place first: it hands back an ID token for the
// mock's client id carrying the nonce the app gave it, as Google does.
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
const mockBase = process.env.SMOKE_MOCK_URL ?? "http://127.0.0.1:4174";
const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath }).catch(() => chromium.launch());
let failures = 0;
const problems = [];
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message}`);
  }
};
function watch(page) {
  page.on("console", (message) => {
    // A wrong code is answered 401 on purpose; the browser logs every 401 response.
    if (message.type() === "error" && !/status of 401/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
}
/** Google's own script cannot run here: a stand-in for its button, handing back a token as Google does. */
async function withGoogleStandIn(context) {
  await context.addInitScript(() => {
    const encode = (value) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    let config = null;
    window.google = {
      accounts: {
        id: {
          initialize(cfg) {
            config = cfg;
          },
          renderButton(parent) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Mock Google";
            button.onclick = () => {
              const payload = { aud: config.client_id, sub: "google-123", email: "gina@example.com", name: "Gina Google", nonce: config.nonce };
              config.callback({ credential: `${encode({ alg: "none" })}.${encode(payload)}.sig` });
            };
            parent.appendChild(button);
          },
        },
      },
    };
  });
}

async function signOut(page, label) {
  await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: new RegExp(label) }).first().click();
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.getByRole("heading", { name: "Sign out?" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Sign out", exact: true }).last().click();
  await page.getByLabel("Email address").waitFor({ timeout: 20000 });
}

for (const size of [{ width: 390, height: 844, name: "phone" }, { width: 1440, height: 900, name: "desktop" }]) {
  console.log(`other ways in (${size.name})`);
  const email = `student-${size.name}@example.edu`;

  // ── Email ──
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  await withGoogleStandIn(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await check("the sign-in screen offers an email code, and says the iPhone app signs in with Apple", async () => {
    await page.getByLabel("Email address").waitFor({ timeout: 15000 });
    await page.getByText(/Using the iPhone app too\?/).first().waitFor({ timeout: 5000 });
  });
  await check("a typo is caught before anything is sent", async () => {
    await page.getByLabel("Email address").fill("not-an-address");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.getByText(/Enter your email address/).waitFor({ timeout: 5000 });
  });
  await check("the code is sent, a wrong one is refused, the right one signs in", async () => {
    await page.getByLabel("Email address").fill(`  ${email.toUpperCase()} `);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.getByText(/We sent a 6-digit code to/).waitFor({ timeout: 10000 });
    const response = await fetch(`${mockBase}/__test/email-code?email=${encodeURIComponent(email)}`);
    if (!response.ok) throw new Error(`the mock has no code for ${email}`);
    const { code } = await response.json();
    const wrong = code === "000000" ? "111111" : "000000";
    await page.getByLabel("6-digit code").fill(wrong);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText(/isn't right/).waitFor({ timeout: 10000 });
    await page.getByLabel("6-digit code").fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForFunction(() => !window.location.hash.startsWith("#/welcome") && window.location.hash !== "" && window.location.hash !== "#/", null, { timeout: 30000 });
  });
  await check("Settings says the account signs in with email", async () => {
    await page.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
    await page.getByText("Signed in with email").first().waitFor({ timeout: 10000 });
  });
  await check("the delete-account list has no Sign in with Apple line for this account", async () => {
    await page.goto(`${base}/#/delete-account`, { waitUntil: "networkidle" });
    await page.getByText("Your Trajectory account", { exact: true }).first().waitFor({ timeout: 10000 });
    if (await page.getByText(/Sign in with Apple link/).count()) throw new Error("the Apple line is shown for an email account");
  });
  await check("signing out returns to the sign-in screen", async () => {
    await signOut(page, "Signed in with email");
  });
  await context.close();

  // ── Google ──
  const googleContext = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  await withGoogleStandIn(googleContext);
  const gpage = await googleContext.newPage();
  watch(gpage);
  await gpage.goto(`${base}/`, { waitUntil: "networkidle" });
  await check("Continue with Google signs in, with the nonce the app gave Google", async () => {
    await gpage.getByRole("button", { name: "Mock Google" }).click();
    await gpage.waitForFunction(() => !window.location.hash.startsWith("#/welcome") && window.location.hash !== "" && window.location.hash !== "#/", null, { timeout: 30000 });
    await gpage.goto(`${base}/#/settings`, { waitUntil: "networkidle" });
    await gpage.getByText("Signed in with Google").first().waitFor({ timeout: 10000 });
  });
  await check("signing out of the Google account returns to the sign-in screen", async () => {
    await signOut(gpage, "Signed in with Google");
  });
  await googleContext.close();
}
await browser.close();

if (problems.length > 0) {
  failures += problems.length;
  for (const problem of problems) console.log(`  FAIL ${problem}`);
}
console.log(failures === 0 ? "all good" : `${failures} problem${failures === 1 ? "" : "s"}`);
process.exit(failures === 0 ? 0 : 1);
