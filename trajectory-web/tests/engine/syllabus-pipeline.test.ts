/**
 * Syllabus pipeline, end to end (no network): a realistic model answer -> parse -> resolve the term and dates ->
 * review drafts -> import -> plan the WHOLE semester with the planner -> assert the promises:
 *   - nothing is dropped, nothing is invented (an undated item stays undated),
 *   - every dated deliverable has study time before its deadline OR an explicit shortfall,
 *   - class meetings never land on a break or outside the term,
 *   - import -> undo puts everything back.
 * Run under several timezones (see the package notes: TZ=UTC, Asia/Tokyo, America/Los_Angeles).
 */
import { describe, expect, it } from "vitest";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { importableDrafts, undoSyllabusImport, setDraftDate, type DraftItem } from "../../src/engine/syllabus-import";
import type { AppState, ClassBlock, RecurringEvent, ScheduleBlock, Task } from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";
import {
  baseState,
  EXPLICIT_FIXTURE,
  EXPLICIT_NOW,
  EXPLICIT_TODAY,
  extractLikeServer,
  importFresh,
  WEEKLY_FIXTURE,
  WEEKLY_NOW,
  WEEKLY_TODAY,
} from "./syllabus-fixtures";

const BIO: ClassBlock = { id: "class-bio", name: "Biology 101", days: ["Mon", "Wed"], startTime: "11:00", endTime: "11:50", color: "#10B981" };
const GYM: RecurringEvent = { id: "gym", title: "Gym", days: ["Tue", "Thu"], startTime: "17:00", endTime: "18:00", color: "#06B6D4", locked: true };
const BIO_TASK = (dueDate: string): Task => ({
  id: "bio-1", name: "Lab notebook", courseId: "class-bio", courseName: "Biology 101", dueDate, estimatedMinutes: 90, difficulty: 2,
  requiresOnCampus: false, status: "pending", createdAt: "2026-01-01T00:00:00.000Z",
});

interface Scenario {
  name: string;
  fixture: string;
  today: string;
  now: Date;
  bioDue: string;
  expected: { tasks: string[]; undated: string[]; past: string[]; termStart: string; termEnd: string; breaks: string[] };
}

const SCENARIOS: Scenario[] = [
  {
    name: "explicit dates, uploaded mid-semester",
    fixture: EXPLICIT_FIXTURE,
    today: EXPLICIT_TODAY,
    now: EXPLICIT_NOW,
    bioDue: "2026-10-05",
    expected: {
      tasks: ["Homework 2", "Lab Report 1", "Midterm Exam", "Problem Set 5", "Quiz 1", "Research Paper"],
      undated: ["Final Exam", "Bonus Assignment"],
      past: ["Homework 1"],
      termStart: "2026-08-24",
      termEnd: "2026-12-11",
      breaks: ["Fall Break", "Thanksgiving"],
    },
  },
  {
    name: "week-numbered dates with a spring break, uploaded before the term",
    fixture: WEEKLY_FIXTURE,
    today: WEEKLY_TODAY,
    now: WEEKLY_NOW,
    bioDue: "2027-02-03",
    expected: {
      tasks: ["Essay 1", "Essay 2", "Midterm Exam", "Reading Response 1"],
      undated: ["Final Exam", "Group Presentation"],
      past: [],
      termStart: "2027-01-11",
      termEnd: "2027-05-07",
      breaks: ["Spring Break"],
    },
  },
];

function setup(s: Scenario) {
  const before = baseState({ classes: [BIO], recurringEvents: [GYM], tasks: [BIO_TASK(s.bioDue)] });
  const pipeline = extractLikeServer(s.fixture, s.today);
  const imported = importFresh(before, pipeline, { now: s.now, today: s.today, importId: "import-e2e" });
  const plan = buildSemesterPlan(imported.after, { now: s.now });
  const planned: AppState = { ...imported.after, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks };
  return { before, pipeline, ...imported, plan, planned };
}

const inBreak = (date: string, breaks: Array<{ startDate: string; endDate: string }>) => breaks.some((b) => date >= b.startDate && date <= b.endDate);
const minutes = (b: ScheduleBlock) => timeToMinutes(b.endTime) - timeToMinutes(b.startTime);

describe.each(SCENARIOS)("syllabus pipeline: $name", (s) => {
  const run = setup(s);
  const { pipeline, built, after, plan, planned, semester } = run;

  it("reads the term, the meeting pattern and the breaks from the document", () => {
    expect(semester).toMatchObject({ startDate: s.expected.termStart, endDate: s.expected.termEnd });
    expect(semester.breaks.map((b) => b.name)).toEqual(s.expected.breaks);
    const cls = built.payload.classToCreate!;
    expect(cls.days.length).toBeGreaterThan(0);
    expect(cls.startTime < cls.endTime).toBe(true);
    // The grading table is read too (work that counts for more gets a little more priority), but a class does not
    // carry it: there is no grade tracking.
    expect(pipeline.extraction.course.gradeWeights.length).toBeGreaterThan(0);
    expect(cls).not.toHaveProperty("gradeComponents");
  });

  it("drops nothing: every item is a task or a flagged exclusion", () => {
    const { counts } = built;
    const accounted = counts.added + counts.overwritten + counts.skippedDuplicates + counts.repeated + counts.excludedUndated + counts.excludedPast + counts.excludedUnchecked;
    expect(accounted).toBe(pipeline.drafts.length);
    expect(pipeline.items).toHaveLength(pipeline.extraction.items.length);
    expect(built.payload.tasks.map((t) => t.name).sort()).toEqual([...s.expected.tasks].sort());
    expect(pipeline.drafts.filter((d) => d.dueDate === null).map((d) => d.name).sort()).toEqual([...s.expected.undated].sort());
    expect(pipeline.drafts.filter((d) => d.isPast).map((d) => d.name)).toEqual(s.expected.past);
  });

  it("never fabricates a date: undated items stay undated and every task's date came from the document", () => {
    for (const name of s.expected.undated) {
      const draft = pipeline.drafts.find((d) => d.name === name)!;
      expect(draft.dueDate).toBeNull();
      expect(after.tasks.some((t) => t.name === name)).toBe(false);
      expect(plan.scheduleBlocks.some((b) => b.title.includes(name))).toBe(false);
    }
    for (const task of built.payload.tasks) {
      const draft = pipeline.drafts.find((d) => d.id === task.id)!;
      expect(task.dueDate).toBe(draft.dueDate);
      expect(task.dateEvidence, `${task.name} must cite where its date came from`).toBeTruthy();
      expect(["explicit", "inferred"]).toContain(task.dateConfidence);
    }
  });

  it("every dated deliverable has study time on or before its deadline, or an explicit shortfall", () => {
    const study = plan.scheduleBlocks.filter((b): b is ScheduleBlock & { taskId: string } => b.type === "study" && Boolean(b.taskId));
    for (const task of built.payload.tasks) {
      const own = study.filter((b) => b.taskId === task.id);
      const shortfall = plan.shortfalls.find((sf) => sf.taskId === task.id);
      const placed = own.reduce((sum, b) => sum + minutes(b), 0);
      expect(placed > 0 || shortfall !== undefined, `${task.name}: no study time and no shortfall reported`).toBe(true);
      for (const block of own) expect(block.date <= task.dueDate, `${task.name}: session on ${block.date} after the deadline ${task.dueDate}`).toBe(true);
      if (shortfall) expect(shortfall.missingMinutes).toBeGreaterThan(0);
    }
  });

  it("plans the whole semester, not just the current week", () => {
    const weeks = new Set(plan.scheduleBlocks.filter((b) => b.type === "study" && built.payload.tasks.some((t) => t.id === b.taskId)).map((b) => b.date.slice(0, 7)));
    expect(plan.weeksPlanned).toBeGreaterThanOrEqual(5);
    expect(weeks.size).toBeGreaterThanOrEqual(2);
  });

  it("class meetings are generated inside the term and never on a break day", () => {
    const classBlocks = plan.scheduleBlocks.filter((b) => b.type === "class");
    expect(classBlocks.length).toBeGreaterThan(0);
    for (const b of classBlocks) {
      expect(b.date >= semester.startDate && b.date <= semester.endDate, `${b.title} on ${b.date} is outside the term`).toBe(true);
      expect(inBreak(b.date, semester.breaks), `${b.title} on ${b.date} falls in a break`).toBe(false);
    }
    // the new class really does meet on its days inside the term
    expect(classBlocks.some((b) => b.courseId === built.payload.classToCreate!.id)).toBe(true);
  });

  it("study sessions never overlap a class meeting or each other", () => {
    const timed = plan.scheduleBlocks.filter((b) => b.type === "study" || b.type === "class");
    const byDate = new Map<string, ScheduleBlock[]>();
    for (const b of timed) byDate.set(b.date, [...(byDate.get(b.date) ?? []), b]);
    for (const [date, blocks] of byDate) {
      for (let i = 0; i < blocks.length; i += 1) {
        for (let j = i + 1; j < blocks.length; j += 1) {
          const a = blocks[i]!;
          const c = blocks[j]!;
          const overlap = a.startTime < c.endTime && c.startTime < a.endTime;
          expect(overlap, `${date}: ${a.title} ${a.startTime}-${a.endTime} overlaps ${c.title} ${c.startTime}-${c.endTime}`).toBe(false);
        }
      }
    }
  });

  it("Practice Test sessions appear only for exams (Task.kind comes from the syllabus type)", () => {
    const kindOf = new Map(after.tasks.map((t) => [t.id, t.kind]));
    for (const b of plan.scheduleBlocks) {
      if (b.type !== "study" || !b.taskId || !/practice test/i.test(b.title)) continue;
      expect(kindOf.get(b.taskId)).toBe("exam");
    }
  });

  it("import -> undo restores the original state exactly (even after the semester was planned)", () => {
    expect(undoSyllabusImport(after, "import-e2e")).toEqual(run.before);

    const undone = undoSyllabusImport(planned, "import-e2e");
    const importedIds = new Set(built.payload.tasks.map((t) => t.id));
    expect(undone.tasks.map((t) => t.id)).toEqual(run.before.tasks.map((t) => t.id));
    expect(undone.classes).toEqual(run.before.classes);
    expect(undone.semester).toBeUndefined();
    expect(undone.syllabusImports).toEqual([]);
    expect(undone.scheduleBlocks.some((b) => (b.taskId && importedIds.has(b.taskId)) || b.courseId === built.payload.classToCreate!.id || b.id.includes(built.payload.classToCreate!.id))).toBe(false);
    // what was not the import's stays: the Biology class meetings and the gym blocks
    expect(undone.scheduleBlocks.some((b) => b.courseId === "class-bio")).toBe(true);
    expect(undone.scheduleBlocks.some((b) => b.type === "recurring")).toBe(true);
  });
});

describe("the honesty path: not enough time is reported, never hidden", () => {
  it("huge estimates under near deadlines produce explicit shortfalls and still no session after a deadline", () => {
    const s = SCENARIOS[0]!;
    const pipeline = extractLikeServer(s.fixture, s.today);
    const stressed: DraftItem[] = pipeline.drafts.map((d) => ({ ...d, estimatedMinutes: 5000 })); // 83 hours each: cannot fit before the near deadlines
    const before = baseState({ classes: [BIO], tasks: [BIO_TASK(s.bioDue)] });
    const { built, after } = importFresh(before, pipeline, { now: s.now, today: s.today, drafts: stressed });
    const plan = buildSemesterPlan(after, { now: s.now });
    expect(plan.shortfalls.length).toBeGreaterThan(0);
    for (const sf of plan.shortfalls) expect(sf.missingMinutes).toBeGreaterThan(0);
    for (const task of built.payload.tasks) {
      const own = plan.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === task.id);
      expect(own.every((b) => b.date <= task.dueDate)).toBe(true);
      expect(own.length > 0 || plan.shortfalls.some((sf) => sf.taskId === task.id)).toBe(true);
    }
  });

  it("a date the student types for an undated item is planned like any other, marked as theirs", () => {
    const s = SCENARIOS[0]!;
    const pipeline = extractLikeServer(s.fixture, s.today);
    const final = pipeline.drafts.find((d) => d.name === "Final Exam")!;
    const typed = setDraftDate(final, "2026-12-09", { today: s.today, termStart: "2026-08-24", termEnd: "2026-12-11" });
    if (!typed.ok) throw new Error("expected ok");
    const drafts = pipeline.drafts.map((d) => (d.id === final.id ? typed.draft : d));
    expect(importableDrafts(drafts).map((d) => d.name)).toContain("Final Exam");
    const { built, after } = importFresh(baseState(), pipeline, { now: s.now, today: s.today, drafts });
    const task = built.payload.tasks.find((t) => t.name === "Final Exam")!;
    expect(task).toMatchObject({ dueDate: "2026-12-09", dateConfidence: "user", kind: "exam" });
    const plan = buildSemesterPlan(after, { now: s.now });
    expect(plan.scheduleBlocks.some((b) => b.type === "study" && b.taskId === task.id) || plan.shortfalls.some((sf) => sf.taskId === task.id)).toBe(true);
  });
});
