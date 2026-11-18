// Headless browser smoke test: seeds the demo into an in-memory database, starts the
// server on a free port, clicks through every screen at desktop and phone width and
// saves screenshots to screenshots/. Needs Playwright + Chromium installed globally:
//
//   npm run test:browser
//
// Not part of `npm test`, which stays dependency-free.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { seed } from "../../src/seed.ts";
import { today } from "../../src/dates.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const shots = fileURLToPath(new URL("../../screenshots/", import.meta.url));
mkdirSync(shots, { recursive: true });

const now = today();
const db = openDb();
const demo = seed(db, now);
const server = createServer(db, { today: () => now });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch();
let failures = 0;
const results: string[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push(`ok     ${name}`);
  } catch (err: any) {
    failures++;
    results.push(`FAILED ${name}\n       ${String(err?.message || err).split("\n").slice(0, 12).join("\n       ")}`);
  }
  console.log(results[results.length - 1]);
}

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 860 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript((id: number) => localStorage.setItem("lawdesk.me", String(id)), demo.users.jordan);

  const noHorizontalScroll = async () => {
    const over = await page.evaluate(() => {
      const extra = document.documentElement.scrollWidth - window.innerWidth;
      const wide = [...document.querySelectorAll("body *")]
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 3)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
      return { extra, wide };
    });
    assert.ok(over.extra <= 1, `page scrolls sideways by ${over.extra}px (${over.wide.join(", ")})`);
  };

  await check(`${label}: My tasks shows buckets and waiting reasons`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".task");
    assert.ok(await page.locator("#g-overdue .task").count() > 0, "overdue bucket");
    assert.ok(await page.locator("#g-waiting .waiting-on").count() > 0, "waiting reasons");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `my-tasks-${label}.png`, fullPage: true });
  });

  await check(`${label}: quick-add parses and adds a task`, async () => {
    await page.fill("#quick-add", "Check filing receipt tomorrow #d-1003 !high");
    await page.waitForSelector(".quick-preview .pv:has-text('D-1003')");
    await page.press("#quick-add", "Enter");
    await page.waitForSelector(".task:has-text('Check filing receipt')");
    const row = page.locator(".task", { hasText: "Check filing receipt" });
    assert.match(await row.locator(".chip.due").innerText(), /Tomorrow/);
  });

  await check(`${label}: finish a task, see what it unlocked, undo`, async () => {
    const row = page.locator("#g-overdue .task", { hasText: "Attorney review of articles" });
    await row.locator(".check").click();
    await page.waitForSelector(".toast:has-text('Ready now')");
    assert.equal(await page.locator("#g-overdue .task", { hasText: "Attorney review of articles" }).count(), 0);
    await page.locator(".toast-action", { hasText: "Undo" }).first().click();
    await page.waitForSelector("#g-overdue .task:has-text('Attorney review of articles')");
  });

  await check(`${label}: inline due-date and assignee edits`, async () => {
    const row = page.locator(".task", { hasText: "Check filing receipt" });
    await row.locator(".chip.due").click();
    await page.locator(".popover button", { hasText: "Next Mon" }).click();
    await page.waitForSelector(".toast:has-text('Due ')");
    await page.locator(".task", { hasText: "Check filing receipt" }).locator(".chip.who").click();
    await page.locator(".popover .pop-item", { hasText: "Sam Patel" }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".task")].some((t) => t.textContent!.includes("Check filing receipt")));
  });

  await check(`${label}: keyboard j / x completes the focused task`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".task");
    await page.locator("body").click({ position: { x: 2, y: 300 } });
    await page.keyboard.press("j");
    const title = await page.evaluate(() => (document.activeElement as HTMLElement).querySelector(".task-title-text")?.textContent);
    assert.ok(title, "a task row has focus");
    await page.keyboard.press("x");
    await page.waitForSelector(`.toast:has-text("Done")`);
    await page.locator(".toast-action", { hasText: "Undo" }).first().click();
  });

  await check(`${label}: Firm tasks filters by person`, async () => {
    await page.goto(base + "/#/firm");
    await page.waitForSelector(".load-card");
    await page.locator(".load-card", { hasText: "Sam Patel" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".task").length > 0 && [...document.querySelectorAll(".task .who-name")].every((e) => e.textContent === "Sam Patel"));
    await page.locator(".load-card", { hasText: "Sam Patel" }).click();
    await noHorizontalScroll();
  });

  await check(`${label}: Matters list and matter detail`, async () => {
    await page.goto(base + "/#/matters");
    await page.waitForSelector(".matter-row");
    assert.equal(await page.locator(".matter-row").count(), 5);
    await noHorizontalScroll();
    await page.locator(".matter-row", { hasText: "Riverside Plaza" }).locator("a").first().click();
    await page.waitForSelector(".stage-bar");
    assert.ok(await page.locator(".checklist-group").count() >= 2);
    assert.ok(await page.locator(".waiting-on").count() > 0);
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `matter-${label}.png`, fullPage: true });
  });

  await check(`${label}: changing a key date re-dates tasks`, async () => {
    const input = page.locator(".matter-aside input[type=date][aria-label='Closing date']");
    // Both widths share one database, so each run picks a different date.
    await input.fill(label === "desktop" ? "2027-01-15" : "2027-01-22");
    await input.dispatchEvent("change");
    await page.waitForSelector(".toast:has-text('re-dated')");
  });

  await check(`${label}: moving the stage runs the automation`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m3}`);
    await page.waitForSelector(".stage-bar");
    await page.locator(".stage", { hasText: "Review" }).click();
    await page.waitForSelector(".checklist-group:has-text('Contract review')");
  });

  await check(`${label}: checklist editor loads, edits and saves`, async () => {
    await page.goto(base + `/#/checklists/${demo.lists.llc}`);
    await page.waitForSelector(".step");
    const before = await page.locator(".step").count();
    assert.ok(before >= 9, "the LLC checklist has its steps");
    await page.locator(".add-step").click();
    await page.keyboard.type("Send welcome letter");
    const last = page.locator(".step").last();
    await last.locator(".dep-chip", { hasText: "Apply for EIN" }).click();
    await last.locator(".rule-mode").selectOption("deps");
    assert.match(await page.locator(".step").last().locator(".rule-line").innerText(), /after “Apply for EIN” is done/);
    await page.locator(".save-bar button[type=submit]").click();
    await page.waitForSelector(".toast:has-text('Saved')");
    await page.waitForFunction((n: number) => document.querySelectorAll(".step").length === n, before + 1);
    await noHorizontalScroll();
  });

  await check(`${label}: settings shows every section`, async () => {
    await page.goto(base + "/#/settings");
    await page.waitForSelector("#s-auto");
    for (const id of ["s-people", "s-clients", "s-areas", "s-dates", "s-closed", "s-auto"]) assert.equal(await page.locator("#" + id).count(), 1, id);
    await noHorizontalScroll();
  });

  const clearToasts = () => page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());

  await check(`${label}: contacts list searches names, other names and phones`, async () => {
    await page.goto(base + "/#/contacts");
    await page.waitForSelector(".ct-row");
    assert.ok((await page.locator(".ct-row").count()) >= 16, "every demo contact is listed");
    await page.fill("input[data-search]", "peggy");
    await page.waitForFunction(() => document.querySelectorAll(".ct-row").length === 1);
    assert.match(await page.locator(".ct-row").innerText(), /Margaret Ellison/);
    await page.fill("input[data-search]", "555-0198");
    await page.waitForFunction(() => document.querySelectorAll(".ct-row").length === 1 && document.querySelector(".ct-row")!.textContent!.includes("Dana Whitfield"));
    await page.fill("input[data-search]", "");
    await page.locator(".segmented button", { hasText: "Companies" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".ct-row")].every((r) => r.textContent!.includes("Company")));
    await page.locator(".segmented button", { hasText: "Everyone" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".ct-row").length >= 16);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `contacts-${label}.png`, fullPage: true });
  });

  await check(`${label}: contact page shows details, other names, relationships and matters; edits save`, async () => {
    await page.goto(base + `/#/contacts/${demo.contacts.peggy}`);
    await page.waitForSelector(".ct-details");
    const text = await page.locator(".ct-grid").innerText();
    for (const s of ["Peggy Ellison (demo)", "Maiden name", "an owner of", "Sunflower Coffee Roasters formation", "316-555-0144", "22 Sample Lane"]) assert.ok(text.includes(s), s);
    await page.locator("button", { hasText: "Add phone, email or address" }).click();
    await page.locator(".ct-add-detail select").first().selectOption("address");
    await page.fill(".ct-add-detail input[aria-label='Label']", "Work");
    await page.fill(".ct-add-detail input[aria-label='Street']", label === "desktop" ? "1 Desk Street" : "2 Phone Street");
    await page.fill(".ct-add-detail input[aria-label='City']", "Wichita");
    await page.locator(".ct-add-detail button[type=submit]").click();
    await page.waitForSelector(`.ct-dl:has-text('${label === "desktop" ? "1 Desk Street" : "2 Phone Street"}')`);
    await page.fill(".ct-inline-form input", label === "desktop" ? "Maggie Ellison (demo)" : "Meg Ellison (demo)");
    await page.locator(".ct-inline-form button").click();
    await page.waitForSelector(`.ct-list:has-text('${label === "desktop" ? "Maggie" : "Meg"} Ellison')`);
    // A relationship in the other direction, to a new contact.
    await page.locator(".ct-rel-form button", { hasText: "Swap sides" }).click();
    await page.fill(".ct-rel-form .picker input", label === "desktop" ? "Ellison Family Trust (demo)" : "Ellison Holdings (demo)");
    await page.locator(".ct-rel-form select[aria-label='New contact is a']").selectOption("company");
    await page.locator(".ct-rel-form select[aria-label='Relationship']").selectOption("affiliate");
    await page.locator(".ct-rel-form button[type=submit]").click();
    await page.waitForSelector(`.ct-rels:has-text('is an affiliate of')`);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `contact-${label}.png`, fullPage: true });
  });

  await check(`${label}: new contact warns about similar names`, async () => {
    await page.goto(base + "/#/contacts");
    await page.locator("button", { hasText: "New contact" }).click();
    await page.fill("dialog input >> nth=0", "Sunflower Coffee Roasters");
    await page.waitForSelector("dialog .similar-box:has-text('Sunflower Coffee Roasters LLC')");
    await page.fill("dialog input >> nth=0", label === "desktop" ? "Prairie Rose Bakery (demo)" : "Prairie Rose Catering (demo)");
    await page.locator("dialog select").first().selectOption("company");
    await page.locator("dialog button[type=submit]").click();
    await page.waitForSelector(`h1:has-text('Prairie Rose')`);
  });

  let checkId = 0;
  await check(`${label}: conflict check finds a current client named as adverse party; waiver needs a note`, async () => {
    await page.goto(base + "/#/conflicts");
    await page.waitForSelector(".cc-term");
    await page.fill(".cc-term >> nth=0 >> input", "Bob Klein");
    await page.locator(".cc-term >> nth=0 >> select >> nth=0").selectOption("person");
    await page.fill(".cc-term >> nth=1 >> input", "Prairie Wind Solar");
    await page.locator(".cc-term >> nth=1 >> select >> nth=0").selectOption("company");
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `conflict-new-${label}.png`, fullPage: true });
    await page.locator("button", { hasText: "Run conflict check" }).click();
    await page.waitForSelector(".cc-hit");
    checkId = Number(/#\/conflicts\/(\d+)/.exec(page.url())![1]);
    const text = await page.locator(".cc-main").innerText();
    assert.match(text, /Proposed adverse party is a current client/);
    assert.match(text, /a common nickname/);
    assert.ok(!/\b0\.\d\d\b/.test(text), "no raw scores on screen");
    await page.locator(".cc-choice", { hasText: "Waived" }).click();
    await page.locator(".cc-decision button[type=submit]").click();
    await page.waitForSelector(".cc-decision .error-text:has-text('written consent')");
    await page.fill(".cc-decision textarea", "Written consent from both clients in the file, signed Nov 2026.");
    await page.locator(".cc-decision button[type=submit]").click();
    await page.waitForSelector(".cc-decision .status-pill.waived");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `conflict-check-${label}.png`, fullPage: true });
  });

  await check(`${label}: printable conflict report`, async () => {
    const r = await page.request.get(base + `/api/conflict-checks/${checkId}/report`);
    assert.equal(r.status(), 200);
    assert.match(r.headers()["content-security-policy"], /default-src 'none'/);
    const html = await r.text();
    for (const s of ["Conflict of Interest Check", "Prairie Wind Solar", "Waived", "Written consent"]) assert.ok(html.includes(s), s);
    const rp = await ctx.newPage();
    await rp.goto(base + `/api/conflict-checks/${checkId}/report`);
    await rp.screenshot({ path: shots + `conflict-report-${label}.png`, fullPage: true });
    await rp.close();
    const dl = await page.request.get(base + `/api/conflict-checks/${checkId}/report?download=1`);
    assert.match(dl.headers()["content-disposition"], /attachment/);
  });

  await check(`${label}: saved checks filter by decision and name`, async () => {
    await page.goto(base + "/#/conflicts/history");
    await page.waitForSelector(".cc-row");
    await page.locator(".segmented button", { hasText: "Awaiting decision" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".cc-row")].length > 0 && [...document.querySelectorAll(".cc-row")].every((r) => r.textContent!.includes("Awaiting decision")));
    await page.locator(".segmented button", { hasText: "All" }).click();
    await page.fill("input[data-search]", "cottonwood");
    await page.waitForFunction(() => document.querySelectorAll(".cc-row").length === 1 && document.querySelector(".cc-row")!.textContent!.includes("Cleared"));
    await page.fill("input[data-search]", "");
    await page.locator("select[aria-label='Result']").selectOption("strong");
    await page.waitForFunction(() => document.querySelectorAll(".cc-row").length >= 1 && [...document.querySelectorAll(".cc-row")].every((r) => / strong/.test(r.textContent!)));
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `conflict-history-${label}.png`, fullPage: true });
  });

  await check(`${label}: matter page shows parties and conflict status; add a party`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m3}`);
    await page.waitForSelector(".parties-card .party-list");
    assert.match(await page.locator(".parties-card").innerText(), /Cottonwood Office Park/);
    await page.waitForSelector(".cc-status-card .status-pill.cleared");
    await page.locator(".parties-card button", { hasText: "Add a party" }).click();
    await page.fill(".parties-card .picker input", label === "desktop" ? "Alex Moreno (demo)" : "Jamie Moreno (demo)");
    await page.locator(".parties-card select[aria-label='Role']").selectOption("opposing_counsel");
    await page.locator(".parties-card button[type=submit]").click();
    await page.waitForSelector(`.party-list:has-text('Moreno')`);
    await page.waitForSelector(".cc-status-card .cc-warn:has-text('added after this check')");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `matter-parties-${label}.png`, fullPage: true });
  });

  // Desktop declines (so the phone run still sees five open matters); the phone opens one.
  await check(`${label}: new matter runs a conflict check and needs a decision`, async () => {
    await page.goto(base + "/#/matters");
    await page.locator("button", { hasText: "New matter" }).click();
    await page.fill("dialog input[name=name]", label === "desktop" ? "Panel warranty claim" : "Panel warranty dispute");
    await page.fill("dialog input[name=number]", label === "desktop" ? "D-2001" : "D-2002");
    await page.locator("dialog select[name=client]").selectOption({ label: "Prairie Wind Solar Inc. (demo)" });
    await page.fill("dialog .intake-party input", "Kestrel Panel Manufacturing Co. (demo)");
    const submit = page.locator("dialog .form-actions button[type=submit]");
    assert.equal(await submit.innerText(), "Check for conflicts");
    await submit.click();
    await page.waitForSelector("dialog .intake-panel .intake-status:has-text('Saved as check no.')");
    assert.match(await page.locator("dialog .intake-own").innerText(), /Kestrel Panel Manufacturing/, "contacts picked from the list are noted, not flagged");
    await submit.click();
    await page.waitForSelector("dialog .intake-panel .error-text:has-text('Choose cleared')");
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `new-matter-conflicts-${label}.png`, fullPage: false });
    if (label === "desktop") {
      await page.locator("dialog .cc-choice", { hasText: "Declined" }).click();
      assert.match(await submit.innerText(), /matter not opened/);
      await submit.click();
      await page.waitForSelector(".toast:has-text('declined')");
      assert.equal(await page.locator("dialog[open]").count(), 0);
      assert.equal(await page.locator(".matter-row", { hasText: "Panel warranty" }).count(), 0);
    } else {
      // Changing a name makes the check out of date.
      await page.fill("dialog .intake-party input", "Kestrel Panel Manufacturing");
      await page.waitForFunction(() => document.querySelector("dialog .form-actions button[type=submit]")!.textContent === "Check for conflicts");
      await submit.click();
      await page.waitForSelector("dialog .intake-panel:not([hidden]) .cc-hit");
      await page.locator("dialog .cc-choice", { hasText: "Cleared" }).click();
      await submit.click();
      await page.waitForSelector(".matter-page .parties-card .party-list:has-text('Kestrel Panel Manufacturing')");
      await page.waitForSelector(".cc-status-card .status-pill.cleared");
    }
  });

  await check(`${label}: no script errors`, async () => {
    assert.deepEqual(errors, []);
  });
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${results.length - failures} passed, ${failures} failed. Screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
