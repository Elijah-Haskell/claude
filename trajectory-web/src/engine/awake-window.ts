import { timeToMinutes } from "./utils";

/** Latest a same-day session may END (23:55) so no block ever wraps past midnight. */
export const LAST_MINUTE_OF_DAY = 24 * 60 - 5;

export interface AwakeWindow {
  /** Minutes after midnight the student wakes up. */
  wakeMinutes: number;
  /** Minutes after midnight of bedtime; > 1440 when bedtime is after midnight (next day). */
  bedMinutes: number;
  /** True when bedtime falls on the next calendar day (bedtime <= wake time). */
  crossesMidnight: boolean;
}

/**
 * The awake window is [wake, bedtime). A bedtime at or before the wake time is
 * a bedtime after midnight ("00:30", "01:00"): it belongs to the NEXT day.
 */
export function getAwakeWindow(wakeTime: string, bedtime: string): AwakeWindow {
  const wakeMinutes = timeToMinutes(wakeTime);
  const rawBed = timeToMinutes(bedtime);
  const crossesMidnight = rawBed <= wakeMinutes;
  return { wakeMinutes, bedMinutes: crossesMidnight ? rawBed + 24 * 60 : rawBed, crossesMidnight };
}

export interface PlanningWindow {
  /** First minute a session may start (wake + startBuffer). */
  start: number;
  /** Last minute a same-day session may end: bedtime - endBuffer, never past midnight. */
  end: number;
}

/**
 * The slice of the awake window that can hold a same-day study session.
 * Sessions never run past midnight (sleep protects retention), so for a
 * bedtime after midnight the usable window simply runs to 23:55 and the
 * hours after midnight stay free as wind-down time.
 */
export function getPlanningWindow(
  wakeTime: string,
  bedtime: string,
  startBufferMinutes = 30,
  endBufferMinutes = 30,
): PlanningWindow {
  const awake = getAwakeWindow(wakeTime, bedtime);
  return {
    start: awake.wakeMinutes + startBufferMinutes,
    end: Math.min(awake.bedMinutes - endBufferMinutes, LAST_MINUTE_OF_DAY),
  };
}
