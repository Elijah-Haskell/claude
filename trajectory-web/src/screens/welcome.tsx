// The first screen on a first visit: the brand, what the app does in one picture (a syllabus becomes a planned day),
// the headline and the lede, and "Get started". There is no account on the web: the plan lives in this browser.

import { alpha } from "../engine/design";
import { useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { PREF_KEYS, writePref } from "../state/local-prefs";
import { Icon } from "../ui/icon";
import { MONO_FONT, PrimaryButton } from "../ui/primitives";
import { useColors } from "../ui/theme";

function Picture() {
  const colors = useColors();
  const line = (width: string, tone = colors.border) => <span style={{ display: "block", height: 6, width, borderRadius: 3, background: tone }} />;
  return (
    <div aria-hidden style={{ display: "flex", alignItems: "center", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
      {/* the syllabus */}
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
      {/* the day */}
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

export function WelcomeScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch } = useApp();
  const planIsEmpty = state.classes.length === 0 && state.tasks.length === 0 && !state.semester;

  function start(where: "today" | "syllabus") {
    writePref(PREF_KEYS.welcomeSeen, "1");
    if (!state.onboardingComplete) dispatch({ type: "COMPLETE_ONBOARDING" });
    navigate(where, { replace: true });
  }

  return (
    <div className="app" style={{ display: "block" }}>
      <main className="app-main" style={{ maxWidth: 640, minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 20px 32px", gap: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#0a0e24", border: `1px solid ${colors.borderStrong}` }}>
            <Icon name="bolt" size={20} color={colors.gold} strokeWidth={2} />
          </span>
          <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1.6, color: colors.foreground }}>TRAJECTORY</span>
        </div>
        <Picture />
        <div>
          <div className="eyebrow" style={{ marginBottom: 10, color: colors.peri }}>One syllabus · whole semester</div>
          <h1 style={{ margin: 0, fontSize: 34, lineHeight: "38px", fontWeight: 800, letterSpacing: -0.9, color: colors.foreground }}>
            Your semester, <span style={{ color: colors.peri }}>planned from your syllabus.</span>
          </h1>
          <p style={{ margin: "12px 0 0", fontSize: 15.5, lineHeight: "23px", color: colors.muted }}>
            Paste it in once. Trajectory finds your deadlines, plans study time around your classes, and replans when something changes. Everything stays in this browser.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <PrimaryButton size="lg" fullWidth label={planIsEmpty ? "Start with a syllabus" : "Open my plan"} onPress={() => start(planIsEmpty ? "syllabus" : "today")} />
          {planIsEmpty ? <PrimaryButton size="lg" fullWidth tone="ghost" label="Set up by hand" onPress={() => start("today")} /> : null}
          <p className="caption" style={{ textAlign: "center", margin: 0 }}>No account. Your plan is saved on this device, and you can export a backup any time.</p>
        </div>
      </main>
    </div>
  );
}
