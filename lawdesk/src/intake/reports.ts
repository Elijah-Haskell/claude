// Intake reports: where leads come from, how many become clients, and how long that takes.
// Each figure carries a plain-English definition so the numbers can't be misread.

import { daysBetween, isISODate, addDays } from "../dates.ts";
import { STATUSES } from "./schema.ts";
import { type Intake, bad } from "./leads.ts";

type Row = Record<string, any>;

export const DEFINITIONS = {
  leads: "Leads received: people who contacted the firm (by form, booking or entered by staff) with a received date in the period.",
  conversion:
    "Conversion rate: of the leads received in the period, the share that have become clients so far. Leads still in progress count against the rate until they are decided, so recent periods look lower until those leads are decided.",
  decidedConversion: "Decided conversion: of the leads received in the period that have been decided (hired or not hired), the share that hired the firm.",
  timeToHire: "Time to hire: for leads that became clients during the period, the number of calendar days from the day the lead came in to the day it was converted. The middle value (median) is shown, with the average and range.",
  bySource: "By source: how the person said they heard about the firm. Leads with no answer are listed as “Not given”.",
  notHired: "Not hired: leads received in the period that were closed without becoming clients, by the reason recorded.",
} as const;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function intakeReport(it: Intake, opts: { from?: string | null; to?: string | null } = {}) {
  const to = opts.to || it.today();
  const from = opts.from || addDays(to, -89);
  if (!isISODate(from) || !isISODate(to)) bad("Dates must look like 2026-01-31");
  if (from > to) bad("The start date is after the end date");
  const leads = it.all("SELECT * FROM intake_leads WHERE received_on BETWEEN ? AND ?", from, to);
  const hired = leads.filter((l) => l.status === "hired");
  const notHired = leads.filter((l) => l.status === "not_hired");

  const sources = new Map<string, { leads: number; hired: number; notHired: number }>();
  for (const l of leads) {
    const k = l.source || "Not given";
    const s = sources.get(k) ?? { leads: 0, hired: 0, notHired: 0 };
    s.leads++;
    if (l.status === "hired") s.hired++;
    if (l.status === "not_hired") s.notHired++;
    sources.set(k, s);
  }
  const bySource = [...sources.entries()]
    .map(([source, s]) => ({ source, ...s, open: s.leads - s.hired - s.notHired, conversionPct: pct(s.hired, s.leads) }))
    .sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));

  const reasons = new Map<string, number>();
  for (const l of notHired) {
    const r = String(l.not_hired_reason || "No reason recorded").split(":")[0];
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  // Time to hire looks at leads hired in the period, whenever they came in.
  const hiredInPeriod = it.all("SELECT received_on, hired_on FROM intake_leads WHERE status = 'hired' AND hired_on BETWEEN ? AND ?", from, to);
  const days = hiredInPeriod.map((l) => daysBetween(l.received_on, l.hired_on));

  const byArea = it.all(
    `SELECT COALESCE(pa.name, 'No practice area') AS area, COUNT(*) AS leads, SUM(l.status = 'hired') AS hired
     FROM intake_leads l LEFT JOIN practice_areas pa ON pa.id = l.practice_area_id
     WHERE l.received_on BETWEEN ? AND ? GROUP BY area ORDER BY leads DESC, area`,
    from,
    to,
  ).map((r: Row) => ({ area: r.area, leads: r.leads, hired: r.hired ?? 0, conversionPct: pct(r.hired ?? 0, r.leads) }));

  const pipeline = STATUSES.map((s) => ({
    status: s.key,
    label: s.label,
    count: it.one("SELECT COUNT(*) AS n FROM intake_leads WHERE status = ?", s.key)!.n as number,
  }));

  return {
    from,
    to,
    definitions: DEFINITIONS,
    totals: {
      leads: leads.length,
      hired: hired.length,
      notHired: notHired.length,
      open: leads.length - hired.length - notHired.length,
      conversionPct: pct(hired.length, leads.length),
      decidedConversionPct: pct(hired.length, hired.length + notHired.length),
    },
    timeToHire: {
      count: days.length,
      medianDays: median(days),
      averageDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
      fastestDays: days.length ? Math.min(...days) : null,
      slowestDays: days.length ? Math.max(...days) : null,
    },
    bySource,
    byArea,
    notHiredReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    pipeline,
  };
}
