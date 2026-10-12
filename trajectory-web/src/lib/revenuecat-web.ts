/**
 * RevenueCat's Web Billing SDK speaks a slightly different dialect from the iPhone SDK (Date objects instead of ISO
 * strings, `currentPrice` instead of `priceString`, `normalPeriodDuration` instead of `subscriptionPeriod`). These
 * adapters turn its offerings and customer info into the shapes the ported, unit-tested rules in
 * lib/subscription-plans.ts expect, so the plan catalog, the Pro rule and every sentence built on them stay the same.
 */
import type { CustomerInfo, Offering, Package, Product } from "@revenuecat/purchases-js";

import { PRO_ENTITLEMENT_ID } from "../shared/pro";
import { NOT_PRO_STATUS, packageInfo, planForProductId, proStatusFromCustomerInfo, resolveOfferings, type ProStatus, type PurchasePlan, type SubscriptionOffering } from "./subscription-plans";

/** The iPhone SDK's StoreProduct, as far as the copy reads it (lib/subscription-plans.ts classifyStoreProduct etc.). */
interface StoreProductLike {
  productIdentifier: string;
  priceString: string;
  price: number;
  currencyCode: string;
  productType: "AUTO_RENEWABLE_SUBSCRIPTION" | "NON_CONSUMABLE" | "CONSUMABLE";
  subscriptionPeriod?: string;
  introPrice: { price: number; priceString: string; period: string | null; cycles: number } | null;
}

/** A RevenueCat package as lib/subscription-plans.ts reads it, carrying the real web package for the purchase. */
export interface WebPackage {
  identifier: string;
  packageType: string;
  product: StoreProductLike;
  /** The SDK's own package: what `purchases.purchase({ rcPackage })` takes. */
  rc: Package;
}

function storeProductOf(product: Product): StoreProductLike {
  const trial = product.freeTrialPhase;
  const intro = product.introPricePhase;
  return {
    productIdentifier: product.identifier,
    priceString: product.currentPrice.formattedPrice,
    price: product.currentPrice.amount,
    currencyCode: product.currentPrice.currency,
    productType: product.productType === "subscription" ? "AUTO_RENEWABLE_SUBSCRIPTION" : product.productType === "consumable" ? "CONSUMABLE" : "NON_CONSUMABLE",
    subscriptionPeriod: product.productType === "subscription" ? product.normalPeriodDuration ?? undefined : undefined,
    introPrice: trial
      ? { price: 0, priceString: "", period: trial.periodDuration, cycles: Math.max(1, trial.cycleCount) }
      : intro && intro.price
        ? { price: intro.price.amount, priceString: intro.price.formattedPrice, period: intro.periodDuration, cycles: Math.max(1, intro.cycleCount) }
        : null,
  };
}

export function webPackageOf(pkg: Package): WebPackage {
  return { identifier: pkg.identifier, packageType: pkg.packageType, product: storeProductOf(pkg.webBillingProduct ?? pkg.product), rc: pkg };
}

/** The plan a RevenueCat package type stands for, when the product id itself does not say (the web products may be named differently). */
const PLAN_BY_PACKAGE_TYPE: Record<string, PurchasePlan> = {
  "$rc_monthly": "monthly",
  "$rc_annual": "schoolYear",
  "$rc_lifetime": "degreePass",
};

/**
 * The three plans from the current web offering: by exact product id first (the App Store's ids, lib/subscription-plans.ts
 * PRODUCT_IDS), then, for a plan still without a package, by RevenueCat's package type ($rc_monthly, $rc_annual,
 * $rc_lifetime), which is how the Web Billing products are usually arranged.
 */
export function resolveWebOfferings(current: Offering | null | undefined): SubscriptionOffering {
  const packages = (current?.availablePackages ?? []).map(webPackageOf);
  const resolved = resolveOfferings({ availablePackages: packages });
  const taken = new Set<string>();
  for (const info of Object.values(resolved)) if (info.productIdentifier) taken.add(info.productIdentifier);
  for (const pkg of packages) {
    if (taken.has(pkg.product.productIdentifier) || planForProductId(pkg.product.productIdentifier)) continue;
    const plan = PLAN_BY_PACKAGE_TYPE[pkg.packageType];
    if (!plan || resolved[plan].package) continue;
    resolved[plan] = packageInfo(pkg);
    taken.add(pkg.product.productIdentifier);
  }
  return resolved;
}

const iso = (value: Date | string | null | undefined): string | null => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);

/** Trajectory Pro from the web SDK's CustomerInfo, by the same rule as the iPhone and the server (shared/term-pass.ts). */
export function proStatusFromWebCustomerInfo(info: CustomerInfo | null | undefined, now: Date): ProStatus {
  if (!info) return NOT_PRO_STATUS;
  const entitlement = info.entitlements?.active?.[PRO_ENTITLEMENT_ID];
  const shaped = {
    entitlements: {
      active: entitlement
        ? {
            [PRO_ENTITLEMENT_ID]: {
              productIdentifier: entitlement.productIdentifier,
              expirationDate: iso(entitlement.expirationDate),
              willRenew: entitlement.willRenew,
              latestPurchaseDate: iso(entitlement.latestPurchaseDate) ?? undefined,
            },
          }
        : {},
    },
    nonSubscriptionTransactions: (info.nonSubscriptionTransactions ?? []).map((t) => ({
      productIdentifier: t.productIdentifier,
      purchaseDate: iso(t.purchaseDate) ?? "",
      transactionIdentifier: t.transactionIdentifier,
    })),
    subscriptionsByProductIdentifier: Object.fromEntries(
      Object.entries(info.subscriptionsByProductIdentifier ?? {}).map(([key, sub]) => [
        key,
        {
          productIdentifier: sub.productIdentifier,
          expiresDate: iso(sub.expiresDate),
          gracePeriodExpiresDate: iso(sub.gracePeriodExpiresDate),
          isActive: sub.isActive,
          willRenew: sub.willRenew,
          refundedAt: iso(sub.refundedAt),
        },
      ]),
    ),
  };
  return proStatusFromCustomerInfo(shaped, now);
}
