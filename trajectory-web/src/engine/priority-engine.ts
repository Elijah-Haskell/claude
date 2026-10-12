/**
 * Trajectory AI Priority Scoring Engine
 * ======================================
 * Scores each pending task 0–100 based on:
 *   1. Deadline proximity  (40 pts) — exponential urgency curve
 *   2. Difficulty          (20 pts) — harder tasks score higher
 *   3. Importance          (20 pts) — user-set importance level
 *   4. Energy alignment    (10 pts) — matches task difficulty to time-of-day energy
 *   5. Estimated effort    (10 pts) — larger tasks get a slight boost to ensure early scheduling
 *
 * The score is stored on the Task as `priorityScore` and used by the
 * intelligent scheduler to order study blocks.
 */

import { Task } from "./types";
import { dateKeyOf, daysBetweenKeys, localDateKey } from "./utils";
import { remainingMinutes } from "./task-progress";

/**
 * Compute a 0–100 priority score for a single task.
 * @param task  The task to score
 * @param now   Current date (defaults to today)
 */
export function computePriorityScore(task: Task, now: Date = new Date()): number {
  const daysUntilDue = Math.max(0, daysBetweenKeys(localDateKey(now), dateKeyOf(task.dueDate)));

  // ── 1. Deadline proximity (40 pts) ──────────────────────────
  // Exponential urgency: 40 pts when due today, ~20 pts at 3 days, ~5 pts at 14 days
  let deadlineScore: number;
  if (daysUntilDue === 0) {
    deadlineScore = 40;
  } else if (daysUntilDue <= 1) {
    deadlineScore = 36;
  } else if (daysUntilDue <= 3) {
    deadlineScore = 28;
  } else if (daysUntilDue <= 7) {
    deadlineScore = 20;
  } else if (daysUntilDue <= 14) {
    deadlineScore = 10;
  } else if (daysUntilDue <= 30) {
    deadlineScore = 5;
  } else {
    deadlineScore = 2;
  }

  // ── 2. Difficulty (20 pts) ──────────────────────────────────
  // Harder tasks need more lead time → schedule earlier
  const difficultyScore = ((task.difficulty - 1) / 4) * 20; // 0–20

  // ── 3. Importance (20 pts) ──────────────────────────────────
  const importance = task.importance ?? 2; // default medium
  const importanceScore = ((importance - 1) / 2) * 20; // 0–20

  // ── 4. Energy alignment (10 pts) ────────────────────────────
  // Hard tasks (4-5) should be done in the morning; easy tasks (1-2) in the evening.
  // This is a scheduling hint, not a hard constraint. We give a small bonus if the
  // task difficulty is high (meaning it needs prime-time slots).
  const energyScore = task.difficulty >= 4 ? 10 : task.difficulty >= 3 ? 6 : 3;

  // ── 5. Estimated effort (10 pts) ────────────────────────────
  // Large tasks (>120 min) need to be started early to avoid cramming
  const remaining = remainingMinutes(task);
  const effortScore = remaining >= 180 ? 10
    : remaining >= 120 ? 7
    : remaining >= 60 ? 4
    : 2;

  const total = deadlineScore + difficultyScore + importanceScore + energyScore + effortScore + gradeWeightBonus(task);
  return Math.min(100, Math.round(total));
}

/** Most a grade weight can add to a score: enough to break ties toward the work that counts, never enough to outrank a deadline. */
export const MAX_GRADE_WEIGHT_BONUS = 6;

/**
 * Small additive bonus for work that is worth a lot of the course grade (from the syllabus): 1 point per 5% of
 * the grade, up to MAX_GRADE_WEIGHT_BONUS. Tasks without a weight get 0, so existing scores do not change.
 */
export function gradeWeightBonus(task: Pick<Task, "weightPercent">): number {
  const weight = task.weightPercent;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) return 0;
  return Math.min(MAX_GRADE_WEIGHT_BONUS, Math.round(Math.min(100, weight) / 5));
}

/**
 * Compute and attach priority scores to all pending tasks.
 * Returns a new array — does not mutate inputs.
 */
export function scoreTasks(tasks: Task[], now: Date = new Date()): Task[] {
  return tasks.map((t) => {
    if (t.status === "done") return t;
    return { ...t, priorityScore: computePriorityScore(t, now) };
  });
}

/**
 * Sort tasks by priority score descending (highest first).
 */
export function sortByPriority(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
}

/**
 * Get a human-readable priority label for a score.
 */
export function getPriorityLabel(score: number): { label: string; color: string } {
  if (score >= 70) return { label: "Critical", color: "#EF4444" };
  if (score >= 50) return { label: "High", color: "#F59E0B" };
  if (score >= 30) return { label: "Medium", color: "#0a7ea4" };
  return { label: "Low", color: "#687076" };
}
