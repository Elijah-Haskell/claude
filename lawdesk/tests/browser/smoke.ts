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
import { addReportsDemo } from "./reports-demo.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMessage } from "../../src/email/mime.ts";

// Dev mail and uploaded files go to a throwaway folder, not the working tree.
const scratch = mkdtempSync(join(tmpdir(), "lawdesk-smoke-"));
process.env.LAWDESK_MAIL_DIR ??= join(scratch, "mail");
process.env.LAWDESK_FILES ??= join(scratch, "files");
delete process.env.LAWDESK_MAIL_TRANSPORT;

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const shots = fileURLToPath(new URL("../../screenshots/", import.meta.url));
mkdirSync(shots, { recursive: true });

const now = today();
const db = openDb();
const demo = seed(db, now);
addReportsDemo(db, now, demo);
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

  // ------------------------------------------------------------ calendar
  const nextTuesday = (() => {
    let d = now;
    do d = new Date(Date.parse(d + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10);
    while (new Date(d + "T12:00:00Z").getUTCDay() !== 2);
    return d;
  })();

  await check(`${label}: My tasks shows today's calendar`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".cal-today h2:has-text(\"Today's calendar\")");
    await page.waitForSelector(".cal-today :is(.cal-line, p.muted)");
  });

  await check(`${label}: calendar month shows events and tasks`, async () => {
    await page.evaluate(() => {
      localStorage.setItem("lawdesk.cal.view", "month");
      localStorage.setItem("lawdesk.cal.scope", "firm");
    });
    await page.goto(base + "/#/calendar");
    await page.waitForSelector(".cal-month .cal-cell");
    assert.equal(await page.locator(".cal-month .cal-cell").count(), 42);
    await page.waitForSelector(".cal-daypanel");
    if (label === "desktop") {
      assert.ok(await page.locator(".cal-chip", { hasText: "Staff meeting" }).count() >= 3, "weekly staff meeting");
      assert.ok(await page.locator(".cal-chip.is-task").count() > 0, "task due dates shown as tasks");
    } else assert.ok(await page.locator(".cal-dot").count() > 0, "phone month shows dots");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `calendar-month-${label}.png`, fullPage: true });
  });

  await check(`${label}: new repeating event warns about double-booking`, async () => {
    await page.locator(".page-head button", { hasText: "New event" }).click();
    const dlg = page.locator("dialog.cal-dialog");
    await dlg.locator("input[name=title]").fill(`Case strategy ${label}`);
    await dlg.locator("select[name=matter]").selectOption({ label: "D-1002 Riverside Plaza purchase" });
    await dlg.locator("input[name=date]").fill(nextTuesday);
    await dlg.locator("input[name=date]").dispatchEvent("change");
    await dlg.locator("input[name=startTime]").fill("09:00");
    await dlg.locator("input[name=endTime]").fill("09:30");
    const options = await dlg.locator("select[name=repeat] option").allInnerTexts();
    assert.ok(options.includes("Every week on Tuesday"), options.join(" | "));
    assert.ok(options.some((o) => / Tuesday of each month$/.test(o)), "nth weekday of the month");
    await dlg.locator("select[name=repeat]").selectOption({ label: "Every week on Tuesday" });
    await dlg.locator("select[name=repeatEnds]").selectOption("count");
    await dlg.locator("button[type=submit]").click();
    await dlg.locator(".cal-warning:has-text('Staff meeting')").waitFor();
    assert.equal(await dlg.locator("button[type=submit]").innerText(), "Save anyway");
    await page.screenshot({ path: shots + `calendar-event-dialog-${label}.png` });
    await dlg.locator("button[type=submit]").click();
    await page.waitForSelector(`.toast:has-text("Case strategy ${label}")`);
    await page.waitForSelector(".toast:has-text('Double-booked')");
  });

  await check(`${label}: week and list views; cancel one date of a series`, async () => {
    await page.locator(".segmented button", { hasText: "Week" }).click();
    await page.waitForSelector(label === "desktop" ? ".cal-week .cal-block" : ".cal-list-day");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `calendar-week-${label}.png`, fullPage: true });
    await page.locator(".segmented button", { hasText: "List" }).click();
    await page.waitForSelector(".cal-list .cal-line");
    await noHorizontalScroll();
    const before = await page.locator(".cal-line", { hasText: `Case strategy ${label}` }).count();
    assert.ok(before >= 1, "the new series is listed");
    await page.locator(".cal-line", { hasText: `Case strategy ${label}` }).first().locator("button").click();
    page.once("dialog", (d: any) => d.accept());
    await page.locator("dialog.cal-dialog button", { hasText: "Cancel this date" }).click();
    await page.waitForSelector(".toast:has-text('Cancelled that date')");
    await page.waitForFunction(
      ([t, n]: [string, number]) => [...document.querySelectorAll(".cal-line")].filter((e) => e.textContent!.includes(t)).length === n - 1,
      [`Case strategy ${label}`, before] as [string, number],
    );
    await page.screenshot({ path: shots + `calendar-list-${label}.png`, fullPage: true });
  });

  await check(`${label}: import an .ics file`, async () => {
    await page.locator(".page-head button", { hasText: "Import a calendar file" }).click();
    const dlg = page.locator("dialog.cal-dialog");
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demo//EN", "BEGIN:VEVENT", `UID:smoke-${label}@example.com`,
      `DTSTAMP:20261101T000000Z`, `DTSTART;VALUE=DATE:${nextTuesday.replaceAll("-", "")}`, `SUMMARY:Imported docket call ${label}`,
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    await dlg.locator("input[type=file]").setInputFiles({ name: "court.ics", mimeType: "text/calendar", buffer: Buffer.from(ics) });
    await dlg.locator("button[type=submit]").click();
    await dlg.locator(".cal-import-result:has-text('1 event added')").waitFor();
    await dlg.locator("button", { hasText: "Close" }).last().click();
    await page.waitForSelector(`.cal-line:has-text("Imported docket call ${label}")`);
  });

  await check(`${label}: subscribe link: make, read, turn off`, async () => {
    await page.locator(".page-head button", { hasText: "Subscribe" }).click();
    const dlg = page.locator("dialog.cal-dialog");
    await dlg.locator(".cal-steps li").first().waitFor();
    await dlg.locator(".cal-app-tabs button", { hasText: "Google Calendar" }).click();
    assert.match(await dlg.locator(".cal-steps").innerText(), /From URL/);
    await dlg.locator(".cal-feed-form input").fill(`Smoke ${label}`);
    await dlg.locator(".cal-feed-form button[type=submit]").click();
    const url = await dlg.locator("input.cal-feed-url").inputValue();
    assert.match(url, /\/api\/calendar\/feed\/[\w-]+\.ics$/);
    const feed = await fetch(url);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), /BEGIN:VCALENDAR/);
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `calendar-subscribe-${label}.png` });
    page.once("dialog", (d: any) => d.accept());
    await dlg.locator(".cal-feed-list li", { hasText: `Smoke ${label}` }).locator("button", { hasText: "Turn off" }).click();
    await page.waitForSelector(".toast:has-text('Link turned off')");
    assert.equal((await fetch(url)).status, 404);
    await dlg.locator(".modal-head button").click();
  });

  // ------------------------------------------------------ deadline calculator
  await check(`${label}: deadline calculator shows working, warnings and disclaimer`, async () => {
    await page.goto(base + `/#/deadlines/${demo.matters.m2}`);
    await page.waitForSelector("#dl-rule");
    await page.waitForSelector(".dl-disclaimer");
    await page.selectOption("#dl-rule", "interrogatory-answers");
    await page.fill("#dl-trigger", "2026-10-01");
    await page.locator("#dl-trigger").dispatchEvent("change");
    await page.selectOption("#dl-service", "mail");
    await page.waitForSelector(".dl-date:has-text('Thursday, November 5, 2026')");
    assert.ok(await page.locator(".dl-steps li").count() >= 4, "steps shown");
    assert.ok(await page.locator(".dl-disclaimer").isVisible(), "disclaimer visible");
    assert.ok(await page.locator(".dl-sources a", { hasText: "K.S.A. 60-233" }).count() > 0, "citation");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `deadlines-${label}.png`, fullPage: true });
  });

  await check(`${label}: add a deadline to a matter as event and task`, async () => {
    // A trigger date of today keeps the deadline in the future, so it shows under Upcoming.
    await page.fill("#dl-trigger", now);
    await page.locator("#dl-trigger").dispatchEvent("change");
    await page.waitForFunction(() => !document.querySelector(".dl-date")?.textContent?.includes("November 5, 2026"));
    assert.equal(await page.locator("#dl-matter").inputValue(), String(demo.matters.m2));
    await page.fill("#dl-title", `Interrogatory answers due ${label}`);
    await page.locator("#dl-add").click();
    await page.waitForSelector(".dl-added");
    assert.ok(await page.locator(".dl-disclaimer").isVisible(), "disclaimer still visible");
    await page.goto(base + `/#/matters/${demo.matters.m2}`);
    await page.waitForSelector(`.cal-upcoming .cal-line:has-text("Interrogatory answers due ${label}")`);
    const task = page.locator(".task", { hasText: `Interrogatory answers due ${label}` });
    await task.waitFor();
    assert.ok(await task.evaluate((e) => e.classList.contains("prio-high")), "high-priority task");
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `matter-upcoming-${label}.png`, fullPage: true });
    await page.locator(".cal-upcoming .cal-line", { hasText: `Interrogatory answers due ${label}` }).locator("button").click();
    const notes = await page.locator("dialog.cal-dialog .cal-notes").innerText();
    assert.match(notes, /How it was computed/);
    assert.match(notes, /VERIFY THIS DATE/);
    await page.locator("dialog.cal-dialog .modal-head button").click();
  });

  await check(`${label}: firm overview shows figures, charts and lists that link to fixes`, async () => {
    await page.goto(base + "/#/overview");
    await page.waitForSelector(".ov-tile");
    assert.equal(await page.locator(".ov-tile").count(), 5);
    const firmOverdue = await page.evaluate(async () => {
      const r = await fetch("/api/firm-tasks").then((x) => x.json());
      return r.tasks.filter((x: any) => x.status === "open" && x.due_date && x.due_date < r.today).length;
    });
    assert.equal(await page.locator("#t-overdue .stat-n").innerText(), String(firmOverdue), "overdue tile matches Firm tasks");
    await page.waitForFunction(() => document.querySelectorAll(".chart svg").length >= 4);
    assert.ok(await page.locator(".ov-attn").count() === 4);
    assert.ok(await page.locator(".ov-attn .ov-list li").count() >= 3, "attention lists have items");
    assert.match(await page.locator(".ov-attn", { hasText: "Conflict checks" }).innerText(), /Prairie Wind/);
    assert.match(await page.locator(".ov-attn", { hasText: "days past due" }).innerText(), /Invoice \d+/);
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `overview-${label}.png`, fullPage: true });
    await page.locator("#t-owed").click();
    await page.waitForSelector(".report-page[data-report=aging] #rp-table");
    assert.match(await page.locator("#rp-table tfoot").innerText(), /\$/);
  });

  await check(`${label}: reports list, filters, table, CSV and print view`, async () => {
    await page.goto(base + "/#/reports");
    await page.waitForSelector(".rp-card");
    assert.equal(await page.locator(".rp-card").count(), 8);
    await page.locator(".rp-card[data-report=productivity]").click();
    await page.waitForSelector(".report-page[data-report=productivity]");
    await page.locator("#rp-preset").selectOption("year");
    await page.locator(".rp-filters button[type=submit]").click();
    await page.waitForFunction(() => location.hash.includes("from=") && document.querySelector("#rp-table tbody tr"));
    assert.ok(await page.locator("#rp-table tfoot").count() === 1);
    assert.ok(await page.locator(".rp-defs dt").count() >= 4, "definitions listed");
    const href = await page.locator("#rp-csv").getAttribute("href");
    assert.match(href!, /^\/api\/reports\/productivity\/csv\?from=/);
    const csv = await page.evaluate(async (u: string) => {
      const r = await fetch(u);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), bom: [...bytes.slice(0, 3)], head: new TextDecoder().decode(bytes.slice(3)).split("\r\n")[0] };
    }, href!);
    assert.deepEqual(csv.bom, [0xef, 0xbb, 0xbf]);
    assert.match(csv.disp!, /attachment; filename="lawdesk-productivity-/);
    assert.equal(csv.head, "Person,Hours worked,Billable hours,Billable share,Billed hours,Billed ÷ billable,Billed value");
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `report-${label}.png`, fullPage: true });
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator("header.top").isVisible(), false, "app header hidden in print");
    assert.equal(await page.locator(".rp-filters").isVisible(), false, "filters hidden in print");
    assert.equal(await page.locator(".rp-print-head").isVisible(), true);
    await page.screenshot({ path: shots + `report-print-${label}.png`, fullPage: true });
    await page.emulateMedia({ media: "screen" });
  });

  await check(`${label}: activity log search and matter report`, async () => {
    await page.goto(base + "/#/reports/activity?all=1&q=Finished");
    await page.waitForSelector(".report-page[data-report=activity] #rp-table tbody tr");
    const details = await page.locator("#rp-table tbody tr td:last-child").allInnerTexts();
    assert.ok(details.length > 0 && details.every((d) => /finished/i.test(d)), details.join(" / ").slice(0, 300));
    await page.goto(base + "/#/reports/matters");
    await page.waitForSelector(".report-page[data-report=matters] #rp-table tbody tr");
    assert.equal(await page.locator("#rp-table tbody tr").count(), 5, "open matters");
    await page.locator("#rp-table tbody tr a").first().click();
    await page.waitForSelector(".stage-bar");
    await noHorizontalScroll();
  });

  await check(`${label}: firm figures are offered to attorneys, not paralegals`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".task");
    assert.equal(await page.locator(".nav-link", { hasText: "Firm overview" }).count(), 1);
    await page.locator("#working-as").selectOption(String(demo.users.sam));
    await page.waitForFunction(() => ![...document.querySelectorAll(".nav-link")].some((a) => a.textContent === "Reports"));
    await page.locator("#working-as").selectOption(String(demo.users.jordan));
    await page.waitForFunction(() => [...document.querySelectorAll(".nav-link")].some((a) => a.textContent === "Reports"));
  });

  await check(`${label}: matter communications: log a call, write an email, file a saved email`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m1}`);
    await page.waitForSelector("#communications .comms-toolbar");
    await page.locator("#communications button", { hasText: "Log a call or meeting" }).click();
    await page.locator("dialog[open] input[aria-label='With']").fill(`Client call ${label}`);
    await page.locator("dialog[open] input[aria-label='Length in minutes']").fill("15");
    await page.locator("dialog[open] button[type=submit]").click();
    await page.waitForSelector(`#communications .comms-entry:has-text('Client call ${label}')`);

    await page.locator("#communications button", { hasText: "Write an email" }).click();
    await page.locator("dialog[open] input[aria-label='Other recipients']").fill("client@example.test");
    await page.locator("dialog[open] select[aria-label='Template']").selectOption({ label: "Status update" });
    await page.waitForFunction(() => (document.querySelector("dialog[open] input[aria-label='Subject']") as HTMLInputElement)?.value.includes("status update"));
    await noHorizontalScroll();
    await page.locator("dialog[open] button[type=submit]").click();
    await page.waitForSelector("#communications .comms-entry:has-text('Email sent')");

    const eml = buildMessage({ from: { name: "Client (demo)", address: "client@example.test" }, to: [{ address: "jordan@example.com" }], subject: `Reply from client ${label}`, text: "Thank you for the update." }).raw;
    await page.locator("#communications .comms-file-input").setInputFiles({ name: "reply.eml", mimeType: "message/rfc822", buffer: eml });
    await page.waitForSelector(`#communications .comms-entry:has-text('Reply from client ${label}')`);
    await page.locator(".comms-head", { hasText: `Reply from client ${label}` }).click();
    await page.waitForSelector(".comms-text:has-text('Thank you for the update.')");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.locator("#communications").screenshot({ path: shots + `communications-${label}.png` });
  });

  await check(`${label}: settings > email saves and sends a test email`, async () => {
    await page.goto(base + "/#/settings");
    await page.waitForSelector("#s-email .email-sending");
    await page.locator("#s-email input[aria-label='From address']").fill("office@example.test");
    await page.locator("#s-email button", { hasText: "Save email settings" }).click();
    await page.waitForSelector(".toast:has-text('Email settings saved'), .toast:has-text('No changes')");
    await page.waitForSelector("#s-email .email-test");
    await page.locator("#s-email input[aria-label='Send a test to']").fill("jordan@example.com");
    await page.locator("#s-email button", { hasText: "Send test email" }).click();
    await page.waitForSelector("#s-email .email-test-result.ok");
    await page.locator("#s-email input[aria-label='Time of the daily summary']").fill("08:15");
    await page.locator("#s-email input[aria-label='Time of the daily summary']").dispatchEvent("change");
    await page.waitForSelector(".toast:has-text('Saved')");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.locator("#s-email").screenshot({ path: shots + `settings-email-${label}.png` });
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
