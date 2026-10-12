// Tasks — the third screen: everything with a due date, in one list.
// Top to bottom: how much is left ("58 to do · 1 due this week") over the title; a search box; a switch between
// "By date" and "By class"; then plain groups (src/engine/task-list.ts): Overdue, Past quizzes and exams, This week,
// Next week, Later and Done by date, or one group per class. A row is a tick box, the name (a gold flag marks a quiz
// or an exam), the class as a small tag with the time it needs, and ONE badge that says how close it is (quiet, gold
// inside a week, red for today, tomorrow and overdue). Clicking a row opens the task's sheet. What needs a look is
// said on the row itself ("Needs ~2 more hours to fit before the deadline"); the Overdue group offers "Catch up" (the
// Replan sheet for the whole semester). Adding is the add button at the end of the tab bar.

import { memo, useCallback, useMemo, useState } from "react";

import { legibleOn } from "../engine/contrast";
import { alpha } from "../engine/design";
import { currentSolverShortfalls } from "../engine/plan-alerts";
import { describeMoreTime } from "../engine/plan-format";
import { classifyTaskKind } from "../engine/task-kind";
import { groupTasksByClass, groupTasksByDate, matchesTaskSearch, taskBadge, tasksSummary, type TaskBadge } from "../engine/task-list";
import type { Task } from "../engine/types";
import { formatDuration, todayString } from "../engine/utils";
import { classOfTask, classShortName } from "../engine/week-layout";
import { useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { useGlobalModal } from "../state/modal-context";
import { Icon, IconWell } from "../ui/icon";
import { Card, CheckBox, CourseChip, DateBadge, MONO_FONT, PrimaryButton, ScreenHeader, SectionLabel, Segmented } from "../ui/primitives";
import { useColors } from "../ui/theme";

type Mode = "date" | "class";

interface TaskSection {
  key: string;
  title: string;
  color?: string;
  total: number;
  folded: boolean;
  data: Task[];
}

// ── A row ─────────────────────────────────────────────────────

const TaskRow = memo(function TaskRow({ task, chip, chipColor, badge, shortBy, onToggle, onOpen }: {
  task: Task;
  /** The class as a short tag; absent in a by-class group (its header says it) and for work with no class. */
  chip?: string;
  chipColor?: string;
  badge: TaskBadge;
  /** Minutes the plan cannot fit before this task's deadline. */
  shortBy?: number;
  onToggle: (taskId: string) => void;
  onOpen: (taskId: string) => void;
}) {
  const colors = useColors();
  const closed = task.status === "done" || task.status === "skipped";
  const kind = classifyTaskKind(task);
  const assessment = kind === "exam" || kind === "quiz";
  const short = !closed && shortBy !== undefined && shortBy > 0;
  const course = task.courseName && task.courseName !== "General" ? task.courseName : "no class";

  return (
    <div className="row" style={{ paddingLeft: 2, paddingRight: 0, gap: 0, minHeight: 62 }}>
      <CheckBox checked={task.status === "done"} onPress={() => onToggle(task.id)} ariaLabel={task.status === "done" ? `${task.name}, done. Tick to undo` : `Mark ${task.name} done`} />
      <button
        type="button"
        className="pressable"
        onClick={() => onOpen(task.id)}
        aria-label={`${task.name}, ${course}, ${formatDuration(task.estimatedMinutes)}, ${badge.spoken}${short ? `. Needs ${describeMoreTime(shortBy!)} to fit before the deadline` : ""}. Opens the task`}
        style={{ flex: 1, minWidth: 0, minHeight: 60, display: "flex", alignItems: "center", gap: 10, padding: "9px 12px 9px 8px", textAlign: "left" }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {assessment ? <Icon name="flag" size={16} color={closed ? colors.muted : colors.gold} strokeWidth={2} /> : null}
            <span className="clamp2" style={{ flexShrink: 1, fontSize: 16, lineHeight: "21px", fontWeight: 500, color: closed ? colors.muted : colors.foreground, textDecoration: closed ? "line-through" : "none" }}>{task.name}</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3 }}>
            {chip ? <CourseChip label={chip} color={chipColor} /> : null}
            <span className="truncate" style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{formatDuration(task.estimatedMinutes)}</span>
          </span>
          {short ? <span style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 3, color: colors.error }}>Needs {describeMoreTime(shortBy!)} to fit before the deadline</span> : null}
        </span>
        <DateBadge label={badge.label} tone={badge.tone} />
      </button>
    </div>
  );
});

// ── The screen ────────────────────────────────────────────────

export function TasksScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const { state, dispatch } = useApp();
  const { openReplan, openAdd, openTask } = useGlobalModal();
  const [mode, setMode] = useState<Mode>("date");
  const [query, setQuery] = useState("");
  // Finished work starts folded away.
  const [showDone, setShowDone] = useState(false);
  const today = todayString();

  const shortByTask = useMemo(
    () => new Map(currentSolverShortfalls(state).map((shortfall) => [shortfall.taskId, shortfall.missingMinutes])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.tasks, state.planAlerts],
  );
  const classById = useMemo(() => new Map(state.classes.map((cls) => [cls.id, cls])), [state.classes]);

  const searching = query.trim().length > 0;
  const sections = useMemo<TaskSection[]>(() => {
    const found = searching ? state.tasks.filter((task) => matchesTaskSearch(task, query)) : state.tasks;
    const groups = mode === "date" ? groupTasksByDate(found, today) : groupTasksByClass(found, state.classes);
    return groups.map((group) => {
      // Only Done folds, and a search looks inside it too.
      const folded = group.key === "done" && !showDone && !searching;
      return { key: group.key, title: group.title, color: group.color, total: group.tasks.length, folded, data: folded ? [] : group.tasks };
    });
  }, [state.tasks, state.classes, mode, query, searching, showDone, today]);

  const handleToggle = useCallback((taskId: string) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (task.status === "done") dispatch({ type: "UPDATE_TASK", payload: { ...task, status: "pending" } });
    else dispatch({ type: "COMPLETE_TASK", payload: taskId });
  }, [state.tasks, dispatch]);

  const count = (section: TaskSection) => <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 600, color: colors.muted }}>{section.total}</span>;
  const link = { display: "inline-flex", alignItems: "center", gap: 6, minHeight: 24, fontSize: 14, lineHeight: "19px", fontWeight: 600, color: colors.peri } as const;

  return (
    <div className="screen">
      <ScreenHeader eyebrow={tasksSummary(state.tasks, today)} title="Tasks" />
      <div style={{ display: "flex", alignItems: "center", gap: 10, height: 46, borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.panel, paddingLeft: 14, paddingRight: 6 }}>
        <Icon name="search" size={18} color={colors.muted} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks"
          aria-label="Search tasks"
          autoCorrect="off"
          autoCapitalize="none"
          style={{ flex: 1, minWidth: 0, height: 44, fontSize: 16, background: "transparent", border: "none", outline: "none", color: colors.foreground }}
        />
        {searching ? (
          <button type="button" aria-label="Clear the search" onClick={() => setQuery("")} style={{ width: 32, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={16} color={colors.muted} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "date", label: "By date", ariaLabel: "Group by due date" },
          { value: "class", label: "By class", ariaLabel: "Group by class" },
        ]}
      />

      {sections.length === 0 ? (
        state.tasks.length === 0 ? (
          <Card tone="surface" radiusSize={16} style={{ marginTop: 8, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
            <IconWell name="list" color={colors.peri} background={alpha(colors.peri, 0.12)} size={44} />
            <div style={{ fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.4, color: colors.foreground }}>No tasks yet</div>
            <div style={{ fontSize: 14, lineHeight: "20px", color: colors.muted }}>Add an assignment or a reading, or paste in a syllabus and Trajectory lists every deadline in it.</div>
            <PrimaryButton label="Add a task" fullWidth left={<Icon name="plus" size={18} color="#fff" strokeWidth={2.2} />} onPress={() => openAdd({ kind: "task" })} />
            <PrimaryButton label="Add a syllabus" tone="ghost" fullWidth left={<Icon name="upload" size={17} color={colors.foreground} />} onPress={() => navigate("syllabus")} />
          </Card>
        ) : (
          <div style={{ marginTop: 28, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 14, lineHeight: "20px", color: colors.muted }}>No task matches “{query.trim()}”.</div>
            <button type="button" className="link" onClick={() => setQuery("")} style={link}>Clear the search</button>
          </div>
        )
      ) : (
        sections.map((section) => (
          <section key={section.key} aria-label={section.title}>
            <SectionLabel
              title={section.title}
              color={section.key === "overdue" ? colors.error : section.color ? legibleOn(section.color, colors.background, 5.5) : undefined}
              style={{ marginTop: 8, marginBottom: 8 }}
              right={
                section.key === "overdue" ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                    {/* Overdue work: "Catch up" previews replanning the semester around it (the Replan sheet). */}
                    <button type="button" className="link" onClick={() => openReplan({ scope: "semester" })} aria-label="Catch up: preview replanning the semester around your overdue work" style={link}>
                      <Icon name="bolt" size={15} color={colors.gold} />
                      Catch up
                    </button>
                    {count(section)}
                  </span>
                ) : section.key === "done" && !searching ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                    <button type="button" className="link" onClick={() => setShowDone((shown) => !shown)} aria-expanded={!section.folded} aria-label={section.folded ? `Show the ${section.total} finished` : "Hide finished work"} style={link}>
                      {section.folded ? "Show" : "Hide"}
                    </button>
                    {count(section)}
                  </span>
                ) : (
                  count(section)
                )
              }
            />
            {section.data.length > 0 ? (
              <div className="group">
                {section.data.map((item) => {
                  const cls = classById.get(item.courseId) ?? classOfTask(item, state.classes);
                  const named = item.courseName && item.courseName !== "General" ? item.courseName : "";
                  const chip = mode === "date" ? classShortName(cls, named) : "";
                  return <TaskRow key={item.id} task={item} chip={chip || undefined} chipColor={cls?.color} badge={taskBadge(item, today)} shortBy={shortByTask.get(item.id)} onToggle={handleToggle} onOpen={openTask} />;
                })}
              </div>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}
