import { describe, expect, it } from "vitest";
import {
  assessTerm,
  bucketDrafts,
  buildDraftItems,
  buildStrategyRequest,
  buildSyllabusImport,
  applySyllabusImport,
  composeClassName,
  decideSemester,
  importableDrafts,
  isValidMeeting,
  kindFromSyllabusType,
  normalizeItemName,
  normalizeStrategyResponse,
  partitionDuplicates,
  prefillBasics,
  requestStrategyWithFallback,
  reresolveDrafts,
  setDraftDate,
  STRATEGY_MAX_TASKS,
  TERM_END_TOLERANCE_DAYS,
  TERM_START_TOLERANCE_DAYS,
  undoSyllabusImport,
  type DraftItem,
  type StrategyRequest,
} from "../../src/engine/syllabus-import";
import { computePriorityScore, gradeWeightBonus, MAX_GRADE_WEIGHT_BONUS } from "../../src/engine/priority-engine";
import { findBestClassMatch } from "../../src/engine/course-matcher";
import { courseShortName, normalizeShortName } from "../../src/engine/week-layout";
import type { ClassBlock, Semester, Task } from "../../src/engine/types";
import {
  baseState,
  EXPLICIT_FIXTURE,
  EXPLICIT_NOW,
  EXPLICIT_TODAY,
  extractLikeServer,
  importFresh,
  WEEKLY_FIXTURE,
  WEEKLY_TODAY,
} from "./syllabus-fixtures";

const TERM: Semester = { id: "sem-1", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [] };

function existingTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-old",
    name: "Homework 2",
    courseId: "class-chem",
    courseName: "CHEM 201: Organic Chemistry",
    dueDate: "2026-09-25",
    estimatedMinutes: 30,
    difficulty: 1,
    requiresOnCampus: false,
    status: "pending",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("kindFromSyllabusType", () => {
  it("maps each syllabus type to the planner's task kind so 'Practice Test' labels only reach exams and quizzes", () => {
    expect(kindFromSyllabusType("exam")).toBe("exam");
    expect(kindFromSyllabusType("quiz")).toBe("quiz");
    expect(kindFromSyllabusType("project")).toBe("project");
    expect(kindFromSyllabusType("reading")).toBe("reading");
    expect(kindFromSyllabusType("assignment")).toBe("assignment");
    expect(kindFromSyllabusType("other")).toBe("other");
    expect(kindFromSyllabusType("EXAM")).toBe("exam");
    expect(kindFromSyllabusType("")).toBe("other");
    expect(kindFromSyllabusType("midterm-ish")).toBe("other");
  });
});

describe("normalizeItemName / duplicate detection", () => {
  it("treats case, punctuation, accents, zero padding and common abbreviations as the same name", () => {
    const same = ["Homework 3", "HOMEWORK 3", "homework #3", "Homework-3", "HW 03", "hw3".replace("hw3", "hw 3"), "  Homework   3 ", "Homewörk 3".replace("ö", "o")];
    const keys = new Set(same.map(normalizeItemName));
    expect(keys.size).toBe(1);
    expect(normalizeItemName("Mid-term Exam")).toBe(normalizeItemName("Midterm exam"));
    expect(normalizeItemName("Problem Set 4")).toBe(normalizeItemName("PSet 4"));
    expect(normalizeItemName("Quiz #2")).toBe("quiz 2");
  });

  it("different numbers or words are NOT the same name", () => {
    expect(normalizeItemName("Homework 3")).not.toBe(normalizeItemName("Homework 13"));
    expect(normalizeItemName("Quiz 1")).not.toBe(normalizeItemName("Quiz 2"));
    expect(normalizeItemName("Midterm")).not.toBe(normalizeItemName("Final"));
  });

  function drafts(): DraftItem[] {
    const p = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
    return p.drafts;
  }

  it("finds an existing task by normalised name + date + course, even when the id or wording differs", () => {
    const all = drafts();
    const hw2 = all.find((d) => d.name === "Homework 2")!;
    const renamed = { ...hw2, name: "HW #02" };
    const importable = importableDrafts([renamed]);
    const result = partitionDuplicates(importable, [existingTask()], { id: "class-chem", name: "CHEM 201: Organic Chemistry" });
    expect(result.duplicates).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
    expect(result.duplicates[0]!.existing.id).toBe("t-old");
  });

  it("does not match a task with a different date or a different course", () => {
    const hw2 = drafts().find((d) => d.name === "Homework 2")!;
    const course = { id: "class-chem", name: "CHEM 201: Organic Chemistry" };
    expect(partitionDuplicates([hw2], [existingTask({ dueDate: "2026-09-26" })], course).duplicates).toHaveLength(0);
    expect(partitionDuplicates([hw2], [existingTask({ courseId: "class-bio", courseName: "Biology" })], course).duplicates).toHaveLength(0);
  });

  it("recognises the same course by name when the class id changed", () => {
    const hw2 = drafts().find((d) => d.name === "Homework 2")!;
    const result = partitionDuplicates([hw2], [existingTask({ courseId: "old-id" })], { id: "class-new", name: "chem 201 organic chemistry".replace("chem 201 organic chemistry", "CHEM 201: Organic Chemistry") });
    expect(result.duplicates).toHaveLength(1);
  });

  it("drops a repeat inside the same batch (the model listed it twice) and keeps the first", () => {
    const hw2 = drafts().find((d) => d.name === "Homework 2")!;
    const twin = { ...hw2, id: "run1-99", name: "homework 2" };
    const result = partitionDuplicates([hw2, twin], [], { id: "c", name: "x" });
    expect(result.fresh.map((d) => d.id)).toEqual([hw2.id]);
    expect(result.repeated.map((d) => d.id)).toEqual(["run1-99"]);
  });
});

describe("draft items: nothing fabricated, nothing dropped", () => {
  const { drafts } = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
  const byName = (name: string) => drafts.find((d) => d.name === name)!;

  it("keeps every item the model listed", () => {
    expect(drafts).toHaveLength(9);
  });

  it("dated upcoming items start checked; past, undated and impossible-date items start unchecked", () => {
    expect(byName("Homework 2")).toMatchObject({ dueDate: "2026-09-25", selected: true, isPast: false });
    expect(byName("Lab Report 1")).toMatchObject({ dueDate: "2026-10-09", dateConfidence: "inferred", selected: true });
    expect(byName("Homework 1")).toMatchObject({ dueDate: "2026-09-04", isPast: true, selected: false });
    expect(byName("Final Exam")).toMatchObject({ dueDate: null, selected: false });
    expect(byName("Bonus Assignment")).toMatchObject({ dueDate: null, selected: false, problem: "impossible-date" });
  });

  it("buckets into groups by type, a 'needs a date' bucket and a collapsed past group", () => {
    const buckets = bucketDrafts(drafts, EXPLICIT_TODAY);
    expect(buckets.needsDate.map((d) => d.name).sort()).toEqual(["Bonus Assignment", "Final Exam"]);
    expect(buckets.past.map((d) => d.name)).toEqual(["Homework 1"]);
    expect(buckets.groups.map((g) => g.type)).toEqual(["exam", "quiz", "project", "assignment"]);
    expect(buckets.groups.find((g) => g.type === "assignment")!.items.map((d) => d.name)).toEqual(["Homework 2", "Lab Report 1", "Problem Set 5"]);
  });

  it("an item due today is upcoming, not past", () => {
    const local = buildDraftItems(
      extractLikeServer(JSON.stringify({ course: { name: "X", termStart: "2026-08-24", termEnd: "2026-12-11" }, items: [{ name: "Due today", type: "assignment", dueDate: "2026-09-20", dateConfidence: "explicit" }] }), EXPLICIT_TODAY).items,
      { today: EXPLICIT_TODAY, idPrefix: "x" },
    );
    expect(local[0]).toMatchObject({ isPast: false, selected: true });
  });

  it("the student supplies a date for a 'needs a date' item: it is accepted, marked as theirs, and checked", () => {
    const result = setDraftDate(byName("Final Exam"), "2026-12-09", { today: EXPLICIT_TODAY, termStart: "2026-08-24", termEnd: "2026-12-11" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({ dueDate: "2026-12-09", dateConfidence: "user", dateSource: "user", selected: true, dateEdited: true, problem: null });
  });

  it("a made-up date is refused, and the item keeps no date", () => {
    for (const bad of ["2026-02-30", "soon", "12/09/2026", "2026-13-01"]) {
      const result = setDraftDate(byName("Final Exam"), bad, { today: EXPLICIT_TODAY });
      expect(result.ok).toBe(false);
    }
    expect(byName("Final Exam").dueDate).toBeNull();
  });

  it("clearing a date returns the item to 'needs a date' and unchecks it", () => {
    const dated = setDraftDate(byName("Final Exam"), "2026-12-09", { today: EXPLICIT_TODAY });
    if (!dated.ok) throw new Error("expected ok");
    const cleared = setDraftDate(dated.draft, "", { today: EXPLICIT_TODAY });
    expect(cleared.ok && cleared.draft).toMatchObject({ dueDate: null, selected: false });
  });

  it("flags a student-entered date outside the term, without changing it", () => {
    const result = setDraftDate(byName("Final Exam"), "2027-02-01", { today: EXPLICIT_TODAY, termStart: "2026-08-24", termEnd: "2026-12-11" });
    expect(result.ok && result.draft).toMatchObject({ dueDate: "2027-02-01", outOfRange: "after-term" });
  });

  it("re-resolving after the student corrects the term moves week-based dates but never touches typed dates or their checkboxes", () => {
    const weekly = extractLikeServer(WEEKLY_FIXTURE, WEEKLY_TODAY);
    const essay = weekly.drafts.find((d) => d.name === "Essay 1")!;
    expect(essay.dueDate).toBe("2027-02-12"); // Week 5 Fri of a term starting Mon 2027-01-11
    let drafts = weekly.drafts;
    const typed = setDraftDate(drafts.find((d) => d.name === "Final Exam")!, "2027-05-05", { today: WEEKLY_TODAY });
    if (!typed.ok) throw new Error("expected ok");
    drafts = drafts.map((d) => (d.name === "Final Exam" ? typed.draft : d.name === "Essay 2" ? { ...d, selected: false, selectionTouched: true } : d));

    const later = reresolveDrafts(drafts, { today: WEEKLY_TODAY, termStart: "2027-01-18", termEnd: "2027-05-14" });
    expect(later.find((d) => d.name === "Essay 1")!.dueDate).toBe("2027-02-19"); // one week later
    expect(later.find((d) => d.name === "Final Exam")).toMatchObject({ dueDate: "2027-05-05", dateConfidence: "user" });
    expect(later.find((d) => d.name === "Essay 2")).toMatchObject({ selected: false }); // the student unchecked it: stays unchecked
    expect(later.find((d) => d.name === "Essay 1")!.selected).toBe(true);
  });

  it("a week-only item stays undated with a range to pick from (nothing is chosen for the student)", () => {
    const weekly = extractLikeServer(WEEKLY_FIXTURE, WEEKLY_TODAY);
    const presentation = weekly.drafts.find((d) => d.name === "Group Presentation")!;
    expect(presentation.dueDate).toBeNull();
    expect(presentation.weekHint).toEqual({ start: "2027-04-12", end: "2027-04-18" });
    expect(presentation.selected).toBe(false);
  });
});

describe("term assessment and semester decision", () => {
  const range = { start: "2026-08-24", end: "2026-12-11", breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] };

  it("no semester on file: the syllabus proposes one; it is created only when the student confirms dates", () => {
    const a = assessTerm({ existing: undefined, ...range });
    expect(a.mode).toBe("new");
    const outcome = decideSemester(a, { action: "create", start: "2026-08-24", end: "2026-12-11" }, { includeBreaks: true, newId: "sem-x" });
    expect(outcome).toMatchObject({ ok: true, changed: true, before: null });
    if (!outcome.ok) return;
    expect(outcome.semester).toEqual({ id: "sem-x", name: "Fall 2026", startDate: "2026-08-24", endDate: "2026-12-11", breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] });
  });

  it("breaks are only added when the student wants them", () => {
    const a = assessTerm({ existing: undefined, ...range });
    const outcome = decideSemester(a, { action: "create", start: "2026-08-24", end: "2026-12-11" }, { includeBreaks: false, newId: "s" });
    expect(outcome.ok && outcome.semester?.breaks).toEqual([]);
  });

  it("rejects a semester the planner would reject (end before start, unreal dates)", () => {
    const a = assessTerm({ existing: undefined, ...range });
    expect(decideSemester(a, { action: "create", start: "2026-12-11", end: "2026-08-24" }, { includeBreaks: false }).ok).toBe(false);
    expect(decideSemester(a, { action: "create", start: "2026-02-30", end: "2026-12-11" }, { includeBreaks: false }).ok).toBe(false);
  });

  it("a semester on file that the syllabus agrees with is kept (small differences in the last day of class are tolerated)", () => {
    const a = assessTerm({ existing: TERM, start: "2026-08-26", end: "2026-12-04", breaks: [] });
    expect(a.mode).toBe("agree");
    const kept = decideSemester(a, { action: "keep" }, { includeBreaks: true });
    expect(kept).toMatchObject({ ok: true, changed: false });
  });

  it("adds new breaks from the syllabus to the semester on file, once, without duplicating known ones", () => {
    const withBreak: Semester = { ...TERM, breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] };
    const a = assessTerm({ existing: withBreak, start: "2026-08-24", end: "2026-12-11", breaks: [...range.breaks, { name: "Fall Break", startDate: "2026-10-12", endDate: "2026-10-13" }] });
    expect(a.newBreaks.map((b) => b.name)).toEqual(["Fall Break"]);
    const out = decideSemester(a, { action: "keep" }, { includeBreaks: true });
    expect(out.ok && out.changed).toBe(true);
    expect(out.ok && out.semester?.breaks.map((b) => b.name)).toEqual(["Fall Break", "Thanksgiving"]);
    const again = assessTerm({ existing: out.ok ? out.semester : null, start: "2026-08-24", end: "2026-12-11", breaks: a.newBreaks });
    expect(again.newBreaks).toEqual([]);
  });

  it("a syllabus that disagrees is a conflict: keep or replace is the student's call", () => {
    const a = assessTerm({ existing: TERM, start: "2027-01-11", end: "2027-05-07", breaks: [] });
    expect(a.mode).toBe("conflict");
    const keep = decideSemester(a, { action: "keep" }, { includeBreaks: true });
    expect(keep).toMatchObject({ ok: true, changed: false });
    const replace = decideSemester(a, { action: "replace" }, { includeBreaks: true });
    expect(replace.ok && replace.semester).toMatchObject({ id: "sem-1", startDate: "2027-01-11", endDate: "2027-05-07" });
    expect(replace.ok && replace.before).toEqual(TERM);
  });

  it("the tolerances are exactly what they say", () => {
    const at = (s: string, e: string) => assessTerm({ existing: TERM, start: s, end: e, breaks: [] }).mode;
    expect(at("2026-09-03", "2026-12-11")).toBe("agree"); // +10 days
    expect(at("2026-09-04", "2026-12-11")).toBe("conflict"); // +11 days
    expect(at("2026-08-24", "2027-01-01")).toBe("agree"); // +21 days
    expect(at("2026-08-24", "2027-01-02")).toBe("conflict"); // +22 days
    expect([TERM_START_TOLERANCE_DAYS, TERM_END_TOLERANCE_DAYS]).toEqual([10, 21]);
  });

  it("a syllabus silent about the term agrees with the one on file", () => {
    expect(assessTerm({ existing: TERM, start: null, end: null, breaks: [] }).mode).toBe("agree");
  });

  it("replace drops old breaks that fall outside the new dates instead of failing", () => {
    const withBreak: Semester = { ...TERM, breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] };
    const a = assessTerm({ existing: withBreak, start: "2026-08-24", end: "2026-11-13", breaks: [] });
    const out = decideSemester({ ...a, mode: "conflict" }, { action: "replace" }, { includeBreaks: false });
    expect(out.ok && out.semester?.breaks).toEqual([]);
  });

  it("skip leaves the semester exactly as it was", () => {
    const a = assessTerm({ existing: undefined, ...range });
    expect(decideSemester(a, { action: "skip" }, { includeBreaks: true })).toEqual({ ok: true, changed: false, semester: null, before: null });
  });
});

describe("prefillBasics / meeting helpers", () => {
  it("prefills meeting days, times and location from the extraction so the student only verifies", () => {
    const { extraction } = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
    expect(prefillBasics(extraction.course)).toMatchObject({
      name: "Organic Chemistry",
      code: "CHEM 201",
      isAsynchronous: false,
      days: ["Tue", "Thu"],
      startTime: "09:30",
      endTime: "10:45",
      location: "Science Hall 12",
      missingMeeting: false,
    });
  });

  it("flags a missing meeting pattern and lets an existing class fill the gaps", () => {
    const course = { name: "X", code: "", isAsynchronous: false, meetingPattern: null };
    expect(prefillBasics(course).missingMeeting).toBe(true);
    const linked: ClassBlock = { id: "c", name: "X", days: ["Mon"], startTime: "10:00", endTime: "11:00", color: "#fff" };
    expect(prefillBasics(course, linked)).toMatchObject({ days: ["Mon"], startTime: "10:00", missingMeeting: false });
  });

  it("an asynchronous course needs no meeting time", () => {
    expect(prefillBasics({ name: "Online Ethics", code: "", isAsynchronous: true, meetingPattern: null })).toMatchObject({ isAsynchronous: true, days: [], missingMeeting: false });
  });

  it("validates meetings and composes class names", () => {
    expect(isValidMeeting(["Mon"], "09:00", "10:00")).toBe(true);
    expect(isValidMeeting([], "09:00", "10:00")).toBe(false);
    expect(isValidMeeting(["Mon"], "10:00", "09:00")).toBe(false);
    expect(isValidMeeting(["Mon"], "", "09:00")).toBe(false);
    expect(composeClassName("Organic Chemistry", "CHEM 201")).toBe("CHEM 201: Organic Chemistry");
    expect(composeClassName("CHEM 201: Organic Chemistry", "chem 201")).toBe("CHEM 201: Organic Chemistry");
    expect(composeClassName("", "CHEM 201")).toBe("CHEM 201");
    expect(composeClassName("Ethics", "")).toBe("Ethics");
  });
});

describe("buildSyllabusImport", () => {
  const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);

  it("creates one class (with its meeting pattern, without the syllabus's grade weights) and tasks only for dated, checked items", () => {
    const { built } = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY });
    const { payload, counts } = built;
    expect(payload.classToCreate).toMatchObject({
      id: "class-test",
      name: "CHEM 201: Organic Chemistry",
      days: ["Tue", "Thu"],
      startTime: "09:30",
      endTime: "10:45",
      location: "Science Hall 12",
    });
    // The grading table the syllabus gave is not stored on the class: there is no grade tracking. (What each item
    // counts for still reaches its task, as weightPercent.)
    expect(pipeline.extraction.course.gradeWeights.map((w) => [w.name, w.weightPercent])).toEqual([["Exams", 45], ["Homework", 25], ["Research paper", 20], ["Quizzes", 10]]);
    expect(payload.classToCreate).not.toHaveProperty("gradeComponents");
    expect(payload.tasks.map((t) => t.name).sort()).toEqual(["Homework 2", "Lab Report 1", "Midterm Exam", "Problem Set 5", "Quiz 1", "Research Paper"]);
    expect(counts).toMatchObject({ added: 6, excludedUndated: 2, excludedPast: 1, skippedDuplicates: 0, overwritten: 0 });
  });

  it("never fabricates a date: an undated item (Final Exam, Feb 30) is not imported and no task has an invented date", () => {
    const { built } = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY });
    const names = built.payload.tasks.map((t) => t.name);
    expect(names).not.toContain("Final Exam");
    expect(names).not.toContain("Bonus Assignment");
    for (const task of built.payload.tasks) expect(task.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // the date on each task is the one the document gave (or the year inferred for a month/day)
    const lab = built.payload.tasks.find((t) => t.name === "Lab Report 1")!;
    expect(lab).toMatchObject({ dueDate: "2026-10-09", dateConfidence: "inferred", dateEvidence: "Lab report 1 due Oct 9" });
  });

  it("a student-entered date makes the undated item importable, marked as the student's own", () => {
    const final = pipeline.drafts.find((d) => d.name === "Final Exam")!;
    const typed = setDraftDate(final, "2026-12-09", { today: EXPLICIT_TODAY });
    if (!typed.ok) throw new Error("expected ok");
    const drafts = pipeline.drafts.map((d) => (d.id === final.id ? typed.draft : d));
    const { built } = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY, drafts });
    expect(built.payload.tasks.find((t) => t.name === "Final Exam")).toMatchObject({ dueDate: "2026-12-09", dateConfidence: "user", kind: "exam", weightPercent: 20 });
  });

  it("sets Task.kind from the item type and keeps weight, evidence and the import id", () => {
    const { built } = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY });
    const byName = (n: string) => built.payload.tasks.find((t) => t.name === n)!;
    expect(byName("Midterm Exam")).toMatchObject({ kind: "exam", weightPercent: 25, syllabusImportId: "import-1", status: "pending", courseId: "class-test", requiresOnCampus: false });
    expect(byName("Quiz 1").kind).toBe("quiz");
    expect(byName("Research Paper").kind).toBe("project");
    expect(byName("Homework 2").kind).toBe("assignment");
    expect(byName("Homework 2").weightPercent).toBeUndefined();
  });

  it("records the import so it can be undone: created ids, raw text and the extraction JSON", () => {
    const built = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY });
    const record = built.after.syllabusImports![0]!;
    expect(record.createdTaskIds).toHaveLength(6);
    expect(record.createdClassId).toBe("class-test");
    expect(record.semesterSetId).toBe("semester-test");
    expect(record.semesterBefore).toBeNull();
  });

  it("stores the source text and the normalised extraction on the record", () => {
    const { payload } = buildSyllabusImport({
      now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "import-2", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "new" },
      existing: { classes: [], tasks: [] }, source: "file", rawText: "THE SYLLABUS TEXT", extractionJson: "{\"ok\":true}",
    });
    expect(payload.importRecord).toMatchObject({ rawText: "THE SYLLABUS TEXT", extractionJson: "{\"ok\":true}", source: "file", isNewClass: true, itemCount: 6, excludedCount: 3 });
    expect(payload.semester).toBeUndefined();
  });

  it("links to an existing class, updating its meeting pattern only when the student changed it", () => {
    const cls: ClassBlock = { id: "class-chem", name: "CHEM 201: Organic Chemistry", days: ["Tue", "Thu"], startTime: "09:30", endTime: "10:45", location: "Science Hall 12", color: "#4F6EF7" };
    const same = buildSyllabusImport({
      now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "i", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "existing", cls }, existing: { classes: [cls], tasks: [] }, source: "paste",
    });
    expect(same.payload.classToUpdate).toBeUndefined();
    expect(same.payload.classToCreate).toBeUndefined();
    expect(same.payload.tasks.every((t) => t.courseId === "class-chem")).toBe(true);

    const changed = buildSyllabusImport({
      now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "i", drafts: pipeline.drafts,
      course: { ...prefillBasics(pipeline.extraction.course), days: ["Mon", "Wed"] }, target: { kind: "existing", cls }, existing: { classes: [cls], tasks: [] }, source: "paste",
    });
    expect(changed.payload.classToUpdate).toMatchObject({ id: "class-chem", days: ["Mon", "Wed"] });
  });

  it("saves the short name the student confirmed, only when it says more than the name already does", () => {
    const base = { now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "i", drafts: pipeline.drafts, existing: { classes: [], tasks: [] }, source: "paste" as const };
    const course = prefillBasics(pipeline.extraction.course);
    const label = composeClassName(course.name, course.code);

    const chosen = buildSyllabusImport({ ...base, course: { ...course, shortName: " chem " }, target: { kind: "new" } });
    expect(chosen.payload.classToCreate).toMatchObject({ name: label, shortName: "CHEM" });

    // Left as what the name gives anyway, or left empty: nothing is stored, so a later rename still shows through.
    const derived = buildSyllabusImport({ ...base, course: { ...course, shortName: courseShortName(label) }, target: { kind: "new" } });
    expect(derived.payload.classToCreate).not.toHaveProperty("shortName");
    const empty = buildSyllabusImport({ ...base, course, target: { kind: "new" } });
    expect(empty.payload.classToCreate).not.toHaveProperty("shortName");

    // A class the student already has: its tag changes only when they changed it, and undo puts the class back.
    const cls: ClassBlock = { id: "class-chem", name: label, days: ["Tue", "Thu"], startTime: "09:30", endTime: "10:45", location: "Science Hall 12", color: "#4F6EF7" };
    const existing = { classes: [cls], tasks: [] };
    const untouched = buildSyllabusImport({ ...base, existing, course: { ...course, shortName: courseShortName(label) }, target: { kind: "existing", cls } });
    expect(untouched.payload.classToUpdate).toBeUndefined();
    const renamed = buildSyllabusImport({ ...base, existing, course: { ...course, shortName: "ORGO" }, target: { kind: "existing", cls } });
    expect(renamed.payload.classToUpdate).toMatchObject({ id: "class-chem", shortName: "ORGO", days: ["Tue", "Thu"] });
    const state = baseState({ classes: [cls] });
    const after = applySyllabusImport(state, renamed.payload);
    expect(after.classes[0]!.shortName).toBe("ORGO");
    expect(undoSyllabusImport(after, "i").classes).toEqual([cls]);

    // A tag the student gave the class earlier is left alone when the field still shows it, and taken away again
    // when they empty the field (the tag is then made from the name).
    const tagged: ClassBlock = { ...cls, shortName: "ORGO" };
    const withTag = { classes: [tagged], tasks: [] };
    const kept = buildSyllabusImport({ ...base, existing: withTag, course: { ...course, shortName: "ORGO" }, target: { kind: "existing", cls: tagged } });
    expect(kept.payload.classToUpdate).toBeUndefined();
    const cleared = buildSyllabusImport({ ...base, existing: withTag, course: { ...course, shortName: "" }, target: { kind: "existing", cls: tagged } });
    expect(cleared.payload.classToUpdate).toMatchObject({ id: "class-chem" });
    expect(cleared.payload.classToUpdate).not.toHaveProperty("shortName");
    // A caller that says nothing about the tag changes nothing.
    expect(buildSyllabusImport({ ...base, existing: withTag, course, target: { kind: "existing", cls: tagged } }).payload.classToUpdate).toBeUndefined();

    // A class whose name gives a tag longer than the field holds: the field shows it cut to fit, and an import that
    // did not touch it must not store the cut.
    const long: ClassBlock = { ...cls, id: "class-acctg", name: "ACCTG 2301A Intermediate Accounting" };
    expect(courseShortName(long.name)).toBe("ACCTG 2301A");
    const shown = normalizeShortName(courseShortName(long.name));
    expect(shown).toBe("ACCTG 2301");
    const untouchedLong = buildSyllabusImport({ ...base, existing: { classes: [long], tasks: [] }, course: { ...course, shortName: shown }, target: { kind: "existing", cls: long } });
    expect(untouchedLong.payload.classToUpdate).toBeUndefined();
    const newLong = buildSyllabusImport({ ...base, course: { ...course, name: long.name, code: "", shortName: shown }, target: { kind: "new" } });
    expect(newLong.payload.classToCreate).not.toHaveProperty("shortName");
  });

  it("skips duplicates of existing tasks unless the student chose to overwrite them (and then keeps the original for undo)", () => {
    const cls: ClassBlock = { id: "class-chem", name: "CHEM 201: Organic Chemistry", days: ["Tue", "Thu"], startTime: "09:30", endTime: "10:45", location: "Science Hall 12", color: "#4F6EF7" };
    const state = baseState({ classes: [cls], tasks: [existingTask()] });
    const drafts = pipeline.drafts;
    const hw2 = drafts.find((d) => d.name === "Homework 2")!;
    const common = { now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "i", drafts, course: prefillBasics(pipeline.extraction.course), target: { kind: "existing", cls } as const, existing: { classes: state.classes, tasks: state.tasks }, source: "paste" as const };

    const skipped = buildSyllabusImport(common);
    expect(skipped.counts).toMatchObject({ skippedDuplicates: 1, overwritten: 0, added: 5 });
    expect(skipped.payload.tasks.map((t) => t.name)).not.toContain("Homework 2");

    const overwritten = buildSyllabusImport({ ...common, overwriteIds: new Set([hw2.id]) });
    expect(overwritten.counts).toMatchObject({ skippedDuplicates: 0, overwritten: 1, added: 5 });
    expect(overwritten.payload.taskUpdates[0]).toMatchObject({ id: "t-old", estimatedMinutes: 75, difficulty: 3, kind: "assignment" });
    const after = applySyllabusImport(state, overwritten.payload);
    expect(after.syllabusImports![0]!.overwrittenTasks).toEqual([existingTask()]);
    expect(after.tasks.find((t) => t.id === "t-old")!.estimatedMinutes).toBe(75);
  });

  it("importing the same syllabus twice adds nothing the second time", () => {
    const first = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY });
    const class1 = first.after.classes[0]!;
    const second = buildSyllabusImport({
      now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "import-2", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "existing", cls: class1 },
      existing: { classes: first.after.classes, tasks: first.after.tasks }, source: "paste",
    });
    expect(second.counts).toMatchObject({ added: 0, skippedDuplicates: 6 });
    expect(second.payload.tasks).toEqual([]);
  });

  it("a repeat inside the batch is not imported twice", () => {
    const drafts = [...pipeline.drafts, { ...pipeline.drafts.find((d) => d.name === "Quiz 1")!, id: "run1-dup", name: "quiz 1" }];
    const { built } = importFresh(baseState(), pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY, drafts });
    expect(built.payload.tasks.filter((t) => t.name.toLowerCase() === "quiz 1")).toHaveLength(1);
    expect(built.counts.repeated).toBe(1);
  });

  it("importable drafts are exactly the checked, dated ones", () => {
    expect(importableDrafts(pipeline.drafts).map((d) => d.name)).not.toContain("Homework 1");
    const forced = pipeline.drafts.map((d) => (d.name === "Homework 1" ? { ...d, selected: true } : d));
    expect(importableDrafts(forced).map((d) => d.name)).toContain("Homework 1");
    const undatedChecked = pipeline.drafts.map((d) => (d.name === "Final Exam" ? { ...d, selected: true } : d));
    expect(importableDrafts(undatedChecked).map((d) => d.name)).not.toContain("Final Exam");
  });
});

describe("the AI strategist is advisory: a failure never blocks the import", () => {
  const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
  const request = (): StrategyRequest =>
    buildStrategyRequest({
      today: EXPLICIT_TODAY,
      semester: TERM,
      userPrefs: { energyProfile: "morning", studyStyle: "deep_blocks" },
      classes: [],
      drafts: importableDrafts(pipeline.drafts),
      course: { id: "class-test", name: "CHEM 201" },
    });

  it("when the strategist call throws, the import still builds with default session plans and says so", async () => {
    const outcome = await requestStrategyWithFallback(async () => { throw new Error("gemini is down"); }, request());
    expect(outcome.unavailable).toBe(true);
    expect(outcome.strategies.size).toBe(0);

    const { payload } = buildSyllabusImport({
      now: EXPLICIT_NOW, today: EXPLICIT_TODAY, importId: "i", drafts: pipeline.drafts,
      course: prefillBasics(pipeline.extraction.course), target: { kind: "new" }, existing: { classes: [], tasks: [] },
      strategies: outcome.strategies, strategyUnavailable: outcome.unavailable, source: "paste",
    });
    expect(payload.tasks).toHaveLength(6);
    expect(payload.tasks.every((t) => t.planningStrategy === undefined)).toBe(true);
    expect(payload.importRecord.strategyUnavailable).toBe(true);
  });

  it("garbage from the strategist also falls back safely", async () => {
    for (const junk of [null, "text", 5, {}, { taskPlans: "nope" }, { taskPlans: [null, 3, { taskId: "unknown", sessions: [] }] }]) {
      const outcome = await requestStrategyWithFallback(async () => junk, request());
      expect(outcome.strategies.size).toBe(0);
    }
  });

  it("uses a good plan, clamping values, dropping unknown ids and implausible totals", async () => {
    const req = request();
    const target = req.tasks.find((t) => t.name === "Midterm Exam")!;
    const other = req.tasks.find((t) => t.name === "Quiz 1")!;
    const response = {
      planSummary: "ok",
      taskPlans: [
        { taskId: target.id, rationale: "Space it out", priority: 9, sessions: [
          { label: "Preview", purpose: "preview", minutes: 100, earliestDaysBeforeDue: 14, targetDaysBeforeDue: 10 },
          { label: "Practice", purpose: "not-a-purpose", minutes: 999, earliestDaysBeforeDue: 5, targetDaysBeforeDue: 9 },
        ] },
        { taskId: other.id, rationale: "Way too little", priority: 2, sessions: [{ label: "x", purpose: "learn", minutes: 15, earliestDaysBeforeDue: 1, targetDaysBeforeDue: 1 }] },
        { taskId: "ghost", rationale: "not asked", priority: 3, sessions: [{ label: "x", purpose: "learn", minutes: 60, earliestDaysBeforeDue: 1, targetDaysBeforeDue: 1 }] },
      ],
      warnings: [{ severity: "info", taskId: "", message: "fyi" }, { severity: "warning", taskId: "", message: "Three exams in one week" }],
    };
    const outcome = await requestStrategyWithFallback(async () => response, req);
    expect(outcome.unavailable).toBe(false);
    expect([...outcome.strategies.keys()]).toEqual([target.id]);
    const plan = outcome.strategies.get(target.id)!;
    expect(plan.priority).toBe(5);
    expect(plan.sessions).toEqual([
      { label: "Preview", purpose: "preview", minutes: 100, earliestDaysBeforeDue: 14, targetDaysBeforeDue: 10 },
      { label: "Practice", purpose: "learn", minutes: 240, earliestDaysBeforeDue: 5, targetDaysBeforeDue: 5 },
    ]);
    expect(outcome.warnings).toEqual(["Three exams in one week"]);
  });

  it("the request carries the semester range and breaks and respects the endpoint's bounds", () => {
    const req = buildStrategyRequest({
      today: EXPLICIT_TODAY,
      semester: { ...TERM, breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] },
      userPrefs: { energyProfile: "night", studyStyle: "short_bursts" },
      classes: [],
      drafts: importableDrafts(pipeline.drafts),
      course: { id: "c", name: "CHEM" },
    });
    expect(req).toMatchObject({ semesterStart: "2026-08-24", semesterEnd: "2026-12-11", breaks: [{ name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" }] });
    const midterm = req.tasks.find((t) => t.name === "Midterm Exam")!;
    expect(midterm).toMatchObject({ type: "exam", weightPercent: 25, estimatedMinutes: 240 });

    const many = Array.from({ length: 200 }, (_, i) => ({ ...pipeline.drafts[1]!, id: `d-${i}`, name: `Homework ${i}` }));
    const big = buildStrategyRequest({ today: EXPLICIT_TODAY, semester: undefined, userPrefs: { energyProfile: "morning", studyStyle: "deep_blocks" }, classes: [], drafts: many, course: { id: "c", name: "x".repeat(400) } });
    expect(big.tasks).toHaveLength(STRATEGY_MAX_TASKS);
    expect(big.tasks[0]!.courseName.length).toBe(300);
    expect(big.semesterStart).toBeUndefined();
  });

  it("normalizeStrategyResponse tolerates non-objects", () => {
    expect(normalizeStrategyResponse(undefined, []).strategies.size).toBe(0);
  });
});

describe("grade weights in scoring (modest and additive)", () => {
  const NOW = new Date(2026, 8, 20, 12, 0, 0);
  const task = (overrides: Partial<Task> = {}): Task => ({
    id: "t", name: "Paper", courseId: "c", courseName: "C", dueDate: "2026-10-20", estimatedMinutes: 120, difficulty: 3,
    requiresOnCampus: false, status: "pending", createdAt: NOW.toISOString(), ...overrides,
  });

  it("a task with no weight scores exactly as before", () => {
    expect(computePriorityScore(task(), NOW)).toBe(computePriorityScore(task({ weightPercent: undefined }), NOW));
    expect(gradeWeightBonus({})).toBe(0);
  });

  it("a heavier task scores higher than an identical lighter one, by at most the cap", () => {
    const plain = computePriorityScore(task(), NOW);
    const light = computePriorityScore(task({ weightPercent: 5 }), NOW);
    const heavy = computePriorityScore(task({ weightPercent: 30 }), NOW);
    expect(light).toBe(plain + 1);
    expect(heavy).toBe(plain + MAX_GRADE_WEIGHT_BONUS);
    expect(heavy - plain).toBeLessThanOrEqual(MAX_GRADE_WEIGHT_BONUS);
  });

  it("a big weight never outranks a closer deadline (the bonus is smaller than a deadline bucket)", () => {
    const soon = computePriorityScore(task({ dueDate: "2026-09-22" }), NOW);
    const farHeavy = computePriorityScore(task({ dueDate: "2026-10-20", weightPercent: 100 }), NOW);
    expect(soon).toBeGreaterThan(farHeavy);
  });

  it("ignores nonsense weights and never exceeds 100", () => {
    expect(gradeWeightBonus({ weightPercent: -5 })).toBe(0);
    expect(gradeWeightBonus({ weightPercent: Number.NaN })).toBe(0);
    expect(gradeWeightBonus({ weightPercent: 5000 })).toBe(MAX_GRADE_WEIGHT_BONUS);
    expect(computePriorityScore(task({ dueDate: "2026-09-20", difficulty: 5, importance: 3, estimatedMinutes: 480, weightPercent: 100 }), NOW)).toBeLessThanOrEqual(100);
  });
});

describe("course matching by course code", () => {
  const classes: ClassBlock[] = [
    { id: "a", name: "Organic Chemistry (CHEM 201)", days: [], startTime: "", endTime: "", color: "#000" },
    { id: "b", name: "Intro to Biology", days: [], startTime: "", endTime: "", color: "#000" },
  ];

  it("matches a class that carries the same course code even when the titles are worded differently", () => {
    const match = findBestClassMatch("Elements of Carbon Compounds", classes, "chem-201");
    expect(match).toMatchObject({ isConfident: true, score: 1 });
    expect(match.matchedClass?.id).toBe("a");
  });

  it("finds the code inside the course name too", () => {
    expect(findBestClassMatch("CHEM201 Lab & Lecture", classes).matchedClass?.id).toBe("a");
  });

  it("a different course number is not a match by code", () => {
    expect(findBestClassMatch("Advanced Compounds", classes, "CHEM 2010").matchedClass).toBeNull();
    expect(findBestClassMatch("Advanced Compounds", classes, "CHEM 301").matchedClass).toBeNull();
  });

  it("still matches by name when no code is present", () => {
    expect(findBestClassMatch("Organic Chemistry", classes).matchedClass?.id).toBe("a");
  });
});

describe("undo of a plain import (pure)", () => {
  it("removes the import's tasks, class, semester and record", () => {
    const before = baseState();
    const pipeline = extractLikeServer(EXPLICIT_FIXTURE, EXPLICIT_TODAY);
    const { after } = importFresh(before, pipeline, { now: EXPLICIT_NOW, today: EXPLICIT_TODAY });
    expect(after.tasks).toHaveLength(6);
    const undone = undoSyllabusImport(after, "import-1");
    expect(undone).toEqual(before);
    expect(undone.semester).toBeUndefined();
  });

  it("an unknown import id changes nothing", () => {
    const state = baseState();
    expect(undoSyllabusImport(state, "nope")).toBe(state);
  });
});
