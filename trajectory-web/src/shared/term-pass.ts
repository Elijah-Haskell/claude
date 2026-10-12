/**
 * School Year pass + the Trajectory Pro rule, shared by the app and the server (pure, no platform imports).
 *
 * "School Year" can be sold as ONE payment for a fixed term of Pro (12 months) that never renews: an App Store
 * Non-Renewing Subscription. Neither Apple nor RevenueCat keeps such a product's length. RevenueCat records the
 * purchase with no expiry, so attached to the "Trajectory Pro" entitlement it would even read as lifetime Pro. The
 * term is therefore computed here, the same way on the phone (CustomerInfo.nonSubscriptionTransactions,
 * lib/subscription-plans.ts) and on the server (subscriber.non_subscriptions, server/entitlements.ts):
 *  - a pass lasts TERM_PASS_PRODUCTS[id].months calendar months (UTC; Jan 31 + 1 month = Feb 28/29);
 *  - passes stack: one bought while another is still running starts when that one ends;
 *  - one bought after the last one ended starts on its own purchase date.
 *
 * resolveProAccess is the one Pro rule both sides use, whichever way the store is set up: the term product either
 * left out of the entitlement (recommended) or attached to it (then its "lifetime" is ignored).
 */

export interface TermPassProduct {
  /** How long one purchase keeps Pro on. */
  months: number;
  /** Plan name in copy: "Your School Year Pro ends Thu, Aug 20". */
  label: string;
}

/** One-time products that buy a fixed term of Pro, by exact App Store product id. */
export const TERM_PASS_PRODUCTS: Record<string, TermPassProduct> = {
  trajectory_school_year: { months: 12, label: "School Year" },
};

/**
 * One-time products that unlock Pro for good (the Degree Pass, a non-consumable). Only consulted when a School Year
 * pass attached to the entitlement hides them (see resolveProAccess); otherwise the entitlement reports them itself.
 */
export const LIFETIME_PRO_PRODUCTS: readonly string[] = ["trajectory_lifetime_college"];

/** Android ids look like "sub_id:base_plan"; App Store ids are the bare id. */
export function baseProductId(productId: unknown): string {
  return typeof productId === "string" ? (productId.split(":")[0] ?? "").trim() : "";
}

/** The term product for an id, or null (own keys only: "toString" is not a product). */
export function termPassProduct(productId: unknown): TermPassProduct | null {
  const id = baseProductId(productId);
  return id && Object.prototype.hasOwnProperty.call(TERM_PASS_PRODUCTS, id) ? TERM_PASS_PRODUCTS[id]! : null;
}

export function isTermPassProduct(productId: unknown): boolean {
  return termPassProduct(productId) !== null;
}

/**
 * `at` plus whole calendar months in UTC, keeping the time of day. A day the target month does not have is clamped
 * to its last day (Aug 31 + 1 month = Sep 30; Feb 29 2028 + 12 months = Feb 28 2029).
 */
export function addCalendarMonthsUTC(at: Date | number, months: number): Date {
  const d = new Date(at);
  const monthIndex = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  // setUTCFullYear (not Date.UTC) so years 0-99 are not read as 1900-1999. Day 0 of the next month = this month's last.
  const lastDayProbe = new Date(0);
  lastDayProbe.setUTCFullYear(year, month + 1, 0);
  const result = new Date(0);
  result.setUTCFullYear(year, month, Math.min(d.getUTCDate(), lastDayProbe.getUTCDate()));
  result.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return result;
}

export interface TermPassPurchase {
  productId: string;
  /** When the store says it was bought (ISO string from RevenueCat, or a Date). */
  purchaseDate: string | Date;
  /** Store transaction id when known: a purchase reported twice is counted once. */
  id?: string | null;
}

export interface TermPassStatus {
  /** A pass is running right now. */
  active: boolean;
  /** When the latest pass ends (or ended); null when no term purchase could be read. */
  expiresAt: Date | null;
  /** The product of the latest pass counted. */
  productId: string | null;
}

function timeOf(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Where a student's School Year passes stand at `now`. Purchases of other products and unreadable dates are ignored.
 * A purchase dated after `now` still counts from its own date: Apple's date is right and the clock reading it (an
 * iPhone set a few minutes or days behind) is wrong, and a student who just paid must not be told they have no Pro.
 */
export function termPassStatus(purchases: readonly TermPassPurchase[], now: Date): TermPassStatus {
  const seen = new Set<string>();
  const counted: { at: number; productId: string; months: number }[] = [];
  for (const purchase of purchases) {
    const product = termPassProduct(purchase?.productId);
    const at = timeOf(purchase?.purchaseDate);
    if (!product || at === null || !(product.months > 0)) continue;
    if (purchase.id) {
      const key = `${baseProductId(purchase.productId)}|${purchase.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    counted.push({ at, productId: baseProductId(purchase.productId), months: product.months });
  }
  counted.sort((a, b) => a.at - b.at);
  let expiresAt: number | null = null;
  let productId: string | null = null;
  for (const purchase of counted) {
    const start: number = expiresAt !== null && expiresAt > purchase.at ? expiresAt : purchase.at;
    expiresAt = addCalendarMonthsUTC(start, purchase.months).getTime();
    productId = purchase.productId;
  }
  return { active: expiresAt !== null && now.getTime() < expiresAt, expiresAt: expiresAt === null ? null : new Date(expiresAt), productId };
}

// ── The Pro rule ──────────────────────────────────────────────────────────────

/** What keeps Pro on: an auto-renewing subscription, a one-time lifetime purchase, or a School Year pass. */
export type ProAccessSource = "subscription" | "lifetime" | "term";

export interface ProAccessInput {
  /** The "Trajectory Pro" entitlement as RevenueCat reports it, or null when the customer has none. */
  entitlement: {
    productId: string | null;
    /** RevenueCat (or the server's own expiry check) says it is active now. */
    active: boolean;
    /** RevenueCat gave no expiry: a lifetime product, or a non-renewing one it cannot time. */
    lifetime: boolean;
    /** The expiry (or grace-period end) when there is one. */
    expiresAt: Date | null;
    willRenew: boolean | null;
    /** Latest purchase of the entitlement's product (a fallback when a pass shows up nowhere else). */
    purchaseDate: string | Date | null;
  } | null;
  /** Every one-time purchase RevenueCat holds: School Year passes, the Degree Pass. */
  oneTimePurchases: readonly TermPassPurchase[];
  /** Every subscription RevenueCat holds, active or not. */
  subscriptions: readonly { productId: string; active: boolean; expiresAt: Date | null; willRenew: boolean | null }[];
}

export interface ProAccess {
  isPro: boolean;
  source: ProAccessSource | null;
  /** When the access that counts ends: the subscription's period end or the pass end. Null for lifetime / no Pro. */
  until: Date | null;
  /** Subscriptions: whether it renews. False for a pass (it never does), null for lifetime / no Pro. */
  willRenew: boolean | null;
  productId: string | null;
  /** The latest School Year pass, running or ended ("ended Aug 20"); null when none was ever bought. */
  termPass: TermPassStatus | null;
}

export const NO_PRO_ACCESS: ProAccess = { isPro: false, source: null, until: null, willRenew: null, productId: null, termPass: null };

type Option = Omit<ProAccess, "isPro" | "termPass"> & { source: ProAccessSource };

/** Lifetime first, then a subscription that renews, then whatever lasts longest. */
function bestOption(options: Option[]): Option | null {
  return (
    options.find((o) => o.source === "lifetime") ??
    options.find((o) => o.source === "subscription" && o.willRenew !== false) ??
    [...options].sort((a, b) => (b.until?.getTime() ?? 0) - (a.until?.getTime() ?? 0))[0] ??
    null
  );
}

/**
 * Does this customer hold Trajectory Pro at `now`, and through what?
 *  - The entitlement counts as RevenueCat reports it (monthly, the auto-renewing School Year, the Degree Pass),
 *    EXCEPT when it names a one-time School Year pass: RevenueCat has no expiry for that, so it reads as lifetime.
 *    Then the pass is timed here instead, and because RevenueCat names one product per entitlement (a no-expiry one
 *    first), whatever else the student owns is looked up directly: an active subscription or the Degree Pass.
 *  - A School Year pass counts for its months whether or not it is attached to the entitlement.
 * A term product with a real expiry that RevenueCat lists as a subscription (created as auto-renewing by mistake) is
 * trusted like any subscription; with no expiry it never is.
 */
export function resolveProAccess(input: ProAccessInput, now: Date): ProAccess {
  const entitlement = input.entitlement;
  const subscriptionIds = new Set(input.subscriptions.map((s) => baseProductId(s.productId)));
  const masked =
    entitlement !== null &&
    isTermPassProduct(entitlement.productId) &&
    (entitlement.lifetime || !subscriptionIds.has(baseProductId(entitlement.productId)));

  const termPurchases = input.oneTimePurchases.filter((p) => isTermPassProduct(p?.productId));
  if (masked && termPurchases.length === 0 && entitlement.purchaseDate) {
    termPurchases.push({ productId: entitlement.productId as string, purchaseDate: entitlement.purchaseDate });
  }
  const counted = termPurchases.length > 0 ? termPassStatus(termPurchases, now) : null;
  const termPass = counted?.expiresAt ? counted : null;

  const options: Option[] = [];
  if (entitlement?.active && !masked) {
    options.push(
      entitlement.lifetime
        ? { source: "lifetime", until: null, willRenew: null, productId: entitlement.productId }
        : { source: "subscription", until: entitlement.expiresAt, willRenew: entitlement.willRenew, productId: entitlement.productId },
    );
  }
  if (termPass?.active) options.push({ source: "term", until: termPass.expiresAt, willRenew: false, productId: termPass.productId });
  if (masked) {
    const lifetime = input.oneTimePurchases.find((p) => LIFETIME_PRO_PRODUCTS.includes(baseProductId(p?.productId)));
    if (lifetime) options.push({ source: "lifetime", until: null, willRenew: null, productId: baseProductId(lifetime.productId) });
    for (const sub of input.subscriptions) {
      if (sub.active && !isTermPassProduct(sub.productId)) {
        options.push({ source: "subscription", until: sub.expiresAt, willRenew: sub.willRenew, productId: baseProductId(sub.productId) });
      }
    }
  }

  const best = bestOption(options);
  return best ? { isPro: true, ...best, termPass } : { ...NO_PRO_ACCESS, termPass };
}
