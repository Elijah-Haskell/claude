/**
 * Today's two small summaries, pure so they can be unit-tested:
 *  - the week as a strip of seven dates (which is today, which are past, which have a deadline);
 *  - the label over the day's list ("3 sessions · 2h 40m", "1 of 3 done · 1h 15m left", "3 of 3 sessions done").
 */
import type { ScheduleBlock, Task } from "./types";
import { addDaysToKey, formatDuration, getDurationMinutes, weekStartKeyOf } from "./utils";

const LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export interface StripDay {
  /** "YYYY-MM-DD" */
  key: string;
  /** "M" … "S", Monday first */
  letter: string;
  dayOfMonth: number;
  isToday: boolean;
  isPast: boolean;
  /** Open deadlines (tasks not done and not skipped) due on this day. */
  dueCount: number;
  /** For screen readers: "Wednesday, September 30, today, 1 due". */
  label: string;
}

/** The week that holds `todayKey`, Monday first. */
export function weekStripDays(todayKey: string, tasks: readonly Pick<Task, "dueDate" | "status">[]): StripDay[] {
  const start = weekStartKeyOf(todayKey);
  const dueByDay = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === "done" || task.status === "skipped") continue;
    dueByDay.set(task.dueDate, (dueByDay.get(task.dueDate) ?? 0) + 1);
  }
  return LETTERS.map((letter, index) => {
    const key = addDaysToKey(start, index);
    const [, month, day] = key.split("-").map(Number);
    const dueCount = dueByDay.get(key) ?? 0;
    const isToday = key === todayKey;
    const words = [`${WEEKDAYS[index]}, ${MONTHS[(month ?? 1) - 1]} ${day}`];
    if (isToday) words.push("today");
    if (dueCount > 0) words.push(`${dueCount} due`);
    return { key, letter, dayOfMonth: day ?? 0, isToday, isPast: key < todayKey, dueCount, label: words.join(", ") };
  });
}

export interface DaySessions {
  /** Study sessions on the day that still count (a skipped one does not). */
  total: number;
  done: number;
  /** Minutes of the sessions not yet done. */
  remainingMinutes: number;
  /** The label over the day's list. */
  label: string;
}

/** Counts the day's study sessions. Classes, commitments and calendar events are not sessions. */
export function daySessions(blocks: readonly Pick<ScheduleBlock, "type" | "completionStatus" | "startTime" | "endTime">[]): DaySessions {
  const sessions = blocks.filter((block) => block.type === "study" && block.completionStatus !== "skipped");
  const total = sessions.length;
  const done = sessions.filter((block) => block.completionStatus === "done").length;
  const minutes = (list: typeof sessions) => list.reduce((sum, block) => sum + getDurationMinutes(block.startTime, block.endTime), 0);
  const remainingMinutes = minutes(sessions.filter((block) => block.completionStatus !== "done"));
  const plural = total === 1 ? "session" : "sessions";
  const label =
    total === 0
      ? "No study sessions"
      : done === total
        ? `${done} of ${total} ${plural} done`
        : done === 0
          ? `${total} ${plural} · ${formatDuration(remainingMinutes)}`
          : `${done} of ${total} done · ${formatDuration(remainingMinutes)} left`;
  return { total, done, remainingMinutes, label };
}
