/**
 * Outside calendar events and Undo (owner's 1.0.9 item "a Google sync drops Undo"; every iPhone-calendar refresh would
 * hit it too). When Google's or the iPhone's calendar events change and the automatic re-plan moves or removes
 * sessions, the student sees "Plan updated for calendar changes" WITHOUT an Undo of its own (the calendar cannot be
 * un-changed), the older Undo stack is left alone, and undoing an older change afterwards never puts a session back on
 * top of a calendar event.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { CALENDAR_REPLAN_LABEL, reducer } from "../../src/engine/app-context";
import { busyCalendarEvents } from "../../src/engine/calendar-events";
import { sessionsOnCalendarEvents } from "../../src/engine/day-conflicts";
import { planInputsKey } from "../../src/engine/plan-inputs";
import { countConflicts } from "../../src/engine/plan-quality";
import { createInitialState, parsePersistedState, toLocalPersistedState } from "../../src/engine/state-persistence";
import type { AppState, GoogleCalendarEventLocal, RecurringEvent, ScheduleBlock } from "../../src/engine/types";
import { fiveCourseState } from "./fixtures/stress-semester";

type Action = Parameters<typeof reducer>[1];
const run = (state: AppState, ...actions: Action[]) => actions.reduce(reducer, state);
const at = (date: string, hour: number, minute = 0) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour, minute);
};
const hhmm = (now: Date) => `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
const slotKey = (b: ScheduleBlock) => `${b.taskId}|${b.date}|${b.startTime}|${b.endTime}`;
const upcomingStudy = (blocks: ScheduleBlock[], now: Date) => {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return blocks.filter((b) => b.type === "study" && b.taskId && b.completionStatus === "pending" && (b.date > today || (b.date === today && b.endTime > hhmm(now))));
};

const MONDAY = "2026-09-07";
const NOW = at(MONDAY, 8, 5);
const JOB: RecurringEvent = { id: "job", title: "Job shift", days: ["Tue", "Thu", "Sat"], startTime: "16:00", endTime: "21:00", color: "#EC4899", locked: true };
const fresh = () => run({ ...createInitialState(), ...fiveCourseState() }, { type: "AUTO_BUILD_WEEK", payload: { now: at(MONDAY, 8) } });

/** An event read from the iPhone's calendars, on top of `block`. */
const deviceEventOn = (block: Pick<ScheduleBlock, "date" | "startTime" | "endTime">, id = "dentist"): GoogleCalendarEventLocal => ({
  id: `${id}@${block.date}`, calendarId: "home", title: "Dentist", startDate: block.date, endDate: block.date, startTime: block.startTime, endTime: block.endTime,
  isAllDay: false, isRecurring: false, status: "active", syncedAt: NOW.toISOString(), source: "device",
});
const conflicts = (state: AppState) => countConflicts(state.scheduleBlocks, state, { fromDate: MONDAY });
const onEvents = (state: AppState, now = NOW) => sessionsOnCalendarEvents(state.scheduleBlocks, busyCalendarEvents(state), now);

/** The heavy semester plus a new job (one undoable "Plan updated for your new commitment"). */
function withJob() {
  const base = fresh();
  const state = run(base, { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now: NOW } });
  expect(state.undoSnapshots).toHaveLength(1);
  return { base, state };
}

/** A session that sits on the same slot before and after the job was added (so undoing the job brings it back there). */
function sessionInBothPlans(base: AppState, state: AppState): ScheduleBlock {
  const before = new Set(upcomingStudy(base.scheduleBlocks, NOW).map(slotKey));
  const found = upcomingStudy(state.scheduleBlocks, NOW).find((b) => b.date > MONDAY && before.has(slotKey(b)));
  expect(found).toBeDefined();
  return found!;
}

describe("an iPhone calendar event lands on a session", () => {
  it("the session moves, the student is told without an Undo, and the older Undo stays", () => {
    const { state } = withJob();
    const target = upcomingStudy(state.scheduleBlocks, NOW).find((b) => b.date > MONDAY)!;
    const after = run(state, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [deviceEventOn(target)] }, { type: "AUTO_REPLAN", payload: { now: NOW } });

    expect(after.scheduleBlocks.some((b) => slotKey(b) === slotKey(target) && b.completionStatus === "pending")).toBe(false);
    expect(conflicts(after)).toBe(0);
    expect(onEvents(after)).toEqual([]);
    expect(after.replanNotice).toMatchObject({ label: CALENDAR_REPLAN_LABEL, at: NOW.toISOString() });
    expect(after.replanNotice!.summary).toMatch(/^1 session (moved|removed)/);
    expect(after.undoSnapshots).toBe(state.undoSnapshots); // was: wiped (and its saved copy removed)
    expect(after.inputsBeforeEdit).toBeUndefined();
  });

  it("undoing the older change afterwards re-checks the restored plan: nothing ends up on the event", () => {
    const { base, state } = withJob();
    const target = sessionInBothPlans(base, state);
    const after = run(state, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [deviceEventOn(target)] }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    const later = new Date(NOW.getTime() + 60_000);

    const undone = reducer(after, { type: "UNDO_REPLAN", now: later });
    expect(undone.recurringEvents).toEqual(base.recurringEvents); // the job is gone, as Undo promised
    expect(undone.undoSnapshots).toBeUndefined();
    // The plan from before the job had a session on the event's slot: it is moved again, not put back on the event.
    expect(base.scheduleBlocks.some((b) => slotKey(b) === slotKey(target))).toBe(true);
    expect(onEvents(undone, later)).toEqual([]);
    expect(conflicts(undone)).toBe(0);
    expect(undone.replanNotice).toMatchObject({ label: CALENDAR_REPLAN_LABEL, at: later.toISOString() });
    // Everything else is exactly the plan from before the job.
    const others = (blocks: ScheduleBlock[]) => upcomingStudy(blocks, later).filter((b) => b.taskId !== target.taskId).map(slotKey).sort();
    expect(others(undone.scheduleBlocks)).toEqual(others(base.scheduleBlocks));
    // The re-plan the provider runs after the undo (its inputs changed back) has nothing left to do.
    const settled = reducer(undone, { type: "AUTO_REPLAN", payload: { now: new Date(later.getTime() + 2000) } });
    expect(settled.undoSnapshots).toBeUndefined();
    expect(settled.scheduleBlocks.filter((b) => b.completionStatus === "pending").map(slotKey)).toEqual(undone.scheduleBlocks.filter((b) => b.completionStatus === "pending").map(slotKey));
  });

  it("an Undo with nothing on a calendar event is still exact (and clears an older calendar notice)", () => {
    const { base, state } = withJob();
    const farAway = upcomingStudy(state.scheduleBlocks, NOW).find((b) => b.date > MONDAY)!;
    // An event at 03:00, while the student sleeps: nothing moves, no notice.
    const quiet = run(state, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [deviceEventOn({ date: farAway.date, startTime: "03:00", endTime: "04:00" })] }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(quiet.replanNotice).toBeUndefined();
    expect(quiet.undoSnapshots).toBe(state.undoSnapshots);
    const undone = reducer({ ...quiet, replanNotice: { label: CALENDAR_REPLAN_LABEL, summary: "1 session moved · 0 conflicts", at: NOW.toISOString() } }, { type: "UNDO_REPLAN", now: NOW });
    expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
    expect(undone.replanNotice).toBeUndefined();
  });

  it("the same events read again change nothing: no re-plan input changes, no notice, the stack untouched", () => {
    const { state } = withJob();
    const target = upcomingStudy(state.scheduleBlocks, NOW).find((b) => b.date > MONDAY)!;
    const event = deviceEventOn(target);
    const after = run(state, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [event] }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    const reread = reducer(after, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [{ ...event, syncedAt: new Date(NOW.getTime() + 3_600_000).toISOString() }] });
    expect(reread.inputsBeforeEdit?.calendarChanged).toBeUndefined();
    expect(planInputsKey(reread, MONDAY)).toBe(planInputsKey(after, MONDAY));
    const replanned = reducer(reread, { type: "AUTO_REPLAN", payload: { now: new Date(NOW.getTime() + 2000) } });
    expect(replanned.undoSnapshots).toBe(state.undoSnapshots);
    expect(replanned.replanNotice).toBe(after.replanNotice);
  });

  it("turning the iPhone calendars off (or a Google disconnect) frees time without touching the Undo stack", () => {
    const { state } = withJob();
    const target = upcomingStudy(state.scheduleBlocks, NOW).find((b) => b.date > MONDAY)!;
    const after = run(state, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [deviceEventOn(target)] }, { type: "AUTO_REPLAN", payload: { now: NOW } });

    const cleared = run(after, { type: "CLEAR_DEVICE_CALENDAR_EVENTS" }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(cleared.deviceCalendarEvents).toEqual([]);
    expect(cleared.undoSnapshots).toBe(state.undoSnapshots);
    expect(cleared.replanNotice).toBe(after.replanNotice); // nothing moved: no new notice
    expect(reducer(cleared, { type: "CLEAR_DEVICE_CALENDAR_EVENTS" })).toBe(cleared); // already empty: no change at all

    const google = { ...deviceEventOn(target, "g1"), source: "google" as const };
    const synced = run(state, { type: "SET_GOOGLE_CALENDAR_EVENTS", payload: { events: [google], connected: true, lastSync: NOW.toISOString() } }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(synced.undoSnapshots).toBe(state.undoSnapshots);
    expect(synced.replanNotice?.label).toBe(CALENDAR_REPLAN_LABEL);
    const disconnected = run(synced, { type: "CLEAR_GOOGLE_CALENDAR" }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(disconnected.undoSnapshots).toBe(state.undoSnapshots);
    expect(disconnected.replanNotice).toBe(synced.replanNotice);
  });

  it("a calendar change that arrives together with an edit: the edit keeps its Undo, which still respects the calendar", () => {
    const base = fresh();
    const target = upcomingStudy(base.scheduleBlocks, NOW).find((b) => b.date > MONDAY && !JOB.days.includes(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${b.date}T12:00:00`).getDay()] as RecurringEvent["days"][number]))!;
    const after = run(
      base,
      { type: "ADD_RECURRING_EVENT", payload: JOB },
      { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [deviceEventOn(target)] },
      { type: "AUTO_REPLAN", payload: { now: NOW } },
    );
    expect(after.undoSnapshots?.[0]).toMatchObject({ label: "Plan updated for your new commitment", source: "auto" });
    expect(conflicts(after)).toBe(0);
    const undone = reducer(after, { type: "UNDO_REPLAN", now: NOW });
    expect(undone.recurringEvents).toEqual(base.recurringEvents);
    expect(undone.deviceCalendarEvents).toHaveLength(1); // the calendar is not un-changed
    expect(onEvents(undone)).toEqual([]);
    expect(conflicts(undone)).toBe(0);
  });
});

describe("iPhone calendar events in the plan's inputs", () => {
  it("a new or moved event changes the re-plan key; a renamed one does not", () => {
    const state = fresh();
    const block = upcomingStudy(state.scheduleBlocks, NOW)[0]!;
    const event = deviceEventOn(block);
    const withEvent = reducer(state, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [event] });
    expect(planInputsKey(withEvent, MONDAY)).not.toBe(planInputsKey(state, MONDAY));
    expect(withEvent.inputsBeforeEdit?.calendarChanged).toBe(true);
    const renamed = reducer(withEvent, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [{ ...event, title: "Orthodontist" }] });
    expect(planInputsKey(renamed, MONDAY)).toBe(planInputsKey(withEvent, MONDAY));
    const moved = reducer(withEvent, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [{ ...event, startTime: "06:00", endTime: "06:30" }] });
    expect(planInputsKey(moved, MONDAY)).not.toBe(planInputsKey(withEvent, MONDAY));
  });

  it("events are kept one per id and always marked as device events", () => {
    const block = upcomingStudy(fresh().scheduleBlocks, NOW)[0]!;
    const event = deviceEventOn(block);
    const next = reducer(createInitialState(), { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [event, { ...event, title: "Copy" }, { ...event, id: "other", source: undefined }] });
    expect(next.deviceCalendarEvents?.map((e) => [e.id, e.source])).toEqual([[event.id, "device"], ["other", "device"]]);
  });

  it("are saved with the plan (a launch plans with them at once); the calendar notice is not", () => {
    const block = upcomingStudy(fresh().scheduleBlocks, NOW)[0]!;
    const state: AppState = {
      ...createInitialState(),
      deviceCalendarEvents: [deviceEventOn(block)],
      replanNotice: { label: CALENDAR_REPLAN_LABEL, summary: "1 session moved · 0 conflicts", at: NOW.toISOString() },
    };
    const saved = JSON.stringify(toLocalPersistedState(state));
    expect(saved).not.toContain(CALENDAR_REPLAN_LABEL);
    const restored = parsePersistedState(saved)!;
    // Saved packed (lib/state-persistence.ts packDeviceEvents): what the plan and the screens read comes back exactly.
    expect(restored.deviceCalendarEvents).toEqual(state.deviceCalendarEvents!.map((e) => ({ ...e, calendarId: "", syncedAt: "" })));
    expect(restored.replanNotice).toBeUndefined();
    // Malformed entries from disk are dropped; old saves have none.
    expect(parsePersistedState(JSON.stringify({ deviceCalendarEvents: [null, { id: 3 }, "x"] }))!.deviceCalendarEvents).toEqual([]);
    expect(parsePersistedState(JSON.stringify({ onboardingComplete: true }))!.deviceCalendarEvents).toEqual([]);
  });
});
