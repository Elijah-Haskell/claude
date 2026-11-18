// Firm reports. Each report returns the same table shape (columns, rows, totals) plus the
// plain-English definition of every figure in it, so the screen, the CSV export and the
// print view all show the same numbers with the same explanation.
//
// Money figures come from the billing module and reuse its definitions in
// src/billing/reports.ts (billedVsCollected, aging, unbilledTime). Nothing here
// recomputes realization, collection or aging in a different way.

import type { DB } from "../db.ts";
import { daysBetween, type ISODate } from "../dates.ts";
import { EngineError } from "../engine.ts";
import { Billing } from "../billing/billing.ts";
import { aging, billedVsCollected, unbilledTime } from "../billing/reports.ts";
import {
  BILLING_TABLES,
  addDays,
  all,
  checkDate,
  hasTables,
  localDate,
  localTime,
  monthLabel,
  monthsIn,
  one,
  ratio,
  type Row,
} from "./util.ts";

export type ColumnType = "text" | "int" | "cents" | "minutes" | "ratio" | "date" | "links";

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
}

export interface Definition {
  term: string;
  meaning: string;
}

export interface ReportResult {
  key: string;
  title: string;
  /** What the date range means for this report, e.g. "Tasks due between". */
  period: string | null;
  filters: Filters;
  columns: Column[];
  /** Each row: values by column key, plus optional `_links` { columnKey: "#/..." }. */
  rows: Row[];
  totals: Row | null;
  definitions: Definition[];
  notes: string[];
  /** False when the data this report needs is not set up (e.g. billing is not installed). */
  available: boolean;
}

export interface Filters {
  from?: ISODate;
  to?: ISODate;
  userId?: number;
  matterId?: number;
  /** Report-specific options, e.g. status=open, view=invoice, q=search text. */
  options: Record<string, string>;
}

export interface ReportCtx {
  db: DB;
  today: ISODate;
}

type Range = "month" | "year" | "week" | "none" | "asof" | "quarter";

export interface ReportInfo {
  key: string;
  title: string;
  summary: string;
  /** Which filters the report uses. */
  uses: { dates: boolean; asOf?: boolean; person: boolean; matter: boolean };
  personLabel?: string;
  periodLabel?: string;
  defaultRange: Range;
  options?: { key: string; label: string; choices: { value: string; label: string }[]; default: string }[];
  search?: string;
  needsBilling?: boolean;
  run: (c: ReportCtx, f: Filters) => ReportResult;
}

// ---------------------------------------------------------------- helpers

function billingFor(c: ReportCtx): Billing | null {
  if (!hasTables(c.db, ...BILLING_TABLES)) return null;
  return new Billing(c.db, { today: () => c.today });
}

function result(info: ReportInfo, f: Filters, part: Partial<ReportResult>): ReportResult {
  return {
    key: info.key,
    title: info.title,
    period: info.uses.dates ? info.periodLabel ?? "Between" : null,
    filters: f,
    columns: [],
    rows: [],
    totals: null,
    definitions: [],
    notes: [],
    available: true,
    ...part,
  };
}

function unavailable(info: ReportInfo, f: Filters, why: string): ReportResult {
  return result(info, f, { available: false, notes: [why] });
}

const NO_BILLING = "Billing is not set up in this copy of Lawdesk, so there are no figures to show yet.";

function sum(rows: Row[], key: string): number {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

function matterLabel(m: Row): string {
  return m.number ? `${m.number} ${m.name}` : m.name;
}

/** Push "col BETWEEN from AND to" style conditions for whichever ends are set. */
function range(where: string[], p: any[], col: string, f: Filters) {
  if (f.from) (where.push(`${col} >= ?`), p.push(f.from));
  if (f.to) (where.push(`${col} <= ?`), p.push(f.to));
}

// ------------------------------------------------------------------ tasks

const TASKS: ReportInfo = {
  key: "tasks",
  title: "Task completion and on-time rate",
  summary: "For each person: how many of the tasks due in the period are done, and how many were done by their due date.",
  uses: { dates: true, person: true, matter: true },
  periodLabel: "Tasks due between",
  personLabel: "Assigned to",
  defaultRange: "month",
  run(c, f) {
    const where = ["t.status <> 'skipped'", "t.due_date IS NOT NULL"];
    const p: any[] = [];
    range(where, p, "t.due_date", f);
    if (f.userId) (where.push("t.assignee_id = ?"), p.push(f.userId));
    if (f.matterId) (where.push("t.matter_id = ?"), p.push(f.matterId));
    const tasks = all(
      c.db,
      `SELECT t.assignee_id, u.name AS user_name, t.status, t.due_date, t.completed_on FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id WHERE ${where.join(" AND ")}`,
      ...p,
    );
    const by = new Map<string, Row>();
    for (const t of tasks) {
      const k = String(t.assignee_id ?? 0);
      let r = by.get(k);
      if (!r) {
        r = { person: t.user_name ?? "Unassigned", user_id: t.assignee_id, due: 0, done: 0, on_time: 0, late: 0, open: 0, overdue: 0 };
        by.set(k, r);
      }
      r.due++;
      if (t.status === "done") {
        r.done++;
        if (t.completed_on && t.completed_on <= t.due_date) r.on_time++;
        else r.late++;
      } else {
        r.open++;
        if (t.status === "open" && t.due_date < c.today) r.overdue++;
      }
    }
    const finish = (r: Row) => ({ ...r, completion_rate: ratio(r.done, r.due), on_time_rate: ratio(r.on_time, r.done) });
    const rows = [...by.values()]
      .sort((a, b) => (a.user_id == null ? 1 : b.user_id == null ? -1 : a.person.localeCompare(b.person)))
      .map(finish);
    const totals = finish({ person: "All people", due: sum(rows, "due"), done: sum(rows, "done"), on_time: sum(rows, "on_time"), late: sum(rows, "late"), open: sum(rows, "open"), overdue: sum(rows, "overdue") });
    return result(TASKS, f, {
      columns: [
        { key: "person", label: "Person", type: "text" },
        { key: "due", label: "Tasks due", type: "int" },
        { key: "done", label: "Done", type: "int" },
        { key: "on_time", label: "Done on time", type: "int" },
        { key: "late", label: "Done late", type: "int" },
        { key: "open", label: "Not done yet", type: "int" },
        { key: "overdue", label: "Now overdue", type: "int" },
        { key: "completion_rate", label: "Completion rate", type: "ratio" },
        { key: "on_time_rate", label: "On-time rate", type: "ratio" },
      ],
      rows,
      totals: rows.length ? totals : null,
      definitions: [
        { term: "Tasks due", meaning: "Tasks with a due date in the period, assigned to the person. Skipped tasks and tasks with no due date are left out." },
        { term: "Done on time", meaning: "Marked done on or before the due date." },
        { term: "Done late", meaning: "Marked done after the due date." },
        { term: "Not done yet", meaning: "Still open, or still waiting on an earlier task." },
        { term: "Now overdue", meaning: "Not done, and the due date has passed (as of today)." },
        { term: "Completion rate", meaning: "Done ÷ tasks due." },
        { term: "On-time rate", meaning: "Done on time ÷ done. Tasks not yet done do not count either way; see “Now overdue” for those." },
      ],
      notes: ["Tasks count against the person they are assigned to now. A task reassigned after it was finished moves with it."],
    });
  },
};

// ---------------------------------------------------------------- matters

const MATTERS: ReportInfo = {
  key: "matters",
  title: "Matter list with stages and ages",
  summary: "Every matter with its stage, how long it has been open and how long it has been in its current stage.",
  uses: { dates: true, person: true, matter: false },
  periodLabel: "Opened between",
  personLabel: "Person on the matter",
  defaultRange: "none",
  options: [
    {
      key: "status",
      label: "Matters",
      default: "open",
      choices: [
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
        { value: "all", label: "Open and closed" },
      ],
    },
  ],
  run(c, f) {
    const status = f.options.status ?? "open";
    if (!["open", "closed", "all"].includes(status)) throw new EngineError("Status must be open, closed or all");
    const where: string[] = [];
    const p: any[] = [];
    if (status !== "all") (where.push("m.status = ?"), p.push(status));
    range(where, p, "m.opened_on", f);
    if (f.userId) (where.push("EXISTS (SELECT 1 FROM matter_roles r WHERE r.matter_id = m.id AND r.user_id = ?)"), p.push(f.userId));
    const ms = all(
      c.db,
      `SELECT m.*, c.name AS client_name, pa.name AS practice_area, s.name AS stage_name,
         (SELECT u.name FROM matter_roles r JOIN users u ON u.id = r.user_id WHERE r.matter_id = m.id AND r.role = 'attorney') AS attorney,
         (SELECT MAX(a.at) FROM activity a WHERE a.matter_id = m.id AND a.kind = 'stage_changed') AS stage_at,
         (SELECT MAX(a.at) FROM activity a WHERE a.matter_id = m.id) AS last_at,
         (SELECT COUNT(*) FROM tasks t WHERE t.matter_id = m.id AND t.status IN ('open','waiting')) AS open_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.matter_id = m.id AND t.status = 'open' AND t.due_date < ?) AS overdue_tasks
       FROM matters m LEFT JOIN contacts c ON c.id = m.client_id LEFT JOIN practice_areas pa ON pa.id = m.practice_area_id
       LEFT JOIN stages s ON s.id = m.stage_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.opened_on, m.id`,
      c.today,
      ...p,
    );
    const rows = ms.map((m) => {
      const end = m.status === "closed" && m.closed_on ? m.closed_on : c.today;
      const stageSince = m.stage_id == null ? null : m.stage_at ? localDate(m.stage_at) : m.opened_on;
      return {
        matter: matterLabel(m),
        client: m.client_name,
        practice_area: m.practice_area,
        stage: m.stage_name ?? (m.practice_area ? "No stage" : null),
        attorney: m.attorney,
        status: m.status === "open" ? "Open" : "Closed",
        opened_on: m.opened_on,
        closed_on: m.closed_on,
        age_days: Math.max(0, daysBetween(m.opened_on, end)),
        stage_days: m.status === "open" && stageSince ? Math.max(0, daysBetween(stageSince, c.today)) : null,
        open_tasks: m.open_tasks,
        overdue_tasks: m.overdue_tasks,
        last_activity: m.last_at ? localDate(m.last_at) : null,
        _links: { matter: `#/matters/${m.id}` },
      };
    });
    return result(MATTERS, f, {
      columns: [
        { key: "matter", label: "Matter", type: "text" },
        { key: "client", label: "Client", type: "text" },
        { key: "practice_area", label: "Practice area", type: "text" },
        { key: "stage", label: "Stage", type: "text" },
        { key: "attorney", label: "Attorney", type: "text" },
        { key: "status", label: "Status", type: "text" },
        { key: "opened_on", label: "Opened", type: "date" },
        { key: "age_days", label: "Age (days)", type: "int" },
        { key: "stage_days", label: "Days in stage", type: "int" },
        { key: "open_tasks", label: "Open tasks", type: "int" },
        { key: "overdue_tasks", label: "Overdue tasks", type: "int" },
        { key: "last_activity", label: "Last activity", type: "date" },
      ],
      rows,
      totals: rows.length ? { matter: `${rows.length} ${rows.length === 1 ? "matter" : "matters"}`, open_tasks: sum(rows, "open_tasks"), overdue_tasks: sum(rows, "overdue_tasks") } : null,
      definitions: [
        { term: "Age", meaning: "Days from the open date to today, or to the close date for a closed matter." },
        { term: "Days in stage", meaning: "Days since the matter last moved to its current stage (open matters only). If it has never moved, counted from the open date." },
        { term: "Attorney", meaning: "The person in the matter's attorney role." },
        { term: "Open tasks", meaning: "Tasks not yet done or skipped, including ones waiting on an earlier task." },
        { term: "Overdue tasks", meaning: "Open tasks whose due date has passed." },
        { term: "Last activity", meaning: "The most recent entry in the matter's history: a task change, a stage move, a billing entry and so on." },
      ],
    });
  },
};

// ----------------------------------------------------------- productivity

/** Billed time per person (or matter) from finalized invoices, by the line's work date. */
function billedTime(db: DB, f: Filters, groupBy: "user" | "matter"): Map<number, { minutes: number; cents: number }> {
  const where = ["i.status = 'final'", "l.kind = 'time'", "l.no_charge_note IS NULL"];
  const p: any[] = [];
  range(where, p, "l.date", f);
  if (f.userId) (where.push("l.user_id = ?"), p.push(f.userId));
  if (f.matterId) (where.push("i.matter_id = ?"), p.push(f.matterId));
  const key = groupBy === "user" ? "l.user_id" : "i.matter_id";
  const rows = all(
    db,
    `SELECT ${key} AS k, COALESCE(SUM(l.minutes),0) AS minutes, COALESCE(SUM(l.amount_cents - l.writedown_cents),0) AS cents
     FROM billing_invoice_lines l JOIN billing_invoices i ON i.id = l.invoice_id
     WHERE ${where.join(" AND ")} GROUP BY ${key}`,
    ...p,
  );
  return new Map(rows.map((r) => [r.k, { minutes: r.minutes, cents: r.cents }]));
}

const HOURS_DEFS: Definition[] = [
  { term: "Hours worked", meaning: "All time recorded with a work date in the period, billable or not, as entered (before rounding)." },
  { term: "Billable hours", meaning: "The part of hours worked marked billable." },
  {
    term: "Billed hours",
    meaning:
      "Hours on finalized invoices for work dated in the period, as charged: each entry is rounded up to the firm's billing increment, so this can be a little more than the hours worked. Time on flat-fee or contingency matters is shown on invoices at no charge and is not counted. Void invoices are left out.",
  },
  { term: "Billed value", meaning: "The fees for those billed hours after any write-downs, before invoice discounts and tax." },
];

export function productivityRows(c: ReportCtx, f: Filters): { rows: Row[]; billing: boolean } {
  const b = hasTables(c.db, ...BILLING_TABLES);
  const people = new Map<number, Row>();
  const blank = (id: number, name: string) => ({ person: name, user_id: id, worked: 0, billable: 0, billed: 0, billed_cents: 0 });
  const activeWhere = f.userId ? "id = ?" : "active = 1";
  for (const u of all(c.db, `SELECT id, name FROM users WHERE ${activeWhere} ORDER BY name, id`, ...(f.userId ? [f.userId] : []))) people.set(u.id, blank(u.id, u.name));
  if (!b) return { rows: [...people.values()], billing: false };
  const where: string[] = [];
  const p: any[] = [];
  range(where, p, "t.date", f);
  if (f.userId) (where.push("t.user_id = ?"), p.push(f.userId));
  if (f.matterId) (where.push("t.matter_id = ?"), p.push(f.matterId));
  const worked = all(
    c.db,
    `SELECT t.user_id, u.name, COALESCE(SUM(t.minutes),0) AS worked, COALESCE(SUM(CASE WHEN t.billable = 1 THEN t.minutes ELSE 0 END),0) AS billable
     FROM billing_time_entries t JOIN users u ON u.id = t.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY t.user_id`,
    ...p,
  );
  for (const w of worked) {
    if (!people.has(w.user_id)) people.set(w.user_id, blank(w.user_id, w.name));
    Object.assign(people.get(w.user_id)!, { worked: w.worked, billable: w.billable });
  }
  for (const [uid, v] of billedTime(c.db, f, "user")) {
    if (uid == null) continue;
    if (!people.has(uid)) {
      const u = one(c.db, "SELECT name FROM users WHERE id = ?", uid);
      people.set(uid, blank(uid, u?.name ?? "Unknown"));
    }
    Object.assign(people.get(uid)!, { billed: v.minutes, billed_cents: v.cents });
  }
  return { rows: [...people.values()].sort((a, b) => a.person.localeCompare(b.person)), billing: true };
}

const PRODUCTIVITY: ReportInfo = {
  key: "productivity",
  title: "Productivity by person",
  summary: "Hours worked, billable and billed for each person.",
  uses: { dates: true, person: true, matter: true },
  periodLabel: "Work dated between",
  personLabel: "Person",
  defaultRange: "month",
  needsBilling: true,
  run(c, f) {
    const { rows, billing } = productivityRows(c, f);
    if (!billing) return unavailable(PRODUCTIVITY, f, NO_BILLING);
    const withRates = rows.map((r) => ({ ...r, billable_share: ratio(r.billable, r.worked), billed_share: ratio(r.billed, r.billable) }));
    const t = { person: "All people", worked: sum(rows, "worked"), billable: sum(rows, "billable"), billed: sum(rows, "billed"), billed_cents: sum(rows, "billed_cents") };
    return result(PRODUCTIVITY, f, {
      columns: [
        { key: "person", label: "Person", type: "text" },
        { key: "worked", label: "Hours worked", type: "minutes" },
        { key: "billable", label: "Billable hours", type: "minutes" },
        { key: "billable_share", label: "Billable share", type: "ratio" },
        { key: "billed", label: "Billed hours", type: "minutes" },
        { key: "billed_share", label: "Billed ÷ billable", type: "ratio" },
        { key: "billed_cents", label: "Billed value", type: "cents" },
      ],
      rows: withRates,
      totals: { ...t, billable_share: ratio(t.billable, t.worked), billed_share: ratio(t.billed, t.billable) },
      definitions: [
        ...HOURS_DEFS,
        { term: "Billable share", meaning: "Billable hours ÷ hours worked." },
        { term: "Billed ÷ billable", meaning: "Billed hours ÷ billable hours. Below 100% usually means billable work is not invoiced yet, or was left off an invoice." },
      ],
    });
  },
};

// ---------------------------------------------------------------- revenue

const REVENUE: ReportInfo = {
  key: "revenue",
  title: "Revenue: billed and collected",
  summary: "Month by month: what was billed, what has been collected on those invoices, and cash received.",
  uses: { dates: true, person: false, matter: false },
  periodLabel: "Invoices and payments dated between",
  defaultRange: "year",
  needsBilling: true,
  run(c, f) {
    const b = billingFor(c);
    if (!b) return unavailable(REVENUE, f, NO_BILLING);
    const from = f.from ?? c.today.slice(0, 4) + "-01-01";
    const to = f.to ?? c.today;
    if (from > to) throw new EngineError("The start of the period is after its end");
    const shape = (r: ReturnType<typeof billedVsCollected>, label: string) => ({
      month: label,
      invoices: r.invoices,
      standard_cents: r.standard_cents,
      adjustments_cents: r.written_down_cents + r.discount_cents,
      billed_cents: r.billed_cents,
      invoiced_total_cents: r.invoiced_total_cents,
      collected_cents: r.collected_cents,
      realization_rate: r.realization_rate,
      collection_rate: r.collection_rate,
      cash_received_cents: r.cash_received_cents,
      written_off_cents: r.written_off_cents,
    });
    const rows = monthsIn(from, to).map((m) => shape(billedVsCollected(b, m.from, m.to), monthLabel(m.from)));
    const totals = shape(billedVsCollected(b, from, to), "Whole period");
    return result(REVENUE, f, {
      columns: [
        { key: "month", label: "Month", type: "text" },
        { key: "invoices", label: "Invoices", type: "int" },
        { key: "standard_cents", label: "Standard value", type: "cents" },
        { key: "adjustments_cents", label: "Write-downs and discounts", type: "cents" },
        { key: "billed_cents", label: "Billed", type: "cents" },
        { key: "invoiced_total_cents", label: "Invoiced incl. tax", type: "cents" },
        { key: "collected_cents", label: "Collected so far", type: "cents" },
        { key: "realization_rate", label: "Realization rate", type: "ratio" },
        { key: "collection_rate", label: "Collection rate", type: "ratio" },
        { key: "cash_received_cents", label: "Payments received", type: "cents" },
        { key: "written_off_cents", label: "Written off", type: "cents" },
      ],
      rows,
      totals,
      definitions: [
        { term: "Invoices", meaning: "Finalized invoices dated in the month. Invoices that have since been voided are left out." },
        { term: "Standard value", meaning: "What the work on those invoices was worth at the normal rates, before any write-down or discount." },
        { term: "Write-downs and discounts", meaning: "Reductions made on those invoices: line write-downs plus invoice discounts." },
        { term: "Billed", meaning: "Fees and expenses charged on those invoices after write-downs and discounts, not counting sales tax." },
        { term: "Invoiced incl. tax", meaning: "The invoice totals, including any sales tax." },
        { term: "Collected so far", meaning: "Payments and client credit applied to those invoices up to today." },
        { term: "Realization rate", meaning: "Billed ÷ standard value. 100% means everything was billed at the normal rate; 90% means a tenth was written down or discounted." },
        { term: "Collection rate", meaning: "Collected so far ÷ invoiced including tax. Write-offs do not count as collected." },
        { term: "Payments received", meaning: "Money received from clients in the month (not voided), whichever invoices it paid." },
        { term: "Written off", meaning: "Unpaid balances written off in the month as uncollectible." },
      ],
      notes: [
        "The “Whole period” line is worked out over the whole range at once, so its rates are not an average of the monthly rates.",
        "These are the same figures and definitions the billing screens use.",
      ],
    });
  },
};

// ------------------------------------------------------------------ aging

const AGING: ReportInfo = {
  key: "aging",
  title: "Accounts receivable aging",
  summary: "Unpaid invoice balances by how far past due they are, by client or by invoice.",
  uses: { dates: false, asOf: true, person: false, matter: false },
  defaultRange: "asof",
  needsBilling: true,
  options: [
    {
      key: "view",
      label: "Show",
      default: "client",
      choices: [
        { value: "client", label: "By client" },
        { value: "invoice", label: "By invoice" },
      ],
    },
  ],
  run(c, f) {
    const b = billingFor(c);
    if (!b) return unavailable(AGING, f, NO_BILLING);
    const asOf = f.to ?? c.today;
    const a = aging(b, asOf);
    const defs: Definition[] = [
      { term: "Balance", meaning: "What is still owed on a finalized invoice as of the date: its total less payments and credit applied and amounts written off." },
      { term: "Current", meaning: "Not yet past its due date." },
      { term: "1–30, 31–60, 61–90, Over 90", meaning: "Days past the invoice's due date." },
    ];
    const notes = [`Balances as of ${asOf}. Payments, write-offs and voids after that date are not counted.`];
    const bucketCols: Column[] = [
      { key: "current", label: "Current", type: "cents" },
      { key: "d1_30", label: "1–30 days", type: "cents" },
      { key: "d31_60", label: "31–60 days", type: "cents" },
      { key: "d61_90", label: "61–90 days", type: "cents" },
      { key: "d90_plus", label: "Over 90 days", type: "cents" },
      { key: "total", label: "Total owed", type: "cents" },
    ];
    if ((f.options.view ?? "client") === "invoice") {
      const rows: Row[] = [];
      for (const cl of a.rows) {
        for (const i of cl.invoices) {
          const mid = one(c.db, "SELECT matter_id FROM billing_invoices WHERE id = ?", i.id)?.matter_id;
          rows.push({
            invoice: i.number != null ? `Invoice ${i.number}` : `Invoice #${i.id}`,
            client: cl.client_name,
            matter: i.matter_name,
            issued_on: i.issued_on,
            due_on: i.due_on,
            days_past_due: i.days_past_due,
            balance_cents: i.balance_cents,
            _links: mid ? { matter: `#/matters/${mid}` } : {},
          });
        }
      }
      rows.sort((x, y) => y.days_past_due - x.days_past_due || x.client.localeCompare(y.client));
      return result(AGING, f, {
        columns: [
          { key: "invoice", label: "Invoice", type: "text" },
          { key: "client", label: "Client", type: "text" },
          { key: "matter", label: "Matter", type: "text" },
          { key: "issued_on", label: "Dated", type: "date" },
          { key: "due_on", label: "Due", type: "date" },
          { key: "days_past_due", label: "Days past due", type: "int" },
          { key: "balance_cents", label: "Balance", type: "cents" },
        ],
        rows,
        totals: rows.length ? { invoice: `${rows.length} unpaid`, balance_cents: a.totals.total } : null,
        definitions: defs,
        notes,
      });
    }
    const rows = a.rows.map((r) => ({ client: r.client_name, ...pick(r, "current", "d1_30", "d31_60", "d61_90", "d90_plus", "total"), credit_cents: r.credit_cents }));
    return result(AGING, f, {
      columns: [{ key: "client", label: "Client", type: "text" }, ...bucketCols, { key: "credit_cents", label: "Unused credit", type: "cents" }],
      rows,
      totals: rows.length ? { client: "All clients", ...a.totals, credit_cents: sum(rows, "credit_cents") } : null,
      definitions: [...defs, { term: "Unused credit", meaning: "Money the client has paid that is not yet applied to any invoice. It is not subtracted from the balances." }],
      notes,
    });
  },
};

function pick(r: Row, ...keys: string[]): Row {
  return Object.fromEntries(keys.map((k) => [k, r[k]]));
}

// ---------------------------------------------------------- time by matter

const TIME_BY_MATTER: ReportInfo = {
  key: "time-by-matter",
  title: "Time by matter",
  summary: "Hours worked on each matter, how much is billable, how much has been billed and the value not yet billed.",
  uses: { dates: true, person: true, matter: true },
  periodLabel: "Work dated between",
  personLabel: "Worked by",
  defaultRange: "month",
  needsBilling: true,
  run(c, f) {
    const b = billingFor(c);
    if (!b) return unavailable(TIME_BY_MATTER, f, NO_BILLING);
    const where: string[] = [];
    const p: any[] = [];
    range(where, p, "t.date", f);
    if (f.userId) (where.push("t.user_id = ?"), p.push(f.userId));
    if (f.matterId) (where.push("t.matter_id = ?"), p.push(f.matterId));
    const worked = all(
      c.db,
      `SELECT t.matter_id, COALESCE(SUM(t.minutes),0) AS worked, COALESCE(SUM(CASE WHEN t.billable = 1 THEN t.minutes ELSE 0 END),0) AS billable
       FROM billing_time_entries t ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY t.matter_id`,
      ...p,
    );
    const billed = billedTime(c.db, f, "matter");
    const unbilled = unbilledTime(b, { from: f.from, to: f.to, userId: f.userId, matterId: f.matterId });
    const ids = new Set<number>([...worked.map((w) => w.matter_id), ...billed.keys(), ...unbilled.rows.map((u) => u.matter_id)]);
    const rows: Row[] = [];
    for (const id of ids) {
      const m = one(
        c.db,
        `SELECT m.*, c.name AS client_name, COALESCE(bm.method,'hourly') AS method FROM matters m LEFT JOIN contacts c ON c.id = m.client_id
         LEFT JOIN billing_matters bm ON bm.matter_id = m.id WHERE m.id = ?`,
        id,
      );
      if (!m) continue;
      const w = worked.find((x) => x.matter_id === id);
      const u = unbilled.rows.filter((x) => x.matter_id === id);
      rows.push({
        matter: matterLabel(m),
        client: m.client_name,
        method: { hourly: "Hourly", flat: "Flat fee", contingency: "Contingency" }[m.method as string] ?? m.method,
        worked: w?.worked ?? 0,
        billable: w?.billable ?? 0,
        nonbillable: (w?.worked ?? 0) - (w?.billable ?? 0),
        billed: billed.get(id)?.minutes ?? 0,
        billed_cents: billed.get(id)?.cents ?? 0,
        unbilled: u.reduce((s, x) => s + x.minutes, 0),
        unbilled_cents: u.reduce((s, x) => s + x.value_cents, 0),
        _links: { matter: `#/matters/${m.id}` },
      });
    }
    rows.sort((x, y) => y.worked - x.worked || x.matter.localeCompare(y.matter));
    const keys = ["worked", "billable", "nonbillable", "billed", "billed_cents", "unbilled", "unbilled_cents"];
    return result(TIME_BY_MATTER, f, {
      columns: [
        { key: "matter", label: "Matter", type: "text" },
        { key: "client", label: "Client", type: "text" },
        { key: "method", label: "Billed as", type: "text" },
        { key: "worked", label: "Hours worked", type: "minutes" },
        { key: "billable", label: "Billable hours", type: "minutes" },
        { key: "nonbillable", label: "Non-billable hours", type: "minutes" },
        { key: "billed", label: "Billed hours", type: "minutes" },
        { key: "billed_cents", label: "Billed value", type: "cents" },
        { key: "unbilled", label: "Unbilled hours", type: "minutes" },
        { key: "unbilled_cents", label: "Unbilled value", type: "cents" },
      ],
      rows,
      totals: rows.length ? { matter: "All matters", ...Object.fromEntries(keys.map((k) => [k, sum(rows, k)])) } : null,
      definitions: [
        ...HOURS_DEFS,
        { term: "Non-billable hours", meaning: "Hours worked not marked billable." },
        {
          term: "Unbilled hours and value",
          meaning:
            "Billable time not yet on a finalized invoice (time on a draft invoice still counts), and what it would bill at the entry's rate after rounding. On flat-fee and contingency matters the value is $0 because time is not charged by the hour.",
        },
      ],
    });
  },
};

// ---------------------------------------------------------------- clients

const CLIENTS: ReportInfo = {
  key: "clients",
  title: "Client list with matters",
  summary: "Every client, how to reach them, their matters and what they owe.",
  uses: { dates: false, person: true, matter: false },
  personLabel: "Person on a matter",
  defaultRange: "none",
  run(c, f) {
    const b = billingFor(c);
    const p: any[] = [];
    let roleCond = "";
    if (f.userId) {
      roleCond = "AND EXISTS (SELECT 1 FROM matter_roles r WHERE r.matter_id = m.id AND r.user_id = ?)";
      p.push(f.userId);
    }
    const ms = all(
      c.db,
      `SELECT m.id, m.number, m.name, m.status, m.opened_on, m.client_id, c.name AS client_name, c.kind, c.email, c.phone
       FROM matters m JOIN contacts c ON c.id = m.client_id WHERE 1 = 1 ${roleCond} ORDER BY c.name, c.id, m.status DESC, m.opened_on, m.id`,
      ...p,
    );
    const owed = new Map<number, number>();
    if (b) for (const r of aging(b).rows) owed.set(r.client_id, r.total);
    const by = new Map<number, Row>();
    for (const m of ms) {
      let r = by.get(m.client_id);
      if (!r) {
        r = {
          client: m.client_name,
          kind: m.kind === "company" ? "Company" : "Person",
          email: m.email,
          phone: m.phone,
          open: 0,
          closed: 0,
          matters: [] as Row[],
          first_opened: m.opened_on,
          owed_cents: b ? owed.get(m.client_id) ?? 0 : null,
        };
        by.set(m.client_id, r);
      }
      r[m.status === "open" ? "open" : "closed"]++;
      r.matters.push({ label: matterLabel(m) + (m.status === "closed" ? " (closed)" : ""), href: `#/matters/${m.id}` });
      if (m.opened_on < r.first_opened) r.first_opened = m.opened_on;
    }
    const rows = [...by.values()];
    const cols: Column[] = [
      { key: "client", label: "Client", type: "text" },
      { key: "kind", label: "Type", type: "text" },
      { key: "email", label: "Email", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "open", label: "Open matters", type: "int" },
      { key: "closed", label: "Closed matters", type: "int" },
      { key: "matters", label: "Matters", type: "links" },
      { key: "first_opened", label: "Client since", type: "date" },
    ];
    if (b) cols.push({ key: "owed_cents", label: "Owed now", type: "cents" });
    return result(CLIENTS, f, {
      columns: cols,
      rows,
      totals: rows.length ? { client: `${rows.length} ${rows.length === 1 ? "client" : "clients"}`, open: sum(rows, "open"), closed: sum(rows, "closed"), ...(b ? { owed_cents: sum(rows, "owed_cents") } : {}) } : null,
      definitions: [
        { term: "Client", meaning: "A contact who is the client on at least one matter." },
        { term: "Client since", meaning: "The open date of the client's earliest matter." },
        ...(b ? [{ term: "Owed now", meaning: "Unpaid balances on the client's finalized invoices as of today (the same figure as the aging report's total)." }] : []),
      ],
      notes: f.userId ? ["Only matters where the chosen person has a role are listed."] : [],
    });
  },
};

// --------------------------------------------------------------- activity

const KIND_LABELS: Record<string, string> = {
  matter_opened: "Opened a matter",
  matter_closed: "Closed a matter",
  matter_reopened: "Reopened a matter",
  stage_changed: "Moved a matter's stage",
  date_changed: "Changed a key date",
  role_changed: "Changed who is on a matter",
  checklist_applied: "Added a checklist",
  checklist_done: "Finished a checklist",
  checklist_updated: "Edited a checklist",
  task_added: "Added a task",
  task_updated: "Changed a task",
  task_done: "Finished a task",
  task_skipped: "Skipped a task",
  task_reopened: "Reopened a task",
  task_deleted: "Deleted a task",
  automation: "Automatic step",
  automation_stopped: "Automatic steps stopped",
};

export function kindLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  const s = kind.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : kind;
}

export const ACTIVITY_LIMIT = 1000;

const ACTIVITY: ReportInfo = {
  key: "activity",
  title: "Activity log",
  summary: "Who did what and when, across the firm. Search by person, matter, kind of change or words in the description.",
  uses: { dates: true, person: true, matter: true },
  periodLabel: "Between",
  personLabel: "Done by",
  defaultRange: "week",
  search: "Words in the description",
  options: [{ key: "kind", label: "Kind of change", default: "", choices: [] }],
  run(c, f) {
    const where: string[] = [];
    const p: any[] = [];
    // `at` is a UTC timestamp. Widen the SQL range by a day each side, then keep the rows
    // whose firm-time-zone date falls in the period.
    if (f.from) (where.push("a.at >= ?"), p.push(addDays(f.from, -1)));
    if (f.to) (where.push("a.at < ?"), p.push(addDays(f.to, 2)));
    if (f.userId) (where.push("a.user_id = ?"), p.push(f.userId));
    if (f.matterId) (where.push("a.matter_id = ?"), p.push(f.matterId));
    if (f.options.kind) (where.push("a.kind = ?"), p.push(f.options.kind));
    const q = (f.options.q ?? "").trim();
    if (q) {
      where.push("a.detail LIKE ? ESCAPE '\\'");
      p.push(`%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`);
    }
    const raw = all(
      c.db,
      `SELECT a.*, u.name AS user_name, m.number AS matter_number, m.name AS matter_name FROM activity a
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN matters m ON m.id = a.matter_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.at DESC, a.id DESC`,
      ...p,
    );
    const inRange = raw.filter((a) => {
      const d = localDate(a.at);
      return (!f.from || d >= f.from) && (!f.to || d <= f.to);
    });
    const rows = inRange.slice(0, ACTIVITY_LIMIT).map((a) => ({
      date: localDate(a.at),
      time: localTime(a.at),
      who: a.user_name ?? "Not recorded",
      matter: a.matter_id ? matterLabel({ number: a.matter_number, name: a.matter_name }) : null,
      what: kindLabel(a.kind),
      detail: a.detail,
      _links: a.matter_id ? { matter: `#/matters/${a.matter_id}` } : {},
    }));
    return result(ACTIVITY, f, {
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "time", label: "Time", type: "text" },
        { key: "who", label: "Who", type: "text" },
        { key: "what", label: "What", type: "text" },
        { key: "matter", label: "Matter", type: "text" },
        { key: "detail", label: "Details", type: "text" },
      ],
      rows,
      totals: null,
      definitions: [
        { term: "Who", meaning: "The person Lawdesk recorded as making the change. “Not recorded” means an automatic step, or a change made before people were set up." },
        { term: "Date and time", meaning: "When the change was made, in Kansas (Central) time." },
      ],
      notes: [
        inRange.length > ACTIVITY_LIMIT
          ? `${inRange.length.toLocaleString("en-US")} entries match; showing the newest ${ACTIVITY_LIMIT.toLocaleString("en-US")}. Narrow the dates or filters to see the rest.`
          : `${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "entry" : "entries"}, newest first.`,
      ],
    });
  },
};

export const REPORTS: ReportInfo[] = [TASKS, MATTERS, PRODUCTIVITY, REVENUE, AGING, TIME_BY_MATTER, CLIENTS, ACTIVITY];

export function reportInfo(key: string): ReportInfo {
  const r = REPORTS.find((x) => x.key === key);
  if (!r) throw new EngineError("No such report", 404);
  return r;
}

/** Default date range for a report, as of `today`. */
export function defaultRange(r: ReportInfo, today: ISODate): { from?: ISODate; to?: ISODate } {
  switch (r.defaultRange) {
    case "month":
      return { from: today.slice(0, 8) + "01", to: today };
    case "quarter": {
      const m = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
      return { from: `${today.slice(0, 4)}-${String(m).padStart(2, "0")}-01`, to: today };
    }
    case "year":
      return { from: today.slice(0, 4) + "-01-01", to: today };
    case "week":
      return { from: addDays(today, -6), to: today };
    case "asof":
      return { to: today };
    default:
      return {};
  }
}

/** Run a report, filling in its default range when no dates were given. */
export function runReport(c: ReportCtx, key: string, f: Filters, opts: { useDefaults?: boolean } = {}): ReportResult {
  const r = reportInfo(key);
  const g: Filters = { ...f, options: { ...f.options } };
  if (opts.useDefaults !== false && g.from == null && g.to == null) Object.assign(g, defaultRange(r, c.today));
  if (!r.uses.dates) {
    if (!r.uses.asOf) delete g.to;
    delete g.from;
  }
  if (!r.uses.person) delete g.userId;
  if (!r.uses.matter) delete g.matterId;
  if (g.from && g.to && g.from > g.to) throw new EngineError("The start of the period is after its end");
  for (const o of r.options ?? []) if (g.options[o.key] == null || g.options[o.key] === "") g.options[o.key] = o.default;
  return r.run(c, g);
}
