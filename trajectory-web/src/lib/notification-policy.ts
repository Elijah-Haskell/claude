/**
 * Pure decision logic for study notifications (the iPhone app's lib/notification-policy.ts, unchanged). No browser
 * API here so it can be unit tested; lib/notifications.ts and components/headless/study-notifications.tsx wire it to
 * the browser's Notification API.
 *
 * Rules:
 *  - Notifications are OFF for a fresh install (DEFAULT_NOTIFICATION_SETTINGS.enabled === false).
 *  - The permission prompt is shown when the student flips the switch on the Reminders screen (a browser shows it
 *    only on a click). Everything else merely *reads* the permission status. Granting it turns notifications on.
 *  - Notifications are scheduled whenever settings.enabled AND permission is granted.
 *    Being signed in has no bearing on local notifications.
 *  - Two kinds per upcoming study session: a "session start" notification and the student's optional heads-up
 *    reminders ("1 hour before", "1 day before at 8 PM", ...). Both say what the session is for and, when it works
 *    toward a task, when that task is due (engine/due-label.ts).
 */
import type { NotificationSettings, ReminderTime, ScheduleBlock, Task } from "../engine/types";
import { relativeDayLabel } from "../engine/due-label";

export type NotificationPermission = "granted" | "denied" | "undetermined";

/**
 * NotificationSettings plus the session-start switch. Stored inside `state.notificationSettings` (the persisted
 * settings object keeps unknown keys); a missing value means "on".
 */
export interface StudyNotificationSettings extends NotificationSettings {
  /** Notify when a study session starts. Default true. */
  sessionStart?: boolean;
}

/** True when notifications may be scheduled right now. */
export function remindersActive(settings: NotificationSettings, permission: NotificationPermission): boolean {
  return settings.enabled === true && permission === "granted";
}

/** Whether session-start notifications are on (they are unless explicitly switched off). */
export function sessionStartEnabled(settings: NotificationSettings): boolean {
  return (settings as StudyNotificationSettings).sessionStart !== false;
}

/**
 * What the Reminders switch should do. Turning ON requires the user to grant the permission (which the switch
 * handler requests); if they refuse, the setting stays off and they are told how to enable it later.
 */
export function resolveReminderToggle(
  requestedEnabled: boolean,
  permissionGrantedAfterPrompt: boolean,
): { enabled: boolean; showDeniedAlert: boolean } {
  if (!requestedEnabled) return { enabled: false, showDeniedAlert: false };
  return permissionGrantedAfterPrompt
    ? { enabled: true, showDeniedAlert: false }
    : { enabled: false, showDeniedAlert: true };
}

/**
 * What to do after the first-plan permission prompt. Only a grant turns notifications on; a refusal leaves the
 * setting off (the student can still enable it in Settings later) and is never asked about again.
 */
export function settingsAfterFirstPlanPrompt(
  outcome: "granted" | "denied" | "already-asked" | "unavailable",
): Partial<StudyNotificationSettings> | null {
  return outcome === "granted" ? { enabled: true, sessionStart: true } : null;
}

function blockStart(block: ScheduleBlock): Date | null {
  const [year, month, day] = block.date.split("-").map(Number);
  const [hour, minute] = block.startTime.split(":").map(Number);
  if ([year, month, day, hour, minute].some((n) => !Number.isFinite(n))) return null;
  return new Date(year!, month! - 1, day!, hour!, minute!, 0);
}

/**
 * The moment a reminder should fire, or null if that moment has already passed.
 * `now` is injected so callers/tests control the clock.
 */
export function computeReminderDate(block: ScheduleBlock, leadTimeHours: number, now: Date): Date | null {
  return computeLeadReminderDate(block, { minutes: leadTimeHours * 60 }, now);
}

/** One heads-up reminder: how long before the session, optionally pinned to a time of day. */
export interface ReminderLead {
  id?: string;
  minutes: number;
  customHour?: number;
  customMinute?: number;
}

/**
 * When a heads-up reminder fires: `minutes` before the session, or — with a custom time of day — at that time on
 * the day `minutes` before (e.g. "1 day before, at 8 PM"). A day-ahead reminder without a custom time is held until
 * 8 AM rather than firing in the night. Null when the moment has passed or would not be before the session.
 */
export function computeLeadReminderDate(block: ScheduleBlock, lead: ReminderLead, now: Date): Date | null {
  const start = blockStart(block);
  if (!start || !Number.isFinite(lead.minutes) || lead.minutes < 0) return null;
  const reminderDate = new Date(start.getTime() - lead.minutes * 60 * 1000);
  if (lead.customHour !== undefined && Number.isFinite(lead.customHour)) {
    reminderDate.setHours(lead.customHour, lead.customMinute ?? 0, 0, 0);
  } else if (lead.minutes === 24 * 60 && reminderDate.getHours() < 8) {
    // A day-ahead reminder should not wake anyone at 3 AM: hold it until 8 AM.
    reminderDate.setHours(8, 0, 0, 0);
  }
  if (reminderDate.getTime() >= start.getTime()) return null;
  return reminderDate.getTime() <= now.getTime() ? null : reminderDate;
}

/** Human wording for how far ahead the reminder fires. */
export function reminderLeadLabel(leadTimeHours: number): string {
  if (leadTimeHours === 24) return "Tomorrow";
  if (leadTimeHours === 48) return "In 2 days";
  return leadTimeHours === 1 ? "In 1 hour" : `In ${leadTimeHours} hours`;
}

/** Wording for a lead given in minutes. */
export function reminderLeadLabelMinutes(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return reminderLeadLabel(minutes / 60);
  return minutes === 1 ? "In 1 minute" : `In ${minutes} minutes`;
}

/** The student's heads-up reminders (the legacy single `leadTimeHours` when no list was ever saved). */
export function reminderLeads(settings: NotificationSettings): ReminderLead[] {
  const list: ReminderTime[] | undefined = settings.reminders;
  if (!Array.isArray(list)) return [{ id: "default", minutes: (settings.leadTimeHours ?? 24) * 60 }];
  return list.map((r) => ({
    id: r.id,
    minutes: r.leadTimeMinutes ?? r.leadTimeHours * 60,
    customHour: r.customHour,
    customMinute: r.customMinute,
  }));
}

/**
 * iOS keeps at most 64 pending local notifications per app. Plan at most 50, which leaves room for snoozes and
 * any other notification. The browser has no such cap, but the same window keeps the two apps' behaviour one.
 */
export const MAX_PENDING_REMINDERS = 50;
/** Notifications are only scheduled this far ahead; later sessions are scheduled as they come into range. */
export const REMINDER_WINDOW_DAYS = 7;

export type StudyNotificationKind = "start" | "reminder";

export interface PlannedReminder {
  block: ScheduleBlock;
  /** Notification identifier: stable per block and kind, so scheduling twice replaces instead of duplicating. */
  identifier: string;
  fireAt: Date;
  kind: StudyNotificationKind;
  /** Minutes before the session (0 for the start notification). */
  leadMinutes: number;
  /** The task this session works on (from block.taskId), when the caller passed `tasks` to selectReminderWindow. Names the notification and says when the work is due. */
  task?: Pick<Task, "name" | "courseName" | "dueDate" | "dueTime" | "status">;
}

/** Stable notification identifier for a block's heads-up reminder (one per reminder setting). */
export function reminderIdentifier(blockId: string, leadId?: string): string {
  return leadId && leadId !== "default" ? `study-${blockId}-${leadId}` : `study-${blockId}`;
}

/** Stable notification identifier for a block's session-start notification. */
export function sessionStartIdentifier(blockId: string): string {
  return `study-start-${blockId}`;
}

function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The study notifications that should be pending right now: for every upcoming pending study session within the
 * next REMINDER_WINDOW_DAYS days, its start notification (when enabled) and each heads-up reminder whose moment is
 * still ahead; soonest first, at most MAX_PENDING_REMINDERS. The app re-runs this (and reconciles the timers) after
 * every plan change and whenever the tab comes back, so the window slides forward with the calendar. Idempotent.
 */
export function selectReminderWindow(
  blocks: readonly ScheduleBlock[],
  opts: {
    settings: NotificationSettings;
    permission: NotificationPermission;
    now: Date;
    windowDays?: number;
    max?: number;
    /** Tasks for the blocks' `taskId`, so the notification can name the course and say when the work is due. */
    tasks?: readonly Pick<Task, "id" | "name" | "courseName" | "dueDate" | "dueTime" | "status">[];
  },
): PlannedReminder[] {
  if (!remindersActive(opts.settings, opts.permission)) return [];
  const last = new Date(opts.now.getFullYear(), opts.now.getMonth(), opts.now.getDate() + (opts.windowDays ?? REMINDER_WINDOW_DAYS) + 1);
  const lastKey = dateKey(last);
  const leads = reminderLeads(opts.settings);
  const withStart = sessionStartEnabled(opts.settings);
  const taskById = new Map((opts.tasks ?? []).map((t) => [t.id, t] as const));
  const planned: PlannedReminder[] = [];
  for (const block of blocks) {
    if (block.type !== "study" || block.completionStatus !== "pending" || block.startedAt || block.date >= lastKey) continue;
    const task = block.taskId ? taskById.get(block.taskId) : undefined;
    if (withStart) {
      const start = blockStart(block);
      if (start && start.getTime() > opts.now.getTime()) {
        planned.push({ block, identifier: sessionStartIdentifier(block.id), fireAt: start, kind: "start", leadMinutes: 0, task });
      }
    }
    for (const lead of leads) {
      if (lead.minutes <= 0) continue; // "at the start" is the start notification
      const fireAt = computeLeadReminderDate(block, lead, opts.now);
      if (!fireAt) continue;
      planned.push({ block, identifier: reminderIdentifier(block.id, lead.id), fireAt, kind: "reminder", leadMinutes: lead.minutes, task });
    }
  }
  planned.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime() || a.identifier.localeCompare(b.identifier));
  // Two reminders that land on the same minute for the same session say the same thing: keep one.
  const seen = new Set<string>();
  const unique = planned.filter((item) => {
    const key = `${item.block.id}@${item.fireAt.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, opts.max ?? MAX_PENDING_REMINDERS);
}

function formatClock(time: string | undefined): string {
  if (typeof time !== "string") return "";
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const period = h! >= 12 ? "PM" : "AM";
  return `${h! % 12 || 12}:${String(m).padStart(2, "0")} ${period}`;
}

/** "4:00–4:45 PM" (one AM/PM when both times share it), or "9:30 AM–1:00 PM" when the session spans noon. */
function timeRangeLabel(startTime: string | undefined, endTime: string | undefined): string {
  const start = formatClock(startTime);
  const end = formatClock(endTime);
  if (!start || !end) return start || end;
  const startPeriod = start.slice(-2);
  const endPeriod = end.slice(-2);
  return startPeriod === endPeriod ? `${start.slice(0, -3)}–${end}` : `${start}–${end}`;
}

/** " due Thu 11:59 PM" / " due tomorrow" for a task, relative to the day the notification fires; "" when there is
 * no usable due date or the task is already done. */
function notificationDueSuffix(task: Pick<Task, "dueDate" | "dueTime" | "status"> | undefined, fireAt: Date): string {
  if (!task || task.status === "done" || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate ?? "")) return "";
  const when = relativeDayLabel(task.dueDate, dateKey(fireAt));
  const time = task.dueTime && /^\d{1,2}:\d{2}$/.test(task.dueTime) ? ` ${formatClock(task.dueTime)}` : "";
  return ` due ${when}${time}`;
}

/** Task name / course code stripped of the block's verb prefix, for a block with no matching task (should be rare). */
function fallbackSessionName(block: Pick<ScheduleBlock, "title">): string {
  return (block.title ?? "").replace(/^(?:Study|Catch up|Draft|Review|Finalize|Practice Test|Work on):\s*/, "").trim() || "Study session";
}

/**
 * Notification title/body for a planned notification (plain text, no emoji): what the session is for and when it
 * meets, plus — when it works toward a task — when that task is due (engine/due-label.ts). No mention of a focus
 * timer: sessions are started from Today.
 */
export function studyNotificationContent(item: Pick<PlannedReminder, "block" | "kind" | "leadMinutes" | "fireAt" | "task">): { title: string; body: string } {
  const name = item.task?.name?.trim() || fallbackSessionName(item.block);
  const course = item.task?.courseName && item.task.courseName !== "General" ? ` · ${item.task.courseName}` : "";
  const range = timeRangeLabel(item.block.startTime, item.block.endTime);
  const due = notificationDueSuffix(item.task, item.fireAt);
  const done = !due && item.block.whatCountsAsDone ? ` ${item.block.whatCountsAsDone}` : "";
  const body = due ? [range, `${name}${due}`].filter(Boolean).join(" · ") : `${range}${done}`.trim() || name;
  if (item.kind === "start") {
    return { title: `Study: ${name}${course}`, body };
  }
  return { title: `${reminderLeadLabelMinutes(item.leadMinutes)}: ${name}${course}`, body };
}

/**
 * Study blocks that should get a reminder scheduled now.
 * `today` is a LOCAL "YYYY-MM-DD" key; `inFlight` holds ids whose scheduling call has not finished.
 */
export function selectBlocksNeedingReminder(
  blocks: readonly ScheduleBlock[],
  opts: {
    settings: NotificationSettings;
    permission: NotificationPermission;
    today: string;
    inFlight?: ReadonlySet<string>;
  },
): ScheduleBlock[] {
  if (!remindersActive(opts.settings, opts.permission)) return [];
  return blocks.filter(
    (block) =>
      block.type === "study" &&
      block.completionStatus === "pending" &&
      !block.notificationId &&
      block.date >= opts.today &&
      !opts.inFlight?.has(block.id),
  );
}

/**
 * When to ask for notification permission after planning. New students (no study sessions when the app loaded)
 * are asked as soon as their first plan has sessions; students who already had a plan are asked on the first plan
 * change that happens a minute or more after launch (a change they made, not the launch roll-forward), never at
 * launch itself. `alreadyAsked` comes from storage. (A browser shows the prompt only on a click, so the web app
 * leaves this ask to the Reminders switch: lib/notifications.ts maybeAskForNotificationsAfterFirstPlan.)
 */
export function shouldAskAfterPlan(input: {
  alreadyAsked: boolean;
  hadStudyAtLoad: boolean;
  upcomingStudyCount: number;
  planChanged: boolean;
  msSinceHydration: number;
}): boolean {
  if (input.alreadyAsked || input.upcomingStudyCount === 0) return false;
  if (!input.hadStudyAtLoad) return true;
  return input.planChanged && input.msSinceHydration >= 60_000;
}
