/**
 * The Replan sheet and the preview of a change (components/replan-sheet.tsx, components/replan-preview-sheet.tsx), as
 * pure functions: which options Today offers and what each says, what the sheet opens on, the row that undoes the
 * last change, the question before a move that would miss a deadline, and the preview's rows and counts. The engine
 * stays where it is (lib/replan.ts, runReplan in lib/app-context.tsx); this is only what the two sheets SAY.
 */
import type { ReplanScope, TodayReplanMode } from "./app-context";
import { describeMoreTime, dueLabel } from "./plan-format";
import { undoAlsoRestores, type BlockRef, type DeferralAtRisk, type ReleasedRef, type ReplanDiff, type ReplanMove, type Slot } from "./replan";
import type { ReplanSnapshot } from "./types";
import { addDaysToKey, daysBetweenKeys, formatDateShort, formatTime, getDayLabel, parseLocalDate } from "./utils";
import { classOfTask, classShortName } from "./week-layout";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── The options ───────────────────────────────────────────────────────────────

export const REPLAN_SUB = "See what would move before anything changes.";
export const REPLAN_HINT = "Nothing changes until you apply it. You can undo it until your next change.";
/** Kept, quietly, at the foot of the sheet: the sheet is for the day that got away, not for every change. */
export const REPLAN_QUIET_NOTE = "Your plan already updates itself when something changes.";

/** A Today option the student can pick ("Use time up to bedtime" is a switch on the first, not an option). */
export type TodayChoice = Exclude<TodayReplanMode, "crunch_mode">;

export interface TodayFacts {
  /** Study sessions of a task still open today. */
  pendingStudy: number;
  /** Blocks today overlapping an event in a calendar. */
  calendarClashes: number;
  /** Blocks today inside a no-study zone. */
  zoneClashes: number;
}

export interface TodayOption {
  mode: TodayChoice;
  title: string;
  detail: string;
}

/**
 * What Today can do right now. "Fit the rest of today" is always there; an option that would do nothing is left
 * out, unless the sheet was opened for it (a notice on Today asked for exactly that).
 */
export function todayOptions(facts: TodayFacts, asked?: TodayReplanMode): TodayOption[] {
  const options: TodayOption[] = [{ mode: "protect_sleep", title: "Fit the rest of today", detail: "Reshuffle what's left of today within your normal hours" }];
  if (facts.pendingStudy > 0 || asked === "defer") {
    const n = facts.pendingStudy;
    options.push({ mode: "defer", title: "Move the rest of today to tomorrow", detail: `${n} unfinished study session${n === 1 ? " moves" : "s move"} to the next days; work due today goes to the time left before its deadline` });
  }
  if (facts.calendarClashes > 0 || asked === "calendar_conflicts") {
    const n = facts.calendarClashes;
    options.push({ mode: "calendar_conflicts", title: "Clear calendar conflicts", detail: `${n} block${n === 1 ? " overlaps" : "s overlap"} an event in your calendar: move ${n === 1 ? "it" : "them"} to the next free time` });
  }
  if (facts.zoneClashes > 0 || asked === "do_not_schedule") {
    const n = facts.zoneClashes;
    options.push({ mode: "do_not_schedule", title: "Clear no-study-zone sessions", detail: `${n} block${n === 1 ? " is" : "s are"} inside a no-study zone: move ${n === 1 ? "it" : "them"} after it` });
  }
  return options;
}

/** The option that is ticked: the one chosen while it is still offered, otherwise the first. */
export function chosenTodayMode(options: readonly TodayOption[], mode: TodayReplanMode): TodayChoice {
  return options.find((option) => option.mode === mode)?.mode ?? "protect_sleep";
}

/** What is asked of the planner: "Fit the rest of today" with the bedtime switch on is its crunch mode. */
export function todayRequestMode(chosen: TodayChoice, untilBedtime: boolean): TodayReplanMode {
  return chosen === "protect_sleep" && untilBedtime ? "crunch_mode" : chosen;
}

export const BEDTIME_SWITCH = { label: "Use time up to bedtime", detail: "Also uses the half hour before bedtime. Use it sparingly." } as const;
export const KEPT_SWITCH = { label: "Also move sessions I kept", detail: "Sessions you edited or started never move" } as const;

/** What a preset opens the sheet on: an option asked for by name is ticked, and crunch mode is the first with its switch on. */
export function presetChoice(preset: { scope: ReplanScope; mode?: TodayReplanMode }): { scope: ReplanScope; mode: TodayChoice; untilBedtime: boolean } {
  const crunch = preset.mode === "crunch_mode";
  return { scope: preset.scope, mode: crunch || !preset.mode ? "protect_sleep" : (preset.mode as TodayChoice), untilBedtime: crunch };
}

/** Under Today's options: "3 blocks left today". */
export function blocksLeftLine(remaining: number): string {
  return `${count(remaining, "block")} left today`;
}

const shortDay = (key: string) => {
  const date = parseLocalDate(key);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** This week's one option, with the week it means ("Oct 5 to Oct 11"). */
export function weekOption(weekStart: string): { title: string; range: string; detail: string } {
  return {
    title: "Replan this week",
    range: `${shortDay(weekStart)} to ${shortDay(addDaysToKey(weekStart, 6))}`,
    detail: "Start the week over: its unfinished study sessions are placed again, consistently with the rest of the semester. Started and finished sessions, and those set to never move, stay.",
  };
}

/** The semester's option: named "Catch up" when the student is behind. */
export function semesterOption(behind: boolean): { title: string; detail: string; reason: string } {
  return {
    title: behind ? "Catch up: replan the semester" : "Replan the semester",
    detail: "Missed sessions are marked as missed and every week to the end of the term is refit around what's left.",
    // The label the change carries in the Undo bar (ReplanRequest.reason).
    reason: behind ? "Catch up" : "Replan the semester",
  };
}

/** Over the semester's option while the student is behind: one line of the plan status. */
export function behindLine(summary: string): string {
  return `Behind plan · ${summary}`;
}

/** The row that undoes the last change, while there is one to undo. */
export function undoRow(lastChange: ReplanSnapshot | undefined): { label: string; detail: string; accessibilityLabel: string } | null {
  if (!lastChange) return null;
  const what = `${lastChange.label}${lastChange.summary ? ` · ${lastChange.summary}` : ""}`;
  return { label: "Undo last change", detail: [what, undoAlsoRestores(lastChange)].filter(Boolean).join(". "), accessibilityLabel: `Undo last change: ${lastChange.label}` };
}

// ── "Tomorrow is too late for this" ───────────────────────────────────────────

export const DEFERRAL_COPY = {
  label: "Deadline at risk",
  title: "Tomorrow is too late for this",
  keep: "Keep it",
  move: "Move anyway",
  hint: "Move anyway shows the preview first. Nothing is dropped silently.",
} as const;

export interface DeferralRow {
  key: string;
  name: string;
  detail: string;
  /** A quiz or exam (it cannot be done late) rather than homework. */
  assessment: boolean;
  spoken: string;
}

/** The work a move to tomorrow would push past its deadline, one row each. */
export function deferralRows(atRisk: readonly DeferralAtRisk[], today: string): DeferralRow[] {
  return atRisk.map((item) => {
    const due = dueLabel(item.dueDate, today);
    const needs = item.missingMinutes > 0 ? describeMoreTime(item.missingMinutes) : "";
    return {
      key: item.taskId,
      name: item.taskName,
      detail: `${item.assessment ? "Quiz / exam" : "Due"} ${due}${needs ? ` · needs ${needs}` : ""}`,
      assessment: item.assessment,
      spoken: `${item.taskName}, ${due}. ${needs ? `Needs ${needs}` : ""}`,
    };
  });
}

// ── The preview ───────────────────────────────────────────────────────────────

export const PREVIEW_TITLE: Record<ReplanScope, string> = {
  today: "How does today look?",
  week: "How does this week look?",
  semester: "Replan your semester",
};
export const PREVIEW_UNDO_HINT = "You can undo this until your next change.";

/** The semester's "Also move sessions I kept" is offered again in the preview when work still does not fit, or once it is on. */
export function previewOffersKeptSwitch(scope: ReplanScope, shortfalls: number, moveAccepted: boolean): boolean {
  return scope === "semester" && (shortfalls > 0 || moveAccepted);
}

type SlotLike = Pick<Slot, "date" | "startTime" | "endTime">;

/** The full slot, for the spoken form. */
const slotText = (slot: SlotLike) => `${formatDateShort(slot.date)}, ${formatTime(slot.startTime)}–${formatTime(slot.endTime)}`;

/**
 * A slot as a row shows it: "Thu 3:00 PM–4:00 PM" inside the next week, "Oct 23 3:00 PM–4:00 PM" beyond it. The end
 * time is there so a change that only moves the end is visible.
 */
export function shortSlot(slot: SlotLike, today: string): string {
  const days = daysBetweenKeys(today, slot.date);
  const day = Number.isFinite(days) && days >= 0 && days <= 6 ? getDayLabel(slot.date) : shortDay(slot.date);
  return `${day} ${formatTime(slot.startTime)}–${formatTime(slot.endTime)}`;
}

export type PreviewRowKind = "moved" | "added" | "removed" | "released" | "missed" | "unplaced";

export interface PreviewRow {
  key: string;
  kind: PreviewRowKind;
  /** The task's name, or the block's own title when it belongs to no task. */
  name: string;
  taskId?: string;
  /** Struck through: the slot it leaves. */
  from?: string;
  /** Plain: the slot of a session that stays in the record (a missed one), or "New" for one that is added. */
  at?: string;
  /** Strong, after the arrow: the slot it gets. */
  to?: string;
  /** What happens to it, in a word, when it gets no slot: "Removed", "Released", "Marked as missed", "Won't fit". */
  outcome?: string;
  /** Why: gold for a session the student had confirmed and the change released, quiet for a session that fits nowhere. */
  reason?: string;
  reasonTone?: "gold" | "quiet";
  /** A quiet extra ("Missed earlier"). */
  note?: string;
  /** The whole row for VoiceOver. */
  spoken: string;
}

interface Line {
  key: string;
  date: string;
  kind: "moved" | "added" | "removed";
  name: string;
  taskId?: string;
  from?: Slot;
  to: SlotLike;
  note?: string;
}

const KIND_WORD: Record<Line["kind"], string> = { moved: "Moved", added: "Added", removed: "Removed" };

const sameSlot = (a: SlotLike, b: SlotLike) => a.date === b.date && a.startTime === b.startTime && a.endTime === b.endTime;

function linesOf(task: { taskId?: string; taskName: string; added: BlockRef[]; removed: BlockRef[]; moved: ReplanMove[] }): Line[] {
  const group = task.taskId ? task.taskName : undefined;
  const lines: Line[] = [
    ...task.moved.map((move): Line => ({ key: `m-${move.id}`, date: move.to.date, kind: "moved", name: group ?? move.title, taskId: task.taskId, from: move.from, to: move.to, note: move.note })),
    ...task.added.map((ref): Line => ({ key: `a-${ref.id}`, date: ref.date, kind: "added", name: group ?? ref.title, taskId: task.taskId, to: ref })),
    ...task.removed.map((ref): Line => ({ key: `r-${ref.id}`, date: ref.date, kind: "removed", name: group ?? ref.title, taskId: task.taskId, to: ref })),
  ];
  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/**
 * Every row of the preview, in the order shown: per task what moves, is added and is removed (by day); then confirmed
 * sessions that were released and are not one of those rows; then past sessions recorded as missed; then sessions
 * that fit nowhere today. A moved or removed row that was a confirmed session carries why it was released.
 */
export function previewRows(diff: ReplanDiff, unplaced: readonly { block: BlockRef; reason: string }[], today: string): PreviewRow[] {
  const released: ReleasedRef[] = [...(diff.released ?? [])];
  const rows: PreviewRow[] = [];

  for (const line of diff.byTask.filter((task) => task.added.length + task.removed.length + task.moved.length > 0).flatMap(linesOf)) {
    // The slot a released session had: where a moved one came from, or where a removed one was.
    const left = line.kind === "moved" ? line.from : line.kind === "removed" ? line.to : undefined;
    const index = left ? released.findIndex((ref) => sameSlot(ref, left)) : -1;
    const why = index >= 0 ? released.splice(index, 1)[0]!.detail : undefined;
    const text = line.kind === "moved" && line.from ? `${slotText(line.from)} to ${slotText(line.to)}` : slotText(line.to);
    const row: PreviewRow = { key: line.key, kind: line.kind, name: line.name, taskId: line.taskId, spoken: `${line.name}. ${KIND_WORD[line.kind]}: ${text}${line.note ? `. ${line.note}` : ""}${why ? `. Released: ${why}` : ""}` };
    if (line.kind === "moved" && line.from) {
      row.from = shortSlot(line.from, today);
      row.to = shortSlot(line.to, today);
    } else if (line.kind === "added") {
      row.at = "New";
      row.to = shortSlot(line.to, today);
    } else {
      row.from = shortSlot(line.to, today);
      row.outcome = "Removed";
    }
    if (why) {
      row.reason = why;
      row.reasonTone = "gold";
    }
    if (line.note) row.note = line.note;
    rows.push(row);
  }

  for (const ref of released) {
    const name = ref.taskName ?? ref.title;
    rows.push({ key: `released-${ref.id}`, kind: "released", name, taskId: ref.taskId, from: shortSlot(ref, today), outcome: "Released", reason: ref.detail, reasonTone: "gold", spoken: `${name}. Released: ${ref.detail}. Was ${slotText(ref)}` });
  }
  for (const ref of diff.markedMissed) {
    const name = ref.taskName ?? ref.title;
    rows.push({ key: `missed-${ref.id}`, kind: "missed", name, taskId: ref.taskId, at: shortSlot(ref, today), outcome: "Marked as missed", spoken: `${name}. Marked as missed: ${slotText(ref)}` });
  }
  for (const { block, reason } of unplaced) {
    rows.push({ key: `unplaced-${block.id}`, kind: "unplaced", name: block.title, taskId: block.taskId, outcome: "Won't fit", reason, reasonTone: "quiet", spoken: `${block.title}. Won't fit today. ${reason}` });
  }
  return rows;
}

/** Nothing to show and nothing to warn about: the preview then says only "Nothing to change." */
export function previewIsEmpty(diff: Pick<ReplanDiff, "changed">, shortfalls: number, unplaced: number): boolean {
  return !diff.changed && shortfalls === 0 && unplaced === 0;
}

/** The counts over the buttons: "2 blocks will move, 1 added.", or that the plan changes, or that nothing does. */
export function previewHeadline(diff: Pick<ReplanDiff, "moved" | "added" | "removed" | "changed">): string {
  const counts = [
    diff.moved.length > 0 ? `${count(diff.moved.length, "block")} will move` : null,
    diff.added.length > 0 ? `${diff.added.length} added` : null,
    diff.removed.length > 0 ? `${diff.removed.length} removed` : null,
  ].filter(Boolean);
  return counts.length > 0 ? `${counts.join(", ")}.` : diff.changed ? "Your plan will change." : "Nothing to change.";
}

/** Sessions and events that keep their slot, summed over the tasks ("3 other sessions stay where they are"); "" for none. */
export function unchangedLine(diff: Pick<ReplanDiff, "byTask">): string {
  const unchanged = diff.byTask.reduce((sum, task) => sum + task.unchanged, 0);
  if (unchanged <= 0) return "";
  return `${count(unchanged, "other session")} ${unchanged === 1 ? "stays where it is" : "stay where they are"}`;
}

export const STILL_WONT_FIT = "Still won't fit";

/** The lines of the red box: work that does not fit before its deadline even after this change. */
export function shortfallLines(shortfalls: readonly { taskId: string; taskName: string; dueDate: string; missingMinutes: number }[], today: string): { key: string; text: string }[] {
  return shortfalls.map((shortfall) => ({ key: shortfall.taskId, text: `${shortfall.taskName}: needs ${describeMoreTime(shortfall.missingMinutes)} before ${dueLabel(shortfall.dueDate, today)}` }));
}

/**
 * The class of a row, as its tag and colour, where the plan knows it: the task's class (by id, else by name), or the
 * class name the task carries when that class is not in the list. Null for a block of no task, and for "General".
 */
export function courseTagOf(
  taskId: string | undefined,
  tasks: readonly { id: string; courseId?: string; courseName?: string }[],
  classes: readonly { id: string; name: string; shortName?: string; color?: string }[],
): { label: string; color?: string } | null {
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : undefined;
  if (!task) return null;
  const cls = classOfTask(task, classes);
  const name = cls?.name ?? (task.courseName && task.courseName !== "General" ? task.courseName : "");
  if (!name) return null;
  return { label: classShortName(cls, name) || name, color: cls?.color };
}
