import { describe, expect, it } from "vitest";
import { buildVerifiedClassFromSyllabus } from "../../src/engine/course-matcher";
import { buildSyllabusImport, prefillBasics } from "../../src/engine/syllabus-import";
import { EXPLICIT_FIXTURE, EXPLICIT_NOW, EXPLICIT_TODAY, extractLikeServer } from "./syllabus-fixtures";

// Behavioural version of the old source-text policy checks: what the intake must guarantee before it plans.
describe("syllabus intake policy", () => {
  const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
  const base = {
    now: EXPLICIT_NOW,
    today: EXPLICIT_TODAY,
    importId: "i",
    drafts: pipeline.drafts,
    target: { kind: "new" } as const,
    existing: { classes: [], tasks: [] },
    source: "paste" as const,
  };
  const basics = prefillBasics(pipeline.extraction.course);

  it("builds a class only from the verified meeting pattern the student confirmed", () => {
    const cls = buildVerifiedClassFromSyllabus("CHEM 201", 0, { days: ["Tue", "Thu"], startTime: "09:30", endTime: "10:45", location: " Hall 1 ", isAsynchronous: false });
    expect(cls).toMatchObject({ name: "CHEM 201", days: ["Tue", "Thu"], startTime: "09:30", location: "Hall 1" });
    expect(cls.isAsynchronous).toBeUndefined();
  });

  it("refuses to plan a class with no meeting days, or one that ends before it starts, unless it is asynchronous", () => {
    expect(() => buildSyllabusImport({ ...base, course: { ...basics, days: [] } })).toThrow(/meeting days and times/);
    expect(() => buildSyllabusImport({ ...base, course: { ...basics, startTime: "11:00", endTime: "10:00" } })).toThrow(/meeting days and times/);
    expect(() => buildSyllabusImport({ ...base, course: { ...basics, startTime: "", endTime: "" } })).toThrow();
    const asynchronous = buildSyllabusImport({ ...base, course: { ...basics, isAsynchronous: true, days: [], startTime: "", endTime: "" } });
    expect(asynchronous.payload.classToCreate).toMatchObject({ days: [], startTime: "", endTime: "", isAsynchronous: true });
  });

  it("class, tasks, semester and history record travel in ONE payload (one atomic reducer transaction)", () => {
    const { payload } = buildSyllabusImport({ ...base, course: basics });
    expect(Object.keys(payload).sort()).toEqual(["classToCreate", "importRecord", "taskUpdates", "tasks"]);
    expect(payload.tasks.every((t) => t.courseId === payload.classToCreate!.id)).toBe(true);
    expect(payload.importRecord.linkedClassId).toBe(payload.classToCreate!.id);
  });
});
