import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_REMINDERS,
  REMINDER_WINDOW_DAYS,
  computeLeadReminderDate,
  reminderIdentifier,
  selectReminderWindow,
  sessionStartEnabled,
  sessionStartIdentifier,
  settingsAfterFirstPlanPrompt,
  shouldAskAfterPlan,
  studyNotificationContent,
  type StudyNotificationSettings,
} from "../../src/lib/notification-policy";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, type NotificationSettings, type ScheduleBlock } from "../../src/engine/types";
import { addDaysToKey } from "../../src/engine/utils";
import { localMoment, makeBlock, makeClass, makeTask, NOW, TODAY } from "../engine/scheduler-fixtures";

const ON: NotificationSettings = { enabled: true, leadTimeHours: 24 };

/** `perDay` pending study sessions on each of `days` days starting tomorrow. */
function manyBlocks(days: number, perDay = 3): ScheduleBlock[] {
  const blocks: ScheduleBlock[] = [];
  for (let d = 1; d <= days; d += 1) {
    for (let i = 0; i < perDay; i += 1) {
      const hour = 10 + i * 2;
      blocks.push(makeBlock({
        id: `b-${d}-${i}`, type: "study", taskId: "t", date: addDaysToKey(TODAY, d),
        startTime: `${String(hour).padStart(2, "0")}:00`, endTime: `${String(hour + 1).padStart(2, "0")}:00`, accepted: false,
      }));
    }
  }
  return blocks;
}

describe("selectReminderWindow (whole-semester plans must not overflow iOS's 64-notification cap)", () => {
  it("schedules only the next 7 days and at most 50 notifications, soonest first, out of a 16-week plan", () => {
    const blocks = manyBlocks(112, 3); // 336 sessions
    const planned = selectReminderWindow(blocks, { settings: ON, permission: "granted", now: NOW });

    expect(planned.length).toBeLessThanOrEqual(MAX_PENDING_REMINDERS);
    expect(planned.length).toBeGreaterThan(30);
    const lastAllowed = addDaysToKey(TODAY, REMINDER_WINDOW_DAYS);
    expect(planned.every((p) => p.block.date <= lastAllowed)).toBe(true);
    const times = planned.map((p) => p.fireAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // the earliest session comes first
    expect(planned[0]!.block.id).toBe("b-1-2"); // tomorrow 10:00 and 12:00 would have fired already (24 h ahead)
  });

  it("caps at 50 even when the 7-day window itself holds more (a heavy week)", () => {
    const planned = selectReminderWindow(manyBlocks(14, 6), { settings: ON, permission: "granted", now: NOW });
    expect(planned).toHaveLength(MAX_PENDING_REMINDERS);
  });

  it("the window slides forward with the clock: later sessions get their notifications once they come into range", () => {
    const blocks = manyBlocks(60, 1);
    const early = selectReminderWindow(blocks, { settings: ON, permission: "granted", now: NOW });
    const later = selectReminderWindow(blocks, { settings: ON, permission: "granted", now: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 20, 9, 0) });

    expect(early.some((p) => p.block.date === addDaysToKey(TODAY, 25))).toBe(false);
    expect(later.some((p) => p.block.date === addDaysToKey(TODAY, 25))).toBe(true);
    expect(later.every((p) => p.block.date >= addDaysToKey(TODAY, 20))).toBe(true);
  });

  it("only pending study sessions, and only notification moments still ahead", () => {
    const upcoming = makeBlock({ id: "ok", type: "study", taskId: "t", date: addDaysToKey(TODAY, 3), startTime: "15:00", endTime: "16:00" });
    const blocks = [
      upcoming,
      makeBlock({ id: "done", type: "study", date: addDaysToKey(TODAY, 3), completionStatus: "done" }),
      makeBlock({ id: "skipped", type: "study", date: addDaysToKey(TODAY, 3), completionStatus: "skipped" }),
      makeBlock({ id: "started", type: "study", date: TODAY, startTime: "12:30", endTime: "13:30", startedAt: NOW.toISOString() }),
      makeBlock({ id: "class", type: "class", date: addDaysToKey(TODAY, 3) }),
      makeBlock({ id: "past", type: "study", date: addDaysToKey(TODAY, -1) }),
      // 24h before 13:30 today is yesterday 13:30: only its start notification is still ahead
      makeBlock({ id: "too-soon", type: "study", date: TODAY, startTime: "13:30", endTime: "14:30" }),
    ];
    const planned = selectReminderWindow(blocks, { settings: ON, permission: "granted", now: NOW });

    expect(planned.map((p) => `${p.block.id}:${p.kind}`)).toEqual(["too-soon:start", "ok:reminder", "ok:start"]);
  });

  it("nothing is scheduled while reminders are off or the permission is missing", () => {
    const blocks = manyBlocks(5);
    expect(selectReminderWindow(blocks, { settings: { ...ON, enabled: false }, permission: "granted", now: NOW })).toEqual([]);
    expect(selectReminderWindow(blocks, { settings: ON, permission: "denied", now: NOW })).toEqual([]);
    expect(selectReminderWindow(blocks, { settings: ON, permission: "undetermined", now: NOW })).toEqual([]);
  });

  it("gives every block one stable identifier, so scheduling twice replaces instead of duplicating", () => {
    const first = selectReminderWindow(manyBlocks(3), { settings: ON, permission: "granted", now: NOW });
    const second = selectReminderWindow(manyBlocks(3), { settings: ON, permission: "granted", now: NOW });

    expect(first.map((p) => p.identifier)).toEqual(second.map((p) => p.identifier));
    expect(first[0]!.identifier).toBe(reminderIdentifier("b-1-2"));
    expect(new Set(first.map((p) => p.identifier)).size).toBe(first.length);
  });

  it("works on a real whole-semester plan", () => {
    const plan = buildSemesterPlan({
      classes: [makeClass()],
      recurringEvents: [],
      tasks: Array.from({ length: 40 }, (_, i) => makeTask({ id: `t${i}`, dueDate: addDaysToKey(TODAY, 3 + i * 2), estimatedMinutes: 120 })),
      scheduleBlocks: [],
      healthPrefs: DEFAULT_HEALTH_PREFS,
      userPrefs: DEFAULT_USER_PREFS,
    }, { now: localMoment(2030, 3, 13, 12, 0) });
    const studyCount = plan.scheduleBlocks.filter((b) => b.type === "study").length;
    const planned = selectReminderWindow(plan.scheduleBlocks, { settings: ON, permission: "granted", now: NOW });

    expect(studyCount).toBeGreaterThan(MAX_PENDING_REMINDERS);
    expect(planned.length).toBeLessThanOrEqual(MAX_PENDING_REMINDERS);
    expect(planned.length).toBeGreaterThan(0);
  });
});

describe("session-start notifications and heads-up reminders", () => {
  const block = makeBlock({ id: "s1", type: "study", taskId: "t", title: "Study: Problem set 4", date: addDaysToKey(TODAY, 2), startTime: "19:00", endTime: "20:00" });

  it("every upcoming session gets a start notification at its start time, with a stable identifier", () => {
    const planned = selectReminderWindow([block], { settings: { ...ON, reminders: [] }, permission: "granted", now: NOW });
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ kind: "start", identifier: sessionStartIdentifier("s1"), leadMinutes: 0 });
    expect(planned[0]!.fireAt).toEqual(localMoment(2030, 3, 15, 19, 0));
  });

  it("the start notification can be switched off, leaving only the heads-up reminders", () => {
    const settings: StudyNotificationSettings = { ...ON, sessionStart: false };
    const planned = selectReminderWindow([block], { settings, permission: "granted", now: NOW });
    expect(planned.map((p) => p.kind)).toEqual(["reminder"]);
    expect(sessionStartEnabled(settings)).toBe(false);
    expect(sessionStartEnabled(ON)).toBe(true); // unset = on
  });

  it("honours every saved reminder (minutes before, or a time of day on the day before)", () => {
    const settings: NotificationSettings = {
      ...ON,
      reminders: [
        { id: "r30", leadTimeHours: 1, leadTimeMinutes: 30 },
        { id: "eve", leadTimeHours: 24, leadTimeMinutes: 1440, customHour: 20, customMinute: 0 },
      ],
    };
    const planned = selectReminderWindow([block], { settings, permission: "granted", now: NOW });
    expect(planned.map((p) => [p.identifier, p.fireAt.getTime()])).toEqual([
      [reminderIdentifier("s1", "eve"), localMoment(2030, 3, 14, 20, 0).getTime()],
      [reminderIdentifier("s1", "r30"), localMoment(2030, 3, 15, 18, 30).getTime()],
      [sessionStartIdentifier("s1"), localMoment(2030, 3, 15, 19, 0).getTime()],
    ]);
  });

  it("a reminder pinned to a time that is not before the session is dropped", () => {
    expect(computeLeadReminderDate(block, { minutes: 60, customHour: 21 }, NOW)).toBeNull();
  });

  it("is idempotent: the same plan gives the same notifications", () => {
    const a = selectReminderWindow(manyBlocks(5), { settings: ON, permission: "granted", now: NOW });
    const b = selectReminderWindow(manyBlocks(5), { settings: ON, permission: "granted", now: NOW });
    expect(a.map((p) => `${p.identifier}@${p.fireAt.getTime()}`)).toEqual(b.map((p) => `${p.identifier}@${p.fireAt.getTime()}`));
  });

  it("notification text is plain (no emoji), names the session, and has no focus-timer wording (falls back to the block title when no task is attached)", () => {
    const fireAt = localMoment(2030, 3, 15, 19, 0);
    const start = studyNotificationContent({ block, kind: "start", leadMinutes: 0, fireAt });
    expect(start.title).toBe("Study: Problem set 4");
    expect(start.body).toContain("7:00–8:00 PM");
    const reminder = studyNotificationContent({ block, kind: "reminder", leadMinutes: 30, fireAt });
    expect(reminder.title).toBe("In 30 minutes: Problem set 4");
    const all = `${start.title}${start.body}${reminder.title}${reminder.body}`;
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(all).not.toMatch(/focus timer|start the/i);
  });

  it("selectReminderWindow attaches the matching task, so the content can name the course and the due date", () => {
    const task = makeTask({ id: "t", name: "Quiz 3", courseName: "FINC 3100", dueDate: addDaysToKey(TODAY, 4), dueTime: "23:59" });
    const planned = selectReminderWindow([block], { settings: { ...ON, reminders: [] }, permission: "granted", now: NOW, tasks: [task] });
    expect(planned[0]!.task).toMatchObject({ name: "Quiz 3", courseName: "FINC 3100" });

    const content = studyNotificationContent(planned[0]!);
    expect(content.title).toBe("Study: Quiz 3 · FINC 3100");
    expect(content.body).toBe("7:00–8:00 PM · Quiz 3 due Sun 11:59 PM");
  });

  it("drops the course tag for the placeholder 'General' course and the due tag once the task is done", () => {
    const fireAt = localMoment(2030, 3, 15, 19, 0);
    const task = makeTask({ name: "Quiz 3", courseName: "General", dueDate: addDaysToKey(TODAY, 4) });
    const noCourse = studyNotificationContent({ block, kind: "start", leadMinutes: 0, fireAt, task });
    expect(noCourse.title).toBe("Study: Quiz 3");

    const doneTask = studyNotificationContent({ block, kind: "start", leadMinutes: 0, fireAt, task: { ...task, status: "done" } });
    expect(doneTask.body).not.toMatch(/due/);
  });

  it("never throws on odd session data (a missing end time, an empty task name or title) and still says something", () => {
    const fireAt = localMoment(2030, 3, 15, 19, 0);
    const odd = { ...block, endTime: undefined as unknown as string, title: "" };
    const content = studyNotificationContent({ block: odd, kind: "start", leadMinutes: 0, fireAt, task: makeTask({ name: "  ", dueDate: addDaysToKey(TODAY, 4) }) });
    expect(content.title).toMatch(/^Study: Study session/);
    expect(content.body).toContain("7:00 PM");
    expect(content.body).not.toMatch(/undefined|NaN/);
  });
});

describe("asking for permission after the first plan", () => {
  const base = { alreadyAsked: false, hadStudyAtLoad: false, upcomingStudyCount: 4, planChanged: true, msSinceHydration: 5_000 };

  it("asks a new student as soon as the first plan has sessions", () => {
    expect(shouldAskAfterPlan(base)).toBe(true);
    expect(shouldAskAfterPlan({ ...base, upcomingStudyCount: 0 })).toBe(false);
  });

  it("asks only once", () => {
    expect(shouldAskAfterPlan({ ...base, alreadyAsked: true })).toBe(false);
  });

  it("never prompts at launch for a student who already had a plan; waits for a change they make", () => {
    const upgrader = { ...base, hadStudyAtLoad: true };
    expect(shouldAskAfterPlan({ ...upgrader, msSinceHydration: 2_000 })).toBe(false);
    expect(shouldAskAfterPlan({ ...upgrader, planChanged: false, msSinceHydration: 120_000 })).toBe(false);
    expect(shouldAskAfterPlan({ ...upgrader, msSinceHydration: 120_000 })).toBe(true);
  });

  it("a grant turns notifications (and session starts) on; anything else changes nothing", () => {
    expect(settingsAfterFirstPlanPrompt("granted")).toEqual({ enabled: true, sessionStart: true });
    expect(settingsAfterFirstPlanPrompt("denied")).toBeNull();
    expect(settingsAfterFirstPlanPrompt("already-asked")).toBeNull();
  });
});
