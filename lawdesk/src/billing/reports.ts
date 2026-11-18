// Billing reports. Definitions used throughout:
//
//   Unbilled / WIP   billable time and expenses NOT on a finalized invoice. Work sitting on
//                    a draft invoice still counts (it has not been billed yet) and is shown
//                    separately as "on draft".
//   Standard value   what the work was worth when drafted: billed minutes x the entry's rate
//                    (or its flat amount), expenses at cost + markup, the matter flat fee.
//                    Stored per invoice line as standard_cents.
//   Billed           an invoice's fees after write-downs and discount, excluding tax:
//                    subtotal_cents - discount_cents.
//   Realization rate billed / standard value, over the invoices issued in the period.
//                    1.0 = billed everything at standard; 0.9 = 10% was written down or discounted.
//   Collection rate  amount applied to the period's invoices so far (payments + credit, not
//                    released) / their totals including tax. Write-offs are not collections.
//   Cash received    payments received in the period (not voided), however applied.
// Invoices that are void now are left out of billed figures.

import { type ISODate, daysBetween, isISODate } from "../dates.ts";
import { EngineError } from "../engine.ts";
import { type Billing, type BillingMethod, type Row, agingBucket } from "./billing.ts";
import { billedMinutes, expenseAmount } from "./money.ts";

function checkDate(v: unknown, what: string): ISODate {
  if (!isISODate(v)) throw new EngineError(`${what} must be a date like 2026-01-31`);
  return v;
}

const NOT_FINAL = "(t.invoice_id IS NULL OR (SELECT status FROM billing_invoices WHERE id = t.invoice_id) = 'draft')";

function methodOf(b: Billing, matterId: number): BillingMethod {
  return (b.one("SELECT method FROM billing_matters WHERE matter_id = ?", matterId)?.method as BillingMethod) ?? "hourly";
}

/** Unbilled billable time grouped by matter and timekeeper. */
export function unbilledTime(b: Billing, f: { from?: ISODate; to?: ISODate; matterId?: number; userId?: number } = {}) {
  const inc = b.settings().increment_minutes;
  const where = ["t.billable = 1", NOT_FINAL];
  const p: any[] = [];
  if (f.from) (where.push("t.date >= ?"), p.push(checkDate(f.from, "From")));
  if (f.to) (where.push("t.date <= ?"), p.push(checkDate(f.to, "To")));
  if (f.matterId != null) (where.push("t.matter_id = ?"), p.push(f.matterId));
  if (f.userId != null) (where.push("t.user_id = ?"), p.push(f.userId));
  const rows = b.all(
    `SELECT t.*, u.name AS user_name, m.name AS matter_name, m.number AS matter_number FROM billing_time_entries t
     JOIN users u ON u.id = t.user_id JOIN matters m ON m.id = t.matter_id WHERE ${where.join(" AND ")} ORDER BY m.name, m.id, u.name, u.id`,
    ...p,
  );
  const groups = new Map<string, Row>();
  const methods = new Map<number, BillingMethod>();
  for (const t of rows) {
    if (!methods.has(t.matter_id)) methods.set(t.matter_id, methodOf(b, t.matter_id));
    const method = methods.get(t.matter_id)!;
    const key = `${t.matter_id}:${t.user_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        matter_id: t.matter_id,
        matter_name: t.matter_name,
        matter_number: t.matter_number,
        billing_method: method,
        user_id: t.user_id,
        user_name: t.user_name,
        entries: 0,
        minutes: 0,
        billed_minutes: 0,
        value_cents: 0,
        on_draft_minutes: 0,
        running_timers: 0,
      };
      groups.set(key, g);
    }
    g.entries++;
    g.minutes += t.minutes;
    g.billed_minutes += billedMinutes(t.minutes, inc);
    g.value_cents += b.entryValue(t, method, inc);
    if (t.invoice_id != null) g.on_draft_minutes += t.minutes;
    if (t.timer_started_at) g.running_timers++;
  }
  const out = [...groups.values()];
  return {
    rows: out,
    totals: {
      minutes: out.reduce((s, g) => s + g.minutes, 0),
      billed_minutes: out.reduce((s, g) => s + g.billed_minutes, 0),
      value_cents: out.reduce((s, g) => s + g.value_cents, 0),
    },
  };
}

/** Work in progress per matter: unbilled time value, unbilled expenses and any unbilled flat fee. */
export function wip(b: Billing, f: { matterId?: number } = {}) {
  const inc = b.settings().increment_minutes;
  const matters = b.all(
    `SELECT m.id, m.number, m.name, m.client_id, c.name AS client_name, COALESCE(bm.method,'hourly') AS method, bm.flat_fee_cents
     FROM matters m LEFT JOIN contacts c ON c.id = m.client_id LEFT JOIN billing_matters bm ON bm.matter_id = m.id
     ${f.matterId != null ? "WHERE m.id = ?" : ""} ORDER BY m.name, m.id`,
    ...(f.matterId != null ? [f.matterId] : []),
  );
  const rows: Row[] = [];
  for (const m of matters) {
    const times = b.all(`SELECT * FROM billing_time_entries t WHERE t.matter_id = ? AND t.billable = 1 AND ${NOT_FINAL}`, m.id);
    const exps = b.all(
      `SELECT * FROM billing_expenses t WHERE t.matter_id = ? AND t.billable = 1 AND ${NOT_FINAL}`,
      m.id,
    );
    const flatPending =
      m.method === "flat" &&
      !b.one(
        `SELECT 1 FROM billing_invoice_lines l JOIN billing_invoices i ON i.id = l.invoice_id WHERE i.matter_id = ? AND l.matter_flat_fee = 1 AND i.status = 'final'`,
        m.id,
      );
    const row = {
      matter_id: m.id,
      matter_number: m.number,
      matter_name: m.name,
      client_id: m.client_id,
      client_name: m.client_name,
      billing_method: m.method,
      minutes: times.reduce((s, t) => s + t.minutes, 0),
      time_cents: times.reduce((s, t) => s + b.entryValue(t, m.method, inc), 0),
      expense_cents: exps.reduce((s, x) => s + expenseAmount(x.cost_cents, x.markup_bp), 0),
      flat_fee_cents: flatPending ? (m.flat_fee_cents ?? 0) : 0,
      draft_invoice_ids: b.all("SELECT id FROM billing_invoices WHERE matter_id = ? AND status = 'draft' ORDER BY id", m.id).map((r) => r.id),
      total_cents: 0,
    };
    row.total_cents = row.time_cents + row.expense_cents + row.flat_fee_cents;
    if (row.minutes || row.total_cents || times.length || exps.length) rows.push(row);
  }
  return {
    rows,
    totals: {
      time_cents: rows.reduce((s, r) => s + r.time_cents, 0),
      expense_cents: rows.reduce((s, r) => s + r.expense_cents, 0),
      flat_fee_cents: rows.reduce((s, r) => s + r.flat_fee_cents, 0),
      total_cents: rows.reduce((s, r) => s + r.total_cents, 0),
    },
  };
}

/** Billed vs collected for invoices issued in [from, to] (inclusive). See the definitions above. */
export function billedVsCollected(b: Billing, from: ISODate, to: ISODate) {
  checkDate(from, "From");
  checkDate(to, "To");
  if (from > to) throw new EngineError("The start of the period is after its end");
  const invs = b.all("SELECT * FROM billing_invoices WHERE status = 'final' AND issued_on BETWEEN ? AND ?", from, to);
  let standard = 0;
  let billed = 0;
  let invoiced = 0;
  let collected = 0;
  let writtenDown = 0;
  let discounts = 0;
  for (const i of invs) {
    const l = b.one(
      "SELECT COALESCE(SUM(standard_cents),0) AS std, COALESCE(SUM(writedown_cents),0) AS wd FROM billing_invoice_lines WHERE invoice_id = ?",
      i.id,
    )!;
    standard += l.std;
    writtenDown += l.wd;
    discounts += i.discount_cents;
    billed += i.subtotal_cents - i.discount_cents;
    invoiced += i.total_cents;
    collected += b.paidCents(i.id);
  }
  const cash = b.one(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM billing_payments WHERE voided_on IS NULL AND received_on BETWEEN ? AND ?",
    from,
    to,
  )!.s;
  const writtenOff = b.one(
    `SELECT COALESCE(SUM(w.amount_cents),0) AS s FROM billing_writeoffs w JOIN billing_invoices i ON i.id = w.invoice_id
     WHERE i.status = 'final' AND w.written_on BETWEEN ? AND ?`,
    from,
    to,
  )!.s;
  const ratio = (a: number, d: number) => (d === 0 ? null : Math.round((a / d) * 10_000) / 10_000);
  return {
    from,
    to,
    invoices: invs.length,
    standard_cents: standard,
    written_down_cents: writtenDown,
    discount_cents: discounts,
    billed_cents: billed,
    invoiced_total_cents: invoiced,
    collected_cents: collected,
    cash_received_cents: cash,
    written_off_cents: writtenOff,
    realization_rate: ratio(billed, standard),
    collection_rate: ratio(collected, invoiced),
  };
}

/**
 * Accounts receivable aging as of a date, by client. An invoice's age is the number of
 * days past its due date: not yet due (0 or less) = current, then 1-30, 31-60, 61-90, 90+.
 * Balances are as of the date: later payments, write-offs and voids are ignored.
 */
export function aging(b: Billing, asOf?: ISODate) {
  const at = asOf ? checkDate(asOf, "As-of date") : b.today();
  const invs = b.all(
    `SELECT i.*, c.name AS client_name, m.name AS matter_name FROM billing_invoices i
     JOIN contacts c ON c.id = i.client_id JOIN matters m ON m.id = i.matter_id
     WHERE i.status <> 'draft' AND i.issued_on <= ? ORDER BY c.name, i.client_id, i.number`,
    at,
  );
  const empty = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });
  const clients = new Map<number, Row>();
  const totals = empty();
  for (const i of invs) {
    const bal = b.balance(i.id, at);
    if (bal === 0) continue;
    const days = daysBetween(i.due_on, at);
    const bucket = agingBucket(days);
    let c = clients.get(i.client_id);
    if (!c) {
      c = { client_id: i.client_id, client_name: i.client_name, ...empty(), invoices: [] as Row[] };
      clients.set(i.client_id, c);
    }
    c[bucket] += bal;
    c.total += bal;
    totals[bucket] += bal;
    totals.total += bal;
    c.invoices.push({ id: i.id, number: i.number, matter_name: i.matter_name, issued_on: i.issued_on, due_on: i.due_on, days_past_due: Math.max(0, days), bucket, balance_cents: bal });
  }
  const rows: Row[] = [...clients.values()].map((c) => ({ ...c, credit_cents: b.clientCredit(c.client_id, at) }));
  return { as_of: at, rows, totals };
}
