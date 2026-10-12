// ============================================================
// AI-assistant schedule changes: a pending change object (pure)
// ============================================================
// The assistant may PROPOSE tasks, events, classes, recurring commitments, edits to existing blocks, new due dates
// for existing tasks and a new sleep window. It never changes the schedule itself: the proposal becomes an `AssistantChange`, is applied to a
// COPY of the state (`applyAssistantChange`), previewed against what the student has now (`previewAssistantChange`)
// and only then applied for real with an undo snapshot (APPLY_REPLAN in lib/app-context.tsx).

import type { AppState, ClassBlock, HealthPreferences, RecurringEvent, ScheduleBlock, Task } from "./types";
import { previewPlanChange, ReplanPreview } from "./replan";
import { scoreTasks } from "./priority-engine";
import { followExamDates } from "./exam-prep-link";

export interface BlockEdit {
  id: string;
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}

export interface RecurringEdit {
  id: string;
  startTime?: string;
  endTime?: string;
  days?: RecurringEvent["days"];
}

/** A new due date (and optional time) for an existing task, as proposed by the chat ("deadline" answers). */
export interface DeadlineChange {
  taskId: string;
  dueDate: string;
  dueTime?: string;
}

export interface AssistantChange {
  /** Short label for the preview title and the Undo snackbar ("Add 2 tasks"). */
  label: string;
  newTasks?: Task[];
  newBlocks?: ScheduleBlock[];
  newClasses?: ClassBlock[];
  newRecurringEvents?: RecurringEvent[];
  blockEdits?: BlockEdit[];
  recurringEdits?: RecurringEdit[];
  sleepUpdate?: Partial<Pick<HealthPreferences, "wakeTime" | "bedtime">>;
  deadlineChanges?: DeadlineChange[];
}

const same = (a: string, b: string) => a.toLowerCase().trim() === b.toLowerCase().trim();

/** True when the change would not alter anything. */
export function isEmptyChange(change: AssistantChange): boolean {
  return !(
    change.newTasks?.length || change.newBlocks?.length || change.newClasses?.length || change.newRecurringEvents?.length ||
    change.blockEdits?.length || change.recurringEdits?.length || change.sleepUpdate?.wakeTime || change.sleepUpdate?.bedtime ||
    change.deadlineChanges?.length
  );
}

/**
 * The tasks with their due dates moved. Pure: neither `tasks` nor any task is modified; unchanged tasks are
 * returned as the same objects. Unknown ids are ignored. A moved task counts as a date the student gave
 * (dateConfidence "user", syllabus evidence dropped), and a "not before" hint that would now fall after the new
 * due date is cleared. An exam's prep study task moves with its exam (lib/exam-prep-link.ts; one saved before links
 * existed is matched to the exam's old date here). The sessions are not touched here: the app re-plans around the
 * new dates afterwards.
 */
export function applyDeadlineChanges<T extends Task>(tasks: readonly T[], changes: readonly DeadlineChange[]): T[] {
  const byId = new Map(changes.map((change) => [change.taskId, change]));
  const moved = tasks.map((task) => {
    const change = byId.get(task.id);
    if (!change) return task;
    const next: T = { ...task, dueDate: change.dueDate, dateConfidence: "user" };
    if (change.dueTime) next.dueTime = change.dueTime;
    delete next.dateEvidence;
    if (next.notBeforeDate && next.notBeforeDate > change.dueDate) delete next.notBeforeDate;
    return next;
  });
  return followExamDates(moved, tasks);
}

/**
 * The state with the change applied. Pure: `state` is not modified.
 *  - Edited blocks are locked and marked as the student's decision, so no later plan moves them.
 *  - A proposed event that duplicates an edited block (the assistant sometimes returns both) or a block that
 *    already exists (same title, date and start) is skipped.
 */
export function applyAssistantChange(state: AppState, change: AssistantChange): AppState {
  const edits = new Map((change.blockEdits ?? []).map((edit) => [edit.id, edit]));
  const editedBlocks = state.scheduleBlocks.filter((block) => edits.has(block.id));
  const scheduleBlocks = state.scheduleBlocks.map((block) => {
    const edit = edits.get(block.id);
    if (!edit) return block;
    return {
      ...block,
      locked: true,
      accepted: true,
      userEdited: true,
      ...(edit.startTime ? { startTime: edit.startTime } : {}),
      ...(edit.endTime ? { endTime: edit.endTime } : {}),
      ...(edit.date ? { date: edit.date } : {}),
      ...(edit.title ? { title: edit.title } : {}),
    };
  });

  const seen = [...scheduleBlocks];
  const addedBlocks: ScheduleBlock[] = [];
  for (const block of change.newBlocks ?? []) {
    const duplicatesEdit = editedBlocks.some((edited) => edited.date === block.date && same(edited.title, block.title));
    const alreadyThere = seen.some((existing) => existing.date === block.date && same(existing.title, block.title) && existing.startTime === block.startTime);
    if (duplicatesEdit || alreadyThere) continue;
    addedBlocks.push(block);
    seen.push(block);
  }

  const recurringEdits = new Map((change.recurringEdits ?? []).map((edit) => [edit.id, edit]));
  const recurringEvents = [
    ...state.recurringEvents.map((event) => {
      const edit = recurringEdits.get(event.id);
      if (!edit) return event;
      return {
        ...event,
        ...(edit.startTime ? { startTime: edit.startTime } : {}),
        ...(edit.endTime ? { endTime: edit.endTime } : {}),
        ...(edit.days ? { days: edit.days } : {}),
      };
    }),
    ...(change.newRecurringEvents ?? []),
  ];

  const sleep = change.sleepUpdate;
  const healthPrefs = sleep && (sleep.wakeTime || sleep.bedtime)
    ? { ...state.healthPrefs, ...(sleep.wakeTime ? { wakeTime: sleep.wakeTime } : {}), ...(sleep.bedtime ? { bedtime: sleep.bedtime } : {}) }
    : state.healthPrefs;

  const tasks = change.deadlineChanges?.length ? applyDeadlineChanges(state.tasks, change.deadlineChanges) : state.tasks;

  return {
    ...state,
    tasks: change.newTasks?.length ? [...tasks, ...scoreTasks(change.newTasks)] : tasks,
    scheduleBlocks: [...scheduleBlocks, ...addedBlocks],
    classes: change.newClasses?.length ? [...state.classes, ...change.newClasses] : state.classes,
    recurringEvents: change.recurringEdits?.length || change.newRecurringEvents?.length ? recurringEvents : state.recurringEvents,
    healthPrefs,
  };
}

/**
 * What applying the change would do, without doing it. By default the whole semester is re-planned around the
 * change (new tasks get their sessions, a changed commitment moves the sessions it collides with) and the preview
 * lists every session that would be added, removed or moved. `replan: false` previews just the raw edit.
 */
export function previewAssistantChange(
  state: AppState,
  change: AssistantChange,
  options: { now?: Date; replan?: boolean } = {},
): ReplanPreview {
  return previewPlanChange(state, applyAssistantChange(state, change), { now: options.now, label: change.label, replan: options.replan });
}
