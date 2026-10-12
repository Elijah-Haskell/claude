import { beforeEach, describe, expect, it } from "vitest";
import {
  isUnauthorizedError,
  refreshSession,
  refreshSessionOncePerLaunch,
  resetSessionRefreshForTests,
  type SessionRefreshDeps,
} from "../../src/lib/session-refresh";

function makeDeps(overrides: Partial<SessionRefreshDeps> = {}) {
  const stored: { token: string | null } = { token: "old-token" };
  const deps: SessionRefreshDeps = {
    getToken: async () => stored.token,
    setToken: async (token) => { stored.token = token; },
    callRefresh: async () => ({ sessionToken: "new-token" }),
    ...overrides,
  };
  return { deps, stored };
}

describe("session refresh", () => {
  beforeEach(() => resetSessionRefreshForTests());

  it("stores the fresh token", async () => {
    const { deps, stored } = makeDeps();
    expect(await refreshSession(deps)).toBe("refreshed");
    expect(stored.token).toBe("new-token");
  });

  it("does nothing when signed out", async () => {
    const { deps, stored } = makeDeps({ getToken: async () => null });
    expect(await refreshSession(deps)).toBe("skipped");
    expect(stored.token).toBe("old-token");
  });

  it("reports an expired or invalid session so the app can sign the user out", async () => {
    const { deps, stored } = makeDeps({
      callRefresh: async () => { throw Object.assign(new Error("x"), { data: { code: "UNAUTHORIZED", httpStatus: 401 } }); },
    });
    expect(await refreshSession(deps)).toBe("unauthorized");
    expect(stored.token).toBe("old-token");
  });

  it("keeps the current token on a network error (never signs the user out for being offline)", async () => {
    const { deps, stored } = makeDeps({ callRefresh: async () => { throw new TypeError("Network request failed"); } });
    expect(await refreshSession(deps)).toBe("error");
    expect(stored.token).toBe("old-token");
  });

  it("refuses an empty token from the server", async () => {
    const { deps, stored } = makeDeps({ callRefresh: async () => ({ sessionToken: "" }) });
    expect(await refreshSession(deps)).toBe("error");
    expect(stored.token).toBe("old-token");
  });

  it("runs once per launch", async () => {
    let calls = 0;
    const { deps } = makeDeps({ callRefresh: async () => { calls += 1; return { sessionToken: "t" }; } });
    expect(await refreshSessionOncePerLaunch(deps)).toBe("refreshed");
    expect(await refreshSessionOncePerLaunch(deps)).toBe("skipped");
    expect(calls).toBe(1);
  });

  it("recognises unauthorized errors by code or status", () => {
    expect(isUnauthorizedError({ data: { code: "UNAUTHORIZED" } })).toBe(true);
    expect(isUnauthorizedError({ data: { httpStatus: 401 } })).toBe(true);
    expect(isUnauthorizedError({ data: { code: "TOO_MANY_REQUESTS" } })).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});
