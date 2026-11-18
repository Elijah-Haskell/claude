// API routes for billing, mounted under /api. Request bodies use camelCase; amounts are
// integer cents, percentages are basis points, durations are minutes.

import { type Ctx, type Route, intParam } from "../http.ts";
import { EngineError } from "../engine.ts";
import { Billing } from "./billing.ts";
import { aging, billedVsCollected, unbilledTime, wip } from "./reports.ts";
import { renderInvoiceHtml } from "./render.ts";

/** Wall clock used for timers and timestamps. Tests replace `clock.now`. */
export const clock = { now: () => new Date() };

function billing(ctx: Ctx): Billing {
  return new Billing(ctx.db, { today: () => ctx.engine.today(), now: () => clock.now() });
}

function qInt(ctx: Ctx, name: string): number | undefined {
  const v = ctx.query.get(name);
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${name}`);
  return n;
}

function qStr(ctx: Ctx, name: string): string | undefined {
  const v = ctx.query.get(name);
  return v == null || v === "" ? undefined : v;
}

function qStatus(ctx: Ctx): "unbilled" | "billed" | "all" | undefined {
  const s = qStr(ctx, "status");
  if (s != null && !["unbilled", "billed", "all"].includes(s)) throw new EngineError("status must be unbilled, billed or all");
  return s as any;
}

const body = (ctx: Ctx) => (ctx.body && typeof ctx.body === "object" ? ctx.body : {});

export const routes: Route[] = [
  // ------------------------------------------------------------ settings & rates
  { method: "GET", path: "/billing/settings", handler: (ctx) => billing(ctx).settings() },
  { method: "PATCH", path: "/billing/settings", handler: (ctx) => billing(ctx).updateSettings(body(ctx), ctx.userId) },
  {
    method: "PUT",
    path: "/billing/users/:userId/rate",
    handler: (ctx) => {
      billing(ctx).setUserRate(intParam(ctx, "userId"), body(ctx).rateCents ?? null);
      return { ok: true };
    },
  },
  { method: "GET", path: "/billing/matters/:matterId", handler: (ctx) => billing(ctx).matterBilling(intParam(ctx, "matterId")) },
  { method: "PUT", path: "/billing/matters/:matterId", handler: (ctx) => billing(ctx).setMatterBilling(intParam(ctx, "matterId"), body(ctx), ctx.userId) },
  {
    method: "PUT",
    path: "/billing/matters/:matterId/rates/:userId",
    handler: (ctx) => {
      billing(ctx).setMatterUserRate(intParam(ctx, "matterId"), intParam(ctx, "userId"), body(ctx).rateCents ?? null);
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/billing/matters/:matterId/rates/:userId",
    handler: (ctx) => billing(ctx).resolveRate(intParam(ctx, "matterId"), intParam(ctx, "userId")),
  },

  // ------------------------------------------------------------------- time
  {
    method: "GET",
    path: "/billing/time",
    handler: (ctx) =>
      billing(ctx).listTime({ matterId: qInt(ctx, "matterId"), userId: qInt(ctx, "userId"), from: qStr(ctx, "from"), to: qStr(ctx, "to"), status: qStatus(ctx) }),
  },
  { method: "POST", path: "/billing/time", handler: (ctx) => billing(ctx).addTime({ userId: ctx.userId, ...body(ctx) }, ctx.userId) },
  { method: "GET", path: "/billing/time/:id", handler: (ctx) => billing(ctx).timeEntry(intParam(ctx, "id")) },
  { method: "PATCH", path: "/billing/time/:id", handler: (ctx) => billing(ctx).updateTime(intParam(ctx, "id"), body(ctx), ctx.userId) },
  {
    method: "DELETE",
    path: "/billing/time/:id",
    handler: (ctx) => {
      billing(ctx).deleteTime(intParam(ctx, "id"));
      return { ok: true };
    },
  },
  { method: "GET", path: "/billing/timers", handler: (ctx) => billing(ctx).runningTimers(qInt(ctx, "userId")) },
  { method: "POST", path: "/billing/timers", handler: (ctx) => billing(ctx).startTimer({ input: { userId: ctx.userId, ...body(ctx) } }, ctx.userId) },
  { method: "POST", path: "/billing/time/:id/start", handler: (ctx) => billing(ctx).startTimer({ entryId: intParam(ctx, "id") }, ctx.userId) },
  { method: "POST", path: "/billing/time/:id/stop", handler: (ctx) => billing(ctx).stopTimer(intParam(ctx, "id")) },

  // --------------------------------------------------------------- expenses
  {
    method: "GET",
    path: "/billing/expenses",
    handler: (ctx) => billing(ctx).listExpenses({ matterId: qInt(ctx, "matterId"), from: qStr(ctx, "from"), to: qStr(ctx, "to"), status: qStatus(ctx) }),
  },
  { method: "POST", path: "/billing/expenses", handler: (ctx) => billing(ctx).addExpense(body(ctx), ctx.userId) },
  { method: "GET", path: "/billing/expenses/:id", handler: (ctx) => billing(ctx).expense(intParam(ctx, "id")) },
  { method: "PATCH", path: "/billing/expenses/:id", handler: (ctx) => billing(ctx).updateExpense(intParam(ctx, "id"), body(ctx)) },
  {
    method: "DELETE",
    path: "/billing/expenses/:id",
    handler: (ctx) => {
      billing(ctx).deleteExpense(intParam(ctx, "id"));
      return { ok: true };
    },
  },

  // --------------------------------------------------------------- invoices
  {
    method: "GET",
    path: "/billing/invoices",
    handler: (ctx) => billing(ctx).listInvoices({ matterId: qInt(ctx, "matterId"), clientId: qInt(ctx, "clientId"), status: qStr(ctx, "status") }),
  },
  { method: "POST", path: "/billing/invoices", handler: (ctx) => billing(ctx).createDraft(body(ctx), ctx.userId) },
  { method: "GET", path: "/billing/invoices/:id", handler: (ctx) => billing(ctx).invoice(intParam(ctx, "id")) },
  {
    method: "GET",
    path: "/billing/invoices/:id/html",
    handler: (ctx) => {
      const b = billing(ctx);
      return { html: renderInvoiceHtml(b.invoice(intParam(ctx, "id")), b.settings()) };
    },
  },
  { method: "PATCH", path: "/billing/invoices/:id", handler: (ctx) => billing(ctx).updateDraft(intParam(ctx, "id"), body(ctx), ctx.userId) },
  {
    method: "DELETE",
    path: "/billing/invoices/:id",
    handler: (ctx) => {
      billing(ctx).deleteDraft(intParam(ctx, "id"), ctx.userId);
      return { ok: true };
    },
  },
  { method: "POST", path: "/billing/invoices/:id/lines", handler: (ctx) => billing(ctx).addLine(intParam(ctx, "id"), body(ctx)) },
  {
    method: "PATCH",
    path: "/billing/invoices/:id/lines/:lineId",
    handler: (ctx) => billing(ctx).updateLine(intParam(ctx, "id"), intParam(ctx, "lineId"), body(ctx)),
  },
  {
    method: "DELETE",
    path: "/billing/invoices/:id/lines/:lineId",
    handler: (ctx) => {
      billing(ctx).removeLine(intParam(ctx, "id"), intParam(ctx, "lineId"));
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/billing/invoices/:id/lines/:lineId/write-down",
    handler: (ctx) => billing(ctx).writeDownLine(intParam(ctx, "id"), intParam(ctx, "lineId"), body(ctx), ctx.userId),
  },
  { method: "POST", path: "/billing/invoices/:id/finalize", handler: (ctx) => billing(ctx).finalize(intParam(ctx, "id"), ctx.userId) },
  { method: "POST", path: "/billing/invoices/:id/void", handler: (ctx) => billing(ctx).void(intParam(ctx, "id"), body(ctx).reason, ctx.userId) },
  { method: "POST", path: "/billing/invoices/:id/payments", handler: (ctx) => billing(ctx).payInvoice(intParam(ctx, "id"), body(ctx), ctx.userId) },
  {
    method: "POST",
    path: "/billing/invoices/:id/apply-credit",
    handler: (ctx) => billing(ctx).applyCredit(intParam(ctx, "id"), body(ctx).amountCents ?? null, ctx.userId),
  },
  { method: "POST", path: "/billing/invoices/:id/write-off", handler: (ctx) => billing(ctx).writeOffBalance(intParam(ctx, "id"), body(ctx), ctx.userId) },

  // --------------------------------------------------------------- payments
  { method: "GET", path: "/billing/payments", handler: (ctx) => billing(ctx).listPayments({ clientId: qInt(ctx, "clientId") }) },
  { method: "POST", path: "/billing/payments", handler: (ctx) => billing(ctx).recordPayment(body(ctx), ctx.userId) },
  { method: "GET", path: "/billing/payments/:id", handler: (ctx) => billing(ctx).payment(intParam(ctx, "id")) },
  { method: "POST", path: "/billing/payments/:id/void", handler: (ctx) => billing(ctx).voidPayment(intParam(ctx, "id"), body(ctx).reason, ctx.userId) },

  // ---------------------------------------------------------------- clients
  {
    method: "GET",
    path: "/billing/clients/:clientId/statement",
    handler: (ctx) => billing(ctx).statement(intParam(ctx, "clientId"), qStr(ctx, "from"), qStr(ctx, "to")),
  },
  {
    method: "GET",
    path: "/billing/clients/:clientId/credit",
    handler: (ctx) => ({ credit_cents: billing(ctx).clientCredit(intParam(ctx, "clientId")) }),
  },

  // ---------------------------------------------------------------- reports
  { method: "GET", path: "/billing/reports/aging", handler: (ctx) => aging(billing(ctx), qStr(ctx, "asOf")) },
  {
    method: "GET",
    path: "/billing/reports/unbilled",
    handler: (ctx) =>
      unbilledTime(billing(ctx), { from: qStr(ctx, "from"), to: qStr(ctx, "to"), matterId: qInt(ctx, "matterId"), userId: qInt(ctx, "userId") }),
  },
  { method: "GET", path: "/billing/reports/wip", handler: (ctx) => wip(billing(ctx), { matterId: qInt(ctx, "matterId") }) },
  {
    method: "GET",
    path: "/billing/reports/billed-vs-collected",
    handler: (ctx) => {
      const from = qStr(ctx, "from");
      const to = qStr(ctx, "to");
      if (!from || !to) throw new EngineError("from and to are required");
      return billedVsCollected(billing(ctx), from, to);
    },
  },
];
