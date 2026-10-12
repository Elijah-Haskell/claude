/**
 * The account's session in this browser (the iPhone app's lib/_core/auth.ts, lib/app-session.ts, hooks/use-auth.ts
 * and lib/session-refresh-client.ts in one place). The rules are the ported lib/session-store.ts and
 * lib/session-refresh.ts: only a Sign in with Apple session counts; a session ends by itself only when the SERVER
 * refused it twice, never because it could not be reached; ending a session never touches the plan in this browser.
 *
 * The token and the user it belongs to live in localStorage under keys outside the "trajectory_" family, so the wipe
 * that precedes a sign-out (lib/account-deletion-utils.ts) leaves them to `logout()`, which removes them last.
 */
import { isGuestAccount } from "../shared/pro";
import { mutate, setSessionTokenProvider, type ApiUser, type SignInResult } from "./api";
import { refreshSession, refreshSessionOncePerLaunch } from "./session-refresh";
import { createSessionStore } from "./session-store";
import { accountStatusOf, type AccountStatus } from "./start-route";
import { readLocal, writeLocal } from "./storage";

export const SESSION_TOKEN_KEY = "app_session_token";
export const SESSION_USER_KEY = "app_session_user";

export interface SessionUser {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  /** ISO 8601, or null. */
  lastSignedIn: string | null;
}

function readToken(): string | null {
  return readLocal(SESSION_TOKEN_KEY);
}

function readUser(): SessionUser | null {
  const raw = readLocal(SESSION_USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionUser> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.openId !== "string" || typeof parsed.id !== "number") return null;
    return {
      id: parsed.id,
      openId: parsed.openId,
      name: typeof parsed.name === "string" ? parsed.name : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      loginMethod: typeof parsed.loginMethod === "string" ? parsed.loginMethod : null,
      lastSignedIn: typeof parsed.lastSignedIn === "string" ? parsed.lastSignedIn : null,
    };
  } catch {
    return null;
  }
}

/** The session token this browser holds right now, or null (every API call carries it). */
export function sessionTokenNow(): string | null {
  return readToken();
}

setSessionTokenProvider(readToken);

/** What the server answered about the account, as this browser keeps it. */
export function userFromApi(user: ApiUser): SessionUser {
  const signedIn = user.lastSignedIn instanceof Date ? user.lastSignedIn.toISOString() : typeof user.lastSignedIn === "string" ? user.lastSignedIn : new Date().toISOString();
  return { id: user.id, openId: user.openId, name: user.name ?? null, email: user.email ?? null, loginMethod: user.loginMethod ?? null, lastSignedIn: signedIn };
}

// ── Renewing the session ──────────────────────────────────────
// A plain call (quiet: no "session ended" prompt): a refused refresh is reported to its one caller, the store, which
// decides. The token to renew is passed explicitly so the answer can be compared with what the browser holds then.
const refreshDeps = {
  getToken: async () => readToken(),
  setToken: async (token: string) => {
    if (!writeLocal(SESSION_TOKEN_KEY, token)) throw new Error("Could not store the session.");
  },
  callRefresh: (token: string) => mutate("auth.refresh", undefined, { quiet: true, token, timeoutMs: 15_000 }),
};

/** Longest a sign-out waits for the server: the session goes either way. */
const LOGOUT_TIMEOUT_MS = 6_000;

export const sessionStore = createSessionStore<SessionUser>({
  readToken: async () => readToken(),
  readUser: async () => readUser(),
  forget: async () => {
    writeLocal(SESSION_TOKEN_KEY, null);
    writeLocal(SESSION_USER_KEY, null);
  },
  // Guest sessions were an iPhone affair (the Keychain); this browser never held one.
  removeGuestResumeKey: async () => undefined,
  refreshOncePerLaunch: () => refreshSessionOncePerLaunch(refreshDeps),
  refreshNow: () => refreshSession(refreshDeps),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  serverLogout: () => mutate("auth.logout", undefined, { quiet: true, timeoutMs: LOGOUT_TIMEOUT_MS }).then(() => undefined),
});

/** After Sign in with Apple answered: store the session and tell everyone. Resolves to the account, or null. */
export async function completeSignIn(result: SignInResult): Promise<SessionUser | null> {
  const user = userFromApi(result.user);
  if (!writeLocal(SESSION_TOKEN_KEY, result.sessionToken) || !writeLocal(SESSION_USER_KEY, JSON.stringify(user))) {
    writeLocal(SESSION_TOKEN_KEY, null);
    writeLocal(SESSION_USER_KEY, null);
    throw new Error("This browser cannot store a session (storage is blocked). Allow site data and try again.");
  }
  return sessionStore.refresh();
}

/** Signed in with a Trajectory account (Sign in with Apple). A guest session from an older build is not one. */
export function isAccountUser(user: SessionUser | null): boolean {
  return user !== null && !isGuestAccount(user);
}

/** Right now, outside React (lib/sign-out-flow.ts looks again before it acts). */
export function isSignedInNow(): boolean {
  return isAccountUser(sessionStore.getState().user);
}

export function accountStatusNow(): AccountStatus {
  const state = sessionStore.getState();
  return accountStatusOf({ loading: state.loading, signedIn: isAccountUser(state.user), leaving: state.leaving !== null });
}

/**
 * A call that carried the session `refusedToken` was answered "not signed in" (lib/sign-in-prompt.ts reports it). The
 * server is asked once more; if it still refuses, the session is forgotten and the welcome screen says "You've been
 * signed out". The plan in this browser is never touched: signing in again picks it up.
 */
export function sessionRefused(refusedToken: string | null | undefined): Promise<void> {
  return sessionStore.sessionRefused(refusedToken);
}

// ── Leaving (sign out, delete account) ────────────────────────
// lib/sign-out-flow.ts brackets its work with these; the gate then reports "loading" and the app covers itself with
// `line` while the plan is erased from this browser a moment before the session is dropped.

export function beginLeaving(line: string): void {
  sessionStore.beginLeaving(line);
}

export function endLeaving(): void {
  sessionStore.endLeaving();
}

// ── Launch ────────────────────────────────────────────────────

let started = false;

/** Once per launch, from the first hook that mounts: find out who is signed in and renew the session. */
export function startSession(): void {
  if (started) return;
  started = true;
  void sessionStore.start();
  // Another tab signed in or out: this one follows (the token is shared through localStorage).
  window.addEventListener("storage", (event) => {
    if (event.key === SESSION_TOKEN_KEY || event.key === SESSION_USER_KEY) void sessionStore.refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void sessionStore.recheck();
  });
}
