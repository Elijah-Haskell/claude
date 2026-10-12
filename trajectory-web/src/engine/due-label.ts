/**
 * "Due" wording for a study session, so every block working toward a deadline says which deadline and when:
 * "due today 11:59p", "due tomorrow", "due Thu", "due Oct 16". Relative to today, the way a student reads it.
 */
import type { ScheduleBlock, Task } from "./types";
import { daysBetweenKeys, weekdayOfKey } from "./utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "11:59p", "9a", "2:30p" */
function compactTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return "";
  const hour = (h! % 12) || 12;
  const suffix = h! < 12 ? "a" : "p";
  return m ? `${hour}:${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

/** "today", "tomorrow", "Thu" (within the next 6 days), "yesterday", or "Oct 16". */
export function relativeDayLabel(dateKey: string, todayKey: string): string {
  const days = daysBetweenKeys(todayKey, dateKey);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return weekdayOfKey(dateKey);
  const [, month, day] = dateKey.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1] ?? ""} ${day ?? ""}`;
}

/** "due Thu 11:59p" for a task; null when it has no usable due date. */
export function dueLabel(task: Pick<Task, "dueDate" | "dueTime"> | undefined, todayKey: string): string | null {
  if (!task || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate ?? "")) return null;
  const when = relativeDayLabel(task.dueDate, todayKey);
  const time = task.dueTime && /^\d{1,2}:\d{2}$/.test(task.dueTime) ? ` ${compactTime(task.dueTime)}` : "";
  return `due ${when}${time}`;
}

/** The due wording for a study / assignment-work block (null for classes, commitments, free time, sleep). */
export function blockDueLabel(block: Pick<ScheduleBlock, "type" | "taskId">, task: Pick<Task, "dueDate" | "dueTime" | "status"> | undefined, todayKey: string): string | null {
  if (block.type !== "study" || !block.taskId || !task || task.status === "done") return null;
  return dueLabel(task, todayKey);
}
