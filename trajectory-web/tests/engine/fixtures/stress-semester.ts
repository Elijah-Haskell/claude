/**
 * Two whole-semester planning fixtures and the plan metrics the audit (deliverables/TRAJECTORY-DIAGNOSTIC.md) reports:
 *  - the REAL FINC-3100 schedule (tests/fixtures/finc3100-schedule.ts) as the syllabus import creates it: 30 quizzes (25 min),
 *    10 Excel homeworks (75 min), 3 exams (240 / 240 / 300 min, the final due by 12:00), class MWF 10:00-10:50, no due times;
 *  - a synthetic heavy 5-course semester (~280 h of work, midterms clustered in weeks 7-8, finals in one week).
 * Not a test file itself.
 */
import type { AppState, ClassBlock, DayOfWeek, ScheduleBlock, Semester, Task, TaskKind } from "../../../src/engine/types";
import { DEFAULT_HEALTH_PREFS, DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_USER_PREFS } from "../../../src/engine/types";
import { addDaysToKey, daysBetweenKeys, timeToMinutes, weekStartKeyOf, weekdayOfKey } from "../../../src/engine/utils";
import { FINC3100_ROWS } from "./finc3100-schedule";

export const FINC_NOW = new Date(2026, 7, 24, 9, 0, 0); // Mon 24 Aug 2026, the Monday before the first class
export const STRESS_NOW = new Date(2026, 7, 24, 9, 0, 0);

export function emptyState(overrides: Partial<AppState> = {}): AppState {
  return {
    onboardingComplete: true,
    classes: [],
    recurringEvents: [],
    tasks: [],
    scheduleBlocks: [],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
    grades: [],
    recommendations: [],
    examPreps: [],
    studyGuides: [],
    practiceExams: [],
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    syllabusImports: [],
    googleCalendarEvents: [],
    googleCalendarConnected: false,
    ...overrides,
  };
}

const EXAM_TOPICS: Record<number, string[]> = {
  1: ["Topic 1: Financial Statements", "Topic 2: Financial Statement Analysis", "Topic 3: Short-Term Forecasting", "Topic 4: Working Capital Management"],
  2: ["Topic 5: Time Value of Money", "Topic 6: Interest Rates", "Topic 7: Bonds and Bond Pricing", "Topic 8: Stock Valuation", "Topic 9: Cost of Capital"],
  3: ["Topic 9: Cost of Capital", "Topic 10: Capital Budgeting"],
};

function task(id: string, name: string, courseId: string, courseName: string, dueDate: string, kind: TaskKind, estimatedMinutes: number, difficulty: Task["difficulty"], extra: Partial<Task> = {}): Task {
  return { id, name, courseId, courseName, dueDate, kind, estimatedMinutes, difficulty, requiresOnCampus: false, status: "pending", createdAt: "2026-08-20T12:00:00.000Z", ...extra };
}

/** FINC-3100 imported into an empty app: one class, the Fall 2026 semester with its breaks, 43 tasks. */
export function fincState(): AppState {
  const cls: ClassBlock = { id: "class-finc", name: "Principles of Finance", days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "10:50", color: "#4F6EF7" };
  const semester: Semester = {
    id: "sem-fall-2026", name: "Fall 2026", startDate: "2026-08-26", endDate: "2026-12-15",
    breaks: [
      { name: "Fall Break", startDate: "2026-10-16", endDate: "2026-10-16" },
      { name: "Thanksgiving Break", startDate: "2026-11-25", endDate: "2026-11-27" },
      { name: "Exam period", startDate: "2026-12-08", endDate: "2026-12-15" },
      { name: "Study Day", startDate: "2026-12-09", endDate: "2026-12-09" },
    ],
  };
  const tasks: Task[] = [];
  for (const row of FINC3100_ROWS) {
    if (row.quiz) tasks.push(task(`finc-q${row.quiz}`, `Quiz ${row.quiz}`, cls.id, cls.name, row.date, "quiz", 25, 2));
    if (row.hw) tasks.push(task(`finc-hw${row.hw}`, `HW ${row.hw} (Excel)`, cls.id, cls.name, row.date, "assignment", 75, 3));
    if (row.exam) {
      const final = row.exam === 3;
      tasks.push(task(`finc-exam${row.exam}`, final ? "Final Exam (Exam 3)" : `Exam ${row.exam}`, cls.id, cls.name, row.date, "exam", final ? 300 : 240, final ? 5 : 4, {
        coversTopics: EXAM_TOPICS[row.exam], ...(final ? { dueTime: "12:00" } : {}),
      }));
    }
  }
  return emptyState({ classes: [cls], semester, tasks });
}

const COURSES: Array<{ id: string; name: string; days: DayOfWeek[]; start: string; end: string }> = [
  { id: "calc", name: "Calculus II", days: ["Mon", "Wed", "Fri"], start: "09:00", end: "09:50" },
  { id: "chem", name: "Organic Chemistry", days: ["Tue", "Thu"], start: "11:00", end: "12:15" },
  { id: "hist", name: "World History", days: ["Mon", "Wed", "Fri"], start: "13:00", end: "13:50" },
  { id: "econ", name: "Microeconomics", days: ["Tue", "Thu"], start: "14:00", end: "15:15" },
  { id: "writ", name: "Academic Writing", days: ["Mon", "Wed"], start: "16:00", end: "17:15" },
];

/**
 * A heavy synthetic 5-course semester (Mon 24 Aug to Fri 11 Dec 2026, Thanksgiving off): per course a weekly homework
 * (90 min), a quiz every other week (30 min, no due time), two midterms in weeks 7-8 and 12 (300 min), a paper or
 * project (600 min) and a final (420 min) in the last week. About 280 hours of work in all.
 */
export function fiveCourseState(): AppState {
  const semester: Semester = {
    id: "sem-stress", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11",
    breaks: [{ name: "Thanksgiving Break", startDate: "2026-11-25", endDate: "2026-11-27" }],
  };
  const colors = ["#4F6EF7", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981"];
  const classes: ClassBlock[] = COURSES.map((c, i) => ({ id: c.id, name: c.name, days: c.days, startTime: c.start, endTime: c.end, color: colors[i]! }));
  const tasks: Task[] = [];
  const firstMonday = "2026-08-24";
  const classDayIn = (course: (typeof COURSES)[number], week: number, which: "first" | "last") => {
    const days = Array.from({ length: 5 }, (_, d) => addDaysToKey(firstMonday, week * 7 + d)).filter((date) => course.days.includes(weekdayOfKey(date)));
    return which === "first" ? days[0]! : days[days.length - 1]!;
  };
  COURSES.forEach((course, ci) => {
    for (let week = 1; week < 15; week += 1) {
      if (week === 13) continue; // Thanksgiving week
      tasks.push(task(`${course.id}-hw${week}`, `Problem set ${week}`, course.id, course.name, classDayIn(course, week, "last"), "assignment", 90, 3));
      if (week % 2 === ci % 2) tasks.push(task(`${course.id}-quiz${week}`, `Quiz ${week}`, course.id, course.name, classDayIn(course, week, "first"), "quiz", 30, 2));
    }
    tasks.push(task(`${course.id}-mid1`, "Midterm 1", course.id, course.name, classDayIn(course, 6 + (ci % 2), "first"), "exam", 300, 4));
    tasks.push(task(`${course.id}-mid2`, "Midterm 2", course.id, course.name, classDayIn(course, 11, "first"), "exam", 300, 4));
    tasks.push(task(`${course.id}-proj`, ci % 2 === 0 ? "Term project" : "Research paper", course.id, course.name, classDayIn(course, 10 + (ci % 3), "last"), ci % 2 === 0 ? "project" : "assignment", 600, 4));
    tasks.push(task(`${course.id}-final`, "Final exam", course.id, course.name, addDaysToKey("2026-12-07", ci % 5), "exam", 420, 5, { dueTime: `${String(9 + (ci % 3) * 2).padStart(2, "0")}:00` }));
  });
  return emptyState({ classes, semester, tasks });
}

// ── Metrics ───────────────────────────────────────────────────

export interface PlanMetrics {
  studyMinutes: number;
  sessions: number;
  weeklyHoursMin: number;
  weeklyHoursMax: number;
  maxHoursPerDay: number;
  daysOver5h: number;
  /** Sessions after their task's deadline (date after the due date, or on it past the due time / the class start of a time-less deadline). */
  lateSessions: number;
  /** Tasks with at least one session before their deadline. */
  preppedTasks: number;
  tasks: number;
  shortfallMinutes: number;
  /** Study sessions overlapping a class, a recurring commitment, a Google event or another study session. */
  overlaps: number;
  weekendEarlyStarts: number;
  /** Sessions that start exactly when the 15-minute transition after a class ends. */
  rightAfterClass: number;
}

const iv = (b: Pick<ScheduleBlock, "startTime" | "endTime">) => [timeToMinutes(b.startTime), timeToMinutes(b.endTime)] as const;

export function planMetrics(state: Pick<AppState, "tasks" | "classes" | "semester" | "recurringEvents">, blocks: ScheduleBlock[], shortfalls: Array<{ missingMinutes: number }> = []): PlanMetrics {
  const study = blocks.filter((b) => b.type === "study" && b.taskId && b.completionStatus !== "skipped" && b.completionStatus !== "missed");
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  for (const b of study) {
    const m = iv(b)[1] - iv(b)[0];
    perDay.set(b.date, (perDay.get(b.date) ?? 0) + m);
    perWeek.set(weekStartKeyOf(b.date), (perWeek.get(weekStartKeyOf(b.date)) ?? 0) + m);
  }
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  // A quiz / exam without a time happens at the start of its class that day (the rule the 1.0.8 planner follows);
  // measured the same way before and after the change, so the "before" numbers count prep after the class too.
  const classStartOn = (t: Task, date: string): number | undefined => {
    if (t.kind !== "quiz" && t.kind !== "exam") return undefined;
    const cls = state.classes.find((c) => c.id === t.courseId);
    if (!cls || !cls.days.includes(weekdayOfKey(date))) return 0;
    if (state.semester && (date < state.semester.startDate || date > state.semester.endDate || state.semester.breaks.some((x) => date >= x.startDate && date <= x.endDate))) return 0;
    return timeToMinutes(cls.startTime);
  };
  let late = 0;
  for (const b of study) {
    const t = taskById.get(b.taskId!);
    if (!t) continue;
    if (b.date > t.dueDate) late += 1;
    else if (b.date === t.dueDate) {
      const cutoff = t.dueTime ? timeToMinutes(t.dueTime) : classStartOn(t, t.dueDate);
      if (cutoff !== undefined && iv(b)[1] > cutoff) late += 1;
    }
  }
  const prepped = state.tasks.filter((t) => study.some((b) => b.taskId === t.id && b.date <= t.dueDate)).length;
  const fixed = blocks.filter((b) => b.type === "class" || b.type === "recurring");
  let overlaps = 0;
  for (let i = 0; i < study.length; i += 1) {
    const a = study[i]!;
    const [as, ae] = iv(a);
    for (const f of fixed) if (f.date === a.date && as < iv(f)[1] && iv(f)[0] < ae) overlaps += 1;
    for (let j = i + 1; j < study.length; j += 1) {
      const c = study[j]!;
      if (c.date === a.date && as < iv(c)[1] && iv(c)[0] < ae) overlaps += 1;
    }
  }
  const classEnds = new Set(blocks.filter((b) => b.type === "class").map((b) => `${b.date}|${timeToMinutes(b.endTime) + 15}`));
  const weeks = [...perWeek.values()];
  const days = [...perDay.values()];
  return {
    studyMinutes: study.reduce((s, b) => s + iv(b)[1] - iv(b)[0], 0),
    sessions: study.length,
    weeklyHoursMin: weeks.length ? Math.round((Math.min(...weeks) / 60) * 10) / 10 : 0,
    weeklyHoursMax: weeks.length ? Math.round((Math.max(...weeks) / 60) * 10) / 10 : 0,
    maxHoursPerDay: days.length ? Math.round((Math.max(...days) / 60) * 10) / 10 : 0,
    daysOver5h: days.filter((m) => m > 300).length,
    lateSessions: late,
    preppedTasks: prepped,
    tasks: state.tasks.length,
    shortfallMinutes: shortfalls.reduce((s, x) => s + x.missingMinutes, 0),
    overlaps,
    weekendEarlyStarts: study.filter((b) => (weekdayOfKey(b.date) === "Sat" || weekdayOfKey(b.date) === "Sun") && timeToMinutes(b.startTime) < 9 * 60).length,
    rightAfterClass: study.filter((b) => classEnds.has(`${b.date}|${timeToMinutes(b.startTime)}`)).length,
  };
}

/** Days from the first to the last week of study (for a printout). */
export function spanWeeks(blocks: ScheduleBlock[]): number {
  const dates = blocks.filter((b) => b.type === "study").map((b) => b.date).sort();
  return dates.length ? Math.floor(daysBetweenKeys(weekStartKeyOf(dates[0]!), dates[dates.length - 1]!) / 7) + 1 : 0;
}
