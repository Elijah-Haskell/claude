// The Week screen's Month view: the month as rows of seven days (Monday first, like the week grids), with what is
// due marked under each day (an exam is a short gold bar; anything else is a dot in its class's colour), then the
// day that is picked: its deadlines, each with how far away it is and how many study sessions are planned before it,
// and how much study is planned that day (click to see the day in the three-day view). Today is outlined.

import { useMemo } from "react";

import { parseHexColor } from "../engine/contrast";
import { alpha } from "../engine/design";
import { classifyTaskKind } from "../engine/task-kind";
import { shortDateLabel, taskBadge } from "../engine/task-list";
import { plannedSessionsFor } from "../engine/task-sessions";
import type { Task } from "../engine/types";
import { dateKeyOf, formatDuration, getDurationMinutes, weekdayOfKey } from "../engine/utils";
import { blockCourseLabel, classOfTask, classShortName, weekdayName } from "../engine/week-layout";
import { countdownBadge, isDeadline, monthCells, termDayNote, type DayMark } from "../engine/week-view";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { CourseChip, DateBadge, MONO_FONT, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

const LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

interface Props {
  /** Any day of the month on screen. */
  anchorKey: string;
  todayKey: string;
  /** The day whose deadlines are listed under the month. */
  selectedKey: string;
  /** The marks under each day (src/engine/week-view.ts monthMarks). */
  marks: Map<string, DayMark[]>;
  onSelect: (dateKey: string) => void;
  onOpenTask: (taskId: string) => void;
  /** "N study sessions that day": look at the day in the three-day view. */
  onOpenDay: (dateKey: string) => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function MonthView({ anchorKey, todayKey, selectedKey, marks, onSelect, onOpenTask, onOpenDay }: Props) {
  const colors = useColors();
  const { state } = useApp();

  const cells = useMemo(() => monthCells(anchorKey), [anchorKey]);
  const classById = useMemo(() => new Map(state.classes.map((cls) => [cls.id, cls])), [state.classes]);

  // The picked day: what is due, and the study planned on it.
  const due = useMemo(() => {
    const tested = (task: Task) => {
      const kind = classifyTaskKind(task);
      return kind === "exam" ? 0 : kind === "quiz" ? 1 : 2;
    };
    return state.tasks.filter((task) => dateKeyOf(task.dueDate ?? "") === selectedKey && isDeadline(task)).sort((a, b) => tested(a) - tested(b) || a.name.localeCompare(b.name));
  }, [state.tasks, selectedKey]);
  const openDue = due.filter((task) => task.status !== "done" && task.status !== "skipped");
  const finished = due.length - openDue.length;
  const sessions = useMemo(
    () => state.scheduleBlocks.filter((block) => block.date === selectedKey && block.type === "study" && block.completionStatus !== "skipped"),
    [state.scheduleBlocks, selectedKey],
  );
  const sessionMinutes = sessions.reduce((sum, block) => sum + Math.max(0, getDurationMinutes(block.startTime, block.endTime)), 0);
  const sessionCourses = useMemo(() => {
    const context = { classes: state.classes, tasks: state.tasks };
    const seen = new Map<string, string | undefined>();
    for (const block of sessions) {
      const label = blockCourseLabel(block, context);
      if (label && !seen.has(label)) seen.set(label, block.color);
    }
    // Two at most: three long ones ("CHEM 101") would push the time off the row.
    return [...seen.entries()].slice(0, 2);
  }, [sessions, state.classes, state.tasks]);

  const dayLabel = `${weekdayOfKey(selectedKey)}, ${shortDateLabel(selectedKey)}`;
  const note = termDayNote(selectedKey, state.semester);
  const spokenDay = (key: string) => `${weekdayName(key)}, ${MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? ""} ${Number(key.slice(8, 10))}`;
  const metaText = { fontSize: 13, lineHeight: "18px", color: colors.muted } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div role="grid" aria-label="Month">
        <div style={{ display: "flex" }} role="row">
          {LETTERS.map((letter, index) => (
            <span key={index} role="columnheader" style={{ flex: 1, height: 24, textAlign: "center", fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 0.7, color: colors.muted }}>{letter}</span>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, row) => (
          <div key={row} style={{ display: "flex" }} role="row">
            {cells.slice(row * 7, row * 7 + 7).map((cell) => {
              const today = cell.key === todayKey;
              const selected = cell.key === selectedKey;
              const dayMarks = marks.get(cell.key) ?? [];
              const exams = dayMarks.filter((mark) => mark.exam).length;
              return (
                <button
                  key={cell.key}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={`${spokenDay(cell.key)}${today ? ", today" : ""}${dayMarks.length > 0 ? `, ${dayMarks.length === 3 ? "3 or more" : dayMarks.length} due${exams > 0 ? `, ${plural(exams, "exam", "exams")}` : ""}` : ""}`}
                  onClick={() => onSelect(cell.key)}
                  className="pressable"
                  style={{ flex: 1, height: 52, marginBottom: 2, borderRadius: 11, border: `1px solid ${selected ? colors.borderStrong : "transparent"}`, background: selected ? colors.surface : "transparent", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 5, gap: 3 }}
                >
                  {/* Today's number sits in an outline (the outline is always there, so no day's number moves). */}
                  <span style={{ width: 30, height: 30, borderRadius: 9, border: `1.5px solid ${today ? colors.accent : "transparent"}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 15, lineHeight: "20px", color: today ? colors.peri : cell.inMonth ? colors.foreground : colors.muted, fontWeight: today || selected ? 700 : 500, opacity: cell.inMonth || today ? 1 : 0.7 }}>{cell.day}</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 3, height: 5 }}>
                    {dayMarks.map((mark, index) =>
                      mark.exam ? (
                        <span key={index} style={{ width: 12, height: 5, borderRadius: 2.5, background: colors.gold }} />
                      ) : (
                        <span key={index} style={{ width: 5, height: 5, borderRadius: 2.5, background: mark.color && parseHexColor(mark.color) ? mark.color : colors.peri }} />
                      ),
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* The picked day */}
      <SectionLabel title={dayLabel} style={{ marginTop: 14, marginBottom: 8 }} right={note ? <span className="truncate" style={{ ...metaText, maxWidth: 190 }}>{note}</span> : undefined} />
      <div className="group">
        {openDue.map((task) => {
          const kind = classifyTaskKind(task);
          const assessment = kind === "exam" || kind === "quiz";
          const cls = classById.get(task.courseId) ?? classOfTask(task, state.classes);
          const className = cls?.name ?? (task.courseName && task.courseName !== "General" ? task.courseName : "");
          const badge = countdownBadge(selectedKey, todayKey) ?? taskBadge(task, todayKey);
          const planned = plannedSessionsFor(task.id, state.scheduleBlocks, state.examPreps, state.tasks).filter((session) => (session.status === "pending" || session.status === "missed") && session.date >= todayKey).length;
          const sub = selectedKey < todayKey ? (assessment ? "Took place" : "Still to do") : planned > 0 ? `${plural(planned, "session", "sessions")} before it` : "No sessions planned";
          return (
            <button key={task.id} type="button" className="row pressable" onClick={() => onOpenTask(task.id)} aria-label={`${task.name}${className ? `, ${className}` : ""}. ${sub}. Opens the task`} style={{ minHeight: 64 }}>
              <span className="well" style={{ background: assessment ? alpha(colors.gold, 0.15) : alpha(colors.peri, 0.12) }}>
                <Icon name={assessment ? "flag" : "file"} size={18} color={assessment ? colors.gold : colors.peri} />
              </span>
              <span className="row-text">
                <span className="row-label clamp2" style={{ display: "block" }}>{task.name}</span>
                <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 7, rowGap: 2, marginTop: 3 }}>
                  {className ? <CourseChip label={classShortName(cls, className) || className} color={cls?.color} /> : null}
                  <span style={metaText}>{sub}</span>
                </span>
              </span>
              <DateBadge label={badge.label} tone={badge.tone} />
            </button>
          );
        })}

        {sessions.length > 0 ? (
          <button type="button" className="row pressable" onClick={() => onOpenDay(selectedKey)} aria-label={`${plural(sessions.length, "study session", "study sessions")} that day, ${formatDuration(sessionMinutes)}. Shows the day`} style={{ minHeight: 64 }}>
            <span className="well" style={{ background: alpha(colors.peri, 0.12) }}>
              <Icon name="clock" size={18} color={colors.peri} />
            </span>
            <span className="row-text">
              <span className="row-label truncate" style={{ display: "block" }}>{plural(sessions.length, "study session", "study sessions")} that day</span>
              <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 7, rowGap: 2, marginTop: 3 }}>
                {sessionCourses.map(([label, color]) => <CourseChip key={label} label={label} color={color} />)}
                <span style={metaText}>{formatDuration(sessionMinutes)}</span>
              </span>
            </span>
            <Icon name="chevronRight" size={18} color={colors.muted} />
          </button>
        ) : null}

        {openDue.length === 0 && sessions.length === 0 ? (
          <div className="row">
            <span style={{ ...metaText, padding: "6px 0" }}>{finished > 0 ? `Everything due this day is done (${finished}).` : "Nothing is due this day, and no study is planned on it."}</span>
          </div>
        ) : null}
      </div>
      {finished > 0 && openDue.length + sessions.length > 0 ? <p className="caption" style={{ marginTop: 10 }}>{plural(finished, "thing", "things")} due this day already done.</p> : null}
      <p className="caption" style={{ marginTop: 10 }}>A dot is something due, in its class's colour. A gold bar is an exam.</p>
    </div>
  );
}
