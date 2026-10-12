/**
 * Signing out and deleting the account, as two sequences with everything they touch passed in. Pure (no imports but
 * a type), so the ORDER is unit-tested: it is what keeps a student's saved plan safe.
 *
 * The plan is saved to the account and a copy lives on the iPhone (lib/plan-sync-client.ts). Leaving the account
 * removes the iPhone's copy, so each sequence is:
 *   1. prepare: prepareSignOut() saves what the account does not have yet and then STOPS saving. From here the
 *      emptied plan that step 2 leaves in memory can never be saved over the account's plan.
 *   2. wipe: the iPhone's copy is erased while the session still exists. A crash right here leaves "signed in,
 *      nothing on this iPhone", which the next launch repairs from the account; the other order could leave one
 *      student's plan on an iPhone the next student signs in on.
 *   3. logout: the session is dropped, and the root guard shows the sign-in screen.
 * When step 1 gave no answer, saving was never confirmed stopped, so 2 and 3 swap: without a session nothing can
 * reach the account, and only then is the iPhone's copy erased.
 *
 * Leaving a sign-in that cannot finish (the welcome screen's "Sign out") has its own rules further down: there the
 * iPhone's plan has not been brought together with the account's yet, and it is usually not erased at all.
 * hooks/use-sign-out.ts and app/delete-account.tsx wire these to the alerts and the real functions.
 */
import type { AppState } from "../engine/types";

/**
 * What prepareSignOut() said: "saved", or "unsaved" (the account does not have this iPhone's latest changes).
 * "unanswered": it said nothing in time, or failed. Then the changes may not be saved AND saving may still be running.
 */
export type PrepareAnswer = "saved" | "unsaved" | "unanswered";

/**
 * prepareSignOut() answers within a few seconds. If it ever does not, the app must not sit behind "Signing out…"
 * for good: after `timeoutMs` the answer is "unanswered", and the student is asked what to do.
 *
 * One consequence is handled here too. prepareSignOut() stops saving when it finishes, so if it finishes AFTER the
 * student already chose to stay signed in, saving would be left stopped: `cancel` therefore starts saving again
 * right away and once more when the late answer has arrived.
 */
export function boundedPreparation(deps: { prepare: () => Promise<"saved" | "unsaved">; cancel: () => void; timeoutMs: number }): {
  prepare: () => Promise<PrepareAnswer>;
  cancel: () => void;
} {
  let late: Promise<void> | null = null;
  return {
    prepare: () => {
      const real = deps.prepare();
      let done = false;
      const whenDone = real.then(
        () => void (done = true),
        () => void (done = true),
      );
      return Promise.race<PrepareAnswer>([
        real,
        new Promise<PrepareAnswer>((resolve) =>
          setTimeout(() => {
            if (!done) late = whenDone;
            resolve("unanswered");
          }, deps.timeoutMs),
        ),
      ]);
    },
    cancel: () => {
      deps.cancel();
      if (late) void late.then(deps.cancel);
    },
  };
}

export type SignOutOutcome = "cancelled" | "stayed" | "signed-out";

export interface SignOutDeps {
  /** "Sign out?": resolves true when the student confirms. */
  confirm: () => Promise<boolean>;
  /**
   * Whether there still is a session once the question has been answered (it can stay open for a long time, and the
   * server may have refused the session meanwhile). Without one there is nothing to sign out of.
   */
  signedIn?: () => boolean;
  /** prepareSignOut(), see PrepareAnswer. A rejection counts as "unanswered". */
  prepare: () => Promise<PrepareAnswer>;
  /** "Your latest changes aren't saved yet": resolves true for "Sign out anyway", false for "Stay signed in". */
  confirmUnsaved: () => Promise<boolean>;
  /** cancelSignOut(): the student stays, saving starts again. */
  cancel: () => void;
  /** Erases this iPhone's copy (hooks/use-wipe-local-data.ts). */
  wipe: () => Promise<void>;
  /** useAuth().logout: drops the session. */
  logout: () => Promise<void>;
  /** true once the student has confirmed, false when the sequence is over, however it ended. */
  setBusy?: (busy: boolean) => void;
}

export async function runSignOut(deps: SignOutDeps): Promise<SignOutOutcome> {
  if (!(await deps.confirm())) return "cancelled";
  // The session ended while the question was open: the plan on the iPhone stays, for the next sign-in to pick up.
  if (deps.signedIn && !deps.signedIn()) return "cancelled";
  deps.setBusy?.(true);
  try {
    const prepared = await deps.prepare().catch((): PrepareAnswer => "unanswered");
    // Anything but "saved": the student is asked before anything is erased.
    if (prepared !== "saved" && !(await deps.confirmUnsaved())) {
      deps.cancel();
      return "stayed";
    }
    // No way back from here.
    if (prepared === "unanswered") {
      // Saving was never confirmed stopped, and the wipe leaves an EMPTY plan in memory. The session goes first, so
      // nothing can be saved over the account's plan any more; only then is the iPhone's copy erased.
      await deps.logout();
      await deps.wipe().catch(() => undefined);
    } else {
      // A wipe that failed half-way still ends in a sign-out: saving is stopped and the plan in memory is already
      // emptied, so staying signed in could only put that empty plan at risk of being saved.
      await deps.wipe().catch(() => undefined);
      await deps.logout();
    }
    return "signed-out";
  } finally {
    deps.setBusy?.(false);
  }
}

// ── Leaving a sign-in that cannot finish ──────────────────────────────────────
// The welcome screen's quiet "Sign out" (the account could not be reached, or "Getting your plan…" lasts). Nothing is
// asked there, so nothing may be erased on a guess. What is on the iPhone at that moment is one of two things:
//  - No plan of the student's own: the iPhone held none when the account signed in, and the student has not been
//    inside the app since. Whatever plan is on it now came from the account (onto an iPhone without a plan the
//    saved plan is put without asking, and it may be arriving at this very moment). Then the iPhone IS erased, like
//    an ordinary sign-out without its questions: left behind, it would be one account's plan on an iPhone nobody is
//    signed in on, for the next account to take over.
//  - A plan that was there before this sign-in (made before accounts were required, or kept through a session that
//    ended), or one the student has worked on since. It may be the only copy: only the session goes.

/**
 * "There is no plan on this iPhone", from the app state: no classes, tasks, recurring events, semester, syllabus
 * imports, exam preps, study guides, practice exams or grades, and no event the student put on the calendar. The
 * same list as the saved plan's own rule for an iPhone it may load the account's plan onto without asking
 * (isBlankPlan, with the saved-plan code): keep the two in step. Settings, and whether the welcome screen was
 * passed, say nothing about it.
 */
export function holdsNoPlan(
  state: Pick<AppState, "classes" | "tasks" | "recurringEvents" | "semester" | "syllabusImports" | "examPreps" | "studyGuides" | "practiceExams" | "grades" | "scheduleBlocks">,
): boolean {
  const empty = (list: readonly unknown[] | undefined) => !Array.isArray(list) || list.length === 0;
  if (!empty(state.classes) || !empty(state.tasks) || !empty(state.recurringEvents) || state.semester) return false;
  if (!empty(state.syllabusImports) || !empty(state.examPreps) || !empty(state.studyGuides) || !empty(state.practiceExams)) return false;
  if (!empty(state.grades)) return false;
  // Sleep and buffer blocks are made by the planner even when there is nothing to plan.
  return !(state.scheduleBlocks ?? []).some((block) => block.type !== "sleep" && block.type !== "buffer");
}

/**
 * "Did this iPhone hold no plan when its account signed in, and has the student stayed outside the app since?",
 * kept up to date as the facts change (`noted` is the previous answer; null: nobody signed in, or not known yet).
 * Noted once per sign-in, from the app state AFTER it was loaded from disk (`hydrated`; before that every iPhone
 * looks empty), and given up for good once the saved plan has been "ready": from then on the student is inside the
 * app, and what is on the iPhone may be theirs.
 */
export function noteEmptyAtSignIn(
  noted: boolean | null,
  now: { account: "loading" | "signed-out" | "signed-in"; hydrated: boolean; empty: boolean; planReady: boolean },
): boolean | null {
  if (now.account === "signed-out") return null;
  if (now.account !== "signed-in" || !now.hydrated) return noted;
  if (now.planReady) return false;
  return noted === null ? now.empty : noted;
}

/** What the welcome screen's "Sign out" does. Anything but a certain "empty": nothing on the iPhone is erased. */
export function leaveSignInMode(emptyAtSignIn: boolean | null): "erase" | "session-only" {
  return emptyAtSignIn === true ? "erase" : "session-only";
}

/**
 * The "session-only" way: ONLY the session goes. The iPhone is left exactly as when a session ends by itself, and
 * signing in again picks its plan up. So there is nothing to ask and nothing to save first.
 */
export async function runSessionOnlySignOut(deps: Pick<SignOutDeps, "signedIn" | "logout" | "setBusy">): Promise<SignOutOutcome> {
  if (deps.signedIn && !deps.signedIn()) return "cancelled";
  deps.setBusy?.(true);
  try {
    await deps.logout();
    return "signed-out";
  } finally {
    deps.setBusy?.(false);
  }
}

export type AccountDeletionOutcome =
  | { outcome: "cancelled" }
  /** The server did not delete the account (offline, an error): nothing was erased, the student is still signed in. */
  | { outcome: "failed" }
  /** `appleRevoked`: Apple really accepted the revocation of Sign in with Apple (the app only claims it then). */
  | { outcome: "deleted"; appleRevoked: boolean };

export interface AccountDeletionDeps {
  /** "Permanently Delete Account?": resolves true when the student confirms. */
  confirm: () => Promise<boolean>;
  /** As in SignOutDeps: without a session there is no account this iPhone could delete. */
  signedIn?: () => boolean;
  /**
   * prepareSignOut({ save: false }): nothing is worth saving to an account about to be deleted; saving just stops.
   * Its answer does not matter here: once the server has deleted the account, nothing can be saved to it anyway.
   */
  prepare: () => Promise<unknown>;
  /** account.delete on the server. */
  deleteAccount: () => Promise<{ appleRevoked?: boolean } | null | undefined>;
  cancel: () => void;
  wipe: () => Promise<void>;
  logout: () => Promise<void>;
  setBusy?: (busy: boolean) => void;
}

export async function runAccountDeletion(deps: AccountDeletionDeps): Promise<AccountDeletionOutcome> {
  if (!(await deps.confirm())) return { outcome: "cancelled" };
  if (deps.signedIn && !deps.signedIn()) return { outcome: "cancelled" };
  deps.setBusy?.(true);
  try {
    await deps.prepare().catch(() => undefined);
    let deleted: { appleRevoked?: boolean } | null | undefined;
    try {
      deleted = await deps.deleteAccount();
    } catch {
      // The account is still there: keep its plan on this iPhone and go on saving it.
      deps.cancel();
      return { outcome: "failed" };
    }
    await deps.wipe().catch(() => undefined);
    await deps.logout();
    return { outcome: "deleted", appleRevoked: deleted?.appleRevoked === true };
  } finally {
    deps.setBusy?.(false);
  }
}
