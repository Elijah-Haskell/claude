import { describe, expect, it } from "vitest";
import {
  compactTimeRange,
  countdownBadge,
  dateRangeTitle,
  defaultMonthDay,
  gridSessionText,
  hourRailLabel,
  isDeadline,
  isWeekView,
  monthCells,
  monthMarks,
  monthTitle,
  narrowBlockLabel,
  periodEyebrow,
  showsToday,
  stepAnchor,
  termDayNote,
  visibleDates,
} from "../../src/engine/week-view";

// The Week tab's three views (app/(tabs)/week.tsx): three days, seven days, a month.
const WED = "2026-09-30";
/** "YYYY-MM-DD" plus a number of days, for the expectations below. */
function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const TERM = { name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [{ name: "Fall break", startDate: "2026-10-15", endDate: "2026-10-16" }] };

describe("what is on screen", () => {
  it("three days start on the anchor", () => {
    expect(visibleDates("days", WED)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("the week runs Monday to Sunday around the anchor", () => {
    expect(visibleDates("week", WED)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(visibleDates("week", "2026-10-04")[0]).toBe("2026-09-28"); // a Sunday belongs to the week before it
  });

  it("knows the three views by name", () => {
    expect(isWeekView("days")).toBe(true);
    expect(isWeekView("month")).toBe(true);
    expect(isWeekView("year")).toBe(false);
    expect(isWeekView(undefined)).toBe(false);
  });
});

describe("back and forward", () => {
  it("three days at a time, a week at a time, a month at a time", () => {
    expect(stepAnchor("days", WED, 1, WED)).toBe("2026-10-03");
    expect(stepAnchor("days", WED, -1, WED)).toBe("2026-09-27");
    expect(stepAnchor("week", WED, 1, WED)).toBe("2026-10-07");
    expect(stepAnchor("month", WED, 1, WED)).toBe("2026-10-01");
    expect(stepAnchor("month", WED, -1, WED)).toBe("2026-08-01");
  });

  it("stepping away and back ends on today again", () => {
    expect(stepAnchor("days", stepAnchor("days", WED, 1, WED), -1, WED)).toBe(WED);
    expect(stepAnchor("week", stepAnchor("week", WED, -1, WED), 1, WED)).toBe(WED);
    expect(stepAnchor("month", stepAnchor("month", WED, 1, WED), -1, WED)).toBe(WED);
  });

  it("three days at a time never skips or repeats a day, wherever it starts", () => {
    // From the Monday of last week (where the week view leaves the page), forward: every day shows exactly once,
    // the days just before today included (today then sits inside a page instead of starting it).
    for (const start of ["2026-09-21", "2026-09-25", "2026-09-26", "2026-09-28"]) {
      const seen: string[] = [];
      let anchor = start;
      for (let page = 0; page < 6; page += 1) {
        seen.push(...visibleDates("days", anchor));
        anchor = stepAnchor("days", anchor, 1, WED);
      }
      expect(seen).toEqual(Array.from({ length: 18 }, (_, index) => addDays(start, index)));
    }
    expect(visibleDates("days", stepAnchor("days", "2026-09-25", 1, WED))).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(stepAnchor("days", "2026-10-02", -1, WED)).toBe("2026-09-29");
  });

  it("a week or a month that holds today is anchored on today, so three days from there start today", () => {
    expect(stepAnchor("week", "2026-10-07", -1, WED)).toBe(WED);
    expect(stepAnchor("week", "2026-09-22", 1, WED)).toBe(WED);
    expect(stepAnchor("month", "2026-10-20", -1, WED)).toBe(WED);
  });

  it("crosses a year", () => {
    expect(stepAnchor("month", "2026-12-15", 1, WED)).toBe("2027-01-01");
    expect(stepAnchor("month", "2027-01-10", -1, WED)).toBe("2026-12-01");
  });

  it("says whether the page shows today", () => {
    expect(showsToday("days", WED, WED)).toBe(true);
    expect(showsToday("days", "2026-09-28", WED)).toBe(true);
    expect(showsToday("days", "2026-10-01", WED)).toBe(false);
    expect(showsToday("week", "2026-10-04", WED)).toBe(true);
    expect(showsToday("month", "2026-09-01", WED)).toBe(true);
    expect(showsToday("month", "2026-10-01", WED)).toBe(false);
  });
});

describe("the title", () => {
  it("names the days on screen, with the second month only when it changes", () => {
    expect(dateRangeTitle("2026-09-30", "2026-10-02")).toBe("Sep 30 – Oct 2");
    expect(dateRangeTitle("2026-10-07", "2026-10-09")).toBe("Oct 7 – 9");
    expect(dateRangeTitle("2026-12-30", "2027-01-01")).toBe("Dec 30 – Jan 1");
  });

  it("names the month, with the year when it is not this one", () => {
    expect(monthTitle("2026-10-14", WED)).toBe("October");
    expect(monthTitle("2027-01-05", WED)).toBe("January 2027");
  });
});

describe("the line over the title", () => {
  it("counts the week of the term", () => {
    expect(periodEyebrow("days", "2026-09-30", "2026-10-02", TERM)).toBe("Fall 2026 · Week 6 of 16");
    expect(periodEyebrow("week", "2026-08-24", "2026-08-30", TERM)).toBe("Fall 2026 · Week 1 of 16");
  });

  it("gives a span of weeks for a month, or for three days across a weekend", () => {
    expect(periodEyebrow("month", "2026-10-01", "2026-10-31", TERM)).toBe("Fall 2026 · Weeks 6 to 10");
    expect(periodEyebrow("days", "2026-10-03", "2026-10-05", TERM)).toBe("Fall 2026 · Weeks 6 to 7");
  });

  it("counts only the weeks a page shares with the term", () => {
    expect(periodEyebrow("month", "2026-08-01", "2026-08-31", TERM)).toBe("Fall 2026 · Weeks 1 to 2");
    expect(periodEyebrow("month", "2026-12-01", "2026-12-31", TERM)).toBe("Fall 2026 · Weeks 15 to 16");
  });

  it("is the term's name alone outside the term, and plain words before a term is set", () => {
    expect(periodEyebrow("week", "2027-01-04", "2027-01-10", TERM)).toBe("Fall 2026");
    expect(periodEyebrow("week", "2026-08-10", "2026-08-16", TERM)).toBe("Fall 2026");
    expect(periodEyebrow("week", "2026-09-28", "2026-10-04", null)).toBe("Your week");
    expect(periodEyebrow("month", "2026-10-01", "2026-10-31", undefined)).toBe("Your month");
  });

  it("leaves the term's name out when the line would not fit", () => {
    const long = { ...TERM, name: "Autumn Semester 2026-2027" };
    expect(periodEyebrow("days", "2026-09-30", "2026-10-02", long)).toBe("Week 6 of 16");
    expect(periodEyebrow("week", "2027-01-04", "2027-01-10", { ...TERM, name: "The Autumn Semester of 2026 to 2027" })).toBe("Your week");
  });

  it("shows the name for every week of a term or for none: the line does not change shape at week 10", () => {
    const spring = { name: "Spring 2027", startDate: "2027-01-11", endDate: "2027-05-07", breaks: [] };
    expect(periodEyebrow("week", "2027-03-08", "2027-03-14", spring)).toBe("Spring 2027 · Week 9 of 17");
    expect(periodEyebrow("week", "2027-03-15", "2027-03-21", spring)).toBe("Spring 2027 · Week 10 of 17");
    expect(periodEyebrow("month", "2027-04-01", "2027-04-30", spring)).toBe("Spring 2027 · Weeks 12 to 16");
    // A name that would not fit beside the last weeks is left out from the first week on.
    const long = { ...spring, name: "Spring Semester 2027" };
    expect(periodEyebrow("week", "2027-01-11", "2027-01-17", long)).toBe("Week 1 of 17");
    expect(periodEyebrow("week", "2027-03-15", "2027-03-21", long)).toBe("Week 10 of 17");
  });
});

describe("the month", () => {
  it("is whole weeks, Monday first, with the neighbours' days marked", () => {
    const cells = monthCells("2026-10-14");
    expect(cells).toHaveLength(35);
    expect(cells[0]).toEqual({ key: "2026-09-28", day: 28, inMonth: false });
    expect(cells[3]).toEqual({ key: "2026-10-01", day: 1, inMonth: true });
    expect(cells[34]).toEqual({ key: "2026-11-01", day: 1, inMonth: false });
  });

  it("is four rows for a February that starts on a Monday, six for a long month that starts late in the week", () => {
    expect(monthCells("2027-02-10")).toHaveLength(28);
    expect(monthCells("2026-08-15")).toHaveLength(42); // August 2026 starts on a Saturday
  });

  it("marks what is due: exams first as bars, then dots in the class colour, three at most", () => {
    const task = (id: string, name: string, dueDate: string, courseId = "", status: "pending" | "done" | "skipped" = "pending", kind?: "exam" | "quiz") =>
      ({ id, name, dueDate, courseId, status, kind });
    const marks = monthMarks(
      [
        task("1", "HW 3", "2026-10-05", "fin"),
        task("2", "Quiz 11", "2026-10-05", "fin"),
        task("3", "Midterm", "2026-10-13", "calc"),
        task("4", "Lab Report", "2026-10-14", "chem"),
        task("5", "Exam 1", "2026-10-14", "fin", "pending", "exam"),
        task("6", "Old", "2026-10-14", "fin", "done"),
        task("7", "Skipped", "2026-10-14", "fin", "skipped"),
        task("8", "A", "2026-10-26"),
        task("9", "B", "2026-10-26"),
        task("10", "C", "2026-10-26"),
        task("11", "D", "2026-10-26"),
        task("exam-runway-x", "Finance exam prep", "2026-10-14", "fin"),
      ],
      [{ id: "fin", color: "#4F6EF7" }, { id: "calc", color: "#8B6CF6" }, { id: "chem", color: "#F472B6" }],
    );
    expect(marks.get("2026-10-05")).toEqual([{ exam: false, color: "#4F6EF7" }, { exam: false, color: "#4F6EF7" }]);
    expect(marks.get("2026-10-13")).toEqual([{ exam: true, color: "#8B6CF6" }]);
    // The exam's bar comes first; finished and skipped work, and the exam prep's own study task, leave no mark.
    expect(marks.get("2026-10-14")).toEqual([{ exam: true, color: "#4F6EF7" }, { exam: false, color: "#F472B6" }]);
    expect(marks.get("2026-10-26")).toHaveLength(3);
    expect(marks.has("2026-10-06")).toBe(false);
  });

  it("counts a due date saved with a time on its own day", () => {
    const marks = monthMarks([{ id: "t", name: "Essay", dueDate: "2026-10-09T12:00:00", courseId: "", status: "pending" }], []);
    expect(marks.get("2026-10-09")).toEqual([{ exam: false, color: undefined }]);
  });

  it("an exam prep's own study task is not a deadline of its own", () => {
    expect(isDeadline({ id: "exam-runway-abc" })).toBe(false);
    expect(isDeadline({ id: "task-1" })).toBe(true);
  });

  it("opens on today, else on the first day with something due, else on the 1st", () => {
    expect(defaultMonthDay("2026-09-05", WED, () => false)).toBe(WED);
    expect(defaultMonthDay("2026-10-20", WED, (key) => key === "2026-10-13")).toBe("2026-10-13");
    expect(defaultMonthDay("2026-11-20", WED, () => false)).toBe("2026-11-01");
  });

  it("says what the term means for a day", () => {
    expect(termDayNote("2026-10-16", TERM)).toBe("No classes: Fall break");
    expect(termDayNote("2026-08-24", TERM)).toBe("First day of classes");
    expect(termDayNote("2026-12-11", TERM)).toBe("Last day of the term");
    expect(termDayNote("2026-10-14", TERM)).toBe("");
    expect(termDayNote("2026-10-14", null)).toBe("");
  });

  it("counts down to a day", () => {
    expect(countdownBadge(WED, WED)).toEqual({ label: "Today", tone: "red" });
    expect(countdownBadge("2026-10-01", WED)).toEqual({ label: "Tomorrow", tone: "red" });
    expect(countdownBadge("2026-10-02", WED)).toEqual({ label: "2 days", tone: "gold" });
    expect(countdownBadge("2026-10-14", WED)).toEqual({ label: "14 days", tone: "neutral" });
    expect(countdownBadge("2026-09-29", WED)).toBeNull();
  });
});

describe("labels on the grids", () => {
  it("writes the hours long beside three days and short beside seven", () => {
    expect([0, 8, 12, 13, 24].map((hour) => hourRailLabel(hour, false))).toEqual(["12 AM", "8 AM", "12 PM", "1 PM", "12 AM"]);
    expect([0, 8, 12, 13].map((hour) => hourRailLabel(hour, true))).toEqual(["12a", "8a", "12p", "1p"]);
  });

  it("fits a class's short name to a narrow block", () => {
    expect(narrowBlockLabel("CHEM 101", "Organic Chemistry", 2)).toBe("CHEM 101");
    expect(narrowBlockLabel("CHEM 101", "Organic Chemistry", 1)).toBe("CHEM");
    expect(narrowBlockLabel("PF", "Principles of Finance", 1)).toBe("PF");
  });

  it("shortens the first word of something with no class", () => {
    expect(narrowBlockLabel(undefined, "Work shift", 1)).toBe("WORK");
    expect(narrowBlockLabel(undefined, "Volleyball practice", 2)).toBe("VOLL");
    expect(narrowBlockLabel(undefined, "Gym", 1)).toBe("GYM");
    expect(narrowBlockLabel(undefined, "  ", 1)).toBe("");
  });

  it("never cuts a first word into something else", () => {
    expect(narrowBlockLabel(undefined, "Cocktail hour", 1)).toBe("CKTL");
    expect(narrowBlockLabel(undefined, "Assembly", 1)).toBe("ASMB");
  });

  it("names an exam-prep session by its topic", () => {
    expect(gridSessionText("Exam prep — Learn: Topic 3: Short-Term Forecasting")).toEqual({ title: "Short-Term Forecasting", sub: "Exam prep" });
    expect(gridSessionText("Exam prep — Quiz yourself: Topic 4: Working Capital Management")).toEqual({ title: "Working Capital Management", sub: "Exam prep" });
    expect(gridSessionText("Exam prep — Review: Cash budgets")).toEqual({ title: "Cash budgets", sub: "Exam prep" });
    expect(gridSessionText("Exam prep — Final review before the exam")).toEqual({ title: "Final review before the exam", sub: "Exam prep" });
  });

  it("leaves every other session's name alone", () => {
    expect(gridSessionText("Quiz 10")).toEqual({ title: "Quiz 10" });
    expect(gridSessionText("Lab Report 3 (1/2)")).toEqual({ title: "Lab Report 3 (1/2)" });
  });

  it("writes a time range without AM or PM", () => {
    expect(compactTimeRange("09:30", "10:45")).toBe("9:30–10:45");
    expect(compactTimeRange("13:00", "14:15")).toBe("1:00–2:15");
    expect(compactTimeRange("00:00", "12:00")).toBe("12:00–12:00");
  });
});
