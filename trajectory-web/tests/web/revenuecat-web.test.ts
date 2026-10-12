// The adapters between RevenueCat's Web Billing SDK and the ported plan rules (lib/subscription-plans.ts).
import { describe, expect, it } from "vitest";

import { proStatusFromWebCustomerInfo, resolveWebOfferings } from "../../src/lib/revenuecat-web";

const price = (amount: number, formattedPrice: string) => ({ amount, amountMicros: amount * 1_000_000, currency: "USD", formattedPrice });
const product = (overrides: Record<string, unknown>) => ({
  identifier: "x",
  displayName: "x",
  title: "x",
  description: null,
  currentPrice: price(4.99, "$4.99"),
  productType: "subscription",
  normalPeriodDuration: "P1M",
  presentedOfferingIdentifier: "default",
  presentedOfferingContext: {},
  defaultPurchaseOption: { id: "base", priceId: "p" },
  defaultSubscriptionOption: null,
  subscriptionOptions: {},
  defaultNonSubscriptionOption: null,
  price: price(4.99, "$4.99"),
  period: { number: 1, unit: "month" },
  freeTrialPhase: null,
  introPricePhase: null,
  ...overrides,
});
const pkg = (identifier: string, packageType: string, p: Record<string, unknown>) => {
  const prod = product(p);
  return { identifier, packageType, rcBillingProduct: prod, webBillingProduct: prod, product: prod, webCheckoutURL: null };
};

describe("resolveWebOfferings", () => {
  it("finds the plans by the App Store product ids first", () => {
    const offering = {
      identifier: "default",
      serverDescription: "",
      metadata: null,
      packagesById: {},
      availablePackages: [
        pkg("$rc_monthly", "$rc_monthly", { identifier: "trajectory_pro_monthly" }),
        pkg("$rc_annual", "$rc_annual", { identifier: "trajectory_school_year", productType: "non_consumable", normalPeriodDuration: null, currentPrice: price(29.99, "$29.99"), period: null }),
        pkg("$rc_lifetime", "$rc_lifetime", { identifier: "trajectory_lifetime_college", productType: "non_consumable", normalPeriodDuration: null, currentPrice: price(79.99, "$79.99"), period: null }),
      ],
      lifetime: null, annual: null, sixMonth: null, threeMonth: null, twoMonth: null, monthly: null, weekly: null, hasPaywall: false,
    };
    const resolved = resolveWebOfferings(offering as never);
    expect(resolved.monthly).toMatchObject({ productIdentifier: "trajectory_pro_monthly", priceString: "$4.99", billing: "Renews every month", kind: "renewing" });
    expect(resolved.schoolYear).toMatchObject({ productIdentifier: "trajectory_school_year", kind: "term", termMonths: 12, billing: "One payment · 12 months of Pro · doesn't renew" });
    expect(resolved.degreePass).toMatchObject({ productIdentifier: "trajectory_lifetime_college", kind: "lifetime", billing: "One-time purchase" });
    expect((resolved.monthly.package as { rc: unknown }).rc).toBeTruthy();
  });

  it("falls back to RevenueCat's package type when the web products carry other ids", () => {
    const offering = {
      availablePackages: [
        pkg("$rc_monthly", "$rc_monthly", { identifier: "web_monthly" }),
        pkg("$rc_annual", "$rc_annual", { identifier: "web_yearly", normalPeriodDuration: "P1Y", currentPrice: price(39.99, "$39.99"), period: { number: 1, unit: "year" } }),
      ],
    };
    const resolved = resolveWebOfferings(offering as never);
    expect(resolved.monthly.productIdentifier).toBe("web_monthly");
    expect(resolved.schoolYear).toMatchObject({ productIdentifier: "web_yearly", kind: "renewing", billing: "Renews every year" });
    expect(resolved.degreePass.package).toBeNull();
  });

  it("words a free trial from the product's trial phase", () => {
    const offering = { availablePackages: [pkg("$rc_monthly", "$rc_monthly", { identifier: "trajectory_pro_monthly", freeTrialPhase: { periodDuration: "P1W", period: { number: 1, unit: "week" }, price: null, cycleCount: 1, pricePerWeek: null, pricePerMonth: null, pricePerYear: null } })] };
    const resolved = resolveWebOfferings(offering as never);
    expect(resolved.monthly).toMatchObject({ hasFreeTrial: true, introOffer: "1-week free trial" });
  });

  it("with no offering nothing is for sale", () => {
    const resolved = resolveWebOfferings(null);
    expect(resolved.monthly.package).toBeNull();
    expect(resolved.schoolYear.priceString).toBeNull();
  });
});

describe("proStatusFromWebCustomerInfo", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const base = { allExpirationDatesByProduct: {}, allPurchaseDatesByProduct: {}, activeSubscriptions: new Set<string>(), managementURL: null, requestDate: now, firstSeenDate: now, originalPurchaseDate: null, originalAppUserId: "u", nonSubscriptionTransactions: [], subscriptionsByProductIdentifier: {} };

  it("reads an active monthly subscription with Date values", () => {
    const expires = new Date("2026-11-12T12:00:00Z");
    const info = {
      ...base,
      entitlements: { all: {}, active: { "Trajectory Pro": { identifier: "Trajectory Pro", isActive: true, willRenew: true, store: "rc_billing", latestPurchaseDate: new Date("2026-10-12T11:00:00Z"), originalPurchaseDate: new Date("2026-10-12T11:00:00Z"), expirationDate: expires, productIdentifier: "trajectory_pro_monthly", productPlanIdentifier: null, unsubscribeDetectedAt: null, billingIssueDetectedAt: null, isSandbox: false, periodType: "normal", ownershipType: null } } },
      subscriptionsByProductIdentifier: { trajectory_pro_monthly: { productIdentifier: "trajectory_pro_monthly", expiresDate: expires, gracePeriodExpiresDate: null, isActive: true, willRenew: true, refundedAt: null } },
    };
    expect(proStatusFromWebCustomerInfo(info as never, now)).toMatchObject({ isPro: true, source: "subscription", until: expires.toISOString(), willRenew: true, productId: "trajectory_pro_monthly" });
  });

  it("times a School Year pass from its purchase date instead of trusting a lifetime entitlement", () => {
    const bought = new Date("2026-08-20T09:00:00Z");
    const info = {
      ...base,
      entitlements: { all: {}, active: { "Trajectory Pro": { identifier: "Trajectory Pro", isActive: true, willRenew: false, store: "rc_billing", latestPurchaseDate: bought, originalPurchaseDate: bought, expirationDate: null, productIdentifier: "trajectory_school_year", productPlanIdentifier: null, unsubscribeDetectedAt: null, billingIssueDetectedAt: null, isSandbox: false, periodType: "normal", ownershipType: null } } },
      nonSubscriptionTransactions: [{ transactionIdentifier: "t1", productIdentifier: "trajectory_school_year", purchaseDate: bought, storeTransactionId: null, store: "rc_billing" }],
    };
    const status = proStatusFromWebCustomerInfo(info as never, now);
    expect(status).toMatchObject({ isPro: true, source: "term", productId: "trajectory_school_year", willRenew: false });
    expect(status.until).toBe("2027-08-20T09:00:00.000Z");
    expect(proStatusFromWebCustomerInfo(info as never, new Date("2027-09-01T00:00:00Z")).isPro).toBe(false);
  });

  it("no entitlement is no Pro", () => {
    expect(proStatusFromWebCustomerInfo({ ...base, entitlements: { all: {}, active: {} } } as never, now).isPro).toBe(false);
    expect(proStatusFromWebCustomerInfo(null, now).isPro).toBe(false);
  });
});
