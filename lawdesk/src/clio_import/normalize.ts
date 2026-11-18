// Turn one CSV row (with the column mapping chosen on screen) into an import record.

import { createHash } from "node:crypto";
import type { Kind } from "./fields.ts";
import type { ActivityRec, ContactRec, EventRec, MatterRec, Rec, Ref, RowResult, TaskRec, TrustRec } from "./records.ts";
import { ValueError, cleanText, localInstant, nameKey, parseBool, parseDate, parseDecimal, parseHours, parseMoney, parseTime } from "./values.ts";

export interface NormalizeOpts {
  dateOrder?: "mdy" | "dmy";
  timeZone?: string;
}

type Get = (key: string) => string | null;

export function normalizeRow(kind: Kind, cells: string[], mapping: Record<string, number>, line: number, opts: NormalizeOpts = {}): RowResult {
  const out: RowResult = { line, rec: null, errors: [], warnings: [] };
  const get: Get = (key) => {
    const i = mapping[key];
    if (i == null) return null;
    return cleanText(cells[i]);
  };
  /** Run a value parser; a ValueError becomes a row error naming the field. */
  const read = <T>(label: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ValueError) {
        out.errors.push(`${label}: ${e.message}`);
        return null;
      }
      throw e;
    }
  };
  const date = (key: string, label: string) => read(label, () => parseDate(get(key), opts.dateOrder, opts.timeZone));
  const ctx = { get, read, date, out, opts };
  try {
    out.rec = BUILDERS[kind](ctx);
  } catch (e) {
    if (!(e instanceof RowError)) throw e;
    out.errors.push(e.message);
  }
  if (out.errors.length) out.rec = null;
  return out;
}

class RowError extends Error {}

interface Ctx {
  get: Get;
  read: <T>(label: string, fn: () => T) => T | null;
  date: (key: string, label: string) => string | null;
  out: RowResult;
  opts: NormalizeOpts;
}

const idKey = (clioId: string | null, natural: string) => (clioId ? `id:${clioId}` : `csv:${natural}`);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

function matterRef(c: Ctx): Ref | null {
  const clioId = c.get("matter_clio_id");
  const name = c.get("matter");
  return clioId || name ? { clioId, name } : null;
}

function joinName(...parts: (string | null)[]) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

const BUILDERS: Record<Kind, (c: Ctx) => Rec | null> = {
  contacts(c): ContactRec {
    const company = c.get("company");
    const personName = joinName(c.get("first_name"), c.get("middle_name"), c.get("last_name"));
    const typeRaw = (c.get("type") ?? "").toLowerCase();
    let kind: "person" | "company";
    if (typeRaw.startsWith("comp") || typeRaw === "organization") kind = "company";
    else if (typeRaw.startsWith("per") || typeRaw === "individual") kind = "person";
    else if (typeRaw) throw new RowError(`Person or company: "${c.get("type")}" should be Person or Company`);
    else kind = !personName && company ? "company" : "person";
    const name = c.get("name") ?? (kind === "company" ? company ?? personName : personName || company);
    if (!name) throw new RowError("No name: a person needs a first and last name, a company needs a company name");
    if (kind === "person" && !c.get("name") && (!c.get("first_name") || !c.get("last_name")))
      c.out.warnings.push("Only part of the name is filled in");
    const extra: string[] = [];
    const add = (label: string, v: string | null) => v && extra.push(`${label}: ${v}`);
    add("Title", c.get("title"));
    add("Job title", c.get("job_title"));
    if (kind === "person" && company && company !== name) add("Company", company);
    add("Other email", c.get("email2"));
    add("Other phone", c.get("phone2"));
    const cityLine = joinName([c.get("city"), c.get("state")].filter(Boolean).join(", ") || null, c.get("postal_code"));
    const address = [c.get("street"), cityLine || null, c.get("country")].filter(Boolean).join(", ");
    add("Address", address || null);
    const email = c.get("email");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s.]+$/.test(email)) c.out.warnings.push(`Email "${email}" doesn't look like an email address`);
    const clioId = c.get("clio_id");
    return {
      type: "contact",
      key: idKey(clioId, `${nameKey(name)}|${(email ?? "").toLowerCase()}`),
      kind,
      name,
      email,
      phone: c.get("phone"),
      extra,
      notes: c.get("notes"),
    };
  },

  matters(c): MatterRec {
    const name = c.get("name");
    if (!name) throw new RowError("No matter name (Clio calls it the description)");
    const rawStatus = c.get("status");
    const s = (rawStatus ?? "open").toLowerCase();
    if (!["open", "closed", "pending"].includes(s)) throw new RowError(`Status: "${rawStatus}" should be Open, Pending or Closed`);
    const openedOn = c.date("open_date", "Open date");
    const closedOn = c.date("close_date", "Close date");
    const pendingOn = c.date("pending_date", "Pending date");
    if (s === "pending") c.out.warnings.push("Pending in Clio; imported as open");
    if (s === "closed" && !closedOn) c.out.warnings.push("Closed, but no close date; the open date (or today) is used");
    if (openedOn && closedOn && closedOn < openedOn) c.out.warnings.push("The close date is before the open date");
    const cFirst = c.get("client_first_name");
    const cLast = c.get("client_last_name");
    const cCompany = c.get("client_company_name");
    const clientName = c.get("client_name") ?? (joinName(cFirst, cLast) || cCompany);
    const clientId = c.get("client_clio_id");
    if (!clientName && !clientId) c.out.warnings.push("No client");
    const extra: string[] = [];
    const add = (label: string, v: string | null) => v && extra.push(`${label}: ${v}`);
    add("Location", c.get("location"));
    add("Client reference", c.get("client_reference"));
    if (s === "pending") add("Clio status", `Pending${pendingOn ? ` since ${pendingOn}` : ""}`);
    add("Notes", c.get("note"));
    const resp = c.get("responsible_attorney");
    const orig = c.get("originating_attorney");
    const number = c.get("number");
    const clioId = c.get("clio_id");
    return {
      type: "matter",
      key: idKey(clioId, number ? `num:${number.toLowerCase()}` : `name:${nameKey(name)}|${nameKey(clientName)}`),
      number,
      name,
      status: s === "closed" ? "closed" : "open",
      clioStatus: rawStatus,
      openedOn,
      closedOn,
      client: clientName || clientId ? { clioId: clientId, name: clientName || null, kind: !cFirst && !cLast && cCompany ? "company" : undefined } : null,
      practiceArea: c.get("practice_area"),
      responsible: resp ? { name: resp } : null,
      originating: orig ? { name: orig } : null,
      extra,
    };
  },

  tasks(c): TaskRec {
    const title = c.get("title");
    if (!title) throw new RowError("No task name");
    const due = c.date("due", "Due date");
    const status = c.get("status");
    const complete = c.read("Done", () => parseBool(c.get("complete")));
    const done = complete ?? (status ? /^complete/i.test(status) : false);
    if (status && !/^(pending|in[ _]progress|in[ _]review|complete|completed|draft|open|done)$/i.test(status))
      c.out.warnings.push(`Status "${status}" isn't one Clio uses; treated as ${done ? "done" : "not done"}`);
    const completedOn = c.date("completed_at", "Date finished");
    const p = (c.get("priority") ?? "normal").toLowerCase();
    if (!["low", "normal", "high"].includes(p)) c.out.warnings.push(`Priority "${c.get("priority")}" isn't High, Normal or Low; Normal used`);
    const assignee = c.get("assignee");
    const assigneeId = c.get("assignee_clio_id");
    const matter = matterRef(c);
    const clioId = c.get("clio_id");
    return {
      type: "task",
      key: idKey(clioId, `${nameKey(matter?.clioId ?? matter?.name)}|${nameKey(title)}|${due ?? ""}`),
      title,
      description: c.get("description"),
      due,
      done,
      completedOn,
      priority: (["low", "normal", "high"].includes(p) ? p : "normal") as TaskRec["priority"],
      clioStatus: status,
      matter,
      assignee: assignee || assigneeId ? { clioId: assigneeId, name: assignee } : null,
    };
  },

  calendar(c): EventRec | null {
    const title = c.get("title");
    if (!title) throw new RowError("No title");
    const tz = c.opts.timeZone;
    // A "start" column may hold "03/09/2026 9:30 AM" or an ISO instant; split it.
    const split = (key: string) => {
      const v = c.get(key);
      if (!v) return { date: null as string | null, time: null as string | null, instant: null as string | null };
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && /(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
        const ms = Date.parse(v);
        if (Number.isNaN(ms)) throw new RowError(`"${v}" is not a date and time we can read`);
        return { date: null, time: null, instant: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") };
      }
      const m = /^(\S+)(?:[ T](.+))?$/.exec(v)!;
      return { date: m[1], time: m[2] ?? null, instant: null };
    };
    const s = split("start_date");
    const e = split("end_date");
    const allDayFlag = c.read("All day", () => parseBool(c.get("all_day")));
    const startDate = s.date ? c.read("Start date", () => parseDate(s.date, c.opts.dateOrder, tz)) : null;
    const endDate = e.date ? c.read("End date", () => parseDate(e.date, c.opts.dateOrder, tz)) : null;
    const startTime = c.read("Start time", () => parseTime(c.get("start_time") ?? s.time));
    const endTime = c.read("End time", () => parseTime(c.get("end_time") ?? e.time));
    if (c.out.errors.length) return null;
    if (!startDate && !s.instant) throw new RowError("No start date");
    // Clio's calendar template asks for a start and end time even on all-day events and suggests
    // 12:00 PM for both, so an event whose times are identical on one day is read as all-day.
    const sameTimes = !!startTime && startTime === endTime && (!endDate || endDate === startDate);
    if (allDayFlag == null && sameTimes) c.out.warnings.push("Starts and ends at the same time; imported as an all-day event");
    const allDay = allDayFlag ?? (sameTimes || (!s.instant && !startTime));
    let start: string;
    let end: string | null = null;
    if (allDay) {
      start = startDate ?? s.instant!.slice(0, 10);
      end = endDate ?? (e.instant ? e.instant.slice(0, 10) : null);
      if (end && end < start) {
        c.out.warnings.push("Ends before it starts; made a one-day event");
        end = null;
      }
    } else {
      start = s.instant ?? localInstant(startDate!, startTime ?? "09:00:00", tz);
      if (e.instant) end = e.instant;
      else if (endTime || endDate) end = localInstant(endDate ?? startDate ?? start.slice(0, 10), endTime ?? startTime ?? "09:00:00", tz);
      if (end && end <= start) {
        c.out.warnings.push("Ends before it starts; made a one-hour event");
        end = null;
      }
    }
    const matter = matterRef(c);
    const clioId = c.get("clio_id");
    return {
      type: "event",
      key: idKey(clioId, `${nameKey(matter?.clioId ?? matter?.name)}|${nameKey(title)}|${start}`),
      title,
      allDay,
      start,
      end,
      location: c.get("location"),
      notes: c.get("description"),
      matter,
    };
  },

  time: (c) => activity(c, "time"),
  expenses: (c) => activity(c, "expense"),

  trust_balances(c): TrustRec | null {
    const balanceCents = c.read("Trust balance", () => parseMoney(c.get("balance")));
    if (balanceCents == null) {
      if (!c.out.errors.length) throw new RowError("No trust balance");
      return null;
    }
    const matter = matterRef(c);
    const client = c.get("client");
    if (!matter && !client) throw new RowError("No client or matter");
    // Total rows in a report ("Total", "Grand total") are not balances.
    if (!matter && client && /^(grand )?totals?$/i.test(client)) throw new RowError("A total line from the report, not a balance");
    return {
      type: "trust",
      key: `csv:${nameKey(client)}|${nameKey(matter?.clioId ?? matter?.name)}|${nameKey(c.get("account"))}`,
      client,
      matter,
      balanceCents,
      account: c.get("account"),
      asOf: c.date("as_of", "As of date"),
    };
  },
};

const EXPENSE_TYPES = /^(expense|expenseentry|expense entry|softcostentry|hardcostentry|soft cost|hard cost|cost|disbursement)$/i;
const TIME_TYPES = /^(time|timeentry|time entry|fixedfee|fixed fee|flat fee|flat)$/i;

function activity(c: Ctx, defaultKind: "time" | "expense"): ActivityRec | null {
  const clioType = c.get("type");
  let kind = defaultKind;
  if (clioType) {
    if (EXPENSE_TYPES.test(clioType)) kind = "expense";
    else if (TIME_TYPES.test(clioType)) kind = "time";
    else throw new RowError(`Entry type: "${clioType}" should be TimeEntry, ExpenseEntry, HardCostEntry, SoftCostEntry or FixedFee`);
  }
  const flat = !!clioType && /^(fixedfee|fixed fee|flat fee|flat)$/i.test(clioType);
  const date = c.date("date", "Date");
  const rateCents = c.read("Rate", () => parseMoney(c.get("rate")));
  const totalCents = c.read("Amount", () => parseMoney(c.get("total")));
  let minutes = 0;
  let amountCents: number | null = null;
  if (kind === "time") {
    minutes = c.read("Hours", () => parseHours(c.get("hours"))) ?? 0;
    if (flat) amountCents = totalCents ?? rateCents;
  } else {
    const qty = c.read("Quantity", () => parseDecimal(c.get("hours"), 4, "quantity")) ?? 10_000;
    if (rateCents != null) amountCents = Math.round((rateCents * qty) / 10_000);
    else amountCents = totalCents;
    if (totalCents != null && amountCents != null && totalCents !== amountCents)
      c.out.warnings.push(`Clio's total (${totalCents / 100}) differs from price × quantity (${amountCents / 100}); price × quantity used`);
  }
  if (c.out.errors.length) return null;
  if (!date) throw new RowError("No date");
  if (kind === "time" && minutes > 24 * 60) throw new RowError(`${(minutes / 60).toFixed(2)} hours on one entry is more than a day; split it in Clio or enter it by hand`);
  if (kind === "time" && !flat && rateCents == null) c.out.warnings.push("No rate; the timekeeper's Lawdesk rate will be used");
  if (kind === "time" && rateCents != null && rateCents < 0) throw new RowError("The rate is negative");
  if (kind === "expense" && amountCents == null) throw new RowError("No amount for the expense");
  if (amountCents != null && amountCents < 0) throw new RowError("Negative amount (a credit or refund); enter it by hand");
  if (kind === "time" && minutes === 0 && !flat) c.out.warnings.push("Zero hours");
  const nonBillable = c.read("Non-billable", () => parseBool(c.get("non_billable")));
  const billableCol = c.read("Billable", () => parseBool(c.get("billable")));
  const billedRaw = c.get("billed");
  let billed = false;
  if (billedRaw) {
    const b = billedRaw.toLowerCase();
    if (b === "draft") {
      c.out.warnings.push("On a draft bill in Clio; imported as unbilled");
      billed = false;
    } else billed = c.read("Billed", () => parseBool(billedRaw)) ?? false;
  }
  const billNumber = c.get("bill_number");
  if (billNumber && !billedRaw) billed = true;
  const matter = matterRef(c);
  if (!matter) throw new RowError("No matter");
  const userName = c.get("user");
  const userId = c.get("user_clio_id");
  if (kind === "time" && !userName && !userId) throw new RowError("No timekeeper");
  const category = c.get("activity_category");
  const note = c.get("description");
  const description = note ?? category ?? "";
  const code = kind === "time"
    ? [c.get("utbms_task_code"), c.get("utbms_activity_code")].filter(Boolean).join(" ") || (note && category ? category : null)
    : c.get("utbms_expense_code") ?? c.get("expense_type") ?? (note && category ? category : null);
  const receipt = [c.get("vendor_name") && `Vendor: ${c.get("vendor_name")}`, c.get("reference") && `Reference: ${c.get("reference")}`].filter(Boolean).join("; ") || null;
  const clioId = c.get("clio_id");
  const natural = hash([kind, date, matter.clioId ?? nameKey(matter.name), userId ?? nameKey(userName), minutes, rateCents, amountCents, totalCents, description].join("|"));
  return {
    type: "activity",
    key: idKey(clioId, natural),
    kind,
    clioType,
    date,
    matter,
    user: userName || userId ? { clioId: userId, name: userName } : null,
    description,
    minutes,
    rateCents,
    totalCents: totalCents ?? (kind === "expense" ? amountCents : flat ? amountCents : rateCents != null ? Math.round((minutes * rateCents) / 60) : null),
    amountCents,
    flat,
    billable: nonBillable != null ? !nonBillable : billableCol ?? true,
    billed,
    billNumber,
    code,
    receipt,
  };
}

/** Rows with identical natural keys (two identical lines in one file) get #2, #3 so both import. */
export function dedupeKeys(results: RowResult[]): void {
  const seen = new Map<string, number>();
  for (const r of results) {
    if (!r.rec || !r.rec.key.startsWith("csv:")) continue;
    const n = (seen.get(r.rec.key) ?? 0) + 1;
    seen.set(r.rec.key, n);
    if (n < 2) continue;
    if (r.rec.type === "contact" || r.rec.type === "matter" || r.rec.type === "trust") {
      // The same person or matter twice: the later row updates the earlier one.
      r.warnings.push("Appears earlier in this file too; this row's details are used");
    } else {
      if (r.rec.type !== "activity") r.warnings.push("Same as an earlier row in this file; both are imported");
      r.rec.key += `#${n}`;
    }
  }
}
