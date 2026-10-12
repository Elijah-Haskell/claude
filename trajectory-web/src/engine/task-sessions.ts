/**
 * The study sessions the plan gave one task, for the task's sheet (pure, unit-tested).
 *
 * A session belongs to a task through its `taskId`. An exam or quiz that has an exam prep is planned through the
 * prep's own study task (lib/exam-prep-link.ts), so those sessions count as the exam's too.
 */
import { findExamTask, runwayTaskId } from "./exam-prep-link";
import type { ExamPrep, ScheduleBlock, Task } from "./types";
import { getDurationMinutes } from "./utils";

export interface PlannedSession {
  /** The block's id. */
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  status: ScheduleBlock["completionStatus"];
  /** 1-based place among the task's sessions in time order ("Session 2 of 3"). */
  position: number;
}

/**
 * The task's sessions: what is still to do first (soonest first, a missed one included), then what is settled
 * (done or skipped, most recent first). `position` is always the place in time order.
 */
export function plannedSessionsFor(
  taskId: string,
  blocks: readonly Pick<ScheduleBlock, "id" | "type" | "taskId" | "date" | "startTime" | "endTime" | "completionStatus">[],
  examPreps: readonly Pick<ExamPrep, "id" | "classId" | "examDate" | "examTaskId">[] = [],
  tasks: readonly Task[] = [],
): PlannedSession[] {
  const ids = new Set([taskId]);
  for (const prep of examPreps) {
    if (findExamTask(prep, tasks)?.id === taskId) ids.add(runwayTaskId(prep.id));
  }
  const inOrder = blocks
    .filter((block) => block.type === "study" && block.taskId !== undefined && ids.has(block.taskId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    .map((block, index): PlannedSession => ({
      id: block.id,
      date: block.date,
      startTime: block.startTime,
      endTime: block.endTime,
      minutes: Math.max(0, getDurationMinutes(block.startTime, block.endTime)),
      status: block.completionStatus,
      position: index + 1,
    }));
  const settled = (session: PlannedSession) => session.status === "done" || session.status === "skipped";
  return [...inOrder.filter((session) => !settled(session)), ...inOrder.filter(settled).reverse()];
}
