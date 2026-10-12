// lib/session-store.ts: who is signed in. An account is required, so these rules decide which screens the app may
// show at all: only a Sign in with Apple session counts, a session ends by itself only when the server refused it
// and refused it again when asked a moment later, and nothing here ever touches the plan on the iPhone.
import { describe, expect, it, vi } from "vitest";

import type { RefreshOutcome } from "../../src/lib/session-refresh";
import { CONFIRM_REFUSAL_AFTER_MS, createSessionStore } from "../../src/lib/session-store";

interface TestUser {
  id: number;
  openId: string;
  loginMethod: string | null;
}

const apple: TestUser = { id: 7, openId: "apple:001234.abc.0123", loginMethod: "apple" };
const guest: TestUser = { id: 8, openId: "guest:3f2a1b4c-0d5e-4f60-8a71-92b3c4d5e6f7", loginMethod: "guest" };

/**
 * An in-memory Keychain plus a server that answers the launch refresh with `refresh`, and with `confirm` when it is
 * asked again about a session it refused (by default it keeps refusing).
 */
function setup(
  initial: {
    token?: string | null;
    user?: TestUser | null;
    guestKey?: boolean;
    refresh?: RefreshOutcome | (() => Promise<RefreshOutcome>);
    confirm?: RefreshOutcome | (() => Promise<RefreshOutcome>);
  } = {},
) {
  const keychain = { token: initial.token ?? null, user: initial.user ?? null, guestKey: initial.guestKey ?? false };
  const calls: string[] = [];
  const refresh = initial.refresh ?? "refreshed";
  const confirm = initial.confirm ?? "unauthorized";
  const waits: number[] = [];
  const store = createSessionStore<TestUser>({
    readToken: async () => keychain.token,
    readUser: async () => keychain.user,
    forget: async () => {
      calls.push("forget");
      keychain.token = null;
      keychain.user = null;
    },
    removeGuestResumeKey: async () => {
      calls.push("removeGuestResumeKey");
      keychain.guestKey = false;
    },
    refreshOncePerLaunch: async () => {
      calls.push("refresh");
      return typeof refresh === "function" ? refresh() : refresh;
    },
    refreshNow: async () => {
      calls.push("refreshNow");
      return typeof confirm === "function" ? confirm() : confirm;
    },
    wait: async (ms) => void waits.push(ms),
    serverLogout: async () => {
      calls.push("serverLogout");
    },
  });
  const seen: (TestUser | null)[] = [];
  store.subscribe(() => seen.push(store.getState().user));
  return { store, keychain, calls, seen, waits };
}

describe("at launch", () => {
  it("is loading until the Keychain has been read", () => {
    const { store } = setup({ token: "t", user: apple });
    expect(store.getState()).toMatchObject({ user: null, loading: true, ended: false, leaving: null });
  });

  it("nobody signed in: signed out, nothing removed, the server is not asked", async () => {
    const { store, calls } = setup();
    await store.start();
    expect(store.getState()).toMatchObject({ user: null, loading: false, ended: false });
    expect(calls).not.toContain("forget");
    expect(calls).not.toContain("refresh");
  });

  it("a Sign in with Apple session: signed in, and renewed with the server", async () => {
    const { store, keychain, calls } = setup({ token: "t", user: apple });
    await store.start();
    expect(store.getState()).toMatchObject({ user: apple, loading: false, ended: false });
    expect(calls).toContain("refresh");
    expect(calls).not.toContain("forget");
    expect(keychain).toMatchObject({ token: "t", user: apple });
  });

  it("a guest session kept by an older build is dropped quietly, with its resume secret", async () => {
    const { store, keychain, calls } = setup({ token: "guest-token", user: guest, guestKey: true });
    await store.start();
    expect(store.getState()).toMatchObject({ user: null, loading: false });
    expect(store.getState().ended).toBe(false); // quietly: never "You've been signed out"
    expect(keychain).toEqual({ token: null, user: null, guestKey: false });
    expect(calls).not.toContain("refresh"); // the server refuses guests: nothing to renew
  });

  it("a guest resume secret left without a session is removed too", async () => {
    const { store, keychain } = setup({ guestKey: true });
    await store.start();
    expect(keychain.guestKey).toBe(false);
  });

  it("half a session is not a session, and is left alone (one failed Keychain read must not cost the session)", async () => {
    const tokenOnly = setup({ token: "t", user: null });
    await tokenOnly.store.start();
    expect(tokenOnly.store.getState().user).toBeNull();
    expect(tokenOnly.keychain.token).toBe("t");
    expect(tokenOnly.calls).not.toContain("forget");

    const userOnly = setup({ token: null, user: apple });
    await userOnly.store.start();
    expect(userOnly.store.getState().user).toBeNull();
    expect(userOnly.keychain.user).toBe(apple);
    expect(userOnly.calls).not.toContain("forget");
  });

  it("a session the server refuses at the launch refresh, and again when asked a moment later, is dropped, and the welcome screen is told", async () => {
    const { store, keychain, calls, waits } = setup({ token: "t", user: apple, refresh: "unauthorized" });
    await store.start();
    expect(store.getState()).toMatchObject({ user: null, loading: false, ended: true });
    expect(keychain).toMatchObject({ token: null, user: null });
    expect(calls.filter((call) => call === "refresh" || call === "refreshNow")).toEqual(["refresh", "refreshNow"]);
    expect(waits).toEqual([CONFIRM_REFUSAL_AFTER_MS]);
  });

  it("a refusal at the launch refresh that the server does not repeat signs nobody out (it could not look the session up for a moment)", async () => {
    for (const confirm of ["refreshed", "error", "skipped"] as const) {
      const { store, keychain, calls } = setup({ token: "t", user: apple, refresh: "unauthorized", confirm });
      await store.start();
      expect(store.getState()).toMatchObject({ user: apple, loading: false, ended: false });
      expect(keychain).toMatchObject({ token: "t", user: apple });
      expect(calls).not.toContain("forget");
    }
  });

  it("a network error at the launch refresh never signs anyone out", async () => {
    for (const refresh of ["error", "skipped"] as const) {
      const { store, keychain } = setup({ token: "t", user: apple, refresh });
      await store.start();
      expect(store.getState()).toMatchObject({ user: apple, ended: false });
      expect(keychain.token).toBe("t");
    }
  });

  it("the student is let in before the server has answered (the refresh does not hold the launch up)", async () => {
    let answer: (outcome: RefreshOutcome) => void = () => undefined;
    const { store } = setup({ token: "t", user: apple, refresh: () => new Promise<RefreshOutcome>((resolve) => (answer = resolve)) });
    const started = store.start();
    await vi.waitFor(() => expect(store.getState().loading).toBe(false));
    expect(store.getState().user).toBe(apple);
    answer("refreshed");
    await started;
    expect(store.getState().user).toBe(apple);
  });

  it("a Keychain that cannot be read at all ends the wait as signed out", async () => {
    const store = createSessionStore<TestUser>({
      readToken: async () => {
        throw new Error("keychain unavailable");
      },
      readUser: async () => null,
      forget: async () => undefined,
      removeGuestResumeKey: async () => undefined,
      refreshOncePerLaunch: async () => "refreshed",
      refreshNow: async () => "refreshed",
      wait: async () => undefined,
      serverLogout: async () => undefined,
    });
    await store.start();
    expect(store.getState()).toMatchObject({ user: null, loading: false, ended: false });
  });
});

describe("signing in", () => {
  it("refresh() picks up the session Sign in with Apple just stored and tells every listener", async () => {
    const { store, keychain, seen } = setup();
    await store.start();
    keychain.token = "new";
    keychain.user = apple;
    expect(await store.refresh()).toBe(apple);
    expect(store.getState()).toMatchObject({ user: apple, loading: false, ended: false });
    expect(seen[seen.length - 1]).toBe(apple);
  });

  it("clears 'You've been signed out' once the student is signed in again", async () => {
    const { store, keychain } = setup({ token: "t", user: apple, refresh: "unauthorized" });
    await store.start();
    expect(store.getState().ended).toBe(true);
    keychain.token = "new";
    keychain.user = apple;
    await store.refresh();
    expect(store.getState()).toMatchObject({ user: apple, ended: false });
  });

  it("resolves to null when what was stored is not an account session", async () => {
    const { store, keychain } = setup();
    await store.start();
    keychain.token = "g";
    keychain.user = guest;
    expect(await store.refresh()).toBeNull();
    expect(store.getState().user).toBeNull();
  });
});

describe("a call the server answered 'not signed in' (a 401 on any call)", () => {
  it("the server is asked once more a moment later; when it refuses again the session is forgotten, and the welcome screen says so", async () => {
    const { store, keychain, calls, waits } = setup({ token: "t", user: apple });
    await store.start();
    calls.length = 0;
    await store.sessionRefused("t");
    expect(waits).toEqual([CONFIRM_REFUSAL_AFTER_MS]);
    expect(calls).toEqual(["refreshNow", "forget"]);
    expect(store.getState()).toMatchObject({ user: null, ended: true });
    expect(keychain).toMatchObject({ token: null, user: null });
  });

  it("when the server accepts the session after all, nobody is signed out (it could not look the session up for a moment)", async () => {
    const { store, keychain, calls } = setup({ token: "t", user: apple, confirm: "refreshed" });
    await store.start();
    await store.sessionRefused("t");
    expect(store.getState()).toMatchObject({ user: apple, ended: false });
    expect(keychain).toMatchObject({ token: "t", user: apple });
    expect(calls).not.toContain("forget");
  });

  it("nor when the server cannot be reached to ask: offline never signs anyone out", async () => {
    for (const confirm of ["error", "skipped"] as const) {
      const { store, keychain, calls } = setup({ token: "t", user: apple, confirm });
      await store.start();
      await store.sessionRefused("t");
      expect(store.getState()).toMatchObject({ user: apple, ended: false });
      expect(keychain.token).toBe("t");
      expect(calls).not.toContain("forget");
    }
  });

  it("an answer for another session asks nothing and ends nothing (it arrived after a new sign-in, or after signing out)", async () => {
    const { store, keychain, calls } = setup({ token: "current", user: apple });
    await store.start();
    calls.length = 0;
    await store.sessionRefused("older");
    await store.sessionRefused(null);
    await store.sessionRefused(undefined);
    expect(store.getState()).toMatchObject({ user: apple, ended: false });
    expect(keychain.token).toBe("current");
    expect(calls).toEqual([]);
  });

  it("the student signs out, or in again, while the server is being asked: the new state is left alone", async () => {
    let answer: (outcome: RefreshOutcome) => void = () => undefined;
    const { store, keychain, calls } = setup({ token: "t", user: apple, confirm: () => new Promise<RefreshOutcome>((resolve) => (answer = resolve)) });
    await store.start();
    const confirming = store.sessionRefused("t");
    await vi.waitFor(() => expect(calls).toContain("refreshNow"));
    // A new sign-in meanwhile: another session is in the Keychain now.
    keychain.token = "new";
    answer("unauthorized");
    await confirming;
    expect(store.getState()).toMatchObject({ user: apple, ended: false });
    expect(keychain.token).toBe("new");
    expect(calls).not.toContain("forget");
  });

  it("several refused calls at once ask the server once and end the session once", async () => {
    const { store, calls } = setup({ token: "t", user: apple });
    await store.start();
    calls.length = 0;
    await Promise.all([store.sessionRefused("t"), store.sessionRefused("t"), store.sessionRefused("t")]);
    expect(calls.filter((call) => call === "refreshNow")).toHaveLength(1);
    expect(calls.filter((call) => call === "forget")).toHaveLength(1);
    expect(store.getState()).toMatchObject({ user: null, ended: true });
  });

  it("a later refusal is asked about again (the earlier one was not confirmed)", async () => {
    let confirm: RefreshOutcome = "refreshed";
    const { store, calls } = setup({ token: "t", user: apple, confirm: async () => confirm });
    await store.start();
    await store.sessionRefused("t");
    expect(store.getState().user).toBe(apple);
    confirm = "unauthorized";
    await store.sessionRefused("t");
    expect(calls.filter((call) => call === "refreshNow")).toHaveLength(2);
    expect(store.getState()).toMatchObject({ user: null, ended: true });
  });

  it("never says 'You've been signed out' to someone the app had not signed in", async () => {
    const { store, keychain } = setup({ token: "stray", user: null }); // half a session: not signed in
    await store.start();
    await store.sessionRefused("stray");
    expect(keychain.token).toBeNull();
    expect(store.getState()).toMatchObject({ user: null, ended: false });
  });
});

describe("signing out", () => {
  it("tells the server, forgets the session and a leftover guest resume secret, without 'You've been signed out'", async () => {
    const { store, keychain, calls } = setup({ token: "t", user: apple, guestKey: true });
    await store.start();
    calls.length = 0;
    await store.logout();
    expect(calls).toEqual(["serverLogout", "forget", "removeGuestResumeKey"]);
    expect(store.getState()).toMatchObject({ user: null, ended: false });
    expect(keychain).toEqual({ token: null, user: null, guestKey: false });
  });

  it("signs out on this iPhone even when the server cannot be told", async () => {
    const keychain = { token: "t" as string | null, user: apple as TestUser | null };
    const store = createSessionStore<TestUser>({
      readToken: async () => keychain.token,
      readUser: async () => keychain.user,
      forget: async () => {
        keychain.token = null;
        keychain.user = null;
      },
      removeGuestResumeKey: async () => undefined,
      refreshOncePerLaunch: async () => "refreshed",
      refreshNow: async () => "refreshed",
      wait: async () => undefined,
      serverLogout: async () => {
        throw new TypeError("Network request failed");
      },
    });
    await store.start();
    await store.logout();
    expect(store.getState().user).toBeNull();
    expect(keychain.token).toBeNull();
  });

  it("clears an earlier 'You've been signed out'", async () => {
    const { store } = setup({ token: "t", user: apple, refresh: "unauthorized" });
    await store.start();
    expect(store.getState().ended).toBe(true);
    await store.logout();
    expect(store.getState().ended).toBe(false);
  });
});

describe("coming back to the app while signed out", () => {
  it("adopts a complete account session the launch could not read (the iPhone was locked)", async () => {
    const { store, keychain } = setup();
    await store.start();
    keychain.token = "t";
    keychain.user = apple;
    await store.recheck();
    expect(store.getState()).toMatchObject({ user: apple, ended: false });
  });

  it("never removes anything, so a sign-in in progress is not disturbed", async () => {
    const { store, keychain, calls } = setup();
    await store.start();
    calls.length = 0;
    keychain.token = "half-stored"; // the token is stored, its user not yet
    await store.recheck();
    expect(store.getState().user).toBeNull();
    expect(keychain.token).toBe("half-stored");
    keychain.user = guest;
    await store.recheck();
    expect(keychain).toMatchObject({ token: "half-stored", user: guest });
    expect(calls).toEqual([]);
  });

  it("does nothing while loading, while signed in, or while signing out", async () => {
    const loading = setup({ token: "t", user: apple });
    await loading.store.recheck();
    expect(loading.store.getState().loading).toBe(true);

    const signedIn = setup({ token: "t", user: apple });
    await signedIn.store.start();
    const before = signedIn.store.getState();
    await signedIn.store.recheck();
    expect(signedIn.store.getState()).toBe(before);

    const leaving = setup();
    await leaving.store.start();
    leaving.store.beginLeaving("Signing out…");
    leaving.keychain.token = "t";
    leaving.keychain.user = apple;
    await leaving.store.recheck();
    expect(leaving.store.getState().user).toBeNull();
  });
});

describe("leaving (sign out, delete account)", () => {
  it("carries the overlay's line from begin to end and leaves the session alone", async () => {
    const { store } = setup({ token: "t", user: apple });
    await store.start();
    store.beginLeaving("Signing out…");
    expect(store.getState()).toMatchObject({ user: apple, leaving: "Signing out…" });
    store.endLeaving();
    expect(store.getState()).toMatchObject({ user: apple, leaving: null });
  });
});

describe("the store itself", () => {
  it("only tells listeners when something changed, and stops after unsubscribe", async () => {
    const { store } = setup();
    let notified = 0;
    const off = store.subscribe(() => (notified += 1));
    await store.start(); // loading -> false
    expect(notified).toBe(1);
    store.endLeaving(); // already null: nothing changed
    expect(notified).toBe(1);
    store.beginLeaving("Signing out…");
    expect(notified).toBe(2);
    off();
    store.endLeaving();
    expect(notified).toBe(2);
  });

  it("the browser preview adopts whoever its cookie session belongs to", () => {
    const { store } = setup();
    store.adopt(apple);
    expect(store.getState()).toMatchObject({ user: apple, loading: false, error: null });
    store.adopt(null);
    expect(store.getState()).toMatchObject({ user: null, loading: false });
  });
});
