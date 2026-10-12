/**
 * The gate: which screen the app may show. Pure (no imports but a type) and unit-tested; the root index
 * (app/index.tsx), the tabs layout, the root guard (app/_layout.tsx) and the welcome screen (app/onboarding.tsx)
 * all ask here, so they can never disagree.
 *
 * A Trajectory account is required on iPhone (lib/features.ts): nothing but the welcome / sign-in screen is shown
 * without an account session, and nothing but its waiting state until this iPhone's plan is known to be the
 * account's (lib/plan-sync-client.ts). The plan itself still lives on the iPhone, so `onboardingComplete` keeps its
 * old job once those two are settled. The browser preview has no accounts and keeps the rule it always had.
 */
import type { PlanSyncPhase } from "./plan-sync";

export type StartRoute = "loading" | "/onboarding" | "/(tabs)";

/**
 * "loading": the Keychain has not been read yet, or signing out / deleting the account is under way (the plan is
 * being erased while the session still exists: hooks/use-auth.ts). "signed-in" means Sign in with Apple; a guest
 * session kept by an older build is "signed-out".
 */
export type AccountStatus = "loading" | "signed-out" | "signed-in";

export function accountStatusOf(input: { loading: boolean; signedIn: boolean; leaving: boolean }): AccountStatus {
  if (input.loading || input.leaving) return "loading";
  return input.signedIn ? "signed-in" : "signed-out";
}

export interface StartRouteInput {
  /** AsyncStorage hydration finished (before that, onboardingComplete is the initial `false`). */
  hydrated: boolean;
  onboardingComplete: boolean;
  /** lib/features.ts accountRequired(): true on iPhone, false in the browser preview. */
  accountRequired: boolean;
  account: AccountStatus;
  /** usePlanSync().phase: "ready" once this iPhone's plan is the account's plan. */
  planPhase: PlanSyncPhase;
  /**
   * The screens a launch can open first (the root index, the tabs): the account and the plan on this iPhone have
   * been known for less than PLAN_SETTLE_MS (hooks/use-account-gate.ts useSettlingGateInput).
   */
  settling?: boolean;
}

/**
 * How long a launch gives a signed-in student's saved plan to report "ready" before the waiting screen is shown.
 * On a normal launch that takes milliseconds and no network (it passes through "checking" on the way), and a flash
 * of "Getting your plan…" on every launch would be worse than this short extra moment on the launch mark.
 */
export const PLAN_SETTLE_MS = 700;

export function startRoute(input: StartRouteInput): StartRoute {
  if (!input.hydrated) return "loading";
  // The browser preview: the welcome screen once, then the tabs. No account decides anything.
  if (!input.accountRequired) return input.onboardingComplete ? "/(tabs)" : "/onboarding";

  if (input.account === "loading") return "loading";
  // Whatever onboardingComplete says: a plan made before accounts were required stays on the iPhone and is adopted
  // by the account after sign-in.
  if (input.account === "signed-out") return "/onboarding";
  if (input.planPhase !== "ready") {
    // "off" / "checking" in the first moments of a launch is the saved plan starting up, not a wait worth a screen.
    if (input.settling && (input.planPhase === "off" || input.planPhase === "checking")) return "loading";
    // The welcome screen shows the waiting / retry state (and <PlanSync /> its own question while "choose").
    return "/onboarding";
  }
  // Signed in and the plan settled: a new student still passes the welcome screen once (it completes onboarding).
  return input.onboardingComplete ? "/(tabs)" : "/onboarding";
}

/**
 * For the tabs layout: must the tabs give way to the welcome screen? Like startRoute, except:
 *  - Without an account session the root guard already sends the student there (it also closes the open sheets
 *    and empties the stack), and two navigations for one reason would mount that screen twice: left to the guard.
 *  - "off" while signed in means the saved plan has not started yet. The tabs can only be open then because a
 *    notification or a link opened them before the launch had settled, and in a moment the plan reports "ready":
 *    sending the student to the waiting screen for that moment would only lose the screen they asked for. The same
 *    goes for the "checking" it passes through on the way, for as long as the launch is `settling`.
 */
export function tabsGiveWayToWelcome(input: StartRouteInput): boolean {
  if (input.accountRequired && input.account === "signed-out") return false;
  if (input.accountRequired && input.account === "signed-in" && input.planPhase === "off") return false;
  return startRoute(input) === "/onboarding";
}

// ── The root guard ────────────────────────────────────────────────────────────

/**
 * Whether a route needs an account session, by its first path segment (expo-router's useSegments()[0]; the tabs
 * are "(tabs)"). Open without one: the root index (no segment at all), the welcome / sign-in screen, and the
 * in-app privacy policy that screen links to. Everything else, stack screens such as the paywall included, is not.
 */
export function routeNeedsAccount(firstSegment: string | undefined): boolean {
  return firstSegment !== undefined && firstSegment !== "onboarding" && firstSegment !== "privacy-policy";
}

/**
 * The root guard's one decision: replace this route with the sign-in screen? True when the session is not there
 * (never signed in, signed out, account deleted, expired, refused by the server) on a route that needs one. It
 * waits while the account is "loading".
 */
export function guardSendsToSignIn(input: { accountRequired: boolean; account: AccountStatus; firstSegment: string | undefined }): boolean {
  return input.accountRequired && input.account === "signed-out" && routeNeedsAccount(input.firstSegment);
}

// ── The welcome screen ────────────────────────────────────────────────────────

/**
 * What app/onboarding.tsx shows:
 *  - "start": no account is required here (the browser preview): the welcome with "Get started".
 *  - "sign-in": signed out: the welcome with Continue with Apple as its only action.
 *  - "loading": the account is not known yet (or the student is signing out): the brand and a spinner, no words.
 *  - "waiting": signed in, this iPhone's plan and the account's are being brought together ("Getting your plan…").
 *  - "unreachable": signed in, no plan on this iPhone and the account could not be reached: try again, or sign out.
 *  - "enter": signed in and the plan settled: the screen completes onboarding for a new student and leaves.
 */
export type WelcomeStage = "start" | "sign-in" | "loading" | "waiting" | "unreachable" | "enter";

/**
 * Browser-preview switches (`/onboarding?preview=account`), so the iPhone states can be looked at and screenshotted
 * in the web build, which otherwise only ever shows "start".
 */
export type WelcomePreview = "account" | "account-signed-out" | "account-wait" | "account-unreachable";

const WELCOME_PREVIEWS: readonly WelcomePreview[] = ["account", "account-signed-out", "account-wait", "account-unreachable"];

/** A `?preview=` value, when it is one of the switches. */
export function welcomePreviewOf(param: unknown): WelcomePreview | undefined {
  return WELCOME_PREVIEWS.find((preview) => preview === param);
}

/**
 * `preview` is honoured only where no account is required, and the screen only passes it in the browser build: on
 * iPhone a preview can never stand in for the real state.
 */
export function welcomeStage(input: Pick<StartRouteInput, "accountRequired" | "account" | "planPhase"> & { preview?: WelcomePreview }): WelcomeStage {
  if (!input.accountRequired) {
    if (input.preview === "account" || input.preview === "account-signed-out") return "sign-in";
    if (input.preview === "account-wait") return "waiting";
    if (input.preview === "account-unreachable") return "unreachable";
    return "start";
  }
  if (input.account === "loading") return "loading";
  if (input.account === "signed-out") return "sign-in";
  if (input.planPhase === "ready") return "enter";
  // "off", "checking" and "choose" all wait: while "choose", <PlanSync /> asks its question on top of this screen.
  return input.planPhase === "unreachable" ? "unreachable" : "waiting";
}

/** "Getting your plan…" normally lasts a moment. After this long the welcome screen adds waitingExtras below. */
export const WAITING_SLOW_MS = 20_000;

/**
 * What the "waiting" stage adds once it has lasted WAITING_SLOW_MS:
 *  - `signOut`: the quiet "Sign out" link. Whatever is being waited for: a sign-in that cannot finish must never
 *    be a screen without a way out.
 *  - `slowLine`: "This is taking longer than usual." Only for a wait on the server. While <PlanSync /> is asking
 *    which plan to keep ("choose"), the wait is for the student's answer and nothing is slow.
 */
export function waitingExtras(input: { stage: WelcomeStage; planPhase: PlanSyncPhase; waitedLong: boolean }): { signOut: boolean; slowLine: boolean } {
  const signOut = input.stage === "waiting" && input.waitedLong;
  return { signOut, slowLine: signOut && input.planPhase !== "choose" };
}

/**
 * What the welcome screen does once its stage is "enter" (signed in, the saved plan settled):
 *  - "leave": onboarding is complete, go into the app.
 *  - "complete-onboarding": a new student: mark the welcome done (the next step is then "leave").
 *  - "wait-for-restore": the plan now on this iPhone came from the account, but its state is not there yet. A
 *    restored plan arrives through LOAD_STATE with onboarding already complete, so the screen waits for that
 *    instead of completing onboarding on the empty plan it is about to replace.
 * Never anything before the stage is "enter": until the plan is settled it is not known whether this iPhone gets
 * a plan from the account.
 */
export type EnterStep = "none" | "wait-for-restore" | "complete-onboarding" | "leave";

/** How long "wait-for-restore" may last before the screen completes onboarding anyway (it must never get stuck). */
export const RESTORE_WAIT_MS = 2000;

export function enterStep(input: { stage: WelcomeStage; onboardingComplete: boolean; restoredFromAccount: boolean; restoreOverdue: boolean }): EnterStep {
  if (input.stage !== "enter") return "none";
  if (input.onboardingComplete) return "leave";
  if (input.restoredFromAccount && !input.restoreOverdue) return "wait-for-restore";
  return "complete-onboarding";
}

/**
 * Leaving the welcome screen: does the syllabus upload open on top of the tabs? Only for a first visit with an
 * empty plan. A plan that came back from the account is never a first visit, even when it is empty.
 */
export function opensSyllabusUpload(input: { planIsEmpty: boolean; restoredFromAccount: boolean }): boolean {
  return input.planIsEmpty && !input.restoredFromAccount;
}
