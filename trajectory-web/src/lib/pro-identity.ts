/**
 * Who owns a Trajectory Pro purchase, and what to do when the server and this iPhone disagree. Pure (no platform
 * imports) so it is unit-tested; lib/subscription-context.tsx wires it to RevenueCat.
 *
 * - Trajectory Pro is tied to the account: RevenueCat's app user id follows the session, `revenueCatAppUserId(openId)`
 *   ("apple_<sub>" for Sign in with Apple), and is anonymous only while signed out. The server asks RevenueCat about
 *   the same id (server/entitlements.ts), so the two agree on who holds Pro.
 * - After logging RevenueCat in the app calls syncPurchases once, so a purchase made under another id (anonymous, or
 *   the "guest_<uuid>" id of a build from before accounts were required) follows to the account (RevenueCat's
 *   "transfer" restore behaviour, the default). Never after logging out: the purchase stays with the account.
 */
import { revenueCatAppUserId } from "../shared/pro";

/** The RevenueCat app user id for the current session's account, or null for "anonymous" (signed out). */
export function revenueCatIdForSession(user: { openId: string } | null | undefined): string | null {
  return user?.openId ? revenueCatAppUserId(user.openId) : null;
}

export type IdentityStep = "none" | "logIn" | "logOut";

/** What RevenueCat has to do so its identity matches the session. */
export function identityStep(current: string | null | undefined, desired: string | null, currentIsAnonymous: boolean): IdentityStep {
  if (desired) return current === desired ? "none" : "logIn";
  return currentIsAnonymous ? "none" : "logOut";
}

/**
 * "needs-pro": this iPhone has no Pro either, so the paywall is right.
 * "confirmed": this iPhone has Pro and, after linking the purchase again, the server agrees (the refused call can
 *   be sent again).
 * "unconfirmed": this iPhone has Pro but the server still does not see it: say so honestly and offer Restore
 *   Purchases, never the "buy Pro" paywall.
 */
export type ProRefusalOutcome = "needs-pro" | "confirmed" | "unconfirmed";

export interface ProReconcileDeps {
  /** This iPhone's entitlement, read fresh from RevenueCat. */
  devicePro: () => Promise<boolean>;
  /**
   * Posts this Apple Account's purchases to RevenueCat once (syncPurchases: never an Apple sign-in prompt) and
   * resolves to the entitlement read afterwards. Asked only when devicePro says no.
   */
  syncDevice: () => Promise<boolean>;
  /** Logs RevenueCat in again with the session's id and syncs purchases; resolves to the entitlement afterwards. */
  relink: () => Promise<boolean>;
  /** Asks the server to re-check Pro now (dropping its cached answer): true / false, or null if it could not ask. */
  recheckServer: () => Promise<boolean | null>;
}

/**
 * The server refused a call as "needs Pro": decide what the student is told. Never throws.
 *
 * "No Pro on this iPhone" is only concluded after one syncPurchases: a purchase this Apple Account made under another
 * RevenueCat id (before accounts were required, or under an earlier Trajectory account) shows no Pro in this iPhone's
 * customer info until its receipt is posted under the current id.
 */
export async function reconcileProRefusal(deps: ProReconcileDeps): Promise<ProRefusalOutcome> {
  const devicePro = (await deps.devicePro().catch(() => false)) || (await deps.syncDevice().catch(() => false));
  if (!devicePro) return "needs-pro";
  const stillPro = await deps.relink().catch(() => true);
  // The iPhone showed Pro a moment ago: whatever happens now, a paying student is never sent to "buy Pro".
  if (!stillPro) return "unconfirmed";
  return (await deps.recheckServer().catch(() => null)) === true ? "confirmed" : "unconfirmed";
}

/** Runs `fn` once at a time: callers that arrive while it runs share its result. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = fn().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
