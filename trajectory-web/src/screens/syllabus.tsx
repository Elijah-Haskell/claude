// The syllabus import: upload ONCE and the whole semester is planned. Four steps, counted at the top of each:
//
//   1. Add your syllabus   a file, photos or pasted text; then the wait while the server reads it (the live list)
//   2. Check your class    the class and its short name, days and times (prefilled), the term (asked once), breaks
//   3. Check the dates     only the doubtful ones ask for attention; nothing without a date is planned
//   4. Building your plan  duplicate-aware; the plan is built right away
//
// It ends on Today, which shows what was planned and how to undo it (src/engine/setup-recap.ts). All decisions live
// in src/engine/syllabus-*.ts (pure and tested); this file only collects the student's choices. The reading is the
// one server-backed step: the file goes up (components/syllabus/use-syllabus-source.ts), the server reads it as a job
// that is polled once a second (src/engine/poll-job.ts) and reports the deadlines it has found so far
// (src/lib/live-list.ts), and the job id is kept in this browser (src/lib/pending-extraction.ts) so a reload picks
// the result up instead of paying for a second reading.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { latestImportFor } from "../engine/classes-view";
import { findBestClassMatch } from "../engine/course-matcher";
import { alpha } from "../engine/design";
import { JobFailed, LIVE_READING_POLL_OPTIONS, pollJob, type JobPollProgress } from "../engine/poll-job";
import { buildSetupRecap } from "../engine/setup-recap";
import { semesterNameFor } from "../engine/syllabus-dates";
import { resolveCourseTerm, resolveExtractedItems, serializeExtraction, SYLLABUS_ITEM_TYPES, type MeetingPattern, type SyllabusExtraction, type SyllabusItemType } from "../engine/syllabus-extraction-utils";
import {
  applySyllabusImport,
  assessTerm,
  buildDraftItems,
  buildSyllabusImport,
  composeClassName,
  decideSemester,
  importableDrafts,
  isValidMeeting,
  partitionDuplicates,
  prefillBasics,
  reresolveDrafts,
  setDraftDate,
  summarizeImportPlan,
  type ClassTarget,
  type DraftItem,
  type DuplicateMatch,
  type SemesterOutcome,
  type TermAssessment,
} from "../engine/syllabus-import";
import { describeIntakeFailure, PASTE_PICTURE_NOTE, type IntakeFailure } from "../engine/syllabus-messages";
import { classNameFromSyllabus, classStepBlocker, flowStepNumber, lookLine, lookReasonOf, planButtonLabel, plannedCount, readingExpectation, readingRows, reviewBuckets, reviewDate, reviewSummary, shownImportWarnings, termRangeLabel, type FlowStep, type SourceKind } from "../engine/syllabus-review";
import type { ClassBlock, DayOfWeek, Semester } from "../engine/types";
import { todayString } from "../engine/utils";
import { classShortName, normalizeShortName, SHORT_NAME_MAX, suggestShortName } from "../engine/week-layout";
import { mutate, query, type SyllabusExtractionResult } from "../lib/api";
import { liveCourseName, liveItemsOf, liveModeAfter, mergeLiveItems, showsLiveList, type LiveItem, type LiveMode } from "../lib/live-list";
import { clearPendingExtraction, isSameSource, loadPendingExtraction, savePendingExtraction } from "../lib/pending-extraction";
import { decideSyllabusUpload } from "../lib/subscription-plans";
import { readingOfResult } from "../lib/syllabus-result";
import { pendingSourceOf, sourceWords, type ExtractionSource } from "../lib/syllabus-source";
import { FREE_SYLLABUS_LIMIT_ERR_MSG, PRO_GATE_CODES } from "../shared/pro";
import { goBack, useNavigate, useRoute } from "../router";
import { useApp } from "../state/app-provider";
import { useAuth } from "../state/auth";
import { PREF_KEYS, writePref } from "../state/local-prefs";
import { useProStatus } from "../state/subscription-context";
import { Icon } from "../ui/icon";
import { AppSwitch, CheckBox, DateInput, FieldGroup, FieldLabel, FieldRow, MONO_FONT, Note, PrimaryButton, SectionLabel, Segmented, TimeInput, DayToggles } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useDesktop, useWideLayout } from "../ui/layout";
import { useColors } from "../ui/theme";
import { ReadingStep } from "../components/syllabus/reading-step";
import { FlowFooter, FlowTitle, formatShortDate, StepBar, TextLink, TYPE_ICON } from "../components/syllabus/shared";
import { effectiveSourceMode, SourceStep, type SourceMode } from "../components/syllabus/source-step";
import { describeFailure, useSyllabusSource } from "../components/syllabus/use-syllabus-source";

// ── Step 2: the class ─────────────────────────────────────────

interface BasicsDraft {
  name: string;
  code: string;
  shortName: string;
  isAsynchronous: boolean;
  days: DayOfWeek[];
  startTime: string;
  endTime: string;
  location: string;
}
type TermChoiceKind = "keep" | "replace" | "create" | "skip";

const ORDER: DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function BasicsStep(p: {
  basics: BasicsDraft;
  onBasics: (patch: Partial<BasicsDraft>) => void;
  modelSaysAsync: boolean;
  meetingMissing: boolean;
  classes: ClassBlock[];
  linkedClass: ClassBlock | null;
  onLinkClass: (cls: ClassBlock | null) => void;
  assessment: TermAssessment;
  termChoice: TermChoiceKind;
  onTermChoice: (choice: TermChoiceKind) => void;
  termName: string;
  termStart: string;
  termEnd: string;
  onTerm: (patch: { start?: string; end?: string }) => void;
  includeBreaks: boolean;
  onIncludeBreaks: (value: boolean) => void;
  confirmedCandidates: readonly string[];
  onToggleCandidate: (key: string) => void;
  warnings: readonly string[];
  error: string | null;
  onContinue: () => void;
  existingSemester: Semester | null;
}) {
  const colors = useColors();
  const desktop = useDesktop();
  const { basics } = p;
  const [choosingClass, setChoosingClass] = useState(false);
  const toggleDay = (day: DayOfWeek) => p.onBasics({ days: basics.days.includes(day) ? basics.days.filter((d) => d !== day) : ORDER.filter((d) => d === day || basics.days.includes(d)) });

  const termMode = p.assessment.mode;
  const termSkipped = p.termChoice === "skip";
  const blocker = classStepBlocker({ name: basics.name, linked: p.linkedClass !== null, isAsynchronous: basics.isAsynchronous, days: basics.days, startTime: basics.startTime, endTime: basics.endTime, termMode, termSkipped, termStart: p.termStart, termEnd: p.termEnd });
  const timesMissing = !basics.isAsynchronous && (!basics.startTime || !basics.endTime);
  const rangeText = (start: string, end: string) => `${formatShortDate(start)}${end !== start ? ` – ${formatShortDate(end)}` : ""}`;
  const small = { fontSize: 13, lineHeight: "18px", color: colors.muted } as const;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <FlowTitle title="Check your class" sub="Found in your syllabus. Fix anything that is off." />

        {p.warnings.length > 0 ? (
          <Note tone="gold" icon="warning">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {p.warnings.map((warning) => <span key={warning} style={{ fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{warning}</span>)}
            </div>
          </Note>
        ) : null}

        {/* A computer: the class on the left, the term on the right. */}
        <div style={desktop ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 32, alignItems: "start" } : { display: "contents" }}>
        <div style={desktop ? { display: "flex", flexDirection: "column", gap: 18, minWidth: 0 } : { display: "contents" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <FieldLabel>Class</FieldLabel>
              <input className="input" value={p.linkedClass ? p.linkedClass.name : basics.name} onChange={(e) => p.onBasics({ name: e.target.value })} readOnly={Boolean(p.linkedClass)} placeholder="Class name" maxLength={200} aria-label="Class name" style={p.linkedClass ? { color: colors.muted } : undefined} />
            </div>
            <div>
              <FieldLabel>Short name</FieldLabel>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input className="input" style={{ width: 124, fontFamily: MONO_FONT, textTransform: "uppercase" }} value={basics.shortName} onChange={(e) => p.onBasics({ shortName: e.target.value.toUpperCase().slice(0, SHORT_NAME_MAX) })} onBlur={() => p.onBasics({ shortName: normalizeShortName(basics.shortName) })} placeholder="FINC" maxLength={SHORT_NAME_MAX} aria-label="Short name" title="The tag shown on small blocks and next to a session's name" />
                <span style={{ ...small, flex: 1 }}>The tag on small blocks and next to a session&apos;s name.</span>
              </div>
            </div>
          </div>
          {p.classes.length > 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...small, flex: 1 }}>{p.linkedClass ? "These dates join the class you already have." : "This makes a new class."}</span>
              <TextLink label={choosingClass ? "Done" : "Change"} onPress={() => setChoosingClass((open) => !open)} ariaLabel="Choose which class these dates belong to" />
            </div>
          ) : null}
          {choosingClass ? (
            <FieldGroup>
              {[...p.classes, null].map((cls) => {
                const selected = cls ? p.linkedClass?.id === cls.id : p.linkedClass === null;
                return (
                  <button key={cls?.id ?? "new"} type="button" role="radio" aria-checked={selected} aria-label={cls ? cls.name : "A new class"} className="row pressable" onClick={() => { p.onLinkClass(cls); setChoosingClass(false); }}>
                    <span className="row-label truncate" style={{ flex: 1 }}>{cls ? cls.name : "A new class"}</span>
                    {selected ? <Icon name="check" size={18} color={colors.success} strokeWidth={2.4} /> : null}
                  </button>
                );
              })}
            </FieldGroup>
          ) : null}
        </div>

        {basics.isAsynchronous ? null : (
          <div>
            <FieldLabel>Class days</FieldLabel>
            {/* The letters centred in their buttons on a computer (the buttons take the text alignment around them). */}
            <div style={desktop ? { textAlign: "center" } : { display: "contents" }}>
              <DayToggles days={basics.days} onToggle={toggleDay} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {p.meetingMissing && timesMissing ? <Note tone="gold">The syllabus didn&apos;t list a class time. Choose when it starts and ends.</Note> : null}
          {p.modelSaysAsync && !basics.isAsynchronous ? <Note>The syllabus reads like an online class with no set time. If that is right, turn on “No set class time”.</Note> : null}
          <FieldGroup>
            {basics.isAsynchronous ? null : (
              <>
                <FieldRow first icon="clock" label="Starts">
                  <TimeInput ariaLabel="Class start time" value={basics.startTime} onChange={(startTime) => p.onBasics({ startTime })} unsetTone={!basics.startTime} />
                </FieldRow>
                <FieldRow icon="clock" label="Ends">
                  <TimeInput ariaLabel="Class end time" value={basics.endTime} onChange={(endTime) => p.onBasics({ endTime })} unsetTone={!basics.endTime} />
                </FieldRow>
              </>
            )}
            <FieldRow first={basics.isAsynchronous} icon="phone" label="No set class time" detail="Online or self-paced">
              <AppSwitch value={basics.isAsynchronous} onValueChange={(isAsynchronous) => p.onBasics({ isAsynchronous })} ariaLabel="No set class time" />
            </FieldRow>
            <FieldRow icon="pin" label="Where">
              <input value={basics.location} onChange={(e) => p.onBasics({ location: e.target.value })} placeholder="Optional" maxLength={120} aria-label="Room or link, optional" style={{ minWidth: 130, width: "100%", height: 44, fontSize: 15, textAlign: "right", background: "transparent", border: "none", outline: "none", color: colors.foreground }} />
            </FieldRow>
          </FieldGroup>
        </div>

        </div>
        <div style={desktop ? { display: "flex", flexDirection: "column", gap: 18, minWidth: 0 } : { display: "contents" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {termMode === "new" ? (
            termSkipped ? (
              <>
                <FieldLabel style={{ marginBottom: -3 }}>Term</FieldLabel>
                <Note tone="plain" icon="cal">No term dates for now. The plan follows your deadlines.</Note>
                <TextLink label="Add the term dates" onPress={() => p.onTermChoice("create")} style={{ alignSelf: "flex-start", padding: 0, margin: "-8px 0" }} />
              </>
            ) : (
              <>
                <FieldLabel style={{ marginBottom: -3 }}>{p.termName ? `Term · ${p.termName}` : "Term"}</FieldLabel>
                <FieldGroup>
                  <FieldRow first icon="cal" label="First day">
                    <DateInput ariaLabel="Term start date" value={p.termStart} onChange={(start) => p.onTerm({ start })} />
                  </FieldRow>
                  <FieldRow icon="cal" label="Last day">
                    <DateInput ariaLabel="Term end date" value={p.termEnd} min={p.termStart || undefined} onChange={(end) => p.onTerm({ end })} />
                  </FieldRow>
                </FieldGroup>
                <span style={small}>Asked once, and used for every class.</span>
                <TextLink label="Skip the term dates for now" color={colors.muted} onPress={() => p.onTermChoice("skip")} style={{ alignSelf: "flex-start", padding: 0, margin: "-8px 0" }} />
              </>
            )
          ) : null}

          {termMode === "agree" && p.existingSemester ? (
            <>
              <FieldLabel style={{ marginBottom: -3 }}>Term</FieldLabel>
              <FieldGroup>
                <FieldRow first icon="cal" label={p.existingSemester.name} detail="Fits this syllabus">
                  <span style={{ fontSize: 15, lineHeight: "20px", color: colors.muted }}>{termRangeLabel(p.existingSemester.startDate, p.existingSemester.endDate)}</span>
                </FieldRow>
              </FieldGroup>
            </>
          ) : null}

          {termMode === "conflict" && p.existingSemester ? (
            <>
              <FieldLabel style={{ marginBottom: -3 }}>Term</FieldLabel>
              <Note tone="gold">This syllabus has different term dates than your semester. Which one is right?</Note>
              <Segmented
                options={[
                  { value: "keep", label: "Keep mine" },
                  { value: "replace", label: "Use the syllabus" },
                ]}
                value={p.termChoice === "replace" ? "replace" : "keep"}
                onChange={(value) => p.onTermChoice(value)}
              />
              <FieldGroup>
                {(["keep", "replace"] as const).map((choice) => {
                  const active = (p.termChoice === "replace" ? "replace" : "keep") === choice;
                  const start = choice === "keep" ? p.existingSemester!.startDate : p.assessment.proposedStart ?? p.existingSemester!.startDate;
                  const end = choice === "keep" ? p.existingSemester!.endDate : p.assessment.proposedEnd ?? p.existingSemester!.endDate;
                  return (
                    <div key={choice} className="row">
                      <span className="row-label" style={{ flex: 1, color: active ? colors.foreground : colors.muted }}>{choice === "keep" ? "Mine" : "The syllabus"}</span>
                      <span style={{ fontSize: 15, lineHeight: "20px", color: active ? colors.peri : colors.muted, fontWeight: active ? 600 : 400 }}>{termRangeLabel(start, end)}</span>
                    </div>
                  );
                })}
              </FieldGroup>
            </>
          ) : null}
        </div>

        {p.assessment.newBreaks.length > 0 && !termSkipped ? (
          <FieldGroup>
            <FieldRow first icon="moon" label="Breaks found" detail={p.includeBreaks ? "No class on these days" : "Not added"}>
              <AppSwitch value={p.includeBreaks} onValueChange={p.onIncludeBreaks} ariaLabel="Add these breaks to the term" />
            </FieldRow>
            {p.assessment.newBreaks.map((b) => (
              <div key={`${b.name}-${b.startDate}`} className="row" style={{ opacity: p.includeBreaks ? 1 : 0.55 }}>
                <span className="row-label clamp2" style={{ flex: 1 }}>{b.name}</span>
                <span style={{ fontSize: 15, lineHeight: "20px", color: colors.muted }}>{rangeText(b.startDate, b.endDate)}</span>
              </div>
            ))}
          </FieldGroup>
        ) : null}

        {p.assessment.candidateBreaks.length > 0 && !termSkipped ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FieldLabel style={{ marginBottom: -3 }}>Is there class on these days?</FieldLabel>
            <span style={small}>The syllabus marks these days but still lists a class. Turn one on only if there is no class that day.</span>
            <FieldGroup>
              {p.assessment.candidateBreaks.map((b) => {
                const key = `${b.startDate}|${b.endDate}`;
                return (
                  <div key={key} className="row">
                    <span className="row-text">
                      <span className="row-label clamp2" style={{ display: "block" }}>{b.name}</span>
                      <span style={small}>{rangeText(b.startDate, b.endDate)}</span>
                    </span>
                    <AppSwitch value={p.confirmedCandidates.includes(key)} onValueChange={() => p.onToggleCandidate(key)} ariaLabel={`No class on ${b.name}`} />
                  </div>
                );
              })}
            </FieldGroup>
          </div>
        ) : null}
        </div>
        </div>
      </div>

      <FlowFooter hint={blocker ?? p.error} hintTone={blocker ? "gold" : "red"}>
        <PrimaryButton size="lg" fullWidth label="Continue" onPress={p.onContinue} disabled={blocker !== null} ariaLabel={blocker ? `Continue. ${blocker}` : "Continue to the dates"} />
      </FlowFooter>
    </>
  );
}

// ── Step 3: the dates ─────────────────────────────────────────

const isTest = (item: DraftItem) => item.type === "exam" || item.type === "quiz";

function RowButton({ label, onPress, ariaLabel }: { label: string; onPress: () => void; ariaLabel: string }) {
  const colors = useColors();
  return (
    <button type="button" className="pressable" onClick={onPress} aria-label={ariaLabel} style={{ minHeight: 44, padding: "0 14px", borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: alpha(colors.peri, 0.08), color: colors.foreground, fontSize: 15, fontWeight: 600, flexShrink: 0, alignSelf: "center" }}>
      {label}
    </button>
  );
}

/** A doubtful item: its name, its date and what is doubtful about it, the line it came from, and the way to fix it. */
function LookRow({ item, termKnown, onToggle, onEdit, onUseDate }: { item: DraftItem; termKnown: boolean; onToggle: () => void; onEdit: () => void; onUseDate: (key: string) => void }) {
  const colors = useColors();
  const dated = item.dueDate !== null;
  const hint = !dated && item.weekHint ? item.weekHint : null;
  const confirmable = dated && lookReasonOf(item, { termKnown }) === "guess";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", padding: "10px 12px 10px 2px", gap: 0 }}>
      {dated ? <CheckBox checked={item.selected} onPress={onToggle} ariaLabel={`${item.name}. ${item.selected ? "Included in the plan. Tick to leave it out" : "Left out. Tick to include it"}`} style={{ marginTop: 6 }} /> : <span style={{ width: 12 }} />}
      <div style={{ flex: 1, minWidth: 0, padding: "2px 10px 2px 2px", display: "flex", flexDirection: "column", gap: 3, opacity: dated && !item.selected ? 0.6 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isTest(item) ? <Icon name="flag" size={15} color={colors.gold} /> : null}
          <span className="clamp2" style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{item.name}</span>
        </div>
        <span style={{ fontSize: 14, lineHeight: "19px", color: dated ? colors.muted : colors.gold }}>{lookLine(item)}</span>
        {item.dateEvidence ? <span className="clamp2" style={{ fontSize: 13, lineHeight: "18px", fontStyle: "italic", color: colors.muted }}>From the syllabus: “{item.dateEvidence}”</span> : null}
        {hint ? <TextLink label={`Use ${reviewDate(hint.end)}, the end of that week`} onPress={() => onUseDate(hint.end)} style={{ alignSelf: "flex-start", padding: 0 }} /> : null}
        {confirmable ? <TextLink label="This date is right" ariaLabel={`${reviewDate(item.dueDate!)} is right for ${item.name}`} onPress={() => onUseDate(item.dueDate!)} style={{ alignSelf: "flex-start", padding: 0 }} /> : null}
        {!dated ? <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>Left out of the plan until it has a date.</span> : null}
      </div>
      <RowButton label={dated ? "Edit" : "Add date"} onPress={onEdit} ariaLabel={dated ? `Edit ${item.name}` : `Add a date for ${item.name}`} />
    </div>
  );
}

/** A plain row: the tick, the name (click it to edit), the date. */
function PlainRow({ item, onToggle, onEdit }: { item: DraftItem; onToggle: () => void; onEdit: () => void }) {
  const colors = useColors();
  const date = item.dueDate ? reviewDate(item.dueDate) : "No date";
  return (
    <div style={{ display: "flex", alignItems: "center", minHeight: 52, paddingLeft: 2 }}>
      <CheckBox checked={item.selected} onPress={onToggle} ariaLabel={`${item.name}, ${date}. ${item.selected ? "Included in the plan. Tick to leave it out" : "Left out. Tick to include it"}`} />
      <button type="button" className="pressable" onClick={onEdit} aria-label={`Edit ${item.name}, ${date}`} style={{ flex: 1, minWidth: 0, minHeight: 52, display: "flex", alignItems: "center", gap: 10, padding: "8px 14px 8px 8px", textAlign: "left", opacity: item.selected ? 1 : 0.6 }}>
        <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {isTest(item) ? <Icon name="flag" size={15} color={colors.gold} /> : null}
          <span className="clamp2" style={{ fontSize: 15, lineHeight: "20px", fontWeight: 500, color: colors.foreground }}>{item.name}</span>
        </span>
        <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", color: colors.muted, flexShrink: 0 }}>{date}</span>
      </button>
    </div>
  );
}

function ItemsStep(p: { drafts: DraftItem[]; today: string; isCommitting: boolean; truncated: boolean; termKnown: boolean; error?: string | null; onToggle: (id: string) => void; onEdit: (item: DraftItem) => void; onSetDate: (id: string, text: string) => string | null; onCommit: () => void }) {
  const colors = useColors();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const [showPast, setShowPast] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);
  const { look, right, past } = reviewBuckets(p.drafts, p.today, { termKnown: p.termKnown });
  const planned = plannedCount(p.drafts);
  const allRight = right.length > 0 && right.every((d) => d.selected);
  const applyDate = (id: string, key: string) => setDateError(p.onSetDate(id, key));
  const count = { fontFamily: MONO_FONT, fontSize: 12.5, fontWeight: 600, color: colors.muted } as const;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <FlowTitle title="Check the dates" sub={reviewSummary(p.drafts, p.today)} />
        {p.truncated ? <Note tone="gold" icon="warning">This syllabus was long, so the list may be missing items at the end. Add anything missing with the add button afterwards.</Note> : null}

        {/* A wide computer screen: what needs a look beside what looks right. */}
        <div style={desktop && wide && look.length > 0 && right.length > 0 ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 24, alignItems: "start" } : { display: "contents" }}>
        {look.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel title={`Take a look at ${look.length}`} right={<span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 7px", borderRadius: 6, border: `1px solid ${alpha(colors.gold, 0.5)}`, background: alpha(colors.gold, 0.14), fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: colors.gold }}><Icon name="info" size={13} color={colors.gold} strokeWidth={2} />Unsure</span>} />
            <FieldGroup>
              {look.map((item) => <LookRow key={item.id} item={item} termKnown={p.termKnown} onToggle={() => p.onToggle(item.id)} onEdit={() => p.onEdit(item)} onUseDate={(key) => applyDate(item.id, key)} />)}
            </FieldGroup>
            {dateError ? <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: "18px", fontWeight: 600, color: colors.error }}>{dateError}</p> : null}
          </section>
        ) : null}

        {right.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel title={`Looks right · ${right.length}`} right={<TextLink label={allRight ? "Untick all" : "Tick all"} ariaLabel={allRight ? "Leave all of these out" : "Include all of these"} onPress={() => right.forEach((d) => { if (d.selected === allRight) p.onToggle(d.id); })} style={{ minHeight: 28 }} />} />
            <FieldGroup>{right.map((item) => <PlainRow key={item.id} item={item} onToggle={() => p.onToggle(item.id)} onEdit={() => p.onEdit(item)} />)}</FieldGroup>
          </section>
        ) : null}
        </div>

        {past.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel title={`Already past · ${past.length}`} color={colors.muted} right={<TextLink label={showPast ? "Hide" : "Show"} ariaLabel={showPast ? "Hide the items already past" : `Show the ${past.length} items already past`} onPress={() => setShowPast((v) => !v)} style={{ minHeight: 28 }} />} />
            {showPast ? <FieldGroup>{past.map((item) => <PlainRow key={item.id} item={item} onToggle={() => p.onToggle(item.id)} onEdit={() => p.onEdit(item)} />)}</FieldGroup> : <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>Left out of the plan. Show them to add one back.</span>}
          </section>
        ) : null}

        {look.length === 0 && right.length === 0 && past.length === 0 ? <span style={count}>Nothing was found.</span> : null}
      </div>

      <FlowFooter hint={p.error} hintTone="red">
        <PrimaryButton size="lg" fullWidth label={p.isCommitting ? "Building your plan…" : planButtonLabel(planned)} loading={p.isCommitting} onPress={p.onCommit} disabled={planned === 0 || p.isCommitting} ariaLabel={planned === 0 ? "Nothing to plan yet. Tick at least one item with a date" : planButtonLabel(planned)} />
      </FlowFooter>
    </>
  );
}

// ── Edit one item, and the duplicates question ────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function EditItemSheet({ item, onClose, onSave }: { item: DraftItem | null; onClose: () => void; onSave: (id: string, patch: { name: string; type: SyllabusItemType; date: string; dueTime: string; estimatedMinutes: number; difficulty: number; weightPercent: number | null }) => string | null }) {
  const colors = useColors();
  const [name, setName] = useState("");
  const [type, setType] = useState<SyllabusItemType>("assignment");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [minutes, setMinutes] = useState("");
  const [difficulty, setDifficulty] = useState(3);
  const [weight, setWeight] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setName(item.name);
    setType(item.type);
    setDate(item.dueDate ?? "");
    setTime(item.dueTime);
    setMinutes(String(item.estimatedMinutes));
    setDifficulty(item.difficulty);
    setWeight(item.weightPercent === null ? "" : String(item.weightPercent));
    setError(null);
  }, [item]);

  const save = () => {
    if (!item) return;
    const mins = parseInt(minutes, 10);
    if (!Number.isFinite(mins) || mins < 15 || mins > 960) return setError("Study time has to be between 15 and 960 minutes.");
    if (time.trim() && !HHMM.test(time.trim())) return setError("Choose the time again, or clear it.");
    const w = weight.trim() === "" ? null : Number(weight);
    if (w !== null && (!Number.isFinite(w) || w < 0 || w > 100)) return setError("The share of the grade has to be between 0 and 100.");
    const message = onSave(item.id, { name: name.trim() || item.name, type, date: date.trim(), dueTime: time.trim(), estimatedMinutes: mins, difficulty, weightPercent: w === null || w === 0 ? null : w });
    if (message) setError(message);
    else onClose();
  };

  return (
    <Sheet open={item !== null} onClose={onClose} ariaLabel="Edit the item">
      {item ? (
        <SheetBody>
          <SheetHead title="Edit" onClose={onClose} />
          {item.dateEvidence ? <p className="sheet-sub" style={{ marginTop: -8, fontStyle: "italic", fontSize: 13 }}>From the syllabus: “{item.dateEvidence}”</p> : null}
          <div>
            <FieldLabel>Name</FieldLabel>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="Name" />
          </div>
          <div>
            <FieldLabel>What it is</FieldLabel>
            <div role="radiogroup" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SYLLABUS_ITEM_TYPES.map((t) => {
                const active = type === t;
                const label = t.charAt(0).toUpperCase() + t.slice(1);
                return (
                  <button key={t} type="button" role="radio" aria-checked={active} aria-label={label} onClick={() => setType(t)} style={{ width: "31.5%", minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 12, border: `1px solid ${active ? alpha(colors.peri, 0.7) : colors.borderStrong}`, background: active ? alpha(colors.peri, 0.14) : "transparent", color: active ? colors.foreground : colors.muted, fontSize: 13, fontWeight: 600 }}>
                    <Icon name={TYPE_ICON[t] ?? "list"} size={16} color={active ? colors.peri : colors.muted} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <FieldLabel>Due date</FieldLabel>
              <DateInput ariaLabel="Due date" value={date} onChange={setDate} style={{ width: "100%" }} />
              {date ? <TextLink label="Clear the date" color={colors.muted} onPress={() => setDate("")} style={{ minHeight: 32, padding: 0 }} /> : null}
            </div>
            <div style={{ flex: 1 }}>
              <FieldLabel>Time · optional</FieldLabel>
              <TimeInput ariaLabel="Due time" value={time} onChange={setTime} style={{ width: "100%" }} />
              {time ? <TextLink label="Clear the time" color={colors.muted} onPress={() => setTime("")} style={{ minHeight: 32, padding: 0 }} /> : null}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <FieldLabel>Study minutes</FieldLabel>
              <input className="input" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="Study time in minutes" />
            </div>
            <div style={{ flex: 1 }}>
              <FieldLabel>Grade % · optional</FieldLabel>
              <input className="input" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.slice(0, 5))} placeholder="20" aria-label="Share of the grade, in percent" />
            </div>
          </div>
          <div>
            <FieldLabel>Difficulty</FieldLabel>
            <Segmented options={[1, 2, 3, 4, 5].map((d) => ({ value: String(d), label: String(d), ariaLabel: `Difficulty ${d} of 5` }))} value={String(difficulty)} onChange={(v) => setDifficulty(Number(v))} />
          </div>
          {error ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{error}</p> : null}
          <PrimaryButton size="lg" fullWidth label="Save" onPress={save} ariaLabel="Save the changes" />
        </SheetBody>
      ) : null}
    </Sheet>
  );
}

function DuplicateSheet({ open, duplicates, onCancel, onContinue }: { open: boolean; duplicates: DuplicateMatch[]; onCancel: () => void; onContinue: (overwriteIds: Set<string>) => void }) {
  const colors = useColors();
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setOverwrite(new Set());
  }, [open]);
  const toggle = (id: string) =>
    setOverwrite((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const many = duplicates.length !== 1;
  return (
    <Sheet open={open} onClose={onCancel} ariaLabel="Already in your plan">
      <SheetBody>
        <SheetHead title="Already in your plan" onClose={onCancel} />
        <p className="sheet-sub" style={{ marginTop: -8 }}>
          {duplicates.length} {many ? "items match" : "item matches"} something you already have. {many ? "They are" : "It is"} kept as {many ? "they are" : "it is"} unless you tick {many ? "one" : "it"} to replace it.
        </p>
        <FieldGroup>
          {duplicates.map((dup) => {
            const checked = overwrite.has(dup.draft.id);
            const date = dup.draft.dueDate ? reviewDate(dup.draft.dueDate) : "No date";
            return (
              <div key={dup.draft.id} className="row" style={{ paddingLeft: 2, gap: 0 }}>
                <CheckBox checked={checked} onPress={() => toggle(dup.draft.id)} ariaLabel={`Replace ${dup.draft.name}, due ${date}`} />
                <button type="button" className="pressable" onClick={() => toggle(dup.draft.id)} tabIndex={-1} aria-hidden style={{ flex: 1, minWidth: 0, padding: "9px 14px 9px 8px", textAlign: "left" }}>
                  <span className="clamp2" style={{ display: "block", fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{dup.draft.name}</span>
                  <span style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 1, color: checked ? colors.peri : colors.muted }}>{date} · {checked ? "its study time and difficulty are replaced" : "kept as it is"}</span>
                </button>
              </div>
            );
          })}
        </FieldGroup>
        <PrimaryButton size="lg" fullWidth label={overwrite.size > 0 ? `Continue and replace ${overwrite.size}` : "Continue"} onPress={() => onContinue(overwrite)} />
      </SheetBody>
    </Sheet>
  );
}

// ── The screen ────────────────────────────────────────────────

interface Run {
  runId: string;
  kind: SourceKind;
  rawText: string;
  extractionJson: string;
  course: { name: string; code: string; isAsynchronous: boolean; meetingPattern: MeetingPattern | null };
  warnings: string[];
  truncated: boolean;
  assessment: TermAssessment;
  meetingMissing: boolean;
  resolvedStart: string | null;
  resolvedEnd: string | null;
  resolvedBreaks: { name: string; startDate: string; endDate: string }[];
}

const WAYS_IN = "A PDF, a Word file, photos or pasted text all work.";

/** The server's refusal of a second free syllabus, as the app itself can foresee it (the same card, before any upload). */
function freeSyllabusLimitError(): Error {
  return Object.assign(new Error(FREE_SYLLABUS_LIMIT_ERR_MSG), { data: { code: "FORBIDDEN", appCode: PRO_GATE_CODES.freeSyllabusLimit } });
}

/** "No assignments found": the reading worked, but nothing in it can be planned. */
function nothingFound(kind: SourceKind, warnings: readonly string[]): IntakeFailure {
  return {
    title: "No assignments found",
    message:
      kind === "paste"
        ? warnings[0] ?? "We could not find any assignments or exams in this text."
        : `${warnings[0] ?? "We could not find any assignments or exams in this document."} If the text is readable, pasting it may work. ${PASTE_PICTURE_NOTE}`,
    canRetry: false,
    offerPaste: kind !== "paste",
  };
}

function errorCode(error: unknown): string {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof code === "string" ? code : "";
}

export function SyllabusScreen() {
  const navigate = useNavigate();
  const desktop = useDesktop();
  const route = useRoute();
  const { state, dispatch } = useApp();
  const today = todayString();

  const prefilledClass = useMemo(() => (route.query.classId ? state.classes.find((c) => c.id === route.query.classId) ?? null : null), [route.query.classId, state.classes]);

  // Reading a syllabus is the one server-backed step here; the rest happens in this browser. It runs under the
  // account's session (ensureSession below).
  const { user } = useAuth();
  const hasSession = user !== null;
  const hasSessionRef = useRef(hasSession);
  useEffect(() => {
    hasSessionRef.current = hasSession;
  }, [hasSession]);
  /**
   * True when server calls can be made: there is a session. An account is required here, and the gate above every
   * route shows the sign-in screen when the session goes; on false nothing is sent and nothing picked is dropped.
   */
  const ensureSession = useCallback(async (): Promise<boolean> => hasSessionRef.current, []);

  // The free plan plans one syllabus; the server is the authority (it remembers every syllabus an account imported)
  // and refuses a second one with FREE_SYLLABUS_LIMIT. This local check only saves a pointless upload when the app
  // already knows (src/lib/subscription-plans.ts decideSyllabusUpload). Adding a class's syllabus AGAIN is left to the
  // server: it allows the same syllabus a second time.
  const { isPro, isLoading: isProLoading } = useProStatus();
  const imports = state.syllabusImports ?? [];
  const addingAgain = prefilledClass !== null && latestImportFor(prefilledClass.id, imports) !== undefined;
  const uploadDecision = addingAgain ? "allow" : decideSyllabusUpload({ isPro, isLoading: isProLoading, syllabusCount: imports.length });

  const [step, setStep] = useState<FlowStep>("source");
  const [sourceMode, setSourceMode] = useState<SourceMode>("pick");
  // The class the import was opened for (from Classes) is passed to the reader as a hint for the course's name; a
  // resumed read brings back the hint it started with, so "Try again" sends the same one.
  const [courseHint, setCourseHint] = useState(route.query.className ?? prefilledClass?.name ?? "");
  const [isExtracting, setIsExtracting] = useState(false);
  const [failure, setFailure] = useState<IntakeFailure | null>(null);
  const lastSource = useRef<ExtractionSource | null>(null);
  const extractingRef = useRef(false);
  // Each read gets a token; Cancel (or leaving the screen) moves the token on, which stops the polling and
  // makes a late answer from the old read land nowhere. The server keeps reading; the job id is remembered
  // (src/lib/pending-extraction.ts) so coming back picks the result up.
  const runToken = useRef(0);

  // The clock of the wait runs in this browser, from when the read began (a resumed read: from when it first began).
  const [readStartedAt, setReadStartedAt] = useState<number | null>(null);
  const [clockMs, setClockMs] = useState(0);
  const [progress, setProgress] = useState<JobPollProgress | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  // The live import (the mobile repo's docs/live-import.md): the deadlines the server has found so far, shown while it
  // reads. A preview for the wait only. The class and the dates the student checks are built from the reading's result.
  const [liveMode, setLiveMode] = useState<LiveMode>("unknown");
  const [liveItems, setLiveItems] = useState<readonly LiveItem[] | null>(null);
  const [liveCourse, setLiveCourse] = useState<string | null>(null);
  const [resumedRead, setResumedRead] = useState(false);

  // False once the screen is gone: a plan that finishes building after that is still applied (and Today says so),
  // but a late answer must not move the student off whatever screen they have gone to.
  const mounted = useRef(true);
  useEffect(() => {
    const tokens = runToken;
    return () => {
      mounted.current = false;
      tokens.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!isExtracting || readStartedAt === null) return;
    const tick = () => setClockMs(Math.max(0, Date.now() - readStartedAt));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isExtracting, readStartedAt]);

  const [run, setRun] = useState<Run | null>(null);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [basics, setBasics] = useState<BasicsDraft>({ name: "", code: "", shortName: "", isAsynchronous: false, days: [], startTime: "", endTime: "", location: "" });
  // The student changed the days, times or room themselves: choosing another class then keeps what they entered.
  const [meetingTouched, setMeetingTouched] = useState(false);
  const [linkedClass, setLinkedClass] = useState<ClassBlock | null>(null);
  const [termChoice, setTermChoice] = useState<TermChoiceKind>("create");
  const [termName, setTermName] = useState("");
  const [termStart, setTermStart] = useState("");
  const [termEnd, setTermEnd] = useState("");
  const [includeBreaks, setIncludeBreaks] = useState(true);
  const [confirmedCandidates, setConfirmedCandidates] = useState<string[]>([]);
  const [basicsError, setBasicsError] = useState<string | null>(null);
  const [semesterOutcome, setSemesterOutcome] = useState<SemesterOutcome | null>(null);
  const [editing, setEditing] = useState<DraftItem | null>(null);
  const [pendingDuplicates, setPendingDuplicates] = useState<DuplicateMatch[]>([]);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  /** The short names the student's other classes already use (a new class is offered one that differs). */
  const takenShortNames = useCallback((except?: ClassBlock | null) => state.classes.filter((cls) => cls.id !== except?.id).map((cls) => classShortName(cls)), [state.classes]);

  // ── 1. Reading ──────────────────────────────────────────────

  /**
   * The reading's result becomes the class and the dates steps. `courseName` is the name the server settled (the
   * document's, else the hint); `kind` is where the syllabus came from. False when nothing in it can be planned.
   */
  function finishRead(extraction: SyllabusExtraction, rawText: string, kind: SourceKind = "paste", courseName = ""): boolean {
    const term = resolveCourseTerm(extraction.course, today);
    const termStartKey = term.termStart ?? state.semester?.startDate ?? null;
    const termEndKey = term.termEnd ?? state.semester?.endDate ?? null;
    const items = resolveExtractedItems(extraction.items, { today, termStart: termStartKey, termEnd: termEndKey, breaks: term.breaks });
    if (items.length === 0) {
      setFailure(nothingFound(kind, extraction.warnings));
      return false;
    }
    const runId = `syl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const detectedName = extraction.course.name || courseName || courseHint.trim();
    const match = findBestClassMatch(detectedName, state.classes, extraction.course.code);
    const linked = prefilledClass ?? (match.isConfident ? match.matchedClass : null);
    const prefill = prefillBasics({ ...extraction.course, name: detectedName }, linked);
    const assessment = assessTerm({ existing: state.semester ?? null, start: term.termStart, end: term.termEnd, breaks: term.breaks, candidates: term.candidates });
    const pattern = extraction.course.meetingPattern;
    setRun({
      runId,
      kind,
      rawText,
      extractionJson: serializeExtraction({ course: extraction.course, items: extraction.items, warnings: extraction.warnings, truncated: extraction.truncated }),
      course: { name: detectedName, code: extraction.course.code, isAsynchronous: extraction.course.isAsynchronous, meetingPattern: pattern },
      warnings: [...extraction.warnings, ...term.warnings.filter((warning) => !extraction.warnings.includes(warning))],
      truncated: extraction.truncated,
      assessment,
      // What the SYLLABUS lacks (a class the dates join may still fill the times in).
      meetingMissing: !extraction.course.isAsynchronous && !isValidMeeting(pattern?.days ?? [], pattern?.startTime ?? "", pattern?.endTime ?? ""),
      resolvedStart: termStartKey,
      resolvedEnd: termEndKey,
      resolvedBreaks: term.breaks,
    });
    setDrafts(buildDraftItems(items, { today, idPrefix: runId }));
    setLinkedClass(linked);
    // One name field: a course code the syllabus gave is part of the name ("FINC 3100: Principles of Finance"),
    // and its letters are the short name offered ("FINC").
    setBasics({
      name: classNameFromSyllabus(prefill.name, prefill.code),
      code: "",
      shortName: linked ? normalizeShortName(classShortName(linked)) : suggestShortName({ name: prefill.name, code: prefill.code, taken: takenShortNames() }),
      isAsynchronous: prefill.isAsynchronous,
      days: prefill.days,
      startTime: prefill.startTime,
      endTime: prefill.endTime,
      location: prefill.location,
    });
    setTermChoice(assessment.mode === "new" ? "create" : "keep");
    setTermStart(assessment.proposedStart ?? "");
    setTermEnd(assessment.proposedEnd ?? "");
    setTermName(assessment.proposedStart ? semesterNameFor(assessment.proposedStart) : "");
    setIncludeBreaks(true);
    setConfirmedCandidates([]);
    setBasicsError(null);
    setCommitError(null);
    setSemesterOutcome(null);
    setMeetingTouched(false);
    setSourceMode("pick"); // coming back to step 1 shows the ways in, not an emptied text box
    setStep("basics");
    return true;
  }
  const finishReadRef = useRef(finishRead);
  finishReadRef.current = finishRead;

  /** Forgets the picked file once it has been read (set from the source hook below). */
  const clearPickedRef = useRef<() => void>(() => undefined);

  const startExtraction = useCallback(
    async (source: ExtractionSource, resume?: { jobId: string; startedAt: number; courseHint: string }) => {
      if (extractingRef.current) return; // ignore a second click while reading
      extractingRef.current = true;
      const token = ++runToken.current;
      const stale = () => runToken.current !== token;
      lastSource.current = source;
      setFailure(null);
      const hint = resume?.courseHint ?? courseHint;
      let jobId: string | null = resume?.jobId ?? null;
      try {
        // Without a session nothing is sent, and the source stays on screen.
        if (!resume && !(await ensureSession())) return;
        if (stale()) return;
        // The free syllabus is used, and the app already knows: the same card the server would answer with, with
        // "See plans", before anything is sent. The source stays on screen for "Try again" after upgrading.
        if (!resume && uploadDecision === "paywall") {
          setFailure(describeIntakeFailure(freeSyllabusLimitError(), "extract"));
          return;
        }
        setIsExtracting(true);
        setProgress(null);
        setReconnecting(false);
        setLiveMode("unknown");
        setLiveItems(null);
        setLiveCourse(null);
        setResumedRead(Boolean(resume));
        setClockMs(resume ? Math.max(0, Date.now() - resume.startedAt) : 0);
        setReadStartedAt(resume ? resume.startedAt : Date.now());
        const input = { ...source.input, ...(source.input.rawText ? { rawText: source.input.rawText.slice(0, 200_000) } : {}) };
        if (input.rawText !== undefined && !input.rawText.trim()) throw new Error("This file has no readable text.");
        const request = {
          pdfUrl: input.pdfUrl,
          pdfUrls: input.pdfUrls,
          rawText: input.rawText,
          courseName: hint.trim().slice(0, 300),
          today,
          ...(state.semester ? { semesterStart: state.semester.startDate, semesterEnd: state.semester.endDate } : {}),
        };
        // Every reading runs as a job on the server and is polled (src/engine/poll-job.ts) until it is done: a PDF or
        // photos go through a multimodal model that can take minutes, and a browser's request cannot wait that long
        // either; pasted text is quick, but as a job it shows its deadlines as they are read and survives a reload.
        // The job id is remembered so a dropped connection or a closed tab resumes the same reading instead of
        // starting (and paying for) a new one.
        if (!jobId) {
          const started = await mutate("ai.startSyllabusExtraction", request);
          jobId = started.jobId;
          await savePendingExtraction({ jobId, startedAt: Date.now(), source: pendingSourceOf(source), courseHint: hint });
          // Cancelled while the job was being started: forget it again, so it is not resumed next time.
          if (stale()) {
            void clearPendingExtraction(jobId);
            return;
          }
        }
        const id = jobId;
        const result = await pollJob<SyllabusExtractionResult>(
          async () => {
            const s = await query("ai.syllabusExtractionStatus", { jobId: id });
            const elapsedMs = typeof s.elapsedMs === "number" ? s.elapsedMs : 0;
            if (s.status === "done") return { status: "done", elapsedMs, result: (s.result ?? { count: 0 }) as SyllabusExtractionResult };
            if (s.status === "failed") return { status: "failed", elapsedMs, error: s.error };
            return { status: s.status, elapsedMs, progress: s.progress };
          },
          {
            // Asked once a second, so the list of deadlines found so far fills in as they arrive.
            ...LIVE_READING_POLL_OPTIONS,
            onTick: (status) => {
              if (stale()) return;
              setReconnecting(false);
              const reading = status.status === "running" || status.status === "queued";
              const now = reading ? status.progress ?? null : null;
              setProgress(now);
              // The list only grows while the reading runs. The answer that ends it carries no list: the result
              // takes over from there, and what was shown is dropped below.
              if (!reading) return;
              setLiveMode((mode) => liveModeAfter(mode, now));
              setLiveItems((shown) => mergeLiveItems(shown, liveItemsOf(now)));
              setLiveCourse((shown) => liveCourseName(shown, now));
            },
            onCheckError: () => {
              if (!stale()) setReconnecting(true);
            },
            isCancelled: () => stale() || !extractingRef.current,
          },
        );
        void clearPendingExtraction(id);
        if (stale()) return; // cancelled while the server was reading

        const reading = readingOfResult(result);
        if (!reading) throw new Error("The server's answer could not be read.");
        if (reading.count === 0) {
          setFailure(nothingFound(source.kind, reading.extraction.warnings));
          return;
        }
        // The server answers the document's text for a transcribed file; pasted text is the text that was sent.
        if (finishReadRef.current(reading.extraction, reading.rawText || input.rawText || "", source.kind, reading.courseName)) {
          clearPickedRef.current(); // read: the picked file is no longer needed
        }
      } catch (error) {
        if (stale()) return; // the student cancelled: nothing to report
        // A definitive answer (the reading failed, or the server no longer has it) ends that job; a
        // connection problem keeps it, so "Try again" resumes it.
        if (jobId && (error instanceof JobFailed || errorCode(error) === "NOT_FOUND")) void clearPendingExtraction(jobId);
        setFailure(describeFailure(error, "extract"));
      } finally {
        if (!stale()) {
          extractingRef.current = false;
          setIsExtracting(false);
          setReconnecting(false);
          // The wait is over (read, failed or nothing found): the preview list goes with it.
          setLiveItems(null);
          setLiveCourse(null);
        }
      }
    },
    [courseHint, ensureSession, state.semester, today, uploadDecision],
  );

  const source = useSyllabusSource((s) => void startExtraction(s), { ensureSession });
  const shownFailure = failure ?? source.failure;
  const dismissFailure = () => {
    setFailure(null);
    source.clearFailure();
  };
  useEffect(() => {
    clearPickedRef.current = source.clearPendingFile;
  });

  // The free syllabus is already used when the screen opens: said at once, before a file is picked, with "See plans".
  const gateSaid = useRef(false);
  useEffect(() => {
    if (uploadDecision !== "paywall" || gateSaid.current || step !== "source" || isExtracting) return;
    gateSaid.current = true;
    setFailure(describeIntakeFailure(freeSyllabusLimitError(), "extract"));
  }, [uploadDecision, step, isExtracting]);

  /**
   * "Try again" after a failed reading: resume the remembered job when there is one for this file (a dropped
   * connection: the server may be done already), otherwise send the source again (a file or photos are uploaded
   * again, because the server deletes an uploaded syllabus when its reading is over).
   */
  const retryLast = async () => {
    const last = lastSource.current;
    if (!last) return;
    setFailure(null);
    if (last.input.pdfUrl || last.input.pdfUrls?.length) {
      const pending = await loadPendingExtraction();
      if (pending && isSameSource(pending.source, last)) {
        void startExtraction(last, { jobId: pending.jobId, startedAt: pending.startedAt, courseHint: pending.courseHint });
        return;
      }
    }
    source.resend(last);
  };
  const retry = () => {
    if (failure) void retryLast();
    else if (source.pendingFile) source.continuePendingFile();
    else if (source.scannedPages.length > 0) void source.submitScan();
  };
  const canRetry = (failure !== null && lastSource.current !== null) || (source.failure !== null && (source.pendingFile !== null || source.scannedPages.length > 0));

  // Coming back to the screen (or reloading the page) while a reading is still on the server: pick it up.
  const resumeRef = useRef<{ start: typeof startExtraction; restore: typeof source.restore }>({ start: startExtraction, restore: source.restore });
  useEffect(() => {
    resumeRef.current = { start: startExtraction, restore: source.restore };
  });
  useEffect(() => {
    let alive = true;
    void loadPendingExtraction().then((pending) => {
      if (!alive || !pending || extractingRef.current) return;
      const resumed: ExtractionSource = { kind: pending.source.kind, input: pending.source.input, local: pending.source.local, pageUris: pending.source.pageUris };
      if (pending.courseHint) setCourseHint(pending.courseHint);
      resumeRef.current.restore(resumed);
      void resumeRef.current.start(resumed, { jobId: pending.jobId, startedAt: pending.startedAt, courseHint: pending.courseHint });
    });
    return () => {
      alive = false;
    };
  }, []);

  // The free syllabus is used: the failure card offers "See plans" (the picked file stays for "Try again"). The
  // paywall is not opened from here when the server refuses: the API client already answers that 403 with the
  // app-wide "See Pro plans" question (src/state/subscription-context.tsx).

  // ── 2. The class ────────────────────────────────────────────

  const linkClass = (cls: ClassBlock | null) => {
    setLinkedClass(cls);
    if (run) {
      // Days, times and room: what the student entered here if they did, otherwise the syllabus's own, with the
      // chosen class filling what the syllabus leaves out. Never the times of the class that was chosen before.
      const pattern = meetingTouched ? (basics.days.length > 0 || basics.startTime ? { days: basics.days, startTime: basics.startTime || null, endTime: basics.endTime || null, location: basics.location } : null) : run.course.meetingPattern;
      const p = prefillBasics({ name: run.course.name, code: run.course.code, isAsynchronous: meetingTouched ? basics.isAsynchronous : run.course.isAsynchronous, meetingPattern: pattern }, cls);
      setBasics((b) => ({ ...b, shortName: cls ? normalizeShortName(classShortName(cls)) : suggestShortName({ name: run.course.name, code: run.course.code, taken: takenShortNames() }), isAsynchronous: p.isAsynchronous, days: p.days, startTime: p.startTime, endTime: p.endTime, location: p.location }));
    }
  };

  const continueFromBasics = () => {
    if (!run) return;
    // The step's own line over Continue says what is missing (src/engine/syllabus-review.ts classStepBlocker); these
    // are the same rules once more, so nothing unchecked can reach the plan.
    if (!basics.name.trim() && !linkedClass) return setBasicsError("Give the class a name to continue");
    if (!basics.isAsynchronous && !isValidMeeting(basics.days, basics.startTime, basics.endTime)) return setBasicsError("Choose the class days and times, or turn on “No set class time”");
    const { assessment } = run;
    const confirmed = assessment.candidateBreaks.filter((b) => confirmedCandidates.includes(`${b.startDate}|${b.endDate}`));
    let outcome: SemesterOutcome;
    if (assessment.mode === "new") {
      outcome = termChoice === "skip" ? decideSemester(assessment, { action: "skip" }, { includeBreaks: false }) : decideSemester(assessment, { action: "create", name: termName, start: termStart.trim(), end: termEnd.trim() }, { includeBreaks, confirmedCandidates: confirmed });
    } else {
      outcome = decideSemester(assessment, { action: termChoice === "replace" ? "replace" : "keep" }, { includeBreaks, confirmedCandidates: confirmed });
    }
    if (!outcome.ok) return setBasicsError(outcome.error);
    setBasicsError(null);
    setSemesterOutcome(outcome);
    // The confirmed term decides how week numbers and month/day dates are read.
    const term = outcome.semester;
    setDrafts((current) => reresolveDrafts(current, { today, termStart: term?.startDate ?? run.resolvedStart, termEnd: term?.endDate ?? run.resolvedEnd, breaks: term?.breaks ?? run.resolvedBreaks }));
    setStep("items");
  };

  // ── 3. The dates ────────────────────────────────────────────

  const dateContext = () => ({
    today,
    termStart: semesterOutcome?.ok ? semesterOutcome.semester?.startDate ?? run?.resolvedStart : run?.resolvedStart,
    termEnd: semesterOutcome?.ok ? semesterOutcome.semester?.endDate ?? run?.resolvedEnd : run?.resolvedEnd,
    breaks: semesterOutcome?.ok ? semesterOutcome.semester?.breaks : run?.resolvedBreaks,
  });
  const toggleDraft = (id: string) => setDrafts((current) => current.map((d) => (d.id === id && (d.dueDate !== null || d.selected) ? { ...d, selected: !d.selected, selectionTouched: true } : d)));
  const setDate = (id: string, value: string): string | null => {
    const draft = drafts.find((d) => d.id === id);
    if (!draft) return null;
    const changed = setDraftDate(draft, value, dateContext());
    if (!changed.ok) return changed.error;
    setDrafts((current) => current.map((d) => (d.id === id ? changed.draft : d)));
    return null;
  };
  const saveEdit = (id: string, patch: { name: string; type: SyllabusItemType; date: string; dueTime: string; estimatedMinutes: number; difficulty: number; weightPercent: number | null }): string | null => {
    const draft = drafts.find((d) => d.id === id);
    if (!draft) return null;
    let next = draft;
    // Saving the sheet with a date the app had worked out is the student saying it is right: it becomes theirs.
    const confirms = patch.date !== "" && draft.dateConfidence !== "explicit" && draft.dateConfidence !== "user";
    if (patch.date !== (draft.dueDate ?? "") || confirms) {
      const changed = setDraftDate(draft, patch.date, dateContext());
      if (!changed.ok) return changed.error;
      next = changed.draft;
    }
    next = { ...next, name: patch.name, type: patch.type, dueTime: patch.dueTime, estimatedMinutes: patch.estimatedMinutes, difficulty: patch.difficulty, weightPercent: patch.weightPercent };
    setDrafts((current) => current.map((d) => (d.id === id ? next : d)));
    return null;
  };

  // ── 4. The plan ─────────────────────────────────────────────

  const courseLabel = composeClassName(basics.name, basics.code);

  function commit(overwriteIds?: Set<string>) {
    if (!run || isCommitting) return;
    setCommitError(null);
    const importId = `import-${run.runId}`;
    const target: ClassTarget = linkedClass ? { kind: "existing", cls: linkedClass } : { kind: "new" };
    const newClassId = `class-${run.runId}`;
    const linked = linkedClass ? { id: linkedClass.id, name: linkedClass.name } : { id: "", name: courseLabel };
    const parts = partitionDuplicates(importableDrafts(drafts), state.tasks, linked);
    if (parts.duplicates.length > 0 && overwriteIds === undefined) {
      setPendingDuplicates(parts.duplicates);
      setShowDuplicates(true);
      return;
    }
    setIsCommitting(true);
    setStep("plan");
    // Let the "Building your plan" step paint before the planner runs.
    setTimeout(() => {
      try {
        const overwrite = overwriteIds ?? new Set<string>();
        const changedSemester = semesterOutcome?.ok && semesterOutcome.changed ? semesterOutcome.semester : null;
        const now = new Date();
        const built = buildSyllabusImport({
          now,
          today,
          importId,
          drafts,
          course: { name: basics.name.trim(), code: basics.code.trim(), shortName: basics.shortName, isAsynchronous: basics.isAsynchronous, days: basics.days, startTime: basics.startTime, endTime: basics.endTime, location: basics.location },
          target,
          existing: { classes: state.classes, tasks: state.tasks },
          semester: changedSemester,
          overwriteIds: overwrite,
          strategies: new Map(),
          strategyUnavailable: false,
          source: run.kind,
          rawText: run.rawText,
          extractionJson: run.extractionJson,
          newClassId,
        });
        // What the planner will do with this import, worked out BEFORE committing (the same pure code the reducer runs).
        let plannedMinutes: number | null = null;
        try {
          const after = applySyllabusImport(state, built.payload);
          const ids = new Set([...built.payload.tasks.map((t) => t.id), ...built.payload.taskUpdates.map((t) => t.id)]);
          plannedMinutes = summarizeImportPlan(after, ids, { now, needDate: built.counts.excludedUndated }).plannedMinutes;
        } catch {
          plannedMinutes = null; // the import itself is fine; only that number is unknown
        }
        dispatch({ type: "APPLY_SYLLABUS_IMPORT", payload: built.payload });
        if (built.counts.added + built.counts.overwritten > 0) dispatch({ type: "AUTO_BUILD_WEEK" });
        const before = linkedClass;
        const updated = built.payload.classToUpdate;
        const classUpdated = Boolean(updated) && before !== null && (before.days.join() !== updated!.days.join() || before.startTime !== updated!.startTime || before.endTime !== updated!.endTime || (before.location ?? "") !== (updated!.location ?? "") || Boolean(before.isAsynchronous) !== Boolean(updated!.isAsynchronous));
        // The flow ends on Today, which shows what was planned and offers the undo (src/engine/setup-recap.ts).
        writePref(
          PREF_KEYS.setupRecap,
          JSON.stringify(
            buildSetupRecap({
              importId,
              day: today,
              courseLabel: linkedClass?.name ?? courseLabel,
              first: (state.syllabusImports?.length ?? 0) === 0,
              dueDates: [...built.payload.tasks, ...built.payload.taskUpdates].map((task) => task.dueDate),
              plannedMinutes,
              needDate: built.counts.excludedUndated,
              kept: built.counts.skippedDuplicates,
              replaced: built.counts.overwritten,
              classUpdated,
              defaultSessions: false,
              notes: [],
            }),
          ),
        );
        writePref(PREF_KEYS.setupListHidden, null);
        if (mounted.current) navigate("today", { replace: true });
      } catch (error) {
        setStep("items");
        setCommitError(error instanceof Error && error.message ? `${error.message} Nothing was added. Try again.` : "Something went wrong and nothing was added. Try again.");
      } finally {
        setIsCommitting(false);
      }
    }, 60);
  }

  // ── Render ──────────────────────────────────────────────────

  const leave = () => goBack("classes");

  /**
   * Stop waiting for the server (the polling ends on the next tick); the chosen source stays on screen. The
   * reading is forgotten in this browser, so it is not resumed the next time the screen opens.
   */
  const cancelExtraction = () => {
    runToken.current += 1;
    extractingRef.current = false;
    setIsExtracting(false);
    setReadStartedAt(null);
    setClockMs(0);
    setProgress(null);
    setReconnecting(false);
    setLiveItems(null);
    setLiveCourse(null);
    void clearPendingExtraction();
  };

  // A picked file on its way to the server, before the read begins (an open picker, pages being added, or an unread
  // file that is only remembered are not "sending").
  const sendingFile = step === "source" && !isExtracting && source.isSendingFile && source.pendingFile !== null;
  const mode = effectiveSourceMode(sourceMode, source.scannedPages.length);
  const waiting = step === "source" && (isExtracting || sendingFile);

  // What the wait is reading, in words.
  const last = lastSource.current;
  const waitFile = sendingFile ? source.pendingFile : last?.local ?? null;
  const waitKind: SourceKind = sendingFile ? "file" : last?.kind ?? "file";
  // A Word or text file is read in this browser and sent as text: quick, like pasted text, so no usual time and no bar.
  const quick = !sendingFile && last?.input.rawText !== undefined;
  const pageCount = last?.pageUris?.length ?? last?.input.pdfUrls?.length ?? 0;
  const words = sourceWords({ kind: waitKind, file: waitFile, pageCount, textLength: last?.input.rawText?.length ?? 0 });
  const copyKind: SourceKind = quick ? "paste" : waitKind;
  // Every reading runs as a job on the server, which reports what it has found so far: every wait has the list.
  const liveList = showsLiveList({ isJob: isExtracting && !sendingFile, mode: liveMode });

  const lead = prefilledClass ? `For ${prefilledClass.name}. ${WAYS_IN}` : state.classes.length === 0 && (state.syllabusImports?.length ?? 0) === 0 ? `Start with one class. ${WAYS_IN}` : `One class at a time. ${WAYS_IN}`;

  const bar =
    step === "plan"
      ? { icon: "back" as const, label: "Back", onPress: () => undefined, disabled: true }
      : step === "items"
        ? { icon: "back" as const, label: "Back to your class", onPress: () => setStep("basics"), disabled: isCommitting }
        : step === "basics"
          ? { icon: "back" as const, label: "Back to adding a syllabus", onPress: () => setStep("source") }
          : isExtracting
            ? { icon: "close" as const, label: "Cancel reading the syllabus", onPress: cancelExtraction }
            : mode === "paste" && !sendingFile
              ? { icon: "back" as const, label: "Back to the ways to add a syllabus", onPress: () => setSourceMode("pick") }
              : mode === "scan" && !sendingFile
                ? {
                    icon: "back" as const,
                    label: "Discard these pages and go back",
                    onPress: () => {
                      source.setScannedPages([]);
                      setSourceMode("pick");
                    },
                  }
                : { icon: "close" as const, label: "Close", onPress: leave };

  return (
    <div className={desktop ? "screen medium" : "screen"} style={{ gap: desktop ? 18 : 14 }}>
      <StepBar step={flowStepNumber(step)} icon={bar.icon} label={bar.label} onPress={bar.onPress} disabled={bar.disabled} />

      {waiting ? (
        <ReadingStep
          title={sendingFile ? "Uploading your syllabus" : "Reading your syllabus"}
          sourceName={words.name}
          sourceDetail={words.detail}
          rows={readingRows({ kind: copyKind === "paste" ? "paste" : waitKind, phase: sendingFile ? "sending" : "reading", progress, pages: pageCount })}
          elapsedMs={sendingFile ? undefined : clockMs}
          expectation={sendingFile ? null : readingExpectation({ kind: copyKind, elapsedMs: clockMs, reconnecting })}
          showBar={!sendingFile && copyKind !== "paste"}
          leaveNote={!sendingFile ? "You can leave this page. It keeps reading, and the result will be here when you come back." : null}
          onCancel={sendingFile ? undefined : cancelExtraction}
          live={liveList ? { items: liveItems ?? [], courseName: liveCourse, stage: progress?.stage ?? null, reconnecting, resumed: resumedRead, answered: liveMode === "live", today } : null}
        />
      ) : null}

      {/* Kept mounted (just hidden) during the wait, so a pasted text or picked pages survive a failure or Cancel. */}
      {step === "source" ? (
        <div style={{ display: waiting ? "none" : "contents" }}>
          <SourceStep
            mode={sourceMode}
            onMode={setSourceMode}
            lead={lead}
            isBusy={isExtracting || source.isUploading}
            failure={shownFailure}
            canRetryLast={canRetry}
            onRetry={retry}
            onDismissFailure={dismissFailure}
            onOpenPaywall={() => navigate("paywall")}
            onFilePicked={(file) => void source.filePicked(file)}
            onPhotosPicked={(files) => void source.photosPicked(files)}
            pendingFile={source.pendingFile}
            onContinuePending={() => {
              dismissFailure();
              source.continuePendingFile();
            }}
            onRemovePending={() => {
              dismissFailure();
              source.clearPendingFile();
            }}
            scannedPages={source.scannedPages}
            onRemovePage={(index) => source.setScannedPages((pages) => pages.filter((_, i) => i !== index))}
            onSubmitScan={() => void source.submitScan()}
            onSubmit={(s) => void startExtraction(s)}
            courseHint={courseHint}
            onCourseHint={setCourseHint}
            note="Your syllabus is read by AI on Trajectory's server."
          />
        </div>
      ) : null}

      {step === "basics" && run ? (
        <BasicsStep
          basics={basics}
          onBasics={(patch) => {
            setBasicsError(null);
            if (patch.days !== undefined || patch.startTime !== undefined || patch.endTime !== undefined || patch.location !== undefined || patch.isAsynchronous !== undefined) setMeetingTouched(true);
            setBasics((b) => ({ ...b, ...patch }));
          }}
          modelSaysAsync={run.course.isAsynchronous}
          meetingMissing={run.meetingMissing}
          classes={state.classes}
          linkedClass={linkedClass}
          onLinkClass={linkClass}
          assessment={run.assessment}
          termChoice={termChoice}
          onTermChoice={(choice) => {
            setBasicsError(null);
            setTermChoice(choice);
          }}
          termName={termName}
          termStart={termStart}
          termEnd={termEnd}
          onTerm={(patch) => {
            setBasicsError(null);
            // The term is named after when it starts ("Fall 2026"); it can be renamed later from Classes.
            if (patch.start !== undefined) {
              setTermStart(patch.start);
              setTermName(patch.start ? semesterNameFor(patch.start) : "");
            }
            if (patch.end !== undefined) setTermEnd(patch.end);
          }}
          includeBreaks={includeBreaks}
          onIncludeBreaks={setIncludeBreaks}
          confirmedCandidates={confirmedCandidates}
          onToggleCandidate={(key) => setConfirmedCandidates((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]))}
          warnings={shownImportWarnings(run.warnings)}
          error={basicsError}
          onContinue={continueFromBasics}
          existingSemester={state.semester ?? null}
        />
      ) : null}

      {step === "items" && run ? (
        <ItemsStep drafts={drafts} today={today} isCommitting={isCommitting} truncated={run.truncated} termKnown={Boolean(dateContext().termStart && dateContext().termEnd)} error={commitError} onToggle={toggleDraft} onEdit={setEditing} onSetDate={setDate} onCommit={() => commit()} />
      ) : null}

      {step === "plan" ? (
        <ReadingStep
          title="Building your plan"
          sourceName={linkedClass?.name ?? courseLabel}
          sourceDetail={run?.kind === "paste" ? "Pasted text" : run?.kind === "scan" ? "Photos of the pages" : "Syllabus"}
          rows={readingRows({ kind: run?.kind ?? "file", phase: "planning", toPlan: plannedCount(drafts) })}
        />
      ) : null}

      <EditItemSheet item={editing} onClose={() => setEditing(null)} onSave={saveEdit} />
      <DuplicateSheet
        open={showDuplicates}
        duplicates={pendingDuplicates}
        onCancel={() => setShowDuplicates(false)}
        onContinue={(overwrite) => {
          setShowDuplicates(false);
          commit(overwrite);
        }}
      />
    </div>
  );
}
