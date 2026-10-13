import { describe, expect, it } from "vitest";

import { computeLeadReminderDate, REMINDER_WINDOW_DAYS } from "../../src/lib/notification-policy";
import {
  addHeadsUpError,
  currentReminders,
  DEFAULT_CUSTOM_HOUR,
  DEFAULT_LEAD_MINUTES,
  DURATION_OPTIONS,
  HOUR_OPTIONS,
  hourLabel,
  newReminder,
  reminderLabel,
  reminderMinutes,
  REMINDERS_COPY,
  remindersNotice,
  settingsAfterAdding,
  settingsAfterRemoving,
} from "../../src/lib/reminders-view";
import type { ReminderTime, ScheduleBlock } from "../../src/engine/types";

describe("the wheels of the 'Add' sheet", () => {
  it("offers the fourteen lead times, shortest first, opening on one hour", () => {
    expect(DURATION_OPTIONS.map((option) => option.label)).toEqual([
      "5 minutes", "10 minutes", "15 minutes", "20 minutes", "30 minutes", "45 minutes", "1 hour", "1.5 hours", "2 hours", "3 hours", "6 hours", "12 hours", "1 day", "2 days",
    ]);
    expect(DURATION_OPTIONS.map((option) => option.minutes)).toEqual([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 360, 720, 1440, 2880]);
    expect(DURATION_OPTIONS.some((option) => option.minutes === DEFAULT_LEAD_MINUTES)).toBe(true);
    expect(DEFAULT_LEAD_MINUTES).toBe(60);
  });

  it("offers every hour of the day, opening on 8:00 AM", () => {
    expect(HOUR_OPTIONS).toHaveLength(24);
    expect(HOUR_OPTIONS.map((hour) => hour.value)).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
    expect([0, 1, 8, 11, 12, 13, 20, 23].map(hourLabel)).toEqual(["12:00 AM", "1:00 AM", "8:00 AM", "11:00 AM", "12:00 PM", "1:00 PM", "8:00 PM", "11:00 PM"]);
    expect(HOUR_OPTIONS[DEFAULT_CUSTOM_HOUR]).toEqual({ value: 8, label: "8:00 AM" });
  });
});

describe("what a heads-up is called", () => {
  it("names how long before, and the time of day when one was set", () => {
    expect(reminderLabel({ leadTimeHours: 1, leadTimeMinutes: 60 })).toBe("1 hour before");
    expect(reminderLabel({ leadTimeHours: 1, leadTimeMinutes: 45 })).toBe("45 minutes before");
    expect(reminderLabel({ leadTimeHours: 24, leadTimeMinutes: 1440, customHour: 8 })).toBe("1 day before, at 8:00 AM");
    expect(reminderLabel({ leadTimeHours: 48, leadTimeMinutes: 2880, customHour: 20 })).toBe("2 days before, at 8:00 PM");
    expect(reminderLabel({ leadTimeHours: 24, leadTimeMinutes: 1440, customHour: 0 })).toBe("1 day before, at 12:00 AM");
  });

  it("reads a reminder saved before minutes existed from its preset hours", () => {
    expect(reminderMinutes({ leadTimeHours: 24 })).toBe(1440);
    expect(reminderMinutes({ leadTimeHours: 24, leadTimeMinutes: 30 })).toBe(30);
    expect(reminderMinutes({ leadTimeHours: 1, leadTimeMinutes: 0 })).toBe(0);
    expect(reminderLabel({ leadTimeHours: 24 })).toBe("1 day before");
    expect(reminderLabel({ leadTimeHours: 6 })).toBe("6 hours before");
  });

  it("falls back to the reminder's own label, then to its minutes, for a time the wheel does not have", () => {
    expect(reminderLabel({ leadTimeHours: 1, leadTimeMinutes: 25, label: "25 minutes before" })).toBe("25 minutes before");
    expect(reminderLabel({ leadTimeHours: 1, leadTimeMinutes: 25 })).toBe("25 min before");
  });
});

describe("the heads-up reminders in force", () => {
  it("is the list, an emptied list included, or the one reminder older settings held", () => {
    const list: ReminderTime[] = [{ id: "a", leadTimeHours: 1, leadTimeMinutes: 60 }];
    expect(currentReminders({ leadTimeHours: 24, reminders: list })).toBe(list);
    expect(currentReminders({ leadTimeHours: 24, reminders: [] })).toEqual([]);
    expect(currentReminders({ leadTimeHours: 6 })).toEqual([{ id: "default", leadTimeHours: 6 }]);
  });
});

describe("adding a heads-up", () => {
  it("saves the minutes chosen, its name, and the nearest preset older builds read", () => {
    expect(newReminder("r1", { minutes: 60 })).toEqual({ id: "r1", leadTimeHours: 1, leadTimeMinutes: 60, label: "1 hour before" });
    expect(DURATION_OPTIONS.map((option) => newReminder("r", { minutes: option.minutes }).leadTimeHours)).toEqual([1, 1, 1, 1, 1, 1, 1, 6, 6, 6, 6, 12, 24, 48]);
  });

  it("saves a time of day only when one was set, on the hour", () => {
    expect(newReminder("r2", { minutes: 1440, customHour: 8 })).toEqual({ id: "r2", leadTimeHours: 24, leadTimeMinutes: 1440, label: "1 day before", customHour: 8, customMinute: 0 });
    expect(newReminder("r3", { minutes: 1440, customHour: 0 })).toMatchObject({ customHour: 0, customMinute: 0 });
    expect("customHour" in newReminder("r4", { minutes: 1440 })).toBe(false);
  });

  it("what it saves is what the notifications are planned from", () => {
    const session = { date: "2026-10-09", startTime: "15:00" } as ScheduleBlock;
    const now = new Date(2026, 9, 7, 9, 0);
    const hourBefore = newReminder("a", { minutes: 60 });
    expect(computeLeadReminderDate(session, { minutes: reminderMinutes(hourBefore), customHour: hourBefore.customHour, customMinute: hourBefore.customMinute }, now)).toEqual(new Date(2026, 9, 9, 14, 0));
    const dayBeforeAt8 = newReminder("b", { minutes: 1440, customHour: 8 });
    expect(computeLeadReminderDate(session, { minutes: reminderMinutes(dayBeforeAt8), customHour: dayBeforeAt8.customHour, customMinute: dayBeforeAt8.customMinute }, now)).toEqual(new Date(2026, 9, 8, 8, 0));
  });

  it("is appended to the list, and the list's preset follows it", () => {
    const existing: ReminderTime[] = [{ id: "default", leadTimeHours: 24 }];
    const added = newReminder("r1", { minutes: 90 });
    expect(settingsAfterAdding(existing, added)).toEqual({ reminders: [{ id: "default", leadTimeHours: 24 }, added], leadTimeHours: 6 });
    expect(existing).toHaveLength(1);
  });

  it("refuses the same heads-up twice, in the words shown over the button", () => {
    const existing: ReminderTime[] = [
      { id: "default", leadTimeHours: 24 },
      { id: "a", leadTimeHours: 1, leadTimeMinutes: 60 },
      { id: "b", leadTimeHours: 24, leadTimeMinutes: 1440, customHour: 8, customMinute: 0 },
    ];
    expect(addHeadsUpError(existing, { minutes: 60 })).toBe("You already have this heads-up");
    // The one from older settings counts too: it is "1 day before".
    expect(addHeadsUpError(existing, { minutes: 1440 })).toBe("You already have this heads-up");
    expect(addHeadsUpError(existing, { minutes: 1440, customHour: 8 })).toBe("You already have this heads-up");
    // The same lead at another time of day, or with one where there was none, is a different heads-up.
    expect(addHeadsUpError(existing, { minutes: 1440, customHour: 20 })).toBeNull();
    expect(addHeadsUpError(existing, { minutes: 60, customHour: 8 })).toBeNull();
    expect(addHeadsUpError(existing, { minutes: 30 })).toBeNull();
    expect(addHeadsUpError([], { minutes: 60 })).toBeNull();
  });
});

describe("removing a heads-up", () => {
  const list: ReminderTime[] = [
    { id: "a", leadTimeHours: 1, leadTimeMinutes: 60 },
    { id: "b", leadTimeHours: 24, leadTimeMinutes: 1440 },
  ];

  it("takes that one out, and the list's preset follows the first one left", () => {
    expect(settingsAfterRemoving(list, "a")).toEqual({ reminders: [list[1]], leadTimeHours: 24 });
    expect(settingsAfterRemoving(list, "b")).toEqual({ reminders: [list[0]], leadTimeHours: 1 });
    expect(settingsAfterRemoving(list, "nobody")).toEqual({ reminders: list, leadTimeHours: 1 });
  });

  it("leaves an empty list, not the old single reminder, when the last one goes", () => {
    const after = settingsAfterRemoving([list[0]!], "a");
    expect(after).toEqual({ reminders: [], leadTimeHours: 24 });
    expect(currentReminders(after)).toEqual([]);
  });
});

describe("the gold note under the switch", () => {
  it("says reminders are blocked when they are on but the browser does not allow them", () => {
    expect(remindersNotice({ enabled: true, permission: "denied", refused: false })).toEqual({ title: "Blocked by this browser", body: "Nothing can be delivered until notifications are allowed for Trajectory." });
    expect(remindersNotice({ enabled: true, permission: "denied", refused: true })?.title).toBe("Blocked by this browser");
  });

  it("says where to allow them when the browser has just refused the switch (iOS says 'iOS Settings'; a browser, its site settings)", () => {
    expect(remindersNotice({ enabled: false, permission: "denied", refused: true })).toEqual({ title: "Notifications are off for Trajectory", body: "Allow them for this site in your browser's settings, then come back here." });
    expect(REMINDERS_COPY.deniedBody).not.toMatch(/iOS/);
  });

  it("says nothing when the browser allows them, has not been asked, or the student simply has them off", () => {
    expect(remindersNotice({ enabled: true, permission: "granted", refused: false })).toBeNull();
    expect(remindersNotice({ enabled: false, permission: "granted", refused: true })).toBeNull();
    expect(remindersNotice({ enabled: false, permission: "undetermined", refused: false })).toBeNull();
    expect(remindersNotice({ enabled: false, permission: "denied", refused: false })).toBeNull();
  });
});

describe("what the screen has always promised, word for word (said for a browser where the platform differs)", () => {
  it("what a session's notification does: a browser notification has no Snooze / Skip, so it promises neither", () => {
    expect(REMINDERS_COPY.sessionStartDetail).toBe("Says what the session is for and when it's due. Click it to open Today.");
    expect(REMINDERS_COPY.sessionStartDetail).not.toMatch(/snooze|skip/i);
  });

  it("how far ahead notifications are set, with the number the planner really uses", () => {
    expect(REMINDER_WINDOW_DAYS).toBe(7);
    expect(REMINDERS_COPY.footnote).toBe("Notifications cover the next 7 days and are rewritten whenever your plan changes, so a moved session never pings you at its old time.");
  });

  it("the note when the browser says no, and the empty list", () => {
    expect(REMINDERS_COPY.deniedTitle).toBe("Notifications are off for Trajectory");
    expect(REMINDERS_COPY.deniedBody).toBe("Allow them for this site in your browser's settings, then come back here.");
    expect(REMINDERS_COPY.noHeadsUp).toBe("No heads-up reminders. Tap Add to get one before each session.");
  });

  it("what the browser adds: reminders come from an open tab, and a browser without notifications says so", () => {
    expect(REMINDERS_COPY.tabNote).toBe("Reminders come from this browser while a Trajectory tab is open.");
    expect(REMINDERS_COPY.unsupported).toMatch(/^This browser cannot show notifications/);
  });

  it("the rest is the iPhone's, unchanged", () => {
    expect(REMINDERS_COPY.sub).toBe("Notifications for the study sessions in your plan.");
    expect(REMINDERS_COPY.master).toBe("Study reminders");
    expect(REMINDERS_COPY.masterDetail).toBe("For the sessions in your plan");
    expect(REMINDERS_COPY.sessionStart).toBe("When a session starts");
    expect(REMINDERS_COPY.headsUp).toBe("A heads-up before a session");
    expect(REMINDERS_COPY.sheetTitle).toBe("Add a heads-up");
    expect(REMINDERS_COPY.sheetSub).toBe("How long before the session starts?");
    expect(REMINDERS_COPY.customTime).toBe("Set specific time of day");
  });
});
