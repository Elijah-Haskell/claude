/**
 * PassExpiryBanner (Today): a School Year pass never renews by itself, so in its last 14 days Today says "Your School
 * Year Pro ends Thu, Aug 20", and for 30 days after it ended "Your School Year Pro ended Aug 20", with "Get another
 * year" (opens the paywall). Never while Pro comes from a subscription or the Degree Pass, never while the entitlement
 * is still loading (lib/subscription-plans.ts passExpiryNotice). The × hides it until tomorrow.
 */
import { localDateKey } from "../engine/utils";
import { passExpiryNotice } from "../lib/subscription-plans";
import { termPassProduct } from "../shared/term-pass";
import { PREF_KEYS, useLocalPref } from "../state/local-prefs";
import { useProDetails } from "../state/subscription-context";
import { navigate } from "../router";
import { Icon } from "../ui/icon";
import { useColors } from "../ui/theme";

export function PassExpiryBanner({ onGetAnotherYear }: { onGetAnotherYear?: () => void }) {
  const colors = useColors();
  const status = useProDetails();
  const [hiddenOn, setHiddenOn] = useLocalPref(PREF_KEYS.passBannerHiddenOn);
  if (status.isLoading) return null;
  const notice = passExpiryNotice(status, new Date(), hiddenOn);
  if (!notice) return null;

  const actionLabel = termPassProduct(status.termPass?.productId)?.months === 12 ? "Get another year" : "Buy another pass";
  const open = onGetAnotherYear ?? (() => navigate("paywall"));
  return (
    <div style={{ display: "flex", alignItems: "center", minHeight: 52, paddingLeft: 12, borderRadius: 14, border: `1px solid ${colors.gold}66`, background: `${colors.gold}14` }}>
      <button type="button" className="pressable" onClick={open} aria-label={`${notice.message}. ${actionLabel}`} style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, minHeight: 44, padding: "9px 0", background: "transparent", border: "none", textAlign: "left", color: "inherit" }}>
        <span style={{ width: 32, height: 32, borderRadius: 10, background: `${colors.gold}29`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="crown" size={17} color={colors.gold} />
        </span>
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, lineHeight: "18px", fontWeight: 600, color: colors.foreground }}>{notice.message}</span>
          <span style={{ fontSize: 12, lineHeight: "16px", fontWeight: 600, color: colors.gold }}>{actionLabel}</span>
        </span>
        <Icon name="chevronRight" size={16} color={colors.gold} />
      </button>
      <button type="button" className="pressable" onClick={() => setHiddenOn(localDateKey(new Date()))} aria-label="Hide until tomorrow" style={{ width: 40, height: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none" }}>
        <Icon name="close" size={15} color={colors.dim} />
      </button>
    </div>
  );
}
