// Trajectory Pro, on one screen: what it adds (three lines), the plans, and the button. "Compare Free and Pro" opens
// the full table for anyone who wants it; it is not in the way of the price. Every price and term string comes from
// the store (the RevenueCat offering); nothing here is hardcoded. What each plan is (auto-renewing, a School Year
// pass of one payment, or one-time for good) decides its billing line and fine print (lib/subscription-plans.ts).

import { useState } from "react";

import { WEBSITE_TERMS_URL } from "../shared/const";
import { PLAN_CATALOG, PLAN_SHORT_TITLE, paywallOwnershipNote, planBadge, planLegalText, type PurchasePlan } from "../lib/subscription-plans";
import { goBack, navigate } from "../router";
import { showAlert } from "../state/dialogs";
import { useProDetails, useSubscription } from "../state/subscription-context";
import { Icon, type IconName } from "../ui/icon";
import { CloseButton, MONO_FONT, Note, PrimaryButton } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

/** What Pro adds, in three lines (the table behind "Compare Free and Pro" has the rest). */
const BENEFITS: { icon: IconName; title: string; sub: string }[] = [
  { icon: "layers", title: "Every class in one plan", sub: "Add all your syllabi" },
  { icon: "spark", title: "Ask AI to replan", sub: "Say what changed and preview the new plan" },
  { icon: "cap", title: "Exam prep", sub: "Study guides, flashcards and practice quizzes" },
];

// The comparison table: [feature, free, pro]. true = included, false = not included, a string = said in words.
const COMPARISON_ROWS: { label: string; free: boolean | string; pro: boolean | string }[] = [
  { label: "Semester setup, syllabus to schedule", free: "1 syllabus", pro: "Unlimited" },
  { label: "Ask AI (replans for you)", free: false, pro: true },
  { label: "Exam Prep & study guides", free: false, pro: true },
  { label: "Automatic replanning", free: true, pro: true },
  { label: "Week & Today views", free: true, pro: true },
  { label: "Tasks & deadlines", free: true, pro: true },
  { label: "Manual schedule blocks", free: true, pro: true },
  { label: "Semester calendar", free: true, pro: true },
  { label: "Course site link keeps dates current", free: true, pro: true },
  { label: "Saved to your account, on every device", free: true, pro: true },
];

function CellValue({ value, isPro }: { value: boolean | string; isPro: boolean }) {
  const colors = useColors();
  if (value === true) return <Icon name="check" size={18} color={colors.success} strokeWidth={2.2} />;
  if (value === false) return <span style={{ color: colors.muted, fontSize: 16 }} aria-label="Not included">–</span>;
  return <span style={{ fontFamily: MONO_FONT, fontSize: 12, textAlign: "center", color: isPro ? colors.peri : colors.muted, fontWeight: isPro ? 600 : 500 }}>{value}</span>;
}

function PlanTag({ label, tone }: { label: string; tone: "green" | "gold" }) {
  const colors = useColors();
  const base = tone === "green" ? colors.success : colors.gold;
  return <span style={{ height: 22, padding: "0 7px", borderRadius: 6, border: `1px solid ${base}80`, background: `${base}24`, color: base, fontFamily: MONO_FONT, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", display: "inline-flex", alignItems: "center" }}>{label}</span>;
}

/** The fine print, said for the web: a web subscription is managed from Settings, not the App Store. */
function webLegalText(text: string | null): string | null {
  return text?.replace("Manage or cancel it in your App Store account settings.", "Manage or cancel it from Settings → Trajectory Pro.") ?? null;
}

export function PaywallScreen() {
  const colors = useColors();
  const { offerings, purchasePlan, restorePurchases, isLoading, purchasesConfigured } = useSubscription();
  const pro = useProDetails();
  const [selectedPlan, setSelectedPlan] = useState<PurchasePlan>("schoolYear");
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [comparing, setComparing] = useState(false);

  const selectedOffering = offerings?.[selectedPlan] ?? null;
  const planOptions = Object.keys(PLAN_CATALOG) as PurchasePlan[];
  const ownershipNote = pro.isLoading ? null : paywallOwnershipNote(pro, selectedOffering)?.replace("App Store subscription", "subscription").replace(" cancel it in your App Store account settings if you don't want it to renew", " cancel it from Settings if you don't want it to renew") ?? null;
  const legalText = webLegalText(planLegalText(selectedOffering));
  const close = () => goBack("settings");

  function ctaLabel(): string {
    if (selectedOffering?.hasFreeTrial && selectedOffering.introOffer) return `Start ${selectedOffering.introOffer}`;
    if (selectedOffering?.kind === "term" && pro.source === "term") return selectedOffering.termMonths === 12 ? "Get another year" : "Buy another pass";
    return "Continue";
  }

  async function handlePurchase() {
    if (!selectedOffering?.package) {
      void showAlert({ title: "Purchases unavailable", message: "Trajectory Pro is temporarily unavailable. Please try again later.", buttons: [{ text: "OK" }] });
      return;
    }
    setPurchasing(true);
    try {
      if (await purchasePlan(selectedPlan)) close();
    } finally {
      setPurchasing(false);
    }
  }

  async function handleRestore() {
    setRestoring(true);
    try {
      const restored = await restorePurchases();
      if (restored) {
        await showAlert({ title: "Trajectory Pro restored", message: "Your purchase is active in this browser again.", buttons: [{ text: "OK" }] });
        close();
      } else {
        void showAlert({ title: "No purchase found", message: "We couldn't find an active Trajectory Pro purchase for this account. A purchase made in the iPhone app shows here once that iPhone has signed in with the same Apple Account.", buttons: [{ text: "OK" }] });
      }
    } finally {
      setRestoring(false);
    }
  }

  const storeUnavailable = !isLoading && !selectedOffering?.package;

  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="eyebrow" style={{ color: colors.peri, fontSize: 12 }}>Trajectory Pro</span>
        <CloseButton onPress={close} />
      </div>
      <h1 className="screen-title" style={{ fontSize: 30, lineHeight: "35px", letterSpacing: -0.75, margin: "6px 0 0" }}>
        Plan every class, <span style={{ color: colors.peri, fontWeight: 800 }}>not just one.</span>
      </h1>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        {BENEFITS.map((benefit) => (
          <div key={benefit.title} style={{ display: "flex", alignItems: "flex-start", gap: 12 }} aria-label={`${benefit.title}: ${benefit.sub}`}>
            <span style={{ width: 38, height: 38, borderRadius: 11, background: `${colors.violet}29`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon name={benefit.icon} size={20} color={colors.violet} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{benefit.title}</span>
              <span style={{ display: "block", fontSize: 13, lineHeight: "18px", color: colors.muted }}>{benefit.sub}</span>
            </span>
          </div>
        ))}
      </div>

      {!purchasesConfigured ? (
        pro.isPro ? (
          <Note tone="green" icon="check">Trajectory Pro is active on your account.</Note>
        ) : (
          <Note tone="blue" icon="info">Trajectory Pro isn&apos;t sold on the website yet. If your account already has Pro, it&apos;s active here as soon as you sign in.</Note>
        )
      ) : null}

      {purchasesConfigured ? (
        <>

      <div role="radiogroup" aria-label="Plans" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
        {planOptions.map((plan) => {
          const offering = offerings?.[plan];
          const selected = selectedPlan === plan;
          const badge = planBadge(plan, offerings);
          const payOnce = offering?.kind === "term" || offering?.kind === "lifetime";
          const showBadge = badge && !(payOnce && badge.label.toUpperCase() === "PAY ONCE");
          return (
            <button
              key={plan}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setSelectedPlan(plan)}
              aria-label={`${PLAN_CATALOG[plan].title}${badge ? `, ${badge.accessibilityLabel}` : ""}, ${offering?.priceString ?? "price unavailable"}${offering?.billing ? `, ${offering.billing.replace(/ · /g, ", ")}` : ""}`}
              className="pressable"
              style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 66, padding: "10px 14px", borderRadius: 14, border: `1px solid ${selected ? colors.accent : colors.borderStrong}`, background: selected ? `${colors.primary}29` : colors.surface, textAlign: "left", color: "inherit", width: "100%" }}
            >
              <span style={{ width: 24, height: 24, borderRadius: 12, border: `1.5px solid ${selected ? colors.accent : `${colors.muted}bf`}`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {selected ? <span style={{ width: 12, height: 12, borderRadius: 6, background: colors.accent }} /> : null}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px" }}>
                  <span style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{PLAN_SHORT_TITLE[plan]}</span>
                  {payOnce ? <PlanTag label="Pay once" tone="green" /> : null}
                  {showBadge ? <PlanTag label={badge.label} tone="gold" /> : null}
                </span>
                {offering?.introOffer ? <span style={{ fontSize: 13, lineHeight: "18px", color: colors.peri, fontWeight: 600 }}>{offering.hasFreeTrial ? `${offering.introOffer}, then ${offering.priceString ?? "the price shown"}` : offering.introOffer}</span> : null}
                {offering?.billing ? <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{offering.billing}</span> : null}
              </span>
              <span style={{ fontFamily: MONO_FONT, fontSize: 16, fontWeight: 600, color: selected ? colors.foreground : colors.muted }}>{offering?.priceString ?? (isLoading ? "…" : "Unavailable")}</span>
            </button>
          );
        })}
      </div>

      {ownershipNote ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "0 2px" }} aria-label={ownershipNote}>
          <Icon name="info" size={16} color={colors.peri} style={{ marginTop: 1, flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13, lineHeight: "18px", color: colors.peri }}>{ownershipNote}</span>
        </div>
      ) : null}

        </>
      ) : null}

      <button type="button" className="link" onClick={() => setComparing(true)} style={{ minHeight: 44, alignSelf: "center", padding: "0 12px", fontSize: 14, fontWeight: 600, color: colors.peri }}>Compare Free and Pro</button>

      {purchasesConfigured ? (
        <>
      {storeUnavailable && purchasesConfigured ? <p role="alert" style={{ margin: 0, textAlign: "center", fontSize: 14, fontWeight: 600, color: colors.gold }}>The store did not send this plan&apos;s price. Try again in a moment.</p> : null}
      <PrimaryButton size="lg" fullWidth label={ctaLabel()} onPress={() => void handlePurchase()} loading={purchasing} disabled={purchasing || isLoading || !selectedOffering?.package} />
      {legalText ? <p style={{ margin: 0, fontSize: 12, lineHeight: "17px", textAlign: "center", color: colors.muted }}>{legalText}</p> : null}

      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flexWrap: "wrap", gap: "0 6px" }}>
        <button type="button" className="link" onClick={() => void handleRestore()} disabled={restoring} style={{ minHeight: 44, padding: "0 8px", fontSize: 14, fontWeight: 500, color: colors.muted }}>{restoring ? "Checking…" : "Restore purchases"}</button>
      </div>
        </>
      ) : (
        <PrimaryButton size="lg" fullWidth label="Back to Trajectory" onPress={close} />
      )}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flexWrap: "wrap", gap: "0 6px", marginTop: -10 }}>
        <a className="link" href={WEBSITE_TERMS_URL} target="_blank" rel="noreferrer" style={{ minHeight: 44, display: "inline-flex", alignItems: "center", padding: "0 8px", fontSize: 14, fontWeight: 500, color: colors.muted }}>Terms of Use</a>
        <button type="button" className="link" onClick={() => navigate("privacy-policy")} style={{ minHeight: 44, padding: "0 8px", fontSize: 14, fontWeight: 500, color: colors.muted }}>Privacy Policy</button>
      </div>

      <Sheet open={comparing} onClose={() => setComparing(false)} ariaLabel="Free and Pro">
        <SheetBody>
          <SheetHead title="Free and Pro" onClose={() => setComparing(false)} />
          <div style={{ borderRadius: 16, border: `1px solid ${colors.border}`, background: colors.surface, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 76px 84px", borderBottom: `1px solid ${colors.border}` }}>
              <span className="eyebrow" style={{ padding: "12px 8px 12px 14px", color: colors.muted, fontSize: 11.5 }}>What you get</span>
              <span className="eyebrow" style={{ padding: 12, textAlign: "center", color: colors.muted, fontSize: 11.5 }}>Free</span>
              <span className="eyebrow" style={{ padding: 12, textAlign: "center", color: colors.peri, fontSize: 11.5, background: `${colors.primary}29` }}>Pro</span>
            </div>
            {COMPARISON_ROWS.map((row, index) => (
              <div key={row.label} style={{ display: "grid", gridTemplateColumns: "1fr 76px 84px", alignItems: "stretch", borderBottom: index < COMPARISON_ROWS.length - 1 ? `1px solid ${colors.border}` : "none" }} aria-label={`${row.label}. Free: ${row.free === true ? "included" : row.free === false ? "not included" : row.free}. Pro: ${row.pro === true ? "included" : row.pro === false ? "not included" : row.pro}`}>
                <span style={{ padding: "12px 8px 12px 14px", fontSize: 14, lineHeight: "19px", color: colors.foreground }}>{row.label}</span>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}><CellValue value={row.free} isPro={false} /></span>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px", background: `${colors.primary}1a` }}><CellValue value={row.pro} isPro /></span>
              </div>
            ))}
          </div>
        </SheetBody>
      </Sheet>
    </div>
  );
}
