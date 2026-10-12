import { describe, expect, it } from "vitest";

import { resolveCourseTerm, resolveExtractedItems } from "../../src/engine/syllabus-extraction-utils";
import { readingOfResult } from "../../src/lib/syllabus-result";

// What server/syllabus-extract.ts runSyllabusExtraction answers: the extraction's fields at the top level, every item
// carrying the date it resolved beside the one the document reported.
const SERVER_ANSWER = {
  courseName: "FINC 3100: Principles of Finance",
  course: {
    name: "Principles of Finance",
    code: "FINC 3100",
    instructor: "Dr. Rivers",
    isAsynchronous: false,
    meetingPattern: { days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "10:50", location: "Hayes 204" },
    termStart: "2026-08-24",
    termEnd: "2026-12-04",
    lastClassDate: null,
    gradeWeights: [],
    breaks: [{ name: "Fall break", startDate: "2026-10-12", endDate: "2026-10-13", uncertain: false }],
    breakCandidates: [],
  },
  items: [
    { name: "Problem Set 1", type: "assignment", dueDate: "2026-09-14", dueTime: "23:59", weekNumber: null, weekday: null, dateEvidence: "Sept 14 – Problem Set 1 due", dateConfidence: "explicit", estimatedMinutes: 60, difficulty: 2, weightPercent: null, coversTopics: [], notes: "", resolved: { dueDate: "2026-09-14", source: "explicit", confidence: "explicit", isUndated: false, isPast: false, outOfRange: null, inBreak: null, problem: null, weekHint: null } },
    { name: "Midterm Exam", type: "exam", dueDate: "2026-10-19", dueTime: null, weekNumber: null, weekday: null, dateEvidence: "October 19 Midterm", dateConfidence: "explicit", estimatedMinutes: 180, difficulty: 4, weightPercent: 25, coversTopics: ["Ch 1-5"], notes: "", resolved: { dueDate: "2026-10-19", source: "explicit", confidence: "explicit", isUndated: false, isPast: false, outOfRange: null, inBreak: null, problem: null, weekHint: null } },
  ],
  count: 2,
  undatedCount: 0,
  pastCount: 0,
  warnings: ["Office hours were not read."],
  truncated: false,
  term: { start: "2026-08-24", end: "2026-12-04", source: "syllabus" },
  rawText: "FINC 3100 ... the whole syllabus",
};

// The loosely typed answer (src/lib/api.ts) and the browser test's mock: the extraction under `extraction`.
const WRAPPED_ANSWER = {
  count: 1,
  extraction: {
    course: { name: "Mock Course", code: null, meetingDays: [], startTime: null, endTime: null, location: null, instructor: null },
    items: [{ name: "Quiz 1", type: "quiz", dueDate: "2026-11-03", dueTime: null, dateText: "2026-11-03", dateConfidence: "explicit", dateEvidence: "Quiz 1 - 2026-11-03", weightPercent: null, notes: null }],
    term: null,
    warnings: [],
  },
};

describe("the server's answer becomes the engine's extraction", () => {
  it("reads the server's own shape: the course, every item, the warnings, the text and the count", () => {
    const reading = readingOfResult(SERVER_ANSWER)!;
    expect(reading).not.toBeNull();
    expect(reading.count).toBe(2);
    expect(reading.courseName).toBe("FINC 3100: Principles of Finance");
    expect(reading.rawText).toBe("FINC 3100 ... the whole syllabus");
    expect(reading.extraction.course).toMatchObject({ name: "Principles of Finance", code: "FINC 3100", termStart: "2026-08-24", termEnd: "2026-12-04" });
    expect(reading.extraction.course.meetingPattern).toEqual({ days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "10:50", location: "Hayes 204" });
    expect(reading.extraction.course.breaks).toEqual([{ name: "Fall break", startDate: "2026-10-12", endDate: "2026-10-13", uncertain: false }]);
    expect(reading.extraction.items.map((item) => item.name)).toEqual(["Problem Set 1", "Midterm Exam"]);
    expect(reading.extraction.items[1]).toMatchObject({ type: "exam", weightPercent: 25, coversTopics: ["Ch 1-5"], dueTime: null });
    expect(reading.extraction.warnings).toEqual(["Office hours were not read."]);
    expect(reading.extraction.truncated).toBe(false);
  });

  it("resolving the dates again on this side gives the dates the server gave", () => {
    const { extraction } = readingOfResult(SERVER_ANSWER)!;
    const term = resolveCourseTerm(extraction.course, "2026-08-20");
    const items = resolveExtractedItems(extraction.items, { today: "2026-08-20", termStart: term.termStart, termEnd: term.termEnd, breaks: term.breaks });
    expect(items.map((item) => item.resolved.dueDate)).toEqual(["2026-09-14", "2026-10-19"]);
    expect(term.termStart).toBe("2026-08-24");
    expect(term.termEnd).toBe("2026-12-04");
  });

  it("reads the wrapped shape too, with defaults for what it leaves out", () => {
    const reading = readingOfResult(WRAPPED_ANSWER)!;
    expect(reading).not.toBeNull();
    expect(reading.count).toBe(1);
    expect(reading.courseName).toBe("Mock Course");
    expect(reading.rawText).toBe("");
    expect(reading.extraction.course).toMatchObject({ name: "Mock Course", code: "", isAsynchronous: false, meetingPattern: null, termStart: null, termEnd: null, breaks: [] });
    expect(reading.extraction.items).toHaveLength(1);
    expect(reading.extraction.items[0]).toMatchObject({ name: "Quiz 1", type: "quiz", dueDate: "2026-11-03", dateConfidence: "explicit", estimatedMinutes: 30, difficulty: 3 });
  });

  it("a truncated answer carries the engine's warning once, after the server's", () => {
    const reading = readingOfResult({ ...SERVER_ANSWER, truncated: true, warnings: ["Office hours were not read.", "Office hours were not read."] })!;
    expect(reading.extraction.truncated).toBe(true);
    expect(reading.extraction.warnings[0]).toBe("Office hours were not read.");
    expect(reading.extraction.warnings.filter((w) => w === "Office hours were not read.")).toHaveLength(1);
    expect(reading.extraction.warnings.some((w) => /cut off/.test(w))).toBe(true);
  });

  it("an answer with nothing found still reads, so the screen can say so", () => {
    const reading = readingOfResult({ ...SERVER_ANSWER, items: [], count: 0, warnings: ["No assignments or exams were found in this document."] })!;
    expect(reading.count).toBe(0);
    expect(reading.extraction.items).toEqual([]);
    expect(reading.extraction.warnings[0]).toMatch(/No assignments or exams were found/);
  });

  it("an answer that is not an extraction at all is null, not a crash", () => {
    expect(readingOfResult(null)).toBeNull();
    expect(readingOfResult("done")).toBeNull();
    expect(readingOfResult({ count: 3 })).toBeNull();
    expect(readingOfResult({ extraction: { course: {} } })).toBeNull();
  });
});
