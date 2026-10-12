import { useCallback, useEffect } from "react";

import { decideProGate, shouldRedirectToPaywall } from "../lib/subscription-plans";
import { navigate } from "../router";
import { useProStatus } from "./subscription-context";

/**
 * Returns a function that checks Pro status and opens the paywall if needed:
 *   const requirePro = useProGate();
 *   if (!requirePro()) return; // opens the paywall for free users; does nothing while entitlement is loading
 * While RevenueCat is still reporting the entitlement the call returns false WITHOUT opening the paywall, so a paying
 * student is never bounced at launch.
 */
export function useProGate(): () => boolean {
  const { isPro, isLoading } = useProStatus();
  return useCallback((): boolean => {
    const decision = decideProGate({ isPro, isLoading });
    if (decision === "allow") return true;
    if (decision === "paywall") navigate("paywall");
    return false;
  }, [isPro, isLoading]);
}

/** For screens that are Pro-only when opened directly: to the paywall once the entitlement is known and the student is not Pro. */
export function useRedirectToPaywallIfNotPro(): void {
  const { isPro, isLoading } = useProStatus();
  useEffect(() => {
    if (shouldRedirectToPaywall({ isPro, isLoading })) navigate("paywall", { replace: true });
  }, [isPro, isLoading]);
}
