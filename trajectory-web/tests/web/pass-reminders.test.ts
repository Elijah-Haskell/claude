// Reminders before a School Year pass ends (src/lib/pass-reminders.ts), on the browser's timers. The planning is the
// iPhone app's word for word; the scheduling goes through src/lib/notifications.ts, faked here with vitest's clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASS_REMINDER_KIND,
  planPassReminders,
  resetPassRemindersForTests,
  syncPassReminders,
} from "../../src/lib/pass-reminders";
import { cancelAllStudyReminders, cancelLocalNotification, pendingLocalNotifications, reconcileStudyReminders, scheduleLocalNotification } from "../../src/lib/notifications";
import { MAX_PENDING_REMINDERS } from "../../src/lib/notification-policy";
import { NOT_PRO_STATUS, type ProStatus } from "../../src/lib/subscription-plans";

class FakeNotification {
  static permission = "granted";
  static shown: string[] = [];
  static requestPermission(): Promise<string> {
    return Promise.resolve(FakeNotification.permission);
  }
  constructor(title: string) {
    FakeNotification.shown.push(title);
  }
  set onclick(_handler: () => void) {
    // not exercised here
  }
  close() {}
}
const g = globalThis as unknown as { window?: unknown; Notification?: unknown };

const PASS = "trajectory_school_year";
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const END = local(2027, 8, 20, 15); // Fri, Aug 20 2027, 3 PM
const passStatus = (until: Date): ProStatus => ({
  isPro: true,
  source: "term",
  until: until.toISOString(),
  willRenew: false,
  productId: PASS,
  termPass: { active: true, until: until.toISOString(), productId: PASS },
});
/** A pass running beside a monthly subscription that renews: the subscription is what keeps Pro on. */
const viaSubscription: ProStatus = { ...passStatus(END), source: "subscription", willRenew: true };
const studyReminder = (id: string) => ({ identifier: id, fireAt: local(2027, 7, 2), title: "Study", body: "", data: { blockId: id, kind: "start" } });
const pendingIds = () => pendingLocalNotifications().map((r) => r.identifier).sort();

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(local(2027, 7, 1));
  g.window = globalThis;
  g.Notification = FakeNotification;
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  await cancelAllStudyReminders();
  for (const request of pendingLocalNotifications()) cancelLocalNotification(request.identifier);
  resetPassRemindersForTests();
});
afterEach(() => {
  resetPassRemindersForTests();
  vi.useRealTimers();
  delete g.window;
  delete g.Notification;
});

describe("planPassReminders", () => {
  it("14 days and 2 days before a School Year pass ends, at 10 AM", () => {
    const reminders = planPassReminders(passStatus(END), local(2027, 7, 1));
    expect(reminders.map((r) => r.identifier)).toEqual(["pass-expiry-14d", "pass-expiry-2d"]);
    expect(reminders[0]!.fireAt.getTime()).toBe(local(2027, 8, 6, 10).getTime());
    expect(reminders[1]!.fireAt.getTime()).toBe(local(2027, 8, 18, 10).getTime());
    expect(reminders[0]!.title).toBe("Your School Year Pro ends in 14 days");
    expect(reminders[0]!.body).toBe("Pro stays on until Fri, Aug 20. The pass doesn't renew by itself; your plan and data stay either way.");
    expect(reminders[1]!.title).toBe("Your School Year Pro ends Fri, Aug 20");
  });

  it("skips a reminder whose moment has passed, and has none once the pass is about to end", () => {
    expect(planPassReminders(passStatus(END), local(2027, 8, 10)).map((r) => r.identifier)).toEqual(["pass-expiry-2d"]);
    expect(planPassReminders(passStatus(END), local(2027, 8, 18, 10, 1))).toEqual([]);
    expect(planPassReminders(passStatus(END), local(2027, 8, 21))).toEqual([]);
  });

  it("none unless a pass is what keeps Pro on", () => {
    const now = local(2027, 7, 1);
    expect(planPassReminders(NOT_PRO_STATUS, now)).toEqual([]);
    expect(planPassReminders(viaSubscription, now)).toEqual([]);
    expect(planPassReminders({ ...passStatus(END), source: "lifetime", until: null }, now)).toEqual([]);
    expect(planPassReminders({ ...passStatus(END), until: "garbage" }, now)).toEqual([]);
  });
});

describe("syncPassReminders (the browser side)", () => {
  const now = local(2027, 7, 1);

  it("schedules the two reminders without a blockId, tagged pass-expiry and opening the paywall", async () => {
    await syncPassReminders(passStatus(END), now);
    expect(pendingIds()).toEqual(["pass-expiry-14d", "pass-expiry-2d"]);
    for (const request of pendingLocalNotifications()) {
      expect(request.data).toEqual({ kind: PASS_REMINDER_KIND, url: "/paywall" });
      expect(request.data).not.toHaveProperty("blockId");
    }
    // Each fires at its moment (setTimeout cannot wait 36 days in one go: it waits in steps).
    vi.advanceTimersByTime(local(2027, 8, 6, 10).getTime() - now.getTime() - 1);
    expect(FakeNotification.shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(FakeNotification.shown).toEqual(["Your School Year Pro ends in 14 days"]);
    expect(pendingIds()).toEqual(["pass-expiry-2d"]);
  });

  it("does nothing for the same pass twice, and moves both when another pass is bought", async () => {
    await syncPassReminders(passStatus(END), now);
    const before = pendingLocalNotifications().map((r) => r.fireAt.getTime());
    await syncPassReminders(passStatus(END), now);
    expect(pendingLocalNotifications().map((r) => r.fireAt.getTime())).toEqual(before);
    const renewed = local(2028, 8, 20, 15);
    await syncPassReminders(passStatus(renewed), now);
    expect(pendingLocalNotifications()).toHaveLength(2); // replaced, not added
    const fire = pendingLocalNotifications().map((r) => r.fireAt.getTime()).sort((a, b) => a - b);
    expect(fire).toEqual([local(2028, 8, 6, 10).getTime(), local(2028, 8, 18, 10).getTime()]);
  });

  it("cancels them once the pass no longer keeps Pro on, leaving study reminders alone", async () => {
    scheduleLocalNotification(studyReminder("b1"));
    scheduleLocalNotification(studyReminder("b2"));
    await syncPassReminders(passStatus(END), now);
    expect(pendingLocalNotifications()).toHaveLength(4);
    await syncPassReminders(viaSubscription, now);
    expect(pendingIds()).toEqual(["b1", "b2"]);
  });

  it("never asks for permission: without it nothing is scheduled, and it tries again later", async () => {
    FakeNotification.permission = "default";
    await syncPassReminders(passStatus(END), now);
    expect(pendingLocalNotifications()).toEqual([]);
    FakeNotification.permission = "granted";
    await syncPassReminders(passStatus(END), now);
    expect(pendingLocalNotifications()).toHaveLength(2);
  });

  it("does nothing outside a browser", async () => {
    delete g.window;
    await syncPassReminders(passStatus(END), now);
    expect(pendingLocalNotifications()).toEqual([]);
  });
});

describe("study-reminder housekeeping leaves pass reminders alone", () => {
  it("cancelAllStudyReminders and reconcileStudyReminders only touch notifications with a blockId", async () => {
    await syncPassReminders(passStatus(END), local(2027, 7, 1));
    scheduleLocalNotification(studyReminder("b1"));
    await reconcileStudyReminders([]);
    expect(pendingIds()).toEqual(["pass-expiry-14d", "pass-expiry-2d"]);
    scheduleLocalNotification(studyReminder("b2"));
    await cancelAllStudyReminders();
    expect(pendingIds()).toEqual(["pass-expiry-14d", "pass-expiry-2d"]);
  });

  it("two pass reminders fit beside the most study reminders the app ever plans (iOS keeps 64)", () => {
    expect(planPassReminders(passStatus(END), local(2027, 7, 1)).length + MAX_PENDING_REMINDERS).toBeLessThanOrEqual(64 - 10);
  });
});
