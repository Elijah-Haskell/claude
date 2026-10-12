import { describe, expect, it } from "vitest";
import { daySessions, weekStripDays } from "../../src/engine/day-strip";
import { sessionDisplayTitle } from "../../src/engine/week-layout";

// Today's week strip and the label over the day's list (app/(tabs)/index.tsx).
describe("weekStripDays: the week as seven dates, Monday first", () => {
  const WED = "2026-09-30";

  it("holds the week of the given day, across a month boundary", () => {
    const days = weekStripDays(WED, []);
    expect(days.map((d) => d.key)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(days.map((d) => d.letter).join("")).toBe("MTWTFSS");
    expect(days.map((d) => d.dayOfMonth)).toEqual([28, 29, 30, 1, 2, 3, 4]);
  });

  it("marks today and the days gone by", () => {
    const days = weekStripDays(WED, []);
    expect(days.filter((d) => d.isToday).map((d) => d.key)).toEqual([WED]);
    expect(days.filter((d) => d.isPast).map((d) => d.key)).toEqual(["2026-09-28", "2026-09-29"]);
  });

  it("a Sunday belongs to the week that started the Monday before", () => {
    const days = weekStripDays("2026-10-04", []);
    expect(days[0]!.key).toBe("2026-09-28");
    expect(days[6]!.isToday).toBe(true);
  });

  it("counts open deadlines per day: done and skipped work is not due any more", () => {
    const days = weekStripDays(WED, [
      { dueDate: "2026-10-02", status: "pending" },
      { dueDate: "2026-10-02", status: "scheduled" },
      { dueDate: "2026-10-02", status: "done" },
      { dueDate: "2026-10-01", status: "skipped" },
      { dueDate: "2026-10-09", status: "pending" },
    ]);
    expect(days.map((d) => d.dueCount)).toEqual([0, 0, 0, 0, 2, 0, 0]);
  });

  it("says each day in words for a screen reader", () => {
    const days = weekStripDays(WED, [{ dueDate: WED, status: "pending" }]);
    expect(days[2]!.label).toBe("Wednesday, September 30, today, 1 due");
    expect(days[3]!.label).toBe("Thursday, October 1");
  });
});

describe("daySessions: the label over the day's list", () => {
  const session = (startTime: string, endTime: string, completionStatus: "pending" | "done" | "skipped" | "missed" = "pending") =>
    ({ type: "study" as const, startTime, endTime, completionStatus });
  const klass = { type: "class" as const, startTime: "10:00", endTime: "10:50", completionStatus: "pending" as const };

  it("counts study sessions only, with the time they add up to", () => {
    expect(daySessions([session("09:00", "09:25"), klass, session("11:30", "12:30"), session("16:00", "17:15")])).toEqual({
      total: 3,
      done: 0,
      remainingMinutes: 160,
      label: "3 sessions · 2h 40m",
    });
    expect(daySessions([session("09:00", "09:25")]).label).toBe("1 session · 25m");
  });

  it("says how far along the day is once something is ticked", () => {
    const part = daySessions([session("09:00", "09:25", "done"), session("11:30", "12:30"), session("16:00", "17:15")]);
    expect(part).toMatchObject({ total: 3, done: 1, remainingMinutes: 135, label: "1 of 3 done · 2h 15m left" });
    const all = daySessions([session("09:00", "09:25", "done"), session("11:30", "12:30", "done")]);
    expect(all).toMatchObject({ total: 2, done: 2, remainingMinutes: 0, label: "2 of 2 sessions done" });
    expect(daySessions([session("09:00", "09:25", "done")]).label).toBe("1 of 1 session done");
  });

  it("a skipped session no longer counts; a missed one still does", () => {
    expect(daySessions([session("09:00", "09:25", "skipped"), session("11:30", "12:30", "missed")])).toMatchObject({ total: 1, done: 0, remainingMinutes: 60 });
  });

  it("a day of classes only has no study sessions", () => {
    expect(daySessions([klass])).toEqual({ total: 0, done: 0, remainingMinutes: 0, label: "No study sessions" });
    expect(daySessions([]).label).toBe("No study sessions");
  });
});

describe("sessionDisplayTitle: a session's name beside its class tag", () => {
  it("drops the generated verb prefix and a leading class name", () => {
    expect(sessionDisplayTitle("Study: Principles of Finance exam prep — Learn: Topic 3: Short-Term Forecasting", "Principles of Finance")).toBe("Exam prep — Learn: Topic 3: Short-Term Forecasting");
    expect(sessionDisplayTitle("Review: Quiz 10", "Principles of Finance")).toBe("Quiz 10");
    expect(sessionDisplayTitle("Work on: Calculus II: Problem Set 6", "Calculus II")).toBe("Problem Set 6");
    expect(sessionDisplayTitle("organic chemistry - lab report 3", "Organic Chemistry")).toBe("Lab report 3");
  });

  it("leaves a title alone when the class name is not at its start, is all of it, or is unknown", () => {
    expect(sessionDisplayTitle("Study: Midterm for Calculus II", "Calculus II")).toBe("Midterm for Calculus II");
    expect(sessionDisplayTitle("Calculus II", "Calculus II")).toBe("Calculus II");
    expect(sessionDisplayTitle("Study: Essay draft")).toBe("Essay draft");
    expect(sessionDisplayTitle("Study: General reading", "General")).toBe("General reading");
  });
});
