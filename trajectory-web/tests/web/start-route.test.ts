// The gate (lib/start-route.ts): which screen the app may show. An account is required on iPhone since
// 5 October 2026; the browser preview has no accounts and keeps the rule it always had.
import { describe, expect, it } from "vitest";

import type { PlanSyncPhase } from "../../src/lib/plan-sync";
import {
  accountStatusOf,
  enterStep,
  guardSendsToSignIn,
  opensSyllabusUpload,
  PLAN_SETTLE_MS,
  RESTORE_WAIT_MS,
  routeNeedsAccount,
  startRoute,
  tabsGiveWayToWelcome,
  WAITING_SLOW_MS,
  waitingExtras,
  welcomePreviewOf,
  welcomeStage,
  type AccountStatus,
  type StartRouteInput,
} from "../../src/lib/start-route";

const PHASES: PlanSyncPhase[] = ["off", "checking", "choose", "unreachable", "ready"];
const ACCOUNTS: AccountStatus[] = ["loading", "signed-out", "signed-in"];

/** A signed-in iPhone whose plan is settled and whose welcome screen is done: the state the tabs are shown in. */
const iphone = (over: Partial<StartRouteInput> = {}): StartRouteInput => ({
  hydrated: true,
  onboardingComplete: true,
  accountRequired: true,
  account: "signed-in",
  planPhase: "ready",
  ...over,
});

/** The browser preview: no account is required, so nobody is signed in and nothing is saved ("off"). */
const browser = (over: Partial<StartRouteInput> = {}): StartRouteInput => ({
  hydrated: true,
  onboardingComplete: true,
  accountRequired: false,
  account: "signed-out",
  planPhase: "off",
  ...over,
});

describe("account status", () => {
  it("is loading until the Keychain has been read", () => {
    expect(accountStatusOf({ loading: true, signedIn: false, leaving: false })).toBe("loading");
    expect(accountStatusOf({ loading: true, signedIn: true, leaving: false })).toBe("loading");
  });

  it("then says whether a Sign in with Apple account is signed in", () => {
    expect(accountStatusOf({ loading: false, signedIn: true, leaving: false })).toBe("signed-in");
    expect(accountStatusOf({ loading: false, signedIn: false, leaving: false })).toBe("signed-out");
  });

  it("is loading again while signing out or deleting the account (signed in, but the plan is already erased)", () => {
    expect(accountStatusOf({ loading: false, signedIn: true, leaving: true })).toBe("loading");
    expect(accountStatusOf({ loading: false, signedIn: false, leaving: true })).toBe("loading");
  });
});

describe("start route on iPhone (an account is required)", () => {
  it("waits for hydration, whatever else is known (the initial state always says onboarding is incomplete)", () => {
    for (const account of ACCOUNTS) {
      for (const planPhase of PHASES) {
        for (const onboardingComplete of [true, false]) {
          expect(startRoute(iphone({ hydrated: false, account, planPhase, onboardingComplete }))).toBe("loading");
        }
      }
    }
  });

  it("waits for the account to be known", () => {
    for (const planPhase of PHASES) {
      for (const onboardingComplete of [true, false]) {
        expect(startRoute(iphone({ account: "loading", planPhase, onboardingComplete }))).toBe("loading");
      }
    }
  });

  it("signed out: the welcome / sign-in screen, whatever onboardingComplete says (a plan made before is adopted after sign-in)", () => {
    for (const planPhase of PHASES) {
      expect(startRoute(iphone({ account: "signed-out", planPhase, onboardingComplete: true }))).toBe("/onboarding");
      expect(startRoute(iphone({ account: "signed-out", planPhase, onboardingComplete: false }))).toBe("/onboarding");
    }
  });

  it("signed in but the saved plan is not settled: the welcome screen, which shows the waiting / retry state", () => {
    for (const planPhase of ["off", "checking", "choose", "unreachable"] as const) {
      expect(startRoute(iphone({ planPhase, onboardingComplete: true }))).toBe("/onboarding");
      expect(startRoute(iphone({ planPhase, onboardingComplete: false }))).toBe("/onboarding");
    }
  });

  it("signed in and settled: the tabs, or the welcome screen once for a new student", () => {
    expect(startRoute(iphone({ onboardingComplete: true }))).toBe("/(tabs)");
    expect(startRoute(iphone({ onboardingComplete: false }))).toBe("/onboarding");
  });

  it("gives a launch a moment for the saved plan to start up instead of flashing the waiting screen", () => {
    expect(PLAN_SETTLE_MS).toBeGreaterThan(0);
    expect(startRoute(iphone({ planPhase: "off", settling: true }))).toBe("loading");
    expect(startRoute(iphone({ planPhase: "checking", settling: true }))).toBe("loading");
    // A decision or a failure is not "starting up": those go to the welcome screen at once.
    expect(startRoute(iphone({ planPhase: "choose", settling: true }))).toBe("/onboarding");
    expect(startRoute(iphone({ planPhase: "unreachable", settling: true }))).toBe("/onboarding");
    // The moment changes nothing else.
    expect(startRoute(iphone({ settling: true }))).toBe("/(tabs)");
    expect(startRoute(iphone({ settling: true, onboardingComplete: false }))).toBe("/onboarding");
    expect(startRoute(iphone({ account: "signed-out", settling: true }))).toBe("/onboarding");
    expect(startRoute(iphone({ account: "loading", settling: true }))).toBe("loading");
  });
});

describe("start route in the browser preview (no account)", () => {
  it("waits for hydration", () => {
    expect(startRoute(browser({ hydrated: false, onboardingComplete: false }))).toBe("loading");
    expect(startRoute(browser({ hydrated: false, onboardingComplete: true }))).toBe("loading");
  });

  it("shows the welcome screen once, then goes straight to the tabs", () => {
    expect(startRoute(browser({ onboardingComplete: false }))).toBe("/onboarding");
    expect(startRoute(browser({ onboardingComplete: true }))).toBe("/(tabs)");
  });

  it("never depends on an account or on the saved plan", () => {
    for (const account of ACCOUNTS) {
      for (const planPhase of PHASES) {
        for (const settling of [true, false]) {
          expect(startRoute(browser({ account, planPhase, settling, onboardingComplete: true }))).toBe("/(tabs)");
          expect(startRoute(browser({ account, planPhase, settling, onboardingComplete: false }))).toBe("/onboarding");
        }
      }
    }
  });
});

describe("the tabs give way to the welcome screen", () => {
  it("not for a signed-in student whose plan is settled", () => {
    expect(tabsGiveWayToWelcome(iphone())).toBe(false);
  });

  it("when the saved plan stops being settled, or the plan was reset, while the tabs are open", () => {
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "choose" }))).toBe(true);
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "unreachable" }))).toBe(true);
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "checking" }))).toBe(true);
    expect(tabsGiveWayToWelcome(iphone({ onboardingComplete: false }))).toBe(true);
  });

  it("not while the saved plan has not started yet (a notification opened the tabs before the launch settled)", () => {
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "off" }))).toBe(false);
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "off", onboardingComplete: false }))).toBe(false);
    // The launch itself (the root index) still does not let anyone in until the plan is settled.
    expect(startRoute(iphone({ planPhase: "off" }))).toBe("/onboarding");
  });

  it("not in the launch's settle moment either: the saved plan passes through 'checking' on its way to 'ready' at every launch", () => {
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "checking", settling: true }))).toBe(false);
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "off", settling: true }))).toBe(false);
    // Once the moment is over, a plan still being checked is a real wait: the waiting screen.
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "checking", settling: false }))).toBe(true);
    // A decision, a failure or a plan that was reset do not wait for the moment to pass.
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "choose", settling: true }))).toBe(true);
    expect(tabsGiveWayToWelcome(iphone({ planPhase: "unreachable", settling: true }))).toBe(true);
    expect(tabsGiveWayToWelcome(iphone({ onboardingComplete: false, settling: true }))).toBe(true);
    expect(tabsGiveWayToWelcome(iphone({ settling: true }))).toBe(false);
  });

  it("never because the session is missing: the root guard does that, once", () => {
    for (const planPhase of PHASES) {
      for (const onboardingComplete of [true, false]) {
        expect(tabsGiveWayToWelcome(iphone({ account: "signed-out", planPhase, onboardingComplete }))).toBe(false);
      }
    }
  });

  it("not while the account is loading or the student is signing out (the plan is erased before the session)", () => {
    expect(tabsGiveWayToWelcome(iphone({ account: "loading", onboardingComplete: false, planPhase: "off" }))).toBe(false);
    expect(tabsGiveWayToWelcome(iphone({ hydrated: false, onboardingComplete: false }))).toBe(false);
  });

  it("in the browser preview only for an unfinished welcome screen, as before", () => {
    expect(tabsGiveWayToWelcome(browser({ onboardingComplete: false }))).toBe(true);
    expect(tabsGiveWayToWelcome(browser({ onboardingComplete: true }))).toBe(false);
  });
});

describe("the root guard", () => {
  it("leaves three routes open without an account: the root index, the welcome screen and the privacy policy", () => {
    expect(routeNeedsAccount(undefined)).toBe(false); // the root index has no path segment
    expect(routeNeedsAccount("onboarding")).toBe(false);
    expect(routeNeedsAccount("privacy-policy")).toBe(false);
  });

  it("closes every other route, stack screens included", () => {
    for (const segment of ["(tabs)", "paywall", "syllabus-upload", "delete-account", "exam-prep", "google-calendar-sync", "syllabus-history", "+not-found"]) {
      expect(routeNeedsAccount(segment), segment).toBe(true);
    }
  });

  it("sends a signed-out student to the sign-in screen from any closed route", () => {
    expect(guardSendsToSignIn({ accountRequired: true, account: "signed-out", firstSegment: "(tabs)" })).toBe(true);
    expect(guardSendsToSignIn({ accountRequired: true, account: "signed-out", firstSegment: "paywall" })).toBe(true);
    expect(guardSendsToSignIn({ accountRequired: true, account: "signed-out", firstSegment: "delete-account" })).toBe(true);
  });

  it("does nothing on an open route, for a signed-in student, or while the account is loading", () => {
    for (const firstSegment of [undefined, "onboarding", "privacy-policy"]) {
      expect(guardSendsToSignIn({ accountRequired: true, account: "signed-out", firstSegment })).toBe(false);
    }
    expect(guardSendsToSignIn({ accountRequired: true, account: "signed-in", firstSegment: "(tabs)" })).toBe(false);
    expect(guardSendsToSignIn({ accountRequired: true, account: "loading", firstSegment: "(tabs)" })).toBe(false);
  });

  it("does nothing at all in the browser preview", () => {
    for (const account of ACCOUNTS) {
      expect(guardSendsToSignIn({ accountRequired: false, account, firstSegment: "(tabs)" })).toBe(false);
      expect(guardSendsToSignIn({ accountRequired: false, account, firstSegment: "paywall" })).toBe(false);
    }
  });
});

describe("the welcome screen's stage", () => {
  const stage = (over: Partial<Parameters<typeof welcomeStage>[0]> = {}) =>
    welcomeStage({ accountRequired: true, account: "signed-out", planPhase: "off", ...over });

  it("signed out: Continue with Apple", () => {
    for (const planPhase of PHASES) expect(stage({ planPhase })).toBe("sign-in");
  });

  it("signed in: waits for the saved plan, offers a retry when the account is unreachable, then enters the app", () => {
    expect(stage({ account: "signed-in", planPhase: "off" })).toBe("waiting");
    expect(stage({ account: "signed-in", planPhase: "checking" })).toBe("waiting");
    expect(stage({ account: "signed-in", planPhase: "choose" })).toBe("waiting"); // <PlanSync /> asks on top
    expect(stage({ account: "signed-in", planPhase: "unreachable" })).toBe("unreachable");
    expect(stage({ account: "signed-in", planPhase: "ready" })).toBe("enter");
  });

  it("never enters before the plan is settled (onboarding must not be completed until then)", () => {
    for (const planPhase of PHASES.filter((phase) => phase !== "ready")) {
      expect(stage({ account: "signed-in", planPhase })).not.toBe("enter");
    }
  });

  it("shows no words while the account is not known", () => {
    for (const planPhase of PHASES) expect(stage({ account: "loading", planPhase })).toBe("loading");
  });

  it("in the browser preview: Get started, whoever is signed in", () => {
    for (const account of ACCOUNTS) {
      for (const planPhase of PHASES) {
        expect(welcomeStage({ accountRequired: false, account, planPhase })).toBe("start");
      }
    }
  });

  it("the preview switches show the iPhone states in the browser preview", () => {
    const preview = (name: Parameters<typeof welcomeStage>[0]["preview"]) =>
      welcomeStage({ accountRequired: false, account: "signed-out", planPhase: "off", preview: name });
    expect(preview("account")).toBe("sign-in");
    expect(preview("account-signed-out")).toBe("sign-in");
    expect(preview("account-wait")).toBe("waiting");
    expect(preview("account-unreachable")).toBe("unreachable");
  });

  it("a preview can never stand in for the real state where an account is required", () => {
    for (const preview of ["account", "account-signed-out", "account-wait", "account-unreachable"] as const) {
      expect(stage({ preview })).toBe("sign-in");
      expect(stage({ account: "signed-in", planPhase: "ready", preview })).toBe("enter");
      expect(stage({ account: "signed-in", planPhase: "checking", preview })).toBe("waiting");
      expect(stage({ account: "signed-in", planPhase: "unreachable", preview })).toBe("unreachable");
      expect(stage({ account: "loading", preview })).toBe("loading");
    }
  });

  it("only knows its own preview names", () => {
    expect(welcomePreviewOf("account")).toBe("account");
    expect(welcomePreviewOf("account-wait")).toBe("account-wait");
    expect(welcomePreviewOf("account-unreachable")).toBe("account-unreachable");
    expect(welcomePreviewOf("account-signed-out")).toBe("account-signed-out");
    for (const other of [undefined, null, "", "signin", "ACCOUNT", ["account"], 1]) expect(welcomePreviewOf(other)).toBeUndefined();
  });

  it("a wait that lasts always gets a way out, and says it is slow only when it is the server that is waited for", () => {
    expect(WAITING_SLOW_MS).toBeGreaterThanOrEqual(10_000); // long enough that a normal sign-in never sees it
    const both = { signOut: true, slowLine: true };
    const nothing = { signOut: false, slowLine: false };
    expect(waitingExtras({ stage: "waiting", planPhase: "checking", waitedLong: true })).toEqual(both);
    expect(waitingExtras({ stage: "waiting", planPhase: "off", waitedLong: true })).toEqual(both); // the saved plan never started
    // The student is being asked which plan to keep: nothing is slow, but the way out is there all the same.
    expect(waitingExtras({ stage: "waiting", planPhase: "choose", waitedLong: true })).toEqual({ signOut: true, slowLine: false });
    // Not before the wait has lasted.
    for (const planPhase of PHASES) expect(waitingExtras({ stage: "waiting", planPhase, waitedLong: false })).toEqual(nothing);
    // The other stages have their own actions (or none is wanted: the app is about to open).
    for (const other of ["start", "sign-in", "loading", "unreachable", "enter"] as const) {
      for (const planPhase of PHASES) expect(waitingExtras({ stage: other, planPhase, waitedLong: true })).toEqual(nothing);
    }
  });
});

describe("entering the app from the welcome screen", () => {
  const step = (over: Partial<Parameters<typeof enterStep>[0]> = {}) =>
    enterStep({ stage: "enter", onboardingComplete: false, restoredFromAccount: false, restoreOverdue: false, ...over });

  it("does nothing before the stage is 'enter': onboarding is never completed while the plan is not settled", () => {
    for (const stage of ["start", "sign-in", "loading", "waiting", "unreachable"] as const) {
      for (const onboardingComplete of [true, false]) {
        for (const restoredFromAccount of [true, false]) {
          expect(step({ stage, onboardingComplete, restoredFromAccount, restoreOverdue: true })).toBe("none");
        }
      }
    }
  });

  it("a new student: onboarding is completed first, then the screen leaves", () => {
    expect(step()).toBe("complete-onboarding");
    expect(step({ onboardingComplete: true })).toBe("leave");
  });

  it("a plan made on this iPhone before, or restored from the account: straight into the app", () => {
    expect(step({ onboardingComplete: true, restoredFromAccount: false })).toBe("leave");
    expect(step({ onboardingComplete: true, restoredFromAccount: true })).toBe("leave");
  });

  it("a restored plan that has not reached the state yet is waited for, not replaced by a completed empty one", () => {
    expect(step({ restoredFromAccount: true })).toBe("wait-for-restore");
    expect(step({ restoredFromAccount: true, onboardingComplete: true })).toBe("leave"); // it arrived
  });

  it("never waits for good: after RESTORE_WAIT_MS onboarding is completed anyway", () => {
    expect(RESTORE_WAIT_MS).toBeGreaterThan(0);
    expect(step({ restoredFromAccount: true, restoreOverdue: true })).toBe("complete-onboarding");
  });

  it("opens the syllabus upload only for a first visit with an empty plan", () => {
    expect(opensSyllabusUpload({ planIsEmpty: true, restoredFromAccount: false })).toBe(true);
    expect(opensSyllabusUpload({ planIsEmpty: false, restoredFromAccount: false })).toBe(false);
    // A plan that came back from the account is not a first visit, even when it is empty.
    expect(opensSyllabusUpload({ planIsEmpty: true, restoredFromAccount: true })).toBe(false);
    expect(opensSyllabusUpload({ planIsEmpty: false, restoredFromAccount: true })).toBe(false);
  });
});
