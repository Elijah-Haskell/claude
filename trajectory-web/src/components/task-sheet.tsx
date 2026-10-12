// A task's sheet, opened by clicking its row on Tasks (or a deadline on Today, Week and Month).
//
// Look: the class as a small tag and its name, the task's name as the title (edit it to rename), the close button;
// one group with what the planner needs (when it is due, how long it takes, how hard it is); then "Planned": the
// study sessions the plan gave it, each with its tick box (click one to open it); Save; and Delete as a quiet red
// line. A change that would move study sessions is PREVIEWED first in the same sheet (what moves, what no longer
// fits); "Save & apply" then saves the task and the new plan together, undoable until the next change.

import { useCallback, useEffect, useMemo, useState } from "react";

import { previewTaskEdit } from "../engine/app-context";
import { alpha } from "../engine/design";
import { relativeDayLabel } from "../engine/due-label";
import { currentSolverShortfalls } from "../engine/plan-alerts";
import { describeMoreTime } from "../engine/plan-format";
import { shortDateLabel } from "../engine/task-list";
import { plannedSessionsFor, type PlannedSession } from "../engine/task-sessions";
import type { Task } from "../engine/types";
import { dateKeyOf, formatDuration, formatTime, localDateKey } from "../engine/utils";
import { classOfTask, classShortName } from "../engine/week-layout";
import { useApp } from "../state/app-provider";
import { useReplanFlow } from "../state/use-replan-flow";
import { Icon } from "../ui/icon";
import { CheckBox, CloseButton, CourseChip, DateInput, FieldGroup, FieldLabel, FieldRow, InlineConfirm, PrimaryButton, Segmented, Stepper } from "../ui/primitives";
import { Sheet, SheetBody } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { BlockSheet } from "./block-sheet";
import { ReplanPreviewBody } from "./replan-preview";

const DIFFICULTY_WORDS = ["", "Easy", "Medium", "Hard", "Very hard", "Brutal"] as const;
const STEP_MINUTES = 15;
const MAX_MINUTES = 24 * 60;
/** Sessions listed before "and N more". */
const SESSIONS_SHOWN = 5;

const capitalized = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1) : word);

interface Props {
  task: Task | null;
  /** Minutes the plan cannot fit before this task's deadline. */
  shortBy?: number;
  onClose: () => void;
  onDelete: (taskId: string) => void;
  /** Open one of its sessions (the caller closes this sheet first). */
  onOpenSession: (blockId: string) => void;
}

export function TaskSheet({ task, shortBy, onClose, onDelete, onOpenSession }: Props) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const flow = useReplanFlow();
  const todayKey = localDateKey(new Date());

  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [difficulty, setDifficulty] = useState<Task["difficulty"]>(3);
  const [difficultyOpen, setDifficultyOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Every opening starts from the task as it is saved.
  const taskId = task?.id ?? null;
  useEffect(() => {
    if (!task) return;
    setName(task.name);
    setDueDate(dateKeyOf(task.dueDate ?? ""));
    setMinutes(task.estimatedMinutes);
    setDifficulty(task.difficulty);
    setDifficultyOpen(false);
    setTried(false);
    setConfirmingDelete(false);
    flow.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const sessions = useMemo<PlannedSession[]>(
    () => (task ? plannedSessionsFor(task.id, state.scheduleBlocks, state.examPreps, state.tasks) : []),
    [task, state.scheduleBlocks, state.examPreps, state.tasks],
  );

  if (!task) return null;

  const cls = classOfTask(task, state.classes);
  const className = cls?.name ?? (task.courseName && task.courseName !== "General" ? task.courseName : "");
  const doneMinutes = task.completedMinutes ?? 0;
  const error = !name.trim() ? "Give the task a name" : !shortDateLabel(dueDate) ? "Pick a due date" : null;
  const short = shortBy !== undefined && shortBy > 0 && task.status !== "done";

  function save() {
    if (!task) return;
    if (error) {
      setTried(true);
      return;
    }
    const patch: Partial<Task> = { name: name.trim(), dueDate, estimatedMinutes: minutes, difficulty };
    const replans = dueDate !== dateKeyOf(task.dueDate ?? "") || minutes !== task.estimatedMinutes || difficulty !== task.difficulty;
    if (!replans && patch.name === task.name) {
      onClose();
      return;
    }
    // Only a change that moves study sessions needs a preview; anything else saves straight away.
    const preview = replans ? previewTaskEdit(state, task.id, patch) : null;
    if (preview && (preview.diff.changed || preview.shortfalls.length > 0)) {
      const id = task.id;
      flow.open((current, now) => previewTaskEdit(current, id, patch, now) ?? preview);
      return;
    }
    dispatch({ type: "UPDATE_TASK", payload: { ...task, ...patch } });
    onClose();
  }

  function toggleSession(session: PlannedSession) {
    dispatch({ type: session.status === "done" ? "UNCOMPLETE_BLOCK" : "COMPLETE_BLOCK", payload: session.id });
  }

  const shown = sessions.slice(0, SESSIONS_SHOWN);
  const hidden = sessions.length - shown.length;

  return (
    <Sheet open onClose={flow.preview ? flow.cancel : onClose} ariaLabel={task.name}>
      {flow.preview ? (
        <ReplanPreviewBody
          title={dueDate !== dateKeyOf(task.dueDate ?? "") ? `Due ${shortDateLabel(dueDate)}: here's what moves` : "Here's what moves"}
          summary={flow.preview.summary}
          diff={flow.preview.diff}
          shortfalls={flow.preview.shortfalls}
          applyLabel="Save & apply"
          next={flow.preview.next}
          onApply={() => { if (flow.apply()) onClose(); }}
          onCancel={flow.cancel}
        />
      ) : (
        <SheetBody>
          {/* The class, the name (edit to rename), and the close button */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                {className ? <CourseChip label={classShortName(cls, className) || className} color={cls?.color} /> : null}
                <span className="truncate" style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{className || "Task"}</span>
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Task name"
                aria-label="Task name"
                title="Edit to rename the task"
                style={{ width: "100%", background: "transparent", border: "none", padding: "2px 0", fontSize: 22, lineHeight: "27px", fontWeight: 700, letterSpacing: -0.4, color: colors.foreground, outline: "none" }}
              />
            </div>
            <CloseButton onPress={onClose} />
          </div>

          {short ? (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: 12, border: `1px solid ${alpha(colors.error, 0.4)}`, background: alpha(colors.error, 0.1) }}>
              <Icon name="warning" size={18} color={colors.error} />
              <span style={{ flex: 1, fontSize: 14, lineHeight: "19px", color: colors.foreground }}>
                This needs {describeMoreTime(shortBy!)} than the plan can find before it is due. Move the date or shorten the time.
              </span>
            </div>
          ) : null}

          <FieldGroup>
            <FieldRow first icon="cal" label="Due">
              <DateInput ariaLabel="Due date" value={dueDate} onChange={setDueDate} />
            </FieldRow>
            <FieldRow icon="clock" label="Time needed" detail={doneMinutes > 0 ? `${formatDuration(doneMinutes)} done so far` : undefined}>
              <Stepper
                value={formatDuration(minutes)}
                lessLabel="15 minutes less"
                moreLabel="15 minutes more"
                lessDisabled={minutes <= STEP_MINUTES}
                moreDisabled={minutes >= MAX_MINUTES}
                onLess={() => setMinutes((value) => Math.max(STEP_MINUTES, value - STEP_MINUTES))}
                onMore={() => setMinutes((value) => Math.min(MAX_MINUTES, value + STEP_MINUTES))}
              />
            </FieldRow>
            <button type="button" className="row pressable" aria-expanded={difficultyOpen} aria-label={`Difficulty: ${DIFFICULTY_WORDS[difficulty]}. Change it`} onClick={() => setDifficultyOpen((open) => !open)} style={{ justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="well" style={{ background: alpha(colors.peri, 0.12) }}>
                  <Icon name="gauge" size={18} color={colors.peri} />
                </span>
                <span className="row-label">Difficulty</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.peri }}>{DIFFICULTY_WORDS[difficulty]}</span>
                <Icon name={difficultyOpen ? "chevronDown" : "chevronRight"} size={18} color={colors.muted} />
              </span>
            </button>
            {difficultyOpen ? (
              <div style={{ padding: "0 14px 12px" }}>
                <Segmented
                  options={([1, 2, 3, 4, 5] as const).map((level) => ({ value: String(level), label: String(level), ariaLabel: `Difficulty ${level}: ${DIFFICULTY_WORDS[level]}` }))}
                  value={String(difficulty)}
                  onChange={(value) => setDifficulty(Number(value) as Task["difficulty"])}
                />
              </div>
            ) : null}
          </FieldGroup>

          {/* The study sessions the plan gave this task */}
          <div>
            <FieldLabel>Planned</FieldLabel>
            {sessions.length === 0 ? (
              <div className="card" style={{ padding: "14px" }}>
                <span style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>
                  {task.status === "done" || task.status === "skipped"
                    ? "No study sessions: this one is finished."
                    : "No study sessions yet. Trajectory adds them when it next updates the plan."}
                </span>
              </div>
            ) : (
              <FieldGroup>
                {shown.map((session) => {
                  const settled = session.status === "done" || session.status === "skipped";
                  const when = `${capitalized(relativeDayLabel(session.date, todayKey))}, ${formatTime(session.startTime)} – ${formatTime(session.endTime)}`;
                  const detail = session.status === "done" ? "Done" : session.status === "skipped" ? "Skipped" : session.status === "missed" ? "Missed" : sessions.length === 1 ? formatDuration(session.minutes) : `Session ${session.position} of ${sessions.length} · ${formatDuration(session.minutes)}`;
                  return (
                    <div key={session.id} className="row" style={{ paddingLeft: 2, paddingRight: 12, gap: 0 }}>
                      <CheckBox checked={session.status === "done"} onPress={session.status === "skipped" ? undefined : () => toggleSession(session)} ariaLabel={session.status === "done" ? `${when}, done. Tick to undo` : `Mark the session ${when} done`} />
                      <button type="button" className="pressable" onClick={() => onOpenSession(session.id)} aria-label={`${when}. ${detail}. Open the session`} style={{ flex: 1, minWidth: 0, minHeight: 58, display: "flex", alignItems: "center", gap: 8, padding: "8px 0 8px 8px", textAlign: "left" }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="truncate" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 500, color: settled ? colors.muted : colors.foreground, textDecoration: settled ? "line-through" : "none" }}>{when}</span>
                          <span className="truncate" style={{ display: "block", fontSize: 13, lineHeight: "18px", color: session.status === "missed" ? colors.gold : colors.muted }}>{detail}</span>
                        </span>
                        <Icon name="chevronRight" size={18} color={colors.muted} />
                      </button>
                    </div>
                  );
                })}
              </FieldGroup>
            )}
            {hidden > 0 ? <p className="caption" style={{ marginTop: 8 }}>And {hidden} more {hidden === 1 ? "session" : "sessions"} later on. Week shows them all.</p> : null}
          </div>

          {tried && error ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{error}</p> : null}
          <PrimaryButton size="lg" fullWidth label="Save" onPress={save} ariaLabel="Save the task" />
          {confirmingDelete ? (
            <InlineConfirm question="Delete this task? This cannot be undone." confirmLabel="Delete" onConfirm={() => onDelete(task.id)} onCancel={() => setConfirmingDelete(false)} />
          ) : (
            <button type="button" className="link" onClick={() => setConfirmingDelete(true)} aria-label="Delete task" style={{ minHeight: 44, alignSelf: "center", color: colors.error, fontSize: 15, fontWeight: 600, marginTop: -6 }}>
              Delete task
            </button>
          )}
        </SheetBody>
      )}
    </Sheet>
  );
}

/**
 * The task's sheet wherever a task can be opened: give it the id of the task to show, or null. It brings what goes
 * with the sheet: how much the plan is short for the task, the question before a delete, and opening one of the
 * task's sessions (this sheet closes first, then the session's opens).
 */
export function TaskSheetHost({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { state, dispatch } = useApp();
  const [sessionBlockId, setSessionBlockId] = useState<string | null>(null);

  const task = taskId ? state.tasks.find((candidate) => candidate.id === taskId) ?? null : null;
  const shortBy = useMemo(
    () => (taskId ? currentSolverShortfalls(state).find((shortfall) => shortfall.taskId === taskId)?.missingMinutes : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskId, state.tasks, state.planAlerts],
  );
  const sessionExists = sessionBlockId !== null && state.scheduleBlocks.some((block) => block.id === sessionBlockId);

  const deleteTask = useCallback((id: string) => {
    dispatch({ type: "DELETE_TASK", payload: id });
    onClose();
  }, [dispatch, onClose]);

  const openSession = useCallback((blockId: string) => {
    onClose();
    setSessionBlockId(blockId);
  }, [onClose]);

  return (
    <>
      <TaskSheet task={task} shortBy={shortBy} onClose={onClose} onDelete={deleteTask} onOpenSession={openSession} />
      {sessionBlockId && sessionExists ? <BlockSheet blockId={sessionBlockId} onClose={() => setSessionBlockId(null)} /> : null}
    </>
  );
}
