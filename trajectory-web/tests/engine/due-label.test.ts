import { describe, expect, it } from "vitest";
import { blockDueLabel, dueLabel, relativeDayLabel } from "../../src/engine/due-label";

const TODAY = "2026-09-27"; // a Sunday

describe("due wording on study sessions", () => {
  it("reads relative to today", () => {
    expect(relativeDayLabel("2026-09-27", TODAY)).toBe("today");
    expect(relativeDayLabel("2026-09-28", TODAY)).toBe("tomorrow");
    expect(relativeDayLabel("2026-10-01", TODAY)).toBe("Thu");
    expect(relativeDayLabel("2026-10-04", TODAY)).toBe("Oct 4");
    expect(relativeDayLabel("2026-09-26", TODAY)).toBe("yesterday");
  });

  it("adds a compact due time when there is one", () => {
    expect(dueLabel({ dueDate: "2026-09-27", dueTime: "23:59" }, TODAY)).toBe("due today 11:59p");
    expect(dueLabel({ dueDate: "2026-10-01", dueTime: "09:00" }, TODAY)).toBe("due Thu 9a");
    expect(dueLabel({ dueDate: "2026-10-16" }, TODAY)).toBe("due Oct 16");
    expect(dueLabel({ dueDate: "" }, TODAY)).toBeNull();
  });

  it("only labels study blocks that work toward an unfinished task", () => {
    const task = { dueDate: "2026-09-28", status: "pending" as const };
    expect(blockDueLabel({ type: "study", taskId: "t1" }, task, TODAY)).toBe("due tomorrow");
    expect(blockDueLabel({ type: "class", taskId: undefined }, task, TODAY)).toBeNull();
    expect(blockDueLabel({ type: "study", taskId: "t1" }, { ...task, status: "done" as const }, TODAY)).toBeNull();
    expect(blockDueLabel({ type: "study", taskId: "t1" }, undefined, TODAY)).toBeNull();
  });
});
