/**
 * Reminders, opened from Settings (the iPhone app's app/notification-settings.tsx): one switch for all of them (it
 * asks the browser for permission when it is turned on, and only then), then when they come: as a session starts, and
 * any heads-up before it ("1 hour before", "1 day before, at 8:00 AM"). A heads-up is added in a sheet and removed
 * with the button at the end of its row. When the browser is not letting anything through, a gold note says so (there
 * is no iOS Settings to open here: notifications are allowed for the site in the browser's own settings). Reminders
 * are shown by this browser while a Trajectory tab is open (components/headless/study-notifications.tsx). What every
 * line says is lib/reminders-view.ts.
 */
import { useCallback, useEffect, useState } from "react";

import type { NotificationSettings } from "../engine/types";
import { generateId } from "../engine/utils";
import { cancelAllStudyReminders, getNotificationPermission, notificationsSupported, requestNotificationPermissions } from "../lib/notifications";
import { resolveReminderToggle, sessionStartEnabled, type NotificationPermission, type StudyNotificationSettings } from "../lib/notification-policy";
import {
  addHeadsUpError,
  currentReminders,
  DEFAULT_CUSTOM_HOUR,
  DEFAULT_LEAD_MINUTES,
  DURATION_OPTIONS,
  HOUR_OPTIONS,
  newReminder,
  reminderLabel,
  REMINDERS_COPY,
  remindersNotice,
  settingsAfterAdding,
  settingsAfterRemoving,
  type HeadsUpDraft,
} from "../lib/reminders-view";
import { goBack } from "../router";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { AppSwitch, FieldGroup, FieldRow, HeaderIconButton, Note, PrimaryButton, ScreenHeader, SectionLabel } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

export function RemindersScreen() {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const { notificationSettings } = state;
  const reminders = currentReminders(notificationSettings);

  const [showAdd, setShowAdd] = useState(false);
  const [minutes, setMinutes] = useState(DEFAULT_LEAD_MINUTES);
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [customHour, setCustomHour] = useState(DEFAULT_CUSTOM_HOUR);
  const [permission, setPermission] = useState<NotificationPermission>("undetermined");
  // The browser just said no to the switch: it stays off, and the page says where to allow notifications.
  const [refused, setRefused] = useState(false);
  const supported = notificationsSupported();

  // Re-read the permission whenever the screen is shown, and whenever the tab comes back: the way to allow
  // notifications is the browser's site settings, and returning from them does not render this screen again.
  const readPermission = useCallback(() => {
    getNotificationPermission()
      .then((next) => {
        setPermission(next);
        if (next === "granted") setRefused(false);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    readPermission();
    const onVisible = () => {
      if (document.visibilityState === "visible") readPermission();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", readPermission);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", readPermission);
    };
  }, [readPermission]);

  const startsOn = sessionStartEnabled(notificationSettings);
  const notice = remindersNotice({ enabled: notificationSettings.enabled, permission, refused });

  function updateSettings(patch: Partial<StudyNotificationSettings>) {
    // `sessionStart` lives in the same persisted settings object (see StudyNotificationSettings).
    dispatch({ type: "UPDATE_NOTIFICATION_SETTINGS", payload: patch as Partial<NotificationSettings> });
  }

  // Turning reminders on asks the browser, in this click (the only time permission is ever asked for).
  async function handleToggle(requested: boolean) {
    const granted = requested ? await requestNotificationPermissions() : false;
    const { enabled, showDeniedAlert } = resolveReminderToggle(requested, granted);
    if (requested) setPermission(granted ? "granted" : "denied");
    setRefused(showDeniedAlert);
    // The browser has said no (or asked nothing: the site is blocked, or it cannot show notifications), and only its
    // own settings can change that. The gold note on the page says so and where; there is no alert to carry it.
    if (showDeniedAlert) return;
    updateSettings({ enabled });
    if (!enabled) void cancelAllStudyReminders();
  }

  const draft: HeadsUpDraft = useCustomTime ? { minutes, customHour } : { minutes };
  const addError = addHeadsUpError(reminders, draft);
  const draftLabel = reminderLabel(newReminder("draft", draft));

  function openAdd() {
    setMinutes(DEFAULT_LEAD_MINUTES);
    setUseCustomTime(false);
    setCustomHour(DEFAULT_CUSTOM_HOUR);
    setShowAdd(true);
  }
  const closeAdd = () => setShowAdd(false);
  function addReminder() {
    if (addError) return;
    dispatch({ type: "UPDATE_NOTIFICATION_SETTINGS", payload: settingsAfterAdding(reminders, newReminder(generateId(), draft)) });
    setShowAdd(false);
  }
  function removeReminder(id: string) {
    dispatch({ type: "UPDATE_NOTIFICATION_SETTINGS", payload: settingsAfterRemoving(reminders, id) });
  }

  const select = { height: 52, borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.background, color: colors.foreground, padding: "0 12px", fontSize: 16, width: "100%" } as const;

  return (
    <div className="screen" style={{ maxWidth: 560, gap: 14 }}>
      <div style={{ display: "flex", paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("settings")} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow="Account and app" title="Reminders" subtitle={REMINDERS_COPY.sub} />

      {/* The one switch for all of them */}
      <FieldGroup>
        <FieldRow first icon="bell" label={REMINDERS_COPY.master} detail={REMINDERS_COPY.masterDetail}>
          <AppSwitch value={notificationSettings.enabled} onValueChange={(value) => void handleToggle(value)} ariaLabel={`${REMINDERS_COPY.master}: ${REMINDERS_COPY.masterDetail.toLowerCase()}`} />
        </FieldRow>
      </FieldGroup>

      {/* This browser cannot show notifications at all */}
      {!supported ? <Note tone="gold" icon="warning">{REMINDERS_COPY.unsupported}</Note> : null}

      {/* The browser is not letting them through: where to allow them */}
      {supported && notice ? (
        <Note tone="gold" icon="warning" role="alert">
          <div style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{notice.title}</div>
          <div style={{ fontSize: 14, lineHeight: "20px", marginTop: 1, color: colors.foreground }}>{notice.body}</div>
        </Note>
      ) : null}

      {notificationSettings.enabled ? (
        <>
          {/* As a session starts */}
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel title="When" />
            <FieldGroup>
              <FieldRow first icon="clock" label={REMINDERS_COPY.sessionStart} detail={REMINDERS_COPY.sessionStartDetail}>
                <AppSwitch value={startsOn} onValueChange={(value) => updateSettings({ sessionStart: value })} ariaLabel="Notify when a study session starts" />
              </FieldRow>
            </FieldGroup>
          </section>

          {/* Heads-up reminders */}
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel
              title={REMINDERS_COPY.headsUp}
              right={
                <button type="button" className="link" onClick={openAdd} aria-label="Add a heads-up before a session" style={{ minHeight: 44, gap: 5 }}>
                  <Icon name="plus" size={16} color={colors.peri} strokeWidth={2.2} />
                  Add
                </button>
              }
            />
            {reminders.length === 0 ? (
              <Note tone="plain" icon="clock">{REMINDERS_COPY.noHeadsUp}</Note>
            ) : (
              <FieldGroup>
                {reminders.map((reminder) => {
                  const label = reminderLabel(reminder);
                  return (
                    <div key={reminder.id} className="row" style={{ minHeight: 54, gap: 8, padding: "0 5px 0 14px" }}>
                      <span style={{ flex: 1, fontSize: 16, lineHeight: "21px", fontWeight: 500, padding: "8px 0", color: colors.foreground }}>{label}</span>
                      <button type="button" className="pressable" onClick={() => removeReminder(reminder.id)} aria-label={`Remove the heads-up ${label}`} style={{ width: 44, height: 44, borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon name="close" size={18} color={colors.muted} strokeWidth={2} />
                      </button>
                    </div>
                  );
                })}
              </FieldGroup>
            )}
          </section>

          <p className="caption" style={{ margin: 0, padding: "0 2px" }}>{REMINDERS_COPY.footnote}</p>
          <p className="caption" style={{ margin: 0, padding: "0 2px" }}>{REMINDERS_COPY.tabNote}</p>
        </>
      ) : null}

      {/* A new heads-up: how long before, and optionally at a set time of day */}
      <Sheet open={showAdd} onClose={closeAdd} ariaLabel={REMINDERS_COPY.sheetTitle}>
        <SheetBody>
          <SheetHead title={REMINDERS_COPY.sheetTitle} onClose={closeAdd} />
          <p className="sheet-sub" style={{ marginTop: -8 }}>{REMINDERS_COPY.sheetSub}</p>

          <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} aria-label="How long before the session" style={select}>
            {DURATION_OPTIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>{option.label}</option>
            ))}
          </select>

          <FieldGroup>
            <FieldRow first icon="clock" label={REMINDERS_COPY.customTime}>
              <AppSwitch value={useCustomTime} onValueChange={setUseCustomTime} ariaLabel={REMINDERS_COPY.customTime} />
            </FieldRow>
          </FieldGroup>

          {useCustomTime ? (
            <select value={customHour} onChange={(event) => setCustomHour(Number(event.target.value))} aria-label="Time of day" style={select}>
              {HOUR_OPTIONS.map((hour) => (
                <option key={hour.value} value={hour.value}>{hour.label}</option>
              ))}
            </select>
          ) : null}

          {/* What "Add" adds, or why it cannot */}
          {addError ? (
            <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", textAlign: "center", fontWeight: 600, color: colors.gold }}>{addError}</p>
          ) : (
            <p style={{ margin: 0, fontSize: 14, lineHeight: "19px", textAlign: "center", color: colors.muted }}>{draftLabel}</p>
          )}
          <PrimaryButton size="lg" fullWidth label="Add" disabled={addError !== null} onPress={addReminder} ariaLabel={addError ? `Add. ${addError}` : `Add the heads-up ${draftLabel}`} />
        </SheetBody>
      </Sheet>
    </div>
  );
}
