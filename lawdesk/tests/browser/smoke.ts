// Headless browser smoke test: seeds the demo into an in-memory database, starts the
// server on a free port, clicks through every screen at desktop (1440px) and phone (390px)
// width and saves screenshots to screenshots/ (plus 2x "final-*.png" shots of Home,
// Matters and a matter for review). Needs Playwright + Chromium installed globally:
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

const openMatters = (await (await fetch(base + "/api/matters")).json()).length;

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
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

  await check(`${label}: settings shows every section`, async () => {
    await page.goto(base + "/#/settings");
    await page.waitForSelector("#s-auto");
    for (const id of ["s-people", "s-clients", "s-areas", "s-dates", "s-closed", "s-auto"]) assert.equal(await page.locator("#" + id).count(), 1, id);
    await noHorizontalScroll();
    await shot("settings");
  });

  await check(`${label}: no script errors`, async () => {
    assert.equal(errors.length, 0, errors.join(" | "));
  });
  await ctx.close();
}

// Sharp 2x screenshots for review.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((id: number) => localStorage.setItem("lawdesk.me", String(id)), demo.users.jordan);
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
console.log(`\n${results.length - failures} passed, ${failures} failed. Screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
