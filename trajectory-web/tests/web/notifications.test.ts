// Study reminders in the browser (src/lib/notifications.ts): a notification per planned reminder held in a timer
// until its moment, the timers in window.__trajectoryReminderTimers, and a click that routes back into the app.
// Node has no window and no Notification: a fake of each, and vitest's fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAllStudyReminders,
  cancelLocalNotification,
  getNotificationPermission,
  LATE_DELIVERY_GRACE_MS,
  mapNotificationPermission,
  maybeAskForNotificationsAfterFirstPlan,
  notificationsSupported,
  pendingLocalNotifications,
  reconcileStudyReminders,
  registerNotificationActionHandler,
  requestNotificationPermissions,
  respondToNotification,
  scheduleLocalNotification,
} from "../../src/lib/notifications";
import type { PlannedReminder } from "../../src/lib/notification-policy";
import type { ScheduleBlock } from "../../src/engine/types";

type Shown = { title: string; options: { body?: string; tag?: string } | undefined; onclick: (() => void) | null; closed: boolean };

class FakeNotification {
  static permission = "granted";
  static asked = 0;
  static shown: Shown[] = [];
  static requestPermission(callback?: (value: string) => void): Promise<string> {
    FakeNotification.asked++;
    callback?.(FakeNotification.permission);
    return Promise.resolve(FakeNotification.permission);
  }
  private record: Shown;
  constructor(title: string, options?: { body?: string; tag?: string }) {
    this.record = { title, options, onclick: null, closed: false };
    FakeNotification.shown.push(this.record);
  }
  set onclick(handler: () => void) {
    this.record.onclick = handler;
  }
  close() {
    this.record.closed = true;
  }
}

const g = globalThis as unknown as { window?: unknown; Notification?: unknown };
const timersOnWindow = () => (globalThis as unknown as { __trajectoryReminderTimers?: Set<number> }).__trajectoryReminderTimers;

const NOW = new Date(2030, 2, 13, 12, 0, 0);
const block = (id: string, patch: Partial<ScheduleBlock> = {}): ScheduleBlock => ({
  id,
  type: "study",
  title: "Study: Problem set 4",
  date: "2030-03-15",
  startTime: "19:00",
  endTime: "20:00",
  locked: false,
  accepted: false,
  color: "#4F6EF7",
  completionStatus: "pending",
  ...patch,
});
const planned = (id: string, fireAt: Date, kind: "start" | "reminder" = "start", leadMinutes = 0): PlannedReminder => ({
  block: block(id),
  identifier: kind === "start" ? `study-start-${id}` : `study-${id}`,
  fireAt,
  kind,
  leadMinutes,
});
const inMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  g.window = globalThis;
  g.Notification = FakeNotification;
  FakeNotification.permission = "granted";
  FakeNotification.asked = 0;
  FakeNotification.shown = [];
  await cancelAllStudyReminders();
  for (const request of pendingLocalNotifications()) cancelLocalNotification(request.identifier);
});

afterEach(() => {
  vi.useRealTimers();
  delete g.window;
  delete g.Notification;
});

describe("permission", () => {
  it("maps the browser's three states to the iPhone app's", () => {
    expect(mapNotificationPermission("granted")).toBe("granted");
    expect(mapNotificationPermission("denied")).toBe("denied");
    expect(mapNotificationPermission("default")).toBe("undetermined");
    expect(mapNotificationPermission(undefined)).toBe("undetermined");
  });

  it("reads the permission without asking, and reads 'denied' where notifications cannot be shown at all", async () => {
    FakeNotification.permission = "default";
    expect(await getNotificationPermission()).toBe("undetermined");
    expect(FakeNotification.asked).toBe(0);
    delete g.Notification;
    expect(notificationsSupported()).toBe(false);
    expect(await getNotificationPermission()).toBe("denied");
    expect(await requestNotificationPermissions()).toBe(false);
  });

  it("asks only when asked to (the switch), and not again once granted", async () => {
    FakeNotification.permission = "default";
    const refusedByClosing = await requestNotificationPermissions();
    expect(refusedByClosing).toBe(false);
    expect(FakeNotification.asked).toBe(1);
    FakeNotification.permission = "granted";
    expect(await requestNotificationPermissions()).toBe(true);
    expect(FakeNotification.asked).toBe(1); // already granted: no prompt
  });

  it("never asks after the first plan: a browser shows the prompt only on a click", async () => {
    FakeNotification.permission = "default";
    expect(await maybeAskForNotificationsAfterFirstPlan()).toBe("unavailable");
    expect(FakeNotification.asked).toBe(0);
  });
});

describe("scheduling", () => {
  it("holds each wanted reminder in a timer kept in window.__trajectoryReminderTimers, and shows it at its moment", async () => {
    await reconcileStudyReminders([planned("s1", inMinutes(30)), planned("s1", inMinutes(10), "reminder", 20)]);
    expect(pendingLocalNotifications().map((r) => r.identifier).sort()).toEqual(["study-s1", "study-start-s1"]);
    expect(timersOnWindow()?.size).toBe(2);

    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeNotification.shown).toHaveLength(1);
    expect(FakeNotification.shown[0]!.title).toBe("In 20 minutes: Problem set 4");
    expect(FakeNotification.shown[0]!.options?.tag).toBe("study-s1");
    expect(FakeNotification.shown[0]!.options?.body).toContain("7:00–8:00 PM");
    expect(pendingLocalNotifications().map((r) => r.identifier)).toEqual(["study-start-s1"]);
    expect(timersOnWindow()?.size).toBe(1);

    vi.advanceTimersByTime(20 * 60_000);
    expect(FakeNotification.shown.map((s) => s.title)).toEqual(["In 20 minutes: Problem set 4", "Study: Problem set 4"]);
    expect(pendingLocalNotifications()).toEqual([]);
    expect(timersOnWindow()?.size).toBe(0);
  });

  it("reconciling replaces, drops and keeps: the same identifier never rings twice", async () => {
    await reconcileStudyReminders([planned("a", inMinutes(30)), planned("b", inMinutes(40))]);
    // "a" moves, "b" is gone, "c" is new.
    await reconcileStudyReminders([planned("a", inMinutes(50)), planned("c", inMinutes(60))]);
    expect(pendingLocalNotifications().map((r) => [r.identifier, r.fireAt.getTime()])).toEqual(
      expect.arrayContaining([["study-start-a", inMinutes(50).getTime()], ["study-start-c", inMinutes(60).getTime()]]),
    );
    expect(pendingLocalNotifications()).toHaveLength(2);
    expect(timersOnWindow()?.size).toBe(2);
    vi.advanceTimersByTime(60 * 60_000);
    expect(FakeNotification.shown.map((s) => s.options?.tag)).toEqual(["study-start-a", "study-start-c"]);
  });

  it("a timer that fires long after its moment (the tab slept) shows nothing; a little late still does", async () => {
    scheduleLocalNotification({ identifier: "late", fireAt: new Date(NOW.getTime() - LATE_DELIVERY_GRACE_MS - 60_000), title: "Late", body: "", data: { blockId: "x" } });
    scheduleLocalNotification({ identifier: "bit-late", fireAt: new Date(NOW.getTime() - 5 * 60_000), title: "A bit late", body: "", data: { blockId: "y" } });
    vi.advanceTimersByTime(1);
    expect(FakeNotification.shown.map((s) => s.title)).toEqual(["A bit late"]);
  });

  it("shows nothing once the browser has taken the permission back", async () => {
    await reconcileStudyReminders([planned("s1", inMinutes(5))]);
    FakeNotification.permission = "denied";
    vi.advanceTimersByTime(5 * 60_000);
    expect(FakeNotification.shown).toEqual([]);
  });

  it("cancelAllStudyReminders clears every study timer and leaves other notifications (the pass reminders) alone", async () => {
    await reconcileStudyReminders([planned("a", inMinutes(30)), planned("b", inMinutes(40))]);
    scheduleLocalNotification({ identifier: "pass-expiry-2d", fireAt: inMinutes(90), title: "Pass", body: "", data: { kind: "pass-expiry", url: "/paywall" } });
    expect(pendingLocalNotifications()).toHaveLength(3);
    await cancelAllStudyReminders();
    expect(pendingLocalNotifications().map((r) => r.identifier)).toEqual(["pass-expiry-2d"]);
    expect(timersOnWindow()?.size).toBe(0);
    vi.advanceTimersByTime(90 * 60_000);
    expect(FakeNotification.shown.map((s) => s.title)).toEqual(["Pass"]);
  });

  it("does nothing outside a browser", async () => {
    delete g.window;
    expect(scheduleLocalNotification({ identifier: "x", fireAt: inMinutes(1), title: "x", body: "", data: { blockId: "x" } })).toBe(false);
    await reconcileStudyReminders([planned("a", inMinutes(30))]);
    expect(pendingLocalNotifications()).toEqual([]);
    await expect(cancelAllStudyReminders()).resolves.toBeUndefined();
  });
});

describe("a clicked notification", () => {
  it("opens Today for a study notification and the named screen for one that carries an in-app url, through the one registered handler", async () => {
    const opened: string[] = [];
    const urls: string[] = [];
    const unregister = registerNotificationActionHandler({ onOpen: (blockId) => opened.push(blockId), onOpenUrl: (url) => urls.push(url) });

    await reconcileStudyReminders([planned("s1", inMinutes(1))]);
    vi.advanceTimersByTime(60_000);
    FakeNotification.shown[0]!.onclick?.();
    expect(opened).toEqual(["s1"]);
    expect(FakeNotification.shown[0]!.closed).toBe(true);

    respondToNotification({ kind: "pass-expiry", url: "/paywall" });
    expect(urls).toEqual(["/paywall"]);
    // Never an external or protocol-relative link, and a replaced handler no longer hears anything.
    respondToNotification({ url: "https://evil.example" });
    respondToNotification({ url: "//evil.example" });
    expect(urls).toEqual(["/paywall"]);
    unregister();
    respondToNotification({ blockId: "s1" });
    expect(opened).toEqual(["s1"]);
  });
});
