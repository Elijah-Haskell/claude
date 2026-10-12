/**
 * Study reminders in the browser (the iPhone app's lib/notifications.ts): the Notification API while a Trajectory
 * tab is open. What is here:
 *  - Permission: read-only status, and the one prompt, which the Reminders switch asks for (a browser shows the
 *    prompt only on a click, so the one-time ask after the first plan is "unavailable" here, as in the iPhone app's
 *    own browser build).
 *  - Scheduling: a notification per planned reminder, held in a setTimeout until its moment (timers in
 *    `window.__trajectoryReminderTimers`, so the account layer can clear them without importing this module's state),
 *    shown with `new Notification(...)` when it comes. Nothing is delivered once the last Trajectory tab is closed.
 *  - Keeping the pending notifications equal to the plan (reconcileStudyReminders), and dropping them all
 *    (cancelAllStudyReminders: signing out, deleting the account, replacing another account's plan).
 *  - Routing a clicked notification back into the app (registerNotificationActionHandler): the tab is focused and
 *    Today opens (or the screen the notification names in `data.url`).
 * Decision logic lives in ./notification-policy (pure, unit tested). Nothing here runs at import time.
 */
import { studyNotificationContent, type NotificationPermission, type PlannedReminder } from "./notification-policy";
import { appStorage } from "./storage";

export type { NotificationPermission };

/** A timer that fires this long after its moment (the tab was asleep) still shows; later than that, the moment is gone. */
export const LATE_DELIVERY_GRACE_MS = 30 * 60_000;
/** setTimeout's longest wait; a later moment is waited for in steps. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface LocalNotificationRequest {
  /** Stable per block and kind, so scheduling twice replaces instead of duplicating. */
  identifier: string;
  fireAt: Date;
  title: string;
  body: string;
  /** What a click carries back: a study notification has `blockId`; one that opens a screen has an app-relative `url`. */
  data: Record<string, unknown>;
}

interface PendingNotification extends LocalNotificationRequest {
  timer: number | null;
}

/** Everything held in a timer right now, by identifier. */
const pending = new Map<string, PendingNotification>();
/** Timers of notifications that are not study reminders (the pass reminders): kept apart so cancelAllStudyReminders leaves them. */
const otherTimers = new Set<number>();

type ReminderWindow = Window & { __trajectoryReminderTimers?: Set<number> };

/** The study reminders' timers, where the account layer (lib/sign-out-flow.ts) expects them. Null outside a browser. */
function studyTimers(): Set<number> | null {
  if (typeof window === "undefined") return null;
  const w = window as ReminderWindow;
  if (!w.__trajectoryReminderTimers) w.__trajectoryReminderTimers = new Set<number>();
  return w.__trajectoryReminderTimers;
}

function isStudyNotification(request: { data: Record<string, unknown> }): boolean {
  return request.data.blockId !== undefined;
}

// ── Permission ────────────────────────────────────────────────

/** Whether this browser can show notifications at all (not in a worker, not in an old or restricted browser). */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && typeof Notification !== "undefined" && typeof Notification.requestPermission === "function";
}

/** The browser's three states as the iPhone app names them ("default" = never asked = undetermined). */
export function mapNotificationPermission(value: string | undefined): NotificationPermission {
  return value === "granted" ? "granted" : value === "denied" ? "denied" : "undetermined";
}

/** Current permission status. Never shows a prompt. "denied" where notifications cannot be shown at all. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  try {
    return mapNotificationPermission(Notification.permission);
  } catch {
    return "denied";
  }
}

/**
 * Ask the browser for notification permission. Called from the Reminders switch, in the click that turns it on
 * (browsers show the prompt only then). Returns true if granted.
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  try {
    if (Notification.permission === "granted") return true;
    // Older Safari takes a callback and returns nothing; everything else returns a promise.
    const result = await new Promise<string>((resolve) => {
      const maybe = Notification.requestPermission((value) => resolve(value)) as unknown;
      if (maybe && typeof (maybe as Promise<string>).then === "function") void (maybe as Promise<string>).then(resolve);
    });
    return result === "granted";
  } catch {
    return false;
  }
}

/** Storage flag: the post-first-plan prompt has been shown (or was not needed). Wiped with the app's data. */
export const NOTIFICATION_PROMPT_FLAG_KEY = "@trajectory/notificationsAskedAfterPlan";

export async function hasAskedForNotificationsAfterPlan(): Promise<boolean> {
  try {
    return (await appStorage.getItem(NOTIFICATION_PROMPT_FLAG_KEY)) !== null;
  } catch {
    return true; // storage trouble: do not risk prompting repeatedly
  }
}

/**
 * The iPhone app asks for permission once, right after the student's first plan exists. A browser shows the prompt
 * only in answer to a click, so here the answer is always "unavailable" (as in the iPhone app's own browser build)
 * and the Reminders switch is where permission is asked. Never a side effect.
 */
export async function maybeAskForNotificationsAfterFirstPlan(): Promise<"granted" | "denied" | "already-asked" | "unavailable"> {
  return "unavailable";
}

// ── Scheduling ────────────────────────────────────────────────

function timersFor(request: { data: Record<string, unknown> }): Set<number> | null {
  return isStudyNotification(request) ? studyTimers() : typeof window === "undefined" ? null : otherTimers;
}

function disarm(entry: PendingNotification): void {
  if (entry.timer === null) return;
  clearTimeout(entry.timer);
  timersFor(entry)?.delete(entry.timer);
  entry.timer = null;
}

/** Hold the notification until its moment, in steps when that is further than one timer can wait. */
function arm(entry: PendingNotification): void {
  const timers = timersFor(entry);
  if (!timers) return;
  const wait = Math.min(Math.max(0, entry.fireAt.getTime() - Date.now()), MAX_TIMEOUT_MS);
  entry.timer = window.setTimeout(() => {
    timers.delete(entry.timer as number);
    entry.timer = null;
    if (pending.get(entry.identifier) !== entry) return; // replaced or cancelled meanwhile
    if (Date.now() < entry.fireAt.getTime() - 1_000) {
      arm(entry); // a long wait, or a timer the browser ran early
      return;
    }
    pending.delete(entry.identifier);
    deliver(entry);
  }, wait);
  timers.add(entry.timer);
}

/** The app's icon beside the notification, when there is a page to take it from. */
function notificationIcon(): string | undefined {
  try {
    return typeof document !== "undefined" ? new URL("favicon.svg", document.baseURI).href : undefined;
  } catch {
    return undefined;
  }
}

/** Show it now, if the browser still allows it and the moment has not long passed. */
function deliver(entry: PendingNotification): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (Date.now() - entry.fireAt.getTime() > LATE_DELIVERY_GRACE_MS) return;
  try {
    const shown = new Notification(entry.title, { body: entry.body, tag: entry.identifier, icon: notificationIcon() });
    shown.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers refuse: the click still routes.
      }
      shown.close();
      respondToNotification(entry.data);
    };
  } catch {
    // A browser that has the API but refuses to show from a page: nothing to do.
  }
}

/** Schedule one notification (the same identifier replaces). False where nothing can be scheduled (no browser). */
export function scheduleLocalNotification(request: LocalNotificationRequest): boolean {
  if (typeof window === "undefined") return false;
  const previous = pending.get(request.identifier);
  if (previous) disarm(previous);
  const entry: PendingNotification = { ...request, data: { ...request.data }, timer: null };
  pending.set(request.identifier, entry);
  arm(entry);
  return true;
}

export function cancelLocalNotification(identifier: string): void {
  const entry = pending.get(identifier);
  if (!entry) return;
  disarm(entry);
  pending.delete(identifier);
}

/** What is held in a timer right now (for the pass reminders' bookkeeping and the tests). */
export function pendingLocalNotifications(): LocalNotificationRequest[] {
  return [...pending.values()].map(({ timer: _timer, ...request }) => ({ ...request, data: { ...request.data } }));
}

/**
 * Make the pending study notifications exactly `wanted` (see selectReminderWindow): cancel the ones that are no
 * longer wanted (block moved away, finished, deleted, or outside the window), schedule the rest (the same identifier
 * replaces, so this never duplicates), leaving one that is unchanged alone. Safe to call repeatedly. `_leadTimeHours`
 * is ignored (each planned item carries its own time).
 */
export async function reconcileStudyReminders(wanted: PlannedReminder[], _leadTimeHours?: number): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const wantedIds = new Set(wanted.map((item) => item.identifier));
    for (const [identifier, entry] of [...pending]) {
      if (isStudyNotification(entry) && !wantedIds.has(identifier)) cancelLocalNotification(identifier);
    }
    for (const item of wanted) {
      // One session with odd data must never stop the rest of the reminders from being scheduled.
      try {
        const { title, body } = studyNotificationContent(item);
        const current = pending.get(item.identifier);
        if (current && current.fireAt.getTime() === item.fireAt.getTime() && current.title === title && current.body === body) continue;
        scheduleLocalNotification({
          identifier: item.identifier,
          fireAt: item.fireAt,
          title,
          body,
          data: { blockId: item.block.id, blockDate: item.block.date, kind: item.kind },
        });
      } catch {
        // skip this one
      }
    }
  } catch {
    // Notifications are best-effort.
  }
}

/** Cancels one pending notification by its identifier. Safe when it has fired or never existed. */
export async function cancelStudyReminder(notificationId: string | undefined | null): Promise<void> {
  if (!notificationId) return;
  cancelLocalNotification(notificationId);
}

/**
 * Every pending study reminder goes (signing out, deleting the account, replacing another account's plan, turning
 * reminders off). Other notifications (the pass reminders) stay, as on the iPhone. Every timer left in
 * `window.__trajectoryReminderTimers` by anyone is cleared too: that set is the study reminders' and nothing else's.
 */
export async function cancelAllStudyReminders(): Promise<void> {
  if (typeof window === "undefined") return;
  for (const [identifier, entry] of [...pending]) {
    if (isStudyNotification(entry)) cancelLocalNotification(identifier);
  }
  const timers = (window as ReminderWindow).__trajectoryReminderTimers;
  if (!timers) return;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

// ── Handling clicks ───────────────────────────────────────────

export interface StudyNotificationHandlers {
  /** "Skip": mark the session skipped and replan. A browser notification has no buttons, so this is never called here; kept for the iPhone app's shape. */
  onSkip?: (blockId: string) => void;
  /** "Snooze": not offered by a browser notification; kept for the iPhone app's shape. */
  onSnooze?: (blockId: string) => void;
  /** The notification itself was clicked. */
  onOpen?: (blockId: string) => void;
  /**
   * A clicked notification that carries an in-app route in `data.url` (e.g. a pass reminder -> "/paywall"). Only
   * app-relative paths ("/...") are passed on.
   */
  onOpenUrl?: (url: string) => void;
}

let currentHandlers: StudyNotificationHandlers | null = null;

/** Route a clicked notification's data to the registered handlers (what the iPhone app does with a response). */
export function respondToNotification(data: Record<string, unknown>): void {
  const handlers = currentHandlers;
  if (!handlers) return;
  const url = typeof data.url === "string" ? data.url : null;
  if (url) {
    // In-app routes only ("/paywall"); never an external or protocol-relative link.
    if (url.startsWith("/") && !url.startsWith("//")) handlers.onOpenUrl?.(url);
    return;
  }
  const blockId = typeof data.blockId === "string" ? data.blockId : null;
  if (blockId) handlers.onOpen?.(blockId);
}

/**
 * Route notification clicks to the app. One set of handlers is active at a time (a new registration replaces the
 * previous one). Returns an unregister function.
 */
export function registerNotificationActionHandler(handlers: StudyNotificationHandlers): () => void {
  currentHandlers = handlers;
  return () => {
    if (currentHandlers === handlers) currentHandlers = null;
  };
}
