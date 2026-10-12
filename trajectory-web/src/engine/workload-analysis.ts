import { HealthPreferences, ScheduleBlock, Task, UserPreferences } from "./types";
import { addDaysToKey, dateKeyOf, localDateKey, parseLocalDate, timeToMinutes, weekStartKeyOf } from "./utils";
import { blockMinutes, remainingMinutes } from "./task-progress";

export interface WorkloadWarning { weekStart: string; dueMinutes: number; capacityMinutes: number; severity: "watch" | "high"; message: string; }

// ── Study-load caps ───────────────────────────────────────────

export interface StudyLoadCaps {
  /** The planner first tries to keep every day at or under this many study minutes. */
  dailyTargetMinutes: number;
  /** Most study minutes on one day while any other day in the task's runway (up to 2x) still has room. */
  dailyMinutes: number;
  /** Most study minutes in one Monday-Sunday week while any other week in reach still has room. */
  weeklyMinutes: number;
}

const clampIntensity = (value: number | undefined) => Math.min(100, Math.max(0, Number.isFinite(value) ? (value as number) : 50));

/**
 * Minutes-based study-load caps. Explicit settings win (UserPreferences.dailyStudyCapMinutes / weeklyStudyCapMinutes);
 * otherwise they follow the existing "schedule intensity" slider (0-100, balanced 50):
 *   daily   = 180 + 2.4 x intensity   (balanced: 300 min = 5 h, the plan-quality "overloaded day" line)
 *   weekly  = 540 + 9 x intensity     (balanced: 990 min = 16.5 h, the capacity getSemesterWorkloadWarnings uses)
 *   target  = 60% of the daily cap    (balanced: 3 h)
 * Caps are soft limits on WHERE work goes, never on WHETHER it is planned: when no day in reach has room the
 * planner still places the work (over the cap) rather than silently dropping it.
 */
export function studyLoadCaps(prefs?: Partial<Pick<UserPreferences, "scheduleIntensity" | "dailyStudyCapMinutes" | "weeklyStudyCapMinutes">>): StudyLoadCaps {
  const intensity = clampIntensity(prefs?.scheduleIntensity);
  const daily = prefs?.dailyStudyCapMinutes && prefs.dailyStudyCapMinutes > 0 ? Math.round(prefs.dailyStudyCapMinutes) : Math.round(180 + 2.4 * intensity);
  const weekly = prefs?.weeklyStudyCapMinutes && prefs.weeklyStudyCapMinutes > 0 ? Math.round(prefs.weeklyStudyCapMinutes) : Math.round(540 + 9 * intensity);
  return { dailyTargetMinutes: Math.round(daily * 0.6), dailyMinutes: daily, weeklyMinutes: Math.max(weekly, daily) };
}

function weekStartFor(dateString: string): string {
  return weekStartKeyOf(dateString.slice(0, 10));
}

/** Flags deadline clusters before the planner is forced into last-minute placement. */
export function getSemesterWorkloadWarnings(tasks: Task[], scheduleIntensity: number, today = new Date()): WorkloadWarning[] {
  const todayString = localDateKey(today);
  const weeklyCapacity = studyLoadCaps({ scheduleIntensity }).weeklyMinutes;
  const buckets = new Map<string, { dueMinutes: number; highDifficultyCount: number }>();
  for (const task of tasks) {
    if (task.status === "done" || task.status === "skipped" || task.dueDate < todayString) continue;
    const weekStart = weekStartFor(task.dueDate);
    const bucket = buckets.get(weekStart) ?? { dueMinutes: 0, highDifficultyCount: 0 };
    bucket.dueMinutes += remainingMinutes(task);
    if (task.difficulty >= 4) bucket.highDifficultyCount += 1;
    buckets.set(weekStart, bucket);
  }
  return [...buckets.entries()].map(([weekStart, bucket]): WorkloadWarning | null => {
    const ratio = bucket.dueMinutes / weeklyCapacity;
    const severity = ratio >= 1 || (ratio >= 0.75 && bucket.highDifficultyCount >= 2) ? "high" : ratio >= 0.7 ? "watch" : null;
    if (!severity) return null;
    const dueHours = Math.round((bucket.dueMinutes / 60) * 10) / 10;
    // "the week of Mar 11", never the raw "2030-03-11" key.
    const week = parseLocalDate(weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return { weekStart, dueMinutes: bucket.dueMinutes, capacityMinutes: weeklyCapacity, severity, message: severity === "high" ? `${dueHours} hours of estimated work cluster in the week of ${week}. Start earlier or protect study time now.` : `${dueHours} hours of work are due in the week of ${week}. Review the plan before it becomes a crunch week.` };
  }).filter((warning): warning is WorkloadWarning => warning !== null).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ── Today's workload (the one "day is over your cap" warning) ─
// Only Today's workload card says a day is too full (the plan alerts on Today / Tasks / Week no longer repeat it).
// It looks at what is still TO DO: pending blocks, and today only from now on. A session the student moved to
// tomorrow, skipped or finished stops counting at once.
//
// The percentage is a load heuristic, not a measured probability: a smooth curve over how much of the awake time
// left is booked, times a penalty when the study still to do is over the daily cap. The UI words it as "Today looks
// about N% doable". Clamped to 5-99.

type CapPrefs = Partial<Pick<UserPreferences, "scheduleIntensity" | "dailyStudyCapMinutes" | "weeklyStudyCapMinutes">>;

/** The card shows below this score; at or above it the day is comfortable and the card stays hidden. */
const COMFORTABLE_PERCENT = 78;

const clampPercent = (p: number) => Math.max(5, Math.min(99, Math.round(p * 100)));
const hours = (minutes: number) => {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)} h`;
};

/** Minutes of `block` still ahead at `nowMinutes` (all of it without a clock). */
function minutesAhead(block: Pick<ScheduleBlock, "startTime" | "endTime">, nowMinutes?: number): number {
  const length = blockMinutes(block);
  if (nowMinutes === undefined) return length;
  const start = timeToMinutes(block.startTime);
  return Math.max(0, Math.min(length, start + length - Math.max(start, nowMinutes)));
}

/** Awake minutes of the day: all of them before wake-up (or without a clock), otherwise what is left until bedtime. */
function awakeMinutesLeft(prefs: Pick<HealthPreferences, "wakeTime" | "bedtime">, nowMinutes?: number): { minutes: number; wholeDay: boolean } {
  const wake = timeToMinutes(prefs.wakeTime);
  const bed = timeToMinutes(prefs.bedtime);
  const day = bed > wake ? bed - wake : 24 * 60 - wake + bed;
  if (nowMinutes === undefined || nowMinutes <= wake) return { minutes: day, wholeDay: true };
  const end = bed > wake ? bed : bed + 24 * 60;
  return { minutes: Math.max(0, end - nowMinutes), wholeDay: false };
}

/** The doable score for `totalMinutes` booked (of which `studyMinutes` is study) in `availableMinutes` of awake time. */
function doableScore(totalMinutes: number, studyMinutes: number, availableMinutes: number, capMinutes: number) {
  const loadRatio = availableMinutes > 0 ? totalMinutes / availableMinutes : 1;
  const loadFactor = 1 / (1 + Math.exp((loadRatio - 0.8) / 0.06));
  const capFactor = studyMinutes > capMinutes ? Math.pow(capMinutes / studyMinutes, 0.8) : 1;
  return { percent: clampPercent(0.99 * loadFactor * capFactor), loadFactor, capFactor };
}

/** The Today workload card. */
export interface RealityCheckResult {
  /** 5-99: how doable what is left of today looks (a load heuristic, NOT a measured probability). */
  doablePercent: number;
  /** Minutes still booked today (pending, from now on). */
  totalMinutes: number;
  /** Study minutes still to do today. */
  studyMinutes: number;
  /** Awake minutes left today (the whole awake day before wake-up or without a clock). */
  availableMinutes: number;
  overloadedBy: number;
  /** How many sessions "Move N to tomorrow" moves (= moveBlockIds.length). */
  movableCount: number;
  /**
   * Just enough sessions to bring today back under the daily cap (and out of the warning zone), taken latest deadline
   * first, then longest first. Never one due today or earlier, locked, already started, or already under way.
   */
  moveBlockIds: string[];
  /** Moving `moveBlockIds` is enough to make the day comfortable (false when even all of them is not). */
  moveFixesDay: boolean;
  /** Why the number is what it is ("7.3 h of study left today is over your 5 h daily cap."). */
  reason: string;
}

export interface RealityCheckOptions {
  userPrefs?: CapPrefs;
  /** Return a result on a comfortable day too (tests). */
  showAll?: boolean;
  /** Minutes since midnight: only what is still ahead counts, against the awake time left. Omit to judge the whole day. */
  nowMinutes?: number;
  /** The tasks, for the deadlines that decide which sessions can wait. Without them nothing is suggested to move. */
  tasks?: Task[];
}

/**
 * Can the student get through what is left of `today`? Returns null when there is nothing to show: nothing left
 * to do, or a comfortable day (score >= 78). Only pending blocks count (moved, skipped, missed and finished ones do
 * not), and with `nowMinutes` only what is still ahead, against the awake time left before bed.
 */
export function realityCheckFor(
  scheduleBlocks: ScheduleBlock[],
  healthPrefs: Pick<HealthPreferences, "wakeTime" | "bedtime">,
  today: string,
  options: RealityCheckOptions = {},
): RealityCheckResult | null {
  const { nowMinutes } = options;
  const ahead = scheduleBlocks
    .filter((block) => block.date === today && block.type !== "sleep" && block.type !== "buffer" && block.completionStatus === "pending")
    .map((block) => ({ block, minutes: minutesAhead(block, nowMinutes) }))
    .filter((item) => item.minutes > 0);
  if (ahead.length === 0) return null;
  const totalMinutes = ahead.reduce((sum, item) => sum + item.minutes, 0);
  const studyMinutes = ahead.filter((item) => item.block.type === "study").reduce((sum, item) => sum + item.minutes, 0);
  const awake = awakeMinutesLeft(healthPrefs, nowMinutes);
  const cap = studyLoadCaps(options.userPrefs).dailyMinutes;
  const score = doableScore(totalMinutes, studyMinutes, awake.minutes, cap);
  if (score.percent >= COMFORTABLE_PERCENT && !options.showAll) return null;

  // "Move N to tomorrow": only the excess. Sessions whose deadline allows it most go first (latest due date, then the
  // longest, then the latest start), until the study left is within the cap and the day is out of the warning zone.
  const fits = (total: number, study: number) => study <= cap && doableScore(total, study, awake.minutes, cap).percent >= COMFORTABLE_PERCENT;
  const dueByTask = new Map((options.tasks ?? []).map((task) => [task.id, dateKeyOf(task.dueDate)]));
  const dueOf = (block: ScheduleBlock) => (block.taskId ? dueByTask.get(block.taskId) ?? "" : "");
  const candidates = ahead
    .filter(({ block }) =>
      block.type === "study" && !block.locked && !block.startedAt && dueOf(block) > today &&
      (nowMinutes === undefined || timeToMinutes(block.startTime) >= nowMinutes))
    .sort((a, b) => dueOf(b.block).localeCompare(dueOf(a.block)) || b.minutes - a.minutes || b.block.startTime.localeCompare(a.block.startTime));
  const moveBlockIds: string[] = [];
  let totalLeft = totalMinutes;
  let studyLeft = studyMinutes;
  for (const { block, minutes } of candidates) {
    if (fits(totalLeft, studyLeft)) break;
    moveBlockIds.push(block.id);
    totalLeft -= minutes;
    studyLeft -= minutes;
  }

  const reason = score.capFactor < 1 && score.capFactor <= score.loadFactor
    ? `${hours(studyMinutes)} of study ${awake.wholeDay ? "today" : "left today"} is over your ${hours(cap)} daily cap.`
    : awake.wholeDay
      ? `${hours(totalMinutes)} of your ${hours(awake.minutes)} awake time is booked.`
      : `${hours(totalMinutes)} of the ${hours(awake.minutes)} left before bed is booked.`;
  return {
    doablePercent: score.percent,
    totalMinutes,
    studyMinutes,
    availableMinutes: awake.minutes,
    overloadedBy: totalMinutes - awake.minutes * 0.8,
    movableCount: moveBlockIds.length,
    moveBlockIds,
    moveFixesDay: moveBlockIds.length > 0 && fits(totalLeft, studyLeft),
    reason,
  };
}

export interface OverloadedDay {
  date: string;
  /** Open (pending) study minutes planned that day. */
  studyMinutes: number;
  capMinutes: number;
}

/**
 * Upcoming days (tomorrow through `days` days ahead, default 7) whose open study is over the daily cap, earliest
 * first. Only pending sessions count, so moved, skipped and finished ones never keep a day flagged. Today itself is
 * realityCheckFor's job.
 */
export function overloadedDaysAhead(scheduleBlocks: ScheduleBlock[], today: string, options: { userPrefs?: CapPrefs; days?: number } = {}): OverloadedDay[] {
  const cap = studyLoadCaps(options.userPrefs).dailyMinutes;
  const last = addDaysToKey(today, options.days ?? 7);
  const perDay = new Map<string, number>();
  for (const block of scheduleBlocks) {
    if (block.type !== "study" || block.completionStatus !== "pending" || block.date <= today || block.date > last) continue;
    perDay.set(block.date, (perDay.get(block.date) ?? 0) + blockMinutes(block));
  }
  return [...perDay.entries()]
    .filter(([, minutes]) => minutes > cap)
    .map(([date, studyMinutes]) => ({ date, studyMinutes, capMinutes: cap }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
