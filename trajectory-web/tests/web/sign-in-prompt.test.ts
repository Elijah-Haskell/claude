// lib/sign-in-prompt.ts: what the tRPC client does with a refusal. Since an account is required, "not signed in"
// from the server no longer asks anyone to sign in from an alert: it means the session this iPhone holds is gone.
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bearerTokenOf,
  createPromptDebouncer,
  emitSessionEnded,
  noteSignedOutResponse,
  resetSessionEndedForTests,
  responseSaysSignedOut,
  subscribeSessionEnded,
  type SessionEndedEvent,
} from "../../src/lib/sign-in-prompt";

describe("prompt debounce", () => {
  it("shows the first prompt and swallows the rest of the burst", () => {
    let t = 1_000;
    const d = createPromptDebouncer({ windowMs: 4_000, now: () => t });

    expect(d.shouldShow()).toBe(true);
    // A batch of five refusals lands within a few ms.
    t += 5;
    expect(d.shouldShow()).toBe(false);
    t += 5;
    expect(d.shouldShow()).toBe(false);
    t += 5;
    expect(d.shouldShow()).toBe(false);
    t += 5;
    expect(d.shouldShow()).toBe(false);
  });

  it("prompts again once the window has passed", () => {
    let t = 0;
    const d = createPromptDebouncer({ windowMs: 4_000, now: () => t });
    expect(d.shouldShow()).toBe(true);
    t = 3_999;
    expect(d.shouldShow()).toBe(false);
    t = 4_000;
    expect(d.shouldShow()).toBe(true);
  });

  it("reset() lets the next failure prompt immediately (the user dismissed the alert)", () => {
    let t = 0;
    const d = createPromptDebouncer({ windowMs: 4_000, now: () => t });
    expect(d.shouldShow()).toBe(true);
    d.reset();
    t = 10;
    expect(d.shouldShow()).toBe(true);
  });
});

describe("session-ended emitter", () => {
  beforeEach(() => resetSessionEndedForTests());

  it("delivers events to every subscriber and stops after unsubscribe", () => {
    const seen: SessionEndedEvent[] = [];
    const off = subscribeSessionEnded((e) => seen.push(e));
    emitSessionEnded({ token: "t1" });
    off();
    emitSessionEnded({ token: "t2" });
    expect(seen).toEqual([{ token: "t1" }]);
  });

  it("a throwing listener does not block the others", () => {
    let delivered = 0;
    subscribeSessionEnded(() => { throw new Error("boom"); });
    subscribeSessionEnded(() => { delivered += 1; });
    emitSessionEnded({ token: "t" });
    expect(delivered).toBe(1);
  });
});

/** The server's UNAUTHORIZED as it arrives: superjson wraps the error shape in `json`. */
const unauthorized = (path = "ai.extractSyllabus") => ({
  error: { json: { message: "Please login (10001)", code: -32001, data: { code: "UNAUTHORIZED", httpStatus: 401, path } } },
});
const done = { result: { data: { json: 1 } } };

describe("responseSaysSignedOut (tRPC 401 detection)", () => {
  const AI = "https://api.test/api/trpc/ai.extractSyllabus,ai.planSemesterStrategy?batch=1";

  it("a 401 whose body is the server's UNAUTHORIZED is 'not signed in'", () => {
    expect(responseSaysSignedOut({ url: AI, status: 401, body: [unauthorized(), unauthorized("ai.planSemesterStrategy")] })).toBe(true);
    expect(responseSaysSignedOut({ url: AI, status: 401, body: unauthorized() })).toBe(true); // a call that was not batched
  });

  it("a bare 401 without that body is not (something in front of the server answered, not its session check)", () => {
    expect(responseSaysSignedOut({ url: AI, status: 401 })).toBe(false);
    expect(responseSaysSignedOut({ url: AI, status: 401, body: "Unauthorized" })).toBe(false);
    expect(responseSaysSignedOut({ url: AI, status: 401, body: { message: "Unauthorized" } })).toBe(false);
  });

  it("a mixed batch (207) is inspected per envelope", () => {
    expect(responseSaysSignedOut({ url: AI, status: 207, body: [done, unauthorized()] })).toBe(true);
    const badRequest = { error: { json: { message: "no", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } } };
    expect(responseSaysSignedOut({ url: AI, status: 207, body: [done, badRequest] })).toBe(false);
  });

  it("reads the envelope with or without the superjson wrapper", () => {
    expect(responseSaysSignedOut({ url: AI, status: 207, body: [done, { error: { data: { code: "UNAUTHORIZED", httpStatus: 401 } } }] })).toBe(true);
    expect(responseSaysSignedOut({ url: AI, status: 207, body: [done, { error: { json: { data: { httpStatus: 401 } } } }] })).toBe(true);
  });

  it("other failures and successes are not", () => {
    expect(responseSaysSignedOut({ url: AI, status: 200, body: [done] })).toBe(false);
    expect(responseSaysSignedOut({ url: AI, status: 429 })).toBe(false);
    expect(responseSaysSignedOut({ url: AI, status: 500, body: { error: { json: { data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } } } } })).toBe(false);
    // Only 401 and 207 are looked at, whatever the body claims.
    expect(responseSaysSignedOut({ url: AI, status: 500, body: [unauthorized()] })).toBe(false);
  });

  it("never for the sign-in procedures themselves (a refused Apple sign-in is not a session that ended)", () => {
    expect(responseSaysSignedOut({ url: "https://api.test/api/trpc/auth.apple?batch=1", status: 401, body: [unauthorized("auth.apple")] })).toBe(false);
    expect(responseSaysSignedOut({ url: "https://api.test/api/trpc/auth.refresh?batch=1", status: 401, body: [unauthorized("auth.refresh")] })).toBe(false);
  });
});

// The fixtures above are written by hand. These answers are produced by tRPC itself, set up as the server sets it up
// (superjson), so the detection is checked against what really comes over the wire.
describe("against tRPC's own answers", () => {
  const t = initTRPC.create({ transformer: superjson });
  const router = t.router({
    open: t.procedure.query(() => "ok"),
    closed: t.procedure.query((): string => {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Please login (10001)" });
    }),
    broken: t.procedure.query((): string => {
      throw new TRPCError({ code: "BAD_REQUEST", message: "no" });
    }),
  });

  async function call(procedures: string) {
    const names = procedures.split(",");
    const input = Object.fromEntries(names.map((_, index) => [index, { json: null, meta: { values: ["undefined"] } }]));
    const url = `https://api.test/api/trpc/${procedures}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetchRequestHandler({ endpoint: "/api/trpc", req: new Request(url), router, createContext: () => ({}) });
    return { url, status: response.status, body: (await response.json()) as unknown };
  }

  it("every call refused: 401, recognised", async () => {
    const answer = await call("closed");
    expect(answer.status).toBe(401);
    expect(responseSaysSignedOut(answer)).toBe(true);
    const both = await call("closed,closed");
    expect(both.status).toBe(401);
    expect(responseSaysSignedOut(both)).toBe(true);
  });

  it("a mixed batch: 207, recognised by its envelope", async () => {
    const answer = await call("open,closed");
    expect(answer.status).toBe(207);
    expect(responseSaysSignedOut(answer)).toBe(true);
  });

  it("other refusals and successes are not 'not signed in'", async () => {
    const mixed = await call("open,broken");
    expect(mixed.status).toBe(207);
    expect(responseSaysSignedOut(mixed)).toBe(false);
    const fine = await call("open");
    expect(fine.status).toBe(200);
    expect(responseSaysSignedOut(fine)).toBe(false);
  });
});

describe("the session a request carried", () => {
  it("reads the bearer token from headers in any of their shapes", () => {
    expect(bearerTokenOf({ Authorization: "Bearer abc.def" })).toBe("abc.def");
    expect(bearerTokenOf({ authorization: "bearer abc" })).toBe("abc");
    expect(bearerTokenOf([["x", "1"], ["Authorization", "Bearer abc"]])).toBe("abc");
    expect(bearerTokenOf(new Headers({ Authorization: "Bearer abc" }))).toBe("abc");
  });

  it("is null without one", () => {
    expect(bearerTokenOf(undefined)).toBeNull();
    expect(bearerTokenOf({})).toBeNull();
    expect(bearerTokenOf({ "content-type": "application/json" })).toBeNull();
    expect(bearerTokenOf({ Authorization: "" })).toBeNull();
    expect(bearerTokenOf({ Authorization: "Basic abc" })).toBeNull();
    expect(bearerTokenOf(new Headers())).toBeNull();
  });
});

describe("a 'not signed in' answer ends the session the request carried", () => {
  const url = "https://api.test/api/trpc/ai.conversationalChat?batch=1";
  beforeEach(() => resetSessionEndedForTests());

  function listen() {
    const seen: SessionEndedEvent[] = [];
    subscribeSessionEnded((e) => seen.push(e));
    return seen;
  }

  it("the server's UNAUTHORIZED for a request that carried a session: that session is gone", () => {
    const seen = listen();
    noteSignedOutResponse({ url, status: 401, body: [unauthorized("ai.conversationalChat")], sentToken: "tok" });
    expect(seen).toEqual([{ token: "tok" }]);
  });

  it("a request that carried none ends nothing (the browser preview's cookie sessions; a call made while signed out)", () => {
    const seen = listen();
    noteSignedOutResponse({ url, status: 401, body: [unauthorized()], sentToken: null });
    expect(seen).toEqual([]);
  });

  it("anything that is not the server's 'not signed in' ends nothing", () => {
    const seen = listen();
    noteSignedOutResponse({ url, status: 401, sentToken: "tok" }); // a bare 401
    noteSignedOutResponse({ url, status: 500, sentToken: "tok" });
    noteSignedOutResponse({ url, status: 403, sentToken: "tok" });
    noteSignedOutResponse({ url: "https://api.test/api/trpc/auth.apple?batch=1", status: 401, body: [unauthorized("auth.apple")], sentToken: "tok" });
    expect(seen).toEqual([]);
  });

  it("a mixed batch with one UNAUTHORIZED envelope does", () => {
    const seen = listen();
    noteSignedOutResponse({ url, status: 207, body: [done, unauthorized()], sentToken: "tok" });
    expect(seen).toEqual([{ token: "tok" }]);
  });
});
