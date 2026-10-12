/**
 * The plan saved to the account, the app's side (the rules are in src/shared/plan-sync.ts and src/lib/plan-sync.ts;
 * the engine in src/lib/plan-sync-engine.ts). This file only wires the engine to the real server, storage and scheduler;
 * <PlanSync /> (src/components/plan-sync.tsx) drives it. Screens use:
 *  - usePlanSync(): where things stand (the sign-in flow's "Getting your plan…", Settings' "Saved to your account" row);
 *  - prepareSignOut() / cancelSignOut(): the first step of signing out or deleting the account.
 */
import { useSyncExternalStore } from "react";

import { isUnauthorizedError, mutate, query } from "../lib/api";
import { PlanNoSessionError, type PlanSync, type PlanSyncPrompt } from "../lib/plan-sync";
import { createPlanSyncEngine, type PlanSyncEngine, type PlanSyncTransport } from "../lib/plan-sync-engine";
import { sessionTokenNow } from "../lib/session";
import { emitSessionEnded } from "../lib/sign-in-prompt";
import { appStorage } from "../lib/storage";

export type { PlanSaveState, PlanSync, PlanSyncPhase, PlanSyncStatus } from "../lib/plan-sync";

/** A request left hanging would hold up every check and save queued behind it. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One quiet request with the session token (no consent prompt, no sign-in or paywall prompt: a save in the background
 * must never put a dialog on screen). When the server refuses the session (expired, or the account was deleted) the
 * app is told the same way the API client tells it: the root listener asks once more, ends the session and shows the
 * sign-in screen. Without this a browser holding no plan would sit on "Couldn't reach your account".
 */
async function withServer<T>(run: (token: string) => Promise<T>): Promise<T> {
  const token = sessionTokenNow();
  if (!token) throw new PlanNoSessionError();
  try {
    return await run(token);
  } catch (error) {
    if (isUnauthorizedError(error)) emitSessionEnded({ token });
    throw error;
  }
}

const transport: PlanSyncTransport = {
  header: () => withServer((token) => query("plan.header", undefined, { quiet: true, token, timeoutMs: REQUEST_TIMEOUT_MS })),
  load: () => withServer((token) => query("plan.load", undefined, { quiet: true, token, timeoutMs: REQUEST_TIMEOUT_MS })),
  save: (input) => withServer((token) => mutate("plan.save", input, { quiet: true, token, timeoutMs: REQUEST_TIMEOUT_MS })),
};

/** The heavy work (JSON, compression) waits for a quiet moment, never longer than this. */
const IDLE_WAIT_LIMIT_MS = 2500;

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const limit = setTimeout(resolve, IDLE_WAIT_LIMIT_MS);
    const done = () => {
      clearTimeout(limit);
      resolve();
    };
    const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => unknown }).requestIdleCallback;
    if (typeof idle === "function") idle(done, { timeout: 1000 });
    else setTimeout(done, 0);
  });
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The app's one engine. For src/components/plan-sync.tsx only: screens use the exports below. */
export const planSyncEngine: PlanSyncEngine = createPlanSyncEngine({
  transport,
  storage: appStorage,
  whenIdle,
  pause,
  // Never plan content, a token or a snapshot: only what failed and the error's name or code.
  log: (what, label) => console.warn(`[plan] ${what}: ${label}`),
});

/** Where the saved plan stands. Safe to call anywhere under the providers. */
export function usePlanSync(): PlanSync {
  return useSyncExternalStore(planSyncEngine.subscribe, planSyncEngine.getStatus, planSyncEngine.getStatus);
}

/** What <PlanSync /> has to ask or tell the student, and whether saving is held back. */
export function usePlanSyncPrompt(): PlanSyncPrompt {
  return useSyncExternalStore(planSyncEngine.subscribe, planSyncEngine.getPrompt, planSyncEngine.getPrompt);
}

/**
 * First step of signing out, and of deleting the account: stops all saving until the next sign-in (after one last save
 * unless `save` is false), so the emptied plan the wipe leaves behind can never be saved over the account's plan.
 * "unsaved" means the account does NOT have this browser's latest changes: the caller warns the student.
 */
export function prepareSignOut(options?: { save?: boolean }): Promise<"saved" | "unsaved"> {
  return planSyncEngine.prepareSignOut(options);
}

/** The student decided to stay signed in after prepareSignOut(): saving starts again. */
export function cancelSignOut(): void {
  planSyncEngine.cancelSignOut();
}

type SignOutHandler = () => void | Promise<void>;
let signOutHandler: SignOutHandler | null = null;

/** How "Sign out" from the other-account question is carried out (it must only end the session, never wipe). */
export function setPlanSyncSignOutHandler(handler: SignOutHandler | null): void {
  signOutHandler = handler;
}

export function planSyncSignOutHandler(): SignOutHandler | null {
  return signOutHandler;
}
