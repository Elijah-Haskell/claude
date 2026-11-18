// DEMO DATA ONLY: fictional calendar events for the demo firm in src/seed.ts.
// Hearings, meetings, a weekly staff meeting, time out of the office and one deliberate
// double-booking so the warning can be seen. Times are Central (the firm's zone).

import type { DB } from "../db.ts";
import { addDays, type ISODate } from "../dates.ts";
import { Calendar } from "./calendar.ts";
import { SCHEMA } from "./schema.ts";
import { WEEKDAYS } from "./rrule.ts";

export interface CalendarSeedIds {
  users: { jordan: number; riley: number; sam: number; casey: number; avery?: number; dana?: number; priya?: number };
  matters: { m1: number; m2: number; m3: number; m4: number; m5: number; m6: number; m7?: number; m10?: number; m12?: number; m14?: number; m17?: number };
}

const dow = (d: ISODate) => new Date(d + "T00:00:00Z").getUTCDay();

/** The first date on or after `from` that falls on weekday `wd` (0 = Sunday). */
function onOrAfter(from: ISODate, wd: number): ISODate {
  let d = from;
  while (dow(d) !== wd) d = addDays(d, 1);
  return d;
}

/** A Monday-to-Friday date about n days from today (moved forward off weekends and firm closed days). */
function weekdayNear(today: ISODate, n: number, closed: ReadonlySet<string>): ISODate {
  let d = addDays(today, n);
  while (dow(d) === 0 || dow(d) === 6 || closed.has(d)) d = addDays(d, 1);
  return d;
}

export function seedCalendar(db: DB, ids: CalendarSeedIds, today: ISODate, closed: ReadonlySet<string> = new Set()) {
  const near = (n: number) => weekdayNear(today, n, closed);
  db.exec(SCHEMA);
  const cal = new Calendar(db);
  const { jordan, riley, sam, casey, avery, dana, priya } = ids.users;
  // In src/seed.ts: m1 Sunflower Coffee (D-1003), m2 Supply agreement (D-1004), m3 Office lease (D-1005),
  // m4 Riverside Plaza (D-1002), m5 Brooks Consulting (D-1006).
  const { m1, m2: supply, m3, m4: riverside, m5 } = ids.matters;
  const everyone = [jordan, riley, avery, sam, dana, casey, priya].filter((u): u is number => u != null);
  const add = (input: Parameters<Calendar["createEvent"]>[0], by = casey) => cal.createEvent(input, by).event;

  // Weekly staff meeting, Tuesdays 9:00-9:45, running since about eight weeks ago.
  const firstTuesday = onOrAfter(addDays(today, -56), 2);
  const staff = add({
    title: "Staff meeting",
    kind: "meeting",
    start: `${firstTuesday}T09:00`,
    end: `${firstTuesday}T09:45`,
    location: "Conference room",
    attendees: everyone,
    reminders: [15],
    rrule: `FREQ=WEEKLY;BYDAY=${WEEKDAYS[2]}`,
    notes: "Open matters, deadlines for the coming two weeks, intake.",
  });
  // One meeting a few weeks out is cancelled on its own (a single-occurrence change).
  const skipped = onOrAfter(addDays(today, 15), 2);
  cal.cancelOccurrence(staff.id, occurrenceKey(cal, staff.id, skipped), casey);

  // Monthly billing review: second Thursday of each month.
  const secondThursday = (() => {
    const first = onOrAfter(`${today.slice(0, 8)}01`, 4);
    return addDays(first, 7);
  })();
  add({
    title: "Monthly billing review",
    kind: "meeting",
    start: `${secondThursday}T15:00`,
    end: `${secondThursday}T16:00`,
    attendees: [jordan, riley, casey],
    reminders: [60],
    rrule: "FREQ=MONTHLY;BYDAY=2TH",
  });

  // Hearings on the real estate matter (administrative hearings, made up).
  const hearing = near(9);
  add(
    {
      title: "Planning commission hearing: Riverside Plaza rezoning",
      matterId: riverside,
      kind: "hearing",
      start: `${hearing}T18:30`,
      end: `${hearing}T20:00`,
      location: "City Hall, commission chambers (demo)",
      attendees: [jordan, sam],
      reminders: [1440, 120],
      notes: "Demo event. Bring the site plan and the title commitment exceptions list.",
    },
    jordan,
  );
  const appeal = near(23);
  add(
    {
      title: "Property tax appeal hearing: Riverside Plaza",
      matterId: riverside,
      kind: "hearing",
      start: `${appeal}T10:00`,
      end: `${appeal}T11:30`,
      location: "Video hearing (link in the notice)",
      attendees: [jordan],
      reminders: [10080, 1440, 60],
      notes: "Demo event.",
    },
    jordan,
  );

  // Client meetings.
  const t1 = near(1);
  add({ title: "Client call: Sunflower Coffee operating agreement", matterId: m1, kind: "meeting", start: `${t1}T10:30`, end: `${t1}T11:00`, attendees: [jordan], reminders: [10] }, jordan);
  add({ title: "Supply agreement: call with the other side's counsel", matterId: supply, kind: "meeting", start: `${t1}T14:00`, end: `${t1}T15:00`, attendees: [riley, sam], location: "Phone" }, riley);
  const t3 = near(3);
  add({ title: "Lease renewal walkthrough", matterId: m3, kind: "meeting", start: `${t3}T13:00`, end: `${t3}T14:30`, location: "Client's office (demo address)", attendees: [riley] }, riley);
  add({ title: "Intake meeting: Brooks Consulting", matterId: m5, kind: "meeting", start: `${t3}T09:30`, end: `${t3}T10:30`, attendees: [jordan, casey], reminders: [30] }, casey);

  // Today: a meeting, and a call booked on top of it so the double-booking warning shows.
  if (dow(today) !== 0 && dow(today) !== 6) {
    add({ title: "Research block: title objections", matterId: riverside, kind: "other", start: `${today}T13:00`, end: `${today}T14:30`, attendees: [jordan] }, jordan);
    add({ title: "Call with Riverside Plaza lender's counsel", matterId: riverside, kind: "meeting", start: `${today}T14:00`, end: `${today}T14:30`, attendees: [jordan], location: "Phone" }, casey);
    add({ title: "Lunch CLE: e-filing update", kind: "other", start: `${today}T12:00`, end: `${today}T13:00`, attendees: [riley, sam], location: "Webinar" }, riley);
  }

  // Milestones on the other matters, on the same dates as the matters' key dates in src/seed.ts.
  const { m7, m10, m12, m14, m17 } = ids.matters;
  if (m10 != null && dow(today) !== 0 && dow(today) !== 6)
    add({ title: "Call with Prairie Wind about distributor minimums", matterId: m10, kind: "meeting", start: `${today}T15:30`, end: `${today}T16:00`, attendees: [jordan] }, jordan);
  if (m7 != null) add({ title: "Client call: Wheatland Analytics DPA questions", matterId: m7, kind: "meeting", start: `${t1}T11:00`, end: `${t1}T11:30`, attendees: avery != null ? [avery, jordan] : [jordan] }, jordan);
  if (m12 != null) add({ title: "Closing: Warehouse purchase", matterId: m12, kind: "meeting", start: `${near(5)}T14:00`, end: `${near(5)}T15:30`, attendees: [jordan, casey], location: "Title company conference room" }, jordan);
  if (m17 != null) {
    add({ title: "Status conference: Granger v. Flint Hills Dental", matterId: m17, kind: "hearing", start: `${near(7)}T13:30`, end: `${near(7)}T14:00`, attendees: [jordan, sam], location: "District Court, Courtroom 3" }, jordan);
    add({ title: "Mediation: Granger v. Flint Hills Dental", matterId: m17, kind: "hearing", start: `${near(16)}T09:00`, end: `${near(16)}T16:00`, attendees: [jordan], location: "Mediator's office" }, jordan);
  }
  if (m14 != null) add({ title: "Harper signing ceremony", matterId: m14, kind: "meeting", start: `${near(8)}T10:00`, end: `${near(8)}T11:30`, attendees: [jordan, priya ?? casey], location: "Our office" }, jordan);
  add({ title: "Sunflower Coffee operating agreement signing", matterId: m1, kind: "meeting", start: `${near(9)}T14:00`, end: `${near(9)}T15:00`, attendees: [jordan, sam] }, jordan);

  // Out of the office (all-day, several days).
  const away = near(12);
  add({ title: "Riley out of office", kind: "other", allDay: true, start: away, end: addDays(away, 2), attendees: [riley] }, riley);
  // A reminder-type all-day item.
  add({ title: "Renew firm malpractice policy", kind: "reminder", allDay: true, start: near(20), attendees: [casey], reminders: [10080] }, casey);
}

/** The occurrence key (original start, UTC) of a timed repeating event on a local `date`. */
function occurrenceKey(cal: Calendar, eventId: number, date: ISODate): string {
  const occ = cal.occurrences(Date.parse(date + "T00:00:00Z"), Date.parse(addDays(date, 1) + "T12:00:00Z"), { eventIds: [eventId] });
  const o = occ.find((x) => x.startLocal?.startsWith(date));
  if (!o) throw new Error(`seed: no occurrence of event ${eventId} on ${date}`);
  return o.occurrence;
}
