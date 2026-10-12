import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { countPlanConflicts, describeConflicts, describeReplanDiff, previewTaskEdit, reducer, runReplan } from "../../src/engine/app-context";
import {
  applyBlockMoves,
  calendarConflicts,
  doNotScheduleConflicts,
  resolveCalendarConflicts,
  resolveDoNotScheduleConflicts,
} from "../../src/engine/day-conflicts";
import { createInitialState } from "../../src/engine/state-persistence";
import type { AppState, GoogleCalendarEventLocal, RecurringEvent, ScheduleBlock, Semester } from "../../src/engine/types";
import { parsePersistedUndo, toPersistedUndo } from "../../src/engine/undo-persistence";
import { makeBlock, makeClass, makeTask, NOW, TODAY } from "./scheduler-fixtures";

const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [] };

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), onboardingComplete: true, semester: SEMESTER, ...overrides };
}

const session = (id: string, taskId: string, date: string, start: string, end: string, extra: Partial<ScheduleBlock> = {}): ScheduleBlock =>
  makeBlock({ id, type: "study", title: "Study", taskId, date, startTime: start, endTime: end, accepted: true, ...extra });

const gcalEvent = (start: string, end: string): GoogleCalendarEventLocal => ({
  id: "g1", calendarId: "primary", title: "Dentist", startDate: TODAY, startTime: start, endTime: end,
  isAllDay: false, isRecurring: false, status: "active", syncedAt: NOW.toISOString(),
});

describe("describeReplanDiff", () => {
  const ref = { id: "x", title: "t", date: TODAY, startTime: "10:00", endTime: "11:00", minutes: 60 };
  const move = { id: "x", title: "t", from: { date: TODAY, startTime: "10:00", endTime: "11:00" }, to: { date: TODAY, startTime: "12:00", endTime: "13:00" } };

  it("says what changed, first count with the noun", () => {
    expect(describeReplanDiff({ moved: [move, move, move], added: [ref], removed: [], markedMissed: [] })).toBe("3 sessions moved · 1 added");
    expect(describeReplanDiff({ moved: [], added: [ref, ref], removed: [ref], markedMissed: [] })).toBe("2 sessions added · 1 removed");
    expect(describeReplanDiff({ moved: [move], added: [], removed: [], markedMissed: [] })).toBe("1 session moved");
  });

  it("is empty when nothing changed", () => {
    expect(describeReplanDiff({ moved: [], added: [], removed: [], markedMissed: [] })).toBe("");
  });

  it("counts confirmed sessions the change released", () => {
    const released = { ...ref, reason: "conflict" as const, detail: "Clashes with Job shift" };
    expect(describeReplanDiff({ moved: [move], added: [], removed: [], markedMissed: [], released: [released] })).toBe("1 session moved · 1 released");
  });

  it("says '0 conflicts' only when there really are none", () => {
    expect(describeConflicts(0)).toBe("0 conflicts");
    expect(describeConflicts(1)).toBe("1 conflict");
    expect(describeConflicts(3)).toBe("3 conflicts");
  });
});

describe("countPlanConflicts (the only source for a conflicts claim)", () => {
  it("counts a study session on top of a class meeting, and nothing for a clean plan", () => {
    const state = stateWith({ classes: [makeClass()] }); // Chemistry Mon/Wed/Fri 10:00-11:00; TODAY is a Wednesday
    const clash = session("x", "t", TODAY, "10:30", "11:30");
    const clean = session("y", "t", TODAY, "15:00", "16:00");
    expect(countPlanConflicts(state, { scheduleBlocks: [clash] }, NOW)).toBe(1);
    expect(countPlanConflicts(state, { scheduleBlocks: [clean] }, NOW)).toBe(0);
  });
});

describe("runReplan: Today → move the rest to tomorrow (preview, apply, undo)", () => {
  const task = makeTask({ id: "essay", name: "Essay", dueDate: "2030-03-22", estimatedMinutes: 60, status: "scheduled" });
  const base = () => stateWith({ tasks: [task], scheduleBlocks: [session("s1", "essay", TODAY, "15:00", "16:00")] });

  it("previews the sessions moving to a later day without touching state", () => {
    const state = base();
    const preview = runReplan(state, { scope: "today", mode: "defer", date: TODAY }, NOW);

    expect(state.scheduleBlocks[0]!.completionStatus).toBe("pending"); // nothing applied
    expect(preview.label).toBe("Move to tomorrow");
    expect(preview.diff.moved.length).toBeGreaterThan(0);
    expect(preview.diff.moved.every((m) => m.from.date === TODAY && m.to.date > TODAY)).toBe(true);
    expect(preview.next.tasks.find((t) => t.id === "essay")!.notBeforeDate).toBe("2030-03-14");
  });

  it("applies as one undoable change with a summary, and undo restores the day exactly", () => {
    const state = base();
    const preview = runReplan(state, { scope: "today", mode: "defer", date: TODAY }, NOW);
    const applied = reducer(state, {
      type: "APPLY_REPLAN",
      payload: { label: preview.label, at: NOW.toISOString(), next: preview.next, summary: describeReplanDiff(preview.diff) },
    });

    expect(applied.undoSnapshots?.[0]).toMatchObject({ label: "Move to tomorrow", source: "manual", summary: describeReplanDiff(preview.diff) });
    // Today's session stays on the calendar as history (skipped); the work moved to a later day.
    expect(applied.scheduleBlocks.find((b) => b.id === "s1")?.completionStatus).toBe("skipped");
    expect(applied.scheduleBlocks.some((b) => b.taskId === "essay" && b.completionStatus === "pending" && b.date > TODAY)).toBe(true);

    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.scheduleBlocks).toBe(state.scheduleBlocks);
    expect(undone.tasks).toBe(state.tasks);
  });

  it("a day with nothing to move previews 'nothing to change'", () => {
    const preview = runReplan(stateWith({ tasks: [task] }), { scope: "today", mode: "defer", date: TODAY }, NOW);
    expect(preview.diff.changed).toBe(false);
    expect(preview.needsConfirmation).toBeUndefined();
  });

  it("work that would miss its deadline is not moved until the student says 'Move anyway'", () => {
    // Due tonight, 2 hours still to do, and the only session is later today: tomorrow is too late.
    const dueTonight = makeTask({ id: "quiz", name: "Quiz 3", kind: "quiz", dueDate: TODAY, dueTime: "23:59", estimatedMinutes: 120, status: "scheduled" });
    const state = stateWith({ tasks: [dueTonight], scheduleBlocks: [session("q1", "quiz", TODAY, "20:00", "22:00")] });
    const asked = runReplan(state, { scope: "today", mode: "defer", date: TODAY }, NOW);
    if (asked.needsConfirmation) {
      expect(asked.needsConfirmation.atRisk.map((r) => r.taskId)).toEqual(["quiz"]);
      expect(asked.diff.changed).toBe(false); // nothing to apply yet
      const anyway = runReplan(state, { scope: "today", mode: "defer", date: TODAY, acceptLate: true }, NOW);
      expect(anyway.needsConfirmation).toBeUndefined();
      expect(anyway.diff.changed).toBe(true);
    } else {
      // The planner found time before the deadline instead: then nothing is late and nothing needs asking.
      expect(asked.next.scheduleBlocks.filter((b) => b.taskId === "quiz" && b.completionStatus === "pending").every((b) => b.date === TODAY)).toBe(true);
    }
  });
});

describe("runReplan: every scope is a preview (state is never mutated)", () => {
  const tasks = [
    makeTask({ id: "a", name: "Problem set 1", dueDate: "2030-03-20", estimatedMinutes: 120 }),
    makeTask({ id: "c", name: "Midterm exam", dueDate: "2030-04-24", estimatedMinutes: 300 }),
  ];
  const planned = () => reducer(stateWith({ classes: [makeClass()], tasks }), { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });

  it("week and semester scopes return a label, a diff and the plan to apply", () => {
    const state = planned();
    const blocks = state.scheduleBlocks;
    const week = runReplan(state, { scope: "week", weekStart: "2030-03-11" }, NOW);
    const semester = runReplan(state, { scope: "semester" }, NOW);

    expect(week.label).toBe("Replan this week");
    expect(semester.label).toBe("Replan the semester");
    expect(week.next.scheduleBlocks.length).toBeGreaterThan(0);
    expect(semester.next.scheduleBlocks.length).toBeGreaterThan(0);
    expect(state.scheduleBlocks).toBe(blocks);
  });

  it("Today's 'Fit the rest of today' modes (normal hours / up to bedtime) go through the same seam", () => {
    const state = planned();
    expect(runReplan(state, { scope: "today", mode: "protect_sleep" }, NOW).label).toBe("Fit the rest of today");
    expect(runReplan(state, { scope: "today", mode: "crunch_mode" }, NOW).label).toBe("Fit the rest of today");
  });
});

describe("AUTO_REPLAN: the automatic re-plan is never silent", () => {
  const tasks = [makeTask({ id: "a", name: "Problem set 1", dueDate: "2030-03-20", estimatedMinutes: 120 })];

  it("keeps an 'auto' undo snapshot with what changed when sessions move or appear", () => {
    const state = stateWith({ classes: [makeClass()], tasks });
    const after = reducer(state, { type: "AUTO_REPLAN", payload: { now: NOW } });

    expect(after.scheduleBlocks.some((b) => b.type === "study")).toBe(true);
    expect(after.undoSnapshots?.[0]).toMatchObject({ label: "Plan updated", source: "auto" });
    expect(after.undoSnapshots![0]!.summary).toMatch(/added/);
    expect(after.undoSnapshots![0]!.summary).toMatch(/\d+ conflicts?$/); // counted, never assumed
    expect(reducer(after, { type: "UNDO_REPLAN" }).scheduleBlocks).toBe(state.scheduleBlocks);
  });

  it("a re-plan that changes nothing the student can see adds no snapshot", () => {
    const once = reducer(stateWith({ classes: [makeClass()], tasks }), { type: "AUTO_REPLAN", payload: { now: NOW } });
    const twice = reducer(once, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(twice.undoSnapshots).toHaveLength(1);
  });

  it("a custom label is kept (pull-to-refresh: 'Plan refreshed')", () => {
    const after = reducer(stateWith({ classes: [makeClass()], tasks }), { type: "AUTO_REPLAN", payload: { now: NOW, label: "Plan refreshed" } });
    expect(after.undoSnapshots?.[0]?.label).toBe("Plan refreshed");
  });
});

describe("previewTaskEdit: a deadline edit is previewed, applied and undone as one step", () => {
  const tasks = [makeTask({ id: "mid", name: "Midterm exam", dueDate: "2030-04-24", estimatedMinutes: 300 })];

  it("moving the deadline earlier moves sessions; undo restores the old deadline and plan", () => {
    const state = reducer(stateWith({ classes: [makeClass()], tasks }), { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });
    const preview = previewTaskEdit(state, "mid", { dueDate: "2030-03-22" }, NOW)!;

    expect(preview.label).toBe("Deadline change");
    expect(preview.diff.changed).toBe(true);
    expect(state.tasks[0]!.dueDate).toBe("2030-04-24"); // untouched until applied
    expect(preview.next.tasks.find((t) => t.id === "mid")!.dueDate).toBe("2030-03-22");
    expect(preview.next.scheduleBlocks.filter((b) => b.taskId === "mid" && b.type === "study").every((b) => b.date <= "2030-03-22")).toBe(true);

    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: NOW.toISOString(), next: preview.next } });
    expect(applied.tasks.find((t) => t.id === "mid")!.dueDate).toBe("2030-03-22");
    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.tasks.find((t) => t.id === "mid")!.dueDate).toBe("2030-04-24");
    expect(undone.scheduleBlocks).toBe(state.scheduleBlocks);
  });

  it("returns null for a task that no longer exists", () => {
    expect(previewTaskEdit(stateWith(), "gone", { dueDate: "2030-03-22" }, NOW)).toBeNull();
  });
});

describe("day conflicts (Google Calendar clashes and do-not-schedule zones)", () => {
  it("finds a block overlapping an upcoming calendar event and moves it to the first free slot after it", () => {
    const blocks = [session("s1", "t", TODAY, "15:00", "16:00")];
    const conflicts = calendarConflicts(blocks, [gcalEvent("14:30", "15:30")], TODAY, 12 * 60);
    expect(conflicts).toHaveLength(1);
    expect(resolveCalendarConflicts(blocks, conflicts, TODAY)).toEqual([{ id: "s1", startTime: "15:30", endTime: "16:30" }]);
  });

  it("jumps past another block in the way, and never moves a locked block", () => {
    const blocks = [session("s1", "t", TODAY, "15:00", "16:00"), makeBlock({ id: "c1", type: "class", date: TODAY, startTime: "15:30", endTime: "17:00", locked: true })];
    const conflicts = calendarConflicts(blocks, [gcalEvent("14:30", "15:30")], TODAY, 12 * 60);
    const moves = resolveCalendarConflicts(blocks, conflicts, TODAY);
    expect(moves).toEqual([{ id: "s1", startTime: "17:00", endTime: "18:00" }]);
  });

  it("ignores calendar events that already started", () => {
    const blocks = [session("s1", "t", TODAY, "15:00", "16:00")];
    expect(calendarConflicts(blocks, [gcalEvent("14:30", "15:30")], TODAY, 15 * 60)).toHaveLength(0);
  });

  it("moves blocks out of a do-not-schedule zone", () => {
    const zone: RecurringEvent = { id: "z", title: "Family dinner", days: ["Wed"], startTime: "18:00", endTime: "19:00", color: "#999", locked: false, doNotSchedule: true };
    const blocks = [session("s1", "t", TODAY, "18:30", "19:30")];
    const conflicts = doNotScheduleConflicts(blocks, [zone], TODAY);
    expect(conflicts).toHaveLength(1);
    const moves = resolveDoNotScheduleConflicts(blocks, conflicts, TODAY);
    expect(moves).toEqual([{ id: "s1", startTime: "19:00", endTime: "20:00" }]);
    expect(applyBlockMoves(blocks, moves)[0]).toMatchObject({ startTime: "19:00", userEdited: true });
  });

  it("runReplan previews the calendar fix as a move", () => {
    const task = makeTask({ id: "t", dueDate: "2030-03-22" });
    const state = stateWith({ tasks: [task], scheduleBlocks: [session("s1", "t", TODAY, "15:00", "16:00")], googleCalendarEvents: [gcalEvent("14:30", "15:30")] });
    const preview = runReplan(state, { scope: "today", mode: "calendar_conflicts" }, NOW);
    expect(preview.diff.moved).toHaveLength(1);
    expect(preview.next.scheduleBlocks[0]).toMatchObject({ startTime: "15:30", endTime: "16:30", userEdited: true });
    expect(state.scheduleBlocks[0]!.startTime).toBe("15:00");
  });
});

describe("undo survives a restart until the next change", () => {
  const snapshot = { label: "Fix my day", at: NOW.toISOString(), scheduleBlocks: [makeBlock({ notificationId: "os-1" })], tasks: [], summary: "2 sessions moved", source: "manual" as const };

  it("round-trips (without OS notification ids), also long after the change: there is no 30-minute limit any more", () => {
    const back = parsePersistedUndo(toPersistedUndo(snapshot), new Date(NOW.getTime() + 10 * 60 * 1000));
    expect(back).toMatchObject({ label: "Fix my day", summary: "2 sessions moved", source: "manual" });
    expect(back!.scheduleBlocks[0]!.notificationId).toBeUndefined();
    expect(parsePersistedUndo(toPersistedUndo(snapshot), new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000))).toMatchObject({ label: "Fix my day" });
  });

  it("is dropped when the saved value is malformed", () => {
    expect(parsePersistedUndo(toPersistedUndo({ ...snapshot, at: "not a date" }), NOW)).toBeNull();
    expect(parsePersistedUndo("{not json", NOW)).toBeNull();
    expect(parsePersistedUndo(JSON.stringify({ label: "x", at: NOW.toISOString() }), NOW)).toBeNull();
    expect(parsePersistedUndo(null, NOW)).toBeNull();
  });

  it("a restored snapshot is undoable through the normal reducer path", () => {
    const restored = parsePersistedUndo(toPersistedUndo(snapshot), NOW)!;
    const loaded = reducer(createInitialState(), { type: "LOAD_STATE", payload: { ...stateWith(), undoSnapshots: [restored] } });
    const undone = reducer(loaded, { type: "UNDO_REPLAN" });
    expect(undone.scheduleBlocks).toHaveLength(1);
    expect(undone.undoSnapshots).toBeUndefined();
  });
});

describe("Fix my day / Crunch keep the planner's limits (1.0.8 semester audit)", () => {
  const at = (hour: number, minute = 0) => new Date(2030, 2, 13, hour, minute); // Wed 13 Mar 2030, local
  const upcomingMinutes = (blocks: ScheduleBlock[], taskId: string, now: Date) => blocks
    .filter((b) => b.type === "study" && b.taskId === taskId && b.completionStatus === "pending" && (b.date > TODAY || (b.date === TODAY && b.endTime > `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`)))
    .reduce((sum, b) => sum + (Number(b.endTime.slice(0, 2)) * 60 + Number(b.endTime.slice(3)) - Number(b.startTime.slice(0, 2)) * 60 - Number(b.startTime.slice(3))), 0);

  it("a missed session moved back into today drops its make-up: the work is not planned twice (was 375 min for a 300-min task)", () => {
    const task = makeTask({ id: "x", name: "Essay", dueDate: "2030-03-18", estimatedMinutes: 120 });
    const missed = session("missed", "x", TODAY, "09:00", "10:00", { accepted: false, completionStatus: "missed", autoMissed: true });
    const makeUp = session("makeup", "x", "2030-03-15", "15:00", "16:00", { accepted: false });
    const other = session("other", "x", "2030-03-14", "15:00", "16:00", { accepted: false });
    const state = stateWith({ tasks: [task], scheduleBlocks: [missed, makeUp, other] });
    for (const mode of ["protect_sleep", "crunch_mode"] as const) {
      const preview = runReplan(state, { scope: "today", mode }, NOW);
      expect(preview.diff.moved.map((m) => m.id)).toEqual(["missed"]);
      expect(upcomingMinutes(preview.next.scheduleBlocks, "x", NOW)).toBe(120); // was 180
      expect(preview.diff.removed.map((r) => r.id)).toEqual(["makeup"]); // the latest unconfirmed one goes
      expect(preview.summary).toBe("This moves 1 session into free time today. 1 later session is no longer needed.");
    }
    // Only part of it is surplus: the make-up is shortened instead.
    const longer = stateWith({ tasks: [{ ...task, estimatedMinutes: 150 }], scheduleBlocks: [missed, { ...makeUp, endTime: "17:00" }, other] });
    const preview = runReplan(longer, { scope: "today", mode: "protect_sleep" }, NOW);
    expect(upcomingMinutes(preview.next.scheduleBlocks, "x", NOW)).toBe(150);
    expect(preview.next.scheduleBlocks.find((b) => b.id === "makeup")).toMatchObject({ startTime: "15:00", endTime: "15:30" });
    // The make-up was missed today too: only what the task still needs comes back.
    const twice = stateWith({ tasks: [{ ...task, estimatedMinutes: 60 }], scheduleBlocks: [missed, session("makeup-today", "x", TODAY, "10:30", "11:30", { accepted: false })] });
    const once = runReplan(twice, { scope: "today", mode: "crunch_mode" }, NOW);
    expect(once.diff.moved).toHaveLength(1);
    expect(upcomingMinutes(once.next.scheduleBlocks, "x", NOW)).toBe(60); // was 120
  });

  it("never leaves more than 4 study sessions on the day: a missed session stays missed while the day is full (1.0.9 audit: 5)", () => {
    const tasks = ["a", "b", "c", "d", "x"].map((id) => makeTask({ id, dueDate: "2030-03-18", estimatedMinutes: 60 }));
    const missed = session("missed", "x", TODAY, "09:00", "10:00", { accepted: false, completionStatus: "missed", autoMissed: true });
    const makeUp = session("makeup", "x", "2030-03-15", "15:00", "16:00", { accepted: false });
    const day = [["a1", "a", "13:00", "14:00"], ["b1", "b", "14:30", "15:30"], ["c1", "c", "16:00", "17:00"], ["d1", "d", "17:30", "18:30"]] as const;
    const state = stateWith({ tasks, scheduleBlocks: [missed, makeUp, ...day.map(([id, task, start, end]) => session(id, task, TODAY, start, end, { accepted: false }))] });
    const onToday = (blocks: ScheduleBlock[]) => blocks.filter((b) => b.type === "study" && b.date === TODAY && (b.completionStatus === "pending" || b.completionStatus === "done"));
    for (const mode of ["protect_sleep", "crunch_mode"] as const) {
      const preview = runReplan(state, { scope: "today", mode }, NOW);
      expect(onToday(preview.next.scheduleBlocks)).toHaveLength(4); // was 5: the missed one came back on top of the four
      expect(preview.next.scheduleBlocks.find((b) => b.id === "missed")).toMatchObject({ completionStatus: "missed", startTime: "09:00" });
      expect(preview.unplaced?.map((u) => [u.block.id, u.reason])).toEqual([["missed", "Today already has 4 study sessions."]]);
      expect(preview.next.scheduleBlocks.find((b) => b.id === "makeup")).toMatchObject({ date: "2030-03-15", startTime: "15:00", completionStatus: "pending" }); // its make-up stays
      expect(preview.summary).toBe("1 session will not fit today.");
      const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: NOW.toISOString(), next: preview.next } });
      const replanned = reducer(applied, { type: "AUTO_REPLAN", payload: { now: new Date(NOW.getTime() + 60_000) } });
      expect(onToday(replanned.scheduleBlocks).length).toBeLessThanOrEqual(4);
      expect(upcomingMinutes(replanned.scheduleBlocks, "x", NOW)).toBe(60); // the work is planned once, by its make-up
    }
    // With one of the four skipped the day has room: the missed one comes back (and its make-up goes).
    const roomy = { ...state, scheduleBlocks: state.scheduleBlocks.map((b) => (b.id === "d1" ? { ...b, completionStatus: "skipped" as const } : b)) };
    const back = runReplan(roomy, { scope: "today", mode: "protect_sleep" }, NOW);
    expect(back.diff.moved.map((m) => m.id)).toEqual(["missed"]);
    expect(onToday(back.next.scheduleBlocks)).toHaveLength(4);
    expect(back.diff.removed.map((r) => r.id)).toEqual(["makeup"]);
  });

  it("never moves quiz prep to after the quiz, nor homework past its due time (was 12:05 after a 10:00 quiz, 17:10-18:10 for 17:00)", () => {
    const quiz = makeTask({ id: "q", name: "Quiz 7", kind: "quiz", courseId: "chem", dueDate: TODAY, estimatedMinutes: 30 });
    const hw = makeTask({ id: "hw", name: "Homework", dueDate: TODAY, dueTime: "17:00", estimatedMinutes: 60 });
    const state = stateWith({
      classes: [makeClass()], // Chemistry MWF 10:00-11:00: the quiz is at its class
      tasks: [quiz, hw],
      scheduleBlocks: [session("qprep", "q", TODAY, "08:00", "08:30", { accepted: false }), session("hwS", "hw", TODAY, "12:00", "13:00", { accepted: false })],
    });
    const noon = runReplan(state, { scope: "today", mode: "protect_sleep" }, at(13, 30));
    expect(noon.diff.moved.map((m) => m.id)).toEqual(["hwS"]); // 13:35-14:35: before 17:00, fine
    expect(noon.diff.moved[0]!.to.endTime <= "17:00").toBe(true);
    expect(noon.unplaced?.map((u) => [u.block.id, u.reason])).toEqual([["qprep", "There is no time left before its deadline."]]);

    const late = runReplan(state, { scope: "today", mode: "crunch_mode" }, at(16, 30));
    expect(late.diff.moved.some((m) => m.id === "hwS")).toBe(false); // 16:35-17:35 would be late
    expect(late.unplaced?.find((u) => u.block.id === "hwS")?.reason).toBe("It is due at 5:00 PM and there is no free slot left before then.");
    const evening = runReplan(state, { scope: "today", mode: "crunch_mode" }, at(19));
    expect(evening.diff.moved).toEqual([]);
    expect(evening.unplaced?.find((u) => u.block.id === "hwS")?.reason).toBe("It was due at 5:00 PM.");
    // Homework already late from an earlier day is still caught up on, as the planner does.
    const overdue = stateWith({ tasks: [{ ...hw, dueDate: "2030-03-12" }], scheduleBlocks: [session("hwS", "hw", TODAY, "12:00", "13:00", { accepted: false })] });
    expect(runReplan(overdue, { scope: "today", mode: "protect_sleep" }, at(13, 30)).diff.moved.map((m) => m.id)).toEqual(["hwS"]);
  });

  it("a session that does not fit keeps its time and nothing is moved on top of it (was: preview clean, Undo bar '1 conflict')", () => {
    const tasks = ["a", "b", "c", "d"].map((id) => makeTask({ id }));
    const state = stateWith({
      tasks,
      scheduleBlocks: [
        session("M1", "a", TODAY, "14:00", "15:00", { accepted: false }),
        session("M2", "b", TODAY, "15:30", "16:00", { accepted: false }),
        session("F1", "c", TODAY, "19:30", "21:00", { accepted: false }),
        session("F2", "d", TODAY, "21:10", "22:25", { accepted: false }),
      ],
    });
    for (const mode of ["protect_sleep", "crunch_mode"] as const) {
      const now = at(19);
      const preview = runReplan(state, { scope: "today", mode }, now);
      expect(preview.unplaced?.length).toBeGreaterThan(0);
      const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: now.toISOString(), next: preview.next } });
      expect(countPlanConflicts(applied, applied, now)).toBe(0);
      const today = applied.scheduleBlocks.filter((b) => b.date === TODAY && b.completionStatus === "pending");
      for (const b of today) for (const o of today) if (b.id < o.id) expect(b.startTime < o.endTime && o.startTime < b.endTime, `${b.id} x ${o.id}`).toBe(false);
    }
  });

  it("keeps the no-study zones the planner keeps: 22:00-07:00 by default, also with a 01:00 bedtime (was 22:30-23:30)", () => {
    const task = makeTask({ id: "x", dueDate: "2030-03-18" });
    const late = stateWith({ healthPrefs: { ...createInitialState().healthPrefs, wakeTime: "08:30", bedtime: "01:00" }, tasks: [task], scheduleBlocks: [session("m", "x", TODAY, "10:00", "11:00", { accepted: false })] });
    for (const mode of ["protect_sleep", "crunch_mode"] as const) {
      const at2030 = runReplan(late, { scope: "today", mode }, at(20, 30));
      expect(at2030.diff.moved.map((m) => [m.to.startTime, m.to.endTime])).toEqual([["20:35", "21:35"]]);
      const at2130 = runReplan(late, { scope: "today", mode }, at(21, 30));
      expect(at2130.diff.moved).toEqual([]); // 21:35-22:35 would run into the no-study zone
      expect(at2130.unplaced?.map((u) => u.block.id)).toEqual(["m"]);
    }
    // A zone the student set (do not schedule, Wednesdays 17:00-21:00) is kept too.
    const zone: RecurringEvent = { id: "z", title: "No study", days: ["Wed"], startTime: "17:00", endTime: "21:00", color: "#999", locked: true, doNotSchedule: true };
    const zoned = runReplan({ ...late, recurringEvents: [zone] }, { scope: "today", mode: "crunch_mode" }, at(16, 30));
    expect(zoned.diff.moved.map((m) => [m.to.startTime, m.to.endTime])).toEqual([["21:00", "22:00"]]); // after the zone, before 22:00
  });
});
