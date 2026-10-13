import { describe, expect, it } from "vitest";

import { requiresAIConsent } from "../../src/lib/ai-consent-utils";
import { AI_CONSENT_DECLINED_MESSAGE, describeStudyError } from "../../src/lib/study-errors";

// The shape src/lib/api.ts ApiError has (and a tRPC client error on the iPhone): the code under `data`.
const apiError = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe("describeStudyError", () => {
  it("shows the server's friendly quota message for TOO_MANY_REQUESTS", () => {
    const info = describeStudyError(apiError("TOO_MANY_REQUESTS", "You've used today's AI allowance. It resets in about 5 hours (midnight UTC). Your saved plan and the rest of the app keep working."));
    expect(info.kind).toBe("quota");
    expect(info.message).toMatch(/resets in about 5 hours/);
    expect(info.retryable).toBe(true);
  });

  it("burst limit message passes through too", () => {
    expect(describeStudyError(apiError("TOO_MANY_REQUESTS", "You're sending AI requests faster than we can keep up. Please wait 12 seconds and try again.")).message).toMatch(/wait 12 seconds/);
  });

  it("the consent-declined error is explained, not shown raw", () => {
    const info = describeStudyError(new Error(AI_CONSENT_DECLINED_MESSAGE));
    expect(info.kind).toBe("consent");
    expect(info.message).not.toContain("authorized by the user");
    expect(info.message).toMatch(/Allow/);
  });

  it("the API client really throws the message this module recognises", () => {
    // src/lib/api.ts throws this exact text (code CONSENT_DECLINED); guard against the two drifting apart.
    expect(requiresAIConsent("http://x/api/trpc/ai.reviewTest?batch=1")).toBe(true);
    const info = describeStudyError(Object.assign(new Error("AI processing was not authorized by the user."), { data: { code: "CONSENT_DECLINED" } }));
    expect(info.kind).toBe("consent");
  });

  it("size / type / auth / busy / network cases", () => {
    expect(describeStudyError(apiError("PAYLOAD_TOO_LARGE", "Choose a file smaller than 10 MB.")).kind).toBe("too_large");
    expect(describeStudyError(apiError("PAYLOAD_TOO_LARGE", "Choose a file smaller than 10 MB.")).retryable).toBe(false);
    expect(describeStudyError(apiError("UNSUPPORTED_MEDIA_TYPE", "That file type isn't supported. Use PDF, JPG, PNG, WEBP.")).message).toMatch(/isn't supported/);
    expect(describeStudyError(apiError("UNAUTHORIZED", "Please login (10001)")).kind).toBe("auth");
    expect(describeStudyError(apiError("GATEWAY_TIMEOUT", "The AI took too long to respond. Please try again.")).kind).toBe("busy");
    expect(describeStudyError(new TypeError("Network request failed")).kind).toBe("offline");
    expect(describeStudyError(new Error("Failed to fetch")).kind).toBe("offline");
  });

  it("the web API client's NetworkError is 'offline' whatever its sentence says", () => {
    const network = Object.assign(new Error("Could not reach Trajectory. Check your connection and try again."), { name: "NetworkError" });
    expect(describeStudyError(network)).toMatchObject({ kind: "offline", retryable: true });
  });

  it("the account copy says 'this browser' here, not 'this iPhone'", () => {
    const info = describeStudyError(apiError("UNAUTHORIZED", "Please login (10001)"));
    expect(info.message).not.toContain("iPhone");
    expect(info.message).toContain("this browser");
  });

  it("a zod BAD_REQUEST dump is not shown to the student", () => {
    const info = describeStudyError(apiError("BAD_REQUEST", JSON.stringify([{ code: "too_big", path: ["imageUrls"], message: "Too big" }])), "review the test");
    expect(info.kind).toBe("invalid");
    expect(info.message).not.toContain("too_big");
  });

  it("unknown / hostile errors fall back to a generic sentence naming the action", () => {
    expect(describeStudyError(null, "review the test").message).toBe("We couldn't review the test. Please try again.");
    expect(describeStudyError(new Error("TypeError: Cannot read properties of undefined (reading 'x') at Object.foo (bar.js:1)"), "review the test").message).toBe("We couldn't review the test. Please try again.");
    expect(describeStudyError("boom").kind).toBe("unknown");
    expect(describeStudyError(undefined).retryable).toBe(true);
  });

  it("friendly server sentences for our own failures are kept", () => {
    expect(describeStudyError(apiError("INTERNAL_SERVER_ERROR", "We couldn't read that test. Try again with clearer, well-lit photos of each page.")).message).toMatch(/well-lit/);
  });
});
