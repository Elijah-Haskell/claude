// Pure helpers of the Trajectory AI page (src/screens/ai.tsx): the shapes the assistant returns, turning a found task
// into a Task, the change-preview rows, and the plain-text versions of AI output that the "Report" e-mail quotes.
// Pure, no React (unit-tested in tests/web/ai-items.test.ts); the mobile app's components/ai/ai-items.ts.

import type { ClassBlock, ScheduleBlock, Task } from "../engine/types";
import { formatTime, toDateString } from "../engine/utils";

// ── Shapes returned by the ai.* procedures ─────────────────────

export interface ParsedTask {
  name: string;
  courseName: string;
  estimatedMinutes: number;
  difficulty: number;
  dueDate: string;
  notes?: string;
}

export interface ParsedEvent {
  title: string;
  date: string;       // "YYYY-MM-DD"
  startTime: string;  // "HH:MM" 24h
  endTime: string;    // "HH:MM" 24h
  type: "free" | "workout" | "meal" | "work" | "recurring" | "buffer";
  notes?: string;
}

type Day = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface ParsedRecurringEvent {
  title: string;
  days: Day[];
  startTime: string;
  endTime: string;
  color: string;
  description?: string;
}

export interface ParsedNewClass {
  name: string;
  days: Day[];
  startTime: string;
  endTime: string;
  location?: string;
  color: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tasks?: ParsedTask[];
  events?: ParsedEvent[];
}

/** An assistant edit waiting for the student's review (nothing is applied yet). */
export interface PendingEdit {
  editBlocks: Record<string, unknown>[];
  editRecurring: Record<string, unknown>[];
  newEvents: ParsedEvent[];
  newRecurring: ParsedRecurringEvent[];
  healthPrefsUpdate?: { mealTimes?: string[]; wakeTime?: string; bedtime?: string };
  /** New due dates for existing tasks (the chat's "deadline" answers: "my midterm moved to Tuesday"). */
  deadlineChanges?: { taskId: string; dueDate: string; dueTime?: string }[];
  summary: string;
}

// ── Messages ──────────────────────────────────────────────────

/** The app's own confirmation messages start with this mark; they render as the website's done bar. */
export const DONE_PREFIX = /^(✅|🎉)\s*/;

/** Trailing timestamp of a message id ("sys-1712345678901"): when the message was written. Display only. */
export function messageStamp(id: string): number | null {
  const m = /(\d{10,})$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** A confirmation split into a bold headline and the rest (display only). */
export function splitDone(content: string): { headline: string; rest: string } {
  const body = content.replace(DONE_PREFIX, "").trim();
  const para = body.indexOf("\n\n");
  if (para > 0) return { headline: body.slice(0, para).trim(), rest: body.slice(para + 2).trim() };
  const sentence = /^(.+?[.!])\s+([\s\S]*)$/.exec(body);
  return sentence ? { headline: sentence[1]!, rest: sentence[2]!.trim() } : { headline: body, rest: "" };
}

/**
 * Was this message written by the model (so it carries the "AI-generated · Report" label)? The app's own lines are
 * not: the welcome text, confirmations (done bars), "sys-" notices and "err-" connection errors.
 */
export function isAiAuthoredMessage(message: Pick<ChatMessage, "id" | "role" | "content">): boolean {
  if (message.role !== "assistant") return false;
  if (DONE_PREFIX.test(message.content)) return false;
  return !/^(welcome|sys-|err-)/.test(message.id);
}

/**
 * What the page says once things were added: what was added, then where the new tasks' study sessions were planned
 * (up to four days), or plainly that none could be. It starts with the done mark, so it is drawn as a confirmation
 * with Undo. `blocks` is the plan that was just applied.
 */
export function addedConfirmation(
  items: string,
  taskIds: readonly string[],
  blocks: readonly Pick<ScheduleBlock, "type" | "taskId" | "date" | "startTime">[],
): string {
  const head = `✅ ${items ? items[0]!.toUpperCase() + items.slice(1) : "It was"} added.`;
  if (taskIds.length === 0) return `${head}\n\nYou can undo it here.`;
  const ids = new Set(taskIds);
  const sessions = blocks
    .filter((block) => block.type === "study" && block.taskId !== undefined && ids.has(block.taskId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  if (sessions.length === 0) {
    return `${head}\n\nNo study session is planned for ${taskIds.length === 1 ? "it" : "them"} yet. You can undo it here.`;
  }
  const byDay = new Map<string, string[]>();
  for (const session of sessions) {
    const day = new Date(session.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    byDay.set(day, [...(byDay.get(day) ?? []), formatTime(session.startTime)]);
  }
  const lines = [...byDay.entries()].slice(0, 4).map(([day, times]) => `  • ${day}: ${times.join(", ")}`);
  if (byDay.size > 4) lines.push(`  • and ${byDay.size - 4} more ${byDay.size - 4 === 1 ? "day" : "days"}`);
  return `${head}\n\nStudy sessions planned:\n${lines.join("\n")}\nYou can undo it here.`;
}

// ── Formatting ────────────────────────────────────────────────

export function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function difficultyLabel(d: number): string {
  return ["", "Easy", "Moderate", "Medium", "Hard", "Very Hard"][d] ?? "Medium";
}

/** "Mar 15" for a "YYYY-MM-DD" key (raw text otherwise). */
export function shortDate(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return dateKey;
  return new Date(dateKey + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Whole days from `today` to a "YYYY-MM-DD" key (display only: due dates within 3 days are shown in gold). */
export function daysUntil(dateKey: string, today: string = toDateString(new Date())): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const target = new Date(dateKey + "T12:00:00").getTime();
  const from = new Date(today + "T12:00:00").getTime();
  if (!Number.isFinite(target) || !Number.isFinite(from)) return null;
  return Math.round((target - from) / 86400000);
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Parsed task -> Task ────────────────────────────────────────

/**
 * A reviewed parsed task as a Task. The course is matched to one of the student's classes by name (either name
 * containing the other), otherwise "general". A task without a due date gets one a week out; with
 * `clampPastDue`, a date already in the past does too (the page does this: the parser sometimes returns last week's date).
 */
export function taskFromParsed(
  pt: ParsedTask,
  classes: Pick<ClassBlock, "id" | "name">[],
  opts: { now?: Date; clampPastDue?: boolean } = {},
): Task {
  const now = opts.now ?? new Date();
  const weekOut = toDateString(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const course = (pt.courseName ?? "").trim().toLowerCase();
  // An empty course name is "no course" (every name includes ""), not the first class.
  const matchedClass = course ? classes.find((c) => c.name.toLowerCase().includes(course) || course.includes(c.name.toLowerCase())) : undefined;
  const raw = pt.dueDate || weekOut;
  const dueDate = opts.clampPastDue && raw < toDateString(now) ? weekOut : raw;
  return {
    id: `task-${now.getTime()}-${Math.random().toString(36).slice(2)}`,
    name: pt.name,
    courseId: matchedClass?.id ?? "general",
    courseName: pt.courseName,
    dueDate,
    estimatedMinutes: pt.estimatedMinutes,
    difficulty: Math.min(5, Math.max(1, pt.difficulty)) as 1 | 2 | 3 | 4 | 5,
    requiresOnCampus: false,
    status: "pending",
    createdAt: now.toISOString(),
  };
}

// ── Change preview rows (website `.prev li`: "old → new") ──────

export interface Slot {
  date?: string;
  start?: string;
  end?: string;
}

export function slotLabel(slot: Slot, detail: "day" | "date" | "range"): string {
  const day = slot.date && /^\d{4}-\d{2}-\d{2}$/.test(slot.date)
    ? new Date(slot.date + "T12:00:00").toLocaleDateString("en-US", detail === "day" ? { weekday: "short" } : { weekday: "short", month: "short", day: "numeric" })
    : "";
  const clock = slot.start && /^\d{1,2}:\d{2}/.test(slot.start)
    ? formatTime(slot.start) + (detail === "range" && slot.end && /^\d{1,2}:\d{2}/.test(slot.end) ? `–${formatTime(slot.end)}` : "")
    : "";
  return [day, clock].filter(Boolean).join(" ");
}

/** "Thu 3:00 PM" → "Tue 3:00 PM"; adds the date, then the end time, only when needed to show the difference. */
export function moveLabels(from: Slot | null, to: Slot): { from: string; to: string } {
  if (!from) return { from: "", to: slotLabel(to, "date") };
  for (const detail of ["day", "date", "range"] as const) {
    const a = slotLabel(from, detail);
    const b = slotLabel(to, detail);
    if (a !== b || detail === "range") return { from: a, to: b };
  }
  return { from: "", to: slotLabel(to, "range") };
}

export interface ChangeRowModel {
  key: string;
  title: string;
  from: string;
  to: string;
  isNew?: boolean;
}

interface CurrentPlan {
  scheduleBlocks: { id: string; date: string; startTime: string; endTime: string }[];
  recurringEvents: { id: string; title: string; startTime: string; endTime: string }[];
  healthPrefs?: { wakeTime?: string; bedtime?: string } | null;
  tasks?: { id: string; name: string; courseName?: string; dueDate: string; dueTime?: string }[];
}

/** "Tue, Oct 20" plus the time when there is one ("Tue, Oct 20 5:00 PM"). */
function dueLabelOf(dueDate: string, dueTime?: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(dueDate)
    ? new Date(dueDate.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : dueDate;
  return dueTime && /^\d{1,2}:\d{2}/.test(dueTime) ? `${day} ${formatTime(dueTime)}` : day;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** One row per thing the pending edit would change, "old → new" against the plan as it is now. */
export function pendingEditRows(edit: PendingEdit, current: CurrentPlan): ChangeRowModel[] {
  const rows: ChangeRowModel[] = [];
  edit.editBlocks.forEach((eb, i) => {
    const original = typeof eb.id === "string" ? current.scheduleBlocks.find((b) => b.id === eb.id) : undefined;
    const labels = moveLabels(
      original ? { date: original.date, start: original.startTime, end: original.endTime } : null,
      { date: str(eb.date) ?? original?.date, start: str(eb.startTime), end: str(eb.endTime) }
    );
    rows.push({ key: `eb-${i}`, title: str(eb.title) ?? "Block", ...labels });
  });
  edit.editRecurring.forEach((er, i) => {
    const original = typeof er.id === "string" ? current.recurringEvents.find((r) => r.id === er.id) : undefined;
    const labels = moveLabels(
      original ? { start: original.startTime, end: original.endTime } : null,
      { start: str(er.startTime) ?? original?.startTime, end: str(er.endTime) ?? original?.endTime }
    );
    const days = Array.isArray(er.days) ? (er.days as string[]).join("/") : "";
    rows.push({
      key: `er-${i}`,
      title: `Recurring "${str(er.title) ?? original?.title ?? "event"}"`,
      from: labels.from,
      to: [days, labels.to].filter(Boolean).join(" "),
    });
  });
  edit.newEvents.forEach((ev, i) => {
    rows.push({ key: `ne-${i}`, isNew: true, title: ev.title, from: "", to: slotLabel({ date: ev.date, start: ev.startTime, end: ev.endTime }, "date") });
  });
  edit.newRecurring.forEach((re, i) => {
    rows.push({ key: `nr-${i}`, isNew: true, title: re.title, from: "", to: `${re.days.join("/")} ${formatTime(re.startTime)}` });
  });
  (edit.deadlineChanges ?? []).forEach((dc, i) => {
    const task = current.tasks?.find((t) => t.id === dc.taskId);
    rows.push({
      key: `dl-${i}`,
      title: task ? (task.courseName && task.courseName !== "General" ? `${task.courseName} · ${task.name}` : task.name) : "Deadline",
      from: task ? dueLabelOf(task.dueDate, task.dueTime) : "",
      to: dueLabelOf(dc.dueDate, dc.dueTime ?? task?.dueTime),
    });
  });
  const hpu = edit.healthPrefsUpdate;
  if (hpu?.wakeTime || hpu?.bedtime) {
    const hp = current.healthPrefs;
    rows.push({
      key: "sleep",
      title: "Sleep window",
      from: [hp?.bedtime && `Bed ${formatTime(hp.bedtime)}`, hp?.wakeTime && `Wake ${formatTime(hp.wakeTime)}`].filter(Boolean).join(" · "),
      to: [hpu.bedtime && `Bed ${formatTime(hpu.bedtime)}`, hpu.wakeTime && `Wake ${formatTime(hpu.wakeTime)}`].filter(Boolean).join(" · "),
    });
  }
  return rows;
}

/** What the pending edit would do, as one line (website: "4 blocks will move. Nothing changes until you say so."). */
export function pendingEditHeadline(edit: PendingEdit): string {
  const deadlines = edit.deadlineChanges?.length ?? 0;
  return [
    deadlines > 0 && `${plural(deadlines, "deadline", "deadlines")} will move; your sessions are replanned around ${deadlines === 1 ? "it" : "them"}.`,
    edit.editBlocks.length > 0 && `${plural(edit.editBlocks.length, "block", "blocks")} will move.`,
    edit.editRecurring.length > 0 && `${plural(edit.editRecurring.length, "recurring event", "recurring events")} will change.`,
    edit.newEvents.length + edit.newRecurring.length > 0 &&
      `${plural(edit.newEvents.length + edit.newRecurring.length, "new item", "new items")} will be added.`,
    (edit.healthPrefsUpdate?.wakeTime || edit.healthPrefsUpdate?.bedtime) && "Your sleep window will change.",
  ].filter(Boolean).join(" ") || "Review the change.";
}

// ── Plain text of AI output (quoted in the Report e-mail) ──────

/** The proposed plan change as text: the assistant's summary, then one line per change. */
export function planChangeText(summary: string, rows: ChangeRowModel[]): string {
  const lines = rows.map((r) => `- ${r.isNew ? "New: " : ""}${r.title}: ${r.from ? `${r.from} → ` : ""}${r.to}`);
  return [summary.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}

/** The parsed items under review as text, one line each. */
export function parsedItemsText(items: {
  tasks?: ParsedTask[];
  events?: Pick<ParsedEvent, "title" | "date" | "startTime" | "endTime">[];
  recurring?: ParsedRecurringEvent[];
  classes?: ParsedNewClass[];
}): string {
  const lines: string[] = [];
  for (const t of items.tasks ?? []) {
    const bits = [t.courseName, t.dueDate ? `due ${t.dueDate}` : "no due date", formatMinutes(t.estimatedMinutes), `difficulty ${t.difficulty}/5`];
    lines.push(`- Task: ${t.name} (${bits.filter(Boolean).join(", ")})`);
  }
  for (const e of items.events ?? []) lines.push(`- Event: ${e.title} (${e.date} ${e.startTime}-${e.endTime})`);
  for (const r of items.recurring ?? []) lines.push(`- Recurring: ${r.title} (${r.days.join("/")} ${r.startTime}-${r.endTime})`);
  for (const c of items.classes ?? []) lines.push(`- Class: ${c.name} (${c.days.join("/")} ${c.startTime}-${c.endTime})`);
  return lines.join("\n");
}
