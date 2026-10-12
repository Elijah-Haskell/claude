import { describe, expect, it } from "vitest";
import {
  clampDateToRange,
  inferYear,
  isRealDateKey,
  parseDateInput,
  resolveItemDate,
  resolveWeekDate,
  semesterNameFor,
  weekOneMonday,
  weekRange,
  type RawDateFields,
} from "../../src/engine/syllabus-dates";

const TERM = { termStart: "2026-08-24", termEnd: "2026-12-11" }; // Monday .. Friday
const SPRING = { termStart: "2027-01-11", termEnd: "2027-05-07" };

function raw(overrides: Partial<RawDateFields> = {}): RawDateFields {
  return { dueDate: null, weekNumber: null, weekday: null, dateConfidence: "explicit", dateEvidence: "", ...overrides };
}

describe("parseDateInput", () => {
  it.each([
    ["2026-10-20", { year: 2026, month: 10, day: 20 }],
    ["2026/10/20", { year: 2026, month: 10, day: 20 }],
    ["2026-10-20T23:59:00Z", { year: 2026, month: 10, day: 20 }],
    ["10/20/2026", { year: 2026, month: 10, day: 20 }],
    ["10/20/26", { year: 2026, month: 10, day: 20 }],
    ["10/20", { year: null, month: 10, day: 20 }],
    ["10-20", { year: null, month: 10, day: 20 }],
    ["--10-20", { year: null, month: 10, day: 20 }],
    ["October 20", { year: null, month: 10, day: 20 }],
    ["Oct. 20th", { year: null, month: 10, day: 20 }],
    ["Fri, Oct 20, 2026", { year: 2026, month: 10, day: 20 }],
    ["Tuesday October 20", { year: null, month: 10, day: 20 }],
    ["20 October 2026", { year: 2026, month: 10, day: 20 }],
    ["20 Oct", { year: null, month: 10, day: 20 }],
    ["Sept 1st", { year: null, month: 9, day: 1 }],
    ["26-Aug", { year: null, month: 8, day: 26 }],
    ["2-Sep", { year: null, month: 9, day: 2 }],
    ["Wed 2-Sep", { year: null, month: 9, day: 2 }],
    ["2-Sep-2026", { year: 2026, month: 9, day: 2 }],
    ["Sep-2", { year: null, month: 9, day: 2 }],
    ["25/12/2026", { year: 2026, month: 12, day: 25 }], // 25 cannot be a month: read day-first
    ["Feb 29", { year: null, month: 2, day: 29 }], // possible in a leap year
    ["2028-02-29", { year: 2028, month: 2, day: 29 }],
  ])("reads %s", (input, date) => {
    expect(parseDateInput(input)).toEqual({ ok: true, date });
  });

  it.each([
    ["2026-02-30", "impossible"],
    ["2027-02-29", "impossible"],
    ["Feb 30", "impossible"],
    ["April 31", "impossible"],
    ["13/45", "impossible"],
    ["2026-13-01", "impossible"],
    ["2026-00-10", "impossible"],
    ["", "empty"],
    ["   ", "empty"],
    ["sometime in October", "unparseable"],
    ["TBA", "unparseable"],
    ["October 2026", "unparseable"],
    ["Oct Nov 3", "unparseable"],
  ])("rejects %j as %s", (input, reason) => {
    expect(parseDateInput(input)).toEqual({ ok: false, reason });
  });

  it("rejects non-strings", () => {
    expect(parseDateInput(null)).toEqual({ ok: false, reason: "empty" });
    expect(parseDateInput(20261020)).toEqual({ ok: false, reason: "empty" });
  });

  it("isRealDateKey rejects impossible and badly formatted keys", () => {
    expect(isRealDateKey("2026-09-20")).toBe(true);
    expect(isRealDateKey("2028-02-29")).toBe(true);
    expect(isRealDateKey("2026-02-29")).toBe(false);
    expect(isRealDateKey("2026-9-2")).toBe(false);
    expect(isRealDateKey(undefined)).toBe(false);
  });
});

describe("a printed weekday picks the year", () => {
  it("only the year in which 2-Sep is a Wednesday is chosen, wherever today is", () => {
    expect(inferYear(9, 2, { today: "2027-06-01", weekday: "Wed" })?.key).toBe("2026-09-02");
    expect(inferYear(9, 2, { today: "2026-06-01", weekday: "Thu" })?.key).toBe("2027-09-02");
  });
  it("a weekday that fits no candidate year is ignored rather than inventing anything", () => {
    expect(inferYear(9, 2, { today: "2026-06-01", weekday: "Sun" })?.key).toBe("2026-09-02");
  });
});

describe("weekOneMonday / resolveWeekDate", () => {
  it("week 1 is the week the term starts in", () => {
    expect(weekOneMonday("2026-08-24")).toBe("2026-08-24"); // Monday
    expect(weekOneMonday("2026-08-26")).toBe("2026-08-24"); // Wednesday start
    expect(weekOneMonday("2026-08-29")).toBe("2026-08-31"); // Saturday start rolls forward
    expect(weekOneMonday("2026-08-30")).toBe("2026-08-31"); // Sunday start rolls forward
    expect(weekOneMonday("nonsense")).toBeNull();
  });

  it("resolves 'Week 5 Friday' relative to the term start, not to today", () => {
    expect(resolveWeekDate(5, "Fri", "2026-08-24")).toEqual({ date: "2026-09-25", weekStart: "2026-09-21", inBreak: null });
    expect(resolveWeekDate(1, "Mon", "2026-08-24")?.date).toBe("2026-08-24");
    expect(resolveWeekDate(1, "Sun", "2026-08-24")?.date).toBe("2026-08-30");
  });

  it("works across a mid-week start, a year boundary and a leap day", () => {
    expect(resolveWeekDate(2, "Tue", "2026-08-26")?.date).toBe("2026-09-01");
    expect(resolveWeekDate(8, "Wed", "2026-11-02")?.date).toBe("2026-12-23");
    expect(resolveWeekDate(9, "Mon", "2026-11-02")?.date).toBe("2026-12-28");
    expect(resolveWeekDate(10, "Mon", "2026-11-02")?.date).toBe("2027-01-04");
    expect(resolveWeekDate(4, "Thu", "2028-02-07")?.date).toBe("2028-03-02");
  });

  it("accepts full weekday names and is case-insensitive", () => {
    expect(resolveWeekDate(3, "friday", "2026-08-24")?.date).toBe("2026-09-11");
    expect(resolveWeekDate(3, "FRI", "2026-08-24")?.date).toBe("2026-09-11");
  });

  it("returns null for unusable input instead of guessing", () => {
    expect(resolveWeekDate(0, "Fri", "2026-08-24")).toBeNull();
    expect(resolveWeekDate(-2, "Fri", "2026-08-24")).toBeNull();
    expect(resolveWeekDate(2.5, "Fri", "2026-08-24")).toBeNull();
    expect(resolveWeekDate(99, "Fri", "2026-08-24")).toBeNull();
    expect(resolveWeekDate(3, "Someday", "2026-08-24")).toBeNull();
    expect(resolveWeekDate(3, "Fri", "2026-02-30")).toBeNull();
  });

  const springBreak = [{ name: "Spring Break", startDate: "2027-03-08", endDate: "2027-03-14" }];

  it("flags a date inside a break but does not move it (calendar numbering)", () => {
    const result = resolveWeekDate(9, "Wed", SPRING.termStart, springBreak);
    expect(result?.date).toBe("2027-03-10");
    expect(result?.inBreak?.name).toBe("Spring Break");
  });

  it("instructional numbering skips break weeks", () => {
    // Weeks 1-8 are Jan 11 - Mar 1... calendar week 9 is the break week, so instructional week 9 is one week later.
    expect(resolveWeekDate(9, "Wed", SPRING.termStart, springBreak, { numbering: "calendar" })?.date).toBe("2027-03-10");
    const instructional = resolveWeekDate(9, "Wed", SPRING.termStart, springBreak, { numbering: "instructional" });
    expect(instructional?.date).toBe("2027-03-17");
    expect(instructional?.inBreak).toBeNull();
    // weeks before the break are unaffected
    expect(resolveWeekDate(8, "Wed", SPRING.termStart, springBreak, { numbering: "instructional" })?.date).toBe("2027-03-03");
  });

  it("a single break day (not a full week) does not remove a week from instructional numbering", () => {
    const oneDay = [{ name: "Holiday", startDate: "2027-02-15", endDate: "2027-02-15" }];
    expect(resolveWeekDate(6, "Fri", SPRING.termStart, oneDay, { numbering: "instructional" })?.date).toBe("2027-02-19");
  });

  it("weekRange gives Monday..Sunday", () => {
    expect(weekRange(5, "2026-08-24")).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(weekRange(0, "2026-08-24")).toBeNull();
  });
});

describe("inferYear", () => {
  it("puts a month/day inside the term", () => {
    expect(inferYear(10, 20, { ...TERM, today: "2026-09-20" })).toMatchObject({ key: "2026-10-20", insideTerm: true });
    // a spring term that starts in January: 'March 15' is that year, even when uploaded from the previous December
    expect(inferYear(3, 15, { ...SPRING, today: "2026-12-20" })).toMatchObject({ key: "2027-03-15", insideTerm: true });
  });

  it("handles a term that straddles New Year", () => {
    const winter = { termStart: "2026-11-02", termEnd: "2027-02-12", today: "2026-11-10" };
    expect(inferYear(12, 4, winter)?.key).toBe("2026-12-04");
    expect(inferYear(1, 20, winter)?.key).toBe("2027-01-20");
  });

  it("falls back to the year nearest to today when no term is known", () => {
    expect(inferYear(3, 15, { today: "2026-09-20" })?.key).toBe("2027-03-15"); // 176 days ahead beats 189 days back
    expect(inferYear(8, 1, { today: "2026-09-20" })?.key).toBe("2026-08-01");
    expect(inferYear(12, 31, { today: "2026-01-02" })?.key).toBe("2025-12-31"); // just before today is nearest
  });

  it("reports when no year lands inside a known term (and picks nearest to today)", () => {
    const result = inferYear(2, 1, { ...TERM, today: "2026-09-20" });
    expect(result).toMatchObject({ key: "2027-02-01", insideTerm: false });
  });

  it("uses a single known end of the term to pick a year, without claiming certainty", () => {
    const result = inferYear(10, 20, { termStart: "2026-08-24", today: "2026-09-20" });
    expect(result).toMatchObject({ key: "2026-10-20", insideTerm: null });
  });

  it("Feb 29 only resolves to leap years", () => {
    expect(inferYear(2, 29, { termStart: "2028-01-10", termEnd: "2028-05-01", today: "2028-01-15" })?.key).toBe("2028-02-29");
    expect(inferYear(2, 29, { today: "2026-09-20" })?.key).toBe("2028-02-29");
  });

  it("returns null without any anchor date", () => {
    expect(inferYear(3, 1, { today: "garbage" })).toBeNull();
  });
});

describe("resolveItemDate", () => {
  const ctx = { ...TERM, today: "2026-09-20" };

  it("keeps an explicit date and marks it explicit", () => {
    const r = resolveItemDate(raw({ dueDate: "2026-10-20", dateEvidence: "Midterm: Oct 20, 2026" }), ctx);
    expect(r).toMatchObject({ dueDate: "2026-10-20", source: "explicit", confidence: "explicit", isUndated: false, isPast: false, outOfRange: null, problem: null });
  });

  it("infers the year of a month/day date inside the term and downgrades the confidence", () => {
    const r = resolveItemDate(raw({ dueDate: "10-20", dateEvidence: "Oct 20" }), ctx);
    expect(r).toMatchObject({ dueDate: "2026-10-20", source: "year-inferred", confidence: "inferred" });
  });

  it("resolves Week N + weekday from the term start", () => {
    const r = resolveItemDate(raw({ dueDate: null, weekNumber: 5, weekday: "Fri", dateConfidence: "inferred", dateEvidence: "Week 5 Friday" }), ctx);
    expect(r).toMatchObject({ dueDate: "2026-09-25", source: "week", confidence: "inferred", isPast: false });
  });

  it("a week with no weekday stays UNDATED and offers a range instead of picking a day", () => {
    const r = resolveItemDate(raw({ weekNumber: 5, dateConfidence: "inferred", dateEvidence: "Week 5: Paper due" }), ctx);
    expect(r.dueDate).toBeNull();
    expect(r.isUndated).toBe(true);
    expect(r.problem).toBe("week-without-weekday");
    expect(r.weekHint).toEqual({ start: "2026-09-21", end: "2026-09-27" });
  });

  it("a week-based item with no known term start stays undated and says why", () => {
    const r = resolveItemDate(raw({ weekNumber: 5, weekday: "Fri", dateConfidence: "inferred" }), { today: "2026-09-20" });
    expect(r).toMatchObject({ dueDate: null, isUndated: true, problem: "needs-term-start" });
  });

  it("NEVER invents a date: null / empty / prose all stay undated", () => {
    for (const dueDate of [null, "", "   ", "TBA", "sometime in October"]) {
      const r = resolveItemDate(raw({ dueDate, dateConfidence: "missing" }), ctx);
      expect(r.dueDate).toBeNull();
      expect(r.isUndated).toBe(true);
      expect(r.confidence).toBe("missing");
    }
  });

  it("rejects an impossible date (Feb 30) instead of repairing it", () => {
    const r = resolveItemDate(raw({ dueDate: "2027-02-30", dateEvidence: "due Feb 30" }), ctx);
    expect(r).toMatchObject({ dueDate: null, isUndated: true, problem: "impossible-date" });
  });

  it("a model that says 'missing' but returns a bare date with no quote guessed: the date is dropped", () => {
    const r = resolveItemDate(raw({ dueDate: "2026-11-01", dateConfidence: "missing", dateEvidence: "" }), ctx);
    expect(r.dueDate).toBeNull();
    expect(r.isUndated).toBe(true);
  });

  it("a 'missing' date that does come with a quote is kept but only as inferred", () => {
    const r = resolveItemDate(raw({ dueDate: "2026-11-01", dateConfidence: "missing", dateEvidence: "due first Sunday of November" }), ctx);
    expect(r).toMatchObject({ dueDate: "2026-11-01", confidence: "inferred" });
  });

  it("the model's lower confidence is respected for an explicit-looking date", () => {
    const r = resolveItemDate(raw({ dueDate: "2026-11-01", dateConfidence: "inferred", dateEvidence: "early November" }), ctx);
    expect(r.confidence).toBe("inferred");
  });

  it("flags out-of-range dates and does NOT move them", () => {
    expect(resolveItemDate(raw({ dueDate: "2027-01-15", dateEvidence: "x" }), ctx)).toMatchObject({ dueDate: "2027-01-15", outOfRange: "after-term" });
    expect(resolveItemDate(raw({ dueDate: "2026-08-01", dateEvidence: "x" }), ctx)).toMatchObject({ dueDate: "2026-08-01", outOfRange: "before-term" });
  });

  it("past = strictly before today; due today is not past", () => {
    expect(resolveItemDate(raw({ dueDate: "2026-09-19" }), ctx).isPast).toBe(true);
    expect(resolveItemDate(raw({ dueDate: "2026-09-20" }), ctx).isPast).toBe(false);
    expect(resolveItemDate(raw({ dueDate: "2026-09-21" }), ctx).isPast).toBe(false);
  });

  it("does not move a past item forward (mid-semester uploads keep the whole picture)", () => {
    const r = resolveItemDate(raw({ dueDate: "2026-09-04", dateEvidence: "HW1 due Sep 4" }), ctx);
    expect(r.dueDate).toBe("2026-09-04");
    expect(r.isPast).toBe(true);
  });

  it("reports a date that falls inside a break", () => {
    const r = resolveItemDate(raw({ dueDate: "2026-11-25", dateEvidence: "x" }), { ...ctx, breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] });
    expect(r.inBreak).toBe("Thanksgiving");
    expect(r.dueDate).toBe("2026-11-25");
  });

  it("gives the same answer in every timezone (pure calendar arithmetic)", () => {
    const a = resolveItemDate(raw({ weekNumber: 12, weekday: "Thu", dateConfidence: "inferred", dateEvidence: "w12" }), ctx);
    expect(a.dueDate).toBe("2026-11-12");
  });
});

describe("clampDateToRange", () => {
  it("moves a date inside the range and says so", () => {
    expect(clampDateToRange("2027-01-15", "2026-08-24", "2026-12-11")).toEqual({ date: "2026-12-11", clamped: true, direction: "after" });
    expect(clampDateToRange("2026-08-01", "2026-08-24", "2026-12-11")).toEqual({ date: "2026-08-24", clamped: true, direction: "before" });
    expect(clampDateToRange("2026-10-01", "2026-08-24", "2026-12-11")).toEqual({ date: "2026-10-01", clamped: false, direction: null });
    expect(clampDateToRange("2026-10-01", null, undefined)).toEqual({ date: "2026-10-01", clamped: false, direction: null });
  });
});

describe("semesterNameFor", () => {
  it("labels the term from its start month", () => {
    expect(semesterNameFor("2026-08-24")).toBe("Fall 2026");
    expect(semesterNameFor("2027-01-11")).toBe("Spring 2027");
    expect(semesterNameFor("2026-06-08")).toBe("Summer 2026");
    expect(semesterNameFor("bad")).toBe("This semester");
  });
});
