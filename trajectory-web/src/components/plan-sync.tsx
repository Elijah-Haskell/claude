/**
 * The saved plan's two pieces of UI (src/state/plan-sync-client.ts explains the whole feature):
 *  - <PlanSync />: mounted once, inside the providers. Shows nothing by itself. It connects the engine
 *    (src/lib/plan-sync-engine.ts) to the app: who is signed in, the plan in this browser, every change to it, and the
 *    tab going to the background and coming back. It asks "which plan do you want to keep?" when this browser and
 *    the account each hold a plan the other has not seen, and shows the few things the student has to be told.
 *  - <PlanSavedRow />: the "Saved to your account" line for the account section of Settings.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { lastStudentActionTime, reducer, stateReplacementsIn, studentActionCount, studentEditsIn } from "../engine/app-context";
import type { AppState } from "../engine/types";
import { ACCOUNT_REQUIRED } from "../lib/config";
import { loadCourseFeeds, readCourseFeedsForPlan, replaceCourseFeedLinks, subscribeCourseFeeds, type CourseFeedsState } from "../lib/lms-feed-store";
import { cancelAllStudyReminders } from "../lib/notifications";
import { isPristineState, planStateChanged } from "../lib/plan-snapshot";
import { PLAN_SYNC_COPY, planSavedRowModel, type PlanSyncNotice, type PlanSyncQuestion } from "../lib/plan-sync";
import { createPlanDevice } from "../lib/plan-sync-device";
import { appStorage } from "../lib/storage";
import { appStatePersister, useApp } from "../state/app-provider";
import { useAuth } from "../state/auth";
import { showAlert } from "../state/dialogs";
import { planSyncEngine, planSyncSignOutHandler, usePlanSync, usePlanSyncPrompt } from "../state/plan-sync-client";
import { Icon, type IconName } from "../ui/icon";
import { useColors } from "../ui/theme";

/** A dispatched action is rendered within a frame or two; after this long it changed nothing and never will. */
const EDIT_IN_FLIGHT_MS = 2000;

function feedsKeyOf(feeds: CourseFeedsState): string {
  return `${feeds.feeds.length}|${JSON.stringify(feeds.links)}`;
}

/** The copy, with "this iPhone" said as "this browser". */
const here = (text: string) => text.replace(/this iPhone's/g, "this browser's").replace(/This iPhone/g, "This browser").replace(/this iPhone/g, "this browser").replace(/each iPhone/g, "each device").replace(/an iPhone/g, "a device");

/** Keeps this browser's plan and the account's saved plan together. Mount once, inside the providers. */
export function PlanSync(): null {
  const { state, dispatch, isHydrated } = useApp();
  const { user, logout } = useAuth();
  const prompt = usePlanSyncPrompt();

  const stateRef = useRef(state);
  stateRef.current = state;
  const feedsKeyRef = useRef<string | null>(null);

  const device = useMemo(
    () =>
      createPlanDevice({
        rendered: () => stateRef.current,
        dispatch,
        reduce: reducer,
        replacements: stateReplacementsIn,
        editing: () => studentActionCount() > studentEditsIn(stateRef.current) && Date.now() - lastStudentActionTime() < EDIT_IN_FLIGHT_MS,
        persister: appStatePersister(),
        storage: appStorage,
        loadFeeds: readCourseFeedsForPlan,
        replaceFeedLinks: replaceCourseFeedLinks,
        cancelReminders: cancelAllStudyReminders,
      }),
    [dispatch],
  );

  // Only a Sign in with Apple account has a saved plan: never a guest session, never the browser preview.
  const openId = typeof user?.openId === "string" ? user.openId : "";
  const isAccount = openId !== "" && user?.loginMethod !== "guest" && !openId.startsWith("guest:");
  const account = ACCOUNT_REQUIRED && isHydrated && isAccount ? openId : null;

  useLayoutEffect(() => {
    if (isHydrated) planSyncEngine.attach(device);
  }, [isHydrated, device]);
  useLayoutEffect(() => {
    planSyncEngine.setAccount(account);
  }, [account]);

  // ── Every change to the plan ──
  const seenRef = useRef<AppState | null>(null);
  useEffect(() => {
    if (!isHydrated) return;
    const previous = seenRef.current;
    seenRef.current = state;
    if (!previous) return;
    if (!planStateChanged(previous, state) || isPristineState(state)) return;
    planSyncEngine.planChanged({ edited: studentEditsIn(state) > studentEditsIn(previous) });
  }, [state, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    let active = true;
    loadCourseFeeds()
      .then((feeds) => {
        if (active && feedsKeyRef.current === null) feedsKeyRef.current = feedsKeyOf(feeds);
      })
      .catch(() => undefined);
    const offFeeds = subscribeCourseFeeds((feeds) => {
      const key = feedsKeyOf(feeds);
      const before = feedsKeyRef.current;
      feedsKeyRef.current = key;
      if (!device.isApplying() && before !== key) planSyncEngine.planChanged({ edited: false });
    });
    return () => {
      active = false;
      offFeeds();
    };
  }, [isHydrated, device]);

  // ── Leaving and coming back ──
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") planSyncEngine.appBecameActive();
      else planSyncEngine.appLeftForeground();
    };
    const onHide = () => planSyncEngine.appLeftForeground();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  // ── The questions ──
  const signOut = useCallback(async () => {
    try {
      const handler = planSyncSignOutHandler();
      if (handler) await handler();
      else await logout();
    } catch {
      // Still signed in: asked again below.
    }
    setTimeout(() => planSyncEngine.askAgain(), 1500);
  }, [logout]);

  const askedRef = useRef<PlanSyncQuestion | null>(null);
  useEffect(() => {
    const question = prompt.question;
    if (!question || askedRef.current === question) return;
    askedRef.current = question;
    if (question.kind === "choose") {
      void showAlert({
        title: PLAN_SYNC_COPY.chooseTitle,
        message: here(PLAN_SYNC_COPY.chooseMessage(question.savedAt, new Date())),
        cancelable: false,
        icon: "info",
        buttons: [
          { text: PLAN_SYNC_COPY.useSavedPlan, onPress: () => planSyncEngine.answer(question, "use-saved") },
          { text: here(PLAN_SYNC_COPY.keepThisPlan), style: "cancel", onPress: () => planSyncEngine.answer(question, "keep-mine") },
        ],
      });
      return;
    }
    void showAlert({
      title: here(PLAN_SYNC_COPY.otherAccountTitle),
      message: here(PLAN_SYNC_COPY.otherAccountMessage),
      cancelable: false,
      icon: "warning",
      buttons: [
        { text: PLAN_SYNC_COPY.otherAccountContinue, style: "destructive", onPress: () => planSyncEngine.answer(question, "continue") },
        { text: PLAN_SYNC_COPY.otherAccountSignOut, style: "cancel", onPress: () => void signOut() },
      ],
    });
  }, [prompt.question, signOut]);

  // ── What the student is told once ──
  const toldRef = useRef<PlanSyncNotice | null>(null);
  useEffect(() => {
    const notice = prompt.notice;
    if (!notice || toldRef.current === notice) return;
    toldRef.current = notice;
    const [title, message] =
      notice.kind === "newer-version"
        ? [PLAN_SYNC_COPY.newerVersionTitle, PLAN_SYNC_COPY.newerVersionMessage.replace("Update the app", "Reload this page (or update the app)")]
        : notice.kind === "unreadable"
          ? [PLAN_SYNC_COPY.unreadableTitle, here(PLAN_SYNC_COPY.unreadableMessage).replace("Updating the app", "Reloading this page")]
          : [PLAN_SYNC_COPY.feedsTitle, here(PLAN_SYNC_COPY.feedsMessage)];
    void showAlert({ title, message, cancelable: false, buttons: [{ text: PLAN_SYNC_COPY.ok, onPress: () => planSyncEngine.dismissNotice(notice) }] });
  }, [prompt.notice]);

  return null;
}

/**
 * "Your plan" with "Saved to your account · 2 min ago" / "Saving…" / "Not saved yet · you're offline" (tap to try
 * again) / "Too large to save". Renders nothing when nobody is signed in.
 */
export function PlanSavedRow({ first }: { first?: boolean }): ReactElement | null {
  const colors = useColors();
  const sync = usePlanSync();
  const { blocked } = usePlanSyncPrompt();
  const [now, setNow] = useState(() => Date.now());
  const showing = sync.phase !== "off";
  useEffect(() => {
    if (!showing) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [showing]);

  const model = planSavedRowModel(sync, blocked, new Date(now));
  if (!model) return null;

  const tint = model.tone === "attention" ? colors.gold : colors.peri;
  const icon: IconName = model.tone === "attention" ? "warning" : model.tone === "busy" ? "refresh" : "check";
  const status = model.status.replace("Update Trajectory to keep saving", "Reload the page to keep saving");
  const body = (
    <>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: `${tint}24`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name={icon} size={18} color={tint} />
      </span>
      <span className="row-text">
        {/* Two lines, as in every row: the title, then what became of the plan under it. */}
        <span className="row-label" style={{ display: "block" }}>{model.title}</span>
        <span className="row-detail" style={{ display: "block" }}>{status}</span>
      </span>
      {model.canRetry ? <Icon name="refresh" size={17} color={colors.dim} /> : null}
    </>
  );
  // The rest of the row's shape (and its wider padding on a computer) comes from the .row class.
  const style = { textAlign: "left" as const, borderTop: first ? "none" : `1px solid ${colors.border}` };
  if (!model.canRetry) {
    return (
      <div className="row" style={style} aria-label={`${model.title}. ${status}`}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className="row pressable" style={{ ...style, background: "transparent", border: "none", borderTop: style.borderTop }} onClick={sync.retry} aria-label={`${model.title}. ${status}. Tries again`}>
      {body}
    </button>
  );
}
