// What a block IS, for colouring it the way trajectoryapp.org does: the website's week grid colours by kind
// (class = blue, assignment work = violet, study = periwinkle, exam = gold, recurring = dashed grey), not by
// course. The course stays visible as a small coloured dot. Pure (no React) so it is unit-tested.

import type { BlockKind } from "./design";
import { classifyTaskKind } from "./task-kind";
import type { ScheduleBlock, Task } from "./types";

/** null = not drawn as a block (sleep, buffer). */
export function blockKindOf(block: Pick<ScheduleBlock, "type" | "taskId" | "title">, task?: Pick<Task, "name" | "kind">): BlockKind | null {
  switch (block.type) {
    case "class":
      return "class";
    case "recurring":
    case "work":
      return "recurring";
    case "free":
      // Social / personal events the student adds (and meals or workouts from the AI).
      return "personal";
    case "study": {
      const kind = task ? classifyTaskKind(task) : classifyTaskKind({ name: block.title, kind: undefined });
      // Work on a deliverable (homework, paper, project) reads as "assignment work"; preparation for an
      // exam, quiz or reading reads as study.
      return kind === "assignment" || kind === "project" ? "task" : "study";
    }
    default:
      return null;
  }
}

/**
 * Legend rows in the website's order and wording. Whether a session may still move is its outline, not its kind
 * (the Week legend adds "Flexible (may move)" and "Kept" swatches).
 */
export const KIND_LEGEND: Array<{ kind: BlockKind; label: string }> = [
  { kind: "class", label: "Class" },
  { kind: "task", label: "Assignment work" },
  { kind: "study", label: "Study" },
  { kind: "exam", label: "Exam" },
  { kind: "recurring", label: "Recurring" },
  { kind: "personal", label: "Personal" },
];

/** Exams and quizzes due on a date, for the gold deadline markers on the Week grid and Today. */
export function examDeadlinesOn<T extends Pick<Task, "name" | "kind" | "dueDate" | "status">>(tasks: readonly T[], dateKey: string): T[] {
  return tasks.filter((task) => {
    if (task.dueDate !== dateKey || task.status === "done") return false;
    const kind = classifyTaskKind(task);
    return kind === "exam" || kind === "quiz";
  });
}
