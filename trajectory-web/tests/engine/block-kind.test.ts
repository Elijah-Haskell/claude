import { describe, expect, it } from "vitest";

import { blockKindOf, examDeadlinesOn, KIND_LEGEND } from "../../src/engine/block-kind";

describe("blockKindOf (website colour by kind)", () => {
  it("maps classes, recurring commitments and jobs", () => {
    expect(blockKindOf({ type: "class", title: "FINC 3100" })).toBe("class");
    expect(blockKindOf({ type: "recurring", title: "Club" })).toBe("recurring");
    expect(blockKindOf({ type: "work", title: "Shift" })).toBe("recurring");
  });

  it("splits study blocks into assignment work and exam study by the task kind", () => {
    expect(blockKindOf({ type: "study", title: "Work on: Homework 3" }, { name: "Homework 3", kind: "assignment" })).toBe("task");
    expect(blockKindOf({ type: "study", title: "Paper" }, { name: "Paper outline", kind: "project" })).toBe("task");
    expect(blockKindOf({ type: "study", title: "Review: Quiz 9" }, { name: "Quiz 9", kind: "quiz" })).toBe("study");
    expect(blockKindOf({ type: "study", title: "Midterm prep" }, { name: "Midterm Exam", kind: "exam" })).toBe("study");
  });

  it("falls back to the block title when the task is gone", () => {
    expect(blockKindOf({ type: "study", title: "Review: Midterm Exam" })).toBe("study");
  });

  it("does not draw sleep or buffer; personal events get their own kind", () => {
    expect(blockKindOf({ type: "sleep", title: "Sleep" })).toBeNull();
    expect(blockKindOf({ type: "buffer", title: "" })).toBeNull();
    expect(blockKindOf({ type: "free", title: "Dinner" })).toBe("personal");
  });

  it("lists the legend in the website's order", () => {
    expect(KIND_LEGEND.map((row) => row.kind)).toEqual(["class", "task", "study", "exam", "recurring", "personal"]);
  });

  it("calls study blocks just 'Study': whether one may move is its outline (flexible / kept), not its kind", () => {
    expect(KIND_LEGEND.find((row) => row.kind === "study")?.label).toBe("Study");
    expect(KIND_LEGEND.map((row) => row.label).join(" ")).not.toMatch(/auto-planned|suggested/i);
  });
});

describe("examDeadlinesOn", () => {
  const tasks = [
    { name: "Quiz 9", kind: "quiz" as const, dueDate: "2026-09-27", status: "pending" as const },
    { name: "Homework 3", kind: "assignment" as const, dueDate: "2026-09-27", status: "pending" as const },
    { name: "Midterm", kind: "exam" as const, dueDate: "2026-09-27", status: "done" as const },
    { name: "Final", kind: "exam" as const, dueDate: "2026-12-10", status: "pending" as const },
  ];
  it("returns only open exams and quizzes due that day", () => {
    expect(examDeadlinesOn(tasks, "2026-09-27").map((t) => t.name)).toEqual(["Quiz 9"]);
  });
});
