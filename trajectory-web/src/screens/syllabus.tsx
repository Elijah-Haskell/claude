// The syllabus import: paste it ONCE and the whole semester is planned. Four steps, counted at the top of each:
//
//   1. Add your syllabus   pasted text or a text file; read by the built-in reader, or by Claude with your own key
//   2. Check your class    the class and its short name, days and times (prefilled), the term (asked once), breaks
//   3. Check the dates     only the doubtful ones ask for attention; nothing without a date is planned
//   4. Building your plan  duplicate-aware; the plan is built right away
//
// It ends on Today, which shows what was planned and how to undo it (src/engine/setup-recap.ts). All decisions live
// in src/engine/syllabus-*.ts (pure and tested); this file only collects the student's choices.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { findBestClassMatch } from "../engine/course-matcher";
import { alpha } from "../engine/design";
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
import { classNameFromSyllabus, classStepBlocker, flowStepNumber, lookLine, lookReasonOf, planButtonLabel, plannedCount, reviewBuckets, reviewDate, reviewSummary, shownImportWarnings, termRangeLabel, type FlowStep } from "../engine/syllabus-review";
import type { ClassBlock, DayOfWeek, Semester } from "../engine/types";
import { localDateKey, parseLocalDate, todayString } from "../engine/utils";
import { classShortName, normalizeShortName, SHORT_NAME_MAX, suggestShortName } from "../engine/week-layout";
import { AiError } from "../lib/ai-types";
import { extractSyllabusHeuristically } from "../lib/syllabus-heuristic";
import { goBack, useNavigate, useRoute } from "../router";
import { useApp } from "../state/app-provider";
import { PREF_KEYS, useLocalPref, writePref } from "../state/local-prefs";
import { Icon, type IconName } from "../ui/icon";
import { AppSwitch, CheckBox, DateInput, FieldGroup, FieldLabel, FieldRow, MONO_FONT, Note, PrimaryButton, SectionLabel, Segmented, TimeInput, DayToggles } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

// ── Shared pieces ─────────────────────────────────────────────

const TYPE_ICON: Record<string, IconName> = { exam: "flag", quiz: "flag", assignment: "file", project: "layers", reading: "book", other: "list" };

/** The top of every step: the way back (or out) on the left, "STEP 2 OF 4" on the right, four thin segments under. */
function StepBar({ step, total = 4, icon = "back", label, onPress, disabled }: { step: number; total?: number; icon?: "back" | "close"; label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useColors();
  return (
    <div style={{ paddingTop: 6, paddingBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button type="button" className="pressable" onClick={onPress} disabled={disabled} aria-label={label} style={{ width: 44, height: 44, borderRadius: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", background: colors.surface, border: `1px solid ${colors.borderStrong}`, opacity: disabled ? 0.5 : 1 }}>
          <Icon name={icon === "close" ? "close" : "chevronLeft"} size={20} color={colors.foreground} strokeWidth={2} />
        </button>
        <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1.4, textTransform: "uppercase", color: colors.peri }}>Step {step} of {total}</span>
      </div>
      <div role="progressbar" aria-label={`Step ${step} of ${total}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={step} style={{ display: "flex", gap: 6, marginTop: 14 }}>
        {Array.from({ length: total }, (_, index) => (
          <span key={index} style={{ flex: 1, height: 3, borderRadius: 2, background: index < step ? colors.accent : colors.borderStrong }} />
        ))}
      </div>
    </div>
  );
}

function FlowTitle({ title, sub }: { title: string; sub?: string }) {
  const colors = useColors();
  return (
    <div>
      <h1 style={{ margin: 0, fontSize: 26, lineHeight: "32px", fontWeight: 800, letterSpacing: -0.6, color: colors.foreground }}>{title}</h1>
      {sub ? <p style={{ margin: "6px 0 0", fontSize: 14.5, lineHeight: "20px", color: colors.muted }}>{sub}</p> : null}
    </div>
  );
}

/** The bar at the bottom of a step: an optional line over the button (what is still missing), then the button(s). */
function FlowFooter({ hint, hintTone = "quiet", children }: { hint?: string | null; hintTone?: "quiet" | "gold" | "red"; children: ReactNode }) {
  const colors = useColors();
  return (
    <div className="flow-footer">
      {hint ? <p role={hintTone === "quiet" ? undefined : "alert"} style={{ margin: 0, fontSize: 13.5, lineHeight: "18px", textAlign: "center", color: hintTone === "quiet" ? colors.muted : hintTone === "gold" ? colors.gold : colors.error, fontWeight: hintTone === "quiet" ? 400 : 600 }}>{hint}</p> : null}
      {children}
    </div>
  );
}

function TextLink({ label, onPress, color, ariaLabel, style }: { label: string; onPress: () => void; color?: string; ariaLabel?: string; style?: React.CSSProperties }) {
  const colors = useColors();
  return (
    <button type="button" className="link" onClick={onPress} aria-label={ariaLabel ?? label} style={{ minHeight: 44, fontSize: 14, lineHeight: "19px", fontWeight: 600, color: color ?? colors.peri, ...style }}>
      {label}
    </button>
  );
}

const formatShortDate = (key: string) => {
  const date = parseLocalDate(key);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

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
            <DayToggles days={basics.days} onToggle={toggleDay} />
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

type Reader = "ai" | "builtin";

interface Run {
  runId: string;
  kind: "paste";
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

const WAYS_IN = "Paste the text of the syllabus, or choose a .txt file.";

export function SyllabusScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const route = useRoute();
  const { state, dispatch } = useApp();
  const [apiKey] = useLocalPref(PREF_KEYS.anthropicKey);
  const [aiModel] = useLocalPref(PREF_KEYS.aiModel);
  const today = todayString();

  const prefilledClass = useMemo(() => (route.query.classId ? state.classes.find((c) => c.id === route.query.classId) ?? null : null), [route.query.classId, state.classes]);

  const [step, setStep] = useState<FlowStep>("source");
  const [text, setText] = useState("");
  const [courseHint, setCourseHint] = useState(prefilledClass?.name ?? "");
  const [reader, setReader] = useState<Reader>(apiKey ? "ai" : "builtin");
  const [isReading, setIsReading] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string; offerBuiltin: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [run, setRun] = useState<Run | null>(null);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [basics, setBasics] = useState<BasicsDraft>({ name: "", code: "", shortName: "", isAsynchronous: false, days: [], startTime: "", endTime: "", location: "" });
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

  useEffect(() => () => abortRef.current?.abort(), []);

  const takenShortNames = (except?: ClassBlock | null) => state.classes.filter((cls) => cls.id !== except?.id).map((cls) => classShortName(cls));

  // ── 1. Reading ──────────────────────────────────────────────

  function finishRead(extraction: SyllabusExtraction, rawText: string) {
    const term = resolveCourseTerm(extraction.course, today);
    const termStartKey = term.termStart ?? state.semester?.startDate ?? null;
    const termEndKey = term.termEnd ?? state.semester?.endDate ?? null;
    const items = resolveExtractedItems(extraction.items, { today, termStart: termStartKey, termEnd: termEndKey, breaks: term.breaks });
    if (items.length === 0) {
      setFailure({ title: "No assignments found", message: extraction.warnings[0] ?? "No assignments or exams were found in this text.", offerBuiltin: false });
      return;
    }
    const runId = `syl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const detectedName = extraction.course.name || courseHint.trim();
    const match = findBestClassMatch(detectedName, state.classes, extraction.course.code);
    const linked = prefilledClass ?? (match.isConfident ? match.matchedClass : null);
    const prefill = prefillBasics({ ...extraction.course, name: detectedName }, linked);
    const assessment = assessTerm({ existing: state.semester ?? null, start: term.termStart, end: term.termEnd, breaks: term.breaks, candidates: term.candidates });
    const pattern = extraction.course.meetingPattern;
    setRun({
      runId,
      kind: "paste",
      rawText,
      extractionJson: serializeExtraction({ course: extraction.course, items: extraction.items, warnings: extraction.warnings, truncated: extraction.truncated }),
      course: { name: detectedName, code: extraction.course.code, isAsynchronous: extraction.course.isAsynchronous, meetingPattern: pattern },
      warnings: [...extraction.warnings, ...term.warnings],
      truncated: extraction.truncated,
      assessment,
      meetingMissing: !extraction.course.isAsynchronous && !isValidMeeting(pattern?.days ?? [], pattern?.startTime ?? "", pattern?.endTime ?? ""),
      resolvedStart: termStartKey,
      resolvedEnd: termEndKey,
      resolvedBreaks: term.breaks,
    });
    setDrafts(buildDraftItems(items, { today, idPrefix: runId }));
    setLinkedClass(linked);
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
    setStep("basics");
  }

  async function read(withReader: Reader = reader) {
    const source = text.trim();
    if (source.length < 20 || isReading) return;
    setFailure(null);
    if (withReader === "ai" && apiKey) {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsReading(true);
      try {
        // The Anthropic SDK is loaded only when a key is used, so the app itself stays small.
        const { readSyllabusWithClaude } = await import("../lib/anthropic");
        const extraction = await readSyllabusWithClaude({ apiKey, model: aiModel ?? undefined, text: source, courseHint, today, semesterStart: state.semester?.startDate, semesterEnd: state.semester?.endDate, signal: controller.signal });
        if (controller.signal.aborted) return;
        finishRead(extraction, source);
      } catch (error) {
        if (controller.signal.aborted) return;
        const failed = error instanceof AiError ? error : new AiError("other", "Something went wrong while reading.");
        setFailure({ title: failed.kind === "refusal" ? "The AI declined" : "Could not read it with AI", message: failed.message, offerBuiltin: true });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsReading(false);
      }
      return;
    }
    finishRead(extractSyllabusHeuristically(source, { courseHint }), source);
  }

  function cancelRead() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsReading(false);
  }

  function pickFile(file: File | undefined) {
    if (!file) return;
    file.text().then((content) => setText(content.slice(0, 200_000))).catch(() => setFailure({ title: "Could not read the file", message: "Choose a plain text file (.txt or .md), or paste the text.", offerBuiltin: false }));
  }

  // ── 2. The class ────────────────────────────────────────────

  const linkClass = (cls: ClassBlock | null) => {
    setLinkedClass(cls);
    if (run) {
      const pattern = meetingTouched ? (basics.days.length > 0 || basics.startTime ? { days: basics.days, startTime: basics.startTime || null, endTime: basics.endTime || null, location: basics.location } : null) : run.course.meetingPattern;
      const p = prefillBasics({ name: run.course.name, code: run.course.code, isAsynchronous: meetingTouched ? basics.isAsynchronous : run.course.isAsynchronous, meetingPattern: pattern }, cls);
      setBasics((b) => ({ ...b, shortName: cls ? normalizeShortName(classShortName(cls)) : suggestShortName({ name: run.course.name, code: run.course.code, taken: takenShortNames() }), isAsynchronous: p.isAsynchronous, days: p.days, startTime: p.startTime, endTime: p.endTime, location: p.location }));
    }
  };

  const continueFromBasics = () => {
    if (!run) return;
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
        let plannedMinutes: number | null = null;
        try {
          const after = applySyllabusImport(state, built.payload);
          const ids = new Set([...built.payload.tasks.map((t) => t.id), ...built.payload.taskUpdates.map((t) => t.id)]);
          plannedMinutes = summarizeImportPlan(after, ids, { now, needDate: built.counts.excludedUndated }).plannedMinutes;
        } catch {
          plannedMinutes = null;
        }
        dispatch({ type: "APPLY_SYLLABUS_IMPORT", payload: built.payload });
        if (built.counts.added + built.counts.overwritten > 0) dispatch({ type: "AUTO_BUILD_WEEK" });
        const before = linkedClass;
        const updated = built.payload.classToUpdate;
        const classUpdated = Boolean(updated) && before !== null && (before.days.join() !== updated!.days.join() || before.startTime !== updated!.startTime || before.endTime !== updated!.endTime || (before.location ?? "") !== (updated!.location ?? "") || Boolean(before.isAsynchronous) !== Boolean(updated!.isAsynchronous));
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
        navigate("today", { replace: true });
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
  const lead = prefilledClass ? `For ${prefilledClass.name}. ${WAYS_IN}` : state.classes.length === 0 && (state.syllabusImports?.length ?? 0) === 0 ? `Start with one class. ${WAYS_IN}` : `One class at a time. ${WAYS_IN}`;
  const bar =
    step === "plan"
      ? { icon: "back" as const, label: "Back", onPress: () => undefined, disabled: true }
      : step === "items"
        ? { icon: "back" as const, label: "Back to your class", onPress: () => setStep("basics"), disabled: isCommitting }
        : step === "basics"
          ? { icon: "back" as const, label: "Back to adding a syllabus", onPress: () => setStep("source") }
          : isReading
            ? { icon: "close" as const, label: "Cancel reading the syllabus", onPress: cancelRead }
            : { icon: "close" as const, label: "Close", onPress: leave };
  const chars = text.trim().length;

  return (
    <div className="screen" style={{ gap: 14 }}>
      <StepBar step={flowStepNumber(step)} icon={bar.icon} label={bar.label} onPress={bar.onPress} disabled={bar.disabled} />

      {step === "source" ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <FlowTitle title="Add your syllabus" sub={lead} />
            {failure ? (
              <div role="alert" style={{ padding: 14, borderRadius: 14, border: `1px solid ${alpha(colors.error, 0.45)}`, background: alpha(colors.error, 0.08), display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <Icon name="warning" size={20} color={colors.error} style={{ marginTop: 1 }} />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{failure.title}</span>
                    <span style={{ fontSize: 14, lineHeight: "20px", color: colors.muted }}>{failure.message}</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <PrimaryButton size="sm" label="Try again" onPress={() => void read()} />
                  {failure.offerBuiltin ? <PrimaryButton size="sm" tone="ghost" label="Use the built-in reader" onPress={() => { setReader("builtin"); void read("builtin"); }} /> : null}
                  <PrimaryButton size="sm" tone="ghost" label="Dismiss" onPress={() => setFailure(null)} />
                </div>
              </div>
            ) : null}
            <div>
              <FieldLabel>The syllabus</FieldLabel>
              <textarea className="input" value={text} onChange={(e) => setText(e.target.value.slice(0, 200_000))} placeholder={"Paste the whole syllabus here: the schedule with its dates, the exams, the assignments…"} aria-label="Syllabus text" rows={10} style={{ minHeight: 220 }} disabled={isReading} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 6 }}>
                <span className="caption mono" style={{ fontSize: 12 }}>{chars > 0 ? `${chars.toLocaleString("en-US")} characters` : "Tables saved as pictures do not paste as text."}</span>
                <button type="button" className="link" onClick={() => fileInput.current?.click()} style={{ fontSize: 14, fontWeight: 600, color: colors.peri, minHeight: 32 }} disabled={isReading}>Choose a .txt file</button>
                <input ref={fileInput} type="file" accept=".txt,.md,.text,text/plain,text/markdown" style={{ display: "none" }} aria-hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
            </div>
            <div>
              <FieldLabel>Which class is it for? · optional</FieldLabel>
              <input className="input" value={courseHint} onChange={(e) => setCourseHint(e.target.value)} placeholder="Principles of Finance" maxLength={300} aria-label="Course name, optional" disabled={isReading} />
            </div>
            <FieldGroup>
              {apiKey ? (
                <FieldRow first icon="spark" label="Read with AI" detail="Claude reads the whole document with your own key" tint={colors.violet}>
                  <AppSwitch value={reader === "ai"} onValueChange={(on) => setReader(on ? "ai" : "builtin")} ariaLabel="Read with AI, using your own Anthropic key" disabled={isReading} />
                </FieldRow>
              ) : (
                <FieldRow first icon="spark" label="Built-in reader" detail="Finds dated items line by line. For messy syllabi, add an Anthropic API key in Settings and Claude reads it instead" tint={colors.violet} />
              )}
            </FieldGroup>
          </div>
          <FlowFooter hint={isReading ? (reader === "ai" ? "Claude is reading your syllabus. This usually takes under a minute." : null) : chars > 0 && chars < 20 ? "Paste a little more of the syllabus to continue" : null} hintTone="quiet">
            {isReading ? (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 54 }}>
                  <span className="spinner" />
                  <span style={{ fontSize: 15, fontWeight: 600, color: colors.foreground }}>Reading your syllabus…</span>
                </div>
                <PrimaryButton size="lg" fullWidth tone="ghost" label="Cancel" onPress={cancelRead} />
              </>
            ) : (
              <PrimaryButton size="lg" fullWidth label={reader === "ai" && apiKey ? "Read it with AI" : "Read the syllabus"} onPress={() => void read()} disabled={chars < 20} ariaLabel={chars < 20 ? "Read the syllabus. Paste the text first" : "Read the syllabus"} />
            )}
          </FlowFooter>
        </>
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
          onTermChoice={(choice) => { setBasicsError(null); setTermChoice(choice); }}
          termName={termName}
          termStart={termStart}
          termEnd={termEnd}
          onTerm={(patch) => {
            setBasicsError(null);
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
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "60px 20px", textAlign: "center" }} role="status" aria-live="polite">
          <span className="spinner" style={{ width: 28, height: 28 }} />
          <h1 style={{ margin: 0, fontSize: 24, lineHeight: "30px", fontWeight: 800, letterSpacing: -0.5, color: colors.foreground }}>Building your plan</h1>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: "20px", color: colors.muted }}>{linkedClass?.name ?? courseLabel} · {plannedCount(drafts)} items go into the plan.</p>
        </div>
      ) : null}

      <EditItemSheet item={editing} onClose={() => setEditing(null)} onSave={saveEdit} />
      <DuplicateSheet open={showDuplicates} duplicates={pendingDuplicates} onCancel={() => setShowDuplicates(false)} onContinue={(overwrite) => { setShowDuplicates(false); commit(overwrite); }} />
    </div>
  );
}

// Keeps the localDateKey import honest for the plan step's "today" (same clock as the rest of the app).
void localDateKey;
