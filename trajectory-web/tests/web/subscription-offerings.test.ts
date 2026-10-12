import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  PRODUCT_IDS,
  classifyStoreProduct,
  decideProGate,
  decideSyllabusUpload,
  describeSubscriptionPeriod,
  describeTermBilling,
  monthsPerPayment,
  packageInfo,
  paywallOwnershipNote,
  planBadge,
  planForProductId,
  planLegalText,
  planPriceLine,
  resolveOfferings,
  schoolYearSavings,
  shouldRedirectToPaywall,
  type ProStatus,
} from "../../src/lib/subscription-plans";

const pkg = (identifier: string, packageType: string, productIdentifier: string, priceString: string, subscriptionPeriod: string | null) => ({
  identifier,
  packageType,
  product: { productIdentifier, priceString, subscriptionPeriod },
});

/** A RevenueCat offering as the SDK returns it, with decoys that a fuzzy matcher would pick up. */
const OFFERING = {
  identifier: "default",
  // RevenueCat's own shortcuts point at a decoy on purpose: they must NOT be trusted.
  monthly: pkg("$rc_monthly", "MONTHLY", "trajectory_monthly_promo", "$0.99", "P1M"),
  annual: pkg("$rc_annual", "ANNUAL", "trajectory_annual_promo", "$1.99", "P1Y"),
  lifetime: null,
  availablePackages: [
    pkg("$rc_monthly", "MONTHLY", "trajectory_monthly_promo", "$0.99", "P1M"),
    pkg("$rc_annual", "ANNUAL", "trajectory_annual_promo", "$1.99", "P1Y"),
    pkg("pro_monthly", "CUSTOM", "trajectory_pro_monthly", "$5.49", "P1M"),
    pkg("school_year", "CUSTOM", "trajectory_pro_school_year", "$31.99", "P1Y"),
    pkg("degree", "LIFETIME", "trajectory_lifetime_college", "$54.99", null),
  ],
};

describe("resolveOfferings (exact product ids)", () => {
  it("takes each plan's package and price from the exact product identifier, not from RevenueCat shortcuts or names", () => {
    const offerings = resolveOfferings(OFFERING);

    expect(offerings.monthly.productIdentifier).toBe("trajectory_pro_monthly");
    expect(offerings.monthly.priceString).toBe("$5.49");
    expect(offerings.schoolYear.productIdentifier).toBe("trajectory_pro_school_year");
    expect(offerings.schoolYear.priceString).toBe("$31.99");
    expect(offerings.degreePass.productIdentifier).toBe("trajectory_lifetime_college");
    expect(offerings.degreePass.priceString).toBe("$54.99");
  });

  it("accepts the planned one-time School Year id (trajectory_school_year) as well", () => {
    const offerings = resolveOfferings({
      availablePackages: [
        pkg("a", "CUSTOM", "trajectory_school_year", "$29.99", null),
        pkg("b", "CUSTOM", "trajectory_lifetime_college", "$49.99", null),
      ],
    });

    expect(offerings.schoolYear.priceString).toBe("$29.99");
    expect(offerings.degreePass.priceString).toBe("$49.99");
  });

  it("matches Android base-plan style identifiers on the subscription id", () => {
    const offerings = resolveOfferings({
      availablePackages: [pkg("m", "MONTHLY", "trajectory_pro_monthly:monthly-base", "$5.49", "P1M")],
    });

    expect(offerings.monthly.priceString).toBe("$5.49");
  });

  it("never substring-matches: near-miss ids resolve to unavailable, with no invented price", () => {
    const offerings = resolveOfferings({
      availablePackages: [
        pkg("x", "MONTHLY", "trajectory_pro_monthly_v2", "$9.99", "P1M"),
        pkg("y", "ANNUAL", "my_school_year_thing", "$9.99", "P1Y"),
        pkg("z", "LIFETIME", "trajectory_pro_lifetime_x", "$9.99", null),
      ],
    });

    for (const plan of [offerings.monthly, offerings.schoolYear, offerings.degreePass]) {
      expect(plan.package).toBeNull();
      expect(plan.priceString).toBeNull();
      expect(planPriceLine(plan)).toBeNull();
    }
  });

  it("derives the billing term from the store product", () => {
    const offerings = resolveOfferings(OFFERING);

    expect(offerings.monthly).toMatchObject({ billing: "Renews every month", renews: true, kind: "renewing" });
    expect(offerings.schoolYear).toMatchObject({ billing: "Renews every year", renews: true, kind: "renewing" });
    expect(offerings.degreePass).toMatchObject({ billing: "One-time purchase", renews: false, kind: "lifetime" });
    expect(planPriceLine(offerings.monthly)).toBe("$5.49 · Renews every month");
    expect(planPriceLine(offerings.schoolYear)).toBe("$31.99 · Renews every year");
    expect(planPriceLine(offerings.degreePass)).toBe("$54.99 · One-time purchase");
  });

  it("has no price or term when no offering has loaded", () => {
    for (const offerings of [resolveOfferings(null), resolveOfferings({}), resolveOfferings({ availablePackages: "nope" })]) {
      expect(offerings.monthly).toMatchObject({ package: null, priceString: null, billing: null, renews: null, kind: null });
    }
  });

  it("every product id is unique to one plan", () => {
    const all = Object.values(PRODUCT_IDS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(planForProductId("trajectory_pro_monthly")).toBe("monthly");
    expect(planForProductId("trajectory_pro_school_year")).toBe("schoolYear");
    expect(planForProductId("trajectory_lifetime_college")).toBe("degreePass");
    expect(planForProductId("trajectory_pro_yearly")).toBeNull(); // "Yearly Pro" exists in the store group but is not sold
    expect(planForProductId("nope")).toBeNull();
    expect(planForProductId(undefined)).toBeNull();
  });
});

describe("what each product is: auto-renewing, a School Year pass, or one-time for good", () => {
  // productType is UNKNOWN under StoreKit 1 (RevenueCat's fallback below iOS 16), so it is often missing.
  const product = (productIdentifier: string, subscriptionPeriod: string | null, productType?: string) => ({
    product: { productIdentifier, priceString: "€29.99", subscriptionPeriod, ...(productType ? { productType } : {}) },
  });

  it("classifies by the store's renewal first, then our pass table, then the store's type, else lifetime", () => {
    expect(classifyStoreProduct({ productIdentifier: "trajectory_pro_monthly", subscriptionPeriod: "P1M" })).toEqual({ kind: "renewing" });
    expect(classifyStoreProduct({ productIdentifier: "trajectory_pro_school_year", productType: "AUTO_RENEWABLE_SUBSCRIPTION", subscriptionPeriod: null })).toEqual({ kind: "renewing" });
    expect(classifyStoreProduct({ productIdentifier: "trajectory_school_year", subscriptionPeriod: null, productType: "UNKNOWN" })).toEqual({ kind: "term", termMonths: 12 });
    expect(classifyStoreProduct({ productIdentifier: "trajectory_school_year", subscriptionPeriod: null, productType: "NON_RENEWABLE_SUBSCRIPTION" })).toEqual({ kind: "term", termMonths: 12 });
    expect(classifyStoreProduct({ productIdentifier: "some_other_pass", productType: "NON_RENEWABLE_SUBSCRIPTION" })).toEqual({ kind: "term" });
    expect(classifyStoreProduct({ productIdentifier: "trajectory_lifetime_college", productType: "NON_CONSUMABLE" })).toEqual({ kind: "lifetime" });
    expect(classifyStoreProduct({ productIdentifier: "trajectory_lifetime_college" })).toEqual({ kind: "lifetime" });
    // Our table never overrides the store's own word that a product renews (it was created as auto-renewing).
    expect(classifyStoreProduct({ productIdentifier: "trajectory_school_year", subscriptionPeriod: "P1Y" })).toEqual({ kind: "renewing" });
  });

  it("words the one-time School Year as one payment for 12 months that does not renew", () => {
    const info = packageInfo(product("trajectory_school_year", null));
    expect(info).toMatchObject({ kind: "term", termMonths: 12, renews: false, billing: "One payment · 12 months of Pro · doesn't renew", introOffer: null, hasFreeTrial: false });
    expect(planPriceLine(info)).toBe("€29.99 · One payment · 12 months of Pro · doesn't renew");
    expect(planLegalText(info)).toBe("One-time purchase of 12 months of Trajectory Pro. It does not renew; when it ends you can buy another year.");
  });

  it("never claims a length it does not know", () => {
    const info = packageInfo(product("some_other_pass", null, "NON_RENEWABLE_SUBSCRIPTION"));
    expect(info).toMatchObject({ kind: "term", renews: false, billing: "One payment · doesn't renew" });
    expect(info.termMonths).toBeUndefined();
    expect(describeTermBilling()).toBe("One payment · doesn't renew");
    expect(planLegalText(info)).toBe("One-time purchase of Trajectory Pro. It does not renew.");
    for (const text of [info.billing, planLegalText(info)]) expect(text).not.toMatch(/\d+ months?|year/);
  });

  it("keeps auto-renew and one-time wording for the other plans", () => {
    const monthly = packageInfo(product("trajectory_pro_monthly", "P1M"));
    expect(monthly).toMatchObject({ kind: "renewing", renews: true, billing: "Renews every month" });
    expect(planLegalText(monthly)).toMatch(/^This subscription auto-renews unless cancelled at least 24 hours/);
    const trial = packageInfo({ product: { productIdentifier: "trajectory_pro_school_year", priceString: "€31.99", subscriptionPeriod: "P1Y", introPrice: { price: 0, period: "P1W", cycles: 1 } } });
    expect(planLegalText(trial)).toMatch(/^If you are eligible for the 1-week free trial, you are not charged until it ends; after that the subscription costs €31\.99 and auto-renews\./);
    const degree = packageInfo(product("trajectory_lifetime_college", null));
    expect(degree).toMatchObject({ kind: "lifetime", renews: false, billing: "One-time purchase" });
    expect(planLegalText(degree)).toBe("This is a one-time purchase. No recurring subscription is created.");
    // A product that renews never gets "doesn't renew" wording, and a pass never gets cancel-the-renewal wording.
    expect(`${monthly.billing} ${planLegalText(monthly)}`).not.toMatch(/doesn't renew|does not renew/);
    expect(`${packageInfo(product("trajectory_school_year", null)).billing}`).not.toMatch(/Renews every/);
    expect(planLegalText(null)).toBeNull();
    expect(planLegalText(packageInfo(null))).toBeNull();
  });

  it("sells the one-time School Year when the offering holds both School Year products, in either order", () => {
    const renewing = pkg("sy_renew", "ANNUAL", "trajectory_pro_school_year", "€31.99", "P1Y");
    const oneTime = pkg("sy_once", "CUSTOM", "trajectory_school_year", "€29.99", null);
    for (const availablePackages of [[renewing, oneTime], [oneTime, renewing]]) {
      const offerings = resolveOfferings({ availablePackages });
      expect(offerings.schoolYear).toMatchObject({ productIdentifier: "trajectory_school_year", kind: "term", priceString: "€29.99" });
    }
    // Only the auto-renewing one in the offering: still sold, as before.
    expect(resolveOfferings({ availablePackages: [renewing] }).schoolYear).toMatchObject({ productIdentifier: "trajectory_pro_school_year", kind: "renewing" });
  });
});

describe("describeSubscriptionPeriod", () => {
  it("words ISO-8601 periods", () => {
    expect(describeSubscriptionPeriod("P1M")).toBe("Renews every month");
    expect(describeSubscriptionPeriod("P1Y")).toBe("Renews every year");
    expect(describeSubscriptionPeriod("P3M")).toBe("Renews every 3 months");
    expect(describeSubscriptionPeriod("P1W")).toBe("Renews every week");
    expect(describeSubscriptionPeriod(null)).toBeNull();
    expect(describeSubscriptionPeriod("monthly")).toBeNull();
  });
});

describe("plan catalog", () => {
  it("carries names and badges only, never a price or a billing promise", () => {
    expect(PLAN_CATALOG.monthly.title).toBe("Monthly");
    expect(PLAN_CATALOG.schoolYear.title).toBe("Trajectory School Year Plan");
    expect(PLAN_CATALOG.degreePass.title).toBe("Trajectory Degree Pass");
    for (const plan of Object.values(PLAN_CATALOG)) {
      expect(Object.keys(plan).sort()).toEqual(Object.keys(plan).filter((k) => k === "title" || k === "badge").sort());
    }
  });

  it("claims no popularity: the School Year has no fixed badge (its saving is computed from the store prices)", () => {
    expect(PLAN_CATALOG.schoolYear.badge).toBeUndefined();
    expect(JSON.stringify(PLAN_CATALOG)).not.toMatch(/popular/i);
  });
});

describe("School Year savings badge, from the real store prices", () => {
  /** A package as RevenueCat returns it, with the numeric price and currency the badge is worked out from. */
  const priced = (productIdentifier: string, price: number | undefined, subscriptionPeriod: string | null, extra: Record<string, unknown> = {}) => ({
    identifier: productIdentifier,
    packageType: "CUSTOM",
    product: { productIdentifier, priceString: `€${price}`, subscriptionPeriod, currencyCode: "EUR", ...(price === undefined ? {} : { price }), ...extra },
  });
  const offer = (...availablePackages: unknown[]) => resolveOfferings({ availablePackages });
  const monthly = (price: number | undefined, period: string | null = "P1M", extra?: Record<string, unknown>) => priced("trajectory_pro_monthly", price, period, extra);

  it("compares 12 months of Monthly with the renewing School Year, rounding down", () => {
    const offerings = offer(monthly(4.99), priced("trajectory_pro_school_year", 36.99, "P1Y"));
    // 1 - 36.99 / (12 × 4.99) = 38.2%
    expect(schoolYearSavings(offerings)).toEqual({ percent: 38, months: 12 });
    expect(planBadge("schoolYear", offerings)).toEqual({ label: "SAVE 38%", accessibilityLabel: "38% less than 12 months of Monthly" });
  });

  it("works for the one-time 12-month pass too (its length comes from our pass table)", () => {
    const offerings = offer(monthly(4.99), priced("trajectory_school_year", 29.99, null, { productType: "NON_RENEWABLE_SUBSCRIPTION" }));
    expect(monthsPerPayment(offerings.schoolYear)).toBe(12);
    // 1 - 29.99 / 59.88 = 49.9%: rounded DOWN, never up to 50%.
    expect(planBadge("schoolYear", offerings)?.label).toBe("SAVE 49%");
  });

  it("keeps an exact saving exact (no floating-point 49%)", () => {
    expect(schoolYearSavings(offer(monthly(5), priced("trajectory_pro_school_year", 30, "P1Y")))?.percent).toBe(50);
    expect(schoolYearSavings(offer(monthly(4.99), priced("trajectory_pro_school_year", 29.94, "P1Y")))?.percent).toBe(50);
  });

  it("measures a multi-month Monthly period per month", () => {
    // Billed every 3 months: 12 months cost 4 × 15 = 60.
    expect(schoolYearSavings(offer(monthly(15, "P3M"), priced("trajectory_pro_school_year", 45, "P1Y")))?.percent).toBe(25);
  });

  it("shows no badge unless both prices are real, comparable and the School Year is really cheaper", () => {
    const year = priced("trajectory_pro_school_year", 36.99, "P1Y");
    const none = [
      offer(year), // no Monthly in the offering
      offer(monthly(4.99)), // no School Year
      offer(monthly(undefined), year), // no numeric price from the store
      offer(monthly(0), year), // a zero price is not a price
      offer(monthly(4.99, null, { productType: "AUTO_RENEWABLE_SUBSCRIPTION" }), year), // Monthly's period unknown
      offer(monthly(4.99, "P1W"), year), // a weekly period is not counted in months
      offer(monthly(4.99), priced("trajectory_pro_school_year", 36.99, "P1Y", { currencyCode: "USD" })), // two currencies
      offer(monthly(4.99), priced("trajectory_pro_school_year", 59.88, "P1Y")), // the same price: nothing saved
      offer(monthly(4.99), priced("trajectory_pro_school_year", 70, "P1Y")), // dearer
      offer(monthly(4.99), priced("trajectory_pro_school_year", 59.5, "P1Y")), // under 1%
      resolveOfferings(null), // nothing loaded yet
    ];
    for (const offerings of none) {
      expect(schoolYearSavings(offerings)).toBeNull();
      expect(planBadge("schoolYear", offerings)).toBeNull();
    }
    expect(schoolYearSavings(null)).toBeNull();
  });

  it("needs the School Year's length in months: none for a pass of unknown length or a product with no period", () => {
    expect(monthsPerPayment(packageInfo(priced("some_other_pass", 20, null, { productType: "NON_RENEWABLE_SUBSCRIPTION" })))).toBeNull();
    expect(monthsPerPayment(packageInfo(priced("trajectory_lifetime_college", 54.99, null)))).toBeNull();
    // The renewing School Year id without a period reads as a one-time product: no length, so no badge.
    expect(planBadge("schoolYear", offer(monthly(4.99), priced("trajectory_pro_school_year", 36.99, null)))).toBeNull();
    // The store's own period wins over our table (it renews yearly): 12 months.
    expect(schoolYearSavings(offer(monthly(4.99), priced("trajectory_school_year", 29.99, "P1Y")))?.months).toBe(12);
  });

  it("other plans keep their fixed badge, or none", () => {
    const offerings = offer(monthly(4.99), priced("trajectory_pro_school_year", 36.99, "P1Y"));
    expect(planBadge("monthly", offerings)).toBeNull();
    expect(planBadge("degreePass", offerings)).toEqual({ label: "PAY ONCE", accessibilityLabel: "Pay once" });
  });
});

describe("F8: paywall note for a pass bought while a cancelled subscription still runs", () => {
  // Aug 20, 2027 at noon on the phone's own calendar (formatPassDate reads local time).
  const until = new Date(2027, 7, 20, 12).toISOString();
  const cancelled: ProStatus = { isPro: true, source: "subscription", until, willRenew: false, productId: "trajectory_pro_school_year", termPass: null };
  const product = (productIdentifier: string, subscriptionPeriod: string | null, productType?: string) =>
    packageInfo({ product: { productIdentifier, priceString: "€29.99", subscriptionPeriod, ...(productType ? { productType } : {}) } });
  const pass = product("trajectory_school_year", null);
  const passOfUnknownLength = product("some_other_pass", null, "NON_RENEWABLE_SUBSCRIPTION");
  const monthly = product("trajectory_pro_monthly", "P1M");
  const degree = product("trajectory_lifetime_college", null);

  it("says the pass starts today, while the current plan runs until its end (the two overlap)", () => {
    expect(paywallOwnershipNote(cancelled, pass)).toBe("These 12 months start today; your current plan runs until Aug 20, 2027.");
    expect(paywallOwnershipNote(cancelled, passOfUnknownLength)).toBe("This pass starts today; your current plan runs until Aug 20, 2027.");
  });

  it("keeps the other notes as they were", () => {
    // Still renewing (or not known): buying a one-time plan does not cancel it.
    expect(paywallOwnershipNote({ ...cancelled, willRenew: true }, pass)).toMatch(/^You already have Trajectory Pro as an App Store subscription\. Buying this does not cancel it/);
    expect(paywallOwnershipNote({ ...cancelled, willRenew: null }, degree)).toMatch(/does not cancel it/);
    // Cancelled, and not buying a pass: nothing to add (Monthly is a plan change in the group; the Degree Pass is for good).
    expect(paywallOwnershipNote(cancelled, monthly)).toBeNull();
    expect(paywallOwnershipNote(cancelled, degree)).toBeNull();
    // No end date known: no date is made up.
    expect(paywallOwnershipNote({ ...cancelled, until: null }, pass)).toBeNull();
    // Not Pro at all: nothing.
    expect(paywallOwnershipNote({ ...cancelled, isPro: false, source: null }, pass)).toBeNull();
  });
});

describe("paywall gating waits for the entitlement", () => {
  it("never bounces a paying user while entitlement is loading", () => {
    expect(decideProGate({ isPro: false, isLoading: true })).toBe("wait");
    expect(shouldRedirectToPaywall({ isPro: false, isLoading: true })).toBe(false);
  });

  it("allows Pro users and sends known-free users to the paywall", () => {
    expect(decideProGate({ isPro: true, isLoading: false })).toBe("allow");
    expect(decideProGate({ isPro: false, isLoading: false })).toBe("paywall");
    expect(shouldRedirectToPaywall({ isPro: false, isLoading: false })).toBe(true);
    expect(shouldRedirectToPaywall({ isPro: true, isLoading: false })).toBe(false);
  });

  it("lets a free user upload their first syllabus even while entitlement loads, then gates the second", () => {
    expect(decideSyllabusUpload({ isPro: false, isLoading: true, syllabusCount: 0 })).toBe("allow");
    expect(decideSyllabusUpload({ isPro: false, isLoading: true, syllabusCount: 1 })).toBe("wait");
    expect(decideSyllabusUpload({ isPro: false, isLoading: false, syllabusCount: 1 })).toBe("paywall");
    expect(decideSyllabusUpload({ isPro: true, isLoading: false, syllabusCount: 5 })).toBe("allow");
  });
});

describe("no hardcoded prices in the client", () => {
  const root = resolve(__dirname, "../..");
  const PRICE = /\$\s?\d+(\.\d{2})?\s*(\/|per\s|a\s)?\s*(mo|month|yr|year)?/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("the screens, components and subscription modules contain no literal dollar prices", () => {
    const files = [
      ...sourceFiles(join(root, "src/screens")),
      ...sourceFiles(join(root, "src/components")),
      join(root, "src/lib/subscription-plans.ts"),
      join(root, "src/lib/revenuecat-web.ts"),
      join(root, "src/state/subscription-context.tsx"),
    ];
    const offenders = files.filter((file) => {
      // Strip template-literal placeholders like `${x}`, which are not prices.
      const text = readFileSync(file, "utf8").replace(/\$\{[^}]*\}/g, "");
      const code = text.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
      return PRICE.test(code);
    });

    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});
