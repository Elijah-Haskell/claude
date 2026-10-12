// A deadline that moved: the proposal is sanitised (lib/assistant-reply.ts), recognised as news about a task rather
// than a block move (lib/assistant-intent.ts) and applied through the one AssistantChange path (engine/assistant-change.ts).
// The mobile app's tests/assistant-deadline.test.ts.
import { describe, expect, it } from "vitest";

import { applyAssistantChange, applyDeadlineChanges, isEmptyChange } from "../../src/engine/assistant-change";
import { createInitialState } from "../../src/engine/state-persistence";
import { isDeadlineChangeIntent, isEditIntent } from "../../src/lib/assistant-intent";
import { isRealIsoDate, sanitizeDeadlineChanges, statesADate } from "../../src/lib/assistant-reply";
import { makeTask } from "../engine/scheduler-fixtures";

const known = new Map([
  ["mid", { dueDate: "2026-10-08" }],
  ["essay", { dueDate: "2026-10-02", dueTime: "17:00" }],
]);
const opts = (statedText: string) => ({ today: "2026-09-24", statedText });

describe("statesADate", () => {
  it("recognises days and dates the way students write them", () => {
    for (const text of [
      "Midterm moved to Tuesday",
      "the essay is now due Fri at 5",
      "quiz 3 got pushed to next week",
      "final moved to Dec 12",
      "it's on the 14th now",
      "exam is 10/6",
      "moved to 2026-10-06",
      "due tomorrow",
      "in two weeks",
    ]) expect(statesADate(text), text).toBe(true);
    for (const text of ["my midterm got moved", "the professor changed the exam", "it was postponed"]) {
      expect(statesADate(text), text).toBe(false);
    }
  });

  it("validates real calendar dates", () => {
    expect(isRealIsoDate("2026-10-06")).toBe(true);
    expect(isRealIsoDate("2026-02-30")).toBe(false);
    expect(isRealIsoDate("2026-13-01")).toBe(false);
    expect(isRealIsoDate("Oct 6")).toBe(false);
  });
});

describe("sanitizeDeadlineChanges", () => {
  it("keeps well-formed changes for known tasks and drops everything else", () => {
    const changes = sanitizeDeadlineChanges(
      [
        { taskId: "mid", dueDate: "2026-10-06" },
        { taskId: "mid", dueDate: "2026-10-07" }, // repeat id
        { taskId: "ghost", dueDate: "2026-10-06" }, // unknown task
        { taskId: "essay", dueDate: "2026-10-05", dueTime: "9:30" },
        { taskId: "essay", dueDate: "not a date" },
        "junk",
        null,
      ],
      known,
      opts("my midterm moved to Tuesday and the essay to Monday 9:30"),
    );
    expect(changes).toEqual([
      { taskId: "mid", dueDate: "2026-10-06" },
      { taskId: "essay", dueDate: "2026-10-05", dueTime: "09:30" },
    ]);
  });

  it("never accepts a date the student did not state", () => {
    expect(sanitizeDeadlineChanges([{ taskId: "mid", dueDate: "2026-10-06" }], known, opts("my midterm got moved"))).toEqual([]);
  });

  it("drops dates in the past, more than a year ahead, impossible dates, and no-op changes", () => {
    const stated = opts("moved to Tuesday");
    expect(sanitizeDeadlineChanges([{ taskId: "mid", dueDate: "2026-09-01" }], known, stated)).toEqual([]);
    expect(sanitizeDeadlineChanges([{ taskId: "mid", dueDate: "2028-01-01" }], known, stated)).toEqual([]);
    expect(sanitizeDeadlineChanges([{ taskId: "mid", dueDate: "2026-02-30" }], known, stated)).toEqual([]);
    expect(sanitizeDeadlineChanges([{ taskId: "mid", dueDate: "2026-10-08" }], known, stated)).toEqual([]);
    expect(sanitizeDeadlineChanges([{ taskId: "essay", dueDate: "2026-10-02", dueTime: "17:00" }], known, stated)).toEqual([]);
    // Same day, new time is a real change.
    expect(sanitizeDeadlineChanges([{ taskId: "essay", dueDate: "2026-10-02", dueTime: "23:59" }], known, opts("due Friday 11:59pm")))
      .toEqual([{ taskId: "essay", dueDate: "2026-10-02", dueTime: "23:59" }]);
    expect(sanitizeDeadlineChanges("nope", known, stated)).toEqual([]);
  });
});

describe("applyDeadlineChanges", () => {
  const tasks = [
    makeTask({ id: "mid", name: "Midterm", dueDate: "2026-10-08", dateConfidence: "explicit", dateEvidence: "Midterm: Oct 8", notBeforeDate: "2026-10-07" }),
    makeTask({ id: "hw", name: "HW 3", dueDate: "2026-10-01" }),
  ];

  it("moves only the named tasks, marks the date as the student's, and never mutates its input", () => {
    const frozen = JSON.stringify(tasks);
    const next = applyDeadlineChanges(tasks, [{ taskId: "mid", dueDate: "2026-10-06", dueTime: "10:00" }, { taskId: "unknown", dueDate: "2026-10-09" }]);
    expect(JSON.stringify(tasks)).toBe(frozen);
    expect(next[1]).toBe(tasks[1]); // untouched task is the same object
    expect(next[0]).toMatchObject({ id: "mid", dueDate: "2026-10-06", dueTime: "10:00", dateConfidence: "user" });
    expect(next[0]!.dateEvidence).toBeUndefined();
    expect(next[0]!.notBeforeDate).toBeUndefined(); // would now fall after the deadline
  });

  it("is part of an AssistantChange, so the usual preview/replan/undo path applies it", () => {
    const state = { ...createInitialState(), tasks };
    const change = { label: "Move Midterm", deadlineChanges: [{ taskId: "mid", dueDate: "2026-10-06" }] };
    expect(isEmptyChange(change)).toBe(false);
    const after = applyAssistantChange(state, change);
    expect(after.tasks.find((t) => t.id === "mid")!.dueDate).toBe("2026-10-06");
    expect(state.tasks.find((t) => t.id === "mid")!.dueDate).toBe("2026-10-08");
  });
});

describe("deadline messages go to the conversation, session moves stay edits", () => {
  it("recognises a deadline that itself moved", () => {
    for (const text of [
      "Midterm moved to Tuesday",
      "my STAT midterm got moved to next Thursday",
      "The essay is now due Friday at 5pm",
      "professor pushed the final to Dec 14",
      "quiz 3 was postponed to Monday",
      "the lab report deadline is extended to the 20th",
    ]) {
      expect(isDeadlineChangeIntent(text), text).toBe(true);
      expect(isEditIntent(text), text).toBe(false);
    }
  });

  it("keeps requests to move a study session (or anything imperative) as edits", () => {
    for (const text of [
      "move my midterm review to Tuesday",
      "push my quiz 12 review to Sunday afternoon",
      "reschedule the exam prep for later in the week",
      "can you move the homework 3 session to Friday",
    ]) {
      expect(isDeadlineChangeIntent(text), text).toBe(false);
      expect(isEditIntent(text), text).toBe(true);
    }
  });
});
