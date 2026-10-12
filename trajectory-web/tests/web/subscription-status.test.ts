import { describe, expect, it } from "vitest";
import {
  NOT_PRO_STATUS,
  formatPassDate,
  packageInfo,
  paywallOwnershipNote,
  proStatusFromCustomerInfo,
  proStatusRowModel,
  renewalPeriodFor,
  resolveOfferings,
  sameProStatus,
  type ProStatus,
} from "../../src/lib/subscription-plans";

const PASS = "trajectory_school_year";
const NOW = new Date("2026-10-01T12:00:00Z");

/** A CustomerInfo as react-native-purchases 9 hands it over. */
function customerInfo(over: Record<string, unknown> = {}) {
  return {
    entitlements: { all: {}, active: {}, verification: "NOT_REQUESTED" },
    activeSubscriptions: [],
    allPurchasedProductIdentifiers: [],
    latestExpirationDate: null,
    allExpirationDates: {},
    allPurchaseDates: {},
    nonSubscriptionTransactions: [],
    subscriptionsByProductIdentifier: {},
    ...over,
  };
}
const proEntitlement = (productIdentifier: string, expirationDate: string | null, extra: Record<string, unknown> = {}) => ({
  "Trajectory Pro": {
    identifier: "Trajectory Pro",
    isActive: true,
    willRenew: expirationDate !== null,
    productIdentifier,
    expirationDate,
    latestPurchaseDate: "2026-09-26T12:00:00.000Z",
    ...extra,
  },
});
const transaction = (productIdentifier: string, purchaseDate: string, transactionIdentifier = `t-${purchaseDate}`) => ({ productIdentifier, purchaseDate, transactionIdentifier });

describe("proStatusFromCustomerInfo (Pro on this iPhone)", () => {
  it("no CustomerInfo, or nothing bought: not Pro", () => {
    expect(proStatusFromCustomerInfo(null, NOW)).toEqual(NOT_PRO_STATUS);
    expect(proStatusFromCustomerInfo(customerInfo(), NOW)).toEqual(NOT_PRO_STATUS);
  });

  it("monthly: an auto-renewing subscription, until its period ends", () => {
    const info = customerInfo({ entitlements: { all: {}, active: proEntitlement("trajectory_pro_monthly", "2026-10-26T12:00:00.000Z") } });
    expect(proStatusFromCustomerInfo(info, NOW)).toEqual({
      isPro: true,
      source: "subscription",
      until: "2026-10-26T12:00:00.000Z",
      willRenew: true,
      productId: "trajectory_pro_monthly",
      termPass: null,
    });
  });

  it("the Degree Pass: lifetime", () => {
    const info = customerInfo({
      entitlements: { all: {}, active: proEntitlement("trajectory_lifetime_college", null) },
      nonSubscriptionTransactions: [transaction("trajectory_lifetime_college", "2026-01-10T00:00:00.000Z")],
    });
    expect(proStatusFromCustomerInfo(info, NOW)).toMatchObject({ isPro: true, source: "lifetime", until: null, willRenew: null, productId: "trajectory_lifetime_college" });
  });

  it("a School Year pass left out of the entitlement: Pro for 12 months from the purchase", () => {
    const info = customerInfo({ nonSubscriptionTransactions: [transaction(PASS, "2026-08-20T15:00:00.000Z")] });
    expect(proStatusFromCustomerInfo(info, NOW)).toEqual({
      isPro: true,
      source: "term",
      until: "2027-08-20T15:00:00.000Z",
      willRenew: false,
      productId: PASS,
      termPass: { active: true, until: "2027-08-20T15:00:00.000Z", productId: PASS },
    });
  });

  it("a pass attached to the entitlement (no expiry = 'lifetime') bought 13 months ago is not Pro, and says when it ended", () => {
    const info = customerInfo({
      entitlements: { all: {}, active: proEntitlement(PASS, null, { latestPurchaseDate: "2025-09-01T00:00:00.000Z" }) },
      nonSubscriptionTransactions: [transaction(PASS, "2025-09-01T00:00:00.000Z")],
    });
    expect(proStatusFromCustomerInfo(info, NOW)).toEqual({
      ...NOT_PRO_STATUS,
      termPass: { active: false, until: "2026-09-01T00:00:00.000Z", productId: PASS },
    });
  });

  it("an attached pass that hides a running monthly subscription keeps Pro (and reads the subscription's own dates)", () => {
    const info = customerInfo({
      entitlements: { all: {}, active: proEntitlement(PASS, null, { latestPurchaseDate: "2025-09-01T00:00:00.000Z" }) },
      nonSubscriptionTransactions: [transaction(PASS, "2025-09-01T00:00:00.000Z")],
      activeSubscriptions: ["trajectory_pro_monthly"],
      subscriptionsByProductIdentifier: {
        trajectory_pro_monthly: { productIdentifier: "trajectory_pro_monthly", expiresDate: "2026-10-20T00:00:00.000Z", willRenew: true, isActive: true, refundedAt: null, gracePeriodExpiresDate: null },
      },
    });
    expect(proStatusFromCustomerInfo(info, NOW)).toMatchObject({ isPro: true, source: "subscription", until: "2026-10-20T00:00:00.000Z", willRenew: true, productId: "trajectory_pro_monthly" });
    // An older SDK without subscriptionsByProductIdentifier: the active subscription list is enough.
    const older = { ...info, subscriptionsByProductIdentifier: undefined, allExpirationDates: { trajectory_pro_monthly: "2026-10-20T00:00:00.000Z" } };
    expect(proStatusFromCustomerInfo(older, NOW)).toMatchObject({ isPro: true, source: "subscription", until: "2026-10-20T00:00:00.000Z" });
    // Refunded: no.
    const refunded = {
      ...info,
      subscriptionsByProductIdentifier: { trajectory_pro_monthly: { productIdentifier: "trajectory_pro_monthly", expiresDate: "2026-10-20T00:00:00.000Z", refundedAt: "2026-09-25T00:00:00.000Z" } },
    };
    expect(proStatusFromCustomerInfo(refunded, NOW).isPro).toBe(false);
  });

  it("a monthly subscription that will renew is what keeps Pro on, even with a pass running", () => {
    const info = customerInfo({
      entitlements: { all: {}, active: proEntitlement("trajectory_pro_monthly", "2026-10-26T12:00:00.000Z") },
      nonSubscriptionTransactions: [transaction(PASS, "2026-08-20T15:00:00.000Z")],
    });
    expect(proStatusFromCustomerInfo(info, NOW)).toMatchObject({ source: "subscription", termPass: { active: true, until: "2027-08-20T15:00:00.000Z", productId: PASS } });
    const cancelled = customerInfo({
      entitlements: { all: {}, active: proEntitlement("trajectory_pro_monthly", "2026-10-26T12:00:00.000Z", { willRenew: false }) },
      nonSubscriptionTransactions: [transaction(PASS, "2026-08-20T15:00:00.000Z")],
    });
    expect(proStatusFromCustomerInfo(cancelled, NOW)).toMatchObject({ source: "term", until: "2027-08-20T15:00:00.000Z" });
  });

  it("compares by value, so an identical update does not re-render", () => {
    const info = customerInfo({ nonSubscriptionTransactions: [transaction(PASS, "2026-08-20T15:00:00.000Z")] });
    expect(sameProStatus(proStatusFromCustomerInfo(info, NOW), proStatusFromCustomerInfo(info, NOW))).toBe(true);
    expect(sameProStatus(proStatusFromCustomerInfo(info, NOW), NOT_PRO_STATUS)).toBe(false);
  });
});

// Dates below are built in the phone's own time zone, as the app shows them.
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0);
const termStatus = (until: Date): ProStatus => ({
  isPro: true,
  source: "term",
  until: until.toISOString(),
  willRenew: false,
  productId: PASS,
  termPass: { active: true, until: until.toISOString(), productId: PASS },
});

describe("formatPassDate", () => {
  it("writes short dates in the phone's time zone", () => {
    expect(formatPassDate(local(2026, 8, 20))).toBe("Aug 20");
    expect(formatPassDate(local(2026, 8, 20), { weekday: true })).toBe("Thu, Aug 20");
    expect(formatPassDate(local(2027, 8, 20), { year: true })).toBe("Aug 20, 2027");
  });
});

describe("Settings row (proStatusRowModel)", () => {
  it("not Pro: the upgrade row", () => {
    expect(proStatusRowModel(NOT_PRO_STATUS, NOW)).toMatchObject({ kind: "upgrade", label: "Upgrade to Pro", offerAnotherTerm: false });
  });

  it("subscription: manage it, with how it renews", () => {
    const sub: ProStatus = { isPro: true, source: "subscription", until: local(2026, 10, 26).toISOString(), willRenew: true, productId: "trajectory_pro_monthly", termPass: null };
    expect(proStatusRowModel(sub, NOW, "Renews every month")).toMatchObject({ kind: "subscription", label: "Manage subscription", sublabel: "Trajectory Pro · renews every month" });
    expect(proStatusRowModel(sub, NOW).sublabel).toBe("Trajectory Pro · renews Oct 26, 2026");
    expect(proStatusRowModel({ ...sub, willRenew: false }, NOW, "Renews every month").sublabel).toBe("Trajectory Pro · ends Oct 26, 2026, won't renew");
  });

  it("Degree Pass: Pro for good, nothing to manage", () => {
    const degree: ProStatus = { isPro: true, source: "lifetime", until: null, willRenew: null, productId: "trajectory_lifetime_college", termPass: null };
    expect(proStatusRowModel(degree, NOW)).toMatchObject({ kind: "lifetime", label: "Degree Pass · Pro for good", offerAnotherTerm: false });
  });

  it("School Year pass: Pro until the date; 'Get another year' only in its last 30 days", () => {
    const until = local(2027, 8, 20, 15);
    expect(proStatusRowModel(termStatus(until), local(2027, 3, 1))).toMatchObject({
      kind: "term",
      label: "Pro until Aug 20, 2027",
      sublabel: "School Year pass · one payment, doesn't renew",
      offerAnotherTerm: false,
    });
    expect(proStatusRowModel(termStatus(until), local(2027, 7, 21))).toMatchObject({ offerAnotherTerm: true, anotherTermLabel: "Get another year", sublabel: "School Year pass ends in 30 days. It doesn't renew." });
    expect(proStatusRowModel(termStatus(until), local(2027, 7, 20)).offerAnotherTerm).toBe(false); // 31 days
    expect(proStatusRowModel(termStatus(until), local(2027, 8, 19)).sublabel).toBe("School Year pass ends tomorrow. It doesn't renew.");
    expect(proStatusRowModel(termStatus(until), local(2027, 8, 20, 9)).sublabel).toBe("School Year pass ends today. It doesn't renew.");
  });

  it("finds the store's renewal wording for the subscribed product", () => {
    const offerings = resolveOfferings({
      availablePackages: [
        { product: { productIdentifier: "trajectory_pro_monthly", priceString: "€5.49", subscriptionPeriod: "P1M" } },
        { product: { productIdentifier: PASS, priceString: "€29.99", subscriptionPeriod: null } },
      ],
    });
    expect(renewalPeriodFor("trajectory_pro_monthly", offerings)).toBe("Renews every month");
    expect(renewalPeriodFor(PASS, offerings)).toBeNull(); // a pass has no renewal wording
    expect(renewalPeriodFor("trajectory_pro_school_year", offerings)).toBeNull(); // not in this offering
    expect(renewalPeriodFor(null, offerings)).toBeNull();
    expect(renewalPeriodFor("trajectory_pro_monthly", null)).toBeNull();
  });
});

describe("paywall note for a student who already has Pro", () => {
  const pass = packageInfo({ product: { productIdentifier: PASS, priceString: "€29.99", subscriptionPeriod: null } });
  const monthly = packageInfo({ product: { productIdentifier: "trajectory_pro_monthly", priceString: "€5.49", subscriptionPeriod: "P1M" } });
  const degree = packageInfo({ product: { productIdentifier: "trajectory_lifetime_college", priceString: "€59.99", subscriptionPeriod: null } });
  const subscriber: ProStatus = { isPro: true, source: "subscription", until: local(2026, 10, 26).toISOString(), willRenew: true, productId: "trajectory_pro_monthly", termPass: null };

  it("says nothing to a student without Pro", () => {
    for (const plan of [pass, monthly, degree]) expect(paywallOwnershipNote(NOT_PRO_STATUS, plan)).toBeNull();
  });

  it("a running pass: another pass starts when it ends; a subscription starts at once", () => {
    const status = termStatus(local(2027, 8, 20, 15));
    expect(paywallOwnershipNote(status, pass)).toBe("Your School Year Pro runs until Aug 20, 2027. These 12 months start when it ends.");
    expect(paywallOwnershipNote(status, monthly)).toBe("Your School Year Pro runs until Aug 20, 2027. A subscription starts as soon as you buy it.");
    expect(paywallOwnershipNote(status, degree)).toBeNull();
  });

  it("an App Store subscription is not cancelled by buying a one-time plan", () => {
    expect(paywallOwnershipNote(subscriber, pass)).toMatch(/^You already have Trajectory Pro as an App Store subscription\. Buying this does not cancel it/);
    expect(paywallOwnershipNote(subscriber, degree)).toMatch(/does not cancel it/);
    expect(paywallOwnershipNote(subscriber, monthly)).toBeNull(); // a change of plan within the subscription group
    // Already switched off: the pass starts today, while the plan still runs (F8; tests/subscription-offerings.test.ts).
    expect(paywallOwnershipNote({ ...subscriber, willRenew: false }, pass)).toBe("These 12 months start today; your current plan runs until Oct 26, 2026.");
  });

  it("lifetime Pro: nothing more to buy", () => {
    const lifetime: ProStatus = { isPro: true, source: "lifetime", until: null, willRenew: null, productId: "trajectory_lifetime_college", termPass: null };
    expect(paywallOwnershipNote(lifetime, pass)).toBe("You already have Trajectory Pro for good. There is nothing more to buy.");
  });
});
