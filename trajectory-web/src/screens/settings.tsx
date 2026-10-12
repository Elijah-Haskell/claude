// Settings: one page, opened from the gear on Classes. What makes the plan fit real life comes first (sleep hours,
// work and activities, how much study a day), then what keeps the plan with you (the calendar file, a backup of the
// plan, the AI reader's key), then the app. Each row says its state at its right end. "Reset semester" asks first,
// on the page. Everything lives in this browser: there is no account.

import { useRef, useState } from "react";

import { sleepHoursLabel } from "../engine/classes-view";
import { clampSleepTarget, formatSleepDuration, sleepWindowWarning } from "../engine/sleep-window";
import type { UserPreferences } from "../engine/types";
import { localDateKey } from "../engine/utils";
import { studyLoadCaps } from "../engine/workload-analysis";
import { formatDuration } from "../engine/utils";
import { UndoReplanBar } from "../components/plan-status";
import { buildPlanIcs, downloadTextFile } from "../lib/ics-export";
import { DEFAULT_AI_MODEL } from "../lib/ai-types";
import { goBack, useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { PREF_KEYS, useLocalPref } from "../state/local-prefs";
import { Icon } from "../ui/icon";
import { FieldGroup, FieldLabel, FieldPickRow, FieldRow, HeaderIconButton, InlineConfirm, Note, PrimaryButton, SectionLabel, Segmented, Stepper, TimeInput } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors, useTheme } from "../ui/theme";

type Open = "sleep" | "study" | "ai" | "help" | null;

const INTENSITY_OPTIONS: { value: string; label: string; ariaLabel: string }[] = [
  { value: "25", label: "Light", ariaLabel: "Light: about 4 hours of study a day at most" },
  { value: "50", label: "Balanced", ariaLabel: "Balanced: about 5 hours of study a day at most" },
  { value: "75", label: "Full", ariaLabel: "Full: about 6 hours of study a day at most" },
];

export function SettingsScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch, exportState, importState, flush } = useApp();
  const { scheme, setScheme } = useTheme();
  const isDark = scheme === "dark";
  const [open, setOpen] = useState<Open>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [importNote, setImportNote] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useLocalPref(PREF_KEYS.geminiKey);
  const [aiModel, setAiModel] = useLocalPref(PREF_KEYS.aiModel);
  const [keyDraft, setKeyDraft] = useState(apiKey ?? "");
  const [modelDraft, setModelDraft] = useState(aiModel ?? DEFAULT_AI_MODEL);

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
  function saveKey() {
    const trimmed = keyDraft.trim();
    setApiKey(trimmed ? trimmed : null);
    setAiModel(modelDraft.trim() && modelDraft.trim() !== DEFAULT_AI_MODEL ? modelDraft.trim() : null);
    setOpen(null);
  }

  const activities = state.recurringEvents.length === 0 ? "None" : String(state.recurringEvents.length);

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
        <FieldGroup>
          <FieldPickRow first icon="moon" label="Sleep hours" value={sleepHoursLabel(bedtime, wakeTime)} onPress={() => setOpen("sleep")} ariaLabel={`Sleep hours: ${sleepHoursLabel(bedtime, wakeTime)}. Nothing is planned inside them`} />
          <FieldPickRow icon="work" label="Work and activities" value={activities} onPress={() => navigate("activities")} ariaLabel={`Work and activities that repeat every week: ${activities}`} />
          <FieldPickRow icon="gauge" label="Study load" value={`${formatDuration(caps.dailyMinutes)} a day`} onPress={() => setOpen("study")} ariaLabel={`Study load: up to ${formatDuration(caps.dailyMinutes)} of study a day`} />
        </FieldGroup>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="Your plan, elsewhere" />
        <FieldGroup>
          <FieldPickRow first icon="calSync" label="Calendar file" detail="Every class, session and deadline as an .ics file for Google, Apple or Outlook" value="Download" chevron={false} onPress={exportCalendar} ariaLabel="Download the plan as a calendar file" />
          <FieldPickRow icon="download" label="Back up this plan" detail="A file you can bring back here or on another computer" value="Save" chevron={false} onPress={exportBackup} ariaLabel="Save a backup file of the plan" />
          <FieldPickRow icon="upload" label="Restore a backup" detail="Replaces what is here with the file's plan" value="Open" chevron={false} onPress={() => fileInput.current?.click()} ariaLabel="Restore the plan from a backup file" />
          <input ref={fileInput} type="file" accept="application/json,.json" style={{ display: "none" }} aria-hidden onChange={(e) => { importBackup(e.target.files?.[0]); e.target.value = ""; }} />
        </FieldGroup>
        {importNote ? <Note tone={importNote.tone} icon={importNote.tone === "green" ? "check" : "warning"} role="status">{importNote.text}</Note> : null}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="App" />
        <FieldGroup>
          <FieldPickRow first icon="spark" label="AI syllabus reader" detail={apiKey ? "Your own Gemini key reads syllabi. It stays in this browser" : "Optional: your own Gemini API key reads messy syllabi"} value={apiKey ? "On" : "Off"} tone="violet" onPress={() => { setKeyDraft(apiKey ?? ""); setModelDraft(aiModel ?? DEFAULT_AI_MODEL); setOpen("ai"); }} />
          <FieldPickRow icon={isDark ? "moon" : "sun"} label="Appearance" value={isDark ? "Dark" : "Light"} chevron={false} onPress={() => setScheme(isDark ? "light" : "dark")} ariaLabel={isDark ? "Appearance: dark. Switch to light" : "Appearance: light. Switch to dark"} />
          <FieldPickRow icon="info" label="Help and privacy" onPress={() => setOpen("help")} />
        </FieldGroup>
      </section>

      {confirmingReset ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Note tone="red" icon="warning">Reset the semester? This clears every class, task and study session, the syllabi you imported and the study guides made from them. Your preferences stay.</Note>
          <InlineConfirm question="" confirmLabel="Reset" onConfirm={resetSemester} onCancel={() => setConfirmingReset(false)} />
        </div>
      ) : (
        <button type="button" className="link" onClick={() => setConfirmingReset(true)} aria-label="Reset semester" style={{ minHeight: 44, alignSelf: "center", padding: "0 12px", fontSize: 15, fontWeight: 600, color: colors.error }}>Reset semester</button>
      )}
      <p className="caption mono" style={{ textAlign: "center", letterSpacing: 0.6, fontSize: 12 }}>Trajectory for the web · your plan stays in this browser</p>

      {/* What the sheets changed re-planned the semester: the bar that says so, with its Undo */}
      <UndoReplanBar variant="row" />

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

      {/* The AI reader's key: optional, the student's own, kept in this browser only */}
      <Sheet open={open === "ai"} onClose={() => setOpen(null)} ariaLabel="AI syllabus reader">
        <SheetBody>
          <SheetHead eyebrow="Optional" eyebrowColor={colors.violet} title="AI syllabus reader" onClose={() => setOpen(null)} />
          <p className="sheet-sub" style={{ marginTop: -8 }}>Without a key, Trajectory finds dated items in a pasted syllabus itself. With your own Gemini API key (free from Google AI Studio), Gemini reads the whole document: the class, when it meets, the term and every deadline, including ones written as "Week 6".</p>
          <div>
            <FieldLabel>Gemini API key</FieldLabel>
            <input className="input" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="AIza…" autoComplete="off" aria-label="Gemini API key" />
          </div>
          <div>
            <FieldLabel>Model</FieldLabel>
            <input className="input mono" value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} placeholder={DEFAULT_AI_MODEL} autoComplete="off" aria-label="Model id" style={{ fontSize: 14 }} />
          </div>
          <Note tone="plain" icon="shield">The key is stored in this browser only and sent straight to Google when you import a syllabus. Nothing goes through a Trajectory server. Gemini Flash has a free tier; beyond it an import costs a fraction of a cent on your account.</Note>
          <PrimaryButton size="lg" fullWidth label={keyDraft.trim() ? "Save key" : apiKey ? "Remove key" : "Done"} onPress={saveKey} />
        </SheetBody>
      </Sheet>

      {/* Help and privacy */}
      <Sheet open={open === "help"} onClose={() => setOpen(null)} ariaLabel="Help and privacy">
        <SheetBody>
          <SheetHead title="Help and privacy" onClose={() => setOpen(null)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 14.5, lineHeight: "21px", color: colors.muted }}>
            <p style={{ margin: 0 }}><strong style={{ color: colors.foreground }}>How planning works.</strong> Add your classes and deadlines (or paste a syllabus) and Trajectory places study sessions in the free time before each deadline, around your classes, work, activities and sleep. Whenever something changes, it re-plans the whole semester by itself and offers an Undo.</p>
            <p style={{ margin: 0 }}><strong style={{ color: colors.foreground }}>Replan.</strong> Today's Replan link previews a new plan for today, the week or the semester. Nothing changes until you apply it, and every applied change can be undone.</p>
            <p style={{ margin: 0 }}><strong style={{ color: colors.foreground }}>Privacy.</strong> Your plan is saved in this browser's storage and never sent anywhere. Clearing the site's data removes it, so keep a backup file if it matters. If you add a Gemini API key, the syllabus text you import is sent to Google under your own account and nowhere else.</p>
          </div>
          <PrimaryButton size="lg" fullWidth tone="ghost" label="Close" onPress={() => setOpen(null)} />
        </SheetBody>
      </Sheet>
    </div>
  );
}
