// Time, expenses, rates, invoices and payments (operating money only; no trust).
// Units and rounding rules are described in schema.ts and money.ts.
//
// Lifecycle of billable work:
//   time entry / expense  --draft-->  line on a draft invoice (entry.invoice_id = draft)
//                          --finalize--> locked; invoice gets the next number
//                          --void-->     entries released back to unbilled; payments released to client credit
// A draft can be edited or deleted freely; it never consumes an invoice number.
// A finalized invoice is never deleted (the database refuses), so numbers have no gaps.

import { type DB, tx } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type ISODate, addDays, isISODate, today as todayIn } from "../dates.ts";
import { applyBp, billedMinutes, expenseAmount, formatCents, timeAmount } from "./money.ts";

export type Row = Record<string, any>;
export type BillingMethod = "hourly" | "flat" | "contingency";
export type LineKind = "time" | "expense" | "flat";

export interface TimeInput {
  userId: number;
  matterId: number;
  date?: ISODate;
  minutes?: number;
  description?: string;
  billable?: boolean;
  rateCents?: number | null;
  flatCents?: number | null;
  activityCode?: string | null;
  taskId?: number | null;
}

export interface ExpenseInput {
  matterId: number;
  userId?: number | null;
  date?: ISODate;
  description?: string;
  costCents: number;
  markupBp?: number;
  billable?: boolean;
  expenseCode?: string | null;
  receiptNote?: string | null;
}

export interface LineInput {
  kind: LineKind;
  date?: ISODate | null;
  userId?: number | null;
  description?: string;
  minutes?: number;
  rateCents?: number;
  amountCents?: number;
  taxBp?: number;
}

export interface PaymentInput {
  clientId: number;
  matterId?: number | null;
  amountCents: number;
  receivedOn?: ISODate;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  allocations?: { invoiceId: number; amountCents: number }[];
}

export interface Totals {
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
}

const NO_CHARGE: Record<string, string> = {
  flat: "Included in flat fee",
  contingency: "Contingency matter: no hourly charge",
};

function bad(message: string, status = 400): never {
  throw new EngineError(message, status);
}

export function int(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    bad(max === Number.MAX_SAFE_INTEGER ? `${what} must be a whole number of at least ${min}` : `${what} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

function text(v: unknown, what: string, max = 4000): string {
  if (v == null) return "";
  if (typeof v !== "string") bad(`${what} must be text`);
  if (v.length > max) bad(`${what} is too long`);
  return v.trim();
}

function optText(v: unknown, what: string): string | null {
  const s = text(v, what);
  return s === "" ? null : s;
}

function date(v: unknown, what: string): ISODate {
  if (!isISODate(v)) bad(`${what} must be a date like 2026-01-31`);
  return v;
}

export class Billing {
  db: DB;
  private todayFn: () => ISODate;
  private nowFn: () => Date;

  constructor(db: DB, opts: { today?: () => ISODate; now?: () => Date; timeZone?: string } = {}) {
    this.db = db;
    this.todayFn = opts.today ?? (() => todayIn(opts.timeZone));
    this.nowFn = opts.now ?? (() => new Date());
  }

  today(): ISODate {
    return this.todayFn();
  }

  // ---------------------------------------------------------------- helpers

  one(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: any[]): number {
    return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
  }

  private must(sql: string, what: string, ...params: any[]): Row {
    const row = this.one(sql, ...params);
    if (!row) bad(`${what} not found`, 404);
    return row;
  }

  /** Same row shape the engine writes, so billing events show in the matter's history. */
  private log(kind: string, detail: string, userId: number | null, matterId: number | null) {
    this.run(
      "INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,?,?,?)",
      this.nowFn().toISOString(),
      userId ?? null,
      matterId ?? null,
      null,
      kind,
      detail,
    );
  }

  private user(id: unknown): Row {
    return this.must("SELECT * FROM users WHERE id = ?", "User", int(id, "User id", 1));
  }

  private matter(id: unknown): Row {
    return this.must("SELECT * FROM matters WHERE id = ?", "Matter", int(id, "Matter id", 1));
  }

  // --------------------------------------------------------------- settings

  settings(): Row {
    return this.one("SELECT * FROM billing_settings WHERE id = 1")!;
  }

  updateSettings(patch: Record<string, unknown>, actor: number | null = null): Row {
    const fields: Record<string, (v: unknown) => unknown> = {
      firmName: (v) => text(v, "Firm name", 200),
      firmAddress: (v) => text(v, "Firm address", 1000),
      defaultRateCents: (v) => int(v, "Default rate"),
      incrementMinutes: (v) => int(v, "Billing increment", 1, 60),
      paymentTermsDays: (v) => int(v, "Payment terms", 0, 3650),
      firstInvoiceNumber: (v) => int(v, "First invoice number", 1),
      taxTimeBp: (v) => int(v, "Tax rate on time", 0, 10000),
      taxExpenseBp: (v) => int(v, "Tax rate on expenses", 0, 10000),
      taxFlatBp: (v) => int(v, "Tax rate on flat fees", 0, 10000),
    };
    return tx(this.db, () => {
      const changed: string[] = [];
      for (const [k, v] of Object.entries(patch ?? {})) {
        const check = fields[k];
        if (!check) bad(`Unknown setting "${k}"`);
        const col = k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
        if (k === "firstInvoiceNumber" && this.one("SELECT 1 FROM billing_invoices WHERE number IS NOT NULL")) {
          bad("Invoice numbering has started; the first number can no longer change", 409);
        }
        this.run(`UPDATE billing_settings SET ${col} = ? WHERE id = 1`, check(v) as any);
        changed.push(k);
      }
      if (changed.length) this.log("billing_settings", `Changed billing settings: ${changed.join(", ")}`, actor, null);
      return this.settings();
    });
  }

  // ------------------------------------------------------------------ rates

  setUserRate(userId: number, rateCents: number | null): void {
    this.user(userId);
    if (rateCents == null) this.run("DELETE FROM billing_user_rates WHERE user_id = ?", userId);
    else this.run("INSERT OR REPLACE INTO billing_user_rates (user_id, rate_cents) VALUES (?,?)", userId, int(rateCents, "Rate"));
  }

  /** Every person's standard rate override, as [{user_id, rate_cents}]. */
  userRates(): Row[] {
    return this.all("SELECT user_id, rate_cents FROM billing_user_rates ORDER BY user_id");
  }

  matterBilling(matterId: number): { matter_id: number; method: BillingMethod; rate_cents: number | null; flat_fee_cents: number | null } {
    this.matter(matterId);
    const r = this.one("SELECT * FROM billing_matters WHERE matter_id = ?", matterId);
    return (r as any) ?? { matter_id: matterId, method: "hourly", rate_cents: null, flat_fee_cents: null };
  }

  setMatterBilling(matterId: number, input: { method?: BillingMethod; rateCents?: number | null; flatFeeCents?: number | null }, actor: number | null = null) {
    return tx(this.db, () => {
      const cur = this.matterBilling(matterId);
      const method = input.method ?? cur.method;
      if (!["hourly", "flat", "contingency"].includes(method)) bad("Billing method must be hourly, flat or contingency");
      const rate = input.rateCents !== undefined ? (input.rateCents == null ? null : int(input.rateCents, "Matter rate")) : cur.rate_cents;
      const flat = input.flatFeeCents !== undefined ? (input.flatFeeCents == null ? null : int(input.flatFeeCents, "Flat fee")) : cur.flat_fee_cents;
      if (method === "flat" && flat == null) bad("A flat-fee matter needs the fee amount");
      this.run("INSERT OR REPLACE INTO billing_matters (matter_id, method, rate_cents, flat_fee_cents) VALUES (?,?,?,?)", matterId, method, rate, flat);
      const desc = method === "flat" ? `flat fee ${formatCents(flat!)}` : method === "contingency" ? "contingency" : `hourly${rate != null ? ` at ${formatCents(rate)}/h` : ""}`;
      this.log("billing_terms", `Billing set to ${desc}`, actor, matterId);
      return this.matterBilling(matterId);
    });
  }

  setMatterUserRate(matterId: number, userId: number, rateCents: number | null): void {
    this.matter(matterId);
    this.user(userId);
    if (rateCents == null) this.run("DELETE FROM billing_matter_user_rates WHERE matter_id = ? AND user_id = ?", matterId, userId);
    else
      this.run(
        "INSERT OR REPLACE INTO billing_matter_user_rates (matter_id, user_id, rate_cents) VALUES (?,?,?)",
        matterId,
        userId,
        int(rateCents, "Rate"),
      );
  }

  /** Most specific wins: matter+user, then matter, then user, then the firm default. */
  resolveRate(matterId: number, userId: number): { rate_cents: number; source: "matter_user" | "matter" | "user" | "firm" } {
    const mu = this.one("SELECT rate_cents FROM billing_matter_user_rates WHERE matter_id = ? AND user_id = ?", matterId, userId);
    if (mu) return { rate_cents: mu.rate_cents, source: "matter_user" };
    const m = this.one("SELECT rate_cents FROM billing_matters WHERE matter_id = ? AND rate_cents IS NOT NULL", matterId);
    if (m) return { rate_cents: m.rate_cents, source: "matter" };
    const u = this.one("SELECT rate_cents FROM billing_user_rates WHERE user_id = ?", userId);
    if (u) return { rate_cents: u.rate_cents, source: "user" };
    return { rate_cents: this.settings().default_rate_cents, source: "firm" };
  }

  // ------------------------------------------------------------ time entries

  private checkTask(taskId: unknown, matterId: number): number | null {
    if (taskId == null) return null;
    const t = this.must("SELECT id, matter_id FROM tasks WHERE id = ?", "Task", int(taskId, "Task id", 1));
    if (t.matter_id != null && t.matter_id !== matterId) bad("That task belongs to a different matter");
    return t.id;
  }

  timeEntry(id: number): Row {
    return this.must("SELECT * FROM billing_time_entries WHERE id = ?", "Time entry", id);
  }

  private assertEditable(row: Row, what: string) {
    if (row.invoice_id != null) {
      const inv = this.one("SELECT status, number FROM billing_invoices WHERE id = ?", row.invoice_id);
      bad(
        inv?.status === "draft"
          ? `This ${what} is on a draft invoice; remove it from the draft first`
          : `This ${what} has been billed on invoice ${inv?.number} and is locked`,
        409,
      );
    }
  }

  addTime(input: TimeInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      this.user(input.userId);
      this.matter(input.matterId);
      const rate = input.rateCents != null ? int(input.rateCents, "Rate") : this.resolveRate(input.matterId, input.userId).rate_cents;
      const id = this.run(
        `INSERT INTO billing_time_entries (user_id, matter_id, date, minutes, description, billable, rate_cents, flat_cents, activity_code, task_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.userId,
        input.matterId,
        input.date != null ? date(input.date, "Date") : this.today(),
        int(input.minutes ?? 0, "Minutes", 0, 24 * 60),
        text(input.description, "Description"),
        input.billable === false ? 0 : 1,
        rate,
        input.flatCents == null ? null : int(input.flatCents, "Flat amount"),
        optText(input.activityCode, "Activity code"),
        this.checkTask(input.taskId, input.matterId),
        actor,
        this.nowFn().toISOString(),
      );
      return this.timeEntry(id);
    });
  }

  updateTime(id: number, patch: Partial<TimeInput>, _actor: number | null = null): Row {
    return tx(this.db, () => {
      const e = this.timeEntry(id);
      this.assertEditable(e, "time entry");
      const sets: string[] = [];
      const vals: any[] = [];
      const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
      if (patch.matterId !== undefined && patch.matterId !== e.matter_id) {
        this.matter(patch.matterId);
        set("matter_id", patch.matterId);
      }
      if (patch.userId !== undefined && patch.userId !== e.user_id) {
        this.user(patch.userId);
        set("user_id", patch.userId);
      }
      const matterId = patch.matterId ?? e.matter_id;
      if (patch.date !== undefined) set("date", date(patch.date, "Date"));
      if (patch.minutes !== undefined) set("minutes", int(patch.minutes, "Minutes", 0, 24 * 60));
      if (patch.description !== undefined) set("description", text(patch.description, "Description"));
      if (patch.billable !== undefined) set("billable", patch.billable ? 1 : 0);
      if (patch.rateCents !== undefined) {
        // null re-resolves the rate for the (possibly new) matter and user
        set("rate_cents", patch.rateCents == null ? this.resolveRate(matterId, patch.userId ?? e.user_id).rate_cents : int(patch.rateCents, "Rate"));
      }
      if (patch.flatCents !== undefined) set("flat_cents", patch.flatCents == null ? null : int(patch.flatCents, "Flat amount"));
      if (patch.activityCode !== undefined) set("activity_code", optText(patch.activityCode, "Activity code"));
      if (patch.taskId !== undefined) set("task_id", this.checkTask(patch.taskId, matterId));
      else if (patch.matterId !== undefined && e.task_id != null) this.checkTask(e.task_id, matterId);
      if (sets.length) this.run(`UPDATE billing_time_entries SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
      return this.timeEntry(id);
    });
  }

  deleteTime(id: number): void {
    tx(this.db, () => {
      const e = this.timeEntry(id);
      this.assertEditable(e, "time entry");
      this.run("DELETE FROM billing_time_entries WHERE id = ?", id);
    });
  }

  /**
   * Start (or resume) a timer. With entryId, resumes that entry; otherwise creates a new
   * entry from `input`. A person has at most one running timer: any other is stopped first.
   */
  startTimer(opts: { entryId?: number; input?: TimeInput }, actor: number | null = null): Row {
    return tx(this.db, () => {
      let e: Row;
      if (opts.entryId != null) {
        e = this.timeEntry(opts.entryId);
        this.assertEditable(e, "time entry");
        if (e.timer_started_at) return e;
      } else {
        if (!opts.input) bad("Say which entry to resume or give the new entry's details");
        e = this.addTime({ ...opts.input, minutes: opts.input.minutes ?? 0 }, actor);
      }
      for (const other of this.all("SELECT id FROM billing_time_entries WHERE user_id = ? AND timer_started_at IS NOT NULL AND id <> ?", e.user_id, e.id)) {
        this.stopTimer(other.id);
      }
      this.run("UPDATE billing_time_entries SET timer_started_at = ? WHERE id = ?", this.nowFn().toISOString(), e.id);
      return this.timeEntry(e.id);
    });
  }

  /** Stop a running timer, adding the elapsed time rounded UP to the whole minute. */
  stopTimer(entryId: number): Row {
    return tx(this.db, () => {
      const e = this.timeEntry(entryId);
      if (!e.timer_started_at) bad("That timer is not running", 409);
      const ms = Math.max(0, this.nowFn().getTime() - new Date(e.timer_started_at).getTime());
      const minutes = Math.min(24 * 60, e.minutes + Math.ceil(ms / 60_000));
      this.run("UPDATE billing_time_entries SET minutes = ?, timer_started_at = NULL WHERE id = ?", minutes, entryId);
      return this.timeEntry(entryId);
    });
  }

  runningTimers(userId?: number): Row[] {
    const sql = `SELECT t.*, m.name AS matter_name, m.number AS matter_number FROM billing_time_entries t
      JOIN matters m ON m.id = t.matter_id WHERE t.timer_started_at IS NOT NULL`;
    return userId != null ? this.all(sql + " AND t.user_id = ?", userId) : this.all(sql);
  }

  listTime(f: { matterId?: number; userId?: number; from?: ISODate; to?: ISODate; status?: "unbilled" | "billed" | "all" } = {}): Row[] {
    const where: string[] = [];
    const p: any[] = [];
    if (f.matterId != null) (where.push("t.matter_id = ?"), p.push(f.matterId));
    if (f.userId != null) (where.push("t.user_id = ?"), p.push(f.userId));
    if (f.from) (where.push("t.date >= ?"), p.push(date(f.from, "From")));
    if (f.to) (where.push("t.date <= ?"), p.push(date(f.to, "To")));
    if (f.status === "unbilled") where.push("(i.status IS NULL OR i.status = 'draft')");
    if (f.status === "billed") where.push("i.status = 'final'");
    return this.all(
      `SELECT t.*, u.name AS user_name, m.name AS matter_name, i.status AS invoice_status, i.number AS invoice_number
       FROM billing_time_entries t JOIN users u ON u.id = t.user_id JOIN matters m ON m.id = t.matter_id
       LEFT JOIN billing_invoices i ON i.id = t.invoice_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.date, t.id`,
      ...p,
    );
  }

  /** What an entry would bill for on its matter today (0 on flat/contingency matters). */
  entryValue(e: Row, method: BillingMethod, increment = this.settings().increment_minutes): number {
    if (method !== "hourly") return 0;
    if (e.flat_cents != null) return e.flat_cents;
    return timeAmount(e.rate_cents, billedMinutes(e.minutes, increment));
  }

  // ---------------------------------------------------------------- expenses

  expense(id: number): Row {
    return this.must("SELECT * FROM billing_expenses WHERE id = ?", "Expense", id);
  }

  addExpense(input: ExpenseInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      this.matter(input.matterId);
      if (input.userId != null) this.user(input.userId);
      const id = this.run(
        `INSERT INTO billing_expenses (matter_id, user_id, date, description, cost_cents, markup_bp, billable, expense_code, receipt_note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        input.matterId,
        input.userId ?? null,
        input.date != null ? date(input.date, "Date") : this.today(),
        text(input.description, "Description"),
        int(input.costCents, "Cost"),
        int(input.markupBp ?? 0, "Markup", 0, 100_000),
        input.billable === false ? 0 : 1,
        optText(input.expenseCode, "Expense code"),
        optText(input.receiptNote, "Receipt note"),
        actor,
        this.nowFn().toISOString(),
      );
      return this.expense(id);
    });
  }

  updateExpense(id: number, patch: Partial<ExpenseInput>): Row {
    return tx(this.db, () => {
      const e = this.expense(id);
      this.assertEditable(e, "expense");
      const sets: string[] = [];
      const vals: any[] = [];
      const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
      if (patch.matterId !== undefined) (this.matter(patch.matterId), set("matter_id", patch.matterId));
      if (patch.userId !== undefined) {
        if (patch.userId != null) this.user(patch.userId);
        set("user_id", patch.userId);
      }
      if (patch.date !== undefined) set("date", date(patch.date, "Date"));
      if (patch.description !== undefined) set("description", text(patch.description, "Description"));
      if (patch.costCents !== undefined) set("cost_cents", int(patch.costCents, "Cost"));
      if (patch.markupBp !== undefined) set("markup_bp", int(patch.markupBp ?? 0, "Markup", 0, 100_000));
      if (patch.billable !== undefined) set("billable", patch.billable ? 1 : 0);
      if (patch.expenseCode !== undefined) set("expense_code", optText(patch.expenseCode, "Expense code"));
      if (patch.receiptNote !== undefined) set("receipt_note", optText(patch.receiptNote, "Receipt note"));
      if (sets.length) this.run(`UPDATE billing_expenses SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
      return this.expense(id);
    });
  }

  deleteExpense(id: number): void {
    tx(this.db, () => {
      this.assertEditable(this.expense(id), "expense");
      this.run("DELETE FROM billing_expenses WHERE id = ?", id);
    });
  }

  listExpenses(f: { matterId?: number; from?: ISODate; to?: ISODate; status?: "unbilled" | "billed" | "all" } = {}): Row[] {
    const where: string[] = [];
    const p: any[] = [];
    if (f.matterId != null) (where.push("x.matter_id = ?"), p.push(f.matterId));
    if (f.from) (where.push("x.date >= ?"), p.push(date(f.from, "From")));
    if (f.to) (where.push("x.date <= ?"), p.push(date(f.to, "To")));
    if (f.status === "unbilled") where.push("(i.status IS NULL OR i.status = 'draft')");
    if (f.status === "billed") where.push("i.status = 'final'");
    return this.all(
      `SELECT x.*, m.name AS matter_name, i.status AS invoice_status, i.number AS invoice_number
       FROM billing_expenses x JOIN matters m ON m.id = x.matter_id LEFT JOIN billing_invoices i ON i.id = x.invoice_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY x.date, x.id`,
      ...p,
    ).map((x) => ({ ...x, amount_cents: expenseAmount(x.cost_cents, x.markup_bp) }));
  }

  // ---------------------------------------------------------------- invoices

  private invoiceRow(id: number): Row {
    return this.must("SELECT * FROM billing_invoices WHERE id = ?", "Invoice", id);
  }

  private draftRow(id: number): Row {
    const inv = this.invoiceRow(id);
    if (inv.status !== "draft") bad(`Invoice ${inv.number} is ${inv.status === "final" ? "finalized" : "void"} and cannot be edited`, 409);
    return inv;
  }

  private label(inv: Row): string {
    return inv.number != null ? `invoice ${inv.number}` : `draft invoice (id ${inv.id})`;
  }

  /** True when the matter's flat fee is on a draft or finalized (not void) invoice. */
  private flatFeeBilled(matterId: number): boolean {
    return !!this.one(
      `SELECT 1 FROM billing_invoice_lines l JOIN billing_invoices i ON i.id = l.invoice_id
       WHERE i.matter_id = ? AND l.matter_flat_fee = 1 AND i.status <> 'void'`,
      matterId,
    );
  }

  private nextPosition(invoiceId: number): number {
    return (this.one("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM billing_invoice_lines WHERE invoice_id = ?", invoiceId)!.p as number);
  }

  /**
   * Draft an invoice from the matter's unbilled billable time and expenses dated in
   * [from, to] (both optional, inclusive). Running timers are left out. On a flat-fee
   * matter the fee is added once (until that invoice is voided) and time is listed at no charge.
   */
  createDraft(input: { matterId: number; from?: ISODate | null; to?: ISODate | null }, actor: number | null = null): Row {
    return tx(this.db, () => {
      const m = this.matter(input.matterId);
      if (m.client_id == null) bad("This matter has no client to bill");
      const from = input.from ? date(input.from, "From") : null;
      const to = input.to ? date(input.to, "To") : null;
      if (from && to && from > to) bad("The start of the period is after its end");
      const s = this.settings();
      const mb = this.matterBilling(m.id);
      const invoiceId = this.run(
        "INSERT INTO billing_invoices (matter_id, client_id, status, period_from, period_to, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
        m.id,
        m.client_id,
        "draft",
        from,
        to,
        actor,
        this.nowFn().toISOString(),
      );
      let pos = 0;
      const addLine = (l: Row) =>
        this.run(
          `INSERT INTO billing_invoice_lines (invoice_id, kind, position, date, user_id, description, minutes, rate_cents, amount_cents, standard_cents,
             tax_bp, no_charge_note, matter_flat_fee, source_time_id, source_expense_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          invoiceId,
          l.kind,
          pos++,
          l.date ?? null,
          l.user_id ?? null,
          l.description ?? "",
          l.minutes ?? null,
          l.rate_cents ?? null,
          l.amount_cents,
          l.standard_cents ?? l.amount_cents,
          l.tax_bp ?? 0,
          l.no_charge_note ?? null,
          l.matter_flat_fee ? 1 : 0,
          l.source_time_id ?? null,
          l.source_expense_id ?? null,
        );

      if (mb.method === "flat" && !this.flatFeeBilled(m.id)) {
        addLine({ kind: "flat", description: `Flat fee: ${m.name}`, amount_cents: mb.flat_fee_cents ?? 0, tax_bp: s.tax_flat_bp, matter_flat_fee: 1, date: to });
      }

      const range = `${from ? " AND date >= ?" : ""}${to ? " AND date <= ?" : ""}`;
      const rp = [from, to].filter((x) => x != null);
      const times = this.all(
        `SELECT * FROM billing_time_entries WHERE matter_id = ? AND invoice_id IS NULL AND billable = 1 AND timer_started_at IS NULL${range} ORDER BY date, id`,
        m.id,
        ...rp,
      );
      for (const t of times) {
        const minutes = billedMinutes(t.minutes, s.increment_minutes);
        const amount = this.entryValue(t, mb.method, s.increment_minutes);
        addLine({
          kind: "time",
          date: t.date,
          user_id: t.user_id,
          description: t.description,
          minutes,
          rate_cents: t.flat_cents != null || mb.method !== "hourly" ? null : t.rate_cents,
          amount_cents: amount,
          tax_bp: s.tax_time_bp,
          no_charge_note: NO_CHARGE[mb.method] ?? null,
          source_time_id: t.id,
        });
        this.run("UPDATE billing_time_entries SET invoice_id = ? WHERE id = ?", invoiceId, t.id);
      }
      const exps = this.all(
        `SELECT * FROM billing_expenses WHERE matter_id = ? AND invoice_id IS NULL AND billable = 1${range} ORDER BY date, id`,
        m.id,
        ...rp,
      );
      for (const x of exps) {
        addLine({
          kind: "expense",
          date: x.date,
          user_id: x.user_id,
          description: x.description,
          amount_cents: expenseAmount(x.cost_cents, x.markup_bp),
          tax_bp: s.tax_expense_bp,
          source_expense_id: x.id,
        });
        this.run("UPDATE billing_expenses SET invoice_id = ? WHERE id = ?", invoiceId, x.id);
      }
      this.log("invoice_drafted", `Drafted an invoice with ${pos} line(s)`, actor, m.id);
      return this.invoice(invoiceId);
    });
  }

  /** Totals computed from the lines. See money.ts for rounding. Tax is per line, on the line's
   * net amount (after write-down) and before any invoice-level discount. */
  computeTotals(invoiceId: number): Totals {
    const inv = this.invoiceRow(invoiceId);
    const lines = this.all("SELECT amount_cents, writedown_cents, tax_bp FROM billing_invoice_lines WHERE invoice_id = ?", invoiceId);
    let subtotal = 0;
    let tax = 0;
    for (const l of lines) {
      const net = l.amount_cents - l.writedown_cents;
      subtotal += net;
      tax += applyBp(net, l.tax_bp);
    }
    let discount = 0;
    if (inv.discount_kind === "percent") discount = applyBp(subtotal, inv.discount_value);
    if (inv.discount_kind === "fixed") discount = Math.min(inv.discount_value, subtotal);
    return { subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: subtotal - discount + tax };
  }

  totals(invoiceId: number): Totals {
    const inv = this.invoiceRow(invoiceId);
    if (inv.status === "draft") return this.computeTotals(invoiceId);
    return { subtotal_cents: inv.subtotal_cents, discount_cents: inv.discount_cents, tax_cents: inv.tax_cents, total_cents: inv.total_cents };
  }

  /** Sum applied to the invoice as of a date (allocations not released by then). */
  paidCents(invoiceId: number, asOf?: ISODate): number {
    if (asOf == null) {
      return this.one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM billing_allocations WHERE invoice_id = ? AND released_on IS NULL", invoiceId)!.s;
    }
    return this.one(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM billing_allocations WHERE invoice_id = ? AND applied_on <= ? AND (released_on IS NULL OR released_on > ?)",
      invoiceId,
      asOf,
      asOf,
    )!.s;
  }

  writtenOffCents(invoiceId: number, asOf?: ISODate): number {
    return this.one(
      `SELECT COALESCE(SUM(amount_cents),0) AS s FROM billing_writeoffs WHERE invoice_id = ?${asOf ? " AND written_on <= ?" : ""}`,
      invoiceId,
      ...(asOf ? [asOf] : []),
    )!.s;
  }

  /** Amount still owed. 0 for drafts and for invoices void as of the date. */
  balance(invoiceId: number, asOf?: ISODate): number {
    const inv = this.invoiceRow(invoiceId);
    if (inv.status === "draft") return 0;
    if (asOf != null && inv.issued_on > asOf) return 0;
    if (inv.status === "void" && (asOf == null || inv.voided_on <= asOf)) return 0;
    return inv.total_cents - this.paidCents(invoiceId, asOf) - this.writtenOffCents(invoiceId, asOf);
  }

  invoice(id: number): Row {
    const inv = this.invoiceRow(id);
    const lines = this.all(
      `SELECT l.*, u.name AS user_name FROM billing_invoice_lines l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.invoice_id = ? ORDER BY l.position, l.id`,
      id,
    ).map((l) => ({ ...l, net_cents: l.amount_cents - l.writedown_cents, tax_cents: applyBp(l.amount_cents - l.writedown_cents, l.tax_bp) }));
    const totals = this.totals(id);
    const paid = inv.status === "draft" ? 0 : this.paidCents(id);
    const writtenOff = this.writtenOffCents(id);
    return {
      ...inv,
      matter: this.one("SELECT id, number, name FROM matters WHERE id = ?", inv.matter_id),
      client: this.one("SELECT id, name, email, phone FROM contacts WHERE id = ?", inv.client_id),
      lines,
      totals,
      payments: this.all(
        `SELECT a.*, p.received_on, p.method, p.reference FROM billing_allocations a JOIN billing_payments p ON p.id = a.payment_id
         WHERE a.invoice_id = ? ORDER BY a.applied_on, a.id`,
        id,
      ),
      writeoffs: this.all("SELECT * FROM billing_writeoffs WHERE invoice_id = ? ORDER BY written_on, id", id),
      paid_cents: paid,
      written_off_cents: writtenOff,
      balance_cents: this.balance(id),
    };
  }

  listInvoices(f: { matterId?: number; clientId?: number; status?: string } = {}): Row[] {
    const where: string[] = [];
    const p: any[] = [];
    if (f.matterId != null) (where.push("i.matter_id = ?"), p.push(f.matterId));
    if (f.clientId != null) (where.push("i.client_id = ?"), p.push(f.clientId));
    if (f.status) (where.push("i.status = ?"), p.push(f.status));
    return this.all(
      `SELECT i.*, m.name AS matter_name, c.name AS client_name FROM billing_invoices i
       JOIN matters m ON m.id = i.matter_id JOIN contacts c ON c.id = i.client_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.number IS NULL, i.number, i.id`,
      ...p,
    ).map((i) => ({ ...i, ...(i.status === "draft" ? this.computeTotals(i.id) : {}), balance_cents: this.balance(i.id) }));
  }

  updateDraft(
    id: number,
    patch: { discountKind?: "none" | "percent" | "fixed"; discountValue?: number; notes?: string | null; issuedOn?: ISODate | null; dueOn?: ISODate | null },
    actor: number | null = null,
  ): Row {
    return tx(this.db, () => {
      const inv = this.draftRow(id);
      const kind = patch.discountKind ?? inv.discount_kind;
      if (!["none", "percent", "fixed"].includes(kind)) bad("Discount must be none, percent or fixed");
      let value = patch.discountValue !== undefined ? int(patch.discountValue, "Discount") : patch.discountKind !== undefined ? 0 : inv.discount_value;
      if (kind === "percent" && value > 10000) bad("A percent discount is in basis points and cannot exceed 10000 (100%)");
      if (kind === "none") value = 0;
      const issued = patch.issuedOn !== undefined ? (patch.issuedOn == null ? null : date(patch.issuedOn, "Invoice date")) : inv.issued_on;
      const due = patch.dueOn !== undefined ? (patch.dueOn == null ? null : date(patch.dueOn, "Due date")) : inv.due_on;
      if (issued && due && due < issued) bad("The due date is before the invoice date");
      this.run(
        "UPDATE billing_invoices SET discount_kind = ?, discount_value = ?, notes = ?, issued_on = ?, due_on = ? WHERE id = ?",
        kind,
        value,
        patch.notes !== undefined ? optText(patch.notes, "Notes") : inv.notes,
        issued,
        due,
        id,
      );
      if (kind !== inv.discount_kind || value !== inv.discount_value) {
        const d = kind === "none" ? "removed the discount" : kind === "percent" ? `discount ${value / 100}%` : `discount ${formatCents(value)}`;
        this.log("invoice_discount", `Draft invoice (id ${id}): ${d}`, actor, inv.matter_id);
      }
      return this.invoice(id);
    });
  }

  /** Delete a draft. Its time and expenses go back to unbilled. Finalized invoices are voided, never deleted. */
  deleteDraft(id: number, actor: number | null = null): void {
    tx(this.db, () => {
      const inv = this.draftRow(id);
      this.run("UPDATE billing_time_entries SET invoice_id = NULL WHERE invoice_id = ?", id);
      this.run("UPDATE billing_expenses SET invoice_id = NULL WHERE invoice_id = ?", id);
      this.run("DELETE FROM billing_invoice_lines WHERE invoice_id = ?", id);
      this.run("DELETE FROM billing_invoices WHERE id = ?", id);
      this.log("invoice_draft_deleted", `Deleted a draft invoice (id ${id})`, actor, inv.matter_id);
    });
  }

  private lineRow(invoiceId: number, lineId: number): Row {
    return this.must("SELECT * FROM billing_invoice_lines WHERE id = ? AND invoice_id = ?", "Invoice line", lineId, invoiceId);
  }

  /** Add a line by hand (time at a rate, an expense, or a flat-fee item). */
  addLine(invoiceId: number, input: LineInput): Row {
    return tx(this.db, () => {
      this.draftRow(invoiceId);
      const s = this.settings();
      if (!["time", "expense", "flat"].includes(input.kind)) bad("Line kind must be time, expense or flat");
      if (input.userId != null) this.user(input.userId);
      let minutes: number | null = null;
      let rate: number | null = null;
      let amount: number;
      if (input.kind === "time" && input.amountCents == null) {
        minutes = billedMinutes(int(input.minutes ?? 0, "Minutes", 0, 24 * 60), s.increment_minutes);
        rate = int(input.rateCents ?? 0, "Rate");
        amount = timeAmount(rate, minutes);
      } else {
        amount = int(input.amountCents, "Amount");
        if (input.kind === "time" && input.minutes != null) minutes = billedMinutes(int(input.minutes, "Minutes", 0, 24 * 60), s.increment_minutes);
      }
      const defaultTax = input.kind === "time" ? s.tax_time_bp : input.kind === "expense" ? s.tax_expense_bp : s.tax_flat_bp;
      const id = this.run(
        `INSERT INTO billing_invoice_lines (invoice_id, kind, position, date, user_id, description, minutes, rate_cents, amount_cents, standard_cents, tax_bp)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        invoiceId,
        input.kind,
        this.nextPosition(invoiceId),
        input.date != null ? date(input.date, "Date") : null,
        input.userId ?? null,
        text(input.description, "Description"),
        minutes,
        rate,
        amount,
        amount,
        input.taxBp != null ? int(input.taxBp, "Tax rate", 0, 10000) : defaultTax,
      );
      return this.lineRow(invoiceId, id);
    });
  }

  /** Edit a draft line. Changing minutes or rate on a time line re-prices it unless amountCents is given. */
  updateLine(invoiceId: number, lineId: number, patch: Partial<LineInput>): Row {
    return tx(this.db, () => {
      this.draftRow(invoiceId);
      const l = this.lineRow(invoiceId, lineId);
      const s = this.settings();
      let minutes = l.minutes;
      let rate = l.rate_cents;
      let amount = l.amount_cents;
      if (patch.minutes !== undefined) minutes = billedMinutes(int(patch.minutes, "Minutes", 0, 24 * 60), s.increment_minutes);
      if (patch.rateCents !== undefined) rate = int(patch.rateCents, "Rate");
      if (patch.amountCents !== undefined) amount = int(patch.amountCents, "Amount");
      else if (l.kind === "time" && l.no_charge_note == null && rate != null && (patch.minutes !== undefined || patch.rateCents !== undefined)) {
        amount = timeAmount(rate, minutes ?? 0);
      }
      if (l.writedown_cents > amount) bad("The line's write-down is larger than its new amount; reduce the write-down first");
      this.run(
        "UPDATE billing_invoice_lines SET description = ?, date = ?, minutes = ?, rate_cents = ?, amount_cents = ?, tax_bp = ? WHERE id = ?",
        patch.description !== undefined ? text(patch.description, "Description") : l.description,
        patch.date !== undefined ? (patch.date == null ? null : date(patch.date, "Date")) : l.date,
        minutes,
        rate,
        amount,
        patch.taxBp !== undefined ? int(patch.taxBp, "Tax rate", 0, 10000) : l.tax_bp,
        lineId,
      );
      return this.lineRow(invoiceId, lineId);
    });
  }

  /** Remove a line from a draft; its time entry or expense goes back to unbilled. */
  removeLine(invoiceId: number, lineId: number): void {
    tx(this.db, () => {
      this.draftRow(invoiceId);
      const l = this.lineRow(invoiceId, lineId);
      if (l.source_time_id) this.run("UPDATE billing_time_entries SET invoice_id = NULL WHERE id = ?", l.source_time_id);
      if (l.source_expense_id) this.run("UPDATE billing_expenses SET invoice_id = NULL WHERE id = ?", l.source_expense_id);
      this.run("DELETE FROM billing_invoice_lines WHERE id = ?", lineId);
    });
  }

  /**
   * Write a draft line down by `amountCents` (replacing any earlier write-down), or write
   * it off entirely with `all: true`. A reason is required. 0 clears the write-down.
   */
  writeDownLine(invoiceId: number, lineId: number, input: { amountCents?: number; all?: boolean; reason?: string }, actor: number | null = null): Row {
    return tx(this.db, () => {
      const inv = this.draftRow(invoiceId);
      const l = this.lineRow(invoiceId, lineId);
      const amount = input.all ? l.amount_cents : int(input.amountCents, "Write-down", 0, l.amount_cents);
      const reason = text(input.reason, "Reason", 1000);
      if (amount > 0 && !reason) bad("Give a reason for the write-down");
      this.run("UPDATE billing_invoice_lines SET writedown_cents = ?, writedown_reason = ? WHERE id = ?", amount, amount ? reason : null, lineId);
      const what = amount === 0 ? "Cleared write-down on" : amount === l.amount_cents ? "Wrote off" : `Wrote down ${formatCents(amount)} on`;
      this.log(
        amount === l.amount_cents && amount > 0 ? "line_written_off" : "line_written_down",
        `${what} line "${l.description}" of ${this.label(inv)}${amount ? `: ${reason}` : ""}`,
        actor,
        inv.matter_id,
      );
      return this.lineRow(invoiceId, lineId);
    });
  }

  /** Lock the draft, give it the next invoice number, set its dates and freeze its totals. */
  finalize(id: number, actor: number | null = null): Row {
    return tx(this.db, () => {
      const inv = this.draftRow(id);
      const lines = this.one("SELECT COUNT(*) AS n FROM billing_invoice_lines WHERE invoice_id = ?", id)!.n;
      if (lines === 0) bad("An invoice needs at least one line", 409);
      const s = this.settings();
      const max = this.one("SELECT MAX(number) AS n FROM billing_invoices")!.n as number | null;
      const number = max == null ? s.first_invoice_number : max + 1;
      const issued = inv.issued_on ?? this.today();
      const due = inv.due_on ?? addDays(issued, s.payment_terms_days);
      if (due < issued) bad("The due date is before the invoice date");
      const t = this.computeTotals(id);
      if (t.total_cents < 0) bad("The invoice total is negative");
      this.run(
        `UPDATE billing_invoices SET number = ?, issued_on = ?, due_on = ?, subtotal_cents = ?, discount_cents = ?, tax_cents = ?, total_cents = ?,
           finalized_by = ?, finalized_at = ? WHERE id = ?`,
        number,
        issued,
        due,
        t.subtotal_cents,
        t.discount_cents,
        t.tax_cents,
        t.total_cents,
        actor,
        this.nowFn().toISOString(),
        id,
      );
      this.run("UPDATE billing_invoices SET status = 'final' WHERE id = ?", id);
      this.log("invoice_finalized", `Finalized invoice ${number} for ${formatCents(t.total_cents)}, due ${due}`, actor, inv.matter_id);
      return this.invoice(id);
    });
  }

  /**
   * Void a finalized invoice. It keeps its number (no gaps) and stays on record. Its time
   * and expenses return to unbilled; payments applied to it become client credit.
   */
  void(id: number, reason: string, actor: number | null = null): Row {
    return tx(this.db, () => {
      const inv = this.invoiceRow(id);
      if (inv.status === "draft") bad("A draft is not voided; delete it instead", 409);
      if (inv.status === "void") bad(`Invoice ${inv.number} is already void`, 409);
      const why = text(reason, "Reason", 1000);
      if (!why) bad("Give a reason for voiding the invoice");
      const on = this.today();
      if (on < inv.issued_on) bad("An invoice cannot be voided before its invoice date", 409);
      const released = this.paidCents(id);
      this.run("UPDATE billing_allocations SET released_on = ? WHERE invoice_id = ? AND released_on IS NULL", on, id);
      this.run("UPDATE billing_time_entries SET invoice_id = NULL WHERE invoice_id = ?", id);
      this.run("UPDATE billing_expenses SET invoice_id = NULL WHERE invoice_id = ?", id);
      this.run("UPDATE billing_invoices SET status = 'void', voided_on = ?, voided_by = ?, void_reason = ? WHERE id = ?", on, actor, why, id);
      this.log(
        "invoice_voided",
        `Voided invoice ${inv.number} (${formatCents(inv.total_cents)}): ${why}${released ? `; ${formatCents(released)} in payments moved to client credit` : ""}`,
        actor,
        inv.matter_id,
      );
      return this.invoice(id);
    });
  }

  // ---------------------------------------------------------------- payments

  payment(id: number): Row {
    const p = this.must("SELECT * FROM billing_payments WHERE id = ?", "Payment", id);
    const allocations = this.all("SELECT * FROM billing_allocations WHERE payment_id = ? ORDER BY id", id);
    const applied = allocations.filter((a) => a.released_on == null).reduce((s, a) => s + a.amount_cents, 0);
    return { ...p, allocations, unapplied_cents: p.voided_on ? 0 : p.amount_cents - applied };
  }

  private allocate(paymentId: number, invoiceId: number, clientId: number, amount: number, on: ISODate) {
    const inv = this.invoiceRow(invoiceId);
    if (inv.status !== "final") bad(`Payments can only be applied to finalized invoices; ${this.label(inv)} is ${inv.status}`, 409);
    if (inv.client_id !== clientId) bad(`Invoice ${inv.number} belongs to a different client`);
    const bal = this.balance(invoiceId);
    if (amount > bal) bad(`${formatCents(amount)} is more than the ${formatCents(bal)} owed on invoice ${inv.number}`);
    this.run("INSERT INTO billing_allocations (payment_id, invoice_id, amount_cents, applied_on) VALUES (?,?,?,?)", paymentId, invoiceId, amount, on);
    return inv;
  }

  /**
   * Record money received from a client and apply it to invoices. Anything not applied
   * stays as the client's credit, to apply to a later invoice with applyCredit.
   * (Whether a credit should instead be refunded or held elsewhere is the firm's call;
   * this module only tracks it.)
   */
  recordPayment(input: PaymentInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const client = this.must("SELECT * FROM contacts WHERE id = ?", "Client", int(input.clientId, "Client id", 1));
      if (input.matterId != null) {
        const m = this.matter(input.matterId);
        if (m.client_id !== client.id) bad("That matter belongs to a different client");
      }
      const amount = int(input.amountCents, "Payment amount", 1);
      const on = input.receivedOn != null ? date(input.receivedOn, "Date received") : this.today();
      const allocs = input.allocations ?? [];
      const total = allocs.reduce((s, a) => s + int(a.amountCents, "Amount applied", 1), 0);
      if (total > amount) bad("More is applied to invoices than was received");
      const pid = this.run(
        `INSERT INTO billing_payments (client_id, matter_id, received_on, amount_cents, method, reference, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        client.id,
        input.matterId ?? null,
        on,
        amount,
        optText(input.method, "Method"),
        optText(input.reference, "Reference"),
        optText(input.note, "Note"),
        actor,
        this.nowFn().toISOString(),
      );
      const parts: string[] = [];
      let matterId: number | null = input.matterId ?? null;
      for (const a of allocs) {
        const inv = this.allocate(pid, int(a.invoiceId, "Invoice id", 1), client.id, a.amountCents, on);
        matterId ??= inv.matter_id;
        parts.push(`${formatCents(a.amountCents)} to invoice ${inv.number}`);
        if (inv.matter_id !== matterId) this.log("payment_applied", `Applied ${formatCents(a.amountCents)} of payment ${pid} to invoice ${inv.number}`, actor, inv.matter_id);
      }
      const credit = amount - total;
      if (credit) parts.push(`${formatCents(credit)} held as client credit`);
      this.log("payment_received", `Received ${formatCents(amount)} from ${client.name} on ${on}${parts.length ? ": " + parts.join(", ") : ""}`, actor, matterId);
      return this.payment(pid);
    });
  }

  /** Pay one invoice. Anything over its balance becomes client credit. */
  payInvoice(invoiceId: number, input: Omit<PaymentInput, "clientId" | "matterId" | "allocations">, actor: number | null = null): Row {
    return tx(this.db, () => {
      const inv = this.invoiceRow(invoiceId);
      if (inv.status !== "final") bad(`Payments can only be applied to finalized invoices; ${this.label(inv)} is ${inv.status}`, 409);
      const amount = int(input.amountCents, "Payment amount", 1);
      const applied = Math.min(amount, this.balance(invoiceId));
      return this.recordPayment(
        { ...input, clientId: inv.client_id, matterId: inv.matter_id, allocations: applied > 0 ? [{ invoiceId, amountCents: applied }] : [] },
        actor,
      );
    });
  }

  /** Unapplied credit, from payments not voided (as of a date when given). */
  clientCredit(clientId: number, asOf?: ISODate): number {
    if (asOf == null) {
      return this.one(
        `SELECT COALESCE(SUM(p.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM billing_allocations a WHERE a.payment_id = p.id AND a.released_on IS NULL),0)),0) AS s
         FROM billing_payments p WHERE p.client_id = ? AND p.voided_on IS NULL`,
        clientId,
      )!.s;
    }
    return this.one(
      `SELECT COALESCE(SUM(p.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM billing_allocations a WHERE a.payment_id = p.id
           AND a.applied_on <= ?1 AND (a.released_on IS NULL OR a.released_on > ?1)),0)),0) AS s
       FROM billing_payments p WHERE p.client_id = ?2 AND p.received_on <= ?1 AND (p.voided_on IS NULL OR p.voided_on > ?1)`,
      asOf,
      clientId,
    )!.s;
  }

  /** Apply the client's credit (oldest payments first) to an invoice. Defaults to as much as possible. */
  applyCredit(invoiceId: number, amountCents: number | null = null, actor: number | null = null): Row {
    return tx(this.db, () => {
      const inv = this.invoiceRow(invoiceId);
      if (inv.status !== "final") bad(`Credit can only be applied to finalized invoices; ${this.label(inv)} is ${inv.status}`, 409);
      const credit = this.clientCredit(inv.client_id);
      const bal = this.balance(invoiceId);
      const want = amountCents == null ? Math.min(credit, bal) : int(amountCents, "Amount", 1);
      if (want > credit) bad(`The client has only ${formatCents(credit)} of credit`, 409);
      if (want > bal) bad(`${formatCents(want)} is more than the ${formatCents(bal)} owed`, 409);
      if (want === 0) bad("There is no credit to apply, or nothing is owed", 409);
      const on = this.today();
      let left = want;
      for (const p of this.all("SELECT id FROM billing_payments WHERE client_id = ? AND voided_on IS NULL ORDER BY received_on, id", inv.client_id)) {
        if (left === 0) break;
        const free = this.payment(p.id).unapplied_cents;
        const take = Math.min(free, left);
        if (take > 0) {
          this.allocate(p.id, invoiceId, inv.client_id, take, on);
          left -= take;
        }
      }
      this.log("credit_applied", `Applied ${formatCents(want)} of client credit to invoice ${inv.number}`, actor, inv.matter_id);
      return this.invoice(invoiceId);
    });
  }

  /** Void a payment (e.g. a returned check). Whatever it paid is owed again. */
  voidPayment(paymentId: number, reason: string, actor: number | null = null): Row {
    return tx(this.db, () => {
      const p = this.payment(paymentId);
      if (p.voided_on) bad("That payment is already void", 409);
      const why = text(reason, "Reason", 1000);
      if (!why) bad("Give a reason for voiding the payment");
      const on = this.today();
      const touched = this.all(
        "SELECT DISTINCT i.matter_id, i.number FROM billing_allocations a JOIN billing_invoices i ON i.id = a.invoice_id WHERE a.payment_id = ? AND a.released_on IS NULL",
        paymentId,
      );
      this.run("UPDATE billing_allocations SET released_on = ? WHERE payment_id = ? AND released_on IS NULL", on, paymentId);
      this.run("UPDATE billing_payments SET voided_on = ?, voided_by = ?, void_reason = ? WHERE id = ?", on, actor, why, paymentId);
      const matters = new Set<number | null>(touched.map((t) => t.matter_id));
      if (matters.size === 0) matters.add(p.matter_id);
      for (const m of matters) {
        this.log("payment_voided", `Voided payment ${paymentId} of ${formatCents(p.amount_cents)} received ${p.received_on}: ${why}`, actor, m);
      }
      return this.payment(paymentId);
    });
  }

  /** Write off some or all of a finalized invoice's balance, with a reason. */
  writeOffBalance(invoiceId: number, input: { amountCents?: number | null; reason?: string }, actor: number | null = null): Row {
    return tx(this.db, () => {
      const inv = this.invoiceRow(invoiceId);
      if (inv.status !== "final") bad(`Only a finalized invoice's balance can be written off; ${this.label(inv)} is ${inv.status}`, 409);
      const bal = this.balance(invoiceId);
      const amount = input.amountCents == null ? bal : int(input.amountCents, "Write-off", 1);
      if (amount <= 0) bad("Nothing is owed on this invoice", 409);
      if (amount > bal) bad(`${formatCents(amount)} is more than the ${formatCents(bal)} owed`, 409);
      const why = text(input.reason, "Reason", 1000);
      if (!why) bad("Give a reason for the write-off");
      this.run(
        "INSERT INTO billing_writeoffs (invoice_id, amount_cents, reason, written_on, created_by) VALUES (?,?,?,?,?)",
        invoiceId,
        amount,
        why,
        this.today(),
        actor,
      );
      this.log("invoice_written_off", `Wrote off ${formatCents(amount)} of invoice ${inv.number}: ${why}`, actor, inv.matter_id);
      return this.invoice(invoiceId);
    });
  }

  listPayments(f: { clientId?: number } = {}): Row[] {
    const rows =
      f.clientId != null
        ? this.all("SELECT id FROM billing_payments WHERE client_id = ? ORDER BY received_on, id", f.clientId)
        : this.all("SELECT id FROM billing_payments ORDER BY received_on, id");
    return rows.map((r) => this.payment(r.id));
  }

  // ---------------------------------------------------------- client views

  /**
   * Statement of account: every invoice, void, payment, payment reversal and write-off
   * for the client in date order with a running balance. Positive = the client owes the
   * firm; negative = the firm holds a credit for the client. The closing balance always
   * equals (sum of open invoice balances) - (unapplied credit) as of `to`.
   */
  statement(clientId: number, from?: ISODate | null, to?: ISODate | null): Row {
    const client = this.must("SELECT id, name, email, phone FROM contacts WHERE id = ?", "Client", clientId);
    const end = to ? date(to, "To") : this.today();
    const start = from ? date(from, "From") : null;
    type Ev = { date: ISODate; order: number; type: string; description: string; amount_cents: number; invoice_id?: number; payment_id?: number };
    const ev: Ev[] = [];
    for (const i of this.all("SELECT i.*, m.name AS matter_name FROM billing_invoices i JOIN matters m ON m.id = i.matter_id WHERE i.client_id = ? AND i.status <> 'draft'", clientId)) {
      ev.push({ date: i.issued_on, order: 0, type: "invoice", description: `Invoice ${i.number} (${i.matter_name})`, amount_cents: i.total_cents, invoice_id: i.id });
      if (i.status === "void") ev.push({ date: i.voided_on, order: 3, type: "invoice_void", description: `Invoice ${i.number} voided: ${i.void_reason}`, amount_cents: -i.total_cents, invoice_id: i.id });
    }
    for (const p of this.all("SELECT * FROM billing_payments WHERE client_id = ?", clientId)) {
      const ref = [p.method, p.reference].filter(Boolean).join(" ");
      ev.push({ date: p.received_on, order: 1, type: "payment", description: `Payment received${ref ? ` (${ref})` : ""}`, amount_cents: -p.amount_cents, payment_id: p.id });
      if (p.voided_on) ev.push({ date: p.voided_on, order: 4, type: "payment_void", description: `Payment of ${p.received_on} reversed: ${p.void_reason}`, amount_cents: p.amount_cents, payment_id: p.id });
    }
    for (const w of this.all(
      "SELECT w.*, i.number, i.status, i.voided_on FROM billing_writeoffs w JOIN billing_invoices i ON i.id = w.invoice_id WHERE i.client_id = ?",
      clientId,
    )) {
      ev.push({ date: w.written_on, order: 2, type: "write_off", description: `Write-off on invoice ${w.number}: ${w.reason}`, amount_cents: -w.amount_cents, invoice_id: w.invoice_id });
      // Voiding an invoice reverses its whole total, so reverse its write-offs too.
      if (w.status === "void") ev.push({ date: w.voided_on, order: 3, type: "write_off_reversed", description: `Write-off on voided invoice ${w.number} reversed`, amount_cents: w.amount_cents, invoice_id: w.invoice_id });
    }
    ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    let opening = 0;
    let running = 0;
    const lines: Row[] = [];
    for (const e of ev) {
      if (e.date > end) continue;
      if (start && e.date < start) {
        opening += e.amount_cents;
        continue;
      }
      if (lines.length === 0) running = opening;
      running += e.amount_cents;
      lines.push({ ...e, balance_cents: running });
    }
    const closing = lines.length ? running : opening;
    const open = this.all("SELECT id, number, issued_on, due_on, total_cents, matter_id FROM billing_invoices WHERE client_id = ? AND status <> 'draft' ORDER BY number", clientId)
      .map((i) => ({ ...i, balance_cents: this.balance(i.id, end) }))
      .filter((i) => i.balance_cents !== 0);
    return {
      client,
      from: start,
      to: end,
      opening_balance_cents: opening,
      lines,
      closing_balance_cents: closing,
      open_invoices: open,
      credit_cents: this.clientCredit(clientId, end),
    };
  }
}

/** Aging bucket for an invoice `daysPastDue` days past its due date (0 or less = not yet due). */
export function agingBucket(daysPastDue: number): "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus" {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

