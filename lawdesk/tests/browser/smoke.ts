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

  await check(`${label}: trust account, deposit, refused overdraft, reconciliation`, async () => {
    await page.goto(base + "/#/trust");
    await page.waitForSelector(".page-head h1:has-text('Client trust accounts')");
    await page.locator("button", { hasText: "New trust account" }).click();
    const dlg = page.locator("dialog[open]");
    await dlg.getByLabel("Account name", { exact: true }).fill(`IOLTA ${label}`);
    await dlg.getByLabel("Bank", { exact: true }).fill("Example Bank (demo)");
    await dlg.locator("button[type=submit]").click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("dialog[open]").count(), 1, "the browser blocks submit until the Kansas box is ticked");
    await dlg.locator("input[type=checkbox]").first().check();
    await dlg.locator("button[type=submit]").click();
    await page.waitForSelector(`h1:has-text('IOLTA ${label}')`);
    await noHorizontalScroll();

    await page.locator(".trust-actions button", { hasText: "Record deposit" }).click();
    const dep = page.locator("dialog[open]");
    await dep.locator("select").first().selectOption({ index: 1 });
    await dep.getByLabel("Amount", { exact: true }).fill("1,250.00");
    await dep.getByLabel("Received from", { exact: true }).fill("Demo client");
    await dep.locator("input[type=checkbox]").check();
    await dep.locator("button[type=submit]").click();
    await page.waitForSelector(".trust-register td:has-text('$1,250.00')");

    await page.locator(".trust-actions button", { hasText: "Record payment" }).click();
    const pay = page.locator("dialog[open]");
    await pay.locator("select").first().selectOption({ index: 1 });
    await pay.getByLabel("Amount", { exact: true }).fill("1250.01");
    await pay.getByLabel("Check number", { exact: true }).fill("1001");
    await pay.getByLabel("Payee", { exact: true }).fill("County clerk");
    await pay.getByLabel("For", { exact: true }).fill("Filing fee");
    await pay.locator("button[type=submit]").click();
    await pay.locator(".error-text:has-text('below zero')").waitFor();
    // That refusal is the point of the check; drop the browser's log line for the 409 it caused.
    const i = errors.findIndex((e) => /status of 409/.test(e));
    if (i >= 0) errors.splice(i, 1);
    await pay.locator("button", { hasText: "Cancel" }).click();

    await page.locator(".segmented button", { hasText: "Client ledgers" }).click();
    await page.waitForSelector(".trust-table td:has-text('$1,250.00')");
    await page.screenshot({ path: shots + `trust-account-${label}.png`, fullPage: true });

    await page.locator("a", { hasText: "Reconcile a month" }).click();
    await page.waitForSelector("h1:has-text('three-way reconciliation')");
    await page.getByLabel("Month", { exact: true }).fill(now.slice(0, 7));
    await page.getByLabel("Statement ending balance", { exact: true }).fill("1,250.00");
    await page.getByLabel("Statement ending balance", { exact: true }).dispatchEvent("change");
    await page.waitForSelector(".trust-verdict.trust-ok");
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `trust-reconcile-${label}.png`, fullPage: true });
    await page.getByLabel("Statement ending balance", { exact: true }).fill("1,249.99");
    await page.getByLabel("Statement ending balance", { exact: true }).dispatchEvent("change");
    await page.waitForSelector(".trust-verdict.trust-bad:has-text('$0.01')");
    assert.ok(await page.locator("button", { hasText: "Sign off and lock" }).isDisabled(), "can't sign when it doesn't balance");
    assert.ok(!(await page.locator("#main").innerText()).match(/\bnull\b|undefined|NaN/), "no stray null/undefined/NaN on the page");

    await page.locator(".trust-crumb a").last().click();
    await page.locator("a", { hasText: "Reports" }).click();
    await page.waitForSelector("h1:has-text('Trust reports')");
    assert.equal(await page.locator(".trust-report").count(), 5);
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `trust-reports-${label}.png`, fullPage: true });
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
