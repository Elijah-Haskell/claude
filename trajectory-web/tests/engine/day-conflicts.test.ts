import { describe, expect, it, vi } from "vitest";

// runReplan lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { runReplan } from "../../src/engine/app-context";
import {
  calendarConflicts,
  doNotScheduleConflicts,
  resolveCalendarConflicts,
  resolveDoNotScheduleConflicts,
  sessionsOnCalendarEvents,
} from "../../src/engine/day-conflicts";
import { createInitialState } from "../../src/engine/state-persistence";
import { DEFAULT_HEALTH_PREFS, type AppState, type GoogleCalendarEventLocal, type RecurringEvent, type ScheduleBlock } from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";
import { localMoment, makeBlock, TODAY } from "./scheduler-fixtures";

const gcalEvent = (startTime: string, endTime: string): GoogleCalendarEventLocal => ({
  id: `g-${startTime}`, calendarId: "primary", title: "Dinner", startDate: TODAY, endDate: TODAY, startTime, endTime,
  isAllDay: false, isRecurring: false, status: "active", syncedAt: "2030-03-13T08:00:00.000Z",
});
const zone = (startTime: string, endTime: string): RecurringEvent =>
  ({ id: `z-${startTime}`, title: "Quiet time", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], startTime, endTime, color: "#000", locked: true, doNotSchedule: true });
const study = (startTime: string, endTime: string, id = "s1") => makeBlock({ id, type: "study", taskId: "t1", startTime, endTime });
/** The day's sleep block as the planner writes it (bedtime -> wake, wrapping past midnight). */
const sleepBlock = (bedtime: string, wakeTime: string) => makeBlock({ id: "sleep", type: "sleep", title: "Sleep", startTime: bedtime, endTime: wakeTime, locked: true });

const BED_22 = { ...DEFAULT_HEALTH_PREFS, bedtime: "22:00", wakeTime: "07:00" };
const BED_01 = { ...DEFAULT_HEALTH_PREFS, bedtime: "01:00", wakeTime: "08:00" };

function endsBy(moves: { endTime: string }[], latest: string) {
  for (const move of moves) expect(timeToMinutes(move.endTime)).toBeLessThanOrEqual(timeToMinutes(latest));
}

describe("calendar-conflict Fix never lands in the sleep window", () => {
  it("bedtime 22:00: the audit's case no longer proposes 21:45-22:45", () => {
    const blocks = [study("21:00", "22:00"), sleepBlock("22:00", "07:00")];
    const conflicts = calendarConflicts(blocks, [gcalEvent("20:45", "21:45")], TODAY, 12 * 60);
    expect(conflicts).toHaveLength(1);
    expect(resolveCalendarConflicts(blocks, conflicts, TODAY, BED_22)).toEqual([]); // nothing fits before 21:30
  });

  it("bedtime 22:00: a block that still fits moves, and ends by 21:30 (30 min wind-down, as the planner)", () => {
    const blocks = [study("19:30", "20:30"), sleepBlock("22:00", "07:00")];
    const moves = resolveCalendarConflicts(blocks, calendarConflicts(blocks, [gcalEvent("19:00", "20:00")], TODAY, 12 * 60), TODAY, BED_22);
    expect(moves).toEqual([{ id: "s1", startTime: "20:00", endTime: "21:00" }]);
    endsBy(moves, "21:30");
  });

  it("bedtime 01:00 (after midnight): the late evening is usable, but a block never runs past midnight", () => {
    const blocks = [study("22:30", "23:15"), sleepBlock("01:00", "08:00")];
    const conflicts = calendarConflicts(blocks, [gcalEvent("22:00", "23:00")], TODAY, 12 * 60);
    // The old fixed 23:00 cutoff refused this; with a 01:00 bedtime 23:00-23:45 is awake time.
    expect(resolveCalendarConflicts(blocks, conflicts, TODAY, BED_01)).toEqual([{ id: "s1", startTime: "23:00", endTime: "23:45" }]);
    const long = [study("22:30", "23:30"), sleepBlock("01:00", "08:00")];
    expect(resolveCalendarConflicts(long, calendarConflicts(long, [gcalEvent("22:00", "23:00")], TODAY, 12 * 60), TODAY, BED_01)).toEqual([]);
  });

  it("without sleep settings the default sleep window (23:00-07:00) applies, not a later cutoff", () => {
    const blocks = [study("21:30", "22:30")];
    const moves = resolveCalendarConflicts(blocks, calendarConflicts(blocks, [gcalEvent("21:00", "22:00")], TODAY, 12 * 60), TODAY);
    expect(moves).toEqual([]); // 22:00-23:00 would end after 22:30
  });
});

describe("do-not-schedule Fix never lands in the sleep window", () => {
  it("bedtime 22:00: a zone ending at 21:30 leaves no room, so nothing moves", () => {
    const blocks = [study("20:45", "21:15"), sleepBlock("22:00", "07:00")];
    const conflicts = doNotScheduleConflicts(blocks, [zone("20:30", "21:30")], TODAY);
    expect(conflicts).toHaveLength(1);
    expect(resolveDoNotScheduleConflicts(blocks, conflicts, TODAY, BED_22)).toEqual([]);
  });

  it("bedtime 01:00: a block moves out of an evening zone into the late evening", () => {
    const blocks = [study("21:30", "22:15"), sleepBlock("01:00", "08:00")];
    const moves = resolveDoNotScheduleConflicts(blocks, doNotScheduleConflicts(blocks, [zone("21:00", "22:00")], TODAY), TODAY, BED_01);
    expect(moves).toEqual([{ id: "s1", startTime: "22:00", endTime: "22:45" }]);
  });

  it("early morning: a block pushed out of a pre-dawn zone waits until 30 min after waking", () => {
    const blocks = [study("05:30", "06:30")];
    const moves = resolveDoNotScheduleConflicts(blocks, doNotScheduleConflicts(blocks, [zone("05:00", "06:00")], TODAY), TODAY, BED_22);
    expect(moves).toEqual([{ id: "s1", startTime: "07:30", endTime: "08:30" }]);
  });
});

describe("runReplan passes the student's sleep window to both Fix modes", () => {
  const NOW = localMoment(2030, 3, 13, 18, 0);
  const state = (healthPrefs: AppState["healthPrefs"], blocks: ScheduleBlock[], extra: Partial<AppState> = {}): AppState => ({
    ...createInitialState(),
    onboardingComplete: true,
    healthPrefs,
    scheduleBlocks: blocks,
    ...extra,
  });

  it("calendar conflicts with bedtime 22:00: nothing is proposed inside the sleep window", () => {
    const blocks = [study("21:00", "22:00"), sleepBlock("22:00", "07:00")];
    const preview = runReplan(state(BED_22, blocks, { googleCalendarEvents: [gcalEvent("20:45", "21:45")] }), { scope: "today", mode: "calendar_conflicts" }, NOW);
    expect(preview.diff.moved).toEqual([]);
    expect(preview.summary).toMatch(/no free slot between the conflicting events and bedtime/);
    expect(preview.next.scheduleBlocks).toEqual(blocks);
  });

  it("do-not-schedule zones with bedtime 01:00: the move uses the late evening", () => {
    const blocks = [study("21:30", "22:15"), sleepBlock("01:00", "08:00")];
    const preview = runReplan(state(BED_01, blocks, { recurringEvents: [zone("21:00", "22:00")] }), { scope: "today", mode: "do_not_schedule" }, NOW);
    const moved = preview.next.scheduleBlocks!.find((b) => b.id === "s1")!;
    expect([moved.startTime, moved.endTime]).toEqual(["22:00", "22:45"]);
  });
});

describe("Today's calendar conflicts are only ones the Fix can move (1.0.8 audit: a permanent '1 conflict … overlaps FINC 3100')", () => {
  it("a class (or commitment) that is also in Google Calendar is not a conflict; a study session under an event is", () => {
    const cls = makeBlock({ id: "finc", type: "class", title: "FINC 3100", startTime: "10:00", endTime: "10:50", locked: true });
    const job = makeBlock({ id: "job", type: "recurring", title: "Job shift", startTime: "16:00", endTime: "21:00", locked: true });
    const events = [gcalEvent("10:00", "10:50"), gcalEvent("16:00", "21:00")];
    expect(calendarConflicts([cls, job], events, TODAY, 8 * 60)).toEqual([]); // was 2, and the Fix said "Nothing can move"
    const pending = study("16:30", "17:30");
    expect(calendarConflicts([cls, job, pending], events, TODAY, 8 * 60).map((c) => c.block.id)).toEqual(["s1"]);
  });

  it("finished and locked sessions stay where they are, so they are not reported either", () => {
    const events = [gcalEvent("15:00", "16:00")];
    expect(calendarConflicts([makeBlock({ id: "d", type: "study", taskId: "t1", startTime: "15:00", endTime: "16:00", completionStatus: "done" })], events, TODAY, 8 * 60)).toEqual([]);
    expect(calendarConflicts([makeBlock({ id: "l", type: "study", taskId: "t1", startTime: "15:00", endTime: "16:00", locked: true })], events, TODAY, 8 * 60)).toEqual([]);
  });

  it("an event that runs into another day has no slot after it today: the planner keeps study off it, the Fix leaves it", () => {
    const overnight = { ...gcalEvent("20:00", "02:00"), endDate: "2030-03-14" };
    expect(calendarConflicts([study("20:30", "21:30")], [overnight], TODAY, 8 * 60)).toEqual([]);
  });

  it("iPhone calendar events count like Google's (runReplan reads both)", () => {
    const blocks = [study("16:30", "17:30"), sleepBlock("23:00", "07:00")];
    const device = { ...gcalEvent("16:00", "17:00"), id: "dentist@x", source: "device" as const };
    const preview = runReplan({ ...createInitialState(), onboardingComplete: true, scheduleBlocks: blocks, deviceCalendarEvents: [device] }, { scope: "today", mode: "calendar_conflicts" }, localMoment(2030, 3, 13, 12, 0));
    expect(preview.next.scheduleBlocks!.find((b) => b.id === "s1")).toMatchObject({ startTime: "17:00", endTime: "18:00" });
  });
});

describe("sessions an Undo would put back on a calendar event (sessionsOnCalendarEvents)", () => {
  const NOW = localMoment(2030, 3, 13, 12, 0);

  it("finds open sessions still ahead under a timed or all-day event, as the planner's busy time reads them", () => {
    const later = study("15:00", "16:00", "later");
    const past = study("09:00", "10:00", "past");
    const done = makeBlock({ id: "done", type: "study", taskId: "t1", startTime: "15:00", endTime: "16:00", completionStatus: "done" });
    const started = makeBlock({ id: "started", type: "study", taskId: "t1", startTime: "15:00", endTime: "16:00", startedAt: "2030-03-13T14:00:00.000Z" });
    const tomorrow = makeBlock({ id: "tomorrow", type: "study", taskId: "t1", date: "2030-03-14", startTime: "10:00", endTime: "11:00" });
    const events: GoogleCalendarEventLocal[] = [
      gcalEvent("09:00", "16:00"),
      { ...gcalEvent("00:00", "00:00"), id: "trip", startDate: "2030-03-14", endDate: "2030-03-15", startTime: undefined, endTime: undefined, isAllDay: true },
    ];
    expect(sessionsOnCalendarEvents([later, past, done, started, tomorrow], events, NOW).map((b) => b.id)).toEqual(["later", "tomorrow"]);
    expect(sessionsOnCalendarEvents([later], [], NOW)).toEqual([]);
    expect(sessionsOnCalendarEvents([study("16:00", "17:00")], events, NOW)).toEqual([]); // touching the end is no overlap
  });
});
