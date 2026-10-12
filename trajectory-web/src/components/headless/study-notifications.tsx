/**
 * Headless (renders nothing), mounted once in src/app.tsx inside AppProvider (the iPhone app's
 * components/study-notifications.tsx together with AppProvider's reminders effect, for the browser).
 *
 *  1. Keeps the pending notifications equal to the plan: for the upcoming study sessions of the next 7 days, a
 *     session-start notification and each heads-up the student asked for (lib/notification-policy.ts
 *     selectReminderWindow), held in timers until their moment (lib/notifications.ts reconcileStudyReminders).
 *     Re-run after every plan or settings change (debounced) and whenever the tab comes back into view, so the window
 *     slides forward with the calendar. While reminders are off, nothing stays pending.
 *  2. Handles a clicked notification: the tab is focused, and Today opens; a notification that names a screen in
 *     `data.url` (a pass reminder -> /paywall) opens that screen. This is the app's single notification-response
 *     listener. A browser notification has no Snooze / Skip buttons, so those actions do not exist here.
 *  3. Keeps the reminders before a School Year pass ends (lib/pass-reminders.ts) in step with the entitlement.
 *
 * The iPhone app also asks for notification permission once, right after the first plan. A browser shows that
 * prompt only in answer to a click, so here the Reminders switch is the one place permission is asked.
 */
import { useEffect, useRef, useState } from "react";

import { localDateKey } from "../../engine/utils";
import { cancelAllStudyReminders, getNotificationPermission, reconcileStudyReminders, registerNotificationActionHandler } from "../../lib/notifications";
import { selectReminderWindow, studyNotificationContent } from "../../lib/notification-policy";
import { syncPassReminders } from "../../lib/pass-reminders";
import { navigate, useRoute } from "../../router";
import { useApp } from "../../state/app-provider";
import { useProDetails } from "../../state/subscription-context";

/** The plan settles before the timers are rewritten (a replan dispatches several actions in a row). */
const RECONCILE_DELAY_MS = 2000;

/** An in-app route from a notification ("/paywall") as this router names it ("paywall"). */
export function routeFromNotificationUrl(url: string): string {
  return url.replace(/^\/+/, "") || "today";
}

export function StudyNotifications(): null {
  const { state, isHydrated } = useApp();
  const route = useRoute();
  const routeRef = useRef(route.path);
  routeRef.current = route.path;

  // ── A clicked notification ──
  useEffect(() => {
    if (!isHydrated) return;
    return registerNotificationActionHandler({
      onOpen: () => navigate("today"),
      onOpenUrl: (url) => {
        const target = routeFromNotificationUrl(url);
        if (routeRef.current !== `/${target}`) navigate(target); // already on that screen: nothing to open
      },
    });
  }, [isHydrated]);

  // ── Reminders off: nothing stays pending ──
  useEffect(() => {
    if (!isHydrated) return;
    if (!state.notificationSettings.enabled) void cancelAllStudyReminders();
  }, [isHydrated, state.notificationSettings.enabled]);

  // ── The pending notifications follow the plan ──
  const signatureRef = useRef<string>("");
  const [visibleTick, setVisibleTick] = useState(0);
  useEffect(() => {
    if (!isHydrated || !state.notificationSettings.enabled) {
      signatureRef.current = "";
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const permission = await getNotificationPermission();
      if (cancelled) return;
      const now = new Date();
      const wanted = selectReminderWindow(state.scheduleBlocks, { settings: state.notificationSettings, permission, now, tasks: state.tasks });
      // The text is part of the signature: a deadline edit that moves no session still changes "due Thu 11:59 PM".
      const text = (item: (typeof wanted)[number]) => {
        try {
          const content = studyNotificationContent(item);
          return `${content.title}|${content.body}`;
        } catch {
          return "";
        }
      };
      const signature = `${permission}|${state.notificationSettings.leadTimeHours}|${wanted.map((item) => `${item.identifier}@${item.fireAt.getTime()}:${text(item)}`).join(",")}`;
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      await reconcileStudyReminders(wanted, state.notificationSettings.leadTimeHours ?? 24);
    }, RECONCILE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isHydrated, state.scheduleBlocks, state.tasks, state.notificationSettings, visibleTick]);

  // Coming back to the tab (or a new calendar day while it stays open): the window slides forward, and timers the
  // browser slowed down while the tab was hidden are set again.
  const [dayKey, setDayKey] = useState(() => localDateKey(new Date()));
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      setDayKey(localDateKey(new Date()));
      signatureRef.current = "";
      setVisibleTick((tick) => tick + 1);
    };
    const interval = setInterval(() => {
      const next = localDateKey(new Date());
      if (next !== dayKey) wake();
    }, 60_000);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [dayKey]);

  // ── Reminders before a School Year pass ends (never asks for permission) ──
  const pro = useProDetails();
  useEffect(() => {
    if (pro.isLoading) return;
    void syncPassReminders({ isPro: pro.isPro, source: pro.source, until: pro.until, productId: pro.productId });
  }, [pro.isLoading, pro.isPro, pro.source, pro.until, pro.productId]);

  return null;
}
