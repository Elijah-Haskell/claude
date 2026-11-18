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
    results.push(`FAILED ${name}\n       ${String(err?.message || err).split("\n").slice(0, 4).join("\n       ")}`);
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

  // ---------------------------------------------------------------- intake
  const shot = async (name: string) => {
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `${name}-${label}.png`, fullPage: true });
  };

  await check(`${label}: intake pipeline shows every stage and moves a lead`, async () => {
    await page.goto(base + "/#/intake");
    await page.waitForSelector(".lead-card");
    assert.equal(await page.locator(".intake-col").count(), 6);
    for (const s of ["new", "contacted", "consult_scheduled", "engagement_sent", "hired", "not_hired"]) {
      assert.ok(await page.locator(`.intake-col[data-status=${s}] .lead-card`).count() >= 1, `a lead in ${s}`);
    }
    await noHorizontalScroll();
    await shot("intake-board");
    const card = page.locator(".intake-col[data-status=new] .lead-card").first();
    const name = (await card.locator(".lead-name").innerText()).trim();
    await card.locator(".lead-move").selectOption("contacted");
    await page.waitForSelector(`.intake-col[data-status=contacted] .lead-card:has-text("${name}")`);
  });

  await check(`${label}: lead page: conflict hits, clear, convert dialog`, async () => {
    const id = (db.prepare("SELECT id FROM intake_leads WHERE name = 'Harper Quinn (demo)'").get() as any).id;
    await page.goto(base + `/#/intake/leads/${id}`);
    await page.waitForSelector(".conflict-card .hit");
    assert.match(await page.locator(".conflict-card").innerText(), /Sunflower Coffee Roasters/);
    await noHorizontalScroll();
    await shot("intake-lead");
    if ((await page.locator(".conflict-actions").count()) > 0) {
      await page.locator(".conflict-actions button", { hasText: "Clear" }).click();
      await page.locator("dialog[open] button[type=submit]").click();
      await page.waitForSelector(".conflict-status.cleared");
    }
    await page.locator(".head-actions button", { hasText: "Convert to client" }).click();
    await page.waitForSelector("dialog[open] select");
    assert.match(await page.locator("dialog[open]").innerText(), /opens the client and the matter in one step/);
    await page.locator("dialog[open] button", { hasText: "Cancel" }).click();
    await page.locator(".note-add textarea").fill("Left a voicemail.");
    await page.locator(".note-add button").click();
    await page.waitForSelector(".note-list li:has-text('Left a voicemail.')");
  });

  await check(`${label}: intake list and reports`, async () => {
    await page.goto(base + "/#/intake/list");
    await page.waitForSelector(".leads-table .matter-row");
    await noHorizontalScroll();
    await page.goto(base + "/#/intake/reports");
    await page.waitForSelector(".report-stats");
    assert.match(await page.locator(".definitions").innerText(), /Conversion rate:/);
    await noHorizontalScroll();
    await shot("intake-reports");
  });

  await check(`${label}: intake form builder and booking settings`, async () => {
    await page.goto(base + "/#/settings/intake-forms");
    await page.waitForSelector(".form-list .card");
    await noHorizontalScroll();
    await page.locator(".form-list h3 a").first().click();
    await page.waitForSelector(".q-list .q");
    const before = await page.locator(".q").count();
    await page.locator(".q-add button").click();
    await page.locator(".q").last().locator(".q-label").fill("Is there a deadline coming up?");
    await page.locator(".q").last().locator("select").first().selectOption("yesno");
    await page.locator(".save-bar button[type=submit]").click();
    await page.waitForSelector(".toast:has-text('Form saved')");
    assert.equal(await page.locator(".q").count(), before + 1);
    await noHorizontalScroll();
    await shot("intake-form-builder");
    await page.goto(base + "/#/settings/booking");
    await page.waitForSelector(".person-hours .window-row");
    await noHorizontalScroll();
    await shot("intake-booking-settings");
  });

  await check(`${label}: public intake form creates a lead`, async () => {
    const token = (db.prepare("SELECT token FROM intake_forms WHERE deleted_at IS NULL ORDER BY id LIMIT 1").get() as any).token;
    await page.goto(base + `/intake/form.html?f=${token}`);
    await page.waitForSelector(".public-form");
    assert.match(await page.locator(".public-firm").innerText(), /Reyes & Chen/);
    const who = `Web Visitor ${label} (demo)`;
    await page.getByLabel("Your name").fill(who);
    await page.getByLabel("Email").fill(`visitor-${label}@example.com`);
    await page.getByLabel("Briefly, how can we help?").fill("Need a partnership agreement.");
    await page.locator("input[name^=q-][value=no]").first().check();
    await noHorizontalScroll();
    await shot("intake-public-form");
    await page.waitForTimeout(3100); // the time-to-submit check
    await page.locator(".public-send").click();
    await page.waitForSelector(".public-done");
    assert.ok(db.prepare("SELECT 1 FROM intake_leads WHERE name = ?").get(who), "lead saved");
  });

  await check(`${label}: public booking page books a consultation`, async () => {
    const token = (db.prepare("SELECT booking_token FROM intake_settings").get() as any).booking_token;
    await page.goto(base + `/intake/book.html?b=${token}`);
    await page.waitForSelector(".slot");
    await page.locator(".slot").nth(label === "desktop" ? 1 : 2).click();
    await page.getByLabel("Your name").fill(`Booker ${label} (demo)`);
    await page.getByLabel("Phone").fill("785-555-0111");
    await noHorizontalScroll();
    await shot("intake-public-booking");
    await page.waitForTimeout(3100);
    await page.locator(".public-send").click();
    await page.waitForSelector(".public-done");
    assert.match(await page.locator(".public-done").innerText(), /You're booked/);
    await shot("intake-public-booked");
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
