/**
 * The live import's list, as pure rules (components/syllabus/live-list.tsx and reading-step.tsx): while a syllabus is
 * read, the waiting screen fills in with the deadlines the server has found so far. The server's side of it, and
 * what a screen may rely on, is docs/live-import.md.
 *
 * The rules that keep it honest:
 *  - every row is one the server sent (JobPollProgress.items). Nothing is made up to fill the screen;
 *  - the list is a preview. It is labelled "found so far", its rows cannot be tapped, and none of it is carried
 *    into the review or the plan: those are built from the reading's result alone;
 *  - a server from before the live import sends no list at all, and the screen is then the one it was.
 */
import { LIVE_ITEMS_MAX, type LiveItem } from "../shared/live-import";
import type { JobPollProgress } from "../engine/poll-job";
import { parseLocalDate } from "../engine/utils";

export type { LiveItem };

type Stage = JobPollProgress["stage"];

// ── Is there a list at all ────────────────────────────────────────────────────

/**
 * Which waiting screen a reading gets. "unknown": the server has not said where the reading is yet. "live": it
 * sends the list. "legacy": it reported a stage without a list, so it is a server from before the live import.
 */
export type LiveMode = "unknown" | "live" | "legacy";

/**
 * The mode after one more answer. A server with the live import sends `items` on every report (an empty list at
 * first), so a report without it is an older server. An answer with no progress at all says nothing, and a reading
 * that has shown its list once keeps it whatever a later answer leaves out.
 */
export function liveModeAfter(mode: LiveMode, progress: JobPollProgress | null | undefined): LiveMode {
  if (!progress) return mode;
  if (Array.isArray(progress.items)) return "live";
  return mode === "live" ? "live" : "legacy";
}

/**
 * Whether the wait shows the list's screen. A reading that runs as a job (a file or photos) starts on it, before the
 * first answer, so that on a server with the live import (every server this build is released against) the screen
 * does not change shape a second into every reading. Until that answer the frame promises nothing about rows
 * (liveEmptyLine): "nothing found yet" and "the reading is starting" are true on any server. A server that turns
 * out not to send a list gets the older screen from its first answer on. Pasted text is one plain request with no
 * progress, so it never has a list.
 */
export function showsLiveList(input: { isJob: boolean; mode: LiveMode }): boolean {
  return input.isJob && input.mode !== "legacy";
}

// ── The rows ──────────────────────────────────────────────────────────────────

const KINDS = new Set(["assignment", "exam", "quiz", "project", "reading", "other"]);

/**
 * The list one answer carries, or null when it carries none (no progress, or an older server). Rows keep the
 * position the server gave them; a row is only tidied (a kind the app does not know reads as "other", a date that
 * is not a day reads as no date), never dropped, and the list is never longer than the server's own limit.
 */
export function liveItemsOf(progress: JobPollProgress | null | undefined): LiveItem[] | null {
  const items = progress?.items;
  if (!Array.isArray(items)) return null;
  return items.slice(0, LIVE_ITEMS_MAX).map((item) => {
    const raw = (item ?? {}) as Partial<LiveItem>;
    return {
      name: typeof raw.name === "string" ? raw.name.trim() : "",
      type: typeof raw.type === "string" && KINDS.has(raw.type) ? raw.type : "other",
      date: typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null,
    };
  });
}

const sameRow = (a: LiveItem | undefined, b: LiveItem): boolean => a !== undefined && a.name === b.name && a.type === b.type && a.date === b.date;

/**
 * The list on screen after one more answer: it never gets shorter. A longer list (or one as long) replaces the one
 * shown, so a row the server corrected is corrected in place; an answer with no list, or a shorter one, changes
 * nothing. That covers a dropped connection, a second model that has found less so far, and a late answer that
 * arrives out of order.
 *
 * A row that has not changed stays the very same object, and an answer that changes nothing hands back the very
 * same list: the screen then draws only the rows that are new (the server sends the whole list every second).
 */
export function mergeLiveItems(shown: readonly LiveItem[] | null, incoming: readonly LiveItem[] | null): readonly LiveItem[] | null {
  if (!incoming) return shown;
  if (shown && incoming.length < shown.length) return shown;
  const rows = incoming.map((row, index) => (sameRow(shown?.[index], row) ? shown![index]! : row));
  return shown && rows.length === shown.length && rows.every((row, index) => row === shown[index]) ? shown : rows;
}

/** The course's name as the model has written it so far; once shown it stays until a later answer changes it. */
export function liveCourseName(shown: string | null, progress: JobPollProgress | null | undefined): string | null {
  const next = typeof progress?.courseName === "string" ? progress.courseName.trim() : "";
  return next || shown;
}

const KIND_LABEL: Record<LiveItem["type"], string> = {
  exam: "Exam",
  quiz: "Quiz",
  assignment: "Assignment",
  project: "Project",
  reading: "Reading",
  other: "Other",
};

/** "Quiz", "Assignment": what kind of thing a row is. */
export function liveKindLabel(type: LiveItem["type"]): string {
  return KIND_LABEL[type] ?? KIND_LABEL.other;
}

/** Exams and quizzes carry the gold flag, as they do in "Check the dates" and on Week's due row. */
export function liveIsTest(item: LiveItem): boolean {
  return item.type === "exam" || item.type === "quiz";
}

/** A row's name. One the model left empty shows as its kind ("Quiz"); a name is never made up. */
export function liveRowName(item: LiveItem): string {
  return item.name || liveKindLabel(item.type);
}

/** What stands where a date would, for an item the syllabus gives no date for yet. */
export const LIVE_NO_DATE = "No date yet";

/** "Sep 2" on a row (the year too when it is not `today`'s year), or "No date yet". Never a gap. */
export function liveDateLabel(date: string | null, today?: string): string {
  if (!date) return LIVE_NO_DATE;
  const day = parseLocalDate(date);
  if (Number.isNaN(day.getTime())) return LIVE_NO_DATE;
  const sameYear = !today || date.slice(0, 4) === today.slice(0, 4);
  return day.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Wed": the weekday under a row's date, or nothing for an item without a date. */
export function liveWeekday(date: string | null): string {
  if (!date) return "";
  const day = parseLocalDate(date);
  return Number.isNaN(day.getTime()) ? "" : day.toLocaleDateString("en-US", { weekday: "short" });
}

/** A row read aloud: "Quiz 1, quiz, Wednesday, September 2", "Term paper, project, no date yet". */
export function liveRowSpoken(item: LiveItem): string {
  const day = item.date ? parseLocalDate(item.date) : null;
  const when = day && !Number.isNaN(day.getTime()) ? day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "no date yet";
  const name = liveRowName(item);
  const kind = liveKindLabel(item.type).toLowerCase();
  return name.toLowerCase() === kind ? `${name}, ${when}` : `${name}, ${kind}, ${when}`;
}

// ── The words around the list ─────────────────────────────────────────────────

/**
 * The label over the list: how many rows are on screen. Always "so far", in every stage: the list is a preview. More
 * can come, the result can have fewer rows than the list (a second model that found less; the list keeps the longer
 * preview), and the list stops at the server's limit while the result does not.
 *
 * `asking`: a reading that was picked up again, before the server's first answer. It may well have found things
 * already, so the label does not say "nothing found yet"; it says the app is asking.
 */
export function liveCountLabel(input: { count: number; asking?: boolean }): string {
  const { count } = input;
  if (count <= 0) return input.asking ? "Checking what was found" : "Nothing found yet";
  return `${count} found so far`;
}

/** Whether the list has reached the most rows the server sends; the reading's result is not cut to it. */
export function liveListIsFull(count: number): boolean {
  return count >= LIVE_ITEMS_MAX;
}

/** The line at the end of a full list. */
export const LIVE_FULL_NOTE = `Only the first ${LIVE_ITEMS_MAX} are shown while it reads. The next step has everything it found.`;

export interface LiveStatus {
  /** What the reading is doing now. */
  title: string;
  /** The line under it: why, what comes next, or how long it usually takes. */
  sub: string | null;
}

/**
 * The status line over the list: the stage the server reports, in words. `expectation` is the clock's own line
 * ("Usually 1 to 3 minutes", lib/syllabus-review.ts readingExpectation); it is shown where a stage has nothing more
 * to say. A dropped connection says so, and the rows already shown stay.
 */
export function liveStatus(input: { stage?: Stage | null; reconnecting?: boolean; expectation?: string | null }): LiveStatus {
  const title =
    input.stage === "reading-more"
      ? "Reading the rest"
      : input.stage === "second-look"
        ? "Taking a slower second look"
        : input.stage === "finishing"
          ? "Finishing up"
          : "Finding deadlines";
  if (input.reconnecting) return { title, sub: "The connection dropped. Reconnecting…" };
  if (input.stage === "reading-more") return { title, sub: "The first pass stopped early." };
  if (input.stage === "second-look") return { title, sub: "The first read wasn't usable." };
  if (input.stage === "finishing") return { title, sub: "Saving the text. You check the dates next." };
  return { title, sub: input.expectation ?? null };
}

/**
 * That the app can be left while a file or photos are read, in one line: on the list's screen every line above and
 * below the list is a row less of it on a small iPhone. (The wait without a list says it in full.)
 */
export const LIVE_LEAVE_NOTE = "You can leave the app. It keeps reading.";

/**
 * What the empty list says. Before the server's first answer (`answered: false`) it only says the reading is
 * starting: that rows will appear one by one is not known yet (an older server sends none). A second look does not
 * report as it goes (the server says so), so it is not promised that dates will appear one by one either.
 */
export function liveEmptyLine(stage?: Stage | null, options: { asking?: boolean; answered?: boolean } = {}): string {
  if (options.asking) return "This reading was already under way. Asking the server what it has found so far.";
  if (options.answered === false) return "The reading is starting.";
  if (stage === "second-look") return "This read reports its dates together, when it is done.";
  if (stage === "finishing") return "The dates are on the next step.";
  return "Each deadline appears here as it is read.";
}

// ── Rows flowing in ───────────────────────────────────────────────────────────

/** The shortest pause between two rows landing on screen (many rows are waiting). */
export const LIVE_STAGGER_MS = 130;

/** The longest pause between two rows landing (one or two are waiting). */
export const LIVE_STAGGER_SLOW_MS = 450;

/** Rows that are waiting are spread over about this long: a little under the time until the next answer. */
export const LIVE_PACE_WINDOW_MS = 900;

/**
 * The pause before the next row lands, given how many rows are known and not yet on screen. The rows of an answer are
 * spread over the second until the next answer instead of landing in a clump, so the list reads as one steady flow
 * at whatever rate the model writes: about two rows a second on a real syllabus (docs/live-import.md), faster on a
 * long one. The more rows are waiting, the shorter the pause, so the list never falls far behind.
 */
export function revealDelay(waiting: number): number {
  return Math.max(LIVE_STAGGER_MS, Math.min(LIVE_STAGGER_SLOW_MS, Math.round(LIVE_PACE_WINDOW_MS / Math.max(1, waiting))));
}

/** The most rows of one answer that land one after another; the ones before them are simply there. */
export const LIVE_STAGGER_MAX = 8;

/**
 * How the rows of a new answer come on screen. The server's answers bring a handful of rows at a time; they land
 * one after another so the list reads as a flow. When many arrive at once (coming back to a reading that is well
 * under way, or a slow connection catching up), all but the last few are simply there: forty rows are not replayed.
 * `instant` (Reduce Motion, or the first answer of a reading that was picked up again) shows everything at once.
 */
export function revealPlan(shown: number, total: number, options: { instant?: boolean } = {}): { jumpTo: number; staggered: number } {
  const have = Math.max(0, Math.min(shown, total));
  if (options.instant) return { jumpTo: total, staggered: 0 };
  const staggered = Math.min(total - have, LIVE_STAGGER_MAX);
  return { jumpTo: total - staggered, staggered };
}

export interface RevealStep {
  /** How many rows are on screen after this step. */
  shown: number;
  /** The row that lands with this step and eases in (-1: the rows of this step are simply there). */
  fresh: number;
  /** How long to wait before the step. */
  delayMs: number;
  /** Several rows at once, without moving: the list is then placed at its end, not scrolled there. */
  jump: boolean;
}

/**
 * The next thing the list does with `shown` rows on screen and `total` rows known, or null when it has caught up.
 * Either the rows that need no flow appear at once (a jump), or one more row lands after the pause between rows.
 */
export function revealStep(shown: number, total: number, options: { instant?: boolean } = {}): RevealStep | null {
  const have = Math.max(0, Math.min(shown, total));
  if (have >= total) return null;
  const plan = revealPlan(have, total, options);
  if (plan.jumpTo > have) return { shown: plan.jumpTo, fresh: -1, delayMs: 0, jump: true };
  return { shown: have + 1, fresh: have, delayMs: revealDelay(total - have), jump: false };
}

// ── Following the newest row ──────────────────────────────────────────────────

/** How close to the end still counts as "at the newest row". */
export const LIVE_FOLLOW_SLOP = 28;

/**
 * Whether the list keeps scrolling to the newest row. It does until the student moves it away from the end to look
 * at something; then it stays where they left it, and follows again once they are back at the end. `byHand`: a
 * finger is on the list, so any position away from the end is theirs, however slowly they got there. Without a
 * finger (the list coasting after a flick, a mouse wheel in the browser), moving up is the student: scrolling done
 * by the list itself only ever moves down.
 */
export function followAfterScroll(input: { following: boolean; offsetY: number; lastOffsetY: number; distanceFromEnd: number; byHand?: boolean }): boolean {
  if (input.distanceFromEnd <= LIVE_FOLLOW_SLOP) return true;
  if (input.byHand) return false;
  if (input.offsetY < input.lastOffsetY - 4) return false;
  return input.following;
}

/**
 * Whether the list scrolls itself to a row that has just landed. Not while a finger is on it, and not under a
 * screen reader: VoiceOver's place in the list is the student's, and the count is spoken instead.
 */
export function scrollsToNewest(input: { following: boolean; dragging: boolean; screenReader: boolean }): boolean {
  return input.following && !input.dragging && !input.screenReader;
}

// ── Said aloud ────────────────────────────────────────────────────────────────

/** The least time between two spoken counts while rows arrive. */
export const LIVE_ANNOUNCE_EVERY_MS = 8_000;

/**
 * Whether VoiceOver is told the count now. Not for every row: the first rows, then at most every few seconds while
 * the count grows, and once more when the reading is finishing and its last rows have all landed (`settled`; the
 * last rows and that stage arrive in the same answer, so without it every one of them would be spoken).
 */
export function shouldAnnounceCount(input: { count: number; lastCount: number; sinceLastMs: number; finishing?: boolean; settled?: boolean }): boolean {
  if (input.count <= 0 || input.count === input.lastCount) return false;
  if (input.lastCount === 0) return true;
  if (input.finishing && input.settled) return true;
  return input.sinceLastMs >= LIVE_ANNOUNCE_EVERY_MS;
}

/** "12 found so far." for VoiceOver. */
export function liveCountSpoken(count: number): string {
  return `${liveCountLabel({ count })}.`;
}
