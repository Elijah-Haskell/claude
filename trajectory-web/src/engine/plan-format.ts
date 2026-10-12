import { daysBetweenKeys, parseLocalDate, weekdayOfKey } from "./utils";

/** "45 min" / "~1 hour" / "~5 hours": rounded wording for a number of minutes. */
export function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 1.75) return "~1 hour";
  return `~${Math.round(hours)} hours`;
}

/** "today" / "tomorrow" / "Fri" (within a week) / "Mar 20": how a due date reads after "before". */
export function dueLabel(dueKey: string, todayKey: string): string {
  const delta = daysBetweenKeys(todayKey, dueKey);
  if (delta <= 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta < 7) return weekdayOfKey(dueKey);
  return parseLocalDate(dueKey).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "45 more minutes" / "~1 more hour" / "~5 more hours": how much extra time a shortfall needs. */
export function describeMoreTime(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} more minutes`;
  const hours = minutes / 60;
  if (hours < 1.75) return "~1 more hour";
  return `~${Math.round(hours)} more hours`;
}
