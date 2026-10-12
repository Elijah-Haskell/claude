import { describe, expect, it } from "vitest";
import {
  addCalendarMonthsUTC,
  isTermPassProduct,
  LIFETIME_PRO_PRODUCTS,
  resolveProAccess,
  TERM_PASS_PRODUCTS,
  termPassProduct,
  termPassStatus,
  type ProAccessInput,
} from "../../src/shared/term-pass";
import { PRODUCT_IDS } from "../../src/lib/subscription-plans";

const PASS = "trajectory_school_year";
const iso = (value: string) => new Date(value).toISOString();
const buy = (purchaseDate: string, productId = PASS, id?: string) => ({ productId, purchaseDate, ...(id ? { id } : {}) });

describe("term pass products", () => {
  it("knows the School Year pass (12 months) and nothing else, by exact id", () => {
    expect(TERM_PASS_PRODUCTS[PASS]).toEqual({ months: 12, label: "School Year" });
    expect(isTermPassProduct(PASS)).toBe(true);
    expect(isTermPassProduct(`${PASS}:base-plan`)).toBe(true); // Android-style id
    for (const other of ["trajectory_pro_school_year", "trajectory_pro_monthly", "trajectory_lifetime_college", "trajectory_school_year_v2", "", null, undefined, 42]) {
      expect(isTermPassProduct(other), String(other)).toBe(false);
    }
  });

  it("never mistakes an Object.prototype name for a product", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(termPassProduct(name), name).toBeNull();
      expect(termPassStatus([buy("2026-09-01T00:00:00Z", name)], new Date("2026-10-01T00:00:00Z")).active).toBe(false);
    }
  });

  it("matches the paywall's product table", () => {
    for (const id of Object.keys(TERM_PASS_PRODUCTS)) expect(PRODUCT_IDS.schoolYear).toContain(id);
    expect([...LIFETIME_PRO_PRODUCTS]).toEqual([...PRODUCT_IDS.degreePass]);
  });
});

describe("addCalendarMonthsUTC", () => {
  it("adds whole calendar months and keeps the time of day", () => {
    expect(addCalendarMonthsUTC(Date.parse("2026-08-20T15:30:12.345Z"), 12).toISOString()).toBe("2027-08-20T15:30:12.345Z");
    expect(addCalendarMonthsUTC(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(addCalendarMonthsUTC(new Date("2026-05-10T08:00:00Z"), 25).toISOString()).toBe("2028-06-10T08:00:00.000Z");
  });

  it("clamps a day the target month does not have to its last day", () => {
    expect(addCalendarMonthsUTC(new Date("2026-01-31T12:00:00Z"), 1).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(addCalendarMonthsUTC(new Date("2028-01-31T12:00:00Z"), 1).toISOString()).toBe("2028-02-29T12:00:00.000Z"); // leap year
    expect(addCalendarMonthsUTC(new Date("2026-08-31T12:00:00Z"), 1).toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(addCalendarMonthsUTC(new Date("2028-02-29T09:00:00Z"), 12).toISOString()).toBe("2029-02-28T09:00:00.000Z");
    expect(addCalendarMonthsUTC(new Date("2026-03-31T00:00:00Z"), -1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("works in UTC, whatever the date is in a local time zone", () => {
    // 11:30 PM on Aug 31 in New York is already Sep 1 in UTC: the term follows the UTC calendar.
    expect(addCalendarMonthsUTC(new Date("2026-09-01T03:30:00Z"), 12).toISOString()).toBe("2027-09-01T03:30:00.000Z");
  });
});

describe("termPassStatus", () => {
  const NOW = new Date("2026-10-01T12:00:00Z");

  it("no purchases: no pass", () => {
    expect(termPassStatus([], NOW)).toEqual({ active: false, expiresAt: null, productId: null });
  });

  it("one purchase lasts 12 calendar months from its purchase moment", () => {
    const status = termPassStatus([buy("2026-08-20T15:00:00Z")], NOW);
    expect(status).toEqual({ active: true, expiresAt: new Date("2027-08-20T15:00:00Z"), productId: PASS });
  });

  it("ends exactly at its expiry", () => {
    const purchases = [buy("2025-10-01T12:00:00Z")];
    expect(termPassStatus(purchases, new Date("2026-10-01T11:59:59.999Z")).active).toBe(true);
    expect(termPassStatus(purchases, new Date("2026-10-01T12:00:00Z")).active).toBe(false);
    expect(termPassStatus(purchases, new Date("2026-10-01T12:00:00Z")).expiresAt?.toISOString()).toBe(iso("2026-10-01T12:00:00Z"));
  });

  it("a renewal bought early stacks onto the end of the running pass (no days lost)", () => {
    const status = termPassStatus([buy("2026-08-20T15:00:00Z"), buy("2027-07-01T09:00:00Z")], NOW);
    expect(status.expiresAt?.toISOString()).toBe(iso("2028-08-20T15:00:00Z"));
    expect(status.active).toBe(true);
    // Three in a row: three years from the first.
    const three = termPassStatus([buy("2026-08-20T15:00:00Z"), buy("2026-09-01T00:00:00Z"), buy("2026-09-02T00:00:00Z")], NOW);
    expect(three.expiresAt?.toISOString()).toBe(iso("2029-08-20T15:00:00Z"));
  });

  it("a pass bought after the last one lapsed starts on its own purchase date", () => {
    const status = termPassStatus([buy("2024-08-01T00:00:00Z"), buy("2025-09-15T10:00:00Z")], NOW);
    expect(status.expiresAt?.toISOString()).toBe(iso("2026-09-15T10:00:00Z"));
    expect(status.active).toBe(false); // ended two weeks before NOW
    const renewed = termPassStatus([buy("2024-08-01T00:00:00Z"), buy("2026-09-20T10:00:00Z")], NOW);
    expect(renewed).toEqual({ active: true, expiresAt: new Date("2027-09-20T10:00:00Z"), productId: PASS });
  });

  it("does not depend on the order RevenueCat lists purchases in", () => {
    const a = [buy("2027-07-01T09:00:00Z"), buy("2024-01-01T00:00:00Z"), buy("2026-08-20T15:00:00Z")];
    const b = [...a].reverse();
    expect(termPassStatus(a, NOW)).toEqual(termPassStatus(b, NOW));
    // 2024-01-01 lapsed on 2025-01-01; the next two stack: 2026-08-20 + 24 months.
    expect(termPassStatus(a, NOW).expiresAt?.toISOString()).toBe(iso("2028-08-20T15:00:00Z"));
  });

  it("handles month ends: Feb 29 + 12 months = Feb 28, and a stacked year keeps the clamped day", () => {
    expect(termPassStatus([buy("2028-02-29T09:00:00Z")], new Date("2028-03-01T00:00:00Z")).expiresAt?.toISOString()).toBe(iso("2029-02-28T09:00:00Z"));
    const stacked = termPassStatus([buy("2028-02-29T09:00:00Z"), buy("2028-06-01T00:00:00Z")], new Date("2028-07-01T00:00:00Z"));
    expect(stacked.expiresAt?.toISOString()).toBe(iso("2030-02-28T09:00:00Z"));
    expect(termPassStatus([buy("2026-08-31T23:00:00Z")], NOW).expiresAt?.toISOString()).toBe(iso("2027-08-31T23:00:00Z"));
  });

  it("ignores other products and unreadable dates", () => {
    const status = termPassStatus(
      [
        buy("2026-09-01T00:00:00Z", "trajectory_pro_monthly"),
        buy("2026-09-01T00:00:00Z", "trajectory_lifetime_college"),
        buy("2026-09-01T00:00:00Z", "trajectory_pro_school_year"),
        buy("garbage"),
        buy(""),
        { productId: PASS, purchaseDate: new Date(NaN) },
        { productId: PASS, purchaseDate: 1790000000000 as unknown as string },
      ],
      NOW,
    );
    expect(status).toEqual({ active: false, expiresAt: null, productId: null });
  });

  it("accepts Date objects and Android-style ids", () => {
    const status = termPassStatus([{ productId: `${PASS}:base`, purchaseDate: new Date("2026-09-10T00:00:00Z") }], NOW);
    expect(status).toEqual({ active: true, expiresAt: new Date("2027-09-10T00:00:00Z"), productId: PASS });
  });

  it("counts a purchase reported twice (same transaction id) once, but two real purchases twice", () => {
    const twice = termPassStatus([buy("2026-09-10T00:00:00Z", PASS, "t1"), buy("2026-09-10T00:00:00Z", PASS, "t1")], NOW);
    expect(twice.expiresAt?.toISOString()).toBe(iso("2027-09-10T00:00:00Z"));
    const two = termPassStatus([buy("2026-09-10T00:00:00Z", PASS, "t1"), buy("2026-09-10T00:00:00Z", PASS, "t2")], NOW);
    expect(two.expiresAt?.toISOString()).toBe(iso("2028-09-10T00:00:00Z"));
  });

  it("a purchase dated after now (the phone's clock is behind the store's) still counts from its own date", () => {
    const status = termPassStatus([buy("2026-10-03T12:00:00Z")], NOW);
    expect(status).toEqual({ active: true, expiresAt: new Date("2027-10-03T12:00:00Z"), productId: PASS });
  });
});

describe("resolveProAccess (the rule the app and the server share)", () => {
  const NOW = new Date("2026-10-01T12:00:00Z");
  const base: ProAccessInput = { entitlement: null, oneTimePurchases: [], subscriptions: [] };
  const entitlement = (over: Partial<NonNullable<ProAccessInput["entitlement"]>>): NonNullable<ProAccessInput["entitlement"]> => ({
    productId: "trajectory_pro_monthly",
    active: true,
    lifetime: false,
    expiresAt: new Date("2026-10-26T12:00:00Z"),
    willRenew: true,
    purchaseDate: "2026-09-26T12:00:00Z",
    ...over,
  });
  // The one-time pass attached to the entitlement: RevenueCat reports it with no expiry (lifetime).
  const attachedPass = (purchaseDate: string) =>
    entitlement({ productId: PASS, lifetime: true, expiresAt: null, willRenew: false, purchaseDate });

  it("nothing bought: no Pro", () => {
    expect(resolveProAccess(base, NOW)).toEqual({ isPro: false, source: null, until: null, willRenew: null, productId: null, termPass: null });
  });

  it("monthly and the auto-renewing School Year count exactly as the entitlement says", () => {
    expect(resolveProAccess({ ...base, entitlement: entitlement({}) }, NOW)).toMatchObject({
      isPro: true,
      source: "subscription",
      until: new Date("2026-10-26T12:00:00Z"),
      willRenew: true,
      productId: "trajectory_pro_monthly",
    });
    const yearly = entitlement({ productId: "trajectory_pro_school_year", expiresAt: new Date("2027-09-01T00:00:00Z"), willRenew: false });
    expect(resolveProAccess({ ...base, entitlement: yearly }, NOW)).toMatchObject({ isPro: true, source: "subscription", willRenew: false });
    expect(resolveProAccess({ ...base, entitlement: entitlement({ active: false }) }, NOW).isPro).toBe(false);
  });

  it("the Degree Pass is Pro for good", () => {
    const degree = entitlement({ productId: "trajectory_lifetime_college", lifetime: true, expiresAt: null, willRenew: false });
    expect(resolveProAccess({ ...base, entitlement: degree }, NOW)).toMatchObject({ isPro: true, source: "lifetime", until: null, willRenew: null });
  });

  it("a School Year pass left out of the entitlement counts for its 12 months", () => {
    const access = resolveProAccess({ ...base, oneTimePurchases: [buy("2026-08-20T15:00:00Z")] }, NOW);
    expect(access).toMatchObject({ isPro: true, source: "term", until: new Date("2027-08-20T15:00:00Z"), willRenew: false, productId: PASS });
    expect(access.termPass).toEqual({ active: true, expiresAt: new Date("2027-08-20T15:00:00Z"), productId: PASS });
    const ended = resolveProAccess({ ...base, oneTimePurchases: [buy("2025-08-20T15:00:00Z")] }, NOW);
    expect(ended).toMatchObject({ isPro: false, source: null });
    expect(ended.termPass).toEqual({ active: false, expiresAt: new Date("2026-08-20T15:00:00Z"), productId: PASS }); // for "ended Aug 20"
  });

  it("a pass attached to the entitlement never reads as lifetime: bought 13 months ago is not Pro", () => {
    const access = resolveProAccess({ ...base, entitlement: attachedPass("2025-09-01T00:00:00Z"), oneTimePurchases: [buy("2025-09-01T00:00:00Z")] }, NOW);
    expect(access.isPro).toBe(false);
    expect(access.termPass?.expiresAt?.toISOString()).toBe(iso("2026-09-01T00:00:00Z"));
    const fresh = resolveProAccess({ ...base, entitlement: attachedPass("2026-09-01T00:00:00Z"), oneTimePurchases: [buy("2026-09-01T00:00:00Z")] }, NOW);
    expect(fresh).toMatchObject({ isPro: true, source: "term", until: new Date("2027-09-01T00:00:00Z") });
  });

  it("falls back to the entitlement's purchase date when the pass shows up nowhere else", () => {
    expect(resolveProAccess({ ...base, entitlement: attachedPass("2025-09-01T00:00:00Z") }, NOW).isPro).toBe(false);
    expect(resolveProAccess({ ...base, entitlement: attachedPass("2026-09-01T00:00:00Z") }, NOW)).toMatchObject({ isPro: true, source: "term" });
  });

  it("an attached pass that hides a running subscription or the Degree Pass does not take Pro away", () => {
    const pass = attachedPass("2025-09-01T00:00:00Z"); // ended a month ago
    const monthly = { productId: "trajectory_pro_monthly", active: true, expiresAt: new Date("2026-10-20T00:00:00Z"), willRenew: true };
    expect(resolveProAccess({ ...base, entitlement: pass, oneTimePurchases: [buy("2025-09-01T00:00:00Z")], subscriptions: [monthly] }, NOW)).toMatchObject({
      isPro: true,
      source: "subscription",
      productId: "trajectory_pro_monthly",
      until: new Date("2026-10-20T00:00:00Z"),
    });
    const degree = buy("2024-01-01T00:00:00Z", "trajectory_lifetime_college");
    expect(resolveProAccess({ ...base, entitlement: pass, oneTimePurchases: [buy("2025-09-01T00:00:00Z"), degree] }, NOW)).toMatchObject({
      isPro: true,
      source: "lifetime",
      productId: "trajectory_lifetime_college",
    });
    // A lapsed subscription does not count.
    const lapsed = { ...monthly, active: false, expiresAt: new Date("2026-09-20T00:00:00Z") };
    expect(resolveProAccess({ ...base, entitlement: pass, subscriptions: [lapsed] }, NOW).isPro).toBe(false);
  });

  it("trusts a term id that RevenueCat lists as a subscription (created as auto-renewing): it has a real expiry", () => {
    const ent = entitlement({ productId: PASS, expiresAt: new Date("2027-09-01T00:00:00Z"), willRenew: true });
    const sub = { productId: PASS, active: true, expiresAt: new Date("2027-09-01T00:00:00Z"), willRenew: true };
    expect(resolveProAccess({ ...base, entitlement: ent, subscriptions: [sub] }, NOW)).toMatchObject({ isPro: true, source: "subscription", productId: PASS });
  });

  it("never trusts 'no expiry' for a pass, wherever RevenueCat lists it", () => {
    const listed = { productId: PASS, active: false, expiresAt: null, willRenew: null };
    expect(resolveProAccess({ ...base, entitlement: attachedPass("2025-09-01T00:00:00Z"), subscriptions: [listed] }, NOW).isPro).toBe(false);
    expect(resolveProAccess({ ...base, entitlement: attachedPass("2026-09-01T00:00:00Z"), subscriptions: [listed] }, NOW)).toMatchObject({ isPro: true, source: "term" });
  });

  it("with several, says what keeps Pro on: lifetime, then a renewing subscription, then whatever lasts longest", () => {
    const pass = [buy("2026-08-20T15:00:00Z")]; // until 2027-08-20
    expect(resolveProAccess({ ...base, entitlement: entitlement({}), oneTimePurchases: pass }, NOW).source).toBe("subscription");
    // Monthly switched off and ending before the pass: the pass is what keeps Pro on.
    const cancelled = entitlement({ willRenew: false });
    expect(resolveProAccess({ ...base, entitlement: cancelled, oneTimePurchases: pass }, NOW)).toMatchObject({ source: "term", until: new Date("2027-08-20T15:00:00Z") });
    const degree = entitlement({ productId: "trajectory_lifetime_college", lifetime: true, expiresAt: null });
    expect(resolveProAccess({ ...base, entitlement: degree, oneTimePurchases: pass }, NOW).source).toBe("lifetime");
  });
});
