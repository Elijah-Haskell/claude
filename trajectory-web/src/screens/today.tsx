// Today — the first screen, and where the app opens.
// Top to bottom: the date eyebrow and "Today"; the week as a strip of dates (click a day to look at it); on the day a
// syllabus was planned, the green "Your semester is planned" card with its undo, and until it is done or hidden the
// short "Make it fit your life" list; ONE gold deadline card; then the day in order under one label ("3 sessions ·
// 2h 40m", with the Replan link): study sessions with a tick box (dashed while the plan may still move them), classes
// with their colour as a bar, commitments muted. A session is finished by ticking its box. Under the day: the undo
// row, then one "Heads up" tile that gathers every contextual notice: the plan status card (behind plan, overdue
// work, quizzes to record, work short on time), today's workload, no-study zones, other exams and the syllabus nudge.
// Every replan goes through the single Replan sheet; the one exception is the workload card's "Move N to tomorrow",
// which previews moving exactly the N sessions it names.
// Before any class or task exists the day's list gives way to one card: "Start with your syllabus".

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { runReplan, type ScopedReplanPreview } from "../engine/app-context";
import { legibleOn, parseHexColor } from "../engine/contrast";
import { doNotScheduleConflicts } from "../engine/day-conflicts";
import { daySessions, weekStripDays } from "../engine/day-strip";
import { alpha, glow } from "../engine/design";
import { blockDueLabel, relativeDayLabel } from "../engine/due-label";
import { runwayTaskId, withLinkedExam } from "../engine/exam-prep-link";
import { planStatusFor } from "../engine/plan-alerts";
import { parseSetupRecap, recapDetailLines, recapIsCurrent, recapLine, recapNotesLabel, recapTitle, setupChecklist, setupProgress, showsSetupList } from "../engine/setup-recap";
import { classifyTaskKind } from "../engine/task-kind";
import type { AppState, ScheduleBlock, Task } from "../engine/types";
import { daysBetweenKeys, dateKeyOf, formatDuration, formatTime, getDurationMinutes, localDateKey, minutesToTime, timeToMinutes, weekStartKeyOf } from "../engine/utils";
import { isDeadline } from "../engine/week-view";
import { blockCourseLabel, blockDisplayTitle, isFlexibleSession, sessionDisplayTitle, showsOnWeekGrid } from "../engine/week-layout";
import { overloadedDaysAhead, realityCheckFor } from "../engine/workload-analysis";
import { AskAiButton } from "../components/ask-ai-button";
import { FlexibleSessionsTip } from "../components/block-sheet";
import { PassExpiryBanner } from "../components/pass-expiry-banner";
import { PlanReviewSheet, PlanStatusCard, UndoReplanBar, usePlanFixHandlers } from "../components/plan-status";
import { DeferralConfirm, ReplanPreviewBody } from "../components/replan-preview";
import { WeekStrip } from "../components/week-strip";
import { useNavigate } from "../router";
import { useApp } from "../state/app-provider";
import { PREF_KEYS, useLocalFlag, useLocalPref } from "../state/local-prefs";
import { useGlobalModal } from "../state/modal-context";
import { useReplanFlow } from "../state/use-replan-flow";
import { Icon, IconWell } from "../ui/icon";
import { Card, CheckBox, Chip, CourseChip, MONO_FONT, PrimaryButton, ProgressRing, ScreenHeader, SectionLabel, Tile, TileRow } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { useWideLayout } from "../ui/layout";
import { useColors } from "../ui/theme";

// ── Small pieces ─────────────────────────────────────────────────

function DismissButton({ onPress, ariaLabel }: { onPress: () => void; ariaLabel: string }) {
  const colors = useColors();
  return (
    <button type="button" aria-label={ariaLabel} onClick={onPress} className="pressable" style={{ width: 32, height: 32, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Icon name="close" size={15} color={colors.dim} />
    </button>
  );
}

/** Same shell as TileRow, for rows that need a custom leading visual or stacked actions. */
function HeadsRow({ leading, children, ariaLabel }: { leading: ReactNode; children: ReactNode; ariaLabel?: string }) {
  const colors = useColors();
  return (
    <div aria-label={ariaLabel} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 12px", borderRadius: 14, border: `1px solid ${colors.border}`, background: "var(--row-tint)" }}>
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const rowTitle = (colors: ReturnType<typeof useColors>) => ({ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground } as const);
const rowSub = (colors: ReturnType<typeof useColors>) => ({ fontSize: 13.5, lineHeight: "19px", marginTop: 2, color: colors.muted } as const);
const rowMono = (colors: ReturnType<typeof useColors>) => ({ fontFamily: MONO_FONT, fontSize: 11.5, lineHeight: "16px", marginTop: 4, color: colors.dim } as const);

// ── The day's rows ──────────────────────────────────────────────

/** The mono time on the left of a row. It opens the row too; screen readers get the one button on the card. */
function RowTime({ time, current, onPress }: { time: string; current?: boolean; onPress?: () => void }) {
  const colors = useColors();
  const style = { width: 52, flexShrink: 0, paddingTop: 14, fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: current ? 600 : 500, color: current ? colors.peri : colors.muted, textAlign: "right" as const, background: "none", border: "none" };
  if (!onPress) return <div style={style}>{time}</div>;
  return (
    <button type="button" tabIndex={-1} aria-hidden onClick={onPress} style={{ ...style, cursor: "pointer" }}>
      {time}
    </button>
  );
}

/**
 * A study session: the tick box, its name, and one line under it (the class as a small tag, how long, what it is
 * due for). A dashed outline means the plan may still move it; a solid one with a pin means the student kept it.
 */
function SessionRow({ time, title, courseLabel, color, meta, flexible, kept, current, done, skipped, onToggle, onPress, ariaLabel }: {
  time: string;
  title: string;
  courseLabel?: string;
  color?: string;
  meta: string;
  flexible: boolean;
  kept: boolean;
  current: boolean;
  done: boolean;
  skipped: boolean;
  onToggle?: () => void;
  onPress: () => void;
  ariaLabel: string;
}) {
  const colors = useColors();
  const settled = done || skipped;
  const outline = current
    ? { border: `1px solid ${colors.accent}`, ...glowStyle(colors.primary) }
    : settled
      ? { border: `1px solid ${colors.border}`, background: "transparent" }
      : flexible
        ? { border: `1px dashed ${alpha(colors.peri, 0.55)}` }
        : { border: `1px solid ${colors.borderStrong}` };
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <RowTime time={time} current={current} onPress={onPress} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, padding: "10px 12px 10px 10px", borderRadius: 14, background: colors.surface, ...outline }}>
        <CheckBox checked={done} onPress={onToggle} ariaLabel={done ? `${title}, done. Tick to undo` : `Mark ${title} done`} />
        <button type="button" className="pressable" aria-label={ariaLabel} onClick={onPress} style={{ flex: 1, minWidth: 0, textAlign: "left", padding: 0 }}>
          <span className="clamp2" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 500, color: settled ? colors.muted : colors.foreground, textDecoration: settled ? "line-through" : "none" }}>{title}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3, minWidth: 0 }}>
            {courseLabel ? <CourseChip label={courseLabel} color={color} /> : null}
            <span className="truncate" style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{meta}</span>
            {kept ? <Icon name="pin" size={14} color={colors.muted} /> : null}
          </span>
        </button>
      </div>
    </div>
  );
}

function glowStyle(color: string) {
  const g = glow(color, 0.4);
  return { boxShadow: `0 ${g.shadowOffset.height}px ${g.shadowRadius}px ${alpha(color, g.shadowOpacity)}` };
}

/**
 * Something with a fixed time: a class (its colour as a bar on the left and a faint tint), or a commitment
 * (`muted`). Never moved by the plan, so it has no tick box.
 */
function FixedRow({ time, title, sub, color, muted, current, done, onPress, ariaLabel }: {
  time: string;
  title: string;
  sub: string;
  color?: string;
  muted?: boolean;
  current?: boolean;
  done?: boolean;
  onPress?: () => void;
  ariaLabel: string;
}) {
  const colors = useColors();
  const base = !muted && color && parseHexColor(color) ? color : null;
  const look = base
    ? { background: alpha(base, 0.14), border: `1px solid ${alpha(base, 0.4)}`, borderLeft: `3px solid ${base}` }
    : { background: alpha(colors.muted, 0.08), border: `1px solid ${alpha(colors.muted, 0.3)}` };
  const current_ = current ? { borderColor: colors.accent, ...glowStyle(colors.primary) } : null;
  const body = (
    <>
      <span className="clamp2" style={{ display: "block", fontSize: 15.5, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{title}</span>
      <span className="truncate" style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 2, color: base ? legibleOn(base, colors.surface, 5.5) : colors.muted }}>{sub}</span>
    </>
  );
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, opacity: done ? 0.6 : 1 }}>
      <RowTime time={time} current={current} onPress={onPress} />
      <div style={{ flex: 1, minWidth: 0, borderRadius: 14, ...look, ...current_ }}>
        {onPress ? (
          <button type="button" className="pressable" aria-label={ariaLabel} onClick={onPress} style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 12px" }}>
            {body}
          </button>
        ) : (
          <div aria-label={ariaLabel} style={{ padding: "11px 12px" }}>{body}</div>
        )}
      </div>
    </div>
  );
}

/** "1:00p" for the narrow time column: the full "1:00 PM" does not fit on one mono line. */
const clockLabel = (hhmm: string) => formatTime(hhmm).replace(/\s?([AaPp])[Mm]$/, (_m, p: string) => p.toLowerCase());

/** Today's workload at `at`: only what is still ahead counts (src/engine/workload-analysis.ts). */
const workloadAt = (state: Pick<AppState, "scheduleBlocks" | "healthPrefs" | "userPrefs" | "tasks">, at: Date) =>
  realityCheckFor(state.scheduleBlocks, state.healthPrefs, localDateKey(at), {
    userPrefs: state.userPrefs,
    nowMinutes: at.getHours() * 60 + at.getMinutes(),
    tasks: state.tasks,
  });

/** A clock that ticks once a minute. */
function useLiveMinutes(): number {
  const [minutes, setMinutes] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    const interval = setInterval(() => {
      const n = new Date();
      setMinutes(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);
  return minutes;
}

// ── Main Today Screen ─────────────────────────────────────────

type Deadline = {
  key: string;
  days: number;
  title: string;
  sub: string;
  onPress: () => void;
};

export function TodayScreen() {
  const colors = useColors();
  const wideLayout = useWideLayout();
  const navigate = useNavigate();
  const { state, dispatch } = useApp();
  const { openReplan, openAdd, openTask, openBlock } = useGlobalModal();
  const moveFlow = useReplanFlow<ScopedReplanPreview>();
  const planFixes = usePlanFixHandlers();
  const [reviewOpen, setReviewOpen] = useState(false);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  // What the last import planned (shown on its day), and whether "Make it fit your life" was hidden.
  const [recapRaw, setRecapRaw] = useLocalPref(PREF_KEYS.setupRecap);
  const recap = useMemo(() => parseSetupRecap(recapRaw), [recapRaw]);
  const [setupHidden, setSetupHidden] = useLocalFlag(PREF_KEYS.setupListHidden);
  const [nudgeDismissed, setNudgeDismissed] = useLocalFlag(PREF_KEYS.semesterNudgeDismissed);
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  const [recapNotesOpen, setRecapNotesOpen] = useState(false);

  const liveMinutes = useLiveMinutes();
  const today = localDateKey(new Date());
  const currentMinutes = liveMinutes;

  // The day on screen: today, or another day of this week picked on the strip. Leaving the screen puts it back on
  // today (the screen unmounts), and so does the week rolling over (the picked day is then no longer on the strip).
  const stripDays = useMemo(() => weekStripDays(today, state.tasks.filter(isDeadline)), [today, state.tasks]);
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const viewDate = pickedDate && stripDays.some((day) => day.key === pickedDate) ? pickedDate : today;
  const isToday = viewDate === today;

  const dayBlocks = useMemo(
    () =>
      state.scheduleBlocks
        // Same rule as the Week grid: no sleep, no planner transitions (a student's own "buffer" event is shown).
        .filter((b) => b.date === viewDate && showsOnWeekGrid(b))
        .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)),
    [state.scheduleBlocks, viewDate],
  );

  const tasksById = useMemo(() => new Map(state.tasks.map((task) => [task.id, task] as const)), [state.tasks]);
  const courseContext = useMemo(() => ({ classes: state.classes, tasks: state.tasks }), [state.classes, state.tasks]);

  // The "now" block: whatever is on at this minute and not finished. Only today has one.
  const currentBlock = useMemo(
    () =>
      isToday
        ? dayBlocks.find((b) => timeToMinutes(b.startTime) <= currentMinutes && timeToMinutes(b.endTime) > currentMinutes && b.completionStatus !== "done" && b.completionStatus !== "skipped")
        : undefined,
    [dayBlocks, currentMinutes, isToday],
  );

  // Blocks planned inside a recurring "do not schedule" zone.
  const dnzConflicts = useMemo(() => doNotScheduleConflicts(state.scheduleBlocks, state.recurringEvents || [], today), [state.scheduleBlocks, state.recurringEvents, today]);
  const [dnzDismissed, setDnzDismissed] = useState(false);

  // The label over the day's list, and (today, once every session is ticked) what comes next.
  const sessions = useMemo(() => daySessions(dayBlocks), [dayBlocks]);
  const allDone = isToday && sessions.total > 0 && sessions.done === sessions.total;
  const nextSession = useMemo(
    () =>
      allDone
        ? state.scheduleBlocks
            .filter((b) => b.type === "study" && b.completionStatus === "pending" && b.date > today)
            .sort((a, b) => (a.date === b.date ? timeToMinutes(a.startTime) - timeToMinutes(b.startTime) : a.date.localeCompare(b.date)))[0]
        : undefined,
    [allDone, state.scheduleBlocks, today],
  );

  // A computer has room for what comes after the day: the next few study sessions (wide layout only).
  const comingUp = useMemo(
    () =>
      wideLayout
        ? state.scheduleBlocks
            .filter((b) => b.type === "study" && b.completionStatus === "pending" && b.date > viewDate)
            .sort((a, b) => (a.date === b.date ? timeToMinutes(a.startTime) - timeToMinutes(b.startTime) : a.date.localeCompare(b.date)))
            .slice(0, 6)
        : [],
    [wideLayout, state.scheduleBlocks, viewDate],
  );

  const viewDay = new Date(viewDate + "T12:00:00");
  const dayName = viewDay.toLocaleDateString("en-US", { weekday: "long" });
  const shortDate = viewDay.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const dayOffset = daysBetweenKeys(today, viewDate);
  const eyebrow = isToday ? `${dayName} · ${shortDate}` : dayOffset === 1 ? `${shortDate} · Tomorrow` : dayOffset === -1 ? `${shortDate} · Yesterday` : shortDate;

  // Upcoming deadlines: exam preps in the next 14 days (opens the exam prep) plus exam / quiz tasks in the next 7
  // days that have no exam prep yet (opens the task). The most urgent one within 7 days is the gold deadline card;
  // the rest become "Heads up" rows.
  const deadlines = useMemo<Deadline[]>(() => {
    const list: Deadline[] = [];
    const prepBlocksPending = (ids: (block: ScheduleBlock) => boolean) =>
      state.scheduleBlocks.filter((b) => ids(b) && b.date >= today && b.completionStatus !== "done" && b.completionStatus !== "skipped").length;
    const prepLine = (count: number, fallback: string) => (count === 0 ? fallback : count === 1 ? "1 prep session planned" : `${count} prep sessions planned`);

    // A prep's date comes from its exam task (src/engine/exam-prep-link.ts), so a moved exam moves here too.
    const exams = (state.examPreps || [])
      .map((e) => withLinkedExam(e, state.tasks))
      .map((e) => ({ exam: e, key: dateKeyOf(e.examDate) }))
      .map(({ exam, key }) => ({ exam, key, days: daysBetweenKeys(today, key) }))
      .filter((e) => Number.isFinite(e.days) && e.days >= 0 && e.days <= 14)
      .sort((a, b) => a.days - b.days)
      .slice(0, 3);
    for (const { exam, days } of exams) {
      const name = exam.subject || exam.className || "Exam";
      const title = exam.className && exam.subject ? `${exam.className} · ${exam.subject}` : name;
      const prepTaskIds = new Set([runwayTaskId(exam.id), ...(exam.examTaskId ? [exam.examTaskId] : [])]);
      list.push({
        key: `exam-${exam.id}`,
        days,
        title,
        sub: prepLine(prepBlocksPending((b) => !!b.taskId && prepTaskIds.has(b.taskId)), "Open to review study materials"),
        onPress: () => navigate(`exam-prep/${encodeURIComponent(exam.id)}`),
      });
    }

    const examKeys = new Set(exams.map((e) => `${e.key}|${(e.exam.className ?? "").toLowerCase()}`));
    const linkedTaskIds = new Set(exams.map((e) => e.exam.examTaskId).filter(Boolean));
    const examTasks = state.tasks
      .filter((task: Task) => {
        if (task.status === "done") return false;
        if (linkedTaskIds.has(task.id)) return false;
        const kind = classifyTaskKind(task);
        if (kind !== "exam" && kind !== "quiz") return false;
        const days = daysBetweenKeys(today, task.dueDate);
        if (!Number.isFinite(days) || days < 0 || days > 7) return false;
        return !examKeys.has(`${task.dueDate}|${(task.courseName ?? "").toLowerCase()}`);
      })
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 3);
    for (const task of examTasks) {
      list.push({
        key: `task-${task.id}`,
        days: daysBetweenKeys(today, task.dueDate),
        title: task.courseName ? `${task.courseName} · ${task.name}` : task.name,
        sub: prepLine(prepBlocksPending((b) => b.taskId === task.id), "No prep sessions yet"),
        onPress: () => openTask(task.id),
      });
    }
    return list.sort((a, b) => a.days - b.days);
  }, [state.examPreps, state.tasks, state.scheduleBlocks, today, navigate, openTask]);

  const featuredDeadline = deadlines[0] && deadlines[0].days <= 7 ? deadlines[0] : null;
  const otherDeadlines = featuredDeadline ? deadlines.slice(1) : deadlines;
  const daysBadge = (days: number) => (days === 0 ? "TODAY" : days === 1 ? "TOMORROW" : `${days} DAYS`);

  // Today's workload: only what is still to do, from now on; null on a comfortable day. This card is the ONE place
  // that says a day is over the cap.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const realityCheck = useMemo(() => workloadAt(state, new Date()), [state.scheduleBlocks, state.healthPrefs, state.userPrefs, state.tasks, liveMinutes]);
  // Upcoming days (the next 7) over the daily cap: one line inside the same card, with a Replan of that week.
  const aheadOverload = useMemo(() => overloadedDaysAhead(state.scheduleBlocks, today, { userPrefs: state.userPrefs }), [state.scheduleBlocks, state.userPrefs, today]);
  const nextOverload = aheadOverload[0];
  // "Move N to tomorrow" previews moving exactly the sessions the card names (recomputed if the plan changes first).
  const previewMove = (acceptLate: boolean) =>
    moveFlow.open((current, at) => runReplan(current, { scope: "today", mode: "defer", acceptLate, blockIds: workloadAt(current, at)?.moveBlockIds ?? [] }, at));
  // The plan status: behind plan, overdue work, quizzes to record, work short on time, a heavy week ahead — ONE card
  // with its fixes, the same status Week shows as a pill. Re-checked every minute (live clock).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const planStatus = useMemo(() => planStatusFor(state, new Date()), [state.tasks, state.scheduleBlocks, state.planAlerts, state.userPrefs, liveMinutes, today]);
  // The one-time tip about dashed (flexible) sessions shows while the day has one.
  const showsFlexible = dayBlocks.some(isFlexibleSession);

  const nowIndex = (() => {
    const index = dayBlocks.findIndex((item) => timeToMinutes(item.startTime) > currentMinutes);
    return index === -1 ? dayBlocks.length : index;
  })();

  /** The line under a session's name: how long, and which deadline it works toward ("25m · due Fri"). */
  const sessionMeta = (block: ScheduleBlock): string => {
    const duration = formatDuration(getDurationMinutes(block.startTime, block.endTime));
    if (block.completionStatus === "skipped") return `Skipped · ${duration}`;
    if (block.completionStatus === "missed") return `Missed · ${duration}`;
    const due = blockDueLabel(block, block.taskId ? tasksById.get(block.taskId) : undefined, today);
    return [duration, due].filter(Boolean).join(" · ");
  };

  /** The line under anything with a fixed time. */
  const fixedSub = (block: ScheduleBlock): string => {
    const range = `${formatTime(block.startTime)} – ${formatTime(block.endTime)}`;
    if (block.type === "class") return `Class · ${range}`;
    if (block.type === "recurring" || block.type === "work") return `Every week · ${range}`;
    return range;
  };

  const toggleDone = (block: ScheduleBlock) => {
    dispatch({ type: block.completionStatus === "done" ? "UNCOMPLETE_BLOCK" : "COMPLETE_BLOCK", payload: block.id });
  };

  const nowLine = isToday && dayBlocks.length > 0 ? (
    <div key="now-line" aria-label={`Now, ${formatTime(minutesToTime(liveMinutes))}`} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 18 }}>
      <span style={{ width: 52, textAlign: "right", fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: colors.peri }}>{clockLabel(minutesToTime(liveMinutes))}</span>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: colors.accent, flexShrink: 0 }} />
      <span style={{ flex: 1, height: 1.5, background: colors.accent, opacity: 0.8 }} />
    </div>
  ) : null;

  const showDnz = dnzConflicts.length > 0 && !dnzDismissed;
  // With no class and no task yet, the "Start with your syllabus" card says it; the nudge is for a plan made by hand.
  const planIsEmpty = state.classes.length === 0 && state.tasks.length === 0;
  const imports = state.syllabusImports ?? [];
  const showSemesterNudge = imports.length === 0 && !nudgeDismissed;
  const hasHeadsUp = Boolean(planStatus) || Boolean(realityCheck) || Boolean(nextOverload) || showDnz || otherDeadlines.length > 0 || (showSemesterNudge && !planIsEmpty);

  // Workload card copy: plain words, and the number is "how doable", never a "probability".
  const sessionsWord = (n: number) => `${n} session${n === 1 ? "" : "s"}`;
  const moveCount = realityCheck?.movableCount ?? 0;
  const moveAdvice = !realityCheck
    ? ""
    : moveCount > 0
      ? realityCheck.moveFixesDay
        ? ` Moving ${sessionsWord(moveCount)} to tomorrow brings it back within your limits.`
        : ` Moving ${sessionsWord(moveCount)} to tomorrow makes it lighter.`
      : realityCheck.studyMinutes > 0
        ? " Nothing left today can wait until tomorrow."
        : " Try removing some commitments.";
  const overloadDay = (key: string) => (daysBetweenKeys(today, key) === 1 ? "Tomorrow" : new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" }));
  const overloadLine = !nextOverload
    ? ""
    : aheadOverload.length === 1
      ? `${overloadDay(nextOverload.date)} has ${formatDuration(nextOverload.studyMinutes)} of study planned, over your ${formatDuration(nextOverload.capMinutes)} daily cap.`
      : `${overloadDay(nextOverload.date)} and ${aheadOverload.length - 1} more day${aheadOverload.length > 2 ? "s" : ""} in the next week are over your ${formatDuration(nextOverload.capMinutes)} daily cap.`;
  const overloadReplanLabel = nextOverload && weekStartKeyOf(nextOverload.date) !== weekStartKeyOf(today) ? "Replan next week" : "Replan this week";

  // ── Setup: before any syllabus, right after one, and the things that make the plan fit a real week ──
  const startCard = planIsEmpty && dayBlocks.length === 0;
  const shownRecap = isToday && recapIsCurrent(recap, { today, importIds: imports.map((entry) => entry.id) }) ? recap : null;
  const recapDetails = shownRecap ? recapDetailLines(shownRecap) : [];
  const shownImportId = shownRecap?.importId ?? null;
  useEffect(() => {
    setConfirmingUndo(false);
    setRecapNotesOpen(false);
  }, [shownImportId]);
  const recapNotes = shownRecap ? recapNotesLabel(shownRecap) : "";
  // In the browser only the first row applies: there are no phone calendars and no course-site feeds to link.
  const setupItems = setupChecklist({ recurringEvents: (state.recurringEvents ?? []).length, calendarsSupported: false, calendarsOn: false, feeds: 0 }).filter((item) => item.key === "commitments");
  const showSetup = isToday && showsSetupList({ items: setupItems, hidden: setupHidden, hasPlan: !planIsEmpty });
  const addSyllabus = () => navigate("syllabus");
  const undoImport = () => {
    if (!shownRecap) return;
    dispatch({ type: "UNDO_SYLLABUS_IMPORT", payload: shownRecap.importId });
    setConfirmingUndo(false);
    setRecapRaw(null);
  };

  const replanLink = { display: "inline-flex", alignItems: "center", gap: 5, minHeight: 32, padding: "0 4px", fontSize: 14, fontWeight: 600, color: colors.peri } as const;

  const part_header = (
    <>
      {/* 1 · The date and "Today" (or the weekday looked at), and Ask AI */}
      <ScreenHeader eyebrow={eyebrow} title={isToday ? "Today" : dayName} right={startCard ? undefined : <AskAiButton />} />
    </>
  );
  const part_strip = (
    <>
      {/* 2 · The week as a strip of dates: click a day to look at it, click today to come back */}
      <WeekStrip days={stripDays} selectedKey={viewDate} onSelect={(key) => setPickedDate(key === today ? null : key)} />
      {/* A School Year pass in its last days, or just ended: "Get another year" (components/pass-expiry-banner.tsx) */}
      <PassExpiryBanner />
    </>
  );
  const part_recap = (
    <>
      {/* The day a syllabus was planned: what was planned, what was left out, and the way to undo it */}
      {shownRecap ? (
        <div style={{ borderRadius: 16, border: `1px solid ${alpha(colors.success, 0.45)}`, background: alpha(colors.success, 0.1), padding: "14px 14px 10px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <Icon name="check" size={22} color={colors.success} strokeWidth={2.4} style={{ marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }} aria-label={`${recapTitle(shownRecap)}. ${recapLine(shownRecap)} ${recapDetails.join(" ")}`}>
              <div style={{ fontSize: 16, lineHeight: "21px", fontWeight: 700, color: colors.foreground }}>{recapTitle(shownRecap)}</div>
              <div style={{ fontSize: 14, lineHeight: "19px", marginTop: 2, color: colors.success }}>{recapLine(shownRecap)}</div>
              {recapDetails.map((line) => (
                <div key={line} style={{ fontSize: 13, lineHeight: "18px", marginTop: 4, color: colors.muted }}>{line}</div>
              ))}
              {recapNotesOpen ? shownRecap.notes.map((note) => <div key={note} style={{ fontSize: 13, lineHeight: "18px", marginTop: 4, color: colors.muted }}>{note}</div>) : null}
            </div>
            <DismissButton ariaLabel="Dismiss" onPress={() => { setConfirmingUndo(false); setRecapRaw(null); }} />
          </div>
          {recapNotes ? (
            <button type="button" className="link" aria-expanded={recapNotesOpen} aria-label={`${recapNotes}. ${recapNotesOpen ? "Hide" : "Show"}`} onClick={() => setRecapNotesOpen((open) => !open)} style={{ ...replanLink, marginTop: 6 }}>
              <Icon name="spark" size={15} color={colors.violet} />
              {recapNotes} · {recapNotesOpen ? "Hide" : "Show"}
            </button>
          ) : null}
          {confirmingUndo ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
              <span style={{ flex: 1, fontSize: 13.5, color: colors.foreground }}>Remove everything this import added?</span>
              <button type="button" className="link" onClick={undoImport} aria-label="Remove everything this import added" style={{ ...replanLink, color: colors.error }}>Remove</button>
              <button type="button" className="link" onClick={() => setConfirmingUndo(false)} aria-label="Keep the import" style={replanLink}>Keep</button>
            </div>
          ) : (
            <button type="button" className="link" onClick={() => setConfirmingUndo(true)} aria-label="Undo this import" style={{ ...replanLink, marginTop: 6 }}>
              <Icon name="undo" size={15} color={colors.peri} />
              Undo this import
            </button>
          )}
        </div>
      ) : null}
    </>
  );
  const part_setup = (
    <>
      {/* Make it fit your life: what makes a plan fit a real week, until done or hidden */}
      {showSetup ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel
            title="Make it fit your life"
            right={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: colors.muted }}>{setupProgress(setupItems)}</span>
                <button type="button" className="link" aria-label="Hide this list" onClick={() => setSetupHidden(true)} style={replanLink}>Hide</button>
              </span>
            }
          />
          <div className="group">
            {setupItems.map((item) => (
              <button key={item.key} type="button" className="row pressable" aria-label={`${item.title}. ${item.done ? "Done. " : ""}${item.sub}`} onClick={() => openAdd({ kind: "event", weekly: true, date: today })}>
                <span className="well" style={{ background: alpha(item.done ? colors.success : colors.peri, item.done ? 0.14 : 0.12) }}>
                  <Icon name={item.done ? "check" : item.icon} size={18} color={item.done ? colors.success : colors.peri} strokeWidth={item.done ? 2.6 : 1.8} />
                </span>
                <span className="row-text">
                  <span className="row-label" style={{ display: "block" }}>{item.title}</span>
                  <span className="row-detail" style={{ display: "block" }}>{item.sub}</span>
                </span>
                <Icon name="chevronRight" size={18} color={colors.muted} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
  const part_deadline = (
    <>
      {/* 3 · ONE deadline card: the countdown first, in gold */}
      {isToday && featuredDeadline ? (
        <Card tone="surface" padded={false} radiusSize={16} onClick={featuredDeadline.onPress} ariaLabel={`${daysBadge(featuredDeadline.days)}: ${featuredDeadline.title}. ${featuredDeadline.sub}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
          <span style={{ padding: "6px 9px", borderRadius: 9, border: `1px solid ${alpha(colors.gold, 0.5)}`, background: alpha(colors.gold, 0.15), fontFamily: MONO_FONT, fontSize: 11, fontWeight: 700, letterSpacing: 1, color: colors.gold, flexShrink: 0 }}>{daysBadge(featuredDeadline.days)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="truncate" style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{featuredDeadline.title}</span>
            <span className="truncate" style={{ display: "block", fontSize: 13, lineHeight: "18px", color: colors.muted }}>{featuredDeadline.sub}</span>
          </span>
          <Icon name="chevronRight" size={18} color={colors.muted} />
        </Card>
      ) : null}
    </>
  );
  const part_allDone = (
    <>
      {/* Every session of today ticked: say so, and say what comes next */}
      {allDone ? (
        <div aria-label={`Done for today.${nextSession ? ` Next: ${blockDisplayTitle(nextSession.title)}, ${relativeDayLabel(nextSession.date, today)} at ${formatTime(nextSession.startTime)}` : ""}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px", borderRadius: 16, border: `1px solid ${alpha(colors.success, 0.45)}`, background: alpha(colors.success, 0.1) }}>
          <Icon name="check" size={22} color={colors.success} strokeWidth={2.4} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, lineHeight: "21px", fontWeight: 700, color: colors.foreground }}>Done for today</div>
            {nextSession ? (
              <div className="clamp2" style={{ fontSize: 13.5, lineHeight: "18px", color: colors.muted }}>
                Next: {blockDisplayTitle(nextSession.title)}, {relativeDayLabel(nextSession.date, today)} at {formatTime(nextSession.startTime)}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
  const part_tip = (
    <>
      {/* Once: what the dashed (flexible) sessions below are, and how to keep one */}
      <FlexibleSessionsTip visible={showsFlexible} />
    </>
  );
  const part_start = (
    <>
      {/* Before any class or task: one clear next step instead of an empty day */}
      {startCard ? (
        <Card tone="surface" padded={false} radiusSize={18} style={{ padding: "26px 22px 22px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <span style={{ width: 60, height: 60, borderRadius: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
            <Icon name="file" size={28} color={colors.peri} />
          </span>
          <h2 style={{ margin: "16px 0 0", fontSize: 21, lineHeight: "26px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>Start with your syllabus</h2>
          <p style={{ margin: "6px 0 0", fontSize: 14.5, lineHeight: "20px", color: colors.muted, maxWidth: 360 }}>Paste it in, Trajectory finds your deadlines and plans your study time.</p>
          <PrimaryButton label="Add a syllabus" fullWidth size="lg" onPress={addSyllabus} style={{ marginTop: 18 }} />
          <button type="button" className="link" aria-label="Add a class by hand" onClick={() => navigate("classes?add=class")} style={{ ...replanLink, marginTop: 10, minHeight: 44 }}>Add a class by hand</button>
        </Card>
      ) : null}
    </>
  );
  const part_sessions = (
    <>
      {/* 4 · The day in order, under one label. Replan is the one way to change the plan from here */}
      {startCard ? null : (
        <>
          <SectionLabel
            title={sessions.label}
            right={
              isToday ? (
                <button type="button" className="link" onClick={() => openReplan({ scope: "today" })} aria-label="Replan today, this week or the semester. You see a preview first" style={replanLink}>
                  <Icon name="bolt" size={15} color={colors.gold} />
                  Replan
                </button>
              ) : (
                <button type="button" className="link" onClick={() => setPickedDate(null)} aria-label="Back to today" style={replanLink}>Back to today</button>
              )
            }
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {dayBlocks.length === 0 ? (
              <Card tone="surface" padded={false} radiusSize={14} onClick={() => navigate("week")} ariaLabel={`Nothing scheduled ${isToday ? "today" : `on ${dayName}`}. Open Week to see your plan.`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
                <IconWell name="today" color={colors.peri} background={alpha(colors.peri, 0.12)} size={36} radius={11} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>Nothing scheduled {isToday ? "today" : `on ${dayName}`}</span>
                  <span style={{ display: "block", fontSize: 13.5, lineHeight: "18px", color: colors.muted }}>Your plan fills in by itself as you add classes and deadlines.</span>
                </span>
              </Card>
            ) : (
              dayBlocks.flatMap((block, index) => {
                const nodes: ReactNode[] = [];
                if (index === nowIndex && nowLine) nodes.push(nowLine);
                const isCurrent = currentBlock?.id === block.id;
                const done = block.completionStatus === "done";
                const time = clockLabel(block.startTime);
                const openSheet = () => openBlock(block.id);
                if (block.type === "study") {
                  const title = sessionDisplayTitle(block.title, block.taskId ? tasksById.get(block.taskId)?.courseName : undefined);
                  const meta = sessionMeta(block);
                  const flexible = isFlexibleSession(block);
                  const kept = block.accepted && block.completionStatus === "pending";
                  nodes.push(
                    <SessionRow
                      key={block.id}
                      time={time}
                      title={title}
                      courseLabel={blockCourseLabel(block, courseContext)}
                      color={block.color}
                      meta={meta}
                      flexible={flexible}
                      kept={kept}
                      current={isCurrent}
                      done={done}
                      skipped={block.completionStatus === "skipped"}
                      onToggle={block.completionStatus === "skipped" ? undefined : () => toggleDone(block)}
                      onPress={openSheet}
                      ariaLabel={`${formatTime(block.startTime)}, ${title}. ${isCurrent ? "Now. " : ""}${done ? "Done. " : ""}${meta}. ${flexible ? "The plan may still move it. " : kept ? "Kept at this time. " : ""}Open details`}
                    />,
                  );
                } else {
                  const sub = fixedSub(block);
                  nodes.push(
                    <FixedRow
                      key={block.id}
                      time={time}
                      title={block.title}
                      sub={isCurrent ? `Now · ${sub}` : sub}
                      color={block.color}
                      muted={block.type !== "class"}
                      current={isCurrent}
                      done={done || block.completionStatus === "skipped"}
                      onPress={openSheet}
                      ariaLabel={`${formatTime(block.startTime)}, ${block.title}. ${isCurrent ? "Now. " : ""}${sub}. Open details`}
                    />,
                  );
                }
                if (index === dayBlocks.length - 1 && nowIndex === dayBlocks.length && nowLine) nodes.push(nowLine);
                return nodes;
              })
            )}
          </div>
        </>
      )}
    </>
  );
  const part_undo = (
    <>
      {/* Undo for the last applied replan (until the next change) */}
      <UndoReplanBar variant="row" />
    </>
  );
  const part_headsUp = (
    <>
      {/* 5 · Heads up: every contextual notice as one compact tile (about today, so only shown with today) */}
      {isToday && hasHeadsUp ? (
        <Tile tag="Heads up" tagColor={colors.gold} padding={14}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {planStatus ? <PlanStatusCard status={planStatus} handlers={planFixes} onReview={() => setReviewOpen(true)} /> : null}

            {/* Today's workload: the ONE "over your cap" warning, with its fix */}
            {realityCheck || nextOverload ? (
              <HeadsRow
                ariaLabel={realityCheck ? `Today's workload. Today looks about ${realityCheck.doablePercent}% doable.${moveAdvice}` : `Workload ahead. ${overloadLine}`}
                leading={
                  realityCheck ? (
                    <ProgressRing progress={realityCheck.doablePercent / 100} size={44} stroke={4} color={realityCheck.doablePercent < 50 ? colors.error : colors.gold} trackColor={alpha(colors.peri, 0.14)} label={`${realityCheck.doablePercent}%`} labelSize={10} />
                  ) : (
                    <IconWell name="gauge" color={colors.gold} background={alpha(colors.gold, 0.15)} size={36} radius={11} />
                  )
                }
              >
                <div style={rowTitle(colors)}>{realityCheck ? "Today's workload" : "Workload ahead"}</div>
                {realityCheck ? (
                  <>
                    <div style={rowSub(colors)}>
                      Today looks about <span style={{ fontWeight: 700, color: realityCheck.doablePercent < 50 ? colors.error : colors.gold }}>{realityCheck.doablePercent}%</span> doable.{moveAdvice}
                    </div>
                    <div style={rowMono(colors)}>{realityCheck.reason}</div>
                  </>
                ) : null}
                {nextOverload ? <div style={realityCheck ? rowMono(colors) : rowSub(colors)}>{overloadLine}</div> : null}
                {moveCount > 0 || nextOverload ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                    {moveCount > 0 ? <Chip tone="red" label={`Move ${moveCount} to tomorrow`} ariaLabel={`Move ${sessionsWord(moveCount)} to tomorrow: preview the change first`} onPress={() => previewMove(false)} /> : null}
                    {nextOverload ? <Chip icon="bolt" label={overloadReplanLabel} ariaLabel={`${overloadReplanLabel}: preview the change first`} onPress={() => openReplan({ scope: "week", weekStart: weekStartKeyOf(nextOverload.date) })} /> : null}
                  </div>
                ) : null}
              </HeadsRow>
            ) : null}

            {/* doNotSchedule zone conflicts */}
            {showDnz ? (
              <HeadsRow leading={<IconWell name="lock" color={colors.violet} background={alpha(colors.violet, 0.16)} size={36} radius={11} />}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ ...rowTitle(colors), flex: 1 }}>
                    {dnzConflicts.length === 1 ? `1 item is in your "${dnzConflicts[0]!.zone.title}" zone` : `${dnzConflicts.length} items are in your "${dnzConflicts[0]!.zone.title}" zone`}
                  </div>
                  <DismissButton ariaLabel="Dismiss the no-study zone warning" onPress={() => setDnzDismissed(true)} />
                </div>
                <div style={rowSub(colors)}>
                  {dnzConflicts.map((c) => c.block.title).join(", ")} · Want to move {dnzConflicts.length === 1 ? "it" : "them"} after {formatTime(dnzConflicts[0]!.zone.endTime)}?
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  <Chip tone="violet" label={`Reschedule ${dnzConflicts.length === 1 ? "it" : "them"}`} ariaLabel={`Preview moving ${dnzConflicts.length === 1 ? "it" : "them"} out of the zone`} onPress={() => openReplan({ scope: "today", mode: "do_not_schedule" })} />
                </div>
              </HeadsRow>
            ) : null}

            {/* Other upcoming exams and quizzes */}
            {otherDeadlines.map((deadline) => (
              <TileRow
                key={deadline.key}
                icon="flag"
                iconColor={colors.gold}
                iconBackground={alpha(colors.gold, 0.15)}
                title={deadline.title}
                subtitle={deadline.sub}
                ariaLabel={`${daysBadge(deadline.days)}: ${deadline.title}. ${deadline.sub}`}
                onPress={deadline.onPress}
                right={<span style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 700, letterSpacing: 1, color: colors.gold }}>{daysBadge(deadline.days)}</span>}
              />
            ))}

            {/* Syllabus nudge: never imported a syllabus and not dismissed */}
            {showSemesterNudge && !planIsEmpty ? (
              <TileRow
                icon="upload"
                iconColor={colors.accent}
                iconBackground={alpha(colors.primary, 0.18)}
                title="Add your syllabus"
                subtitle="Trajectory finds the deadlines in it and plans the study time."
                onPress={addSyllabus}
                right={<DismissButton ariaLabel="Dismiss syllabus suggestion" onPress={() => setNudgeDismissed(true)} />}
              />
            ) : null}
          </div>
        </Tile>
      ) : null}
    </>
  );
  const part_sheets = (
    <>
      {/* The plan status, item by item with its fix (the same sheet Week's "N to review" pill opens) */}
      <PlanReviewSheet visible={reviewOpen} status={planStatus} onClose={closeReview} />

      {/* "Move N to tomorrow": exactly the sessions the workload card names. Nothing changes until Apply (undoable). */}
      {moveFlow.preview ? (
        <Sheet open onClose={moveFlow.cancel} ariaLabel="Move to tomorrow">
          {moveFlow.preview.needsConfirmation ? (
            <DeferralConfirm risk={moveFlow.preview.needsConfirmation} onKeep={moveFlow.cancel} onMoveAnyway={() => previewMove(true)} />
          ) : (
            <ReplanPreviewBody
              title="Move to tomorrow"
              summary={moveFlow.preview.summary}
              diff={moveFlow.preview.diff}
              shortfalls={moveFlow.preview.shortfalls}
              unplaced={moveFlow.preview.unplaced}
              next={moveFlow.preview.next}
              applyLabel="Move them"
              applyDisabled={!moveFlow.preview.diff.changed}
              onApply={() => { moveFlow.apply(); }}
              onCancel={moveFlow.cancel}
            />
          )}
        </Sheet>
      ) : null}
    </>
  );

  // A computer with room: the day in the main column, everything about the days around it in the rail beside it.
  if (wideLayout) {
    return (
      <div className="screen full">
        {part_header}
        <div className="split">
          <div className="split-main">
            {part_recap}
            {part_allDone}
            {part_tip}
            {part_start}
            {part_sessions}
            {part_undo}
            {comingUp.length > 0 ? (
              <section style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }} aria-label="Coming up">
                <SectionLabel title="Coming up" right={<a className="link" href="#/week" style={{ ...replanLink, textDecoration: "none" }}>Open Week</a>} />
                <div className="group">
                  {comingUp.map((block) => {
                    const title = sessionDisplayTitle(block.title, block.taskId ? tasksById.get(block.taskId)?.courseName : undefined);
                    const when = `${relativeDayLabel(block.date, today)} · ${formatTime(block.startTime)}`;
                    return (
                      <button key={block.id} type="button" className="row pressable" onClick={() => openBlock(block.id)} aria-label={`${title}, ${when}. Open details`}>
                        <span style={{ width: 4, alignSelf: "stretch", borderRadius: 2, background: block.color || colors.accent, flexShrink: 0 }} />
                        <span className="row-text">
                          <span className="row-label truncate" style={{ display: "block", fontSize: 15 }}>{title}</span>
                          <span className="row-detail" style={{ display: "block" }}>{sessionMeta(block)}</span>
                        </span>
                        <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: colors.muted, whiteSpace: "nowrap" }}>{when}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>
          <aside className="split-rail" aria-label="Your week">
            <div className="card" style={{ padding: "10px 10px 12px" }}>{part_strip}</div>
            {part_deadline}
            {part_setup}
            {part_headsUp}
          </aside>
        </div>
        {part_sheets}
      </div>
    );
  }

  return (
    <div className="screen">
      {part_header}
      {part_strip}
      {part_recap}
      {part_setup}
      {part_deadline}
      {part_allDone}
      {part_tip}
      {part_start}
      {part_sessions}
      {part_undo}
      {part_headsUp}
      {part_sheets}
    </div>
  );
}
