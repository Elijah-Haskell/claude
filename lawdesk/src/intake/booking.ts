// Consultation booking. Each person who takes consultations has weekly windows (firm time)
// and a consultation length. Open slots are those windows cut into consultation-sized
// pieces, minus anything already on that person's calendar, firm closed days, and anything
// sooner than the notice period. Booking a slot puts a meeting on the calendar.

import { tx } from "../db.ts";
import { addDays } from "../dates.ts";
import { Calendar } from "../calendar/calendar.ts";
import { FIRM_TZ, isoInstant, localToUtc, utcToLocal } from "../calendar/tz.ts";
import { type Intake, bad, cleanEmail, cleanPhone, cleanText } from "./leads.ts";
import { spamCheck } from "./forms.ts";

type Row = Record<string, any>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface Slot {
  start: string; // UTC instant
  end: string;
  userId: number;
  userName: string;
  date: string; // firm-time date
  time: string; // "9:30 AM"
}

export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function longDay(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Tuesday, November 24 at 10:00 AM" in firm time. */
export function describeInstant(iso: string): string {
  const l = utcToLocal(Date.parse(iso), FIRM_TZ);
  return `${longDay(l.date)} at ${clock(l.time.slice(0, 5))}`;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// --------------------------------------------------------------- settings

export function listAvailability(it: Intake): Row[] {
  const people = it.all(
    `SELECT u.id, u.name, u.default_role, b.consult_minutes, b.location, b.active AS booking_active
     FROM users u LEFT JOIN intake_booking_people b ON b.user_id = u.id WHERE u.active = 1 ORDER BY u.name`,
  );
  return people.map((p) => ({
    userId: p.id,
    name: p.name,
    role: p.default_role,
    takesConsultations: !!p.booking_active,
    consultMinutes: p.consult_minutes ?? 30,
    location: p.location,
    windows: it
      .all("SELECT weekday, start_time, end_time FROM intake_availability WHERE user_id = ? ORDER BY weekday, start_time", p.id)
      .map((w) => ({ weekday: w.weekday, start: w.start_time, end: w.end_time })),
  }));
}

export function setAvailability(
  it: Intake,
  userId: number,
  input: { takesConsultations?: boolean; consultMinutes?: number; location?: string | null; windows?: { weekday: number; start: string; end: string }[] },
  actor: number | null,
) {
  return tx(it.db, () => {
    const u = it.one("SELECT id, name FROM users WHERE id = ?", userId);
    if (!u) bad("Person not found", 404);
    const len = Number(input.consultMinutes ?? 30);
    if (!Number.isInteger(len) || len < 10 || len > 240) bad("A consultation must be 10 to 240 minutes long");
    const windows = (input.windows ?? []).map((w, i) => {
      const day = Number(w?.weekday);
      if (!Number.isInteger(day) || day < 0 || day > 6) bad(`Window ${i + 1} has no day of the week`);
      if (!TIME_RE.test(w.start ?? "") || !TIME_RE.test(w.end ?? "")) bad(`Window ${i + 1} needs start and end times like 09:00`);
      if (minutes(w.end) - minutes(w.start) < len) bad(`${WEEKDAYS[day]} ${clock(w.start)}–${clock(w.end)} is shorter than one consultation`);
      return { weekday: day, start: w.start, end: w.end };
    });
    for (const a of windows) {
      for (const b of windows) {
        if (a !== b && a.weekday === b.weekday && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end)) {
          bad(`Two ${WEEKDAYS[a.weekday]} windows overlap`);
        }
      }
    }
    if (windows.length > 50) bad("Too many windows");
    it.run(
      `INSERT INTO intake_booking_people (user_id, consult_minutes, location, active) VALUES (?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET consult_minutes = excluded.consult_minutes, location = excluded.location, active = excluded.active`,
      userId,
      len,
      cleanText(input.location, "Location", 300),
      input.takesConsultations === false ? 0 : 1,
    );
    it.run("DELETE FROM intake_availability WHERE user_id = ?", userId);
    for (const w of windows) it.run("INSERT INTO intake_availability (user_id, weekday, start_time, end_time) VALUES (?,?,?,?)", userId, w.weekday, w.start, w.end);
    it.engine.log("intake_availability", `Changed consultation hours for ${u.name}`, { userId: actor });
    return listAvailability(it).find((p) => p.userId === userId);
  });
}

// ------------------------------------------------------------------ slots

/** Open consultation slots from now (plus the notice period) through the booking horizon. */
/** graceMs lets a booking go through for a slot that crossed the notice line while the visitor was choosing. */
export function openSlots(it: Intake, opts: { userId?: number | null; days?: number; graceMs?: number } = {}): Slot[] {
  const s = it.settings();
  const now = it.now();
  const earliest = now + s.min_notice_hours * 3600_000 - (opts.graceMs ?? 0);
  const days = Math.min(Math.max(1, opts.days ?? s.days_ahead), 90);
  const startDate = utcToLocal(now, FIRM_TZ).date;
  const lastDate = addDays(startDate, days);
  const holidays = new Set(it.all("SELECT date FROM holidays").map((r) => r.date as string));
  const people = it.all(
    `SELECT b.user_id, b.consult_minutes, u.name FROM intake_booking_people b JOIN users u ON u.id = b.user_id
     WHERE b.active = 1 AND u.active = 1 ${opts.userId ? "AND b.user_id = ?" : ""} ORDER BY u.name`,
    ...(opts.userId ? [opts.userId] : []),
  );
  const cal = new Calendar(it.db, { now: () => new Date(it.now()) });
  const out: Slot[] = [];
  const rangeStart = localToUtc(startDate, "00:00", FIRM_TZ);
  const rangeEnd = localToUtc(addDays(lastDate, 1), "00:00", FIRM_TZ);
  for (const p of people) {
    const windows = it.all("SELECT * FROM intake_availability WHERE user_id = ?", p.user_id);
    if (!windows.length) continue;
    const busy = cal
      .occurrences(rangeStart, rangeEnd, { userId: p.user_id })
      .filter((o) => !o.allDay)
      .map((o) => [o.startMs, o.endMs] as const);
    const len = p.consult_minutes * 60_000;
    for (let d = startDate; d <= lastDate; d = addDays(d, 1)) {
      if (holidays.has(d)) continue;
      const wd = new Date(d + "T12:00:00Z").getUTCDay();
      for (const w of windows) {
        if (w.weekday !== wd) continue;
        const wEnd = localToUtc(d, w.end_time, FIRM_TZ);
        for (let t = localToUtc(d, w.start_time, FIRM_TZ); t + len <= wEnd; t += len) {
          if (t < earliest) continue;
          if (busy.some(([a, b]) => a < t + len && t < b)) continue;
          out.push({
            start: isoInstant(t),
            end: isoInstant(t + len),
            userId: p.user_id,
            userName: p.name,
            date: d,
            time: clock(utcToLocal(t, FIRM_TZ).time.slice(0, 5)),
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.userName.localeCompare(b.userName));
}

/** Slots grouped by day, for the booking pages. */
export function slotsByDay(slots: Slot[]) {
  const days: { date: string; label: string; slots: Slot[] }[] = [];
  for (const s of slots) {
    let d = days[days.length - 1];
    if (!d || d.date !== s.date) days.push((d = { date: s.date, label: longDay(s.date), slots: [] }));
    d.slots.push(s);
  }
  return days;
}

// ---------------------------------------------------------------- booking

/** Put a consultation on the calendar for a lead. The slot must still be open. */
export function book(it: Intake, leadId: number, input: { userId: unknown; start: unknown; via: "public" | "staff"; notes?: string | null }, actor: number | null) {
  return tx(it.db, () => {
    const l = it.leadRow(leadId);
    if (l.status === "hired" || l.status === "not_hired") bad("This lead is already decided", 409);
    const userId = Number(input.userId);
    const start = typeof input.start === "string" ? input.start : "";
    const startMs = Date.parse(start);
    if (!Number.isInteger(userId) || Number.isNaN(startMs)) bad("Choose a time");
    const slot = openSlots(it, { userId, graceMs: 30 * 60_000 }).find((s) => Date.parse(s.start) === startMs);
    if (!slot) bad("That time has just been taken or is no longer available. Please choose another.", 409);
    const p = it.one("SELECT * FROM intake_booking_people WHERE user_id = ?", userId)!;
    const cal = new Calendar(it.db, { now: () => new Date(it.now()) });
    const { event } = cal.createEvent(
      {
        title: `Consultation: ${l.name}`,
        kind: "meeting",
        source: "intake",
        sourceRef: String(leadId),
        start: slot.start,
        end: slot.end,
        attendees: [userId],
        reminders: [60],
        location: p.location ?? null,
        notes: [l.phone ? `Phone: ${l.phone}` : "", l.email ? `Email: ${l.email}` : "", l.summary ?? "", input.notes ?? ""].filter(Boolean).join("\n").slice(0, 9000) || null,
      },
      actor,
    );
    const cid = it.run(
      "INSERT INTO intake_consultations (lead_id, user_id, event_id, start_at, end_at, booked_via, created_at) VALUES (?,?,?,?,?,?,?)",
      leadId,
      userId,
      event.id,
      slot.start,
      slot.end,
      input.via,
      it.nowIso(),
    );
    const when = describeInstant(slot.start);
    it.log(leadId, "consultation_booked", `Consultation with ${slot.userName} on ${when}${input.via === "public" ? " (booked online)" : ""}`, actor);
    if (l.status === "new" || l.status === "contacted") it.setStatus(leadId, "consult_scheduled", {}, actor);
    if (l.email) {
      const firm = it.firmName();
      it.queueEmail(
        leadId,
        {
          kind: "booking_confirmation",
          subject: `Your consultation with ${firm}`,
          body: `Dear ${l.name},\n\nThis confirms your consultation with ${slot.userName} of ${firm} on ${when} (Central time), for about ${p.consult_minutes} minutes.${p.location ? `\n\nWhere: ${p.location}` : ""}\n\nIf you need to change the time, please call or reply to this email.\n\n${firm}`,
        },
        actor,
      );
    }
    return { consultationId: cid, eventId: event.id as number, start: slot.start, end: slot.end, when, userName: slot.userName, minutes: p.consult_minutes as number, location: p.location as string | null };
  });
}

export function cancelConsultation(it: Intake, id: number, actor: number | null) {
  return tx(it.db, () => {
    const c = it.one("SELECT * FROM intake_consultations WHERE id = ?", id);
    if (!c) bad("Consultation not found", 404);
    if (c.status === "cancelled") bad("Already cancelled", 409);
    if (c.event_id && it.one("SELECT id FROM cal_events WHERE id = ?", c.event_id)) new Calendar(it.db).deleteEvent(c.event_id, actor);
    it.run("UPDATE intake_consultations SET status = 'cancelled' WHERE id = ?", id);
    it.log(c.lead_id, "consultation_cancelled", `Cancelled the consultation on ${describeInstant(c.start_at)}`, actor);
    return it.getLead(c.lead_id);
  });
}

// ------------------------------------------------------------ public side

function checkBookingToken(it: Intake, tok: unknown) {
  const s = it.settings();
  if (typeof tok !== "string" || tok !== s.booking_token) bad("This booking page isn't available. Please contact the firm directly.", 404);
}

function leadByToken(it: Intake, tok: unknown): Row | null {
  if (tok === undefined || tok === null || tok === "") return null;
  if (typeof tok !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(tok)) bad("This booking link isn't valid", 404);
  const l = it.one("SELECT * FROM intake_leads WHERE public_token = ?", tok);
  if (!l) bad("This booking link isn't valid", 404);
  if (l.status === "hired" || l.status === "not_hired") bad("This booking link is no longer active. Please contact the firm directly.", 410);
  return l;
}

export function publicBooking(it: Intake, tok: string, opts: { lead?: string | null; userId?: number | null }) {
  checkBookingToken(it, tok);
  const lead = leadByToken(it, opts.lead);
  const s = it.settings();
  const people = it.all(
    `SELECT b.user_id AS id, u.name, b.consult_minutes AS minutes FROM intake_booking_people b JOIN users u ON u.id = b.user_id
     WHERE b.active = 1 AND u.active = 1 AND EXISTS (SELECT 1 FROM intake_availability a WHERE a.user_id = b.user_id) ORDER BY u.name`,
  );
  const slots = openSlots(it, { userId: opts.userId ?? null });
  return {
    firmName: it.firmName(),
    intro: s.booking_intro,
    personal: !!lead,
    people,
    days: slotsByDay(slots).map((d) => ({ date: d.date, label: d.label, slots: d.slots.map((x) => ({ start: x.start, userId: x.userId, userName: x.userName, time: x.time })) })),
    timeZoneNote: "Times are Central time (Kansas).",
    stamp: it.stamp("booking"),
  };
}

export function publicBook(it: Intake, tok: string, body: Row, ip: string | null | undefined) {
  checkBookingToken(it, tok);
  const existing = leadByToken(it, body?.lead);
  const h = spamCheck(it, "booking", body, ip);
  if (h === "spam") return { ok: true, firmName: it.firmName(), when: null };
  return tx(it.db, () => {
    let leadId: number;
    if (existing) leadId = existing.id;
    else {
      const name = cleanText(body?.name, "Your name", 200, true)!;
      const email = cleanEmail(body?.email, "Email");
      const phone = cleanPhone(body?.phone, "Phone");
      if (!email && !phone) bad("Give an email address or a phone number so the firm can confirm");
      leadId = it.createLead(
        { name, email, phone, summary: cleanText(body?.summary, "What it's about", 4000), opposing: cleanText(body?.opposing, "Other people involved", 4000), via: "Booked a consultation online" },
        null,
      ).id;
    }
    const notes = existing ? cleanText(body?.summary, "Notes", 4000) : null;
    const r = book(it, leadId, { userId: body?.userId, start: body?.start, via: "public", notes }, null);
    it.run("INSERT INTO intake_submit_log (ip_hash, at, outcome) VALUES (?,?,?)", h, it.now(), "accepted");
    return { ok: true, firmName: it.firmName(), when: r.when, userName: r.userName, minutes: r.minutes, location: r.location };
  });
}

