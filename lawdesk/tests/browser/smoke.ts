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

  // ------------------------------------------------------------- billing
  const pickOption = async (sel: string, text: string) => {
    const value = await page.evaluate(
      ([s, t]: string[]) => [...(document.querySelector(s) as HTMLSelectElement).options].find((o) => o.textContent!.includes(t))?.value,
      [sel, text],
    );
    assert.ok(value, `option "${text}" in ${sel}`);
    await page.selectOption(sel, value!);
  };
  const clearToasts = () => page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());

  await check(`${label}: billing time: quick entry takes 1:30 and the week adds up`, async () => {
    await page.goto(base + "/#/billing");
    await page.waitForSelector(".bl-quick");
    assert.match(page.url(), /#\/billing\/time$/);
    await pickOption("#qt-matter", "D-1004");
    await page.fill("#qt-hours", "1:30");
    await page.fill("#qt-desc", `Reviewed exhibits (${label})`);
    await page.locator(".bl-quick button[type=submit]").click();
    await page.waitForSelector(`.bl-entry:has-text("Reviewed exhibits (${label})")`);
    assert.equal(await page.locator(`.bl-entry:has-text("Reviewed exhibits (${label})") .bl-entry-hours`).innerText(), "1.5");
    await page.fill("#qt-hours", "abc");
    await page.locator(".bl-quick button[type=submit]").click();
    await page.waitForSelector(".bl-quick .error-text:has-text('1.5 or 1:30')");
    await page.fill("#qt-hours", "");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `billing-time-${label}.png`, fullPage: true });
  });

  await check(`${label}: billing timer keeps running across pages and stops from the header`, async () => {
    await pickOption("#qt-matter", "D-1005");
    await page.fill("#qt-desc", "Timer test");
    await page.click("#qt-timer");
    await page.waitForSelector(".bl-timer:not([hidden]) .bl-timer-clock");
    await page.waitForSelector(".bl-running");
    await page.goto(base + "/#/matters");
    await page.waitForSelector(".matter-row");
    await page.waitForSelector(".bl-timer:not([hidden])");
    assert.match(await page.locator(".bl-timer").innerText(), /D-1005/);
    await noHorizontalScroll();
    await page.locator(".bl-timer-stop").click();
    await page.waitForSelector(".bl-timer[hidden]", { state: "attached" });
  });

  await check(`${label}: billing expenses: add one`, async () => {
    await page.goto(base + "/#/billing/expenses");
    await page.waitForSelector(".bl-exp-table");
    await pickOption("#qe-matter", "D-1004");
    await page.fill("#qe-desc", `Courier (${label})`);
    await page.fill("#qe-amount", "42.10");
    await page.locator(".bl-quick button[type=submit]").click();
    await page.waitForSelector(`.bl-exp-table tr:has-text("Courier (${label})"):has-text("$42.10")`);
    await noHorizontalScroll();
  });

  await check(`${label}: billing invoices: amounts owed by age and the list`, async () => {
    await page.goto(base + "/#/billing/invoices");
    await page.waitForSelector(".bl-aging .bl-figure");
    assert.equal(await page.locator(".bl-aging .bl-figure").count(), 6);
    assert.ok(await page.locator(".bl-inv-table tr:has-text('No. 1001')").count() === 1, "invoice 1001 awaits payment");
    assert.match(await page.locator(".bl-inv-table tr:has-text('No. 1001') .bl-status").innerText(), /Past due/);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `billing-invoices-${label}.png`, fullPage: true });
  });

  let invoiceUrl = "";
  await check(`${label}: billing matter card starts an invoice; edit, write down, discount, finalize`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m2}`);
    await page.waitForSelector("#matter-billing .bl-mc-row");
    assert.match(await page.locator("#matter-billing").innerText(), /Unbilled time/);
    await page.click("#mc-start-invoice");
    await page.waitForSelector(".bl-preview-list");
    await page.locator("dialog button[type=submit]", { hasText: "Create draft" }).click();
    await page.waitForSelector(".bl-invoice-page .bl-line-table");
    invoiceUrl = page.url();
    const firstLine = page.locator(".bl-line-table tbody tr").first();
    await firstLine.locator(".bl-line-actions button", { hasText: "Write down" }).click();
    await page.fill("#wd-amount", "10");
    await page.locator("dialog button[type=submit]", { hasText: "Write down" }).click();
    await page.waitForSelector("dialog .error-text:has-text('reason')");
    await page.fill("#wd-reason", "Courtesy reduction");
    await page.locator("dialog button[type=submit]", { hasText: "Write down" }).click();
    await page.waitForSelector(".bl-line-note.wd:has-text('Courtesy reduction')");
    await page.click("#inv-add-line");
    await page.selectOption("dialog select", "flat");
    await page.fill("dialog textarea", "Document preparation");
    await page.locator("dialog input.bl-money:visible").fill("75");
    await page.locator("dialog button[type=submit]", { hasText: "Add line" }).click();
    await page.waitForSelector(".bl-line-table tr:has-text('Document preparation')");
    await page.selectOption("#inv-discount-kind", "percent");
    await page.fill("#inv-discount-value", "5");
    await page.press("#inv-discount-value", "Tab");
    await page.waitForSelector(".bl-totals:has-text('Discount (5%)')");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `billing-draft-${label}.png`, fullPage: true });
    await page.click("#inv-finalize");
    await page.waitForSelector("dialog .bl-confirm-facts");
    await page.locator("dialog button", { hasText: "Cancel" }).click();
    assert.match(await page.locator("h1").innerText(), /Draft invoice/);
    await page.click("#inv-finalize");
    await page.locator("dialog button[type=submit]", { hasText: "Finalize invoice" }).click();
    await page.waitForFunction(() => /Invoice \d+/.test(document.querySelector("h1")!.textContent!));
    assert.equal(await page.locator("#inv-add-line").count(), 0, "a finalized invoice can't be edited");
    await clearToasts();
    await page.screenshot({ path: shots + `billing-invoice-${label}.png`, fullPage: true });
  });

  await check(`${label}: billing printable invoice opens with a Print button and no errors`, async () => {
    const href = await page.locator("#inv-print").getAttribute("href");
    const p2 = await ctx.newPage();
    const errs: string[] = [];
    p2.on("console", (m: any) => m.type() === "error" && errs.push(m.text()));
    await p2.goto(base + href);
    await p2.waitForSelector("#ld-print");
    assert.match(await p2.locator("h1").innerText(), /Reyes & Chen/);
    assert.ok(await p2.evaluate(() => getComputedStyle(document.querySelector(".totals")!).width !== "auto"), "inline styles apply");
    if (label === "desktop") await p2.screenshot({ path: shots + `billing-print-${label}.png`, fullPage: true });
    await p2.close();
    assert.deepEqual(errs, []);
  });

  await check(`${label}: billing record a payment across invoices, then void the invoice`, async () => {
    const id = invoiceUrl.split("/").pop();
    await page.goto(base + `/#/billing/payments?invoice=${id}`);
    await page.waitForSelector(".bl-apply-table");
    assert.notEqual(await page.inputValue("#pay-total"), "");
    await page.fill("#pay-total", "100");
    await page.click("#pay-auto");
    await page.waitForSelector(".bl-apply-summary:has-text('$100.00')");
    await page.click("#pay-submit");
    await page.waitForSelector("dialog .bl-confirm-facts");
    await page.locator("dialog button[type=submit]", { hasText: "Record payment" }).click();
    await page.waitForSelector(".toast:has-text('Payment of $100.00 recorded')");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `billing-payments-${label}.png`, fullPage: true });
    await page.goto(invoiceUrl);
    await page.waitForSelector(".bl-pay-list li");
    assert.match(await page.locator(".bl-status").first().innerText(), /Partly paid/);
    await page.click("#inv-void");
    await page.locator("dialog button[type=submit]", { hasText: "Void invoice" }).click();
    await page.waitForSelector("dialog .error-text:has-text('reason')");
    await page.fill("dialog textarea", "Billed to the wrong matter");
    await page.locator("dialog button[type=submit]", { hasText: "Void invoice" }).click();
    await page.waitForSelector(".bl-banner.void:has-text('Billed to the wrong matter')");
  });

  await check(`${label}: billing client statement`, async () => {
    await page.goto(base + "/#/billing/statements");
    await page.waitForSelector("#st-client");
    await pickOption("#st-client", "Meadowlark");
    await page.waitForSelector(".bl-st-table");
    assert.ok(await page.locator(".bl-st-table tr:has-text('Payment received')").count() >= 1);
    assert.match(await page.locator(".bl-st-close").innerText(), /Amount due\s+\$799\.50/);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `billing-statement-${label}.png`, fullPage: true });
  });

  await check(`${label}: billing settings save the firm rate`, async () => {
    await page.goto(base + "/#/billing/settings");
    await page.waitForSelector("#bs-rate");
    assert.equal(await page.inputValue("#bs-rate"), "250.00");
    assert.ok(await page.locator("#bs-first").isDisabled(), "numbering has started");
    assert.equal(await page.locator("#bs-tax").isChecked(), false);
    await page.fill("#bs-rate", "250");
    await page.press("#bs-rate", "Tab");
    await page.waitForSelector(".toast:has-text('Firm rate saved')");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `billing-settings-${label}.png`, fullPage: true });
  });

  await check(`${label}: billing Log time from a task's menu links the task`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m2}`);
    await page.waitForSelector(".task:has-text('indemnity cap')");
    const row = page.locator(".task", { hasText: "Call client about the indemnity cap" });
    await row.locator(".more").click();
    await page.locator(".popover .pop-item", { hasText: "Log time" }).click();
    await page.waitForSelector("dialog .bl-linked:has-text('indemnity cap')");
    await page.fill("dialog .bl-hours", "0.3");
    await page.locator("dialog button[type=submit]", { hasText: "Save time" }).click();
    await page.waitForSelector(".toast:has-text('Logged 0.3 hours')");
    await clearToasts();
    await page.screenshot({ path: shots + `billing-matter-${label}.png`, fullPage: true });
  });

  await check(`${label}: settings shows every section`, async () => {
    await page.goto(base + "/#/settings");
    await page.waitForSelector("#s-auto");
    for (const id of ["s-people", "s-clients", "s-areas", "s-dates", "s-closed", "s-auto"]) assert.equal(await page.locator("#" + id).count(), 1, id);
    await noHorizontalScroll();
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
