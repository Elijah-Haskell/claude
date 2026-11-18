// Kansas time computation under K.S.A. 60-206 (Kansas state courts, Chapter 60 civil procedure).
// Source: https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html (current text, history
// ends "L. 2020, ch. 4, § 3; March 19."). Each rule below quotes the subsection it implements.
//
// THIS IS AN AID, NOT LEGAL ADVICE. A lawyer must check every date it produces.

import { type ISODate, addDays, isISODate } from "../dates.ts";
import type { TaskInput, Priority } from "../engine.ts";
import { type Holiday, HolidayCalendar, YEARS_WITH_COURT_ORDER, SOURCES, checkYear } from "./holidays.ts";

export const DISCLAIMER =
  "VERIFY THIS DATE. This is a calculation aid, not legal advice. A lawyer must check every deadline " +
  "against the current statute, Supreme Court rules, local rules and any order in the case: local rules " +
  "and court orders can shorten or lengthen a period, and the court may extend or change it. The holiday " +
  "list may be incomplete (presidential declarations and Kansas Supreme Court orders not loaded here). " +
  "Kansas state courts only: federal court (U.S. District Court for the District of Kansas, which uses " +
  "Fed. R. Civ. P. 6 and its own local rules) is NOT covered, nor are criminal, appellate-rule or " +
  "administrative-agency periods unless a rule here says so.";

export class DeadlineError extends Error {
  status = 400;
}

export type Direction = "after" | "before";

/**
 * How the paper was served, by K.S.A. 60-205(b)(2)
 * (https://ksrevisor.gov/statutes/chapters/ch60/060_002_0005.html):
 *   hand        (A) "Handing it to the person"
 *   leaving     (B) leaving it at the person's office or dwelling
 *   mail        (C) "mailing it to the person's last known address, in which event service is complete upon mailing"
 *   clerk       (D) "leaving it with the court clerk if the person has no known address"
 *   fax         (E) "sending it by telefacsimile communication"
 *   electronic  (F) "serving it by electronic means when authorized by supreme court rule or a local rule"
 * Only (C) and (D) get the 3 extra days under 60-206(d).
 */
export type ServiceMethod = "hand" | "leaving" | "mail" | "clerk" | "fax" | "electronic";
export const SERVICE_METHODS: ServiceMethod[] = ["hand", "leaving", "mail", "clerk", "fax", "electronic"];
const ADDS_THREE_DAYS = new Set<ServiceMethod>(["mail", "clerk"]);
const SERVICE_LABEL: Record<ServiceMethod, string> = {
  hand: "hand delivery, K.S.A. 60-205(b)(2)(A)",
  leaving: "leaving it at the office or dwelling, K.S.A. 60-205(b)(2)(B)",
  mail: "mail, K.S.A. 60-205(b)(2)(C)",
  clerk: "leaving it with the court clerk, K.S.A. 60-205(b)(2)(D)",
  fax: "fax, K.S.A. 60-205(b)(2)(E)",
  electronic: "electronic service, K.S.A. 60-205(b)(2)(F)",
};

export interface ComputeInput {
  /** The day of the triggering event, "YYYY-MM-DD"; for an hours period "YYYY-MM-DDTHH:MM" (court's local time). */
  trigger: string;
  /** Period in days. Give exactly one of days or hours. */
  days?: number;
  /** Period in hours. */
  hours?: number;
  /** "after" (default) = the period runs after the event; "before" = it is counted back from the event (e.g. a hearing). */
  direction?: Direction;
  /** How the triggering paper was served, if the period runs from service. */
  serviceMethod?: ServiceMethod | null;
  /** Days the clerk's office was or will be inaccessible (K.S.A. 60-206(a)(3)), e.g. a weather closure. */
  courtClosedDays?: ISODate[];
  /** Further legal holidays (a presidential declaration, a Supreme Court order not loaded here). */
  extraHolidays?: { date: ISODate; name?: string; source?: string }[];
  /** Court's time zone for hours periods. Default America/Chicago; four western Kansas counties use Mountain time. */
  timeZone?: string;
}

export interface Citation {
  cite: string;
  url: string;
}

export interface DeadlineResult {
  /** The computed last day. For "after" periods this is the earlier (safer) reading where the law is unclear. */
  date: ISODate;
  /** For hours periods, the time of day ("HH:MM", court's time zone) the period ends. */
  time?: string;
  /**
   * Set only when the 60-206(d) three extra days end on a weekend, legal holiday or closed day. The
   * statute does not say whether the weekend/holiday rule applies again after the 3 days are
   * added; this is the later date if it does. Do not rely on it without checking.
   */
  laterDateIfExtended?: ISODate;
  /** When the last day ends, K.S.A. 60-206(a)(4). */
  lastDayEnds: string;
  steps: string[];
  warnings: string[];
  citations: Citation[];
  disclaimer: string;
}

const URL_60206 = SOURCES.ksa60206;
const URL_60205 = "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0005.html";
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekday(d: ISODate): string {
  return DOW[new Date(d + "T00:00:00Z").getUTCDay()];
}
const fmt = (d: ISODate) => `${weekday(d)} ${d}`;

const LAST_DAY_ENDS =
  "Under K.S.A. 60-206(a)(4), unless a statute, local rule or court order sets a different time, the last day ends " +
  "\"For electronic or telefacsimile filing, at midnight in the court's time zone\" and \"for filing by other means, " +
  "when the clerk's office is scheduled to close.\"";

type DayKind = { why: string } | null;

class Calendar {
  holidays: HolidayCalendar;
  closed: Set<ISODate>;
  constructor(extra: Holiday[], closed: ISODate[]) {
    this.holidays = new HolidayCalendar(extra);
    this.closed = new Set(closed);
  }
  /** Saturday, Sunday or legal holiday (the days 60-206(a)(1)(C) skips). */
  excluded(d: ISODate): DayKind {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 6) return { why: "a Saturday" };
    if (dow === 0) return { why: "a Sunday" };
    const h = this.holidays.get(d);
    if (h) return { why: `a legal holiday (${h.name}; ${h.sources.join("; ")})` };
    return null;
  }
  inaccessible(d: ISODate): DayKind {
    return this.closed.has(d) ? { why: "a day the clerk's office is inaccessible (given as a court-closed day)" } : null;
  }
}

function checkInt(n: unknown, what: string, max: number): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) {
    throw new DeadlineError(`${what} must be a whole number from 1 to ${max}; use direction "before" for periods counted back from an event`);
  }
  return n;
}

function normaliseDirection(d: unknown): Direction {
  if (d === undefined || d === null || d === "" || d === "after" || d === "forward") return "after";
  if (d === "before" || d === "backward") return "before";
  throw new DeadlineError('direction must be "after" or "before"');
}

function normaliseInput(input: ComputeInput) {
  if (!input || typeof input !== "object") throw new DeadlineError("Missing input");
  const direction = normaliseDirection(input.direction);
  const serviceMethod = input.serviceMethod ?? null;
  if (serviceMethod !== null && !SERVICE_METHODS.includes(serviceMethod)) {
    throw new DeadlineError(`serviceMethod must be one of ${SERVICE_METHODS.join(", ")}`);
  }
  const closed = input.courtClosedDays ?? [];
  if (!Array.isArray(closed)) throw new DeadlineError("courtClosedDays must be a list of dates");
  for (const c of closed) if (!isISODate(c)) throw new DeadlineError(`Court-closed day "${c}" is not a date like 2026-01-31`);
  const extraIn = input.extraHolidays ?? [];
  if (!Array.isArray(extraIn)) throw new DeadlineError("extraHolidays must be a list");
  const extra: Holiday[] = extraIn.map((h) => {
    if (!h || !isISODate(h.date)) throw new DeadlineError(`Extra holiday "${h?.date}" is not a date like 2026-01-31`);
    return { date: h.date, name: h.name || "Holiday supplied by user", sources: [h.source || "supplied by the user (verify the declaration or order)"] };
  });
  const hasDays = input.days !== undefined && input.days !== null;
  const hasHours = input.hours !== undefined && input.hours !== null;
  if (hasDays === hasHours) throw new DeadlineError("Give exactly one of days or hours");
  return { direction, serviceMethod, closed, extra, hasDays };
}

function wrapYear<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) throw new DeadlineError(e.message);
    throw e;
  }
}

/**
 * Compute a deadline under K.S.A. 60-206 and explain each step.
 */
export function computeDeadline(input: ComputeInput): DeadlineResult {
  const n = normaliseInput(input);
  const cal = new Calendar(n.extra, n.closed);
  return wrapYear(() => (n.hasDays ? computeDays(input, n, cal) : computeHours(input, n, cal)));
}

function computeDays(input: ComputeInput, n: ReturnType<typeof normaliseInput>, cal: Calendar): DeadlineResult {
  const trigger = input.trigger;
  if (!isISODate(trigger)) throw new DeadlineError("trigger must be a date like 2026-01-31");
  checkYear(Number(trigger.slice(0, 4)));
  const days = checkInt(input.days, "days", 3650);
  const after = n.direction === "after";
  const step = after ? 1 : -1;
  const steps: string[] = [];
  const warnings: string[] = [];
  const citations: Citation[] = [{ cite: "K.S.A. 60-206(a)", url: URL_60206 }];

  steps.push(
    `Triggering event: ${fmt(trigger)}. K.S.A. 60-206(a)(1)(A): "Exclude the day of the event that triggers the period." ` +
      `Counting starts on ${fmt(addDays(trigger, step))}.`,
  );

  // (a)(1)(B): count every day.
  const raw = addDays(trigger, step * days);
  let skippedInside = 0;
  for (let i = 1; i < days; i++) if (cal.excluded(addDays(trigger, step * i))) skippedInside++;
  steps.push(
    `K.S.A. 60-206(a)(1)(B): "count every day, including intermediate Saturdays, Sundays and legal holidays." ` +
      `Counting ${days} day${days === 1 ? "" : "s"} ${after ? "forward" : "backward"} reaches ${fmt(raw)}` +
      (skippedInside ? ` (${skippedInside} intermediate weekend day(s)/legal holiday(s) were counted, not skipped).` : "."),
  );

  // (a)(1)(C) and (a)(5): last day rule.
  let date = raw;
  let why = cal.excluded(date);
  if (!why) {
    steps.push(`K.S.A. 60-206(a)(1)(C): "include the last day of the period". ${fmt(date)} is not a Saturday, Sunday or legal holiday, so it stands.`);
  } else {
    const moved: string[] = [];
    while (why) {
      moved.push(`${fmt(date)} is ${why.why}`);
      date = addDays(date, step);
      why = cal.excluded(date);
    }
    steps.push(
      `K.S.A. 60-206(a)(1)(C): "if the last day is a Saturday, Sunday or legal holiday, the period continues to run until ` +
        `the end of the next day that is not a Saturday, Sunday or legal holiday." ${moved.join("; ")}. ` +
        `K.S.A. 60-206(a)(5): the "next day" is found "by continuing to count forward when the period is measured after an event ` +
        `and backward when measured before an event", so the ${after ? "next" : "previous"} qualifying day is ${fmt(date)}.`,
    );
    citations.push({ cite: "K.S.A. 60-206(a)(5)", url: URL_60206 });
  }

  // (a)(3): inaccessible clerk's office.
  if (cal.inaccessible(date)) {
    const moved: string[] = [];
    let k: DayKind;
    while ((k = cal.inaccessible(date) ?? cal.excluded(date))) {
      moved.push(`${fmt(date)} is ${k.why}`);
      date = addDays(date, step);
    }
    citations.push({ cite: "K.S.A. 60-206(a)(3)", url: URL_60206 });
    if (after) {
      steps.push(
        `K.S.A. 60-206(a)(3)(A): "Unless the court orders otherwise, if the clerk's office is inaccessible" on the last day for filing, ` +
          `"the time for filing is extended to the first accessible day that is not a Saturday, Sunday or legal holiday". ` +
          `${moved.join("; ")}. The period is extended to ${fmt(date)}.`,
      );
      warnings.push(
        "A court-closed day was applied under K.S.A. 60-206(a)(3). Confirm the clerk's office was actually inaccessible for the " +
          "way you will file (electronic filing may stay open when the building is closed) and that no order says otherwise.",
      );
    } else {
      steps.push(
        `${moved.join("; ")}. K.S.A. 60-206(a)(3) speaks only of extending the time for filing; it does not say how a closed ` +
          `day affects a period counted back from an event. This calculator takes the safer course and moves to the earlier ` +
          `accessible day, ${fmt(date)}.`,
      );
      warnings.push("A court-closed day fell on the last day of a period counted backward; the calculator moved the date earlier (the safer reading). Check.");
    }
  }

  // (d): 3 extra days after service by mail or leaving with the clerk.
  let laterDateIfExtended: ISODate | undefined;
  if (n.serviceMethod) {
    citations.push({ cite: "K.S.A. 60-205(b)(2)", url: URL_60205 });
    if (!ADDS_THREE_DAYS.has(n.serviceMethod)) {
      steps.push(
        `Service was by ${SERVICE_LABEL[n.serviceMethod]}. K.S.A. 60-206(d) adds 3 days only when "service is made under K.S.A. ` +
          `60-205(b)(2)(C) (mail), or (D) (leaving with the clerk)", so no days are added.`,
      );
    } else if (!after) {
      steps.push(
        `Service was by ${SERVICE_LABEL[n.serviceMethod]}, but K.S.A. 60-206(d) applies "When a party may or must act within a ` +
          `specified time after being served"; this period is counted before an event, so no days are added.`,
      );
      warnings.push("A service method was given for a period counted before an event; the 60-206(d) three days were not added.");
    } else {
      citations.push({ cite: "K.S.A. 60-206(d)", url: URL_60206 });
      const periodEnd = date;
      date = addDays(periodEnd, 3);
      steps.push(
        `Service was by ${SERVICE_LABEL[n.serviceMethod]}. K.S.A. 60-206(d): "three days are added after the period would ` +
          `otherwise expire under subsection (a)." The period would otherwise expire on ${fmt(periodEnd)}; adding 3 days gives ${fmt(date)}.` +
          (n.serviceMethod === "mail" ? ` (Mail service "is complete upon mailing", K.S.A. 60-205(b)(2)(C), so the trigger should be the mailing date.)` : ""),
      );
      const k = cal.excluded(date) ?? cal.inaccessible(date);
      if (k) {
        let later = date;
        while (cal.excluded(later) || cal.inaccessible(later)) later = addDays(later, 1);
        laterDateIfExtended = later;
        steps.push(
          `${fmt(date)} is ${k.why}. K.S.A. 60-206(d) does not say whether the weekend/holiday rule of subsection (a) applies ` +
            `again after the 3 days are added. This calculator keeps the earlier date, ${fmt(date)}, as the deadline. ` +
            `If the rule does apply again the last day would be ${fmt(later)}; do not rely on that without checking.`,
        );
        warnings.push(
          `The 3 added days end on ${fmt(date)}, which is ${k.why}. The deadline shown is that day (the safer reading); ` +
            `${fmt(later)} is possible only if the weekend/holiday rule applies again. Verify before relying on the later date.`,
        );
      }
    }
  }

  steps.push(`Result: the last day is ${fmt(date)}. ${LAST_DAY_ENDS}`);
  citations.push({ cite: "K.S.A. 60-206(a)(4)", url: URL_60206 });
  holidayWarnings(cal, after, warnings);

  return { date, laterDateIfExtended, lastDayEnds: LAST_DAY_ENDS, steps, warnings, citations: dedupe(citations), disclaimer: DISCLAIMER };
}

function holidayWarnings(cal: Calendar, after: boolean, warnings: string[]) {
  const missing = cal.holidays.touchedYears().filter((y) => !YEARS_WITH_COURT_ORDER.has(y));
  if (missing.length) {
    warnings.push(
      `No Kansas Supreme Court holiday order is loaded for ${missing.join(", ")}. Under K.S.A. 60-206(a)(6) any day "observed ` +
        `as a holiday by order of the Kansas supreme court" is a legal holiday; past orders added days such as the Friday after ` +
        `Thanksgiving and moved weekend holidays to a weekday (e.g. Veterans Day on Friday, Nov. 10, 2023, Order 2022-CC-080). ` +
        `Check that year's order and any presidential declaration, and pass extra days as extraHolidays. ` +
        (after
          ? "For a period counted forward a missing holiday can only make the date shown earlier than the true deadline."
          : "For a period counted backward a missing holiday can make the date shown LATER than the true deadline."),
    );
  }
}

function dedupe(c: Citation[]): Citation[] {
  const seen = new Set<string>();
  return c.filter((x) => (seen.has(x.cite) ? false : (seen.add(x.cite), true)));
}

// ------------------------------------------------------------------ hours

const DT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

function wallAsUTC(epoch: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(epoch))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

/** Epoch ms for a wall-clock time in tz. */
function wallToEpoch(date: ISODate, hh: number, mm: number, tz: string): number {
  const target = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm);
  let e = target - (wallAsUTC(target, tz) - target);
  e = target - (wallAsUTC(e, tz) - e);
  return e;
}

function epochToWall(epoch: number, tz: string): { date: ISODate; time: string } {
  const iso = new Date(wallAsUTC(epoch, tz)).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function computeHours(input: ComputeInput, n: ReturnType<typeof normaliseInput>, cal: Calendar): DeadlineResult {
  const m = typeof input.trigger === "string" ? DT_RE.exec(input.trigger) : null;
  if (!m || !isISODate(m[1]) || +m[2] > 23 || +m[3] > 59) {
    throw new DeadlineError("For an hours period, trigger must be a local date and time like 2026-01-31T14:30");
  }
  checkYear(Number(m[1].slice(0, 4)));
  const hours = checkInt(input.hours, "hours", 24 * 366);
  if (n.serviceMethod && ADDS_THREE_DAYS.has(n.serviceMethod)) {
    throw new DeadlineError("The 60-206(d) three added days are not supported for periods stated in hours; compute this by hand");
  }
  const tz = input.timeZone || "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new DeadlineError(`Unknown time zone ${tz}`);
  }
  const after = n.direction === "after";
  const step = after ? 1 : -1;
  const steps: string[] = [];
  const warnings: string[] = [];
  const citations: Citation[] = [{ cite: "K.S.A. 60-206(a)(2)", url: URL_60206 }];
  const startTime = `${m[2]}:${m[3]}`;

  steps.push(
    `Triggering event: ${fmt(m[1])} at ${startTime} (${tz}). K.S.A. 60-206(a)(2)(A): "Begin counting immediately on the occurrence ` +
      `of the event that triggers the period".`,
  );
  const startEpoch = wallToEpoch(m[1], +m[2], +m[3], tz);
  const end = epochToWall(startEpoch + step * hours * 3_600_000, tz);
  steps.push(
    `K.S.A. 60-206(a)(2)(B): "count every hour, including hours during intermediate Saturdays, Sundays and legal holidays." ` +
      `${hours} hour${hours === 1 ? "" : "s"} ${after ? "after" : "before"} the event is ${fmt(end.date)} at ${end.time}.`,
  );
  if (end.time !== startTime) {
    warnings.push(
      `The period crosses a daylight-saving change, so it ends at ${end.time} rather than ${startTime}. The calculator counts real ` +
        `elapsed hours ("count every hour"); check this.`,
    );
  }
  let date = end.date;
  let why = cal.excluded(date);
  if (why) {
    const moved: string[] = [];
    while (why) {
      moved.push(`${fmt(date)} is ${why.why}`);
      date = addDays(date, step);
      why = cal.excluded(date);
    }
    steps.push(
      `K.S.A. 60-206(a)(2)(C): "if the period would end on a Saturday, Sunday or legal holiday, the period continues to run until ` +
        `the same time on the next day that is not a Saturday, Sunday or legal holiday." ${moved.join("; ")}. Using the "next day" ` +
        `of K.S.A. 60-206(a)(5) (${after ? "forward" : "backward"}), the period ends ${fmt(date)} at ${end.time}.`,
    );
  } else {
    steps.push(`${fmt(date)} is not a Saturday, Sunday or legal holiday, so the period ends then.`);
  }
  if (cal.inaccessible(date)) {
    const moved: string[] = [];
    let k: DayKind;
    while ((k = cal.inaccessible(date) ?? cal.excluded(date))) {
      moved.push(`${fmt(date)} is ${k.why}`);
      date = addDays(date, step);
    }
    citations.push({ cite: "K.S.A. 60-206(a)(3)(B)", url: URL_60206 });
    steps.push(
      `K.S.A. 60-206(a)(3)(B): if the clerk's office is inaccessible "during the last hour for filing", the time "is extended to the ` +
        `same time on the first accessible day that is not a Saturday, Sunday or legal holiday." ${moved.join("; ")}; ` +
        `${after ? "extended" : "moved earlier (safer reading for a backward period)"} to ${fmt(date)} at ${end.time}.`,
    );
    warnings.push("A court-closed day was applied under K.S.A. 60-206(a)(3). Confirm the clerk's office was actually inaccessible during the last hour.");
  }
  if (n.serviceMethod) {
    steps.push(`Service was by ${SERVICE_LABEL[n.serviceMethod]}; K.S.A. 60-206(d) adds days only for mail or leaving with the clerk, so nothing is added.`);
  }
  steps.push(`Result: the period ends ${fmt(date)} at ${end.time} (${tz}).`);
  holidayWarnings(cal, after, warnings);
  return { date, time: end.time, lastDayEnds: LAST_DAY_ENDS, steps, warnings, citations: dedupe(citations), disclaimer: DISCLAIMER };
}

// ------------------------------------------------------- task engine glue

export interface TaskOptions {
  title: string;
  matterId?: number | null;
  assigneeId?: number | null;
  role?: string | null;
  priority?: Priority;
}

/** Turn a computed deadline into a task for Engine.addTask, with the full working in the description. */
export function deadlineToTaskInput(result: DeadlineResult, opts: TaskOptions): TaskInput {
  const lines = [
    `Deadline computed by Lawdesk: ${weekday(result.date)} ${result.date}${result.time ? ` at ${result.time}` : ""}.`,
    "",
    "How it was computed:",
    ...result.steps.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (result.warnings.length) lines.push("", "Warnings:", ...result.warnings.map((w) => `- ${w}`));
  lines.push("", "Sources:", ...result.citations.map((c) => `- ${c.cite}: ${c.url}`), "", result.disclaimer);
  return {
    matterId: opts.matterId ?? null,
    title: opts.title,
    description: lines.join("\n"),
    assigneeId: opts.assigneeId ?? null,
    role: opts.role ?? null,
    dueDate: result.date,
    priority: opts.priority ?? "high",
  };
}
