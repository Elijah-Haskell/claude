import { describe, it, expect } from "vitest";
import { normalizeCourse, courseMatchScore, findBestClassMatch, buildVerifiedClassFromSyllabus } from "../../src/engine/course-matcher";
import { ClassBlock, DayOfWeek } from "../../src/engine/types";

// ── Helpers ───────────────────────────────────────────────────

function makeClass(id: string, name: string, color = "#4F6EF7"): ClassBlock {
  return { id, name, days: [], startTime: "09:00", endTime: "10:00", color };
}

// ── normalizeCourse ───────────────────────────────────────────

describe("normalizeCourse", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeCourse("Organic Chemistry!")).toEqual(expect.arrayContaining(["organic", "chemistry"]));
  });

  it("removes stop words", () => {
    const tokens = normalizeCourse("Introduction to Computer Science");
    expect(tokens).not.toContain("to");
    expect(tokens).not.toContain("introduction");
    expect(tokens).toContain("computer");
    expect(tokens).toContain("science");
  });

  it("expands abbreviations", () => {
    const tokens = normalizeCourse("Calc II");
    expect(tokens).toContain("calculus");
  });

  it("expands cs abbreviation", () => {
    const tokens = normalizeCourse("CS 101");
    expect(tokens).toContain("computer");
    expect(tokens).toContain("science");
  });

  it("handles empty string", () => {
    expect(normalizeCourse("")).toEqual([]);
  });
});

// ── courseMatchScore ──────────────────────────────────────────

describe("courseMatchScore", () => {
  it("returns 1.0 for identical token sets", () => {
    const tokens = ["organic", "chemistry"];
    expect(courseMatchScore(tokens, tokens)).toBe(1.0);
  });

  it("returns 0 for completely different sets", () => {
    expect(courseMatchScore(["chemistry"], ["history"])).toBe(0);
  });

  it("returns partial score for partial overlap", () => {
    const score = courseMatchScore(["organic", "chemistry"], ["chemistry", "biology"]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 for empty inputs", () => {
    expect(courseMatchScore([], ["chemistry"])).toBe(0);
    expect(courseMatchScore(["chemistry"], [])).toBe(0);
  });
});

// ── findBestClassMatch ────────────────────────────────────────

describe("findBestClassMatch", () => {
  const classes = [
    makeClass("c1", "Organic Chemistry"),
    makeClass("c2", "Calculus II"),
    makeClass("c3", "Introduction to Computer Science"),
    makeClass("c4", "Microeconomics"),
    makeClass("c5", "English Literature"),
  ];

  it("matches exact course name", () => {
    const result = findBestClassMatch("Organic Chemistry", classes);
    expect(result.matchedClass?.id).toBe("c1");
    expect(result.isConfident).toBe(true);
  });

  it("matches despite abbreviation (Calc → Calculus)", () => {
    const result = findBestClassMatch("Calc 2", classes);
    expect(result.matchedClass?.id).toBe("c2");
    expect(result.isConfident).toBe(true);
  });

  it("matches despite extra words (Intro to CS → Computer Science)", () => {
    const result = findBestClassMatch("Intro to CS", classes);
    expect(result.matchedClass?.id).toBe("c3");
    expect(result.isConfident).toBe(true);
  });

  it("matches despite typo-style variation (Micro Economics)", () => {
    const result = findBestClassMatch("Micro Economics", classes);
    expect(result.matchedClass?.id).toBe("c4");
    expect(result.isConfident).toBe(true);
  });

  it("returns null when no class is close enough", () => {
    const result = findBestClassMatch("Quantum Mechanics", classes);
    expect(result.matchedClass).toBeNull();
    expect(result.isConfident).toBe(false);
  });

  it("returns null for empty class list", () => {
    const result = findBestClassMatch("Organic Chemistry", []);
    expect(result.matchedClass).toBeNull();
  });

  it("returns null for empty course name", () => {
    const result = findBestClassMatch("", classes);
    expect(result.matchedClass).toBeNull();
  });

  it("matches partial name (Orgo → Organic Chemistry)", () => {
    const result = findBestClassMatch("Orgo", classes);
    expect(result.matchedClass?.id).toBe("c1");
    expect(result.isConfident).toBe(true);
  });
});

// ── buildVerifiedClassFromSyllabus ─────────────────────────────

describe("buildVerifiedClassFromSyllabus", () => {
  it("creates a class with the given name", () => {
    const cls = buildVerifiedClassFromSyllabus("Quantum Mechanics", 0, {
      days: ["Mon", "Wed"], startTime: "10:00", endTime: "11:15", location: "Science 204",
    });
    expect(cls.name).toBe("Quantum Mechanics");
  });

  it("assigns a color from the palette", () => {
    const cls = buildVerifiedClassFromSyllabus("Quantum Mechanics", 0, {
      days: ["Mon"], startTime: "10:00", endTime: "11:15", location: "",
    });
    expect(cls.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("cycles colors based on existing class count", () => {
    const meeting = { days: ["Tue"] as DayOfWeek[], startTime: "10:00", endTime: "11:15", location: "" };
    const cls0 = buildVerifiedClassFromSyllabus("Course A", 0, meeting);
    const cls8 = buildVerifiedClassFromSyllabus("Course B", 8, meeting);
    expect(cls0.color).toBe(cls8.color); // wraps around at 8
  });

  it("preserves verified meeting details rather than creating a placeholder schedule", () => {
    const cls = buildVerifiedClassFromSyllabus("Quantum Mechanics", 0, {
      days: ["Tue", "Thu"], startTime: "13:30", endTime: "14:45", location: "Physics 101",
    });
    expect(cls.days).toEqual(["Tue", "Thu"]);
    expect(cls.startTime).toBe("13:30");
    expect(cls.endTime).toBe("14:45");
    expect(cls.location).toBe("Physics 101");
  });

  it("allows an explicitly asynchronous course without inventing a false meeting time", () => {
    const cls = buildVerifiedClassFromSyllabus("Online Ethics", 0, {
      days: [], startTime: "", endTime: "", location: "Online", isAsynchronous: true,
    });
    expect(cls.days).toEqual([]);
    expect(cls.isAsynchronous).toBe(true);
    expect(cls.startTime).toBe("");
  });
});
