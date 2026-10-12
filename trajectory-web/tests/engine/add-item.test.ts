import { describe, expect, it } from "vitest";
import {
  blockFromEventForm,
  defaultEventForm,
  defaultExamForm,
  defaultTaskForm,
  eventFormError,
  examFormError,
  examFromForm,
  minutesChoiceLabel,
  recurringFromEventForm,
  taskFormError,
  taskFromForm,
} from "../../src/engine/add-item";

// The one Add sheet (components/add-sheet.tsx): what each short form becomes, and what it asks for first.
const TODAY = "2026-09-30"; // a Wednesday
const CLASSES = [
  { id: "c-finc", name: "Principles of Finance" },
  { id: "c-calc", name: "Calculus II" },
];
const NOW = "2026-09-30T13:30:00.000Z";

describe("defaults", () => {
  it("a task is due in a week and needs an hour; an exam is two weeks out with three hours of study", () => {
    expect(defaultTaskForm(TODAY)).toEqual({ name: "", courseId: "", dueDate: "2026-10-07", minutes: 60 });
    expect(defaultExamForm(TODAY)).toEqual({ name: "", courseId: "", date: "2026-10-14", time: "", studyMinutes: 180 });
  });

  it("an event opens on today, or on the day it was opened for when that day has not passed", () => {
    expect(defaultEventForm(TODAY)).toEqual({ name: "", date: TODAY, startTime: "18:00", endTime: "20:00", repeatsWeekly: false });
    expect(defaultEventForm(TODAY, "2026-10-03").date).toBe("2026-10-03");
    expect(defaultEventForm(TODAY, "2026-09-28").date).toBe(TODAY);
    expect(defaultEventForm(TODAY, "next week").date).toBe(TODAY);
  });
});

describe("what is still missing, in words", () => {
  it("a task needs a name and a due date that has not passed", () => {
    expect(taskFormError(defaultTaskForm(TODAY), TODAY)).toBe("Give the task a name");
    expect(taskFormError({ ...defaultTaskForm(TODAY), name: "   " }, TODAY)).toBe("Give the task a name");
    expect(taskFormError({ ...defaultTaskForm(TODAY), name: "PS 7", dueDate: "" }, TODAY)).toBe("Pick a due date");
    expect(taskFormError({ ...defaultTaskForm(TODAY), name: "PS 7", dueDate: "2026-09-29" }, TODAY)).toBe("The due date has already passed");
    expect(taskFormError({ ...defaultTaskForm(TODAY), name: "PS 7", minutes: 0 }, TODAY)).toBe("Choose how long it needs");
    expect(taskFormError({ ...defaultTaskForm(TODAY), name: "PS 7", dueDate: TODAY }, TODAY)).toBeNull();
  });

  it("an exam needs a name and a date; its time is optional", () => {
    expect(examFormError(defaultExamForm(TODAY), TODAY)).toBe("Give the exam a name");
    expect(examFormError({ ...defaultExamForm(TODAY), name: "Midterm", date: "2026-09-01" }, TODAY)).toBe("That date has already passed");
    expect(examFormError({ ...defaultExamForm(TODAY), name: "Midterm" }, TODAY)).toBeNull();
    expect(examFormError({ ...defaultExamForm(TODAY), name: "Midterm", time: "09:30" }, TODAY)).toBeNull();
    expect(examFormError({ ...defaultExamForm(TODAY), name: "Midterm", time: "9" }, TODAY)).toBe("Pick the exam's time again");
  });

  it("an event needs a name and an end after its start; a weekly one may start from a day already gone", () => {
    const named = { ...defaultEventForm(TODAY), name: "Work shift" };
    expect(eventFormError(defaultEventForm(TODAY), TODAY)).toBe("Give the event a name");
    expect(eventFormError(named, TODAY)).toBeNull();
    expect(eventFormError({ ...named, endTime: "18:00" }, TODAY)).toBe("The end time must be after the start time");
    expect(eventFormError({ ...named, startTime: "", endTime: "" }, TODAY)).toBe("Pick a start and an end time");
    expect(eventFormError({ ...named, date: "2026-09-28" }, TODAY)).toBe("That day has already passed");
    expect(eventFormError({ ...named, date: "2026-09-28", repeatsWeekly: true }, TODAY)).toBeNull();
  });
});

describe("what each form becomes", () => {
  it("a task: the student's own date, tied to the class when one is picked", () => {
    const task = taskFromForm({ name: "  Problem Set 7 ", courseId: "c-calc", dueDate: "2026-10-15", minutes: 75 }, CLASSES, "t1", NOW);
    expect(task).toEqual({
      id: "t1",
      name: "Problem Set 7",
      courseId: "c-calc",
      courseName: "Calculus II",
      dueDate: "2026-10-15",
      estimatedMinutes: 75,
      difficulty: 2,
      requiresOnCampus: false,
      status: "pending",
      createdAt: NOW,
      dateConfidence: "user",
    });
  });

  it("no class, or a class that no longer exists, is General", () => {
    expect(taskFromForm({ ...defaultTaskForm(TODAY), name: "Laundry" }, CLASSES, "t2", NOW)).toMatchObject({ courseId: "", courseName: "General" });
    expect(taskFromForm({ ...defaultTaskForm(TODAY), name: "Laundry", courseId: "gone" }, CLASSES, "t3", NOW)).toMatchObject({ courseId: "", courseName: "General" });
  });

  it("an exam: a task of kind exam, with its start time only when one was set", () => {
    const timed = examFromForm({ name: "Midterm", courseId: "c-finc", date: "2026-10-14", time: "09:30", studyMinutes: 240 }, CLASSES, "e1", NOW);
    expect(timed).toMatchObject({ id: "e1", name: "Midterm", kind: "exam", courseName: "Principles of Finance", dueDate: "2026-10-14", dueTime: "09:30", estimatedMinutes: 240, difficulty: 3, dateConfidence: "user" });
    const untimed = examFromForm({ name: "Midterm", courseId: "", date: "2026-10-14", time: "", studyMinutes: 180 }, CLASSES, "e2", NOW);
    expect("dueTime" in untimed).toBe(false);
    expect(untimed.courseName).toBe("General");
  });

  it("a one-time event: a block made by hand, which a re-plan never moves", () => {
    expect(blockFromEventForm({ name: " Dentist ", date: "2026-10-03", startTime: "10:00", endTime: "11:00", repeatsWeekly: false }, "b1")).toEqual({
      id: "b1",
      type: "free",
      title: "Dentist",
      date: "2026-10-03",
      startTime: "10:00",
      endTime: "11:00",
      locked: false,
      accepted: true,
      userEdited: true,
      color: "#CBD5E1",
      completionStatus: "pending",
    });
  });

  it("a weekly event: a commitment on the weekday of the day picked", () => {
    expect(recurringFromEventForm({ name: "Work shift", date: "2026-10-03", startTime: "10:00", endTime: "12:00", repeatsWeekly: true }, "r1")).toEqual({
      id: "r1",
      title: "Work shift",
      days: ["Sat"],
      startTime: "10:00",
      endTime: "12:00",
      color: "#06B6D4",
      locked: true,
      doNotSchedule: false,
    });
  });
});

describe("minutesChoiceLabel", () => {
  it("reads as a student would say it", () => {
    expect([15, 45, 60, 90, 180, 480].map(minutesChoiceLabel)).toEqual(["15m", "45m", "1h", "1h 30m", "3h", "8h"]);
  });
});
