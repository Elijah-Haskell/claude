/**
 * Pure (React-Native-free) plan catalog + RevenueCat offering resolution, so it can be unit tested.
 * lib/subscription-context.tsx wires this to the SDK.
 *
 * Price and billing-term text is NEVER hardcoded here: it always comes from the store product
 * (`priceString`, `subscriptionPeriod`, `productType`) via the RevenueCat offering. When no offering is loaded the
 * fields are null and the UI must render a neutral placeholder and disable purchasing. The one length the app
 * itself knows is a School Year pass's (shared/term-pass.ts): Apple and RevenueCat do not keep it.
 *
 * Also here: what the student's CustomerInfo means (proStatusFromCustomerInfo, the same rule the server applies)
 * and the wording built on it (Settings row, Today banner, paywall notes).
 */

import { FREE_SYLLABUS_IMPORTS, PRO_ENTITLEMENT_ID } from "../shared/pro";
import {
  baseProductId,
  resolveProAccess,
  termPassProduct,
  type ProAccessInput,
  type ProAccessSource,
  type TermPassPurchase,
} from "../shared/term-pass";
import { daysBetweenKeys, localDateKey } from "../engine/utils";

export type PurchasePlan = "monthly" | "schoolYear" | "degreePass";

/**
 * Exact App Store / Play product identifiers per plan. Matching is by equality (never substring).
 * Verified against the RevenueCat product catalog (App Store app, offering `default1`) on 2026-09-23:
 *   - trajectory_pro_monthly       Monthly Pro (auto-renewing)
 *   - trajectory_pro_school_year   School Year Plan, the auto-renewing yearly subscription in the "Trajectory Pro"
 *                                  group (kept working for anyone who bought it)
 *   - trajectory_school_year       School Year Plan as ONE payment = 12 months of Pro, no renewal (an App Store
 *                                  Non-Renewing Subscription; its length lives in shared/term-pass.ts). When the
 *                                  offering holds both School Year products, this one is sold.
 *   - trajectory_lifetime_college  Degree Pass (one-time, for good)
 * Billing copy is never assumed from this table: it is derived from the store product at runtime.
 */
export const PRODUCT_IDS: Record<PurchasePlan, readonly string[]> = {
  monthly: ["trajectory_pro_monthly"],
  schoolYear: ["trajectory_pro_school_year", "trajectory_school_year"],
  degreePass: ["trajectory_lifetime_college"],
};

/**
 * Plan names and fixed badges. Nothing here claims popularity: the School Year's badge is worked out from the real
 * store prices on the paywall (planBadge / schoolYearSavings), or there is none.
 */
export const PLAN_CATALOG: Record<PurchasePlan, { title: string; badge?: string }> = {
  monthly: { title: "Monthly" },
  schoolYear: { title: "Trajectory School Year Plan" },
  // A fact, not a claim: "best value" depends on how long a student stays, so the badge says what it is.
  degreePass: { title: "Trajectory Degree Pass", badge: "PAY ONCE" },
};

/** The plan's name on its row of the Pro screen, where "Trajectory Pro" is already the heading. */
export const PLAN_SHORT_TITLE: Record<PurchasePlan, string> = {
  monthly: "Monthly",
  schoolYear: "School Year",
  degreePass: "Degree Pass",
};

/**
 * What a plan's store product is: an auto-renewing subscription, a fixed term of Pro bought once (the School Year
 * pass), or a one-time purchase for good (the Degree Pass).
 */
export type PlanKind = "renewing" | "term" | "lifetime";

export interface SubscriptionPackageInfo {
  productIdentifier: string | null;
  /** Localized price from the store product, e.g. "$4.99". Null until an offering has loaded. */
  priceString: string | null;
  /**
   * Term wording derived from the store product: "Renews every month", "One payment · 12 months of Pro · doesn't
   * renew", "One-time purchase".
   */
  billing: string | null;
  /** True = auto-renewing subscription, false = no renewal (a pass or a one-time purchase), null = unknown (not loaded). */
  renews: boolean | null;
  /** What the product is (classifyStoreProduct); null until an offering has loaded. */
  kind: PlanKind | null;
  /** A pass's length, only when it is known (shared/term-pass.ts): copy never claims a length it does not know. */
  termMonths?: number;
  /**
   * The store product's introductory offer, worded ("1-week free trial", "$0.99 for the first month"). Null when
   * the product has none: trial wording is never shown unless the store actually offers one.
   */
  introOffer: string | null;
  /** True when the introductory offer is free (a free trial). */
  hasFreeTrial: boolean;
  package: any;
}

export type SubscriptionOffering = Record<PurchasePlan, SubscriptionPackageInfo>;

/** Which plan (if any) an exact product identifier belongs to. */
export function planForProductId(productIdentifier: unknown): PurchasePlan | null {
  const id = baseProductId(productIdentifier);
  if (!id) return null;
  for (const plan of Object.keys(PRODUCT_IDS) as PurchasePlan[]) {
    if (PRODUCT_IDS[plan].includes(id)) return plan;
  }
  return null;
}

/** Human wording for an ISO-8601 subscription period ("P1M", "P1Y", "P3M", "P1W"). */
export function describeSubscriptionPeriod(period: unknown): string | null {
  if (typeof period !== "string") return null;
  const match = /^P(\d+)([DWMY])$/.exec(period);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = { D: "day", W: "week", M: "month", Y: "year" }[match[2] as "D" | "W" | "M" | "Y"];
  return count === 1 ? `Renews every ${unit}` : `Renews every ${count} ${unit}s`;
}

const EMPTY_INFO: SubscriptionPackageInfo = {
  productIdentifier: null,
  priceString: null,
  billing: null,
  renews: null,
  kind: null,
  introOffer: null,
  hasFreeTrial: false,
  package: null,
};

const UNIT_WORDS: Record<string, "day" | "week" | "month" | "year"> = {
  D: "day", DAY: "day", W: "week", WEEK: "week", M: "month", MONTH: "month", Y: "year", YEAR: "year",
};

/** Length of one intro period: from `period` ("P1W") or `periodUnit` + `periodNumberOfUnits` (RevenueCat fields). */
function introPeriod(intro: any): { count: number; unit: "day" | "week" | "month" | "year" } | null {
  const iso = typeof intro?.period === "string" ? /^P(\d+)([DWMY])$/.exec(intro.period) : null;
  if (iso) return { count: Number(iso[1]), unit: UNIT_WORDS[iso[2]!]! };
  const unit = typeof intro?.periodUnit === "string" ? UNIT_WORDS[intro.periodUnit.toUpperCase()] : undefined;
  const count = Number(intro?.periodNumberOfUnits);
  if (unit && Number.isFinite(count) && count > 0) return { count, unit };
  return null;
}

/**
 * Wording for a store product's introductory price (RevenueCat `product.introPrice`), or null when there is none
 * or it cannot be read. A free intro is a trial ("1-week free trial"); a paid one says what it costs
 * ("$0.99 for the first month", "$1.99/month for 3 months").
 */
export function describeIntroOffer(intro: any): { text: string; free: boolean } | null {
  if (!intro || typeof intro !== "object") return null;
  const period = introPeriod(intro);
  if (!period) return null;
  const cycles = Number.isFinite(Number(intro.cycles)) && Number(intro.cycles) > 0 ? Number(intro.cycles) : 1;
  const free = Number(intro.price) === 0;
  const total = period.count * cycles;
  const span = (n: number) => `${n} ${period.unit}${n === 1 ? "" : "s"}`;
  if (free) return { text: `${total}-${period.unit} free trial`, free: true };
  if (typeof intro.priceString !== "string" || !intro.priceString) return null;
  if (cycles === 1) return { text: `${intro.priceString} for the first ${period.count === 1 ? period.unit : span(period.count)}`, free: false };
  return { text: `${intro.priceString}/${period.count === 1 ? period.unit : span(period.count)} for ${span(total)}`, free: false };
}

/**
 * What a store product is, for the copy, in this order:
 *  1. the store says it auto-renews (an AUTO_RENEWABLE_SUBSCRIPTION, or any billing period): "renewing". This wins
 *     even over our own table, so copy never says "doesn't renew" about a product Apple will renew;
 *  2. our table of passes (shared/term-pass.ts): "term" with its known length. StoreKit 1, which RevenueCat uses
 *     below iOS 16, cannot tell a product's type, so the id is what identifies the School Year pass;
 *  3. the store says NON_RENEWABLE_SUBSCRIPTION: "term" of unknown length (no length is claimed);
 *  4. anything else is a one-time purchase for good: "lifetime".
 */
export function classifyStoreProduct(product: any): { kind: PlanKind; termMonths?: number } {
  if (product?.productType === "AUTO_RENEWABLE_SUBSCRIPTION" || describeSubscriptionPeriod(product?.subscriptionPeriod) !== null) {
    return { kind: "renewing" };
  }
  const pass = termPassProduct(product?.productIdentifier);
  if (pass) return { kind: "term", termMonths: pass.months };
  if (product?.productType === "NON_RENEWABLE_SUBSCRIPTION") return { kind: "term" };
  return { kind: "lifetime" };
}

/** Billing line of a pass: "One payment · 12 months of Pro · doesn't renew" (no length when it is not known). */
export function describeTermBilling(months?: number): string {
  return months ? `One payment · ${months} months of Pro · doesn't renew` : "One payment · doesn't renew";
}

/** Wrap a RevenueCat package; all copy comes from the package's store product. */
export function packageInfo(pkg: any): SubscriptionPackageInfo {
  if (!pkg) return EMPTY_INFO;
  const product = pkg.product ?? {};
  const { kind, termMonths } = classifyStoreProduct(product);
  const renewing = kind === "renewing";
  const intro = renewing ? describeIntroOffer(product.introPrice) : null;
  return {
    productIdentifier: typeof product.productIdentifier === "string" ? product.productIdentifier : null,
    priceString: typeof product.priceString === "string" ? product.priceString : null,
    billing: renewing
      ? describeSubscriptionPeriod(product.subscriptionPeriod) ?? "Renews automatically"
      : kind === "term"
        ? describeTermBilling(termMonths)
        : "One-time purchase",
    renews: renewing,
    kind,
    ...(termMonths ? { termMonths } : {}),
    introOffer: intro?.text ?? null,
    hasFreeTrial: intro?.free ?? false,
    package: pkg,
  };
}

/**
 * The fine print under the purchase button, from what the selected plan's store product is. Null until loaded.
 * Auto-renewing plans say how to cancel; a pass says it is one payment that does not renew; the Degree Pass says no
 * subscription is created.
 */
export function planLegalText(info: SubscriptionPackageInfo | null | undefined): string | null {
  if (!info?.kind) return null;
  if (info.kind === "renewing") {
    return info.hasFreeTrial && info.introOffer
      ? `If you are eligible for the ${info.introOffer}, you are not charged until it ends; after that the subscription costs ${info.priceString ?? "the price shown"} and auto-renews. Cancel at least 24 hours before the trial or any period ends to avoid being charged. Manage or cancel it in your App Store account settings.`
      : "This subscription auto-renews unless cancelled at least 24 hours before the end of the current period. Manage or cancel it in your App Store account settings.";
  }
  if (info.kind === "term") {
    if (!info.termMonths) return "One-time purchase of Trajectory Pro. It does not renew.";
    return `One-time purchase of ${info.termMonths} months of Trajectory Pro. It does not renew; when it ends you can ${info.termMonths === 12 ? "buy another year" : "buy it again"}.`;
  }
  return "This is a one-time purchase. No recurring subscription is created.";
}

/**
 * One line of price + term copy for a plan ("$4.99 · Renews every month"), built only from the store
 * product. Returns null when no offering is loaded, so callers render nothing rather than a guess.
 */
export function planPriceLine(info: SubscriptionPackageInfo | null | undefined): string | null {
  if (!info?.priceString) return null;
  return info.billing ? `${info.priceString} · ${info.billing}` : info.priceString;
}

// ── Paywall badges ────────────────────────────────────────────────────────────

/**
 * Months of Pro one payment of a plan buys, from its store product: a subscription's billing period in months or
 * years ("P1M" = 1, "P1Y" = 12), a pass's known length. Null when it is not known (weekly periods included).
 */
export function monthsPerPayment(info: SubscriptionPackageInfo | null | undefined): number | null {
  if (info?.kind === "term") return info.termMonths ?? null;
  if (info?.kind !== "renewing") return null;
  const match = /^P(\d+)([MY])$/.exec(String(info.package?.product?.subscriptionPeriod ?? ""));
  const count = match ? Number(match[1]) : 0;
  if (!match || count <= 0) return null;
  return match[2] === "Y" ? count * 12 : count;
}

/** The store product's numeric price (and currency), or null when the store gave no usable price. */
function storePrice(info: SubscriptionPackageInfo | null | undefined): { amount: number; currency: string | null } | null {
  const product = info?.package?.product;
  const amount = typeof product?.price === "number" ? product.price : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: typeof product.currencyCode === "string" && product.currencyCode ? product.currencyCode : null };
}

export interface PlanSavings {
  /** Whole percent, rounded down: 38 for "SAVE 38%". */
  percent: number;
  /** The School Year's months, which the saving is measured over. */
  months: number;
}

/**
 * How much less the School Year costs than paying Monthly for the same number of months, from the REAL store prices.
 * Null unless both products are loaded with a price in the same currency, Monthly is a subscription, both lengths are
 * known in months and the School Year really is cheaper (by at least 1%).
 */
export function schoolYearSavings(offerings: SubscriptionOffering | null | undefined): PlanSavings | null {
  const monthly = offerings?.monthly;
  const schoolYear = offerings?.schoolYear;
  if (monthly?.kind !== "renewing") return null;
  const monthlyPrice = storePrice(monthly);
  const schoolYearPrice = storePrice(schoolYear);
  const monthlyMonths = monthsPerPayment(monthly);
  const schoolYearMonths = monthsPerPayment(schoolYear);
  if (!monthlyPrice || !schoolYearPrice || !monthlyMonths || !schoolYearMonths) return null;
  if (monthlyPrice.currency && schoolYearPrice.currency && monthlyPrice.currency !== schoolYearPrice.currency) return null;
  // Whole cents times whole months, so the rounding never turns an exact 50% into 49%.
  const monthlyForSameMonths = Math.round(monthlyPrice.amount * 100) * schoolYearMonths;
  const schoolYearCost = Math.round(schoolYearPrice.amount * 100) * monthlyMonths;
  if (schoolYearCost >= monthlyForSameMonths) return null;
  const percent = Math.floor((100 * (monthlyForSameMonths - schoolYearCost)) / monthlyForSameMonths);
  return percent >= 1 ? { percent, months: schoolYearMonths } : null;
}

/**
 * A plan's badge on the paywall: the School Year's saving against Monthly when the store prices show one ("SAVE 38%"),
 * otherwise the catalog's fixed badge, otherwise none.
 */
export function planBadge(plan: PurchasePlan, offerings: SubscriptionOffering | null | undefined): { label: string; accessibilityLabel: string } | null {
  if (plan === "schoolYear") {
    const savings = schoolYearSavings(offerings);
    return savings
      ? { label: `SAVE ${savings.percent}%`, accessibilityLabel: `${savings.percent}% less than ${savings.months} months of Monthly` }
      : null;
  }
  const badge = PLAN_CATALOG[plan].badge;
  return badge ? { label: badge, accessibilityLabel: badge.charAt(0) + badge.slice(1).toLowerCase() } : null;
}

/**
 * Pick each plan's package from a RevenueCat offering by EXACT product identifier.
 * Package types (`monthly`/`annual`/`lifetime` shortcuts) are deliberately ignored: they are
 * derived from RevenueCat package naming and can point at the wrong product.
 * A plan with no matching package resolves to an empty (unavailable) entry. When the offering holds both School
 * Year products, the one-time pass is sold here; app versions before 1.0.9 take the first match in the offering's
 * order, so listing the auto-renewing one first keeps them selling the product they understand.
 */
export function resolveOfferings(current: any): SubscriptionOffering {
  const packages: any[] = Array.isArray(current?.availablePackages) ? current.availablePackages : [];
  const find = (plan: PurchasePlan) => {
    const matches = packages.filter((pkg) => planForProductId(pkg?.product?.productIdentifier) === plan);
    return matches.find((pkg) => termPassProduct(pkg?.product?.productIdentifier) !== null) ?? matches[0] ?? null;
  };
  return {
    monthly: packageInfo(find("monthly")),
    schoolYear: packageInfo(find("schoolYear")),
    degreePass: packageInfo(find("degreePass")),
  };
}

/** What the paywall shows before/without a loaded offering: no price, purchasing unavailable. */
export const UNAVAILABLE_OFFERINGS: SubscriptionOffering = {
  monthly: EMPTY_INFO,
  schoolYear: EMPTY_INFO,
  degreePass: EMPTY_INFO,
};

export type ProGateDecision = "allow" | "paywall" | "wait";

/**
 * Entitlement gate. While RevenueCat is still reporting the entitlement (`isLoading`) the answer is
 * "wait": never bounce a paying user to the paywall, and never grant Pro on a guess.
 */
export function decideProGate(state: { isPro: boolean; isLoading: boolean }): ProGateDecision {
  if (state.isLoading) return "wait";
  return state.isPro ? "allow" : "paywall";
}

/**
 * Free accounts may import this many syllabi before Pro is required. The server is the authority: it remembers
 * every syllabus an account imported (server/ledger.ts), so deleting an import or resetting the semester does not
 * free the slot, and answers a second free import with a Pro-gate error that opens the paywall
 * (lib/sign-in-prompt.ts notePaywallResponse / shared/pro.ts proGateReasonFromError). This local check only
 * saves a pointless upload when the app already knows.
 */
export const FREE_SYLLABUS_LIMIT = FREE_SYLLABUS_IMPORTS;

/** May this user start another syllabus upload? Free uploads are allowed even while entitlement loads. */
export function decideSyllabusUpload(state: { isPro: boolean; isLoading: boolean; syllabusCount: number }): ProGateDecision {
  if (state.syllabusCount < FREE_SYLLABUS_LIMIT) return "allow";
  return decideProGate(state);
}

/** Only send a user to the paywall once entitlement is known and they are not Pro. */
export function shouldRedirectToPaywall(state: { isPro: boolean; isLoading: boolean }): boolean {
  return decideProGate(state) === "paywall";
}

// ── Pro on this iPhone ────────────────────────────────────────────────────────

/** Trajectory Pro on this iPhone (proStatusFromCustomerInfo), as plain values so React state can compare them. */
export interface ProStatus {
  isPro: boolean;
  /** What keeps Pro on: an auto-renewing subscription, a one-time lifetime purchase, or a School Year pass. */
  source: ProAccessSource | null;
  /** ISO end of the access that counts (the subscription's period end, the pass end); null for lifetime / no Pro. */
  until: string | null;
  /** Subscriptions: renews or not. False for a pass (it never renews); null for lifetime / no Pro. */
  willRenew: boolean | null;
  productId: string | null;
  /** The latest School Year pass, running or ended; null when none was ever bought. */
  termPass: { active: boolean; until: string; productId: string } | null;
}

export const NOT_PRO_STATUS: ProStatus = { isPro: false, source: null, until: null, willRenew: null, productId: null, termPass: null };

export function sameProStatus(a: ProStatus, b: ProStatus): boolean {
  return (
    a.isPro === b.isPro &&
    a.source === b.source &&
    a.until === b.until &&
    a.willRenew === b.willRenew &&
    a.productId === b.productId &&
    a.termPass?.active === b.termPass?.active &&
    a.termPass?.until === b.termPass?.until &&
    a.termPass?.productId === b.termPass?.productId
  );
}

function dateOf(value: unknown): Date | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Pro from RevenueCat's CustomerInfo, by the rule the server applies too (shared/term-pass.ts resolveProAccess):
 * the "Trajectory Pro" entitlement as RevenueCat reports it, except a School Year pass, which RevenueCat cannot time
 * and which is counted from `nonSubscriptionTransactions` for its months instead.
 */
export function proStatusFromCustomerInfo(info: any, now: Date): ProStatus {
  if (!info || typeof info !== "object") return NOT_PRO_STATUS;
  const ent = info.entitlements?.active?.[PRO_ENTITLEMENT_ID];
  const entitlement: ProAccessInput["entitlement"] =
    ent && typeof ent === "object"
      ? {
          productId: typeof ent.productIdentifier === "string" ? ent.productIdentifier : null,
          // Listed under `active`: what the app has always trusted.
          active: true,
          lifetime: ent.expirationDate === null || ent.expirationDate === undefined,
          expiresAt: dateOf(ent.expirationDate),
          willRenew: typeof ent.willRenew === "boolean" ? ent.willRenew : null,
          purchaseDate: typeof ent.latestPurchaseDate === "string" ? ent.latestPurchaseDate : null,
        }
      : null;
  const oneTimePurchases: TermPassPurchase[] = (Array.isArray(info.nonSubscriptionTransactions) ? info.nonSubscriptionTransactions : [])
    .filter((t: any) => t && typeof t.productIdentifier === "string")
    .map((t: any) => ({
      productId: t.productIdentifier,
      purchaseDate: typeof t.purchaseDate === "string" ? t.purchaseDate : "",
      id: typeof t.transactionIdentifier === "string" ? t.transactionIdentifier : null,
    }));
  const byProduct = info.subscriptionsByProductIdentifier;
  const subscriptions: ProAccessInput["subscriptions"] =
    byProduct && typeof byProduct === "object"
      ? Object.entries(byProduct as Record<string, any>).map(([key, sub]) => {
          const expiresAt = laterOf(dateOf(sub?.expiresDate), dateOf(sub?.gracePeriodExpiresDate));
          return {
            productId: typeof sub?.productIdentifier === "string" ? sub.productIdentifier : key,
            active: !sub?.refundedAt && (expiresAt ? expiresAt.getTime() > now.getTime() : sub?.isActive === true),
            expiresAt,
            willRenew: typeof sub?.willRenew === "boolean" ? sub.willRenew : null,
          };
        })
      : (Array.isArray(info.activeSubscriptions) ? info.activeSubscriptions : [])
          .filter((id: unknown): id is string => typeof id === "string")
          .map((id: string) => ({ productId: id, active: true, expiresAt: dateOf(info.allExpirationDates?.[id]), willRenew: null }));
  const access = resolveProAccess({ entitlement, oneTimePurchases, subscriptions }, now);
  const pass = access.termPass;
  return {
    isPro: access.isPro,
    source: access.source,
    until: access.until ? access.until.toISOString() : null,
    willRenew: access.willRenew,
    productId: access.productId,
    termPass: pass?.expiresAt && pass.productId ? { active: pass.active, until: pass.expiresAt.toISOString(), productId: pass.productId } : null,
  };
}

// ── Wording built on it ───────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Aug 20", "Thu, Aug 20" or "Aug 20, 2027", in the phone's time zone. */
export function formatPassDate(date: Date, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return `${opts.weekday ? `${WEEKDAYS[date.getDay()]}, ` : ""}${day}${opts.year ? `, ${date.getFullYear()}` : ""}`;
}

/** Calendar days from `now` to `until` on the phone's calendar (0 = today, 1 = tomorrow, negative = past). */
export function calendarDaysUntil(until: Date, now: Date): number {
  return daysBetweenKeys(localDateKey(now), localDateKey(until));
}

function passLabel(productId: string | null | undefined): string {
  return termPassProduct(productId)?.label ?? "School Year";
}

/** Settings offers "Get another year" from this many days before a pass ends. */
export const PASS_RENEWAL_WINDOW_DAYS = 30;

export interface ProRowModel {
  kind: "upgrade" | "subscription" | "term" | "lifetime";
  label: string;
  sublabel: string;
  /** A School Year pass in its last PASS_RENEWAL_WINDOW_DAYS days: offer another one (it starts when this one ends). */
  offerAnotherTerm: boolean;
  anotherTermLabel: string;
}

/**
 * Settings → Account row for the student's Pro (components/pro-status-row.tsx). `renewalPeriod` is the store's
 * wording for the subscription's period ("Renews every month") when the offering has that product.
 */
export function proStatusRowModel(status: ProStatus, now: Date, renewalPeriod?: string | null): ProRowModel {
  const none = { offerAnotherTerm: false, anotherTermLabel: "Get another year" };
  if (!status.isPro || !status.source) {
    return { kind: "upgrade", label: "Upgrade to Pro", sublabel: "Unlimited syllabi, Ask AI and Exam Prep", ...none };
  }
  const until = status.until ? dateOf(status.until) : null;
  if (status.source === "lifetime") {
    const name = planForProductId(status.productId) === "degreePass" ? "Degree Pass" : "Trajectory Pro";
    return { kind: "lifetime", label: `${name} · Pro for good`, sublabel: "One-time purchase. Nothing renews or needs managing.", ...none };
  }
  if (status.source === "term") {
    const days = until ? calendarDaysUntil(until, now) : null;
    const ending = days !== null && days <= PASS_RENEWAL_WINDOW_DAYS;
    const endsIn = days === null ? "" : days <= 0 ? "ends today" : days === 1 ? "ends tomorrow" : `ends in ${days} days`;
    return {
      kind: "term",
      label: until ? `Pro until ${formatPassDate(until, { year: true })}` : "Trajectory Pro",
      sublabel: ending ? `${passLabel(status.productId)} pass ${endsIn}. It doesn't renew.` : `${passLabel(status.productId)} pass · one payment, doesn't renew`,
      offerAnotherTerm: ending,
      anotherTermLabel: termPassProduct(status.productId)?.months === 12 ? "Get another year" : "Buy another pass",
    };
  }
  const period = renewalPeriod ? `${renewalPeriod.charAt(0).toLowerCase()}${renewalPeriod.slice(1)}` : null;
  const detail =
    status.willRenew === false
      ? until
        ? `ends ${formatPassDate(until, { year: true })}, won't renew`
        : "won't renew"
      : period ?? (until ? `renews ${formatPassDate(until, { year: true })}` : "renews automatically");
  return { kind: "subscription", label: "Manage subscription", sublabel: `Trajectory Pro · ${detail}`, ...none };
}

/** The store's period wording ("Renews every month") for the product the student subscribes to, if offered. */
export function renewalPeriodFor(productId: string | null, offerings: SubscriptionOffering | null | undefined): string | null {
  const id = baseProductId(productId);
  if (!id || !offerings) return null;
  for (const info of Object.values(offerings)) {
    if (info.kind === "renewing" && baseProductId(info.productIdentifier) === id) return info.billing;
  }
  return null;
}

/** Today's banner shows in a pass's last this-many days... */
export const PASS_BANNER_DAYS_BEFORE = 14;
/** ...and for this many days after it ended. */
export const PASS_BANNER_DAYS_AFTER = 30;

export interface PassExpiryNotice {
  state: "ending" | "ended";
  /** "Your School Year Pro ends Thu, Aug 20" / "Your School Year Pro ended Aug 20". */
  message: string;
  endsAt: Date;
}

/**
 * Today's banner for a School Year pass (components/pass-expiry-banner.tsx): in its last PASS_BANNER_DAYS_BEFORE
 * days while it is what keeps Pro on, and for PASS_BANNER_DAYS_AFTER days after it ended while nothing else does.
 * Never while Pro comes from a subscription or the Degree Pass. `hiddenOn` = the local day it was dismissed.
 */
export function passExpiryNotice(status: ProStatus, now: Date, hiddenOn?: string | null): PassExpiryNotice | null {
  const pass = status.termPass;
  if (!pass || (hiddenOn && hiddenOn === localDateKey(now))) return null;
  const endsAt = dateOf(pass.until);
  if (!endsAt) return null;
  const label = passLabel(pass.productId);
  if (status.isPro) {
    if (status.source !== "term" || !pass.active) return null;
    const days = calendarDaysUntil(endsAt, now);
    if (days > PASS_BANNER_DAYS_BEFORE) return null;
    const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : formatPassDate(endsAt, { weekday: true });
    return { state: "ending", message: `Your ${label} Pro ends ${when}`, endsAt };
  }
  if (endsAt.getTime() > now.getTime()) return null;
  const daysAgo = -calendarDaysUntil(endsAt, now);
  if (daysAgo > PASS_BANNER_DAYS_AFTER) return null;
  const when = daysAgo <= 0 ? "today" : daysAgo === 1 ? "yesterday" : formatPassDate(endsAt);
  return { state: "ended", message: `Your ${label} Pro ended ${when}`, endsAt };
}

/**
 * A line on the paywall for a student who already has Pro, so nobody pays twice by accident: when a second pass
 * starts, that a subscription bought on top of a pass starts now, that buying a one-time plan does not cancel an
 * App Store subscription, that a pass bought while a cancelled subscription still runs starts today (the two overlap),
 * and that lifetime Pro needs nothing more.
 */
export function paywallOwnershipNote(status: ProStatus, selected: SubscriptionPackageInfo | null | undefined): string | null {
  if (!status.isPro || !status.source) return null;
  if (status.source === "lifetime") return "You already have Trajectory Pro for good. There is nothing more to buy.";
  const until = status.until ? dateOf(status.until) : null;
  if (status.source === "term" && until) {
    const ends = formatPassDate(until, { year: true });
    if (selected?.kind === "term") {
      return selected.termMonths
        ? `Your ${passLabel(status.productId)} Pro runs until ${ends}. These ${selected.termMonths} months start when it ends.`
        : `Your ${passLabel(status.productId)} Pro runs until ${ends}. This pass starts when it ends.`;
    }
    if (selected?.kind === "renewing") return `Your ${passLabel(status.productId)} Pro runs until ${ends}. A subscription starts as soon as you buy it.`;
    return null;
  }
  if (status.source === "subscription" && status.willRenew !== false && selected?.kind && selected.kind !== "renewing") {
    return "You already have Trajectory Pro as an App Store subscription. Buying this does not cancel it: cancel it in your App Store account settings if you don't want it to renew.";
  }
  // A cancelled subscription still runs until its period ends; a pass is timed from its purchase (shared/term-pass.ts),
  // not from that end, so the two overlap.
  if (status.source === "subscription" && status.willRenew === false && until && selected?.kind === "term") {
    const ends = formatPassDate(until, { year: true });
    return selected.termMonths
      ? `These ${selected.termMonths} months start today; your current plan runs until ${ends}.`
      : `This pass starts today; your current plan runs until ${ends}.`;
  }
  return null;
}
