/**
 * Reminders (app/notification-settings.tsx on the iPhone, src/screens/reminders.tsx here), as pure functions: the
 * heads-up choices of the wheel, what each heads-up is called, what adding or removing one saves, which parts of the
 * page show, and the note that says the browser is not letting anything through. The sentences the screen has
 * always promised are kept here word for word, except where the browser differs from iOS: notifications are allowed
 * or blocked for this site in the browser's settings (there is no iOS Settings to open), a notification carries no
 * Snooze / Skip buttons here, and reminders come while a Trajectory tab is open.
 */
import { REMINDER_WINDOW_DAYS, type NotificationPermission } from "./notification-policy";
import type { NotificationSettings, ReminderTime } from "../engine/types";

/** The wheel of the "Add" sheet: how long before a session. */
export const DURATION_OPTIONS: readonly { label: string; minutes: number }[] = [
  { label: "5 minutes", minutes: 5 },
  { label: "10 minutes", minutes: 10 },
  { label: "15 minutes", minutes: 15 },
  { label: "20 minutes", minutes: 20 },
  { label: "30 minutes", minutes: 30 },
  { label: "45 minutes", minutes: 45 },
  { label: "1 hour", minutes: 60 },
  { label: "1.5 hours", minutes: 90 },
  { label: "2 hours", minutes: 120 },
  { label: "3 hours", minutes: 180 },
  { label: "6 hours", minutes: 360 },
  { label: "12 hours", minutes: 720 },
  { label: "1 day", minutes: 1440 },
  { label: "2 days", minutes: 2880 },
];
/** What the wheel opens on: 1 hour. */
export const DEFAULT_LEAD_MINUTES = 60;
/** What the hour wheel opens on: 8:00 AM. */
export const DEFAULT_CUSTOM_HOUR = 8;

/** "8:00 AM" */
export function hourLabel(hour: number): string {
  return `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`;
}

/** The hour wheel of "Set specific time of day": every hour of the day. */
export const HOUR_OPTIONS: readonly { value: number; label: string }[] = Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: hourLabel(hour) }));

export const REMINDERS_COPY = {
  sub: "Notifications for the study sessions in your plan.",
  master: "Study reminders",
  masterDetail: "For the sessions in your plan",
  sessionStart: "When a session starts",
  /** The iPhone's notification carries Snooze and Skip; a browser's does not, so it says only what it can do. */
  sessionStartDetail: "Says what the session is for and when it's due. Click it to open Today.",
  headsUp: "A heads-up before a session",
  noHeadsUp: "No heads-up reminders. Use Add to get one before each session.",
  footnote: `Notifications cover the next ${REMINDER_WINDOW_DAYS} days and are rewritten whenever your plan changes, so a moved session never pings you at its old time.`,
  /** What the browser adds: reminders are shown by this browser, so a Trajectory tab has to be open. */
  tabNote: "Reminders come from this browser while a Trajectory tab is open.",
  /** A browser without the Notification API (or one that keeps it from web pages). */
  unsupported: "This browser cannot show notifications, so reminders cannot come here. The iPhone app can remind you.",
  sheetTitle: "Add a heads-up",
  sheetSub: "How long before the session starts?",
  customTime: "Set specific time of day",
  /** The note when the browser says no to the switch (iOS shows an alert with "Open Settings"; a browser has none to open). */
  deniedTitle: "Notifications are off for Trajectory",
  deniedBody: "Allow them for this site in your browser's settings, then come back here.",
} as const;

/** How long before a session this heads-up comes, in minutes. */
export function reminderMinutes(reminder: Pick<ReminderTime, "leadTimeHours" | "leadTimeMinutes">): number {
  return reminder.leadTimeMinutes !== undefined ? reminder.leadTimeMinutes : reminder.leadTimeHours * 60;
}

/** "1 hour before", "1 day before, at 8:00 AM" */
export function reminderLabel(reminder: Pick<ReminderTime, "leadTimeHours" | "leadTimeMinutes" | "customHour" | "label">): string {
  const minutes = reminderMinutes(reminder);
  const option = DURATION_OPTIONS.find((candidate) => candidate.minutes === minutes);
  const base = option ? `${option.label} before` : reminder.label ?? `${minutes} min before`;
  return reminder.customHour !== undefined ? `${base}, at ${hourLabel(reminder.customHour)}` : base;
}

/** The heads-up reminders in force: the list, or for settings saved before there was a list, the one they held. */
export function currentReminders(settings: Pick<NotificationSettings, "reminders" | "leadTimeHours">): ReminderTime[] {
  return settings.reminders ?? [{ id: "default", leadTimeHours: settings.leadTimeHours }];
}

export interface HeadsUpDraft {
  minutes: number;
  /** Only with "Set specific time of day" on. */
  customHour?: number;
}

/** The heads-up the "Add" sheet is about to add, as it is saved. */
export function newReminder(id: string, draft: HeadsUpDraft): ReminderTime {
  const option = DURATION_OPTIONS.find((candidate) => candidate.minutes === draft.minutes) ?? DURATION_OPTIONS[6]!;
  // Older builds read only this preset: the nearest one at or above the chosen time.
  const leadTimeHours: ReminderTime["leadTimeHours"] = draft.minutes <= 60 ? 1 : draft.minutes <= 360 ? 6 : draft.minutes <= 720 ? 12 : draft.minutes <= 1440 ? 24 : 48;
  return {
    id,
    leadTimeHours,
    leadTimeMinutes: draft.minutes,
    label: `${option.label} before`,
    ...(draft.customHour !== undefined ? { customHour: draft.customHour, customMinute: 0 } : {}),
  };
}

/** Why "Add" cannot act, in the words shown over it; null when it can. The same heads-up twice would ring twice. */
export function addHeadsUpError(reminders: readonly ReminderTime[], draft: HeadsUpDraft): string | null {
  const same = reminders.some((reminder) => reminderMinutes(reminder) === draft.minutes && reminder.customHour === draft.customHour);
  return same ? "You already have this heads-up" : null;
}

/** What is saved after adding a heads-up. */
export function settingsAfterAdding(reminders: readonly ReminderTime[], added: ReminderTime): Pick<NotificationSettings, "reminders" | "leadTimeHours"> {
  return { reminders: [...reminders, added], leadTimeHours: added.leadTimeHours };
}

/** What is saved after removing one. */
export function settingsAfterRemoving(reminders: readonly ReminderTime[], id: string): Pick<NotificationSettings, "reminders" | "leadTimeHours"> {
  const kept = reminders.filter((reminder) => reminder.id !== id);
  return { reminders: kept, leadTimeHours: kept[0]?.leadTimeHours ?? 24 };
}

/**
 * The gold note under the switch, or null. Reminders are on but the browser does not allow them: nothing can be
 * delivered. Or the switch was just refused by the browser: it stays off, and the note says where to allow them.
 */
export function remindersNotice(input: { enabled: boolean; permission: NotificationPermission; refused: boolean }): { title: string; body: string } | null {
  if (input.permission !== "denied") return null;
  if (input.enabled) return { title: "Blocked by this browser", body: "Nothing can be delivered until notifications are allowed for Trajectory." };
  if (input.refused) return { title: REMINDERS_COPY.deniedTitle, body: REMINDERS_COPY.deniedBody };
  return null;
}
