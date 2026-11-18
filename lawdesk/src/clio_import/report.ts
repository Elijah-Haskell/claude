// The reconciliation report: what came over, what didn't and why, and the money totals a
// person can hold up against Clio's own reports.

import type { DB } from "../db.ts";

export type Outcome = "created" | "updated" | "unchanged" | "skipped";

export interface Tally {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface Totals {
  timeEntries: number;
  /** Minutes worked, all time entries imported in this run (billed and unbilled). */
  timeMinutes: number;
  unbilledTimeMinutes: number;
  /** Unbilled billable time at the imported rate (minutes × rate, before Lawdesk's rounding). */
  unbilledTimeCents: number;
  nonBillableTimeMinutes: number;
  billedTimeMinutes: number;
  billedTimeCents: number;
  expenseEntries: number;
  unbilledExpenseCents: number;
  nonBillableExpenseCents: number;
  billedExpenseCents: number;
  /** Sum of Clio's own "total" column, where the file had one. */
  clioStatedTotalCents: number;
}

export interface TrustLine {
  line?: number;
  client: string | null;
  matter: string | null;
  matterId: number | null;
  account: string | null;
  balanceCents: number;
  asOf: string | null;
}

export interface Report {
  runId: number | null;
  source: "csv" | "api";
  kinds: string[];
  fileName: string | null;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number;
  byType: Record<string, Tally>;
  totals: Totals;
  skipped: { line?: number; type: string; ref: string; reason: string }[];
  warnings: { line?: number; ref?: string; message: string }[];
  /** Things the import had to add to make a row fit (a person named in Clio but not in Lawdesk). */
  added: { people: string[]; clients: string[]; practiceAreas: string[] };
  trust: { lines: TrustLine[]; totalCents: number; note: string } | null;
  /** More skips/warnings than are kept in the report. */
  truncated: boolean;
}

const LIST_CAP = 5000;

export const TRUST_NOTE =
  "These balances are listed for checking only. Nothing was posted to trust. Opening trust balances " +
  "are entered in the trust module after the firm's accountant has reconciled them to the bank statement and signed off.";

export function emptyTotals(): Totals {
  return {
    timeEntries: 0,
    timeMinutes: 0,
    unbilledTimeMinutes: 0,
    unbilledTimeCents: 0,
    nonBillableTimeMinutes: 0,
    billedTimeMinutes: 0,
    billedTimeCents: 0,
    expenseEntries: 0,
    unbilledExpenseCents: 0,
    nonBillableExpenseCents: 0,
    billedExpenseCents: 0,
    clioStatedTotalCents: 0,
  };
}

export function newReport(source: "csv" | "api", kinds: string[], opts: { fileName?: string | null; dryRun?: boolean; startedAt: string }): Report {
  return {
    runId: null,
    source,
    kinds,
    fileName: opts.fileName ?? null,
    dryRun: !!opts.dryRun,
    startedAt: opts.startedAt,
    finishedAt: null,
    rowsRead: 0,
    byType: {},
    totals: emptyTotals(),
    skipped: [],
    warnings: [],
    added: { people: [], clients: [], practiceAreas: [] },
    trust: null,
    truncated: false,
  };
}

export function tally(r: Report, type: string, outcome: Outcome) {
  const t = (r.byType[type] ??= { created: 0, updated: 0, unchanged: 0, skipped: 0 });
  t[outcome]++;
}

export function addSkip(r: Report, s: Report["skipped"][number]) {
  if (r.skipped.length < LIST_CAP) r.skipped.push(s);
  else r.truncated = true;
}

export function addWarning(r: Report, w: Report["warnings"][number]) {
  if (r.warnings.length < LIST_CAP) r.warnings.push(w);
  else r.truncated = true;
}

/** Combine API pages (or several files) into one report. */
export function mergeInto(into: Report, from: Report) {
  into.rowsRead += from.rowsRead;
  for (const [k, t] of Object.entries(from.byType)) {
    const d = (into.byType[k] ??= { created: 0, updated: 0, unchanged: 0, skipped: 0 });
    d.created += t.created;
    d.updated += t.updated;
    d.unchanged += t.unchanged;
    d.skipped += t.skipped;
  }
  for (const k of Object.keys(into.totals) as (keyof Totals)[]) into.totals[k] += from.totals[k];
  for (const s of from.skipped) addSkip(into, s);
  for (const w of from.warnings) addWarning(into, w);
  for (const k of ["people", "clients", "practiceAreas"] as const) for (const n of from.added[k]) if (!into.added[k].includes(n)) into.added[k].push(n);
  into.truncated ||= from.truncated;
}

/**
 * What Lawdesk holds now that came from Clio, across every import so far. This is the number
 * to compare with Clio: record counts per type, and the money in time and expense entries.
 */
export function reconciliation(db: DB) {
  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Record<string, number>;
  const count = (kind: string, table: string) =>
    one(`SELECT COUNT(*) n FROM clio_import_map m JOIN ${table} t ON t.id = m.lawdesk_id WHERE m.kind = ? AND m.target = ?`, kind, table).n;
  const time = one(
    `SELECT COUNT(*) n, COALESCE(SUM(t.minutes),0) minutes,
            COALESCE(SUM(CASE WHEN t.billable = 1 AND t.invoice_id IS NULL THEN t.minutes END),0) unbilled_minutes,
            COALESCE(SUM(CASE WHEN t.billable = 1 AND t.invoice_id IS NULL THEN
              CASE WHEN t.flat_cents IS NOT NULL THEN t.flat_cents ELSE (t.minutes * t.rate_cents + 30) / 60 END END),0) unbilled_cents,
            COALESCE(SUM(CASE WHEN t.billable = 0 THEN t.minutes END),0) nonbillable_minutes,
            COALESCE(SUM(CASE WHEN t.invoice_id IS NOT NULL THEN 1 END),0) billed_in_lawdesk
       FROM clio_import_map m JOIN billing_time_entries t ON t.id = m.lawdesk_id
      WHERE m.kind = 'activity' AND m.target = 'billing_time_entries'`,
  );
  const exp = one(
    `SELECT COUNT(*) n,
            COALESCE(SUM(CASE WHEN t.billable = 1 AND t.invoice_id IS NULL THEN t.cost_cents END),0) unbilled_cents,
            COALESCE(SUM(CASE WHEN t.billable = 0 THEN t.cost_cents END),0) nonbillable_cents,
            COALESCE(SUM(CASE WHEN t.invoice_id IS NOT NULL THEN 1 END),0) billed_in_lawdesk
       FROM clio_import_map m JOIN billing_expenses t ON t.id = m.lawdesk_id
      WHERE m.kind = 'activity' AND m.target = 'billing_expenses'`,
  );
  const billed = db
    .prepare(
      `SELECT b.kind, COUNT(*) n, COALESCE(SUM(b.minutes),0) minutes, COALESCE(SUM(b.amount_cents),0) cents
         FROM clio_import_map m JOIN clio_import_billed b ON b.id = m.lawdesk_id
        WHERE m.kind = 'activity' AND m.target = 'clio_import_billed' GROUP BY b.kind`,
    )
    .all() as { kind: string; n: number; minutes: number; cents: number }[];
  const bt = billed.find((b) => b.kind === "time") ?? { n: 0, minutes: 0, cents: 0 };
  const be = billed.find((b) => b.kind === "expense") ?? { n: 0, minutes: 0, cents: 0 };
  const lastTrust = db.prepare("SELECT run_id FROM clio_import_trust_balances ORDER BY run_id DESC LIMIT 1").get() as { run_id: number } | undefined;
  const trust = lastTrust
    ? one("SELECT COUNT(*) n, COALESCE(SUM(balance_cents),0) cents FROM clio_import_trust_balances WHERE run_id = ?", lastTrust.run_id)
    : null;
  return {
    counts: {
      people: count("user", "users"),
      contacts: count("contact", "contacts"),
      matters: count("matter", "matters"),
      tasks: count("task", "tasks"),
      calendar: count("event", "cal_events"),
      unbilledTimeEntries: time.n,
      unbilledExpenseEntries: exp.n,
      billedTimeEntries: bt.n,
      billedExpenseEntries: be.n,
    },
    money: {
      unbilledTimeMinutes: time.unbilled_minutes,
      unbilledTimeCents: time.unbilled_cents,
      nonBillableTimeMinutes: time.nonbillable_minutes,
      unbilledExpenseCents: exp.unbilled_cents,
      nonBillableExpenseCents: exp.nonbillable_cents,
      billedTimeMinutes: bt.minutes,
      billedTimeCents: bt.cents,
      billedExpenseCents: be.cents,
      /** Imported unbilled entries that have since been put on a Lawdesk invoice. */
      billedSinceImport: time.billed_in_lawdesk + exp.billed_in_lawdesk,
    },
    trust: trust ? { runId: lastTrust!.run_id, lines: trust.n, totalCents: trust.cents, note: TRUST_NOTE } : null,
  };
}
