import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { toDateString } from "../../src/engine/utils";
import {
  DONE_PREFIX,
  addedConfirmation,
  daysUntil,
  isAiAuthoredMessage,
  parsedItemsText,
  pendingEditHeadline,
  pendingEditRows,
  planChangeText,
  splitDone,
  taskFromParsed,
  type ParsedTask,
  type PendingEdit,
} from "../../src/lib/ai-items";

const ROOT = resolve(__dirname, "..", "..");

const task = (over: Partial<ParsedTask> = {}): ParsedTask => ({
  name: "Problem set 4",
  courseName: "Chem",
  estimatedMinutes: 120,
  difficulty: 3,
  dueDate: "2026-10-01",
  ...over,
});

describe("the Trajectory AI page", () => {
  it("is one box: no second mode, and no undo snackbar of its own", () => {
    const text = readFileSync(join(ROOT, "src", "screens", "ai.tsx"), "utf8");
    expect(text).not.toMatch(/task-intake|Segmented|mode\?: string/);
    expect(text).not.toMatch(/variant="snackbar"/);
  });

  it("is titled Trajectory AI, while the button that opens it says Ask AI", () => {
    const page = readFileSync(join(ROOT, "src", "screens", "ai.tsx"), "utf8");
    const button = readFileSync(join(ROOT, "src", "components", "ask-ai-button.tsx"), "utf8");
    expect(page).toMatch(/>Trajectory AI<\/h1>/);
    expect(button).toMatch(/Ask AI\s*<\/button>/);
  });

  it("is placed in the header of Today and Week, as on the phone", () => {
    for (const screen of ["today", "week"]) {
      const text = readFileSync(join(ROOT, "src", "screens", `${screen}.tsx`), "utf8");
      expect(text, screen).toMatch(/<AskAiButton \/>/);
    }
  });
});

describe("what the page says after things were added", () => {
  const block = (taskId: string | undefined, date: string, startTime: string, type: "study" | "class" = "study") => ({ type, taskId, date, startTime });

  it("says what was added and where its study sessions were planned", () => {
    const text = addedConfirmation("1 task and 1 weekly event", ["t1"], [
      block("t1", "2026-10-01", "08:30"),
      block("t1", "2026-09-30", "15:00"),
      block("t1", "2026-09-30", "09:00"),
      block("other", "2026-09-30", "10:00"),
      block("t1", "2026-09-30", "11:00", "class"),
    ]);
    expect(text).toBe("✅ 1 task and 1 weekly event added.\n\nStudy sessions planned:\n  • Wed, Sep 30: 9:00 AM, 3:00 PM\n  • Thu, Oct 1: 8:30 AM\nYou can undo it here.");
    expect(DONE_PREFIX.test(text)).toBe(true);
    expect(splitDone(text).headline).toBe("1 task and 1 weekly event added.");
  });

  it("still confirms, and says so plainly, when the plan found no time for the new task", () => {
    expect(addedConfirmation("1 task", ["t1"], [block("other", "2026-09-30", "10:00")])).toBe("✅ 1 task added.\n\nNo study session is planned for it yet. You can undo it here.");
    expect(addedConfirmation("2 tasks", ["t1", "t2"], [])).toContain("No study session is planned for them yet.");
  });

  it("confirms an event on its own", () => {
    expect(addedConfirmation("1 event", [], [])).toBe("✅ 1 event added.\n\nYou can undo it here.");
  });

  it("names four days at most", () => {
    const text = addedConfirmation("1 task", ["t1"], ["01", "02", "03", "04", "05", "06"].map((day) => block("t1", `2026-10-${day}`, "09:00")));
    expect(text.split("\n").filter((line) => line.startsWith("  • "))).toHaveLength(5);
    expect(text).toContain("  • and 2 more days");
  });
});

describe("which messages carry the AI label", () => {
  it("labels model replies but not the app's own lines or the student's messages", () => {
    expect(isAiAuthoredMessage({ id: "ai-1712345678901", role: "assistant", content: "Moved your study block." })).toBe(true);
    expect(isAiAuthoredMessage({ id: "user-1712345678901", role: "user", content: "move it" })).toBe(false);
    expect(isAiAuthoredMessage({ id: "welcome", role: "assistant", content: "Hey!" })).toBe(false);
    expect(isAiAuthoredMessage({ id: "welcome-reset", role: "assistant", content: "Fresh start" })).toBe(false);
    expect(isAiAuthoredMessage({ id: "sys-1712345678901", role: "assistant", content: "No changes made." })).toBe(false);
    expect(isAiAuthoredMessage({ id: "err-sched-1712345678901", role: "assistant", content: "Trouble" })).toBe(false);
    expect(isAiAuthoredMessage({ id: "ai-done-1712345678901", role: "assistant", content: "✅ Added 2 tasks." })).toBe(false);
  });

  it("splits a confirmation into headline and rest", () => {
    expect(splitDone("✅ Added 2 tasks. You can view them in Tasks.")).toEqual({ headline: "Added 2 tasks.", rest: "You can view them in Tasks." });
    expect(splitDone("🎉 Scheduled.\n\nTap to accept.")).toEqual({ headline: "Scheduled.", rest: "Tap to accept." });
  });
});

describe("taskFromParsed", () => {
  const classes = [{ id: "c1", name: "CHEM 101" }, { id: "c2", name: "History" }];
  const now = new Date("2026-09-26T15:00:00");

  it("matches the course by name either way and clamps difficulty", () => {
    const t = taskFromParsed(task({ courseName: "chem", difficulty: 9 }), classes, { now });
    expect(t.courseId).toBe("c1");
    expect(t.difficulty).toBe(5);
    expect(t.status).toBe("pending");
    expect(t.id).toMatch(/^task-\d+-/);
    expect(taskFromParsed(task({ courseName: "Physics" }), classes, { now }).courseId).toBe("general");
  });

  it("does not file a task with no course under the first class", () => {
    expect(taskFromParsed(task({ courseName: "" }), classes, { now }).courseId).toBe("general");
    expect(taskFromParsed(task({ courseName: "  " }), classes, { now }).courseId).toBe("general");
  });

  it("gives a missing due date one a week out", () => {
    expect(taskFromParsed(task({ dueDate: "" }), classes, { now }).dueDate).toBe(toDateString(new Date(now.getTime() + 7 * 86400000)));
  });

  it("keeps a past due date unless clampPastDue (the chat's behaviour)", () => {
    expect(taskFromParsed(task({ dueDate: "2026-09-01" }), classes, { now }).dueDate).toBe("2026-09-01");
    expect(taskFromParsed(task({ dueDate: "2026-09-01" }), classes, { now, clampPastDue: true }).dueDate).toBe(
      toDateString(new Date(now.getTime() + 7 * 86400000))
    );
    expect(taskFromParsed(task({ dueDate: "2026-10-03" }), classes, { now, clampPastDue: true }).dueDate).toBe("2026-10-03");
  });
});

describe("report text for AI content", () => {
  it("lists parsed items one per line", () => {
    const text = parsedItemsText({
      tasks: [task()],
      events: [{ title: "Shift", date: "2026-10-02", startTime: "09:00", endTime: "17:00" }],
      recurring: [{ title: "Gym", days: ["Mon", "Wed"], startTime: "18:00", endTime: "19:00", color: "#fff" }],
    });
    expect(text.split("\n")).toEqual([
      "- Task: Problem set 4 (Chem, due 2026-10-01, 2h, difficulty 3/5)",
      "- Event: Shift (2026-10-02 09:00-17:00)",
      "- Recurring: Gym (Mon/Wed 18:00-19:00)",
    ]);
    expect(parsedItemsText({})).toBe("");
  });

  it("describes a pending plan change as old -> new rows plus the summary", () => {
    const edit: PendingEdit = {
      editBlocks: [{ id: "b1", title: "Study: Chem", date: "2026-09-29", startTime: "15:00", endTime: "16:00" }],
      editRecurring: [],
      newEvents: [{ title: "Office hours", date: "2026-09-30", startTime: "10:00", endTime: "11:00", type: "free" }],
      newRecurring: [],
      healthPrefsUpdate: { bedtime: "23:30" },
      summary: "Moved your Chem session to Tuesday.",
    };
    const rows = pendingEditRows(edit, {
      scheduleBlocks: [{ id: "b1", date: "2026-10-01", startTime: "15:00", endTime: "16:00" }],
      recurringEvents: [],
      healthPrefs: { bedtime: "23:00", wakeTime: "07:00" },
    });
    expect(rows.map((r) => r.key)).toEqual(["eb-0", "ne-0", "sleep"]);
    expect(rows[0]).toMatchObject({ title: "Study: Chem", from: "Thu 3:00 PM", to: "Tue 3:00 PM" });
    expect(rows[1]).toMatchObject({ isNew: true, from: "" });
    expect(rows[2]).toMatchObject({ from: "Bed 11:00 PM · Wake 7:00 AM", to: "Bed 11:30 PM" });

    const text = planChangeText(edit.summary, rows);
    expect(text.startsWith("Moved your Chem session to Tuesday.\n\n- Study: Chem: Thu 3:00 PM → Tue 3:00 PM")).toBe(true);
    expect(text).toContain("- New: Office hours:");
    expect(pendingEditHeadline(edit)).toBe("1 block will move. 1 new item will be added. Your sleep window will change.");
  });

  it("shows a moved deadline as old due date -> new due date, keeping the time", () => {
    const edit: PendingEdit = {
      editBlocks: [], editRecurring: [], newEvents: [], newRecurring: [],
      deadlineChanges: [{ taskId: "mid", dueDate: "2026-10-06" }],
      summary: "Your STAT 230 midterm moves to Tuesday.",
    };
    const rows = pendingEditRows(edit, {
      scheduleBlocks: [], recurringEvents: [],
      tasks: [{ id: "mid", name: "Midterm", courseName: "STAT 230", dueDate: "2026-10-08", dueTime: "14:00" }],
    });
    expect(rows).toEqual([{ key: "dl-0", title: "STAT 230 · Midterm", from: "Thu, Oct 8 2:00 PM", to: "Tue, Oct 6 2:00 PM" }]);
    expect(pendingEditHeadline(edit)).toBe("1 deadline will move; your sessions are replanned around it.");
  });
});

describe("daysUntil", () => {
  it("counts whole days from a given today", () => {
    expect(daysUntil("2026-09-29", "2026-09-26")).toBe(3);
    expect(daysUntil("2026-09-25", "2026-09-26")).toBe(-1);
    expect(daysUntil("soon", "2026-09-26")).toBeNull();
  });
});
