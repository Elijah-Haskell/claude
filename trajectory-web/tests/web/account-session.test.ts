// What counts as being signed in (lib/session-refresh.ts accountSession), and when the launch-time refresh ends a
// session. An account is required: a guest session kept by an older build is not one, and is dropped at launch.
import { describe, expect, it } from "vitest";

import { accountSession, refreshEndsSession, refreshSession } from "../../src/lib/session-refresh";

describe("what counts as being signed in", () => {
  const apple = { id: 7, openId: "apple:001234.abc.0123", name: "Sam", email: null, loginMethod: "apple" };
  const guest = { id: 8, openId: "guest:3f2a1b4c-0d5e-4f60-8a71-92b3c4d5e6f7", name: "Guest", email: null, loginMethod: "guest" };

  it("a token together with the Sign in with Apple user it belongs to", () => {
    expect(accountSession("token", apple)).toBe(apple);
  });

  it("not a guest session kept by a build from before accounts were required", () => {
    expect(accountSession("token", guest)).toBeNull();
    expect(accountSession("token", { ...guest, loginMethod: null })).toBeNull(); // an older cache without loginMethod
    expect(accountSession("token", { ...apple, loginMethod: "guest" })).toBeNull();
  });

  it("not half a session", () => {
    expect(accountSession(null, apple)).toBeNull(); // the user without a token
    expect(accountSession("", apple)).toBeNull();
    expect(accountSession("token", null)).toBeNull(); // a token without its user
    expect(accountSession(undefined, undefined)).toBeNull();
  });
});

describe("after the launch-time refresh", () => {
  it("only a session the server refused is dropped: offline never signs anyone out", () => {
    expect(refreshEndsSession("unauthorized")).toBe(true);
    expect(refreshEndsSession("error")).toBe(false);
    expect(refreshEndsSession("refreshed")).toBe(false);
    expect(refreshEndsSession("skipped")).toBe(false);
  });

  it("a renewed token that arrives after the student signed out is not stored (it would put the session back)", async () => {
    const keychain: { token: string | null } = { token: "old" };
    const signedOutMeanwhile = await refreshSession({
      getToken: async () => keychain.token,
      setToken: async (token) => {
        keychain.token = token;
      },
      callRefresh: async () => {
        keychain.token = null; // the student signs out while the request is on its way
        return { sessionToken: "renewed" };
      },
    });
    expect(signedOutMeanwhile).toBe("skipped");
    expect(keychain.token).toBeNull();

    // Nor after signing in again as someone else: the new session's token stays.
    keychain.token = "old";
    const signedInAgain = await refreshSession({
      getToken: async () => keychain.token,
      setToken: async (token) => {
        keychain.token = token;
      },
      callRefresh: async () => {
        keychain.token = "another-session";
        return { sessionToken: "renewed" };
      },
    });
    expect(signedInAgain).toBe("skipped");
    expect(keychain.token).toBe("another-session");
  });
});
