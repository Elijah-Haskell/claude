// Client trust accounting: accounts, client ledgers, the append-only journal, holds on
// disputed funds, clearing status, and the monthly three-way reconciliation.
//
// Rules enforced here (citations and quoted text in rules.ts and docs/trust.md):
//   * A client ledger can never go below zero, at any point in its history. No override.
//     (The database repeats the check; see trust_lines_not_negative in schema.ts.)
//   * The firm's own money sits only on the account's "firm funds for bank charges" ledger,
//     up to a limit the lawyer sets (KRPC 1.15(d)(1)(i)). Bank charges come only from it.
//   * Earned fees leave trust only against a finalized invoice of the same client, for no
//     more than its balance, and the transfer records a payment on that invoice
//     (KRPC 1.15(d)(1)(ii)). Disputed amounts can be held and then cannot be paid out.
//   * Interest is refused on IOLTA accounts (KRPC 1.15(d)(3)(iii)(aa): the bank remits it
//     to the Kansas Bar Foundation).
//   * Posted entries are permanent; a mistake is fixed by a reversing entry with a reason.
//   * Nothing may be dated inside a month whose reconciliation is signed.
//   * Money that has not cleared can't be paid out when the account requires cleared funds
//     (firm policy, on by default; not a verified rule: docs/trust.md gap G2).

import { type DB, tx } from "../db.ts";
import { type Engine, EngineError } from "../engine.ts";
import { type ISODate, isISODate } from "../dates.ts";
import { Billing } from "../billing/billing.ts";
import { formatCents } from "../billing/money.ts";
import { RETENTION_YEARS } from "./rules.ts";

export type Row = Record<string, any>;
export type TxnKind =
  | "deposit"
  | "disbursement"
  | "fee_transfer"
  | "ledger_transfer"
  | "firm_deposit"
  | "firm_withdrawal"
  | "bank_fee"
  | "interest"
  | "reversal";

export const KIND_LABELS: Record<TxnKind, string> = {
  deposit: "Deposit",
  disbursement: "Payment out",
  fee_transfer: "Earned fee to operating",
  ledger_transfer: "Transfer between clients",
  firm_deposit: "Firm funds for bank charges",
  firm_withdrawal: "Firm funds withdrawn",
  bank_fee: "Bank charge",
  interest: "Interest",
  reversal: "Reversal",
};

/** Kinds whose money has to clear at the bank before it can be paid out. */
const NEEDS_CLEARING = new Set(["deposit", "firm_deposit"]);

function bad(message: string, status = 400): never {
  throw new EngineError(message, status);
}

function cents(v: unknown, what = "Amount"): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) bad(`${what} must be a whole number of cents greater than zero`);
  return v;
}

function id(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) bad(`${what} is required`);
  return v;
}

function text(v: unknown, what: string, max = 500): string {
  if (v == null) return "";
  if (typeof v !== "string") bad(`${what} must be text`);
  if (v.length > max) bad(`${what} is too long`);
  return v.trim();
}

function required(v: unknown, what: string, max = 500): string {
  const s = text(v, what, max);
  if (!s) bad(`${what} is required`);
  return s;
}

function optText(v: unknown, what: string, max = 500): string | null {
  return text(v, what, max) || null;
}

function date(v: unknown, what: string): ISODate {
  if (!isISODate(v)) bad(`${what} must be a date like 2026-01-31`);
  return v;
}

export function monthEnd(period: string): ISODate {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) bad("Month must look like 2026-10");
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}` as ISODate;
}

export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function addYears(d: ISODate, n: number): ISODate {
  const [y, m, day] = d.split("-").map(Number);
  // 29 Feb + 5 years -> 1 Mar (keeps the record at least as long as required)
  const out = new Date(Date.UTC(y + n, m - 1, day));
  return out.toISOString().slice(0, 10) as ISODate;
}

export interface AccountInput {
  name: string;
  bankName: string;
  accountLast4?: string | null;
  kind: "iolta" | "non_iolta";
  inKansas: boolean;
  requireCleared?: boolean;
  firmFundsLimitCents?: number | null;
  clientName?: string | null;
  openedOn?: ISODate;
  notes?: string | null;
}

export interface EntryInput {
  date?: ISODate;
  amountCents: number;
  party?: string | null;
  method?: string | null;
  checkNumber?: string | null;
  reference?: string | null;
  memo?: string | null;
  clearedOn?: ISODate | null;
}

export interface ReconInput {
  period: string;
  statementBalanceCents: number;
  notes?: string | null;
}

export class Trust {
  db: DB;
  engine: Engine;
  private todayFn: () => ISODate;
  private nowFn: () => Date;

  constructor(db: DB, engine: Engine, opts: { today?: () => ISODate; now?: () => Date } = {}) {
    this.db = db;
    this.engine = engine;
    this.todayFn = opts.today ?? (() => engine.today());
    this.nowFn = opts.now ?? (() => new Date());
  }

  today(): ISODate {
    return this.todayFn();
  }

  private stamp(): string {
    return this.nowFn().toISOString();
  }

  one(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }

  all(sql: string, ...p: any[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }

  private run(sql: string, ...p: any[]): number {
    return Number(this.db.prepare(sql).run(...p).lastInsertRowid);
  }

  private must(sql: string, what: string, ...p: any[]): Row {
    const r = this.one(sql, ...p);
    if (!r) bad(`${what} not found`, 404);
    return r;
  }

  private billing(): Billing {
    return new Billing(this.db, { today: this.todayFn, now: this.nowFn });
  }

  private log(kind: string, detail: string, userId: number | null, matterId: number | null = null) {
    this.engine.log(kind, detail, { userId, matterId });
  }

  // ------------------------------------------------------------- accounts

  createAccount(input: AccountInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const name = required(input.name, "Account name", 200);
      const bank = required(input.bankName, "Bank name", 200);
      if (input.kind !== "iolta" && input.kind !== "non_iolta") bad("Choose IOLTA or non-IOLTA");
      if (input.inKansas !== true) bad("Confirm that this is a separate trust account at a bank in Kansas (KRPC 1.15(a))");
      const last4 = optText(input.accountLast4, "Last four digits", 4);
      if (last4 != null && !/^\d{4}$/.test(last4)) bad("Enter only the last four digits of the account number");
      const limit = input.firmFundsLimitCents == null ? null : this.limit(input.firmFundsLimitCents);
      const opened = input.openedOn != null ? date(input.openedOn, "Opening date") : this.today();
      const now = this.stamp();
      const aid = this.run(
        `INSERT INTO trust_accounts (name, bank_name, account_last4, kind, in_kansas, require_cleared, firm_funds_limit_cents, client_name, opened_on, notes, created_by, created_at)
         VALUES (?,?,?,?,1,?,?,?,?,?,?,?)`,
        name,
        bank,
        last4,
        input.kind,
        input.requireCleared === false ? 0 : 1,
        limit,
        optText(input.clientName, "Client name", 200),
        opened,
        optText(input.notes, "Notes", 2000),
        actor,
        now,
      );
      this.run("INSERT INTO trust_ledgers (account_id, kind, created_at) VALUES (?, 'firm', ?)", aid, now);
      this.log("trust_account_opened", `Set up trust account "${name}" (${input.kind === "iolta" ? "IOLTA" : "non-IOLTA"}) at ${bank}`, actor);
      return this.account(aid);
    });
  }

  private limit(v: unknown): number {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad("The bank-charge limit must be a whole number of cents, 0 or more");
    return v;
  }

  /** Settings that can change after opening. Type, Kansas confirmation and opening date are fixed. */
  updateAccount(accountId: number, patch: Record<string, unknown>, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const changes: string[] = [];
      const set = (col: string, val: unknown, label: string) => {
        this.db.prepare(`UPDATE trust_accounts SET ${col} = ? WHERE id = ?`).run(val as any, accountId);
        changes.push(label);
      };
      if ("name" in patch) set("name", required(patch.name, "Account name", 200), "name");
      if ("bankName" in patch) set("bank_name", required(patch.bankName, "Bank name", 200), "bank");
      if ("notes" in patch) set("notes", optText(patch.notes, "Notes", 2000), "notes");
      if ("requireCleared" in patch) {
        if (typeof patch.requireCleared !== "boolean") bad("requireCleared must be true or false");
        set("require_cleared", patch.requireCleared ? 1 : 0, patch.requireCleared ? "now requires cleared funds" : "no longer requires cleared funds");
      }
      if ("firmFundsLimitCents" in patch) {
        const lim = patch.firmFundsLimitCents == null ? null : this.limit(patch.firmFundsLimitCents);
        set("firm_funds_limit_cents", lim, `bank-charge limit ${lim == null ? "cleared" : formatCents(lim)}`);
      }
      if ("closedOn" in patch) {
        const c = patch.closedOn == null ? null : date(patch.closedOn, "Closing date");
        if (c && this.accountBalance(accountId) !== 0) bad("An account can only be closed when its balance is zero");
        set("closed_on", c, c ? `closed ${c}` : "reopened");
      }
      if (changes.length) this.log("trust_account_updated", `Trust account "${a.name}": ${changes.join(", ")}`, actor);
      return this.account(accountId);
    });
  }

  accountRow(accountId: number): Row {
    return this.must("SELECT * FROM trust_accounts WHERE id = ?", "Trust account", id(accountId, "Trust account"));
  }

  accountBalance(accountId: number, asOf?: ISODate): number {
    return this.one(
      `SELECT COALESCE(SUM(amount_cents),0) AS s FROM trust_txns WHERE account_id = ?${asOf ? " AND date <= ?" : ""}`,
      accountId,
      ...(asOf ? [asOf] : []),
    )!.s;
  }

  account(accountId: number): Row {
    const a = this.accountRow(accountId);
    const firm = this.firmLedger(accountId);
    const lastSigned = this.one(
      "SELECT period, period_end, signed_on FROM trust_reconciliations WHERE account_id = ? AND status = 'signed' ORDER BY period DESC LIMIT 1",
      accountId,
    );
    return {
      ...a,
      balance_cents: this.accountBalance(accountId),
      cleared_balance_cents: this.one(
        `SELECT COALESCE(SUM(t.amount_cents),0) AS s FROM trust_txns t WHERE t.account_id = ? AND ${this.clearedSql("t")} IS NOT NULL`,
        accountId,
      )!.s,
      firm_ledger_id: firm.id,
      firm_balance_cents: this.ledgerBalance(firm.id),
      client_ledgers: this.one("SELECT COUNT(*) AS n FROM trust_ledgers WHERE account_id = ? AND kind = 'client'", accountId)!.n,
      last_reconciled: lastSigned ?? null,
      locked_through: lastSigned?.period_end ?? null,
    };
  }

  listAccounts(): Row[] {
    return this.all("SELECT id FROM trust_accounts ORDER BY closed_on IS NOT NULL, name, id").map((r) => this.account(r.id));
  }

  // -------------------------------------------------------------- ledgers

  firmLedger(accountId: number): Row {
    return this.must("SELECT * FROM trust_ledgers WHERE account_id = ? AND kind = 'firm'", "Firm ledger", accountId);
  }

  /** The client ledger for a matter in an account, created on first use. */
  ledgerFor(accountId: number, matterId: number): Row {
    this.accountRow(accountId);
    const m = this.must("SELECT * FROM matters WHERE id = ?", "Matter", id(matterId, "Matter"));
    if (m.client_id == null) bad("That matter has no client, so it can't have a trust ledger");
    const existing = this.one("SELECT * FROM trust_ledgers WHERE account_id = ? AND matter_id = ? AND kind = 'client'", accountId, m.id);
    if (existing) return existing;
    const lid = this.run(
      "INSERT INTO trust_ledgers (account_id, kind, client_id, matter_id, created_at) VALUES (?, 'client', ?, ?, ?)",
      accountId,
      m.client_id,
      m.id,
      this.stamp(),
    );
    return this.one("SELECT * FROM trust_ledgers WHERE id = ?", lid)!;
  }

  ledgerRow(ledgerId: number): Row {
    return this.must("SELECT * FROM trust_ledgers WHERE id = ?", "Trust ledger", id(ledgerId, "Trust ledger"));
  }

  ledgerBalance(ledgerId: number, asOf?: ISODate): number {
    return this.one(
      `SELECT COALESCE(SUM(l.amount_cents),0) AS s FROM trust_lines l JOIN trust_txns t ON t.id = l.txn_id
       WHERE l.ledger_id = ?${asOf ? " AND t.date <= ?" : ""}`,
      ledgerId,
      ...(asOf ? [asOf] : []),
    )!.s;
  }

  /** SQL for a transaction's current cleared date (NULL = not cleared). */
  private clearedSql(alias: string, asOf?: string): string {
    return `(SELECT c.cleared_on FROM trust_clearings c WHERE c.txn_id = ${alias}.id${asOf ? ` AND c.created_at <= ${asOf}` : ""} ORDER BY c.id DESC LIMIT 1)`;
  }

  heldCents(ledgerId: number): number {
    return this.one(
      `SELECT COALESCE(SUM(h.amount_cents),0) AS s FROM trust_holds h
       WHERE h.ledger_id = ? AND NOT EXISTS (SELECT 1 FROM trust_hold_releases r WHERE r.hold_id = h.id)`,
      ledgerId,
    )!.s;
  }

  /** Money on the ledger that has cleared at the bank (incoming deposits not yet cleared are left out). */
  clearedCents(ledgerId: number): number {
    return this.one(
      `SELECT COALESCE(SUM(l.amount_cents),0) AS s FROM trust_lines l JOIN trust_txns t ON t.id = l.txn_id
       WHERE l.ledger_id = ? AND NOT (l.amount_cents > 0 AND t.kind IN ('deposit','firm_deposit') AND ${this.clearedSql("t")} IS NULL)`,
      ledgerId,
    )!.s;
  }

  /** How much can be paid out of a ledger right now. */
  availableCents(ledgerId: number): number {
    const l = this.ledgerRow(ledgerId);
    const a = this.accountRow(l.account_id);
    const base = a.require_cleared ? this.clearedCents(ledgerId) : this.ledgerBalance(ledgerId);
    return Math.max(0, Math.min(base, this.ledgerBalance(ledgerId)) - this.heldCents(ledgerId));
  }

  ledgerLabel(l: Row): string {
    if (l.kind === "firm") return "Firm funds for bank charges";
    const m = this.one(
      "SELECT m.number, m.name, c.name AS client FROM matters m JOIN contacts c ON c.id = m.client_id WHERE m.id = ?",
      l.matter_id,
    );
    return m ? `${m.client} — ${m.number ? m.number + " " : ""}${m.name}` : `Ledger ${l.id}`;
  }

  retention(l: Row): { keep_until: ISODate | null; note: string } {
    if (l.kind === "firm") {
      const a = this.accountRow(l.account_id);
      return a.closed_on
        ? { keep_until: addYears(a.closed_on, RETENTION_YEARS), note: `Keep until ${addYears(a.closed_on, RETENTION_YEARS)} (five years after the account closed)` }
        : { keep_until: null, note: "Keep while the account is open and for five years after" };
    }
    const m = this.one("SELECT status, closed_on FROM matters WHERE id = ?", l.matter_id)!;
    if (m.status === "closed" && m.closed_on) {
      const until = addYears(m.closed_on, RETENTION_YEARS);
      return { keep_until: until, note: `Keep until at least ${until}: five years after the representation ended (matter closed ${m.closed_on}), KRPC 1.15(a)` };
    }
    return { keep_until: null, note: "Matter open: keep for five years after the representation ends, KRPC 1.15(a)" };
  }

  ledger(ledgerId: number): Row {
    const l = this.ledgerRow(ledgerId);
    const matter = l.matter_id
      ? this.one(
          "SELECT m.id, m.number, m.name, m.status, m.closed_on, c.id AS client_id, c.name AS client_name FROM matters m JOIN contacts c ON c.id = m.client_id WHERE m.id = ?",
          l.matter_id,
        )
      : null;
    const holds = this.all(
      `SELECT h.*, r.released_on, r.reason AS release_reason FROM trust_holds h LEFT JOIN trust_hold_releases r ON r.hold_id = h.id
       WHERE h.ledger_id = ? ORDER BY h.id`,
      ledgerId,
    );
    return {
      ...l,
      label: this.ledgerLabel(l),
      matter,
      account: this.one("SELECT id, name, kind FROM trust_accounts WHERE id = ?", l.account_id),
      balance_cents: this.ledgerBalance(ledgerId),
      cleared_cents: this.clearedCents(ledgerId),
      held_cents: this.heldCents(ledgerId),
      available_cents: this.availableCents(ledgerId),
      holds,
      retention: this.retention(l),
      entries: this.ledgerEntries(ledgerId),
    };
  }

  /** Every line on a ledger in date order with a running balance. */
  ledgerEntries(ledgerId: number, from?: ISODate, to?: ISODate): Row[] {
    const rows = this.all(
      `SELECT l.id AS line_id, l.amount_cents, t.*, ${this.clearedSql("t")} AS cleared_on, u.name AS created_by_name
       FROM trust_lines l JOIN trust_txns t ON t.id = l.txn_id LEFT JOIN users u ON u.id = t.created_by
       WHERE l.ledger_id = ? ORDER BY t.date, t.id`,
      ledgerId,
    );
    let bal = 0;
    const out: Row[] = [];
    for (const r of rows) {
      bal += r.amount_cents;
      if (from && r.date < from) continue;
      if (to && r.date > to) continue;
      out.push({ ...r, kind_label: KIND_LABELS[r.kind as TxnKind], description: this.describe(r), balance_cents: bal });
    }
    return out;
  }

  listLedgers(accountId: number, opts: { asOf?: ISODate; includeZero?: boolean } = {}): Row[] {
    this.accountRow(accountId);
    const rows = this.all(
      `SELECT l.*, m.number AS matter_number, m.name AS matter_name, m.status AS matter_status, c.name AS client_name,
         (SELECT MAX(t.date) FROM trust_lines x JOIN trust_txns t ON t.id = x.txn_id WHERE x.ledger_id = l.id) AS last_activity
       FROM trust_ledgers l LEFT JOIN matters m ON m.id = l.matter_id LEFT JOIN contacts c ON c.id = l.client_id
       WHERE l.account_id = ? ORDER BY l.kind = 'firm', c.name, m.number, l.id`,
      accountId,
    );
    return rows
      .map((l) => ({
        ...l,
        label: this.ledgerLabel(l),
        balance_cents: this.ledgerBalance(l.id, opts.asOf),
        held_cents: this.heldCents(l.id),
        available_cents: this.availableCents(l.id),
      }))
      .filter((l) => opts.includeZero !== false || l.balance_cents !== 0);
  }

  // --------------------------------------------------------------- posting

  private checkOpen(a: Row, on: ISODate) {
    if (a.closed_on) bad(`Trust account "${a.name}" is closed`, 409);
    if (on < a.opened_on) bad(`The date is before the account was opened (${a.opened_on})`);
    const lock = this.one("SELECT MAX(period_end) AS e FROM trust_reconciliations WHERE account_id = ? AND status = 'signed'", a.id)!.e;
    if (lock && on <= lock) bad(`${on} is in a month whose reconciliation is signed (through ${lock}). Date the entry after ${lock}.`, 409);
  }

  /**
   * After adding `delta` on `on` (posted after every existing entry that day), would the
   * ledger dip below zero at any point from then on? Checks the whole running balance, so a
   * back-dated payment can't spend money that only arrived later.
   */
  private assertNeverNegative(ledgerId: number, delta: number, on: ISODate, what: string) {
    if (delta >= 0) return;
    const rows = this.all(
      "SELECT t.date, l.amount_cents FROM trust_lines l JOIN trust_txns t ON t.id = l.txn_id WHERE l.ledger_id = ? ORDER BY t.date, t.id",
      ledgerId,
    );
    let bal = 0;
    let inserted = false;
    let low = Infinity;
    for (const r of rows) {
      if (!inserted && r.date > on) {
        bal += delta;
        inserted = true;
        low = Math.min(low, bal);
      }
      bal += r.amount_cents;
      if (inserted) low = Math.min(low, bal);
    }
    if (!inserted) {
      bal += delta;
      low = Math.min(low, bal);
    }
    if (low < 0) {
      const now = this.ledgerBalance(ledgerId, on);
      bad(
        `Refused: this would take ${what} below zero. The ledger holds ${formatCents(now)} on ${on}. ` +
          "Trust money of one client can never be used for another, and there is no override.",
        409,
      );
    }
  }

  private assertAvailable(ledgerId: number, amount: number, what: string) {
    const l = this.ledgerRow(ledgerId);
    const a = this.accountRow(l.account_id);
    const held = this.heldCents(ledgerId);
    const bal = this.ledgerBalance(ledgerId);
    const cleared = this.clearedCents(ledgerId);
    if (a.require_cleared && amount > cleared - held && amount <= bal - held) {
      bad(
        `Refused: only ${formatCents(Math.max(0, cleared - held))} on ${what} has cleared the bank. ` +
          "Mark the deposit cleared once the bank shows it collected, then try again.",
        409,
      );
    }
    if (held && amount > bal - held && amount <= bal) {
      bad(`Refused: ${formatCents(held)} on ${what} is on hold as disputed and can't be paid out until the hold is released.`, 409);
    }
  }

  private post(
    a: Row,
    kind: TxnKind,
    on: ISODate,
    lines: { ledgerId: number; amount: number; what: string }[],
    fields: Record<string, unknown>,
    actor: number | null,
  ): number {
    this.checkOpen(a, on);
    for (const ln of lines) {
      const l = this.ledgerRow(ln.ledgerId);
      if (l.account_id !== a.id) bad("That ledger belongs to a different trust account");
      this.assertNeverNegative(ln.ledgerId, ln.amount, on, ln.what);
    }
    const amount = lines.reduce((s, l) => s + l.amount, 0);
    const tid = this.run(
      `INSERT INTO trust_txns (account_id, kind, date, amount_cents, party, method, check_number, reference, memo, invoice_id, billing_payment_id, reverses_id, reason, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id,
      kind,
      on,
      amount,
      (fields.party as string) ?? null,
      (fields.method as string) ?? null,
      (fields.checkNumber as string) ?? null,
      (fields.reference as string) ?? null,
      (fields.memo as string) ?? "",
      (fields.invoiceId as number) ?? null,
      (fields.billingPaymentId as number) ?? null,
      (fields.reversesId as number) ?? null,
      (fields.reason as string) ?? null,
      actor,
      this.stamp(),
    );
    for (const ln of lines) this.run("INSERT INTO trust_lines (txn_id, ledger_id, amount_cents) VALUES (?,?,?)", tid, ln.ledgerId, ln.amount);
    const sum = this.one("SELECT SUM(amount_cents) AS s FROM trust_lines WHERE txn_id = ?", tid)!.s;
    if (sum !== amount) throw new Error("trust: lines do not add up to the transaction"); // can't happen; rolls back
    return tid;
  }

  private common(input: EntryInput) {
    return {
      on: input.date != null ? date(input.date, "Date") : this.today(),
      amount: cents(input.amountCents),
      reference: optText(input.reference, "Reference", 100),
      memo: text(input.memo, "Memo", 500),
    };
  }

  private initialClearing(tid: number, clearedOn: unknown, on: ISODate, actor: number | null) {
    if (clearedOn == null || clearedOn === "") return;
    const c = date(clearedOn, "Cleared date");
    if (c < on) bad("The cleared date can't be before the entry's date");
    this.run("INSERT INTO trust_clearings (txn_id, cleared_on, created_by, created_at) VALUES (?,?,?,?)", tid, c, actor, this.stamp());
  }

  private matterOf(ledgerId: number): number | null {
    return this.ledgerRow(ledgerId).matter_id ?? null;
  }

  /** Client money in. */
  deposit(accountId: number, matterId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      const party = required(input.party, "Received from", 200);
      const method = input.method ?? "deposit_slip";
      if (!["deposit_slip", "eft", "wire"].includes(method)) bad("Deposit method must be deposit slip, EFT or wire");
      const l = this.ledgerFor(accountId, matterId);
      const tid = this.post(a, "deposit", c.on, [{ ledgerId: l.id, amount: c.amount, what: this.ledgerLabel(l) }], { ...c, party, method }, actor);
      this.initialClearing(tid, input.clearedOn, c.on, actor);
      this.log("trust_deposit", `Trust deposit ${formatCents(c.amount)} from ${party} to "${a.name}" (entry ${tid})`, actor, matterId);
      return this.txn(tid);
    });
  }

  /** Payment out of a client ledger by check, EFT or wire. */
  disburse(accountId: number, matterId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      const party = required(input.party, "Payee", 200);
      const method = input.method;
      if (method !== "check" && method !== "eft" && method !== "wire") bad("Pay by check, EFT or wire");
      let checkNumber: string | null = null;
      if (method === "check") {
        checkNumber = required(input.checkNumber, "Check number", 20);
        if (!/^\d{1,20}$/.test(checkNumber)) bad("Check number must be digits only");
        if (this.one("SELECT 1 FROM trust_txns WHERE account_id = ? AND check_number = ? AND kind <> 'reversal'", a.id, checkNumber)) {
          bad(`Check ${checkNumber} is already recorded on this account`, 409);
        }
      }
      if (!c.memo) bad("Say what the payment is for");
      const l = this.ledgerFor(accountId, matterId);
      this.assertAvailable(l.id, c.amount, this.ledgerLabel(l));
      const tid = this.post(a, "disbursement", c.on, [{ ledgerId: l.id, amount: -c.amount, what: this.ledgerLabel(l) }], { ...c, party, method, checkNumber }, actor);
      this.initialClearing(tid, input.clearedOn, c.on, actor);
      this.log(
        "trust_disbursement",
        `Trust payment ${formatCents(c.amount)} to ${party} by ${method === "check" ? `check ${checkNumber}` : method.toUpperCase()} from "${a.name}" (entry ${tid})`,
        actor,
        matterId,
      );
      return this.txn(tid);
    });
  }

  /**
   * Move an earned fee to the operating account against a finalized invoice. Records a
   * payment on the invoice in billing, in the same database transaction.
   */
  transferFee(accountId: number, invoiceId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      const b = this.billing();
      const inv = this.must("SELECT * FROM billing_invoices WHERE id = ?", "Invoice", id(invoiceId, "Invoice"));
      if (inv.status !== "final") bad(`Earned fees can only be moved against a finalized invoice; this invoice is ${inv.status}`, 409);
      const owed = b.balance(inv.id);
      if (c.amount > owed) bad(`${formatCents(c.amount)} is more than the ${formatCents(owed)} still owed on invoice ${inv.number}`, 409);
      const l = this.ledgerFor(accountId, inv.matter_id);
      if (l.client_id !== inv.client_id) bad("That invoice is for a different client than the trust ledger");
      this.assertAvailable(l.id, c.amount, this.ledgerLabel(l));
      // Check the ledger before touching billing, so a refusal leaves both untouched.
      this.assertNeverNegative(l.id, -c.amount, c.on, this.ledgerLabel(l));
      const pay = b.recordPayment(
        {
          clientId: inv.client_id,
          matterId: inv.matter_id,
          amountCents: c.amount,
          receivedOn: c.on,
          method: "Trust transfer",
          reference: `From trust account "${a.name}"`,
          note: c.memo || null,
          allocations: [{ invoiceId: inv.id, amountCents: c.amount }],
        },
        actor,
      );
      const tid = this.post(
        a,
        "fee_transfer",
        c.on,
        [{ ledgerId: l.id, amount: -c.amount, what: this.ledgerLabel(l) }],
        { ...c, party: "Firm operating account", method: "eft", invoiceId: inv.id, billingPaymentId: pay.id, memo: c.memo || `Earned fees, invoice ${inv.number}` },
        actor,
      );
      this.initialClearing(tid, input.clearedOn, c.on, actor);
      this.log("trust_fee_transfer", `Moved ${formatCents(c.amount)} of earned fees from "${a.name}" to operating for invoice ${inv.number} (entry ${tid})`, actor, inv.matter_id);
      return this.txn(tid);
    });
  }

  /** Move money from one client matter's ledger to another's in the same account. */
  transferBetween(accountId: number, fromMatterId: number, toMatterId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      if (fromMatterId === toMatterId) bad("Choose two different matters");
      if (!c.memo) bad("Say why the money is moving (for example, the client's written instruction)");
      const from = this.ledgerFor(accountId, fromMatterId);
      const to = this.ledgerFor(accountId, toMatterId);
      this.assertAvailable(from.id, c.amount, this.ledgerLabel(from));
      const tid = this.post(
        a,
        "ledger_transfer",
        c.on,
        [
          { ledgerId: from.id, amount: -c.amount, what: this.ledgerLabel(from) },
          { ledgerId: to.id, amount: c.amount, what: this.ledgerLabel(to) },
        ],
        c,
        actor,
      );
      const detail = `Moved ${formatCents(c.amount)} in trust from ${this.ledgerLabel(from)} to ${this.ledgerLabel(to)} (entry ${tid})`;
      this.log("trust_ledger_transfer", detail, actor, fromMatterId);
      this.log("trust_ledger_transfer", detail, actor, toMatterId);
      return this.txn(tid);
    });
  }

  /** Firm money deposited to cover bank charges, up to the limit the lawyer set (KRPC 1.15(d)(1)(i)). */
  firmDeposit(accountId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      if (a.firm_funds_limit_cents == null) bad("Set this account's limit for firm funds to cover bank charges before depositing firm money", 409);
      const f = this.firmLedger(accountId);
      const after = this.ledgerBalance(f.id) + c.amount;
      if (after > a.firm_funds_limit_cents) {
        bad(
          `Refused: firm money in trust would be ${formatCents(after)}, over the ${formatCents(a.firm_funds_limit_cents)} limit set as reasonably sufficient for bank charges. Firm money must not otherwise be mixed with client money.`,
          409,
        );
      }
      const tid = this.post(a, "firm_deposit", c.on, [{ ledgerId: f.id, amount: c.amount, what: "firm funds for bank charges" }], { ...c, party: optText(input.party, "From", 200) ?? "Firm operating account", method: "eft" }, actor);
      this.initialClearing(tid, input.clearedOn, c.on, actor);
      this.log("trust_firm_deposit", `Deposited ${formatCents(c.amount)} of firm money into "${a.name}" to cover bank charges (entry ${tid})`, actor);
      return this.txn(tid);
    });
  }

  firmWithdrawal(accountId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      const f = this.firmLedger(accountId);
      this.assertAvailable(f.id, c.amount, "firm funds for bank charges");
      const tid = this.post(a, "firm_withdrawal", c.on, [{ ledgerId: f.id, amount: -c.amount, what: "firm funds for bank charges" }], { ...c, party: "Firm operating account", method: "eft" }, actor);
      this.initialClearing(tid, input.clearedOn, c.on, actor);
      this.log("trust_firm_withdrawal", `Withdrew ${formatCents(c.amount)} of firm money from "${a.name}" (entry ${tid})`, actor);
      return this.txn(tid);
    });
  }

  /** A charge the bank took. Paid only from the firm's bank-charge funds, never a client's. */
  bankFee(accountId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      const c = this.common(input);
      if (!c.memo) bad("Describe the charge as shown on the bank statement");
      const f = this.firmLedger(accountId);
      const bal = this.ledgerBalance(f.id, c.on);
      if (c.amount > bal) {
        bad(
          `Refused: the firm's bank-charge funds hold ${formatCents(bal)}, less than the ${formatCents(c.amount)} charge. ` +
            "Bank charges can never be taken from client money. Deposit firm funds for bank charges first.",
          409,
        );
      }
      const tid = this.post(a, "bank_fee", c.on, [{ ledgerId: f.id, amount: -c.amount, what: "firm funds for bank charges" }], { ...c, party: a.bank_name, method: "bank" }, actor);
      // A bank charge is on the statement by definition.
      this.run("INSERT INTO trust_clearings (txn_id, cleared_on, created_by, created_at) VALUES (?,?,?,?)", tid, c.on, actor, this.stamp());
      this.log("trust_bank_fee", `Bank charge ${formatCents(c.amount)} on "${a.name}" paid from firm funds: ${c.memo} (entry ${tid})`, actor);
      return this.txn(tid);
    });
  }

  /** Interest on a non-IOLTA account, credited to the client whose money earned it. */
  interest(accountId: number, matterId: number, input: EntryInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const a = this.accountRow(accountId);
      if (a.kind === "iolta") {
        bad("Interest on an IOLTA account is sent by the bank to the Kansas Bar Foundation (KRPC 1.15(d)(3)(iii)(aa)); it is not recorded to a client or the firm.", 409);
      }
      const c = this.common(input);
      const l = this.ledgerFor(accountId, matterId);
      const tid = this.post(a, "interest", c.on, [{ ledgerId: l.id, amount: c.amount, what: this.ledgerLabel(l) }], { ...c, party: a.bank_name, method: "bank" }, actor);
      this.run("INSERT INTO trust_clearings (txn_id, cleared_on, created_by, created_at) VALUES (?,?,?,?)", tid, c.on, actor, this.stamp());
      this.log("trust_interest", `Interest ${formatCents(c.amount)} credited to ${this.ledgerLabel(l)} in "${a.name}" (entry ${tid})`, actor, matterId);
      return this.txn(tid);
    });
  }

  /**
   * Undo a posted entry with an equal and opposite one. The original stays in the journal.
   * Reversing an earned-fee transfer also voids the payment it recorded on the invoice.
   */
  reverse(txnId: number, input: { reason: string; date?: ISODate }, actor: number | null = null): Row {
    return tx(this.db, () => {
      const t = this.must("SELECT * FROM trust_txns WHERE id = ?", "Trust entry", id(txnId, "Trust entry"));
      const reason = required(input?.reason, "Reason for the reversal", 500);
      if (t.kind === "reversal") bad("A reversal can't itself be reversed. Record a new entry instead.", 409);
      if (this.one("SELECT 1 FROM trust_txns WHERE reverses_id = ?", t.id)) bad("That entry has already been reversed", 409);
      const a = this.accountRow(t.account_id);
      const on = input.date != null ? date(input.date, "Date") : this.today();
      if (on < t.date) bad("A reversal can't be dated before the entry it reverses");
      const lines = this.all("SELECT * FROM trust_lines WHERE txn_id = ? ORDER BY id", t.id).map((l) => ({
        ledgerId: l.ledger_id,
        amount: -l.amount_cents,
        what: this.ledgerLabel(this.ledgerRow(l.ledger_id)),
      }));
      const rid = this.post(
        a,
        "reversal",
        on,
        lines,
        { party: t.party, method: t.method, reference: t.check_number ? `Check ${t.check_number}` : t.reference, memo: `Reverses entry ${t.id}`, reversesId: t.id, reason, invoiceId: t.invoice_id },
        actor,
      );
      if (t.billing_payment_id) this.billing().voidPayment(t.billing_payment_id, `Trust transfer reversed: ${reason}`, actor);
      for (const ln of lines) {
        const m = this.matterOf(ln.ledgerId);
        this.log("trust_reversal", `Reversed trust entry ${t.id} (${KIND_LABELS[t.kind as TxnKind]}, ${formatCents(Math.abs(t.amount_cents))}): ${reason} (entry ${rid})`, actor, m);
      }
      return this.txn(rid);
    });
  }

  /** Mark an entry as shown on the bank statement (cleared), or not cleared again. */
  setCleared(txnId: number, clearedOn: ISODate | null, actor: number | null = null): Row {
    return tx(this.db, () => {
      const t = this.must("SELECT * FROM trust_txns WHERE id = ?", "Trust entry", id(txnId, "Trust entry"));
      const c = clearedOn == null ? null : date(clearedOn, "Cleared date");
      if (c && c < t.date) bad("The cleared date can't be before the entry's date");
      const cur = this.one(`SELECT ${this.clearedSql("t")} AS c FROM trust_txns t WHERE t.id = ?`, t.id)!.c;
      if ((cur ?? null) === c) return this.txn(t.id);
      const lock = this.one("SELECT MAX(period_end) AS e FROM trust_reconciliations WHERE account_id = ? AND status = 'signed'", t.account_id)!.e;
      if (lock && ((c && c <= lock) || (cur && cur <= lock))) bad(`That would change a month whose reconciliation is signed (through ${lock})`, 409);
      // Taking a deposit back to "not cleared" must not leave money already paid out uncovered (checked below).
      this.run("INSERT INTO trust_clearings (txn_id, cleared_on, created_by, created_at) VALUES (?,?,?,?)", t.id, c, actor, this.stamp());
      const a = this.accountRow(t.account_id);
      if (c == null && a.require_cleared && NEEDS_CLEARING.has(t.kind)) {
        for (const l of this.all("SELECT ledger_id FROM trust_lines WHERE txn_id = ?", t.id)) {
          if (this.clearedCents(l.ledger_id) < 0) bad("Refused: money from this deposit has already been paid out, so it can't be marked not cleared. Record a reversal if the deposit was returned.", 409);
        }
      }
      this.log("trust_cleared", `Trust entry ${t.id} in "${a.name}" ${c ? `marked cleared ${c}` : "marked not cleared"}`, actor, this.firstMatter(t.id));
      return this.txn(t.id);
    });
  }

  private firstMatter(txnId: number): number | null {
    return this.one("SELECT g.matter_id FROM trust_lines l JOIN trust_ledgers g ON g.id = l.ledger_id WHERE l.txn_id = ? AND g.matter_id IS NOT NULL ORDER BY l.id LIMIT 1", txnId)?.matter_id ?? null;
  }

  // ----------------------------------------------------------------- holds

  placeHold(ledgerId: number, input: { amountCents: number; reason: string; date?: ISODate }, actor: number | null = null): Row {
    return tx(this.db, () => {
      const l = this.ledgerRow(ledgerId);
      const amount = cents(input.amountCents);
      const reason = required(input.reason, "Reason for the hold", 500);
      const on = input.date != null ? date(input.date, "Date") : this.today();
      const free = this.ledgerBalance(l.id) - this.heldCents(l.id);
      if (amount > free) bad(`Only ${formatCents(free)} on this ledger is not already held`, 409);
      const hid = this.run("INSERT INTO trust_holds (ledger_id, amount_cents, reason, placed_on, created_by, created_at) VALUES (?,?,?,?,?,?)", l.id, amount, reason, on, actor, this.stamp());
      this.log("trust_hold", `Held ${formatCents(amount)} on ${this.ledgerLabel(l)} as disputed: ${reason}`, actor, l.matter_id);
      return this.one("SELECT * FROM trust_holds WHERE id = ?", hid)!;
    });
  }

  releaseHold(holdId: number, input: { reason: string; date?: ISODate }, actor: number | null = null): Row {
    return tx(this.db, () => {
      const h = this.must("SELECT * FROM trust_holds WHERE id = ?", "Hold", id(holdId, "Hold"));
      if (this.one("SELECT 1 FROM trust_hold_releases WHERE hold_id = ?", h.id)) bad("That hold was already released", 409);
      const reason = required(input?.reason, "How the dispute was resolved", 500);
      const on = input.date != null ? date(input.date, "Date") : this.today();
      this.run("INSERT INTO trust_hold_releases (hold_id, released_on, reason, created_by, created_at) VALUES (?,?,?,?,?)", h.id, on, reason, actor, this.stamp());
      const l = this.ledgerRow(h.ledger_id);
      this.log("trust_hold_released", `Released hold of ${formatCents(h.amount_cents)} on ${this.ledgerLabel(l)}: ${reason}`, actor, l.matter_id);
      return { ...h, released_on: on, release_reason: reason };
    });
  }

  // --------------------------------------------------------------- reading

  describe(t: Row): string {
    const parts: string[] = [];
    if (t.party) parts.push(t.kind === "deposit" ? `From ${t.party}` : t.kind === "reversal" ? String(t.party) : `To ${t.party}`);
    if (t.check_number) parts.push(`Check ${t.check_number}`);
    else if (t.method && t.method !== "bank" && t.method !== "deposit_slip") parts.push(String(t.method).toUpperCase());
    if (t.reference) parts.push(String(t.reference));
    if (t.memo) parts.push(String(t.memo));
    if (t.reason) parts.push(`Reason: ${t.reason}`);
    return parts.join(" · ");
  }

  txn(txnId: number): Row {
    const t = this.must(
      `SELECT t.*, ${this.clearedSql("t")} AS cleared_on, u.name AS created_by_name FROM trust_txns t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?`,
      "Trust entry",
      txnId,
    );
    const lines = this.all("SELECT * FROM trust_lines WHERE txn_id = ? ORDER BY id", txnId).map((l) => ({ ...l, label: this.ledgerLabel(this.ledgerRow(l.ledger_id)) }));
    const reversedBy = this.one("SELECT id, date, reason FROM trust_txns WHERE reverses_id = ?", txnId) ?? null;
    const invoice = t.invoice_id ? this.one("SELECT id, number, status FROM billing_invoices WHERE id = ?", t.invoice_id) : null;
    return { ...t, kind_label: KIND_LABELS[t.kind as TxnKind], description: this.describe(t), lines, reversed_by: reversedBy, invoice };
  }

  /** The account register: every entry in date order with a running balance. */
  journal(accountId: number, from?: ISODate, to?: ISODate): Row[] {
    this.accountRow(accountId);
    const rows = this.all(
      `SELECT t.*, ${this.clearedSql("t")} AS cleared_on, u.name AS created_by_name,
         (SELECT r.id FROM trust_txns r WHERE r.reverses_id = t.id) AS reversed_by_id
       FROM trust_txns t LEFT JOIN users u ON u.id = t.created_by WHERE t.account_id = ? ORDER BY t.date, t.id`,
      accountId,
    );
    const ledgerLabels = new Map<number, string>();
    const label = (lid: number) => {
      if (!ledgerLabels.has(lid)) ledgerLabels.set(lid, this.ledgerLabel(this.ledgerRow(lid)));
      return ledgerLabels.get(lid)!;
    };
    let bal = 0;
    const out: Row[] = [];
    for (const r of rows) {
      bal += r.amount_cents;
      if (from && r.date < from) continue;
      if (to && r.date > to) continue;
      const lines = this.all("SELECT ledger_id, amount_cents FROM trust_lines WHERE txn_id = ? ORDER BY id", r.id).map((l) => ({ ...l, label: label(l.ledger_id) }));
      out.push({ ...r, kind_label: KIND_LABELS[r.kind as TxnKind], description: this.describe(r), lines, balance_cents: bal });
    }
    return out;
  }

  // -------------------------------------------------------- reconciliation

  /**
   * Three-way reconciliation as of the last day of `period`:
   *   1. bank: statement ending balance + deposits in transit - outstanding checks/payments
   *   2. journal: every entry dated on or before the month end
   *   3. ledgers: the sum of every client ledger and the firm bank-charge ledger
   * Balanced only when all three agree to the cent and no ledger is below zero.
   */
  reconcile(accountId: number, period: string, statementBalanceCents: number): Row {
    const a = this.accountRow(accountId);
    const end = monthEnd(period);
    if (typeof statementBalanceCents !== "number" || !Number.isSafeInteger(statementBalanceCents)) bad("Enter the statement's ending balance in cents");
    const items = this.all(
      `SELECT t.*, (SELECT c.cleared_on FROM trust_clearings c WHERE c.txn_id = t.id ORDER BY c.id DESC LIMIT 1) AS cleared_on,
         (SELECT r.id FROM trust_txns r WHERE r.reverses_id = t.id) AS reversed_by_id
       FROM trust_txns t WHERE t.account_id = ? AND t.date <= ? ORDER BY t.date, t.id`,
      accountId,
      end,
    );
    const outstanding = items
      .filter((t) => t.amount_cents !== 0 && (t.cleared_on == null || t.cleared_on > end))
      .map((t) => ({ id: t.id, date: t.date, kind: t.kind, kind_label: KIND_LABELS[t.kind as TxnKind], description: this.describe(t), amount_cents: t.amount_cents, check_number: t.check_number }));
    const depositsInTransit = outstanding.filter((t) => t.amount_cents > 0).reduce((s, t) => s + t.amount_cents, 0);
    const outstandingPayments = outstanding.filter((t) => t.amount_cents < 0).reduce((s, t) => s - t.amount_cents, 0);
    const adjustedBank = statementBalanceCents + depositsInTransit - outstandingPayments;
    const journal = this.one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM trust_txns WHERE account_id = ? AND date <= ?", accountId, end)!.s;
    // Computed from the lines table, independently of the journal totals.
    const ledgers = this.all(
      `SELECT g.id, g.kind, COALESCE(SUM(CASE WHEN t.date <= ? THEN l.amount_cents END),0) AS balance_cents
       FROM trust_ledgers g LEFT JOIN trust_lines l ON l.ledger_id = g.id LEFT JOIN trust_txns t ON t.id = l.txn_id
       WHERE g.account_id = ? GROUP BY g.id`,
      end,
      accountId,
    ).map((g) => ({ ...g, label: this.ledgerLabel(this.ledgerRow(g.id)) }));
    const ledgersTotal = ledgers.reduce((s, g) => s + g.balance_cents, 0);
    const negative = ledgers.filter((g) => g.balance_cents < 0);
    const bankVsJournal = adjustedBank - journal;
    const journalVsLedgers = journal - ledgersTotal;
    const balanced = bankVsJournal === 0 && journalVsLedgers === 0 && negative.length === 0;
    const problems: string[] = [];
    if (bankVsJournal) problems.push(`The adjusted bank balance is ${formatCents(Math.abs(bankVsJournal))} ${bankVsJournal > 0 ? "more" : "less"} than the trust journal.`);
    if (journalVsLedgers) problems.push(`The trust journal and the total of the client ledgers differ by ${formatCents(Math.abs(journalVsLedgers))}.`);
    for (const g of negative) problems.push(`${g.label} is below zero (${formatCents(g.balance_cents)}).`);
    return {
      account: { id: a.id, name: a.name, kind: a.kind, bank_name: a.bank_name, account_last4: a.account_last4 },
      period,
      period_end: end,
      statement_balance_cents: statementBalanceCents,
      deposits_in_transit_cents: depositsInTransit,
      outstanding_payments_cents: outstandingPayments,
      adjusted_bank_cents: adjustedBank,
      journal_cents: journal,
      ledgers_cents: ledgersTotal,
      bank_vs_journal_cents: bankVsJournal,
      journal_vs_ledgers_cents: journalVsLedgers,
      balanced,
      problems,
      outstanding,
      ledgers: ledgers.filter((g) => g.balance_cents !== 0 || g.kind === "firm"),
      cleared_this_month: items.filter((t) => t.cleared_on && t.cleared_on <= end && t.cleared_on >= `${period}-01`).length,
    };
  }

  /** Save (or re-save) a draft reconciliation for a month. */
  saveReconciliation(accountId: number, input: ReconInput, actor: number | null = null): Row {
    return tx(this.db, () => {
      const r = this.reconcile(accountId, input.period, input.statementBalanceCents);
      const existing = this.one("SELECT * FROM trust_reconciliations WHERE account_id = ? AND period = ?", accountId, input.period);
      if (existing?.status === "signed") bad(`The ${input.period} reconciliation is already signed and locked`, 409);
      const snap = JSON.stringify(r);
      const notes = optText(input.notes, "Notes", 2000);
      if (existing) {
        this.db
          .prepare(
            `UPDATE trust_reconciliations SET statement_balance_cents = ?, adjusted_bank_cents = ?, journal_cents = ?, ledgers_cents = ?, balanced = ?, snapshot = ?, notes = ?, prepared_by = ?, prepared_at = ? WHERE id = ?`,
          )
          .run(r.statement_balance_cents, r.adjusted_bank_cents, r.journal_cents, r.ledgers_cents, r.balanced ? 1 : 0, snap, notes, actor, this.stamp(), existing.id);
      } else {
        this.run(
          `INSERT INTO trust_reconciliations (account_id, period, period_end, statement_balance_cents, adjusted_bank_cents, journal_cents, ledgers_cents, balanced, snapshot, notes, prepared_by, prepared_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          accountId,
          input.period,
          r.period_end,
          r.statement_balance_cents,
          r.adjusted_bank_cents,
          r.journal_cents,
          r.ledgers_cents,
          r.balanced ? 1 : 0,
          snap,
          notes,
          actor,
          this.stamp(),
        );
      }
      const a = this.accountRow(accountId);
      this.log(
        "trust_reconciliation_saved",
        `Saved ${input.period} reconciliation of "${a.name}": ${r.balanced ? "all three balances agree" : "does not balance: " + r.problems.join(" ")}`,
        actor,
      );
      return this.reconciliation(accountId, input.period);
    });
  }

  /**
   * Sign off a month. Recomputes from the live journal first; refuses unless the three
   * balances agree to the cent, and unless every earlier month with activity is signed.
   * After this the month is locked: no entry or clearing date can fall inside it.
   */
  signReconciliation(accountId: number, period: string, actor: number | null): Row {
    return tx(this.db, () => {
      if (actor == null) bad("Choose who is signing off (the User box at the top) before signing a reconciliation", 400);
      const rec = this.one("SELECT * FROM trust_reconciliations WHERE account_id = ? AND period = ?", accountId, period);
      if (!rec) bad("Save the reconciliation before signing it", 404);
      if (rec.status === "signed") bad("That reconciliation is already signed", 409);
      const live = this.reconcile(accountId, period, rec.statement_balance_cents);
      if (!live.balanced) bad(`It does not balance, so it can't be signed. ${live.problems.join(" ")}`, 409);
      const prev = this.unsignedBefore(accountId, period);
      if (prev) bad(`Sign the ${prev} reconciliation first; months are signed in order`, 409);
      this.db
        .prepare(
          `UPDATE trust_reconciliations SET adjusted_bank_cents = ?, journal_cents = ?, ledgers_cents = ?, balanced = 1, snapshot = ?, status = 'signed', signed_by = ?, signed_on = ?, signed_at = ? WHERE id = ?`,
        )
        .run(live.adjusted_bank_cents, live.journal_cents, live.ledgers_cents, JSON.stringify(live), actor, this.today(), this.stamp(), rec.id);
      const a = this.accountRow(accountId);
      const who = this.one("SELECT name FROM users WHERE id = ?", actor)?.name ?? `user ${actor}`;
      this.log("trust_reconciliation_signed", `${who} signed the ${period} three-way reconciliation of "${a.name}" (${formatCents(live.journal_cents)}); the month is now locked`, actor);
      return this.reconciliation(accountId, period);
    });
  }

  /** The earliest month with activity, before `period`, that has no signed reconciliation. */
  unsignedBefore(accountId: number, period: string): string | null {
    const first = this.one("SELECT MIN(date) AS d FROM trust_txns WHERE account_id = ?", accountId)!.d as string | null;
    if (!first) return null;
    const signed = new Set(this.all("SELECT period FROM trust_reconciliations WHERE account_id = ? AND status = 'signed'", accountId).map((r) => r.period));
    for (let p = first.slice(0, 7); p < period; p = nextPeriod(p)) if (!signed.has(p)) return p;
    return null;
  }

  reconciliation(accountId: number, period: string): Row {
    const r = this.must(
      `SELECT r.*, p.name AS prepared_by_name, s.name AS signed_by_name FROM trust_reconciliations r
       LEFT JOIN users p ON p.id = r.prepared_by LEFT JOIN users s ON s.id = r.signed_by WHERE r.account_id = ? AND r.period = ?`,
      "Reconciliation",
      accountId,
      period,
    );
    return { ...r, snapshot: JSON.parse(r.snapshot) };
  }

  listReconciliations(accountId: number): Row[] {
    this.accountRow(accountId);
    return this.all(
      `SELECT r.id, r.account_id, r.period, r.period_end, r.statement_balance_cents, r.adjusted_bank_cents, r.journal_cents, r.ledgers_cents,
         r.balanced, r.status, r.prepared_at, r.signed_on, r.signed_at, p.name AS prepared_by_name, s.name AS signed_by_name
       FROM trust_reconciliations r LEFT JOIN users p ON p.id = r.prepared_by LEFT JOIN users s ON s.id = r.signed_by
       WHERE r.account_id = ? ORDER BY r.period DESC`,
      accountId,
    );
  }

  // ---------------------------------------------------------------- reports

  /** Client ledgers with money, as of a date. */
  clientBalances(accountId: number, asOf?: ISODate): Row[] {
    return this.listLedgers(accountId, { asOf, includeZero: false }).map((l) => ({ ...l, retention: this.retention(l) }));
  }

  /** Ledgers holding money with no activity for `months` months. */
  inactiveBalances(accountId: number, months: number): Row[] {
    if (!Number.isInteger(months) || months < 1 || months > 240) bad("Months must be a whole number from 1 to 240");
    const t = this.today();
    const [y, m, d] = t.split("-").map(Number);
    const cutoff = new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
    return this.listLedgers(accountId, { includeZero: false })
      .filter((l) => l.last_activity && l.last_activity < cutoff)
      .map((l) => ({ ...l, cutoff, retention: this.retention(l) }));
  }

  /** Every ledger for a matter, in any account (for the matter page). */
  matterLedgers(matterId: number): Row[] {
    return this.all("SELECT id FROM trust_ledgers WHERE matter_id = ? ORDER BY account_id", matterId).map((r) => {
      const l = this.ledgerRow(r.id);
      return { ...l, label: this.ledgerLabel(l), account_name: this.accountRow(l.account_id).name, balance_cents: this.ledgerBalance(l.id), available_cents: this.availableCents(l.id) };
    });
  }
}
