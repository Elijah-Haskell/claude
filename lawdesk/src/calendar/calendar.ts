// The firm calendar: events (one-off and recurring), single-occurrence changes, the
// agenda (events plus task due dates), double-booking warnings, reminders, secret
// iCalendar feed URLs and .ics import. Every change is written to the core activity log.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type DB, tx } from "../db.ts";
import { type ISODate, addDays, daysBetween, isISODate } from "../dates.ts";
import { EngineError } from "../engine.ts";
import {
  IcsWriter,
  WINDOWS_ZONES,
  ZONES,
  escapeText,
  getProp,
  getProps,
  icsDate,
  icsLocal,
  icsUtc,
  parseDuration,
  parseIcs,
  parseIcsTime,
  unescapeText,
  vtimezone,
  type IcsComponent,
  type IcsTime,
} from "./ics.ts";
import { RRuleError, formatRRule, occurrenceDates, parseRRule, startMatchesRule, untilInstant, type RRule } from "./rrule.ts";
import { FIRM_TZ, dayBounds, isValidTimeZone, isoInstant, localToUtc, utcToLocal } from "./tz.ts";

export const KINDS = ["court_deadline", "hearing", "meeting", "statute_of_limitations", "reminder", "other"] as const;
export type Kind = (typeof KINDS)[number];

const KIND_LABEL: Record<Kind, string> = {
  court_deadline: "Court deadline",
  hearing: "Hearing",
  meeting: "Meeting",
  statute_of_limitations: "Statute of limitations",
  reminder: "Reminder",
  other: "Other",
};

export interface EventInput {
  title: string;
  matterId?: number | null;
  kind?: Kind;
  /** Where the event came from: manual (default), ics_import, deadlines, ... */
  source?: string;
  sourceRef?: string | null;
  allDay?: boolean;
  /**
   * Timed: local wall time in `timeZone` ("2026-03-09T09:00") or an instant with an offset
   * ("2026-03-09T14:00:00Z"). All-day: a date ("2026-03-09").
   */
  start: string;
  /** Timed: same forms as start (default start + 1 hour). All-day: the last day, inclusive (default = start). */
  end?: string | null;
  timeZone?: string;
  location?: string | null;
  notes?: string | null;
  attendees?: number[];
  /** Minutes before the start, e.g. [1440, 60]. */
  reminders?: number[];
  /** RFC 5545 RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10". */
  rrule?: string | null;
  /** iCalendar UID to keep (imports only); a new one is made otherwise. */
  uid?: string | null;
}

export type EventPatch = Partial<EventInput>;

export interface OccurrencePatch {
  title?: string;
  start?: string;
  end?: string;
  location?: string | null;
  notes?: string | null;
}

export interface Occurrence {
  type: "event";
  eventId: number;
  uid: string;
  /** Key of this occurrence: its original start, 20260309T140000Z (timed) or 20260309 (all-day). */
  occurrence: string;
  title: string;
  kind: Kind;
  matterId: number | null;
  allDay: boolean;
  /** Timed: UTC instant. All-day: first day. */
  start: string;
  /** Timed: UTC instant. All-day: last day (inclusive). */
  end: string;
  startMs: number;
  endMs: number;
  /** Wall time in the event's zone, e.g. 2026-03-09T09:00 (timed only). */
  startLocal: string | null;
  endLocal: string | null;
  timeZone: string;
  location: string | null;
  notes: string | null;
  attendees: number[];
  reminders: number[];
  recurring: boolean;
  /** True when this occurrence was changed on its own. */
  modified: boolean;
}

export interface Conflict {
  userId: number;
  userName: string;
  a: { eventId: number; occurrence: string; title: string; start: string; end: string };
  b: { eventId: number; occurrence: string; title: string; start: string; end: string };
}

export interface ReminderDue {
  eventId: number;
  occurrence: string;
  title: string;
  kind: Kind;
  matterId: number | null;
  start: string;
  allDay: boolean;
  minutesBefore: number;
  fireAt: string;
  userIds: number[];
}

type Row = Record<string, any>;

const DAY_MS = 86_400_000;
const MAX_ITER = 50_000;
const TITLE_MAX = 500;
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class Calendar {
  db: DB;
  private nowFn: () => number;

  constructor(db: DB, opts: { now?: () => Date } = {}) {
    this.db = db;
    this.nowFn = opts.now ? () => opts.now!().getTime() : () => Date.now();
  }

  private now(): number {
    return this.nowFn();
  }

  // ---------------------------------------------------------------- helpers

  private one(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: any[]): number {
    return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
  }

  private log(kind: string, detail: string, userId: number | null, matterId: number | null) {
    this.run(
      "INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,?,?,?)",
      isoInstant(this.now()),
      userId,
      matterId,
      null,
      kind,
      detail,
    );
  }

  private eventRow(id: number): Row {
    const r = this.one("SELECT * FROM cal_events WHERE id = ?", id);
    if (!r) throw new EngineError("Event not found", 404);
    return r;
  }

  private attendeesOf(id: number): number[] {
    return this.all("SELECT user_id FROM cal_attendees WHERE event_id = ? ORDER BY user_id", id).map((r) => r.user_id);
  }

  private exceptionsOf(id: number): Row[] {
    return this.all("SELECT * FROM cal_exceptions WHERE event_id = ? ORDER BY occurrence", id);
  }

  /** Parse a timed start/end: local wall time in tz, or an instant with offset. */
  private parseWhen(s: unknown, tz: string, what: string): number {
    if (typeof s !== "string") throw new EngineError(`${what} is required`);
    const m = LOCAL_RE.exec(s);
    if (m) {
      const [, date, hh, mm, ss] = m;
      if (!isISODate(date) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) {
        throw new EngineError(`${what} "${s}" is not a valid date and time`);
      }
      return localToUtc(date, `${hh}:${mm}:${ss ?? "00"}`, tz);
    }
    if (INSTANT_RE.test(s)) {
      const ms = Date.parse(s);
      if (!Number.isNaN(ms)) return Math.floor(ms / 1000) * 1000;
    }
    throw new EngineError(`${what} must look like 2026-03-09T09:00 (or 2026-03-09 for an all-day event)`);
  }

  private checkZone(tz: unknown): string {
    if (tz === undefined || tz === null || tz === "") return FIRM_TZ;
    if (typeof tz !== "string" || !ZONES[tz]) {
      throw new EngineError(`Time zone must be one of: ${Object.keys(ZONES).join(", ")}`);
    }
    return tz;
  }

  private checkReminders(r: unknown): number[] {
    if (r === undefined || r === null) return [];
    if (!Array.isArray(r) || r.length > 10) throw new EngineError("Reminders must be a list of up to 10 numbers of minutes");
    const out = [...new Set(r)].map((m) => {
      if (!Number.isInteger(m) || m < 0 || m > 4 * 7 * 24 * 60) throw new EngineError("A reminder is whole minutes before the start, up to 4 weeks");
      return m as number;
    });
    return out.sort((a, b) => b - a);
  }

  private checkAttendees(a: unknown): number[] {
    if (a === undefined || a === null) return [];
    if (!Array.isArray(a)) throw new EngineError("Attendees must be a list of user ids");
    const ids = [...new Set(a)];
    for (const id of ids) {
      if (!Number.isInteger(id) || !this.one("SELECT 1 FROM users WHERE id = ?", id)) throw new EngineError(`User ${id} not found`, 404);
    }
    return ids as number[];
  }

  private checkMatter(m: unknown): number | null {
    if (m === undefined || m === null) return null;
    if (!Number.isInteger(m) || !this.one("SELECT 1 FROM matters WHERE id = ?", m)) throw new EngineError("Matter not found", 404);
    return m as number;
  }

  private checkKind(k: unknown): Kind {
    if (k === undefined || k === null) return "meeting";
    if (typeof k !== "string" || !(KINDS as readonly string[]).includes(k)) throw new EngineError(`Kind must be one of: ${KINDS.join(", ")}`);
    return k as Kind;
  }

  private checkText(s: unknown, what: string, max = 10_000): string | null {
    if (s === undefined || s === null) return null;
    if (typeof s !== "string") throw new EngineError(`${what} must be text`);
    if (s.length > max) throw new EngineError(`${what} is too long`);
    return s.trim() === "" ? null : s;
  }

  /**
   * Validate and normalise everything about an event's timing. Returns the column values.
   * UNTIL is rewritten to the form RFC 5545 §3.3.10 requires: a DATE for all-day events,
   * a UTC DATE-TIME for timed ones (a date-only UNTIL means the end of that local day).
   */
  private normaliseTiming(input: { allDay: boolean; start: unknown; end: unknown; timeZone: unknown; rrule: unknown }) {
    const tz = this.checkZone(input.timeZone);
    let startAt: string | null = null,
      endAt: string | null = null,
      startDate: string | null = null,
      endDate: string | null = null;
    let firstDate: string;
    if (input.allDay) {
      if (!isISODate(input.start)) throw new EngineError("An all-day event starts on a date like 2026-03-09");
      const end = input.end ?? input.start;
      if (!isISODate(end)) throw new EngineError("An all-day event ends on a date like 2026-03-09");
      if (end < input.start) throw new EngineError("The event ends before it starts");
      if (daysBetween(input.start, end) > 366) throw new EngineError("An all-day event can last at most a year");
      startDate = input.start;
      endDate = end;
      firstDate = startDate;
    } else {
      const s = this.parseWhen(input.start, tz, "Start");
      const e = input.end == null || input.end === "" ? s + 3600_000 : this.parseWhen(input.end, tz, "End");
      if (e < s) throw new EngineError("The event ends before it starts");
      if (e - s > 366 * DAY_MS) throw new EngineError("An event can last at most a year");
      startAt = isoInstant(s);
      endAt = isoInstant(e);
      firstDate = utcToLocal(s, tz).date;
    }
    let rrule: string | null = null;
    if (input.rrule != null && input.rrule !== "") {
      if (typeof input.rrule !== "string") throw new EngineError("Repeat rule must be text");
      let rule: RRule;
      try {
        rule = parseRRule(input.rrule);
      } catch (e) {
        if (e instanceof RRuleError) throw new EngineError(e.message);
        throw e;
      }
      if (rule.until) {
        const untilDate = `${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}`;
        if (input.allDay) rule.until = rule.until.slice(0, 8);
        else if (rule.until.length === 8) rule.until = icsUtc(localToUtc(addDays(untilDate, 1), "00:00:00", tz) - 1000);
        else if (!rule.until.endsWith("Z")) rule.until = icsUtc(localToUtc(untilDate, `${rule.until.slice(9, 11)}:${rule.until.slice(11, 13)}:${rule.until.slice(13, 15)}`, tz));
        if (untilDate < firstDate) throw new EngineError("The repeat rule ends before the event starts");
      }
      if (!startMatchesRule(rule, firstDate)) {
        throw new EngineError("The first date must itself be one of the repeat days (e.g. a Monday for a rule that repeats on Mondays)");
      }
      rrule = formatRRule(rule);
    }
    return { tz, startAt, endAt, startDate, endDate, rrule };
  }

  // ---------------------------------------------------------- reading events

  private toEvent(r: Row): Row {
    const local = (iso: string | null) => {
      if (!iso) return null;
      const l = utcToLocal(Date.parse(iso), r.time_zone);
      return `${l.date}T${l.time.slice(0, 5)}`;
    };
    return {
      id: r.id,
      uid: r.uid,
      title: r.title,
      matterId: r.matter_id,
      kind: r.kind,
      source: r.source,
      sourceRef: r.source_ref,
      allDay: !!r.all_day,
      start: r.all_day ? r.start_date : r.start_at,
      end: r.all_day ? r.end_date : r.end_at,
      startLocal: r.all_day ? null : local(r.start_at),
      endLocal: r.all_day ? null : local(r.end_at),
      timeZone: r.time_zone,
      location: r.location,
      notes: r.notes,
      reminders: JSON.parse(r.reminders),
      rrule: r.rrule,
      sequence: r.sequence,
      attendees: this.attendeesOf(r.id),
      exceptions: this.exceptionsOf(r.id).map((x) => ({
        occurrence: x.occurrence,
        cancelled: !!x.cancelled,
        title: x.title,
        start: x.start_at ?? x.start_date,
        end: x.end_at ?? x.end_date,
        location: x.location,
        notes: x.notes,
      })),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  getEvent(id: number): Row {
    return this.toEvent(this.eventRow(id));
  }

  listEvents(filter: { matterId?: number; source?: string; sourceRef?: string } = {}): Row[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.matterId != null) (where.push("matter_id = ?"), params.push(filter.matterId));
    if (filter.source != null) (where.push("source = ?"), params.push(filter.source));
    if (filter.sourceRef != null) (where.push("source_ref = ?"), params.push(filter.sourceRef));
    return this.all(`SELECT * FROM cal_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(start_at, start_date), id`, ...params).map(
      (r) => this.toEvent(r),
    );
  }

  // ---------------------------------------------------------- writing events

  createEvent(input: EventInput, userId: number | null = null): { event: Row; conflicts: Conflict[] } {
    return tx(this.db, () => {
      const title = this.checkText(input?.title, "Title", TITLE_MAX)?.trim();
      if (!title) throw new EngineError("An event needs a title");
      const kind = this.checkKind(input.kind);
      const matterId = this.checkMatter(input.matterId);
      const attendees = this.checkAttendees(input.attendees);
      const reminders = this.checkReminders(input.reminders);
      const t = this.normaliseTiming({ allDay: !!input.allDay, start: input.start, end: input.end, timeZone: input.timeZone, rrule: input.rrule });
      const source = this.checkText(input.source, "Source", 64) ?? "manual";
      const now = isoInstant(this.now());
      const id = this.run(
        `INSERT INTO cal_events (uid, title, matter_id, kind, source, source_ref, all_day, start_at, end_at, start_date, end_date,
           time_zone, location, notes, reminders, rrule, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.uid || `${randomUUID()}@lawdesk`,
        title,
        matterId,
        kind,
        source,
        input.sourceRef ?? null,
        input.allDay ? 1 : 0,
        t.startAt,
        t.endAt,
        t.startDate,
        t.endDate,
        t.tz,
        this.checkText(input.location, "Location", 1000),
        this.checkText(input.notes, "Notes"),
        JSON.stringify(reminders),
        t.rrule,
        userId,
        now,
        now,
      );
      for (const u of attendees) this.run("INSERT INTO cal_attendees (event_id, user_id) VALUES (?,?)", id, u);
      this.log("calendar_event_added", `Added ${KIND_LABEL[kind].toLowerCase()} "${title}" on ${this.describeWhen(id)} (event #${id})`, userId, matterId);
      return { event: this.getEvent(id), conflicts: this.conflictsForEvent(id) };
    });
  }

  private describeWhen(id: number): string {
    const r = this.eventRow(id);
    let s: string;
    if (r.all_day) s = r.start_date === r.end_date ? r.start_date : `${r.start_date} to ${r.end_date}`;
    else {
      const l = utcToLocal(Date.parse(r.start_at), r.time_zone);
      s = `${l.date} ${l.time.slice(0, 5)} ${r.time_zone === FIRM_TZ ? "" : r.time_zone}`.trim();
    }
    return r.rrule ? `${s}, repeating ${r.rrule}` : s;
  }

  updateEvent(id: number, patch: EventPatch, userId: number | null = null): { event: Row; conflicts: Conflict[] } {
    return tx(this.db, () => {
      const r = this.eventRow(id);
      const changes: string[] = [];
      const sets: Record<string, any> = {};
      if (patch.title !== undefined) {
        const title = this.checkText(patch.title, "Title", TITLE_MAX)?.trim();
        if (!title) throw new EngineError("An event needs a title");
        if (title !== r.title) (sets.title = title), changes.push(`title "${title}"`);
      }
      if (patch.kind !== undefined) {
        const k = this.checkKind(patch.kind);
        if (k !== r.kind) (sets.kind = k), changes.push(`kind ${k}`);
      }
      if (patch.matterId !== undefined) {
        const m = this.checkMatter(patch.matterId);
        if (m !== r.matter_id) (sets.matter_id = m), changes.push(m == null ? "removed from matter" : `moved to matter #${m}`);
      }
      for (const [key, col, max] of [
        ["location", "location", 1000],
        ["notes", "notes", 10_000],
        ["source", "source", 64],
        ["sourceRef", "source_ref", 200],
      ] as const) {
        if (patch[key] !== undefined) {
          const v = this.checkText(patch[key], key, max);
          if (v !== r[col]) (sets[col] = key === "source" ? (v ?? "manual") : v), changes.push(key === "notes" ? "notes" : `${key} ${v ?? "cleared"}`);
        }
      }
      if (patch.reminders !== undefined) {
        const rem = JSON.stringify(this.checkReminders(patch.reminders));
        if (rem !== r.reminders) (sets.reminders = rem), changes.push("reminders");
      }
      const timingKeys = ["allDay", "start", "end", "timeZone", "rrule"] as const;
      if (timingKeys.some((k) => patch[k] !== undefined)) {
        const allDay = patch.allDay !== undefined ? !!patch.allDay : !!r.all_day;
        if (allDay !== !!r.all_day && patch.start === undefined) throw new EngineError("Give a new start when switching between all-day and timed");
        const tz = patch.timeZone !== undefined ? patch.timeZone : r.time_zone;
        const curLocal = (iso: string) => {
          const l = utcToLocal(Date.parse(iso), tz ?? FIRM_TZ);
          return `${l.date}T${l.time}`;
        };
        let start = patch.start ?? (allDay ? r.start_date : curLocal(r.start_at));
        let end: unknown = patch.end;
        if (end === undefined) {
          if (allDay !== !!r.all_day) end = null;
          else if (allDay) end = patch.start !== undefined ? addDays(start, daysBetween(r.start_date, r.end_date)) : r.end_date;
          else {
            // keep the length of the event when only the start moves
            const dur = Date.parse(r.end_at) - Date.parse(r.start_at);
            end = isoInstant(this.parseWhen(start, this.checkZone(tz), "Start") + dur);
          }
        }
        const t = this.normaliseTiming({ allDay, start, end, timeZone: tz, rrule: patch.rrule !== undefined ? patch.rrule : r.rrule });
        const before = [r.all_day, r.start_at, r.end_at, r.start_date, r.end_date, r.time_zone, r.rrule].join("|");
        const after = [allDay ? 1 : 0, t.startAt, t.endAt, t.startDate, t.endDate, t.tz, t.rrule].join("|");
        if (before !== after) {
          Object.assign(sets, {
            all_day: allDay ? 1 : 0,
            start_at: t.startAt,
            end_at: t.endAt,
            start_date: t.startDate,
            end_date: t.endDate,
            time_zone: t.tz,
            rrule: t.rrule,
          });
          changes.push("time");
          // Single-occurrence changes are keyed by the old occurrence times; they no longer line up.
          const n = Number(this.one("SELECT COUNT(*) AS n FROM cal_exceptions WHERE event_id = ?", id)!.n);
          if (n) {
            this.run("DELETE FROM cal_exceptions WHERE event_id = ?", id);
            changes.push(`${n} single-occurrence change(s) cleared`);
          }
        }
      }
      let attendeesChanged = false;
      if (patch.attendees !== undefined) {
        const next = this.checkAttendees(patch.attendees).sort((a, b) => a - b);
        const cur = this.attendeesOf(id);
        if (next.join() !== cur.join()) {
          this.run("DELETE FROM cal_attendees WHERE event_id = ?", id);
          for (const u of next) this.run("INSERT INTO cal_attendees (event_id, user_id) VALUES (?,?)", id, u);
          changes.push("attendees");
          attendeesChanged = true;
        }
      }
      if (changes.length) {
        const cols = Object.keys(sets);
        sets.updated_at = isoInstant(this.now());
        sets.sequence = r.sequence + 1;
        const all = [...cols, "updated_at", "sequence"];
        this.run(`UPDATE cal_events SET ${all.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...all.map((c) => sets[c]), id);
        const matterId = sets.matter_id !== undefined ? sets.matter_id : r.matter_id;
        this.log("calendar_event_updated", `"${sets.title ?? r.title}": ${changes.join(", ")} (event #${id})`, userId, matterId ?? r.matter_id);
      }
      const timingChanged = changes.includes("time") || attendeesChanged;
      return { event: this.getEvent(id), conflicts: timingChanged ? this.conflictsForEvent(id) : [] };
    });
  }

  deleteEvent(id: number, userId: number | null = null) {
    tx(this.db, () => {
      const r = this.eventRow(id);
      const when = this.describeWhen(id);
      this.run("DELETE FROM cal_events WHERE id = ?", id);
      this.log("calendar_event_deleted", `Deleted "${r.title}" (${when}) (event #${id})`, userId, r.matter_id);
    });
  }

  // ------------------------------------------------- single occurrences

  /** Check that `key` is a real occurrence of the recurring event. */
  private requireOccurrence(r: Row, key: string) {
    if (!r.rrule) throw new EngineError("Only a repeating event has separate occurrences; edit the event itself", 400);
    const target = r.all_day ? keyToDate(key) : keyToMs(key);
    if (target === null) throw new EngineError(`"${key}" is not an occurrence id like 20260309T140000Z or 20260309`);
    const reached = (o: { startMs: number; date?: string }) => (r.all_day ? o.date! >= (target as string) : o.startMs >= (target as number));
    for (const o of this.seriesOccurrences(r, -Infinity, Infinity, reached)) {
      if (!reached(o)) continue;
      if (o.key === key) return o;
      break;
    }
    throw new EngineError("That date is not one of this event's occurrences", 404);
  }

  cancelOccurrence(id: number, key: string, userId: number | null = null) {
    tx(this.db, () => {
      const r = this.eventRow(id);
      this.requireOccurrence(r, key);
      this.run(
        `INSERT INTO cal_exceptions (event_id, occurrence, cancelled, updated_at) VALUES (?,?,1,?)
         ON CONFLICT (event_id, occurrence) DO UPDATE SET cancelled = 1, title = NULL, start_at = NULL, end_at = NULL,
           start_date = NULL, end_date = NULL, location = NULL, notes = NULL, updated_at = excluded.updated_at`,
        id,
        key,
        isoInstant(this.now()),
      );
      this.bump(id);
      this.log("calendar_occurrence_cancelled", `Cancelled the ${describeKey(key, r.time_zone)} occurrence of "${r.title}" (event #${id})`, userId, r.matter_id);
    });
  }

  editOccurrence(id: number, key: string, patch: OccurrencePatch, userId: number | null = null): { event: Row; conflicts: Conflict[] } {
    return tx(this.db, () => {
      const r = this.eventRow(id);
      const occ = this.requireOccurrence(r, key);
      const existing = this.one("SELECT * FROM cal_exceptions WHERE event_id = ? AND occurrence = ?", id, key);
      const title = patch.title !== undefined ? this.checkText(patch.title, "Title", TITLE_MAX)?.trim() : existing?.title;
      if (patch.title !== undefined && !title) throw new EngineError("An event needs a title");
      let startAt = existing?.start_at ?? null,
        endAt = existing?.end_at ?? null,
        startDate = existing?.start_date ?? null,
        endDate = existing?.end_date ?? null;
      if (patch.start !== undefined || patch.end !== undefined) {
        if (r.all_day) {
          const s = patch.start ?? startDate ?? occ.date!;
          const e = patch.end ?? (patch.start !== undefined ? addDays(s, daysBetween(r.start_date, r.end_date)) : (endDate ?? occ.endDate!));
          if (!isISODate(s) || !isISODate(e)) throw new EngineError("An all-day occurrence starts and ends on dates like 2026-03-09");
          if (e < s) throw new EngineError("The occurrence ends before it starts");
          startDate = s;
          endDate = e;
        } else {
          const s = patch.start !== undefined ? this.parseWhen(patch.start, r.time_zone, "Start") : startAt ? Date.parse(startAt) : occ.startMs;
          const dur = Date.parse(r.end_at) - Date.parse(r.start_at);
          const e = patch.end !== undefined ? this.parseWhen(patch.end, r.time_zone, "End") : s + dur;
          if (e < s) throw new EngineError("The occurrence ends before it starts");
          startAt = isoInstant(s);
          endAt = isoInstant(e);
        }
      }
      const location = patch.location !== undefined ? this.checkText(patch.location, "Location", 1000) : existing?.location ?? null;
      const notes = patch.notes !== undefined ? this.checkText(patch.notes, "Notes") : existing?.notes ?? null;
      this.run(
        `INSERT INTO cal_exceptions (event_id, occurrence, cancelled, title, start_at, end_at, start_date, end_date, location, notes, updated_at)
         VALUES (?,?,0,?,?,?,?,?,?,?,?)
         ON CONFLICT (event_id, occurrence) DO UPDATE SET cancelled = 0, title = excluded.title, start_at = excluded.start_at,
           end_at = excluded.end_at, start_date = excluded.start_date, end_date = excluded.end_date, location = excluded.location,
           notes = excluded.notes, updated_at = excluded.updated_at`,
        id,
        key,
        title ?? null,
        startAt,
        endAt,
        startDate,
        endDate,
        location,
        notes,
        isoInstant(this.now()),
      );
      this.bump(id);
      this.log("calendar_occurrence_changed", `Changed the ${describeKey(key, r.time_zone)} occurrence of "${r.title}" (event #${id})`, userId, r.matter_id);
      return { event: this.getEvent(id), conflicts: this.conflictsForEvent(id) };
    });
  }

  restoreOccurrence(id: number, key: string, userId: number | null = null) {
    tx(this.db, () => {
      const r = this.eventRow(id);
      const n = Number(this.db.prepare("DELETE FROM cal_exceptions WHERE event_id = ? AND occurrence = ?").run(id, key).changes);
      if (!n) throw new EngineError("That occurrence has no changes to undo", 404);
      this.bump(id);
      this.log("calendar_occurrence_restored", `Restored the ${describeKey(key, r.time_zone)} occurrence of "${r.title}" (event #${id})`, userId, r.matter_id);
    });
  }

  private bump(id: number) {
    this.run("UPDATE cal_events SET sequence = sequence + 1, updated_at = ? WHERE id = ?", isoInstant(this.now()), id);
  }

  // ------------------------------------------------------------- expansion

  /**
   * The series' occurrences as generated by its rule (exceptions not applied), in order.
   * `stop` ends the walk at the first occurrence for which it returns true (that one is yielded).
   */
  private *seriesOccurrences(
    r: Row,
    _from: number,
    _to: number,
    stop?: (o: { key: string; startMs: number; date?: string }) => boolean,
  ): Generator<{ key: string; startMs: number; endMs: number; date?: string; endDate?: string }> {
    const tz = r.time_zone;
    if (r.all_day) {
      const len = daysBetween(r.start_date, r.end_date);
      const mk = (date: string) => {
        const endDate = addDays(date, len);
        return { key: icsDate(date), date, endDate, startMs: dayBounds(date, tz).start, endMs: dayBounds(endDate, tz).end };
      };
      if (!r.rrule) {
        yield mk(r.start_date);
        return;
      }
      const rule = parseRRule(r.rrule);
      const untilDate = rule.until ? `${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}` : null;
      let i = 0;
      for (const d of occurrenceDates(rule, r.start_date)) {
        if (untilDate && d > untilDate) return;
        if (++i > MAX_ITER) return;
        const o = mk(d);
        yield o;
        if (stop?.(o)) return;
      }
      return;
    }
    const s0 = Date.parse(r.start_at);
    const dur = Date.parse(r.end_at) - s0;
    if (!r.rrule) {
      yield { key: icsUtc(s0), startMs: s0, endMs: s0 + dur };
      return;
    }
    const rule = parseRRule(r.rrule);
    const first = utcToLocal(s0, tz);
    const untilMs = rule.until ? untilInstant(rule.until, (d) => localToUtc(addDays(d, 1), "00:00:00", tz) - 1000) : Infinity;
    let i = 0;
    for (const d of occurrenceDates(rule, first.date)) {
      const s = d === first.date ? s0 : localToUtc(d, first.time, tz);
      if (s > untilMs) return;
      if (++i > MAX_ITER) return;
      const o = { key: icsUtc(s), startMs: s, endMs: s + dur };
      yield o;
      if (stop?.(o)) return;
    }
  }

  /** Occurrences of one event overlapping [fromMs, toMs), with single-occurrence changes applied. */
  private expand(r: Row, fromMs: number, toMs: number, attendees?: number[], exceptions?: Row[]): Occurrence[] {
    const ex = new Map((exceptions ?? this.exceptionsOf(r.id)).map((x) => [x.occurrence, x]));
    const att = attendees ?? this.attendeesOf(r.id);
    const reminders = JSON.parse(r.reminders);
    const tz = r.time_zone;
    const base = (key: string, startMs: number, endMs: number, date: string | undefined, endDate: string | undefined, x?: Row): Occurrence => {
      const local = (ms: number) => {
        const l = utcToLocal(ms, tz);
        return `${l.date}T${l.time.slice(0, 5)}`;
      };
      return {
        type: "event",
        eventId: r.id,
        uid: r.uid,
        occurrence: key,
        title: x?.title ?? r.title,
        kind: r.kind,
        matterId: r.matter_id,
        allDay: !!r.all_day,
        start: r.all_day ? date! : isoInstant(startMs),
        end: r.all_day ? endDate! : isoInstant(endMs),
        startMs,
        endMs,
        startLocal: r.all_day ? null : local(startMs),
        endLocal: r.all_day ? null : local(endMs),
        timeZone: tz,
        location: x?.location ?? r.location,
        notes: x?.notes ?? r.notes,
        attendees: att,
        reminders,
        recurring: !!r.rrule,
        modified: !!x,
      };
    };
    const out: Occurrence[] = [];
    // Pad the walk by the event's length so an occurrence that started before the window but is still going is found.
    const span = r.all_day ? (daysBetween(r.start_date, r.end_date) + 2) * DAY_MS : Date.parse(r.end_at) - Date.parse(r.start_at);
    for (const o of this.seriesOccurrences(r, fromMs, toMs, (o) => o.startMs >= toMs)) {
      if (o.startMs >= toMs) break;
      if (o.startMs + span + DAY_MS < fromMs) continue;
      if (ex.has(o.key)) continue;
      if (o.endMs > fromMs || (o.endMs === o.startMs && o.startMs >= fromMs)) out.push(base(o.key, o.startMs, o.endMs, o.date, o.endDate));
    }
    if (r.rrule) {
      for (const x of ex.values()) {
        if (x.cancelled) continue;
        let o: Occurrence;
        if (r.all_day) {
          const len = daysBetween(r.start_date, r.end_date);
          const orig = keyToDate(x.occurrence)!;
          const sd = x.start_date ?? orig;
          const ed = x.end_date ?? addDays(sd, len);
          o = base(x.occurrence, dayBounds(sd, tz).start, dayBounds(ed, tz).end, sd, ed, x);
        } else {
          const dur = Date.parse(r.end_at) - Date.parse(r.start_at);
          const s = x.start_at ? Date.parse(x.start_at) : keyToMs(x.occurrence)!;
          const e = x.end_at ? Date.parse(x.end_at) : s + dur;
          o = base(x.occurrence, s, e, undefined, undefined, x);
        }
        if (o.startMs < toMs && (o.endMs > fromMs || (o.endMs === o.startMs && o.startMs >= fromMs))) out.push(o);
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  /** All occurrences overlapping [fromMs, toMs), optionally only events a user attends. */
  occurrences(fromMs: number, toMs: number, filter: { userId?: number; eventIds?: number[] } = {}): Occurrence[] {
    const fromIso = isoInstant(fromMs);
    const toIso = isoInstant(toMs);
    const fromDate = new Date(fromMs - 2 * DAY_MS).toISOString().slice(0, 10);
    const toDate = new Date(toMs + 2 * DAY_MS).toISOString().slice(0, 10);
    const where = [
      `(rrule IS NOT NULL OR (all_day = 0 AND start_at < ? AND end_at >= ?) OR (all_day = 1 AND start_date <= ? AND end_date >= ?))`,
    ];
    const params: any[] = [toIso, fromIso, toDate, fromDate];
    if (filter.userId != null) {
      where.push("id IN (SELECT event_id FROM cal_attendees WHERE user_id = ?)");
      params.push(filter.userId);
    }
    if (filter.eventIds) {
      where.push(`id IN (${filter.eventIds.map(() => "?").join(",") || "NULL"})`);
      params.push(...filter.eventIds);
    }
    const out: Occurrence[] = [];
    for (const r of this.all(`SELECT * FROM cal_events WHERE ${where.join(" AND ")}`, ...params)) out.push(...this.expand(r, fromMs, toMs));
    return out.sort((a, b) => a.startMs - b.startMs || a.eventId - b.eventId);
  }

  // ------------------------------------------------------------- conflicts

  /** Overlapping timed occurrences among the given ones, per attendee. All-day items never conflict. */
  private findConflicts(occs: Occurrence[], onlyUsers?: Set<number>, mustInclude?: number): Conflict[] {
    const byUser = new Map<number, Occurrence[]>();
    for (const o of occs) {
      if (o.allDay || o.endMs <= o.startMs) continue;
      for (const u of o.attendees) {
        if (onlyUsers && !onlyUsers.has(u)) continue;
        if (!byUser.has(u)) byUser.set(u, []);
        byUser.get(u)!.push(o);
      }
    }
    const names = new Map<number, string>();
    const out: Conflict[] = [];
    const brief = (o: Occurrence) => ({ eventId: o.eventId, occurrence: o.occurrence, title: o.title, start: o.start, end: o.end });
    for (const [u, list] of byUser) {
      list.sort((a, b) => a.startMs - b.startMs);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length && list[j].startMs < list[i].endMs; j++) {
          const a = list[i],
            b = list[j];
          if (a.eventId === b.eventId && a.occurrence === b.occurrence) continue;
          if (mustInclude !== undefined && a.eventId !== mustInclude && b.eventId !== mustInclude) continue;
          if (!names.has(u)) names.set(u, this.one("SELECT name FROM users WHERE id = ?", u)?.name ?? `User ${u}`);
          out.push({ userId: u, userName: names.get(u)!, a: brief(a), b: brief(b) });
        }
      }
    }
    return out;
  }

  /** Double-bookings that involve this event, over its next year of occurrences. */
  conflictsForEvent(id: number): Conflict[] {
    const r = this.eventRow(id);
    if (r.all_day) return [];
    const att = this.attendeesOf(id);
    if (!att.length) return [];
    const from = Math.max(Date.parse(r.start_at), this.now() - DAY_MS);
    const mine = this.expand(r, r.rrule ? from : Date.parse(r.start_at), r.rrule ? from + 366 * DAY_MS : Date.parse(r.end_at) + 1);
    if (!mine.length) return [];
    const lo = mine[0].startMs;
    const hi = Math.max(...mine.map((o) => o.endMs));
    const others = new Map<number, Occurrence>();
    const pool: Occurrence[] = [...mine];
    for (const u of att) for (const o of this.occurrences(lo, hi, { userId: u })) if (o.eventId !== id) others.set(o.eventId * 1e15 + o.startMs, o);
    pool.push(...others.values());
    return this.findConflicts(pool, new Set(att), id);
  }

  /** Is anyone in `userIds` already busy between start and end? (for a "you're double-booked" warning before saving) */
  checkAvailability(userIds: number[], start: string, end: string, opts: { timeZone?: string; excludeEventId?: number } = {}) {
    const tz = this.checkZone(opts.timeZone);
    const s = this.parseWhen(start, tz, "Start");
    const e = this.parseWhen(end, tz, "End");
    if (e <= s) throw new EngineError("The end must be after the start");
    const busy: { userId: number; eventId: number; occurrence: string; title: string; start: string; end: string }[] = [];
    for (const u of this.checkAttendees(userIds)) {
      for (const o of this.occurrences(s, e, { userId: u })) {
        if (o.allDay || o.eventId === opts.excludeEventId || o.endMs <= s) continue;
        busy.push({ userId: u, eventId: o.eventId, occurrence: o.occurrence, title: o.title, start: o.start, end: o.end });
      }
    }
    return busy;
  }

  // ---------------------------------------------------------------- agenda

  /**
   * Everything on the calendar between two dates (inclusive, in `timeZone`), for one user or the
   * whole firm: event occurrences plus task due dates (read-only, from the engine's tasks), and
   * any double-bookings among them.
   */
  agenda(opts: { from: ISODate; to: ISODate; userId?: number | null; timeZone?: string; includeTasks?: boolean; includeDoneTasks?: boolean }) {
    const tz = opts.timeZone ? this.checkZoneLoose(opts.timeZone) : FIRM_TZ;
    if (!isISODate(opts.from) || !isISODate(opts.to)) throw new EngineError("from and to must be dates like 2026-03-09");
    if (opts.to < opts.from) throw new EngineError("to is before from");
    if (daysBetween(opts.from, opts.to) > 400) throw new EngineError("Ask for at most about a year at a time");
    if (opts.userId != null && !this.one("SELECT 1 FROM users WHERE id = ?", opts.userId)) throw new EngineError("User not found", 404);
    const fromMs = dayBounds(opts.from, tz).start;
    const toMs = dayBounds(opts.to, tz).end;
    const occs = this.occurrences(fromMs, toMs, { userId: opts.userId ?? undefined });
    const conflicts = this.findConflicts(occs, opts.userId != null ? new Set([opts.userId]) : undefined);
    const conflicted = new Set(conflicts.flatMap((c) => [`${c.a.eventId}/${c.a.occurrence}`, `${c.b.eventId}/${c.b.occurrence}`]));
    const matterNames = new Map<number, Row>();
    const matter = (id: number | null) => {
      if (id == null) return null;
      if (!matterNames.has(id)) matterNames.set(id, this.one("SELECT id, number, name FROM matters WHERE id = ?", id)!);
      return matterNames.get(id) ?? null;
    };
    const items: Row[] = occs.map((o) => ({
      ...o,
      date: o.allDay ? (o.start < opts.from ? opts.from : o.start) : utcToLocal(o.startMs, tz).date,
      matter: matter(o.matterId),
      conflict: conflicted.has(`${o.eventId}/${o.occurrence}`),
    }));
    if (opts.includeTasks !== false) {
      const where = ["t.due_date >= ?", "t.due_date <= ?"];
      const params: any[] = [opts.from, opts.to];
      where.push(opts.includeDoneTasks ? "1 = 1" : "t.status IN ('open','waiting')");
      if (opts.userId != null) (where.push("t.assignee_id = ?"), params.push(opts.userId));
      for (const t of this.all(
        `SELECT t.id, t.title, t.due_date, t.status, t.priority, t.matter_id, t.assignee_id, u.name AS assignee_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE ${where.join(" AND ")} ORDER BY t.due_date, t.id`,
        ...params,
      )) {
        items.push({
          type: "task",
          taskId: t.id,
          title: t.title,
          date: t.due_date,
          dueDate: t.due_date,
          allDay: true,
          status: t.status,
          priority: t.priority,
          matterId: t.matter_id,
          matter: matter(t.matter_id),
          assigneeId: t.assignee_id,
          assigneeName: t.assignee_name,
          startMs: dayBounds(t.due_date, tz).start,
        });
      }
    }
    // Per day: all-day items and tasks first, then timed events by start.
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || (a.type === b.type ? 0 : a.type === "event" ? -1 : 1));
    for (const it of items) delete it.startMs, delete it.endMs;
    return { from: opts.from, to: opts.to, timeZone: tz, userId: opts.userId ?? null, items, conflicts };
  }

  /** Viewing zone for an agenda can be any IANA zone. */
  private checkZoneLoose(tz: string): string {
    if (!isValidTimeZone(tz)) throw new EngineError(`Unknown time zone "${tz}"`);
    return tz;
  }

  // ------------------------------------------------------------- reminders

  /**
   * Reminders that fall due in [from, to): one entry per occurrence and reminder, with the users to
   * notify. All-day reminders count back from midnight at the start of the day in the event's zone.
   * A notification job can call this every few minutes with the window since its last run.
   */
  remindersDue(from: Date | string, to: Date | string): ReminderDue[] {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) throw new EngineError("Bad reminder window");
    const rows = this.all("SELECT * FROM cal_events WHERE reminders <> '[]'");
    const out: ReminderDue[] = [];
    for (const r of rows) {
      const lead = Math.max(...JSON.parse(r.reminders)) * 60_000;
      for (const o of this.expand(r, fromMs, toMs + lead)) {
        if (o.startMs < fromMs) continue;
        for (const m of o.reminders) {
          const fire = o.startMs - m * 60_000;
          if (fire >= fromMs && fire < toMs) {
            out.push({
              eventId: o.eventId,
              occurrence: o.occurrence,
              title: o.title,
              kind: o.kind,
              matterId: o.matterId,
              start: o.start,
              allDay: o.allDay,
              minutesBefore: m,
              fireAt: isoInstant(fire),
              userIds: o.attendees,
            });
          }
        }
      }
    }
    return out.sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : a.eventId - b.eventId));
  }

  // ------------------------------------------------------------ feed tokens

  /** Make a secret feed URL token. The token is returned once; only its SHA-256 is stored. */
  createFeedToken(userId: number, opts: { scope?: "mine" | "firm"; label?: string | null } = {}, actorId: number | null = userId) {
    if (!Number.isInteger(userId) || !this.one("SELECT 1 FROM users WHERE id = ?", userId)) throw new EngineError("User not found", 404);
    const scope = opts.scope ?? "mine";
    if (scope !== "mine" && scope !== "firm") throw new EngineError("Scope must be mine or firm");
    const token = randomBytes(32).toString("base64url");
    const now = isoInstant(this.now());
    return tx(this.db, () => {
      const id = this.run(
        "INSERT INTO cal_feed_tokens (user_id, token_hash, scope, label, created_at) VALUES (?,?,?,?,?)",
        userId,
        hashToken(token),
        scope,
        this.checkText(opts.label, "Label", 200),
        now,
      );
      this.log("calendar_feed_created", `Created a ${scope === "firm" ? "whole-firm" : "personal"} calendar feed link (feed #${id}) for user #${userId}`, actorId, null);
      return { id, token, path: `/calendar/feed/${token}.ics`, scope };
    });
  }

  listFeedTokens(userId: number) {
    return this.all(
      "SELECT id, user_id AS userId, scope, label, created_at AS createdAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt FROM cal_feed_tokens WHERE user_id = ? ORDER BY id",
      userId,
    );
  }

  revokeFeedToken(id: number, actorId: number | null = null) {
    tx(this.db, () => {
      const t = this.one("SELECT * FROM cal_feed_tokens WHERE id = ?", id);
      if (!t) throw new EngineError("Feed link not found", 404);
      if (t.revoked_at) return;
      this.run("UPDATE cal_feed_tokens SET revoked_at = ? WHERE id = ?", isoInstant(this.now()), id);
      this.log("calendar_feed_revoked", `Turned off calendar feed link #${id} for user #${t.user_id}`, actorId, null);
    });
  }

  /** The .ics text for a feed token, or null when the token is unknown or revoked. */
  feedForToken(token: string): string | null {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    const t = this.one("SELECT * FROM cal_feed_tokens WHERE token_hash = ? AND revoked_at IS NULL", hashToken(token));
    if (!t) return null;
    this.run("UPDATE cal_feed_tokens SET last_used_at = ? WHERE id = ?", isoInstant(this.now()), t.id);
    const user = this.one("SELECT name FROM users WHERE id = ?", t.user_id);
    return this.buildIcs(t.scope === "firm" ? { name: "Firm calendar" } : { userId: t.user_id, name: `Lawdesk: ${user?.name ?? "calendar"}` });
  }

  /**
   * An RFC 5545 calendar of events and open task due dates.
   *   - timed events use DTSTART;TZID=... with a VTIMEZONE, all-day events use VALUE=DATE with an
   *     exclusive DTEND (RFC 5545 §3.6.1);
   *   - recurring events carry their RRULE, cancelled occurrences as EXDATE, and changed occurrences
   *     as extra VEVENTs with the same UID and a RECURRENCE-ID (§3.8.4.4);
   *   - DTSTAMP is when the event was last changed, as §3.8.7.2 asks of a calendar with no METHOD;
   *   - task due dates are all-day VEVENTs, not VTODOs. Outlook "ignores them [VTODO] on import"
   *     ([MS-STANOICAL] 2.2.44, https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/950b6393-abca-4678-a3ce-4bdc4c5a8974)
   *     and Google Calendar imports only events and ignores VTODO entries
   *     (https://groups.google.com/g/tasks-backup/c/YVUSYThNtl8, https://bugs.kde.org/show_bug.cgi?id=435551).
   */
  buildIcs(opts: { userId?: number; name?: string; pastDays?: number } = {}): string {
    const now = this.now();
    const pastCutoff = now - (opts.pastDays ?? 180) * DAY_MS;
    const where: string[] = [];
    const params: any[] = [];
    if (opts.userId != null) (where.push("e.id IN (SELECT event_id FROM cal_attendees WHERE user_id = ?)"), params.push(opts.userId));
    where.push("(e.rrule IS NOT NULL OR COALESCE(e.end_at, e.end_date) >= ?)");
    params.push(new Date(pastCutoff).toISOString().slice(0, 10));
    const events = this.all(
      `SELECT e.*, m.number AS matter_number, m.name AS matter_name FROM cal_events e LEFT JOIN matters m ON m.id = e.matter_id
       WHERE ${where.join(" AND ")} ORDER BY COALESCE(e.start_at, e.start_date), e.id`,
      ...params,
    );
    const w = new IcsWriter()
      .begin("VCALENDAR")
      .prop("VERSION", "2.0")
      .prop("PRODID", "-//Lawdesk//Firm calendar//EN")
      .prop("CALSCALE", "GREGORIAN")
      .text("X-WR-CALNAME", opts.name ?? "Lawdesk")
      .text("NAME", opts.name ?? "Lawdesk") // RFC 7986 §5.1
      .prop("X-WR-TIMEZONE", FIRM_TZ)
      .prop("REFRESH-INTERVAL", "PT1H", { VALUE: "DURATION" }) // RFC 7986 §5.7
      .prop("X-PUBLISHED-TTL", "PT1H");
    const zones = new Set<string>([FIRM_TZ, ...events.filter((e) => !e.all_day).map((e) => e.time_zone)]);
    for (const z of zones) w.raw(vtimezone(z));

    const userNames = new Map(this.all("SELECT id, name FROM users").map((u) => [u.id, u.name]));
    for (const e of events) {
      const att = this.attendeesOf(e.id);
      const ex = this.exceptionsOf(e.id);
      const matterLabel = e.matter_id ? [e.matter_number, e.matter_name].filter(Boolean).join(" ") : null;
      const description = (notes: string | null) =>
        [
          `${KIND_LABEL[e.kind as Kind]}`,
          matterLabel ? `Matter: ${matterLabel}` : null,
          att.length ? `Attendees: ${att.map((u) => userNames.get(u) ?? `User ${u}`).join(", ")}` : null,
          notes ? `\n${notes}` : null,
        ]
          .filter((x) => x !== null)
          .join("\n");
      const summary = (title: string) => (matterLabel && e.matter_number && !title.includes(e.matter_number) ? `${title} [${e.matter_number}]` : title);
      const timeProps = (startAt: string | null, endAt: string | null, startDate: string | null, endDate: string | null) => {
        if (e.all_day) {
          w.prop("DTSTART", icsDate(startDate!), { VALUE: "DATE" });
          w.prop("DTEND", icsDate(addDays(endDate!, 1)), { VALUE: "DATE" });
        } else {
          const s = utcToLocal(Date.parse(startAt!), e.time_zone);
          const en = utcToLocal(Date.parse(endAt!), e.time_zone);
          w.prop("DTSTART", icsLocal(s.date, s.time), { TZID: e.time_zone });
          w.prop("DTEND", icsLocal(en.date, en.time), { TZID: e.time_zone });
        }
      };
      const keyProp = (name: string, key: string) => {
        if (e.all_day) w.prop(name, key, { VALUE: "DATE" });
        else {
          const l = utcToLocal(keyToMs(key)!, e.time_zone);
          w.prop(name, icsLocal(l.date, l.time), { TZID: e.time_zone });
        }
      };
      const common = (title: string, location: string | null, notes: string | null) => {
        w.prop("DTSTAMP", icsUtc(Date.parse(e.updated_at)))
          .prop("CREATED", icsUtc(Date.parse(e.created_at)))
          .prop("LAST-MODIFIED", icsUtc(Date.parse(e.updated_at)))
          .prop("SEQUENCE", String(e.sequence))
          .text("SUMMARY", summary(title))
          .text("LOCATION", location)
          .text("DESCRIPTION", description(notes))
          .prop("CATEGORIES", escapeText(KIND_LABEL[e.kind as Kind]))
          .prop("STATUS", "CONFIRMED")
          .prop("TRANSP", e.all_day ? "TRANSPARENT" : "OPAQUE");
      };
      const alarms = (title: string) => {
        for (const m of JSON.parse(e.reminders) as number[]) {
          w.begin("VALARM").prop("ACTION", "DISPLAY").text("DESCRIPTION", title).prop("TRIGGER", m === 0 ? "PT0S" : `-PT${m}M`).end("VALARM");
        }
      };

      w.begin("VEVENT").prop("UID", escapeText(e.uid));
      common(e.title, e.location, e.notes);
      timeProps(e.start_at, e.end_at, e.start_date, e.end_date);
      if (e.rrule) {
        w.prop("RRULE", e.rrule);
        for (const x of ex) if (x.cancelled) keyProp("EXDATE", x.occurrence);
      }
      alarms(e.title);
      w.end("VEVENT");

      if (e.rrule) {
        for (const x of ex) {
          if (x.cancelled) continue;
          w.begin("VEVENT").prop("UID", escapeText(e.uid));
          keyProp("RECURRENCE-ID", x.occurrence);
          common(x.title ?? e.title, x.location ?? e.location, x.notes ?? e.notes);
          if (e.all_day) {
            const len = daysBetween(e.start_date, e.end_date);
            const sd = x.start_date ?? keyToDate(x.occurrence)!;
            timeProps(null, null, sd, x.end_date ?? addDays(sd, len));
          } else {
            const dur = Date.parse(e.end_at) - Date.parse(e.start_at);
            const s = x.start_at ? Date.parse(x.start_at) : keyToMs(x.occurrence)!;
            const en = x.end_at ? Date.parse(x.end_at) : s + dur;
            timeProps(isoInstant(s), isoInstant(en), null, null);
          }
          alarms(x.title ?? e.title);
          w.end("VEVENT");
        }
      }
    }

    // Open tasks with due dates, as all-day events.
    const tWhere = ["t.due_date IS NOT NULL", "t.status IN ('open','waiting')", "t.due_date >= ?", "(m.status IS NULL OR m.status = 'open')"];
    const tParams: any[] = [new Date(now - 90 * DAY_MS).toISOString().slice(0, 10)];
    if (opts.userId != null) (tWhere.push("t.assignee_id = ?"), tParams.push(opts.userId));
    const tasks = this.all(
      `SELECT t.*, m.number AS matter_number, m.name AS matter_name, u.name AS assignee_name,
         (SELECT MAX(a.at) FROM activity a WHERE a.task_id = t.id) AS changed_at
       FROM tasks t LEFT JOIN matters m ON m.id = t.matter_id LEFT JOIN users u ON u.id = t.assignee_id
       WHERE ${tWhere.join(" AND ")} ORDER BY t.due_date, t.id`,
      ...tParams,
    );
    for (const t of tasks) {
      const stamp = t.changed_at ? Date.parse(t.changed_at) : Date.parse(t.created_on + "T00:00:00Z");
      const matterLabel = t.matter_id ? [t.matter_number, t.matter_name].filter(Boolean).join(" ") : null;
      w.begin("VEVENT")
        .prop("UID", `task-${t.id}@lawdesk`)
        .prop("DTSTAMP", icsUtc(stamp))
        .text("SUMMARY", `Due: ${t.title}${t.matter_number ? ` [${t.matter_number}]` : ""}`)
        .prop("DTSTART", icsDate(t.due_date), { VALUE: "DATE" })
        .prop("DTEND", icsDate(addDays(t.due_date, 1)), { VALUE: "DATE" })
        .text(
          "DESCRIPTION",
          [
            "Task",
            matterLabel ? `Matter: ${matterLabel}` : null,
            t.assignee_name ? `Assigned to: ${t.assignee_name}` : "Unassigned",
            `Status: ${t.status}`,
            t.priority !== "normal" ? `Priority: ${t.priority}` : null,
            t.description ? `\n${t.description}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
        )
        .prop("CATEGORIES", "Task")
        .prop("TRANSP", "TRANSPARENT")
        .end("VEVENT");
    }
    w.end("VCALENDAR");
    return w.toString();
  }

  // ---------------------------------------------------------------- import

  /**
   * Import the VEVENTs of one .ics file. Events keep their UID, so importing the same file again
   * updates what it created instead of duplicating it. Repeat rules outside the supported subset
   * import the first occurrence only, with a warning.
   */
  importIcs(
    text: string,
    opts: { userId?: number | null; matterId?: number | null; attendees?: number[]; kind?: Kind } = {},
  ): { created: number[]; updated: number[]; skipped: { uid: string | null; summary: string | null; reason: string }[]; warnings: string[] } {
    if (typeof text !== "string" || !text.trim()) throw new EngineError("The file is empty");
    if (text.length > 5_000_000) throw new EngineError("The file is too large");
    let root: IcsComponent;
    try {
      root = parseIcs(text);
    } catch (e) {
      throw new EngineError(`Not a readable .ics file: ${(e as Error).message}`);
    }
    const cal = root.children.find((c) => c.type === "VCALENDAR");
    if (!cal) throw new EngineError("Not an .ics file (no VCALENDAR)");
    const calTz = getProp(cal, "X-WR-TIMEZONE")?.value;
    const defaultKind = opts.kind !== undefined ? this.checkKind(opts.kind) : undefined;
    const userId = opts.userId ?? null;
    const out = { created: [] as number[], updated: [] as number[], skipped: [] as { uid: string | null; summary: string | null; reason: string }[], warnings: [] as string[] };
    const vevents = cal.children.filter((c) => c.type === "VEVENT");
    const masters = vevents.filter((v) => !getProp(v, "RECURRENCE-ID"));
    const overrides = vevents.filter((v) => getProp(v, "RECURRENCE-ID"));

    const resolveZone = (tzid: string | null): { tz: string; ok: boolean } => {
      const name = tzid ?? calTz ?? FIRM_TZ;
      if (ZONES[name]) return { tz: name, ok: true };
      const mapped = WINDOWS_ZONES[name];
      if (mapped && ZONES[mapped]) return { tz: mapped, ok: true };
      return { tz: FIRM_TZ, ok: false };
    };
    /** An IcsTime as epoch ms (timed) plus the zone to keep. */
    const toMs = (t: IcsTime, summary: string): { ms: number; tz: string } => {
      if (t.kind === "utc") return { ms: t.ms, tz: FIRM_TZ };
      if (t.kind === "date") throw new Error("date");
      const z = resolveZone(t.tzid);
      if (z.ok) return { ms: localToUtc(t.date, t.time, z.tz), tz: z.tz };
      const name = t.tzid ?? calTz!;
      if (isValidTimeZone(name)) {
        out.warnings.push(`"${summary}": time zone ${name} converted to ${FIRM_TZ}`);
        return { ms: localToUtc(t.date, t.time, name), tz: FIRM_TZ };
      }
      out.warnings.push(`"${summary}": unknown time zone ${name}; read as ${FIRM_TZ}`);
      return { ms: localToUtc(t.date, t.time, FIRM_TZ), tz: FIRM_TZ };
    };
    const localIn = (ms: number, tz: string) => {
      const l = utcToLocal(ms, tz);
      return `${l.date}T${l.time}`;
    };

    tx(this.db, () => {
      const imported = new Map<string, number>();
      for (const v of masters) {
        const uidRaw = getProp(v, "UID")?.value;
        const uid = uidRaw ? unescapeText(uidRaw) : null;
        const summary = getProp(v, "SUMMARY") ? unescapeText(getProp(v, "SUMMARY")!.value).trim() : null;
        try {
          if (getProp(v, "STATUS")?.value.toUpperCase() === "CANCELLED") {
            out.skipped.push({ uid, summary, reason: "cancelled" });
            continue;
          }
          const ds = getProp(v, "DTSTART");
          if (!ds) {
            out.skipped.push({ uid, summary, reason: "no start (DTSTART)" });
            continue;
          }
          const title = summary || "(no title)";
          const start = parseIcsTime(ds.value, ds.params);
          const de = getProp(v, "DTEND");
          const dur = getProp(v, "DURATION");
          const input: EventInput = {
            title,
            matterId: opts.matterId ?? null,
            kind: defaultKind ?? kindFromCategories(getProps(v, "CATEGORIES").map((p) => p.value).join(",")),
            source: "ics_import",
            sourceRef: uid,
            location: getProp(v, "LOCATION") ? unescapeText(getProp(v, "LOCATION")!.value) : null,
            notes: getProp(v, "DESCRIPTION") ? unescapeText(getProp(v, "DESCRIPTION")!.value) : null,
            attendees: opts.attendees ?? [],
            start: "",
          };
          let tz = FIRM_TZ;
          if (start.kind === "date") {
            input.allDay = true;
            input.start = start.date;
            let endExcl: string;
            if (de) {
              const e = parseIcsTime(de.value, de.params);
              endExcl = e.kind === "date" ? e.date : start.date;
            } else if (dur) endExcl = addDays(start.date, Math.max(1, Math.round(parseDuration(dur.value) / DAY_MS)));
            else endExcl = addDays(start.date, 1);
            input.end = endExcl > start.date ? addDays(endExcl, -1) : start.date;
          } else {
            const s = toMs(start, title);
            tz = s.tz;
            let endMs = s.ms;
            if (de) {
              const e = parseIcsTime(de.value, de.params);
              endMs = e.kind === "date" ? s.ms : toMs(e, title).ms;
            } else if (dur) endMs = s.ms + parseDuration(dur.value);
            input.timeZone = tz;
            input.start = localIn(s.ms, tz);
            input.end = localIn(Math.max(endMs, s.ms), tz);
          }
          const rr = getProp(v, "RRULE");
          if (rr) {
            try {
              parseRRule(rr.value);
              input.rrule = rr.value;
            } catch (e) {
              out.warnings.push(`"${title}": repeat rule not supported (${(e as Error).message}); imported the first occurrence only`);
            }
          }
          if (getProps(v, "RDATE").length) out.warnings.push(`"${title}": extra dates (RDATE) were not imported`);
          // Alarms: VALARM with a relative TRIGGER before the start
          const rem: number[] = [];
          for (const a of v.children.filter((c) => c.type === "VALARM")) {
            const tr = getProp(a, "TRIGGER");
            if (!tr || tr.params.VALUE === "DATE-TIME" || (tr.params.RELATED ?? "START") !== "START") continue;
            try {
              const ms = parseDuration(tr.value);
              if (ms <= 0) rem.push(Math.round(-ms / 60_000));
            } catch {
              /* ignore */
            }
          }
          input.reminders = rem.slice(0, 10);

          const existing = uid ? this.one("SELECT id, source FROM cal_events WHERE uid = ?", uid) : undefined;
          let id: number;
          if (existing) {
            if (existing.source !== "ics_import") {
              out.skipped.push({ uid, summary, reason: "already on the calendar" });
              continue;
            }
            const { attendees: _a, matterId: _m, ...patch } = input;
            id = this.updateEvent(existing.id, { ...patch, rrule: input.rrule ?? null }, userId).event.id;
            out.updated.push(id);
          } else {
            id = this.createEvent({ ...input, uid }, userId).event.id;
            out.created.push(id);
          }
          if (uid) imported.set(uid, id);
          // EXDATEs become cancelled occurrences.
          if (input.rrule) {
            for (const p of getProps(v, "EXDATE")) {
              for (const val of p.value.split(",")) {
                try {
                  const t = parseIcsTime(val, p.params);
                  const key = input.allDay ? icsDate(t.kind === "date" ? t.date : utcToLocal(t.kind === "utc" ? t.ms : toMs(t, title).ms, tz).date) : icsUtc(t.kind === "date" ? localToUtc(t.date, input.start.slice(11) || "00:00:00", tz) : toMs(t, title).ms);
                  this.cancelOccurrence(id, key, userId);
                } catch (e) {
                  out.warnings.push(`"${title}": skipped an excluded date ${val} (${(e as Error).message})`);
                }
              }
            }
          }
        } catch (e) {
          out.skipped.push({ uid, summary, reason: (e as Error).message });
        }
      }
      for (const v of overrides) {
        const uid = getProp(v, "UID") ? unescapeText(getProp(v, "UID")!.value) : null;
        const summary = getProp(v, "SUMMARY") ? unescapeText(getProp(v, "SUMMARY")!.value).trim() : null;
        const id = uid ? imported.get(uid) : undefined;
        if (!id) {
          out.skipped.push({ uid, summary, reason: "changed occurrence of an event not in the file" });
          continue;
        }
        try {
          const r = this.eventRow(id);
          const rid = getProp(v, "RECURRENCE-ID")!;
          const rt = parseIcsTime(rid.value, rid.params);
          const key = r.all_day
            ? icsDate(rt.kind === "date" ? rt.date : utcToLocal(rt.kind === "utc" ? rt.ms : toMs(rt, r.title).ms, r.time_zone).date)
            : icsUtc(rt.kind === "utc" ? rt.ms : rt.kind === "local" ? toMs(rt, r.title).ms : localToUtc(rt.date, utcToLocal(Date.parse(r.start_at), r.time_zone).time, r.time_zone));
          if (getProp(v, "STATUS")?.value.toUpperCase() === "CANCELLED") {
            this.cancelOccurrence(id, key, userId);
            continue;
          }
          const patch: OccurrencePatch = {};
          if (summary) patch.title = summary;
          if (getProp(v, "LOCATION")) patch.location = unescapeText(getProp(v, "LOCATION")!.value);
          if (getProp(v, "DESCRIPTION")) patch.notes = unescapeText(getProp(v, "DESCRIPTION")!.value);
          const ds = getProp(v, "DTSTART");
          if (ds) {
            const st = parseIcsTime(ds.value, ds.params);
            const de = getProp(v, "DTEND");
            if (r.all_day && st.kind === "date") {
              patch.start = st.date;
              if (de) {
                const e = parseIcsTime(de.value, de.params);
                if (e.kind === "date") patch.end = e.date > st.date ? addDays(e.date, -1) : st.date;
              }
            } else if (!r.all_day && st.kind !== "date") {
              patch.start = localIn(toMs(st, r.title).ms, r.time_zone);
              if (de) {
                const e = parseIcsTime(de.value, de.params);
                if (e.kind !== "date") patch.end = localIn(toMs(e, r.title).ms, r.time_zone);
              }
            }
          }
          this.editOccurrence(id, key, patch, userId);
        } catch (e) {
          out.skipped.push({ uid, summary, reason: (e as Error).message });
        }
      }
      this.log(
        "calendar_imported",
        `Imported a calendar file: ${out.created.length} added, ${out.updated.length} updated, ${out.skipped.length} skipped`,
        userId,
        opts.matterId ?? null,
      );
    });
    return out;
  }
}

function kindFromCategories(cats: string): Kind {
  const c = unescapeText(cats).toLowerCase();
  for (const k of KINDS) if (c.includes(KIND_LABEL[k].toLowerCase()) || c.includes(k)) return k;
  return "meeting";
}

/** 20260309T140000Z -> epoch ms, or null. */
export function keyToMs(key: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(key);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** 20260309 -> 2026-03-09, or null. */
export function keyToDate(key: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(key);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return isISODate(d) ? d : null;
}

function describeKey(key: string, tz: string): string {
  const d = keyToDate(key);
  if (d) return d;
  const ms = keyToMs(key);
  if (ms === null) return key;
  const l = utcToLocal(ms, tz);
  return `${l.date} ${l.time.slice(0, 5)}`;
}

