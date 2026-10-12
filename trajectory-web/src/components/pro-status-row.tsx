/**
 * The student's Trajectory Pro, as a row of Settings ("Account and app"). It says what the student actually has
 * (lib/subscription-plans.ts proStatusRowModel): no Pro → the Pro screen; a subscription → "Manage subscription"
 * (RevenueCat's page for web subscriptions, or the App Store for one bought on the iPhone); a School Year pass →
 * "Pro until …" and, in its last 30 days, "Get another year"; the Degree Pass → nothing to manage. Renders nothing
 * while the entitlement is still loading.
 */
import { proStatusRowModel, renewalPeriodFor } from "../lib/subscription-plans";
import { showAlert } from "../state/dialogs";
import { useProDetails, useSubscription } from "../state/subscription-context";
import { navigate } from "../router";
import { FieldPickRow, FieldRow } from "../ui/primitives";

/** Apple's subscription list, for a subscription bought in the iPhone app. */
export const APP_STORE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";

export function ProStatusRow({ onOpenPaywall, first }: { onOpenPaywall?: () => void; first?: boolean }) {
  const status = useProDetails();
  const { offerings, managementUrl } = useSubscription();
  if (status.isLoading) return null;

  const model = proStatusRowModel(status, new Date(), renewalPeriodFor(status.productId, offerings));
  const openPaywall = onOpenPaywall ?? (() => navigate("paywall"));

  if (model.kind === "upgrade") {
    return <FieldPickRow first={first} icon="crown" tone="violet" label="Trajectory Pro" value="Free plan" onPress={openPaywall} ariaLabel={`Trajectory Pro: you are on the free plan. ${model.sublabel}. See the plans`} />;
  }

  if (model.kind === "subscription") {
    const manage = () => {
      const url = managementUrl ?? APP_STORE_SUBSCRIPTIONS_URL;
      const opened = window.open(url, "_blank", "noopener");
      if (!opened) {
        void showAlert({
          title: "Manage your subscription",
          message: managementUrl ? `Open ${managementUrl} to change or cancel it.` : "A subscription bought on your iPhone is managed in iOS Settings: tap your name, then Subscriptions.",
          buttons: [{ text: "OK" }],
        });
      }
    };
    return <FieldPickRow first={first} icon="crown" tone="violet" label={model.label} detail={model.sublabel} onPress={manage} ariaLabel={`${model.label}. ${model.sublabel}. Opens the subscription page`} />;
  }

  if (model.kind === "term" && model.offerAnotherTerm) {
    return (
      <>
        <FieldRow first={first} icon="crown" label={model.label} detail={model.sublabel} />
        <FieldPickRow icon="calPlus" tone="violet" label={model.anotherTermLabel} detail="It starts when this one ends, so no days are lost." onPress={openPaywall} />
      </>
    );
  }

  return <FieldRow first={first} icon="crown" label={model.label} detail={model.sublabel} />;
}
