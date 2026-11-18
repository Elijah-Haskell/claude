// API routes for client trust accounting, mounted under /api. Amounts are integer cents.
// Printable reports (…/print) return a self-contained HTML page instead of JSON.

import { type Ctx, type Route, intParam } from "../http.ts";
import { EngineError } from "../engine.ts";
import { isISODate } from "../dates.ts";
import { Trust } from "./trust.ts";
import { GAPS, RETENTION_YEARS, RULES, SOURCES } from "./rules.ts";
import { balancesHtml, historyHtml, journalHtml, ledgerStatementHtml, reconciliationHtml, rulesHtml } from "./render.ts";

/** Wall clock for timestamps. Tests replace `clock.now`. */
export const clock = { now: () => new Date() };

function trust(ctx: Ctx): Trust {
  return new Trust(ctx.db, ctx.engine, { today: () => ctx.engine.today(), now: () => clock.now() });
}

const body = (ctx: Ctx) => (ctx.body && typeof ctx.body === "object" ? ctx.body : {});

function qDate(ctx: Ctx, name: string): string | undefined {
  const v = ctx.query.get(name);
  if (v == null || v === "") return undefined;
  if (!isISODate(v)) throw new EngineError(`${name} must be a date like 2026-01-31`);
  return v;
}

function period(ctx: Ctx): string {
  const p = ctx.params.period;
  if (!/^\d{4}-\d{2}$/.test(p)) throw new EngineError("Month must look like 2026-10");
  return p;
}

function firm(ctx: Ctx): string {
  return (ctx.db.prepare("SELECT firm_name FROM billing_settings WHERE id = 1").get() as any)?.firm_name ?? "";
}

function html(page: string) {
  return {
    __raw: true,
    contentType: "text/html; charset=utf-8",
    // The page carries its own inline stylesheet and no scripts.
    headers: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'" },
    body: page,
  };
}

const matter = (b: any, key = "matterId") => b[key];

export const routes: Route[] = [
  {
    method: "GET",
    path: "/trust/rules",
    handler: () => ({ rules: RULES, gaps: GAPS, sources: SOURCES, retentionYears: RETENTION_YEARS }),
  },
  { method: "GET", path: "/trust/rules/print", handler: () => html(rulesHtml()) },

  // ------------------------------------------------------------- accounts
  { method: "GET", path: "/trust/accounts", handler: (ctx) => trust(ctx).listAccounts() },
  { method: "POST", path: "/trust/accounts", handler: (ctx) => trust(ctx).createAccount(body(ctx), ctx.userId) },
  { method: "GET", path: "/trust/accounts/:id", handler: (ctx) => trust(ctx).account(intParam(ctx, "id")) },
  { method: "PATCH", path: "/trust/accounts/:id", handler: (ctx) => trust(ctx).updateAccount(intParam(ctx, "id"), body(ctx), ctx.userId) },
  {
    method: "GET",
    path: "/trust/accounts/:id/journal",
    handler: (ctx) => trust(ctx).journal(intParam(ctx, "id"), qDate(ctx, "from"), qDate(ctx, "to")),
  },
  {
    method: "GET",
    path: "/trust/accounts/:id/ledgers",
    handler: (ctx) => trust(ctx).listLedgers(intParam(ctx, "id"), { includeZero: ctx.query.get("all") === "1" }),
  },

  // ------------------------------------------------------------- entries
  {
    method: "POST",
    path: "/trust/accounts/:id/deposits",
    handler: (ctx) => trust(ctx).deposit(intParam(ctx, "id"), matter(body(ctx)), body(ctx), ctx.userId),
  },
  {
    method: "POST",
    path: "/trust/accounts/:id/disbursements",
    handler: (ctx) => trust(ctx).disburse(intParam(ctx, "id"), matter(body(ctx)), body(ctx), ctx.userId),
  },
  {
    method: "POST",
    path: "/trust/accounts/:id/fee-transfers",
    handler: (ctx) => trust(ctx).transferFee(intParam(ctx, "id"), body(ctx).invoiceId, body(ctx), ctx.userId),
  },
  {
    method: "POST",
    path: "/trust/accounts/:id/ledger-transfers",
    handler: (ctx) => trust(ctx).transferBetween(intParam(ctx, "id"), body(ctx).fromMatterId, body(ctx).toMatterId, body(ctx), ctx.userId),
  },
  { method: "POST", path: "/trust/accounts/:id/firm-deposits", handler: (ctx) => trust(ctx).firmDeposit(intParam(ctx, "id"), body(ctx), ctx.userId) },
  { method: "POST", path: "/trust/accounts/:id/firm-withdrawals", handler: (ctx) => trust(ctx).firmWithdrawal(intParam(ctx, "id"), body(ctx), ctx.userId) },
  { method: "POST", path: "/trust/accounts/:id/bank-fees", handler: (ctx) => trust(ctx).bankFee(intParam(ctx, "id"), body(ctx), ctx.userId) },
  { method: "POST", path: "/trust/accounts/:id/interest", handler: (ctx) => trust(ctx).interest(intParam(ctx, "id"), matter(body(ctx)), body(ctx), ctx.userId) },
  { method: "GET", path: "/trust/entries/:id", handler: (ctx) => trust(ctx).txn(intParam(ctx, "id")) },
  { method: "POST", path: "/trust/entries/:id/reverse", handler: (ctx) => trust(ctx).reverse(intParam(ctx, "id"), body(ctx), ctx.userId) },
  {
    method: "PUT",
    path: "/trust/entries/:id/cleared",
    handler: (ctx) => trust(ctx).setCleared(intParam(ctx, "id"), body(ctx).clearedOn ?? null, ctx.userId),
  },

  // -------------------------------------------------------------- ledgers
  { method: "GET", path: "/trust/ledgers/:id", handler: (ctx) => trust(ctx).ledger(intParam(ctx, "id")) },
  {
    method: "GET",
    path: "/trust/ledgers/:id/print",
    handler: (ctx) => html(ledgerStatementHtml(trust(ctx).ledger(intParam(ctx, "id")), qDate(ctx, "from"), qDate(ctx, "to"), firm(ctx))),
  },
  { method: "POST", path: "/trust/ledgers/:id/holds", handler: (ctx) => trust(ctx).placeHold(intParam(ctx, "id"), body(ctx), ctx.userId) },
  { method: "POST", path: "/trust/holds/:id/release", handler: (ctx) => trust(ctx).releaseHold(intParam(ctx, "id"), body(ctx), ctx.userId) },
  { method: "GET", path: "/trust/matters/:id/ledgers", handler: (ctx) => trust(ctx).matterLedgers(intParam(ctx, "id")) },

  // -------------------------------------------------------- reconciliation
  {
    method: "GET",
    path: "/trust/accounts/:id/reconcile/:period",
    handler: (ctx) => {
      const t = trust(ctx);
      const aid = intParam(ctx, "id");
      const p = period(ctx);
      const saved = t.one("SELECT * FROM trust_reconciliations WHERE account_id = ? AND period = ?", aid, p);
      const raw = ctx.query.get("statement");
      const stmt = raw != null && raw !== "" ? Number(raw) : saved?.statement_balance_cents ?? 0;
      if (!Number.isSafeInteger(stmt)) throw new EngineError("statement must be whole cents");
      return {
        preview: t.reconcile(aid, p, stmt),
        saved: saved ? t.reconciliation(aid, p) : null,
        unsignedBefore: t.unsignedBefore(aid, p),
        journal: t.journal(aid, undefined, `${p}-31`).filter((r) => r.amount_cents !== 0),
      };
    },
  },
  {
    method: "PUT",
    path: "/trust/accounts/:id/reconcile/:period",
    handler: (ctx) => trust(ctx).saveReconciliation(intParam(ctx, "id"), { ...body(ctx), period: period(ctx) }, ctx.userId),
  },
  {
    method: "POST",
    path: "/trust/accounts/:id/reconcile/:period/sign",
    handler: (ctx) => trust(ctx).signReconciliation(intParam(ctx, "id"), period(ctx), ctx.userId),
  },
  { method: "GET", path: "/trust/accounts/:id/reconciliations", handler: (ctx) => trust(ctx).listReconciliations(intParam(ctx, "id")) },
  {
    method: "GET",
    path: "/trust/accounts/:id/reconciliations/:period/print",
    handler: (ctx) => html(reconciliationHtml(trust(ctx).reconciliation(intParam(ctx, "id"), period(ctx)), firm(ctx))),
  },

  // --------------------------------------------------------------- reports
  {
    method: "GET",
    path: "/trust/accounts/:id/balances",
    handler: (ctx) => trust(ctx).clientBalances(intParam(ctx, "id"), qDate(ctx, "asOf")),
  },
  {
    method: "GET",
    path: "/trust/accounts/:id/inactive",
    handler: (ctx) => trust(ctx).inactiveBalances(intParam(ctx, "id"), Number(ctx.query.get("months") ?? 12)),
  },
  {
    method: "GET",
    path: "/trust/accounts/:id/journal/print",
    handler: (ctx) => {
      const t = trust(ctx);
      const aid = intParam(ctx, "id");
      return html(journalHtml(t.accountRow(aid), t.journal(aid, qDate(ctx, "from"), qDate(ctx, "to")), qDate(ctx, "from"), qDate(ctx, "to"), firm(ctx)));
    },
  },
  {
    method: "GET",
    path: "/trust/accounts/:id/balances/print",
    handler: (ctx) => {
      const t = trust(ctx);
      const aid = intParam(ctx, "id");
      const asOf = qDate(ctx, "asOf") ?? t.today();
      return html(balancesHtml(t.accountRow(aid), t.clientBalances(aid, asOf), asOf, firm(ctx)));
    },
  },
  {
    method: "GET",
    path: "/trust/accounts/:id/inactive/print",
    handler: (ctx) => {
      const t = trust(ctx);
      const aid = intParam(ctx, "id");
      const months = Number(ctx.query.get("months") ?? 12);
      const rows = t.inactiveBalances(aid, months);
      return html(
        balancesHtml(t.accountRow(aid), rows, t.today(), firm(ctx), `Inactive trust balances (no activity in ${months} months)`,
          "<p>What to do with long-inactive balances is the lawyer's decision; Lawdesk has not verified the rules on unclaimed funds.</p>"),
      );
    },
  },
  {
    method: "GET",
    path: "/trust/accounts/:id/reconciliations/print",
    handler: (ctx) => {
      const t = trust(ctx);
      const aid = intParam(ctx, "id");
      return html(historyHtml(t.accountRow(aid), t.listReconciliations(aid), firm(ctx)));
    },
  },
];
