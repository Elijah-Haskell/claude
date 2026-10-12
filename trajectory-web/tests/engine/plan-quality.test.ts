import { describe, expect, it } from "vitest";
import { assessPlanQuality } from "../../src/engine/plan-quality";
import { ScheduleBlock, Task } from "../../src/engine/types";

const task = (id: string, dueDate = "2030-04-10"): Task => ({ id, name: id, courseId: "course", courseName: "Course", dueDate, estimatedMinutes: 60, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2030-04-01T12:00:00.000Z" });
const study = (id: string, taskId: string, date: string, startTime: string, endTime: string): ScheduleBlock => ({ id, taskId, type: "study", title: taskId, date, startTime, endTime, locked: false, accepted: true, color: "#4F6EF7", completionStatus: "pending" });

describe("plan quality diagnostics", () => {
  it("explains when active work has no calendar session", () => {
    const report = assessPlanQuality([task("planned"), task("missing")], [study("block", "planned", "2030-04-03", "10:00", "11:00")], "2030-04-02");
    expect(report.severity).toBe("watch");
    expect(report.unplannedTaskIds).toEqual(["missing"]);
    expect(report.message).toContain("not yet on the calendar");
  });
  it("an exam planned through its open Exam Prep is not 'not planned': the prep's sessions are its plan (1.0.9)", () => {
    const exam: Task = { ...task("exam-1", "2030-04-10"), name: "Exam 1", kind: "exam" };
    const prep: Task = { ...task("exam-runway-prep-1", "2030-04-10"), name: "Exam 1 prep", kind: "exam", examTaskId: "exam-1" };
    const report = assessPlanQuality([exam, prep], [study("p1", "exam-runway-prep-1", "2030-04-08", "10:00", "11:00")], "2030-04-02");
    expect(report.unplannedTaskIds).toEqual([]);
    expect(report.severity).toBe("healthy");
    // Without the prep's sessions the exam is reported again.
    expect(assessPlanQuality([exam, prep], [], "2030-04-02").unplannedTaskIds).toEqual(["exam-1", "exam-runway-prep-1"]);
  });
  it("lists a day with more than five hours of study, but leaves the warning to Today's workload card (one warning, not four)", () => {
    const report = assessPlanQuality([task("one"), task("two")], [study("a", "one", "2030-04-03", "08:00", "11:30"), study("b", "two", "2030-04-03", "12:00", "14:00")], "2030-04-02");
    expect(report.overloadedDates).toEqual(["2030-04-03"]);
    expect(report.severity).toBe("healthy");
    expect(report.message).not.toContain("five hours");
  });

  it("counts only study still to do from today on: moved (skipped), finished, missed and past sessions never overload a day", () => {
    const heavy = (date: string, completionStatus: ScheduleBlock["completionStatus"]): ScheduleBlock[] =>
      [{ ...study(`a-${date}`, "one", date, "08:00", "11:30"), completionStatus }, { ...study(`b-${date}`, "one", date, "12:00", "14:00"), completionStatus }];
    const blocks = [...heavy("2030-04-01", "pending"), ...heavy("2030-04-02", "skipped"), ...heavy("2030-04-03", "done"), ...heavy("2030-04-04", "missed"), ...heavy("2030-04-05", "pending")];
    expect(assessPlanQuality([task("one")], blocks, "2030-04-02").overloadedDates).toEqual(["2030-04-05"]);
  });

  it("work deferred past its own deadline is never 'healthy' (was: hidden by notBeforeDate, reported healthy)", () => {
    const deferred = { ...task("quiz", "2030-04-02"), notBeforeDate: "2030-04-03" };
    const report = assessPlanQuality([deferred], [], "2030-04-02");
    expect(report.severity).toBe("high");
    expect(report.deferredPastDeadlineTaskIds).toEqual(["quiz"]);
    expect(report.unscheduledMinutes).toBe(60);
    expect(report.shortfalls[0]).toMatchObject({ taskId: "quiz", missingMinutes: 60 });
    expect(report.message).toContain("was moved past");
  });

  it("any minutes the solver could not place are reported, even under the 15-minute calendar tolerance", () => {
    const report = assessPlanQuality([task("t")], [study("a", "t", "2030-04-03", "10:00", "10:50")], "2030-04-02", {
      solverShortfalls: [{ taskId: "t", requestedMinutes: 60, placedMinutes: 50, missingMinutes: 10 }],
    });
    expect(report.severity).not.toBe("healthy");
    expect(report.unscheduledMinutes).toBe(10);
  });

  it("a task deferred to a later day (before its deadline) is checked against the solver, not reported as unplanned", () => {
    const later = { ...task("later", "2030-04-10"), notBeforeDate: "2030-04-05" };
    expect(assessPlanQuality([later], [], "2030-04-02").severity).toBe("healthy");
    const short = assessPlanQuality([later], [], "2030-04-02", { solverShortfalls: [{ taskId: "later", requestedMinutes: 60, placedMinutes: 30, missingMinutes: 30 }] });
    expect(short.shortfalls.map((s) => s.taskId)).toEqual(["later"]);
  });

  it("a quiz whose date passed reads as 'passed without being marked done', not as late work", () => {
    const quiz = { ...task("q", "2030-04-01"), name: "Quiz 3", kind: "quiz" as const };
    const report = assessPlanQuality([quiz], [], "2030-04-02");
    expect(report.message).toContain("passed without being marked done");
    expect(report.message).not.toContain("overdue");
  });

  it("speaks of replanning, never of rebuilding (one name for every plan change)", () => {
    const report = assessPlanQuality([task("missing")], [], "2030-04-02");
    expect(report.message).toContain("replan");
    expect(report.message).not.toMatch(/rebuild|re-plan/i);
  });
});
