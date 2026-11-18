// Dev helper (not part of the test suite): seed, serve, and screenshot one URL at a given
// width so a screen can be checked while styling it.
//
//   NODE_PATH=$(npm root -g) node tests/browser/look.ts "#/home" 1440 out.png [scale]

import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { seed } from "../../src/seed.ts";
import { today } from "../../src/dates.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [hash = "#/home", width = "1440", out = "look.png", scale = "1", action = ""] = process.argv.slice(2);
const now = today();
const db = openDb();
const demo = seed(db, now);
const server = createServer(db, { today: () => now });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: Number(scale) });
const page = await ctx.newPage();
page.on("console", (m: any) => m.type() === "error" && console.log("console:", m.text()));
page.on("response", (r: any) => r.status() >= 400 && console.log("HTTP", r.status(), r.url()));
await page.addInitScript((id: number) => localStorage.setItem("lawdesk.me", String(id)), demo.users.jordan);
await page.goto(base + "/" + hash.replace(/m17/, String(demo.matters.m17)).replace(/m4/, String(demo.matters.m4)));
await page.waitForTimeout(900);
if (action === "palette") {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("har");
  await page.waitForTimeout(400);
}
if (action === "bell") {
  await page.locator(".bell").click();
  await page.waitForTimeout(300);
}
if (action === "user") {
  await page.locator(".user-btn").click();
  await page.waitForTimeout(300);
}
if (action === "drawer") {
  await page.locator(".menu-btn").click();
  await page.waitForTimeout(400);
}
if (action === "newmatter") {
  await page.locator(".top-new").click();
  await page.locator(".pop-item", { hasText: "New matter" }).click();
  await page.waitForTimeout(300);
}
const wide = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((e) => {
      if (e.getBoundingClientRect().right <= window.innerWidth + 1) return false;
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o !== "visible") return false;
      }
      return true;
    })
    .slice(0, 5)
    .map((e) => {
      const chain: string[] = [];
      for (let p = e.parentElement; p && chain.length < 4; p = p.parentElement) chain.push(`${p.tagName.toLowerCase()}${p.id ? "#" + p.id : ""}.${[...p.classList].join(".")}`);
      return `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} ${Math.round(e.getBoundingClientRect().right)} < ${chain.join(" < ")}`;
    }),
);
if (wide.length) console.log("overflow:", wide.join(", "));
await page.screenshot({ path: out, fullPage: action === "" });
await browser.close();
server.close();
