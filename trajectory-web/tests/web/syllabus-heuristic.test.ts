import { describe, expect, it } from "vitest";

import { resolveExtractedItems } from "../../src/engine/syllabus-extraction-utils";
import { extractSyllabusHeuristically } from "../../src/lib/syllabus-heuristic";

const SYLLABUS = `FINC 3100: Principles of Finance
Instructor: Dr. Jane Rivers
Classes meet MWF 10:00-10:50 am in Hayes 204
Classes begin August 24, 2026
Last day of class: December 4, 2026

Schedule
Sept 14 – Problem Set 1 due by 11:59 pm
9/28 Quiz 1
Week 6 Fri: Problem Set 2
October 19, 2026 Midterm Exam
Reading: Chapter 4 (no date given)
Exams: 40% of the grade
Office hours: Tue 2-3 pm
Dec 11 Final Exam 8:00 am
`;

describe("built-in syllabus reader", () => {
  const extraction = extractSyllabusHeuristically(SYLLABUS);

  it("reads the course basics", () => {
    expect(extraction.course.code).toBe("FINC 3100");
    expect(extraction.course.name).toContain("Principles of Finance");
    expect(extraction.course.instructor).toContain("Jane Rivers");
    expect(extraction.course.meetingPattern?.days).toEqual(["Mon", "Wed", "Fri"]);
    expect(extraction.course.meetingPattern?.startTime).toBe("10:00");
    expect(extraction.course.meetingPattern?.endTime).toBe("10:50");
    expect(extraction.course.termStart).toBe("2026-08-24");
    expect(extraction.course.termEnd).toBe("2026-12-04");
  });

  it("keeps every dated deliverable and leaves out policy lines", () => {
    const names = extraction.items.map((item) => item.name);
    expect(names).toContain("Problem Set 1");
    expect(names).toContain("Quiz 1");
    expect(names).toContain("Problem Set 2");
    expect(names).toContain("Midterm Exam");
    expect(names).toContain("Final Exam");
    expect(names.some((name) => /office hours/i.test(name))).toBe(false);
    expect(names.some((name) => /40%/.test(name))).toBe(false);
  });

  it("reports dates the way the AI reader does and never invents one", () => {
    const byName = new Map(extraction.items.map((item) => [item.name, item]));
    expect(byName.get("Problem Set 1")?.dueDate).toBe("09-14");
    expect(byName.get("Problem Set 1")?.dueTime).toBe("23:59");
    expect(byName.get("Quiz 1")?.dueDate).toBe("09-28");
    expect(byName.get("Quiz 1")?.type).toBe("quiz");
    expect(byName.get("Midterm Exam")?.dueDate).toBe("2026-10-19");
    expect(byName.get("Midterm Exam")?.dateConfidence).toBe("explicit");
    expect(byName.get("Problem Set 2")?.weekNumber).toBe(6);
    expect(byName.get("Problem Set 2")?.weekday).toBe("Fri");
    expect(byName.get("Problem Set 2")?.dueDate).toBeNull();
    const reading = extraction.items.find((item) => item.type === "reading");
    expect(reading?.dueDate).toBeNull();
    expect(reading?.dateConfidence).toBe("missing");
  });

  it("feeds the engine's date resolution", () => {
    const resolved = resolveExtractedItems(extraction.items, { today: "2026-09-01", termStart: "2026-08-24", termEnd: "2026-12-04", breaks: [] });
    const ps2 = resolved.find((item) => item.name === "Problem Set 2");
    expect(ps2?.resolved.dueDate).toBe("2026-10-02");
    const quiz = resolved.find((item) => item.name === "Quiz 1");
    expect(quiz?.resolved.dueDate).toBe("2026-09-28");
  });

  it("says so when nothing is found", () => {
    const empty = extractSyllabusHeuristically("Welcome to the course.\nBe kind.");
    expect(empty.items).toHaveLength(0);
    expect(empty.warnings[0]).toMatch(/found no dated/);
  });
});
