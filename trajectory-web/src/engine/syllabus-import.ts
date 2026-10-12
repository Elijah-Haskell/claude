// ============================================================
// Syllabus import - the pure core behind the staged intake flow
//
//   extraction -> DraftItems (review) -> semester decision -> buildSyllabusImport
//   -> ApplySyllabusImportPayload -> applySyllabusImport (reducer)  ...  undoSyllabusImport
//
// Everything here is deterministic and testable without React, the network or a clock:
// `now`, ids and the strategist call are injected. The UI in app/syllabus-upload.tsx only
// collects the student's decisions and calls these functions.
// ============================================================

import type {
  AppState,
  ClassBlock,
  DayOfWeek,
  PlannedStudySession,
  ScheduleBlock,
  Semester,
  SemesterBreak,
  StudySessionPurpose,
  SyllabusImport,
  SyllabusImportItem,
  Task,
  TaskKind,
  TaskPlanningStrategy,
} from "./types";
import { scoreTasks } from "./priority-engine";
import { buildVerifiedClassFromSyllabus } from "./course-matcher";
import { buildSemesterPlan } from "./semester-plan";
import type { TaskShortfall } from "./intelligent-scheduler";
import { newSemesterId, validateSemester } from "./semester";
import {
  daysBetween,
  isRealDateKey,
  resolveItemDate,
  semesterNameFor,
  type DateBreak,
  type DateConfidence,
  type DateSource,
  type ResolvedDate,
} from "./syllabus-dates";
import type { ExtractedItem, ResolvedSyllabusItem, SyllabusItemType } from "./syllabus-extraction-utils";
import { addDaysToKey, timeToMinutes } from "./utils";
import { classShortName, courseShortName, normalizeShortName } from "./week-layout";

// ── Item type -> task kind ────────────────────────────────────

/** The planner's TaskKind for a syllabus item type. An unknown type is "other" (never guessed into an exam). */
export function kindFromSyllabusType(type: string): TaskKind {
  switch (String(type).trim().toLowerCase()) {
    case "exam": return "exam";
    case "quiz": return "quiz";
    case "project": return "project";
    case "reading": return "reading";
    case "assignment": return "assignment";
    default: return "other";
  }
}

/** Display order of the deliverable groups. */
export const SYLLABUS_TYPE_ORDER: readonly SyllabusItemType[] = ["exam", "quiz", "project", "assignment", "reading", "other"];

// ── Names and duplicates ──────────────────────────────────────

const NAME_WORDS: Array<[RegExp, string]> = [
  [/\b(?:hwk|hw)\b/g, "homework"],
  [/\b(?:asgn|assgn|assn|assignt)\b/g, "assignment"],
  [/\b(?:pset|ps)\b/g, "problem set"],
  [/\bpsets\b/g, "problem sets"],
  [/\bmid term\b/g, "midterm"],
  [/\b(?:examination|exams)\b/g, "exam"],
  [/\bquizzes\b/g, "quiz"],
  [/\bfinals\b/g, "final"],
  [/\bprojects\b/g, "project"],
  [/\bpapers\b/g, "paper"],
];

/** Normalise a deliverable name for duplicate detection: case, accents, punctuation, "HW 03" == "homework 3". */
export function normalizeItemName(name: string): string {
  let s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const [pattern, replacement] of NAME_WORDS) s = s.replace(pattern, replacement);
  s = s.replace(/\b0+(\d)/g, "$1").replace(/\s+/g, " ").trim();
  return s;
}

/** Course key used to recognise "the same course" by name when ids differ ("CHEM 201" vs "chem-201"). */
export function normalizeCourseKey(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function duplicateKey(courseKey: string, name: string, dueDate: string): string {
  return `${courseKey}|${normalizeItemName(name)}|${dueDate}`;
}

// ── Draft items (what the student reviews) ────────────────────

export interface DraftItem {
  /** Also the id of the Task that will be created (the strategist refers to it). */
  id: string;
  name: string;
  type: SyllabusItemType;
  /** The date the plan will use; null = "needs a date" (never fabricated). */
  dueDate: string | null;
  /** Optional "HH:MM". */
  dueTime: string;
  estimatedMinutes: number;
  difficulty: number;
  weightPercent: number | null;
  notes: string;
  coversTopics: string[];
  /** Short quote from the document the date came from. */
  dateEvidence: string;
  dateConfidence: DateConfidence | "user";
  dateSource: DateSource | "user";
  outOfRange: ResolvedDate["outOfRange"];
  inBreak: string | null;
  problem: ResolvedDate["problem"];
  weekHint: ResolvedDate["weekHint"];
  /** Strictly before today. */
  isPast: boolean;
  selected: boolean;
  /** The student picked (or unpicked) this item themselves: re-resolving dates must not change it. */
  selectionTouched: boolean;
  /** The student typed the date: re-resolving dates must not change it. */
  dateEdited: boolean;
  /** What the model reported, kept so the date can be re-resolved if the confirmed term differs. */
  raw: ExtractedItem;
}

export interface DateContext {
  today: string;
  termStart?: string | null;
  termEnd?: string | null;
  breaks?: readonly DateBreak[];
}

function applyResolved(draft: DraftItem, resolved: ResolvedDate, today: string): DraftItem {
  const dated = resolved.dueDate !== null;
  return {
    ...draft,
    dueDate: resolved.dueDate,
    dateConfidence: resolved.confidence,
    dateSource: resolved.source,
    outOfRange: resolved.outOfRange,
    inBreak: resolved.inBreak,
    problem: resolved.problem,
    weekHint: resolved.weekHint,
    isPast: dated && resolved.dueDate! < today,
    selected: draft.selectionTouched ? draft.selected && dated : dated && !(resolved.dueDate! < today),
  };
}

/** Items from the server (already resolved once) as review drafts. Undated and past ones start unchecked. */
export function buildDraftItems(items: readonly ResolvedSyllabusItem[], opts: { today: string; idPrefix: string }): DraftItem[] {
  return items.map((item, index) => {
    const { resolved, ...raw } = item;
    const base: DraftItem = {
      id: `${opts.idPrefix}-${index}`,
      name: item.name,
      type: item.type,
      dueDate: null,
      dueTime: item.dueTime ?? "",
      estimatedMinutes: item.estimatedMinutes,
      difficulty: item.difficulty,
      weightPercent: item.weightPercent,
      notes: item.notes,
      coversTopics: item.coversTopics,
      dateEvidence: item.dateEvidence,
      dateConfidence: "missing",
      dateSource: "none",
      outOfRange: null,
      inBreak: null,
      problem: null,
      weekHint: null,
      isPast: false,
      selected: false,
      selectionTouched: false,
      dateEdited: false,
      raw,
    };
    return applyResolved(base, resolved, opts.today);
  });
}

/** After the student confirms the term (which may differ from what the syllabus implied), re-resolve every date they did not type. */
export function reresolveDrafts(drafts: readonly DraftItem[], ctx: DateContext): DraftItem[] {
  return drafts.map((draft) => {
    if (draft.dateEdited) {
      return { ...draft, outOfRange: rangeFlag(draft.dueDate, ctx), isPast: draft.dueDate !== null && draft.dueDate < ctx.today };
    }
    return applyResolved(draft, resolveItemDate(draft.raw, ctx), ctx.today);
  });
}

function rangeFlag(date: string | null, ctx: DateContext): ResolvedDate["outOfRange"] {
  if (!date) return null;
  if (isRealDateKey(ctx.termStart) && date < ctx.termStart) return "before-term";
  if (isRealDateKey(ctx.termEnd) && date > ctx.termEnd) return "after-term";
  return null;
}

export type SetDateResult = { ok: true; draft: DraftItem } | { ok: false; error: string };

/** The student supplies (or clears) a date. Only a real calendar date is accepted. */
export function setDraftDate(draft: DraftItem, value: string, ctx: DateContext): SetDateResult {
  const text = value.trim();
  if (text === "") {
    return {
      ok: true,
      draft: { ...draft, dueDate: null, dateEdited: true, dateConfidence: "missing", dateSource: "none", outOfRange: null, inBreak: null, isPast: false, selected: false, selectionTouched: true },
    };
  }
  if (!isRealDateKey(text)) return { ok: false, error: "Enter a real date as YYYY-MM-DD, for example 2026-10-20." };
  const isPast = text < ctx.today;
  return {
    ok: true,
    draft: {
      ...draft,
      dueDate: text,
      dateEdited: true,
      dateConfidence: "user",
      dateSource: "user",
      problem: null,
      weekHint: null,
      outOfRange: rangeFlag(text, ctx),
      inBreak: ctx.breaks?.find((b) => text >= b.startDate && text <= b.endDate)?.name ?? null,
      isPast,
      selected: draft.selectionTouched ? draft.selected : !isPast,
    },
  };
}

export interface DraftBuckets {
  /** Upcoming (or due today) deliverables by type, each sorted by date. */
  groups: Array<{ type: SyllabusItemType; items: DraftItem[] }>;
  /** No date: the student supplies one or leaves the item out. */
  needsDate: DraftItem[];
  /** Due before today: collapsed and skipped by default. */
  past: DraftItem[];
}

export function bucketDrafts(drafts: readonly DraftItem[], today: string): DraftBuckets {
  const needsDate = drafts.filter((d) => d.dueDate === null);
  const past = drafts.filter((d) => d.dueDate !== null && d.dueDate < today).sort(byDate);
  const upcoming = drafts.filter((d) => d.dueDate !== null && d.dueDate >= today);
  const groups = SYLLABUS_TYPE_ORDER.map((type) => ({ type, items: upcoming.filter((d) => d.type === type).sort(byDate) })).filter((g) => g.items.length > 0);
  return { groups, needsDate, past };
}

function byDate(a: DraftItem, b: DraftItem): number {
  return (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.name.localeCompare(b.name);
}

/** Drafts that will become tasks: checked and dated. (An unchecked or undated draft is never imported.) */
export function importableDrafts(drafts: readonly DraftItem[]): DraftItem[] {
  return drafts.filter((d) => d.selected && d.dueDate !== null && isRealDateKey(d.dueDate));
}

// ── Duplicates ────────────────────────────────────────────────

export interface DuplicateMatch {
  draft: DraftItem;
  existing: Task;
}

export interface DuplicatePartition {
  fresh: DraftItem[];
  /** Same course + same normalised name + same date as a task that already exists. */
  duplicates: DuplicateMatch[];
  /** Repeats within this very import (the model listed an item twice): the first one wins. */
  repeated: DraftItem[];
}

/**
 * Split the importable drafts into new work, work that already exists (the student decides whether to
 * overwrite) and repeats within the batch. A task is "the same course" when its courseId matches OR its
 * course name normalises to the same text.
 */
export function partitionDuplicates(
  drafts: readonly DraftItem[],
  existingTasks: readonly Task[],
  course: { id: string; name: string },
): DuplicatePartition {
  const courseKeys = new Set([normalizeCourseKey(course.name)].filter(Boolean));
  const inCourse = (task: Task) => (course.id !== "" && task.courseId === course.id) || courseKeys.has(normalizeCourseKey(task.courseName));
  const existingByKey = new Map<string, Task>();
  for (const task of existingTasks) {
    if (!inCourse(task)) continue;
    const key = duplicateKey("c", task.name, task.dueDate);
    if (!existingByKey.has(key)) existingByKey.set(key, task);
  }
  const seen = new Set<string>();
  const out: DuplicatePartition = { fresh: [], duplicates: [], repeated: [] };
  for (const draft of drafts) {
    const key = duplicateKey("c", draft.name, draft.dueDate ?? "");
    if (seen.has(key)) {
      out.repeated.push(draft);
      continue;
    }
    seen.add(key);
    const existing = existingByKey.get(key);
    if (existing) out.duplicates.push({ draft, existing });
    else out.fresh.push(draft);
  }
  return out;
}

// ── Semester decision ─────────────────────────────────────────

/** A syllabus "agrees" with the semester on file when its start is within this many days of it ... */
export const TERM_START_TOLERANCE_DAYS = 10;
/** ... and its end within this many (last day of class vs. end of finals differ by a week or two). */
export const TERM_END_TOLERANCE_DAYS = 21;

export interface TermAssessment {
  /** none: no semester on file. agree: consistent with (or silent about) the one on file. conflict: it disagrees. */
  mode: "new" | "agree" | "conflict";
  existing: Semester | null;
  proposedStart: string | null;
  proposedEnd: string | null;
  /** Breaks the syllabus lists that the semester on file does not have yet. */
  newBreaks: SemesterBreak[];
  /** Days the syllabus only annotates (a holiday with a class still listed). Applied only if the student confirms them. */
  candidateBreaks: SemesterBreak[];
}

function sameBreak(a: SemesterBreak, b: SemesterBreak): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate;
}

export function assessTerm(input: {
  existing: Semester | null | undefined;
  start: string | null;
  end: string | null;
  breaks: readonly DateBreak[];
  /** Annotated-only days (see TermAssessment.candidateBreaks). */
  candidates?: readonly DateBreak[];
}): TermAssessment {
  const existing = input.existing ?? null;
  const proposedStart = isRealDateKey(input.start) ? input.start : null;
  const proposedEnd = isRealDateKey(input.end) ? input.end : null;
  const toBreak = (b: DateBreak): SemesterBreak => ({ name: b.name, startDate: b.startDate, endDate: b.endDate });
  const breaks: SemesterBreak[] = input.breaks.map(toBreak);
  const candidates: SemesterBreak[] = (input.candidates ?? []).map(toBreak);
  if (!existing) return { mode: "new", existing: null, proposedStart, proposedEnd, newBreaks: breaks, candidateBreaks: candidates };

  const startDiffers = proposedStart !== null && Math.abs(daysBetween(existing.startDate, proposedStart)) > TERM_START_TOLERANCE_DAYS;
  const endDiffers = proposedEnd !== null && Math.abs(daysBetween(existing.endDate, proposedEnd)) > TERM_END_TOLERANCE_DAYS;
  const unknown = (b: SemesterBreak) => !existing.breaks.some((known) => sameBreak(known, b));
  return {
    mode: startDiffers || endDiffers ? "conflict" : "agree",
    existing,
    proposedStart,
    proposedEnd,
    newBreaks: breaks.filter(unknown),
    candidateBreaks: candidates.filter(unknown),
  };
}

export type SemesterChoice =
  | { action: "keep" } // keep the semester on file (add breaks if asked)
  | { action: "replace" } // use the syllabus's dates for the semester on file
  | { action: "create"; name?: string; start: string; end: string } // no semester on file: create one
  | { action: "skip" }; // no semester (the student declined to enter dates)

export type SemesterOutcome =
  | { ok: true; changed: boolean; semester: Semester | null; before: Semester | null }
  | { ok: false; error: string };

function insideRange(b: SemesterBreak, start: string, end: string): boolean {
  return b.startDate >= start && b.endDate <= end && b.startDate <= b.endDate;
}

function mergeBreaks(current: readonly SemesterBreak[], incoming: readonly SemesterBreak[], start: string, end: string): SemesterBreak[] {
  const merged = current.filter((b) => insideRange(b, start, end));
  for (const b of incoming) {
    if (insideRange(b, start, end) && !merged.some((known) => sameBreak(known, b))) merged.push(b);
  }
  return merged.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
}

/**
 * The semester the student confirmed. `includeBreaks` = "add the breaks found in the syllabus".
 * Validation is the planner's (`validateSemester`): real dates, start <= end, breaks inside the term.
 */
export function decideSemester(
  assessment: TermAssessment,
  choice: SemesterChoice,
  opts: { includeBreaks: boolean; newId?: string; now?: Date; confirmedCandidates?: readonly SemesterBreak[] },
): SemesterOutcome {
  const { existing } = assessment;
  // Candidates (a holiday with a class still listed) count only when the student confirmed them individually.
  const confirmed = (opts.confirmedCandidates ?? []).filter((c) => assessment.candidateBreaks.some((known) => sameBreak(known, c)));
  const extraBreaks = [...(opts.includeBreaks ? assessment.newBreaks : []), ...confirmed];

  if (choice.action === "skip") return { ok: true, changed: false, semester: existing, before: existing };

  if (choice.action === "create") {
    if (existing) return { ok: false, error: "A semester is already set." };
    const name = (choice.name ?? "").trim() || semesterNameFor(choice.start);
    const draft: Semester = {
      id: opts.newId ?? newSemesterId((opts.now ?? new Date()).getTime()),
      name,
      startDate: choice.start,
      endDate: choice.end,
      breaks: mergeBreaks([], extraBreaks, choice.start, choice.end),
    };
    const checked = validateSemester(draft);
    return checked.ok ? { ok: true, changed: true, semester: checked.semester, before: null } : { ok: false, error: checked.error };
  }

  if (!existing) return { ok: false, error: "There is no semester on file to keep or replace." };

  if (choice.action === "replace") {
    const start = assessment.proposedStart ?? existing.startDate;
    const end = assessment.proposedEnd ?? existing.endDate;
    const next: Semester = {
      ...existing,
      startDate: start,
      endDate: end,
      breaks: mergeBreaks(existing.breaks, extraBreaks, start, end),
    };
    const checked = validateSemester(next);
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, changed: JSON.stringify(checked.semester) !== JSON.stringify(existing), semester: checked.semester, before: existing };
  }

  // keep
  if (extraBreaks.length === 0) return { ok: true, changed: false, semester: existing, before: existing };
  const next: Semester = { ...existing, breaks: mergeBreaks(existing.breaks, extraBreaks, existing.startDate, existing.endDate) };
  const checked = validateSemester(next);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, changed: JSON.stringify(checked.semester) !== JSON.stringify(existing), semester: checked.semester, before: existing };
}

// ── Strategist (advisory) with a guaranteed fallback ──────────

const PURPOSES: readonly StudySessionPurpose[] = ["preview", "learn", "practice", "draft", "review", "submit"];
export const STRATEGY_MAX_TASKS = 80;

export interface StrategyRequestTask {
  id: string;
  name: string;
  courseId: string;
  courseName: string;
  dueDate: string;
  estimatedMinutes: number;
  difficulty: number;
  notes?: string;
  type?: string;
  weightPercent?: number;
}

export interface StrategyRequest {
  today: string;
  semesterStart?: string;
  semesterEnd?: string;
  breaks?: Array<{ name: string; startDate: string; endDate: string }>;
  energyProfile: "morning" | "afternoon" | "night";
  studyStyle: "short_bursts" | "deep_blocks";
  classes: Array<{ id: string; name: string; days: string[]; startTime: string; endTime: string; isAsynchronous?: boolean }>;
  tasks: StrategyRequestTask[];
}

export interface StrategyResponse {
  planSummary?: string;
  taskPlans: Array<{
    taskId: string;
    rationale: string;
    priority: number;
    sessions: Array<{ label: string; purpose: string; minutes: number; earliestDaysBeforeDue: number; targetDaysBeforeDue: number }>;
  }>;
  warnings: Array<{ severity: string; taskId?: string; message: string }>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

/** The strategist may only refine what we asked about: unknown ids, junk sessions and implausible totals are dropped. */
export function normalizeStrategyResponse(
  response: unknown,
  tasks: ReadonlyArray<{ id: string; estimatedMinutes: number }>,
): { strategies: Map<string, TaskPlanningStrategy>; warnings: string[] } {
  const strategies = new Map<string, TaskPlanningStrategy>();
  const warnings: string[] = [];
  if (!response || typeof response !== "object") return { strategies, warnings };
  const source = response as Partial<StrategyResponse>;
  const estimates = new Map(tasks.map((t) => [t.id, t.estimatedMinutes]));

  for (const plan of Array.isArray(source.taskPlans) ? source.taskPlans : []) {
    if (!plan || typeof plan.taskId !== "string" || !estimates.has(plan.taskId) || strategies.has(plan.taskId)) continue;
    const sessions: PlannedStudySession[] = [];
    for (const s of Array.isArray(plan.sessions) ? plan.sessions : []) {
      if (!s || typeof s !== "object") continue;
      const minutes = clampInt(s.minutes, 15, 240, 0);
      if (minutes < 15) continue;
      const earliest = clampInt(s.earliestDaysBeforeDue, 0, 180, 0);
      sessions.push({
        label: String(s.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Study session",
        purpose: (PURPOSES as readonly string[]).includes(String(s.purpose)) ? (s.purpose as StudySessionPurpose) : "learn",
        minutes,
        earliestDaysBeforeDue: earliest,
        targetDaysBeforeDue: Math.min(earliest, clampInt(s.targetDaysBeforeDue, 0, 180, earliest)),
      });
      if (sessions.length >= 12) break;
    }
    const estimate = estimates.get(plan.taskId)!;
    const total = sessions.reduce((sum, s) => sum + s.minutes, 0);
    if (sessions.length === 0 || total < estimate * 0.5 || total > estimate * 2) continue; // implausible: the solver's default sessions are safer
    strategies.set(plan.taskId, {
      rationale: String(plan.rationale ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      priority: clampInt(plan.priority, 1, 5, 3) as 1 | 2 | 3 | 4 | 5,
      sessions,
    });
  }
  for (const w of Array.isArray(source.warnings) ? source.warnings : []) {
    if (w && typeof w.message === "string" && w.message.trim() && (w.severity === "warning" || w.severity === "critical")) warnings.push(w.message.trim().slice(0, 300));
  }
  return { strategies, warnings };
}

export interface StrategyOutcome {
  strategies: Map<string, TaskPlanningStrategy>;
  warnings: string[];
  /** true when the AI call failed: the import proceeds with the solver's default session plans. */
  unavailable: boolean;
}

/**
 * Ask the strategist for session plans. The answer is advisory: if the call fails (or returns garbage) the import
 * still succeeds with default session plans, and `unavailable` says so.
 */
export async function requestStrategyWithFallback(
  call: (request: StrategyRequest) => Promise<unknown>,
  request: StrategyRequest,
): Promise<StrategyOutcome> {
  if (request.tasks.length === 0) return { strategies: new Map(), warnings: [], unavailable: false };
  try {
    const response = await call(request);
    const { strategies, warnings } = normalizeStrategyResponse(response, request.tasks);
    return { strategies, warnings, unavailable: false };
  } catch {
    return { strategies: new Map(), warnings: [], unavailable: true };
  }
}

const TYPE_PRIORITY: Record<string, number> = { exam: 0, project: 1, quiz: 2, assignment: 3, other: 4, reading: 5 };

/** Build the strategist request from the import (bounded to what the endpoint accepts). */
export function buildStrategyRequest(input: {
  today: string;
  semester: Semester | null | undefined;
  userPrefs: { energyProfile: StrategyRequest["energyProfile"]; studyStyle: StrategyRequest["studyStyle"] };
  classes: readonly ClassBlock[];
  drafts: readonly DraftItem[];
  course: { id: string; name: string };
}): StrategyRequest {
  const drafts = [...input.drafts]
    .sort((a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9) || (b.weightPercent ?? 0) - (a.weightPercent ?? 0))
    .slice(0, STRATEGY_MAX_TASKS);
  return {
    today: input.today,
    ...(input.semester ? { semesterStart: input.semester.startDate, semesterEnd: input.semester.endDate } : {}),
    ...(input.semester?.breaks.length ? { breaks: input.semester.breaks.slice(0, 20).map((b) => ({ name: b.name.slice(0, 300), startDate: b.startDate, endDate: b.endDate })) } : {}),
    energyProfile: input.userPrefs.energyProfile,
    studyStyle: input.userPrefs.studyStyle,
    classes: input.classes.slice(0, 100).map((c) => ({
      id: c.id.slice(0, 128),
      name: c.name.slice(0, 300),
      days: c.days.slice(0, 7),
      startTime: c.startTime.slice(0, 20),
      endTime: c.endTime.slice(0, 20),
      isAsynchronous: Boolean(c.isAsynchronous),
    })),
    tasks: drafts.map((d) => ({
      id: d.id.slice(0, 128),
      name: d.name.slice(0, 300),
      courseId: input.course.id.slice(0, 128),
      courseName: input.course.name.slice(0, 300),
      dueDate: d.dueDate ?? "",
      estimatedMinutes: Math.max(15, Math.min(960, Math.round(d.estimatedMinutes))),
      difficulty: Math.max(1, Math.min(5, Math.round(d.difficulty))),
      ...(d.notes || d.coversTopics.length > 0
        ? { notes: [d.notes, d.coversTopics.length > 0 ? `Covers: ${d.coversTopics.join("; ")}` : ""].filter(Boolean).join(" | ").slice(0, 2000) }
        : {}),
      type: d.type,
      ...(d.weightPercent ? { weightPercent: d.weightPercent } : {}),
    })),
  };
}

// ── Building the import ───────────────────────────────────────

export interface ApplySyllabusImportPayload {
  classToCreate?: ClassBlock;
  classToUpdate?: ClassBlock;
  tasks: Task[];
  taskUpdates: Task[];
  importRecord: SyllabusImport;
  /** Set when this import creates the semester or changes the one on file (undo restores it). */
  semester?: Semester;
}

export interface CourseInput {
  name: string;
  code: string;
  /** The class's short tag as the student confirmed it ("FINC"). Empty or absent: one is made from the name. */
  shortName?: string;
  isAsynchronous: boolean;
  days: DayOfWeek[];
  startTime: string;
  endTime: string;
  location: string;
}

export type ClassTarget = { kind: "existing"; cls: ClassBlock } | { kind: "new" };

/** "CHEM 201: Organic Chemistry" (or whichever half exists). */
export function composeClassName(name: string, code: string): string {
  const n = name.trim();
  const c = code.trim();
  if (!c) return n || "Untitled course";
  if (!n) return c;
  return n.toLowerCase().includes(c.toLowerCase()) ? n : `${c}: ${n}`;
}

export function isValidMeeting(days: readonly DayOfWeek[], startTime: string, endTime: string): boolean {
  return days.length > 0 && Boolean(startTime && endTime) && timeToMinutes(startTime) < timeToMinutes(endTime);
}

export interface BuildImportInput {
  now: Date;
  today: string;
  /** Local run id: also the id of the SyllabusImport record. */
  importId: string;
  drafts: readonly DraftItem[];
  course: CourseInput;
  target: ClassTarget;
  existing: { classes: readonly ClassBlock[]; tasks: readonly Task[] };
  /** The semester this import sets / changes; omit when it leaves the semester alone. */
  semester?: Semester | null;
  /** Draft ids the student chose to overwrite (duplicates). */
  overwriteIds?: ReadonlySet<string>;
  strategies?: ReadonlyMap<string, TaskPlanningStrategy>;
  strategyUnavailable?: boolean;
  source: "file" | "scan" | "paste";
  rawText?: string;
  extractionJson?: string;
  /** Id for a class this import creates. */
  newClassId?: string;
}

export interface BuiltImport {
  payload: ApplySyllabusImportPayload;
  counts: {
    added: number;
    overwritten: number;
    skippedDuplicates: number;
    repeated: number;
    excludedUndated: number;
    excludedPast: number;
    excludedUnchecked: number;
  };
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Turn the student's confirmed decisions into one atomic payload for the reducer. Pure: no clock, no random ids
 * (`importId`, draft ids and `newClassId` are supplied), no state access.
 */
export function buildSyllabusImport(input: BuildImportInput): BuiltImport {
  const { now, today, drafts, course, target, existing } = input;
  const overwriteIds = input.overwriteIds ?? new Set<string>();
  // A class with no verified meeting pattern is not a scheduling constraint: refuse rather than plan around a guess.
  if (!course.isAsynchronous && !isValidMeeting(course.days, course.startTime, course.endTime)) {
    throw new Error("Choose the class meeting days and times (or mark the course asynchronous) before planning.");
  }
  const label = composeClassName(course.name, course.code);
  const meeting = {
    days: course.isAsynchronous ? [] : [...course.days],
    startTime: course.isAsynchronous ? "" : course.startTime,
    endTime: course.isAsynchronous ? "" : course.endTime,
    location: course.location,
    isAsynchronous: course.isAsynchronous,
  };

  // ── Class ──
  // The short name is only stored when it says something the name does not already give (classShortName).
  const tag = normalizeShortName(course.shortName ?? "");
  let classToCreate: ClassBlock | undefined;
  let classToUpdate: ClassBlock | undefined;
  let linkedClass: { id: string; name: string };
  if (target.kind === "new") {
    const id = input.newClassId ?? `class-${input.importId}`;
    classToCreate = omitUndefined({
      ...buildVerifiedClassFromSyllabus(label, existing.classes.length, meeting),
      id,
      shortName: tag && tag !== normalizeShortName(courseShortName(label)) ? tag : undefined,
    });
    linkedClass = { id, name: label };
  } else {
    const cls = target.cls;
    linkedClass = { id: cls.id, name: cls.name };
    const meetingChanged =
      cls.startTime !== meeting.startTime ||
      cls.endTime !== meeting.endTime ||
      cls.days.join() !== meeting.days.join() ||
      Boolean(cls.isAsynchronous) !== meeting.isAsynchronous ||
      (cls.location ?? "") !== (meeting.location.trim() ?? "");
    // Compared as the field shows it (normalised), so a long tag made from the name is never stored cut short by
    // an import that did not touch it. An emptied field takes a custom tag away again.
    const tagChanged = tag !== "" && tag !== normalizeShortName(classShortName(cls));
    const tagCleared = course.shortName !== undefined && tag === "" && Boolean(cls.shortName);
    if (meetingChanged || tagChanged || tagCleared) {
      classToUpdate = omitUndefined({
        ...cls,
        ...(tagChanged ? { shortName: tag } : tagCleared ? { shortName: undefined } : {}),
        ...(meetingChanged
          ? {
              days: meeting.days,
              startTime: meeting.startTime,
              endTime: meeting.endTime,
              location: meeting.location.trim() || undefined,
              isAsynchronous: meeting.isAsynchronous || undefined,
            }
          : {}),
      });
    }
  }

  // ── Tasks ──
  const importable = importableDrafts(drafts);
  const { fresh, duplicates, repeated } = partitionDuplicates(importable, existing.tasks, linkedClass);
  const strategies = input.strategies ?? new Map<string, TaskPlanningStrategy>();
  const createdAt = now.toISOString();

  const tasks: Task[] = fresh.map((d) => taskFromDraft(d, { linkedClass, createdAt, importId: input.importId, strategy: strategies.get(d.id) }));
  const taskUpdates: Task[] = [];
  let skippedDuplicates = 0;
  for (const { draft, existing: original } of duplicates) {
    if (!overwriteIds.has(draft.id)) {
      skippedDuplicates += 1;
      continue;
    }
    const strategy = strategies.get(draft.id);
    taskUpdates.push(
      omitUndefined({
        ...original,
        estimatedMinutes: draft.estimatedMinutes,
        difficulty: clampInt(draft.difficulty, 1, 5, 3) as Task["difficulty"],
        kind: kindFromSyllabusType(draft.type),
        weightPercent: draft.weightPercent ?? original.weightPercent,
        dueTime: draft.dueTime || original.dueTime,
        planningStrategy: strategy ?? original.planningStrategy,
      }),
    );
  }

  const excludedUndated = drafts.filter((d) => d.dueDate === null).length;
  const excludedPast = drafts.filter((d) => d.dueDate !== null && d.dueDate < today && !d.selected).length;
  const excludedUnchecked = drafts.filter((d) => d.dueDate !== null && d.dueDate >= today && !d.selected).length;

  const imported = [...fresh, ...duplicates.filter((m) => overwriteIds.has(m.draft.id)).map((m) => m.draft)];
  const extractedItems: SyllabusImportItem[] = imported.map((d) => ({
    name: d.name,
    dueDate: d.dueDate ?? "",
    type: d.type,
    difficulty: d.difficulty,
    estimatedMinutes: d.estimatedMinutes,
  }));

  const importRecord: SyllabusImport = omitUndefined({
    id: input.importId,
    importedAt: createdAt,
    courseName: course.name || label,
    linkedClassId: linkedClass.id,
    linkedClassName: linkedClass.name,
    itemCount: tasks.length + taskUpdates.length,
    skippedCount: skippedDuplicates,
    isNewClass: Boolean(classToCreate),
    extractedItems,
    courseDescription: course.name ? course.name : undefined,
    rawText: input.rawText || undefined,
    extractionJson: input.extractionJson,
    source: input.source,
    excludedCount: excludedUndated + excludedPast + excludedUnchecked,
    strategyUnavailable: input.strategyUnavailable || undefined,
  });

  return {
    payload: omitUndefined({
      classToCreate,
      classToUpdate,
      tasks,
      taskUpdates,
      importRecord,
      semester: input.semester ?? undefined,
    }),
    counts: {
      added: tasks.length,
      overwritten: taskUpdates.length,
      skippedDuplicates,
      repeated: repeated.length,
      excludedUndated,
      excludedPast,
      excludedUnchecked,
    },
  };
}

function taskFromDraft(
  draft: DraftItem,
  ctx: { linkedClass: { id: string; name: string }; createdAt: string; importId: string; strategy?: TaskPlanningStrategy },
): Task {
  return omitUndefined<Task>({
    id: draft.id,
    name: draft.name,
    courseId: ctx.linkedClass.id,
    courseName: ctx.linkedClass.name,
    dueDate: draft.dueDate!,
    dueTime: draft.dueTime || undefined,
    estimatedMinutes: draft.estimatedMinutes,
    difficulty: clampInt(draft.difficulty, 1, 5, 3) as Task["difficulty"],
    requiresOnCampus: false,
    status: "pending",
    createdAt: ctx.createdAt,
    kind: kindFromSyllabusType(draft.type),
    weightPercent: draft.weightPercent ?? undefined,
    dateConfidence: draft.dateConfidence === "missing" ? undefined : draft.dateConfidence,
    dateEvidence: draft.dateEvidence || undefined,
    coversTopics: draft.coversTopics.length > 0 ? draft.coversTopics : undefined,
    syllabusImportId: ctx.importId,
    planningStrategy: ctx.strategy,
  });
}

// ── Applying and undoing (used by the reducer) ────────────────

/** Apply one import as a single transaction and record exactly what it created / overwrote so it can be undone. */
export function applySyllabusImport(state: AppState, payload: ApplySyllabusImportPayload): AppState {
  const { classToCreate, classToUpdate, tasks, taskUpdates, importRecord } = payload;
  // A semester the planner would reject is not applied (and not recorded); the tasks still import.
  const checkedSemester = payload.semester ? validateSemester(payload.semester) : null;
  const semester = checkedSemester?.ok ? checkedSemester.semester : undefined;
  const updatesById = new Map(taskUpdates.map((task) => [task.id, task]));
  const overwrittenTasks = state.tasks.filter((task) => updatesById.has(task.id));
  // Ids are unique by construction; if one ever collided it must not be "created" (undo would remove someone else's task).
  const takenIds = new Set(state.tasks.map((task) => task.id));
  const newTasks = tasks.filter((task) => !takenIds.has(task.id));
  const previousClass = classToUpdate ? state.classes.find((course) => course.id === classToUpdate.id) : undefined;

  const record: SyllabusImport = omitUndefined({
    ...importRecord,
    createdTaskIds: newTasks.map((task) => task.id),
    createdClassId: classToCreate?.id,
    previousClass,
    overwrittenTasks: overwrittenTasks.length > 0 ? overwrittenTasks : undefined,
    semesterSetId: semester ? semester.id : undefined,
    semesterBefore: semester ? state.semester ?? null : undefined,
    userBefore: semester ? state.user ?? null : undefined,
  });

  return {
    ...state,
    classes: classToCreate
      ? [...state.classes, classToCreate]
      : classToUpdate
        ? state.classes.map((course) => (course.id === classToUpdate.id ? classToUpdate : course))
        : state.classes,
    tasks: [...state.tasks.map((task) => updatesById.get(task.id) ?? task), ...scoreTasks(newTasks)],
    ...(semester ? { semester } : {}),
    syllabusImports: [record, ...(state.syllabusImports ?? [])],
  };
}

/**
 * Remove exactly what an import created and put back what it overwrote:
 * its tasks and their study blocks, the class it created (and that class's meeting / transition blocks), the
 * class meeting pattern or short name it edited, the tasks it overwrote, and the semester it set or changed.
 * Everything else - including other imports and the student's own edits elsewhere - is untouched.
 */
export function undoSyllabusImport(state: AppState, importId: string): AppState {
  const record = (state.syllabusImports ?? []).find((entry) => entry.id === importId);
  if (!record) return state;

  const createdTaskIds = new Set(record.createdTaskIds ?? []);
  const createdClassId = record.createdClassId;
  const overwritten = new Map((record.overwrittenTasks ?? []).map((task) => [task.id, task]));

  const isGenerated = (block: ScheduleBlock): boolean =>
    Boolean(block.taskId && createdTaskIds.has(block.taskId)) ||
    Boolean(createdClassId && (block.courseId === createdClassId || block.id.startsWith(`class-${createdClassId}-`) || block.id.startsWith(`buffer-${createdClassId}-`)));

  const previousClass = record.previousClass;
  const next: AppState = {
    ...state,
    tasks: state.tasks.filter((task) => !createdTaskIds.has(task.id)).map((task) => overwritten.get(task.id) ?? task),
    classes: state.classes
      .filter((course) => course.id !== createdClassId)
      .map((course) => (previousClass && course.id === previousClass.id ? previousClass : course)),
    scheduleBlocks: state.scheduleBlocks.filter((block) => !isGenerated(block)),
    syllabusImports: (state.syllabusImports ?? []).filter((entry) => entry.id !== importId),
  };

  if (record.semesterSetId !== undefined && state.semester?.id === record.semesterSetId) {
    // Setting a semester also labels the profile with its name; give the profile back only if nobody changed that label since.
    const labelUntouched = state.user?.currentSemester === state.semester.name;
    if (record.semesterBefore) next.semester = record.semesterBefore;
    else delete next.semester;
    if (labelUntouched && record.userBefore !== undefined) {
      if (record.userBefore) next.user = record.userBefore;
      else delete next.user;
    }
  }
  return next;
}

// ── After the import: what did it plan? ───────────────────────

export interface ImportPlanSummary {
  /** Study minutes placed for the imported tasks (before their deadlines). */
  plannedMinutes: number;
  plannedHours: number;
  /** Distinct calendar weeks that hold at least one session for the imported tasks. */
  weeksPlanned: number;
  /** Imported work that could not be fully placed before its deadline. */
  shortfalls: TaskShortfall[];
  /** Deliverables the student left without a date (they are not planned). */
  needDate: number;
  /** shortfalls + items still needing a date: the number on the success screen. */
  needAttention: number;
  /** The study blocks the plan holds for the imported tasks. */
  blocks: ScheduleBlock[];
}

/**
 * Plan the whole semester with the planner's own entry point (buildSemesterPlan: today through the end of the
 * term or the latest deadline) and summarise it honestly: minutes placed for the imported tasks, weeks covered
 * and shortfalls. `state` must already contain the import (see applySyllabusImport).
 */
export function summarizeImportPlan(
  state: AppState,
  taskIds: ReadonlySet<string>,
  opts: { now: Date; needDate?: number },
): ImportPlanSummary {
  // Stable like the build that follows an import (AUTO_BUILD_WEEK): the other courses' sessions stay where they are.
  const plan = buildSemesterPlan(state, { now: opts.now, keepSuggestions: true });
  const shortfalls: TaskShortfall[] = plan.shortfalls.filter((s) => taskIds.has(s.taskId));
  const blocks = plan.scheduleBlocks.filter((b) => b.type === "study" && b.taskId && taskIds.has(b.taskId) && b.completionStatus === "pending");
  const plannedMinutes = blocks.reduce((sum, b) => sum + (timeToMinutes(b.endTime) - timeToMinutes(b.startTime)), 0);
  const weeks = new Set(blocks.map((b) => weekStartOf(b.date)));
  const needDate = opts.needDate ?? 0;
  return {
    plannedMinutes,
    plannedHours: Math.round((plannedMinutes / 60) * 10) / 10,
    weeksPlanned: weeks.size,
    shortfalls,
    needDate,
    needAttention: shortfalls.length + needDate,
    blocks,
  };
}

function weekStartOf(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  return addDaysToKey(key, -dow);
}

// ── Class facts prefilled from the extraction ─────────────────

export interface BasicsPrefill {
  name: string;
  code: string;
  isAsynchronous: boolean;
  days: DayOfWeek[];
  startTime: string;
  endTime: string;
  location: string;
  /** Meeting facts the syllabus did not give: the student has to fill these in. */
  missingMeeting: boolean;
}

/** Prefill "Confirm the basics" from the extraction; an existing class fills the gaps the syllabus leaves. */
export function prefillBasics(
  course: {
    name: string;
    code: string;
    isAsynchronous: boolean;
    meetingPattern: { days: DayOfWeek[]; startTime: string | null; endTime: string | null; location: string } | null;
  },
  linked?: ClassBlock | null,
): BasicsPrefill {
  const mp = course.meetingPattern;
  const days = mp && mp.days.length > 0 ? mp.days : linked?.days ?? [];
  const startTime = mp?.startTime ?? linked?.startTime ?? "";
  const endTime = mp?.endTime ?? linked?.endTime ?? "";
  const isAsynchronous = course.isAsynchronous || Boolean(linked?.isAsynchronous && !mp);
  return {
    name: course.name || linked?.name || "",
    code: course.code,
    isAsynchronous,
    days: isAsynchronous ? [] : days,
    startTime,
    endTime,
    location: mp?.location || linked?.location || "",
    missingMeeting: !isAsynchronous && !isValidMeeting(days, startTime, endTime),
  };
}


// ── After the import: the other classes ───────────────────────

export interface OtherClassesUpsell {
  title: string;
  body: string;
  /** One line, for a row on Today. */
  short: string;
}

/**
 * The non-blocking "Plan your other classes" card on the success step. Only for a free account whose free
 * syllabus is now used (every other course needs Pro); never while the entitlement is still loading. Names the
 * number of the student's classes that have no syllabus yet when there are any.
 */
export function otherClassesUpsell(input: {
  isPro: boolean;
  isProLoading: boolean;
  freeImports: number;
  imports: ReadonlyArray<Pick<SyllabusImport, "linkedClassId">>;
  classes: ReadonlyArray<Pick<ClassBlock, "id">>;
}): OtherClassesUpsell | null {
  if (input.isPro || input.isProLoading) return null;
  if (input.imports.length < input.freeImports) return null;
  const imported = new Set(input.imports.map((i) => i.linkedClassId));
  const others = input.classes.filter((c) => !imported.has(c.id)).length;
  return {
    title: others > 0 ? `Plan your other ${others} class${others === 1 ? "" : "es"}` : "Plan your other classes",
    short: "The free plan covers one syllabus. Pro plans every class together.",
    body: others > 0
      ? "The free plan plans one syllabus. With Pro, upload the rest and the whole semester is planned around all of them."
      : "Taking more than one class? The free plan plans one syllabus. With Pro, upload the rest and the whole semester is planned around all of them.",
  };
}
