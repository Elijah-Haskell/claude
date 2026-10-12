import { describe, expect, it } from "vitest";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { buildWeekPlan, PlannerState } from "../../src/engine/week-planner";
import { planInputsKey } from "../../src/engine/plan-inputs";
import { createInitialState } from "../../src/engine/state-persistence";
import { AppState, DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, ScheduleBlock, Semester, Task } from "../../src/engine/types";
import { addDaysToKey, getWeekStart, localDateKey, weekStartKeyOf } from "../../src/engine/utils";
import { expectNoOverlaps, localMoment, makeBlock, makeClass, makeTask, NOW, TODAY } from "./scheduler-fixtures";

// NOW = Wed 2030-03-13 12:00 local; this week's Monday is 2030-03-11.
const SEMESTER: Semester = {
  id: "s",
  name: "Spring 2030",
  startDate: "2030-01-14",
  endDate: "2030-05-03",
  breaks: [{ name: "Spring break", startDate: "2030-03-18", endDate: "2030-03-22" }],
};

const COURSES = ["chem", "hist", "math", "eng", "cs", "bio"];

function classes() {
  return COURSES.map((id, i) => makeClass({
    id, name: id.toUpperCase(),
    days: i % 2 === 0 ? ["Mon", "Wed", "Fri"] : ["Tue", "Thu"],
    startTime: `${String(8 + i).padStart(2, "0")}:00`,
    endTime: `${String(9 + i).padStart(2, "0")}:15`,
    color: "#4F6EF7",
  }));
}

/** `count` tasks whose due dates are spread over the `days` days after `from`. */
function spreadTasks(count: number, from: string, days: number): Task[] {
  const kinds = ["Problem set", "Reading response", "Quiz", "Lab report", "Midterm exam"];
  return Array.from({ length: count }, (_, i) => ({
    id: `sem-${i}`,
    name: `${kinds[i % kinds.length]} ${Math.floor(i / 5) + 1}`,
    courseId: COURSES[i % COURSES.length]!,
    courseName: COURSES[i % COURSES.length]!.toUpperCase(),
    dueDate: addDaysToKey(from, 2 + Math.floor((i * days) / count)),
    estimatedMinutes: [45, 60, 90, 120, 180][i % 5]!,
    difficulty: ((i % 5) + 1) as Task["difficulty"],
    requiresOnCampus: false,
    status: "pending" as const,
    createdAt: "2030-03-01T00:00:00.000Z",
  }));
}

function planState(overrides: Partial<PlannerState> = {}): PlannerState {
  return {
    classes: classes(),
    recurringEvents: [],
    tasks: spreadTasks(30, TODAY, 50),
    scheduleBlocks: [],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
    semester: SEMESTER,
    ...overrides,
  };
}

const weekOf = (date: string) => weekStartKeyOf(date);
const study = (blocks: ScheduleBlock[]) => blocks.filter((b) => b.type === "study");

describe("buildSemesterPlan: the whole semester in one pass", () => {
  it("plans study sessions in every week with work due, not only the current week (buildWeekPlan only fills its own week)", () => {
    const state = planState();
    const semester = buildSemesterPlan(state, { now: NOW });
    const weeksWithStudy = new Set(study(semester.scheduleBlocks).map((b) => weekOf(b.date)));

    expect(semester.weeksPlanned).toBe(8); // Mar 11 ... Apr 29
    expect(weeksWithStudy.size).toBeGreaterThanOrEqual(6);
    expect(weeksWithStudy.has("2030-04-15")).toBe(true);

    // The single-week planner keeps only its own week (the reason the semester plan exists).
    const oneWeek = buildWeekPlan(state, getWeekStart(NOW), { now: NOW });
    expect(new Set(study(oneWeek.scheduleBlocks).map((b) => weekOf(b.date)))).toEqual(new Set(["2030-03-11"]));
  });

  it("every task gets all its minutes placed (or an explicit shortfall) across the semester", () => {
    const state = planState();
    const plan = buildSemesterPlan(state, { now: NOW });
    for (const task of state.tasks) {
      const placed = study(plan.scheduleBlocks).filter((b) => b.taskId === task.id).reduce((sum, b) => sum + (toMin(b.endTime) - toMin(b.startTime)), 0);
      const missing = plan.shortfalls.find((s) => s.taskId === task.id)?.missingMinutes ?? 0;
      expect(placed + missing).toBe(task.estimatedMinutes);
    }
    expect(plan.tasks.every((t) => t.status === "scheduled")).toBe(true);
  });

  it("builds sleep for every night and class meetings for every class week, none during the break", () => {
    const plan = buildSemesterPlan(planState(), { now: NOW });
    const dates = (type: string) => plan.scheduleBlocks.filter((b) => b.type === type).map((b) => b.date);

    expect(dates("sleep")).toHaveLength(8 * 7);
    const classDates = new Set(dates("class"));
    expect(classDates.has("2030-03-13")).toBe(true);
    expect(classDates.has("2030-03-25")).toBe(true);
    for (const breakDay of ["2030-03-18", "2030-03-19", "2030-03-20", "2030-03-21", "2030-03-22"]) expect(classDates.has(breakDay)).toBe(false);
    // ...and nothing before the semester start or after its end.
    expect([...classDates].every((d) => d >= SEMESTER.startDate && d <= SEMESTER.endDate)).toBe(true);
  });

  it("never places study over a class or before now, and keeps ids unique", () => {
    const plan = buildSemesterPlan(planState(), { now: NOW });
    const busy = plan.scheduleBlocks.filter((b) => b.type !== "sleep");

    expect(expectNoOverlaps(busy)).toBeNull();
    for (const block of study(plan.scheduleBlocks)) {
      expect(block.date > TODAY || (block.date === TODAY && block.startTime >= "12:00")).toBe(true);
    }
    expect(new Set(plan.scheduleBlocks.map((b) => b.id)).size).toBe(plan.scheduleBlocks.length);
  });

  it("is stable: planning its own output changes nothing", () => {
    const state = planState();
    const first = buildSemesterPlan(state, { now: NOW });
    const second = buildSemesterPlan({ ...state, tasks: first.tasks, scheduleBlocks: first.scheduleBlocks }, { now: NOW });

    expect(second.scheduleBlocks).toEqual(first.scheduleBlocks);
    expect(second.tasks).toEqual(first.tasks);
  });

  it("keeps blocks the student accepted, edited, locked, started or finished exactly as they are - in any week", () => {
    const state = planState();
    const base = buildSemesterPlan(state, { now: NOW });
    // A task due after every kept block (1.0.8: a confirmed session AFTER its task's deadline is released - this used
    // task 0, due 2030-03-15, whose "kept" sessions were all after its deadline).
    const t = state.tasks.find((task) => task.dueDate > "2030-04-11")!.id;
    const custom = (id: string, date: string, startTime: string, overrides: Partial<ScheduleBlock>): ScheduleBlock =>
      makeBlock({ id, type: "study", taskId: t, courseId: "chem", date, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, accepted: false, ...overrides });
    const kept: ScheduleBlock[] = [
      custom("accepted-next-week", "2030-03-20", "15:00", { accepted: true }),
      custom("edited-in-april", "2030-04-10", "16:00", { userEdited: true }),
      custom("locked-in-april", "2030-04-11", "16:00", { locked: true }),
      custom("started-today", TODAY, "16:00", { startedAt: "2030-03-13T15:59:00.000Z", accepted: true }),
      custom("finished-last-month", "2030-02-11", "10:00", { completionStatus: "done", accepted: true }),
    ];
    const plan = buildSemesterPlan({ ...state, scheduleBlocks: [...base.scheduleBlocks, ...kept] }, { now: NOW });

    for (const block of kept) expect(plan.scheduleBlocks.find((b) => b.id === block.id)).toEqual(block);
    expect(expectNoOverlaps(plan.scheduleBlocks.filter((b) => b.type !== "sleep"))).toBeNull();
  });

  it("counts an accepted session in the future as covering its task, but a session whose time has passed no longer does", () => {
    const task = makeTask({ id: "essay", name: "Essay", courseId: "hist", dueDate: "2030-03-20", estimatedMinutes: 60 });
    const session = (date: string, startTime: string, endTime: string): ScheduleBlock =>
      makeBlock({ id: `s-${date}`, type: "study", taskId: "essay", courseId: "hist", date, startTime, endTime, accepted: true });
    const state = planState({ classes: [], tasks: [task] });
    const covered = buildSemesterPlan({ ...state, scheduleBlocks: [session("2030-03-15", "10:00", "11:00")] }, { now: NOW });
    const missed = buildSemesterPlan({ ...state, scheduleBlocks: [session("2030-03-12", "10:00", "11:00")] }, { now: NOW });

    expect(study(covered.scheduleBlocks).filter((b) => b.taskId === "essay")).toHaveLength(1); // the accepted one is enough
    expect(study(missed.scheduleBlocks).filter((b) => b.taskId === "essay" && b.date >= TODAY)).not.toHaveLength(0); // re-planned
  });

  it("reports work that cannot fit before its deadline instead of pretending", () => {
    const tasks = [makeTask({ id: "huge", name: "Thesis draft", dueDate: "2030-03-14", estimatedMinutes: 20 * 60 })];
    const plan = buildSemesterPlan(planState({ tasks }), { now: NOW });

    expect(plan.shortfalls.map((s) => s.taskId)).toContain("huge");
    expect(plan.shortfalls[0]!.missingMinutes).toBeGreaterThan(0);
    expect(plan.summary).toContain("won't fully fit");
  });

  it("removes generated blocks beyond a horizon that shrank, but keeps what the student confirmed", () => {
    const state = planState({ tasks: [] });
    const long = buildSemesterPlan(state, { now: NOW });
    expect(long.scheduleBlocks.some((b) => b.type === "class" && b.date > "2030-04-05")).toBe(true);

    const keeper = makeBlock({ id: "dentist", type: "free", title: "Dentist", date: "2030-04-30", startTime: "09:00", endTime: "10:00", accepted: true, locked: true });
    const shorter = buildSemesterPlan(
      { ...state, semester: { ...SEMESTER, endDate: "2030-04-05" }, scheduleBlocks: [...long.scheduleBlocks, keeper] },
      { now: NOW },
    );

    expect(shorter.scheduleBlocks.some((b) => b.type === "class" && b.date > "2030-04-05")).toBe(false);
    expect(shorter.scheduleBlocks.find((b) => b.id === "dentist")).toEqual(keeper);
    expect(shorter.horizon.endKey).toBe("2030-04-07"); // Sunday of the week of Fri Apr 5
  });

  it("plans a task due after the semester end and covers it with structure", () => {
    const tasks = [makeTask({ id: "late", dueDate: "2030-05-10", estimatedMinutes: 60, courseId: "chem" })];
    const plan = buildSemesterPlan(planState({ tasks }), { now: NOW });

    expect(plan.horizon.endKey).toBe("2030-05-12"); // Sunday of the week of the 10th
    expect(study(plan.scheduleBlocks).some((b) => b.taskId === "late")).toBe(true);
    expect(plan.scheduleBlocks.filter((b) => b.type === "sleep" && b.date === "2030-05-10")).toHaveLength(1);
  });

  it("without a semester (older saves) it still plans through the latest due date + a week", () => {
    const plan = buildSemesterPlan(planState({ semester: undefined, tasks: spreadTasks(6, TODAY, 20) }), { now: NOW });

    expect(plan.weeksPlanned).toBeGreaterThanOrEqual(4);
    expect(study(plan.scheduleBlocks).length).toBeGreaterThan(0);
  });
});

describe("performance and size of a whole-semester plan", () => {
  const MONDAY = localMoment(2030, 1, 14, 8, 0);

  it("plans 16 weeks x 60 tasks x 6 classes in under a second, then re-plans its own output just as fast", () => {
    const state = planState({ tasks: spreadTasks(60, "2030-01-14", 107) });
    const started = performance.now();
    const first = buildSemesterPlan(state, { now: MONDAY });
    const firstMs = performance.now() - started;

    expect(first.weeksPlanned).toBe(16);
    expect(study(first.scheduleBlocks).length).toBeGreaterThan(60);
    expect(firstMs).toBeLessThan(1000);

    const again = performance.now();
    const second = buildSemesterPlan({ ...state, tasks: first.tasks, scheduleBlocks: first.scheduleBlocks }, { now: MONDAY });
    expect(performance.now() - again).toBeLessThan(1000);
    expect(second.scheduleBlocks).toEqual(first.scheduleBlocks);
  });

  it("a full semester serialises to well under Android's 2 MB row limit, quickly", () => {
    const state: AppState = { ...createInitialState(), ...planState({ tasks: spreadTasks(60, "2030-01-14", 107) }), onboardingComplete: true } as AppState;
    const plan = buildSemesterPlan(state, { now: MONDAY });
    const started = performance.now();
    const json = JSON.stringify({ ...state, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks });
    const ms = performance.now() - started;

    // eslint-disable-next-line no-console
    console.log(`full semester: ${plan.scheduleBlocks.length} blocks, ${(json.length / 1024).toFixed(0)} KB, stringify ${ms.toFixed(1)} ms`);
    expect(json.length).toBeLessThan(1_500_000);
    expect(ms).toBeLessThan(250);
  });
});

describe("planInputsKey: re-plan only when the plan's inputs change", () => {
  const key = (state: AppState, day = TODAY) => planInputsKey(state, day);
  const base: AppState = { ...createInitialState(), onboardingComplete: true, classes: classes(), tasks: spreadTasks(5, TODAY, 20), semester: SEMESTER };

  it("ignores completing/skipping/accepting blocks, priority scores and a task flipping to scheduled", () => {
    const busy: AppState = { ...base, scheduleBlocks: [makeBlock({ id: "a" })] };
    const changed: AppState = {
      ...busy,
      scheduleBlocks: [makeBlock({ id: "a", completionStatus: "done", accepted: false })],
      tasks: busy.tasks.map((t) => ({ ...t, status: "scheduled" as const, priorityScore: 77 })),
    };

    expect(key(changed)).toBe(key(busy));
  });

  it("changes when a task is edited, a class moves, the semester changes, the sleep window changes, or the day rolls over", () => {
    const original = key(base);

    expect(key({ ...base, tasks: base.tasks.map((t, i) => (i === 0 ? { ...t, dueDate: "2030-03-30" } : t)) })).not.toBe(original);
    expect(key({ ...base, tasks: base.tasks.slice(1) })).not.toBe(original);
    expect(key({ ...base, tasks: base.tasks.map((t, i) => (i === 0 ? { ...t, completedMinutes: 30 } : t)) })).not.toBe(original);
    expect(key({ ...base, classes: base.classes.map((c, i) => (i === 0 ? { ...c, startTime: "09:30" } : c)) })).not.toBe(original);
    expect(key({ ...base, semester: { ...SEMESTER, breaks: [] } })).not.toBe(original);
    expect(key({ ...base, healthPrefs: { ...base.healthPrefs, bedtime: "00:30" } })).not.toBe(original);
    expect(key(base, addDaysToKey(TODAY, 1))).not.toBe(original);
  });

  it("is cheap: keying a 60-task, 6-class semester takes well under a millisecond-scale budget", () => {
    const big: AppState = { ...base, tasks: spreadTasks(60, TODAY, 100) };
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) key(big);
    expect((performance.now() - started) / 200).toBeLessThan(2);
    expect(localDateKey(NOW)).toBe(TODAY);
  });
});

function toMin(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
