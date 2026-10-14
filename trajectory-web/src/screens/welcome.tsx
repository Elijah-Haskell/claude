// The first screen, and the gate: a Trajectory account is required (lib/config.ts), so the welcome's only action is
// Continue with Apple. The plan is saved to that account (src/state/plan-sync-client.ts), which is what the line under
// the button says, and Trajectory Pro is tied to it.
//
// One screen, by lib/start-route.ts welcomeStage:
//   - "sign-in": signed out. The welcome, the Apple button, and "You've been signed out" when a session ended.
//   - "waiting" / "unreachable": signed in, while this browser's plan and the account's are brought together
//     ("Getting your plan…"), or when the account could not be reached (Try again, or Sign out).
//   - "enter": signed in and the plan settled. A new student's onboarding is completed here, then on to Today (and for
//     an empty plan straight on to the syllabus import); a restored plan goes to Today.
//   - "start": the browser preview (VITE_ACCOUNT_REQUIRED=false), which has no accounts: "Get started".

import { useCallback, useEffect, useRef, useState } from "react";

import { ACCOUNT_COPY } from "../engine/account-copy";
import { alpha } from "../engine/design";
import { WEBSITE_TERMS_URL } from "../shared/const";
import { mutate } from "../lib/api";
import { appleSignInAvailable, signInWithApple } from "../lib/apple-signin";
import { TEST_SIGN_IN } from "../lib/config";
import { completeSignIn } from "../lib/session";
import { enterStep, opensSyllabusUpload, RESTORE_WAIT_MS, WAITING_SLOW_MS, waitingExtras, welcomePreviewOf, welcomeStage } from "../lib/start-route";
import { navigate, useRoute } from "../router";
import { useGateInput } from "../state/account-gate";
import { useApp } from "../state/app-provider";
import { useAuth } from "../state/auth";
import { showAlert } from "../state/dialogs";
import { PREF_KEYS, writePref } from "../state/local-prefs";
import { usePlanSync } from "../state/plan-sync-client";
import { useSignOut } from "../state/use-sign-out";
import { Icon } from "../ui/icon";
import { MONO_FONT, Note, PrimaryButton } from "../ui/primitives";
import { useColors } from "../ui/theme";

function Picture() {
  const colors = useColors();
  const line = (width: string, tone = colors.border) => <span style={{ display: "block", height: 6, width, borderRadius: 3, background: tone }} />;
  return (
    <div aria-hidden style={{ display: "flex", alignItems: "center", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
      <div style={{ width: 150, padding: 14, borderRadius: 14, border: `1px solid ${colors.border}`, background: alpha(colors.surface, 0.8), display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, letterSpacing: 1.2, color: colors.muted }}>SYLLABUS</span>
        {line("90%", colors.borderStrong)}
        {line("70%")}
        {line("80%", alpha(colors.gold, 0.6))}
        {line("60%")}
        {line("85%", alpha(colors.gold, 0.6))}
        {line("50%")}
      </div>
      <Icon name="arrow" size={22} color={colors.peri} strokeWidth={2} />
      <div style={{ width: 170, padding: 14, borderRadius: 14, border: `1px solid ${colors.border}`, background: alpha(colors.surface, 0.8), display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, letterSpacing: 1.2, color: colors.peri }}>TODAY</span>
        <span style={{ display: "block", height: 22, borderRadius: 7, background: alpha(colors.primary, 0.2), borderLeft: `3px solid ${colors.primary}` }} />
        <span style={{ display: "block", height: 22, borderRadius: 7, border: `1px dashed ${alpha(colors.peri, 0.6)}` }} />
        <span style={{ display: "block", height: 22, borderRadius: 7, border: `1px solid ${alpha(colors.peri, 0.7)}` }} />
        <span style={{ display: "block", height: 22, borderRadius: 7, background: alpha(colors.muted, 0.1), border: `1px solid ${alpha(colors.muted, 0.3)}` }} />
      </div>
    </div>
  );
}

function Brand() {
  const colors = useColors();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 36, height: 36, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#0a0e24", border: `1px solid ${colors.borderStrong}` }}>
        <Icon name="bolt" size={20} color={colors.gold} strokeWidth={2} />
      </span>
      <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1.6, color: colors.foreground }}>TRAJECTORY</span>
    </div>
  );
}

/** Apple's own look for the button: black, white text, the Apple mark. */
function AppleButton({ onPress, busy }: { onPress: () => void; busy: boolean }) {
  return (
    <button type="button" className="pressable" onClick={onPress} disabled={busy} aria-label="Continue with Apple" style={{ width: "100%", height: 54, borderRadius: 14, border: "1px solid #fff", background: "#000", color: "#fff", fontSize: 17, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: busy ? 0.7 : 1, cursor: busy ? "default" : "pointer" }}>
      <svg width="18" height="22" viewBox="0 0 170 210" aria-hidden fill="#fff"><path d="M140.6 111.4c.3 33.3 29.2 44.4 29.5 44.5-.2.8-4.6 15.8-15.2 31.3-9.2 13.4-18.7 26.7-33.7 27-14.7.3-19.5-8.7-36.3-8.7-16.9 0-22.1 8.4-36.1 9-14.5.5-25.5-14.5-34.8-27.8C-5 159-14.7 109.6 4.9 76.4 14.6 60 32 49.6 50.9 49.3c14.3-.3 27.9 9.7 36.6 9.7 8.8 0 25.2-12 42.5-10.2 7.2.3 27.5 2.9 40.6 22-1.1.7-24.3 14.2-24 40.6M118.6 30.2c7.8-9.4 13-22.5 11.6-35.6-11.2.5-24.8 7.5-32.8 16.9-7.2 8.3-13.5 21.6-11.8 34.4 12.5 1 25.2-6.4 33-15.7"/></svg>
      Continue with Apple
    </button>
  );
}

export function WelcomeScreen() {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const { refresh: authRefresh, sessionEnded } = useAuth();
  const gate = useGateInput();
  const { retry, restoredFromAccount } = usePlanSync();
  const route = useRoute();
  // Preview switches only count where no account is required (the browser preview build).
  const preview = gate.accountRequired ? undefined : welcomePreviewOf(route.query.preview);
  const stage = welcomeStage({ ...gate, preview });
  const leaveSignIn = useSignOut({ fromWelcome: true });
  const [isSigningIn, setIsSigningIn] = useState(false);

  const planIsEmpty = state.classes.length === 0 && state.tasks.length === 0 && !state.semester;
  const opensUpload = opensSyllabusUpload({ planIsEmpty, restoredFromAccount });

  /** Into the app: Today, and for a first-time student straight on to the syllabus import. */
  const leaveOnboarding = useCallback(() => {
    writePref(PREF_KEYS.welcomeSeen, "1");
    navigate(opensUpload ? "syllabus" : "today", { replace: true });
  }, [opensUpload]);

  const [restoreOverdue, setRestoreOverdue] = useState(false);
  const step = enterStep({ stage, onboardingComplete: state.onboardingComplete, restoredFromAccount, restoreOverdue });
  useEffect(() => {
    if (step !== "wait-for-restore") return;
    const timer = setTimeout(() => setRestoreOverdue(true), RESTORE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [step]);
  useEffect(() => {
    if (step === "complete-onboarding") dispatch({ type: "COMPLETE_ONBOARDING" });
  }, [step, dispatch]);
  const left = useRef(false);
  useEffect(() => {
    if (step !== "leave" || left.current) return;
    left.current = true;
    leaveOnboarding();
  }, [step, leaveOnboarding]);

  const waiting = stage === "waiting";
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaitedLong(true), WAITING_SLOW_MS);
    return () => {
      clearTimeout(timer);
      setWaitedLong(false);
    };
  }, [waiting]);
  const extras = waitingExtras({ stage, planPhase: gate.planPhase, waitedLong });

  async function finishSignIn(credential: { identityToken: string; appleUserId: string; email?: string; givenName?: string; familyName?: string; authorizationCode?: string; nonce?: string }) {
    const result = await mutate("auth.apple", credential, { quiet: true, timeoutMs: 20_000 });
    const account = await completeSignIn(result);
    if (!account || !(await authRefresh())) throw new Error("We could not sign you in. Please try again.");
  }

  async function handleAppleSignIn() {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      const credential = await signInWithApple();
      if (credential) await finishSignIn(credential);
    } catch (error) {
      void showAlert({ title: "Sign in unavailable", message: error instanceof Error ? error.message : "We could not sign you in. Please try again.", buttons: [{ text: "OK" }] });
    } finally {
      setIsSigningIn(false);
    }
  }

  /** Build-time only (VITE_TEST_SIGN_IN=1): a sign-in the mock server accepts, for the smoke test. */
  async function handleTestSignIn() {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      await finishSignIn({ identityToken: "test.identity.token-for-the-mock-server", appleUserId: "test-student", email: "student@example.com", givenName: "Test", familyName: "Student" });
    } catch (error) {
      void showAlert({ title: "Sign in unavailable", message: error instanceof Error ? error.message : "We could not sign you in.", buttons: [{ text: "OK" }] });
    } finally {
      setIsSigningIn(false);
    }
  }

  /** The browser preview's way in: no account there. */
  function handleGetStarted(where: "today" | "syllabus") {
    writePref(PREF_KEYS.welcomeSeen, "1");
    if (!state.onboardingComplete) dispatch({ type: "COMPLETE_ONBOARDING" });
    navigate(where, { replace: true });
  }

  const quietSignOut = (
    <button type="button" className="link" onClick={preview ? undefined : leaveSignIn} aria-label="Sign out" style={{ minHeight: 44, alignSelf: "center", fontSize: 14, fontWeight: 600, color: colors.muted }}>Sign out</button>
  );
  const welcome = stage === "start" || stage === "sign-in";
  const showSignedOutNotice = stage === "sign-in" && (preview ? preview === "account-signed-out" : sessionEnded);
  const accountLine = ACCOUNT_COPY.line;

  return (
    <div className="app" style={{ display: "block" }}>
      <main className="app-main" style={{ maxWidth: 640, minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 20px 32px", gap: 26 }}>
        <Brand />
        {welcome ? (
          <>
            <Picture />
            <div>
              <div className="eyebrow" style={{ marginBottom: 10, color: colors.peri }}>One upload · whole semester</div>
              <h1 style={{ margin: 0, fontSize: 34, lineHeight: "38px", fontWeight: 800, letterSpacing: -0.9, color: colors.foreground }}>
                Your semester, <span style={{ color: colors.peri }}>planned from your syllabus.</span>
              </h1>
              <p style={{ margin: "12px 0 0", fontSize: 15.5, lineHeight: "23px", color: colors.muted }}>
                Upload it once. Trajectory finds your deadlines, plans study time around your classes, and replans when something changes.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {stage === "start" ? (
                <>
                  <PrimaryButton size="lg" fullWidth label={planIsEmpty ? "Start with a syllabus" : "Open my plan"} onPress={() => handleGetStarted(planIsEmpty ? "syllabus" : "today")} />
                  {planIsEmpty ? <PrimaryButton size="lg" fullWidth tone="ghost" label="Set up by hand" onPress={() => handleGetStarted("today")} /> : null}
                  <p className="caption" style={{ textAlign: "center", margin: 0 }}>Browser preview. Sign in with Apple and the saved plan are in the full app.</p>
                </>
              ) : (
                <>
                  {showSignedOutNotice ? <Note tone="blue" icon="info" role="alert">{ACCOUNT_COPY.signedOutNotice}</Note> : null}
                  {appleSignInAvailable() ? (
                    <AppleButton onPress={() => void handleAppleSignIn()} busy={isSigningIn} />
                  ) : (
                    <Note tone="gold" icon="info">Sign in with Apple is not set up for this website yet (no Services ID configured). The iPhone app signs in as usual.</Note>
                  )}
                  {TEST_SIGN_IN ? <PrimaryButton size="lg" fullWidth tone="ghost" label="Test sign-in" onPress={() => void handleTestSignIn()} disabled={isSigningIn} /> : null}
                  {isSigningIn ? <p className="caption" style={{ textAlign: "center", margin: 0 }}>Signing you in…</p> : null}
                  <p className="caption" style={{ textAlign: "center", margin: 0 }}>{accountLine}</p>
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 22, minHeight: 22 }}>
                    <button type="button" className="link" onClick={() => navigate("privacy-policy")} style={{ fontSize: 13, fontWeight: 500, color: colors.muted, minHeight: 44 }}>Privacy Policy</button>
                    <a className="link" href={WEBSITE_TERMS_URL} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 500, color: colors.muted, minHeight: 44, display: "inline-flex", alignItems: "center" }}>Terms</a>
                  </div>
                </>
              )}
            </div>
          </>
        ) : stage === "unreachable" ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "24px 0" }}>
              <h1 style={{ margin: 0, fontSize: 28, lineHeight: "34px", fontWeight: 800, letterSpacing: -0.8, color: colors.foreground }}>{ACCOUNT_COPY.unreachableTitle}</h1>
              <p style={{ margin: 0, fontSize: 15, lineHeight: "22px", color: colors.muted }}>{ACCOUNT_COPY.unreachableBody}</p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <PrimaryButton size="lg" fullWidth label="Try again" left={<Icon name="refresh" size={18} color="#fff" />} onPress={retry} />
              {quietSignOut}
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "24px 0", alignItems: "flex-start" }} aria-live="polite" aria-label={stage === "loading" ? "Loading" : extras.slowLine ? `${ACCOUNT_COPY.gettingPlan} ${ACCOUNT_COPY.gettingPlanSlow}` : ACCOUNT_COPY.gettingPlan}>
              <span className="spinner" />
              {stage === "loading" ? null : <h1 style={{ margin: 0, fontSize: 28, lineHeight: "34px", fontWeight: 800, letterSpacing: -0.8, color: colors.foreground }}>{ACCOUNT_COPY.gettingPlan}</h1>}
              {extras.slowLine ? <p style={{ margin: 0, fontSize: 15, lineHeight: "22px", color: colors.muted }}>{ACCOUNT_COPY.gettingPlanSlow}</p> : null}
            </div>
            {extras.signOut ? <div style={{ display: "flex", flexDirection: "column" }}>{quietSignOut}</div> : null}
          </>
        )}
      </main>
    </div>
  );
}

/** The brand and a spinner while the account is being read: what the app shows before it knows where to open. */
export function LaunchMark({ line }: { line?: string }) {
  const colors = useColors();
  return (
    <div className="app" style={{ display: "block" }}>
      <main className="app-main" style={{ maxWidth: 640, minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 18, padding: 20 }} aria-live="polite" aria-label={line ?? "Loading"}>
        <Brand />
        <span className="spinner" />
        {line ? <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: colors.muted }}>{line}</p> : null}
      </main>
    </div>
  );
}
