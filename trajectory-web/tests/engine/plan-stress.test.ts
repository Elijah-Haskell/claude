/**
 * "When something changes, the plan is rewritten correctly" on two whole semesters: the real FINC-3100 schedule and a
 * heavy synthetic 5-course one (tests/fixtures/stress-semester.ts). Each describe block reproduces one finding of the
 * 1.0.6 audit (deliverables/TRAJECTORY-DIAGNOSTIC.md, "Plan quality") and pins the fix.
 *
 * Numbers measured with this harness on 1.0.6 (before) -> 1.0.8 (after):
 *   FINC-3100  weekend 7:30 AM starts 13 -> 0, weekend starts before 9 AM 21 -> 1, starting the minute class ends 23 -> 0
 *   5-course   weekly hours 1.0-38.0 -> 1.0-29.3, max/day 5.8 h -> 4.8 h, days over 5 h 16 -> 0,
 *              weekend 7:30 AM starts 20 -> 0, before 9 AM 36 -> 9, right after class 101 -> 1
 *   Exam moved 5 days earlier with every session accepted: 80 of 240 prep minutes before it -> 240 of 240
 *   New Tue/Thu/Sat job with every session accepted: 21 sessions under the shift -> 0 ("nothing needs to change" -> released)
 *   Planned on a quiz morning: prep after the quiz's class on 3 quiz days -> 0; missed Quiz 4: "Catch up" at 7:30 -> none
 */
import { describe, expect, it } from "vitest";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { planDeferral, previewPlanChange, replanSemester } from "../../src/engine/replan";
import { assessPlanQuality, countConflicts, findConflicts } from "../../src/engine/plan-quality";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { findInvalidPinnedSessions } from "../../src/engine/week-planner";
import { runwayDaysFor } from "../../src/engine/exam-prep-plan";
import type { AppState, RecurringEvent, ScheduleBlock } from "../../src/engine/types";
import { addDaysToKey, timeToMinutes, weekdayOfKey } from "../../src/engine/utils";
import { FINC_NOW, STRESS_NOW, fiveCourseState, fincState, planMetrics } from "./fixtures/stress-semester";

function planned(state: AppState, now: Date) {
  const t0 = performance.now();
  const plan = buildSemesterPlan(state, { now });
  const ms = performance.now() - t0;
  return { state: { ...state, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks }, plan, ms };
}

const acceptAll = (state: AppState): AppState => ({
  ...state,
  scheduleBlocks: state.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b)),
});
const mins = (b: Pick<ScheduleBlock, "startTime" | "endTime">) => timeToMinutes(b.endTime) - timeToMinutes(b.startTime);
const studyOf = (blocks: ScheduleBlock[], taskId?: string) =>
  blocks.filter((b) => b.type === "study" && b.completionStatus === "pending" && (!taskId || b.taskId === taskId));
const weekend730 = (blocks: ScheduleBlock[]) =>
  studyOf(blocks).filter((b) => ["Sat", "Sun"].includes(weekdayOfKey(b.date)) && b.startTime === "07:30").length;

const finc = planned(fincState(), FINC_NOW);
const five = planned(fiveCourseState(), STRESS_NOW);

describe("fresh semester plans stay complete, conflict-free and humane", () => {
  it("prints the numbers", () => {
    console.log("FINC", `${finc.ms.toFixed(0)} ms`, JSON.stringify(planMetrics(finc.state, finc.plan.scheduleBlocks, finc.plan.shortfalls)), "weekend 7:30 starts", weekend730(finc.plan.scheduleBlocks));
    console.log("FIVE", `${five.ms.toFixed(0)} ms`, JSON.stringify(planMetrics(five.state, five.plan.scheduleBlocks, five.plan.shortfalls)), "weekend 7:30 starts", weekend730(five.plan.scheduleBlocks));
    expect(finc.plan.scheduleBlocks.length).toBeGreaterThan(0);
  });

  it("FINC-3100: every deadline prepped, nothing late, no overlaps, no weekend 7:30 AM starts, never on the heels of class", () => {
    const m = planMetrics(finc.state, finc.plan.scheduleBlocks, finc.plan.shortfalls);
    expect(m.preppedTasks).toBe(43);
    expect(m.lateSessions).toBe(0);
    expect(m.overlaps).toBe(0);
    expect(m.shortfallMinutes).toBe(0);
    expect(weekend730(finc.plan.scheduleBlocks)).toBe(0);
    expect(m.weekendEarlyStarts).toBeLessThanOrEqual(2); // was 21
    expect(m.rightAfterClass).toBeLessThanOrEqual(2); // was 23
    expect(m.maxHoursPerDay).toBeLessThanOrEqual(5);
    expect(countConflicts(finc.plan.scheduleBlocks, finc.state)).toBe(0);
  });

  it("5 courses: caps hold (no day over 5 h), the heaviest week drops from 38 h, and nothing is late or dropped", () => {
    const m = planMetrics(five.state, five.plan.scheduleBlocks, five.plan.shortfalls);
    expect(m.preppedTasks).toBe(m.tasks);
    expect(m.shortfallMinutes).toBe(0);
    expect(m.lateSessions).toBe(0);
    expect(m.overlaps).toBe(0);
    expect(m.daysOver5h).toBe(0); // was 16
    expect(m.maxHoursPerDay).toBeLessThanOrEqual(5); // was 5.8
    expect(m.weeklyHoursMax).toBeLessThanOrEqual(30); // was 38
    expect(m.rightAfterClass).toBeLessThanOrEqual(5); // was 101
    expect(weekend730(five.plan.scheduleBlocks)).toBe(0);
    expect(countConflicts(five.plan.scheduleBlocks, five.state)).toBe(0);
  });

  it("smoothing keeps sessions near their deadlines: never earlier than twice the runway (e.g. quiz 8 days, weekly homework 14, exam 28)", () => {
    for (const task of five.state.tasks) {
      const limit = 2 * runwayDaysFor(task.kind ?? "other", Math.ceil(task.estimatedMinutes / 90));
      for (const b of studyOf(five.plan.scheduleBlocks, task.id)) {
        const lead = Math.round((Date.parse(`${task.dueDate}T00:00:00Z`) - Date.parse(`${b.date}T00:00:00Z`)) / 86_400_000);
        expect(lead, `${task.name} (${task.courseName}) on ${b.date}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("plans a whole heavy semester fast (well under 200 ms)", () => {
    const runs = [0, 1, 2].map(() => planned(fiveCourseState(), STRESS_NOW).ms);
    expect(Math.min(...runs)).toBeLessThan(200);
    const fincRuns = [0, 1, 2].map(() => planned(fincState(), FINC_NOW).ms);
    expect(Math.min(...fincRuns)).toBeLessThan(200);
  });

  it("is deterministic", () => {
    const again = buildSemesterPlan(fiveCourseState(), { now: STRESS_NOW });
    expect(again.scheduleBlocks).toEqual(five.plan.scheduleBlocks);
  });
});

describe("accepted / dragged / locked sessions that a change makes wrong are released and re-planned", () => {
  it("an exam moved 5 days earlier: all 240 prep minutes land before the new date, and the preview says what changed", () => {
    const accepted = acceptAll(finc.state);
    const exam = accepted.tasks.find((t) => t.id === "finc-exam2")!;
    const newDue = addDaysToKey(exam.dueDate, -5);
    const moved: AppState = { ...accepted, tasks: accepted.tasks.map((t) => (t.id === exam.id ? { ...t, dueDate: newDue } : t)) };
    const preview = previewPlanChange(accepted, moved, { now: FINC_NOW, label: "Exam moved" });

    const prep = studyOf(preview.next.scheduleBlocks, exam.id);
    expect(prep.filter((b) => b.date < newDue).reduce((s, b) => s + mins(b), 0)).toBe(240); // was 80
    expect(prep.every((b) => b.date < newDue)).toBe(true);
    expect(preview.diff.changed).toBe(true);
    expect(preview.diff.released?.length).toBeGreaterThan(0);
    expect(preview.diff.released!.every((r) => r.reason === "after-deadline" && r.taskId === exam.id)).toBe(true);
    expect(preview.summary).not.toMatch(/nothing needs to change/);
    expect(preview.summary).toMatch(/no longer work/);
    // Valid confirmed sessions stay exactly where they were (still accepted, same id and slot).
    const keptBefore = accepted.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === exam.id && b.date < newDue);
    for (const b of keptBefore) expect(preview.next.scheduleBlocks.find((n) => n.id === b.id)).toEqual(b);
  });

  it("a new job shift: no confirmed session stays under it, the others do not move, and the preview lists the releases", () => {
    const job: RecurringEvent = { id: "job", title: "Job shift", days: ["Tue", "Thu", "Sat"], startTime: "16:00", endTime: "21:00", color: "#EC4899", locked: true };
    const accepted = acceptAll(five.state);
    const withJob: AppState = { ...accepted, recurringEvents: [job] };
    const clashing = studyOf(accepted.scheduleBlocks).filter((b) => ["Tue", "Thu", "Sat"].includes(weekdayOfKey(b.date)) && b.startTime < "21:00" && b.endTime > "16:00");
    expect(clashing.length).toBeGreaterThan(10); // the 1.0.6 plan left ~20 sessions under the shift

    for (const preview of [previewPlanChange(accepted, withJob, { now: STRESS_NOW, label: "New job" }), replanSemester(withJob, { now: STRESS_NOW })]) {
      expect(countConflicts(preview.next.scheduleBlocks, withJob)).toBe(0);
      expect(preview.diff.released?.length).toBe(clashing.length);
      expect(preview.diff.released!.every((r) => r.reason === "conflict" && r.detail === "Clashes with Job shift")).toBe(true);
      expect(preview.summary).not.toMatch(/nothing needs to change/);
      const untouched = studyOf(accepted.scheduleBlocks).filter((b) => !clashing.includes(b));
      for (const b of untouched) expect(preview.next.scheduleBlocks.find((n) => n.id === b.id)).toEqual(b);
      // every released minute is planned again (nothing dropped)
      expect(preview.shortfalls).toEqual([]);
    }
  });

  it("a Google Calendar event, the sleep window and another confirmed session also release a session; a finished or deleted task's sessions go", () => {
    const base = acceptAll(finc.state);
    const sessions = studyOf(base.scheduleBlocks).filter((b) => b.date > "2026-09-01").slice(0, 4);
    const [underEvent, lateNight, dup, closed] = sessions as [ScheduleBlock, ScheduleBlock, ScheduleBlock, ScheduleBlock];
    const state: AppState = {
      ...base,
      googleCalendarEvents: [{ id: "g", calendarId: "c", title: "Dentist", startDate: underEvent.date, startTime: underEvent.startTime, endTime: underEvent.endTime, isAllDay: false, isRecurring: false, status: "active", syncedAt: "" }],
      scheduleBlocks: [
        ...base.scheduleBlocks.map((b) => (b.id === lateNight.id ? { ...b, startTime: "23:30", endTime: "23:55", userEdited: true } : b)),
        { ...dup, id: "dup-copy", locked: true },
      ],
      tasks: base.tasks.map((t) => (t.id === closed.taskId ? { ...t, status: "done" as const } : t)),
    };
    const released = findInvalidPinnedSessions(state, FINC_NOW);
    const byId = new Map(released.map((r) => [r.block.id, r]));
    expect(byId.get(underEvent.id)?.detail).toBe("Clashes with Dentist");
    expect(byId.get(lateNight.id)?.detail).toBe("Falls in your sleep window");
    expect(byId.get(dup.id)?.reason).toBe("conflict"); // the locked copy wins
    expect(byId.has("dup-copy")).toBe(false);
    expect(byId.get(closed.id)?.reason).toBe("task-closed");

    const plan = buildSemesterPlan(state, { now: FINC_NOW });
    expect(plan.releasedSessions?.length).toBe(released.length);
    expect(plan.scheduleBlocks.some((b) => b.id === closed.id)).toBe(false);
    expect(countConflicts(plan.scheduleBlocks, state)).toBe(0);
  });

  it("re-planning twice changes nothing more (stable once released)", () => {
    const job: RecurringEvent = { id: "job", title: "Job shift", days: ["Tue", "Thu"], startTime: "16:00", endTime: "21:00", color: "#EC4899", locked: true };
    const withJob: AppState = { ...acceptAll(five.state), recurringEvents: [job] };
    const once = buildSemesterPlan(withJob, { now: STRESS_NOW });
    const twice = buildSemesterPlan({ ...withJob, scheduleBlocks: once.scheduleBlocks, tasks: once.tasks }, { now: STRESS_NOW });
    expect(twice.releasedSessions).toEqual([]);
    expect(twice.scheduleBlocks).toEqual(once.scheduleBlocks);
  });
});

describe("a quiz / exam without a due time: prep ends before the class where it happens", () => {
  it("mid-semester, with the week already full, FINC quiz prep never runs past the start of that day's 10:00 class", () => {
    const now = new Date(2026, 9, 26, 9, 0); // Mon 26 Oct, quizzes 17-19 and HW 5 this week
    const busy: RecurringEvent = { id: "work", title: "Work", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], startTime: "11:00", endTime: "22:00", color: "#EC4899", locked: true };
    const state: AppState = { ...fincState(), recurringEvents: [busy] };
    const plan = buildSemesterPlan(state, { now });
    for (const task of state.tasks.filter((t) => t.kind === "quiz" || t.kind === "exam")) {
      for (const b of studyOf(plan.scheduleBlocks, task.id)) {
        expect(b.date <= task.dueDate, `${task.name}: ${b.date}`).toBe(true);
        if (b.date === task.dueDate && !task.dueTime) expect(timeToMinutes(b.endTime), `${task.name} ${b.startTime}-${b.endTime}`).toBeLessThanOrEqual(10 * 60);
      }
    }
    // (Homework that was already overdue on 26 Oct gets catch-up sessions after its date: that is intended.)
  });

  it("planned on the morning of each FINC quiz (7:00), the remaining prep goes before the 10:00 class, never after it (1.0.6: 3 quiz days)", () => {
    let after = 0;
    for (const row of fincState().tasks.filter((t) => t.kind === "quiz")) {
      const [y, m, d] = row.dueDate.split("-").map(Number) as [number, number, number];
      const plan = buildSemesterPlan(fincState(), { now: new Date(y, m - 1, d, 7, 0) });
      after += studyOf(plan.scheduleBlocks, row.id).filter((b) => b.date === row.dueDate && timeToMinutes(b.endTime) > 600).length;
    }
    expect(after).toBe(0);
  });
});

describe("a missed quiz / exam gets no catch-up; late homework still does", () => {
  it("after the date: nothing is planned for the quiz, it is reported as a missed assessment, homework is caught up", () => {
    const now = new Date(2026, 8, 16, 12, 0); // Wed 16 Sep: Quiz 4 and HW 1 were due Mon 14 Sep, Quiz 5 is Fri
    const state = fincState();
    const result = scheduleTasksIntelligently(state.tasks, { ...state, googleCalendarEvents: [] }, undefined, undefined, { now });
    const quiz4 = result.scheduledBlocks.filter((b) => b.taskId === "finc-q4");
    const hw1 = result.scheduledBlocks.filter((b) => b.taskId === "finc-hw1");
    expect(quiz4).toEqual([]);
    expect(result.overdueTasks.find((t) => t.taskId === "finc-q4")).toMatchObject({ missedAssessment: true, daysOverdue: 2 });
    expect(result.shortfalls.find((s) => s.taskId === "finc-q4")).toBeUndefined();
    expect(hw1.length).toBeGreaterThan(0);
    expect(hw1.every((b) => b.isOverdue && b.date >= "2026-09-16")).toBe(true);
    expect(result.summary).toMatch(/already taken place/);
    // a quiz later TODAY whose class already started is missed too
    const noon = scheduleTasksIntelligently(state.tasks, state, undefined, undefined, { now: new Date(2026, 8, 18, 11, 0) });
    expect(noon.scheduledBlocks.some((b) => b.taskId === "finc-q5")).toBe(false);
    expect(noon.overdueTasks.find((t) => t.taskId === "finc-q5")?.missedAssessment).toBe(true);
  });
});

describe('"Move to tomorrow" never silently drops work', () => {
  const now = new Date(2026, 8, 17, 8, 0); // Thu 17 Sep 8:00, Quiz 5 is due Fri 18 Sep at the 10:00 class
  const base = planned(fincState(), now).state;
  const sessionsOn = (date: string) => studyOf(base.scheduleBlocks).filter((b) => b.date === date);

  it("work due later just starts tomorrow (as before)", () => {
    const date = sessionsOn("2026-09-17").length > 0 ? "2026-09-17" : studyOf(base.scheduleBlocks).find((b) => b.date >= "2026-09-17")!.date;
    const result = planDeferral(base, date, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of result.deferredTaskIds) expect(result.next.tasks.find((t) => t.id === id)!.notBeforeDate).toBe(addDaysToKey(date, 1));
    expect(studyOf(result.next.scheduleBlocks).some((b) => b.date === date && result.deferredTaskIds.includes(b.taskId!))).toBe(false);
  });

  it("on the due date with no time left before the deadline, it asks instead of dropping (ok: false, past-deadline)", () => {
    const quizDay: AppState = {
      ...base,
      scheduleBlocks: [...base.scheduleBlocks.filter((b) => !(b.type === "study" && b.taskId === "finc-q5")),
        { id: "q5-morning", type: "study", title: "Review: Quiz 5", date: "2026-09-18", startTime: "08:30", endTime: "08:55", locked: false, accepted: true, taskId: "finc-q5", courseId: "class-finc", color: "#4F6EF7", completionStatus: "pending" }],
    };
    const result = planDeferral(quizDay, "2026-09-18", { now: new Date(2026, 8, 18, 7, 45) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("past-deadline");
    expect(result.atRisk).toEqual([expect.objectContaining({ taskId: "finc-q5", assessment: true, missingMinutes: 25 })]);
    expect(result.summary).toMatch(/Quiz 5/);

    // The student confirms: it is applied, and the plan is honest about it (not "healthy").
    const anyway = planDeferral(quizDay, "2026-09-18", { now: new Date(2026, 8, 18, 7, 45), acceptLate: true });
    expect(anyway.ok).toBe(true);
    if (!anyway.ok) return;
    expect(anyway.late.map((r) => r.taskId)).toEqual(["finc-q5"]);
    const quality = assessPlanQuality(anyway.next.tasks, anyway.next.scheduleBlocks, "2026-09-18", { solverShortfalls: anyway.next.planAlerts?.shortfalls });
    expect(quality.severity).not.toBe("healthy");
    expect(quality.unscheduledMinutes).toBeGreaterThanOrEqual(25);
  });

  it("deferring a FUTURE due date moves the work to the days before the deadline instead (ok: true)", () => {
    const hw = base.tasks.find((t) => t.id === "finc-hw2")!; // due Mon 28 Sep
    const onDue: AppState = {
      ...base,
      scheduleBlocks: [...base.scheduleBlocks.filter((b) => !(b.type === "study" && b.taskId === hw.id)),
        { id: "hw2-due-day", type: "study", title: "Work on: HW 2", date: hw.dueDate, startTime: "14:00", endTime: "15:15", locked: false, accepted: true, taskId: hw.id, courseId: "class-finc", color: "#4F6EF7", completionStatus: "pending" }],
    };
    const result = planDeferral(onDue, hw.dueDate, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keptBeforeDeadline).toContain(hw.id);
    const after = studyOf(result.next.scheduleBlocks, hw.id);
    expect(after.reduce((s, b) => s + mins(b), 0)).toBe(75);
    expect(after.every((b) => b.date < hw.dueDate)).toBe(true);
    expect(result.next.tasks.find((t) => t.id === hw.id)!.notBeforeDate).toBeUndefined();
  });

  it("homework moved past its deadline anyway becomes visible late work (catch-up from tomorrow), never nothing", () => {
    const hw = base.tasks.find((t) => t.id === "finc-hw2")!;
    const onDue: AppState = {
      ...base,
      scheduleBlocks: [...base.scheduleBlocks.filter((b) => !(b.type === "study" && b.taskId === hw.id)),
        { id: "hw2-due-day", type: "study", title: "Work on: HW 2", date: hw.dueDate, startTime: "08:00", endTime: "09:15", locked: false, accepted: true, taskId: hw.id, courseId: "class-finc", color: "#4F6EF7", completionStatus: "pending" }],
    };
    const dayOf = new Date(2026, 8, 28, 7, 30);
    const asked = planDeferral(onDue, hw.dueDate, { now: dayOf });
    expect(asked.ok).toBe(false);
    const late = planDeferral(onDue, hw.dueDate, { now: dayOf, acceptLate: true });
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    const caughtUp = studyOf(late.next.scheduleBlocks, hw.id);
    expect(caughtUp.reduce((s, b) => s + mins(b), 0)).toBe(75);
    expect(caughtUp.every((b) => b.date > hw.dueDate)).toBe(true);
    expect(late.next.planAlerts?.overdueTasks.some((t) => t.taskId === hw.id)).toBe(true);
  });
});

describe("findConflicts / countConflicts: the only source for 'N conflicts'", () => {
  it("counts real double bookings only, and each study pair once", () => {
    const state = fincState();
    const blocks: ScheduleBlock[] = [
      { id: "a", type: "study", title: "A", date: "2026-09-02", startTime: "09:30", endTime: "10:30", locked: false, accepted: true, taskId: "finc-q1", color: "#000", completionStatus: "pending" }, // class 10:00
      { id: "b", type: "study", title: "B", date: "2026-09-03", startTime: "14:00", endTime: "15:00", locked: false, accepted: false, taskId: "finc-q2", color: "#000", completionStatus: "pending" },
      { id: "c", type: "study", title: "C", date: "2026-09-03", startTime: "14:30", endTime: "15:30", locked: false, accepted: false, taskId: "finc-q2", color: "#000", completionStatus: "pending" },
      { id: "d", type: "study", title: "D", date: "2026-10-16", startTime: "10:00", endTime: "11:00", locked: false, accepted: false, taskId: "finc-q3", color: "#000", completionStatus: "pending" }, // Fall Break: no class
      { id: "e", type: "study", title: "E", date: "2026-09-04", startTime: "10:00", endTime: "11:00", locked: false, accepted: false, taskId: "finc-q3", color: "#000", completionStatus: "done" }, // history
      { id: "f", type: "study", title: "F", date: "2026-09-05", startTime: "12:00", endTime: "13:00", locked: false, accepted: false, taskId: "finc-q3", color: "#000", completionStatus: "pending" },
      { id: "own", type: "work", title: "Shift", date: "2026-09-05", startTime: "12:30", endTime: "16:00", locked: true, accepted: true, color: "#000", completionStatus: "pending" },
    ];
    const conflicts = findConflicts(blocks, state);
    expect(conflicts.map((c) => [c.blockId, c.kind, c.withLabel])).toEqual([
      ["a", "class", "Principles of Finance"],
      ["b", "study", "C"],
      ["f", "event", "Shift"],
    ]);
    expect(countConflicts(blocks, state)).toBe(3);
    expect(countConflicts(blocks, state, { fromDate: "2026-09-03" })).toBe(2);
    expect(countConflicts(blocks, { ...state, googleCalendarEvents: [{ id: "g", calendarId: "c", title: "Trip", startDate: "2026-10-16", endDate: "2026-10-17", isAllDay: true, isRecurring: false, status: "active", syncedAt: "" }] })).toBe(4);
  });
});
