import type { ScheduleBlock, Task } from "./types";
import { timeToMinutes } from "./utils";

/** Length of a block in minutes (a block that wraps past midnight counts correctly). */
export function blockMinutes(block: Pick<ScheduleBlock, "startTime" | "endTime">): number {
  const diff = timeToMinutes(block.endTime) - timeToMinutes(block.startTime);
  return diff >= 0 ? diff : diff + 24 * 60;
}

/** Minutes of planned work still to do for a task (never negative). */
export function remainingMinutes(task: Pick<Task, "estimatedMinutes" | "completedMinutes">): number {
  return Math.max(0, Math.round(task.estimatedMinutes - (task.completedMinutes ?? 0)));
}

/**
 * Credit a completed study block to its task. The task is only `done` once the
 * completed minutes cover the estimate; until then it stays `scheduled` so the
 * planner keeps placing the remaining minutes. Blocks that do not belong to the
 * task (or are not study blocks) leave the task untouched.
 *
 * The reducer must call this once per pending->done transition of a block, not on
 * every render, or the minutes would be credited twice.
 */
export function applyBlockCompletion(task: Task, block: ScheduleBlock): Task {
  if (block.type !== "study" || block.taskId !== task.id) return task;
  if (task.status === "done" || task.status === "skipped") return task;
  const completedMinutes = (task.completedMinutes ?? 0) + blockMinutes(block);
  const done = completedMinutes >= task.estimatedMinutes;
  return { ...task, completedMinutes, status: done ? "done" : "scheduled" };
}

/**
 * Is this task done BECAUSE its study sessions were ticked off (their minutes cover what it needs)? For an exam that
 * is "finished preparing", not "the exam is over": it stays on Study until its date. A task marked done by hand
 * before its sessions were done is not this (the student said it is over).
 */
export function finishedByStudying(task: Pick<Task, "id" | "status" | "estimatedMinutes">, blocks: readonly Pick<ScheduleBlock, "type" | "taskId" | "completionStatus" | "startTime" | "endTime">[]): boolean {
  if (task.status !== "done" || !(task.estimatedMinutes > 0)) return false;
  const studied = blocks.reduce((sum, block) => (block.type === "study" && block.taskId === task.id && block.completionStatus === "done" ? sum + blockMinutes(block) : sum), 0);
  return studied >= task.estimatedMinutes;
}

/** Undo `applyBlockCompletion` (user un-checks a block). A finished task becomes `scheduled` again. */
export function revertBlockCompletion(task: Task, block: ScheduleBlock): Task {
  if (block.type !== "study" || block.taskId !== task.id) return task;
  const completedMinutes = Math.max(0, (task.completedMinutes ?? 0) - blockMinutes(block));
  const done = completedMinutes >= task.estimatedMinutes;
  return { ...task, completedMinutes, status: done ? "done" : task.status === "done" ? "scheduled" : task.status };
}
