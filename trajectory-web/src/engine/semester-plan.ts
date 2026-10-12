// ============================================================
// Whole-semester plan (pure)
// ============================================================
// "Upload the syllabus once and the ENTIRE SEMESTER is planned." One solver pass over the whole planning
// horizon (lib/semester.ts getPlanningHorizon), every week's structure (sleep, classes, recurring), and every
// solved study session kept - not just the ones in a single requested week.

import { addDaysToKey, daysBetweenKeys } from "./utils";
import { getPlanningHorizon, PlanningHorizon, weekStartsInRange } from "./semester";
import { PlannerState, planWindow, WeekPlanResult } from "./week-planner";

export interface SemesterPlanOptions {
  /** Clock injection (defaults to `new Date()`). */
  now?: Date;
  /** Plan through this date instead of the inferred horizon (still never before today). */
  horizonEnd?: string;
  /** Keep confirmed user decisions (default true). false lets the plan move accepted sessions too. */
  preserveAccepted?: boolean;
  preserveLocked?: boolean;
  /** Dates on which no new study may be placed (a day the student just deferred). */
  blockedDates?: string[];
  /** Keep still-valid upcoming suggestions where they are and solve only the difference (the automatic re-plan). */
  keepSuggestions?: boolean;
  /** With keepSuggestions: the tasks a change touched, planned again instead of kept. */
  replanTaskIds?: ReadonlySet<string>;
  /** With keepSuggestions: let go of no valid suggestion to make room (see PlanWindowOptions.keepAllValid). */
  keepAllValid?: boolean;
}

export interface SemesterPlanResult extends WeekPlanResult {
  /** Number of calendar weeks (Monday to Sunday) the plan covers, starting with the current week. */
  weeksPlanned: number;
  /** The horizon that was planned (endKey rounded up to the end of its week). */
  horizon: PlanningHorizon;
}

export function buildSemesterPlan(state: PlannerState, options: SemesterPlanOptions = {}): SemesterPlanResult {
  const now = options.now ?? new Date();
  const inferred = getPlanningHorizon(state, now);
  const startKey = inferred.startKey;
  const requestedEnd = options.horizonEnd && options.horizonEnd > startKey ? options.horizonEnd : inferred.endKey;
  const weekStartKeys = weekStartsInRange(startKey, requestedEnd);
  const firstWeek = weekStartKeys[0]!;
  const lastWeek = weekStartKeys[weekStartKeys.length - 1]!;

  const plan = planWindow(state, {
    weekStartKeys,
    now,
    preserveAccepted: options.preserveAccepted ?? true,
    preserveLocked: options.preserveLocked ?? true,
    fullHorizon: true,
    // The solver may look at every day of the last week, never past it.
    maxHorizonDays: daysBetweenKeys(firstWeek, lastWeek) + 7,
    blockedDates: options.blockedDates,
    keepSuggestions: options.keepSuggestions,
    replanTaskIds: options.replanTaskIds,
    keepAllValid: options.keepAllValid,
  });

  return {
    ...plan,
    weeksPlanned: weekStartKeys.length,
    horizon: { startKey, endKey: addDaysToKey(lastWeek, 6) },
  };
}
