import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { Calendar } from "../../src/calendar/calendar.ts";
import { book, cancelConsultation, openSlots, publicBook, publicBooking, setAvailability, listAvailability, clock as fmtClock, describeInstant } from "../../src/intake/booking.ts";

const weekdays = (start: string, end: string) => [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start, end }));

test("availability is validated", () => {
  const { it, jordan } = setup();
  assert.throws(() => setAvailability(it, jordan, { consultMinutes: 5 }, null), /10 to 240/);
  assert.throws(() => setAvailability(it, jordan, { windows: [{ weekday: 1, start: "9am", end: "10:00" }] }, null), /times like/);
  assert.throws(() => setAvailability(it, jordan, { consultMinutes: 60, windows: [{ weekday: 1, start: "09:00", end: "09:30" }] }, null), /shorter/);
  assert.throws(
    () => setAvailability(it, jordan, { windows: [{ weekday: 1, start: "09:00", end: "11:00" }, { weekday: 1, start: "10:00", end: "12:00" }] }, null),
    /overlap/,
  );
  const p = setAvailability(it, jordan, { consultMinutes: 45, location: "Main office", windows: weekdays("09:00", "11:00") }, null);
  assert.equal(p.consultMinutes, 45);
  assert.equal(p.windows.length, 5);
  assert.equal(listAvailability(it).find((x) => x.userId === jordan)!.takesConsultations, true);
});

test("open slots respect notice, existing events, closed days and length", () => {
  const { it, db, engine, jordan } = setup();
  setAvailability(it, jordan, { consultMinutes: 30, windows: weekdays("09:00", "11:00") }, null);
  engine.addHoliday("2026-11-26", "Thanksgiving");
  const cal = new Calendar(db);
  cal.createEvent({ title: "Hearing", start: "2026-11-19T09:30", end: "2026-11-19T10:15", attendees: [jordan] });
  const slots = openSlots(it);
  // Now is Wed 9:00 AM with 24 hours' notice, so the first day is Thursday.
  assert.equal(slots[0].date, "2026-11-19");
  assert.deepEqual(slots.filter((s) => s.date === "2026-11-19").map((s) => s.time), ["9:00 AM", "10:30 AM"]);
  assert.equal(slots.filter((s) => s.date === "2026-11-20").length, 4);
  assert.ok(!slots.some((s) => s.date === "2026-11-21" || s.date === "2026-11-22"), "no weekend slots");
  assert.ok(!slots.some((s) => s.date === "2026-11-26"), "closed for Thanksgiving");
  // 9:00 AM Central in November is 15:00 UTC.
  assert.equal(slots[0].start, "2026-11-19T15:00:00Z");
  assert.equal(fmtClock("13:05"), "1:05 PM");
  assert.equal(describeInstant("2026-11-19T15:00:00Z"), "Thursday, November 19 at 9:00 AM");
});

test("staff booking puts a meeting on the calendar, moves the lead and queues a confirmation", () => {
  const { it, db, jordan } = setup();
  setAvailability(it, jordan, { consultMinutes: 30, location: "Main office", windows: weekdays("09:00", "11:00") }, null);
  const l = it.createLead({ name: "Quinn Adams", email: "quinn@example.test" });
  const r = book(it, l.id, { userId: jordan, start: "2026-11-19T15:00:00Z", via: "staff" }, jordan);
  const ev = db.prepare("SELECT * FROM cal_events WHERE id = ?").get(r.eventId) as any;
  assert.equal(ev.title, "Consultation: Quinn Adams");
  assert.equal(ev.source, "intake");
  assert.equal(ev.end_at, "2026-11-19T15:30:00Z");
  const lead = it.getLead(l.id);
  assert.equal(lead.status, "consult_scheduled");
  assert.equal(lead.consultations.length, 1);
  assert.ok(lead.emails.some((e: any) => e.kind === "booking_confirmation" && /Thursday, November 19 at 9:00 AM/.test(e.body)));
  // The slot is gone, and booking it again fails.
  assert.ok(!openSlots(it).some((s) => s.start === "2026-11-19T15:00:00Z"));
  assert.throws(() => book(it, l.id, { userId: jordan, start: "2026-11-19T15:00:00Z", via: "staff" }, jordan), /just been taken/);
  // A time that was never offered.
  assert.throws(() => book(it, l.id, { userId: jordan, start: "2026-11-19T15:10:00Z", via: "staff" }, jordan), /no longer available/);
  // Cancelling removes the calendar event and frees the slot.
  const after = cancelConsultation(it, r.consultationId, jordan);
  assert.equal(after.consultations[0].status, "cancelled");
  assert.ok(openSlots(it).some((s) => s.start === "2026-11-19T15:00:00Z"));
  // Converting moves consultation events onto the matter.
  const r2 = book(it, l.id, { userId: jordan, start: "2026-11-20T15:00:00Z", via: "staff" }, jordan);
  it.decideConflict(l.id, "cleared", null, jordan);
  const c = it.convert(l.id, {}, jordan);
  assert.equal((db.prepare("SELECT matter_id FROM cal_events WHERE id = ?").get(r2.eventId) as any).matter_id, c.matterId);
});

test("public booking page: slots, new lead, personal link, spam checks", () => {
  const { it, clock, jordan } = setup();
  setAvailability(it, jordan, { consultMinutes: 30, windows: weekdays("09:00", "10:00") }, null);
  const tok = it.settings().booking_token;
  assert.throws(() => publicBooking(it, "wrong", {}), /isn't available/);
  const page = publicBooking(it, tok, {});
  assert.equal(page.people.length, 1);
  assert.ok(page.days.length > 0);
  assert.ok(!JSON.stringify(page).includes("Hearing"));
  const slot = page.days[0].slots[0];
  clock.now += 15_000;
  assert.throws(() => publicBook(it, tok, { stamp: page.stamp, userId: slot.userId, start: slot.start, name: "Lee Fox" }, "9.9.9.9"), /email address or a phone/);
  const r = publicBook(it, tok, { stamp: page.stamp, userId: slot.userId, start: slot.start, name: "Lee Fox", email: "lee@example.test", summary: "Will question" }, "9.9.9.9") as any;
  assert.match(r.when, /at 9:00 AM/);
  const lead = it.listLeads()[0];
  assert.equal(lead.name, "Lee Fox");
  assert.equal(lead.status, "consult_scheduled");
  // Honeypot.
  const hp = publicBook(it, tok, { stamp: page.stamp, website: "x", userId: slot.userId, start: page.days[0].slots[1].start, name: "Bot" }, "9.9.9.9") as any;
  assert.equal(hp.when, null);
  assert.equal(it.listLeads().length, 1);
  // A lead's own link books for that lead without asking for details again.
  const other = it.createLead({ name: "Mia Wong", phone: "316-555-0199" });
  const mine = publicBooking(it, tok, { lead: other.publicToken });
  assert.equal(mine.personal, true);
  clock.now += 15_000;
  const s2 = mine.days[0].slots[0];
  publicBook(it, tok, { stamp: mine.stamp, lead: other.publicToken, userId: s2.userId, start: s2.start }, "8.8.8.8");
  assert.equal(it.getLead(other.id).status, "consult_scheduled");
  assert.equal(it.listLeads().length, 2);
  assert.throws(() => publicBooking(it, tok, { lead: "nonexistent-token" }), /isn't valid/);
});
