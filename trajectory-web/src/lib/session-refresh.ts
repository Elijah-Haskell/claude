/**
 * Sessions last 180 days on the server. Calling `auth.refresh` once per app launch renews them, so a student who
 * opens the app at least twice a year stays signed in, while a leaked token still dies by itself.
 * Pure logic only (no platform imports) so it is unit-testable; the wiring lives in
 * lib/session-refresh-client.ts and hooks/use-auth.ts.
 */
import { isGuestAccount } from "../shared/pro";

export type RefreshOutcome = "refreshed" | "unauthorized" | "skipped" | "error";

export interface SessionRefreshDeps {
  getToken: () => Promise<string | null>;
  setToken: (token: string) => Promise<void>;
  callRefresh: (token: string) => Promise<{ sessionToken: string }>;
}

export function isUnauthorizedError(error: unknown): boolean {
  const candidate = error as { data?: { code?: string; httpStatus?: number } } | null;
  return candidate?.data?.code === "UNAUTHORIZED" || candidate?.data?.httpStatus === 401;
}

export async function refreshSession(deps: SessionRefreshDeps): Promise<RefreshOutcome> {
  const token = await deps.getToken();
  if (!token) return "skipped";
  try {
    const { sessionToken } = await deps.callRefresh(token);
    if (!sessionToken) return "error";
    // The answer can arrive after the student signed out (or signed in again): the renewed token then belongs to a
    // session this iPhone no longer holds, and storing it would put that session back.
    if ((await deps.getToken()) !== token) return "skipped";
    await deps.setToken(sessionToken);
    return "refreshed";
  } catch (error) {
    return isUnauthorizedError(error) ? "unauthorized" : "error";
  }
}

let attemptedThisLaunch = false;

/** Refreshes at most once per app launch; safe to call from any hook that mounts often. */
export async function refreshSessionOncePerLaunch(deps: SessionRefreshDeps): Promise<RefreshOutcome> {
  if (attemptedThisLaunch) return "skipped";
  attemptedThisLaunch = true;
  return refreshSession(deps);
}

/** Test hook. */
export function resetSessionRefreshForTests(): void {
  attemptedThisLaunch = false;
}

// ── What counts as being signed in ────────────────────────────────────────────

type SessionUser = { openId?: string | null; loginMethod?: string | null };

/**
 * The account session this iPhone holds, or null. A session is a token together with the Sign in with Apple user it
 * belongs to, so these do not count:
 *  - a guest session kept by a build from before accounts were required (the server refuses those now);
 *  - half a session: a token without its user, or a user without a token (a store that failed half-way).
 * Without one the student lands on the welcome screen (hooks/use-auth.ts removes a guest session at launch). The
 * plan on the iPhone is never touched by that.
 */
export function accountSession<U extends SessionUser>(token: string | null | undefined, user: U | null | undefined): U | null {
  if (!token || !user || isGuestAccount(user)) return null;
  return user;
}

/** After the launch-time refresh: only a session the server refused is dropped. Offline never signs anyone out. */
export function refreshEndsSession(outcome: RefreshOutcome): boolean {
  return outcome === "unauthorized";
}
