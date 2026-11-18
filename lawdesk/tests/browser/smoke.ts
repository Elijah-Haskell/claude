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

  await check(`${label}: no script errors`, async () => {
    assert.deepEqual(errors, []);
  });
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${results.length - failures} passed, ${failures} failed. Screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
