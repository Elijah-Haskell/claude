import { describe, expect, it } from "vitest";
import { dateBadge, dateGroupOf, groupTasksByClass, groupTasksByDate, matchesTaskSearch, shortDateLabel, taskBadge, tasksSummary } from "../../src/engine/task-list";
import { plannedSessionsFor } from "../../src/engine/task-sessions";
import type { Task } from "../../src/engine/types";

// The Tasks tab (app/(tabs)/tasks.tsx): its badge, its groups, its search and the line over its title.
const WED = "2026-09-30"; // this week ends on Sunday Oct 4, next week on Sunday Oct 11

let seq = 0;
function task(name: string, dueDate: string, extra: Partial<Task> = {}): Task {
  seq += 1;
  return { id: `t${seq}`, name, courseId: "", courseName: "General", dueDate, estimatedMinutes: 60, difficulty: 2, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z", ...extra };
}

describe("shortDateLabel", () => {
  it("reads a date key as month and day", () => {
    expect(shortDateLabel("2026-10-07")).toBe("Oct 7");
    expect(shortDateLabel("2026-01-31")).toBe("Jan 31");
  });
  it("is empty for anything that is not a date key", () => {
    expect(shortDateLabel("")).toBe("");
    expect(shortDateLabel("soon")).toBe("");
  });
});

describe("the one badge: how close a date is", () => {
  it("is red for today and tomorrow", () => {
    expect(dateBadge(WED, WED)).toMatchObject({ label: "Today", tone: "red" });
    expect(dateBadge("2026-10-01", WED)).toMatchObject({ label: "Tomorrow", tone: "red" });
  });

  it("is the weekday in gold for the rest of the next six days", () => {
    expect(dateBadge("2026-10-02", WED)).toMatchObject({ label: "Fri", tone: "gold", spoken: "due Friday" });
    expect(dateBadge("2026-10-06", WED)).toMatchObject({ label: "Tue", tone: "gold" });
  });

  it("is the date, quiet, from a week away on (the same weekday would be ambiguous)", () => {
    expect(dateBadge("2026-10-07", WED)).toMatchObject({ label: "Oct 7", tone: "neutral" });
    expect(dateBadge("2026-12-14", WED)).toMatchObject({ label: "Dec 14", tone: "neutral" });
  });

  it("says overdue in red for work whose date passed", () => {
    expect(taskBadge(task("Problem Set 4", "2026-09-28"), WED)).toMatchObject({ label: "Overdue", tone: "red", spoken: "overdue since Sep 28" });
  });

  it("a quiz or exam whose date passed is not overdue: it took place", () => {
    const badge = taskBadge(task("Quiz 9", "2026-09-28"), WED);
    expect(badge).toMatchObject({ label: "Sep 28", tone: "neutral" });
    expect(badge.spoken).toContain("took place Sep 28");
  });

  it("finished and skipped work is quiet whatever its date", () => {
    expect(taskBadge(task("Essay", "2026-09-20", { status: "done" }), WED)).toMatchObject({ label: "Sep 20", tone: "neutral" });
    expect(taskBadge(task("Essay", WED, { status: "skipped" }), WED)).toMatchObject({ label: "Skipped", tone: "neutral" });
  });

  it("a task without a usable date says so", () => {
    expect(taskBadge(task("Loose end", ""), WED)).toMatchObject({ label: "No date", tone: "neutral" });
  });

  it("reads a due date saved with a time as its local day", () => {
    expect(taskBadge(task("HW", "2026-10-02T12:00:00"), WED).label).toBe("Fri");
    expect(dateGroupOf(task("HW", "2026-10-02T12:00:00"), WED)).toBe("thisWeek");
  });
});

describe("groups by date, on calendar weeks", () => {
  it("puts each task in its group", () => {
    expect(dateGroupOf(task("HW 1", "2026-09-29"), WED)).toBe("overdue");
    expect(dateGroupOf(task("Quiz 9", "2026-09-29"), WED)).toBe("past");
    expect(dateGroupOf(task("HW 2", WED), WED)).toBe("thisWeek");
    expect(dateGroupOf(task("HW 3", "2026-10-04"), WED)).toBe("thisWeek"); // Sunday
    expect(dateGroupOf(task("HW 4", "2026-10-05"), WED)).toBe("nextWeek"); // Monday
    expect(dateGroupOf(task("HW 5", "2026-10-11"), WED)).toBe("nextWeek");
    expect(dateGroupOf(task("HW 6", "2026-10-12"), WED)).toBe("later");
    expect(dateGroupOf(task("HW 7", ""), WED)).toBe("later");
    expect(dateGroupOf(task("HW 8", "2026-09-01", { status: "done" }), WED)).toBe("done");
    expect(dateGroupOf(task("HW 9", "2026-10-20", { status: "skipped" }), WED)).toBe("done");
  });

  it("on a Sunday, this week is that one day", () => {
    expect(dateGroupOf(task("HW", "2026-10-04"), "2026-10-04")).toBe("thisWeek");
    expect(dateGroupOf(task("HW", "2026-10-05"), "2026-10-04")).toBe("nextWeek");
  });

  it("lists only the groups that have something, in order, soonest first", () => {
    const groups = groupTasksByDate(
      [task("Later one", "2026-11-02"), task("Friday", "2026-10-02"), task("Today", WED), task("Old", "2026-09-25"), task("Next", "2026-10-06")],
      WED,
    );
    expect(groups.map((group) => group.title)).toEqual(["Overdue", "This week", "Next week", "Later"]);
    expect(groups[1]!.tasks.map((t) => t.name)).toEqual(["Today", "Friday"]);
  });

  it("finished work reads newest first", () => {
    const groups = groupTasksByDate([task("A", "2026-09-10", { status: "done" }), task("B", "2026-09-20", { status: "done" })], WED);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tasks.map((t) => t.name)).toEqual(["B", "A"]);
  });
});

describe("groups by class", () => {
  const classes = [
    { id: "c-fin", name: "Principles of Finance", color: "#4F6EF7" },
    { id: "c-chem", name: "Organic Chemistry", color: "#F472B6" },
  ];

  it("follows the order of the student's classes, then other names, then work with no class", () => {
    const groups = groupTasksByClass(
      [
        task("Loose", "2026-10-02"),
        task("Lab", "2026-10-03", { courseId: "c-chem", courseName: "Organic Chemistry" }),
        task("Old course work", "2026-10-03", { courseId: "gone", courseName: "Art History" }),
        task("Quiz", "2026-10-01", { courseId: "c-fin", courseName: "Principles of Finance" }),
      ],
      classes,
    );
    expect(groups.map((group) => group.title)).toEqual(["Principles of Finance", "Organic Chemistry", "Art History", "No class"]);
    expect(groups[0]!.color).toBe("#4F6EF7");
    expect(groups[3]!.color).toBeUndefined();
  });

  it("uses the class's current name, not the one saved on the task", () => {
    const groups = groupTasksByClass([task("Quiz", WED, { courseId: "c-fin", courseName: "FINC 3303" })], classes);
    expect(groups[0]!.title).toBe("Principles of Finance");
  });

  it("puts what is open first (soonest first), then what is finished", () => {
    const groups = groupTasksByClass(
      [
        task("Done early", "2026-09-10", { courseId: "c-fin", status: "done" }),
        task("Later", "2026-10-20", { courseId: "c-fin" }),
        task("Soon", "2026-10-01", { courseId: "c-fin" }),
      ],
      classes,
    );
    expect(groups[0]!.tasks.map((t) => t.name)).toEqual(["Soon", "Later", "Done early"]);
  });
});

describe("search", () => {
  const quiz = { name: "Quiz 10", courseName: "Principles of Finance" };
  it("matches every word, in the name or the class, whatever the case", () => {
    expect(matchesTaskSearch(quiz, "quiz")).toBe(true);
    expect(matchesTaskSearch(quiz, "FINANCE quiz")).toBe(true);
    expect(matchesTaskSearch(quiz, "quiz 11")).toBe(false);
    expect(matchesTaskSearch(quiz, "chem")).toBe(false);
  });
  it("an empty search matches everything", () => {
    expect(matchesTaskSearch(quiz, "")).toBe(true);
    expect(matchesTaskSearch(quiz, "   ")).toBe(true);
  });
});

describe("the line over the title", () => {
  it("counts what is left and what is due this week", () => {
    expect(tasksSummary([task("A", "2026-10-02"), task("B", "2026-10-20"), task("C", "2026-09-01", { status: "done" })], WED)).toBe("2 to do · 1 due this week");
  });
  it("says overdue work first", () => {
    expect(tasksSummary([task("A", "2026-09-20"), task("B", "2026-10-02")], WED)).toBe("2 to do · 1 overdue");
  });
  it("a past quiz is not counted as overdue", () => {
    expect(tasksSummary([task("Quiz 3", "2026-09-20")], WED)).toBe("1 to do · 0 due this week");
  });
  it("has words for an empty list and a finished one", () => {
    expect(tasksSummary([], WED)).toBe("No tasks yet");
    expect(tasksSummary([task("A", "2026-09-01", { status: "done" })], WED)).toBe("Nothing left to do");
  });
});

describe("plannedSessionsFor: a task's study sessions, for its sheet", () => {
  const block = (id: string, taskId: string | undefined, date: string, startTime: string, endTime: string, completionStatus: "pending" | "done" | "skipped" | "missed" = "pending", type: "study" | "class" = "study") =>
    ({ id, type, taskId, date, startTime, endTime, completionStatus });

  it("lists what is still to do first, soonest first, then what is settled, most recent first", () => {
    const sessions = plannedSessionsFor("t", [
      block("b3", "t", "2026-10-02", "09:00", "10:00"),
      block("b1", "t", "2026-09-29", "09:00", "09:45", "done"),
      block("b2", "t", "2026-09-30", "16:00", "17:15"),
      block("b0", "t", "2026-09-28", "09:00", "09:30", "skipped"),
      block("x", "other", "2026-09-30", "10:00", "11:00"),
      block("c", "t", "2026-09-30", "10:00", "11:00", "pending", "class"),
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["b2", "b3", "b1", "b0"]);
    expect(sessions.map((s) => s.position)).toEqual([3, 4, 2, 1]);
    expect(sessions[0]!.minutes).toBe(75);
  });

  it("a missed session is still to do", () => {
    const sessions = plannedSessionsFor("t", [block("m", "t", "2026-09-29", "09:00", "10:00", "missed"), block("d", "t", "2026-09-28", "09:00", "10:00", "done")]);
    expect(sessions.map((s) => s.id)).toEqual(["m", "d"]);
  });

  it("counts the sessions of an exam's prep as the exam's", () => {
    const exam = task("Midterm", "2026-10-13", { id: "exam-1", courseId: "c-calc", kind: "exam" });
    const sessions = plannedSessionsFor(
      "exam-1",
      [block("p1", "exam-runway-prep-1", "2026-10-08", "09:00", "10:00"), block("e1", "exam-1", "2026-10-10", "09:00", "10:00")],
      [{ id: "prep-1", classId: "c-calc", examDate: "2026-10-13", examTaskId: "exam-1" }],
      [exam],
    );
    expect(sessions.map((s) => s.id)).toEqual(["p1", "e1"]);
  });

  it("has nothing for a task the plan has not reached", () => {
    expect(plannedSessionsFor("t", [])).toEqual([]);
  });
});
