// The Week screen's time grid, three days or seven days wide (the Month view is src/components/month-view.tsx).
//
// Top to bottom: the days (today outlined), a "due" row with what is due each day in gold, then the hours: an hour
// rail, hairline hour lines, a faint tint on today's column and its "now" line, and the blocks.
//   - A class is a faint tint of its colour with the colour as a bar on its left edge.
//   - A study session is an outline in its class's colour: dashed while the plan may still move it, solid once kept.
//   - Commitments are muted grey: they are around the plan, not part of it.
// Three days wide there is room for names ("Principles of Finance", "9:30–10:45"); seven days wide a block carries
// only its class's short name. Blocks that overlap are drawn side by side, the grid grows to fit early and late
// blocks, sleep is a hatched band, and every block can be clicked over at least 44px without reaching into its
// neighbour. The hours scroll inside the grid; the first time it is on screen it scrolls to "now" by itself.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { legibleOn, parseHexColor } from "../engine/contrast";
import { alpha } from "../engine/design";
import { relativeDayLabel } from "../engine/due-label";
import { classifyTaskKind } from "../engine/task-kind";
import type { ScheduleBlock, Task } from "../engine/types";
import { addDaysToKey, dateKeyOf, formatDuration, getDurationMinutes, weekStartKeyOf, weekdayOfKey } from "../engine/utils";
import {
  blockCourseLabel,
  blockFrame,
  classOfTask,
  classShortName,
  computeVisibleHourRange,
  currentTimeY,
  deadlineChipLabel,
  describeBlockForA11y,
  gridHeight,
  isFlexibleSession,
  laneFrame,
  layoutDayBlocks,
  minutesToY,
  scrollTargetForNow,
  sessionDisplayTitle,
  showsOnWeekGrid,
  sleepBandsForDate,
  verticalTouchSlops,
  weekDateKeys,
  weekdayName,
  type LaidOutItem,
  type VerticalSlop,
} from "../engine/week-layout";
import { compactTimeRange, gridSessionText, hourRailLabel, isDeadline, narrowBlockLabel } from "../engine/week-view";
import { useApp } from "../state/app-provider";
import type { Clock } from "../state/use-clock";
import { Icon } from "../ui/icon";
import { DateBadge, MONO_FONT } from "../ui/primitives";
import { useColors } from "../ui/theme";

/** Every block and badge on the grid can be clicked over at least this many pixels. */
const MIN_TOUCH = 44;
const GRID_PAD_TOP = 10;
const GRID_PAD_BOTTOM = 16;

/** The measures of the two widths of the grid. */
const LAYOUT = {
  days: { hourHeight: 56, rail: 44, pad: 4, gap: 6, minBlock: 24 },
  week: { hourHeight: 48, rail: 34, pad: 2, gap: 3, minBlock: 18 },
} as const;

type GridItem = { kind: "block"; key: string; startTime: string; endTime: string; block: ScheduleBlock };

export interface WeekData {
  blocksByDate: Record<string, ScheduleBlock[]>;
  /** Open work due each day: quizzes and exams first. */
  dueByDate: Record<string, Task[]>;
  sleepBlocks: ScheduleBlock[];
  /** Does the week (or weeks) these days belong to have anything in it at all? */
  weekHasContent: boolean;
  /** The Mondays of the weeks on screen that have nothing in them (a week ahead like that is built on demand). */
  emptyWeekStarts: string[];
}

/** Everything the grid draws for `dates`, read from the plan. */
export function useWeekData(dates: readonly string[]): WeekData {
  const { state } = useApp();
  const key = dates.join(",");

  const blocksByDate = useMemo(() => {
    const map: Record<string, ScheduleBlock[]> = {};
    for (const date of dates) map[date] = [];
    // Sleep is drawn as bands; transitions after classes are the planner's busy time only (Today hides them too).
    for (const block of state.scheduleBlocks) {
      if (showsOnWeekGrid(block)) map[block.date]?.push(block);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.scheduleBlocks, key]);

  const dueByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const date of dates) map[date] = [];
    for (const task of state.tasks) {
      if (task.status === "done" || task.status === "skipped" || !isDeadline(task)) continue;
      map[dateKeyOf(task.dueDate ?? "")]?.push(task);
    }
    const tested = (task: Task) => {
      const kind = classifyTaskKind(task);
      return kind === "exam" || kind === "quiz" ? 0 : 1;
    };
    for (const date of dates) map[date]!.sort((a, b) => tested(a) - tested(b) || a.name.localeCompare(b.name));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tasks, key]);

  // Nights that touch the visible days (the night before the first one runs into its morning).
  const sleepBlocks = useMemo(() => {
    const from = addDaysToKey(dates[0]!, -1);
    const to = dates[dates.length - 1]!;
    return state.scheduleBlocks.filter((block) => block.type === "sleep" && block.date >= from && block.date <= to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.scheduleBlocks, key]);

  const { weekHasContent, emptyWeekStarts } = useMemo(() => {
    const starts = [...new Set(dates.map(weekStartKeyOf))];
    const empty = starts.filter((start) => {
      const days = weekDateKeys(start);
      return !state.scheduleBlocks.some((block) => days.includes(block.date) && showsOnWeekGrid(block));
    });
    return { weekHasContent: empty.length < starts.length, emptyWeekStarts: empty };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.scheduleBlocks, key]);

  return { blocksByDate, dueByDate, sleepBlocks, weekHasContent, emptyWeekStarts };
}

// ── Sleep band (the violet hatched band) ──────────────────────

const SleepBand = memo(function SleepBand({ top, height, color }: { top: number; height: number; color: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top,
        height,
        pointerEvents: "none",
        backgroundColor: alpha(color, 0.1),
        backgroundImage: `repeating-linear-gradient(135deg, ${alpha(color, 0.2)} 0 2px, transparent 2px 8px)`,
      }}
    />
  );
});

// ── A block ───────────────────────────────────────────────────

type BlockLook = "class" | "flexible" | "kept" | "settled" | "other";

interface GridBlockProps {
  id: string;
  look: BlockLook;
  color?: string;
  top: number;
  height: number;
  left: number;
  width: number;
  /** Seven days wide, or squeezed beside another block: only a short mono label fits. */
  narrow: boolean;
  title: string;
  /** The line under the name when there is room: a class's times, what a session is due for. */
  sub?: string;
  code: string;
  done?: boolean;
  dimmed?: boolean;
  slop: VerticalSlop;
  ariaLabel: string;
  onPress: (id: string) => void;
}

const GridBlock = memo(function GridBlock({ id, look, color, top, height, left, width, narrow, title, sub, code, done, dimmed, slop, ariaLabel, onPress }: GridBlockProps) {
  const colors = useColors();
  const base = color && parseHexColor(color) ? color : colors.peri;
  const ink = look === "other" ? colors.muted : legibleOn(base, colors.surface, 5);
  const shape =
    look === "class"
      ? { background: alpha(base, 0.22), borderLeft: `${narrow ? 2 : 3}px solid ${base}` }
      : look === "flexible"
        ? { background: colors.surface, border: `1px dashed ${alpha(base, 0.75)}` }
        : look === "kept"
          ? { background: colors.surface, border: `1px solid ${alpha(base, 0.75)}` }
          : look === "settled"
            ? { background: colors.surface, border: `1px solid ${colors.borderStrong}` }
            : { background: alpha(colors.muted, 0.1), border: `1px solid ${alpha(colors.muted, 0.3)}` };
  const session = look === "flexible" || look === "kept" || look === "settled";
  const tight = height < 48;
  const showSub = !narrow && Boolean(sub) && height >= 58;
  const titleLines = Math.max(1, Math.floor((height - (tight ? 6 : 10) - (showSub ? 18 : 0)) / 16));

  return (
    // The button is the touch area (grown above and below by the slop); the visual block sits inside it.
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() => onPress(id)}
      style={{ position: "absolute", top: top - slop.top, height: height + slop.top + slop.bottom, left, width, padding: 0, background: "transparent", border: "none", textAlign: "left", zIndex: 2 }}
    >
      <span
        style={{
          position: "absolute",
          top: slop.top,
          height,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: narrow ? "center" : "stretch",
          justifyContent: narrow ? "center" : "flex-start",
          borderRadius: narrow ? 5 : 7,
          padding: narrow ? "0 1px" : tight ? "3px 6px" : "5px 6px",
          overflow: "hidden",
          boxSizing: "border-box",
          opacity: dimmed ? 0.5 : done ? 0.6 : 1,
          ...shape,
        }}
      >
        {narrow ? (
          height >= 16 && width >= 22 ? (
            <span className={height >= 34 ? "clamp2" : "truncate"} style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: "14px", fontWeight: 600, letterSpacing: 0.2, textAlign: "center", color: ink, maxWidth: "100%" }}>{code}</span>
          ) : null
        ) : (
          <>
            <span style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: titleLines, overflow: "hidden", fontSize: 12.5, lineHeight: "16px", fontWeight: 600, color: look === "other" || look === "settled" ? colors.muted : colors.foreground }}>
              {session ? <span style={done ? { fontSize: 12, fontWeight: 700, color: colors.success } : { fontSize: 8, color: base }}>{done ? "✓ " : "● "}</span> : null}
              {title}
            </span>
            {showSub ? <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 500, marginTop: 2, color: look === "class" ? ink : colors.muted }}>{sub}</span> : null}
          </>
        )}
      </span>
    </button>
  );
});

// ── The grid ──────────────────────────────────────────────────

export interface TimeGridHandle {
  /** Bring the current time into view. */
  scrollToNow: (animated: boolean) => void;
}

interface Props {
  view: "days" | "week";
  /** The days on screen, in order (src/engine/week-view.ts visibleDates). */
  dates: readonly string[];
  data: WeekData;
  clock: Clock;
  onPressBlock: (blockId: string) => void;
  /** A day's badge in the "due" row. */
  onPressDue: (dateKey: string) => void;
  /** A day's header, seven days wide: look at that day closer. */
  onPressDay?: (dateKey: string) => void;
  /** Shown in place of the hours when the week has nothing in it. */
  empty?: ReactNode;
}

/** The width of the element, kept up to date as the window changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export const TimeGrid = forwardRef<TimeGridHandle, Props>(function TimeGrid({ view, dates, data, clock, onPressBlock, onPressDue, onPressDay, empty }, ref) {
  const colors = useColors();
  const { state } = useApp();
  const [frameRef, frameWidth] = useWidth<HTMLDivElement>();
  const layout = LAYOUT[view];
  const { hourHeight } = layout;
  const wide = view === "days";
  const columnWidth = Math.max(30, ((frameWidth || 360) - layout.pad * 2 - layout.rail - layout.gap * dates.length) / dates.length);
  const todayKey = clock.dateKey;
  const showsTodayColumn = dates.includes(todayKey);
  const nowHour = Math.floor(clock.minutes / 60);
  const { blocksByDate, dueByDate, sleepBlocks } = data;

  const taskById = useMemo(() => new Map(state.tasks.map((task) => [task.id, task])), [state.tasks]);
  const courseContext = useMemo(() => ({ classes: state.classes, tasks: state.tasks }), [state.classes, state.tasks]);

  // The grid shows at least 06:00-23:00 and grows to fit every block of the visible days — and, when today is one
  // of them, the current hour, so the "now" line is there late at night and early in the morning too.
  const range = useMemo(() => {
    const items: { startTime: string; endTime: string; type?: string }[] = [];
    for (const date of dates) for (const block of blocksByDate[date] ?? []) items.push(block);
    if (showsTodayColumn) {
      const pad = (n: number) => String(Math.max(0, Math.min(23, n))).padStart(2, "0");
      items.push({ startTime: `${pad(nowHour)}:00`, endTime: nowHour >= 23 ? "23:59" : `${pad(nowHour + 1)}:00` });
    }
    return computeVisibleHourRange(items);
  }, [blocksByDate, dates, showsTodayColumn, nowHour]);
  const totalHeight = gridHeight(range, hourHeight);
  const hourMarks = useMemo(() => Array.from({ length: range.endHour - range.startHour + 1 }, (_, i) => range.startHour + i), [range]);

  // Where each item is drawn (side by side where they overlap), and the extra click area above / below that makes
  // it at least 44px tall without reaching into a neighbour's (src/engine/week-layout.ts verticalTouchSlops).
  const geometry = useMemo(() => {
    const minLayoutMinutes = Math.ceil((layout.minBlock / hourHeight) * 60);
    const map: Record<string, { item: GridItem; top: number; height: number; left: number; width: number; slop: VerticalSlop }[]> = {};
    for (const date of dates) {
      const items: GridItem[] = (blocksByDate[date] ?? []).map((block): GridItem => ({ kind: "block", key: block.id, startTime: block.startTime, endTime: block.endTime, block }));
      const placed = layoutDayBlocks(items, { minDurationMinutes: minLayoutMinutes }).map(({ block: item, lane, laneCount }: LaidOutItem<GridItem>) => {
        const frame = blockFrame(item.startTime, item.endTime, range, hourHeight, layout.minBlock);
        const lanePos = laneFrame(lane, laneCount, columnWidth, 0, 2);
        // Drawn a little short of its end, so two blocks back to back read as two.
        return { item, top: frame.top + 1, height: Math.max(layout.minBlock - 2, frame.height - 3), left: lanePos.left, width: lanePos.width };
      });
      const slops = verticalTouchSlops(placed, totalHeight, MIN_TOUCH);
      map[date] = placed.map((p, index) => ({ ...p, slop: slops[index] ?? { top: 0, bottom: 0 } }));
    }
    return map;
  }, [blocksByDate, dates, range, hourHeight, layout.minBlock, columnWidth, totalHeight]);

  // ── Scrolling ───────────────────────────────────────────────
  // The hours scroll inside the grid. It scrolls to "now" by itself exactly once: the first time it is on screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollPending = useRef(true);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const hourHeightRef = useRef(hourHeight);

  const scrollToNow = useCallback((animated: boolean) => {
    scrollRef.current?.scrollTo({ top: scrollTargetForNow(clockRef.current.minutes, rangeRef.current, hourHeightRef.current), behavior: animated ? "smooth" : "auto" });
  }, []);
  useImperativeHandle(ref, () => ({ scrollToNow }), [scrollToNow]);

  useEffect(() => {
    if (!initialScrollPending.current || empty) return;
    initialScrollPending.current = false;
    scrollToNow(false);
  }, [scrollToNow, empty]);

  // When earlier hours are added above the grid keep the same hour under the pointer instead of letting the content jump.
  const previousStartHour = useRef(range.startHour);
  useEffect(() => {
    const grewUpwardBy = previousStartHour.current - range.startHour;
    previousStartHour.current = range.startHour;
    if (grewUpwardBy !== 0 && !initialScrollPending.current && scrollRef.current) {
      scrollRef.current.scrollTop = Math.max(0, scrollRef.current.scrollTop + grewUpwardBy * hourHeightRef.current);
    }
  }, [range.startHour]);

  // Switching between three and seven days changes the height of an hour: stay on the same time of day.
  useEffect(() => {
    const previous = hourHeightRef.current;
    hourHeightRef.current = hourHeight;
    if (previous !== hourHeight && !initialScrollPending.current && scrollRef.current) {
      scrollRef.current.scrollTop = Math.max(0, (scrollRef.current.scrollTop / previous) * hourHeight);
    }
  }, [hourHeight]);

  const hasDueRow = dates.some((date) => (dueByDate[date]?.length ?? 0) > 0);
  const rowFrame = { display: "flex", padding: `0 ${layout.pad}px`, gap: layout.gap } as const;

  return (
    <div ref={frameRef} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* The days. Today is outlined; seven days wide, a day opens three days from it. */}
      <div style={{ ...rowFrame, alignItems: "center" }}>
        <div style={{ width: layout.rail, flexShrink: 0 }} />
        {dates.map((date) => {
          const today = date === todayKey;
          const number = Number(date.slice(8, 10));
          const spoken = `${weekdayName(date)} ${number}${today ? ", today" : ""}`;
          const content = (
            <>
              <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, textTransform: "uppercase", letterSpacing: wide ? 1.2 : 0.5, color: today ? colors.peri : colors.muted }}>{weekdayOfKey(date)}</span>
              <span style={{ fontSize: wide ? 16 : 15, lineHeight: wide ? "21px" : "20px", fontWeight: 600, color: colors.foreground }}>{number}</span>
            </>
          );
          const cell = {
            width: columnWidth,
            height: wide ? 40 : 48,
            borderRadius: 10,
            border: `1px solid ${today ? alpha(colors.accent, 0.7) : "transparent"}`,
            background: today ? alpha(colors.primary, 0.18) : "transparent",
            display: "flex",
            flexDirection: wide ? ("row" as const) : ("column" as const),
            alignItems: "center",
            justifyContent: "center",
            gap: wide ? 7 : 0,
            flexShrink: 0,
          };
          return onPressDay ? (
            <button key={date} type="button" className="pressable" style={cell} onClick={() => onPressDay(date)} aria-label={spoken} title="Shows three days from this day">
              {content}
            </button>
          ) : (
            <div key={date} style={cell} aria-label={spoken}>
              {content}
            </div>
          );
        })}
      </div>

      {/* What is due each day, in gold. One target per day: a single item opens it, several open the day's list. */}
      {hasDueRow ? (
        <div style={{ ...rowFrame, alignItems: "center", minHeight: 28, marginTop: 6 }}>
          <div style={{ width: layout.rail, flexShrink: 0 }}>
            <span className="truncate" style={{ display: "block", fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: colors.muted }}>Due</span>
          </div>
          {dates.map((date) => {
            const due = dueByDate[date] ?? [];
            const total = due.length;
            if (total === 0) return <div key={date} style={{ width: columnWidth, flexShrink: 0 }} />;
            const first = due[0]!;
            const firstKind = classifyTaskKind(first);
            // A quiz or an exam gets its short label and the flag ("QUIZ 10"); anything else its own name.
            const tested = firstKind === "exam" || firstKind === "quiz";
            const label = !wide ? String(total) : tested ? deadlineChipLabel(first, classShortName(classOfTask(first, state.classes))) : first.name;
            return (
              <button
                key={date}
                type="button"
                className="pressable"
                style={{ width: columnWidth, minHeight: 28, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0 }}
                onClick={() => onPressDue(date)}
                aria-label={`${weekdayName(date)}. Due: ${due.map((task) => task.name).join(", ")}. ${total === 1 ? "Opens the task" : "Opens the list"}`}
              >
                <DateBadge compact label={label} suffix={wide && total > 1 ? `+${total - 1}` : undefined} tone="gold" left={wide && tested && total === 1 ? <Icon name="flag" size={13} color={colors.gold} strokeWidth={2} /> : undefined} style={wide ? { alignSelf: "stretch", width: "100%", justifyContent: "center" } : { minWidth: 24, justifyContent: "center", padding: "0 4px" }} />
              </button>
            );
          })}
        </div>
      ) : null}

      {/* The hours */}
      <div ref={scrollRef} className="grid-scroll" style={{ marginTop: 6 }}>
        {empty ?? (
          <div style={{ ...rowFrame, paddingTop: GRID_PAD_TOP, paddingBottom: GRID_PAD_BOTTOM, position: "relative" }}>
            <div style={{ width: layout.rail, height: totalHeight, position: "relative", flexShrink: 0 }}>
              {hourMarks.map((hour) => (
                <span key={hour} style={{ position: "absolute", right: 4, top: (hour - range.startHour) * hourHeight - 8, fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", textAlign: "right", color: colors.muted, whiteSpace: "nowrap" }}>
                  {hourRailLabel(hour, !wide)}
                </span>
              ))}
            </div>

            {dates.map((date) => {
              const isTodayColumn = date === todayKey;
              const nowY = isTodayColumn ? currentTimeY(clock.minutes, range, hourHeight) : null;
              return (
                <div key={date} style={{ width: columnWidth, height: totalHeight, position: "relative", flexShrink: 0, background: isTodayColumn ? alpha(colors.primary, 0.08) : "transparent" }}>
                  {hourMarks.map((hour) => (
                    <div key={hour} aria-hidden style={{ position: "absolute", left: 0, right: 0, top: (hour - range.startHour) * hourHeight, height: 1, background: colors.border, pointerEvents: "none" }} />
                  ))}
                  {sleepBandsForDate(date, sleepBlocks, range).map((band, index) => (
                    <SleepBand key={`sleep-${index}`} top={minutesToY(band.startMinutes, range, hourHeight)} height={((band.endMinutes - band.startMinutes) / 60) * hourHeight} color={colors.violet} />
                  ))}
                  {(geometry[date] ?? []).map(({ item, top, height, left, width, slop }) => {
                    const narrow = !wide || width < 64;
                    const block = item.block;
                    const task = block.taskId ? taskById.get(block.taskId) : undefined;
                    const courseLabel = blockCourseLabel(block, courseContext);
                    const study = block.type === "study";
                    const done = block.completionStatus === "done";
                    const dimmed = block.completionStatus === "skipped" || block.completionStatus === "missed";
                    const look: BlockLook = block.type === "class" ? "class" : !study ? "other" : done || dimmed ? "settled" : isFlexibleSession(block) ? "flexible" : "kept";
                    // The line under a session's name: "Exam prep", or which day it is due (the time of day does not fit).
                    const dueDay = study && task && task.status !== "done" && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate ?? "") ? `due ${relativeDayLabel(task.dueDate, todayKey)}` : null;
                    const text = study ? gridSessionText(sessionDisplayTitle(block.title, task?.courseName)) : { title: block.title, sub: compactTimeRange(block.startTime, block.endTime) };
                    const sub = text.sub ?? dueDay ?? formatDuration(Math.max(0, getDurationMinutes(block.startTime, block.endTime)));
                    return (
                      <GridBlock
                        key={item.key}
                        id={block.id}
                        look={look}
                        color={block.type === "class" || study ? block.color : undefined}
                        top={top}
                        height={height}
                        left={left}
                        width={width}
                        narrow={narrow}
                        title={text.title}
                        sub={sub}
                        code={narrowBlockLabel(block.type === "class" || study ? courseLabel : undefined, block.title, height >= 34 ? 2 : 1)}
                        done={done}
                        dimmed={dimmed}
                        slop={slop}
                        ariaLabel={`${describeBlockForA11y(block, courseLabel)}${dueDay && task ? `. For ${task.name}, ${dueDay}` : ""}. Opens the details`}
                        onPress={onPressBlock}
                      />
                    );
                  })}
                  {nowY !== null ? (
                    <div aria-hidden style={{ position: "absolute", left: -4, right: 0, top: nowY - 5, display: "flex", alignItems: "center", zIndex: 10, pointerEvents: "none" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 5, background: colors.accent }} />
                      <span style={{ flex: 1, height: 2, marginLeft: -2, background: colors.accent }} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
