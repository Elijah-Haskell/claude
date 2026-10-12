// Week — the second screen: the plan on a calendar, in three views of the same thing.
// Top to bottom: which part of the term this is ("Fall 2026 · Week 6 of 16"), the dates on screen as the title and
// an "Update plan" button; back and forward buttons either side of the switch "3 days / Week / Month" (the app
// remembers the view; three days is where it starts, because names fit on the blocks); then the view itself:
//   - 3 days and Week: src/components/time-grid.tsx (days, a "due" row in gold, the hours and the blocks);
//   - Month: src/components/month-view.tsx (what is due each day, and the day that is picked).
// A quiet row appears above the view only when it has something to say: "N to review" when the plan needs a look
// (the same list and fixes as Today's card) and "Back to today" when the page does not show today.
// Planning is automatic: "Update plan" runs the planner now (undoable), replanning is on Today, and adding is the add
// button at the end of the tab bar. Clicking a block opens its sheet; clicking what is due opens the task's sheet.
// The left and right arrow keys turn the page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { alpha } from "../engine/design";
import { planStatusFor } from "../engine/plan-alerts";
import { isDateKey } from "../engine/semester";
import { shortDateLabel, taskBadge } from "../engine/task-list";
import { parseLocalDate, weekStartKeyOf } from "../engine/utils";
import { defaultAddDate, isFlexibleSession, weekdayName } from "../engine/week-layout";
import { WEEK_VIEWS, dateRangeTitle, defaultMonthDay, isWeekView, monthCells, monthMarks, monthTitle, periodEyebrow, showsToday, stepAnchor, visibleDates, type WeekView } from "../engine/week-view";
import { FlexibleSessionsTip } from "../components/block-sheet";
import { MonthView } from "../components/month-view";
import { PlanReviewSheet } from "../components/plan-status";
import { TimeGrid, useWeekData, type TimeGridHandle } from "../components/time-grid";
import { useNavigate, useRoute } from "../router";
import { useApp } from "../state/app-provider";
import { PREF_KEYS, readPref, writePref } from "../state/local-prefs";
import { useGlobalModal } from "../state/modal-context";
import { useClock } from "../state/use-clock";
import { Icon, IconWell } from "../ui/icon";
import { DateBadge, HeaderIconButton, PrimaryButton, ScreenHeader, Segmented, TileRow, eyebrowStyle } from "../ui/primitives";
import { Sheet, SheetBody } from "../ui/sheet";
import { useColors } from "../ui/theme";

/** Back / forward, either side of the view switch. */
function PageButton({ back, label, onPress }: { back?: boolean; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <button type="button" className="pressable" aria-label={label} title={label} onClick={onPress} style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: colors.surface, border: `1px solid ${colors.borderStrong}` }}>
      <Icon name={back ? "chevronLeft" : "chevronRight"} size={20} color={colors.foreground} strokeWidth={2} />
    </button>
  );
}

export function WeekScreen() {
  const colors = useColors();
  const navigate = useNavigate();
  const route = useRoute();
  const { state, dispatch, isHydrated } = useApp();
  const { openAdd, setEventDay, openBlock, openTask } = useGlobalModal();

  // Clock: moves the "now" line (and the date across midnight). Deliberately NOT connected to scrolling.
  const clock = useClock();
  const todayKey = clock.dateKey;

  // ── Which view, and which page of it ────────────────────────
  // A link may choose the view ("?view=month") or ask for a week's days ("?week=YYYY-MM-DD").
  const linkedWeek = isDateKey(route.query.week) ? route.query.week : "";
  const linkedView = isWeekView(route.query.view) ? route.query.view : null;
  const [view, setView] = useState<WeekView>(() => {
    if (linkedView) return linkedView;
    const saved = readPref(PREF_KEYS.weekView);
    const remembered = isWeekView(saved) ? saved : "days";
    return linkedWeek && remembered === "month" ? "week" : remembered;
  });

  // The page is known by one day on it: the first of the three days, a day of the week, a day of the month.
  const [anchorKey, setAnchorKey] = useState(linkedWeek || todayKey);
  // The day picked in the month (null = the month's own choice: today, or its first day with something due).
  const [monthDay, setMonthDay] = useState<string | null>(linkedWeek && linkedView === "month" ? linkedWeek : null);
  // Midnight: a page that was anchored on today follows today.
  const lastToday = useRef(todayKey);
  useEffect(() => {
    const was = lastToday.current;
    lastToday.current = todayKey;
    if (was !== todayKey) setAnchorKey((anchor) => (anchor === was ? todayKey : anchor));
  }, [todayKey]);

  const dates = useMemo(() => visibleDates(view === "days" ? "days" : "week", anchorKey), [view, anchorKey]);
  const data = useWeekData(dates);
  const marks = useMemo(() => monthMarks(state.tasks, state.classes), [state.tasks, state.classes]);
  const monthDays = useMemo(() => monthCells(anchorKey), [anchorKey]);
  const pickedDay = monthDay && monthDays.some((cell) => cell.key === monthDay) ? monthDay : defaultMonthDay(anchorKey, todayKey, (key) => marks.has(key));

  const title = view === "month" ? monthTitle(anchorKey, todayKey) : dateRangeTitle(dates[0]!, dates[dates.length - 1]!);
  const eyebrow = useMemo(() => {
    const inMonth = monthDays.filter((cell) => cell.inMonth);
    const first = view === "month" ? inMonth[0]?.key ?? anchorKey : dates[0]!;
    const last = view === "month" ? inMonth[inMonth.length - 1]?.key ?? anchorKey : dates[dates.length - 1]!;
    return periodEyebrow(view, first, last, state.semester);
  }, [view, dates, monthDays, anchorKey, state.semester]);
  const onToday = showsToday(view, anchorKey, todayKey);

  // The add button opens the event form on the day in view: the day picked in the month, today when the page shows
  // it, otherwise the page's first day. Only while this screen is on screen.
  const dayInView = view === "month" ? pickedDay : onToday ? todayKey : dates[0]!;
  useEffect(() => {
    setEventDay(dayInView);
    return () => setEventDay(null);
  }, [dayInView, setEventDay]);

  const gridRef = useRef<TimeGridHandle>(null);

  const changeView = useCallback((next: WeekView) => {
    if (next === view) return;
    // Out of the month: start from the day picked there. From the week to three days: today when the week holds
    // it, otherwise the week's Monday.
    if (view === "month") setAnchorKey(pickedDay);
    else if (view === "week" && next === "days") setAnchorKey((anchor) => (showsToday("week", anchor, todayKey) ? todayKey : weekStartKeyOf(anchor)));
    setMonthDay(null);
    setView(next);
    writePref(PREF_KEYS.weekView, next);
  }, [view, pickedDay, todayKey]);

  const page = useCallback((direction: 1 | -1) => {
    setAnchorKey((anchor) => stepAnchor(view, anchor, direction, todayKey));
    setMonthDay(null);
  }, [view, todayKey]);

  // The arrow keys turn the page (unless the student is typing somewhere).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "ArrowLeft") page(-1);
      else if (event.key === "ArrowRight") page(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);

  const goToToday = useCallback(() => {
    setAnchorKey(todayKey);
    setMonthDay(null);
    setTimeout(() => gridRef.current?.scrollToNow(true), 80);
  }, [todayKey]);

  /** A day's header in the seven-day view, or "N study sessions that day" in the month: three days from that day. */
  const openDay = useCallback((dateKey: string) => {
    setAnchorKey(dateKey);
    setMonthDay(null);
    setView("days");
  }, []);

  // ── Plan status: the same as Today's card, here "N to review", which opens the same review sheet ──
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const planStatus = useMemo(() => planStatusFor(state, new Date()), [state.tasks, state.scheduleBlocks, state.planAlerts, state.userPrefs, clock]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  // ── Planning: the first plan, and weeks ahead that have nothing in them yet ──
  const weekStartKey = weekStartKeyOf(dates[0]!);
  const hasPlanInputs = state.classes.length > 0 || state.recurringEvents.length > 0 || state.tasks.some((task) => task.status === "pending" || task.status === "scheduled");

  // Opened before anything is planned (straight after the first-time setup): build the plan now, once, but only
  // when there is something to plan.
  const firstBuildDone = useRef(false);
  useEffect(() => {
    if (!isHydrated || firstBuildDone.current) return;
    if (state.scheduleBlocks.some((block) => block.type !== "sleep")) {
      firstBuildDone.current = true;
      return;
    }
    if (!hasPlanInputs) return;
    const timer = setTimeout(() => {
      if (firstBuildDone.current) return;
      firstBuildDone.current = true;
      dispatch({ type: "AUTO_BUILD_WEEK", payload: { weekStart: parseLocalDate(weekStartKey) } });
    }, 400);
    return () => clearTimeout(timer);
  }, [isHydrated, state.scheduleBlocks, hasPlanInputs, dispatch, weekStartKey]);

  // A week ahead with nothing in it is built on demand, once per week. If the planner still yields nothing the
  // empty state below explains it; it must never re-dispatch in a loop.
  const attemptedWeekBuilds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isHydrated || view === "month" || !hasPlanInputs) return;
    const thisWeek = weekStartKeyOf(todayKey);
    for (const start of data.emptyWeekStarts) {
      if (start <= thisWeek || attemptedWeekBuilds.current.has(start)) continue;
      attemptedWeekBuilds.current.add(start);
      dispatch({ type: "BUILD_WEEK_FOR", payload: { weekStart: parseLocalDate(start) } });
    }
  }, [isHydrated, view, data.emptyWeekStarts, hasPlanInputs, todayKey, dispatch]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    // The automatic planner, run now and undoable: when sessions move the screens show "Plan updated · Undo".
    dispatch({ type: "AUTO_REPLAN", payload: { weekStart: parseLocalDate(weekStartKey), label: "Plan updated" } });
    setTimeout(() => setIsRefreshing(false), 650);
  }, [dispatch, isRefreshing, weekStartKey]);

  // ── What is open: a day's list ──
  const [dueDay, setDueDay] = useState<string | null>(null);

  // A day of the "due" row: one item opens it (the task's sheet), several open the day's list.
  const openDueDay = useCallback((date: string) => {
    const due = data.dueByDate[date] ?? [];
    if (due.length === 1) openTask(due[0]!.id);
    else setDueDay(date);
  }, [data.dueByDate, openTask]);

  const showsFlexible = view !== "month" && dates.some((date) => (data.blocksByDate[date] ?? []).some(isFlexibleSession));
  const statusColor = planStatus?.severity === "critical" ? colors.error : colors.gold;
  const emptyTitle = dates[dates.length - 1]! < todayKey ? "Nothing was planned this week" : "Nothing is planned this week";
  const pageWord = view === "month" ? "month" : view === "week" ? "week" : "three days";

  const empty = !data.weekHasContent ? (
    <div aria-label={`${emptyTitle}. Trajectory builds your plan automatically.`} style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 10, padding: "36px 24px" }}>
      <IconWell name="cal" size={48} color={colors.peri} background={alpha(colors.peri, 0.12)} />
      <div style={{ fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.4, color: colors.foreground }}>{emptyTitle}</div>
      <div style={{ fontSize: 14, lineHeight: "20px", color: colors.muted, maxWidth: 420 }}>
        {hasPlanInputs
          ? "Trajectory builds your plan by itself from your classes, commitments and deadlines. If this week should have something in it, use Update plan."
          : "Add a syllabus or your classes, and Trajectory plans your whole semester for you."}
      </div>
      {!hasPlanInputs ? <PrimaryButton label="Add a syllabus" left={<Icon name="upload" size={17} color="#fff" />} onPress={() => navigate("syllabus")} style={{ marginTop: 6 }} /> : null}
      <PrimaryButton label="Add an event" tone="ghost" size="sm" left={<Icon name="calPlus" size={16} color={colors.peri} />} onPress={() => openAdd({ kind: "event", date: defaultAddDate(weekStartKey, todayKey) })} ariaLabel="Add an event to this week" />
    </div>
  ) : undefined;

  return (
    <div className="screen">
      {/* 1 · Where in the term, the dates on screen, and Update plan */}
      <ScreenHeader
        eyebrow={eyebrow}
        title={title}
        right={
          <HeaderIconButton ariaLabel={isRefreshing ? "Updating your plan" : "Update plan: run the planner now (you can undo it)"} onPress={handleRefresh}>
            {isRefreshing ? <span className="spinner" style={{ width: 18, height: 18 }} /> : <Icon name="refresh" size={19} color={colors.foreground} strokeWidth={2} />}
          </HeaderIconButton>
        }
      />

      {/* 2 · Back, the three views, forward */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PageButton back label={`Earlier: the ${pageWord} before`} onPress={() => page(-1)} />
        <Segmented style={{ flex: 1 }} options={WEEK_VIEWS.map((option) => ({ value: option.value, label: option.label, ariaLabel: option.accessibilityLabel }))} value={view} onChange={changeView} />
        <PageButton label={`Later: the next ${pageWord}`} onPress={() => page(1)} />
      </div>

      {/* Only when there is something to say: the plan needs a look, or this page does not show today */}
      {planStatus || !onToday ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 28 }}>
          {planStatus ? (
            <button type="button" className="pressable" onClick={() => setReviewOpen(true)} aria-label={`Plan status: ${planStatus.headline}. ${planStatus.summary}. Review ${planStatus.items.length}, each with its fix`} style={{ height: 28, padding: "0 10px", borderRadius: 9, border: `1px solid ${alpha(statusColor, 0.5)}`, background: alpha(statusColor, 0.12), fontSize: 13, fontWeight: 600, color: statusColor }}>
              {`${planStatus.items.length} to review`}
            </button>
          ) : (
            <span />
          )}
          {!onToday ? (
            <button type="button" className="link" onClick={goToToday} aria-label="Back to today" style={{ fontSize: 14, fontWeight: 600, color: colors.peri, minHeight: 28 }}>Back to today</button>
          ) : null}
        </div>
      ) : null}

      {/* Once: what the dashed (flexible) sessions on this grid are, and how to keep one */}
      <FlexibleSessionsTip visible={showsFlexible} />

      {/* 3 · The view */}
      {view === "month" ? (
        <MonthView anchorKey={anchorKey} todayKey={todayKey} selectedKey={pickedDay} marks={marks} onSelect={setMonthDay} onOpenTask={openTask} onOpenDay={openDay} />
      ) : (
        <TimeGrid ref={gridRef} view={view} dates={dates} data={data} clock={clock} onPressBlock={openBlock} onPressDue={openDueDay} onPressDay={view === "week" ? openDay : undefined} empty={empty} />
      )}

      {/* A day's deadlines, when the "due" row has more than one for it */}
      <Sheet open={dueDay !== null} onClose={() => setDueDay(null)} ariaLabel="What is due that day">
        <SheetBody>
          <div style={eyebrowStyle(colors.peri, 12)}>{dueDay ? `Due ${weekdayName(dueDay)}, ${shortDateLabel(dueDay)}` : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(dueDay ? data.dueByDate[dueDay] ?? [] : []).map((task) => {
              const badge = taskBadge(task, todayKey);
              return (
                <TileRow
                  key={task.id}
                  icon="flag"
                  iconColor={colors.gold}
                  iconBackground={alpha(colors.gold, 0.15)}
                  title={task.name}
                  subtitle={task.courseName && task.courseName !== "General" ? task.courseName : undefined}
                  ariaLabel={`${task.name}, ${badge.spoken}. Opens the task`}
                  onPress={() => {
                    setDueDay(null);
                    openTask(task.id);
                  }}
                  right={<DateBadge label={badge.label} tone={badge.tone} />}
                />
              );
            })}
          </div>
          <PrimaryButton label="Close" tone="ghost" fullWidth onPress={() => setDueDay(null)} ariaLabel="Close this day's list" />
        </SheetBody>
      </Sheet>

      {/* The plan status, item by item with its fix (the same sheet Today's card opens) */}
      <PlanReviewSheet visible={reviewOpen} status={planStatus} onClose={closeReview} />
    </div>
  );
}
