import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeReminderDate,
  reminderLeadLabel,
  remindersActive,
  resolveReminderToggle,
  selectBlocksNeedingReminder,
} from "../../src/lib/notification-policy";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings, type ScheduleBlock } from "../../src/engine/types";

const ENABLED: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true };

function studyBlock(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: "b1",
    type: "study",
    title: "Study: Problem set",
    date: "2030-01-10",
    startTime: "10:00",
    endTime: "11:00",
    locked: false,
    accepted: true,
    color: "#8B5CF6",
    completionStatus: "pending",
    ...overrides,
  };
}

describe("reminder defaults", () => {
  it("are OFF for a new user, so nothing is scheduled and no permission is ever needed", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.enabled).toBe(false);
    expect(remindersActive(DEFAULT_NOTIFICATION_SETTINGS, "granted")).toBe(false);
    expect(
      selectBlocksNeedingReminder([studyBlock()], { settings: DEFAULT_NOTIFICATION_SETTINGS, permission: "granted", today: "2030-01-01" }),
    ).toEqual([]);
  });
});

describe("remindersActive", () => {
  it("requires both the setting and an already-granted permission", () => {
    expect(remindersActive(ENABLED, "granted")).toBe(true);
    expect(remindersActive(ENABLED, "denied")).toBe(false);
    expect(remindersActive(ENABLED, "undetermined")).toBe(false);
    expect(remindersActive({ ...ENABLED, enabled: false }, "granted")).toBe(false);
  });
});

describe("the Reminders switch", () => {
  it("turns on only when the user grants permission", () => {
    expect(resolveReminderToggle(true, true)).toEqual({ enabled: true, showDeniedAlert: false });
  });

  it("stays off and explains how to enable it later when permission is refused", () => {
    expect(resolveReminderToggle(true, false)).toEqual({ enabled: false, showDeniedAlert: true });
  });

  it("turning off never shows the denied note", () => {
    expect(resolveReminderToggle(false, false)).toEqual({ enabled: false, showDeniedAlert: false });
  });
});

describe("selectBlocksNeedingReminder", () => {
  const opts = { settings: ENABLED, permission: "granted" as const, today: "2030-01-05" };

  it("schedules whenever reminders are enabled and permitted, independent of any sign-in state", () => {
    // The options have no sign-in field at all: being logged in or out cannot affect scheduling.
    expect(selectBlocksNeedingReminder([studyBlock()], opts).map((b) => b.id)).toEqual(["b1"]);
  });

  it("does not schedule while permission has not been granted (reading permission never prompts)", () => {
    expect(selectBlocksNeedingReminder([studyBlock()], { ...opts, permission: "undetermined" })).toEqual([]);
    expect(selectBlocksNeedingReminder([studyBlock()], { ...opts, permission: "denied" })).toEqual([]);
  });

  it("only picks upcoming, pending study blocks that have no reminder yet", () => {
    const blocks = [
      studyBlock({ id: "ok" }),
      studyBlock({ id: "class", type: "class" }),
      studyBlock({ id: "done", completionStatus: "done" }),
      studyBlock({ id: "skipped", completionStatus: "skipped" }),
      studyBlock({ id: "has-reminder", notificationId: "os-1" }),
      studyBlock({ id: "past", date: "2030-01-04" }),
      studyBlock({ id: "today", date: "2030-01-05" }),
    ];

    expect(selectBlocksNeedingReminder(blocks, opts).map((b) => b.id)).toEqual(["ok", "today"]);
  });

  it("skips blocks whose scheduling call is still in flight, to avoid duplicate notifications", () => {
    const blocks = [studyBlock({ id: "a" }), studyBlock({ id: "b" })];

    expect(selectBlocksNeedingReminder(blocks, { ...opts, inFlight: new Set(["a"]) }).map((b) => b.id)).toEqual(["b"]);
  });
});

describe("computeReminderDate", () => {
  const now = new Date(2030, 0, 1, 12, 0, 0);

  it("fires the configured number of hours before the block starts", () => {
    expect(computeReminderDate(studyBlock(), 1, now)).toEqual(new Date(2030, 0, 10, 9, 0, 0));
    expect(computeReminderDate(studyBlock(), 6, now)).toEqual(new Date(2030, 0, 10, 4, 0, 0));
  });

  it("holds a day-ahead reminder until 8 AM instead of waking the student at night", () => {
    const early = studyBlock({ startTime: "06:30" });

    expect(computeReminderDate(early, 24, now)).toEqual(new Date(2030, 0, 9, 8, 0, 0));
  });

  it("returns null when the reminder moment has already passed", () => {
    const soon = studyBlock({ date: "2030-01-01", startTime: "12:30" });

    expect(computeReminderDate(soon, 1, now)).toBeNull();
    expect(computeReminderDate(studyBlock({ date: "2029-12-31" }), 24, now)).toBeNull();
  });

  it("returns null for a malformed date or time instead of scheduling garbage", () => {
    expect(computeReminderDate(studyBlock({ date: "soon" }), 1, now)).toBeNull();
    expect(computeReminderDate(studyBlock({ startTime: "" }), 1, now)).toBeNull();
  });
});

describe("reminderLeadLabel", () => {
  it("words the notification for its real lead time", () => {
    expect(reminderLeadLabel(24)).toBe("Tomorrow");
    expect(reminderLeadLabel(48)).toBe("In 2 days");
    expect(reminderLeadLabel(1)).toBe("In 1 hour");
    expect(reminderLeadLabel(6)).toBe("In 6 hours");
  });
});

describe("notification copy policy", () => {
  it("contains no post-start accountability or daily nag notification behavior", () => {
    const root = resolve(__dirname, "..", "..");
    for (const file of ["src/lib/notifications.ts", "src/lib/notification-policy.ts", "src/components/headless/study-notifications.tsx", "src/screens/reminders.tsx", "src/engine/app-context.ts", "src/engine/types.ts"]) {
      const text = readFileSync(resolve(root, file), "utf8");
      expect(text, file).not.toMatch(/accountability/i);
      expect(text, file).not.toMatch(/10 minutes AFTER/i);
    }
  });

  it("asks for permission only from the Reminders switch, never as a side effect", () => {
    const root = resolve(__dirname, "..", "..");
    const asks = (file: string) => (readFileSync(resolve(root, file), "utf8").match(/requestNotificationPermissions\(/g) ?? []).length;
    expect(asks("src/screens/reminders.tsx")).toBe(1);
    expect(asks("src/components/headless/study-notifications.tsx")).toBe(0);
    expect(asks("src/lib/pass-reminders.ts")).toBe(0);
    const lib = readFileSync(resolve(root, "src/lib/notifications.ts"), "utf8");
    // The browser's prompt is called in one place in the library, inside requestNotificationPermissions itself.
    expect(lib.match(/Notification\.requestPermission\(/g)).toHaveLength(1);
  });
});
