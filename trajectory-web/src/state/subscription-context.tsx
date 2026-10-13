/**
 * Trajectory Pro in the browser (the iPhone app's lib/subscription-context.tsx on RevenueCat's Web Billing SDK).
 *
 * - Pro is tied to the account: RevenueCat's app user id follows the session (lib/pro-identity.ts
 *   revenueCatIdForSession), so the server, which asks RevenueCat about the same id, agrees on who holds Pro. Signed
 *   out, the SDK runs under an anonymous id kept in this browser.
 * - Every CustomerInfo the app gets (configure, an identity change, a purchase, the check after a server refusal) goes
 *   through one place, applyInfo, and the Pro rule is the shared one (lib/revenuecat-web.ts, shared/term-pass.ts).
 * - A purchase opens RevenueCat's checkout; afterwards the server is asked to drop its cached "not Pro".
 * - When the server refuses a call as "needs Pro" while this browser shows Pro, the identity is linked again, the
 *   server re-checks, and the call is sent once more (lib/sign-in-prompt.ts noteForbiddenResponse).
 * The web has no receipts to restore: "Restore purchases" reads the customer info again and has the server re-check.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorCode, Purchases, type CustomerInfo, type PurchasesError } from "@revenuecat/purchases-js";

import { mutate } from "../lib/api";
import { REVENUECAT_WEB_KEY, TEST_PRO } from "../lib/config";
import { identityStep, reconcileProRefusal, revenueCatIdForSession, singleFlight, type ProRefusalOutcome } from "../lib/pro-identity";
import { proStatusFromWebCustomerInfo, resolveWebOfferings, type WebPackage } from "../lib/revenuecat-web";
import { createPromptDebouncer, paywallPromptCopy, proMismatchCopy, setProRefusalHandler, subscribePaywallPrompt } from "../lib/sign-in-prompt";
import { readLocal, writeLocal } from "../lib/storage";
import { NOT_PRO_STATUS, sameProStatus, UNAVAILABLE_OFFERINGS, type ProStatus, type PurchasePlan, type SubscriptionOffering } from "../lib/subscription-plans";
import type { ProAccessSource } from "../shared/term-pass";
import { navigate } from "../router";
import { showAlert } from "./dialogs";
import { useAuth } from "./auth";

export { PLAN_CATALOG, type ProStatus, type PurchasePlan, type SubscriptionOffering, type SubscriptionPackageInfo } from "../lib/subscription-plans";

/** The anonymous RevenueCat id this browser uses while nobody is signed in (so a purchase made signed out is found again). */
const ANONYMOUS_ID_KEY = "trajectory_web_rc_anonymous_id";
/** Longest a refused call waits while a Pro mismatch is reconciled (RevenueCat + the server re-check). */
const RECONCILE_TIMEOUT_MS = 15_000;
/** setTimeout's ceiling (about 24.8 days): a pass ending later is re-checked when this fires, then again. */
const MAX_TIMER_MS = 2_147_483_647;

function anonymousId(): string {
  const stored = readLocal(ANONYMOUS_ID_KEY);
  if (stored) return stored;
  const fresh = Purchases.generateRevenueCatAnonymousAppUserId();
  writeLocal(ANONYMOUS_ID_KEY, fresh);
  return fresh;
}

/** Asks the server to check Pro for this account again now. true / false, or null when it could not be asked. */
export async function recheckProOnServer(): Promise<boolean | null> {
  try {
    const { pro } = await mutate("account.recheckPro", undefined, { quiet: true, timeoutMs: 15_000 });
    return pro;
  } catch {
    return null;
  }
}

interface SubscriptionContextValue {
  isPro: boolean;
  /** True until RevenueCat has reported the entitlement. Never treat !isPro as "free" while this is true. */
  isLoading: boolean;
  proSource: ProAccessSource | null;
  proUntil: string | null;
  willRenew: boolean | null;
  proProductId: string | null;
  termPass: ProStatus["termPass"];
  offerings: SubscriptionOffering | null;
  /** RevenueCat's page for managing a web subscription, when it has one. */
  managementUrl: string | null;
  /** Whether purchases can work in this build at all (a Web Billing key is configured). */
  purchasesConfigured: boolean;
  purchasePlan: (plan: PurchasePlan) => Promise<boolean>;
  restorePurchases: () => Promise<boolean>;
  refreshStatus: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
  isPro: false, isLoading: true, proSource: null, proUntil: null, willRenew: null, proProductId: null, termPass: null, offerings: null, managementUrl: null, purchasesConfigured: false,
  purchasePlan: async () => false, restorePurchases: async () => false, refreshStatus: async () => {},
});

const statusOf = (info: CustomerInfo | null): ProStatus => proStatusFromWebCustomerInfo(info, new Date());

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ProStatus>(NOT_PRO_STATUS);
  const [isLoading, setIsLoading] = useState(true);
  const [offerings, setOfferings] = useState<SubscriptionOffering | null>(null);
  const [managementUrl, setManagementUrl] = useState<string | null>(null);
  const [passTimerTick, setPassTimerTick] = useState(0);
  const purchasesRef = useRef<Purchases | null>(null);
  const identityQueue = useRef<Promise<unknown>>(Promise.resolve());
  const initDone = useRef(false);
  const loggingIn = useRef(false);
  const lastInfo = useRef<CustomerInfo | null>(null);
  const isProRef = useRef(status.isPro);
  isProRef.current = status.isPro;
  const { user, loading: authLoading } = useAuth();
  const desiredId = revenueCatIdForSession(user);
  const desiredRef = useRef(desiredId);
  desiredRef.current = desiredId;
  const configured = REVENUECAT_WEB_KEY.trim() !== "";

  /** The one place Pro is set. */
  const applyInfo = useCallback((info: CustomerInfo | null): ProStatus => {
    lastInfo.current = info;
    const next = statusOf(info);
    setStatus((prev) => (sameProStatus(prev, next) ? prev : next));
    setManagementUrl(info?.managementURL ?? null);
    return next;
  }, []);

  const refreshStatus = useCallback(async () => {
    const purchases = purchasesRef.current;
    if (!purchases) {
      setIsLoading(false);
      return;
    }
    try {
      applyInfo(await purchases.getCustomerInfo());
    } catch {
      /* keep the last known entitlement */
    }
  }, [applyInfo]);

  // Configure once the account is known, under the account's id (or the browser's anonymous one), then load offerings.
  useEffect(() => {
    if (authLoading || purchasesRef.current || !configured) {
      // No web key: nothing to sell here, and Pro comes from the server (the effect below).
      if (!configured) setOfferings(UNAVAILABLE_OFFERINGS);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const purchases = Purchases.isConfigured() ? Purchases.getSharedInstance() : Purchases.configure({ apiKey: REVENUECAT_WEB_KEY, appUserId: desiredRef.current ?? anonymousId() });
        if (cancelled) return;
        purchasesRef.current = purchases;
        applyInfo(await purchases.getCustomerInfo());
        const all = await purchases.getOfferings();
        if (cancelled) return;
        setOfferings(resolveWebOfferings(all.current ?? Object.values(all.all)[0] ?? null));
      } catch (error) {
        console.warn("[RevenueCat] init error:", error instanceof Error ? error.message : error);
        setOfferings(UNAVAILABLE_OFFERINGS);
      } finally {
        initDone.current = true;
        if (!loggingIn.current) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, configured, applyInfo]);

  // Without a RevenueCat web key the browser cannot read the entitlement itself, but the server can: it checks
  // RevenueCat under the account's id. So Pro bought on the iPhone, or granted in the RevenueCat dashboard, counts here.
  // The server answers yes or no only, so the source stays unknown (the Pro row then just says it is active).
  useEffect(() => {
    if (configured || authLoading) return;
    if (!desiredId) {
      setStatus((prev) => (sameProStatus(prev, NOT_PRO_STATUS) ? prev : NOT_PRO_STATUS));
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void recheckProOnServer().then((pro) => {
      if (cancelled) return;
      const next: ProStatus = pro ? { ...NOT_PRO_STATUS, isPro: true } : NOT_PRO_STATUS;
      setStatus((prev) => (sameProStatus(prev, next) ? prev : next));
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [configured, authLoading, desiredId]);

  // A School Year pass ends at a moment, with no RevenueCat update: read the last CustomerInfo again then.
  useEffect(() => {
    if (status.source !== "term" || !status.until) return;
    const wait = Date.parse(status.until) - Date.now();
    if (!Number.isFinite(wait)) return;
    const timer = setTimeout(() => {
      if (lastInfo.current) applyInfo(lastInfo.current);
      setPassTimerTick((n) => n + 1);
    }, Math.min(Math.max(wait + 1_000, 1_000), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [status.source, status.until, passTimerTick, applyInfo]);

  /** Makes RevenueCat's identity match `desired` (the account's id, or anonymous while signed out), queued. */
  const syncIdentity = useCallback((desired: string | null, force = false): Promise<boolean | null> => {
    const run = identityQueue.current.then(async (): Promise<boolean | null> => {
      const purchases = purchasesRef.current;
      if (!purchases) return null;
      try {
        const current = purchases.getAppUserId();
        const step = identityStep(current, desired, purchases.isAnonymous());
        if (step === "none" && !force) return null;
        const showLoading = step === "logIn";
        if (showLoading) {
          loggingIn.current = true;
          setIsLoading(true);
        }
        try {
          const info = await purchases.changeUser(desired ?? anonymousId());
          const pro = applyInfo(info).isPro;
          if (pro && desired && step === "logIn") void recheckProOnServer();
          return pro;
        } finally {
          if (showLoading) {
            loggingIn.current = false;
            if (initDone.current) setIsLoading(false);
          }
        }
      } catch (error) {
        console.warn("[RevenueCat] identity sync failed:", error instanceof Error ? error.message : error);
        return null;
      }
    });
    identityQueue.current = run;
    return run;
  }, [applyInfo]);

  useEffect(() => {
    if (authLoading || !purchasesRef.current) return;
    void syncIdentity(desiredId);
  }, [authLoading, desiredId, syncIdentity, isLoading]);

  const purchasePlan = useCallback(async (plan: PurchasePlan): Promise<boolean> => {
    const purchases = purchasesRef.current;
    const pkg = offerings?.[plan]?.package as WebPackage | null | undefined;
    if (!purchases || !pkg?.rc) return false;
    try {
      // The purchase belongs to the id the server asks about: RevenueCat is logged in with the account first.
      if (desiredRef.current) await syncIdentity(desiredRef.current);
      const result = await purchases.purchase({ rcPackage: pkg.rc, customerEmail: user?.email ?? undefined });
      const pro = applyInfo(result.customerInfo).isPro;
      if (pro) void recheckProOnServer();
      return pro;
    } catch (error) {
      if ((error as PurchasesError | null)?.errorCode !== ErrorCode.UserCancelledError) console.warn("[RevenueCat] purchase error:", error instanceof Error ? error.message : error);
      return false;
    }
  }, [offerings, syncIdentity, applyInfo, user?.email]);

  const restorePurchases = useCallback(async (): Promise<boolean> => {
    const purchases = purchasesRef.current;
    if (!purchases) return false;
    try {
      if (desiredRef.current) await syncIdentity(desiredRef.current, true);
      const pro = applyInfo(await purchases.getCustomerInfo()).isPro;
      if (pro) void recheckProOnServer();
      return pro;
    } catch (error) {
      console.warn("[RevenueCat] restore error:", error instanceof Error ? error.message : error);
      return false;
    }
  }, [syncIdentity, applyInfo]);

  // The server refused a call as "needs Pro": if this browser holds Pro, link the identity again, have the server
  // re-check, and let the API client re-send the call once.
  useEffect(() => {
    if (!configured) return;
    const reconcile = singleFlight(() =>
      reconcileProRefusal({
        devicePro: async () => {
          await identityQueue.current;
          const purchases = purchasesRef.current;
          return purchases ? applyInfo(await purchases.getCustomerInfo()).isPro : false;
        },
        // The web has no receipts to sync: the fresh customer info above is all there is.
        syncDevice: async () => false,
        relink: async () => (await syncIdentity(desiredRef.current, true)) ?? isProRef.current,
        recheckServer: recheckProOnServer,
      }),
    );
    return setProRefusalHandler(() =>
      Promise.race([
        reconcile(),
        new Promise<ProRefusalOutcome>((resolve) => setTimeout(() => resolve(isProRef.current ? "unconfirmed" : "needs-pro"), RECONCILE_TIMEOUT_MS)),
      ]),
    );
  }, [configured, syncIdentity, applyInfo]);

  // One prompt per refusal burst: the paywall when this browser has no Pro; when it has Pro, never "buy Pro".
  useEffect(() => {
    const debouncer = createPromptDebouncer();
    return subscribePaywallPrompt((event) => {
      if (!event.outcome) void refreshStatus();
      if (!debouncer.shouldShow()) return;
      if (event.outcome) {
        const copy = proMismatchCopy(event.outcome);
        void showAlert({
          title: copy.title,
          message: copy.message.replace("This iPhone shows", "This browser shows"),
          icon: "crown",
          buttons:
            event.outcome === "confirmed"
              ? [{ text: "OK", onPress: () => debouncer.reset() }]
              : [
                  {
                    text: "Restore Purchases",
                    onPress: () => {
                      debouncer.reset();
                      void restorePurchases().then((restored) =>
                        showAlert({
                          title: restored ? "Trajectory Pro restored" : "No purchase found",
                          message: restored ? "Try again now." : "We couldn't find an active Trajectory Pro purchase for this account.",
                          buttons: [{ text: "OK" }],
                        }),
                      );
                    },
                  },
                  { text: "Not now", style: "cancel", onPress: () => debouncer.reset() },
                ],
        });
        return;
      }
      const copy = paywallPromptCopy(event.code);
      void showAlert({
        title: copy.title,
        message: copy.message,
        icon: "crown",
        buttons: [
          { text: "See Pro plans", onPress: () => { debouncer.reset(); navigate("paywall"); } },
          { text: "Not now", style: "cancel", onPress: () => debouncer.reset() },
        ],
      });
    });
  }, [refreshStatus, restorePurchases]);

  return (
    <SubscriptionContext.Provider
      value={{
        isPro: status.isPro,
        isLoading,
        proSource: status.source,
        proUntil: status.until,
        willRenew: status.willRenew,
        proProductId: status.productId,
        termPass: status.termPass,
        offerings,
        managementUrl,
        purchasesConfigured: configured,
        purchasePlan,
        restorePurchases,
        refreshStatus,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionContextValue {
  return useContext(SubscriptionContext);
}

/** The student's Pro in full, as a ProStatus for the wording helpers in lib/subscription-plans.ts. */
export function useProDetails(): ProStatus & { isLoading: boolean } {
  const { isPro, isLoading, proSource, proUntil, willRenew, proProductId, termPass } = useSubscription();
  // A test build holds Pro itself (lib/config.ts TEST_PRO): the browser only learns Pro from RevenueCat, which the
  // mock server's builds have no key for. Compiled out of every other build.
  if (TEST_PRO) return { isPro: true, source: "subscription", until: null, willRenew: true, productId: null, termPass: null, isLoading: false };
  return { isPro, source: proSource, until: proUntil, willRenew, productId: proProductId, termPass, isLoading };
}

/** Entitlement + whether it is still being determined. */
export function useProStatus(): { isPro: boolean; isLoading: boolean } {
  const { isPro, isLoading } = useProDetails();
  return { isPro, isLoading };
}

export function useIsPro(): boolean {
  return useProStatus().isPro;
}
