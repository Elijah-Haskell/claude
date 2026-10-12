/**
 * The course site link (app/course-feeds.tsx), as pure functions: what a linked calendar's row says, the line over
 * "Add link", and what the screen says after adding or checking a link (a note on the page, where an alert used to
 * be). The sentences the screen has always promised are kept here word for word.
 */
import type { CourseFeed } from "./lms-feed-store";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the calendar link is on each course site. */
export const COURSE_SITES: readonly { name: string; steps: string }[] = [
  { name: "Canvas", steps: "Calendar, then Calendar Feed (bottom of the right sidebar). Copy the link." },
  { name: "Moodle", steps: "Calendar, Import or export calendars, Export calendar, Get calendar URL." },
  { name: "Blackboard", steps: "Calendar, the settings gear, Share Calendar. Copy the link." },
  { name: "Brightspace (D2L)", steps: "Calendar, Subscribe. Copy the link." },
];

export const COURSE_LINK_COPY = {
  sub: "When a due date moves on your course site, your plan moves too.",
  field: "Calendar link from your course site",
  placeholder: "Paste the link",
  /** The lock note. */
  privacy: "The link is private to you. It stays on this phone and is fetched straight from your school, never through Trajectory's server.",
  /** What a link brings in. */
  scope: "Only assignments, quizzes and exams are imported (not lectures or office hours), from today on. Each keeps its course and due time.",
  removeQuestion: "Remove this link? Deadlines it already added stay in your tasks; they just stop following the course site.",
} as const;

/** "just now", "5 min ago", "3 h ago", then the day ("Oct 5"). "" when it was never checked. */
export function checkedAgo(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((now.getTime() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The quiet line of a linked calendar: "Checked 5 min ago · 12 upcoming deadlines", or what went wrong the last
 * time it was checked (`failed`: the line is drawn in gold).
 */
export function feedStatus(feed: Pick<CourseFeed, "lastFetchedAt" | "lastStatus" | "lastError" | "lastCount">, now: Date): { line: string; failed: boolean } {
  if (feed.lastStatus === "error") return { line: feed.lastError ?? "The last check failed.", failed: true };
  const ago = checkedAgo(feed.lastFetchedAt, now);
  if (!ago) return { line: "Not checked yet", failed: false };
  const found = feed.lastCount !== undefined ? ` · ${count(feed.lastCount, "upcoming deadline")}` : "";
  return { line: `Checked ${ago}${found}`, failed: false };
}

/** What a check brought in. */
export function feedChangeSummary(added: number, updated: number): string {
  if (added === 0 && updated === 0) return "Everything is already up to date.";
  const parts: string[] = [];
  if (added > 0) parts.push(`${count(added, "new deadline")} added`);
  if (updated > 0) parts.push(`${count(updated, "due date")} updated`);
  return `${parts.join(" and ")}. Your plan is being rewritten around them.`;
}

/** The line over "Add link" while it cannot act; null when it can. */
export function addLinkHint(url: string): string | null {
  return url.trim().length === 0 ? "Paste the link first" : null;
}

export interface LinkNote {
  tone: "green" | "red";
  text: string;
}
interface CheckResult {
  added: number;
  updated: number;
  error?: string;
}

/** The link was not accepted (not a link, already added, the course site refused it): nothing was saved. */
export function linkRefusedNote(message: string): LinkNote {
  return { tone: "red", text: `Could not add this link. ${message}` };
}

/** The link was saved, and this is what its first check brought in, or why that check failed. */
export function linkAddedNote(result: CheckResult): LinkNote {
  if (result.error) return { tone: "red", text: `The link was added, but checking it failed. ${result.error}` };
  return { tone: "green", text: `Link added. ${feedChangeSummary(result.added, result.updated)}` };
}

/** "Check now" on a linked calendar: what it brought in, or why it failed. */
export function linkCheckedNote(result: CheckResult): LinkNote {
  if (result.error) return { tone: "red", text: result.error };
  return { tone: "green", text: feedChangeSummary(result.added, result.updated) };
}
