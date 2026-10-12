import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { createInitialState } from "../../src/engine/state-persistence";
import { buildSyllabusImport, prefillBasics, importableDrafts } from "../../src/engine/syllabus-import";
import type { AppState, ClassBlock, ScheduleBlock, Semester, Task } from "../../src/engine/types";
import { EXPLICIT_FIXTURE, EXPLICIT_NOW, EXPLICIT_TODAY, extractLikeServer, importFresh, WEEKLY_FIXTURE, WEEKLY_NOW, WEEKLY_TODAY } from "./syllabus-fixtures";

const NOW = EXPLICIT_NOW;

const BIO: ClassBlock = { id: "class-bio", name: "Biology 101", days: ["Mon", "Wed"], startTime: "11:00", endTime: "11:50", color: "#10B981" };
const BIO_TASK: Task = {
  id: "bio-1", name: "Lab notebook", courseId: "class-bio", courseName: "Biology 101", dueDate: "2026-10-05", estimatedMinutes: 90, difficulty: 2,
  requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z",
};

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), onboardingComplete: true, ...overrides };
}

function apply(state: AppState, semester?: Semester, importId = "import-1", pipelineFixture = EXPLICIT_FIXTURE, today = EXPLICIT_TODAY, now = NOW) {
  const pipeline = extractLikeServer(pipelineFixture, today, { semesterStart: state.semester?.startDate, semesterEnd: state.semester?.endDate, idPrefix: importId });
  const built = buildSyllabusImport({
    now, today, importId, drafts: pipeline.drafts,
    course: prefillBasics(pipeline.extraction.course),
    target: { kind: "new" }, existing: { classes: state.classes, tasks: state.tasks },
    semester: semester ?? null, source: "paste", newClassId: `class-${importId}`,
  });
  return { next: reducer(state, { type: "APPLY_SYLLABUS_IMPORT", payload: built.payload }), built, pipeline };
}

const plan = (s: AppState) => reducer(s, { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });
const study = (blocks: ScheduleBlock[]) => blocks.filter((b) => b.type === "study").map((b) => `${b.taskId}|${b.date}|${b.startTime}-${b.endTime}`).sort();

describe("import -> undo is exact", () => {
  it("removes exactly what the import created (tasks, class, generated study and class blocks, semester) and nothing else", () => {
    const before = plan(stateWith({ classes: [BIO], tasks: [BIO_TASK] }));
    const semester: Semester = { id: "sem-fall", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] };

    const { next, built } = apply(before, semester);
    const planned = plan(next);
    const createdTaskIds = new Set(built.payload.tasks.map((t) => t.id));

    // the import really produced blocks for the new class and tasks
    expect(planned.scheduleBlocks.some((b) => b.courseId === "class-import-1")).toBe(true);
    expect(planned.scheduleBlocks.some((b) => b.type === "study" && createdTaskIds.has(b.taskId ?? ""))).toBe(true);
    expect(planned.semester?.id).toBe("sem-fall");

    const undone = reducer(planned, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-1" });

    expect(undone.tasks).toEqual(before.tasks);
    expect(undone.classes).toEqual(before.classes);
    expect(undone.semester).toBeUndefined();
    expect(undone.syllabusImports).toEqual(before.syllabusImports);
    expect(undone.user).toEqual(before.user);
    expect(undone.scheduleBlocks.some((b) => b.courseId === "class-import-1" || b.id.includes("class-import-1"))).toBe(false);
    expect(undone.scheduleBlocks.some((b) => b.type === "study" && createdTaskIds.has(b.taskId ?? ""))).toBe(false);
    // the pre-existing Biology plan is untouched: a re-plan gives the same sessions as re-planning the original state
    expect(study(plan(undone).scheduleBlocks)).toEqual(study(plan(before).scheduleBlocks));
  });

  it("the student's own things survive: their manually added block, and other classes' work", () => {
    const own: ScheduleBlock = { id: "own-1", type: "work", title: "Shift", date: "2026-10-03", startTime: "12:00", endTime: "16:00", locked: true, accepted: true, color: "#EC4899", completionStatus: "pending" };
    const before = stateWith({ classes: [BIO], tasks: [BIO_TASK], scheduleBlocks: [own] });
    const { next } = apply(before);
    const undone = reducer(plan(next), { type: "UNDO_SYLLABUS_IMPORT", payload: "import-1" });
    expect(undone.scheduleBlocks.find((b) => b.id === "own-1")).toEqual(own);
    expect(undone.tasks.map((t) => t.id)).toEqual(["bio-1"]); // the planner may have marked it "scheduled"; it is still there
  });

  it("undoing a second import leaves the first import (its class, tasks and semester) intact", () => {
    const semester: Semester = { id: "sem-fall", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [] };
    const first = apply(stateWith(), semester, "import-1").next;
    const second = apply(first, undefined, "import-2", EXPLICIT_FIXTURE.replace(/CHEM 201/g, "CHEM 301").replace("Organic Chemistry", "Advanced Organic")).next;
    expect(second.classes).toHaveLength(2);
    const undone = reducer(second, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-2" });
    expect(undone.classes.map((c) => c.id)).toEqual(["class-import-1"]);
    expect(undone.tasks.every((t) => t.syllabusImportId === "import-1")).toBe(true);
    expect(undone.tasks).toEqual(first.tasks);
    expect(undone.semester?.id).toBe("sem-fall");
    expect(undone.syllabusImports?.map((i) => i.id)).toEqual(["import-1"]);
  });

  it("restores tasks the import overwrote to what they were before", () => {
    const cls: ClassBlock = { id: "class-chem", name: "CHEM 201: Organic Chemistry", days: ["Tue", "Thu"], startTime: "09:30", endTime: "10:45", color: "#4F6EF7" };
    const oldHw2: Task = { id: "old-hw2", name: "Homework 2", courseId: "class-chem", courseName: cls.name, dueDate: "2026-09-25", estimatedMinutes: 30, difficulty: 1, requiresOnCampus: false, status: "pending", createdAt: "2026-08-20T00:00:00.000Z" };
    const before = stateWith({ classes: [cls], tasks: [oldHw2] });
    const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
    const hw2 = pipeline.drafts.find((d) => d.name === "Homework 2")!;
    const built = buildSyllabusImport({
      now: NOW, today: EXPLICIT_TODAY, importId: "import-9", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "existing", cls },
      existing: { classes: before.classes, tasks: before.tasks }, overwriteIds: new Set([hw2.id]), source: "paste",
    });
    const applied = reducer(before, { type: "APPLY_SYLLABUS_IMPORT", payload: built.payload });
    expect(applied.tasks.find((t) => t.id === "old-hw2")!.estimatedMinutes).toBe(75);
    const undone = reducer(applied, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-9" });
    expect(undone.tasks).toEqual([oldHw2]);
  });

  it("restores the class's meeting pattern when the import edited an existing class", () => {
    const cls: ClassBlock = { id: "class-chem", name: "CHEM 201: Organic Chemistry", days: ["Mon"], startTime: "08:00", endTime: "08:50", color: "#4F6EF7" };
    const before = stateWith({ classes: [cls] });
    const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
    const built = buildSyllabusImport({
      now: NOW, today: EXPLICIT_TODAY, importId: "import-7", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "existing", cls },
      existing: { classes: before.classes, tasks: [] }, source: "paste",
    });
    expect(built.payload.classToUpdate).toMatchObject({ days: ["Tue", "Thu"], startTime: "09:30" });
    const applied = reducer(before, { type: "APPLY_SYLLABUS_IMPORT", payload: built.payload });
    expect(applied.classes[0]).toMatchObject({ days: ["Tue", "Thu"], startTime: "09:30" });
    // The syllabus's grading table is not put on the class (there is no grade tracking).
    expect(pipeline.extraction.course.gradeWeights).toHaveLength(4);
    expect(applied.classes[0]).not.toHaveProperty("gradeComponents");
    const undone = reducer(applied, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-7" });
    expect(undone.classes).toEqual([cls]);
    expect(undone.tasks).toEqual([]);
  });

  it("a semester that the import CHANGED goes back to the one on file, and the profile label with it", () => {
    const fall: Semester = { id: "sem-1", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [] };
    const before = reducer(stateWith(), { type: "SET_SEMESTER", payload: fall });
    expect(before.user?.currentSemester).toBe("Fall 2026");
    const replaced: Semester = { ...fall, name: "Fall 2026 (revised)", endDate: "2026-12-18", breaks: [{ name: "Fall Break", startDate: "2026-10-12", endDate: "2026-10-13" }] };
    const { next } = apply(before, replaced);
    expect(next.semester).toMatchObject({ id: "sem-1", endDate: "2026-12-18" });
    expect(next.user?.currentSemester).toBe("Fall 2026 (revised)");

    const undone = reducer(next, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-1" });
    expect(undone.semester).toEqual(fall);
    expect(undone.user).toEqual(before.user);
  });

  it("does not overwrite a semester the student edited after the import", () => {
    const { next } = apply(stateWith(), { id: "sem-fall", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [] });
    const edited = reducer(next, { type: "SET_SEMESTER", payload: { id: "sem-other", name: "Custom", startDate: "2026-09-01", endDate: "2026-12-01", breaks: [] } });
    const undone = reducer(edited, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-1" });
    expect(undone.semester?.id).toBe("sem-other");
    expect(undone.tasks).toEqual([]);
  });

  it("undo twice, or of an unknown import, is a no-op", () => {
    const { next } = apply(stateWith());
    const once = reducer(next, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-1" });
    expect(reducer(once, { type: "UNDO_SYLLABUS_IMPORT", payload: "import-1" })).toBe(once);
    expect(reducer(once, { type: "UNDO_SYLLABUS_IMPORT", payload: "ghost" })).toBe(once);
  });

  it("applying an import records ids of the created tasks, class and semester on its history record", () => {
    const { next } = apply(stateWith(), { id: "sem-fall", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [] });
    const record = next.syllabusImports![0]!;
    expect(record.createdTaskIds).toHaveLength(6);
    expect(record.createdClassId).toBe("class-import-1");
    expect(record).toMatchObject({ semesterSetId: "sem-fall", semesterBefore: null });
    expect(record.itemCount).toBe(6);
  });
});

describe("import through the reducer (one atomic step)", () => {
  it("sets the semester through SET_SEMESTER (validation + profile label) in the same action as the tasks", () => {
    const pipeline = extractLikeServer(WEEKLY_FIXTURE, WEEKLY_TODAY);
    const { after, semester } = importFresh(stateWith(), pipeline, { now: WEEKLY_NOW, today: WEEKLY_TODAY, importId: "import-w", semesterId: "sem-spring" });
    const built = reducer(stateWith(), {
      type: "APPLY_SYLLABUS_IMPORT",
      payload: {
        ...buildSyllabusImport({
          now: WEEKLY_NOW, today: WEEKLY_TODAY, importId: "import-w", drafts: pipeline.drafts,
          course: prefillBasics(pipeline.extraction.course), target: { kind: "new" },
          existing: { classes: [], tasks: [] }, semester, source: "file", newClassId: "class-w",
        }).payload,
      },
    });
    expect(built.semester).toEqual(semester);
    expect(built.user?.currentSemester).toBe("Spring 2027");
    expect(built.tasks.length).toBe(after.tasks.length);
    expect(built.tasks.length).toBeGreaterThan(0);
    expect(importableDrafts(pipeline.drafts).length).toBe(built.tasks.length);
  });

  it("an invalid semester is ignored by SET_SEMESTER but the tasks are still imported", () => {
    const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
    const built = buildSyllabusImport({
      now: NOW, today: EXPLICIT_TODAY, importId: "import-x", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "new" },
      existing: { classes: [], tasks: [] }, semester: { id: "bad", name: "Bad", startDate: "2026-12-11", endDate: "2026-08-24", breaks: [] }, source: "paste",
    });
    const next = reducer(stateWith(), { type: "APPLY_SYLLABUS_IMPORT", payload: built.payload });
    expect(next.tasks.length).toBe(6);
    expect(next.semester).toBeUndefined();
    expect(next.syllabusImports![0]!.semesterSetId).toBeUndefined();
  });
});
