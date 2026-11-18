// Clio API v4 records -> import records. Field names come from Clio's API reference (see
// docs/clio-import.md). Where the docs we could read didn't confirm a field, the import still
// runs without it, and the field list for each resource can be changed in API_RESOURCES.

import { FIRM_TZ, utcToLocal } from "../calendar/tz.ts";
import type { ActivityRec, ContactRec, EventRec, MatterRec, Rec, RowResult, TaskRec, UserRec } from "./records.ts";
import { ValueError, cleanText, parseDate, parseHours, parseMoney, secondsToMinutes } from "./values.ts";

export interface ApiResource {
  name: string;
  label: string;
  path: string;
  fields: string;
  map: (o: any) => RowResult;
}

const id = (v: any) => (v == null ? null : String(v));
const ref = (o: any) => (o && o.id != null ? { clioId: String(o.id), name: o.name ?? o.display_number ?? null } : null);
const str = (v: any) => cleanText(v);

function result(fn: (w: string[]) => Rec): RowResult {
  const out: RowResult = { line: 0, rec: null, errors: [], warnings: [] };
  try {
    out.rec = fn(out.warnings);
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    out.errors.push(e.message);
  }
  return out;
}

export function mapUser(o: any): RowResult {
  return result((): UserRec => {
    const name = str(o.name) ?? [o.first_name, o.last_name].filter(Boolean).join(" ");
    if (!name) throw new ValueError("User has no name");
    return {
      type: "user",
      key: `id:${o.id}`,
      name,
      email: str(o.email),
      active: o.enabled !== false,
      role: /^attorney$/i.test(o.subscription_type ?? "") ? "attorney" : null,
    };
  });
}

export function mapContact(o: any): RowResult {
  return result((w): ContactRec => {
    const kind = /^company$/i.test(o.type ?? "") ? "company" : "person";
    const name = str(o.name) ?? [o.first_name, o.middle_name, o.last_name].filter(Boolean).join(" ");
    if (!name) throw new ValueError("Contact has no name");
    const extra: string[] = [];
    const add = (label: string, v: any) => str(v) && extra.push(`${label}: ${str(v)}`);
    add("Title", o.title ?? o.prefix);
    add("Other email", o.secondary_email_address);
    add("Other phone", o.secondary_phone_number);
    for (const a of Array.isArray(o.addresses) ? o.addresses : []) {
      const line = [a.street, [a.city, a.province].filter(Boolean).join(", "), a.postal_code, a.country].map((x) => str(x)).filter(Boolean).join(" ");
      if (line) extra.push(`${a.name ? `${a.name} address` : "Address"}: ${line}`);
    }
    if (o.date_of_birth) w.push("Date of birth not imported (Lawdesk has no field for it)");
    return {
      type: "contact",
      key: `id:${o.id}`,
      kind,
      name,
      email: str(o.primary_email_address),
      phone: str(o.primary_phone_number),
      extra,
      notes: null,
    };
  });
}

export function mapMatter(o: any): RowResult {
  return result((w): MatterRec => {
    const name = str(o.description) ?? str(o.display_number);
    if (!name) throw new ValueError("Matter has no description");
    const s = String(o.status ?? "Open").toLowerCase();
    if (s === "pending") w.push("Pending in Clio; imported as open");
    const extra: string[] = [];
    if (str(o.location)) extra.push(`Location: ${str(o.location)}`);
    if (str(o.client_reference)) extra.push(`Client reference: ${str(o.client_reference)}`);
    if (s === "pending") extra.push(`Clio status: Pending${o.pending_date ? ` since ${o.pending_date}` : ""}`);
    const client = ref(o.client) ?? (o.client_id ? { clioId: String(o.client_id), name: null } : null);
    return {
      type: "matter",
      key: `id:${o.id}`,
      number: str(o.display_number),
      name,
      status: s === "closed" ? "closed" : "open",
      clioStatus: o.status ?? null,
      openedOn: parseDate(o.open_date),
      closedOn: parseDate(o.close_date),
      client: client ? { ...client, kind: /^company$/i.test(o.client?.type ?? "") ? "company" : o.client?.type ? "person" : undefined } : null,
      practiceArea: str(o.practice_area?.name),
      responsible: ref(o.responsible_attorney),
      originating: ref(o.originating_attorney),
      extra,
    };
  });
}

export function mapTask(o: any, timeZone = FIRM_TZ): RowResult {
  return result((w): TaskRec => {
    const title = str(o.name);
    if (!title) throw new ValueError("Task has no name");
    const status = str(o.status);
    const p = String(o.priority ?? "Normal").toLowerCase();
    let assignee = null;
    if (o.assignee?.id != null) {
      if (/^contact$/i.test(o.assignee.type ?? "")) w.push(`Assigned to a contact in Clio (${o.assignee.name ?? o.assignee.id}); left unassigned`);
      else assignee = ref(o.assignee);
    }
    return {
      type: "task",
      key: `id:${o.id}`,
      title,
      description: str(o.description),
      due: parseDate(o.due_at, "mdy", timeZone),
      done: /^complete/i.test(status ?? ""),
      completedOn: parseDate(o.completed_at, "mdy", timeZone),
      priority: (["low", "normal", "high"].includes(p) ? p : "normal") as TaskRec["priority"],
      clioStatus: status,
      matter: ref(o.matter),
      assignee,
    };
  });
}

export function mapCalendarEntry(o: any, timeZone = FIRM_TZ): RowResult {
  return result((): EventRec => {
    const title = str(o.summary) ?? "(no title)";
    const startMs = Date.parse(o.start_at);
    if (Number.isNaN(startMs)) throw new ValueError("Calendar entry has no start time");
    const endMs = o.end_at ? Date.parse(o.end_at) : NaN;
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    let start: string;
    let end: string | null = null;
    if (o.all_day) {
      start = utcToLocal(startMs, timeZone).date;
      // An all-day entry is assumed to end at midnight after its last day (as in iCalendar).
      if (Number.isFinite(endMs) && endMs > startMs) end = utcToLocal(endMs - 1000, timeZone).date;
    } else {
      start = iso(startMs);
      if (Number.isFinite(endMs) && endMs > startMs) end = iso(endMs);
    }
    return {
      type: "event",
      key: `id:${o.id}`,
      title,
      allDay: !!o.all_day,
      start,
      end,
      location: str(o.location),
      notes: str(o.description),
      matter: ref(o.matter),
    };
  });
}

export function mapActivity(o: any): RowResult {
  return result((w): ActivityRec => {
    const t = String(o.type ?? "");
    const kind = /^(ExpenseEntry|HardCostEntry|SoftCostEntry)$/.test(t) ? "expense" : "time";
    if (!/^(TimeEntry|ExpenseEntry|HardCostEntry|SoftCostEntry|FixedFee)$/.test(t)) w.push(`Unknown activity type "${t}"; treated as time`);
    const flat = t === "FixedFee";
    const date = parseDate(o.date);
    if (!date) throw new ValueError("Activity has no date");
    if (!o.matter?.id) throw new ValueError("Activity has no matter");
    const minutes = kind === "time" ? (o.quantity_in_hours != null ? parseHours(String(o.quantity_in_hours)) : secondsToMinutes(o.quantity)) ?? 0 : 0;
    if (minutes > 24 * 60) throw new ValueError(`${(minutes / 60).toFixed(2)} hours on one entry is more than a day; enter it by hand`);
    const price = parseMoney(o.price);
    const total = parseMoney(o.total);
    const amount = kind === "expense" ? total ?? price : flat ? total ?? price : null;
    if (amount != null && amount < 0) throw new ValueError("Negative amount (a credit or refund); enter it by hand");
    if (o.quantity_redacted) w.push("Clio hid the hours on this entry from the connected user");
    const category = str(o.activity_description?.name);
    const note = str(o.note);
    return {
      type: "activity",
      key: `id:${o.id}`,
      kind,
      clioType: t || null,
      date,
      matter: ref(o.matter),
      user: ref(o.user),
      description: note ?? category ?? "",
      minutes,
      rateCents: kind === "time" ? price : null,
      totalCents: total,
      amountCents: amount,
      flat,
      billable: !o.non_billable && !o.no_charge,
      billed: !!o.billed,
      billNumber: null,
      code: note && category ? category : null,
      receipt: str(o.reference) ? `Reference: ${str(o.reference)}` : null,
    };
  });
}

/** What the API import reads, in order (people and contacts before the matters that name them). */
export const API_RESOURCES: ApiResource[] = [
  { name: "users", label: "People", path: "/api/v4/users.json", fields: "id,name,first_name,last_name,email,enabled,subscription_type", map: mapUser },
  {
    name: "contacts",
    label: "Contacts",
    path: "/api/v4/contacts.json",
    fields:
      "id,name,first_name,middle_name,last_name,type,title,primary_email_address,secondary_email_address,primary_phone_number,secondary_phone_number,addresses{name,street,city,province,postal_code,country}",
    map: mapContact,
  },
  {
    name: "matters",
    label: "Matters",
    path: "/api/v4/matters.json",
    fields:
      "id,display_number,description,status,open_date,close_date,pending_date,location,client_reference,client{id,name,type},practice_area{id,name},responsible_attorney{id,name},originating_attorney{id,name}",
    map: mapMatter,
  },
  { name: "tasks", label: "Tasks", path: "/api/v4/tasks.json", fields: "id,name,description,due_at,status,priority,completed_at,matter{id,display_number},assignee{id,name,type}", map: (o) => mapTask(o) },
  {
    name: "calendar_entries",
    label: "Calendar",
    path: "/api/v4/calendar_entries.json",
    fields: "id,summary,description,location,start_at,end_at,all_day,matter{id,display_number}",
    map: (o) => mapCalendarEntry(o),
  },
  {
    name: "activities",
    label: "Time and expenses",
    path: "/api/v4/activities.json",
    fields: "id,type,date,quantity_in_hours,price,total,note,reference,billed,non_billable,no_charge,quantity_redacted,matter{id,display_number},user{id,name},activity_description{name}",
    map: mapActivity,
  },
];

export function firstPageUrl(r: ApiResource, pageSize = 200): string {
  // Cursor paging needs order=id(asc) and no offset; 200 is the most Clio returns per page.
  return `${r.path}?${new URLSearchParams({ fields: r.fields, order: "id(asc)", limit: String(pageSize) })}`;
}
