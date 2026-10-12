/**
 * Signing out, and erasing this browser's copy of the plan (the iPhone app's hooks/use-sign-out.ts and
 * hooks/use-wipe-local-data.ts). The order lives in src/lib/sign-out-flow.ts and is what keeps a student's saved plan
 * safe: save, stop saving, erase this browser, drop the session.
 */
import { useCallback } from "react";

import { ACCOUNT_COPY, SIGN_OUT_CONFIRM, SIGN_OUT_UNSAVED } from "../engine/account-copy";
import { wipeAllLocalAppData } from "../lib/account-deletion-utils";
import { cancelAllStudyReminders } from "../lib/notifications";
import { beginLeaving, endLeaving, isSignedInNow } from "../lib/session";
import { boundedPreparation, leaveSignInMode, runSessionOnlySignOut, runSignOut } from "../lib/sign-out-flow";
import { appStorage } from "../lib/storage";
import { THEME_STORAGE_KEY } from "../ui/theme";
import { emptyAtSignInNow } from "./account-gate";
import { useAIConsent } from "./ai-consent";
import { appStatePersister, useApp } from "./app-provider";
import { useAuth } from "./auth";
import { confirmDialog, tellDialog } from "./dialogs";
import { cancelSignOut, prepareSignOut } from "./plan-sync-client";

/** prepareSignOut() saves for a few seconds at most; after this it is "not saved" and the student is asked. */
const PREPARE_TIMEOUT_MS = 20_000;

/** The first step of leaving the account and its undo (src/state/plan-sync-client.ts), with the time limit above. */
export function leavePreparation(options?: { save?: boolean }) {
  return boundedPreparation({ prepare: () => prepareSignOut(options), cancel: cancelSignOut, timeoutMs: PREPARE_TIMEOUT_MS });
}

/** A yes / no question as a promise. */
export function confirmAlert(copy: { title: string; message: string; no: string; yes: string; destructive?: boolean }): Promise<boolean> {
  return confirmDialog(copy);
}

/** An alert that only tells (how deleting the account ended). */
export function tellAlert(title: string, message: string, button?: string): void {
  void tellDialog(title, message, button);
}

/** The copy, with "this iPhone" said as "this browser". */
const here = (text: string) => text.replace(/this iPhone/g, "this browser").replace(/This iPhone/g, "This browser");

/**
 * Erases everything Trajectory keeps in this browser: the in-memory app state, every stored key (plan, AI consent, AI
 * memory, drafts, nudges, ...) and every pending reminder. Only ever call it as a step of lib/sign-out-flow.ts, after
 * prepareSignOut() has stopped saving. The appearance setting is kept: it is this browser's, not the student's data.
 */
export function useWipeLocalData(): () => Promise<void> {
  const { dispatch } = useApp();
  const { withdrawAIConsent } = useAIConsent();
  return useCallback(async () => {
    dispatch({ type: "LOGOUT" });
    appStatePersister().cancel();
    await appStatePersister().idle();
    await wipeAllLocalAppData({ storage: appStorage, cancelReminders: cancelAllStudyReminders, keep: [THEME_STORAGE_KEY] });
    await withdrawAIConsent();
  }, [dispatch, withdrawAIConsent]);
}

// One sign-out at a time, whichever screen started it.
let running = false;

/**
 * Signing out: "Sign out?" → the plan's last changes are saved to the account and saving stops → a second warning if
 * they could NOT be saved → the plan is erased from this browser → the session is dropped → the gate shows the sign-in
 * screen. `fromWelcome`: the welcome screen's quiet "Sign out" for a sign-in that cannot finish; it asks nothing, so it
 * erases nothing on a guess (lib/sign-out-flow.ts leaveSignInMode).
 */
export function useSignOut(options?: { fromWelcome?: boolean }): () => void {
  const fromWelcome = options?.fromWelcome === true;
  const wipeLocalData = useWipeLocalData();
  const { logout } = useAuth();

  return useCallback(() => {
    if (running) return;
    running = true;
    const setBusy = (busy: boolean) => (busy ? beginLeaving(ACCOUNT_COPY.signingOut) : endLeaving());
    const yes = () => Promise.resolve(true);
    const withThePlan = () => {
      const preparation = leavePreparation();
      return runSignOut({
        confirm: () => confirmAlert({ title: SIGN_OUT_CONFIRM.title, message: here(SIGN_OUT_CONFIRM.message), no: SIGN_OUT_CONFIRM.cancel, yes: SIGN_OUT_CONFIRM.confirm, destructive: true }),
        signedIn: isSignedInNow,
        prepare: preparation.prepare,
        confirmUnsaved: () => confirmAlert({ title: SIGN_OUT_UNSAVED.title, message: SIGN_OUT_UNSAVED.message, no: SIGN_OUT_UNSAVED.stay, yes: SIGN_OUT_UNSAVED.leave, destructive: true }),
        cancel: preparation.cancel,
        wipe: wipeLocalData,
        logout,
        setBusy,
      });
    };
    const erasingQuietly = () => {
      const preparation = leavePreparation({ save: false });
      return runSignOut({ confirm: yes, signedIn: isSignedInNow, prepare: preparation.prepare, confirmUnsaved: yes, cancel: preparation.cancel, wipe: wipeLocalData, logout, setBusy });
    };
    const leavingSignIn = () =>
      leaveSignInMode(emptyAtSignInNow()) === "erase" ? erasingQuietly() : runSessionOnlySignOut({ signedIn: isSignedInNow, logout, setBusy });
    void (fromWelcome ? leavingSignIn() : withThePlan())
      .catch((error) => {
        console.warn("[sign-out] did not finish:", error instanceof Error ? error.name : "unknown error");
      })
      .finally(() => {
        running = false;
      });
  }, [fromWelcome, wipeLocalData, logout]);
}
