import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { Engine, EngineError } from "../../src/engine.ts";
import { SCHEMA } from "../../src/calendar/schema.ts";
import { Calendar, hashToken } from "../../src/calendar/calendar.ts";
import { getProp, getProps, parseIcs, unfold, unescapeText } from "../../src/calendar/ics.ts";

function setup(nowIso = "2026-03-01T18:00:00Z") {
  const db = openDb();
  db.exec(SCHEMA);
  let now = new Date(nowIso);
  const e = new Engine(db, { today: () => "2026-03-01" });
  const c = new Calendar(db, { now: () => now });
  const ann = e.addUser("Ann Attorney", "attorney");
  const pat = e.addUser("Pat Paralegal", "paralegal");
  const client = e.addContact("Acme Widgets LLC", "company");
  const matter = e.createMatter({ name: "Acme v. Smith", number: "2026-014", clientId: client });
  const setNow = (iso: string) => (now = new Date(iso));
  return { db, e, c, ann, pat, matter, setNow };
}

const activity = (db: any) => db.prepare("SELECT * FROM activity WHERE kind LIKE 'calendar_%' ORDER BY id").all() as any[];
const err = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => e instanceof EngineError && re.test(e.message));

// ------------------------------------------------------------------ events

test("events: timed event stored as UTC instant plus zone; default length one hour", () => {
  const { c, ann, matter } = setup();
  const { event } = c.createEvent({ title: "Client meeting", start: "2026-07-15T09:00", matterId: matter, attendees: [ann], kind: "meeting" }, ann);
  assert.equal(event.start, "2026-07-15T14:00:00Z");
  assert.equal(event.end, "2026-07-15T15:00:00Z");
  assert.equal(event.startLocal, "2026-07-15T09:00");
  assert.equal(event.timeZone, "America/Chicago");
  assert.equal(event.matterId, matter);
  assert.deepEqual(event.attendees, [ann]);
  assert.equal(event.source, "manual");
  assert.match(event.uid, /@lawdesk$/);
});

test("events: an explicit instant or another US zone is accepted", () => {
  const { c } = setup();
  assert.equal(c.createEvent({ title: "x", start: "2026-07-15T14:00:00Z", end: "2026-07-15T15:30:00-05:00" }).event.end, "2026-07-15T20:30:00Z");
  const den = c.createEvent({ title: "Goodland hearing", start: "2026-07-15T09:00", timeZone: "America/Denver" }).event;
  assert.equal(den.start, "2026-07-15T15:00:00Z");
  assert.equal(den.startLocal, "2026-07-15T09:00");
});

test("events: all-day events use dates, end inclusive", () => {
  const { c } = setup();
  const { event } = c.createEvent({ title: "Trial", allDay: true, start: "2026-04-06", end: "2026-04-08", kind: "hearing" });
  assert.equal(event.allDay, true);
  assert.equal(event.start, "2026-04-06");
  assert.equal(event.end, "2026-04-08");
  assert.equal(c.createEvent({ title: "SOL", allDay: true, start: "2026-09-01", kind: "statute_of_limitations" }).event.end, "2026-09-01");
});

test("events: validation", () => {
  const { c } = setup();
  err(() => c.createEvent({ title: "  ", start: "2026-03-02T09:00" }), /needs a title/);
  err(() => c.createEvent({ title: "x", start: "tomorrow" }), /must look like/);
  err(() => c.createEvent({ title: "x", start: "2026-02-30T09:00" }), /not a valid/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", end: "2026-03-02T08:00" }), /ends before/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", kind: "party" as any }), /Kind must be/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", timeZone: "Europe/Paris" }), /Time zone must be/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", attendees: [999] }), /User 999/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", matterId: 999 }), /Matter not found/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", reminders: [-5] }), /reminder/);
  err(() => c.createEvent({ title: "x", allDay: true, start: "2026-03-02T09:00" }), /all-day/);
  err(() => c.createEvent({ title: "x", allDay: true, start: "2026-03-05", end: "2026-03-04" }), /ends before/);
  err(() => c.createEvent({ title: "x", start: "2026-03-02T09:00", rrule: "FREQ=HOURLY" }), /FREQ/);
  err(() => c.createEvent({ title: "x", start: "2026-03-03T09:00", rrule: "FREQ=WEEKLY;BYDAY=MO" }), /first date must/);
  err(() => c.createEvent({ title: "x", start: "2026-03-03T09:00", rrule: "FREQ=DAILY;UNTIL=20260301" }), /ends before/);
});

test("events: create, update and delete are written to the activity log with who and the matter", () => {
  const { db, c, ann, pat, matter } = setup();
  const id = c.createEvent({ title: "Deposition", start: "2026-05-04T10:00", matterId: matter, kind: "hearing" }, ann).event.id;
  c.updateEvent(id, { location: "Courtroom 4", attendees: [pat] }, pat);
  c.updateEvent(id, { location: "Courtroom 4" }, pat); // no change, no log
  c.deleteEvent(id, ann);
  const a = activity(db);
  assert.deepEqual(
    a.map((r) => [r.kind, r.user_id, r.matter_id]),
    [
      ["calendar_event_added", ann, matter],
      ["calendar_event_updated", pat, matter],
      ["calendar_event_deleted", ann, matter],
    ],
  );
  assert.match(a[0].detail, /hearing "Deposition" on 2026-05-04 10:00/);
  assert.match(a[1].detail, /location Courtroom 4, attendees/);
  assert.match(a[2].detail, new RegExp(`event #${id}`));
  err(() => c.getEvent(id), /not found/);
});

test("events: moving the start keeps the length; sequence goes up", () => {
  const { c } = setup();
  const { event } = c.createEvent({ title: "x", start: "2026-03-02T09:00", end: "2026-03-02T10:30" });
  const u = c.updateEvent(event.id, { start: "2026-03-10T13:00" }).event;
  assert.equal(u.startLocal, "2026-03-10T13:00");
  assert.equal(u.endLocal, "2026-03-10T14:30");
  assert.equal(u.sequence, 1);
  const ad = c.updateEvent(event.id, { allDay: true, start: "2026-03-11" }).event;
  assert.equal(ad.allDay, true);
  assert.equal(ad.end, "2026-03-11");
  err(() => c.updateEvent(event.id, { allDay: false }), /Give a new start/);
});

// ------------------------------------------------------------- recurrence & DST

test("recurrence: a weekly 9:00 meeting stays at 9:00 local across spring forward and fall back", () => {
  const { c } = setup();
  c.createEvent({ title: "Staff meeting", start: "2026-03-02T09:00", end: "2026-03-02T10:00", rrule: "FREQ=WEEKLY" });
  const spring = c.agenda({ from: "2026-03-01", to: "2026-03-14" }).items;
  assert.deepEqual(
    spring.map((i) => [i.startLocal, i.start]),
    [
      ["2026-03-02T09:00", "2026-03-02T15:00:00Z"], // CST
      ["2026-03-09T09:00", "2026-03-09T14:00:00Z"], // CDT
    ],
  );
  const fall = c.agenda({ from: "2026-10-26", to: "2026-11-08" }).items;
  assert.deepEqual(
    fall.map((i) => [i.startLocal, i.start, i.end]),
    [
      ["2026-10-26T09:00", "2026-10-26T14:00:00Z", "2026-10-26T15:00:00Z"],
      ["2026-11-02T09:00", "2026-11-02T15:00:00Z", "2026-11-02T16:00:00Z"],
    ],
  );
});

test("recurrence: a daily 02:30 event on the spring-forward day happens at 03:30 CDT; on fall-back day at the first 01:30", () => {
  const { c } = setup();
  c.createEvent({ title: "Overnight backup check", start: "2026-03-07T02:30", end: "2026-03-07T02:45", rrule: "FREQ=DAILY;COUNT=3" });
  assert.deepEqual(
    c.agenda({ from: "2026-03-07", to: "2026-03-09" }).items.map((i) => [i.start, i.startLocal]),
    [
      ["2026-03-07T08:30:00Z", "2026-03-07T02:30"],
      ["2026-03-08T08:30:00Z", "2026-03-08T03:30"],
      ["2026-03-09T07:30:00Z", "2026-03-09T02:30"],
    ],
  );
  c.createEvent({ title: "Fall", start: "2026-10-31T01:30", rrule: "FREQ=DAILY;COUNT=3" });
  assert.deepEqual(
    c.agenda({ from: "2026-10-31", to: "2026-11-02" }).items.filter((i) => i.title === "Fall").map((i) => i.start),
    ["2026-10-31T06:30:00Z", "2026-11-01T06:30:00Z", "2026-11-02T07:30:00Z"],
  );
});

test("recurrence: an event across the DST change keeps its real length", () => {
  const { c } = setup();
  // 01:00 to 04:00 local on spring-forward day is only 2 real hours
  const { event } = c.createEvent({ title: "Night", start: "2026-03-08T01:00", end: "2026-03-08T04:00" });
  assert.equal(Date.parse(event.end) - Date.parse(event.start), 2 * 3600_000);
});

test("recurrence: UNTIL given as a date on a timed event means the end of that local day", () => {
  const { c } = setup();
  const { event } = c.createEvent({ title: "x", start: "2026-03-02T21:00", rrule: "FREQ=DAILY;UNTIL=20260304" });
  assert.equal(event.rrule, "FREQ=DAILY;UNTIL=20260305T055959Z"); // 23:59:59 CST on 3/4
  assert.deepEqual(
    c.agenda({ from: "2026-03-01", to: "2026-03-10" }).items.map((i) => i.startLocal),
    ["2026-03-02T21:00", "2026-03-03T21:00", "2026-03-04T21:00"],
  );
  const ad = c.createEvent({ title: "y", allDay: true, start: "2026-03-02", rrule: "FREQ=DAILY;UNTIL=20260303T120000Z" }).event;
  assert.equal(ad.rrule, "FREQ=DAILY;UNTIL=20260303");
});

test("recurrence: weekly on several days, monthly second Tuesday, all-day yearly", () => {
  const { c } = setup();
  c.createEvent({ title: "MWF", start: "2026-03-02T08:00", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5" });
  c.createEvent({ title: "Motion docket", start: "2026-03-10T09:00", rrule: "FREQ=MONTHLY;BYDAY=2TU" });
  c.createEvent({ title: "Annual report due", allDay: true, start: "2026-04-15", rrule: "FREQ=YEARLY", kind: "court_deadline" });
  const items = c.agenda({ from: "2026-03-01", to: "2026-04-30" }).items;
  assert.deepEqual(items.filter((i) => i.title === "MWF").map((i) => i.date), ["2026-03-02", "2026-03-04", "2026-03-06", "2026-03-09", "2026-03-11"]);
  assert.deepEqual(items.filter((i) => i.title === "Motion docket").map((i) => i.date), ["2026-03-10", "2026-04-14"]);
  assert.deepEqual(items.filter((i) => i.title === "Annual report due").map((i) => i.date), ["2026-04-15"]);
  assert.deepEqual(c.agenda({ from: "2030-04-01", to: "2030-04-30" }).items.filter((i) => i.title === "Annual report due").map((i) => i.date), ["2030-04-15"]);
});

test("recurrence: a multi-day all-day event that started before the range is still shown", () => {
  const { c } = setup();
  c.createEvent({ title: "Trial", allDay: true, start: "2026-04-06", end: "2026-04-10" });
  const items = c.agenda({ from: "2026-04-08", to: "2026-04-08" }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].date, "2026-04-08"); // shown on the first day of the range
  assert.equal(items[0].start, "2026-04-06");
});

// --------------------------------------------------------- single occurrences

test("occurrences: cancel one, change one, restore; all logged", () => {
  const { db, c, ann } = setup();
  const id = c.createEvent({ title: "Weekly call", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY;COUNT=4" }, ann).event.id;
  c.cancelOccurrence(id, "20260309T140000Z", ann);
  c.editOccurrence(id, "20260316T140000Z", { start: "2026-03-17T13:00", title: "Weekly call (moved)", location: "Zoom" }, ann);
  let items = c.agenda({ from: "2026-03-01", to: "2026-03-31" }).items;
  assert.deepEqual(
    items.map((i) => [i.occurrence, i.startLocal, i.title, i.modified]),
    [
      ["20260302T150000Z", "2026-03-02T09:00", "Weekly call", false],
      ["20260316T140000Z", "2026-03-17T13:00", "Weekly call (moved)", true],
      ["20260323T140000Z", "2026-03-23T09:00", "Weekly call", false],
    ],
  );
  assert.equal(items[1].location, "Zoom");
  assert.equal(items[1].endLocal, "2026-03-17T14:00");
  c.restoreOccurrence(id, "20260309T140000Z", ann);
  items = c.agenda({ from: "2026-03-01", to: "2026-03-31" }).items;
  assert.equal(items.length, 4);
  assert.deepEqual(
    activity(db).map((a) => a.kind),
    ["calendar_event_added", "calendar_occurrence_cancelled", "calendar_occurrence_changed", "calendar_occurrence_restored"],
  );
  assert.match(activity(db)[1].detail, /2026-03-09 09:00 occurrence of "Weekly call"/);
});

test("occurrences: a moved occurrence shows up in a range that only holds its new date", () => {
  const { c } = setup();
  const id = c.createEvent({ title: "x", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY;COUNT=2" }).event.id;
  c.editOccurrence(id, "20260309T140000Z", { start: "2026-05-01T09:00" });
  assert.deepEqual(c.agenda({ from: "2026-05-01", to: "2026-05-01" }).items.map((i) => i.startLocal), ["2026-05-01T09:00"]);
  assert.equal(c.agenda({ from: "2026-03-09", to: "2026-03-09" }).items.length, 0);
});

test("occurrences: bad keys are refused", () => {
  const { c } = setup();
  const id = c.createEvent({ title: "x", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY;COUNT=4" }).event.id;
  const single = c.createEvent({ title: "y", start: "2026-03-02T09:00" }).event.id;
  err(() => c.cancelOccurrence(id, "20260310T140000Z"), /not one of this event's occurrences/);
  err(() => c.cancelOccurrence(id, "20260330T140000Z"), /not one of/); // past COUNT
  err(() => c.cancelOccurrence(id, "garbage"), /not an occurrence id/);
  err(() => c.cancelOccurrence(single, "20260302T150000Z"), /Only a repeating event/);
  err(() => c.restoreOccurrence(id, "20260302T150000Z"), /no changes/);
});

test("occurrences: all-day series cancel and move", () => {
  const { c } = setup();
  const id = c.createEvent({ title: "Filing day", allDay: true, start: "2026-03-02", rrule: "FREQ=WEEKLY;COUNT=3" }).event.id;
  c.cancelOccurrence(id, "20260309");
  c.editOccurrence(id, "20260316", { start: "2026-03-17" });
  assert.deepEqual(c.agenda({ from: "2026-03-01", to: "2026-03-31" }).items.map((i) => i.date), ["2026-03-02", "2026-03-17"]);
});

test("occurrences: changing the series timing clears single-occurrence changes, and says so", () => {
  const { db, c } = setup();
  const id = c.createEvent({ title: "x", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY;COUNT=4" }).event.id;
  c.cancelOccurrence(id, "20260309T140000Z");
  c.updateEvent(id, { title: "renamed" });
  assert.equal(c.getEvent(id).exceptions.length, 1); // a rename keeps them
  c.updateEvent(id, { start: "2026-03-02T10:00" });
  assert.equal(c.getEvent(id).exceptions.length, 0);
  assert.match(activity(db).at(-1).detail, /1 single-occurrence change\(s\) cleared/);
});

// ------------------------------------------------------------ agenda + tasks

test("agenda: shows a user's events and their task due dates together; firm view shows everyone's", () => {
  const { e, c, ann, pat, matter } = setup();
  c.createEvent({ title: "Ann's hearing", start: "2026-03-03T09:00", attendees: [ann], matterId: matter, kind: "hearing" });
  c.createEvent({ title: "Pat's meeting", start: "2026-03-03T11:00", attendees: [pat] });
  c.createEvent({ title: "Office closed", allDay: true, start: "2026-03-03" });
  e.addTask({ title: "File answer", matterId: matter, assigneeId: ann, dueDate: "2026-03-03" });
  e.addTask({ title: "Pat's task", assigneeId: pat, dueDate: "2026-03-04" });
  const done = e.addTask({ title: "Done already", assigneeId: ann, dueDate: "2026-03-03" });
  e.completeTask(done, ann);
  e.addTask({ title: "Out of range", assigneeId: ann, dueDate: "2026-04-01" });

  const mine = c.agenda({ from: "2026-03-02", to: "2026-03-06", userId: ann });
  assert.deepEqual(
    mine.items.map((i) => [i.type, i.title]),
    [
      ["task", "File answer"],
      ["event", "Ann's hearing"],
    ],
  );
  assert.equal(mine.items[0].matter.number, "2026-014");
  assert.equal(mine.items[1].matter.name, "Acme v. Smith");

  const firm = c.agenda({ from: "2026-03-02", to: "2026-03-06" });
  assert.deepEqual(
    firm.items.map((i) => i.title),
    ["Office closed", "File answer", "Ann's hearing", "Pat's meeting", "Pat's task"],
  );
  assert.ok(!firm.items.some((i) => i.title === "Done already"));
  assert.ok(c.agenda({ from: "2026-03-02", to: "2026-03-06", includeDoneTasks: true }).items.some((i) => i.title === "Done already"));
  assert.ok(!c.agenda({ from: "2026-03-02", to: "2026-03-06", includeTasks: false }).items.some((i) => i.type === "task"));
});

test("agenda: the range is local days in the viewer's zone", () => {
  const { c } = setup();
  c.createEvent({ title: "Late", start: "2026-03-03T23:00", end: "2026-03-03T23:45" }); // 05:00Z on 3/4
  assert.equal(c.agenda({ from: "2026-03-03", to: "2026-03-03" }).items.length, 1);
  assert.equal(c.agenda({ from: "2026-03-04", to: "2026-03-04" }).items.length, 0);
  assert.equal(c.agenda({ from: "2026-03-04", to: "2026-03-04", timeZone: "America/New_York" }).items.length, 1);
  err(() => c.agenda({ from: "2026-03-04", to: "2026-03-01" }), /before/);
  err(() => c.agenda({ from: "2026-03-04", to: "2028-03-01" }), /at most/);
  err(() => c.agenda({ from: "x", to: "2026-03-01" }), /dates like/);
});

// --------------------------------------------------------------- conflicts

test("conflicts: double-booking is warned on create and flagged in the agenda", () => {
  const { c, ann, pat } = setup();
  c.createEvent({ title: "Hearing", start: "2026-03-03T09:00", end: "2026-03-03T11:00", attendees: [ann] });
  const r = c.createEvent({ title: "Client call", start: "2026-03-03T10:30", attendees: [ann, pat] });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].userName, "Ann Attorney");
  assert.deepEqual([r.conflicts[0].a.title, r.conflicts[0].b.title], ["Hearing", "Client call"]);
  // back-to-back is not a conflict
  assert.equal(c.createEvent({ title: "After", start: "2026-03-03T11:30", attendees: [ann] }).conflicts.length, 0);
  // all-day events never conflict
  assert.equal(c.createEvent({ title: "Trial week", allDay: true, start: "2026-03-03", attendees: [ann] }).conflicts.length, 0);
  const ag = c.agenda({ from: "2026-03-03", to: "2026-03-03", userId: ann });
  assert.deepEqual(ag.items.filter((i) => i.conflict).map((i) => i.title), ["Hearing", "Client call"]);
  assert.equal(ag.conflicts.length, 1);
  assert.equal(c.agenda({ from: "2026-03-03", to: "2026-03-03", userId: pat }).conflicts.length, 0);
});

test("conflicts: a recurring meeting that collides with a one-off weeks later is caught", () => {
  const { c, ann } = setup();
  c.createEvent({ title: "Mediation", start: "2026-04-13T09:30", end: "2026-04-13T12:00", attendees: [ann] });
  const r = c.createEvent({ title: "Weekly 1:1", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY", attendees: [ann] });
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].a.occurrence, r.conflicts[0].b.title], ["20260413T140000Z", "Mediation"]);
  assert.equal(c.updateEvent(r.event.id, { start: "2026-03-02T08:00" }).conflicts.length, 0);
});

test("conflicts: availability check before saving", () => {
  const { c, ann, pat } = setup();
  const id = c.createEvent({ title: "Hearing", start: "2026-03-03T09:00", end: "2026-03-03T11:00", attendees: [ann] }).event.id;
  assert.deepEqual(c.checkAvailability([ann, pat], "2026-03-03T10:00", "2026-03-03T10:30").map((b) => [b.userId, b.title]), [[ann, "Hearing"]]);
  assert.equal(c.checkAvailability([ann], "2026-03-03T11:00", "2026-03-03T12:00").length, 0);
  assert.equal(c.checkAvailability([ann], "2026-03-03T10:00", "2026-03-03T10:30", { excludeEventId: id }).length, 0);
});

// --------------------------------------------------------------- reminders

test("reminders: due in a window, per occurrence, respecting DST and cancellations", () => {
  const { c, ann, pat } = setup();
  const id = c.createEvent({
    title: "Weekly call",
    start: "2026-03-02T09:00",
    rrule: "FREQ=WEEKLY;COUNT=3",
    attendees: [ann, pat],
    reminders: [15, 1440],
  }).event.id;
  c.createEvent({ title: "No reminders", start: "2026-03-09T09:00" });
  const r = c.remindersDue("2026-03-08T00:00:00Z", "2026-03-10T00:00:00Z");
  assert.deepEqual(
    r.map((x) => [x.minutesBefore, x.fireAt, x.occurrence]),
    [
      [1440, "2026-03-08T14:00:00Z", "20260309T140000Z"], // exactly 24h earlier (09:00 CDT on 3/8; DST began at 2 a.m. that day)
      [15, "2026-03-09T13:45:00Z", "20260309T140000Z"],
    ],
  );
  assert.deepEqual(r[0].userIds, [ann, pat]);
  c.cancelOccurrence(id, "20260309T140000Z");
  assert.equal(c.remindersDue("2026-03-08T00:00:00Z", "2026-03-10T00:00:00Z").length, 0);
  // window is half-open: [from, to)
  assert.equal(c.remindersDue("2026-03-02T14:45:00Z", "2026-03-02T14:45:00Z").length, 0);
  assert.equal(c.remindersDue("2026-03-02T14:45:00Z", "2026-03-02T14:46:00Z").length, 1);
});

test("reminders: all-day events count back from local midnight", () => {
  const { c } = setup();
  c.createEvent({ title: "SOL runs", allDay: true, start: "2026-07-01", kind: "statute_of_limitations", reminders: [0, 7 * 1440] });
  const r = c.remindersDue("2026-06-01T00:00:00Z", "2026-07-02T00:00:00Z");
  assert.deepEqual(r.map((x) => x.fireAt), ["2026-06-24T05:00:00Z", "2026-07-01T05:00:00Z"]);
  assert.equal(r[0].start, "2026-07-01");
});

// ------------------------------------------------------------- feed tokens

test("feed tokens: 32 random bytes, stored only as sha256, revocable, logged", () => {
  const { db, c, ann } = setup();
  const t = c.createFeedToken(ann, { label: "iPhone" });
  assert.equal(Buffer.from(t.token, "base64url").length, 32);
  assert.equal(t.path, `/calendar/feed/${t.token}.ics`);
  const row = db.prepare("SELECT * FROM cal_feed_tokens WHERE id = ?").get(t.id) as any;
  assert.equal(row.token_hash, hashToken(t.token));
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM cal_feed_tokens").all()).includes(t.token));
  assert.ok(c.feedForToken(t.token)!.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok((db.prepare("SELECT last_used_at FROM cal_feed_tokens WHERE id = ?").get(t.id) as any).last_used_at);
  assert.equal(c.feedForToken(t.token.slice(0, -1) + (t.token.endsWith("A") ? "B" : "A")), null);
  assert.equal(c.feedForToken(""), null);
  const listed = c.listFeedTokens(ann);
  assert.equal(listed.length, 1);
  assert.ok(!("token_hash" in listed[0]));
  c.revokeFeedToken(t.id, ann);
  assert.equal(c.feedForToken(t.token), null);
  assert.ok(c.listFeedTokens(ann)[0].revokedAt);
  assert.notEqual(c.createFeedToken(ann).token, t.token);
  assert.deepEqual(activity(db).map((a) => a.kind), ["calendar_feed_created", "calendar_feed_revoked", "calendar_feed_created"]);
  err(() => c.createFeedToken(999), /User not found/);
  err(() => c.createFeedToken(ann, { scope: "everyone" as any }), /Scope/);
});

// --------------------------------------------------------------------- feed

function feedFor(c: Calendar, userId: number, scope: "mine" | "firm" = "mine") {
  return c.feedForToken(c.createFeedToken(userId, { scope }).token)!;
}

function vevents(ics: string) {
  return parseIcs(ics).children[0].children.filter((x) => x.type === "VEVENT");
}

test("feed: valid RFC 5545 shape — CRLF, folded lines, VTIMEZONE, DTSTAMP, stable UID", () => {
  const { c, ann, matter } = setup();
  const { event } = c.createEvent({
    title: "Hearing on motion to dismiss, Smith; bring binder",
    start: "2026-03-10T09:00",
    end: "2026-03-10T10:00",
    attendees: [ann],
    matterId: matter,
    kind: "hearing",
    location: "Johnson County Courthouse, Div. 7",
    notes: "Line one\nLine two with a backslash \\ and a very long sentence that will need to be folded because it is long.",
    reminders: [30],
  });
  const ics = feedFor(c, ann);
  assert.ok(!/[^\r]\n/.test(ics), "bare LF");
  for (const l of ics.split("\r\n")) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:/);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/Chicago\r\n/);
  const [v] = vevents(ics);
  assert.equal(getProp(v, "UID")!.value, event.uid);
  assert.equal(getProp(v, "DTSTAMP")!.value, "20260301T180000Z");
  assert.deepEqual(getProp(v, "DTSTART")!.params, { TZID: "America/Chicago" });
  assert.equal(getProp(v, "DTSTART")!.value, "20260310T090000");
  assert.equal(getProp(v, "DTEND")!.value, "20260310T100000");
  assert.equal(unescapeText(getProp(v, "SUMMARY")!.value), "Hearing on motion to dismiss, Smith; bring binder [2026-014]");
  assert.ok(unfold(ics).includes("SUMMARY:Hearing on motion to dismiss\\, Smith\\; bring binder [2026-014]"));
  assert.equal(unescapeText(getProp(v, "LOCATION")!.value), "Johnson County Courthouse, Div. 7");
  assert.match(unescapeText(getProp(v, "DESCRIPTION")!.value), /Matter: 2026-014 Acme v\. Smith\nAttendees: Ann Attorney\n\nLine one\nLine two with a backslash \\ and/);
  assert.equal(getProp(v.children[0], "TRIGGER")!.value, "-PT30M");
  // UID stays the same after an edit; SEQUENCE and DTSTAMP move
  c.updateEvent(event.id, { title: "Renamed" });
  const [v2] = vevents(feedFor(c, ann));
  assert.equal(getProp(v2, "UID")!.value, event.uid);
  assert.equal(getProp(v2, "SEQUENCE")!.value, "1");
});

test("feed: all-day as VALUE=DATE with exclusive DTEND; recurrence as RRULE + EXDATE + RECURRENCE-ID", () => {
  const { c, ann } = setup();
  c.createEvent({ title: "Trial", allDay: true, start: "2026-04-06", end: "2026-04-08", attendees: [ann] });
  const id = c.createEvent({ title: "Weekly", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=4", attendees: [ann] }).event.id;
  c.cancelOccurrence(id, "20260309T140000Z");
  c.editOccurrence(id, "20260316T140000Z", { start: "2026-03-16T11:00", title: "Weekly (late)" });
  const all = vevents(feedFor(c, ann));
  const trial = all.find((v) => getProp(v, "SUMMARY")!.value === "Trial")!;
  assert.deepEqual([getProp(trial, "DTSTART")!.params, getProp(trial, "DTSTART")!.value], [{ VALUE: "DATE" }, "20260406"]);
  assert.equal(getProp(trial, "DTEND")!.value, "20260409");
  assert.equal(getProp(trial, "TRANSP")!.value, "TRANSPARENT");
  const series = all.filter((v) => getProp(v, "UID")!.value === c.getEvent(id).uid);
  assert.equal(series.length, 2);
  const master = series.find((v) => !getProp(v, "RECURRENCE-ID"))!;
  assert.equal(getProp(master, "RRULE")!.value, "FREQ=WEEKLY;COUNT=4;BYDAY=MO");
  assert.deepEqual(getProps(master, "EXDATE").map((p) => [p.params.TZID, p.value]), [["America/Chicago", "20260309T090000"]]);
  const ov = series.find((v) => getProp(v, "RECURRENCE-ID"))!;
  assert.equal(getProp(ov, "RECURRENCE-ID")!.value, "20260316T090000");
  assert.equal(getProp(ov, "DTSTART")!.value, "20260316T110000");
  assert.equal(getProp(ov, "SUMMARY")!.value, "Weekly (late)");
});

test("feed: open tasks appear as all-day VEVENTs (not VTODO); 'mine' vs 'firm' scope", () => {
  const { e, c, ann, pat, matter } = setup();
  e.addTask({ title: "File answer", matterId: matter, assigneeId: ann, dueDate: "2026-03-20" });
  e.addTask({ title: "Pat's job", assigneeId: pat, dueDate: "2026-03-21" });
  const done = e.addTask({ title: "Finished", assigneeId: ann, dueDate: "2026-03-22" });
  e.completeTask(done, ann);
  e.addTask({ title: "No date", assigneeId: ann });
  c.createEvent({ title: "Pat only", start: "2026-03-10T09:00", attendees: [pat] });
  const mine = feedFor(c, ann);
  assert.ok(!mine.includes("VTODO"));
  const vs = vevents(mine);
  assert.deepEqual(vs.map((v) => getProp(v, "SUMMARY")!.value), ["Due: File answer [2026-014]"]);
  const t = vs[0];
  assert.match(getProp(t, "UID")!.value, /^task-\d+@lawdesk$/);
  assert.deepEqual([getProp(t, "DTSTART")!.params.VALUE, getProp(t, "DTSTART")!.value, getProp(t, "DTEND")!.value], ["DATE", "20260320", "20260321"]);
  assert.match(getProp(t, "DTSTAMP")!.value, /^\d{8}T\d{6}Z$/);
  const firm = vevents(feedFor(c, ann, "firm")).map((v) => unescapeText(getProp(v, "SUMMARY")!.value));
  assert.deepEqual(firm.sort(), ["Due: File answer [2026-014]", "Due: Pat's job", "Pat only"]);
});

test("feed: old one-off events drop out, repeating series stay", () => {
  const { c, ann, setNow } = setup();
  c.createEvent({ title: "Old", start: "2026-03-02T09:00", attendees: [ann] });
  c.createEvent({ title: "Series", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY", attendees: [ann] });
  setNow("2027-01-01T00:00:00Z");
  assert.deepEqual(vevents(feedFor(c, ann)).map((v) => getProp(v, "SUMMARY")!.value), ["Series"]);
});

// ------------------------------------------------------------------ import

const OUTLOOK_FILE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Central Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16011104T020000",
  "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0600",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:040000008200E00074C5B7101A82E008",
  "SUMMARY:Pretrial conference\\, Smith v. Jones",
  "DTSTART;TZID=Central Standard Time:20260415T133000",
  "DTEND;TZID=Central Standard Time:20260415T143000",
  "LOCATION:Div. 7",
  "DESCRIPTION:Bring the exhibit list.\\nCall clerk first. This line is long enou",
  " gh to have been folded by Outlook.",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday-1@example.com",
  "SUMMARY:Office closed",
  "DTSTART;VALUE=DATE:20260525",
  "DTEND;VALUE=DATE:20260526",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:series-1@example.com",
  "SUMMARY:Docket call",
  "DTSTART:20260302T150000Z",
  "DURATION:PT30M",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "EXDATE:20260309T140000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:series-1@example.com",
  "RECURRENCE-ID:20260316T140000Z",
  "SUMMARY:Docket call (moved)",
  "DTSTART:20260316T190000Z",
  "DTEND:20260316T193000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weird@example.com",
  "SUMMARY:Every last weekday",
  "DTSTART;VALUE=DATE:20260331",
  "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gone@example.com",
  "SUMMARY:Cancelled thing",
  "STATUS:CANCELLED",
  "DTSTART:20260302T150000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

test("import: Outlook-style file — Windows zone names, folding, all-day, RRULE/EXDATE/RECURRENCE-ID, alarms", () => {
  const { db, c, ann, matter } = setup();
  const r = c.importIcs(OUTLOOK_FILE, { userId: ann, matterId: matter, attendees: [ann] });
  assert.equal(r.created.length, 4);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["cancelled"]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Every last weekday.*BYSETPOS.*first occurrence only/);

  const pre = c.listEvents({ sourceRef: "040000008200E00074C5B7101A82E008" })[0];
  assert.equal(pre.title, "Pretrial conference, Smith v. Jones");
  assert.equal(pre.start, "2026-04-15T18:30:00Z"); // 13:30 CDT
  assert.equal(pre.timeZone, "America/Chicago");
  assert.equal(pre.notes, "Bring the exhibit list.\nCall clerk first. This line is long enough to have been folded by Outlook.");
  assert.deepEqual(pre.reminders, [15]);
  assert.equal(pre.uid, "040000008200E00074C5B7101A82E008");
  assert.equal(pre.matterId, matter);
  assert.equal(pre.source, "ics_import");

  const closed = c.listEvents({ sourceRef: "allday-1@example.com" })[0];
  assert.deepEqual([closed.allDay, closed.start, closed.end], [true, "2026-05-25", "2026-05-25"]);

  const items = c.agenda({ from: "2026-03-01", to: "2026-03-31", userId: ann }).items.filter((i) => i.title.startsWith("Docket"));
  assert.deepEqual(
    items.map((i) => [i.startLocal, i.endLocal, i.title]),
    [
      ["2026-03-02T09:00", "2026-03-02T09:30", "Docket call"],
      ["2026-03-16T14:00", "2026-03-16T14:30", "Docket call (moved)"],
      ["2026-03-23T09:00", "2026-03-23T09:30", "Docket call"],
    ],
  );
  assert.ok(activity(db).some((a) => a.kind === "calendar_imported" && /4 added, 0 updated, 1 skipped/.test(a.detail)));
});

test("import: the same file again updates instead of duplicating", () => {
  const { c } = setup();
  c.importIcs(OUTLOOK_FILE);
  const n = c.listEvents().length;
  const changed = OUTLOOK_FILE.replace("LOCATION:Div. 7", "LOCATION:Div. 9");
  const r = c.importIcs(changed);
  assert.equal(r.created.length, 0);
  assert.equal(r.updated.length, 4);
  assert.equal(c.listEvents().length, n);
  assert.equal(c.listEvents({ sourceRef: "040000008200E00074C5B7101A82E008" })[0].location, "Div. 9");
  // the cancelled and moved occurrences survive the re-import
  assert.equal(c.agenda({ from: "2026-03-01", to: "2026-03-31" }).items.filter((i) => i.title.startsWith("Docket")).length, 3);
});

test("import: our own feed round-trips", () => {
  const { c, ann } = setup();
  c.createEvent({ title: "A; b, c", start: "2026-03-10T09:00", end: "2026-03-10T09:45", attendees: [ann], notes: "x\ny", location: "Room, 2" });
  c.createEvent({ title: "All day", allDay: true, start: "2026-03-11", end: "2026-03-12", attendees: [ann] });
  const ics = feedFor(c, ann);
  const fresh = setup();
  const r = fresh.c.importIcs(ics);
  assert.equal(r.created.length, 2);
  const [a, b] = fresh.c.listEvents();
  assert.deepEqual([a.title, a.startLocal, a.endLocal, a.location, a.kind], ["A; b, c", "2026-03-10T09:00", "2026-03-10T09:45", "Room, 2", "meeting"]);
  assert.match(a.notes, /x\ny/);
  assert.deepEqual([b.start, b.end], ["2026-03-11", "2026-03-12"]);
});

test("import: refuses junk; floating times read in firm zone; unknown zones warn", () => {
  const { c } = setup();
  err(() => c.importIcs(""), /empty/);
  err(() => c.importIcs("hello"), /Not a readable/);
  err(() => c.importIcs("BEGIN:VEVENT\r\nEND:VEVENT\r\n"), /no VCALENDAR/);
  const r = c.importIcs(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:f1",
      "SUMMARY:Floating",
      "DTSTART:20260710T090000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:f2",
      "SUMMARY:Paris",
      "DTSTART;TZID=Europe/Paris:20260710T090000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:f3",
      "SUMMARY:No start",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  assert.equal(c.listEvents({ sourceRef: "f1" })[0].start, "2026-07-10T14:00:00Z");
  assert.equal(c.listEvents({ sourceRef: "f2" })[0].start, "2026-07-10T07:00:00Z");
  assert.match(r.warnings.join(), /Europe\/Paris converted/);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["no start (DTSTART)"]);
});

test("import: does not overwrite an event that was not imported", () => {
  const { c } = setup();
  const { event } = c.createEvent({ title: "Mine", start: "2026-03-10T09:00" });
  const r = c.importIcs(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${event.uid}\r\nSUMMARY:Hijack\r\nDTSTART:20260310T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["already on the calendar"]);
  assert.equal(c.getEvent(event.id).title, "Mine");
});
