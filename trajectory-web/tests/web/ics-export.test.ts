import { describe, expect, it } from "vitest";

import { buildPlanIcs, escapeIcsText, foldIcsLine, icsLocalStamp } from "../../src/lib/ics-export";
import type { ScheduleBlock, Task } from "../../src/engine/types";

const block = (patch: Partial<ScheduleBlock>): ScheduleBlock => ({
  id: "b1",
  type: "study",
  title: "Study: Problem Set 2",
  date: "2026-10-14",
  startTime: "09:00",
  endTime: "10:30",
  locked: false,
  accepted: false,
  color: "#4F6EF7",
  completionStatus: "pending",
  ...patch,
});

const task = (patch: Partial<Task>): Task => ({
  id: "t1",
  name: "Problem Set 2",
  courseId: "c1",
  courseName: "Finance",
  dueDate: "2026-10-16",
  estimatedMinutes: 90,
  difficulty: 3,
  requiresOnCampus: false,
  status: "pending",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

describe("ics export", () => {
  it("escapes commas, semicolons, backslashes and newlines", () => {
    expect(escapeIcsText("a, b; c\\d\nnext")).toBe("a\\, b\\; c\\\\d\\nnext");
  });

  it("folds long lines at 73 characters with a leading space", () => {
    const folded = foldIcsLine("X".repeat(100));
    const lines = folded.split("\r\n");
    expect(lines[0]).toHaveLength(73);
    expect(lines[1]!.startsWith(" ")).toBe(true);
  });

  it("writes floating local stamps", () => {
    expect(icsLocalStamp("2026-10-14", "09:05")).toBe("20261014T090500");
  });

  it("includes pending sessions, classes and open deadlines from the start day on, and skips sleep and done sessions", () => {
    const ics = buildPlanIcs(
      {
        classes: [],
        tasks: [task({}), task({ id: "t2", name: "Old essay", dueDate: "2026-09-01" }), task({ id: "t3", name: "Done one", status: "done" })],
        scheduleBlocks: [
          block({}),
          block({ id: "b2", type: "class", title: "Finance", taskId: undefined, date: "2026-10-15", startTime: "13:00", endTime: "14:15" }),
          block({ id: "b3", type: "sleep", title: "Sleep", date: "2026-10-15", startTime: "23:00", endTime: "07:00" }),
          block({ id: "b4", completionStatus: "done", date: "2026-10-15" }),
          block({ id: "b5", date: "2026-10-01" }),
        ],
      },
      { from: "2026-10-12", now: new Date("2026-10-12T12:00:00Z") },
    );
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("UID:b1@trajectory-web");
    expect(ics).toContain("UID:b2@trajectory-web");
    expect(ics).not.toContain("UID:b3@");
    expect(ics).not.toContain("UID:b4@");
    expect(ics).not.toContain("UID:b5@");
    expect(ics).toContain("SUMMARY:Due: Finance · Problem Set 2");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261016");
    expect(ics).toContain("DTEND;VALUE=DATE:20261017");
    expect(ics).not.toContain("Old essay");
    expect(ics).not.toContain("Done one");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
