import { afterEach, describe, expect, it, vi } from "vitest";
import { describeIntroOffer, FREE_SYLLABUS_LIMIT, packageInfo } from "../../src/lib/subscription-plans";
import {
  noteForbiddenResponse,
  paywallPromptCopy,
  resetPaywallPromptForTests,
  resetSessionEndedForTests,
  responseAppErrorCode,
  responseProGate,
  subscribePaywallPrompt,
  subscribeSessionEnded,
} from "../../src/lib/sign-in-prompt";
import { FREE_SYLLABUS_IMPORTS, FREE_SYLLABUS_LIMIT_ERR_MSG, PRO_REQUIRED_ERR_MSG, SIGN_IN_REQUIRED_ERR_MSG } from "../../src/shared/pro";

describe("introductory offers come only from the store product", () => {
  it("words a free trial and a paid intro, and says nothing without an intro price", () => {
    expect(describeIntroOffer({ price: 0, priceString: "Free", period: "P1W", cycles: 1 })).toEqual({ text: "1-week free trial", free: true });
    expect(describeIntroOffer({ price: 0, periodUnit: "DAY", periodNumberOfUnits: 7, cycles: 1 })).toEqual({ text: "7-day free trial", free: true });
    expect(describeIntroOffer({ price: 0.99, priceString: "€0.99", period: "P1M", cycles: 1 })).toEqual({ text: "€0.99 for the first month", free: false });
    expect(describeIntroOffer({ price: 1.99, priceString: "€1.99", period: "P1M", cycles: 3 })).toEqual({ text: "€1.99/month for 3 months", free: false });
    expect(describeIntroOffer(null)).toBeNull();
    expect(describeIntroOffer({ price: 0 })).toBeNull(); // unreadable period: say nothing rather than guess
  });

  it("puts the offer on the package only for subscriptions that have one", () => {
    const sub = (introPrice: unknown) => ({ product: { productIdentifier: "trajectory_pro_school_year", priceString: "€29.99", subscriptionPeriod: "P1Y", introPrice } });
    expect(packageInfo(sub({ price: 0, period: "P1W", cycles: 1 }))).toMatchObject({ introOffer: "1-week free trial", hasFreeTrial: true, renews: true });
    expect(packageInfo(sub(null))).toMatchObject({ introOffer: null, hasFreeTrial: false });
    const lifetime = { product: { productIdentifier: "trajectory_lifetime_college", priceString: "€59.99", introPrice: { price: 0, period: "P1W" } } };
    expect(packageInfo(lifetime)).toMatchObject({ renews: false, introOffer: null, hasFreeTrial: false });
    expect(packageInfo(null)).toMatchObject({ introOffer: null, hasFreeTrial: false });
  });

  it("keeps the free syllabus limit in one place", () => {
    expect(FREE_SYLLABUS_LIMIT).toBe(FREE_SYLLABUS_IMPORTS);
  });
});

describe("server refusals become the paywall, or end a session that is not an account's", () => {
  afterEach(() => {
    resetPaywallPromptForTests();
    resetSessionEndedForTests();
  });

  const envelope = (message: string, appCode?: string) => ({ error: { json: { message, code: -32003, data: { code: "FORBIDDEN", httpStatus: 403, ...(appCode ? { appCode } : {}) } } } });

  it("reads the code from single and batched (superjson) responses", () => {
    expect(responseAppErrorCode({ status: 403, body: envelope(PRO_REQUIRED_ERR_MSG, "PRO_REQUIRED") })).toBe("PRO_REQUIRED");
    expect(responseAppErrorCode({ status: 207, body: [{ result: { data: {} } }, envelope(FREE_SYLLABUS_LIMIT_ERR_MSG)] })).toBe("FREE_SYLLABUS_LIMIT");
    expect(responseAppErrorCode({ status: 403, body: envelope(SIGN_IN_REQUIRED_ERR_MSG, "SIGN_IN_REQUIRED") })).toBe("SIGN_IN_REQUIRED");
    expect(responseProGate({ status: 403, body: envelope(SIGN_IN_REQUIRED_ERR_MSG, "SIGN_IN_REQUIRED") })).toBeNull();
    expect(responseAppErrorCode({ status: 403, body: envelope("Something else") })).toBeNull();
    expect(responseAppErrorCode({ status: 500, body: envelope(PRO_REQUIRED_ERR_MSG, "PRO_REQUIRED") })).toBeNull();
  });

  it("emits a paywall prompt for a Pro refusal, leaving the response readable", async () => {
    const paywall = vi.fn();
    const sessionEnded = vi.fn();
    subscribePaywallPrompt(paywall);
    subscribeSessionEnded(sessionEnded);

    const pro = new Response(JSON.stringify([envelope(PRO_REQUIRED_ERR_MSG, "PRO_REQUIRED")]), { status: 403 });
    await noteForbiddenResponse(pro, undefined, "tok");
    expect(paywall).toHaveBeenCalledWith({ code: "PRO_REQUIRED" });
    expect(sessionEnded).not.toHaveBeenCalled(); // needing Pro is not being signed out
    expect(await pro.json()).toHaveLength(1); // body not consumed

    await noteForbiddenResponse(new Response("not json", { status: 403 }), undefined, "tok");
    expect(paywall).toHaveBeenCalledTimes(1);
  });

  it("a refusal that asks for an account ends the session the request carried (a guest session from an older build)", async () => {
    const paywall = vi.fn();
    const sessionEnded = vi.fn();
    subscribePaywallPrompt(paywall);
    subscribeSessionEnded(sessionEnded);
    const refusal = () => new Response(JSON.stringify([envelope(SIGN_IN_REQUIRED_ERR_MSG, "SIGN_IN_REQUIRED")]), { status: 403 });

    const guest = refusal();
    expect(await noteForbiddenResponse(guest, undefined, "guest-token")).toBe(guest);
    expect(sessionEnded).toHaveBeenCalledWith({ token: "guest-token" });
    expect(paywall).not.toHaveBeenCalled(); // never the paywall
    expect(await guest.json()).toHaveLength(1);

    // A request that carried no session token (the browser preview) ends nothing.
    await noteForbiddenResponse(refusal());
    await noteForbiddenResponse(refusal(), undefined, null);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
    expect(SIGN_IN_REQUIRED_ERR_MSG).toBe("Sign in with Apple to use this feature.");
  });

  it("has clear alert copy for both paywall reasons", () => {
    expect(paywallPromptCopy("FREE_SYLLABUS_LIMIT").message).toBe(FREE_SYLLABUS_LIMIT_ERR_MSG);
    expect(paywallPromptCopy("PRO_REQUIRED").message).toBe(PRO_REQUIRED_ERR_MSG);
  });
});
