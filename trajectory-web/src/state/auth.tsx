/**
 * Who is signed in, for React (the iPhone app's hooks/use-auth.ts). Many components ask at once (the account gate,
 * Settings, the subscription provider), and the account decides which screen may be shown at all, so the session
 * lives in ONE store (lib/session.ts) that every hook reads: a sign-in, a sign-out or a session the server refused is
 * seen by all of them in the same render.
 */
import { useEffect, useSyncExternalStore } from "react";

import { isAccountUser, sessionStore, startSession, type SessionUser } from "../lib/session";
import { accountStatusOf, type AccountStatus } from "../lib/start-route";

export type { SessionUser } from "../lib/session";
export { beginLeaving, endLeaving, isSignedInNow, sessionRefused } from "../lib/session";

function useSession() {
  const state = useSyncExternalStore(sessionStore.subscribe, sessionStore.getState, sessionStore.getState);
  useEffect(() => {
    startSession();
  }, []);
  return state;
}

export function useAuth(): {
  user: SessionUser | null;
  loading: boolean;
  error: Error | null;
  /** Signed in with a Trajectory account (Sign in with Apple). */
  isAuthenticated: boolean;
  /** The session ended by itself (expired, or the server refused it), as opposed to never signed in or signed out. */
  sessionEnded: boolean;
  refresh: () => Promise<SessionUser | null>;
  /** Drops the session (also the last step of Delete account). It does NOT erase the plan: lib/sign-out-flow.ts does that first. */
  logout: () => Promise<void>;
} {
  const state = useSession();
  return {
    user: state.user,
    loading: state.loading,
    error: state.error,
    isAuthenticated: isAccountUser(state.user),
    sessionEnded: state.ended,
    refresh: sessionStore.refresh,
    logout: sessionStore.logout,
  };
}

/** The account as the gate sees it (lib/start-route.ts): "loading" until read, and while signing out is under way. */
export function useAccountStatus(): AccountStatus {
  const state = useSession();
  return accountStatusOf({ loading: state.loading, signedIn: isAccountUser(state.user), leaving: state.leaving !== null });
}

/** The overlay's line while signing out or deleting the account is under way, else null. */
export function useLeavingLine(): string | null {
  return useSession().leaving;
}
