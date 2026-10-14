/**
 * Local reminders before a School Year pass ends (it never renews by itself): 14 days and 2 days before the end, at
 * 10 AM on this computer's clock. Scheduled only while the pass is what keeps Pro on (ProStatus.source "term") and
 * only when notifications are already allowed: this never asks for permission. The headless
 * components/headless/study-notifications.tsx calls syncPassReminders whenever the entitlement changes; another pass
 * moves them (the same identifiers replace), and they are cancelled once the pass is no longer what keeps Pro on.
 *
 * They carry data { kind: "pass-expiry", url: "/paywall" } and no blockId, so the study-reminder cleanup in
 * lib/notifications.ts (it only touches notifications with a blockId) never removes them, and a click opens the
 * paywall through the app's one response listener (`data.url`). Like every notification here, they are shown by this
 * browser while a Trajectory tab is open.
 */
import { termPassProduct } from "../shared/term-pass";
import { cancelLocalNotification, getNotificationPermission, pendingLocalNotifications, scheduleLocalNotification } from "./notifications";
import { formatPassDate, type ProStatus } from "./subscription-plans";

export const PASS_REMINDER_KIND = "pass-expiry";
/** Days before the pass ends. */
export const PASS_REMINDER_DAYS = [14, 2] as const;
/** Local hour they fire at (never in the night, whatever time of day the pass was bought). */
export const PASS_REMINDER_HOUR = 10;

export interface PassReminder {
  identifier: string;
  fireAt: Date;
  title: string;
  body: string;
}

export function passReminderIdentifier(daysBefore: number): string {
  return `pass-expiry-${daysBefore}d`;
}

/** The reminders that should be pending for this status at `now` (none unless a running pass is what keeps Pro on). */
export function planPassReminders(status: Pick<ProStatus, "isPro" | "source" | "until" | "productId">, now: Date): PassReminder[] {
  if (!status.isPro || status.source !== "term" || !status.until) return [];
  const endsAt = new Date(status.until);
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= now.getTime()) return [];
  const label = termPassProduct(status.productId)?.label ?? "School Year";
  const date = formatPassDate(endsAt, { weekday: true });
  const reminders: PassReminder[] = [];
  for (const daysBefore of PASS_REMINDER_DAYS) {
    const fireAt = new Date(endsAt.getFullYear(), endsAt.getMonth(), endsAt.getDate() - daysBefore, PASS_REMINDER_HOUR, 0, 0, 0);
    if (fireAt.getTime() <= now.getTime() || fireAt.getTime() >= endsAt.getTime()) continue;
    reminders.push(
      daysBefore >= 7
        ? {
            identifier: passReminderIdentifier(daysBefore),
            fireAt,
            title: `Your ${label} Pro ends in ${daysBefore} days`,
            body: `Pro stays on until ${date}. The pass doesn't renew by itself; your plan and data stay either way.`,
          }
        : {
            identifier: passReminderIdentifier(daysBefore),
            fireAt,
            title: `Your ${label} Pro ends ${date}`,
            body: "The pass doesn't renew by itself. Open it to see your options; your plan and data stay either way.",
          },
    );
  }
  return reminders;
}

function isPassReminder(request: { data: Record<string, unknown> }): boolean {
  return request.data.kind === PASS_REMINDER_KIND;
}

/** What is pending after the last successful sync this session (skips identical work). */
let lastApplied: string | null = null;
let queue: Promise<void> = Promise.resolve();

async function applyPassReminders(wanted: PassReminder[]): Promise<void> {
  const signature = wanted.map((r) => `${r.identifier}@${r.fireAt.getTime()}`).join(",");
  if (signature === lastApplied) return;
  let allowed = wanted;
  if (wanted.length > 0) {
    const permission = await getNotificationPermission();
    if (permission !== "granted") allowed = [];
  }
  const keep = new Set(allowed.map((r) => r.identifier));
  for (const request of pendingLocalNotifications()) {
    if (isPassReminder(request) && !keep.has(request.identifier)) cancelLocalNotification(request.identifier);
  }
  for (const reminder of allowed) {
    scheduleLocalNotification({
      identifier: reminder.identifier,
      fireAt: reminder.fireAt,
      title: reminder.title,
      body: reminder.body,
      data: { kind: PASS_REMINDER_KIND, url: "/paywall" },
    });
  }
  // Without permission nothing was scheduled: try again on the next update (it may have been granted by then).
  lastApplied = allowed.length === wanted.length ? signature : null;
}

/**
 * Make the pending pass reminders match `status` (planPassReminders). Calls run one after another, so two quick
 * entitlement updates never interleave their cancels and schedules. Best effort: never throws.
 */
export function syncPassReminders(status: Pick<ProStatus, "isPro" | "source" | "until" | "productId">, now: Date = new Date()): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const wanted = planPassReminders(status, now);
  queue = queue
    .then(() => applyPassReminders(wanted))
    .catch(() => {
      lastApplied = null; // notifications are best-effort; the next update tries again
    });
  return queue;
}

/** Test hook: forget what was applied. */
export function resetPassRemindersForTests(): void {
  lastApplied = null;
  queue = Promise.resolve();
}
