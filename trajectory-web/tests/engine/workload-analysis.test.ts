import { describe, expect, it } from "vitest";
import { getSemesterWorkloadWarnings, overloadedDaysAhead, realityCheckFor, studyLoadCaps } from "../../src/engine/workload-analysis";
import { DEFAULT_HEALTH_PREFS, ScheduleBlock, Task } from "../../src/engine/types";
function task(overrides: Partial<Task>): Task { return { id: Math.random().toString(), name: "Assignment", courseId: "course", courseName: "Course", dueDate: "2030-03-15", estimatedMinutes: 60, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2030-03-01T00:00:00.000Z", ...overrides }; }
describe("semester workload warnings", () => {
  it("flags a high-risk cluster of estimated work due in one week", () => {
    const warnings = getSemesterWorkloadWarnings([task({ id: "a", estimatedMinutes: 360, difficulty: 5 }), task({ id: "b", estimatedMinutes: 330, difficulty: 4, dueDate: "2030-03-16" }), task({ id: "c", estimatedMinutes: 240, difficulty: 3, dueDate: "2030-03-17" })], 50, new Date("2030-03-10T12:00:00"));
    expect(warnings).toHaveLength(1); expect(warnings[0].severity).toBe("high"); expect(warnings[0].weekStart).toBe("2030-03-11");
    expect(warnings[0].message).toContain("the week of Mar 11"); // never the raw "2030-03-11" key
  });
  it("does not flag balanced or already completed workload", () => {
    const warnings = getSemesterWorkloadWarnings([task({ id: "done", estimatedMinutes: 1200, status: "done" }), task({ id: "balanced", estimatedMinutes: 120, dueDate: "2030-03-15" })], 50, new Date("2030-03-10T12:00:00"));
    expect(warnings).toEqual([]);
  });
});

describe("study-load caps", () => {
  it("follow the schedule-intensity slider by default (balanced: 5 h a day, 16.5 h a week, 3 h daily target)", () => {
    expect(studyLoadCaps({ scheduleIntensity: 50 })).toEqual({ dailyTargetMinutes: 180, dailyMinutes: 300, weeklyMinutes: 990 });
    expect(studyLoadCaps({ scheduleIntensity: 0 })).toEqual({ dailyTargetMinutes: 108, dailyMinutes: 180, weeklyMinutes: 540 });
    expect(studyLoadCaps({ scheduleIntensity: 100 })).toEqual({ dailyTargetMinutes: 252, dailyMinutes: 420, weeklyMinutes: 1440 });
    expect(studyLoadCaps(undefined)).toEqual(studyLoadCaps({ scheduleIntensity: 50 }));
  });
  it("explicit minute settings win", () => {
    expect(studyLoadCaps({ scheduleIntensity: 50, dailyStudyCapMinutes: 240, weeklyStudyCapMinutes: 600 })).toEqual({ dailyTargetMinutes: 144, dailyMinutes: 240, weeklyMinutes: 600 });
  });
});

describe("realityCheckFor (Today's workload card)", () => {
  const day = "2030-03-11";
  const block = (id: string, startTime: string, endTime: string, type: ScheduleBlock["type"] = "study", extra: Partial<ScheduleBlock> = {}): ScheduleBlock =>
    ({ id, type, title: id, date: day, startTime, endTime, locked: false, accepted: true, color: "#000", completionStatus: "pending", ...extra });
  const heavyDay = () => [block("s1", "08:00", "12:00"), block("s2", "13:00", "17:00"), block("s3", "18:00", "20:00")];

  it("stays hidden (null) on a comfortable day and on an empty one", () => {
    expect(realityCheckFor([], DEFAULT_HEALTH_PREFS, day)).toBeNull();
    expect(realityCheckFor([block("a", "10:00", "12:00")], DEFAULT_HEALTH_PREFS, day)).toBeNull();
  });

  it("is continuous in the booked share of the day, and explains itself", () => {
    const values: number[] = [];
    for (const end of ["19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00"]) {
      const check = realityCheckFor([block("class", "08:00", "12:00", "class"), block("s", "12:15", end)], DEFAULT_HEALTH_PREFS, day, { showAll: true })!;
      values.push(check.doablePercent);
      expect(check).toMatchObject({ availableMinutes: 16 * 60 });
      expect(check.reason.length).toBeGreaterThan(0);
    }
    for (let i = 1; i < values.length; i += 1) expect(values[i]!).toBeLessThan(values[i - 1]!);
    expect(new Set(values).size).toBe(values.length);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(5);
  });

  it("penalises study over the daily cap and says so", () => {
    const heavy = realityCheckFor(heavyDay(), DEFAULT_HEALTH_PREFS, day, { showAll: true })!;
    expect(heavy.reason).toBe("10 h of study today is over your 5 h daily cap.");
    expect(heavy.doablePercent).toBeLessThan(78);
  });

  it("sessions moved to tomorrow (skipped), missed or finished stop counting at once (was: still '7.3 h … over your cap' after Apply)", () => {
    expect(realityCheckFor(heavyDay(), DEFAULT_HEALTH_PREFS, day)).not.toBeNull();
    const [s1, s2, s3] = heavyDay();
    const moved = [s1!, { ...s2!, completionStatus: "skipped" as const, deferredDay: true }, { ...s3!, completionStatus: "skipped" as const, deferredDay: true }];
    expect(realityCheckFor(moved, DEFAULT_HEALTH_PREFS, day)).toBeNull();
    expect(realityCheckFor([{ ...s1!, completionStatus: "done" }, { ...s2!, completionStatus: "missed" }, s3!], DEFAULT_HEALTH_PREFS, day)).toBeNull();
  });

  it("with a clock, only what is still ahead counts, against the awake time left before bed", () => {
    // 13:30: s1 is over, s2 has 3.5 h left, s3 2 h, and 9.5 h remain before 23:00.
    const check = realityCheckFor(heavyDay(), DEFAULT_HEALTH_PREFS, day, { nowMinutes: 13 * 60 + 30, showAll: true })!;
    expect(check).toMatchObject({ studyMinutes: 330, totalMinutes: 330, availableMinutes: 570 });
    expect(check.reason).toBe("5.5 h of study left today is over your 5 h daily cap.");
    // Late in the evening the same hour of study leaves no slack: the day is flagged although it is "only" 1 h.
    expect(realityCheckFor([block("late", "22:00", "23:00")], DEFAULT_HEALTH_PREFS, day, { nowMinutes: 22 * 60 })?.reason).toBe("1 h of the 1 h left before bed is booked.");
    // Before wake-up the whole day counts.
    expect(realityCheckFor(heavyDay(), DEFAULT_HEALTH_PREFS, day, { nowMinutes: 6 * 60, showAll: true })?.availableMinutes).toBe(16 * 60);
  });

  describe("'Move N to tomorrow' suggests only the excess", () => {
    const tasks = [
      task({ id: "dueToday", dueDate: day }),
      task({ id: "later", dueDate: "2030-03-21" }),
      task({ id: "soon", dueDate: "2030-03-14" }),
      task({ id: "pinned", dueDate: "2030-03-21" }),
    ];
    const plan = [
      block("a", "08:00", "10:00", "study", { taskId: "dueToday" }),
      block("b", "10:00", "12:00", "study", { taskId: "later" }),
      block("c", "13:00", "15:00", "study", { taskId: "soon" }),
      block("d", "15:00", "16:30", "study", { taskId: "pinned", locked: true }),
    ]; // 7.5 h of study, cap 5 h

    it("latest deadline first, until the day is back under the cap; never work due today, never a locked session", () => {
      const check = realityCheckFor(plan, DEFAULT_HEALTH_PREFS, day, { tasks })!;
      expect(check.moveBlockIds).toEqual(["b", "c"]);
      expect(check.movableCount).toBe(2);
      expect(check.moveFixesDay).toBe(true);
    });

    it("with a higher cap one session is enough (was: every pending session of the day)", () => {
      const check = realityCheckFor(plan, DEFAULT_HEALTH_PREFS, day, { tasks, userPrefs: { dailyStudyCapMinutes: 360 }, showAll: true })!;
      expect(check.moveBlockIds).toEqual(["b"]);
    });

    it("leaves out sessions already under way or started, and says when moving all it can is not enough", () => {
      const started = plan.map((b) => (b.id === "b" ? { ...b, startedAt: "2030-03-11T10:00:00.000Z" } : b));
      const check = realityCheckFor(started, DEFAULT_HEALTH_PREFS, day, { tasks })!;
      expect(check.moveBlockIds).toEqual(["c"]);
      expect(check.moveFixesDay).toBe(false); // 5.5 h left: still over the cap
      // At 10:30 "b" is under way (it keeps counting, but is not offered) and the morning is over: 5 h left, not flagged.
      expect(realityCheckFor(plan, DEFAULT_HEALTH_PREFS, day, { tasks, nowMinutes: 10 * 60 + 30 })).toBeNull();
    });

    it("suggests nothing without the tasks (their deadlines decide what can wait)", () => {
      expect(realityCheckFor(plan, DEFAULT_HEALTH_PREFS, day)?.moveBlockIds).toEqual([]);
    });
  });
});

describe("overloadedDaysAhead (the upcoming-day line in the same card)", () => {
  const study = (id: string, date: string, startTime: string, endTime: string, completionStatus: ScheduleBlock["completionStatus"] = "pending"): ScheduleBlock =>
    ({ id, type: "study", title: id, date, startTime, endTime, locked: false, accepted: true, color: "#000", completionStatus });

  it("lists the next 7 days whose open study is over the daily cap (not today, not moved or finished sessions)", () => {
    const blocks = [
      study("today", "2030-03-11", "08:00", "14:00"), // today: the card's own check
      study("tue", "2030-03-12", "08:00", "14:00"), // 6 h: over
      study("wed1", "2030-03-13", "08:00", "12:00"), study("wed2", "2030-03-13", "13:00", "16:00", "skipped"), // 4 h open
      study("thu", "2030-03-14", "08:00", "14:00", "done"),
      study("sat", "2030-03-16", "08:00", "11:00"), study("sat2", "2030-03-16", "12:00", "15:00"), // 6 h: over
      study("far", "2030-03-19", "08:00", "14:00"), // 8 days out
    ];
    expect(overloadedDaysAhead(blocks, "2030-03-11")).toEqual([
      { date: "2030-03-12", studyMinutes: 360, capMinutes: 300 },
      { date: "2030-03-16", studyMinutes: 360, capMinutes: 300 },
    ]);
    expect(overloadedDaysAhead(blocks, "2030-03-11", { userPrefs: { dailyStudyCapMinutes: 420 } })).toEqual([]);
  });
});
