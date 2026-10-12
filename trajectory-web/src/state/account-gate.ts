/**
 * The facts the gate decides from (lib/start-route.ts), read in one place: the app's root, the tabs and the welcome
 * screen each ask a different question, but always about the same situation (the iPhone app's hooks/use-account-gate.ts).
 */
import { useEffect, useState } from "react";

import { accountRequired } from "../lib/config";
import { holdsNoPlan, noteEmptyAtSignIn } from "../lib/sign-out-flow";
import { PLAN_SETTLE_MS, type StartRouteInput } from "../lib/start-route";
import { useApp } from "./app-provider";
import { useAccountStatus } from "./auth";
import { usePlanSync } from "./plan-sync-client";

export function useGateInput(): StartRouteInput {
  const { state, isHydrated } = useApp();
  const account = useAccountStatus();
  const { phase } = usePlanSync();
  return { hydrated: isHydrated, onboardingComplete: state.onboardingComplete, accountRequired: accountRequired(), account, planPhase: phase };
}

/**
 * useGateInput() with `settling`: true for the first PLAN_SETTLE_MS after the account and the plan in this browser are
 * both known. A signed-in student's saved plan passes through "checking" on its way to "ready" at every launch, for a
 * few milliseconds and without the network; in that moment it is not a wait worth a screen.
 */
export function useSettlingGateInput(): StartRouteInput {
  const gate = useGateInput();
  const known = gate.hydrated && gate.account === "signed-in";
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    if (!known) return;
    const timer = setTimeout(() => setSettling(false), PLAN_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [known]);
  return { ...gate, settling };
}

// ── What this browser held when its account signed in ─────────
// The welcome screen's quiet "Sign out" erases the browser's plan only when no plan of the student's own can be in it
// (lib/sign-out-flow.ts). Noted at the moment of the sign-in, by a hook the app mounts once, and kept outside React.
let emptyAtSignIn: boolean | null = null;

/** Mount once, at the root (AccountGuard). */
export function useNoteEmptyAtSignIn(): void {
  const gate = useGateInput();
  const empty = holdsNoPlan(useApp().state);
  const planReady = gate.planPhase === "ready";
  useEffect(() => {
    emptyAtSignIn = noteEmptyAtSignIn(emptyAtSignIn, { account: gate.account, hydrated: gate.hydrated, empty, planReady });
  }, [gate.account, gate.hydrated, empty, planReady]);
}

/** As noted by useNoteEmptyAtSignIn(); null when nobody is signed in or it is not known. */
export function emptyAtSignInNow(): boolean | null {
  return emptyAtSignIn;
}
