/**
 * Plan stability (1.0.8): the automatic re-plan (day roll, completing a session, an input edit) keeps every still-valid
 * study suggestion where it is and only solves the difference, so following the plan no longer reshuffles it.
 *
 * Numbers measured with this harness (5-course fixture, tests/fixtures/stress-semester.ts), before -> after, the same
 * in UTC, Los Angeles, Tokyo and Sydney:
 *   Repro (plan Mon 7 Sep 08:00, finish one session, re-plan 23:30): future sessions on another slot than without the
 *   completion 106 of 192 -> 0 of 192; finishing all 4 of the day's sessions 140 of 190 -> 0 of 190.
 *   28 days day by day (7 Sep - 4 Oct), most sessions finished, some skipped or left: sessions moved per morning roll
 *   max 112 (352 in all) -> 0 (0-2 make-up sessions added); the re-plan right after each completion changed 3129
 *   sessions in 41 re-plans -> 7 in 47 (once, two quizzes with no room get it by moving 3 homework sessions).
 *   Previewed changes on a plan lived in for 3 weeks (28 Sep): other sessions moved by a midterm 3 days earlier
 *   106 of 156 -> 0, 7 days later 108 -> 0; an assistant change (new deadline + new task) 109 of 159 -> 0; importing a
 *   5th course 107 of 128 -> 16 (exactly the 16 under its new class meetings).
 *
 * 1.0.9 (every moved session must win back 10 more minutes; let-go sessions the short work does not need go back):
 *   the semester lived for 91 days moved 130 sessions on 10 mornings (max 45) -> 21 on 7 (max 6), never more tasks
 *   left with no time than a plan made from scratch the same morning and at most 2 h more work short (it was taking
 *   that fresh plan wholesale). Dragging sessions onto a full day of that semester gave another plan on every re-plan at
 *   the same minute in 12 of 401 probed drags -> 0. FINC Exam 1 with its Exam Prep: 240 + 405 -> 405 minutes planned.
 *
 * 1.0.9 review: a 3-8 h assignment added to a full week on 171 sampled mornings ended more than 30 min shorter than a
 *   fresh plan 23 times (worst: none of 480 min) -> 0, at most 17 sessions moved; a quiz due the next morning next to a
 *   dragged session 60 of 90 min -> 90; automatic re-plans of the 91-day semester p95 25 -> 11 ms with the same plans.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { previewTaskEdit, reducer, runReplan } from "../../src/engine/app-context";
import { applyAssistantChange, previewAssistantChange } from "../../src/engine/assistant-change";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { MAX_AUTOMATIC_MOVES } from "../../src/engine/week-planner";
import { detectDrift, diffPlans, undoAlsoRestores } from "../../src/engine/replan";
import { countConflicts } from "../../src/engine/plan-quality";
import { examsPlannedByPrep, followExamDates, prepCredit, withLinkedExam } from "../../src/engine/exam-prep-link";
import { buildExamRunway } from "../../src/engine/exam-runway";
import { realityCheckFor, studyLoadCaps } from "../../src/engine/workload-analysis";
import { createInitialState } from "../../src/engine/state-persistence";
import { deadlinePassed, isAssessmentTask, taskDeadline } from "../../src/engine/task-kind";
import { getPlanningWindow } from "../../src/engine/awake-window";
import { runwayDaysFor } from "../../src/engine/exam-prep-plan";
import { blockMinutes, remainingMinutes } from "../../src/engine/task-progress";
import type { AppState, ExamPrep, RecurringEvent, ScheduleBlock, Semester } from "../../src/engine/types";
import { addDaysToKey, daysBetweenKeys, localDateKey, timeToMinutes } from "../../src/engine/utils";
import { fincState, fiveCourseState } from "./fixtures/stress-semester";
import { makeBlock, makeClass, makeTask, NOW } from "./scheduler-fixtures";

type Action = Parameters<typeof reducer>[1];
const run = (state: AppState, ...actions: Action[]) => actions.reduce(reducer, state);
const at = (date: string, hour: number, minute = 0) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour, minute);
};
const hhmm = (now: Date) => `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
const slotKey = (b: ScheduleBlock) => `${b.taskId}|${b.date}|${b.startTime}|${b.endTime}`;
const upcomingStudy = (blocks: ScheduleBlock[], now: Date) => {
  const today = localDateKey(now);
  const time = hhmm(now);
  return blocks.filter((b) => b.type === "study" && b.taskId && b.completionStatus === "pending" && (b.date > today || (b.date === today && b.endTime > time)));
};

/** Sessions of `after` (from `fromDate` on) whose task + slot does not exist in `before`. */
function changedSlots(before: ScheduleBlock[], after: ScheduleBlock[], fromDate: string): { changed: number; total: number } {
  const pool = new Map<string, number>();
  for (const b of before) if (b.type === "study" && b.completionStatus === "pending" && b.date >= fromDate) pool.set(slotKey(b), (pool.get(slotKey(b)) ?? 0) + 1);
  const mine = after.filter((b) => b.type === "study" && b.completionStatus === "pending" && b.date >= fromDate);
  let changed = 0;
  for (const b of mine) {
    const left = pool.get(slotKey(b)) ?? 0;
    if (left > 0) pool.set(slotKey(b), left - 1);
    else changed += 1;
  }
  return { changed, total: mine.length };
}

/** What an automatic re-plan did to the upcoming sessions (the "Plan updated" numbers). */
function movesOf(before: AppState, after: AppState, now: Date) {
  const live = (b: ScheduleBlock) => b.completionStatus === "pending";
  const diff = diffPlans(before.scheduleBlocks.filter(live), after.scheduleBlocks.filter(live), { tasks: after.tasks, recurringEvents: after.recurringEvents, now });
  return { moved: diff.moved.length, added: diff.added.length, removed: diff.removed.length };
}

/** Deterministic "random" 0-99 per session id. */
const roll = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return Math.abs(h) % 100;
};

/** Every invariant the plan must keep, as readable violations (empty = all good). */
function violations(state: AppState, now: Date): string[] {
  const out: string[] = [];
  const today = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const upcoming = upcomingStudy(state.scheduleBlocks, now);
  const tasksById = new Map(state.tasks.map((t) => [t.id, t]));
  const window = getPlanningWindow(state.healthPrefs.wakeTime, state.healthPrefs.bedtime);
  const shortBy = new Map((state.planAlerts?.shortfalls ?? []).map((s) => [s.taskId, s.missingMinutes]));
  const coverage = new Map<string, number>();
  const perDay = new Map<string, number>();

  for (const b of upcoming) {
    const task = tasksById.get(b.taskId!);
    if (!task || task.status === "done" || task.status === "skipped") {
      out.push(`orphan ${b.id}`);
      continue;
    }
    coverage.set(task.id, (coverage.get(task.id) ?? 0) + blockMinutes(b));
    const deadline = taskDeadline(task, state.classes, state.semester);
    const passed = deadlinePassed(deadline, today, nowMinutes);
    const deferredPast = (task.notBeforeDate ?? "").slice(0, 10) > deadline.dueKey;
    if (passed && isAssessmentTask(task)) out.push(`prep after a quiz/exam took place ${b.id}`);
    if (!passed && !deferredPast) {
      const late = b.date > deadline.dueKey || (b.date === deadline.dueKey && deadline.cutoffMinutes !== undefined && timeToMinutes(b.endTime) > deadline.cutoffMinutes);
      if (late) out.push(`late ${b.id} (due ${task.dueDate} ${task.dueTime ?? ""})`);
      const limit = Math.max(14, 2 * runwayDaysFor(task.kind ?? "other", Math.ceil(task.estimatedMinutes / 90)));
      if (daysBetweenKeys(b.date, deadline.dueKey) > limit) out.push(`outside runway ${b.id} (due ${task.dueDate})`);
    }
    if (timeToMinutes(b.startTime) < window.start || timeToMinutes(b.endTime) > window.end) out.push(`sleep window ${b.id} ${b.startTime}-${b.endTime}`);
  }
  for (const b of state.scheduleBlocks) {
    if (b.type === "study" && b.date >= today && (b.completionStatus === "pending" || b.completionStatus === "done")) perDay.set(b.date, (perDay.get(b.date) ?? 0) + 1);
  }
  for (const [date, n] of perDay) if (n > 4) out.push(`${n} sessions on ${date}`);
  const conflicts = countConflicts(state.scheduleBlocks, state, { fromDate: today });
  if (conflicts > 0) out.push(`${conflicts} conflicts`);
  // Bend, never drop: every open task's remaining work is planned or reported as a shortfall, and nothing is planned twice.
  // An exam with an Exam Prep is ONE piece of work with it (lib/exam-prep-link.ts): the exam's sessions (and an older
  // prep's) count toward the prep that plans it, and the exam needs nothing of its own (1.0.8 planned both). Once the
  // prep is finished, its finished minutes count toward the exam.
  const plannedBy = examsPlannedByPrep(followExamDates(state.tasks));
  const credit = prepCredit(followExamDates(state.tasks));
  const unit = new Map<string, number>();
  for (const [taskId, minutes] of coverage) unit.set(plannedBy.get(taskId) ?? taskId, (unit.get(plannedBy.get(taskId) ?? taskId) ?? 0) + minutes);
  for (const task of state.tasks) {
    if (task.status !== "pending" && task.status !== "scheduled") continue;
    if (plannedBy.has(task.id)) continue;
    const deadline = taskDeadline(task, state.classes, state.semester);
    if (isAssessmentTask(task) && deadlinePassed(deadline, today, nowMinutes)) continue;
    const need = Math.max(0, remainingMinutes(task) - (credit.get(task.id) ?? 0));
    const covered = unit.get(task.id) ?? 0;
    const have = covered + (shortBy.get(task.id) ?? 0);
    if (have < need) out.push(`dropped ${task.id}: ${have} of ${need}`);
    if (covered >= need + 25) out.push(`planned twice ${task.id}: ${covered} for ${need}`);
  }
  return out;
}

const MONDAY = "2026-09-07";
const fresh = () => run({ ...createInitialState(), ...fiveCourseState() }, { type: "AUTO_BUILD_WEEK", payload: { now: at(MONDAY, 8) } });

/**
 * One day of `date` lived like the 1.0.8 audit's student: ~70% of the day's sessions finished (each followed by the
 * automatic re-plan), ~10% skipped, the rest left unticked (missed, so the plan needs make-ups and runs out of room).
 */
function liveTheDay(start: AppState, date: string, replan: (state: AppState, now: Date) => AppState = autoReplan): AppState {
  let state = start;
  const todays = state.scheduleBlocks
    .filter((b) => b.type === "study" && b.date === date && b.completionStatus === "pending")
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (const planned of todays) {
    const block = state.scheduleBlocks.find((b) => b.id === planned.id && b.completionStatus === "pending");
    if (!block) continue;
    const r = roll(`semester|${block.id}`);
    const end = at(date, Math.floor(timeToMinutes(block.endTime) / 60), timeToMinutes(block.endTime) % 60);
    if (r < 70) state = replan(reducer(state, { type: "COMPLETE_BLOCK", payload: block.id }), new Date(end.getTime() + 60_000));
    else if (r < 80) state = reducer(state, { type: "SKIP_BLOCK", payload: block.id });
  }
  return state;
}
function autoReplan(state: AppState, now: Date): AppState {
  return reducer(state, { type: "AUTO_REPLAN", payload: { now } });
}

describe("following the plan no longer reshuffles it (audit finding 1)", () => {
  it("repro: finishing one session and re-planning at 23:30 moves at most a handful of later sessions", () => {
    const morning = fresh();
    const todays = morning.scheduleBlocks.filter((b) => b.type === "study" && b.date === MONDAY && b.completionStatus === "pending").sort((a, b) => a.startTime.localeCompare(b.startTime));
    const target = todays.find((b) => b.id === "study-calc-quiz2-1-2026-09-07") ?? todays[0]!;
    const night = at(MONDAY, 23, 30);
    const baseline = run(morning, { type: "AUTO_REPLAN", payload: { now: night } });
    const one = run(morning, { type: "COMPLETE_BLOCK", payload: target.id }, { type: "AUTO_REPLAN", payload: { now: night } });
    const all = run(morning, ...todays.map((b): Action => ({ type: "COMPLETE_BLOCK", payload: b.id })), { type: "AUTO_REPLAN", payload: { now: night } });
    const tomorrow = addDaysToKey(MONDAY, 1);
    const repro = changedSlots(baseline.scheduleBlocks, one.scheduleBlocks, tomorrow);
    const reproAll = changedSlots(baseline.scheduleBlocks, all.scheduleBlocks, tomorrow);
    const vsMorning = changedSlots(morning.scheduleBlocks, one.scheduleBlocks, tomorrow);
    console.log(`repro: ${repro.changed} of ${repro.total} future sessions on another slot than without the completion (${target.id})`);
    console.log(`repro all: ${reproAll.changed} of ${reproAll.total} after finishing all ${todays.length} of the day's sessions`);
    console.log(`vs the morning plan: ${vsMorning.changed} of ${vsMorning.total} future sessions changed`);
    expect(repro.changed).toBeLessThanOrEqual(10);
    expect(reproAll.changed).toBeLessThanOrEqual(10);
    expect(violations(one, night)).toEqual([]);
  });

  it("28 days, day by day, ~70% of sessions finished: small daily changes, every invariant holds every day", () => {
    let state = fresh();
    const daily: string[] = [];
    const rolls: number[] = [];
    let completions = 0;
    let finished = 0;
    let skipped = 0;
    let offered = 0;
    let afterCompletionMoves = 0;
    for (let day = 0; day < 28; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      const morning = at(date, 7, 30);
      if (day > 0) {
        const before = state;
        state = reducer(state, { type: "AUTO_REPLAN", payload: { now: morning } });
        const moves = movesOf(before, state, morning);
        rolls.push(moves.moved + moves.removed);
        daily.push(`${date.slice(5)} ${moves.moved}m/${moves.added}a/${moves.removed}r`);
        // Idempotent: a second run changes nothing and stacks no second snapshot.
        const again = reducer(state, { type: "AUTO_REPLAN", payload: { now: morning } });
        expect(again.scheduleBlocks, `second run on ${date}`).toEqual(state.scheduleBlocks);
        expect(again.undoSnapshots?.length).toBe(state.undoSnapshots?.length);
        // Undo is exact.
        if (state.undoSnapshots?.[0] && state.undoSnapshots[0].at === morning.toISOString()) {
          expect(reducer(state, { type: "UNDO_REPLAN" }).scheduleBlocks).toBe(before.scheduleBlocks);
        }
      }
      expect(violations(state, morning), `after the ${date} roll`).toEqual([]);

      const todays = state.scheduleBlocks
        .filter((b) => b.type === "study" && b.date === date && b.completionStatus === "pending")
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (const planned of todays) {
        const block = state.scheduleBlocks.find((b) => b.id === planned.id && b.completionStatus === "pending");
        if (!block) continue;
        offered += 1;
        const r = roll(block.id);
        const end = at(date, Math.floor(timeToMinutes(block.endTime) / 60), timeToMinutes(block.endTime) % 60);
        if (r < 70) {
          finished += 1;
          const before = reducer(state, { type: "COMPLETE_BLOCK", payload: block.id });
          // The app re-plans right after a completion (its minutes change the plan inputs).
          const after = reducer(before, { type: "AUTO_REPLAN", payload: { now: new Date(end.getTime() + 60_000) } });
          const moves = movesOf(before, after, end);
          afterCompletionMoves += moves.moved + moves.removed + moves.added;
          completions += 1;
          state = after;
        } else if (r < 82) {
          skipped += 1;
          state = reducer(state, { type: "SKIP_BLOCK", payload: block.id });
        }
      }
    }
    const max = Math.max(...rolls);
    console.log(`daily (moved/added/removed per morning roll): ${daily.join(", ")}`);
    console.log(`rolls: max ${max} moved+removed, total ${rolls.reduce((s, n) => s + n, 0)}; ${finished}/${offered} sessions finished, ${skipped} skipped; ${afterCompletionMoves} changes in ${completions} re-plans after a completion`);
    expect(max).toBeLessThanOrEqual(10);
    expect(afterCompletionMoves).toBeLessThanOrEqual(completions);
  });

  it("a whole semester lived day by day: a heavy morning moves a handful of sessions, and the plan keeps up with a fresh one (1.0.8 audit: 93 sessions moved one morning)", () => {
    // Lived like the audit's student: ~70% of sessions finished, some skipped, the rest left unticked (missed, so the
    // plan needs make-ups and runs out of room from mid-October). Every session a re-plan moves must win back
    // MINUTES_PER_MOVE more minutes (or give a task with no time its first), at most MAX_AUTOMATIC_MOVES a step, and the
    // let-go sessions the short work does not need go back to their slots. Checked every morning against a plan made
    // from scratch: never more tasks left with no time at all, and never much more work short.
    let state = fresh();
    const rolls: Array<{ date: string; moved: number }> = [];
    let worstGap = 0;
    for (let day = 0; day < 91; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      const morning = at(date, 7, 30);
      if (day > 0) {
        const before = state;
        state = reducer(state, { type: "AUTO_REPLAN", payload: { now: morning } });
        const moves = movesOf(before, state, morning);
        rolls.push({ date, moved: moves.moved + moves.removed });
        expect(reducer(state, { type: "AUTO_REPLAN", payload: { now: morning } }).scheduleBlocks, `second run on ${date}`).toEqual(state.scheduleBlocks);
        const scratch = buildSemesterPlan(state, { now: morning });
        const lived = state.planAlerts?.shortfalls ?? [];
        expect(zeroTime(state.scheduleBlocks, lived, morning), `tasks with no time on ${date}`).toBeLessThanOrEqual(zeroTime(scratch.scheduleBlocks, scratch.shortfalls, morning));
        expect(missingOf(lived), `minutes short on ${date}`).toBeLessThanOrEqual(missingOf(scratch.shortfalls) + SHORT_MARGIN_MINUTES);
        worstGap = Math.max(worstGap, missingOf(lived) - missingOf(scratch.shortfalls));
      }
      expect(violations(state, morning), `after the ${date} roll`).toEqual([]);
      state = liveTheDay(state, date);
    }
    const moving = rolls.filter((r) => r.moved > 0);
    console.log(`semester rolls: ${moving.length} of ${rolls.length} mornings moved sessions (max ${Math.max(...rolls.map((r) => r.moved))}, total ${rolls.reduce((s, r) => s + r.moved, 0)}): ${moving.map((r) => `${r.date.slice(5)} ${r.moved}`).join(", ")}; at most ${worstGap} min more short than a fresh plan`);
    expect(Math.max(...rolls.map((r) => r.moved))).toBeLessThanOrEqual(MAX_AUTOMATIC_MOVES); // was 45 (1.0.8: up to 93)
    expect(rolls.reduce((s, r) => s + r.moved, 0)).toBeLessThanOrEqual(30); // was 130 (measured: 21)
  }, 60_000);

  it("stays fast: the automatic re-plan of the heavy semester, also when it has to fall back to re-solving", () => {
    const morning = fresh();
    const first = morning.scheduleBlocks.find((b) => b.type === "study" && b.date === MONDAY && b.completionStatus === "pending")!;
    const done = reducer(morning, { type: "COMPLETE_BLOCK", payload: first.id });
    const time = (state: AppState, now: Date) => Math.min(...[0, 1, 2].map(() => {
      const t0 = performance.now();
      reducer(state, { type: "AUTO_REPLAN", payload: { now } });
      return performance.now() - t0;
    }));
    const fallback = time(done, at(MONDAY, 9, 1)); // two quizzes today only fit when the day's homework moves
    const roll = time(done, at("2026-09-08", 7, 30));
    console.log(`AUTO_REPLAN 5 courses: ${roll.toFixed(0)} ms (day roll), ${fallback.toFixed(0)} ms (with fallback)`);
    expect(roll).toBeLessThan(200);
    expect(fallback).toBeLessThan(200);
  });

  it("stays fast while the semester is lived: every automatic re-plan of 91 days, p95 within 25 ms (1.0.9 audit: 45 ms, 3x 1.0.8)", () => {
    // The morning rolls and the re-plans after each finished session, as the app runs them. A generous bound for CI;
    // measured on the audit's machine 1.0.8 p50 2 / p95 12 / max 30 ms, 1.0.9 before the fix 4 / 45 / 90 ms; on the
    // machine of the fix 1.0.8 2 / 10 / 29, before 2 / 25 / 67, after 2 / 11 / 24 (the same plans, re-plan by re-plan).
    const times: number[] = [];
    const timed = (state: AppState, now: Date) => {
      const t0 = performance.now();
      const next = autoReplan(state, now);
      times.push(performance.now() - t0);
      return next;
    };
    let state = fresh();
    for (let day = 0; day < 91; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      if (day > 0) state = timed(state, at(date, 7, 30));
      state = liveTheDay(state, date, timed);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
    console.log(`${times.length} automatic re-plans over 91 days: p50 ${percentile(50).toFixed(1)} ms, p95 ${percentile(95).toFixed(1)} ms, max ${sorted[sorted.length - 1]!.toFixed(1)} ms`);
    expect(percentile(95)).toBeLessThanOrEqual(25);
  }, 60_000);
});

describe("a task added to a full week gets about what a fresh plan gives it (1.0.9 audit: an 8-hour assignment got 80 of 480 min)", () => {
  it("sampled from 171 insertions of a 3-8 h assignment due in 2-5 days: within 30 min of a plan made from scratch, moving only what it needs", () => {
    // The semester lived like the audit's student, then on a morning a new assignment is added (ADD_TASK and the
    // automatic re-plan). Before: 23 of 171 such insertions ended more than 30 min shorter than a fresh plan, 8 of them
    // by more than 150 (none of 480 min planned on 11-05) — the edit's re-plan only took changes of at most 8 moves
    // that won back 30 + 10 per move. Now the suggestions on the days before its deadline give way, the least urgent
    // first, as many as it needs.
    const cases: Array<[string, number, number]> = [
      ["2026-10-04", 300, 2], ["2026-10-04", 480, 3], ["2026-10-22", 480, 5], ["2026-10-29", 480, 2], ["2026-10-29", 480, 3],
      ["2026-10-29", 480, 5], ["2026-11-05", 180, 3], ["2026-11-05", 480, 5], ["2026-11-08", 480, 5], ["2026-11-12", 300, 2],
    ];
    const mornings = new Map<string, AppState>();
    let state = fresh();
    const last = cases.reduce((latest, [date]) => (date > latest ? date : latest), "");
    for (let day = 0; ; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      if (day > 0) state = autoReplan(state, at(date, 7, 30));
      mornings.set(date, state);
      if (date >= last) break;
      state = liveTheDay(state, date);
    }
    const rows: string[] = [];
    for (const [date, minutes, dueIn] of cases) {
      const base = mornings.get(date)!;
      const now = at(date, 8);
      const task = makeTask({ id: "new-assignment", name: "Case study", courseId: "hist", courseName: "World History", kind: "assignment", dueDate: addDaysToKey(date, dueIn), estimatedMinutes: minutes, createdAt: now.toISOString() });
      const after = run(base, { type: "ADD_TASK", payload: task }, { type: "AUTO_REPLAN", payload: { now } });
      const scratch = buildSemesterPlan({ ...base, tasks: [...base.tasks, task] }, { now });
      const auto = plannedMinutes(after, task.id, now);
      const fromScratch = plannedMinutes(scratch, task.id, now);
      const moves = movesOf(base, after, now);
      rows.push(`${date.slice(5)} ${minutes}/${dueIn}d: ${auto} (fresh ${fromScratch}), ${moves.moved + moves.removed} moved`);
      expect(auto, `${date} ${minutes} min due in ${dueIn} days`).toBeGreaterThanOrEqual(fromScratch - 30);
      // The room it takes (at most a suggestion per half hour it needs), plus what the re-plan may then move to fit the
      // work that gave way (a fresh plan moved 40-70 of them).
      expect(moves.moved + moves.removed, `${date} ${minutes}/${dueIn}`).toBeLessThanOrEqual(Math.ceil(minutes / 30) + MAX_AUTOMATIC_MOVES);
      expect(violations(after, now), `${date} ${minutes}/${dueIn}`).toEqual([]);
      expect(autoReplan(after, now).scheduleBlocks, `second run ${date} ${minutes}/${dueIn}`).toEqual(after.scheduleBlocks);
    }
    console.log(`a new assignment in a full week, minutes planned (a fresh plan): ${rows.join("; ")}`);
  }, 60_000);
});

/** Tasks short of time with no session left to do: none of their work is planned. */
function zeroTime(blocks: ScheduleBlock[], shortfalls: Array<{ taskId: string; missingMinutes: number }>, now: Date): number {
  const planned = new Set(upcomingStudy(blocks, now).map((b) => b.taskId));
  return shortfalls.filter((s) => s.missingMinutes > 0 && !planned.has(s.taskId)).length;
}
const missingOf = (shortfalls: Array<{ missingMinutes: number }>) => shortfalls.reduce((sum, s) => sum + s.missingMinutes, 0);
/** How much more work the lived plan may leave short than a plan made from scratch the same morning (measured: 120). */
const SHORT_MARGIN_MINUTES = 150;

/** Upcoming pending minutes of one task. */
const plannedMinutes = (state: Pick<AppState, "scheduleBlocks">, taskId: string, now: Date) =>
  upcomingStudy(state.scheduleBlocks, now).filter((b) => b.taskId === taskId).reduce((sum, b) => sum + blockMinutes(b), 0);

describe("sessions that ended unticked stay on the calendar as missed (audit finding 2)", () => {
  it("FINC: Wednesday's automatic re-plan keeps Monday's session as Missed, the banner sees it, and ticking it done drops its make-up", () => {
    const monday = run({ ...createInitialState(), ...fincState() }, { type: "AUTO_BUILD_WEEK", payload: { now: at(MONDAY, 8) } });
    const session = monday.scheduleBlocks.find((b) => b.type === "study" && b.taskId === "finc-q2" && b.date === MONDAY)!;
    expect(session).toBeDefined();
    const wednesday = at("2026-09-09", 8);
    const after = reducer(monday, { type: "AUTO_REPLAN", payload: { now: wednesday } });

    expect(after.scheduleBlocks.find((b) => b.id === session.id)).toMatchObject({ completionStatus: "missed", autoMissed: true }); // was: deleted
    const drift = detectDrift(after, wednesday);
    expect(drift.missedBlocks.map((b) => b.id)).toContain(session.id); // was: 0 missed
    expect(drift.behindMinutes).toBeGreaterThanOrEqual(blockMinutes(session));
    const quiz = () => after.tasks.find((t) => t.id === "finc-q2")!;
    expect(plannedMinutes(after, "finc-q2", wednesday) + (after.planAlerts?.shortfalls.find((s) => s.taskId === "finc-q2")?.missingMinutes ?? 0)).toBe(remainingMinutes(quiz()));

    // The student ticks it done after all: its minutes are credited and the next re-plan drops what is no longer needed.
    const ticked = reducer(after, { type: "COMPLETE_BLOCK", payload: session.id });
    const credited = ticked.tasks.find((t) => t.id === "finc-q2")!;
    expect(credited.completedMinutes).toBe(blockMinutes(session));
    const later = new Date(wednesday.getTime() + 60_000);
    const replanned = reducer(ticked, { type: "AUTO_REPLAN", payload: { now: later } });
    expect(plannedMinutes(replanned, "finc-q2", later)).toBe(remainingMinutes(credited));
    expect(detectDrift(replanned, later).missedBlocks.some((b) => b.id === session.id)).toBe(false);

    // A re-plan the student runs (the same as the manual Replan has always done) acknowledges it: the banner clears.
    const preview = runReplan(after, { scope: "semester" }, wednesday);
    expect(preview.diff.markedMissed.map((b) => b.id)).toContain(session.id);
    const applied = reducer(after, { type: "APPLY_REPLAN", payload: { label: preview.label, at: wednesday.toISOString(), next: preview.next } });
    expect(detectDrift(applied, wednesday).missedBlocks.some((b) => b.id === session.id)).toBe(false);
    expect(applied.scheduleBlocks.find((b) => b.id === session.id)?.completionStatus).toBe("missed");
  });

  it("a task with several sessions: the missed one gets a make-up; ticked done later, the extra session goes and nothing else moves", () => {
    const morning = fresh();
    const live = (s: AppState) => s.scheduleBlocks.filter((b) => b.type === "study" && b.completionStatus === "pending");
    const candidate = morning.tasks.find((t) => {
      const mine = live(morning).filter((b) => b.taskId === t.id).sort((a, b) => a.date.localeCompare(b.date));
      return mine.length >= 2 && mine[0]!.date > MONDAY && mine[0]!.date <= "2026-10-10";
    })!;
    const sessions = live(morning).filter((b) => b.taskId === candidate.id).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    const missed = sessions[0]!;
    const nextMorning = at(addDaysToKey(missed.date, 1), 7, 30);
    const after = reducer(morning, { type: "AUTO_REPLAN", payload: { now: nextMorning } });
    const short = after.planAlerts?.shortfalls.find((s) => s.taskId === candidate.id)?.missingMinutes ?? 0;
    expect(after.scheduleBlocks.find((b) => b.id === missed.id)?.completionStatus).toBe("missed");
    expect(plannedMinutes(after, candidate.id, nextMorning) + short).toBe(remainingMinutes(candidate)); // the make-up

    const ticked = reducer(after, { type: "COMPLETE_BLOCK", payload: missed.id });
    const replanned = reducer(ticked, { type: "AUTO_REPLAN", payload: { now: new Date(nextMorning.getTime() + 60_000) } });
    const task = replanned.tasks.find((t) => t.id === candidate.id)!;
    expect(task.completedMinutes).toBe(blockMinutes(missed));
    expect(plannedMinutes(replanned, candidate.id, nextMorning)).toBeLessThanOrEqual(remainingMinutes(task)); // nothing planned twice
    expect(plannedMinutes(replanned, candidate.id, nextMorning)).toBeLessThan(plannedMinutes(after, candidate.id, nextMorning));
    const others = (s: AppState) => upcomingStudy(s.scheduleBlocks, nextMorning).filter((b) => b.taskId !== candidate.id).map(slotKey).sort();
    expect(others(replanned)).toEqual(others(after));
    console.log(`make-up: ${candidate.id} ${sessions.length} sessions, ${plannedMinutes(after, candidate.id, nextMorning)} -> ${plannedMinutes(replanned, candidate.id, nextMorning)} min planned after ticking the missed one done`);
  });
});

const JOB: RecurringEvent = { id: "job", title: "Job shift", days: ["Tue", "Thu", "Sat"], startTime: "16:00", endTime: "21:00", color: "#EC4899", locked: true };

describe("Undo of an automatic 'Plan updated' puts the edit back too (audit finding 3)", () => {
  const OCT7 = "2026-10-07";
  const now = at(OCT7, 20, 30);
  const planned = (acceptAll: boolean) => {
    const built = run({ ...createInitialState(), ...fiveCourseState() }, { type: "AUTO_BUILD_WEEK", payload: { now } });
    return acceptAll ? { ...built, scheduleBlocks: built.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b)) } : built;
  };

  for (const acceptAll of [false, true]) {
    it(`a new job (${acceptAll ? "every session accepted" : "suggestions"}): Undo removes the job and restores the plan, nothing sits under the job at any point`, () => {
      const base = planned(acceptAll);
      const after = run(base, { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now } });
      const snapshot = after.undoSnapshots![0]!;
      expect(snapshot).toMatchObject({ label: "Plan updated for your new commitment", source: "auto" });
      expect(snapshot.summary).toMatch(/moved/);
      expect(undoAlsoRestores(snapshot)).toBe("Undo also puts your commitments back as they were.");
      expect(countConflicts(after.scheduleBlocks, after, { fromDate: OCT7 })).toBe(0);

      const undone = reducer(after, { type: "UNDO_REPLAN" });
      expect(undone.recurringEvents).toEqual(base.recurringEvents); // was: the job stayed, with 17-21 sessions under it
      expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
      expect(countConflicts(undone.scheduleBlocks, undone, { fromDate: OCT7 })).toBe(0);
      expect(undone.inputsBeforeEdit).toBeUndefined();
      // The re-plan the provider runs after the undo (its inputs changed back) has nothing left to do.
      expect(reducer(undone, { type: "AUTO_REPLAN", payload: { now: new Date(now.getTime() + 2000) } }).undoSnapshots).toBeUndefined();
    });
  }

  it("new sleep hours: Undo restores the old wake time with the plan (was: a session left inside the new sleep window)", () => {
    const base = planned(false);
    const after = run(base, { type: "UPDATE_HEALTH_PREFS", payload: { wakeTime: "08:30" } }, { type: "AUTO_REPLAN", payload: { now } });
    expect(after.undoSnapshots?.[0]).toMatchObject({ label: "Plan updated for your sleep hours", healthPrefs: base.healthPrefs });
    expect(violations(after, now).filter((v) => v.startsWith("sleep"))).toEqual([]);
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.healthPrefs).toEqual(base.healthPrefs);
    expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
    expect(violations(undone, now).filter((v) => v.startsWith("sleep"))).toEqual([]);
  });

  it("a class moved: Undo puts the class back; two edits before one re-plan undo to the state before the first", () => {
    const base = planned(false);
    const calc = base.classes.find((c) => c.id === "calc")!;
    const after = run(
      base,
      { type: "UPDATE_CLASS", payload: { ...calc, startTime: "17:00", endTime: "18:15" } },
      { type: "UPDATE_CLASS", payload: { ...calc, startTime: "10:30", endTime: "11:45" } },
      { type: "AUTO_REPLAN", payload: { now } },
    );
    expect(after.undoSnapshots?.[0]?.label).toBe("Plan updated for your classes");
    expect(countConflicts(after.scheduleBlocks, after, { fromDate: OCT7 })).toBe(0);
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.classes).toEqual(base.classes);
    expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
  });

  it("semester dates: Undo restores the old semester (a break removed under a session)", () => {
    const withBreak: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [{ name: "Break", startDate: "2030-03-18", endDate: "2030-03-18" }] };
    const essay = makeTask({ id: "essay", name: "Essay", kind: "assignment", dueDate: "2030-03-20", estimatedMinutes: 60, status: "scheduled" });
    // A suggestion at class time on the break day (the class does not meet then).
    const onBreak = makeBlock({ id: "on-break", taskId: "essay", date: "2030-03-18", startTime: "10:00", endTime: "11:00", accepted: false });
    const base: AppState = { ...createInitialState(), onboardingComplete: true, classes: [makeClass()], semester: withBreak, tasks: [essay], scheduleBlocks: [onBreak] };
    const settled = reducer(base, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(settled.scheduleBlocks.find((b) => b.id === "on-break")).toMatchObject({ startTime: "10:00" }); // still valid: kept
    expect(settled.undoSnapshots).toBeUndefined();

    const after = run(settled, { type: "SET_SEMESTER", payload: { ...withBreak, breaks: [] } }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    expect(after.scheduleBlocks.some((b) => b.taskId === "essay" && b.date === "2030-03-18" && b.startTime === "10:00" && b.completionStatus === "pending")).toBe(false);
    expect(after.undoSnapshots?.[0]).toMatchObject({ label: "Plan updated for your semester dates", semester: withBreak });
    expect(undoAlsoRestores(after.undoSnapshots![0]!)).toBe("Undo also puts your semester dates back as they were.");
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.semester).toEqual(withBreak);
    expect(undone.scheduleBlocks).toBe(settled.scheduleBlocks);
  });

  it("a later edit still drops the snapshot, so Undo never erases it", () => {
    const after = run(planned(false), { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now } });
    const study = upcomingStudy(after.scheduleBlocks, now)[0]!;
    expect(reducer(after, { type: "COMPLETE_BLOCK", payload: study.id }).undoSnapshots).toBeUndefined();
    expect(reducer(after, { type: "UPDATE_HEALTH_PREFS", payload: { bedtime: "23:00" } }).undoSnapshots).toBeUndefined();
  });
});

describe("cleanup: REGENERATE_WEEK and new commitments", () => {
  it("REGENERATE_WEEK is the automatic re-plan: stable, and unticked sessions are kept as missed", () => {
    const morning = fresh();
    const todays = morning.scheduleBlocks.filter((b) => b.type === "study" && b.date === MONDAY && b.completionStatus === "pending");
    const next = at("2026-09-08", 7, 30);
    const regen = reducer(morning, { type: "REGENERATE_WEEK", payload: { now: next } });
    expect(regen.scheduleBlocks).toEqual(reducer(morning, { type: "AUTO_REPLAN", payload: { now: next } }).scheduleBlocks);
    for (const b of todays) expect(regen.scheduleBlocks.find((x) => x.id === b.id)?.completionStatus).toBe("missed");
    expect(violations(regen, next)).toEqual([]); // their make-ups are planned
  });

  it("a morning update that only adds make-ups for missed sessions offers no Undo (Undo left the missed work unplanned)", () => {
    const morning = fresh();
    const next = at("2026-09-08", 7, 30);
    const rolled = reducer(morning, { type: "AUTO_REPLAN", payload: { now: next } });
    const moves = movesOf(morning, rolled, next);
    expect(moves).toMatchObject({ moved: 0, removed: 0 });
    expect(moves.added).toBeGreaterThan(0); // the make-ups
    expect(rolled.undoSnapshots).toBeUndefined(); // was "Plan updated: 3 sessions added · Undo"
    // An update that moves sessions still offers Undo.
    const withJob = run(rolled, { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now: next } });
    expect(withJob.undoSnapshots?.[0]).toMatchObject({ source: "auto" });
  });

  it("marking a task done removes its sessions still ahead; the ones already past stay as done (was: future days' sessions marked done)", () => {
    const monday = fresh();
    const study = (taskId: string) => monday.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === taskId).sort((a, b) => a.date.localeCompare(b.date));
    const target = monday.tasks.find((t) => study(t.id).length >= 3)!;
    const [first, second] = study(target.id);
    expect(second!.date > first!.date).toBe(true);
    const history = [first!];
    const state = reducer(monday, { type: "COMPLETE_BLOCK", payload: first!.id });
    const now = at(first!.date, 23);
    const done = reducer(state, { type: "COMPLETE_TASK", payload: target.id, now });
    const mine = done.scheduleBlocks.filter((b) => b.taskId === target.id);
    expect(mine.map((b) => b.id).sort()).toEqual(history.map((b) => b.id).sort()); // was: every later session too, as done
    for (const b of mine) expect(b.completionStatus).toBe("done");
    const replanned = reducer(done, { type: "AUTO_REPLAN", payload: { now: new Date(now.getTime() + 60_000) } });
    expect(violations(replanned, now)).toEqual([]);
  });

  it("a commitment added mid-week is drawn from today on, never over the days already lived", () => {
    let state = fresh();
    for (const b of state.scheduleBlocks.filter((x) => x.type === "study" && x.completionStatus === "pending" && x.date <= "2026-09-08")) {
      state = reducer(state, { type: "COMPLETE_BLOCK", payload: b.id });
    }
    const wednesday = at("2026-09-09", 9);
    const shift: RecurringEvent = { ...JOB, days: ["Mon", "Tue", "Wed", "Thu"] };
    const after = run(state, { type: "ADD_RECURRING_EVENT", payload: shift }, { type: "AUTO_REPLAN", payload: { now: wednesday } });
    const shiftDays = after.scheduleBlocks.filter((b) => b.type === "recurring" && b.title === "Job shift" && b.date <= "2026-09-10").map((b) => b.date).sort();
    expect(shiftDays).toEqual(["2026-09-09", "2026-09-10"]); // was: also Mon 7 and Tue 8, on top of finished sessions
    const lived = after.scheduleBlocks.filter((b) => b.type === "study" && b.completionStatus === "done");
    const commitments = after.scheduleBlocks.filter((b) => b.type === "recurring");
    expect(lived.filter((d) => commitments.some((c) => c.date === d.date && c.startTime < d.endTime && d.startTime < c.endTime))).toEqual([]);
  });
});

describe("previewed changes are stable too: only what changed moves", () => {
  const SEP28 = "2026-09-28";
  const now = at(SEP28, 8);
  /** The plan as the student lives it: built on 7 Sep, followed (every session done) and rolled forward each morning. */
  const lived = (start: AppState) => {
    let state = run({ ...createInitialState(), ...start }, { type: "AUTO_BUILD_WEEK", payload: { now: at(MONDAY, 8) } });
    for (let day = 0; day < 21; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      if (day > 0) state = reducer(state, { type: "AUTO_REPLAN", payload: { now: at(date, 7, 30) } });
      for (const b of state.scheduleBlocks.filter((x) => x.type === "study" && x.date === date && x.completionStatus === "pending")) {
        state = reducer(state, { type: "COMPLETE_BLOCK", payload: b.id });
      }
    }
    return { ...reducer(state, { type: "AUTO_REPLAN", payload: { now } }), undoSnapshots: undefined };
  };
  const planned = () => lived(fiveCourseState());
  const missing = (shortfalls: Array<{ missingMinutes: number }>) => shortfalls.reduce((sum, s) => sum + s.missingMinutes, 0);
  const split = (blocks: ScheduleBlock[], taskId: string) => [blocks.filter((b) => b.taskId === taskId), blocks.filter((b) => b.taskId !== taskId)] as const;

  for (const days of [-3, 7]) {
    it(`a midterm moved ${Math.abs(days)} days ${days < 0 ? "earlier" : "later"}: only that exam's sessions move, the preview applies cleanly`, () => {
      const state = planned();
      const exam = state.tasks.find((t) => t.id === "chem-mid1")!;
      const newDue = addDaysToKey(exam.dueDate, days);
      const preview = previewTaskEdit(state, exam.id, { dueDate: newDue }, now)!;
      const [examBefore, othersBefore] = split(state.scheduleBlocks, exam.id);
      const [examAfter, othersAfter] = split(preview.next.scheduleBlocks, exam.id);
      const others = changedSlots(othersBefore, othersAfter, SEP28);
      const own = changedSlots(examBefore, examAfter, SEP28);
      console.log(`exam ${days > 0 ? "+" : ""}${days} days: ${others.changed} of ${others.total} other sessions moved, ${own.changed} of the exam's ${own.total} (${preview.summary})`);
      expect(others.changed).toBeLessThanOrEqual(3);
      expect(own.changed).toBeGreaterThan(0);
      // Never less complete than a fresh plan of the same change.
      const edited = { ...state, tasks: state.tasks.map((t) => (t.id === exam.id ? { ...t, dueDate: newDue } : t)) };
      expect(missing(preview.shortfalls)).toBeLessThanOrEqual(missing(buildSemesterPlan(edited, { now }).shortfalls));
      const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: now.toISOString(), next: preview.next } });
      expect(violations(applied, now)).toEqual([]);
      // The automatic re-plan right after has nothing left to do (no second "Plan updated").
      expect(reducer(applied, { type: "AUTO_REPLAN", payload: { now: new Date(now.getTime() + 2000) } }).undoSnapshots).toHaveLength(1);
    });
  }

  it("an assistant change (a new deadline and a new task) moves only what it touches", () => {
    const state = planned();
    const essay = makeTask({ id: "ai-essay", name: "Reflection essay", courseId: "hist", courseName: "World History", kind: "assignment", dueDate: "2026-10-09", estimatedMinutes: 120 });
    const change = { label: "Assistant change", newTasks: [essay], deadlineChanges: [{ taskId: "econ-hw6", dueDate: addDaysToKey(state.tasks.find((t) => t.id === "econ-hw6")!.dueDate, -2) }] };
    const preview = previewAssistantChange(state, change, { now });
    const untouched = (blocks: ScheduleBlock[]) => blocks.filter((b) => b.taskId !== "ai-essay" && b.taskId !== "econ-hw6");
    const others = changedSlots(untouched(state.scheduleBlocks), untouched(preview.next.scheduleBlocks), SEP28);
    console.log(`assistant change: ${others.changed} of ${others.total} other sessions moved`);
    expect(others.changed).toBeLessThanOrEqual(3);
    expect(upcomingStudy(preview.next.scheduleBlocks, now).some((b) => b.taskId === "ai-essay")).toBe(true);
    expect(missing(preview.shortfalls)).toBeLessThanOrEqual(missing(buildSemesterPlan(applyAssistantChange(state, change), { now }).shortfalls));
  });

  it("importing another course into an existing plan leaves the other courses' sessions where they are", () => {
    const full = fiveCourseState();
    const writ = full.classes.find((c) => c.id === "writ")!;
    const writTasks = full.tasks.filter((t) => t.courseId === "writ");
    const base = lived({ ...full, classes: full.classes.filter((c) => c.id !== "writ"), tasks: full.tasks.filter((t) => t.courseId !== "writ") });
    const payload = {
      classToCreate: writ, tasks: writTasks, taskUpdates: [],
      importRecord: { id: "import-writ", importedAt: now.toISOString(), courseName: writ.name, linkedClassId: writ.id, linkedClassName: writ.name, itemCount: writTasks.length, skippedCount: 0, isNewClass: true },
    };
    const after = run(base, { type: "APPLY_SYLLABUS_IMPORT", payload }, { type: "AUTO_BUILD_WEEK", payload: { now } });
    // The sessions the new class meetings (and the break after them) now sit on genuinely have to move.
    const meetings = after.scheduleBlocks.filter((b) => b.type === "class" && b.courseId === "writ");
    const existing = upcomingStudy(base.scheduleBlocks, now);
    const underClass = existing.filter((b) => meetings.some((m) => m.date === b.date && b.startTime < addMinutes(m.endTime, 15) && m.startTime < b.endTime));
    const moved = changedSlots(existing, upcomingStudy(after.scheduleBlocks, now).filter((b) => !writTasks.some((t) => t.id === b.taskId)), SEP28);
    console.log(`import: ${moved.changed} of ${moved.total} existing sessions moved (${underClass.length} were under the new class)`);
    expect(moved.changed).toBeLessThanOrEqual(underClass.length + 3);
    expect(upcomingStudy(after.scheduleBlocks, now).some((b) => writTasks.some((t) => t.id === b.taskId))).toBe(true);
    expect(violations(after, now)).toEqual([]);
  });
});

describe("Undo after a task-list change puts the task list back too", () => {
  const now = at(MONDAY, 8, 5); // nothing has ended since the 08:00 plan
  const essay = makeTask({ id: "new-essay", name: "Reflection essay", courseId: "hist", courseName: "World History", kind: "assignment", dueDate: "2026-09-18", estimatedMinutes: 120 });

  it("a task added (the tabs' Add task): Undo removes it with its sessions (was: kept, with no sessions until the next day)", () => {
    const base = fresh();
    const after = run(base, { type: "ADD_TASK", payload: essay }, { type: "AUTO_REPLAN", payload: { now } });
    const snapshot = after.undoSnapshots![0]!;
    expect(snapshot).toMatchObject({ label: "Plan updated for your new task", source: "auto", taskEdit: { kind: "added", count: 1 } });
    expect(undoAlsoRestores(snapshot)).toBe("Undo also removes the task you added.");
    expect(upcomingStudy(after.scheduleBlocks, now).some((b) => b.taskId === essay.id)).toBe(true);
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.tasks.map((t) => t.id)).toEqual(base.tasks.map((t) => t.id));
    expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
    expect(reducer(undone, { type: "AUTO_REPLAN", payload: { now: new Date(now.getTime() + 2000) } }).undoSnapshots).toBeUndefined();
  });

  it("a task deleted: the update lists its sessions as removed and Undo brings the task and its sessions back", () => {
    const base = fresh();
    const victim = upcomingStudy(base.scheduleBlocks, now).find((b) => b.date > MONDAY)!.taskId!;
    const after = run(base, { type: "DELETE_TASK", payload: victim }, { type: "AUTO_REPLAN", payload: { now } });
    const snapshot = after.undoSnapshots![0]!;
    expect(snapshot.summary).toMatch(/removed/);
    expect(undoAlsoRestores(snapshot)).toBe("Undo also brings back the task you deleted.");
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.tasks).toBe(base.tasks);
    expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
  });

  it("a task edited outside the preview (Exam Prep): its sessions are planned again, Undo puts the task back as it was", () => {
    const base = fresh();
    const task = base.tasks.find((t) => t.id === "hist-hw2")!;
    const after = run(base, { type: "UPDATE_TASK", payload: { ...task, estimatedMinutes: 180 } }, { type: "AUTO_REPLAN", payload: { now } });
    expect(plannedMinutes(after, task.id, now)).toBe(180);
    expect(undoAlsoRestores(after.undoSnapshots![0]!)).toBe("Undo also puts the task back as it was.");
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.tasks).toBe(base.tasks);
    expect(undone.scheduleBlocks).toBe(base.scheduleBlocks);
  });

  it("a session ticked done between the edit and the re-plan is never undone: the task edit is then not reverted", () => {
    const base = fresh();
    const first = upcomingStudy(base.scheduleBlocks, now)[0]!;
    const after = run(base, { type: "ADD_TASK", payload: essay }, { type: "COMPLETE_BLOCK", payload: first.id }, { type: "AUTO_REPLAN", payload: { now } });
    const snapshot = after.undoSnapshots?.[0];
    expect(snapshot?.taskEdit).toBeUndefined();
    const undone = reducer(after, { type: "UNDO_REPLAN" });
    expect(undone.scheduleBlocks.find((b) => b.id === first.id)?.completionStatus).toBe("done");
  });

  it("a Google Calendar sync that moves sessions says so without an Undo of its own, and keeps the older Undo (was: the Undo stack was wiped)", () => {
    const withJob = run(fresh(), { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now } });
    expect(withJob.undoSnapshots).toHaveLength(1);
    const target = upcomingStudy(withJob.scheduleBlocks, now).find((b) => b.date > MONDAY)!;
    const event = { id: "g1", calendarId: "primary", title: "Dentist", startDate: target.date, startTime: target.startTime, endTime: target.endTime, isAllDay: false, isRecurring: false, status: "active" as const, syncedAt: now.toISOString() };
    const sync = (s: AppState) => reducer(s, { type: "SET_GOOGLE_CALENDAR_EVENTS", payload: { events: [event], connected: true, lastSync: now.toISOString() } });
    const after = reducer(sync(withJob), { type: "AUTO_REPLAN", payload: { now } });
    expect(after.scheduleBlocks.some((b) => b.id === target.id && b.startTime === target.startTime && b.date === target.date)).toBe(false);
    expect(countConflicts(after.scheduleBlocks, after, { fromDate: MONDAY })).toBe(0);
    // The calendar cannot be un-changed, so this update has no Undo: the student is told what moved instead.
    expect(after.replanNotice).toMatchObject({ label: "Plan updated for calendar changes" });
    expect(after.replanNotice?.summary).toMatch(/1 session (moved|removed)/);
    expect(after.undoSnapshots).toBe(withJob.undoSnapshots);
    // Undoing the job afterwards brings the old plan back without putting any session under the event.
    const undone = reducer(after, { type: "UNDO_REPLAN", now });
    expect(undone.recurringEvents.some((e) => e.id === JOB.id)).toBe(false);
    expect(countConflicts(undone.scheduleBlocks, undone, { fromDate: MONDAY })).toBe(0);
    // The same events synced again change nothing and cost no Undo.
    const gym: RecurringEvent = { ...JOB, id: "gym", title: "Gym", days: ["Mon", "Wed", "Fri"], startTime: "18:00", endTime: "21:00" };
    const again = run(after, { type: "ADD_RECURRING_EVENT", payload: gym }, { type: "AUTO_REPLAN", payload: { now } });
    expect(again.undoSnapshots).toHaveLength(1); // the new edit replaced the older Undo, as any edit does
    expect(reducer(sync(again), { type: "AUTO_REPLAN", payload: { now } }).undoSnapshots).toBe(again.undoSnapshots);
  });

  it("an all-day trip synced from Google Calendar re-plans only the sessions on its days (was: 120 sessions reshuffled, with no Undo)", () => {
    const base = fresh();
    const trip = { id: "g-trip", calendarId: "primary", title: "Trip", startDate: "2026-09-09", endDate: "2026-09-12", isAllDay: true, isRecurring: false, status: "active" as const, syncedAt: now.toISOString() };
    const after = run(base, { type: "SET_GOOGLE_CALENDAR_EVENTS", payload: { events: [trip], connected: true, lastSync: now.toISOString() } }, { type: "AUTO_REPLAN", payload: { now } });
    const tripDays = new Set(["2026-09-09", "2026-09-10", "2026-09-11"]);
    const before = upcomingStudy(base.scheduleBlocks, now);
    expect(before.filter((b) => tripDays.has(b.date)).length).toBeGreaterThan(0);
    const stillThere = new Set(upcomingStudy(after.scheduleBlocks, now).map(slotKey));
    expect(before.filter((b) => !tripDays.has(b.date) && !stillThere.has(slotKey(b))).map((b) => b.id)).toEqual([]);
    expect(upcomingStudy(after.scheduleBlocks, now).some((b) => tripDays.has(b.date))).toBe(false);
    expect(violations(after, now)).toEqual([]); // what no longer fits is reported short, never dropped
    expect(after.undoSnapshots).toBeUndefined(); // there was nothing to undo before, and the sync itself has no Undo
    expect(after.replanNotice?.label).toBe("Plan updated for calendar changes");
  });
});

describe("'Move to tomorrow' re-plans only the work it moves (1.0.8 audit: 84-147 later sessions reshuffled per 'Move 1')", () => {
  /** The heavy semester with a Tue/Thu/Sat job, lived for `days` days (every session finished), rolled to the morning after. */
  const livedUntil = (days: number) => {
    let state = run(fresh(), { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now: at(MONDAY, 8, 5) } });
    for (let day = 0; day < days; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      for (const b of state.scheduleBlocks.filter((x) => x.type === "study" && x.date === date && x.completionStatus === "pending")) {
        state = reducer(state, { type: "COMPLETE_BLOCK", payload: b.id });
      }
      state = reducer(state, { type: "AUTO_REPLAN", payload: { now: at(addDaysToKey(date, 1), 7, 30) } });
    }
    return state;
  };
  const otherTasks = (blocks: ScheduleBlock[], taskIds: Set<string>) => blocks.filter((b) => !taskIds.has(b.taskId ?? ""));

  /** The student drags two sessions of the coming days onto today's free afternoon (how a day gets overloaded). */
  const piledOnto = (start: AppState, date: string) => {
    let state = start;
    const later = state.scheduleBlocks
      .filter((b) => b.type === "study" && b.completionStatus === "pending" && b.date > addDaysToKey(date, 1) && b.date <= addDaysToKey(date, 6))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .slice(0, 2);
    for (const b of later) {
      const length = blockMinutes(b);
      const busy = state.scheduleBlocks.filter((x) => x.date === date && x.type !== "sleep" && x.completionStatus !== "skipped");
      for (let start = 12 * 60 + 30; start + length <= 21 * 60; start += 15) {
        const [s, e] = [start, start + length];
        if (busy.some((x) => timeToMinutes(x.startTime) < e + 10 && s < timeToMinutes(x.endTime) + 10)) continue;
        const hhmmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        state = reducer(state, { type: "UPDATE_BLOCK", payload: { id: b.id, date, startTime: hhmmOf(s), endTime: hhmmOf(e) } });
        break;
      }
    }
    return state;
  };

  it("Today's 'Move N to tomorrow': exactly N sessions leave today, the day's others and the other tasks' later sessions stay", () => {
    let tried = 0;
    for (let day = 0; day < 14 && tried < 3; day += 1) {
      const date = addDaysToKey(MONDAY, day);
      const state = piledOnto(livedUntil(day), date);
      const noon = at(date, 12);
      const card = realityCheckFor(state.scheduleBlocks, state.healthPrefs, date, { userPrefs: state.userPrefs, nowMinutes: 12 * 60, tasks: state.tasks });
      if (!card || card.moveBlockIds.length === 0) continue;
      const preview = runReplan(state, { scope: "today", mode: "defer", blockIds: card.moveBlockIds }, noon);
      if (preview.needsConfirmation) continue;
      tried += 1;
      const openToday = (blocks: ScheduleBlock[]) => blocks.filter((b) => b.type === "study" && b.date === date && b.completionStatus === "pending" && b.startTime >= "12:00").map(slotKey).sort();
      const stay = state.scheduleBlocks.filter((b) => !card.moveBlockIds.includes(b.id));
      expect(openToday(preview.next.scheduleBlocks)).toEqual(openToday(stay));
      const moved = new Set(state.scheduleBlocks.filter((b) => card.moveBlockIds.includes(b.id)).map((b) => b.taskId!));
      const later = changedSlots(otherTasks(state.scheduleBlocks, moved), otherTasks(preview.next.scheduleBlocks, moved), addDaysToKey(date, 1));
      console.log(`move ${card.moveBlockIds.length} to tomorrow on ${date}: ${later.changed} of ${later.total} later sessions of other tasks moved (${preview.summary})`);
      expect(later.changed).toBeLessThanOrEqual(3);
      const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: noon.toISOString(), next: preview.next } });
      expect(violations(applied, noon)).toEqual([]);
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("the block sheet's 'Move to tomorrow' (the rest of the day): the other tasks' later sessions stay", () => {
    let tried = 0;
    for (let day = 1; day < 14 && tried < 2; day += 1) {
      const state = livedUntil(day);
      const date = addDaysToKey(MONDAY, day);
      const noon = at(date, 12);
      const preview = runReplan(state, { scope: "today", mode: "defer", date }, noon);
      if (preview.needsConfirmation || !preview.diff.changed) continue;
      tried += 1;
      const moving = state.scheduleBlocks.filter((b) => b.type === "study" && b.date === date && b.completionStatus === "pending");
      const movedTasks = new Set(moving.map((b) => b.taskId!));
      const later = changedSlots(otherTasks(state.scheduleBlocks, movedTasks), otherTasks(preview.next.scheduleBlocks, movedTasks), addDaysToKey(date, 1));
      console.log(`move the rest of ${date} (${moving.length} sessions): ${later.changed} of ${later.total} later sessions of other tasks moved`);
      expect(later.changed).toBeLessThanOrEqual(5);
      expect(preview.next.scheduleBlocks.some((b) => b.type === "study" && b.date === date && b.completionStatus === "pending" && moving.some((m) => m.id === b.id))).toBe(false);
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("sessions dragged onto a full day: the automatic re-plans that follow are idempotent (1.0.9 audit: run N let a suggestion go, run N+1 put it back)", () => {
    // The semester lived like the audit's student, so the plan is short of room. On the 1.0.8 planner each of these drags
    // gave a different plan on every re-plan at the same minute (11-06 with the job: 405 -> 330 -> 335 -> 350 min that
    // day): the stable re-plan let the day's suggestions go, its last-resort tier and the fallbacks put them back.
    const cap = studyLoadCaps(fresh().userPrefs).dailyMinutes;
    const seen: string[] = [];
    for (const [withJob, dates] of [[true, ["2026-11-06", "2026-11-08", "2026-11-11"]], [false, ["2026-10-30"]]] as const) {
      let state = withJob ? run(fresh(), { type: "ADD_RECURRING_EVENT", payload: JOB }, { type: "AUTO_REPLAN", payload: { now: at(MONDAY, 8, 5) } }) : fresh();
      for (let day = 0; ; day += 1) {
        const date = addDaysToKey(MONDAY, day);
        if (day > 0) state = reducer(state, { type: "AUTO_REPLAN", payload: { now: at(date, 7, 30) } });
        if ((dates as readonly string[]).includes(date)) {
          const piled = piledOnto(state, date);
          const noon = at(date, 12);
          const open = (s: AppState) => s.scheduleBlocks.filter((b) => b.type === "study" && b.date === date && b.completionStatus === "pending");
          const minutes = (s: AppState) => open(s).reduce((sum, b) => sum + blockMinutes(b), 0);
          const dragged = open(piled).filter((b) => b.userEdited);
          expect(dragged.length, date).toBeGreaterThan(0);
          const run1 = reducer(piled, { type: "AUTO_REPLAN", payload: { now: noon } });
          const run2 = reducer(run1, { type: "AUTO_REPLAN", payload: { now: noon } });
          const run3 = reducer(run2, { type: "AUTO_REPLAN", payload: { now: noon } });
          expect(run2.scheduleBlocks, `second run on ${date}`).toEqual(run1.scheduleBlocks);
          expect(run3.scheduleBlocks, `third run on ${date}`).toEqual(run1.scheduleBlocks);
          expect(violations(run1, noon), date).toEqual([]);
          // The dragged sessions stay where the student put them; the day's suggestions give way down to the daily cap,
          // but for work due within two days (a last resort may still put that there).
          for (const b of dragged) expect(run1.scheduleBlocks.find((x) => x.id === b.id), date).toMatchObject({ date, startTime: b.startTime, endTime: b.endTime });
          const confirmed = open(run1).filter((b) => b.userEdited || b.accepted || b.locked);
          const dueBy = new Map(run1.tasks.map((t) => [t.id, t.dueDate.slice(0, 10)]));
          const urgent = open(run1).filter((b) => !confirmed.includes(b) && (dueBy.get(b.taskId!) ?? "") <= addDaysToKey(date, 2));
          expect(minutes(run1) - urgent.reduce((sum, b) => sum + blockMinutes(b), 0), date).toBeLessThanOrEqual(Math.max(cap, confirmed.reduce((sum, b) => sum + blockMinutes(b), 0)));
          seen.push(`${withJob ? "job" : "no job"} ${date.slice(5)}: ${minutes(piled)} -> ${minutes(run1)} min${urgent.length > 0 ? ` (${urgent.reduce((sum, b) => sum + blockMinutes(b), 0)} due within 2 days)` : ""}`);
        }
        if (date >= dates[dates.length - 1]!) break;
        state = liveTheDay(state, date);
      }
    }
    console.log(`dragged onto a full day (cap ${cap} min), open study that day before -> after the re-plan: ${seen.join(", ")}`);
  }, 120_000);
});

describe("a day the student moved a session onto still takes urgent work (1.0.9 audit: a quiz due the next morning got 30 of its 90 minutes)", () => {
  const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [] };
  const NOON_TODAY = NOW; // Wed 13 Mar 2030, 12:00
  const quizMinutes = (state: AppState) => upcomingStudy(state.scheduleBlocks, NOON_TODAY).filter((b) => b.taskId === "quiz").reduce((sum, b) => sum + blockMinutes(b), 0);
  /** Today holds an essay's 90-minute sessions (one of them dragged there when `dragged`); a 90-minute quiz is due tomorrow at 08:00. */
  function day(starts: string[], dragged: boolean): AppState {
    const essay = makeTask({ id: "essay", name: "Essay", kind: "assignment", dueDate: "2030-03-16", estimatedMinutes: 90 * starts.length, courseId: "hist", courseName: "History" });
    const quiz = makeTask({ id: "quiz", name: "Quiz 4", kind: "quiz", dueDate: "2030-03-14", dueTime: "08:00", estimatedMinutes: 90, courseId: "chem", courseName: "Chemistry" });
    const sessions = starts.map((start, i) => makeBlock({
      id: `essay-${i}`, type: "study", title: "Essay", taskId: "essay", date: "2030-03-13", startTime: start, endTime: addMinutes(start, 90), accepted: true,
      ...(dragged && i === 1 ? { userEdited: true } : {}),
    }));
    return { ...createInitialState(), onboardingComplete: true, semester: SEMESTER, tasks: [essay, quiz], scheduleBlocks: sessions };
  }

  it("the quiz gets the same 90 minutes as next to accepted sessions, and three identical re-plans agree", () => {
    const starts = ["13:00", "15:00", "17:00"];
    const accepted = reducer(day(starts, false), { type: "AUTO_REPLAN", payload: { now: NOON_TODAY } });
    const run1 = reducer(day(starts, true), { type: "AUTO_REPLAN", payload: { now: NOON_TODAY } });
    expect(quizMinutes(accepted)).toBe(90);
    expect(quizMinutes(run1)).toBe(90); // was 60: 30 today (the daily cap) + 30 tomorrow before 08:00, 30 short
    const run2 = reducer(run1, { type: "AUTO_REPLAN", payload: { now: NOON_TODAY } });
    const run3 = reducer(run2, { type: "AUTO_REPLAN", payload: { now: NOON_TODAY } });
    expect(run2.scheduleBlocks).toEqual(run1.scheduleBlocks);
    expect(run3.scheduleBlocks).toEqual(run1.scheduleBlocks);
    expect(violations(run1, NOON_TODAY)).toEqual([]);
  });

  it("the 4-session cap stays: with 4 sessions today the quiz only gets tomorrow's hour before 08:00", () => {
    const full = reducer(day(["13:00", "15:00", "17:00", "19:00"], true), { type: "AUTO_REPLAN", payload: { now: NOON_TODAY } });
    expect(upcomingStudy(full.scheduleBlocks, NOON_TODAY).filter((b) => b.taskId === "quiz").every((b) => b.date === "2030-03-14")).toBe(true);
    expect(quizMinutes(full) + (full.planAlerts?.shortfalls.find((s) => s.taskId === "quiz")?.missingMinutes ?? 0)).toBe(90);
    expect(violations(full, NOON_TODAY)).toEqual([]);
  });
});

describe("an exam with an Exam Prep is planned once, also while it is lived (1.0.8 audit: the exam's own time AND the prep's)", () => {
  it("FINC Exam 1 with a small prep (topped up to the exam's 4 h): never a session of the exam's own, every invariant every morning", () => {
    const start = "2026-10-01";
    const base = run({ ...createInitialState(), ...fincState() }, { type: "AUTO_BUILD_WEEK", payload: { now: at(start, 8) } });
    const prep: ExamPrep = {
      id: "prep-exam1", classId: "class-finc", className: "Principles of Finance", subject: "Exam 1", examDate: "2026-10-14",
      topics: ["Working Capital", "Forecasting"].map((title, i) => ({ id: `t${i}`, title, mastery: "mostly_understood" as const, reviewCount: 0 })),
      rawInput: "", studyBlockIds: [], finalReviewGenerated: false, createdAt: "2026-10-01T08:00:00.000Z",
    };
    const plan = buildExamRunway(withLinkedExam(prep, base.tasks), { todayKey: start, now: at(start, 8) });
    expect(plan.totalMinutes).toBe(165); // 2 x 30 + 2 x 30 + 45, for an exam estimated at 240
    let state = run({ ...base, examPreps: [prep] }, { type: "ADD_TASK", payload: plan.task! }, { type: "AUTO_REPLAN", payload: { now: at(start, 8, 5) } });
    expect(state.tasks.find((t) => t.id === plan.task!.id)!.estimatedMinutes).toBe(240);
    for (let day = 0; day < 13; day += 1) {
      const date = addDaysToKey(start, day);
      const morning = at(date, 7, 30);
      if (day > 0) state = reducer(state, { type: "AUTO_REPLAN", payload: { now: morning } });
      expect(violations(state, morning), `after the ${date} roll`).toEqual([]);
      expect(upcomingStudy(state.scheduleBlocks, morning).filter((b) => b.taskId === "finc-exam1"), date).toEqual([]);
      expect(reducer(state, { type: "AUTO_REPLAN", payload: { now: morning } }).scheduleBlocks, `second run on ${date}`).toEqual(state.scheduleBlocks);
      state = liveTheDay(state, date);
    }
  }, 60_000);
});

function addMinutes(time: string, minutes: number): string {
  const total = Math.min(timeToMinutes(time) + minutes, 24 * 60 - 1);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
