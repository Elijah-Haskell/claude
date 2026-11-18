// Headless browser smoke test: seeds the demo into an in-memory database, starts the
// server on a free port, clicks through every screen at desktop and phone width and
// saves screenshots to screenshots/. Needs Playwright + Chromium installed globally:
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
import { today } from "../../src/dates.ts";
import { Documents } from "../../src/documents/documents.ts";
import { setDocuments } from "../../src/documents/routes.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const shots = fileURLToPath(new URL("../../screenshots/", import.meta.url));
mkdirSync(shots, { recursive: true });

const now = today();
const db = openDb();
// Document files go to a throwaway folder, not ./files.
const filesDir = mkdtempSync(join(tmpdir(), "lawdesk-smoke-files-"));
setDocuments(db, new Documents(db, { dir: filesDir, today: () => now }));
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
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
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

  // ---------------------------------------------------------------- documents
  const clearToasts = () => page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());

  await check(`${label}: matter page shows the Documents card`, async () => {
    await page.goto(base + `/#/matters/${demo.matters.m4}`);
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
    await page.goto(base + `/#/matters/${demo.matters.m5}`);
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

  await check(`${label}: no script errors`, async () => {
    assert.deepEqual(errors, [], errors.slice(0, 3).join(" | "));
  });
  await ctx.close();
}

await browser.close();
server.close();
rmSync(filesDir, { recursive: true, force: true });
console.log(`\n${results.length - failures} passed, ${failures} failed. Screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
