// API routes for billing, mounted under /api. Request bodies use camelCase; amounts are
// integer cents, percentages are basis points, durations are minutes.

import { type Ctx, type Route, intParam } from "../http.ts";
import { EngineError } from "../engine.ts";
import { Billing } from "./billing.ts";
import { aging, billedVsCollected, unbilledTime, wip } from "./reports.ts";
import { renderInvoiceHtml } from "./render.ts";
import { assertCanSeeRow, filterVisible, hiddenMatterIds } from "../auth/access.ts";

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

/** Wrap a rendered invoice as a raw HTML response with a screen-only Print bar. */
export function printablePage(html: string) {
  const bar =
    `<style>.ld-print-bar{position:sticky;top:0;display:flex;gap:12px;align-items:center;justify-content:center;padding:10px;` +
    `margin:-32px -32px 24px;background:#1d3557;color:#fff;font:15px/1.4 "Segoe UI",Arial,sans-serif;flex-wrap:wrap}` +
    `.ld-print-bar button{font:inherit;font-weight:600;padding:6px 16px;border:0;border-radius:4px;background:#fff;color:#1d3557;cursor:pointer}` +
    `@media print{.ld-print-bar{display:none}}</style>` +
    `<div class="ld-print-bar"><span>To save a PDF, choose “Save as PDF” in the print window.</span>` +
    `<button type="button" id="ld-print">Print or save as PDF</button></div>` +
    `<script src="/js/billing/print.js"></script>`;
  return {
    __raw: true,
    contentType: "text/html; charset=utf-8",
    headers: {
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
    body: html.replace(/<body>/, "<body>" + bar),
  };
}

const body = (ctx: Ctx) => (ctx.body && typeof ctx.body === "object" ? ctx.body : {});

// Matter restrictions (src/auth/access.ts). The server already refuses a hidden matter named
// as :matterId, ?matterId= or a body matterId; these cover rows looked up by their own id
// and lists that span matters.
const rowId = (table: string, what: string) => (ctx: Ctx) => {
  const id = intParam(ctx, "id");
  assertCanSeeRow(ctx.db, ctx.userId, table, id, what);
  return id;
};
const timeId = rowId("billing_time_entries", "Time entry");
const expenseId = rowId("billing_expenses", "Expense");
const invoiceId = rowId("billing_invoices", "Invoice");
const paymentId = rowId("billing_payments", "Payment");
const visible = <T extends Record<string, any>>(ctx: Ctx, rows: T[]) => filterVisible(ctx.db, ctx.userId, rows);
const sumOf = (rows: Record<string, any>[], key: string) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);

/** A payment's allocations name invoices; each must be on a matter this person can see. */
function checkAllocations(ctx: Ctx) {
  const allocs = body(ctx).allocations;
  if (!Array.isArray(allocs)) return;
  for (const a of allocs) if (Number.isInteger(a?.invoiceId)) assertCanSeeRow(ctx.db, ctx.userId, "billing_invoices", a.invoiceId, "Invoice");
}

/** Invoice ids on matters hidden from this person (for client-level views that list invoices). */
function hiddenInvoices(ctx: Ctx): Set<number> {
  const hidden = hiddenMatterIds(ctx.db, ctx.userId);
  if (!hidden.size) return new Set();
  const rows = ctx.db.prepare(`SELECT id FROM billing_invoices WHERE matter_id IN (${[...hidden].map(() => "?").join(",")})`).all(...hidden) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/** A client's statement keeps every amount (the running balance is the client's), but names no hidden matter. */
function maskStatement(ctx: Ctx, s: Record<string, any>) {
  const hidden = hiddenInvoices(ctx);
  if (!hidden.size) return s;
  // "Invoice 12 (Matter name)" / "Invoice 12 voided: reason" -> "Invoice 12 (restricted matter)"
  const mask = (r: Record<string, any>) =>
    r && hidden.has(r.invoice_id ?? -1) && typeof r.description === "string"
      ? { ...r, description: r.description.replace(/\s*[(:].*$/s, "") + " (restricted matter)" }
      : r;
  const out: Record<string, any> = { ...s };
  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = out[k].map(mask);
  return out;
}

/** Accounts receivable aging without invoices on hidden matters; client and firm totals follow. */
function agingFor(ctx: Ctx, a: ReturnType<typeof aging>) {
  const hidden = hiddenInvoices(ctx);
  if (!hidden.size) return a;
  const buckets = ["current", "d1_30", "d31_60", "d61_90", "d90_plus", "total"] as const;
  const totals: Record<string, number> = Object.fromEntries(buckets.map((k) => [k, 0]));
  const rows = [];
  for (const c of a.rows) {
    const invoices = c.invoices.filter((i: any) => !hidden.has(i.id));
    if (!invoices.length) continue;
    const row: Record<string, any> = { ...c, invoices };
    for (const k of buckets) row[k] = 0;
    for (const i of invoices) (row[i.bucket] += i.balance_cents), (row.total += i.balance_cents);
    for (const k of buckets) totals[k] += row[k];
    rows.push(row);
  }
  return { ...a, rows, totals };
}

export const routes: Route[] = [
  // ------------------------------------------------------------ settings & rates
  { method: "GET", path: "/billing/settings", handler: (ctx) => billing(ctx).settings() },
  { method: "PATCH", path: "/billing/settings", handler: (ctx) => billing(ctx).updateSettings(body(ctx), ctx.userId) },
  { method: "GET", path: "/billing/users/rates", handler: (ctx) => billing(ctx).userRates() },
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
      visible(ctx, billing(ctx).listTime({ matterId: qInt(ctx, "matterId"), userId: qInt(ctx, "userId"), from: qStr(ctx, "from"), to: qStr(ctx, "to"), status: qStatus(ctx) })),
  },
  { method: "POST", path: "/billing/time", handler: (ctx) => billing(ctx).addTime({ userId: ctx.userId, ...body(ctx) }, ctx.userId) },
  { method: "GET", path: "/billing/time/:id", handler: (ctx) => billing(ctx).timeEntry(timeId(ctx)) },
  { method: "PATCH", path: "/billing/time/:id", handler: (ctx) => billing(ctx).updateTime(timeId(ctx), body(ctx), ctx.userId) },
  {
    method: "DELETE",
    path: "/billing/time/:id",
    handler: (ctx) => {
      billing(ctx).deleteTime(timeId(ctx));
      return { ok: true };
    },
  },
  { method: "GET", path: "/billing/timers", handler: (ctx) => visible(ctx, billing(ctx).runningTimers(qInt(ctx, "userId"))) },
  { method: "POST", path: "/billing/timers", handler: (ctx) => billing(ctx).startTimer({ input: { userId: ctx.userId, ...body(ctx) } }, ctx.userId) },
  { method: "POST", path: "/billing/time/:id/start", handler: (ctx) => billing(ctx).startTimer({ entryId: timeId(ctx) }, ctx.userId) },
  { method: "POST", path: "/billing/time/:id/stop", handler: (ctx) => billing(ctx).stopTimer(timeId(ctx)) },

  // --------------------------------------------------------------- expenses
  {
    method: "GET",
    path: "/billing/expenses",
    handler: (ctx) => visible(ctx, billing(ctx).listExpenses({ matterId: qInt(ctx, "matterId"), from: qStr(ctx, "from"), to: qStr(ctx, "to"), status: qStatus(ctx) })),
  },
  { method: "POST", path: "/billing/expenses", handler: (ctx) => billing(ctx).addExpense(body(ctx), ctx.userId) },
  { method: "GET", path: "/billing/expenses/:id", handler: (ctx) => billing(ctx).expense(expenseId(ctx)) },
  { method: "PATCH", path: "/billing/expenses/:id", handler: (ctx) => billing(ctx).updateExpense(expenseId(ctx), body(ctx)) },
  {
    method: "DELETE",
    path: "/billing/expenses/:id",
    handler: (ctx) => {
      billing(ctx).deleteExpense(expenseId(ctx));
      return { ok: true };
    },
  },

  // --------------------------------------------------------------- invoices
  {
    method: "GET",
    path: "/billing/invoices",
    handler: (ctx) => visible(ctx, billing(ctx).listInvoices({ matterId: qInt(ctx, "matterId"), clientId: qInt(ctx, "clientId"), status: qStr(ctx, "status") })),
  },
  { method: "POST", path: "/billing/invoices", handler: (ctx) => billing(ctx).createDraft(body(ctx), ctx.userId) },
  { method: "GET", path: "/billing/invoices/:id", handler: (ctx) => billing(ctx).invoice(invoiceId(ctx)) },
  {
    method: "GET",
    path: "/billing/invoices/:id/html",
    handler: (ctx) => {
      const b = billing(ctx);
      return { html: renderInvoiceHtml(b.invoice(invoiceId(ctx)), b.settings()) };
    },
  },
  {
    // The same invoice as a page of its own, for the browser's Print / Save as PDF.
    // The app's normal policy forbids inline styles, so this one response allows them
    // (and only them, plus the small script behind the Print button).
    method: "GET",
    path: "/billing/invoices/:id/print",
    handler: (ctx) => {
      const b = billing(ctx);
      return printablePage(renderInvoiceHtml(b.invoice(invoiceId(ctx)), b.settings()));
    },
  },
  { method: "PATCH", path: "/billing/invoices/:id", handler: (ctx) => billing(ctx).updateDraft(invoiceId(ctx), body(ctx), ctx.userId) },
  {
    method: "DELETE",
    path: "/billing/invoices/:id",
    handler: (ctx) => {
      billing(ctx).deleteDraft(invoiceId(ctx), ctx.userId);
      return { ok: true };
    },
  },
  { method: "POST", path: "/billing/invoices/:id/lines", handler: (ctx) => billing(ctx).addLine(invoiceId(ctx), body(ctx)) },
  {
    method: "PATCH",
    path: "/billing/invoices/:id/lines/:lineId",
    handler: (ctx) => billing(ctx).updateLine(invoiceId(ctx), intParam(ctx, "lineId"), body(ctx)),
  },
  {
    method: "DELETE",
    path: "/billing/invoices/:id/lines/:lineId",
    handler: (ctx) => {
      billing(ctx).removeLine(invoiceId(ctx), intParam(ctx, "lineId"));
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/billing/invoices/:id/lines/:lineId/write-down",
    handler: (ctx) => billing(ctx).writeDownLine(invoiceId(ctx), intParam(ctx, "lineId"), body(ctx), ctx.userId),
  },
  { method: "POST", path: "/billing/invoices/:id/finalize", handler: (ctx) => billing(ctx).finalize(invoiceId(ctx), ctx.userId) },
  { method: "POST", path: "/billing/invoices/:id/void", handler: (ctx) => billing(ctx).void(invoiceId(ctx), body(ctx).reason, ctx.userId) },
  { method: "POST", path: "/billing/invoices/:id/payments", handler: (ctx) => billing(ctx).payInvoice(invoiceId(ctx), body(ctx), ctx.userId) },
  {
    method: "POST",
    path: "/billing/invoices/:id/apply-credit",
    handler: (ctx) => billing(ctx).applyCredit(invoiceId(ctx), body(ctx).amountCents ?? null, ctx.userId),
  },
  { method: "POST", path: "/billing/invoices/:id/write-off", handler: (ctx) => billing(ctx).writeOffBalance(invoiceId(ctx), body(ctx), ctx.userId) },

  // --------------------------------------------------------------- payments
  { method: "GET", path: "/billing/payments", handler: (ctx) => visible(ctx, billing(ctx).listPayments({ clientId: qInt(ctx, "clientId") })) },
  { method: "POST", path: "/billing/payments", handler: (ctx) => (checkAllocations(ctx), billing(ctx).recordPayment(body(ctx), ctx.userId)) },
  { method: "GET", path: "/billing/payments/:id", handler: (ctx) => billing(ctx).payment(paymentId(ctx)) },
  { method: "POST", path: "/billing/payments/:id/void", handler: (ctx) => billing(ctx).voidPayment(paymentId(ctx), body(ctx).reason, ctx.userId) },

  // ---------------------------------------------------------------- clients
  {
    method: "GET",
    path: "/billing/clients/:clientId/statement",
    handler: (ctx) => maskStatement(ctx, billing(ctx).statement(intParam(ctx, "clientId"), qStr(ctx, "from"), qStr(ctx, "to"))),
  },
  {
    method: "GET",
    path: "/billing/clients/:clientId/credit",
    handler: (ctx) => ({ credit_cents: billing(ctx).clientCredit(intParam(ctx, "clientId")) }),
  },

  // ---------------------------------------------------------------- reports
  { method: "GET", path: "/billing/reports/aging", handler: (ctx) => agingFor(ctx, aging(billing(ctx), qStr(ctx, "asOf"))) },
  {
    method: "GET",
    path: "/billing/reports/unbilled",
    handler: (ctx) => {
      const r = unbilledTime(billing(ctx), { from: qStr(ctx, "from"), to: qStr(ctx, "to"), matterId: qInt(ctx, "matterId"), userId: qInt(ctx, "userId") });
      const rows = visible(ctx, r.rows);
      if (rows.length === r.rows.length) return r;
      return { rows, totals: { minutes: sumOf(rows, "minutes"), billed_minutes: sumOf(rows, "billed_minutes"), value_cents: sumOf(rows, "value_cents") } };
    },
  },
  {
    method: "GET",
    path: "/billing/reports/wip",
    handler: (ctx) => {
      const r = wip(billing(ctx), { matterId: qInt(ctx, "matterId") });
      const rows = visible(ctx, r.rows);
      if (rows.length === r.rows.length) return r;
      return { rows, totals: Object.fromEntries(Object.keys(r.totals).map((k) => [k, sumOf(rows, k)])) };
    },
  },
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
