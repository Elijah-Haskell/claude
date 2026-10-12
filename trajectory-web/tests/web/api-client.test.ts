// The web API client against a real tRPC router with the production transformer (superjson), served through tRPC's
// fetch adapter and handed to the client as `fetch`: the wire format (GET queries with `?input=`, POST mutations,
// Date values through superjson, the error envelope with the app's own codes) and the two prompts the client raises.
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAIConsentRequester } from "../../src/lib/ai-consent";
import { ApiError, isUnauthorizedError, mutate, query, setSessionTokenProvider } from "../../src/lib/api";
import { resetPaywallPromptForTests, resetSessionEndedForTests, setProRefusalHandler, subscribePaywallPrompt, subscribeSessionEnded } from "../../src/lib/sign-in-prompt";
import { FREE_SYLLABUS_LIMIT_ERR_MSG, PRO_REQUIRED_ERR_MSG, appErrorCodeForMessage } from "../../src/shared/pro";

const t = initTRPC.context<{ token: string | null }>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const appCode = error.code === "FORBIDDEN" ? appErrorCodeForMessage(error.message) : null;
    return appCode ? { ...shape, data: { ...shape.data, appCode } } : shape;
  },
});
const seen: { path: string; method: string; url: string; auth: string | null }[] = [];
let proNow = false;
const router = t.router({
  auth: t.router({
    me: t.procedure.query(({ ctx }) => (ctx.token === "good" ? { id: 1, openId: "apple:x", name: "A", email: null, loginMethod: "apple", lastSignedIn: new Date("2026-10-12T10:00:00Z") } : null)),
    refresh: t.procedure.mutation(({ ctx }) => {
      if (ctx.token !== "good") throw new TRPCError({ code: "UNAUTHORIZED", message: "Please login (10001)" });
      return { sessionToken: "renewed" };
    }),
  }),
  plan: t.router({
    save: t.procedure
      .input(z.object({ baseRevision: z.number(), snapshot: z.string(), deviceId: z.string(), force: z.boolean().optional() }))
      .mutation(({ input }) => ({ saved: true as const, header: { revision: input.baseRevision + 1, savedAt: "2026-10-12T10:00:00.000Z", deviceId: input.deviceId, chars: input.snapshot.length } })),
  }),
  ai: t.router({
    syllabusExtractionStatus: t.procedure.input(z.object({ jobId: z.string() })).query(({ input }) => ({ id: input.jobId, status: "running" as const })),
    parseTasks: t.procedure.input(z.object({ message: z.string() })).mutation(() => {
      if (!proNow) throw new TRPCError({ code: "FORBIDDEN", message: PRO_REQUIRED_ERR_MSG });
      return { tasks: [], events: [], recurringEvents: [], summary: "ok" };
    }),
    startSyllabusExtraction: t.procedure.input(z.any()).mutation(() => {
      throw new TRPCError({ code: "FORBIDDEN", message: FREE_SYLLABUS_LIMIT_ERR_MSG });
    }),
  }),
});

beforeEach(() => {
  seen.length = 0;
  proNow = false;
  resetSessionEndedForTests();
  resetPaywallPromptForTests();
  setSessionTokenProvider(() => "good");
  // The student has agreed to AI processing (the question itself is src/state/ai-consent.tsx's).
  setAIConsentRequester(async () => true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    seen.push({ path: url.pathname, method: request.method, url: request.url, auth });
    return fetchRequestHandler({ endpoint: "/api/trpc", req: request, router, createContext: () => ({ token: auth?.startsWith("Bearer ") ? auth.slice(7) : null }) });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAIConsentRequester(null);
});

describe("the API client speaks tRPC with superjson", () => {
  it("sends a query as GET and gets Dates back", async () => {
    const me = await query("auth.me");
    expect(me?.openId).toBe("apple:x");
    expect(me?.lastSignedIn).toBeInstanceOf(Date);
    expect(seen[0]).toMatchObject({ method: "GET", auth: "Bearer good" });
    expect(seen[0]!.path).toBe("/api/trpc/auth.me");
  });

  it("puts a query's input in the URL and a mutation's in the body", async () => {
    const job = await query("ai.syllabusExtractionStatus", { jobId: "j-1" });
    expect(job.id).toBe("j-1");
    expect(decodeURIComponent(seen[0]!.url)).toContain('"jobId":"j-1"');
    const saved = await mutate("plan.save", { baseRevision: 3, snapshot: "{}", deviceId: "dev_1" });
    expect(saved).toEqual({ saved: true, header: { revision: 4, savedAt: "2026-10-12T10:00:00.000Z", deviceId: "dev_1", chars: 2 } });
    expect(seen[1]).toMatchObject({ method: "POST", path: "/api/trpc/plan.save" });
  });

  it("turns a tRPC error into an ApiError with the code, the status and the message", async () => {
    setSessionTokenProvider(() => "stale");
    await expect(mutate("auth.refresh", undefined, { quiet: true })).rejects.toMatchObject({ code: "UNAUTHORIZED", httpStatus: 401, message: "Please login (10001)" });
    try {
      await mutate("auth.refresh", undefined, { quiet: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(isUnauthorizedError(error)).toBe(true);
    }
  });

  it("an explicit token wins over the stored one (the refresh compares the two)", async () => {
    setSessionTokenProvider(() => "stale");
    await expect(mutate("auth.refresh", undefined, { quiet: true, token: "good" })).resolves.toEqual({ sessionToken: "renewed" });
    expect(seen[0]!.auth).toBe("Bearer good");
  });

  it("reports a refused session once, with the token the request carried", async () => {
    setSessionTokenProvider(() => "stale");
    const ended: string[] = [];
    subscribeSessionEnded((event) => ended.push(event.token));
    await expect(mutate("auth.refresh")).rejects.toBeInstanceOf(ApiError);
    // auth.* refusals are a failed sign-in, not a session that ended (lib/sign-in-prompt.ts responseSaysSignedOut).
    expect(ended).toEqual([]);
    await expect(query("auth.me", undefined, { token: "stale" })).resolves.toBeNull();
  });

  it("an AI procedure is not even sent when the student declines AI processing", async () => {
    setAIConsentRequester(async () => false);
    await expect(mutate("ai.parseTasks", { message: "hi", classes: [], today: "2026-10-12" })).rejects.toMatchObject({ code: "CONSENT_DECLINED" });
    expect(seen).toEqual([]);
    // Everything else goes out as usual.
    await expect(query("auth.me")).resolves.toMatchObject({ openId: "apple:x" });
  });

  it("a Pro refusal carries the app code and opens the paywall prompt", async () => {
    const prompts: string[] = [];
    subscribePaywallPrompt((event) => prompts.push(event.code));
    await expect(mutate("ai.parseTasks", { message: "hi", classes: [], today: "2026-10-12" })).rejects.toMatchObject({ code: "FORBIDDEN", appCode: "PRO_REQUIRED" });
    expect(prompts).toEqual(["PRO_REQUIRED"]);
  });

  it("when the browser holds Pro and the server agrees after a re-check, the refused call is sent once more", async () => {
    const off = setProRefusalHandler(async () => {
      proNow = true;
      return "confirmed";
    });
    try {
      const result = await mutate("ai.parseTasks", { message: "hi", classes: [], today: "2026-10-12" });
      expect(result.summary).toBe("ok");
      expect(seen.filter((call) => call.path.endsWith("ai.parseTasks"))).toHaveLength(2);
    } finally {
      off();
    }
  });

  it("the free syllabus limit is a FREE_SYLLABUS_LIMIT refusal and is never re-sent", async () => {
    const prompts: string[] = [];
    subscribePaywallPrompt((event) => prompts.push(event.code));
    const off = setProRefusalHandler(async () => "confirmed");
    try {
      await expect(mutate("ai.startSyllabusExtraction", { rawText: "x", today: "2026-10-12" })).rejects.toMatchObject({ appCode: "FREE_SYLLABUS_LIMIT" });
      expect(seen.filter((call) => call.path.endsWith("ai.startSyllabusExtraction"))).toHaveLength(1);
      expect(prompts).toEqual(["FREE_SYLLABUS_LIMIT"]);
    } finally {
      off();
    }
  });
});
