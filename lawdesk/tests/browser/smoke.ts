// Headless browser smoke test: seeds the demo into an in-memory database, starts the
// server on a free port, clicks through every screen at desktop (1440px) and phone (390px)
// width and saves screenshots to screenshots/ (plus 2x "final-*.png" shots of Home,
// Matters and a matter for review). Needs Playwright + Chromium installed globally:
//
//   npm run test:browser
//
// Not part of `npm test`, which stays dependency-free.

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { seed } from "../../src/seed.ts";
import { DEMO_PASSWORD } from "../../src/auth/seed.ts";
import { createSession } from "../../src/auth/accounts.ts";
import { today } from "../../src/dates.ts";
import { addReportsDemo } from "./reports-demo.ts";
import { buildMessage } from "../../src/email/mime.ts";

// Dev mail and uploaded files go to a throwaway folder, not the working tree.
const scratch = mkdtempSync(join(tmpdir(), "lawdesk-smoke-"));
process.env.LAWDESK_MAIL_DIR ??= join(scratch, "mail");
process.env.LAWDESK_FILES ??= join(scratch, "files");
delete process.env.LAWDESK_MAIL_TRANSPORT;
import { Documents } from "../../src/documents/documents.ts";
import { setDocuments } from "../../src/documents/routes.ts";
import { Billing } from "../../src/billing/billing.ts";
import { onlinePaymentAndSignatureChecks } from "./pay-esign.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const shots = fileURLToPath(new URL("../../screenshots/", import.meta.url));
mkdirSync(shots, { recursive: true });

const now = today();
const db = openDb();
// Document files (uploads, signature certificates) go to a throwaway folder, not ./files.
const filesDir = mkdtempSync(join(tmpdir(), "lawdesk-smoke-files-"));
process.env.LAWDESK_FILES = filesDir;
setDocuments(db, new Documents(db, { dir: filesDir, today: () => now }));
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
    results.push(`FAILED ${name}\n       ${String(err?.message || err).split("\n").slice(0, 12).join("\n       ")}`);
  }
  console.log(results[results.length - 1]);
}

const openMatters = (await (await fetch(base + "/api/matters", { headers: { Cookie: `lawdesk_session=${createSession(db, demo.users.jordan).token}` } })).json()).length;

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  let expected401 = 0;
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));

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

  await check(`${label}: sign-in screen refuses a wrong password, then signs in`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".auth-card");
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `sign-in-${label}.png`, fullPage: true });
    await page.fill("#signin-email", "jordan@example.com");
    await page.fill("#signin-password", "not the right password");
    await page.click(".auth-submit");
    await page.waitForSelector(".error-box:has-text('match an account')");
    // The refused sign-in is a 401, which the browser reports as a console error (sometimes a little later).
    expected401 = 1;
    await page.fill("#signin-password", DEMO_PASSWORD);
    await page.click(".auth-submit");
    await page.waitForSelector(".user-btn:has-text('Jordan Reyes')");
  });

  const shot = async (name: string) => {
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.mouse.move(0, 0);
    await page.screenshot({ path: shots + `${name}-${label}.png`, fullPage: true });
  };

  await check(`${label}: opens on Home with the shell`, async () => {
    await page.goto(base + "/");
    await page.waitForSelector(".home-page .stat");
    assert.match(page.url(), /#\/home$/);
    assert.equal(await page.locator(".home-stats .stat").count(), 4);
    assert.ok(await page.locator(".home-page .task").count() > 0, "my next tasks");
    assert.ok(await page.locator(".side-link").count() >= 6, "sidebar links");
    assert.equal(await page.locator(".side-link[aria-current=page]").innerText(), "Home");
    await page.waitForSelector(".agenda-item, .home-side .empty-state");
    await page.waitForFunction(() => (document.querySelector(".side-firm-name")?.textContent || "").length > 0);
    await noHorizontalScroll();
    await shot("home");
  });

  await check(`${label}: global search finds a matter`, async () => {
    if (label === "phone") await page.locator(".search-trigger").click();
    else await page.keyboard.press("Control+k");
    await page.waitForSelector("dialog.palette[open]");
    await page.keyboard.type("riverside");
    await page.waitForSelector(".palette-item:has-text('Riverside Plaza')");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".matter-header:has-text('Riverside Plaza')");
  });

  await check(`${label}: notifications and user menu`, async () => {
    await page.goto(base + "/#/home");
    await page.waitForSelector(".home-page");
    await page.locator(".bell").click();
    await page.waitForSelector(".notif-pop .notif-item");
    await page.keyboard.press("Escape");
    await page.locator(".user-btn").click();
    await page.waitForSelector(".popover [role=menu] .pop-item:has-text('Sign out')");
    await page.keyboard.press("Escape");
    if (label === "phone") {
      await page.locator(".menu-btn").click();
      await page.waitForSelector("body.drawer-open .side-link");
      await page.locator(".side-link", { hasText: "Matters" }).click();
      await page.waitForSelector(".matters-page");
      assert.equal(await page.evaluate(() => document.body.classList.contains("drawer-open")), false);
    }
  });

  await check(`${label}: My tasks shows buckets and waiting reasons`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".task");
    assert.ok(await page.locator("#g-overdue .task").count() > 0, "overdue bucket");
    assert.ok(await page.locator("#g-waiting .waiting-on").count() > 0, "waiting reasons");
    await noHorizontalScroll();
    await shot("my-tasks");
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
    await page.waitForFunction(() => !document.querySelector(".load-card.on"));
    if (label === "desktop") {
      // Sort by a column header; the header says which way it is sorted.
      await page.locator("th .th-sort", { hasText: "Task" }).click();
      assert.equal(await page.locator("th[aria-sort=ascending]", { hasText: "Task" }).count(), 1);
      await page.locator("th .th-sort", { hasText: "Due" }).click();
    }
    await noHorizontalScroll();
    await shot("firm-tasks");
  });

  await check(`${label}: Matters list and matter detail`, async () => {
    await page.goto(base + "/#/matters");
    await page.waitForSelector(".matter-row");
    assert.equal(await page.locator(".matter-row").count(), openMatters);
    await page.fill(".dt-search-input", "riverside");
    await page.waitForFunction(() => document.querySelectorAll(".matter-row").length === 1);
    await page.fill(".dt-search-input", "");
    await page.waitForFunction((n: number) => document.querySelectorAll(".matter-row").length === n, openMatters);
    await noHorizontalScroll();
    await shot("matters");
    await page.locator(".matter-row", { hasText: "Riverside Plaza" }).locator("a").first().click();
    await page.waitForSelector(".stage-bar");
    assert.ok(await page.locator(".matter-facts .fact").count() >= 4, "key facts in the header");
    await noHorizontalScroll();
    await shot("matter");
    // Overview is a summary: "Next up" rows are links, and every .task row is in the Tasks tab.
    await page.waitForSelector(".matter-next .matter-sum-row");
    assert.equal(await page.locator("#tab-panel-overview .task").count(), 0, "no task rows on Overview");
    assert.equal(await page.locator(".task").count(), await page.locator("#tab-panel-tasks .task").count());
    await page.waitForSelector(".matter-money .matter-sum-row");
    await page.waitForSelector("#tab-panel-overview .cc-status-card");
    const first = await page.locator(".matter-next .matter-sum-title").first().innerText();
    await page.locator(".matter-next .matter-sum-row").first().click();
    await page.waitForSelector("#tab-panel-tasks:not([hidden]) .checklist-group");
    await page.waitForFunction((t: string) => document.activeElement?.classList.contains("task") && document.activeElement.textContent!.includes(t), first);
    // Module tabs have their own URLs; "documents" stays the full documents page.
    for (const [tab, sel] of [["billing", "#matter-billing"], ["files", ".docs-card"], ["calendar", ".cal-upcoming"], ["communications", "#communications"]]) {
      await page.locator(`.tab[data-tab=${tab}]`).click();
      await page.waitForSelector(`#tab-panel-${tab}:not([hidden]) ${sel}`);
      assert.match(page.url(), new RegExp(`/${tab}$`));
      await noHorizontalScroll();
    }
    await page.locator(".tab", { hasText: "Tasks" }).click();
    await page.waitForSelector("#tab-panel-tasks:not([hidden]) .checklist-group");
    assert.match(page.url(), /\/tasks$/);
    assert.ok(await page.locator("#tab-panel-tasks .checklist-group").count() >= 2);
    assert.ok(await page.locator("#tab-panel-tasks .waiting-on").count() > 0);
    await noHorizontalScroll();
    await shot("matter-tasks");
  });

  await check(`${label}: changing a key date re-dates tasks`, async () => {
    const input = page.locator(".matter-aside input[type=date][aria-label='Closing date']");
    // Both widths share one database, so each run picks a different date.
    await input.fill(label === "desktop" ? "2027-01-15" : "2027-01-22");
    await input.dispatchEvent("change");
    await page.waitForSelector(".toast:has-text('re-dated')");
  });

  await check(`${label}: moving the stage runs the automation`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m3}/tasks`);
    await page.waitForSelector(".stage-bar");
    await page.locator(".stage", { hasText: "Review" }).click();
    await page.waitForSelector("#tab-panel-tasks .checklist-group:has-text('Contract review')");
  });

  await check(`${label}: who can see this matter: restrict, then let everyone see it`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m17}`);
    await page.locator(".matter-access button", { hasText: "Restrict access" }).click();
    const dlg = page.locator("dialog[open]");
    await dlg.locator("label.check-line", { hasText: "Sam Patel" }).locator("input").check();
    await noHorizontalScroll();
    await dlg.locator("button[type=submit]").click();
    await page.waitForSelector(".matter-access .matter-access-list:has-text('Sam Patel')");
    assert.match(await page.locator(".matter-access").innerText(), /Restricted/);
    await page.locator(".matter-access button", { hasText: "Change who can see it" }).click();
    await page.locator("dialog[open] button", { hasText: "Let everyone see it" }).click();
    await page.waitForSelector(".matter-access:has-text('Everyone at the firm')");
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
  });

  await check(`${label}: checklists list`, async () => {
    await page.goto(base + "/#/checklists");
    await page.waitForSelector(".list-card");
    assert.ok(await page.locator(".list-card").count() >= 6);
    await noHorizontalScroll();
    await shot("checklists");
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
    await page.goto(base + `/#/matters/${demo.matters.m2}/billing`);
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
    await page.click("#inv-more");
    await page.locator(".popover .pop-item", { hasText: "Void invoice" }).click();
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
    // The task also shows under Overview's "Next up", so use the one on the Tasks tab.
    await page.goto(base + `/#/matters/${demo.matters.m2}/tasks`);
    await page.waitForSelector("#tab-panel-tasks .task:has-text('indemnity cap')");
    const row = page.locator("#tab-panel-tasks .task", { hasText: "Call client about the indemnity cap" });
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
    await shot("settings");
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
    await page.waitForSelector(label === "desktop" ? ".cal-body[data-view=week] .cal-week .cal-block" : ".cal-body[data-view=week] .cal-list-day");
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `calendar-week-${label}.png`, fullPage: true });
    await page.locator(".segmented button", { hasText: "List" }).click();
    await page.waitForSelector(".cal-body[data-view=list] .cal-list .cal-line");
    await noHorizontalScroll();
    const series = page.locator(".cal-body[data-view=list] .cal-line", { hasText: `Case strategy ${label}` });
    await series.first().waitFor();
    const before = await series.count();
    assert.ok(before >= 1, "the new series is listed");
    await series.first().locator("button").click();
    page.once("dialog", (d: any) => d.accept());
    await page.locator("dialog.cal-dialog button", { hasText: "Cancel this date" }).click();
    await page.waitForSelector(".toast:has-text('Cancelled that date')");
    await page.waitForFunction(
      ([t, n]: [string, number]) =>
        [...document.querySelectorAll(".cal-body[data-view=list] .cal-line")].filter((e) => e.textContent!.includes(t)).length === n - 1,
      [`Case strategy ${label}`, before] as [string, number],
    );
    await page.screenshot({ path: shots + `calendar-list-${label}.png`, fullPage: true });
  });

  await check(`${label}: import an .ics file`, async () => {
    await page.locator(".page-head button", { hasText: "Import or subscribe" }).click();
    await page.locator(".pop-item", { hasText: "Import a calendar file" }).click();
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
    await page.locator(".page-head button", { hasText: "Import or subscribe" }).click();
    await page.locator(".pop-item", { hasText: "Subscribe in Outlook, Google or Apple" }).click();
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
    await page.goto(base + `/#/matters/${demo.matters.m2}/calendar`);
    await page.waitForSelector(`.cal-upcoming .cal-line:has-text("Interrogatory answers due ${label}")`);
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `matter-upcoming-${label}.png`, fullPage: true });
    await page.locator(".cal-upcoming .cal-line", { hasText: `Interrogatory answers due ${label}` }).locator("button").click();
    const notes = await page.locator("dialog.cal-dialog .cal-notes").innerText();
    assert.match(notes, /How it was computed/);
    assert.match(notes, /VERIFY THIS DATE/);
    await page.locator("dialog.cal-dialog .modal-head button").click();
    await page.locator(".tab", { hasText: "Tasks" }).click();
    const task = page.locator(".task", { hasText: `Interrogatory answers due ${label}` });
    await task.waitFor();
    assert.ok(await task.evaluate((e) => e.classList.contains("prio-high")), "high-priority task");
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
    // Earlier checks (and the desktop run, for the phone run) add matters, so count the open ones now.
    const open = await page.evaluate(async () => (await fetch("/api/matters").then((x) => x.json())).length);
    assert.ok(open > 0, "the demo has open matters");
    assert.equal(await page.locator("#rp-table tbody tr").count(), open, "one row per open matter");
    await page.locator("#rp-table tbody tr a").first().click();
    await page.waitForSelector(".stage-bar");
    await noHorizontalScroll();
  });

  await check(`${label}: firm figures are offered to attorneys, not paralegals`, async () => {
    await page.goto(base + "/#/my");
    await page.waitForSelector(".task");
    assert.equal(await page.locator(".nav-link", { hasText: "Firm overview" }).count(), 1);
    // Sam (staff) in a separate browser session: no firm figures in the menu.
    const samCtx = await browser.newContext({ viewport });
    const { token } = createSession(db, demo.users.sam);
    await samCtx.addCookies([{ name: "lawdesk_session", value: token, url: base }]);
    const sam = await samCtx.newPage();
    await sam.goto(base + "/#/my");
    await sam.waitForSelector(".task");
    assert.equal(await sam.locator(".nav-link", { hasText: "Reports" }).count(), 0);
    assert.equal(await sam.locator(".nav-link", { hasText: "Firm overview" }).count(), 0);
    assert.equal(await sam.locator(".nav-link", { hasText: "Trust" }).count(), 0, "staff don't see Trust");
    assert.equal((await sam.request.get(base + "/api/trust/accounts")).status(), 403, "the server refuses trust to staff");
    await samCtx.close();
  });

  await check(`${label}: matter communications: log a call, write an email, file a saved email`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m1}/communications`);
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
    await page.locator(".trust-head-actions a", { hasText: "Reports" }).click();
    await page.waitForSelector("h1:has-text('Trust reports')");
    assert.equal(await page.locator(".trust-report").count(), 5);
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `trust-reports-${label}.png`, fullPage: true });
  });

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
    for (const s of ["Peggy Ellison", "Maiden name", "an owner of", "Sunflower Coffee Roasters formation", "316-555-0144", "22 Sample Lane"]) assert.ok(text.includes(s), s);
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
    await page.locator("dialog select[name=client]").selectOption({ label: "Prairie Wind Solar Inc." });
    await page.fill("dialog .intake-party input", "Kestrel Panel Manufacturing Co.");
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

  // ---------------------------------------------------------------- documents

  await check(`${label}: matter page shows the Documents card`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m4}/files`);
    await page.waitForSelector(".docs-card .doc-mini li");
    assert.ok((await page.locator(".docs-card .doc-mini li").count()) >= 3);
    await page.locator(".docs-card a.docs-all").click();
    await page.waitForSelector(".docs-tree .tree-item");
    await noHorizontalScroll();
  });

  await check(`${label}: upload with progress, then a same-name upload becomes version 2`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m4}/documents`);
    await page.waitForSelector(".docs-table");
    await page.locator(".tree-item", { hasText: "Correspondence" }).click();
    const name = `Upload check ${label}.txt`;
    const input = page.locator(".head-actions input[type=file]");
    await input.setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("first upload, demo text") });
    await page.waitForSelector(`.doc-row:has-text("${name}")`);
    assert.match(await page.locator(".doc-row", { hasText: name }).innerText(), /v1/);
    await input.setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("second upload, demo text") });
    await page.locator("dialog .btn.primary", { hasText: "Save as new version" }).click();
    await page.waitForSelector(`.doc-row:has-text("${name}") >> text=v2`);
  });

  await check(`${label}: dropping a file on the drop area uploads it`, async () => {
    const name = `Dropped ${label}.txt`;
    await page.evaluate((n: string) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["dropped demo text"], n, { type: "text/plain" }));
      const zone = document.querySelector(".dropzone")!;
      for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, name);
    await page.waitForSelector(`.doc-row:has-text("${name}")`);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `documents-${label}.png`, fullPage: true });
  });

  await check(`${label}: PDF preview is served inline as a PDF, and Download saves the file`, async () => {
    await page.locator(".tree-item", { hasText: "All documents" }).click();
    await page.locator("a.doc-name", { hasText: "Title commitment.pdf" }).click();
    const frame = page.locator("iframe.doc-frame");
    await frame.waitFor();
    const src = await frame.getAttribute("src");
    const head = await page.evaluate(async (u: string) => {
      const r = await fetch(u);
      return { type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), nosniff: r.headers.get("x-content-type-options") };
    }, src!);
    assert.equal(head.type, "application/pdf");
    assert.match(head.disp!, /^inline/);
    assert.equal(head.nosniff, "nosniff");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".doc-title a.btn.primary", { hasText: "Download" }).click()]);
    assert.equal(download.suggestedFilename(), "Title commitment.pdf");
    assert.ok((await page.locator(".versions .version").count()) >= 1);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `document-pdf-${label}.png`, fullPage: true });
  });

  await check(`${label}: image preview, rename and tag a document`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m4}/documents`);
    await page.locator("a.doc-name", { hasText: "Site photo" }).first().click();
    await page.waitForFunction(() => (document.querySelector("img.doc-image") as HTMLImageElement | null)?.naturalWidth! > 0);
    const name = page.locator(".doc-form label", { hasText: "Name" }).locator("input");
    await name.fill(`Site photo - ${label}.png`);
    await page.locator(".doc-form label", { hasText: "Tags" }).locator("input").fill("survey, exterior");
    await page.locator(".doc-form button[type=submit]").click();
    await page.waitForSelector(`.doc-title h2:has-text("Site photo - ${label}.png")`);
    assert.equal(await page.locator(".doc-form label", { hasText: "Tags" }).locator("input").inputValue(), "exterior, survey");
  });

  await check(`${label}: versions list restores an older version`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m1}/documents`);
    await page.locator("a.doc-name", { hasText: "Articles of organization" }).click();
    await page.waitForSelector(".versions .version");
    const before = await page.locator(".versions .version").count();
    await page.locator(".version", { has: page.locator(".version-n", { hasText: /^Version 1$/ }) }).locator("button", { hasText: "Make current" }).click();
    await page.waitForFunction((n: number) => document.querySelectorAll(".versions .version").length === n + 1, before);
    assert.match(await page.locator(".version.current").innerText(), /Restored from version 1/);
    assert.match(await page.locator(".doc-paper").innerText(), /ARTICLES OF ORGANIZATION \(DEMO DRAFT\)/);
  });

  await check(`${label}: delete a document, find it in Deleted documents, restore it`, async () => {
    await page.locator(".doc-title button", { hasText: "Delete" }).click();
    await page.waitForSelector(".docs-table");
    assert.equal(await page.locator("a.doc-name", { hasText: "Articles of organization" }).count(), 0);
    await page.locator(".trash-link").click();
    const row = page.locator(".docs-table tr", { hasText: "Articles of organization" });
    await row.locator("button", { hasText: "Restore" }).click();
    await page.waitForSelector(".toast:has-text('Restored')");
    await page.locator(".tree-item", { hasText: "All documents" }).click();
    await page.waitForSelector(`a.doc-name:has-text("Articles of organization")`);
  });

  await check(`${label}: new folder, then move a document into it (drag on desktop, folder list on phone)`, async () => {
    await page.locator(".head-actions button", { hasText: "New folder" }).click();
    await page.locator("dialog input").fill(`Filed ${label}`);
    await page.locator("dialog button[type=submit]").click();
    await page.waitForSelector(`.tree-item.current:has-text("Filed ${label}")`);
    await page.locator(".tree-item", { hasText: "All documents" }).click();
    if (label === "desktop") {
      await page.locator(".doc-row", { hasText: "Formation questionnaire" }).dragTo(page.locator(".tree-item", { hasText: `Filed ${label}` }));
      await page.waitForSelector(".toast:has-text('Moved')");
    } else {
      await page.locator("a.doc-name", { hasText: "Formation questionnaire" }).click();
      await page.locator(".doc-form label", { hasText: "Folder" }).locator("select").selectOption(`Filed ${label}`);
      await page.locator(".doc-form button[type=submit]").click();
      await page.waitForSelector(`.docs-main > a.back:has-text("Filed ${label}")`);
    }
    await page.locator(".tree-item", { hasText: `Filed ${label}` }).click();
    await page.waitForSelector(`.doc-row:has-text("Formation questionnaire")`);
  });

  await check(`${label}: firm-wide search highlights matches and filters`, async () => {
    await page.goto(base + "/#/documents");
    await page.waitForSelector(".result-list");
    await page.fill("input[data-search]", "indemnification");
    await page.waitForSelector(".doc-snippet mark");
    assert.match(await page.locator(".doc-snippet mark").first().innerText(), /indemnification/i);
    assert.equal(await page.locator(".result").count(), 1);
    await page.fill("input[data-search]", "");
    await page.locator("select[aria-label=Tag]").selectOption("lender");
    await page.waitForFunction(() => document.querySelectorAll(".result").length >= 2 && [...document.querySelectorAll(".result")].every((r) => r.textContent!.includes("lender")));
    await page.fill("input[data-search]", "lender");
    await page.waitForSelector(".doc-snippet mark");
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `documents-search-${label}.png`, fullPage: true });
    await page.locator("select[aria-label=Tag]").selectOption("");
    await page.fill("input[data-search]", "");
  });

  await check(`${label}: Settings > Document templates lists fields and accepts an upload`, async () => {
    await page.goto(base + "/#/settings");
    await page.locator(".settings-nav a", { hasText: "Document templates" }).click();
    await page.waitForSelector(".template");
    assert.ok((await page.locator(".template", { hasText: "Engagement letter" }).locator(".field-chip").count()) >= 5);
    assert.ok(await page.locator(".field-reference .field-code", { hasText: "{{client.name}}" }).count());
    await page.locator(".template-upload input[type=file]").setInputFiles({
      name: `Cover note ${label}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("To {{client.name}}\nRe: {{matter.name}}\nFiling date: {{matter.dates.filing_date|long}}\n"),
    });
    await page.locator(".template-upload button[type=submit]").click();
    await page.waitForSelector(`.template:has-text("Cover note ${label}")`);
    await noHorizontalScroll();
    await clearToasts();
    await page.screenshot({ path: shots + `templates-${label}.png`, fullPage: true });
  });

  await check(`${label}: create from template warns about blanks, then opens the new document`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m5}/files`);
    await page.locator(".docs-card button", { hasText: "Create from template" }).click();
    await page.locator("dialog select[aria-label=Template]").selectOption({ label: `Cover note ${label}` });
    await page.waitForSelector("dialog .check-warn:has-text('Filing date')");
    await clearToasts();
    await page.screenshot({ path: shots + `template-dialog-${label}.png` });
    await page.locator("dialog select[aria-label=Template]").selectOption({ label: "Engagement letter" });
    await page.waitForFunction(() => (document.querySelector("dialog input[maxlength='200']") as HTMLInputElement)?.value.startsWith("Engagement letter"));
    await page.locator("dialog button[type=submit]").click();
    await page.waitForSelector(".doc-paper");
    assert.match(page.url(), /#\/matters\/\d+\/documents\/\d+$/);
    assert.match(await page.locator(".doc-paper").innerText(), /Dear Taylor Brooks \(demo\):/);
  });

  // ---------------------------------------------------------------- intake
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
    const id = (db.prepare("SELECT id FROM intake_leads WHERE name = 'Harper Quinn'").get() as any).id;
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

  await check(`${label}: import from Clio: upload, match columns, trial run, import, report`, async () => {
    await page.goto(base + "/#/settings");
    await page.locator("#settings-import-clio").click();
    await page.waitForSelector("#ci-file");
    // A made-up contacts file in Clio's migration-template layout; each width uses different names.
    const tag = label === "desktop" ? "Desk" : "Phone";
    const csv =
      "first_name,last_name,Company,email_address,primary_phone,Mystery\r\n" +
      `Avery,${tag}fictional,,avery@example.com,785-555-0101,x\r\n` +
      `,,${tag} Example Bakery LLC,,785-555-0100,y\r\n` +
      ",,,,,\r\n,,,nobody@example.com,,z\r\n";
    await page.setInputFiles("#ci-input", { name: "contacts.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.waitForSelector("#ci-rows");
    assert.match(await page.locator(".ci-summary").first().innerText(), /3 rows: 2 new, 0 already imported.*1 with problems/);
    // Manual mapping: point "Notes" at the unrecognised column.
    await page.locator("select[aria-label='Column for Notes']").selectOption({ label: "Mystery" });
    await page.waitForFunction(() => document.querySelector("select[aria-label='Column for Notes']") && (document.querySelector("select[aria-label='Column for Notes']") as HTMLSelectElement).selectedOptions[0].textContent === "Mystery");
    await page.locator("#ci-dry").click();
    await page.waitForSelector("#ci-report:not([hidden]) h2:has-text('Trial run')");
    page.once("dialog", (d: any) => d.accept());
    await page.locator("#ci-run").click();
    await page.waitForSelector("#ci-report h2:has-text('Import report')");
    assert.match(await page.locator("#ci-report .ci-tally").innerText(), /Contacts\s+2\s+0\s+0\s+1/);
    await page.waitForSelector("#ci-runs tbody tr");
    assert.ok((await page.locator("#ci-totals .ci-figure").count()) >= 5);
    assert.match(await page.locator("#ci-api").innerText(), /Import directly from Clio/);
    await noHorizontalScroll();
    await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
    await page.screenshot({ path: shots + `clio-import-${label}.png`, fullPage: true });
  });
  await onlinePaymentAndSignatureChecks({ label, page, ctx, base, db, check, noHorizontalScroll, shots, matterId: demo.matters.m1, billing: new Billing(db, { today: () => now }) });

  await check(`${label}: settings lists sign-in accounts for the administrator`, async () => {
    await page.goto(base + "/#/settings");
    await page.waitForSelector(".accounts-table tbody tr");
    assert.ok((await page.locator(".accounts-table tbody tr").count()) >= 4);
    assert.ok(await page.locator(".accounts-table", { hasText: "riley@example.com" }).count());
    await page.locator("#s-accounts").scrollIntoViewIfNeeded();
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `settings-accounts-${label}.png` });
  });

  await check(`${label}: user menu opens My account with password, two-step sign-in and devices`, async () => {
    await page.locator(".user-btn").click();
    await page.locator(".pop-item", { hasText: "My account" }).click();
    await page.waitForSelector("#a-sessions .session");
    for (const id of ["a-details", "a-password", "a-2fa", "a-sessions"]) assert.equal(await page.locator("#" + id).count(), 1, id);
    assert.ok(await page.locator(".session-current").count());
    await page.locator("#a-2fa button", { hasText: "Turn on" }).click();
    await page.waitForSelector(".setup-key");
    assert.match(await page.locator(".setup-key").innerText(), /^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `account-${label}.png`, fullPage: true });
    await page.locator("#a-2fa button", { hasText: "Cancel" }).click();
    await page.waitForSelector("#a-2fa button:has-text('Turn on two-step')");
  });

  await check(`${label}: sign out returns to the sign-in screen`, async () => {
    await page.locator(".user-btn").click();
    await page.locator(".pop-item", { hasText: "Sign out" }).click();
    await page.waitForSelector(".auth-card");
    const res = await page.request.get(base + "/api/matters");
    assert.equal(res.status(), 401);
  });

  await check(`${label}: no script errors`, async () => {
    const i = errors.findIndex((e) => /status of 401/.test(e));
    if (expected401 && i >= 0) errors.splice(i, 1);
    assert.deepEqual(errors, [], errors.slice(0, 3).join(" / "));
  });
  await ctx.close();
}

// Sharp 2x screenshots for review.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await ctx.addCookies([{ name: "lawdesk_session", value: createSession(db, demo.users.jordan).token, url: base }]);
  await check("final 2x screenshots", async () => {
    for (const [name, url, sel] of [
      ["home", "/#/home", ".home-page .agenda-item, .home-side .empty-state"],
      ["matters", "/#/matters", ".matter-row"],
      ["matter", `/#/matters/${demo.matters.m17}`, ".stage-bar"],
    ]) {
      await page.goto(base + url);
      await page.waitForSelector(sel);
      await page.waitForTimeout(150);
      await page.screenshot({ path: shots + `final-${name}.png`, fullPage: true });
    }
  });
  await ctx.close();
}

await browser.close();
server.close();
rmSync(filesDir, { recursive: true, force: true });
console.log(`\n${results.length - failures} passed, ${failures} failed. Screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
