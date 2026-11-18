// The firm overview: headline figures, small charts and "needs attention" lists.
//
// Every section is computed on its own and guarded: if a module's tables are missing
// (billing or conflicts not installed) or have no rows, that section comes back as
// `null` / empty and the rest of the dashboard still loads.

import type { DB } from "../db.ts";
import { daysBetween, type ISODate } from "../dates.ts";
import { Billing } from "../billing/billing.ts";
import { aging, billedVsCollected, unbilledTime } from "../billing/reports.ts";
import { productivityRows } from "./reports.ts";
import { BILLING_TABLES, addDays, addMonths, all, hasTables, localDate, monthLabel, monthStart, monthEnd, type Row } from "./util.ts";

/** How many days without any history entry make an open matter "quiet". */
export const QUIET_DAYS = 30;
/** Invoices more than this many days past due are listed. */
export const PAST_DUE_DAYS = 60;
/** The hours chart covers this many days ending today. */
export const HOURS_WINDOW_DAYS = 90;
const LIST_LIMIT = 8;

function guard<T>(fn: () => T, fallback: T, errors: string[], what: string): T {
  try {
    return fn();
  } catch (err: any) {
    errors.push(`${what}: ${err?.message ?? err}`);
    return fallback;
  }
}

export function dashboard(db: DB, today: ISODate) {
  const errors: string[] = [];
  const hasBilling = hasTables(db, ...BILLING_TABLES);
  const hasConflicts = hasTables(db, "conflicts_checks");
  const b = hasBilling ? new Billing(db, { today: () => today }) : null;
  const mStart = monthStart(today);

  // ------------------------------------------------------------- tasks
  const overdue = guard(
    () =>
      all(
        db,
        `SELECT t.assignee_id, u.name, COUNT(*) AS n, MIN(t.due_date) AS oldest FROM tasks t
         LEFT JOIN matters m ON m.id = t.matter_id LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.status = 'open' AND t.due_date < ? AND (m.id IS NULL OR m.status = 'open')
         GROUP BY t.assignee_id ORDER BY n DESC, u.name`,
        today,
      )
        .map((r) => ({ user_id: r.assignee_id, name: r.name ?? "Unassigned", count: r.n, oldest_due: r.oldest, days_late: daysBetween(r.oldest, today) }))
        // Most overdue first; "Unassigned" after the people with the same count.
        .sort((x, y) => y.count - x.count || (x.user_id == null ? 1 : 0) - (y.user_id == null ? 1 : 0) || x.name.localeCompare(y.name)),
    [] as Row[],
    errors,
    "Overdue tasks",
  );

  const openedThisMonth = guard(
    () => all(db, "SELECT COUNT(*) AS n FROM matters WHERE opened_on BETWEEN ? AND ?", mStart, today)[0].n as number,
    0,
    errors,
    "Matters opened",
  );

  // ----------------------------------------------------------- billing
  const unbilled = b ? guard(() => unbilledTime(b).totals, null, errors, "Unbilled time") : null;
  const ar = b ? guard(() => aging(b, today), null, errors, "Accounts receivable") : null;
  const month = b ? guard(() => billedVsCollected(b, mStart, today), null, errors, "This month") : null;

  const collections = b
    ? guard(
        () => {
          const out = [];
          for (let i = 11; i >= 0; i--) {
            const s = addMonths(mStart, -i);
            const e = i === 0 ? today : monthEnd(s);
            const r = billedVsCollected(b, s, e);
            out.push({ month: s.slice(0, 7), label: monthLabel(s, false), year: s.slice(0, 4), received_cents: r.cash_received_cents, billed_cents: r.billed_cents });
          }
          return out;
        },
        null,
        errors,
        "Collections by month",
      )
    : null;

  const hoursFrom = addDays(today, -(HOURS_WINDOW_DAYS - 1));
  const hours = b
    ? guard(
        () =>
          productivityRows({ db, today }, { from: hoursFrom, to: today, options: {} })
            .rows.filter((r) => r.worked || r.billed)
            .map((r) => ({ user_id: r.user_id, name: r.person, worked: r.worked, billable: r.billable, billed: r.billed })),
        null,
        errors,
        "Hours by person",
      )
    : null;

  const pastDue = ar
    ? ar.rows
        .flatMap((c) => c.invoices.map((i: Row) => ({ ...i, client_id: c.client_id, client_name: c.client_name })))
        .filter((i) => i.days_past_due > PAST_DUE_DAYS)
        .sort((x, y) => y.days_past_due - x.days_past_due)
    : [];
  if (b && pastDue.length) {
    const q = db.prepare("SELECT matter_id FROM billing_invoices WHERE id = ?");
    for (const i of pastDue) i.matter_id = (q.get(i.id) as Row | undefined)?.matter_id ?? null;
  }

  // ----------------------------------------------------------- matters
  const stages = guard(
    () => {
      const areas = all(db, "SELECT id, name FROM practice_areas ORDER BY name");
      const counts = all(
        db,
        "SELECT practice_area_id AS a, stage_id AS s, COUNT(*) AS n FROM matters WHERE status = 'open' GROUP BY practice_area_id, stage_id",
      );
      const n = (a: number | null, s: number | null) => counts.find((c) => c.a === a && c.s === s)?.n ?? 0;
      const out = areas.map((a) => {
        const st = all(db, "SELECT id, name FROM stages WHERE practice_area_id = ? ORDER BY position, id", a.id).map((s) => ({
          stage_id: s.id,
          name: s.name,
          count: n(a.id, s.id),
        }));
        const known = new Set(st.map((s) => s.stage_id));
        const other = counts.filter((c) => c.a === a.id && !known.has(c.s)).reduce((s, c) => s + c.n, 0);
        if (other) st.push({ stage_id: null, name: "No stage", count: other });
        return { practice_area_id: a.id, name: a.name, stages: st, total: st.reduce((s, x) => s + x.count, 0) };
      });
      const none = counts.filter((c) => c.a == null).reduce((s, c) => s + c.n, 0);
      if (none) out.push({ practice_area_id: null, name: "No practice area", stages: [{ stage_id: null, name: "No stage", count: none }], total: none });
      return out.filter((a) => a.total > 0);
    },
    [] as Row[],
    errors,
    "Matters by stage",
  );

  const quiet = guard(
    () => {
      const cutoff = addDays(today, -QUIET_DAYS);
      return all(
        db,
        `SELECT m.id, m.number, m.name, m.opened_on, c.name AS client_name, (SELECT MAX(a.at) FROM activity a WHERE a.matter_id = m.id) AS last_at
         FROM matters m LEFT JOIN contacts c ON c.id = m.client_id WHERE m.status = 'open'`,
      )
        .map((m) => ({ ...m, last_activity: m.last_at ? localDate(m.last_at) : null }))
        // Quiet = the last history entry (or, with none, the open date) is more than 30 days ago.
        .filter((m) => (m.last_activity ?? m.opened_on) < cutoff)
        .map((m) => ({ id: m.id, number: m.number, name: m.name, client_name: m.client_name, last_activity: m.last_activity, days_quiet: daysBetween(m.last_activity ?? m.opened_on, today) }))
        .sort((x, y) => y.days_quiet - x.days_quiet);
    },
    [] as Row[],
    errors,
    "Quiet matters",
  );

  const conflicts = hasConflicts
    ? guard(
        () =>
          all(
            db,
            `SELECT k.id, k.matter_id, k.run_at, k.terms, k.hit_count, m.number AS matter_number, m.name AS matter_name, u.name AS run_by_name
             FROM conflicts_checks k LEFT JOIN matters m ON m.id = k.matter_id LEFT JOIN users u ON u.id = k.run_by
             WHERE k.decision IS NULL ORDER BY k.run_at, k.id`,
          ).map((k) => {
            let names: string[] = [];
            try {
              const t = JSON.parse(k.terms);
              if (Array.isArray(t)) names = t.map((x) => (typeof x === "string" ? x : x?.name)).filter((x) => typeof x === "string");
            } catch {
              /* stored terms unreadable: show none */
            }
            return {
              id: k.id,
              matter_id: k.matter_id,
              matter_number: k.matter_number,
              matter_name: k.matter_name,
              run_on: localDate(k.run_at),
              run_by: k.run_by_name,
              names,
              hit_count: k.hit_count,
              days_waiting: daysBetween(localDate(k.run_at), today),
            };
          }),
        null as Row[] | null,
        errors,
        "Conflict checks",
      )
    : null;

  const overdueCount = overdue.reduce((s, r) => s + r.count, 0);
  return {
    today,
    month_start: mStart,
    available: { billing: hasBilling, conflicts: hasConflicts },
    tiles: {
      overdue_tasks: overdueCount,
      matters_opened: openedThisMonth,
      unbilled_time_cents: unbilled ? unbilled.value_cents : null,
      unbilled_minutes: unbilled ? unbilled.minutes : null,
      outstanding_cents: ar ? ar.totals.total : null,
      outstanding_invoices: ar ? ar.rows.reduce((s, c) => s + c.invoices.length, 0) : null,
      received_cents: month ? month.cash_received_cents : null,
    },
    charts: {
      collections,
      hours: hours ? { from: hoursFrom, to: today, people: hours } : null,
      aging: ar ? ar.totals : null,
      stages,
    },
    attention: {
      overdue_by_person: overdue,
      quiet_matters: { total: quiet.length, items: quiet.slice(0, LIST_LIMIT) },
      past_due_invoices: ar ? { total: pastDue.length, balance_cents: pastDue.reduce((s, i) => s + i.balance_cents, 0), items: pastDue.slice(0, LIST_LIMIT) } : null,
      undecided_conflicts: conflicts ? { total: conflicts.length, items: conflicts.slice(0, LIST_LIMIT) } : null,
    },
    settings: { quiet_days: QUIET_DAYS, past_due_days: PAST_DUE_DAYS, hours_window_days: HOURS_WINDOW_DAYS },
    errors,
  };
}
