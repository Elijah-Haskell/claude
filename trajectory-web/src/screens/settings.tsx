// Settings: one page, opened from the gear on Classes. What makes the plan fit real life comes first (sleep hours,
// work and activities, how much study a day), then what keeps dates current (a course site's link, the calendar
// file), then the account and the app. Each row says its state at its right end. The account row leads to Sign out
// and Delete account; "Reset semester" asks first, on the page. On a computer (src/ui/layout.ts) the sections are titled
// panels in two columns, Help and privacy is a panel of its own instead of a sheet, and there is no way back to Classes
// in the header: Settings has its own place in the sidebar.

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { ACCOUNT_COPY } from "../engine/account-copy";
import { signedInWithLabel } from "../lib/email-signin";
import { sleepHoursLabel } from "../engine/classes-view";
import { clampSleepTarget, formatSleepDuration, sleepWindowWarning } from "../engine/sleep-window";
import type { UserPreferences } from "../engine/types";
import { formatDuration, localDateKey } from "../engine/utils";
import { studyLoadCaps } from "../engine/workload-analysis";
import { SUPPORT_EMAIL, WEBSITE_SUPPORT_URL, WEBSITE_TERMS_URL } from "../shared/const";
import { DesktopPageHead, Panel } from "../components/desktop-panels";
import { PlanSavedRow } from "../components/plan-sync";
import { UndoReplanBar } from "../components/plan-status";
import { ProStatusRow } from "../components/pro-status-row";
import { APP_VERSION } from "../lib/config";
import { buildPlanIcs, downloadTextFile } from "../lib/ics-export";
import { loadCourseFeeds, subscribeCourseFeeds } from "../lib/lms-feed-store";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { useAuth } from "../state/auth";
import { usePlanSync } from "../state/plan-sync-client";
import { useSignOut } from "../state/use-sign-out";
import { Icon } from "../ui/icon";
import { useDesktop, useWideLayout } from "../ui/layout";
import { FieldGroup, FieldLabel, FieldPickRow, FieldRow, HeaderIconButton, InlineConfirm, Note, PrimaryButton, SectionLabel, Segmented, Stepper, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors, useTheme } from "../ui/theme";

type Open = "sleep" | "study" | "account" | "help" | null;

const INTENSITY_OPTIONS: { value: string; label: string; ariaLabel: string }[] = [
  { value: "25", label: "Light", ariaLabel: "Light: about 4 hours of study a day at most" },
  { value: "50", label: "Balanced", ariaLabel: "Balanced: about 5 hours of study a day at most" },
  { value: "75", label: "Full", ariaLabel: "Full: about 6 hours of study a day at most" },
];

/** mailto: link for "Contact support". */
function supportMailto(): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Trajectory support")}&body=${encodeURIComponent(`\n\n---\nTrajectory ${APP_VERSION}`)}`;
}

export function SettingsScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch, exportState, importState, flush } = useApp();
  const { scheme, setScheme } = useTheme();
  const isDark = scheme === "dark";
  const { user: authUser, isAuthenticated, loading: authLoading } = useAuth();
  const signedInLabel = signedInWithLabel(authUser?.loginMethod);
  // "Sign out?", then the plan is saved to the account one last time and removed from this browser (src/state/use-sign-out.ts).
  const signOut = useSignOut();
  // The saved plan's row is only there once the saved plan has started (<PlanSavedRow /> shows nothing while "off").
  const showSavedPlan = usePlanSync().phase !== "off" && isAuthenticated && !authLoading;

  const desktop = useDesktop();
  const wide = useWideLayout();
  const [open, setOpen] = useState<Open>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [importNote, setImportNote] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [feedCount, setFeedCount] = useState(0);
  useEffect(() => {
    let active = true;
    void loadCourseFeeds().then((feeds) => {
      if (active) setFeedCount(feeds.feeds.length);
    });
    const off = subscribeCourseFeeds((feeds) => setFeedCount(feeds.feeds.length));
    return () => {
      active = false;
      off();
    };
  }, []);

  function resetSemester() {
    dispatch({ type: "RESET_SEMESTER" });
    dispatch({ type: "REGENERATE_WEEK" });
    setConfirmingReset(false);
    // Back on Classes, which now says there are none: the reset is seen, not taken on trust.
    navigate("classes", { replace: true });
  }

  const { bedtime, wakeTime, sleepTargetHours } = state.healthPrefs;
  const sleepWarning = sleepWindowWarning(bedtime, wakeTime, sleepTargetHours);
  function updateSleep(payload: Partial<{ bedtime: string; wakeTime: string; sleepTargetHours: number }>) {
    dispatch({ type: "UPDATE_HEALTH_PREFS", payload });
    // The planner builds around the sleep hours, so rebuild the plan with the new ones (undoable: "Plan updated · Undo").
    dispatch({ type: "AUTO_REPLAN" });
  }
  function updateStudy(payload: Partial<UserPreferences>) {
    dispatch({ type: "UPDATE_USER_PREFS", payload });
    dispatch({ type: "AUTO_REPLAN" });
  }
  const caps = studyLoadCaps(state.userPrefs);
  const intensityValue = String([25, 50, 75].reduce((best, option) => (Math.abs(option - state.userPrefs.scheduleIntensity) < Math.abs(best - state.userPrefs.scheduleIntensity) ? option : best), 50));

  function exportCalendar() {
    downloadTextFile(`trajectory-${localDateKey(new Date())}.ics`, buildPlanIcs(state), "text/calendar");
  }
  function exportBackup() {
    flush();
    downloadTextFile(`trajectory-backup-${localDateKey(new Date())}.json`, exportState(), "application/json");
  }
  function importBackup(file: File | undefined) {
    if (!file) return;
    file
      .text()
      .then((raw) => {
        const ok = importState(raw);
        setImportNote(ok ? { tone: "green", text: `Restored from ${file.name}. Your plan is back as it was in that backup.` } : { tone: "red", text: `${file.name} is not a Trajectory backup. Nothing changed.` });
      })
      .catch(() => setImportNote({ tone: "red", text: "That file could not be read. Nothing changed." }));
  }

  /** Close an open sheet, then run the action once it is gone. */
  function after(action: () => void) {
    setOpen(null);
    setTimeout(action, 150);
  }

  const activities = state.recurringEvents.length === 0 ? "None" : String(state.recurringEvents.length);
  const feeds = feedCount === 0 ? "None" : feedCount === 1 ? "1 link" : `${feedCount} links`;
  const reminders = state.notificationSettings?.enabled ? "On" : "Off";

  // The rows of each section, the same on a phone and a computer; only how the sections are laid out differs.
  const yourTimeRows = (
    <>
      <FieldPickRow first icon="moon" label="Sleep hours" value={sleepHoursLabel(bedtime, wakeTime)} onPress={() => setOpen("sleep")} ariaLabel={`Sleep hours: ${sleepHoursLabel(bedtime, wakeTime)}. Nothing is planned inside them`} />
      <FieldPickRow icon="work" label="Work and activities" value={activities} onPress={() => navigate("activities")} ariaLabel={`Work and activities that repeat every week: ${activities}`} />
      <FieldPickRow icon="gauge" label="Study load" value={`${formatDuration(caps.dailyMinutes)} a day`} onPress={() => setOpen("study")} ariaLabel={`Study load: up to ${formatDuration(caps.dailyMinutes)} of study a day`} />
    </>
  );
  const datesRows = (
    <>
      <FieldPickRow first icon="link" label="Course site link" detail="Canvas, Blackboard or Moodle" value={feeds} onPress={() => navigate("course-feeds")} />
      {state.googleCalendarConnected ? <FieldPickRow icon="calSync" label="Google Calendar" detail="Connected. Sync or disconnect" onPress={() => navigate("calendars")} /> : null}
      <FieldPickRow icon="cal" label="Calendar file" detail="Every class, session and deadline as an .ics file for Google, Apple or Outlook" value="Download" chevron={false} onPress={exportCalendar} ariaLabel="Download the plan as a calendar file" />
      <FieldPickRow icon="download" label="Back up this plan" detail="A file you can bring back here or on another computer" value="Save" chevron={false} onPress={exportBackup} ariaLabel="Save a backup file of the plan" />
      <FieldPickRow icon="upload" label="Restore a backup" detail="Replaces what is here with the file's plan" value="Open" chevron={false} onPress={() => fileInput.current?.click()} ariaLabel="Restore the plan from a backup file" />
      <input ref={fileInput} type="file" accept="application/json,.json" style={{ display: "none" }} aria-hidden onChange={(e) => { importBackup(e.target.files?.[0]); e.target.value = ""; }} />
    </>
  );
  const importNoteView = importNote ? <Note tone={importNote.tone} icon={importNote.tone === "green" ? "check" : "warning"} role="status">{importNote.text}</Note> : null;
  // "Your plan · Saved to your account · 2 min ago", or what stops it from being saved (tap to try again). On a
  // computer it sits under the panel's title, so it keeps its line over it.
  const accountRows = (withHelpRow: boolean) => (
    <>
      {showSavedPlan ? <PlanSavedRow first={!desktop} /> : null}
      {authLoading ? null : isAuthenticated ? (
        <FieldPickRow first={!showSavedPlan} icon="user" label={signedInLabel} detail={authUser?.email || ACCOUNT_COPY.signedInDetail} onPress={() => setOpen("account")} ariaLabel={`${signedInLabel}. ${ACCOUNT_COPY.signedInDetail} Sign out or delete the account`} />
      ) : (
        <FieldRow first icon="user" label={ACCOUNT_COPY.notSignedIn} detail="Browser preview: the plan stays in this browser." />
      )}
      <FieldPickRow first={authLoading} icon="bell" label="Reminders" value={reminders} onPress={() => navigate("reminders")} />
      <FieldPickRow icon={isDark ? "moon" : "sun"} label="Appearance" value={isDark ? "Dark" : "Light"} chevron={false} onPress={() => setScheme(isDark ? "light" : "dark")} ariaLabel={isDark ? "Appearance: dark. Switch to light" : "Appearance: light. Switch to dark"} />
      {/* What the student really has (a subscription, a School Year pass, the Degree Pass) or the free plan. Left out while that is still loading. */}
      <ProStatusRow onOpenPaywall={() => navigate("paywall")} />
      {withHelpRow ? <FieldPickRow icon="info" label="Help and privacy" onPress={() => setOpen("help")} /> : null}
    </>
  );
  // Help, support and the two legal pages: in a sheet on a phone, a panel of its own on a computer.
  const helpRows = (leave: (action: () => void) => void) => (
    <>
      <FieldPickRow first icon="info" label="Help" detail="How planning, replanning and the syllabus import work" onPress={() => window.open(WEBSITE_SUPPORT_URL, "_blank", "noopener")} ariaLabel="Help, on the web" />
      <FieldPickRow icon="mail" label="Contact support" detail={SUPPORT_EMAIL} onPress={() => { window.location.href = supportMailto(); }} ariaLabel={`Contact support by e-mail at ${SUPPORT_EMAIL}`} />
      <FieldPickRow icon="shield" label="Privacy Policy" onPress={() => leave(() => navigate("privacy-policy"))} />
      <FieldPickRow icon="file" label="Terms of Use" onPress={() => window.open(WEBSITE_TERMS_URL, "_blank", "noopener")} ariaLabel="Terms of Use, on the web" />
    </>
  );
  const resetConfirm = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Note tone="red" icon="warning">Reset the semester? This clears every class, task and study session, the syllabi you imported and the study guides made from them. Your preferences stay.</Note>
      <InlineConfirm question="" confirmLabel="Reset" onConfirm={resetSemester} onCancel={() => setConfirmingReset(false)} />
    </div>
  );
  const resetButton = (style?: CSSProperties) => (
    <button type="button" className="link" onClick={() => setConfirmingReset(true)} aria-label="Reset semester" style={{ minHeight: 44, alignSelf: "center", padding: "0 12px", fontSize: 15, fontWeight: 600, color: colors.error, ...style }}>Reset semester</button>
  );

  const sheets = (
    <>
      {/* Sleep hours: nothing is planned inside them */}
      <Sheet open={open === "sleep"} onClose={() => setOpen(null)} ariaLabel="Sleep hours">
        <SheetBody>
          <SheetHead title="Sleep hours" onClose={() => setOpen(null)} />
          <p className="sheet-sub" style={{ marginTop: -8 }}>Nothing is planned inside these hours. Changing them re-plans around the new ones.</p>
          <FieldGroup>
            <FieldRow first icon="moon" label="Bedtime">
              <TimeInput ariaLabel="Bedtime" value={bedtime} onChange={(value) => updateSleep({ bedtime: value })} />
            </FieldRow>
            <FieldRow icon="sun" label="Wake up">
              <TimeInput ariaLabel="Wake up" value={wakeTime} onChange={(value) => updateSleep({ wakeTime: value })} />
            </FieldRow>
            <FieldRow icon="clock" label="Sleep I need" detail="The plan warns when your hours give less">
              <Stepper value={formatSleepDuration(sleepTargetHours * 60)} lessLabel="Half an hour less sleep" moreLabel="Half an hour more sleep" onLess={() => updateSleep({ sleepTargetHours: clampSleepTarget(sleepTargetHours - 0.5) })} onMore={() => updateSleep({ sleepTargetHours: clampSleepTarget(sleepTargetHours + 0.5) })} width={62} />
            </FieldRow>
          </FieldGroup>
          {sleepWarning ? <Note tone="gold" icon="warning">{sleepWarning}</Note> : null}
          <PrimaryButton size="lg" fullWidth label="Done" onPress={() => setOpen(null)} />
        </SheetBody>
      </Sheet>

      {/* Study load: how much study a day and in a week, and how the planner shapes sessions */}
      <Sheet open={open === "study"} onClose={() => setOpen(null)} ariaLabel="Study load">
        <SheetBody>
          <SheetHead title="Study load" onClose={() => setOpen(null)} />
          <p className="sheet-sub" style={{ marginTop: -8 }}>How much study the planner puts on one day and in one week. Changing it re-plans the semester.</p>
          <div>
            <FieldLabel>How much a day</FieldLabel>
            <Segmented options={INTENSITY_OPTIONS} value={intensityValue} onChange={(value) => updateStudy({ scheduleIntensity: Number(value), dailyStudyCapMinutes: undefined, weeklyStudyCapMinutes: undefined })} />
            <p className="caption" style={{ marginTop: 8 }}>Up to {formatDuration(caps.dailyMinutes)} a day and {formatDuration(caps.weeklyMinutes)} a week.</p>
          </div>
          <div>
            <FieldLabel>Sessions</FieldLabel>
            <Segmented
              options={[
                { value: "deep_blocks", label: "Longer blocks", ariaLabel: "Longer study blocks" },
                { value: "short_bursts", label: "Short bursts", ariaLabel: "Short study bursts" },
              ]}
              value={state.userPrefs.studyStyle}
              onChange={(value) => updateStudy({ studyStyle: value as UserPreferences["studyStyle"] })}
            />
          </div>
          <div>
            <FieldLabel>Best time of day</FieldLabel>
            <Segmented
              options={[
                { value: "morning", label: "Morning", ariaLabel: "Mornings are best" },
                { value: "afternoon", label: "Afternoon", ariaLabel: "Afternoons are best" },
                { value: "night", label: "Evening", ariaLabel: "Evenings are best" },
              ]}
              value={state.userPrefs.energyProfile}
              onChange={(value) => updateStudy({ energyProfile: value as UserPreferences["energyProfile"] })}
            />
          </div>
          <PrimaryButton size="lg" fullWidth label="Done" onPress={() => setOpen(null)} />
        </SheetBody>
      </Sheet>

      {/* The account: that the plan is saved to it, Sign out, Delete */}
      <Sheet open={open === "account"} onClose={() => setOpen(null)} ariaLabel={signedInLabel}>
        <SheetBody>
          <SheetHead title={signedInLabel} onClose={() => setOpen(null)} />
          {authUser?.email ? <p className="sheet-sub" style={{ marginTop: -8 }}>{authUser.email}</p> : null}
          <p className="sheet-sub" style={{ marginTop: -4 }}>{ACCOUNT_COPY.signedInDetail} Signing out removes it from this browser; sign in again to get it back.</p>
          <FieldGroup>
            <FieldPickRow first icon="logout" label="Sign out" onPress={() => after(signOut)} chevron={false} />
          </FieldGroup>
          <button type="button" className="link" onClick={() => after(() => navigate("delete-account"))} aria-label="Delete account and data" style={{ minHeight: 44, alignSelf: "center", padding: "0 12px", fontSize: 15, fontWeight: 600, color: colors.error }}>Delete account and data</button>
        </SheetBody>
      </Sheet>

      {/* Help, support and the two legal pages */}
      <Sheet open={open === "help"} onClose={() => setOpen(null)} ariaLabel="Help and privacy">
        <SheetBody>
          <SheetHead title="Help and privacy" onClose={() => setOpen(null)} />
          <FieldGroup>{helpRows(after)}</FieldGroup>
          <PrimaryButton size="lg" fullWidth tone="ghost" label="Close" onPress={() => setOpen(null)} />
        </SheetBody>
      </Sheet>
    </>
  );

  if (desktop) {
    const timeAndDates = (
      <>
        <Panel title="Your time" icon="clock">{yourTimeRows}</Panel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Panel title="Keep dates current" icon="calSync">{datesRows}</Panel>
          {importNoteView}
        </div>
      </>
    );
    const accountAndHelp = (
      <>
        <Panel title="Account and app" icon="user">{accountRows(false)}</Panel>
        <Panel title="Help and privacy" icon="info">{helpRows((action) => action())}</Panel>
      </>
    );
    // The version, and "Reset semester" (it asks first, here).
    const footer = confirmingReset ? (
      resetConfirm
    ) : (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 6px 0 4px" }}>
        <span className="caption mono" style={{ letterSpacing: 0.6, fontSize: 12 }}>Trajectory {APP_VERSION}</span>
        {resetButton({ alignSelf: undefined, marginRight: -12 })}
      </div>
    );
    return (
      <div className="screen full" style={{ gap: 22 }}>
        {/* Settings has its own place in the sidebar on a computer: no way back to Classes in its header. */}
        <DesktopPageHead title="Settings" />
        {/* What the sheets changed re-planned the semester: the bar that says so, with its Undo */}
        <UndoReplanBar variant="row" />
        {wide ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 24, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {timeAndDates}
              {footer}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>{accountAndHelp}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%", maxWidth: 760, margin: "0 auto" }}>
            {timeAndDates}
            {accountAndHelp}
            {footer}
          </div>
        )}
        {sheets}
      </div>
    );
  }

  return (
    <div className="screen">
      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("classes")} ariaLabel="Back to Classes">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
        <h1 className="screen-title" style={{ margin: 0 }}>Settings</h1>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="Your time" />
        <FieldGroup>{yourTimeRows}</FieldGroup>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="Keep dates current" />
        <FieldGroup>{datesRows}</FieldGroup>
        {importNoteView}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="Account and app" />
        <FieldGroup>{accountRows(true)}</FieldGroup>
      </section>

      {confirmingReset ? resetConfirm : resetButton()}
      <p className="caption mono" style={{ textAlign: "center", letterSpacing: 0.6, fontSize: 12 }}>Trajectory {APP_VERSION}</p>

      {/* What the sheets changed re-planned the semester: the bar that says so, with its Undo */}
      <UndoReplanBar variant="row" />

      {sheets}
    </div>
  );
}

