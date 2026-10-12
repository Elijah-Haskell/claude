/**
 * The rules of the syllabus import's screens, as pure functions (app/syllabus-upload.tsx, components/syllabus/*):
 * the four steps and the named rows of the wait, the clock and its time bar, what "Check your class" still needs
 * before Continue, and how the found dates are sorted into "Take a look" and "Looks right".
 *
 * Nothing here claims more than the app knows. The server reports four stages of a read and, for two of them, how
 * many deadlines it has found (lib/poll-job.ts JobPollProgress); the rows say exactly that.
 */
import type { JobPollProgress } from "./poll-job";
import { composeClassName, type DraftItem } from "./syllabus-import";
import type { DayOfWeek } from "./types";
import { formatTime, parseLocalDate, timeToMinutes } from "./utils";

// ── The four steps ────────────────────────────────────────────────────────────

/** 1 the syllabus (choosing it, and the wait while it is read), 2 the class, 3 the dates, 4 the plan being built. */
export type FlowStep = "source" | "basics" | "items" | "plan";

export const FLOW_STEPS: readonly FlowStep[] = ["source", "basics", "items", "plan"];

export function flowStepNumber(step: FlowStep): number {
  return FLOW_STEPS.indexOf(step) + 1;
}

// ── The wait ──────────────────────────────────────────────────────────────────

export type SourceKind = "file" | "scan" | "paste";
export type ReadingRowState = "done" | "now" | "wait";

export interface ReadingRow {
  key: "sent" | "read" | "deadlines" | "plan";
  title: string;
  sub?: string;
  state: ReadingRowState;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The named rows of the wait. `phase` "sending": the file or the pages are still on their way. "reading": the server
 * has them. "planning": the student has checked the class and the dates, and the plan is being built (step 4).
 */
export function readingRows(input: {
  kind: SourceKind;
  phase: "sending" | "reading" | "planning";
  progress?: JobPollProgress | null;
  /** Scanned pages or photos sent. */
  pages?: number;
  /** "planning": how many dated items are going into the plan. */
  toPlan?: number;
}): ReadingRow[] {
  const { kind, phase, progress } = input;
  const sending = phase === "sending";
  const sentTitle =
    kind === "paste"
      ? "Text received"
      : kind === "scan"
        ? sending
          ? "Uploading the pages"
          : input.pages
            ? `${count(input.pages, "page")} uploaded`
            : "Pages uploaded"
        : sending
          ? "Uploading"
          : "Uploaded";
  const sent: ReadingRow = { key: "sent", title: sentTitle, state: sending ? "now" : "done" };
  const plan: ReadingRow = { key: "plan", title: "Building your plan", sub: "After you check the class and the dates", state: "wait" };

  if (phase === "planning") {
    return [
      sent,
      { key: "read", title: "Syllabus read", state: "done" },
      { key: "deadlines", title: "Dates checked", sub: input.toPlan ? `${count(input.toPlan, "item")} to plan` : undefined, state: "done" },
      { key: "plan", title: "Building your plan", sub: "Placing study time before each deadline", state: "now" },
    ];
  }
  if (sending) {
    return [sent, { key: "read", title: "Reading the syllabus", state: "wait" }, { key: "deadlines", title: "Finding deadlines", state: "wait" }, plan];
  }

  const found = progress?.itemsFound ?? 0;
  if (progress?.stage === "reading-more" && found > 0) {
    return [sent, { key: "read", title: "First pass read", state: "done" }, { key: "deadlines", title: "Finding deadlines", sub: `${found} found so far. Reading the rest.`, state: "now" }, plan];
  }
  if (progress?.stage === "finishing" && found > 0) {
    return [sent, { key: "read", title: "Syllabus read", state: "done" }, { key: "deadlines", title: "Finding deadlines", sub: `${found} found. Finishing up.`, state: "now" }, plan];
  }
  const readSub = progress?.stage === "second-look" ? "The first read wasn't usable. Taking a slower second look." : "Class times, term dates, exams and deadlines";
  return [sent, { key: "read", title: "Reading the syllabus", sub: readSub, state: "now" }, { key: "deadlines", title: "Finding deadlines", state: "wait" }, plan];
}

/** "0:48", "12:05": the time a read has taken so far. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A file or photos usually take one to three minutes (pictures of pages are the slow part). */
export const USUAL_READ_MS = 180_000;

/**
 * The bar under the clock: the time so far against the usual three minutes, never empty and never quite full. It
 * shows time passing, not how much of the syllabus has been read (the server does not report that).
 */
export function readingTimeFraction(elapsedMs: number): number {
  return Math.min(0.96, Math.max(0.03, elapsedMs / USUAL_READ_MS));
}

/**
 * The words beside the clock. Pasted text has no usual time worth naming (it is one quick request), so it gets no
 * words and no bar.
 */
export function readingExpectation(input: { kind: SourceKind; elapsedMs: number; reconnecting?: boolean }): string | null {
  if (input.reconnecting) return "The connection dropped. Reconnecting…";
  if (input.kind === "paste") return null;
  return input.elapsedMs >= USUAL_READ_MS ? "Taking longer than usual" : "Usually 1 to 3 minutes";
}

/**
 * Whether the wait may say "you can leave the app": only a file or pages are read as a job on the server, which
 * keeps going and is picked up again (lib/pending-extraction.ts). Pasted text is one request that leaving can drop.
 */
export function canLeaveDuringRead(kind: SourceKind): boolean {
  return kind !== "paste";
}

// ── Step 2: check your class ──────────────────────────────────────────────────

/**
 * The name offered for a new class: what the syllabus calls the course, with its code in front when it gives one
 * ("FINC 3100: Principles of Finance"). A syllabus that names neither offers nothing: the field stays empty and
 * Continue waits for the student to name the class (never a made-up "Untitled course").
 */
export function classNameFromSyllabus(name: string, code: string): string {
  return name.trim() || code.trim() ? composeClassName(name, code) : "";
}

export interface ClassStepInput {
  name: string;
  /** The dates join a class the student already has: it has a name. */
  linked: boolean;
  isAsynchronous: boolean;
  days: readonly DayOfWeek[];
  startTime: string;
  endTime: string;
  /** "new": no term on file, so this step asks for one. Otherwise the term needs nothing here. */
  termMode: "new" | "agree" | "conflict";
  termSkipped: boolean;
  termStart: string;
  termEnd: string;
}

/**
 * What is still missing before Continue, in words (shown above the button, which stays off until it is null). A
 * time that was never chosen is missing: the row says "Choose", it never shows a time the student did not pick.
 */
/**
 * The extraction's notes that "Check your class" shows. One is left out: "The grade weights found add up to ...".
 * The weights still tell the planner which work counts for more, but they are not on screen (grade tracking was cut),
 * so a note about them would point at nothing the student can see or fix.
 */
export function shownImportWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !/^The grade weights found\b/i.test(warning));
}

export function classStepBlocker(input: ClassStepInput): string | null {
  if (!input.linked && !input.name.trim()) return "Give the class a name to continue";
  if (!input.isAsynchronous) {
    const noDays = input.days.length === 0;
    const noStart = !input.startTime;
    const noEnd = !input.endTime;
    if (noDays && noStart && noEnd) return "Choose the class days and times to continue";
    if (noDays) return "Choose at least one class day to continue";
    if (noStart && noEnd) return "Choose a start and end time to continue";
    if (noStart) return "Choose a start time to continue";
    if (noEnd) return "Choose an end time to continue";
    if (timeToMinutes(input.endTime) <= timeToMinutes(input.startTime)) return "The class has to end after it starts";
  }
  if (input.termMode === "new" && !input.termSkipped) {
    if (!input.termStart && !input.termEnd) return "Choose the term's first and last day, or skip them for now";
    if (!input.termStart) return "Choose the term's first day to continue";
    if (!input.termEnd) return "Choose the term's last day to continue";
    if (input.termEnd <= input.termStart) return "The term has to end after it starts";
  }
  return null;
}

/** "Aug 26 – Dec 15" (the year only when the two ends are in different years). */
export function termRangeLabel(start: string, end: string): string {
  const a = parseLocalDate(start);
  const b = parseLocalDate(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "";
  const sameYear = a.getFullYear() === b.getFullYear();
  const fmt = (date: Date) => date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(a)} – ${fmt(b)}`;
}

// ── Step 3: check the dates ───────────────────────────────────────────────────

/** "Fri, Oct 2", or with a time "Tue, Dec 15 at 12:00 PM". */
export function reviewDate(key: string, time?: string): string {
  const date = parseLocalDate(key);
  if (Number.isNaN(date.getTime())) return key;
  const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return time ? `${day} at ${formatTime(time)}` : day;
}

export type LookReason = "no-date" | "outside-term" | "in-break" | "guess";

type Doubt = Pick<DraftItem, "dueDate" | "dueTime" | "dateConfidence" | "dateSource" | "outOfRange" | "inBreak" | "problem">;

/** A stretch with no classes that exists FOR exams and final work ("Exam period", "Finals week"): a date in it is expected. */
const EXAM_PERIOD = /\b(exam|exams|examination|examinations|final|finals)\b/i;

export interface ReviewContext {
  /** The term's first and last day are known (confirmed in step 2, or already on file). */
  termKnown?: boolean;
}

/**
 * Why an item is under "Take a look", or null when there is nothing doubtful about its date:
 *  - a date the student set is theirs, whatever it falls on;
 *  - a date printed without a year is as good as printed once the term is known and the date falls inside it (the
 *    term fixes the year); without a term the year is a guess;
 *  - a date worked out from a week number is always worth a look.
 */
export function lookReasonOf(item: Doubt, ctx: ReviewContext = {}): LookReason | null {
  if (item.dueDate === null) return "no-date";
  if (item.dateConfidence === "user") return null;
  if (item.outOfRange) return "outside-term";
  if (item.inBreak && !EXAM_PERIOD.test(item.inBreak)) return "in-break";
  if (item.dateConfidence === "explicit") return null;
  if (item.dateSource === "year-inferred" && ctx.termKnown) return null;
  return "guess";
}

/** The line under a doubtful item's name: its date and what is doubtful about it, or why it has none. */
export function lookLine(item: Doubt): string {
  if (item.dueDate === null) {
    if (item.problem === "impossible-date") return "The syllabus gives a date that doesn't exist";
    if (item.problem === "unparseable-date") return "The date in the syllabus couldn't be read";
    if (item.problem === "needs-term-start") return "Placed by week number, which needs the term's first day";
    if (item.problem === "week-out-of-range") return "The week number doesn't fit this term";
    if (item.problem === "week-without-weekday") return "The syllabus gives a week, not a day";
    return "No date in the syllabus";
  }
  const date = reviewDate(item.dueDate, item.dueTime || undefined);
  if (item.outOfRange === "before-term") return `${date} · before the term starts`;
  if (item.outOfRange === "after-term") return `${date} · after the term ends`;
  if (item.inBreak && !EXAM_PERIOD.test(item.inBreak)) return `${date} · during ${item.inBreak}`;
  if (item.dateSource === "week") return `${date} · worked out from the week number`;
  if (item.dateSource === "year-inferred") return `${date}, ${item.dueDate.slice(0, 4)} · the syllabus gives no year`;
  return `${date} · a best guess`;
}

export interface ReviewBuckets {
  /** Doubtful dates first (by date), then the items with no date. */
  look: DraftItem[];
  /** Dated, upcoming, nothing doubtful: by date. */
  right: DraftItem[];
  /** Due before today: folded away, and left out unless the student ticks one. */
  past: DraftItem[];
}

const byDate = (a: DraftItem, b: DraftItem) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.name.localeCompare(b.name);

export function reviewBuckets(drafts: readonly DraftItem[], today: string, ctx: ReviewContext = {}): ReviewBuckets {
  const past = drafts.filter((d) => d.dueDate !== null && d.dueDate < today).sort(byDate);
  const upcoming = drafts.filter((d) => d.dueDate !== null && d.dueDate >= today);
  const undated = drafts.filter((d) => d.dueDate === null);
  return {
    look: [...upcoming.filter((d) => lookReasonOf(d, ctx) !== null).sort(byDate), ...undated],
    right: upcoming.filter((d) => lookReasonOf(d, ctx) === null).sort(byDate),
    past,
  };
}

/** How many items go into the plan: ticked and dated. */
export function plannedCount(drafts: readonly DraftItem[]): number {
  return drafts.filter((d) => d.selected && d.dueDate !== null).length;
}

/** "43 found. 33 will be planned, 8 are already past, 2 need a date." Every item is in exactly one of the counts. */
export function reviewSummary(drafts: readonly DraftItem[], today: string): string {
  const planned = plannedCount(drafts);
  const past = drafts.filter((d) => d.dueDate !== null && d.dueDate < today && !d.selected).length;
  const undated = drafts.filter((d) => d.dueDate === null).length;
  const unticked = drafts.filter((d) => d.dueDate !== null && d.dueDate >= today && !d.selected).length;
  const parts = [`${planned} will be planned`];
  if (past > 0) parts.push(`${past} ${past === 1 ? "is" : "are"} already past`);
  if (undated > 0) parts.push(`${undated} ${undated === 1 ? "needs" : "need"} a date`);
  if (unticked > 0) parts.push(`${unticked} left out`);
  return `${drafts.length} found. ${parts.join(", ")}.`;
}

/** The main button: "Plan 33 items", "Plan 1 item", or "Nothing to plan yet". */
export function planButtonLabel(planned: number): string {
  return planned > 0 ? `Plan ${count(planned, "item")}` : "Nothing to plan yet";
}
