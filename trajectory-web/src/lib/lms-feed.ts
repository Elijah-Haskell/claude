/**
 * Canvas / LMS calendar feed -> tasks (pure; lib/lms-feed-store.ts does the fetching and storage).
 *
 * Canvas (and Blackboard, Moodle, D2L, Schoology...) publish a private iCalendar feed of every assignment and quiz
 * with its current due date. The student pastes that link once; the device fetches it (no server involved) and
 * keeps the tasks in step: new assignments are added, and when a professor moves a due date the task moves too
 * (the normal replan then rewrites the plan). Each feed event is linked to its task by the event UID, so repeated
 * refreshes never duplicate; a task the student deleted stays deleted.
 */
import { findBestClassMatch } from "../engine/course-matcher";
import { parseIcsEvents, type IcsEvent } from "../engine/ics";
import { classifyTaskKind } from "../engine/task-kind";
import type { ClassBlock, Task, TaskKind } from "../engine/types";

export interface FeedItem {
  /** The feed event's UID (stable across refreshes). */
  uid: string;
  title: string;
  /** Course label from the feed ("[CHEM 101-001]" suffix, or CATEGORIES); may be empty. */
  courseName: string;
  dueDate: string;
  dueTime?: string;
  url?: string;
  kind: TaskKind;
}

/** uid -> task id, or FEED_ITEM_DISMISSED when the student deleted the task (never re-added). */
export type FeedLinks = Record<string, string>;
export const FEED_ITEM_DISMISSED = "__dismissed__";

/**
 * "webcal://..." -> "https://...". Returns null for anything that is not an http(s)/webcal URL.
 * A plain "http://" link is upgraded to "https://": iOS blocks plain-http downloads by default, which would
 * otherwise fail later with a misleading "Could not reach the course site" error, and every LMS that publishes
 * these feeds also serves them over https.
 */
export function normalizeFeedUrl(input: string): string | null {
  const trimmed = input.trim().replace(/^<|>$/g, "");
  if (!trimmed) return null;
  const withScheme = /^webcals?:\/\//i.test(trimmed) ? trimmed.replace(/^webcals?:\/\//i, "https://") : trimmed;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

/** A short, non-secret label for a feed URL (its host), for lists. The full URL is a private link. */
export function feedLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Calendar feed";
  }
}

const DEADLINE_WORDS = /\b(assignment|homework|hw\s?\d|problem set|pset|quiz|exam|midterm|final|test|project|paper|essay|lab|report|due|submission|submit|discussion|reflection|response|reading|worksheet|presentation|portfolio|draft|journal)\b/i;
const NOT_DEADLINES = /\b(office hours?|lecture|class meeting|recitation|no class|holiday|break|zoom meeting)\b/i;

/** Whether a feed event is a deadline (an assignment / quiz / exam), not a meeting or a note. */
export function isDeadlineEvent(event: IcsEvent): boolean {
  if (event.status === "CANCELLED") return false;
  if (/assignment|quiz|assessment|submission/i.test(event.uid)) return true; // Canvas: "event-assignment-123"
  if (NOT_DEADLINES.test(event.summary) && !/\bdue\b/i.test(event.summary)) return false;
  return DEADLINE_WORDS.test(event.summary) || /\bis due\b|\bdue\b/i.test(event.description ?? "");
}

/** "Homework 3 [CHEM 101-001]" -> { title: "Homework 3", course: "CHEM 101-001" }. */
export function splitCourseSuffix(summary: string): { title: string; course: string } {
  const match = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(summary);
  if (match && match[1]!.trim()) return { title: match[1]!.trim(), course: match[2]!.trim() };
  return { title: summary.trim(), course: "" };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The deadlines in a feed document, from today on. Canvas' "11:59 PM" deadlines arrive as UTC times and are
 * converted to the device's local time; all-day events become date-only tasks. `skipped` counts events that were
 * not deadlines or already past.
 */
export function feedItemsFromIcs(text: string, opts: { now: Date }): { items: FeedItem[]; skipped: number; total: number } {
  const events = parseIcsEvents(text);
  const todayKey = dateKey(opts.now);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const event of events) {
    // A deadline at exactly midnight means "by the end of the previous day".
    let dueDate = event.start.date;
    let dueTime = event.start.allDay ? undefined : event.start.time;
    if (dueTime === "00:00") {
      const [y, m, d] = dueDate.split("-").map(Number);
      dueDate = dateKey(new Date(y!, m! - 1, d! - 1));
      dueTime = undefined;
    }
    if (!isDeadlineEvent(event) || dueDate < todayKey || seen.has(event.uid)) {
      skipped++;
      continue;
    }
    seen.add(event.uid);
    const { title, course } = splitCourseSuffix(event.summary);
    items.push({
      uid: event.uid,
      title,
      courseName: course || event.categories[0] || "",
      dueDate,
      dueTime,
      url: event.url,
      kind: classifyTaskKind({ name: title, kind: undefined }),
    });
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  return { items, skipped, total: events.length };
}

const MINUTES_BY_KIND: Record<TaskKind, number> = {
  exam: 240,
  quiz: 60,
  project: 240,
  reading: 45,
  assignment: 90,
  other: 60,
};

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs(Date.UTC(ay!, am! - 1, ad!) - Date.UTC(by!, bm! - 1, bd!)) / 86_400_000;
}

export interface FeedImportResult {
  add: Task[];
  update: Task[];
  links: FeedLinks;
  /** Feed items already in step with their task. */
  unchanged: number;
}

/**
 * Pure: what applying `items` to the student's tasks means. New feed deadlines become tasks (linked to a matching
 * class when one is recognised); a deadline that already exists — linked earlier, or the same assignment imported
 * from the syllabus — is linked and its due date / time / name follow the feed. Finished and deleted tasks are left
 * alone. The caller dispatches ADD_TASK for `add`, UPDATE_TASK for `update`, and stores `links`.
 */
export function importFeedItems(
  state: { tasks: readonly Task[]; classes: readonly ClassBlock[] },
  items: readonly FeedItem[],
  links: FeedLinks,
  opts: { now: Date; makeId: () => string; sourceLabel?: string },
): FeedImportResult {
  const nextLinks: FeedLinks = { ...links };
  const add: Task[] = [];
  const update: Task[] = [];
  let unchanged = 0;
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const linkedTaskIds = new Set(Object.values(links));
  const evidence = `From your ${opts.sourceLabel ?? "course calendar feed"}`;

  const syncTask = (task: Task, item: FeedItem) => {
    if (task.status === "done") {
      unchanged++;
      return;
    }
    const changed = task.dueDate !== item.dueDate || (task.dueTime ?? undefined) !== item.dueTime || task.name !== item.title;
    if (!changed) {
      unchanged++;
      return;
    }
    update.push({ ...task, name: item.title, dueDate: item.dueDate, dueTime: item.dueTime, dateConfidence: "explicit", dateEvidence: evidence });
  };

  for (const item of items) {
    const linked = nextLinks[item.uid];
    if (linked === FEED_ITEM_DISMISSED) continue;
    if (linked) {
      const task = taskById.get(linked);
      if (!task) {
        nextLinks[item.uid] = FEED_ITEM_DISMISSED; // the student deleted it: do not bring it back
        continue;
      }
      syncTask(task, item);
      continue;
    }

    const match = item.courseName ? findBestClassMatch(item.courseName, [...state.classes]) : null;
    const cls = match?.isConfident ? match.matchedClass : null;
    const wanted = normName(item.title);
    const existing = state.tasks.find((task) =>
      !linkedTaskIds.has(task.id)
      && normName(task.name) === wanted
      && ((cls && task.courseId === cls.id) || dayDiff(task.dueDate, item.dueDate) <= 3),
    );
    if (existing) {
      nextLinks[item.uid] = existing.id;
      linkedTaskIds.add(existing.id);
      syncTask(existing, item);
      continue;
    }

    const id = opts.makeId();
    nextLinks[item.uid] = id;
    linkedTaskIds.add(id);
    add.push({
      id,
      name: item.title,
      courseId: cls?.id ?? "",
      courseName: cls?.name ?? (item.courseName || "Course feed"),
      dueDate: item.dueDate,
      ...(item.dueTime ? { dueTime: item.dueTime } : {}),
      estimatedMinutes: MINUTES_BY_KIND[item.kind],
      difficulty: item.kind === "exam" || item.kind === "project" ? 4 : 3,
      requiresOnCampus: false,
      status: "pending",
      createdAt: opts.now.toISOString(),
      kind: item.kind,
      dateConfidence: "explicit",
      dateEvidence: evidence,
    });
  }
  return { add, update, links: nextLinks, unchanged };
}

export type FeedTaskAction = { type: "UPDATE_TASK"; payload: Task } | { type: "ADD_TASK"; payload: Task };

/**
 * The task actions for a feed refresh, applied to the CURRENT tasks: a refresh is computed from a snapshot taken
 * before the (possibly slow) downloads, and UPDATE_TASK replaces the whole task, so only the feed's fields (name,
 * due date / time, date evidence) are copied onto the latest copy. A task finished or deleted meanwhile is left
 * alone, and a task that already exists is not added twice.
 */
export function feedChangeActions(
  changes: { add: readonly Task[]; update: readonly Task[] },
  currentTasks: readonly Task[],
): FeedTaskAction[] {
  const byId = new Map(currentTasks.map((task) => [task.id, task]));
  const actions: FeedTaskAction[] = [];
  for (const task of changes.update) {
    const current = byId.get(task.id);
    if (!current || current.status === "done") continue;
    actions.push({
      type: "UPDATE_TASK",
      payload: { ...current, name: task.name, dueDate: task.dueDate, dueTime: task.dueTime, dateConfidence: task.dateConfidence, dateEvidence: task.dateEvidence },
    });
  }
  for (const task of changes.add) {
    if (!byId.has(task.id)) actions.push({ type: "ADD_TASK", payload: task });
  }
  return actions;
}

/** Feeds are refreshed on foreground at most this often. */
export const FEED_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function feedIsDue(lastFetchedAt: string | undefined, now: Date): boolean {
  if (!lastFetchedAt) return true;
  const last = Date.parse(lastFetchedAt);
  return !Number.isFinite(last) || now.getTime() - last >= FEED_REFRESH_INTERVAL_MS;
}
