/** Pure helpers for the "Sleep window" setting (bedtime / wake time / sleep target). */

export const MIN_SLEEP_TARGET_HOURS = 5;
export const MAX_SLEEP_TARGET_HOURS = 12;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Minutes of sleep between a bedtime and the next wake time (handles bedtimes before or after midnight). */
export function sleepWindowMinutes(bedtime: string, wakeTime: string): number {
  const diff = toMinutes(wakeTime) - toMinutes(bedtime);
  return diff > 0 ? diff : diff + 24 * 60;
}

/** "8h" or "7h 30m". */
export function formatSleepDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Keep the sleep target within a sane range, in half-hour steps. */
export function clampSleepTarget(hours: number): number {
  const stepped = Math.round(hours * 2) / 2;
  return Math.min(MAX_SLEEP_TARGET_HOURS, Math.max(MIN_SLEEP_TARGET_HOURS, stepped));
}

/** A short warning when the chosen window is shorter than the target, otherwise null. */
export function sleepWindowWarning(bedtime: string, wakeTime: string, targetHours: number): string | null {
  const minutes = sleepWindowMinutes(bedtime, wakeTime);
  if (minutes < targetHours * 60 - 30) {
    return `This window is ${formatSleepDuration(minutes)}, shorter than your ${formatSleepDuration(targetHours * 60)} target.`;
  }
  return null;
}
