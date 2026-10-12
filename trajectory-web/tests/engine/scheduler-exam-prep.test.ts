import { describe, expect, it } from "vitest";
import { convertToScheduleBlocks, scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { describeTopics, EXAM_RUNWAY_DAYS, examPrepLeads, normalizeTopics, planExamTopics, runwayDaysFor } from "../../src/engine/exam-prep-plan";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, GoogleCalendarEventLocal, ScheduleBlock, Task } from "../../src/engine/types";
import { addDaysToKey, daysBetweenKeys, timeToMinutes } from "../../src/engine/utils";
import { makeClass, makeTask, NOW, overlaps, schedState, TODAY } from "./scheduler-fixtures";

const DUE = addDaysToKey(TODAY, 17); // 2030-03-30: a full 14-day runway starts 2030-03-16
const exam = (overrides: Partial<Task> = {}) => makeTask({ id: "exam", name: "Exam 1", dueDate: DUE, estimatedMinutes: 240, difficulty: 4, ...overrides });
const solve = (task: Task, state = schedState()) => scheduleTasksIntelligently([task], state, undefined, undefined, { now: NOW });
const leadsOf = (result: ReturnType<typeof solve>, due = DUE) => result.scheduledBlocks.map((b) => daysBetweenKeys(b.date, due)).sort((a, b) => b - a);
const sessionsOf = (task: Task, minutes: number) => ({ ...task, estimatedMinutes: minutes });

describe("examPrepLeads: the default runway schedule", () => {
  it("matches the documented tables for a full 14-day runway", () => {
    expect(examPrepLeads(1, 14)).toEqual([2]);
    expect(examPrepLeads(2, 14)).toEqual([7, 2]);
    expect(examPrepLeads(3, 14)).toEqual([10, 5, 2]);
    expect(examPrepLeads(4, 14)).toEqual([13, 8, 4, 2]);
    expect(examPrepLeads(5, 14)).toEqual([14, 9, 5, 2, 1]);
    expect(examPrepLeads(6, 14)).toEqual([14, 10, 7, 4, 2, 1]);
    expect(examPrepLeads(0, 14)).toEqual([]);
  });

  it("property: for 1..12 sessions and 1..14 runway days, the final review is 1-2 days out, nothing is earlier than the window or on the exam day, and the order never reverses", () => {
    for (let n = 1; n <= 12; n += 1) {
      for (let runway = 1; runway <= 14; runway += 1) {
        const leads = examPrepLeads(n, runway);
        const label = `n=${n} runway=${runway} leads=${leads.join(",")}`;
        expect(leads, label).toHaveLength(n);
        for (const lead of leads) expect(lead >= 1 && lead <= runway, label).toBe(true);
        expect(leads[n - 1]! <= 2, `${label}: final review`).toBe(true);
        expect(leads[n - 1]! >= 1, label).toBe(true);
        for (let i = 1; i < n; i += 1) expect(leads[i]! <= leads[i - 1]!, `${label}: monotone`).toBe(true);
        // distinct days whenever the window has room for them
        if (runway >= n) expect(new Set(leads).size, `${label}: distinct`).toBe(n);
        // and never the whole runway crammed onto its first day
        if (n >= 2 && runway >= n) expect(leads.filter((l) => l === runway).length, label).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gaps tighten toward the exam", () => {
    for (const n of [3, 4, 5, 6, 8]) {
      const leads = examPrepLeads(n, EXAM_RUNWAY_DAYS);
      const gaps = leads.slice(1).map((lead, i) => leads[i]! - lead);
      for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]!, `n=${n} leads ${leads.join(",")}`).toBeLessThanOrEqual(gaps[i - 1]!);
    }
  });

  it("compresses into a truncated runway (exam in 4 days) and keeps the final review 2 days out", () => {
    expect(examPrepLeads(3, 4)).toEqual([4, 3, 2]);
    expect(examPrepLeads(2, 2)).toEqual([2, 1]); // two sessions, two days: distinct, and the review is still the day before
    expect(examPrepLeads(4, 4)).toEqual([4, 3, 2, 1]);
    expect(examPrepLeads(1, 1)).toEqual([1]);
  });
});

describe("lead time by task kind (bug 2026-09-24: quizzes and homework due in 1-2 weeks were all planned on the first free day)", () => {
  // TODAY is Wed 2030-03-13. The real case: Thursday held sessions for Quiz 13 (due 15 days later) and Homework 3 (11 days).
  const leadsFor = (task: Task, others: Task[] = []) => {
    const result = scheduleTasksIntelligently([task, ...others], schedState(), undefined, undefined, { now: NOW });
    return result.scheduledBlocks.filter((b) => b.taskId === task.id).map((b) => daysBetweenKeys(b.date, task.dueDate)).sort((a, b) => b - a);
  };

  it("runwayDaysFor: quizzes 4 days, readings 3, homework a week, exams and projects the full window; big jobs widen it", () => {
    expect(runwayDaysFor("quiz")).toBe(4);
    expect(runwayDaysFor("reading")).toBe(3);
    expect(runwayDaysFor("assignment")).toBe(7);
    expect(runwayDaysFor("other")).toBe(7);
    expect(runwayDaysFor("exam")).toBe(14);
    expect(runwayDaysFor("project")).toBe(14);
    expect(runwayDaysFor("assignment", 7)).toBe(11);
    expect(runwayDaysFor("quiz", 12)).toBe(14);
  });

  it("a 25-minute quiz due in 15 days is reviewed 1-2 days before it, not this week", () => {
    const quiz = makeTask({ id: "q13", name: "Quiz 13", kind: "quiz", dueDate: addDaysToKey(TODAY, 15), estimatedMinutes: 25 });
    expect(leadsFor(quiz)).toEqual([2]);
  });

  it("a 75-minute homework due in 11 days is worked on inside the week before it", () => {
    const hw = makeTask({ id: "hw3", name: "Homework 3", kind: "assignment", dueDate: addDaysToKey(TODAY, 11), estimatedMinutes: 75 });
    const leads = leadsFor(hw);
    expect(leads.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...leads)).toBeLessThanOrEqual(7);
    expect(Math.min(...leads)).toBeGreaterThanOrEqual(1);
  });

  it("a whole fortnight of quizzes and homework leaves the first days of the window free", () => {
    const tasks = [8, 9, 10, 11, 12, 13].map((n, i) => makeTask({ id: `q${n}`, name: `Quiz ${n}`, kind: "quiz", dueDate: addDaysToKey(TODAY, 4 + i * 2), estimatedMinutes: 25 }));
    tasks.push(makeTask({ id: "hw2", name: "Homework 2", kind: "assignment", dueDate: addDaysToKey(TODAY, 4), estimatedMinutes: 75 }));
    tasks.push(makeTask({ id: "hw3", name: "Homework 3", kind: "assignment", dueDate: addDaysToKey(TODAY, 11), estimatedMinutes: 75 }));
    const result = scheduleTasksIntelligently(tasks, schedState(), undefined, undefined, { now: NOW });
    const byTask = new Map(tasks.map((t) => [t.id, t]));
    for (const block of result.scheduledBlocks) {
      const task = byTask.get(block.taskId)!;
      const lead = daysBetweenKeys(block.date, task.dueDate);
      expect(lead, `${task.name} planned ${lead} days before`).toBeLessThanOrEqual(task.kind === "quiz" ? 4 : 7);
      expect(lead, `${task.name} on its due day`).toBeGreaterThanOrEqual(1);
    }
    // Today (Wed) and tomorrow only hold what is due within a few days: nothing for the far quizzes.
    const soon = result.scheduledBlocks.filter((b) => b.date <= addDaysToKey(TODAY, 1)).map((b) => b.taskId);
    expect(soon.every((id) => ["q8", "hw2", "q9"].includes(id)), `early sessions: ${soon.join(",")}`).toBe(true);
    expect(result.shortfalls).toEqual([]);
  });

  it("a big paper that did not fit at full size is filled in nearest the deadline first, never parked weeks early", () => {
    const paper = makeTask({ id: "paper", name: "Research paper", kind: "assignment", dueDate: addDaysToKey(TODAY, 20), estimatedMinutes: 12 * 60, difficulty: 4 });
    const leads = leadsFor(paper);
    expect(leads.length).toBeGreaterThanOrEqual(6);
    expect(Math.min(...leads)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...leads)).toBeLessThanOrEqual(14);
  });
});

describe("exam prep placement (bug: prep sat at the far edge, 14/13/12 days before, with no final review)", () => {
  it("spreads three sessions across the runway and puts the final review 2 days before", () => {
    const result = solve(exam());
    expect(result.shortfalls).toEqual([]);
    expect(leadsOf(result)).toEqual([10, 5, 2]);
  });

  it("four and five sessions: distinct days, gaps tighten, final review 1-2 days out, nothing on the exam day", () => {
    expect(leadsOf(solve(sessionsOf(exam(), 300)))).toEqual([13, 8, 4, 2]);
    const five = leadsOf(solve(sessionsOf(exam(), 400)));
    expect(five).toEqual([14, 9, 5, 2, 1]);
    expect(Math.min(...five)).toBeGreaterThanOrEqual(1);
  });

  it("no session is earlier than the 14-day window, none is on the exam day, and sessions are on distinct days", () => {
    for (const minutes of [90, 180, 240, 300, 420, 600]) {
      const result = solve(sessionsOf(exam(), minutes));
      const leads = leadsOf(result);
      expect(leads.length).toBeGreaterThan(0);
      expect(Math.max(...leads), `${minutes} min: ${leads}`).toBeLessThanOrEqual(14);
      expect(Math.min(...leads), `${minutes} min: ${leads}`).toBeGreaterThanOrEqual(1);
      expect(Math.min(...leads), `${minutes} min: final review`).toBeLessThanOrEqual(2);
      expect(new Set(leads).size, `${minutes} min: ${leads}`).toBe(leads.length);
      expect(leads.filter((l) => l >= 13).length, `${minutes} min: no cluster at the earliest edge`).toBeLessThanOrEqual(1);
    }
  });

  it("works when the window is truncated: an exam in 4 days", () => {
    const result = solve(exam({ dueDate: addDaysToKey(TODAY, 4) }));
    const due = addDaysToKey(TODAY, 4);
    const leads = leadsOf(result, due);
    expect(result.shortfalls).toEqual([]);
    expect(leads).toEqual([4, 3, 2]);
    expect(result.scheduledBlocks.some((b) => b.date === due)).toBe(false);
  });

  it("an exam tomorrow still gets its review today, and only uses the exam day when nothing else fits", () => {
    const easy = solve(exam({ dueDate: addDaysToKey(TODAY, 1), estimatedMinutes: 90 }));
    expect(easy.scheduledBlocks.map((b) => b.date)).toEqual([TODAY]);
    // (Changed in 1.0.8: the exam needs a due time for its own day to be usable; without one it starts the day.)
    const hard = solve(exam({ dueDate: addDaysToKey(TODAY, 1), dueTime: "18:00", estimatedMinutes: 900 }));
    expect(hard.scheduledBlocks.some((b) => b.date === addDaysToKey(TODAY, 1))).toBe(true); // last resort, not first choice
    const today = hard.scheduledBlocks.filter((b) => b.date === TODAY).length;
    expect(today).toBeGreaterThanOrEqual(3);
    const noTime = solve(exam({ dueDate: addDaysToKey(TODAY, 1), estimatedMinutes: 900 }));
    expect(noTime.scheduledBlocks.some((b) => b.date === addDaysToKey(TODAY, 1))).toBe(false);
    expect(noTime.shortfalls[0]?.missingMinutes ?? 0).toBeGreaterThan(0);
  });

  it("uses distinct days when they exist, and shares a day only when the window has fewer days than sessions", () => {
    const shortWindow = solve(exam({ dueDate: addDaysToKey(TODAY, 2), estimatedMinutes: 400 }), schedState({ userPrefs: { ...DEFAULT_USER_PREFS, studyStyle: "short_bursts" } }));
    const dates = shortWindow.scheduledBlocks.map((b) => b.date);
    expect(shortWindow.scheduledBlocks.length).toBeGreaterThan(2);
    expect(new Set(dates).size).toBeGreaterThanOrEqual(2);
    expect(dates.includes(addDaysToKey(TODAY, 1))).toBe(true);
  });

  it("the final review reads as retrieval practice; earlier sessions do not", () => {
    const blocks = solve(exam()).scheduledBlocks;
    expect(blocks.map((b) => b.isRetrievalPractice)).toEqual([false, false, true]);
  });

  it("never violates busy windows: classes, all-day events, timed events and no-go zones", () => {
    const gcal = (over: Partial<GoogleCalendarEventLocal>): GoogleCalendarEventLocal => ({
      id: Math.random().toString(36), calendarId: "primary", title: "Busy", startDate: "2030-03-20", isAllDay: false, isRecurring: false, status: "active", syncedAt: "2030-03-01T00:00:00.000Z", ...over,
    });
    // block the ideal days (leads 10, 5, 2 = Mar 20, Mar 25, Mar 28) outright and clutter the rest
    const events = [
      gcal({ isAllDay: true, startDate: "2030-03-20", endDate: "2030-03-21" }),
      gcal({ startDate: "2030-03-25", endDate: "2030-03-25", startTime: "07:00", endTime: "23:00" }),
      gcal({ isAllDay: true, startDate: "2030-03-28", endDate: "2030-03-29" }),
      gcal({ startDate: "2030-03-22", endDate: "2030-03-22", startTime: "09:00", endTime: "15:00" }),
    ];
    const cls = makeClass({ id: "chem", days: ["Mon", "Wed", "Fri"], startTime: "09:00", endTime: "12:00" });
    const state = schedState({ classes: [cls], googleCalendarEvents: events });
    const result = solve(exam(), state);
    expect(result.shortfalls).toEqual([]);
    expect(result.scheduledBlocks).toHaveLength(3);

    const busy: Array<{ date: string; startTime: string; endTime: string }> = [
      { date: "2030-03-20", startTime: "00:00", endTime: "23:59" },
      { date: "2030-03-25", startTime: "07:00", endTime: "23:00" },
      { date: "2030-03-28", startTime: "00:00", endTime: "23:59" },
      { date: "2030-03-22", startTime: "09:00", endTime: "15:00" },
    ];
    for (const block of result.scheduledBlocks) {
      for (const b of busy) expect(overlaps(block, b), `${block.date} ${block.startTime}`).toBe(false);
      const weekday = new Date(`${block.date}T12:00:00`).getDay();
      if ([1, 3, 5].includes(weekday)) expect(overlaps(block, { date: block.date, startTime: "09:00", endTime: "12:00" })).toBe(false);
      expect(timeToMinutes(block.startTime)).toBeGreaterThanOrEqual(7 * 60 + 30);
      expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(22 * 60 + 30);
      expect(block.date < DUE).toBe(true);
    }
    // the session displaced from its ideal day stays close to it
    const leads = leadsOf(result);
    expect(Math.min(...leads)).toBeLessThanOrEqual(3);
    expect(new Set(leads).size).toBe(3);
  });

  it("respects the daily load cap and a bedtime after midnight", () => {
    const result = solve(sessionsOf(exam(), 900), schedState({ healthPrefs: { ...DEFAULT_HEALTH_PREFS, wakeTime: "08:00", bedtime: "01:00" }, userPrefs: { ...DEFAULT_USER_PREFS, noGoZones: [] } }));
    const perDay = new Map<string, number>();
    for (const b of result.scheduledBlocks) perDay.set(b.date, (perDay.get(b.date) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(4);
    for (const b of result.scheduledBlocks) expect(timeToMinutes(b.endTime)).toBeGreaterThan(timeToMinutes(b.startTime));
  });

  it("honours a strategist's targetDaysBeforeDue (it does not get the default schedule)", () => {
    const task = exam({
      estimatedMinutes: 150,
      planningStrategy: {
        rationale: "Staged.", priority: 4,
        sessions: [
          { label: "Learn Topics 1-2", purpose: "learn", minutes: 60, targetDaysBeforeDue: 11, earliestDaysBeforeDue: 12 },
          { label: "Learn Topics 3-4", purpose: "learn", minutes: 60, targetDaysBeforeDue: 6, earliestDaysBeforeDue: 7 },
          { label: "Final check", purpose: "practice", minutes: 30, targetDaysBeforeDue: 1, earliestDaysBeforeDue: 2 },
        ],
      },
    });
    const result = solve(task);
    expect(leadsOf(result)).toEqual([11, 6, 1]);
    expect(result.scheduledBlocks.map((b) => b.strategyLabel)).toEqual(["Learn Topics 1-2", "Learn Topics 3-4", "Final check"]);
  });

  it("honours a strategist's earliestDaysBeforeDue when the target day is busy, and never plans a named step on the exam day by choice", () => {
    const events: GoogleCalendarEventLocal[] = ["2030-03-25", "2030-03-24"].map((date) => ({
      id: date, calendarId: "primary", title: "Away", startDate: date, endDate: addDaysToKey(date, 1), isAllDay: true, isRecurring: false, status: "active" as const, syncedAt: "2030-03-01T00:00:00.000Z",
    }));
    const task = exam({
      estimatedMinutes: 60,
      planningStrategy: {
        rationale: "One step.", priority: 3,
        sessions: [{ label: "Learn", purpose: "learn", minutes: 60, targetDaysBeforeDue: 5, earliestDaysBeforeDue: 6 }],
      },
    });
    const lead = daysBetweenKeys(solve(task, schedState({ googleCalendarEvents: events })).scheduledBlocks[0]!.date, DUE);
    // leads 5 and 6 are away days; the step may not be moved earlier than 6 days out, so it lands after them
    expect(lead).toBeLessThanOrEqual(4);
    expect(lead).toBeGreaterThanOrEqual(1);
  });

  it("other task kinds keep their placement (the runway schedule is for exams only)", () => {
    const hw = makeTask({ id: "hw", name: "Excel homework", dueDate: DUE, estimatedMinutes: 75 });
    const result = solve(hw);
    expect(leadsOf(result).length).toBeGreaterThan(0);
    const quiz = solve(makeTask({ id: "quiz", name: "Quiz 3", dueDate: DUE, estimatedMinutes: 25 }));
    expect(quiz.shortfalls).toEqual([]);
  });
});

describe("exam topic labels (Task.coversTopics)", () => {
  const four = ["Topic 1: Financial Statements", "Topic 2: Financial Statement Analysis", "Topic 3: Short-Term Forecasting", "Topic 4: Working Capital Management"];
  const titles = (task: Task) => convertToScheduleBlocks(solve(task).scheduledBlocks).map((b) => b.title);

  it("names the topics each session covers and ends with a final review of everything", () => {
    expect(titles(exam({ coversTopics: four }))).toEqual([
      "Exam 1 prep: Topics 1-2",
      "Exam 1 prep: Topics 3-4",
      "Exam 1 final review: all topics",
    ]);
  });

  it("carries the topics into the reason and the definition of done", () => {
    const blocks = convertToScheduleBlocks(solve(exam({ coversTopics: four })).scheduledBlocks);
    expect(blocks[0]!.schedulingReason).toMatch(/^Covers Topics 1-2\./);
    expect(blocks[0]!.whatCountsAsDone).toMatch(/^Topics 1-2: /);
    expect(blocks[2]!.schedulingReason).toMatch(/^Final review of all topics\./);
    expect(blocks[2]!.whatCountsAsDone).toMatch(/^Final review of all topics\. /);
    expect(blocks[2]!.whatCountsAsDone).toMatch(/Do NOT re-read/); // the retrieval-practice instructions stay
  });

  it("distributes five topics over two prep sessions in order, and a short topic list gets one topic per session", () => {
    const five = ["Topic 5: Time Value of Money", "Topic 6: Interest Rates", "Topic 7: Bonds", "Topic 8: Stocks", "Topic 9: Cost of Capital"];
    expect(titles(exam({ name: "Exam 2", coversTopics: five }))).toEqual(["Exam 2 prep: Topics 5-6", "Exam 2 prep: Topics 7-9", "Exam 2 final review: all topics"]);
    expect(titles(exam({ name: "Final", estimatedMinutes: 300, coversTopics: ["Topic 9: Cost of Capital", "Topic 10: Capital Budgeting"] }))).toEqual([
      "Final prep: Topic 9",
      "Final prep: Topic 10",
      "Final prep: mixed practice, all topics",
      "Final final review: all topics",
    ]);
  });

  it("a single-session exam is just the final review", () => {
    expect(titles(exam({ estimatedMinutes: 60, coversTopics: four }))).toEqual(["Exam 1 final review: all topics"]);
  });

  it("without topics, and for quizzes and homework, titles stay simple", () => {
    expect(titles(exam())).toEqual(["Review: Exam 1 (1/3)", "Review: Exam 1 (2/3)", "Practice Test: Exam 1 (3/3)"]);
    expect(titles(makeTask({ name: "Quiz 3", dueDate: DUE, estimatedMinutes: 25, coversTopics: four }))).toEqual(["Review: Quiz 3"]); // topics never rename quiz sessions
    expect(titles(makeTask({ name: "HW 2 (Excel)", dueDate: DUE, estimatedMinutes: 75, coversTopics: four }))[0]).toBe("Work on: HW 2 (Excel)");
  });

  it("describeTopics / normalizeTopics / planExamTopics", () => {
    expect(describeTopics(["Topic 1: A", "Topic 2: B"])).toBe("Topics 1-2");
    expect(describeTopics(["Topic 9: Cost"])).toBe("Topic 9");
    expect(describeTopics(["Topic 1: A", "Topic 3: C", "Topic 4: D"])).toBe("Topics 1, 3-4");
    expect(describeTopics(["Chapter 3", "Chapter 4"])).toBe("Chapters 3-4");
    expect(describeTopics(["Alkanes", "Stereochemistry"])).toBe("Alkanes, Stereochemistry");
    expect(describeTopics(["Topic 1: A", "Ancient empires"])).toBe("A, Ancient empires");
    expect(describeTopics([])).toBe("");
    expect(describeTopics(["x".repeat(90)]).length).toBeLessThanOrEqual(60);
    expect(normalizeTopics("Topics 1-4")).toEqual(["Topics 1-4"]);
    expect(normalizeTopics("A; B\nC")).toEqual(["A", "B", "C"]);
    expect(normalizeTopics(undefined)).toEqual([]);
    expect(planExamTopics([], 3)).toEqual([{ label: null, isFinalReview: false }, { label: null, isFinalReview: false }, { label: null, isFinalReview: true }]);
    expect(planExamTopics(["Topic 1", "Topic 2"], 1)).toEqual([{ label: null, isFinalReview: true }]);
    expect(planExamTopics([], 0)).toEqual([]);
  });

  it("a strategist's own labels are kept (they already name the topics)", () => {
    const task = exam({
      estimatedMinutes: 90, coversTopics: four,
      planningStrategy: { rationale: "r", priority: 3, sessions: [{ label: "Learn Topics 1-4", purpose: "learn", minutes: 90, targetDaysBeforeDue: 5, earliestDaysBeforeDue: 6 }] },
    });
    expect(titles(task)).toEqual(["Study: Exam 1 — Learn Topics 1-4"]);
  });
});

describe("dueTime: nothing is planned after it on the due date (through buildSemesterPlan)", () => {
  const state = (tasks: Task[]) => ({
    classes: [makeClass({ id: "chem", days: ["Mon", "Wed", "Fri"], startTime: "13:00", endTime: "13:50" })],
    recurringEvents: [],
    tasks,
    scheduleBlocks: [] as ScheduleBlock[],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: { ...DEFAULT_USER_PREFS, noGoZones: [] },
  });
  const studyFor = (plan: ReturnType<typeof buildSemesterPlan>, id: string) => plan.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === id);

  it("a final exam due by noon gets no prep on its due date after 12:00 (and by choice none at all)", () => {
    const final = exam({ id: "final", name: "Final Exam", dueDate: "2030-03-26", dueTime: "12:00", estimatedMinutes: 300, coversTopics: ["Topic 9: Cost of Capital", "Topic 10: Capital Budgeting"] });
    const plan = buildSemesterPlan(state([final]), { now: NOW });
    const blocks = studyFor(plan, "final");
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.date <= "2030-03-26").toBe(true);
      if (b.date === "2030-03-26") expect(timeToMinutes(b.endTime)).toBeLessThanOrEqual(12 * 60);
    }
    expect(blocks.some((b) => b.date === "2030-03-26")).toBe(false);
    expect(blocks.map((b) => b.title).at(-1)).toBe("Final Exam final review: all topics");
    expect(plan.shortfalls).toEqual([]);
  });

  it("when the runway is too short the exam day is used, but only before the due time", () => {
    const tight = exam({ id: "tight", dueDate: addDaysToKey(TODAY, 1), dueTime: "10:00", estimatedMinutes: 900 });
    const plan = buildSemesterPlan(state([tight]), { now: NOW });
    const blocks = studyFor(plan, "tight");
    const dueDay = blocks.filter((b) => b.date === addDaysToKey(TODAY, 1));
    expect(dueDay.length, "the exam morning is the last resort here").toBeGreaterThan(0);
    for (const b of dueDay) {
      expect(timeToMinutes(b.startTime)).toBeGreaterThanOrEqual(7 * 60 + 30);
      expect(timeToMinutes(b.endTime), `${b.startTime}-${b.endTime}`).toBeLessThanOrEqual(10 * 60);
    }
    expect(blocks.every((b) => b.date <= addDaysToKey(TODAY, 1))).toBe(true);
    // what does not fit before 10:00 is reported, not squeezed past the deadline
    const placed = blocks.reduce((sum, b) => sum + timeToMinutes(b.endTime) - timeToMinutes(b.startTime), 0);
    const missing = plan.shortfalls.find((s) => s.taskId === "tight")?.missingMinutes ?? 0;
    expect(placed + missing).toBe(900);
  });

  // (Changed in 1.0.8: this used an EXAM without a due time, which was the bug - prep after the exam had happened.)
  it("homework without a due time may use the whole due date", () => {
    const open = makeTask({ id: "open", name: "Problem set 4", kind: "assignment", dueDate: addDaysToKey(TODAY, 1), estimatedMinutes: 900 });
    const plan = buildSemesterPlan(state([open]), { now: NOW });
    const dueDay = studyFor(plan, "open").filter((b) => b.date === addDaysToKey(TODAY, 1));
    expect(dueDay.some((b) => timeToMinutes(b.endTime) > 10 * 60)).toBe(true);
  });

  it("a quiz / exam without a due time happens in class: prep stops at the class start that day, or the day before when the course does not meet", () => {
    const due = addDaysToKey(TODAY, 2); // Fri 2030-03-15: Chemistry meets 10:00-11:00
    const quiz = makeTask({ id: "quiz", name: "Quiz 3", kind: "quiz", courseId: "chem", dueDate: due, estimatedMinutes: 600 });
    const plan = buildSemesterPlan({ ...state([quiz]), classes: [makeClass()] }, { now: NOW });
    const blocks = studyFor(plan, "quiz");
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.date <= due).toBe(true);
      if (b.date === due) expect(timeToMinutes(b.endTime), `${b.startTime}-${b.endTime}`).toBeLessThanOrEqual(10 * 60);
    }

    const offDay = makeTask({ id: "exam-off", name: "Exam 2", kind: "exam", courseId: "chem", dueDate: addDaysToKey(TODAY, 3), estimatedMinutes: 900 }); // Sat
    const plan2 = buildSemesterPlan({ ...state([offDay]), classes: [makeClass()] }, { now: NOW });
    expect(studyFor(plan2, "exam-off").some((b) => b.date === addDaysToKey(TODAY, 3))).toBe(false);
    const placed = studyFor(plan2, "exam-off").reduce((sum, b) => sum + timeToMinutes(b.endTime) - timeToMinutes(b.startTime), 0);
    expect(placed + (plan2.shortfalls.find((s) => s.taskId === "exam-off")?.missingMinutes ?? 0)).toBe(900);
  });

  it("the field is Task.dueTime, the same one the syllabus import and the exam runway write", () => {
    const withTime = exam({ dueTime: "12:00" });
    expect(withTime.dueTime).toBe("12:00");
  });
});
