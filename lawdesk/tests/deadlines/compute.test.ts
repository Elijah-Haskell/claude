// K.S.A. 60-206 time computation. Every expected value below was worked out by hand from the
// statute's text (https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html) and a calendar:
//   (a)(1)(A) exclude the trigger day; (B) count every day; (C) if the last day is a Saturday,
//   Sunday or legal holiday, run to the next day that is not; (a)(5) "next day" goes forward for
//   periods after an event and backward for periods before one; (a)(3) inaccessible clerk's office;
//   (d) 3 days "added after the period would otherwise expire under subsection (a)" for service
//   by mail or by leaving with the clerk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeadline, deadlineToTaskInput, DISCLAIMER, DeadlineError } from "../../src/deadlines/compute.ts";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";

const due = (input: Parameters<typeof computeDeadline>[0]) => computeDeadline(input).date;

test("plain count: Mon 2026-11-02 + 21 days = Mon 2026-11-23", () => {
  // Day 1 is Tue Nov 3 (trigger day excluded); day 21 is Mon Nov 23, a business day.
  assert.equal(due({ trigger: "2026-11-02", days: 21 }), "2026-11-23");
});

test("last day on a Saturday runs to Monday", () => {
  // Thu 2026-10-01 + 30 = Sat Oct 31 -> Sun Nov 1 -> Mon Nov 2.
  assert.equal(due({ trigger: "2026-10-01", days: 30 }), "2026-11-02");
});

test("last day on a Sunday runs to Monday", () => {
  // Fri 2026-12-11 + 30 = Sun 2027-01-10 -> Mon Jan 11 (MLK Day 2027 is Jan 18, not the 11th).
  assert.equal(due({ trigger: "2026-12-11", days: 30 }), "2027-01-11");
});

test("intermediate weekends and holidays are counted, not skipped", () => {
  // Mon 2026-11-16 + 14 = Mon Nov 30. Thanksgiving (Nov 26) and two weekends fall inside and still count.
  const r = computeDeadline({ trigger: "2026-11-16", days: 14 });
  assert.equal(r.date, "2026-11-30");
  assert.match(r.steps[1], /counted, not skipped/);
});

test("last day on Thanksgiving runs to the Friday (2026 order not loaded, so Friday is not a holiday here)", () => {
  // Thu 2026-11-05 + 21 = Thu Nov 26, Thanksgiving (K.S.A. 35-107) -> Fri Nov 27.
  const r = computeDeadline({ trigger: "2026-11-05", days: 21 });
  assert.equal(r.date, "2026-11-27");
  assert.ok(r.warnings.some((w) => /No Kansas Supreme Court holiday order is loaded for 2026/.test(w)));
});

test("Friday after Thanksgiving supplied as an extra holiday pushes to Monday", () => {
  // Same as above, but Nov 27 is a holiday too: Fri 27 -> Sat 28 -> Sun 29 -> Mon Nov 30.
  assert.equal(due({ trigger: "2026-11-05", days: 21, extraHolidays: [{ date: "2026-11-27", name: "Court holiday" }] }), "2026-11-30");
});

test("2023: Thanksgiving and the Friday after (Order 2022-CC-080) both skipped", () => {
  // Tue 2023-10-24 + 30 = Thu Nov 23 (Thanksgiving) -> Fri Nov 24 (holiday by order) -> Sat -> Sun -> Mon Nov 27.
  const r = computeDeadline({ trigger: "2023-10-24", days: 30 });
  assert.equal(r.date, "2023-11-27");
  assert.ok(!r.warnings.some((w) => /No Kansas Supreme Court holiday order/.test(w)));
});

test("2025 National Day of Mourning (Order 2024-CC-105) is skipped", () => {
  // Tue 2024-12-10 + 30: Dec has 31 days, so day 21 is Dec 31 and day 30 is Thu 2025-01-09 -> Fri Jan 10.
  assert.equal(due({ trigger: "2024-12-10", days: 30 }), "2025-01-10");
});

test("Juneteenth counts as a legal holiday because Congress declared it", () => {
  // Wed 2026-05-20 + 30 = Fri June 19 (5 U.S.C. 6103(a)) -> Sat -> Sun -> Mon June 22.
  assert.equal(due({ trigger: "2026-05-20", days: 30 }), "2026-06-22");
});

test("year boundary: New Year's Day on a Friday runs to Monday Jan 4", () => {
  // Fri 2026-12-04 + 28: day 27 is Dec 31, day 28 is Fri 2027-01-01 (holiday) -> Sat -> Sun -> Mon Jan 4.
  assert.equal(due({ trigger: "2026-12-04", days: 28 }), "2027-01-04");
});

test("Christmas on a Friday runs to Monday Dec 28; Christmas Eve is an ordinary day", () => {
  // Wed 2026-11-25 + 30 = Fri Dec 25 -> Mon Dec 28.
  assert.equal(due({ trigger: "2026-11-25", days: 30 }), "2026-12-28");
  // Tue 2026-11-24 + 30 = Thu Dec 24, which no source read makes a holiday.
  assert.equal(due({ trigger: "2026-11-24", days: 30 }), "2026-12-24");
});

test("leap day is counted", () => {
  // Tue 2028-02-01 + 28 = Tue Feb 29, 2028 (Presidents' Day 2028 is Feb 21).
  assert.equal(due({ trigger: "2028-02-01", days: 28 }), "2028-02-29");
});

test("backward: 7 days before Mon 2026-11-30 hearing = Mon Nov 23", () => {
  // Day 1 back is Sun Nov 29, day 7 back is Mon Nov 23.
  assert.equal(due({ trigger: "2026-11-30", days: 7, direction: "before" }), "2026-11-23");
});

test("backward: last day on a weekend moves EARLIER (60-206(a)(5))", () => {
  // 1 day before Mon 2026-12-07 = Sun Dec 6 -> counting backward: Sat Dec 5 -> Fri Dec 4.
  assert.equal(due({ trigger: "2026-12-07", days: 1, direction: "before" }), "2026-12-04");
});

test("backward: last day on a holiday moves earlier, and the warning says a missing holiday is unsafe", () => {
  // 7 days before Thu 2026-12-03 = Thu Nov 26 (Thanksgiving) -> Wed Nov 25.
  const r = computeDeadline({ trigger: "2026-12-03", days: 7, direction: "before" });
  assert.equal(r.date, "2026-11-25");
  assert.ok(r.warnings.some((w) => /LATER than the true deadline/.test(w)));
});

test("backward across a year boundary", () => {
  // 7 days before Thu 2027-01-07 = Thu 2026-12-31 (not a holiday).
  assert.equal(due({ trigger: "2027-01-07", days: 7, direction: "before" }), "2026-12-31");
  // 4 days before Tue 2027-01-05 = Fri 2027-01-01 (holiday) -> Thu 2026-12-31.
  assert.equal(due({ trigger: "2027-01-05", days: 4, direction: "before" }), "2026-12-31");
});

test("clerk's office inaccessible on the last day (60-206(a)(3)) extends to the first accessible business day", () => {
  // Thu 2026-11-05 + 21 = Thanksgiving -> Fri Nov 27, which is closed -> Sat, Sun -> Mon Nov 30.
  const r = computeDeadline({ trigger: "2026-11-05", days: 21, courtClosedDays: ["2026-11-27"] });
  assert.equal(r.date, "2026-11-30");
  assert.ok(r.citations.some((c) => c.cite === "K.S.A. 60-206(a)(3)"));
  // A closed day that is not the last day has no effect: Mon 2026-11-02 + 21 = Mon Nov 23.
  assert.equal(due({ trigger: "2026-11-02", days: 21, courtClosedDays: ["2026-11-20"] }), "2026-11-23");
});

test("mail service: 3 days added AFTER the weekend roll of subsection (a)", () => {
  // Thu 2026-10-01 + 30 = Sat Oct 31 -> Mon Nov 2 under (a); then + 3 = Thu Nov 5.
  // (Adding 3 first and rolling after would wrongly give Tue Nov 3.)
  assert.equal(due({ trigger: "2026-10-01", days: 30, serviceMethod: "mail" }), "2026-11-05");
});

test("leaving with the clerk also adds 3 days; hand, fax and electronic service do not", () => {
  // Mon 2026-11-02 + 21 = Mon Nov 23; + 3 = Thu Nov 26 (Thanksgiving) -> see the next test for that case.
  // Use Mon 2026-11-09 + 21 = Mon Nov 30; + 3 = Thu Dec 3.
  assert.equal(due({ trigger: "2026-11-09", days: 21, serviceMethod: "clerk" }), "2026-12-03");
  for (const m of ["hand", "leaving", "fax", "electronic"] as const) {
    assert.equal(due({ trigger: "2026-11-09", days: 21, serviceMethod: m }), "2026-11-30", m);
  }
});

test("mail days ending on a weekend: shows the earlier date and offers the later one with a warning", () => {
  // Mon 2026-11-02 + 30 = Wed Dec 2; + 3 = Sat Dec 5. The statute does not say whether (a)(1)(C)
  // applies again, so the deadline is the Saturday, and Mon Dec 7 is reported as the possible later date.
  const r = computeDeadline({ trigger: "2026-11-02", days: 30, serviceMethod: "mail" });
  assert.equal(r.date, "2026-12-05");
  assert.equal(r.laterDateIfExtended, "2026-12-07");
  assert.ok(r.warnings.some((w) => /safer reading/.test(w)));
});

test("mail days on a backward period are not added", () => {
  const r = computeDeadline({ trigger: "2026-11-30", days: 7, direction: "before", serviceMethod: "mail" });
  assert.equal(r.date, "2026-11-23");
  assert.ok(r.warnings.some((w) => /not added/.test(w)));
});

test("hours: 48 hours from Friday 10:00 ending on Sunday runs to Monday 10:00", () => {
  const r = computeDeadline({ trigger: "2026-11-20T10:00", hours: 48 });
  assert.equal(r.date, "2026-11-23");
  assert.equal(r.time, "10:00");
});

test("hours: elapsed hours across the end of daylight saving time (Nov 1, 2026)", () => {
  // Sat 2026-10-31 12:00 CDT + 24 real hours = Sun Nov 1 11:00 CST -> Sunday, so Mon Nov 2 at 11:00.
  const r = computeDeadline({ trigger: "2026-10-31T12:00", hours: 24 });
  assert.equal(r.date, "2026-11-02");
  assert.equal(r.time, "11:00");
  assert.ok(r.warnings.some((w) => /daylight-saving/.test(w)));
});

test("hours: ending on a weekday needs no adjustment", () => {
  // Mon 2026-11-16 09:30 + 72 hours = Thu Nov 19 09:30.
  const r = computeDeadline({ trigger: "2026-11-16T09:30", hours: 72 });
  assert.equal(r.date, "2026-11-19");
  assert.equal(r.time, "09:30");
});

test("output carries steps, citations, the 60-206(a)(4) end-of-day rule and the disclaimer", () => {
  const r = computeDeadline({ trigger: "2026-11-02", days: 21 });
  assert.equal(r.disclaimer, DISCLAIMER);
  assert.match(r.disclaimer, /federal court/i);
  assert.match(r.disclaimer, /local rules/i);
  assert.match(r.lastDayEnds, /midnight/);
  assert.ok(r.steps.length >= 4);
  assert.ok(r.citations.every((c) => c.url.startsWith("https://")));
});

test("bad input is refused", () => {
  assert.throws(() => computeDeadline({ trigger: "2026-02-30", days: 3 }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: 0 }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: -5 }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: 2.5 }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02" } as any), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: 3, hours: 3 }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: 3, direction: "sideways" as any }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: 3, serviceMethod: "pigeon" as any }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", days: 3, courtClosedDays: ["soon"] }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02", hours: 3 }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2026-11-02T10:00", hours: 3, serviceMethod: "mail" }), DeadlineError);
  assert.throws(() => computeDeadline({ trigger: "2010-01-04", days: 3 }), DeadlineError);
});

test("deadlineToTaskInput: a task the engine accepts, with the working in the description", () => {
  const r = computeDeadline({ trigger: "2026-10-01", days: 30, serviceMethod: "mail" });
  const input = deadlineToTaskInput(r, { title: "Answer interrogatories" });
  assert.equal(input.dueDate, "2026-11-05");
  assert.equal(input.priority, "high");
  assert.match(input.description!, /60-206\(d\)/);
  assert.match(input.description!, /VERIFY THIS DATE/);

  const e = new Engine(openDb(), { today: () => "2026-10-02" });
  const id = e.addTask(input);
  const row = e.db.prepare("SELECT due_date, description FROM tasks WHERE id = ?").get(id) as any;
  assert.equal(row.due_date, "2026-11-05");
  assert.match(row.description, /How it was computed/);
});
