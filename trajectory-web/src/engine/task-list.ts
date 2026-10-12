/**
 * The Tasks tab's list, pure so its rules are unit-tested without the screen:
 *  - the ONE badge on a row (quiet for a date far off, gold inside a week, red for today, tomorrow and overdue work);
 *  - plain groups by date, on calendar weeks (Overdue, Past quizzes and exams, This week, Next week, Later, Done),
 *    or one group per class;
 *  - search over the task's name and its class;
 *  - the line over the title ("58 to do · 1 due this week").
 */
import { classifyTaskKind } from "./task-kind";
import type { Task } from "./types";
import { addDaysToKey, dateKeyOf, daysBetweenKeys, weekStartKeyOf, weekdayOfKey } from "./utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

type ListTask = Pick<Task, "id" | "name" | "courseId" | "courseName" | "dueDate" | "status" | "kind">;

/** A quiz or an exam: it happens AT its date, so a past one is recorded, never "overdue". */
function isAssessment(task: Pick<Task, "name" | "kind">): boolean {
  const kind = classifyTaskKind(task);
  return kind === "exam" || kind === "quiz";
}

const isClosed = (task: Pick<Task, "status">) => task.status === "done" || task.status === "skipped";

/** "Oct 7" for a date key ("" when it is not one). */
export function shortDateLabel(dateKey: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return "";
  return `${MONTHS[Number(match[1]) - 1] ?? ""} ${Number(match[2])}`;
}

// ── The badge ─────────────────────────────────────────────────

export type BadgeTone = "neutral" | "gold" | "red";

export interface TaskBadge {
  /** Shown in mono capitals: "FRI", "OCT 7", "TOMORROW", "OVERDUE". */
  label: string;
  tone: BadgeTone;
  /** For screen readers: "due Friday", "overdue since Sep 28". */
  spoken: string;
}

const WEEKDAY_FULL: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

/** How far a date is, as the one badge: red today and tomorrow, gold for the rest of the next 6 days, quiet after. */
export function dateBadge(dateKey: string, todayKey: string): TaskBadge {
  const days = daysBetweenKeys(todayKey, dateKey);
  const date = shortDateLabel(dateKey);
  if (!date || !Number.isFinite(days)) return { label: "No date", tone: "neutral", spoken: "no date" };
  if (days === 0) return { label: "Today", tone: "red", spoken: "due today" };
  if (days === 1) return { label: "Tomorrow", tone: "red", spoken: "due tomorrow" };
  if (days > 1 && days < 7) {
    const weekday = weekdayOfKey(dateKey);
    return { label: weekday, tone: "gold", spoken: `due ${WEEKDAY_FULL[weekday] ?? weekday}` };
  }
  return { label: date, tone: "neutral", spoken: `due ${date}` };
}

/** The badge on a task's row. */
export function taskBadge(task: Pick<Task, "name" | "kind" | "dueDate" | "status">, todayKey: string): TaskBadge {
  const key = dateKeyOf(task.dueDate ?? "");
  const date = shortDateLabel(key);
  if (!date) return { label: "No date", tone: "neutral", spoken: "no due date" };
  if (task.status === "done") return { label: date, tone: "neutral", spoken: `done, was due ${date}` };
  if (task.status === "skipped") return { label: "Skipped", tone: "neutral", spoken: `skipped, was due ${date}` };
  if (key < todayKey) {
    return isAssessment(task)
      ? { label: date, tone: "neutral", spoken: `took place ${date}: tick it when it is done, or skip it` }
      : { label: "Overdue", tone: "red", spoken: `overdue since ${date}` };
  }
  return dateBadge(key, todayKey);
}

// ── Groups ────────────────────────────────────────────────────

export type DateGroupKey = "overdue" | "past" | "thisWeek" | "nextWeek" | "later" | "done";

const DATE_GROUPS: readonly { key: DateGroupKey; title: string }[] = [
  { key: "overdue", title: "Overdue" },
  { key: "past", title: "Past quizzes and exams" },
  { key: "thisWeek", title: "This week" },
  { key: "nextWeek", title: "Next week" },
  { key: "later", title: "Later" },
  { key: "done", title: "Done" },
];

/** Which date group a task is in. Weeks are calendar weeks, Monday to Sunday. */
export function dateGroupOf(task: Pick<Task, "name" | "kind" | "dueDate" | "status">, todayKey: string): DateGroupKey {
  if (isClosed(task)) return "done";
  const key = dateKeyOf(task.dueDate ?? "");
  if (!shortDateLabel(key)) return "later";
  if (key < todayKey) return isAssessment(task) ? "past" : "overdue";
  const thisSunday = addDaysToKey(weekStartKeyOf(todayKey), 6);
  if (key <= thisSunday) return "thisWeek";
  return key <= addDaysToKey(thisSunday, 7) ? "nextWeek" : "later";
}

export interface TaskGroup<T> {
  key: string;
  title: string;
  /** The class colour, on a by-class group. */
  color?: string;
  tasks: T[];
}

const byDueThenName = (a: ListTask, b: ListTask) => dateKeyOf(a.dueDate ?? "").localeCompare(dateKeyOf(b.dueDate ?? "")) || a.name.localeCompare(b.name);

/** The date groups that have something in them, in order. Finished work reads newest first. */
export function groupTasksByDate<T extends ListTask>(tasks: readonly T[], todayKey: string): TaskGroup<T>[] {
  const buckets = new Map<DateGroupKey, T[]>();
  for (const task of [...tasks].sort(byDueThenName)) {
    const key = dateGroupOf(task, todayKey);
    buckets.set(key, [...(buckets.get(key) ?? []), task]);
  }
  buckets.get("done")?.reverse();
  return DATE_GROUPS.flatMap(({ key, title }) => {
    const list = buckets.get(key);
    return list && list.length > 0 ? [{ key, title, tasks: list }] : [];
  });
}

/**
 * One group per class, in the order of the student's classes; work for a class that is not (or no longer) one of them
 * follows by name, and work with no class comes last. Inside a group: what is open by due date, then what is finished.
 */
export function groupTasksByClass<T extends ListTask>(tasks: readonly T[], classes: readonly { id: string; name: string; color?: string }[]): TaskGroup<T>[] {
  const known = new Map(classes.map((cls, index) => [cls.id, { ...cls, index }]));
  const groups = new Map<string, TaskGroup<T> & { order: number }>();
  for (const task of [...tasks].sort(byDueThenName)) {
    const cls = known.get(task.courseId);
    const name = cls?.name ?? (task.courseName?.trim() || "General");
    const general = !cls && name === "General";
    const key = cls ? `class:${cls.id}` : `name:${name.toLowerCase()}`;
    const group = groups.get(key) ?? { key, title: general ? "No class" : name, color: cls?.color, tasks: [], order: cls ? cls.index : general ? Number.MAX_SAFE_INTEGER : classes.length };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(({ order: _order, ...group }) => ({ ...group, tasks: [...group.tasks.filter((task) => !isClosed(task)), ...group.tasks.filter(isClosed)] }));
}

// ── Search ────────────────────────────────────────────────────

/** Every word of the search is in the task's name or its class's name (case does not matter). An empty search matches all. */
export function matchesTaskSearch(task: Pick<Task, "name" | "courseName">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${task.name} ${task.courseName ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

// ── The line over the title ───────────────────────────────────

/** "58 to do · 1 due this week", "12 to do · 2 overdue", "Nothing left to do", "No tasks yet". */
export function tasksSummary(tasks: readonly Pick<Task, "name" | "kind" | "dueDate" | "status">[], todayKey: string): string {
  if (tasks.length === 0) return "No tasks yet";
  const open = tasks.filter((task) => !isClosed(task));
  if (open.length === 0) return "Nothing left to do";
  const groups = open.map((task) => dateGroupOf(task, todayKey));
  const overdue = groups.filter((group) => group === "overdue").length;
  const thisWeek = groups.filter((group) => group === "thisWeek").length;
  return `${open.length} to do · ${overdue > 0 ? `${overdue} overdue` : `${thisWeek} due this week`}`;
}
