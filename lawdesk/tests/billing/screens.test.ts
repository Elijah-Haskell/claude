// Logic behind the billing screens: the browser-side helpers in public/js/billing/format.js,
// the printable invoice page, the rates list, and the demo billing data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { money, parseMoney, parseHours, hours, weekStart, clock, percentToBp, bpToPercent, autoApply } from "../../public/js/billing/format.js";
import { routes } from "../../src/billing/routes.ts";
import { matchPath } from "../../src/http.ts";
import { openDb } from "../../src/db.ts";
import { seed } from "../../src/seed.ts";
import { Billing } from "../../src/billing/billing.ts";
import { aging } from "../../src/billing/reports.ts";
import { setup } from "./helpers.ts";

test("screens: money formats and parses in whole cents", () => {
  assert.equal(money(123456), "$1,234.56");
  assert.equal(money(-5), "-$0.05");
  assert.equal(money(0), "$0.00");
  assert.equal(parseMoney("1,234.5"), 123450);
  assert.equal(parseMoney("$12"), 1200);
  assert.equal(parseMoney(".05"), 5);
  assert.equal(parseMoney(" 250.00 "), 25000);
  for (const bad of ["", "abc", "1.234", "12,34", "-5"]) assert.equal(parseMoney(bad), null, bad);
});

test("screens: hours typed as 1.5, 1:30, 90m or 1h 30m", () => {
  assert.equal(parseHours("1.5"), 90);
  assert.equal(parseHours("1,5"), 90);
  assert.equal(parseHours(".25"), 15);
  assert.equal(parseHours("1:30"), 90);
  assert.equal(parseHours("0:06"), 6);
  assert.equal(parseHours("2"), 120);
  assert.equal(parseHours("90m"), 90);
  assert.equal(parseHours("45 min"), 45);
  assert.equal(parseHours("1h 30m"), 90);
  assert.equal(parseHours("1.5h"), 90);
  for (const bad of ["", "abc", "1:75", "1.5.2", "h"]) assert.equal(parseHours(bad), null, bad);
  assert.equal(hours(90), "1.5");
  assert.equal(hours(60), "1.0");
  assert.equal(hours(20), "0.33");
});

test("screens: weeks start on Monday; timer clock; percents", () => {
  assert.equal(weekStart("2026-11-18"), "2026-11-16"); // Wednesday
  assert.equal(weekStart("2026-11-16"), "2026-11-16"); // Monday
  assert.equal(weekStart("2026-11-22"), "2026-11-16"); // Sunday
  assert.equal(clock(425_000), "0:07:05");
  assert.equal(clock(3_600_000 * 2 + 1000), "2:00:01");
  assert.equal(percentToBp("7.5"), 750);
  assert.equal(percentToBp("10%"), 1000);
  assert.equal(percentToBp("x"), null);
  assert.equal(bpToPercent(750), "7.5");
});

test("screens: a payment spreads over invoices oldest first, the rest is credit", () => {
  const invs = [
    { id: 1, balance_cents: 5000 },
    { id: 2, balance_cents: 3000 },
  ];
  assert.deepEqual(autoApply(6000, invs), { allocations: { 1: 5000, 2: 1000 }, left: 0 });
  assert.deepEqual(autoApply(10000, invs), { allocations: { 1: 5000, 2: 3000 }, left: 2000 });
  assert.deepEqual(autoApply(0, invs), { allocations: {}, left: 0 });
});

function call(ctx: ReturnType<typeof setup>, method: string, url: string, body: any = {}) {
  const u = new URL(url, "http://x");
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchPath(r.path, u.pathname);
    if (params) return r.handler({ db: ctx.db, engine: ctx.engine, params, query: u.searchParams, body, userId: ctx.atty }) as any;
  }
  throw new Error(`No route for ${method} ${url}`);
}

test("screens: printable invoice is raw HTML with its own narrow security policy", async () => {
  const ctx = setup();
  ctx.b.addTime({ userId: ctx.atty, matterId: ctx.m1, minutes: 60, description: "<b>Review</b> lease" });
  const draft = ctx.b.createDraft({ matterId: ctx.m1 });
  const out = await call(ctx, "GET", `/billing/invoices/${draft.id}/print`);
  assert.equal(out.__raw, true);
  assert.match(out.contentType, /text\/html/);
  assert.match(out.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(out.headers["Content-Security-Policy"], /script-src 'self'/);
  assert.match(out.body, /id="ld-print"/);
  assert.match(out.body, /&lt;b&gt;Review&lt;\/b&gt;/); // user text stays escaped
});

test("screens: the rates list shows each person's standard rate", async () => {
  const ctx = setup();
  const rows = await call(ctx, "GET", "/billing/users/rates");
  assert.deepEqual(
    rows.map((r: any) => [r.user_id, r.rate_cents]),
    [
      [ctx.atty, 30000],
      [ctx.para, 12000],
    ],
  );
  ctx.b.addTime({ userId: ctx.atty, matterId: ctx.m1, minutes: 0 });
  const t = ctx.b.startTimer({ input: { userId: ctx.atty, matterId: ctx.m1 } });
  const running = await call(ctx, "GET", `/billing/timers?userId=${ctx.atty}`);
  assert.equal(running[0].id, t.id);
  assert.equal(running[0].matter_name, "Acme lease"); // the header timer shows the matter
  assert.equal(running[0].matter_number, "2026-001");
});

test("screens: demo data has a past-due partly paid invoice, an open one and unbilled work", () => {
  const db = openDb();
  const demo = seed(db, "2026-11-18");
  const b = new Billing(db, { today: () => "2026-11-18" });
  const past = b.invoice(demo.invoices.pastDue);
  assert.equal(past.number, 1001);
  assert.ok(past.paid_cents > 0 && past.balance_cents > 0);
  assert.equal(b.invoice(demo.invoices.open).number, 1002);
  const ag = aging(b);
  assert.ok(ag.totals.d1_30 > 0 && ag.totals.current > 0);
  assert.ok(b.listTime({ matterId: demo.matters.m2, status: "unbilled" }).length >= 3);
  for (const c of db.prepare("SELECT name FROM contacts").all() as any[]) assert.match(c.name, /\(demo\)/);
  assert.match(b.settings().firm_name, /\(demo\)/);
});
