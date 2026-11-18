import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, routes } from "../../src/billing/routes.ts";
import { matchPath } from "../../src/http.ts";
import { activity, setup } from "./helpers.ts";

function api(ctx: ReturnType<typeof setup>, userId: number | null) {
  return async (method: string, url: string, body: any = {}) => {
    const u = new URL(url, "http://x");
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchPath(r.path, u.pathname);
      if (!params) continue;
      return r.handler({ db: ctx.db, engine: ctx.engine, params, query: u.searchParams, body, userId });
    }
    throw new Error(`No route for ${method} ${url}`);
  };
}

test("routes: no two routes share a method and path", () => {
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const r of routes) assert.ok(r.path.startsWith("/billing/"));
});

test("routes: time to invoice to payment to reports, end to end", async () => {
  const ctx = setup();
  const call = api(ctx, ctx.atty);
  const entry: any = await call("POST", "/billing/time", { matterId: ctx.m1, minutes: 61, description: "Draft lease" });
  assert.equal(entry.user_id, ctx.atty); // defaults to the signed-in user
  await call("POST", "/billing/expenses", { matterId: ctx.m1, costCents: 2500, description: "Recording fee" });
  clock.now = () => new Date("2026-11-02T15:00:00Z");
  const timer: any = await call("POST", "/billing/timers", { matterId: ctx.m1 });
  assert.equal(((await call("GET", `/billing/timers?userId=${ctx.atty}`)) as any[]).length, 1);
  clock.now = () => new Date("2026-11-02T15:30:00Z"); // 30 minutes after the start
  const stopped: any = await call("POST", `/billing/time/${timer.id}/stop`);
  assert.equal(stopped.minutes, 30);
  clock.now = () => new Date();
  assert.equal(((await call("GET", "/billing/timers")) as any[]).length, 0);

  const draft: any = await call("POST", "/billing/invoices", { matterId: ctx.m1 });
  assert.equal(draft.lines.length, 3);
  await call("POST", `/billing/invoices/${draft.id}/lines/${draft.lines[1].id}/write-down`, { all: true, reason: "Timer test" });
  await call("PATCH", `/billing/invoices/${draft.id}`, { discountKind: "percent", discountValue: 1000 });
  const fin: any = await call("POST", `/billing/invoices/${draft.id}/finalize`);
  // 66 min x $300 = $330, expense $25 => $355, less 10% = $319.50
  assert.equal(fin.total_cents, 31950);
  assert.equal(fin.number, 1);
  const html: any = await call("GET", `/billing/invoices/${draft.id}/html`);
  assert.match(html.html, /^<!doctype html>/);

  const paid: any = await call("POST", `/billing/invoices/${fin.id}/payments`, { amountCents: 40000, receivedOn: "2026-11-02" });
  assert.equal(paid.unapplied_cents, 8050);
  assert.deepEqual(await call("GET", `/billing/clients/${ctx.acme}/credit`), { credit_cents: 8050 });
  const st: any = await call("GET", `/billing/clients/${ctx.acme}/statement?to=2026-11-30`);
  assert.equal(st.closing_balance_cents, -8050);
  const ag: any = await call("GET", "/billing/reports/aging?asOf=2026-11-30");
  assert.equal(ag.totals.total, 0);
  const bvc: any = await call("GET", "/billing/reports/billed-vs-collected?from=2026-11-01&to=2026-11-30");
  assert.equal(bvc.billed_cents, 31950);
  await assert.rejects(call("GET", "/billing/reports/billed-vs-collected"), /required/);
  const unb: any = await call("GET", "/billing/reports/unbilled");
  assert.equal(unb.rows.length, 0);
  const w: any = await call("GET", "/billing/reports/wip");
  assert.equal(w.rows.length, 0);

  await assert.rejects(call("PATCH", `/billing/time/${entry.id}`, { minutes: 5 }), /locked/);
  await assert.rejects(call("DELETE", `/billing/invoices/${fin.id}`), /cannot be edited/);
  const voided: any = await call("POST", `/billing/invoices/${fin.id}/void`, { reason: "Redo" });
  assert.equal(voided.status, "void");
  assert.equal(((await call("GET", "/billing/time?status=unbilled")) as any[]).length, 2);
  await assert.rejects(call("GET", "/billing/time?status=nope"), /status/);
  await assert.rejects(call("GET", "/billing/time?matterId=abc"), /Bad matterId/);

  const kinds = activity(ctx.db).map((a) => a.kind);
  for (const k of ["invoice_finalized", "invoice_voided", "payment_received", "line_written_off"]) assert.ok(kinds.includes(k), k);
  assert.ok(activity(ctx.db).filter((a) => a.kind.startsWith("invoice_") || a.kind.startsWith("payment_")).every((a) => a.user_id === ctx.atty && a.matter_id === ctx.m1));
});

test("routes: rates and matter billing terms", async () => {
  const ctx = setup();
  const call = api(ctx, null);
  await call("PUT", `/billing/users/${ctx.para}/rate`, { rateCents: 15000 });
  await call("PUT", `/billing/matters/${ctx.m1}`, { method: "hourly", rateCents: 22000 });
  await call("PUT", `/billing/matters/${ctx.m1}/rates/${ctx.para}`, { rateCents: 11000 });
  assert.deepEqual(await call("GET", `/billing/matters/${ctx.m1}/rates/${ctx.para}`), { rate_cents: 11000, source: "matter_user" });
  assert.deepEqual(await call("GET", `/billing/matters/${ctx.m2}/rates/${ctx.para}`), { rate_cents: 15000, source: "user" });
  const mb: any = await call("GET", `/billing/matters/${ctx.m1}`);
  assert.equal(mb.rate_cents, 22000);
  const s: any = await call("PATCH", "/billing/settings", { incrementMinutes: 15 });
  assert.equal(s.increment_minutes, 15);
  await assert.rejects(call("PATCH", "/billing/settings", { adsense: 1 }), /Unknown setting/);
  await assert.rejects(call("PATCH", "/billing/settings", { incrementMinutes: 0 }), /increment/);
  // With no signed-in user and no userId, a time entry is refused.
  await assert.rejects(call("POST", "/billing/time", { matterId: ctx.m1, minutes: 6 }), /User id/);
});
