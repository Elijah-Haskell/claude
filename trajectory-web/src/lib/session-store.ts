/**
 * Who is signed in, as one store (hooks/use-auth.ts wires it to the Keychain, the server and React).
 *
 * An account is required (lib/features.ts), so this decides which screens the app may show at all, and nobody can
 * try it on a real iPhone before it ships. It is therefore pure: everything it touches is passed in, and the rules
 * are unit-tested (tests/session-store.test.ts):
 *  - only a Sign in with Apple session counts; a guest session kept by an older build is dropped at launch;
 *  - a session ends by itself only when the SERVER refused it, and refused it again when asked a moment later;
 *    never because the server could not be reached;
 *  - ending a session, or signing out, never touches the plan on the iPhone (the callers decide about that).
 */
import { isGuestAccount } from "../shared/pro";
import { accountSession, refreshEndsSession, type RefreshOutcome } from "./session-refresh";

type SessionUser = { openId?: string | null; loginMethod?: string | null };

export interface SessionState<U> {
  /** The signed-in account, or null. In the browser preview: whoever the cookie session belongs to. */
  user: U | null;
  /** True until the Keychain (the browser preview: the server) has been asked once. */
  loading: boolean;
  error: Error | null;
  /** The session ended without the student asking (expired, refused by the server): the welcome screen says so. */
  ended: boolean;
  /** Signing out or deleting the account is under way: the line the root overlay shows (app/_layout.tsx), else null. */
  leaving: string | null;
}

export interface SessionStoreDeps<U> {
  /** The session token in the Keychain, or null. */
  readToken: () => Promise<string | null>;
  /** The user stored with it, or null. */
  readUser: () => Promise<U | null>;
  /** Removes the token and the user stored with it. Nothing else: never the plan. */
  forget: () => Promise<void>;
  /** Removes the guest resume secret a build from before accounts were required may have left in the Keychain. */
  removeGuestResumeKey: () => Promise<void>;
  /** auth.refresh, at most once per launch (lib/session-refresh-client.ts). */
  refreshOncePerLaunch: () => Promise<RefreshOutcome>;
  /** auth.refresh again, whenever asked: how a refusal is confirmed before the session is ended. */
  refreshNow: () => Promise<RefreshOutcome>;
  /** Waits (passed in so the tests do not have to). */
  wait: (ms: number) => Promise<void>;
  /** Tells the server about a sign-out (it clears its cookie). May fail or time out. */
  serverLogout: () => Promise<void>;
}

/**
 * How long after a "not signed in" answer the server is asked again before the session is ended. A server that
 * could not look the session up for a moment (its database dropped a connection) answers exactly like one that
 * no longer accepts it; a moment later it knows better.
 */
export const CONFIRM_REFUSAL_AFTER_MS = 1500;

export function createSessionStore<U extends SessionUser>(deps: SessionStoreDeps<U>) {
  let state: SessionState<U> = { user: null, loading: true, error: null, ended: false, leaving: null };
  const listeners = new Set<() => void>();

  function set(patch: Partial<SessionState<U>>): void {
    const next = { ...state, ...patch };
    if ((Object.keys(next) as (keyof SessionState<U>)[]).every((key) => next[key] === state[key])) return;
    state = next;
    listeners.forEach((listener) => listener());
  }

  async function readStored(): Promise<{ token: string | null; user: U | null }> {
    const [token, user] = await Promise.all([deps.readToken(), deps.readUser()]);
    return { token, user };
  }

  /**
   * The server no longer accepts the session `refusedToken` (expired after 180 days without a launch, the account
   * deleted from another device): forget it on this iPhone and say so on the welcome screen.
   * Does nothing unless that is still the session the iPhone holds, so an answer that arrives after signing out, or
   * after a new sign-in, ends nothing.
   */
  async function endSession(refusedToken: string | null | undefined): Promise<void> {
    if (!refusedToken) return;
    if ((await deps.readToken()) !== refusedToken) return;
    // "You've been signed out" is only said to a student the app had signed in.
    const wasSignedIn = state.user !== null;
    await deps.forget();
    set({ user: null, loading: false, error: null, ...(wasSignedIn ? { ended: true } : {}) });
  }

  /** One confirmation per session at a time, however many of its calls were refused at once. */
  const confirming = new Map<string, Promise<void>>();

  /**
   * A call that carried the session `refusedToken` was answered "not signed in" (a 401 on any call, or the launch
   * refresh). One such answer does not end the session: an account is required, so ending it puts the student on
   * the sign-in screen, and a server that could not look the session up for a moment answers the same way. The
   * server is asked once more, a moment later, through the session's own endpoint; only if it refuses again is the
   * session ended. If it accepts (the session is renewed) or cannot be reached, the student stays signed in.
   */
  function sessionRefused(refusedToken: string | null | undefined): Promise<void> {
    if (!refusedToken) return Promise.resolve();
    const underWay = confirming.get(refusedToken);
    if (underWay) return underWay;
    const confirmation = (async () => {
      if ((await deps.readToken()) !== refusedToken) return;
      await deps.wait(CONFIRM_REFUSAL_AFTER_MS);
      // (If the student signed out or in again meanwhile, this asks about the session the iPhone holds now, and
      // endSession then does nothing: `refusedToken` is no longer that session.)
      if (refreshEndsSession(await deps.refreshNow())) await endSession(refusedToken);
    })().finally(() => confirming.delete(refusedToken));
    confirming.set(refusedToken, confirmation);
    return confirmation;
  }

  return {
    getState: (): SessionState<U> => state,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Once per launch: read the Keychain. A guest session kept by a build from before accounts were required is
     * removed quietly, with its resume secret: the student lands on the welcome screen with the plan on the iPhone
     * untouched, and signing in adopts it. (Half a session, a token without its user or the reverse, is not a
     * session either, but is left alone: one failed Keychain read must not cost a signed-in student the session.)
     * An account session is renewed with the server; one the server refuses (twice: sessionRefused) is dropped,
     * while a network error never signs anyone out.
     */
    async start(): Promise<void> {
      try {
        const { token, user } = await readStored();
        if (user && isGuestAccount(user)) await deps.forget();
        void deps.removeGuestResumeKey().catch(() => undefined);
        const account = accountSession(token, user);
        set({ user: account, loading: false });
        if (account && refreshEndsSession(await deps.refreshOncePerLaunch())) await sessionRefused(token);
      } catch (cause) {
        set({ user: null, loading: false, error: cause instanceof Error ? cause : new Error("Could not read the session") });
      }
    },

    /** After Sign in with Apple stored a session: read it and tell everyone. Resolves to the account, or null. */
    async refresh(): Promise<U | null> {
      try {
        const { token, user } = await readStored();
        const account = accountSession(token, user);
        set(account ? { user: account, loading: false, error: null, ended: false } : { user: null, loading: false, error: null });
        return account;
      } catch (cause) {
        set({ user: null, loading: false, error: cause instanceof Error ? cause : new Error("Could not read the session") });
        return null;
      }
    },

    /**
     * The Keychain cannot be read while the iPhone is locked, which looks exactly like "signed out". Coming back to
     * the app looks once more. It only ever ADOPTS a complete account session and never removes anything, so a
     * sign-in in progress is not disturbed.
     */
    async recheck(): Promise<void> {
      if (state.loading || state.user || state.leaving) return;
      try {
        const { token, user } = await readStored();
        const account = accountSession(token, user);
        if (account && !state.user && !state.leaving) set({ user: account, error: null, ended: false });
      } catch {
        // still signed out; the next look may do better
      }
    },

    /** The browser preview has no Keychain: its session is a cookie, and this is whoever the server says it is. */
    adopt(user: U | null, error: Error | null = null): void {
      set({ user, loading: false, error });
    },

    sessionRefused,

    /**
     * Signing out (also the last step of deleting the account): the session goes whether or not the server could
     * be told. A guest resume secret left in the Keychain by an older build goes too.
     */
    async logout(): Promise<void> {
      try {
        await deps.serverLogout();
      } catch {
        // Continue with logout even if the server call fails
      } finally {
        await deps.forget();
        await deps.removeGuestResumeKey();
        set({ user: null, error: null, ended: false });
      }
    },

    // Signing out erases this iPhone's copy of the plan BEFORE the session is dropped (lib/sign-out-flow.ts), so for
    // a moment the student is signed in with an emptied plan. Nothing may mistake that for a new student who just
    // signed in: while `leaving` is set the gate reports "loading" and the root layout covers the app with `line`.
    beginLeaving(line: string): void {
      set({ leaving: line });
    },

    endLeaving(): void {
      set({ leaving: null });
    },
  };
}
