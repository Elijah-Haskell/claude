// Delete account, reached from Settings (the account's sheet): the Trajectory account, the plan saved to it and
// everything in this browser, in that order (lib/sign-out-flow.ts runAccountDeletion). The page lists what goes, then
// one button, which turns, in place, into the question with its two answers; nothing is deleted before "Delete".

import { useRef, useState } from "react";

import { ACCOUNT_COPY } from "../engine/account-copy";
import { mutate } from "../lib/api";
import { accountDeletedMessage, DELETE_ACCOUNT_COPY, DELETED_WITH_ACCOUNT, deletionNotice } from "../lib/delete-account-view";
import { beginLeaving, endLeaving, isSignedInNow } from "../lib/session";
import { runAccountDeletion } from "../lib/sign-out-flow";
import { DesktopPageHead, Panel } from "../components/desktop-panels";
import { goBack } from "../router";
import { useAuth } from "../state/auth";
import { leavePreparation, tellAlert, useWipeLocalData } from "../state/use-sign-out";
import { Icon } from "../ui/icon";
import { useDesktop } from "../ui/layout";
import { FieldGroup, HeaderIconButton, Note, PrimaryButton, ScreenHeader, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

/** The list, said for the web ("this iPhone" is this browser; the Apple Calendar row does not apply). */
const DELETED_HERE = DELETED_WITH_ACCOUNT.filter((row) => row.icon !== "cal").map((row) => ({ ...row, text: row.text.replace("on this iPhone", "in this browser") }));

/** The list for this account: an account made with Google or an email code has no Sign in with Apple link. */
function deletedFor(loginMethod: string | null | undefined) {
  if (loginMethod !== "google" && loginMethod !== "email") return DELETED_HERE;
  return DELETED_HERE.map((row) => (row.icon === "user" ? { ...row, text: "Your Trajectory account" } : row));
}

const SUBSCRIPTION_NOTE =
  "Deleting your account does not cancel an active subscription. Cancel a web subscription from Settings → Trajectory Pro before deleting; a subscription bought on your iPhone is cancelled in iOS Settings → Apple Account → Subscriptions.";

export function DeleteAccountScreen() {
  const colors = useColors();
  const desktop = useDesktop();
  const wipeLocalData = useWipeLocalData();
  const { loading: authLoading, logout, user } = useAuth();
  const deletedRows = deletedFor(user?.loginMethod);
  // The method is read before deleting: the account (and with it the signed-in user) is gone by the time it is told.
  const signedInMethod = useRef(user?.loginMethod ?? null);
  if (user) signedInMethod.current = user.loginMethod ?? null;
  const [isDeleting, setIsDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const running = useRef(false);

  const startDeletion = async () => {
    if (running.current) return;
    running.current = true;
    setNotice(null);
    const preparation = leavePreparation({ save: false });
    try {
      const result = await runAccountDeletion({
        confirm: async () => true,
        signedIn: isSignedInNow,
        prepare: preparation.prepare,
        deleteAccount: () => mutate("account.delete"),
        cancel: preparation.cancel,
        wipe: wipeLocalData,
        logout,
        setBusy: (busy) => {
          setIsDeleting(busy);
          if (busy) beginLeaving(ACCOUNT_COPY.deletingAccount);
          else endLeaving();
        },
      });
      if (result.outcome === "deleted") {
        const appleAccount = signedInMethod.current !== "google" && signedInMethod.current !== "email";
        const deletedMessage = appleAccount
          ? accountDeletedMessage(result.appleRevoked).replace("on-device Trajectory data", "Trajectory data in this browser").replace("open iOS Settings → Apple Account → Sign-In & Security → Sign in with Apple", "open Apple Account settings (appleid.apple.com → Sign-In and Security → Sign in with Apple)")
          : "Your Trajectory account, the plan saved to it, uploaded files, and Trajectory data in this browser have been permanently deleted.";
        tellAlert(DELETE_ACCOUNT_COPY.deletedTitle, deletedMessage, DELETE_ACCOUNT_COPY.deletedButton);
        return;
      }
      if (result.outcome === "failed") tellAlert(DELETE_ACCOUNT_COPY.failedTitle, DELETE_ACCOUNT_COPY.failed);
      setAsking(false);
      setNotice(deletionNotice(result.outcome));
    } finally {
      running.current = false;
    }
  };

  if (authLoading) {
    return (
      <div className="screen" style={{ alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <span className="spinner" aria-label="Loading" />
      </div>
    );
  }

  if (desktop) {
    return (
      <div className="screen" style={{ maxWidth: 720, gap: 22 }}>
        <DesktopPageHead back={{ onPress: () => goBack("settings"), ariaLabel: "Back" }} eyebrow="Account" title="Delete account" subtitle={DELETE_ACCOUNT_COPY.sub} />

        <Panel title="What is deleted" icon="trash" tint={colors.error}>
          {deletedRows.map((row) => (
            <div key={row.text} className="row" style={{ minHeight: 56 }}>
              <span className="well" style={{ background: `${colors.error}1f` }}>
                <Icon name={row.icon} size={18} color={colors.error} />
              </span>
              <span style={{ flex: 1, fontSize: 15, lineHeight: "21px", color: colors.foreground }}>{row.text}</span>
            </div>
          ))}
        </Panel>

        <Note tone="plain" icon="info">{SUBSCRIPTION_NOTE}</Note>
        {notice ? <Note tone="red" icon="warning" role="alert">{notice}</Note> : null}

        {/* The button, which turns, in place, into the question with its two answers */}
        <div className="card" style={{ padding: "20px 22px", borderColor: `${colors.error}59`, background: `linear-gradient(180deg, ${colors.error}0f, transparent), ${colors.surface}` }}>
          {asking ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <Icon name="warning" size={20} color={colors.error} style={{ marginTop: 1, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 15, lineHeight: "22px", fontWeight: 500, color: colors.foreground }}>{DELETE_ACCOUNT_COPY.question}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
                <PrimaryButton size="lg" tone="ghost" label={DELETE_ACCOUNT_COPY.no} onPress={() => setAsking(false)} disabled={isDeleting} />
                <PrimaryButton size="lg" tone="danger" label={DELETE_ACCOUNT_COPY.yes} onPress={() => void startDeletion()} disabled={isDeleting} loading={isDeleting} ariaLabel="Delete my account and data for good" style={{ minWidth: 140 }} />
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
              <p className="caption" style={{ flex: "1 1 220px", margin: 0, fontSize: 14, lineHeight: "20px" }}>{DELETE_ACCOUNT_COPY.asksFirst}</p>
              <PrimaryButton size="lg" tone="danger" label={DELETE_ACCOUNT_COPY.button} left={<Icon name="trash" size={18} color={colors.error} />} onPress={() => { setNotice(null); setAsking(true); }} ariaLabel={`${DELETE_ACCOUNT_COPY.button}. ${DELETE_ACCOUNT_COPY.asksFirst}`} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <div style={{ display: "flex", paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("settings")} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow="Account" title="Delete account" subtitle={DELETE_ACCOUNT_COPY.sub} />

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="What is deleted" />
        <FieldGroup>
          {deletedRows.map((row, index) => (
            <div key={row.text} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 50, padding: "8px 14px", borderTop: index > 0 ? `1px solid ${colors.border}` : "none" }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: `${colors.error}1f`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name={row.icon} size={18} color={colors.error} />
              </span>
              <span style={{ flex: 1, fontSize: 15, lineHeight: "20px", color: colors.foreground }}>{row.text}</span>
            </div>
          ))}
        </FieldGroup>
      </section>

      <Note tone="plain" icon="info">{SUBSCRIPTION_NOTE}</Note>
      {notice ? <Note tone="red" icon="warning" role="alert">{notice}</Note> : null}

      {asking ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
          <Note tone="red" icon="warning" role="alert">{DELETE_ACCOUNT_COPY.question}</Note>
          <PrimaryButton size="lg" fullWidth tone="danger" label={DELETE_ACCOUNT_COPY.yes} onPress={() => void startDeletion()} disabled={isDeleting} loading={isDeleting} ariaLabel="Delete my account and data for good" />
          <PrimaryButton size="lg" fullWidth tone="ghost" label={DELETE_ACCOUNT_COPY.no} onPress={() => setAsking(false)} disabled={isDeleting} />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
          <PrimaryButton size="lg" fullWidth tone="danger" label={DELETE_ACCOUNT_COPY.button} left={<Icon name="trash" size={18} color={colors.error} />} onPress={() => { setNotice(null); setAsking(true); }} ariaLabel={`${DELETE_ACCOUNT_COPY.button}. ${DELETE_ACCOUNT_COPY.asksFirst}`} />
          <p className="caption" style={{ textAlign: "center", margin: 0 }}>{DELETE_ACCOUNT_COPY.asksFirst}</p>
        </div>
      )}
    </div>
  );
}
